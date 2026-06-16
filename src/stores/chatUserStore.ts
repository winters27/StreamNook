import { create } from 'zustand';
import {
  getCosmeticsFromMemoryCache,
  getCosmeticsWithFallback,
  isUserCosmeticsHardFailed,
  subscribeToCosmetics,
} from '../services/cosmeticsCache';
import { isStreamNookUser, getProfilePrefs, whenAtmospheresReady, subscribeAtmospheresVersion, subscribeStreamNookRegistryVersion } from '../services/supabaseService';
import { getAtmosphere } from '../services/atmospheres';
import {
  getResolvedIdentity,
  getResolvedIdentityFromCache,
  getIdentityWithCache,
  subscribeResolvedIdentity,
  type ResolvedBadge,
} from '../services/identityService';
import { getGlobalThirdPartyBadges, type ThirdPartyBadge } from '../services/badgeService';
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
 * a user's 7TV paint + 7TV badge + third-party chat-client badges.
 * Per-message components subscribe to these instead of each maintaining its
 * own useState + fetch effect.
 *
 * Third-party chat-client badges (FFZ / Chatterino / Homies / Chatsen / Chatty /
 * DankChat / BTTV) are resolved here ONCE per unique chatter. For StreamNook
 * members it is their curated loadout (resolved + ownership-checked by the
 * Identity API), which overrides their raw set. For everyone else it is their
 * REAL provider badges, looked up from the prefetched provider databases in
 * Rust (a cache-only call, no per-user network round-trip), the way Chatterino
 * shows them. Either way the per-message render path stays free of network calls.
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
  /** Third-party chat-client badges resolved to images: a member's curated
   *  loadout, or a non-member's real provider badges. Undefined until resolved;
   *  empty array = member who opted into nothing. */
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

// Non-members whose real provider badges have already been resolved this session.
// The Rust lookup reads only the prefetched provider databases, so a non-member's
// result can't change within a session — resolving them once is enough. Without
// this guard a non-member re-triggers the Rust IPC lookup on EVERY message until
// their (separate) 7TV cosmetics resolve flips the cosmeticsResolved fast path,
// which floods a busy channel with thousands of redundant cross-process calls.
// Members are intentionally NOT gated here (they go through their own identity
// resolve cache, so a live loadout edit still re-resolves). Pruned alongside the
// user map (eviction + channel switch) so it never outgrows the tracked users.
const thirdPartyNonMemberResolved = new Set<string>();

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

// Resolve a chatter's third-party badges once and push them into the store.
//
// Members: their CURATED loadout (the badges they opted into on their StreamNook
// profile), which overrides their raw set. Cache hit -> enqueue immediately;
// miss -> kick the fetch and let the resolved-identity listener below enqueue
// when it lands (so we never write the store twice).
//
// Everyone else: their REAL provider badges (BTTV / FFZ / Chatterino / Homies /
// Chatsen / Chatty / DankChat), looked up from the prefetched provider databases
// in Rust. That call is a pure in-memory cache hit (no per-user network round
// trip), so it is safe in this once-per-chatter path. We skip the store write
// when the chatter carries no third-party badges (the common case) to avoid
// needless churn. BTTV Pro is intentionally NOT resolved for non-members: it
// needs a per-user live socket lookup, the one thing that would bring back the
// per-chatter network cost, so it stays an opt-in member identity badge.
function ensureThirdPartyResolved(userId: string | undefined) {
  if (!userId) return;

  if (isStreamNookUser(userId)) {
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
    return;
  }

  // Resolve a non-member at most once per session. Mark BEFORE the async call so
  // concurrent messages from the same chatter can't each kick a duplicate lookup.
  if (thirdPartyNonMemberResolved.has(userId)) return;
  thirdPartyNonMemberResolved.add(userId);
  void getGlobalThirdPartyBadges(userId)
    .then((badges) => {
      if (badges.length === 0) return;
      pendingThirdPartyUpdates.set(userId, badges);
      scheduleThirdPartyFlush();
    })
    .catch(() => {});
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
  if (ownAtmosphereAccounts.has(userId)) persistOwnAtmosphere(userId);
}

