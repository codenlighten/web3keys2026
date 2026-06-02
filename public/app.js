'use strict';

// web3keys frontend — vanilla SPA for register / verify / login / dashboard.
// Talks to the same-origin API. Uses the @smartledger/bsv CDN bundle (window.bsv)
// to verify, client-side, that the server-returned recovery phrase really controls
// the address/identity the server claims.

const TOKEN_KEY = 'web3keys_token';
const $ = (sel) => document.querySelector(sel);

const views = ['login', 'register', 'mnemonic', 'verify', 'dashboard'];
function show(name) {
  views.forEach((v) => { $(`#view-${v}`).hidden = v !== name; });
  hideAlert();
}

function alertMsg(msg, ok = false) {
  const el = $('#alert');
  el.textContent = msg;
  el.className = 'alert' + (ok ? ' ok' : '');
  el.hidden = false;
}
function hideAlert() { $('#alert').hidden = true; }

async function api(method, path, body, token) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try { json = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

// Transient registration state (kept only until sign-in completes).
let pending = { email: null, password: null };

// ── client-side seed verification (trust-but-verify) ──────────────────────────
function verifySeedLocally(mnemonic, profile) {
  try {
    if (!window.bsv || !window.bsv.Mnemonic) return null; // CDN not loaded
    const { Mnemonic, HDPrivateKey } = window.bsv;
    const seed = Mnemonic.fromString(mnemonic).toSeed();
    const master = HDPrivateKey.fromSeed(seed);
    const financeAddr = master.deriveChild("m/44'/0'/0'/0/0").privateKey.toAddress().toString();
    const identityKey = master.deriveChild("m/44'/236'/0'/0/0").privateKey.publicKey.toString();
    return financeAddr === profile.address && identityKey === profile.identityKey;
  } catch (e) {
    console.warn('seed verify error', e);
    return null;
  }
}

// ── copy helper ───────────────────────────────────────────────────────────────
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { const o = btn.textContent; btn.textContent = '✓'; setTimeout(() => (btn.textContent = o), 1200); }
  } catch {
    alertMsg('Copy failed — select and copy manually.');
  }
}

// ── flows ───────────────────────────────────────────────────────────────────
$('#form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const email = f.email.value.trim();
  const password = f.password.value;
  if (password !== f.confirm.value) return alertMsg('Passwords do not match.');
  const btn = f.querySelector('button');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const r = await api('POST', '/api/auth/register', { email, password });
    pending = { email, password };
    renderMnemonic(r.mnemonic, r.profile);
    show('mnemonic');
  } catch (err) {
    alertMsg(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Create wallet';
  }
});

function renderMnemonic(mnemonic, profile) {
  const grid = $('#mnemonic-grid');
  grid.innerHTML = '';
  mnemonic.split(' ').forEach((w) => {
    const li = document.createElement('li');
    li.textContent = w;
    grid.appendChild(li);
  });
  $('#copy-mnemonic').onclick = () => copyText(mnemonic, $('#copy-mnemonic'));
  $('#saved-check').checked = false;
  $('#mnemonic-continue').disabled = true;

  // Client-side proof that this phrase controls the server-issued address/identity.
  const badge = $('#verify-badge');
  const ok = verifySeedLocally(mnemonic, profile);
  if (ok === true) { badge.textContent = '✓ verified controls ' + shorten(profile.address); badge.className = 'verify ok'; }
  else if (ok === false) { badge.textContent = '⚠ phrase did not match server address'; badge.className = 'verify bad'; }
  else { badge.textContent = ''; badge.className = 'verify'; }
}

function shorten(s) { return s ? s.slice(0, 6) + '…' + s.slice(-4) : ''; }

$('#saved-check').addEventListener('change', (e) => {
  $('#mnemonic-continue').disabled = !e.target.checked;
});

$('#mnemonic-continue').addEventListener('click', () => {
  $('#verify-email').textContent = pending.email;
  show('verify');
});

$('#form-verify').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = e.target.code.value.trim();
  const btn = e.target.querySelector('button');
  btn.disabled = true; btn.textContent = 'Verifying…';
  try {
    await api('POST', '/api/auth/verify', { email: pending.email, code });
    // Auto sign-in with the credentials still in memory, then discard the password.
    const login = await api('POST', '/api/auth/login', { email: pending.email, password: pending.password });
    pending = { email: null, password: null };
    localStorage.setItem(TOKEN_KEY, login.token);
    await enterDashboard();
  } catch (err) {
    alertMsg(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Verify & sign in';
  }
});

$('#resend').addEventListener('click', async (e) => {
  e.preventDefault();
  try { await api('POST', '/api/auth/resend', { email: pending.email }); alertMsg('A new code has been sent.', true); }
  catch (err) { alertMsg(err.message); }
});

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const login = await api('POST', '/api/auth/login', { email: f.email.value.trim(), password: f.password.value });
    localStorage.setItem(TOKEN_KEY, login.token);
    f.password.value = '';
    await enterDashboard();
  } catch (err) {
    alertMsg(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
});

// ── dashboard ─────────────────────────────────────────────────────────────────
async function enterDashboard() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return show('login');
  let profile;
  try {
    profile = await api('GET', '/api/wallet/profile', null, token);
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    return show('login');
  }
  $('#dash-name').textContent = profile.email ? `, ${profile.email}` : '';
  $('#dash-paymail').textContent = profile.paymail;
  $('#dash-address').textContent = profile.address;
  show('dashboard');
  loadBalance();
}

async function loadBalance() {
  const token = localStorage.getItem(TOKEN_KEY);
  const el = $('#dash-balance');
  el.textContent = '…';
  try {
    const b = await api('GET', '/api/wallet/balance', null, token);
    const sats = (b.confirmed || 0) + (b.unconfirmed || 0);
    el.textContent = `${(sats / 1e8).toFixed(8)} BSV (${sats.toLocaleString()} sats)`;
  } catch (err) {
    el.textContent = 'unavailable';
    console.warn(err);
  }
}

$('#refresh-balance').addEventListener('click', loadBalance);

$('#logout').addEventListener('click', async () => {
  const token = localStorage.getItem(TOKEN_KEY);
  try { await api('POST', '/api/auth/logout', null, token); } catch { /* ignore */ }
  localStorage.removeItem(TOKEN_KEY);
  show('login');
});

// copy buttons on the dashboard
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => copyText($('#' + btn.dataset.copy).textContent, btn));
});

// view switch links
document.querySelectorAll('[data-go]').forEach((a) => {
  a.addEventListener('click', (e) => { e.preventDefault(); show(a.dataset.go); });
});

// ── boot ────────────────────────────────────────────────────────────────────
(async function boot() {
  // network badge
  try { const h = await api('GET', '/health'); $('#net-badge').textContent = h.network === 'testnet' ? 'testnet' : 'mainnet'; } catch { /* ignore */ }
  // resume session if a token exists, else show login
  if (localStorage.getItem(TOKEN_KEY)) await enterDashboard();
  else show('login');
})();
