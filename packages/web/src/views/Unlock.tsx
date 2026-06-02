import { useState } from 'react';
import { api, type Profile } from '../api';
import { validateMnemonic, controlsAddress, decryptBackup } from '../wallet';
import { walletSession } from '../walletSession';

/**
 * Shown after login when the seed isn't in memory (fresh device / page reload). The user
 * unlocks LOCALLY — by typing their phrase or restoring the encrypted backup — so signing
 * can happen client-side. The server is never involved in producing the key.
 */
export function Unlock({
  profile,
  onUnlocked,
  onLogout,
}: {
  profile: Profile;
  onUnlocked: () => void;
  onLogout: () => void;
}) {
  const [mode, setMode] = useState<'phrase' | 'backup'>('phrase');
  const [phrase, setPhrase] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function accept(m: string) {
    if (!validateMnemonic(m)) throw new Error('Invalid recovery phrase');
    if (!controlsAddress(m, profile.address)) {
      throw new Error('That phrase does not match this account');
    }
    walletSession.set(m.trim());
    onUnlocked();
  }

  const unlockPhrase = async () => {
    setBusy(true);
    setErr('');
    try {
      accept(phrase);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unlock failed');
    } finally {
      setBusy(false);
    }
  };

  const unlockBackup = async () => {
    setBusy(true);
    setErr('');
    try {
      const { ciphertext } = await api.getBackup();
      const m = await decryptBackup(ciphertext, passphrase);
      accept(m);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not restore backup');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Unlock your wallet</h2>
      <p className="muted">
        Signed in as {profile.paymail}. Your keys live only in your browser — unlock to send.
      </p>
      <div className="tabs">
        <button className={`ghost tab ${mode === 'phrase' ? 'active' : ''}`} onClick={() => setMode('phrase')}>
          Recovery phrase
        </button>
        <button className={`ghost tab ${mode === 'backup' ? 'active' : ''}`} onClick={() => setMode('backup')}>
          Encrypted backup
        </button>
      </div>
      {err && <div className="alert">{err}</div>}

      {mode === 'phrase' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            unlockPhrase();
          }}
        >
          <label>
            12-word recovery phrase
            <input value={phrase} onChange={(e) => setPhrase(e.target.value)} required />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            unlockBackup();
          }}
        >
          <label>
            Backup passphrase
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              required
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? 'Restoring…' : 'Restore from backup'}
          </button>
        </form>
      )}

      <div className="spacer" />
      <button className="danger" onClick={onLogout}>
        Sign out
      </button>
    </section>
  );
}
