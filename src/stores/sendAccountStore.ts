import { create } from 'zustand';
import { listAccounts, type StoredAccount } from '../services/accountService';
import { setOwnAccountIds } from './chatConnectionStore';

/**
 * Which account chat messages are sent as. `sendAsId === null` (or the primary's
 * id) means the normal main-account send. A secondary id routes the send through
 * that account's token. Kept in its own tiny store so the picker is reactive and
 * `chatConnectionStore` stays free of a back-import (it receives the chosen
 * account as a parameter instead).
 */
interface SendAccountState {
  accounts: StoredAccount[];
  sendAsId: string | null;
  loadAccounts: () => Promise<void>;
  setSendAsId: (id: string | null) => void;
}

// The chosen "send as" account persists across restarts so it acts as a default.
const SEND_AS_KEY = 'streamnook:sendAsAccountId';

function readPersistedSendAsId(): string | null {
  try {
    return localStorage.getItem(SEND_AS_KEY);
  } catch {
    return null;
  }
}

function persistSendAsId(id: string | null): void {
  try {
    if (id) localStorage.setItem(SEND_AS_KEY, id);
    else localStorage.removeItem(SEND_AS_KEY);
  } catch {
    // ignore (private mode / unavailable storage)
  }
}

export const useSendAccountStore = create<SendAccountState>((set, get) => ({
  accounts: [],
  sendAsId: readPersistedSendAsId(),
  loadAccounts: async () => {
    try {
      const accounts = await listAccounts();
      const { sendAsId } = get();
      // Drop a stale selection if that account was unlinked.
      const stillValid = sendAsId !== null && accounts.some((a) => a.user_id === sendAsId);
      if (!stillValid && sendAsId !== null) persistSendAsId(null);
      set({ accounts, sendAsId: stillValid ? sendAsId : null });
      const ids = accounts.map((a) => a.user_id);
      // Feed chat reconciliation so messages we send (incl. from secondaries) are
      // recognized as our own and don't double-render.
      setOwnAccountIds(ids);
      // Mark every added account as "ours" in the persistence layers so each one's
      // cosmetics, curated badges, and Atmosphere are cached + write through. This
      // is the canonical account-list refresh, so it also covers accounts added
      // mid-session (the launch prefetch only sees those present at startup).
      // Dynamic imports avoid a static import cycle; registration is idempotent.
      void Promise.all([
        import('../services/cosmeticsCache').then((m) => m.registerOwnCosmeticAccounts(ids)),
        import('../services/identityService').then((m) => m.seedOwnIdentitiesFromCache(ids)),
        import('./chatUserStore').then((m) => m.registerOwnAtmospheres(ids)),
      ]).catch(() => {});
    } catch {
      // Registry not readable yet (e.g. before the startup reconcile); leave as-is.
    }
  },
  setSendAsId: (id) => {
    persistSendAsId(id);
    set({ sendAsId: id });
  },
}));
