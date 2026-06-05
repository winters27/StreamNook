import { create } from 'zustand';

// Shared pinned-chat state so any component can both READ which messages are
// currently pinned (to flip a Pin control into Unpin) and REQUEST an immediate
// refetch after a pin/unpin action — instead of waiting for the 30s poll.
//
// ChatWidget owns the actual fetch (`get_pinned_chat_messages`); it pushes the
// underlying message ids here after each fetch and re-runs the fetch whenever
// `refreshNonce` changes. Pin/unpin action sites call `requestRefresh()`.
interface PinState {
  /** Underlying chat message ids that are currently pinned (one at a time today). */
  pinnedIds: string[];
  /** Bumped by any pin/unpin action to make ChatWidget refetch right away. */
  refreshNonce: number;
  setPinnedIds: (ids: string[]) => void;
  requestRefresh: () => void;
}

export const usePinStore = create<PinState>((set) => ({
  pinnedIds: [],
  refreshNonce: 0,
  setPinnedIds: (ids) => set({ pinnedIds: ids }),
  requestRefresh: () => set((s) => ({ refreshNonce: s.refreshNonce + 1 })),
}));
