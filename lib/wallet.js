import HDKey from 'hdkey';
import EthereumWalletPkg from 'ethereumjs-wallet';
import CommonPkg, { Hardfork } from '@ethereumjs/common';
import EthereumTxPkg from '@ethereumjs/tx';
import Big from 'big.js';
import BN from 'bn.js';
import API from './api/index.js';
import validator from './validator.js';
import Iban from './iban.js';
import ethUtil from 'ethereumjs-util';
import helpers from './helpers.js';

const { default: EthereumWallet } = EthereumWalletPkg;
const { default: EthereumCommon } = CommonPkg;
const { FeeMarketEIP1559Transaction, Transaction } = EthereumTxPkg;

// var transferTokenHash = ethUtil.keccak('transfer(address,uint256)').toString('hex').substr(0, 8);
const transferTokenHash = 'a9059cbb';

class Wallet {
  #txUrl;
  static network = {
    bip44: "m/44'/966'/0'",
    eip1559: true,
  };
  constructor(options) {
    if (!options) {
      return this;
    }

    const { seed, publicKey, crypto, platformCrypto, cache, settings } = options;
    this.crypto = crypto;
    this.platformCrypto = platformCrypto;
    this.cache = cache;
    this.settings = settings || {};
    this.settings.bip44 = this.settings.bip44 || Wallet.network.bip44;
    this.network = Wallet.network;

    this.useTestNetwork = !!options.useTestNetwork;

    let apiHistory;
    if (options.useTestNetwork) {
      this.chainId = 80001;
      this.networkId = 80001;
      this.#txUrl = 'https://mumbai.polygonscan.com/tx/${txId}';
      apiHistory = 'https://api-testnet.polygonscan.com';
    } else {
      this.chainId = 137;
      this.networkId = 137;
      this.#txUrl = 'https://polygonscan.com/tx/${txId}';
      apiHistory = 'https://api.polygonscan.com';
    }

    this.api = new API({
      request: options.request,
      apiNode: options.apiNode,
      apiHistory,
    });
    this.balance = this.cache.get('balance') || 0;
    this.confirmedBalance = 0;
    this.txsCursor = 1;
    this.txsCount = 0;
    this.gasPrice = '0';
    this.gasLimit = crypto.type === 'token' ? '200000' : '21000';
    if (this.network.eip1559) {
      this.gasFees = {
        maxPriorityFeePerGas: '0',
        maxFeePerGas: '0',
      };
    } else {
      this.gasPrice = '0';
    }
    this.minConf = options.minConf || 5;
    this.isLocked = !seed;
    this.replaceByFeeFactor = options.replaceByFeeFactor || 1.2;

    this.common = EthereumCommon.custom(
      { chainId: this.chainId, networkId: this.networkId },
      { eips: [1559], hardfork: Hardfork.London }
    );

    if (seed) {
      const hdkey = HDKey.fromMasterSeed(Buffer.from(seed, 'hex'));
      // https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki
      // https://github.com/satoshilabs/slips/blob/master/slip-0044.md
      const base = hdkey.derive(this.settings.bip44);
      this.etherWallet = EthereumWallet.fromPrivateKey(base._privateKey);
    } else if (publicKey) {
      const data = publicKey.startsWith('{') ? JSON.parse(publicKey) : publicKey;
      const pubKey = data.pubKey || data;
      this.etherWallet = EthereumWallet.fromPublicKey(Buffer.from(pubKey, 'hex'));
    } else {
      throw new Error('seed or publicKey should be passed');
    }
    this.addressString = this.etherWallet.getAddressString();
    this.checkSumAddressString = this.etherWallet.getChecksumAddressString();
  }
  async load() {
    let promises;
    if (this.crypto.type === 'token') {
      promises = [
        this.api.tokens.balance(this.crypto.address, this.addressString, this.minConf),
        this.api.addresses.txsCount(this.addressString),
        this.api.common.gasPrice(),
        this.api.common.getPolygonscanApiKey(),
        this.api.addresses.balance(this.addressString, this.minConf),
        this.update(),
      ];
    } else {
      promises = [
        this.api.addresses.balance(this.addressString, this.minConf),
        this.api.addresses.txsCount(this.addressString),
        this.api.common.gasPrice(),
        this.api.common.getPolygonscanApiKey(),
        this.update(),
      ];
    }

    const results = await Promise.all(promises);
    this.balance = results[0].balance;
    this.cache.set('balance', this.balance);
    this.txsCursor = 1;
    this.confirmedBalance = results[0].confirmedBalance;
    this.txsCount = results[1];
    this.gasPrice = results[2];
    this.api.polygonscanApiKey = results[3];
    if (this.crypto.type === 'token') {
      this.maticBalance = helpers.min(results[4].confirmedBalance, results[4].balance);
    }
  }
  async update() {
    if (this.network.eip1559) {
      this.gasFees = await this.api.common.gasFees();
    } else {
      this.gasPrice = await this.api.common.gasPrice();
    }
  }
  async loadTxs() {
    const data = this.crypto.type === 'token'
      ? await this.api.tokens.txs(this.crypto.address, this.addressString, this.txsCursor)
      : await this.api.addresses.txs(this.addressString, this.txsCursor);
    data.txs = transformTxs(this, data.txs);
    this.txsCursor = data.cursor;
    return data;
  }
  lock() {
    this.etherWallet._privKey = null;
    this.isLocked = true;
  }
  unlock(seed) {
    const hdkey = HDKey.fromMasterSeed(Buffer.from(seed, 'hex'));
    const base = hdkey.derive(this.settings.bip44);
    this.etherWallet = EthereumWallet.fromPrivateKey(base._privateKey);
    this.isLocked = false;
  }
  publicKey() {
    const data = {
      pubKey: this.etherWallet.pubKey.toString('hex'),
      path: this.settings.bip44,
    };
    return JSON.stringify(data);
  }
  getNextAddress() {
    return this.checkSumAddressString;
  }
  createTx(to, value) {
    validator.transaction({
      wallet: this,
      to,
      value,
    });

    const params = {
      nonce: new BN(this.txsCount),
      ...this.#gasParams(),
    };

    if (this.crypto.type === 'token') {
      params.to = this.crypto.address;
      params.value = new BN(0);
      params.data = '0x' + transferTokenHash;
      params.data += helpers.padLeft(to.substr(2), 32);
      params.data += helpers.padLeft(new BN(value).toString(16), 32);
    } else {
      params.to = to;
      params.value = new BN(value);
    }
    const that = this;
    const tx = this.#buildTransaction(params);
    return {
      sign() {
        return tx.sign(that.etherWallet.getPrivateKey());
      },
    };
  }
  get defaultFee() {
    return Big(this.gasLimit).times(this.network.eip1559 ? this.gasFees.maxFeePerGas : this.gasPrice);
  }
  get maxAmount() {
    const fee = this.crypto.type === 'token' ? 0 : this.defaultFee;
    const balance = Big(this.balance).minus(fee);
    return helpers.max(balance, 0);
  }
  async sendTx(tx) {
    const rawtx = '0x' + tx.serialize().toString('hex');
    await this.api.transactions.propagate(rawtx);
    if (this.crypto.type === 'token') {
      return this.processTokenTx(tx);
    } else {
      return this.processTx(tx);
    }
  }
  async processTx(tx) {
    const from = tx.getSenderAddress().toString();
    const to = tx.to.toString();

    let amount = new BN(tx.value);

    if (from === to) {
      amount = new BN(0);
    } else if (from === this.addressString) {
      amount = new BN(tx.value).neg();
    }

    const fee = from === this.addressString ? this.#txFee(tx) : new BN(0);
    this.balance = new BN(this.balance).add(amount).sub(fee).toString(10);
    if (from === this.addressString) {
      this.txsCount++;
    }
    this.cache.set('balance', this.balance);
    return false;
  }
  async processTokenTx(tx) {
    const from = tx.getSenderAddress().toString();
    const to = `0x${tx.data.slice(16, 36).toString('hex')}`;
    let value = new BN(tx.data.slice(36));
    if (from === to) {
      value = new BN(0);
    } else if (from === this.addressString) {
      value = value.neg();
    }
    this.balance = new BN(this.balance).add(value).toString(10);
    if (from === this.addressString) {
      const fee = this.#txFee(tx);
      this.maticBalance = new BN(this.maticBalance).sub(fee).toString(10);
      this.txsCount++;
    }
    this.cache.set('balance', this.balance);
    return false;
  }
  isValidIban(str) {
    return Iban.isValid(str);
  }
  getAddressFromIban(str) {
    return new Iban(str).address();
  }
  createPrivateKey(str) {
    if (str.indexOf('0x') === 0) {
      str = str.substr(2);
    }
    const privateKey = Buffer.from(str, 'hex');
    if (!ethUtil.isValidPrivate(privateKey)) {
      throw new Error('Invalid private key');
    }
    return privateKey;
  }
  createImportTx(options) {
    const fee = this.crypto.type === 'token' ? 0 : this.defaultFee;
    const amount = Big(options.amount).minus(fee);
    if (amount.lt(0)) {
      throw new Error('Insufficient funds');
    }
    if (this.crypto.type === 'token') {
      const ethFee = this.defaultFee;
      if (Big(options.maticBalance).lt(ethFee)) {
        const error = new Error('Insufficient funds for token transaction');
        error.required = ethFee;
        throw error;
      }
    }
    const params = {
      nonce: new BN(options.txsCount),
      ...this.#gasParams(),
    };
    if (this.crypto.type === 'token') {
      params.to = this.crypto.address;
      params.value = new BN(0);
      params.data = '0x' + transferTokenHash;
      params.data += helpers.padLeft(options.to.substr(2), 32);
      params.data += helpers.padLeft(new BN(amount.toFixed(0)).toString(16), 32);
    } else {
      params.to = options.to;
      params.value = new BN(amount.toFixed(0));
    }
    const tx = this.#buildTransaction(params);
    return {
      sign() {
        return tx.sign(options.privateKey);
      },
    };
  }
  async getImportTxOptions(privateKey) {
    const publicKey = ethUtil.privateToPublic(privateKey);
    const address = ethUtil.bufferToHex(ethUtil.pubToAddress(publicKey));

    let promises;
    if (this.crypto.type === 'token') {
      promises = [
        this.api.tokens.balance(this.crypto.address, address, this.minConf),
        this.api.addresses.txsCount(address),
        this.api.common.gasPrice(),
        this.api.addresses.balance(address, this.minConf),
      ];
    } else {
      promises = [
        this.api.addresses.balance(address, this.minConf),
        this.api.addresses.txsCount(address),
        this.api.common.gasPrice(),
      ];
    }

    const results = await Promise.all(promises);
    this.gasPrice = results[2];

    const importTxOptions = {
      privateKey,
      amount: helpers.min(results[0].confirmedBalance, results[0].balance),
      txsCount: results[1],
    };
    if (this.crypto.type === 'token') {
      importTxOptions.maticBalance = helpers.min(results[3].confirmedBalance, results[3].balance);
    }
    return importTxOptions;
  }
  exportPrivateKeys() {
    let str = 'address,privatekey\n';
    str += this.addressString + ',' + this.etherWallet.getPrivateKeyString().substr(2);
    return str;
  }
  txUrl(txId) {
    return this.#txUrl.replace('${txId}', txId);
  }
  #gasParams() {
    return {
      gasLimit: new BN(this.gasLimit),
      ...this.network.eip1559 ? {
        maxPriorityFeePerGas: new BN(this.gasFees.maxPriorityFeePerGas),
        maxFeePerGas: new BN(this.gasFees.maxFeePerGas),
      } : {
        gasPrice: new BN(this.gasPrice),
      },
    };
  }
  #txFee({ gasLimit, gasPrice, maxFeePerGas }) {
    return new BN(gasLimit).mul(maxFeePerGas || gasPrice);
  }
  #buildTransaction(params, options = {}) {
    if (this.network.eip1559) {
      return FeeMarketEIP1559Transaction.fromTxData(params, { common: this.common, ...options });
    } else {
      return Transaction.fromTxData(params, { common: this.common, ...options });
    }
  }
  serialize() {
    return JSON.stringify({
      crypto: this.crypto,
      balance: this.balance,
      confirmedBalance: this.confirmedBalance,
      txsCount: this.txsCount,
      privateKey: this.etherWallet.getPrivateKeyString(),
      addressString: this.etherWallet.getAddressString(),
      gasPrice: this.gasPrice,
      gasLimit: this.gasLimit,
      minConf: this.minConf,
      chainId: this.chainId,
      networkId: this.networkId,
    });
  }
  static deserialize(json) {
    const wallet = new Wallet();
    const deserialized = JSON.parse(json);
    const privateKey = wallet.createPrivateKey(deserialized.privateKey);

    wallet.crypto = deserialized.crypto;
    wallet.cache = { get: () => {}, set: () => {} };
    wallet.api = new API({});
    wallet.balance = deserialized.balance;
    wallet.confirmedBalance = deserialized.confirmedBalance;
    wallet.txsCount = deserialized.txsCount;
    wallet.etherWallet = EthereumWallet.fromPrivateKey(privateKey);
    wallet.addressString = deserialized.addressString;
    wallet.gasPrice = deserialized.gasPrice;
    wallet.gasLimit = deserialized.gasLimit;
    wallet.minConf = deserialized.minConf;
    wallet.chainId = deserialized.chainId;
    wallet.networkId = deserialized.networkId;
    wallet.common = EthereumCommon.custom(
      { chainId: wallet.chainId, networkId: wallet.networkId },
      { eips: [1559], hardfork: Hardfork.London }
    );
    return wallet;
  }
}

