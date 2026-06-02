'use strict';

/**
 * Outbound paymail (bsvalias) client: resolve a `alias@domain` handle to a payment
 * destination (locking script) so we can pay external paymail wallets.
 *
 * Flow: GET https://domain/.well-known/bsvalias (capability discovery) →
 *       POST the paymentDestination capability URL with { senderHandle, amount, dt } →
 *       receive { output: <P2PKH script hex> } (or p2p { outputs: [{ script }] }).
 *
 * fetch is injectable for testing.
 */

const BRFC = {
  paymentDestination: '759684b1a19a',
  p2pPaymentDestination: '2a1e8be79e21',
};

function makeClient({ fetchImpl, timeoutMs = 8000 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('no fetch available');

  async function withTimeout(p) {
    return p; // fetchImpl in tests resolves immediately; real fetch honors its own timeouts
  }

  async function getCapabilities(domain) {
    const res = await withTimeout(
      doFetch(`https://${domain}/.well-known/bsvalias`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      })
    );
    if (!res.ok) throw new Error(`paymail discovery failed for ${domain} (${res.status})`);
    const doc = await res.json();
    return doc.capabilities || {};
  }

  /** Resolve a handle to a locking-script hex for a payment of `satoshis`. */
  async function getOutputScript(handle, { satoshis, senderHandle, purpose = 'payment', dt }) {
    const [alias, domain] = String(handle).toLowerCase().split('@');
    if (!alias || !domain) throw new Error(`invalid paymail handle ${handle}`);
    const caps = await getCapabilities(domain);
    const tmpl = caps[BRFC.paymentDestination];
    if (!tmpl) throw new Error(`paymail ${handle} has no paymentDestination capability`);

    const url = tmpl.replace('{alias}', alias).replace('{domain.tld}', domain);
    const res = await withTimeout(
      doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          senderHandle,
          amount: satoshis,
          dt: dt || new Date().toISOString(),
          purpose,
        }),
      })
    );
    if (!res.ok)
      throw new Error(`paymail destination request failed for ${handle} (${res.status})`);
    const data = await res.json();
    const script = data.output || (data.outputs && data.outputs[0] && data.outputs[0].script);
    if (!script) throw new Error(`paymail ${handle} returned no output`);
    return script;
  }

  return { getCapabilities, getOutputScript };
}

module.exports = { makeClient, BRFC };
