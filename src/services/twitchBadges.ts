// Service for fetching and caching Twitch badges using Helix API
import { invoke } from '@tauri-apps/api/core';

interface BadgeVersion {
  id: string;
  image_url_1x: string;
  image_url_2x: string;
  image_url_4x: string;
  title: string;
  description: string;
  click_action: string | null;
  click_url: string | null;
  localUrl?: string;
}

interface BadgeSet {
  set_id: string;
  versions: BadgeVersion[];
}

interface HelixBadgesResponse {
  data: BadgeSet[];
}

// Cache for badge data
const globalBadgesCache: Map<string, BadgeVersion> = new Map();
const channelBadgesCache: Map<string, Map<string, BadgeVersion>> = new Map();
let globalBadgesFetched = false;

// Track which badges we've already warned about to avoid spam
const warnedBadges = new Set<string>();



/**
 * Fetch global Twitch badges (moderator, staff, partner, etc.)
 * Using Tauri backend command with Helix API
 */
export async function fetchGlobalBadges(clientId: string, token: string): Promise<void> {
  if (globalBadgesFetched) {
    return;
  }

  // Try to load from disk cache if enabled
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const settings = await invoke('load_settings') as any;

    if (settings.cache?.enabled) {
      const cachedData = await invoke('load_badges_from_cache', {
        cacheType: 'global',
        channelId: null
      }) as string | null;

      if (cachedData) {
        const badgeData = JSON.parse(cachedData) as Array<[string, BadgeVersion]>;
        badgeData.forEach(([key, version]) => {
          globalBadgesCache.set(key, version);
        });
        globalBadgesFetched = true;
        console.log(`[TwitchBadges] Loaded ${globalBadgesCache.size} global badge versions from cache`);
        return;
      }
    }
  } catch (e) {
    console.warn('[TwitchBadges] Failed to load global badges from cache:', e);
  }

  console.log('[TwitchBadges] Fetching global badges...');
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const response = await invoke<HelixBadgesResponse>('fetch_global_badges', {
      clientId,
      token,
    });

    // Parse badge sets from Helix API response
    if (response.data) {
      // Get cached files first
      let cachedFiles: Record<string, string> = {};
      try {
        cachedFiles = await invoke('get_cached_files', { cacheType: 'badge' });
      } catch (e) {
        console.warn('[TwitchBadges] Failed to get cached badge files:', e);
      }

      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const itemsToCache: Array<{ id: string; url: string; localUrl?: string }> = [];

      response.data.forEach((badgeSet) => {
        badgeSet.versions.forEach((version) => {
          const key = `${badgeSet.set_id}/${version.id}`;

          // Use twitch-global- prefix to prevent collision with channel-specific badges
          const cacheId = `twitch-global-${badgeSet.set_id}-${version.id}`;
          const localPath = cachedFiles[cacheId];

          if (localPath) {
            version.localUrl = convertFileSrc(localPath);
          }

          globalBadgesCache.set(key, version);
          itemsToCache.push({
            id: cacheId,
            url: version.image_url_4x,
            localUrl: version.localUrl
          });
        });
      });

      // Trigger background caching with properly prefixed IDs
      cacheBadgeImages(itemsToCache);
    }

    globalBadgesFetched = true;
    console.log(`[TwitchBadges] Loaded ${globalBadgesCache.size} global badge versions`);

    // Save to disk cache if enabled
    try {
      const settings = await invoke('load_settings') as any;

      if (settings.cache?.enabled) {
        const expiryDays = settings.cache?.expiry_days || 7;
        const badgeData = Array.from(globalBadgesCache.entries());
        await invoke('save_badges_to_cache', {
          cacheType: 'global',
          channelId: null,
          data: JSON.stringify(badgeData),
          expiryDays
        });
      }
    } catch (e) {
      console.warn('[TwitchBadges] Failed to save global badges to cache:', e);
    }
  } catch (error) {
    console.error('[TwitchBadges] Error fetching global badges:', error);
    globalBadgesFetched = true;
  }
}

