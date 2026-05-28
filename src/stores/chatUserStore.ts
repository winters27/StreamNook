import { create } from 'zustand';
import {
  getCosmeticsFromMemoryCache,
  getCosmeticsWithFallback,
  subscribeToCosmetics,
} from '../services/cosmeticsCache';
import { snapshotOverrides } from '../utils/userChatOverrides';

/**
 * Represents a user who has chatted in the current channel.
 * Used for @ mention autocomplete suggestions and as the canonical store for
 * a user's 7TV paint + 7TV badge. Per-message components subscribe to these
 * instead of each maintaining its own useState + cosmetics-fetch effect.
 *
 * Third-party chat-client badges (FFZ / Chatterino / Homies / Chatsen / Chatty /
 * DankChat) are intentionally NOT resolved here: doing it per chatter meant a
 * network round-trip per user just for badges that clutter chat. They now load
 * only when a user's profile is opened (see UserProfileCard).
 */
export interface ChatUser {
  userId: string;
  username: string;
  displayName: string;
  color: string;
  /** Timestamp of last message - used for sorting by recency */
  lastSeen: number;
  /** 7TV paint data if available (for decorated display) */
  paint?: any;
  /** Currently-selected 7TV badge if available */
  seventvBadge?: any;
}

interface ChatUserStore {
  /** Map of userId -> ChatUser for O(1) lookups */
  users: Map<string, ChatUser>;
  /** Map of lowercase username -> userId for fast username lookups */
  usernameToId: Map<string, string>;
  
  /**
   * Add or update a user when they send a message. channelContext is accepted
   * for call-site compatibility but no longer used (third-party badges are not
   * resolved in chat anymore).
   */
  addUser: (
    user: Omit<ChatUser, 'lastSeen' | 'paint' | 'seventvBadge'>,
    channelContext?: { channelId: string; channelName: string },
  ) => void;
  
  /** Get a user by username (case-insensitive) */
  getUserByUsername: (username: string) => ChatUser | undefined;
  
  /** Get users matching a search query (prefix match on username/displayName) */
  getMatchingUsers: (query: string, limit?: number) => ChatUser[];
  
  /** Clear all users (call when switching channels) */
  clearUsers: () => void;
}

// Module-scope batched-update coalescer for cosmetic resolutions.
//
// 7TV's batched GraphQL request (see seventvService.requestUserCosmeticsBatched)
// can fan out from a single network round-trip into N user resolutions, all
// firing within the same microtask. Without coalescing, each resolution did
// its own store.setState — that's N Map clones AND N rounds of selector
// evaluation across every ChatMessage subscriber. For a 50-user batch with
// 50 mounted ChatMessage components, that's 2500 selector calls and 50
// commit phases, producing visible chat-stuttering bursts.
//
// With this coalescer, all updates enqueued within the same microtask drain
// into ONE setState: one Map clone, one subscriber notification cycle, one
// React commit. Each ChatMessage that subscribes to a specific userId still
// re-renders if its user's paint/badge actually changed; unrelated users
// pay nothing.
type CosmeticUpdate = { paint: any; seventvBadge: any };
const pendingCosmeticUpdates = new Map<string, CosmeticUpdate>();
let pendingFlushScheduled = false;

function scheduleStoreFlush() {
  if (pendingFlushScheduled) return;
  pendingFlushScheduled = true;
  queueMicrotask(() => {
    pendingFlushScheduled = false;
    if (pendingCosmeticUpdates.size === 0) return;
    const cosmeticUpdates = new Map(pendingCosmeticUpdates);
    pendingCosmeticUpdates.clear();
    useChatUserStore.setState((state) => {
      const newUsers = new Map(state.users);
      for (const [uid, { paint, seventvBadge }] of cosmeticUpdates) {
        const current = newUsers.get(uid);
        if (current) {
          newUsers.set(uid, { ...current, paint, seventvBadge });
        }
      }
      return { users: newUsers };
    });
  });
}

function enqueueCosmeticUpdate(userId: string, paint: any, seventvBadge: any) {
  pendingCosmeticUpdates.set(userId, { paint, seventvBadge });
  scheduleStoreFlush();
}

