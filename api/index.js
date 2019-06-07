const Tx = require('ethereumjs-tx');
const Web3 = require('web3');
const abiDecoder = require('abi-decoder');
const bodyParser = require('body-parser');
const chalk = require('chalk');
const express = require('express');
const fs = require('fs');
const keystore = require('./data/keystore.json');
const keythereum = require('keythereum');
const moment = require('moment');
const path = require('path');
const shajs = require('sha.js');

const colors = {
	fail: chalk.red,
	info: chalk.white,
	warn: chalk.yellow
};

const web3 = new Web3(new Web3.providers.HttpProvider('https://rinkeby.infura.io/v3/91373a66c8ba4ebd89632115bc3df76c'));
const privateKey = keythereum.recover('password', keystore);
const abiPath = 'data/src_contracts_ProofOfExistence_sol_ProofOfExistence.abi';
const abi = JSON.parse(fs.readFileSync(path.join(__dirname, abiPath), 'utf8'));
const contract = new web3.eth.Contract(abi, '0x58df3b0e6cbf1ae0691c51322252b6a3d52aa6f2');
abiDecoder.addABI(abi);

function log(level, message) {
	const label = colors[level](`${level.toUpperCase()}`);
	const date = moment().format('L HH:mm:ss');
	console.log(`${date} [${label}] ${message}`);
}

function pollTransaction(hash) {
	return new Promise(resolve => {
		(async function tick() {
			const receipt = await web3.eth.getTransactionReceipt(hash);
			if (!receipt) {
				return setTimeout(tick, 1000);
			}
			resolve(receipt);
		})();
	});
}

async function sendTransaction(methodName, params, lastNonce, immediate) {
	let txHash;
	const nonce = lastNonce + 1 || (await web3.eth.getTransactionCount('0xb0447e3e270e5595c30074f8c101233fa02b427d'));
	const data = contract.methods[methodName](...params);

	const tx = new Tx({
		data: data.encodeABI(),
		gasLimit: web3.utils.toHex(400000),
		gasPrice: web3.utils.toHex(20000000000),
		nonce: web3.utils.toHex(nonce),
		to: contract.options.address || undefined
	});

	tx.sign(privateKey);
	const serializedTx = `0x${tx.serialize().toString('hex')}`;
	const rpcCall = web3.eth.sendSignedTransaction(serializedTx);

	return new Promise((resolve, reject) => {
		rpcCall.on('transactionHash', async hash => {
			log('info', `Function: ${methodName}() ${hash}`);
			txHash = hash;
			immediate && resolve(txHash);
			resolve(await pollTransaction(txHash));
		});

		rpcCall.on('error', async function(error) {
			error = error.toString();

			if (error.indexOf('known transaction') > -1 || error.indexOf('underpriced') > -1) {
				log('info', `Transaction known, retrying with nonce ${nonce + 1}`);
				return resolve(sendTransaction(methodName, params, nonce, immediate));
			}

			reject(error);
		});

		rpcCall.on('receipt', resolve);
	});
}

async function verify(req, res) {
	const value = req.query.value;
	const valueHash = shajs('sha256')
		.update(value)
		.digest('hex');

	log('info', `Verifying "${value}"`);

	try {
		const receipt = await sendTransaction('verify', [valueHash]);
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

async function notarize(req, res) {
	const value = req.body.value;
	const valueHash = shajs('sha256')
		.update(value)
		.digest('hex');

	log('info', `Notarizing "${value}"`);

	try {
		const txHash = await sendTransaction('notarize', [valueHash], undefined, true);
		log('info', `Notarized ${value}`);
		res.send(txHash);
	} catch (error) {
		log('fail', error);
		res.status(500).send(error);
	}
}

function listen() {
	const app = express();
	app.use(bodyParser.json());
	app.use(express.static(path.join(__dirname, './public')));
	app.get('/verify', verify);
	app.post('/notarize', notarize);
	app.listen(1337, () => {
		log('info', `Server running on port 1337`);
	});
	return app;
}

module.exports = listen();
