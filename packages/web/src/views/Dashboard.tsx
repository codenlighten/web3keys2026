import { useEffect, useState } from 'react';
import { api, type Profile, type Tx, type Notification } from '../api';

const BSV = (sats: number) => `${(sats / 1e8).toFixed(8)} BSV`;

export function Dashboard({ profile, onLogout }: { profile: Profile; onLogout: () => void }) {
  const [tab, setTab] = useState<'wallet' | 'activity' | 'settings'>('wallet');
  const [balance, setBalance] = useState<number | null>(null);
  const [address, setAddress] = useState(profile.address);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [notes, setNotes] = useState<Notification[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  async function guard(fn: () => Promise<void>) {
    setErr('');
    setMsg('');
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error');
    }
  }

  useEffect(() => {
    api.address().then((a) => setAddress(a.address)).catch(() => {});
    api
      .balance()
      .then((b) => setBalance(b.confirmed + b.unconfirmed))
      .catch(() => setBalance(null));
    api.history().then((h) => setTxs(h.transactions)).catch(() => {});
    api.notifications().then((n) => setNotes(n.notifications)).catch(() => {});
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
          onRotate={() =>
            guard(async () => {
              const a = await api.newAddress();
              setAddress(a.address);
            })
          }
          onSent={(txid) => {
            setMsg(`Sent — ${txid.slice(0, 16)}…`);
            api.balance().then((b) => setBalance(b.confirmed + b.unconfirmed));
            api.history().then((h) => setTxs(h.transactions));
          }}
          setErr={setErr}
        />
      )}

      {tab === 'activity' && <Activity txs={txs} notes={notes} onRead={(id) => api.markRead(id)} />}

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

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    api
      .send(to, Math.round(Number(amount)))
      .then((r) => {
        setTo('');
        setAmount('');
        onSent(r.txid);
      })
      .catch((x) => setErr(x instanceof Error ? x.message : 'Send failed'))
      .finally(() => setBusy(false));
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
          <input
            type="number"
            min={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function Activity({
  txs,
  notes,
  onRead,
}: {
  txs: Tx[];
  notes: Notification[];
  onRead: (id: number) => Promise<unknown>;
}) {
  const [items, setItems] = useState(notes);
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
              onClick={() => onRead(n.id).then(() => setItems((xs) => xs.filter((x) => x.id !== n.id)))}
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
  const [seed, setSeed] = useState('');

  const setup = () =>
    api
      .twoFactorSetup()
      .then((r) => {
        setOtpauth(r.otpauth);
        setSecret(r.secret);
      })
      .catch((e) => setErr(e.message));

  const enable = () =>
    api
      .twoFactorEnable(code)
      .then(() => {
        setMsg('2FA enabled');
        setOtpauth('');
        setSecret('');
        setCode('');
      })
      .catch((e) => setErr(e.message));

  return (
    <div>
      <h2>Two-factor auth</h2>
      {!otpauth ? (
        <button className="ghost" onClick={setup}>
          Set up authenticator app
        </button>
      ) : (
        <div>
          <p className="muted">Add this secret to your authenticator, then enter a code:</p>
          <div className="blob">{secret}</div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              enable();
            }}
          >
            <label>
              Code
              <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} />
            </label>
            <button className="primary">Enable 2FA</button>
          </form>
        </div>
      )}

      <div className="spacer" />
      <h2>Export wallet</h2>
      <p className="warn">Reveals your 12-word seed. Anyone with it controls your funds.</p>
      {seed ? (
        <div className="blob">{seed}</div>
      ) : (
        <button
          className="ghost"
          onClick={() => api.exportSeed().then((r) => setSeed(r.mnemonic)).catch((e) => setErr(e.message))}
        >
          Reveal recovery phrase
        </button>
      )}
    </div>
  );
}
