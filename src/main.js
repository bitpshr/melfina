/**
 * Management script to deploy a smart contract or to start an Express
 * HTTP server, both of which interact with the Ethereum blockchain
 * using RPC calls via the web3 API
 *
 * NOTE: All web3 transactions are signed manually using an explicit
 * private key. This allows for easier integration with hosted
 * Ethereum nodes, like https://infura.io/, where only raw transactions
 * are permitted for security reasons.
 */

const fs = require('fs');
const path = require('path');

const abiDecoder = require('abi-decoder');
const bodyParser = require('body-parser');
const chalk = require('chalk');
const env = require('dotenv').config();
const express = require('express');
const keythereum = require('keythereum');
const moment = require('moment');
const shajs = require('sha.js');
const solc = require('solc');
const Tx = require('ethereumjs-tx');
const Web3 = require('web3');
const yargs = require('yargs');

const { task } = yargs.option('t', {
	alias: 'task',
	demandOption: true,
	describe: 'Type of process to run',
	choices: ['deploy', 'serve']
}).argv;

const {
	CONTRACT_ADDRESS: contractAddress = null,
	ETH_ADDRESS: address,
	ETH_KEYFILE: keyfile,
	ETH_PASSWORD: password,
	ETH_PROVIDER: provider = 'http://localhost:8545'
} = (function parseEnv() {
	const missingKeys = [
		'ETH_ADDRESS',
		'ETH_KEYFILE',
		'ETH_PASSWORD',
		'ETH_PROVIDER'
	].filter(key => !process.env[key]);

	if (missingKeys.length) {
		throw new Error(`${missingKeys.join(', ')} environment variables must be set`);
	}

	return process.env;
})();

const colors = {
	fail: chalk.red,
	info: chalk.white,
	warn: chalk.yellow
};

const web3 = new Web3(new Web3.providers.HttpProvider(provider));
const privateKey = keythereum.recover(password, JSON.parse(keyfile));
const abiPath = 'src/contracts/src_contracts_ProofOfExistence_sol_ProofOfExistence.abi';
const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
const binPath = 'src/contracts/src_contracts_ProofOfExistence_sol_ProofOfExistence.bin';
const bin = `0x${fs.readFileSync(binPath, 'utf8')}`;
const contract = new web3.eth.Contract(abi, contractAddress);
// This is only required because Infura doesn't support subscriptions
// TODO: Remove this when websocket support lands, https://git.io/vF5o3
abiDecoder.addABI(abi);

/**
 * Utility method for uniform logging
 *
 * @param {string} level - Type of log message
 * @param {string} message - Content of this message
 */
function log(level, message) {
	const label = colors[level](`${level.toUpperCase()}`);
	const date = moment().format('L HH:mm:ss');
	console.log(`${date} [${label}] ${message}`);
}

/**
 * Checks the status of a transaction every 1000ms until received,
 * useful because web3-core-method/src/index "times out" after 50
 * blocks, but this limit is too low on certain testnets
 *
 * @param {string} hash - transaction hash to look up
 * @returns {Promise.<Object>} - Promise resolving to a transaction receipt
 */
function pollTransaction(hash) {
	return new Promise(resolve => {
		(async function tick() {
			const receipt = await web3.eth.getTransactionReceipt(hash);
			if (!receipt) { return setTimeout(tick, 1000); }
			resolve(receipt);
		})();
	});
}

/**
 * Utility method to create manually-signed transactions to call
 * contract methods, which is only necessary to support hosted
 * Ethereum nodes like Infura that don't support auto-signed
 * transactions due to private key security restrictions
 *
 * @param {string} methodName - contract method name to call
 * @param {Array} params - arguments to call method with
 * @param {number} lastNonce - the last unsuccessful nonce used
 * @param {boolean} immediate - return the transaction hash before confirmed mining
 * @param {boolean} silent - log no output during execution
 * @returns {Object} - Object containing a Promise resolving to a web3 Promise
 */
async function sendTransaction(methodName, params, lastNonce, immediate, silent) {
	let txHash;
	const nonce = lastNonce + 1 || await web3.eth.getTransactionCount(address);
	const deploy = !contract.methods[methodName];
	const data = deploy ? contract.deploy(params[0]) : contract.methods[methodName](...params);

	const tx = new Tx({
		data: data.encodeABI(),
		// TODO: Configure these more carefully
		gasLimit: web3.utils.toHex(400000),
		gasPrice: web3.utils.toHex(20000000000),
		nonce: web3.utils.toHex(nonce),
		to: contract.options.address || undefined
	});

	tx.sign(privateKey);
	const serializedTx = `0x${tx.serialize().toString('hex')}`;
	const rpcCall = web3.eth.sendSignedTransaction(serializedTx);

	return new Promise((resolve, reject) => {
		rpcCall.on('transactionHash', hash => {
			!silent && log('info', `Function: ${methodName}() ${hash}`);
			txHash = hash;
			immediate && resolve(txHash);
		});

		rpcCall.on('error', async function(error) {
			error = error.toString();

			if (error.indexOf('within 50 blocks') > -1) {
				!silent && log('info', 'Transaction not mined, polling');
				return resolve(await pollTransaction(txHash));
			}

			if (error.indexOf('known transaction') > -1 || error.indexOf('underpriced') > -1) {
				!silent && log('info', `Transaction known, retrying with nonce ${nonce + 1}`);
				return resolve(sendTransaction(methodName, params, nonce, immediate));
			}

			reject(error);
		});

		rpcCall.on('receipt', resolve);
	});
}

/**
 * Asynchronously deploys smart contract and logs contract address
 */
async function deploy() {
	try {
		const { contractAddress } = await sendTransaction('deploy', [{ data: bin }], undefined, null, true);
		console.log(contractAddress);
	} catch (error) {
		log('fail', error);
	}
};

/**
 * Starts an HTTP server on port 1337
 */
function serve() {
	const app = express();
	app.use(bodyParser.json());
	app.use(express.static(path.join(__dirname, '../build')));
	app.post('/notarize', notarize);
	app.get('/verify', verify);
	app.listen(1337, () => {
		log('info', `Server running on port 1337`)
	});
}

/**
 * Stores the sha256 hash of a string in a smart contract
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function notarize(req, res) {
	const value = req.body.value;
	const valueHash = shajs('sha256').update(value).digest('hex');

	log('info', `Notarizing "${value}"`);

	try {
		const txHash = await sendTransaction('notarize', [ valueHash ], undefined, true);
		log('info', `Notarized ${value}`);
		res.send(txHash);
	} catch (error) {
		log('fail', error);
		res.status(500).send(error);
	}
}

/**
 * Verifis that the sha256 hash of a string exists in a smart contract
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function verify(req, res) {
	const value = req.query.value;
	const valueHash = shajs('sha256').update(value).digest('hex');

	log('info', `Verifying "${value}"`);

	try {
		const receipt = await sendTransaction('verify', [ valueHash ]);
		const notarized = abiDecoder.decodeLogs(receipt.logs)[0].events[1].value;
		log('info', `Verified "${value}": ${notarized}`);

		res.send({
			notarized,
			txHash: receipt.transactionHash
		});
	} catch (error) {
		log('fail', error);
		res.status(500).send(error);
	}
}

task === 'deploy' ? deploy() : serve();