export const useChatUserStore = create<ChatUserStore>((set, get) => ({
  users: new Map(),
  usernameToId: new Map(),
  
  addUser: (user, _channelContext) => {
    const existingUser = get().users.get(user.userId);

    // Fast path: cosmetics already resolved for this user. Update color/lastSeen
    // in place and skip the cache lookup entirely. paint OR seventvBadge being
    // non-undefined is the "cosmetics resolved" sentinel.
    const cosmeticsResolved =
      existingUser !== undefined &&
      (existingUser.paint !== undefined || existingUser.seventvBadge !== undefined);
    if (cosmeticsResolved) {
      set((state) => {
        const newUsers = new Map(state.users);
        const newUsernameToId = new Map(state.usernameToId);
        newUsers.set(user.userId, {
          ...existingUser!,
          ...user,
          lastSeen: Date.now(),
        });
        newUsernameToId.set(user.username.toLowerCase(), user.userId);
        return { users: newUsers, usernameToId: newUsernameToId };
      });
      return;
    }

    // First sight of this user. Insert their base shape, then resolve cosmetics.
    set((state) => {
      const newUsers = new Map(state.users);
      const newUsernameToId = new Map(state.usernameToId);
      newUsers.set(user.userId, {
        ...user,
        lastSeen: Date.now(),
        paint: existingUser?.paint,
        seventvBadge: existingUser?.seventvBadge,
      });
      newUsernameToId.set(user.username.toLowerCase(), user.userId);
      return { users: newUsers, usernameToId: newUsernameToId };
    });

    // Apply resolved 7TV cosmetics. Always sets paint and seventvBadge
    // (possibly to null) so the cosmeticsResolved sentinel flips true.
    // Routes through the module-level coalescer so a burst of resolutions
    // from the batched GraphQL response collapses into one store update.
    const applyCosmetics = (cosmetics: { paints?: any[]; badges?: any[] } | null) => {
      const selectedPaint = cosmetics?.paints?.find((p: any) => p.selected) ?? null;
      const selectedBadge = cosmetics?.badges?.find((b: any) => b.selected) ?? null;
      enqueueCosmeticUpdate(user.userId, selectedPaint, selectedBadge);
    };

    const cachedCosmetics = getCosmeticsFromMemoryCache(user.userId);
    if (cachedCosmetics) {
      applyCosmetics(cachedCosmetics);
    } else {
      getCosmeticsWithFallback(user.userId)
        .then(applyCosmetics)
        .catch(() => {});
    }
  },
  
  getUserByUsername: (username: string) => {
    const { usernameToId, users } = get();
    const userId = usernameToId.get(username.toLowerCase());
    if (userId) {
      return users.get(userId);
    }
    return undefined;
  },
  
  getMatchingUsers: (query: string, limit = 5) => {
    const { users } = get();
    const queryLower = query.toLowerCase();
    const overrides = snapshotOverrides();

    // Filter users whose username, displayName, or (user-set) nickname starts
    // with the query. Inserting an @mention still uses user.username (the real
    // Twitch login) because Twitch IRC doesn't resolve nicknames.
    const matches: ChatUser[] = [];
    for (const user of users.values()) {
      const nick = overrides[user.userId]?.nickname?.toLowerCase();
      if (
        user.username.toLowerCase().startsWith(queryLower) ||
        user.displayName.toLowerCase().startsWith(queryLower) ||
        (nick && nick.startsWith(queryLower))
      ) {
        matches.push(user);
      }
    }

    // Sort by recency (most recent first)
    matches.sort((a, b) => b.lastSeen - a.lastSeen);

    return matches.slice(0, limit);
  },
  
  clearUsers: () => {
    set({ users: new Map(), usernameToId: new Map() });
  },
}));

// Reactive bridge from the shared cosmetics cache into the per-user chat
// store. Anything that writes to cosmeticsCache (chat's own addUser fetch,
// profile-card refresh, ProfileSettings, future surfaces) lands here, and
// we refresh the matching user's paint/badge in the store so their chat
// row repaints. Without this bridge a transient empty result earlier in
// the session stays stuck on screen even after a later fetch succeeded.
subscribeToCosmetics((userId, cosmetics) => {
  const state = useChatUserStore.getState();
  const existing = state.users.get(userId);
  if (!existing) return;

  const nextPaint = cosmetics?.paints?.find((p: any) => p.selected) ?? null;
  const nextBadge = cosmetics?.badges?.find((b: any) => b.selected) ?? null;

  // Identity-compare by id so we skip an enqueue when nothing changed.
  const samePaint = (existing.paint?.id ?? null) === (nextPaint?.id ?? null);
  const sameBadge = (existing.seventvBadge?.id ?? null) === (nextBadge?.id ?? null);
  if (samePaint && sameBadge && existing.paint !== undefined && existing.seventvBadge !== undefined) {
    return;
  }

  enqueueCosmeticUpdate(userId, nextPaint, nextBadge);
});
