// Service for caching and retrieving 7TV cosmetics and third-party badges using universal cache
import { invoke } from '@tauri-apps/api/core';

interface CachedCosmetics {
  paints: any[];
  badges: any[];
}

interface CachedThirdPartyBadges {
  badges: any[];
}

/**
 * Cache user cosmetics (7TV badges and paints)
 */
export async function cacheUserCosmetics(userId: string, cosmetics: CachedCosmetics): Promise<void> {
  try {
    await invoke('cache_user_cosmetics', {
      userId,
      cosmeticsData: cosmetics,
    });
    console.log(`[CosmeticsCache] Cached cosmetics for user ${userId}`);
  } catch (error) {
    console.error('[CosmeticsCache] Failed to cache user cosmetics:', error);
    throw error;
  }
}

/**
 * Get cached user cosmetics (7TV badges and paints)
 */
export async function getCachedUserCosmetics(userId: string): Promise<CachedCosmetics | null> {
  try {
    const cached = await invoke<CachedCosmetics | null>('get_cached_user_cosmetics', { userId });
    if (cached) {
      console.log(`[CosmeticsCache] Retrieved cached cosmetics for user ${userId}`);
    }
    return cached;
  } catch (error) {
    console.error('[CosmeticsCache] Failed to get cached user cosmetics:', error);
    return null;
  }
}

/**
 * Cache third-party badges for a user
 */
export async function cacheThirdPartyBadges(userId: string, badges: any[]): Promise<void> {
  try {
    await invoke('cache_third_party_badges', {
      userId,
      badgesData: { badges },
    });
    console.log(`[CosmeticsCache] Cached third-party badges for user ${userId}`);
  } catch (error) {
    console.error('[CosmeticsCache] Failed to cache third-party badges:', error);
    throw error;
  }
}

/**
 * Get cached third-party badges for a user
 */
export async function getCachedThirdPartyBadges(userId: string): Promise<any[] | null> {
  try {
    const cached = await invoke<CachedThirdPartyBadges | null>('get_cached_third_party_badges', { userId });
    if (cached) {
      console.log(`[CosmeticsCache] Retrieved cached third-party badges for user ${userId}`);
      return cached.badges;
    }
    return null;
  } catch (error) {
    console.error('[CosmeticsCache] Failed to get cached third-party badges:', error);
    return null;
  }
}

/**
 * Pre-fetch and cache cosmetics for a user (fetches from APIs and stores in cache)
 */
export async function prefetchAndCacheUserCosmetics(userId: string): Promise<void> {
  try {
    console.log(`[CosmeticsCache] Pre-fetching cosmetics for user ${userId}...`);
    
    // Fetch from 7TV service
    const { getUserCosmetics } = await import('./seventvService');
    const cosmetics = await getUserCosmetics(userId);
    
    if (cosmetics && (cosmetics.paints.length > 0 || cosmetics.badges.length > 0)) {
      await cacheUserCosmetics(userId, cosmetics);
    }
  } catch (error) {
    console.error('[CosmeticsCache] Failed to pre-fetch user cosmetics:', error);
  }
}

/**
 * Pre-fetch and cache third-party badges for a user
 */
export async function prefetchAndCacheThirdPartyBadges(userId: string): Promise<void> {
  try {
    console.log(`[CosmeticsCache] Pre-fetching third-party badges for user ${userId}...`);
    
    // Fetch from third-party services
    const { getAllThirdPartyBadges } = await import('./thirdPartyBadges');
    const badges = await getAllThirdPartyBadges(userId);
    
    if (badges.length > 0) {
      await cacheThirdPartyBadges(userId, badges);
    }
  } catch (error) {
    console.error('[CosmeticsCache] Failed to pre-fetch third-party badges:', error);
  }
}

/**
 * Pre-fetch all cosmetics and badges for a user (convenience method)
 */
export async function prefetchAllUserData(userId: string): Promise<void> {
  await Promise.all([
    prefetchAndCacheUserCosmetics(userId),
    prefetchAndCacheThirdPartyBadges(userId),
  ]);
  console.log(`[CosmeticsCache] Pre-fetch complete for user ${userId}`);
}

/**
 * Get cosmetics with fallback - tries cache first, then fetches from API
 */
export async function getCosmeticsWithFallback(userId: string): Promise<CachedCosmetics> {
  // Try cache first
  const cached = await getCachedUserCosmetics(userId);
  if (cached) {
    return cached;
  }
  
  // Fallback to API
  console.log(`[CosmeticsCache] Cache miss, fetching from API for user ${userId}`);
  const { getUserCosmetics } = await import('./seventvService');
  const cosmetics = await getUserCosmetics(userId);
  
  if (cosmetics) {
    // Cache for next time
    await cacheUserCosmetics(userId, cosmetics).catch(err => 
      console.error('[CosmeticsCache] Failed to cache after fetch:', err)
    );
    return cosmetics;
  }
  
  return { paints: [], badges: [] };
}

/**
 * Get third-party badges with fallback - tries cache first, then fetches from API
 */
export async function getThirdPartyBadgesWithFallback(userId: string): Promise<any[]> {
  // Try cache first
  const cached = await getCachedThirdPartyBadges(userId);
  if (cached) {
    return cached;
  }
  
  // Fallback to API
  console.log(`[CosmeticsCache] Cache miss, fetching third-party badges from API for user ${userId}`);
  const { getAllThirdPartyBadges } = await import('./thirdPartyBadges');
  const badges = await getAllThirdPartyBadges(userId);
  
  if (badges.length > 0) {
    // Cache for next time
    await cacheThirdPartyBadges(userId, badges).catch(err =>
      console.error('[CosmeticsCache] Failed to cache third-party badges after fetch:', err)
    );
  }
  
  return badges;
}
