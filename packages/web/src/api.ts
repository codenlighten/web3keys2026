// Typed API client for the non-custodial web3keys server. Same-origin in prod; proxied
// to :3000 in dev. The server never receives a seed — only public material and signed txs.

const TOKEN_KEY = 'web3keys_token';

export type Profile = {
  email: string;
  paymail: string;
  alias: string;
  identityKey: string;
  address: string;
  verified: boolean;
};

export type Tx = {
  txid: string;
  direction: 'in' | 'out';
  amountSats: number;
  address: string | null;
  status: string;
  createdAt: string;
};

export type Notification = {
  id: number;
  type: string;
  payload: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
};

export type Utxo = { txid: string; vout: number; satoshis: number; script: string; index: number };

export type RegisterPublics = {
  identityKey: string;
  financeXpub: string;
  tokensXpub: string;
  identityXpub: string;
};

export class ApiError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(message: string, status: number, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const token = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const t = token.get();
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(t ? { authorization: `Bearer ${t}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: Record<string, unknown> = {};
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    const { error, ...extra } = json as { error?: string };
    throw new ApiError(error || `Request failed (${res.status})`, res.status, extra);
  }
  return json as T;
}

export const api = {
  health: () => request<{ network: string; domain: string }>('GET', '/health'),

  register: (email: string, password: string, publics: RegisterPublics) =>
    request<{ profile: Profile }>('POST', '/api/auth/register', { email, password, ...publics }),
  verify: (email: string, code: string) =>
    request<{ verified: boolean; profile: Profile }>('POST', '/api/auth/verify', { email, code }),
  resend: (email: string) => request<{ otpSent: boolean }>('POST', '/api/auth/resend', { email }),
  login: (email: string, password: string, totpCode?: string) =>
    request<{ token: string; profile: Profile }>('POST', '/api/auth/login', {
      email,
      password,
      totpCode,
    }),
  logout: () => request<{ ok: boolean }>('POST', '/api/auth/logout'),

  profile: () => request<Profile>('GET', '/api/wallet/profile'),
  balance: () => request<{ confirmed: number; unconfirmed: number }>('GET', '/api/wallet/balance'),
  address: () =>
    request<{ address: string; index: number; paymail: string }>('GET', '/api/wallet/address'),
  newAddress: () => request<{ address: string; index: number }>('POST', '/api/wallet/address/new'),
  utxos: () => request<{ utxos: Utxo[] }>('GET', '/api/wallet/utxos'),
  resolve: (to: string, satoshis: number) =>
    request<{ address?: string; script?: string }>('POST', '/api/paymail/resolve', {
      to,
      satoshis,
    }),
  broadcast: (rawHex: string, meta: { to?: string; satoshis?: number } = {}) =>
    request<{ txid: string }>('POST', '/api/tx/broadcast', { rawHex, ...meta }),
  history: () => request<{ transactions: Tx[] }>('GET', '/api/wallet/history'),

  getBackup: () => request<{ scheme: string; ciphertext: string }>('GET', '/api/backup'),
  putBackup: (scheme: string, ciphertext: string) =>
    request<{ ok: boolean }>('PUT', '/api/backup', { scheme, ciphertext }),

  notifications: () => request<{ notifications: Notification[] }>('GET', '/api/notifications'),
  markRead: (id: number) => request<{ ok: boolean }>('POST', `/api/notifications/${id}/read`),

  twoFactorSetup: () => request<{ otpauth: string; secret: string }>('POST', '/api/2fa/setup'),
  twoFactorEnable: (code: string) =>
    request<{ enabled: boolean }>('POST', '/api/2fa/enable', { code }),
};
