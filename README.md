![Melfina logo](public/favicon.png?raw=true)

Melfina is a proof-of-thought smart contract built on the [Ethereum](https://ethereum.org/) blockchain with a [React](https://reactjs.org/)-powered interface served by [Express](https://expressjs.com/).

[https://melfina.network](https://melfina.network/)

[![Build Status](https://travis-ci.org/bitpshr/melfina.svg?branch=master)](https://travis-ci.org/bitpshr/melfina)

## Running locally

```sh
$ npm install
$ 
$ # Expose other env vars; dotenv is also supported
$ export ETH_ADDRESS=<address>      # wallet to fund transactions
$ export ETH_KEYFILE=<json>         # wallet keyfile JSON
$ export ETH_PASSWORD=<password>    # wallet keyfile password
$ export ETH_PROVIDER=<provider>    # ethereum node URL
$
$ # Deploy contract and store address as env var
$ export CONTRACT_ADDRESS="$(node src/main.js -t deploy)"
$
$ # Build the frontend
$ npm run build:client
$ 
$ # Start Express HTTP server
$ npm start                           
```

Visit [http://localhost:1337](http://localhost:1337).

## License

[WTFPL](http://www.wtfpl.net/)
