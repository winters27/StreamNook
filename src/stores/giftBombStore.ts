import { create } from 'zustand';

/**
 * Recipients of a mass gift-sub bomb, keyed by the community-gift origin id.
 *
 * When the "collapse gift-sub floods" setting is on, chatConnectionStore keeps
 * only the `submysterygift` announcement in chat and routes the individual
 * `subgift` follow-ups here. The surviving announcement card subscribes via
 * `useGiftBombRecipients` and renders the recipient list, so a batch of N gifts
 * shows as one row with its recipients instead of N separate rows.
 */
export interface GiftRecipient {
  userId: string;
  userName: string;
  displayName: string;
}

interface GiftBombEntry {
  /** mass-gift-count from the announcement, if known */
  expected?: number;
  recipients: GiftRecipient[];
}

interface GiftBombState {
  byOrigin: Map<string, GiftBombEntry>;
  noteAnnouncement: (originId: string, expected?: number) => void;
  addRecipient: (originId: string, recipient: GiftRecipient) => void;
}

// Cap on tracked origins so a long session can't grow this unbounded. Gift
// bombs collapse within a 60s window, so only a handful are ever live; the cap
// is a generous backstop that prunes the oldest inserted origins.
const MAX_ORIGINS = 50;

const EMPTY_RESULT: { expected?: number; recipients: GiftRecipient[] } = { recipients: [] };

// Replace byOrigin immutably and evict oldest entries past the cap. A fresh Map
// keeps `get(originId)` reference-stable for untouched origins, so subscribers
// for other bombs don't re-render when one bomb gains a recipient.
function withEntry(prev: Map<string, GiftBombEntry>, originId: string, entry: GiftBombEntry): Map<string, GiftBombEntry> {
  const next = new Map(prev);
  next.delete(originId); // re-insert so this origin becomes the most-recent key
  next.set(originId, entry);
  while (next.size > MAX_ORIGINS) {
    const oldest = next.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

export const useGiftBombStore = create<GiftBombState>((set, get) => ({
  byOrigin: new Map(),

  noteAnnouncement: (originId, expected) => {
    const existing = get().byOrigin.get(originId);
    set({
      byOrigin: withEntry(get().byOrigin, originId, {
        expected: expected ?? existing?.expected,
        recipients: existing?.recipients ?? [],
      }),
    });
  },

  addRecipient: (originId, recipient) => {
    const existing = get().byOrigin.get(originId);
    if (existing?.recipients.some((r) => r.userId === recipient.userId)) return;
    set({
      byOrigin: withEntry(get().byOrigin, originId, {
        expected: existing?.expected,
        recipients: [...(existing?.recipients ?? []), recipient],
      }),
    });
  },
}));

/**
 * Subscribe to a single origin's recipients. Safe to call unconditionally with
 * an undefined origin (normal chat messages) — it returns a stable empty result
 * so the caller can satisfy the rules-of-hooks without branching.
 */
export function useGiftBombRecipients(originId?: string): { expected?: number; recipients: GiftRecipient[] } {
  return useGiftBombStore((s) => (originId ? s.byOrigin.get(originId) ?? EMPTY_RESULT : EMPTY_RESULT));
}
