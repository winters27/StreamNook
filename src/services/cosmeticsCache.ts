// Service for caching cosmetics - user lookups in memory, image files on disk
// User -> cosmetics mappings come from APIs fresh each time
// Image files are cached to disk by their respective services (seventvService, thirdPartyBadges)

interface CachedCosmetics {
  paints: any[];
  badges: any[];
  seventvUserId?: string;
}

// Full profile cache structure - includes all badge types
export interface CachedProfile {
  userId: string;
  username: string;
  channelId?: string;
  channelName?: string;
  twitchBadges: any[];
  seventvCosmetics: CachedCosmetics;
  thirdPartyBadges: any[];
  lastUpdated: number;
}

// In-memory cache for 7TV cosmetics (session only) - for SYNCHRONOUS access
// This mirrors the cache in seventvService but provides instant synchronous reads
const inMemoryCosmeticsCache = new Map<string, CachedCosmetics>();

// In-memory cache for third-party badges (session only)
const inMemoryThirdPartyBadgesCache = new Map<string, any[]>();

// In-memory cache for Twitch badges (session only)
const inMemoryTwitchBadgesCache = new Map<string, any[]>();

// Full profile cache (combines all badge types for instant profile loading)
const inMemoryProfileCache = new Map<string, CachedProfile>();

// Track pending requests to prevent duplicate fetches
const pendingCosmeticsRequests = new Map<string, Promise<CachedCosmetics>>();
const pendingThirdPartyBadgesRequests = new Map<string, Promise<any[]>>();
const pendingTwitchBadgesRequests = new Map<string, Promise<any[]>>();
const pendingProfileRequests = new Map<string, Promise<CachedProfile>>();

/**
 * Get cosmetics from synchronous in-memory cache (instant, no async)
 * Returns null if not in memory cache - use this for initial state
 */
export function getCosmeticsFromMemoryCache(userId: string): CachedCosmetics | null {
  return inMemoryCosmeticsCache.get(userId) || null;
}

/**
 * Get third-party badges from synchronous in-memory cache (instant, no async)
 * Returns null if not in memory cache - use this for initial state
 */
export function getThirdPartyBadgesFromMemoryCache(userId: string): any[] | null {
  return inMemoryThirdPartyBadgesCache.get(userId) || null;
}

/**
 * Get cosmetics for a user - memory cache -> API fetch with deduplication
 * Image caching is handled by the seventvService internally
 */
export async function getCosmeticsWithFallback(userId: string): Promise<CachedCosmetics> {
  // 1. Try in-memory cache first (instant, synchronous)
  const memoryCached = inMemoryCosmeticsCache.get(userId);
  if (memoryCached) {
    return memoryCached;
  }

  // 2. Check if there's already a pending request for this user (dedupe)
  const pendingRequest = pendingCosmeticsRequests.get(userId);
  if (pendingRequest) {
    return pendingRequest;
  }

  // 3. Create a new request and track it
  const request = (async (): Promise<CachedCosmetics> => {
    try {
      // Fetch from API (fresh data) - seventvService handles its own 5-minute memory caching
      const { getUserCosmetics } = await import('./seventvService');
      const cosmetics = await getUserCosmetics(userId);

      const result = cosmetics || { paints: [], badges: [] };

      // Store in memory cache for this session (synchronous access)
      inMemoryCosmeticsCache.set(userId, result);

      return result;
    } finally {
      pendingCosmeticsRequests.delete(userId);
    }
  })();

  pendingCosmeticsRequests.set(userId, request);
  return request;
}

/**
 * Get third-party badges for a user - memory cache -> API fetch
 * Badge images are cached to disk separately by thirdPartyBadges service
 */
