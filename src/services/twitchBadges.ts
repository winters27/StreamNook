import { Logger } from '../utils/logger';
/**
 * DEPRECATED: This service has been replaced by the unified Rust badge service
 * 
 * All badge functionality is now handled in Rust for maximum performance.
 * Please use `badgeService.ts` instead:
 * 
 * ```typescript
 * import { getAllUserBadges, prefetchChannelBadges } from './badgeService';
 * ```
 * 
 * The Rust backend handles:
 * - Twitch Helix API (global + channel badges)
 * - Twitch GQL (user display/earned badges)
 * - Third-party providers (FFZ, Chatterino, Homies)
 * - LRU caching with automatic eviction
 * - Background pre-fetching
 */

// Re-export from unified service for backwards compatibility
export {
  getAllUserBadges,
  parseBadgeString,
  prefetchGlobalBadges,
  prefetchChannelBadges,
  clearBadgeCache,
  clearChannelBadgeCache,
  type BadgeInfo,
  type UserBadge,
  type UserBadgesResponse,
  type TwitchBadge,
} from './badgeService';

// Legacy function names for backwards compatibility
export { prefetchGlobalBadges as fetchGlobalBadges } from './badgeService';

// Older callsites expect a 3-arg `fetchChannelBadges(channelId, clientId, token)`.
// Keep that signature but ignore extra args.
export async function fetchChannelBadges(channelId: string, _clientId?: string, _token?: string): Promise<void> {
  const { prefetchChannelBadges } = await import('./badgeService');
  await prefetchChannelBadges(channelId);
}

/**
 * @deprecated Badge info is now included in the UserBadgesResponse from getAllUserBadges()
 * This stub returns null to maintain backwards compatibility
 */
export function getBadgeInfo(_badgeKey: string, _channelId?: string): any | null {
  Logger.warn('[twitchBadges] getBadgeInfo() is deprecated. Use getAllUserBadges() instead');
  return null;
}

/**
 * @deprecated Badge initialization is now automatic
 */
export async function initializeBadges(_clientId: string, _token: string, channelId?: string): Promise<void> {
  Logger.warn('[twitchBadges] initializeBadges() is deprecated. Badges initialize automatically');
  // Pre-fetch channel badges if provided
  if (channelId) {
    const { prefetchChannelBadges } = await import('./badgeService');
    await prefetchChannelBadges(channelId);
  }
}

// In-memory cache for badge metadata
// Global badges come from `commands/badges.rs` (universal cache)
let globalBadgesCache: any = null;

// Channel badges are per-room-id and must be fetched separately.
// IMPORTANT: Many chat-visible badges (subscriber, bits, etc.) are channel-scoped.
const channelBadgesCache = new Map<string, any>();

/**
 * Initialize badge cache from Rust.
 *
 * This must complete BEFORE we start consuming chat messages, otherwise
 * `parseBadges()` will return `{info:null}` and ChatMessage won't render them.
 */
export async function initializeBadgeCache(channelId?: string): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');

    // ------------------------------------------------------------
    // Global badges (cached on disk via universal cache)
    // ------------------------------------------------------------
    let globalBadges = await invoke('get_cached_global_badges');

    if (!globalBadges) {
      // Not cached, fetch+cache via the non-unified badge command.
      // (The unified badge service caches in memory only, and won't populate
      // `get_cached_global_badges`.)
      Logger.debug('[BadgeCache] Global badges not cached, prefetching...');
      await invoke('prefetch_global_badges');
      globalBadges = await invoke('get_cached_global_badges');
    }

    if (globalBadges) {
      globalBadgesCache = globalBadges;
      Logger.debug('[BadgeCache] Loaded global badges into memory cache');
    } else {
      Logger.warn('[BadgeCache] Failed to load global badges even after prefetch');
    }

    // ------------------------------------------------------------
    // Channel badges (not stored in universal cache in this codepath)
    // ------------------------------------------------------------
    if (channelId) {
      try {
        // Fetch credentials + channel badges in one shot.
        const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
        const channelBadges = await invoke<any>('fetch_channel_badges', {
          channelId,
          clientId,
          token,
        });

        channelBadgesCache.set(channelId, channelBadges);
        Logger.debug('[BadgeCache] Loaded channel badges into memory cache for:', channelId);
      } catch (e) {
        Logger.warn('[BadgeCache] Failed to fetch channel badges:', e);
      }

      // Still prefetch in unified service so other codepaths (profile lookups)
      // can take advantage of the warmed in-memory cache.
      try {
        await invoke('prefetch_channel_badges_unified', { channelId });
      } catch {
        // ignore
      }
    }
  } catch (error) {
    Logger.warn('[BadgeCache] Failed to initialize badge cache:', error);
  }
}

/**
 * Legacy function for parsing badge strings
 * Enriches badges with metadata from in-memory cache
 */
export function parseBadges(badgeString: string, channelId?: string): Array<{ key: string; info: any }> {
  if (!badgeString) return [];

  return badgeString.split(',').map((badge) => {
    const [name, version] = badge.split('/');
    const key = `${name}/${version}`;

    // Look up badge info from in-memory cache (channel first, then global)
    const info = getBadgeInfoFromCache(name, version, channelId);

    return {
      key,
      info,
    };
  });
}

/**
 * Get badge info from in-memory cache (synchronous)
 */
function getBadgeInfoFromCache(setId: string, versionId: string, channelId?: string): any | null {
  // 1) Channel badges first (subscriber, bits, etc.)
  if (channelId) {
    const channelBadges = channelBadgesCache.get(channelId);
    if (channelBadges?.data) {
      for (const badgeSet of channelBadges.data) {
        if (badgeSet.set_id === setId) {
          const badgeVersion = badgeSet.versions.find((v: any) => v.id === versionId);
          if (badgeVersion) {
            return {
              image_url_1x: badgeVersion.image_url_1x,
              image_url_2x: badgeVersion.image_url_2x,
              image_url_4x: badgeVersion.image_url_4x,
              title: badgeVersion.title,
              description: badgeVersion.description,
              click_action: badgeVersion.click_action,
              click_url: badgeVersion.click_url,
            };
          }
        }
      }
    }
  }

  // 2) Global badges fallback
  if (!globalBadgesCache || !globalBadgesCache.data) return null;

  for (const badgeSet of globalBadgesCache.data) {
    if (badgeSet.set_id === setId) {
      const badgeVersion = badgeSet.versions.find((v: any) => v.id === versionId);
      if (badgeVersion) {
        return {
          image_url_1x: badgeVersion.image_url_1x,
          image_url_2x: badgeVersion.image_url_2x,
          image_url_4x: badgeVersion.image_url_4x,
          title: badgeVersion.title,
          description: badgeVersion.description,
          click_action: badgeVersion.click_action,
          click_url: badgeVersion.click_url,
        };
      }
    }
  }

  return null;
}