// Disk persistence of OUR OWN accounts' resolved Atmosphere id (primary + every
// linked account), so the wash behind our messages paints on frame one of a cold
// launch instead of after the per-sighting prefs fetch. Keyed by account id.
const OWN_ATMOSPHERE_KEY = 'streamnook_own_atmosphere_v1';
const ownAtmosphereAccounts = new Set<string>();

function readPersistedAtmospheres(): Record<string, string | null> {
  try {
    const raw = localStorage.getItem(OWN_ATMOSPHERE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string | null>) : {};
  } catch {
    return {};
  }
}

function persistOwnAtmosphere(userId: string): void {
  try {
    const store = readPersistedAtmospheres();
    store[userId] = atmosphereCache.get(userId) ?? null;
    localStorage.setItem(OWN_ATMOSPHERE_KEY, JSON.stringify(store));
  } catch {
    /* ignore (private mode / unavailable storage) */
  }
}

/**
 * Register all of OUR account ids (primary + linked) and seed each one's
 * Atmosphere wash from the id persisted last session, so a cold launch paints it
 * on frame one for every account. The stored value is the already-resolved id, so
 * no catalog wait is needed. Marks them own so a later theme change persists. An
 * explicit change still overwrites live via refreshAtmosphere; the per-sighting
 * resolve still backfills any account with nothing stored yet.
 */
export function registerOwnAtmospheres(userIds: string[]): void {
  const store = readPersistedAtmospheres();
  for (const userId of userIds) {
    if (!userId || ownAtmosphereAccounts.has(userId)) continue; // already registered/seeded
    ownAtmosphereAccounts.add(userId);
    if (userId in store) pushAtmosphere(userId, store[userId]);
  }
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
      // Wait for the atmosphere catalog so we never resolve a real theme to null
      // just because the catalog had not loaded yet.
      await whenAtmospheresReady();
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


// The tracked-user map is a session-long singleton shared by every chat surface
// (main app + each MultiChat pane), and clearUsers only fires on channel switch.
// Without a cap it accumulated every chatter ever seen (tens of MB of paint/badge
// data over an evening). The cap sits far above any rendered message buffer (the
// per-channel message cap tops out at ~1150), so the least-recently-seen users
// evicted here have long since scrolled out of view across every surface; if one
// speaks again they are simply re-added (a cheap cosmetics re-resolve).
const MAX_TRACKED_USERS = 8000;
const USER_EVICT_SLACK = 1000;

function evictStaleUsers(
  users: Map<string, ChatUser>,
  usernameToId: Map<string, string>,
): void {
  if (users.size <= MAX_TRACKED_USERS + USER_EVICT_SLACK) return;
  // Sweep in batches (only when over cap + slack) so the O(n log n) sort is
  // amortized across many inserts rather than run on every new chatter.
  const sorted = Array.from(users.values()).sort((a, b) => a.lastSeen - b.lastSeen);
  const removeCount = users.size - MAX_TRACKED_USERS;
  for (let i = 0; i < removeCount; i++) {
    const victim = sorted[i];
    users.delete(victim.userId);
    thirdPartyNonMemberResolved.delete(victim.userId);
    const unameKey = victim.username.toLowerCase();
    if (usernameToId.get(unameKey) === victim.userId) {
      usernameToId.delete(unameKey);
    }
  }
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
      // First-sight is the only path that grows the map, so cap it here.
      evictStaleUsers(newUsers, newUsernameToId);
      return { users: newUsers, usernameToId: newUsernameToId };
    });

    // Apply resolved 7TV cosmetics. A genuine answer (the user has a paint, or
    // genuinely has none) sets paint and seventvBadge (possibly to null) so the
    // cosmeticsResolved sentinel flips true. Routes through the module-level
    // coalescer so a burst of resolutions from the batched GraphQL response
    // collapses into one store update.
    //
    // A HARD FAILURE (network / 5xx / "query too complex" batch rejection) is
    // NOT a real answer. We must leave the user unresolved — paint/badge stay
    // undefined — so their next message re-fetches and the cache's 30s self-heal
    // recovers them. Stamping null here would flip the cosmeticsResolved sentinel,
    // sending every later message down the addUser fast-path that never re-fetches,
    // stranding the user paint-less for the whole session.
    const applyCosmetics = (cosmetics: { paints?: any[]; badges?: any[] } | null) => {
      const selectedPaint = cosmetics?.paints?.find((p: any) => p.selected) ?? null;
      const selectedBadge = cosmetics?.badges?.find((b: any) => b.selected) ?? null;
      enqueueCosmeticUpdate(user.userId, selectedPaint, selectedBadge);
    };

    const cachedCosmetics = getCosmeticsFromMemoryCache(user.userId);
    if (cachedCosmetics && !isUserCosmeticsHardFailed(user.userId)) {
      applyCosmetics(cachedCosmetics);
    } else {
      // The fetch records (or clears) the hard-fail mark before it resolves, so
      // re-read it here. On a hard failure, skip the apply and leave the user
      // unresolved so the next message retries once the 30s window elapses.
      getCosmeticsWithFallback(user.userId)
        .then(() => {
          if (isUserCosmeticsHardFailed(user.userId)) return;
          const resolved = getCosmeticsFromMemoryCache(user.userId);
          if (resolved) applyCosmetics(resolved);
        })
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
    // The third-party badge data lives inside the user records being wiped here,
    // so drop the resolved-guard too: a chatter reappearing in the next channel
    // re-resolves cleanly instead of being skipped with no badges.
    thirdPartyNonMemberResolved.clear();
    set({ users: new Map(), usernameToId: new Map() });
  },
}));

