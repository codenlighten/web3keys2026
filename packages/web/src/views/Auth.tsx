import { useState } from 'react';
import { api, token, ApiError, type Profile } from '../api';
import { generateMnemonic, deriveAccounts } from '../wallet';
import { walletSession } from '../walletSession';

type Step = 'login' | 'register' | 'phrase' | 'verify';

export function Auth({ onAuthed }: { onAuthed: (p: Profile) => void }) {
  const [step, setStep] = useState<Step>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
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
      // Generate the wallet IN THE BROWSER. Only public material goes to the server.
      const m = generateMnemonic();
      const acct = deriveAccounts(m);
      await api.register(email, password, {
        identityKey: acct.identityKey,
        financeXpub: acct.financeXpub,
        tokensXpub: acct.tokensXpub,
        identityXpub: acct.identityXpub,
      });
      setMnemonic(m);
      setStep('phrase');
    });

  async function signIn() {
    try {
      const r = await api.login(email, password, totp || undefined);
      token.set(r.token);
      // Same-session registration already has the seed in memory → unlocked.
      if (mnemonic) walletSession.set(mnemonic);
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

  if (step === 'register') {
    return (
      <section>
        <h2>Create your wallet</h2>
        {err && <div className="alert">{err}</div>}
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
          <button className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create wallet'}
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
        <h2>Write down your recovery phrase</h2>
        <p className="warn">
          These 12 words ARE your wallet — we never see them and cannot recover them for you.
          Write them down and store them offline. Anyone with them controls your funds.
        </p>
        <div className="blob">{mnemonic}</div>
        <div className="row">
          <button className="ghost" onClick={() => navigator.clipboard?.writeText(mnemonic)}>
            Copy
          </button>
        </div>
        <div className="spacer" />
        <label className="muted" style={{ flexDirection: 'row', gap: 8 }}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have
          written down my 12 words
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
          Create one
        </button>
      </p>
    </section>
  );
}