function transformTxs(wallet, txs) {
  const address = wallet.addressString;
  if (Array.isArray(txs)) {
    return txs.map((tx) => {
      return transformTx(address, tx);
    });
  } else {
    return transformTx(address, txs);
  }
  function transformTx(address, tx) {
    let amount = tx.value;
    if (tx.from === tx.to) {
      amount = '0';
    } else if (tx.from === address) {
      amount = '-' + tx.value;
    }
    const isIncoming = tx.to === address && tx.from !== tx.to;
    return {
      id: tx.hash,
      amount,
      value: tx.value,
      timestamp: parseInt(`${tx.timeStamp}000`),
      confirmed: tx.confirmations >= wallet.minConf,
      minConf: wallet.minConf,
      confirmations: parseInt(tx.confirmations),
      fee: tx.gasUsed ? (Big(tx.gasUsed).times(tx.gasPrice).toFixed(0)) : -1,
      maxFee: tx.gas ? Big(tx.gas).times(tx.gasPrice).toFixed(0) : 0,
      gasPrice: tx.gasPrice,
      gasLimit: tx.gas,
      status: tx.contractAddress ? true : tx.txreceipt_status === '1',
      from: tx.from,
      to: tx.to,
      token: tx.contractAddress,
      isIncoming,
      isRBF: false,
    };
  }
}

export default Wallet;
