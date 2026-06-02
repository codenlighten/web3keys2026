import { useState } from 'react';
import { api, token, ApiError, type Profile } from '../api';
import { generateMnemonic, validateMnemonic, deriveAccounts } from '../wallet';
import { walletSession } from '../walletSession';

type Step = 'login' | 'register' | 'phrase' | 'verify';

export function Auth({ onAuthed }: { onAuthed: (p: Profile) => void }) {
  const [step, setStep] = useState<Step>('login');
  const [importMode, setImportMode] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passphrase, setPassphrase] = useState(''); // optional BIP-39 25th word
  const [importPhrase, setImportPhrase] = useState('');
  const [code, setCode] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [mnemonic, setMnemonic] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  function go(s: Step) {
    setErr('');
    setOk('');
    setStep(s);
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const doRegister = () =>
    run(async () => {
      if (password !== confirm) throw new Error('Passwords do not match');
      const m = importMode ? importPhrase.trim() : generateMnemonic();
      if (importMode && !validateMnemonic(m)) throw new Error('Invalid recovery phrase');
      const acct = deriveAccounts(m, passphrase); // keys derived IN THE BROWSER
      await api.register(email, password, {
        identityKey: acct.identityKey,
        financeXpub: acct.financeXpub,
        tokensXpub: acct.tokensXpub,
        identityXpub: acct.identityXpub,
      });
      setMnemonic(m);
      // Imported wallets already have their phrase backed up → skip the write-down step.
      setStep(importMode ? 'verify' : 'phrase');
    });

  async function signIn() {
    try {
      const r = await api.login(email, password, totp || undefined);
      token.set(r.token);
      if (mnemonic) walletSession.set(mnemonic, passphrase); // same-session: already unlocked
      onAuthed(r.profile);
    } catch (e) {
      if (e instanceof ApiError && e.extra.twoFactorRequired) {
        setNeedTotp(true);
        setErr('Enter your 2FA code to continue');
        return;
      }
      throw e;
    }
  }

  const doVerify = () =>
    run(async () => {
      await api.verify(email, code);
      await signIn();
    });

  const Passphrase = () => (
    <label>
      Optional passphrase (BIP-39 “25th word”)
      <input
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        autoComplete="off"
      />
      <small className="muted">
        Extra secret mixed into your keys. Leave blank if unsure — if set, you MUST remember it.
      </small>
    </label>
  );

  if (step === 'register') {
    return (
      <section>
        <h2>{importMode ? 'Import a wallet' : 'Create your wallet'}</h2>
        {err && <div className="alert">{err}</div>}
        <div className="tabs">
          <button className={`ghost tab ${!importMode ? 'active' : ''}`} onClick={() => setImportMode(false)}>
            Create new
          </button>
          <button className={`ghost tab ${importMode ? 'active' : ''}`} onClick={() => setImportMode(true)}>
            Import existing
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            doRegister();
          }}
        >
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              minLength={8}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <small className="muted">Protects your account. Your keys stay in this browser.</small>
          </label>
          <label>
            Confirm password
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </label>
          {importMode && (
            <label>
              Recovery phrase (12 or 24 words)
              <input
                value={importPhrase}
                onChange={(e) => setImportPhrase(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
          )}
          <Passphrase />
          <button className="primary" disabled={busy}>
            {busy ? 'Working…' : importMode ? 'Import wallet' : 'Create wallet'}
          </button>
        </form>
        <p className="switch">
          Have an account?{' '}
          <button className="linkbtn" onClick={() => go('login')}>
            Sign in
          </button>
        </p>
      </section>
    );
  }

  if (step === 'phrase') {
    return (
      <section>
        <h2>Write down your 24-word recovery phrase</h2>
        <p className="warn">
          These words ARE your wallet — we never see them and cannot recover them for you. Write
          them down and store them offline.{' '}
          {passphrase && 'Also remember your passphrase — it is required and is NOT stored here.'}
        </p>
        <div className="blob">{mnemonic}</div>
        <div className="row">
          <button className="ghost" onClick={() => navigator.clipboard?.writeText(mnemonic)}>
            Copy
          </button>
        </div>
        <div className="spacer" />
        <label className="muted" style={{ flexDirection: 'row', gap: 8 }}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I
          have written down my recovery phrase{passphrase ? ' and passphrase' : ''}
        </label>
        <div className="spacer" />
        <button className="primary" disabled={!saved} onClick={() => go('verify')}>
          Continue
        </button>
      </section>
    );
  }

  if (step === 'verify') {
    return (
      <section>
        <h2>Verify your email</h2>
        <p className="muted">Enter the 6-digit code sent to {email}.</p>
        {err && <div className="alert">{err}</div>}
        {ok && <div className="alert ok">{ok}</div>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            doVerify();
          }}
        >
          <label>
            Verification code
            <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} required />
          </label>
          {needTotp && (
            <label>
              2FA code
              <input value={totp} onChange={(e) => setTotp(e.target.value)} maxLength={6} />
            </label>
          )}
          <button className="primary" disabled={busy}>
            {busy ? 'Verifying…' : 'Verify & continue'}
          </button>
        </form>
        <p className="switch">
          <button className="linkbtn" onClick={() => api.resend(email).then(() => setOk('Code resent'))}>
            Resend code
          </button>
        </p>
      </section>
    );
  }

  // login
  return (
    <section>
      <h2>Sign in</h2>
      {err && <div className="alert">{err}</div>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(signIn);
        }}
      >
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {needTotp && (
          <label>
            2FA code
            <input value={totp} onChange={(e) => setTotp(e.target.value)} maxLength={6} />
          </label>
        )}
        <button className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="switch">
        No account?{' '}
        <button className="linkbtn" onClick={() => go('register')}>
          Create or import
        </button>
      </p>
    </section>
  );
}
