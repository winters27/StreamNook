// Service for fetching and caching Twitch badges using Helix API
interface BadgeVersion {
  id: string;
  image_url_1x: string;
  image_url_2x: string;
  image_url_4x: string;
  title: string;
  description: string;
  click_action: string | null;
  click_url: string | null;
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

/**
 * Fetch global Twitch badges (moderator, staff, partner, etc.)
 * Using Tauri backend command with Helix API
 */
export async function fetchGlobalBadges(clientId: string, token: string): Promise<void> {
  if (globalBadgesFetched) {
    console.log('[TwitchBadges] Global badges already fetched, skipping');
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
        console.log('[TwitchBadges] Loaded global badges from disk cache');
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
    
    console.log('[TwitchBadges] Received global badges response:', response);
    
    // Parse badge sets from Helix API response
    if (response.data) {
      response.data.forEach((badgeSet) => {
        badgeSet.versions.forEach((version) => {
          const key = `${badgeSet.set_id}/${version.id}`;
          globalBadgesCache.set(key, version);
        });
      });
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
        console.log('[TwitchBadges] Saved global badges to disk cache');
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
    console.log(`[TwitchBadges] Channel badges for ${channelId} already fetched, skipping`);
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
        console.log(`[TwitchBadges] Loaded channel badges from disk cache for ${channelId}`);
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
    
    console.log(`[TwitchBadges] Received channel badges response for ${channelId}:`, response);
    
    const channelCache = new Map<string, BadgeVersion>();
    
    // Parse badge sets from Helix API response
    if (response.data) {
      response.data.forEach((badgeSet) => {
        badgeSet.versions.forEach((version) => {
          const key = `${badgeSet.set_id}/${version.id}`;
          channelCache.set(key, version);
        });
      });
    }

    channelBadgesCache.set(channelId, channelCache);
    console.log(`[TwitchBadges] Loaded ${channelCache.size} channel badge versions for ${channelId}`);
    
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
        console.log(`[TwitchBadges] Saved channel badges to disk cache for ${channelId}`);
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
        console.warn(`[TwitchBadges] Badge not found: ${key} (channel: ${channelId || 'none'})`);
      }
      // If badge info not found, skip it rather than showing broken images
      // The badge data should be fetched before parsing messages
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
}
