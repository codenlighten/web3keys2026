// Holds the unlocked mnemonic in memory for the current session ONLY. Never persisted;
// cleared on logout / page unload. On a fresh load the user must unlock (enter their
// phrase or restore from encrypted backup) before they can sign.

let mnemonic: string | null = null;

export const walletSession = {
  set(m: string) {
    mnemonic = m;
  },
  get(): string {
    if (!mnemonic) throw new Error('wallet locked — unlock with your recovery phrase');
    return mnemonic;
  },
  unlocked(): boolean {
    return !!mnemonic;
  },
  clear() {
    mnemonic = null;
  },
};

window.addEventListener('beforeunload', () => walletSession.clear());
