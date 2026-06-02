import { useEffect, useState } from 'react';
import { api, token, type Profile } from './api';
import { walletSession } from './walletSession';
import { Auth } from './views/Auth';
import { Unlock } from './views/Unlock';
import { Dashboard } from './views/Dashboard';
import { Approve } from './views/Approve';

// SmartLedger Login approval routes that sl-login.js redirects third-party users to.
const SSO_ROUTES: Record<string, 'login' | 'attest' | 'publish'> = {
  '/login': 'login',
  '/attest': 'attest',
  '/publish': 'publish',
};

export default function App() {
  const ssoKind = SSO_ROUTES[window.location.pathname] ?? null;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [unlocked, setUnlocked] = useState(walletSession.unlocked());
  const [loading, setLoading] = useState(true);
  const [network, setNetwork] = useState('');

  useEffect(() => {
    api
      .health()
      .then((h) => setNetwork(h.network))
      .catch(() => {});
    if (token.get()) {
      api
        .profile()
        .then(setProfile)
        .catch(() => token.clear())
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  function onLogout() {
    api.logout().catch(() => {});
    token.clear();
    walletSession.clear();
    setUnlocked(false);
    setProfile(null);
  }

  let body;
  if (loading) body = <p className="muted">Loading…</p>;
  else if (!profile)
    body = (
      <Auth
        onAuthed={(p) => {
          setProfile(p);
          setUnlocked(walletSession.unlocked());
        }}
      />
    );
  else if (!unlocked)
    body = <Unlock profile={profile} onUnlocked={() => setUnlocked(true)} onLogout={onLogout} />;
  else if (ssoKind) body = <Approve kind={ssoKind} />;
  else body = <Dashboard profile={profile} onLogout={onLogout} />;

  return (
    <main className="card">
      <header className="brand">
        <div style={{ fontSize: 32 }}>🔑</div>
        <h1>web3keys</h1>
        <p className="tagline">
          Your keys. Your BSV. {network && <span className="badge">{network}</span>}
        </p>
      </header>
      {body}
    </main>
  );
}
