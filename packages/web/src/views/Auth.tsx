import { useState } from 'react';
import { api, token, ApiError, type Profile } from '../api';

type Step = 'login' | 'register' | 'share' | 'verify' | 'recover';

export function Auth({ onAuthed }: { onAuthed: (p: Profile) => void }) {
  const [step, setStep] = useState<Step>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [recoveryShare, setRecoveryShare] = useState('');
  const [savedShare, setSavedShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  function reset(msg = '') {
    setErr('');
    setOk(msg);
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
      const r = await api.register(email, password);
      setRecoveryShare(r.recoveryShare);
      setStep('share');
    });

  const doVerify = () =>
    run(async () => {
      await api.verify(email, code);
      await signIn(); // auto sign-in after verification
    });

  async function signIn() {
    try {
      const r = await api.login(email, password, totp || undefined);
      token.set(r.token);
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

  const doLogin = () => run(signIn);

  const doRecover = () =>
    run(async () => {
      if (password !== confirm) throw new Error('Passwords do not match');
      const r = await api.recover(email, recoveryShare, password);
      setRecoveryShare(r.recoveryShare);
      setSavedShare(false);
      setOk('Recovered. Save your NEW recovery share, then sign in.');
      setStep('share');
    });

  const Alert = () => (
    <>
      {err && <div className="alert">{err}</div>}
      {ok && <div className="alert ok">{ok}</div>}
    </>
  );

  if (step === 'register') {
    return (
      <section>
        <h2>Create your wallet</h2>
        <Alert />
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
            <small className="muted">
              At least 8 characters. This password protects one of your three key slices.
            </small>
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
          <button className="linkbtn" onClick={() => { reset(); setStep('login'); }}>
            Sign in
          </button>
        </p>
      </section>
    );
  }

  if (step === 'share') {
    return (
      <section>
        <h2>Save your recovery share</h2>
        <p className="warn">
          Shown <strong>once</strong>. Store it safely — it recovers your wallet if you forget your
          password. (One of three slices; alone it can’t move funds.)
        </p>
        <div className="blob">{recoveryShare}</div>
        <div className="row">
          <button className="ghost" onClick={() => navigator.clipboard?.writeText(recoveryShare)}>
            Copy
          </button>
          <button
            className="ghost"
            onClick={() => download(`web3keys-recovery-${email}.txt`, recoveryShare)}
          >
            Download
          </button>
        </div>
        <div className="spacer" />
        <label className="muted" style={{ flexDirection: 'row', gap: 8 }}>
          <input type="checkbox" checked={savedShare} onChange={(e) => setSavedShare(e.target.checked)} />
          I have saved my recovery share
        </label>
        <div className="spacer" />
        <button className="primary" disabled={!savedShare} onClick={() => { reset(); setStep('verify'); }}>
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
        <Alert />
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
            {busy ? 'Verifying…' : 'Verify & sign in'}
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

  if (step === 'recover') {
    return (
      <section>
        <h2>Recover access</h2>
        <p className="muted">Use your recovery share to set a new password.</p>
        <Alert />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            doRecover();
          }}
        >
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Recovery share
            <input value={recoveryShare} onChange={(e) => setRecoveryShare(e.target.value)} required />
          </label>
          <label>
            New password
            <input
              type="password"
              value={password}
              minLength={8}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
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
            {busy ? 'Recovering…' : 'Recover'}
          </button>
        </form>
        <p className="switch">
          <button className="linkbtn" onClick={() => { reset(); setStep('login'); }}>
            Back to sign in
          </button>
        </p>
      </section>
    );
  }

  // login
  return (
    <section>
      <h2>Sign in</h2>
      <Alert />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          doLogin();
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
        <button className="linkbtn" onClick={() => { reset(); setStep('register'); }}>
          Create one
        </button>{' '}
        ·{' '}
        <button className="linkbtn" onClick={() => { reset(); setStep('recover'); }}>
          Recover
        </button>
      </p>
    </section>
  );
}

function download(filename: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
