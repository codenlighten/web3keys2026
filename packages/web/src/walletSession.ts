// Holds the unlocked secret (mnemonic + optional BIP-39 passphrase) in memory for the
// current session ONLY. Never persisted; cleared on logout / page unload. On a fresh load
// the user must unlock (phrase + passphrase, or encrypted backup) before signing.

export type Secret = { mnemonic: string; passphrase: string };

let secret: Secret | null = null;

export const walletSession = {
  set(mnemonic: string, passphrase = '') {
    secret = { mnemonic, passphrase };
  },
  get(): Secret {
    if (!secret) throw new Error('wallet locked — unlock with your recovery phrase');
    return secret;
  },
  unlocked(): boolean {
    return !!secret;
  },
  clear() {
    secret = null;
  },
};

window.addEventListener('beforeunload', () => walletSession.clear());