// When the atmosphere catalog (re)loads, re-resolve any tracked member we had
// previously resolved to "no atmosphere": an atmosphere added live that they
// already equip can now render without waiting for a re-sighting. Only
// null-cached users are touched, so a value set by an explicit theme change is
// left alone.
subscribeAtmospheresVersion(() => {
  const users = useChatUserStore.getState().users;
  for (const uid of users.keys()) {
    if (atmosphereCache.get(uid) === null) {
      atmosphereCache.delete(uid);
      atmosphereInFlight.delete(uid);
      ensureAtmosphereResolved(uid);
    }
  }
});

// Reactive bridge from the shared cosmetics cache into the per-user chat
// store. Anything that writes to cosmeticsCache (chat's own addUser fetch,
// profile-card refresh, ProfileSettings, future surfaces) lands here, and
// we refresh the matching user's paint/badge in the store so their chat
// row repaints. Without this bridge a transient empty result earlier in
// the session stays stuck on screen even after a later fetch succeeded.
subscribeToCosmetics((userId, cosmetics, hardFail) => {
  const state = useChatUserStore.getState();
  const existing = state.users.get(userId);
  if (!existing) return;

  // A hard failure isn't a real answer. Don't stamp a null paint (which would
  // flip the addUser fast-path's cosmeticsResolved sentinel and stop retries);
  // leave whatever's already on the row so a later success can repaint it.
  if (hardFail) return;

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

// The StreamNook member registry loads/refreshes asynchronously. A member first
// seen before it finished loading was classified as a non-member and shown their
// raw provider badges; when the registry lands, re-resolve any tracked member so
// their curated loadout (which overrides) takes over. Mirrors the atmosphere
// re-resolve above. Non-members are unaffected by a registry change, so we only
// touch users now known to be members.
subscribeStreamNookRegistryVersion(() => {
  const users = useChatUserStore.getState().users;
  for (const uid of users.keys()) {
    if (isStreamNookUser(uid)) ensureThirdPartyResolved(uid);
  }
});