/**
 * Fetch channel-specific badges (subscriber badges, bits badges, etc.)
 * Using Tauri backend command with Helix API
 */
export async function fetchChannelBadges(
  channelId: string,
  clientId: string,
  token: string
): Promise<void> {
  if (channelBadgesCache.has(channelId)) {
    return;
  }

  // Try to load from disk cache if enabled
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const settings = await invoke('load_settings') as any;

    if (settings.cache?.enabled) {
      const cachedData = await invoke('load_badges_from_cache', {
        cacheType: 'channel',
        channelId
      }) as string | null;

      if (cachedData) {
        const badgeData = JSON.parse(cachedData) as Array<[string, BadgeVersion]>;
        const channelCache = new Map<string, BadgeVersion>();
        badgeData.forEach(([key, version]) => {
          channelCache.set(key, version);
        });
        channelBadgesCache.set(channelId, channelCache);
        console.log(`[TwitchBadges] Loaded ${channelCache.size} channel badge versions from cache for ${channelId}`);
        return;
      }
    }
  } catch (e) {
    console.warn(`[TwitchBadges] Failed to load channel badges from cache for ${channelId}:`, e);
  }

  console.log(`[TwitchBadges] Fetching channel badges for ${channelId}...`);
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const response = await invoke<HelixBadgesResponse>('fetch_channel_badges', {
      channelId,
      clientId,
      token,
    });

    const channelCache = new Map<string, BadgeVersion>();

    // Parse badge sets from Helix API response
    if (response.data) {
      // Get cached files first
      let cachedFiles: Record<string, string> = {};
      try {
        cachedFiles = await invoke('get_cached_files', { cacheType: 'badge' });
      } catch (e) {
        console.warn('[TwitchBadges] Failed to get cached badge files:', e);
      }

      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const itemsToCache: Array<{ id: string; url: string; localUrl?: string }> = [];

      response.data.forEach((badgeSet) => {
        badgeSet.versions.forEach((version) => {
          const key = `${badgeSet.set_id}/${version.id}`;

          // Use twitch-${channelId}- prefix to prevent collision between channels
          const cacheId = `twitch-${channelId}-${badgeSet.set_id}-${version.id}`;
          const localPath = cachedFiles[cacheId];

          if (localPath) {
            version.localUrl = convertFileSrc(localPath);
          }

          channelCache.set(key, version);
          itemsToCache.push({
            id: cacheId,
            url: version.image_url_4x,
            localUrl: version.localUrl
          });
        });
      });

      // Trigger background caching with channel-prefixed IDs
      cacheBadgeImages(itemsToCache);
    }

    channelBadgesCache.set(channelId, channelCache);

    // Log subscriber badges specifically for debugging
    const subscriberKeys = Array.from(channelCache.keys()).filter(k => k.startsWith('subscriber'));
    console.log(`[TwitchBadges] Loaded ${channelCache.size} channel badge versions for ${channelId}`);
    console.log(`[TwitchBadges] Channel ${channelId} subscriber badge versions:`, subscriberKeys);

    // Log sample subscriber badge details
    if (subscriberKeys.length > 0) {
      const sampleKey = subscriberKeys[0];
      const sampleBadge = channelCache.get(sampleKey);
      console.log(`[TwitchBadges] Sample subscriber badge (${sampleKey}):`, {
        title: sampleBadge?.title,
        image_url_1x: sampleBadge?.image_url_1x,
        image_url_4x: sampleBadge?.image_url_4x
      });
    }

    // Save to disk cache if enabled
    try {
      const settings = await invoke('load_settings') as any;

      if (settings.cache?.enabled) {
        const expiryDays = settings.cache?.expiry_days || 7;
        const badgeData = Array.from(channelCache.entries());
        await invoke('save_badges_to_cache', {
          cacheType: 'channel',
          channelId,
          data: JSON.stringify(badgeData),
          expiryDays
        });
      }
    } catch (e) {
      console.warn(`[TwitchBadges] Failed to save channel badges to cache for ${channelId}:`, e);
    }
  } catch (error) {
    console.error(`[TwitchBadges] Error fetching channel badges for ${channelId}:`, error);
    channelBadgesCache.set(channelId, new Map());
  }
}

