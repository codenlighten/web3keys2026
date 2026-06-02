'use strict';

/**
 * ChainProvider is the pluggable interface every chain data source must implement.
 * The wallet core never talks to the network directly — it goes through a provider,
 * so you can swap WhatsOnChain for GorillaPool/1Sat, a local node, or a mock in tests.
 *
 * UTXO shape returned by getUtxos / getOrdinalUtxos:
 *   { txid: string, vout: number, satoshis: number, script: string(hex) }
 */
class ChainProvider {
  /** @returns {'livenet'|'testnet'} */
  get network() {
    throw new Error('not implemented');
  }

  /** Confirmed + unconfirmed balance in satoshis: { confirmed, unconfirmed }. */
  // eslint-disable-next-line no-unused-vars
  async getBalance(address) {
    throw new Error('getBalance not implemented');
  }

  /** Spendable UTXOs for an address (array of UTXO objects). */
  // eslint-disable-next-line no-unused-vars
  async getUtxos(address) {
    throw new Error('getUtxos not implemented');
  }

  /** Raw transaction hex for a txid. Needed to populate input scripts/satoshis. */
  // eslint-disable-next-line no-unused-vars
  async getRawTx(txid) {
    throw new Error('getRawTx not implemented');
  }

  /** Broadcast raw tx hex; resolves to txid. */
  // eslint-disable-next-line no-unused-vars
  async broadcast(rawTxHex) {
    throw new Error('broadcast not implemented');
  }

  /** Current chain tip height. */
  async getHeight() {
    throw new Error('getHeight not implemented');
  }

  /** 80-byte block header hex for a height (BRC-100 getHeaderForHeight). */
  // eslint-disable-next-line no-unused-vars
  async getHeaderForHeight(height) {
    throw new Error('getHeaderForHeight not implemented');
  }

  /**
   * Ordinal (1-sat) UTXOs for an address. Optional — providers that don't index
   * ordinals can fall back to filtering getUtxos() for 1-sat outputs.
   */
  async getOrdinalUtxos(address) {
    const utxos = await this.getUtxos(address);
    return utxos.filter((u) => u.satoshis === 1);
  }
}

module.exports = { ChainProvider };
