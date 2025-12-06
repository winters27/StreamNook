// Service for caching cosmetics - user lookups in memory, image files on disk
// User -> cosmetics mappings come from APIs fresh each time
// Image files are cached to disk by their respective services (seventvService, thirdPartyBadges)

interface CachedCosmetics {
  paints: any[];
  badges: any[];
}

// In-memory cache for 7TV cosmetics (session only) - for SYNCHRONOUS access
// This mirrors the cache in seventvService but provides instant synchronous reads
const inMemoryCosmeticsCache = new Map<string, CachedCosmetics>();

// In-memory cache for third-party badges (session only)
const inMemoryThirdPartyBadgesCache = new Map<string, any[]>();

// Track pending requests to prevent duplicate fetches
const pendingCosmeticsRequests = new Map<string, Promise<CachedCosmetics>>();
const pendingThirdPartyBadgesRequests = new Map<string, Promise<any[]>>();

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
 * Clear in-memory caches (useful for testing or channel switch)
 */
export function clearCosmeticsMemoryCache(): void {
  inMemoryCosmeticsCache.clear();
  pendingCosmeticsRequests.clear();
  inMemoryThirdPartyBadgesCache.clear();
  pendingThirdPartyBadgesRequests.clear();
  console.log('[CosmeticsCache] Memory caches cleared');
}
