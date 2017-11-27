/**
 * Express 4 HTTP server that auto-deploys a smart contract to the
 * Ethereum blockchain and interacts with it using RPC via web3
 *
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

const { source } = yargs.option('s', {
	alias: 'source',
	demandOption: true,
	describe: 'Contract source file to compile',
	type: 'string'
}).argv;

const {
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

class HttpServer {
	/**
	 * Asynchronous initialization
	 */
	async init() {
		this.web3 = new Web3(new Web3.providers.HttpProvider(provider));
		this.privateKey = keythereum.recover(password, JSON.parse(keyfile));
		this.contract = await this._initSmartContract();
		this.app = this._initAppServer();

		this.app.post('/notarize', this._notarize.bind(this));
		this.app.get('/verify', this._verify.bind(this));
	}

	/**
	 * Starts the HTTP server
	 *
	 * @param port {number} - Port to start server on
	 */
	listen(port = 1337) {
		this.app.listen(port, () => {
			this.log('info', `Server running on port ${port}`)
		});
	}

	/**
	 * Utility method for uniform logging
	 *
	 * @param {string} level - Type of log message
	 * @param {string} message - Content of this message
	 */
	log(level, message) {
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
	pollTransaction(hash) {
		const self = this;
		return new Promise(resolve => {
			(async function tick() {
				const receipt = await self.web3.eth.getTransactionReceipt(hash);
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
	 * @returns {Object} - Object containing a Promise resolving to a web3 Promise
	 */
	async sendTransaction(methodName, params, lastNonce, immediate) {
		let txHash;
		const self = this;
		const contract = this.contract;
		const nonce = lastNonce + 1 || await this.web3.eth.getTransactionCount(address);
		const deploy = !contract.methods[methodName];
		const data = deploy ? contract.deploy(params[0]) : contract.methods[methodName](...params);

		const tx = new Tx({
			data: data.encodeABI(),
			// TODO: Configure these more carefully
			gasLimit: this.web3.utils.toHex(400000),
			gasPrice: this.web3.utils.toHex(20000000000),
			nonce: this.web3.utils.toHex(nonce),
			to: contract.options.address || undefined
		});

		tx.sign(this.privateKey);
		const serializedTx = `0x${tx.serialize().toString('hex')}`;
		const rpcCall = this.web3.eth.sendSignedTransaction(serializedTx);

		return new Promise((resolve, reject) => {
			rpcCall.on('transactionHash', hash => {
				this.log('info', `Function: ${methodName}() ${hash}`);
				txHash = hash;
				immediate && resolve(txHash);
			});

			rpcCall.on('error', async function(error) {
				error = error.toString();

				if (error.indexOf('within 50 blocks') > -1) {
					self.log('info', 'Transaction not mined, polling');
					return resolve(await self.pollTransaction(txHash));
				}

				if (error.indexOf('known transaction') > -1 || error.indexOf('underpriced') > -1) {
					self.log('info', `Transaction known, retrying with nonce ${nonce + 1}`);
					return resolve(self.sendTransaction(methodName, params, nonce, immediate));
				}

				reject(error);
			});

			rpcCall.on('receipt', resolve);
		});
	}

	_initAppServer() {
		const app = express();
		app.use(bodyParser.json());
		app.use(express.static(path.join(__dirname, '../build')));
		return app;
	}

	async _initSmartContract() {
		const fileName = `:${path.basename(source, '.sol')}`;
		const input = fs.readFileSync(source);
		const output = solc.compile(input.toString(), 1);
		const bytecode = `0x${output.contracts[fileName].bytecode}`;
		const ABI = JSON.parse(output.contracts[fileName].interface);
		this.contract = new this.web3.eth.Contract(ABI, null);
		// This is only required because Infura doesn't support subscriptions
		// TODO: Remove this when websocket support lands, https://git.io/vF5o3
		abiDecoder.addABI(ABI);

		this.log('info', 'Deploying contract');

		try {
			const { contractAddress } = await this.sendTransaction('deploy', [{ data: bytecode }]);
			this.contract.options.address = contractAddress;
			this.log('info', `Deployed contract ${contractAddress}`);
			return this.contract;
		} catch (error) {
			this.log('fail', error);
		}
	}

	async _notarize(req, res) {
		const value = req.body.value;
		const valueHash = shajs('sha256').update(value).digest('hex');

		this.log('info', `Notarizing "${value}"`);

		try {
			const txHash = await this.sendTransaction('notarize', [ valueHash ], undefined, true);
			this.log('info', `Notarized ${value}`);
			res.send(txHash);
		} catch (error) {
			this.log('fail', error);
			res.status(500).send(error);
		}
	}

	async _verify(req, res) {
		const value = req.query.value;
		const valueHash = shajs('sha256').update(value).digest('hex');

		this.log('info', `Verifying "${value}"`);

		try {
			const receipt = await this.sendTransaction('verify', [ valueHash ]);
			const notarized = abiDecoder.decodeLogs(receipt.logs)[0].events[1].value;
			this.log('info', `Verified "${value}": ${notarized}`);

			res.send({
				notarized,
				txHash: receipt.transactionHash
			});
		} catch (error) {
			this.log('fail', error);
			res.status(500).send(error);
		}
	}
}

const server = new HttpServer();
server.init().then(() => { server.listen(); });