export async function getThirdPartyBadgesWithFallback(userId: string): Promise<any[]> {
  // 1. Try in-memory cache first (instant, synchronous)
  const memoryCached = inMemoryThirdPartyBadgesCache.get(userId);
  if (memoryCached) {
    return memoryCached;
  }

  // 2. Check if there's already a pending request for this user (dedupe)
  const pendingRequest = pendingThirdPartyBadgesRequests.get(userId);
  if (pendingRequest) {
    return pendingRequest;
  }

  // 3. Create a new request and track it
  const request = (async (): Promise<any[]> => {
    try {
      // Fetch from API (fresh data) - thirdPartyBadges service handles image caching
      const { getAllThirdPartyBadges } = await import('./thirdPartyBadges');
      const badges = await getAllThirdPartyBadges(userId);

      // Store in memory cache for this session
      inMemoryThirdPartyBadgesCache.set(userId, badges);

      return badges;
    } finally {
      pendingThirdPartyBadgesRequests.delete(userId);
    }
  })();

  pendingThirdPartyBadgesRequests.set(userId, request);
  return request;
}

/**
 * Get Twitch badges from synchronous in-memory cache (instant, no async)
 * Returns null if not in memory cache - use this for initial state
 */
export function getTwitchBadgesFromMemoryCache(cacheKey: string): any[] | null {
  return inMemoryTwitchBadgesCache.get(cacheKey) || null;
}

/**
 * Get Twitch badges for a user - memory cache -> API fetch with deduplication
 */
export async function getTwitchBadgesWithFallback(
  userId: string,
  username: string,
  channelId: string,
  channelName: string
): Promise<any[]> {
  const cacheKey = `${userId}-${channelId}`;

  // 1. Try in-memory cache first (instant, synchronous)
  const memoryCached = inMemoryTwitchBadgesCache.get(cacheKey);
  if (memoryCached) {
    return memoryCached;
  }

  // 2. Check if there's already a pending request for this user (dedupe)
  const pendingRequest = pendingTwitchBadgesRequests.get(cacheKey);
  if (pendingRequest) {
    return pendingRequest;
  }

  // 3. Create a new request and track it
  const request = (async (): Promise<any[]> => {
    try {
      const { getAllUserBadges } = await import('./badgeService');
      const badgeData = await getAllUserBadges(userId, username, channelId, channelName);

      const uniqueBadges = new Map<string, any>();

      // Add display badges first
      badgeData.displayBadges.forEach(badge => {
        uniqueBadges.set(badge.id, badge);
      });

      // Add earned badges that aren't already displayed
      badgeData.earnedBadges.forEach(badge => {
        if (!uniqueBadges.has(badge.id)) {
          uniqueBadges.set(badge.id, badge);
        }
      });

      const result = Array.from(uniqueBadges.values());

      // Store in memory cache for this session
      inMemoryTwitchBadgesCache.set(cacheKey, result);

      return result;
    } finally {
      pendingTwitchBadgesRequests.delete(cacheKey);
    }
  })();

  pendingTwitchBadgesRequests.set(cacheKey, request);
  return request;
}

/**
 * Get full profile from synchronous in-memory cache (instant, no async)
 * Returns null if not in memory cache
 */
export function getProfileFromMemoryCache(userId: string): CachedProfile | null {
  return inMemoryProfileCache.get(userId) || null;
}

/**
 * Get full profile data with cache-first strategy
 * Returns cached data immediately if available, then refreshes in background
 */
export async function getFullProfileWithFallback(
  userId: string,
  username: string,
  channelId?: string,
  channelName?: string
): Promise<CachedProfile> {
  // 1. Try in-memory cache first (instant, synchronous)
  const memoryCached = inMemoryProfileCache.get(userId);
  if (memoryCached) {
    return memoryCached;
  }

  // 2. Check if there's already a pending request for this user (dedupe)
  const pendingRequest = pendingProfileRequests.get(userId);
  if (pendingRequest) {
    return pendingRequest;
  }

  // 3. Create a new request and track it
  const request = (async (): Promise<CachedProfile> => {
    try {
      const effectiveChannelId = channelId || userId;
      const effectiveChannelName = channelName || username;

      // Fetch all badge types in parallel
      const [twitchBadges, seventvCosmetics, thirdPartyBadges] = await Promise.all([
        getTwitchBadgesWithFallback(userId, username, effectiveChannelId, effectiveChannelName),
        getCosmeticsWithFallback(userId),
        getThirdPartyBadgesWithFallback(userId)
      ]);

      const profile: CachedProfile = {
        userId,
        username,
        channelId: effectiveChannelId,
        channelName: effectiveChannelName,
        twitchBadges,
        seventvCosmetics,
        thirdPartyBadges,
        lastUpdated: Date.now()
      };

      // Store in memory cache for this session
      inMemoryProfileCache.set(userId, profile);

      return profile;
    } finally {
      pendingProfileRequests.delete(userId);
    }
  })();

  pendingProfileRequests.set(userId, request);
  return request;
}