/**
 * Get badge information for a specific badge
 */
export function getBadgeInfo(badgeKey: string, channelId?: string): BadgeVersion | null {
  // Check channel-specific badges first
  if (channelId) {
    const channelCache = channelBadgesCache.get(channelId);
    if (channelCache?.has(badgeKey)) {
      return channelCache.get(badgeKey)!;
    }
  }

  // Fall back to global badges
  if (globalBadgesCache.has(badgeKey)) {
    return globalBadgesCache.get(badgeKey)!;
  }

  return null;
}

/**
 * Parse badge string from IRC tags and return badge information
 */
export function parseBadges(badgeString: string, channelId?: string): Array<{ key: string; info: BadgeVersion }> {
  if (!badgeString) return [];

  const badges: Array<{ key: string; info: BadgeVersion }> = [];

  badgeString.split(',').forEach(badge => {
    const [name, version] = badge.split('/');
    if (name && version) {
      const key = `${name}/${version}`;
      const info = getBadgeInfo(key, channelId);

      if (info) {
        badges.push({ key, info });
      } else {
        // Only warn once per unique badge key to avoid spam
        const warnKey = `${channelId || 'global'}-${key}`;
        if (!warnedBadges.has(warnKey)) {
          warnedBadges.add(warnKey);
          const channelCache = channelId ? channelBadgesCache.get(channelId) : null;
          console.warn(`[TwitchBadges] Badge NOT FOUND: "${key}" (channel: ${channelId || 'none'})`);
          console.log(`[TwitchBadges] Channel cache has subscriber keys:`, channelCache ? Array.from(channelCache.keys()).filter(k => k.startsWith('subscriber')).slice(0, 15) : 'no cache');
        }
      }
    }
  });

  return badges;
}

/**
 * Initialize badge caches
 * Requires Twitch Client ID and access token for authentication
 */
export async function initializeBadges(
  clientId: string,
  token: string,
  channelId?: string
): Promise<void> {
  await fetchGlobalBadges(clientId, token);
  if (channelId) {
    await fetchChannelBadges(channelId, clientId, token);
  }
}

/**
 * Clear all badge caches
 */
export function clearBadgeCache(): void {
  globalBadgesCache.clear();
  channelBadgesCache.clear();
  globalBadgesFetched = false;
  warnedBadges.clear();
}

/**
 * Helper to cache badge images with proper IDs
 * @param items - Array of items to cache with id and url
 */
async function cacheBadgeImages(items: Array<{ id: string; url: string; localUrl?: string }>) {
  const { invoke } = await import('@tauri-apps/api/core');

  // Load settings to check if caching is enabled and get expiry
  let expiryDays = 0; // Default to never expire for badges if settings fail
  try {
    const settings = await invoke('load_settings') as any;
    if (settings.cache?.enabled === false) {
      return; // Caching disabled
    }
    // Use configured expiry or default to 0 (permanent) for badges if not specified
    expiryDays = settings.cache?.expiry_days ?? 0;
  } catch (e) {
    console.warn('[TwitchBadges] Failed to load settings for cache config:', e);
  }

  // Process in chunks
  const CHUNK_SIZE = 10;
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    await Promise.allSettled(chunk.map(async (item) => {
      try {
        if (item.localUrl) return;

        await invoke('download_and_cache_file', {
          cacheType: 'badge',
          id: item.id,
          url: item.url,
          expiryDays
        });
      } catch (e) {
        // Silently ignore cache errors
      }
    }));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
