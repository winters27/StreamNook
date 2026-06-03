import { create } from 'zustand';
import {
  getCosmeticsFromMemoryCache,
  getCosmeticsWithFallback,
  subscribeToCosmetics,
} from '../services/cosmeticsCache';
import { isStreamNookUser, getProfilePrefs } from '../services/supabaseService';
import { getAtmosphere } from '../services/atmospheres';
import {
  getResolvedIdentity,
  getResolvedIdentityFromCache,
  getIdentityWithCache,
  subscribeResolvedIdentity,
  type ResolvedBadge,
} from '../services/identityService';
import type { ThirdPartyBadge } from '../services/badgeService';
import {
  BTTV_PRO_LOADOUT_KEY,
  BTTV_PRO_BADGE_ID,
  buildBttvProBadge,
  resolveBttvProUrl,
} from '../services/bttvProBadge';
import { snapshotOverrides } from '../utils/userChatOverrides';

/**
 * Represents a user who has chatted in the current channel.
 * Used for @ mention autocomplete suggestions and as the canonical store for
 * a user's 7TV paint + 7TV badge + StreamNook third-party badge loadout.
 * Per-message components subscribe to these instead of each maintaining its
 * own useState + fetch effect.
 *
 * Third-party chat-client badges (FFZ / Chatterino / Homies / Chatsen / Chatty /
 * DankChat / BTTV) are resolved here ONLY for StreamNook members, ONCE per
 * unique chatter, via the Identity API (the server returns the member's curated
 * set already resolved to images). That keeps the per-message render path free
 * of network calls — the lag/paint-starvation that an earlier per-message
 * resolve caused. Non-members never trigger a fetch.
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
  /** StreamNook member's curated third-party badges, resolved to images.
   *  Undefined until resolved; empty array = member with nothing opted in. */
  thirdPartyBadges?: ThirdPartyBadge[];
  /** The id of the StreamNook Atmosphere this member themes with (if any), so
   *  chat can render the matching animated wash. Undefined until resolved; null =
   *  resolved, none. */
  atmosphereId?: string | null;
}

interface ChatUserStore {
  /** Map of userId -> ChatUser for O(1) lookups */
  users: Map<string, ChatUser>;
  /** Map of lowercase username -> userId for fast username lookups */
  usernameToId: Map<string, string>;
  