/**
 * Refresh profile data in background and update cache
 * This fetches fresh data without blocking
 */
export async function refreshProfileInBackground(
  userId: string,
  username: string,
  channelId?: string,
  channelName?: string
): Promise<void> {
  const effectiveChannelId = channelId || userId;
  const effectiveChannelName = channelName || username;
  const twitchCacheKey = `${userId}-${effectiveChannelId}`;

  console.log('[CosmeticsCache] Refreshing profile in background for:', username);

  try {
    // Fetch all badge types in parallel
    const [twitchBadgesResult, seventvCosmeticsResult, thirdPartyBadgesResult] = await Promise.allSettled([
      (async () => {
        const { getAllUserBadges } = await import('./badgeService');
        const badgeData = await getAllUserBadges(userId, username, effectiveChannelId, effectiveChannelName);
        const uniqueBadges = new Map<string, any>();
        badgeData.displayBadges.forEach(badge => uniqueBadges.set(badge.id, badge));
        badgeData.earnedBadges.forEach(badge => {
          if (!uniqueBadges.has(badge.id)) uniqueBadges.set(badge.id, badge);
        });
        return Array.from(uniqueBadges.values());
      })(),
      (async () => {
        const { getUserCosmetics } = await import('./seventvService');
        return await getUserCosmetics(userId) || { paints: [], badges: [] };
      })(),
      (async () => {
        const { getAllThirdPartyBadges } = await import('./thirdPartyBadges');
        return await getAllThirdPartyBadges(userId);
      })()
    ]);

    // Update individual caches with fresh data
    if (twitchBadgesResult.status === 'fulfilled') {
      inMemoryTwitchBadgesCache.set(twitchCacheKey, twitchBadgesResult.value);
    }
    if (seventvCosmeticsResult.status === 'fulfilled') {
      inMemoryCosmeticsCache.set(userId, seventvCosmeticsResult.value);
    }
    if (thirdPartyBadgesResult.status === 'fulfilled') {
      inMemoryThirdPartyBadgesCache.set(userId, thirdPartyBadgesResult.value);
    }

    // Update full profile cache
    const profile: CachedProfile = {
      userId,
      username,
      channelId: effectiveChannelId,
      channelName: effectiveChannelName,
      twitchBadges: twitchBadgesResult.status === 'fulfilled' ? twitchBadgesResult.value : inMemoryTwitchBadgesCache.get(twitchCacheKey) || [],
      seventvCosmetics: seventvCosmeticsResult.status === 'fulfilled' ? seventvCosmeticsResult.value : inMemoryCosmeticsCache.get(userId) || { paints: [], badges: [] },
      thirdPartyBadges: thirdPartyBadgesResult.status === 'fulfilled' ? thirdPartyBadgesResult.value : inMemoryThirdPartyBadgesCache.get(userId) || [],
      lastUpdated: Date.now()
    };

    inMemoryProfileCache.set(userId, profile);
    console.log('[CosmeticsCache] Profile refreshed for:', username);
  } catch (error) {
    console.error('[CosmeticsCache] Failed to refresh profile:', error);
  }
}

/**
 * Clear in-memory caches (useful for testing or channel switch)
 */
export function clearCosmeticsMemoryCache(): void {
  inMemoryCosmeticsCache.clear();
  pendingCosmeticsRequests.clear();
  inMemoryThirdPartyBadgesCache.clear();
  pendingThirdPartyBadgesRequests.clear();
  inMemoryTwitchBadgesCache.clear();
  pendingTwitchBadgesRequests.clear();
  inMemoryProfileCache.clear();
  pendingProfileRequests.clear();
  console.log('[CosmeticsCache] All memory caches cleared');
}
