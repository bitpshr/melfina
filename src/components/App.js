import React, { Component } from 'react';
import './App.css';

class App extends Component {
	constructor(props) {
		super(props);

		this.onInputChange = this.onInputChange.bind(this);
		this.notarize = this.notarize.bind(this);
		this.verify = this.verify.bind(this);

		this.state = {
			contractAddress: undefined,
			loading: false,
			processes: [],
			value: ''
		};
	}

	componentDidMount() {
		this.updateContractAddress();
	}

	onInputChange(event) {
		this.setState({ value: event.target.value });
	}

	disable() {
		return this.setStateAsync({
			loading: true,
			processes: []
		});
	}

	enable() {
		return this.setStateAsync({
			loading: false,
			value: ''
		});
	}

	finishProcess(ok, status) {
		const processes = [...this.state.processes];
		const lastProcess = processes[processes.length - 1];
		lastProcess.status = ok ? 'ok' : 'fail';
		lastProcess.status = status || lastProcess.status;
		lastProcess.ok = ok;
		return this.setStateAsync({ processes });
	}

	async updateContractAddress() {
		this.setState({
			contractAddress: await fetch('/address').then(response => response.text())
		});
	}

	async notarize() {
		let txHash = '';

		await this.disable();
		await this.queueProcess('Building transaction', true, true);
		this.queueProcess('Sending transaction');

		try {
			txHash = await fetch('/notarize', {
				body: JSON.stringify({ value: this.state.value }),
				headers: new Headers({'content-type': 'application/json; charset=UTF-8'}),
				method: 'POST'
			})
			.then(response => {
				if (!response.ok) {
					throw new Error(response.text())
				}
				return response.text();
			});
		} catch(error) {
			console.error(error);
			await this.enable();
			return this.finishProcess(false);
		}

		await this.finishProcess(true);
		await this.queueProcess('Cleaning up', true, true);
		await this.renderTxLink(txHash);

		this.enable();
	}

	queueProcess(msg, immediate, ok, status) {
		const promise = this.setStateAsync({
			processes: [
				...this.state.processes,
				{
					msg,
					status: <i className="fa fa-circle-o-notch spinner" aria-hidden="true"></i>
				}
			]
		});

		return immediate ? promise.then(() => this.finishProcess(ok, status)) : promise;
	}

	setStateAsync(state) {
		return new Promise(resolve => { this.setState(state, resolve) });
	}

	async verify() {
		let data = {};

		await this.disable();
		await this.queueProcess('Building transaction', true, true);
		this.queueProcess('Sending transaction');

		try {
			data = await fetch(`/verify?value=${this.state.value}`)
				.then(response => {
					if (!response.ok) {
						throw new Error(response.text())
					}
					return response.json();
				});
		} catch(error) {
			console.error(error);
			await this.enable();
			return this.finishProcess(false);
		}

		await this.finishProcess(true);
		await this.queueProcess('Cleaning up', true, true);
		await this.queueProcess('Verified?', true, data.notarized, <div>{String(data.notarized)}</div>);
		await this.renderTxLink(data.txHash);

		this.enable();
	}

	renderTxLink(txHash) {
		return this.queueProcess('Complete', true, true, <div>
			<a href={`https://rinkeby.etherscan.io/tx/${txHash}`} target="_blank">
				Transaction <i class="fa fa-external-link" aria-hidden="true"></i>
			</a>
		</div>);
	}

	render() {
		const {
			contractAddress,
			loading,
			processes,
			value
		} = this.state;

		return (
			<div className="content">
				<div className="stage">
					<textarea
						className="textarea"
						disabled={loading}
						onChange={this.onInputChange}
						placeholder="Message..."
						value={value}
					></textarea>
					<div className="action">
						<div className="count">{value.length} Chars</div>
						<button
							className="btn verify"
							disabled={loading}
							onClick={this.verify}
						>Verify</button>
						<button
							className="btn notarize"
							disabled={loading}
							onClick={this.notarize}
						>Submit</button>
					</div>
				</div>
				<div className="info">
					<h1>MELFINA</h1>
					<p>Melfina is a proof-of-thought smart contract running on the Ethereum blockchain.</p>
					<p className="instructions">Submit a thought to store its SHA-256 hash permanently on the blockchain. Verify a thought to see if it's been stored before.</p>
					<div className="contractAddress">
						Contract deployed
						{contractAddress && <span className="status">
							<div>
								<a
									href={`https://rinkeby.etherscan.io/address/${contractAddress}`} target="_blank"
								>
									Address <i className="fa fa-external-link" aria-hidden="true"></i>
								</a>
							</div>
						</span>}
					</div>
					{processes.map(process => (
						<div key={process.msg}>
							{process.msg}
							<span className={`status ${!process.ok ? 'error' : 'ok'}`}>
								{process.status}
							</span>
						</div>
					))}
				</div>
				<i className="fa fa-circle-o-notch preload" aria-hidden="true"></i>
			</div>
		);
	}
}

export default App;
