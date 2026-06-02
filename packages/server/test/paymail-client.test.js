'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeClient, BRFC } = require('../src/paymailClient');

// A scripted fetch: capability discovery → payment destination.
function mockFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses(url, opts);
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.body,
    };
  };
  fn.calls = calls;
  return fn;
}

test('paymail client resolves a payment destination script', async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.endsWith('/.well-known/bsvalias')) {
      return {
        body: {
          bsvalias: '1.0',
          capabilities: {
            [BRFC.paymentDestination]: 'https://other.com/api/pay/{alias}@{domain.tld}',
          },
        },
      };
    }
    if (url.includes('/api/pay/bob@other.com')) {
      return { body: { output: '76a914' + '11'.repeat(20) + '88ac' } };
    }
    return { ok: false, status: 404, body: {} };
  });

  const client = makeClient({ fetchImpl });
  const script = await client.getOutputScript('bob@other.com', {
    satoshis: 1000,
    senderHandle: 'me@web3keys.com',
  });
  assert.match(script, /^76a914[0-9a-f]{40}88ac$/);

  // it discovered capabilities then posted to the templated destination URL
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(fetchImpl.calls[1].url.includes('bob@other.com'));
  const sent = JSON.parse(fetchImpl.calls[1].opts.body);
  assert.equal(sent.senderHandle, 'me@web3keys.com');
  assert.equal(sent.amount, 1000);
  assert.ok(sent.dt);
});

test('paymail client handles p2p outputs array', async () => {
  const fetchImpl = mockFetch((url) =>
    url.endsWith('/.well-known/bsvalias')
      ? {
          body: {
            capabilities: { [BRFC.paymentDestination]: 'https://x.io/d/{alias}@{domain.tld}' },
          },
        }
      : { body: { outputs: [{ script: '76a914' + '22'.repeat(20) + '88ac', satoshis: 5 }] } }
  );
  const client = makeClient({ fetchImpl });
  const script = await client.getOutputScript('a@x.io', { satoshis: 5 });
  assert.match(script, /^76a914[0-9a-f]{40}88ac$/);
});

test('paymail client errors when destination capability is missing', async () => {
  const fetchImpl = mockFetch(() => ({ body: { capabilities: {} } }));
  const client = makeClient({ fetchImpl });
  await assert.rejects(
    () => client.getOutputScript('a@x.io', { satoshis: 5 }),
    /no paymentDestination capability/
  );
});
