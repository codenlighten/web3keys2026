import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, type Profile, type Tx, type Notification } from '../api';
import { buildSignedTx, encryptBackup } from '../wallet';
import { walletSession } from '../walletSession';

const BSV = (sats: number) => `${(sats / 1e8).toFixed(8)} BSV`;

function Qr({ value }: { value: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    QRCode.toDataURL(value, { margin: 1, width: 180, color: { dark: '#eef2ff', light: '#0e1426' } })
      .then(setSrc)
      .catch(() => setSrc(''));
  }, [value]);
  return src ? (
    <img src={src} alt="QR" width={180} height={180} style={{ display: 'block', margin: '8px auto', borderRadius: 10 }} />
  ) : null;
}

export function Dashboard({ profile, onLogout }: { profile: Profile; onLogout: () => void }) {
  const [tab, setTab] = useState<'wallet' | 'activity' | 'settings'>('wallet');
  const [balance, setBalance] = useState<number | null>(null);
  const [address, setAddress] = useState(profile.address);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [notes, setNotes] = useState<Notification[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  function refresh() {
    api.balance().then((b) => setBalance(b.confirmed + b.unconfirmed)).catch(() => setBalance(null));
    api.history().then((h) => setTxs(h.transactions)).catch(() => {});
    api.notifications().then((n) => setNotes(n.notifications)).catch(() => {});
  }

  useEffect(() => {
    api.address().then((a) => setAddress(a.address)).catch(() => {});
    refresh();
  }, []);

  return (
    <section>
      <div className="tabs">
        {(['wallet', 'activity', 'settings'] as const).map((t) => (
          <button key={t} className={`ghost tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {err && <div className="alert">{err}</div>}
      {msg && <div className="alert ok">{msg}</div>}

      {tab === 'wallet' && (
        <Wallet
          profile={profile}
          balance={balance}
          address={address}
          onRotate={async () => {
            try {
              setAddress((await api.newAddress()).address);
            } catch (e) {
              setErr(e instanceof Error ? e.message : 'Error');
            }
          }}
          onSent={(txid) => {
            setMsg(`Sent — ${txid.slice(0, 16)}…`);
            refresh();
          }}
          setErr={setErr}
        />
      )}
      {tab === 'activity' && <Activity txs={txs} notes={notes} />}
      {tab === 'settings' && <Settings setMsg={setMsg} setErr={setErr} />}

      <div className="spacer" />
      <button className="danger" onClick={onLogout}>
        Sign out
      </button>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="field-value">
        <code>{value}</code>
        <button className="copy" onClick={() => navigator.clipboard?.writeText(value)}>
          ⧉
        </button>
      </div>
    </div>
  );
}

function Wallet({
  profile,
  balance,
  address,
  onRotate,
  onSent,
  setErr,
}: {
  profile: Profile;
  balance: number | null;
  address: string;
  onRotate: () => void;
  onSent: (txid: string) => void;
  setErr: (s: string) => void;
}) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const amt = Math.round(Number(amount));
      if (!Number.isInteger(amt) || amt <= 0) throw new Error('Enter a valid amount');
      // CLIENT-SIDE: fetch UTXOs, resolve recipient, build + sign locally, then broadcast.
      const { utxos } = await api.utxos();
      if (!utxos.length) throw new Error('No spendable funds');
      const dest = await api.resolve(to, amt);
      const s = walletSession.get();
      const rawHex = buildSignedTx(s.mnemonic, s.passphrase, utxos, dest, amt);
      const { txid } = await api.broadcast(rawHex, { to, satoshis: amt });
      setTo('');
      setAmount('');
      onSent(txid);
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'Send failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="field">
        <span className="field-label">Balance</span>
        <div className="field-value">
          <strong>{balance === null ? '…' : BSV(balance)}</strong>
        </div>
      </div>
      <Field label="Paymail" value={profile.paymail} />
      <Field label="Receive address" value={address} />
      <Qr value={address} />
      <button className="ghost" onClick={onRotate}>
        New receive address
      </button>
      <div className="spacer" />
      <h2>Send</h2>
      <form onSubmit={submit}>
        <label>
          To (address or paymail)
          <input value={to} onChange={(e) => setTo(e.target.value)} required />
        </label>
        <label>
          Amount (satoshis)
          <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Signing & sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function Activity({ txs, notes }: { txs: Tx[]; notes: Notification[] }) {
  const [items, setItems] = useState(notes);
  useEffect(() => setItems(notes), [notes]);
  return (
    <div>
      <h2>Notifications</h2>
      {items.length === 0 && <p className="muted">No notifications.</p>}
      {items.map((n) => (
        <div className="tx" key={n.id}>
          <span>{n.type === 'deposit' ? '↓ Deposit received' : n.type}</span>
          {!n.read && (
            <button
              className="linkbtn"
              onClick={() => api.markRead(n.id).then(() => setItems((xs) => xs.filter((x) => x.id !== n.id)))}
            >
              mark read
            </button>
          )}
        </div>
      ))}
      <div className="spacer" />
      <h2>History</h2>
      {txs.length === 0 && <p className="muted">No transactions yet.</p>}
      {txs.map((t) => (
        <div className="tx" key={`${t.txid}:${t.direction}`}>
          <span className={t.direction === 'in' ? 'in' : 'out'}>
            {t.direction === 'in' ? '↓' : '↑'} {BSV(t.amountSats)}
          </span>
          <span className="muted">{t.txid.slice(0, 12)}…</span>
        </div>
      ))}
    </div>
  );
}

function Settings({ setMsg, setErr }: { setMsg: (s: string) => void; setErr: (s: string) => void }) {
  const [otpauth, setOtpauth] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [phrase, setPhrase] = useState('');
  const [backupPass, setBackupPass] = useState('');

  const setup2fa = () =>
    api.twoFactorSetup().then((r) => {
      setOtpauth(r.otpauth);
      setSecret(r.secret);
    }).catch((e) => setErr(e.message));

  const enable2fa = () =>
    api.twoFactorEnable(code).then(() => {
      setMsg('2FA enabled');
      setOtpauth('');
      setSecret('');
      setCode('');
    }).catch((e) => setErr(e.message));

  const saveBackup = async () => {
    try {
      // Back up the full secret (phrase + passphrase) as an opaque blob the server can't read.
      const ct = await encryptBackup(JSON.stringify(walletSession.get()), backupPass);
      await api.putBackup('passphrase-pbkdf2-aesgcm', ct);
      setBackupPass('');
      setMsg('Encrypted backup saved (only you can decrypt it).');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Backup failed');
    }
  };

  return (
    <div>
      <h2>Encrypted cloud backup</h2>
      <p className="muted">
        Optional. Encrypted in your browser under a passphrase we never see — convenience only.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          saveBackup();
        }}
      >
        <label>
          Backup passphrase
          <input
            type="password"
            value={backupPass}
            minLength={8}
            onChange={(e) => setBackupPass(e.target.value)}
            required
          />
        </label>
        <button className="primary">Save encrypted backup</button>
      </form>

      <div className="spacer" />
      <h2>Two-factor auth</h2>
      {!otpauth ? (
        <button className="ghost" onClick={setup2fa}>
          Set up authenticator app
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            enable2fa();
          }}
        >
          <p className="muted">Add this secret to your authenticator, then enter a code:</p>
          <div className="blob">{secret}</div>
          <label>
            Code
            <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} />
          </label>
          <button className="primary">Enable 2FA</button>
        </form>
      )}

      <div className="spacer" />
      <h2>Recovery phrase</h2>
      <p className="warn">Reveals your 12 words. Anyone with them controls your funds.</p>
      {phrase ? (
        <div className="blob">{phrase}</div>
      ) : (
        <button className="ghost" onClick={() => setPhrase(walletSession.get().mnemonic)}>
          Reveal recovery phrase
        </button>
      )}
    </div>
  );
}
