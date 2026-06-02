'use strict';

const { ChainProvider } = require('./ChainProvider');

/**
 * WhatsOnChain (https://whatsonchain.com) adapter.
 * Uses the public REST API. Pass an apiKey to lift rate limits.
 * Requires global fetch (Node 18+).
 */
class WhatsOnChainProvider extends ChainProvider {
  constructor({ network = 'livenet', apiKey, fetchImpl } = {}) {
    super();
    this._network = network;
    const woc = network === 'testnet' ? 'test' : 'main';
    this.base = `https://api.whatsonchain.com/v1/bsv/${woc}`;
    this.apiKey = apiKey;
    this.fetch = fetchImpl || globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw new Error('No fetch available; pass opts.fetchImpl or use Node 18+');
    }
  }

  get network() {
    return this._network;
  }

  async _get(path) {
    const res = await this.fetch(this.base + path, {
      headers: this.apiKey ? { woc_api_key: this.apiKey } : {},
    });
    if (!res.ok) {
      throw new Error(`WoC GET ${path} -> ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async _post(path, body) {
    const res = await this.fetch(this.base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { woc_api_key: this.apiKey } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`WoC POST ${path} -> ${res.status}: ${text}`);
    }
    return text;
  }

  async getBalance(address) {
    const b = await this._get(`/address/${address}/balance`);
    return { confirmed: b.confirmed || 0, unconfirmed: b.unconfirmed || 0 };
  }

  async getUtxos(address) {
    const list = await this._get(`/address/${address}/unspent`);
    return list.map((u) => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      satoshis: u.value,
      script: null, // filled lazily by the tx builder via getRawTx if needed
    }));
  }

  async getRawTx(txid) {
    const data = await this._get(`/tx/${txid}/hex`);
    // WoC returns the hex as a JSON string for this endpoint variant; normalise.
    return typeof data === 'string' ? data : data.hex || data;
  }

  async broadcast(rawTxHex) {
    const txid = await this._post('/tx/raw', { txhex: rawTxHex });
    return txid.replace(/^"|"$/g, '').trim();
  }

  async getHeight() {
    const info = await this._get('/chain/info');
    return info.blocks;
  }

  async getHeaderForHeight(height) {
    const h = await this._get(`/block/height/${height}/header`);
    return h.hex || h;
  }
}

module.exports = { WhatsOnChainProvider };
