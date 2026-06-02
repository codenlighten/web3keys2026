import { useEffect, useState } from 'react';
import { api, token, type Profile } from './api';
import { Auth } from './views/Auth';
import { Dashboard } from './views/Dashboard';

export default function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
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
    setProfile(null);
  }

  return (
    <main className="card">
      <header className="brand">
        <div style={{ fontSize: 32 }}>🔑</div>
        <h1>web3keys</h1>
        <p className="tagline">
          Your keys. Your BSV. {network && <span className="badge">{network}</span>}
        </p>
      </header>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : profile ? (
        <Dashboard profile={profile} onLogout={onLogout} />
      ) : (
        <Auth onAuthed={setProfile} />
      )}
    </main>
  );
}