  /**
   * Add or update a user when they send a message. channelContext is accepted
   * for call-site compatibility but no longer used (third-party badges are
   * resolved by twitch_user_id through the Identity API, not by channel).
   */
  addUser: (
    user: Omit<ChatUser, 'lastSeen' | 'paint' | 'seventvBadge' | 'thirdPartyBadges' | 'atmosphereId'>,
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

// ── StreamNook third-party badge loadout ─────────────────────────────────────
// Same once-per-user, read-synchronously contract as the 7TV cosmetics above,
// but sourced from the Identity API's resolved bundle (the member's curated
// badges already resolved to images, server-side ownership-checked). Its own
// microtask coalescer so a burst of members resolving collapses into one
// setState instead of one clone+commit per user.
const pendingThirdPartyUpdates = new Map<string, ThirdPartyBadge[]>();
let pendingThirdPartyFlushScheduled = false;

function scheduleThirdPartyFlush() {
  if (pendingThirdPartyFlushScheduled) return;
  pendingThirdPartyFlushScheduled = true;
  queueMicrotask(() => {
    pendingThirdPartyFlushScheduled = false;
    if (pendingThirdPartyUpdates.size === 0) return;
    const updates = new Map(pendingThirdPartyUpdates);
    pendingThirdPartyUpdates.clear();
    useChatUserStore.setState((state) => {
      const newUsers = new Map(state.users);
      for (const [uid, badges] of updates) {
        const current = newUsers.get(uid);
        if (current) newUsers.set(uid, { ...current, thirdPartyBadges: badges });
      }
      return { users: newUsers };
    });
  });
}

// The resolve endpoint already ownership-checks and orders these; map its
// minimal {key,provider,title,image_url} shape onto the ThirdPartyBadge shape
// the chat badge row renders (it reads only id / imageUrl / title / provider).
function mapResolvedBadges(badges: ResolvedBadge[]): ThirdPartyBadge[] {
  return badges.map((b) => ({
    id: b.key,
    title: b.title,
    imageUrl: b.image_url,
    image1x: b.image_url,
    image2x: b.image_url,
    image4x: b.image_url,
    provider: b.provider,
  }));
}

// Resolve a member's curated badges once and push them into the store. Cache
// hit → enqueue immediately; miss → kick the fetch and let the resolved-identity
// listener below enqueue when it lands (so we never write the store twice).
// Non-members and empty ids are no-ops, so chat only ever fetches for members.
function ensureThirdPartyResolved(userId: string | undefined) {
  if (!userId || !isStreamNookUser(userId)) return;
  const cached = getResolvedIdentityFromCache(userId);
  if (cached) {
    pendingThirdPartyUpdates.set(userId, mapResolvedBadges(cached.badges));
    scheduleThirdPartyFlush();
  } else {
    void getResolvedIdentity(userId).catch(() => {});
  }
  // BTTV Pro is WebSocket-only, so the Identity API can't resolve it like the
  // other providers (its loadout key passes through unresolved). Resolve it
  // client-side and merge it into this member's row if they opted it in.
  ensureBttvProResolved(userId);
}

// Resolve + merge a member's BTTV Pro badge when their loadout opted it in.
// Kept ADDITIVE and separate from the resolved-badge flush (which REPLACES the
// array) so the two never clobber each other: the flush lands the server-resolved
// contributor badges first (microtask), then this appends Pro after the socket
// lookup returns (network). We read the RAW loadout — not the resolved bundle,
// which drops the unresolved Pro key — to know whether the member opted in.
function ensureBttvProResolved(userId: string) {
  void getIdentityWithCache(userId)
    .then((loadout) => {
      if (!loadout.badges.includes(BTTV_PRO_LOADOUT_KEY)) {
        removeBttvPro(userId);
        return;
      }
      return resolveBttvProUrl(userId).then((url) => {
        if (url) mergeBttvPro(userId, buildBttvProBadge(url));
        else removeBttvPro(userId);
      });
    })
    .catch(() => {});
}

function mergeBttvPro(userId: string, badge: ThirdPartyBadge) {
  useChatUserStore.setState((state) => {
    const u = state.users.get(userId);
    if (!u) return {};
    const existing = u.thirdPartyBadges ?? [];
    if (existing.some((b) => b.id === badge.id)) return {}; // already present
    const newUsers = new Map(state.users);
    newUsers.set(userId, { ...u, thirdPartyBadges: [...existing, badge] });
    return { users: newUsers };
  });
}

function removeBttvPro(userId: string) {
  useChatUserStore.setState((state) => {
    const u = state.users.get(userId);
    if (!u?.thirdPartyBadges?.some((b) => b.id === BTTV_PRO_BADGE_ID)) return {};
    const newUsers = new Map(state.users);
    newUsers.set(userId, {
      ...u,
      thirdPartyBadges: u.thirdPartyBadges.filter((b) => b.id !== BTTV_PRO_BADGE_ID),
    });
    return { users: newUsers };
  });
}

// ── StreamNook Atmosphere chat wash (subscriber profile theme -> chat) ───────
// A subscriber who themes their profile with an Atmosphere also gets a subtle
// STATIC wash + edge bar behind their chat messages, so the cosmetic follows
// them into chat. Resolved once per MEMBER (no-op for non-members), gated on
// subscriber status. No animation in chat (perf): a static gradient only.
const pendingAtmosphereUpdates = new Map<string, string | null>();
let pendingAtmosphereFlushScheduled = false;
// Resolved atmosphere id per user (null = none). Doubles as the once-per-user
// cache AND lets an explicit change set a KNOWN value with no Supabase read, so a
// read can't race the just-fired write.
const atmosphereCache = new Map<string, string | null>();
const atmosphereInFlight = new Set<string>();

function scheduleAtmosphereFlush() {
  if (pendingAtmosphereFlushScheduled) return;
  pendingAtmosphereFlushScheduled = true;
  queueMicrotask(() => {
    pendingAtmosphereFlushScheduled = false;
    if (pendingAtmosphereUpdates.size === 0) return;
    const updates = new Map(pendingAtmosphereUpdates);
    pendingAtmosphereUpdates.clear();
    useChatUserStore.setState((state) => {
      const newUsers = new Map(state.users);
      for (const [uid, id] of updates) {
        const current = newUsers.get(uid);
        if (current) newUsers.set(uid, { ...current, atmosphereId: id });
      }
      return { users: newUsers };
    });
  });
}

function pushAtmosphere(userId: string, id: string | null) {
  atmosphereCache.set(userId, id);
  pendingAtmosphereUpdates.set(userId, id);
  scheduleAtmosphereFlush();
}

function ensureAtmosphereResolved(userId: string) {
  if (!userId || !isStreamNookUser(userId)) return;
  // Cached/known value (incl. one set by an explicit change before the user was
  // in the store): push it to the store for this (re)sighting.
  if (atmosphereCache.has(userId)) {
    pendingAtmosphereUpdates.set(userId, atmosphereCache.get(userId)!);
    scheduleAtmosphereFlush();
    return;
  }
  if (atmosphereInFlight.has(userId)) return;
  atmosphereInFlight.add(userId);
  void (async () => {
    try {
      // Visibility reads the world-readable profile_theme (not gated on subscriber
      // status), so a member's Atmosphere shows for every viewer like a badge.
      const prefs = await getProfilePrefs(userId);
      const atm = getAtmosphere(prefs.profileTheme);
      pushAtmosphere(userId, atm ? atm.id : null);
    } catch {
      /* leave uncached so a later sighting retries */
    } finally {
      atmosphereInFlight.delete(userId);
    }
  })();
}

// Set a member's Atmosphere to a KNOWN value now (they just changed their theme),
// so their messages update in real time with no Supabase read (and switching away
// from an Atmosphere clears it).
export function refreshAtmosphere(userId: string, atmosphereId: string | null) {
  pushAtmosphere(userId, atmosphereId);
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
        thirdPartyBadges: existingUser?.thirdPartyBadges,
        atmosphereId: existingUser?.atmosphereId,
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

    // Resolve this member's curated third-party badges once (no-op for non-members).
    ensureThirdPartyResolved(user.userId);
    // Resolve this member's subscriber Atmosphere chat wash once (no-op for non-members).
    ensureAtmosphereResolved(user.userId);
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

// Repaint chat rows when a member's resolved identity lands or changes. Fires on
// the initial per-user fetch (above) and on a member editing their own loadout
// (setIdentity clears the resolved cache, which re-resolves here). Only touches
// users already in this channel's store; others propagate on their next fetch.
subscribeResolvedIdentity((userId) => {
  if (!useChatUserStore.getState().users.has(userId)) return;
  ensureThirdPartyResolved(userId);
});
