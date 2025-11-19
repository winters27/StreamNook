// Universal cache service for badges, emotes, and other assets
import { invoke } from '@tauri-apps/api/core';

export interface UniversalCacheEntry {
  id: string;
  cache_type: 'badge' | 'emote' | 'badgebase' | 'third-party-badge' | 'cosmetic';
  data: any;
  metadata: {
    timestamp: number;
    expiry_days: number;
    source: string;
    version: number;
  };
}

export interface UniversalCacheStats {
  total_entries: number;
  entries_by_type: Record<string, number>;
  last_sync: number | null;
  cache_dir: string;
}

/**
 * Get an item from the universal cache
 */
export async function getUniversalCachedItem(
  cacheType: 'badge' | 'emote' | 'badgebase' | 'third-party-badge' | 'cosmetic',
  id: string
): Promise<UniversalCacheEntry | null> {
  try {
    const result = await invoke<UniversalCacheEntry | null>('get_universal_cached_item', {
      cacheType,
      id,
    });
    return result;
  } catch (error) {
    console.error('[UniversalCache] Failed to get cached item:', error);
    return null;
  }
}

/**
 * Save an item to the universal cache
 */
export async function saveUniversalCachedItem(
  cacheType: 'badge' | 'emote' | 'badgebase' | 'third-party-badge' | 'cosmetic',
  id: string,
  data: any,
  source: string,
  expiryDays: number = 7
): Promise<void> {
  try {
    await invoke('save_universal_cached_item', {
      cacheType,
      id,
      data,
      source,
      expiryDays,
    });
  } catch (error) {
    console.error('[UniversalCache] Failed to save cached item:', error);
  }
}

/**
 * Sync with the universal cache repository
 */
export async function syncUniversalCache(
  cacheTypes: Array<'badge' | 'emote' | 'badgebase' | 'third-party-badge' | 'cosmetic'>
): Promise<number> {
  try {
    const count = await invoke<number>('sync_universal_cache_data', {
      cacheTypes,
    });
    console.log(`[UniversalCache] Synced ${count} items from universal cache`);
    return count;
  } catch (error) {
    console.error('[UniversalCache] Failed to sync:', error);
    return 0;
  }
}

/**
 * Clean up expired cache entries
 */
export async function cleanupUniversalCache(): Promise<number> {
  try {
    const count = await invoke<number>('cleanup_universal_cache');
    console.log(`[UniversalCache] Cleaned up ${count} expired entries`);
    return count;
  } catch (error) {
    console.error('[UniversalCache] Failed to cleanup:', error);
    return 0;
  }
}

/**
 * Clear all universal cache data
 */
export async function clearUniversalCache(): Promise<void> {
  try {
    await invoke('clear_all_universal_cache');
    console.log('[UniversalCache] Cleared all cache data');
  } catch (error) {
    console.error('[UniversalCache] Failed to clear cache:', error);
  }
}

/**
 * Get universal cache statistics
 */
export async function getUniversalCacheStats(): Promise<UniversalCacheStats | null> {
  try {
    const stats = await invoke<UniversalCacheStats>('get_universal_cache_statistics');
    return stats;
  } catch (error) {
    console.error('[UniversalCache] Failed to get stats:', error);
    return null;
  }
}

/**
 * Helper function to cache badge data (permanent - never expires)
 */
export async function cacheBadge(badgeId: string, badgeData: any, source: string = 'twitch'): Promise<void> {
  await saveUniversalCachedItem('badge', badgeId, badgeData, source, 0); // 0 = never expire
}

/**
 * Helper function to get cached badge data
 */
export async function getCachedBadge(badgeId: string): Promise<any | null> {
  const entry = await getUniversalCachedItem('badge', badgeId);
  return entry?.data || null;
}

/**
 * Helper function to cache emote data (permanent - never expires)
 */
export async function cacheEmote(emoteId: string, emoteData: any, source: string): Promise<void> {
  await saveUniversalCachedItem('emote', emoteId, emoteData, source, 0); // 0 = never expire
}

/**
 * Helper function to get cached emote data
 */
export async function getCachedEmote(emoteId: string): Promise<any | null> {
  const entry = await getUniversalCachedItem('emote', emoteId);
  return entry?.data || null;
}

/**
 * Helper function to cache third-party badge data (permanent - never expires)
 */
export async function cacheThirdPartyBadge(
  badgeId: string,
  badgeData: any,
  provider: 'ffz' | 'chatterino' | 'homies'
): Promise<void> {
  await saveUniversalCachedItem('third-party-badge', badgeId, badgeData, provider, 0); // 0 = never expire
}

/**
 * Helper function to get cached third-party badge data
 */
export async function getCachedThirdPartyBadge(badgeId: string): Promise<any | null> {
  const entry = await getUniversalCachedItem('third-party-badge', badgeId);
  return entry?.data || null;
}
