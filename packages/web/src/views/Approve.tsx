// SmartLedger Login approval pages. Third-party apps (via sl-login.js) redirect the
// user's browser here — /login, /attest, /publish — to approve a request signed by
// their identity key. On approve we sign client-side and redirect back to the app's
// redirect_uri with the result; on cancel we redirect back with ?error=user_cancelled.
// The identity private key never leaves this page.

import { useMemo, useState } from 'react';
import { api } from '../api';
import { walletSession } from '../walletSession';
import {
  signLogin,
  signAttest,
  scopeAddresses,
  buildOpReturnTx,
  type PublishOutput,
} from '../wallet';

type Kind = 'login' | 'attest' | 'publish';

// base64url → utf-8 string (matches sl-login.js b64url()).
function fromB64url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return decodeURIComponent(escape(atob(b64)));
}

/** Validate and return the app's origin/hostname from a redirect_uri, or null. */
function appOrigin(redirectUri: string | null): { url: URL; hostname: string } | null {
  if (!redirectUri) return null;
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return { url, hostname: url.hostname };
  } catch {
    return null;
  }
}

function redirectBack(redirectUri: string, params: Record<string, string>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  window.location.href = u.toString();
}

export function Approve({ kind }: { kind: Kind }) {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const app = (params.get('app') || 'A web app').slice(0, 128);
  const redirectUri = params.get('redirect_uri');
  const target = appOrigin(redirectUri);

  // Requested optional scopes (login only): receive addresses the app would like shared.
  const requested = (params.get('request') || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s === 'ordinals' || s === 'finance');
  const [shareFin, setShareFin] = useState(requested.includes('finance'));
  const [shareOrd, setShareOrd] = useState(requested.includes('ordinals'));

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Bad/missing redirect_uri → nothing safe to do; don't sign or open-redirect.
  if (!target) {
    return (
      <div className="approve">
        <h2>Invalid request</h2>
        <p className="error">This sign-in request is missing a valid return address.</p>
        <p className="muted">Close this window and try again from the app.</p>
      </div>
    );
  }
  const domain = target.hostname;

  function cancel() {
    redirectBack(redirectUri!, { error: 'user_cancelled' });
  }

  async function approve() {
    setErr('');
    setBusy(true);
    try {
      const { mnemonic, passphrase } = walletSession.get();
      if (kind === 'login') {
        const challenge = params.get('challenge') || '';
        const { address, signature, bapId, identityKey } = signLogin(
          mnemonic,
          passphrase,
          domain,
          challenge
        );
        const out: Record<string, string> = { address, signature, challenge, bapId, identityKey };
        if (shareFin || shareOrd) {
          const sc = scopeAddresses(mnemonic, passphrase);
          if (shareFin) out.finAddress = sc.finAddress;
          if (shareOrd) out.ordAddress = sc.ordAddress;
        }
        redirectBack(redirectUri!, out);
      } else if (kind === 'attest') {
        const nonce = params.get('nonce') || '';
        const payload = fromB64url(params.get('payload') || '');
        const { address, signature } = signAttest(
          mnemonic,
          passphrase,
          app,
          domain,
          nonce,
          payload
        );
        redirectBack(redirectUri!, { address, signature, nonce });
      } else {
        const nonce = params.get('nonce') || '';
        const outputs = JSON.parse(fromB64url(params.get('outputs') || ''))
          .outputs as PublishOutput[];
        const { utxos } = await api.utxos();
        if (!utxos.length) throw new Error('no spendable funds to cover the network fee');
        const rawHex = buildOpReturnTx(mnemonic, passphrase, utxos, outputs);
        const { txid } = await api.broadcast(rawHex);
        redirectBack(redirectUri!, { txid, nonce });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
      setBusy(false);
    }
  }

  return (
    <div className="approve">
      <h2>
        {kind === 'login' ? 'Sign in to' : kind === 'attest' ? 'Sign for' : 'Publish from'}{' '}
        <strong>{app}</strong>
      </h2>
      <p className="muted">
        on <span className="badge">{domain}</span>
      </p>

      {kind === 'login' && (
        <>
          <p>This app wants to verify you control your web3keys identity.</p>
          {requested.length > 0 && (
            <div className="scopes">
              <p className="muted">It also requests (optional — uncheck to deny):</p>
              {requested.includes('finance') && (
                <label>
                  <input
                    type="checkbox"
                    checked={shareFin}
                    onChange={(e) => setShareFin(e.target.checked)}
                  />{' '}
                  Share my BSV receive address
                </label>
              )}
              {requested.includes('ordinals') && (
                <label>
                  <input
                    type="checkbox"
                    checked={shareOrd}
                    onChange={(e) => setShareOrd(e.target.checked)}
                  />{' '}
                  Share my 1Sat Ordinals address
                </label>
              )}
            </div>
          )}
        </>
      )}

      {kind === 'attest' && (
        <>
          <p>This app wants you to cryptographically sign the following data:</p>
          <pre className="payload">{fromB64url(params.get('payload') || '')}</pre>
        </>
      )}

      {kind === 'publish' && (
        <>
          <p>
            This app wants to publish data on-chain, paid from your wallet. You spend your own BSV
            (network fee only).
          </p>
          <pre className="payload">{fromB64url(params.get('outputs') || '')}</pre>
        </>
      )}

      <p className="muted small">Your private keys never leave this device.</p>
      {err && <p className="error">{err}</p>}

      <div className="row">
        <button className="ghost" onClick={cancel} disabled={busy}>
          Cancel
        </button>
        <button onClick={approve} disabled={busy}>
          {busy
            ? 'Working…'
            : kind === 'login'
              ? 'Approve sign-in'
              : kind === 'attest'
                ? 'Sign'
                : 'Publish'}
        </button>
      </div>
    </div>
  );
}
