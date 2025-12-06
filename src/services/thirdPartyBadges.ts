// Service for fetching badges from third-party providers (FFZ, Chatterino, Homies, etc.)
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';

export interface ThirdPartyBadge {
  id: string;
  provider: 'ffz' | 'chatterino' | 'homies';
  title: string;
  imageUrl: string;
  link?: string;
  localUrl?: string;
}

// ============================================================================
// GLOBAL BADGE DATABASE CACHES
// These APIs return ALL badge assignments for ALL users in a single response.
// We fetch them ONCE and cache globally, then look up individual users from the cache.
// ============================================================================

interface FFZBadgeData {
  badges: any[];
  users: Record<string, number[]>;
  timestamp: number;
}

interface ChatterinoBadgeData {
  badges: any[];
  timestamp: number;
}

interface HomiesBadgeData {
  badges: any[];
  timestamp: number;
}

// Global caches for badge databases
let ffzBadgeCache: FFZBadgeData | null = null;
let chatterinoBadgeCache: ChatterinoBadgeData | null = null;
let homiesBadgeCache: HomiesBadgeData | null = null;

// Cache duration: 10 minutes for memory cache (in milliseconds)
const BADGE_CACHE_DURATION = 10 * 60 * 1000;

// Fetch locks to prevent concurrent requests
let ffzFetchPromise: Promise<FFZBadgeData | null> | null = null;
let chatterinoFetchPromise: Promise<ChatterinoBadgeData | null> | null = null;
let homiesFetchPromise: Promise<HomiesBadgeData | null> | null = null;

// Helper to cache third-party badge IMAGES in background (lazy caching)
async function cacheThirdPartyBadgeImages(badges: ThirdPartyBadge[]) {
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
    console.warn('[ThirdPartyBadges] Failed to load settings for cache config:', e);
  }

  // Process in chunks
  const CHUNK_SIZE = 10;
  for (let i = 0; i < badges.length; i += CHUNK_SIZE) {
    const chunk = badges.slice(i, i + CHUNK_SIZE);
    await Promise.allSettled(chunk.map(async (badge) => {
      try {
        if (badge.localUrl) return;

        await invoke('download_and_cache_file', {
          cacheType: 'third-party-badge',
          id: badge.id,
          url: badge.imageUrl,
          expiryDays
        });
      } catch (e) {
        console.warn(`Failed to cache third-party badge ${badge.id}:`, e);
      }
    }));
    // Small delay between chunks
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// ============================================================================
// FFZ BADGE FETCHING
// ============================================================================

async function fetchFFZBadgeDatabase(): Promise<FFZBadgeData | null> {
  try {
    const response = await fetch('https://api.frankerfacez.com/v1/badges/ids');
    if (!response.ok) {
      console.warn('[FFZ Badges] Failed to fetch badge database:', response.status);
      return null;
    }

    const data = await response.json();
    return {
      badges: data.badges || [],
      users: data.users || {},
      timestamp: Date.now()
    };
  } catch (error) {
    console.error('[FFZ Badges] Failed to fetch badge database:', error);
    return null;
  }
}

async function getFFZBadgeDatabase(): Promise<FFZBadgeData | null> {
  const now = Date.now();

  // Return memory cached data if valid
  if (ffzBadgeCache && (now - ffzBadgeCache.timestamp) < BADGE_CACHE_DURATION) {
    return ffzBadgeCache;
  }

  // If a fetch is already in progress, wait for it
  if (ffzFetchPromise) {
    return ffzFetchPromise;
  }

  // Start a new fetch from API
  ffzFetchPromise = fetchFFZBadgeDatabase().then(data => {
    if (data) {
      ffzBadgeCache = data;
      console.log('[FFZ Badges] Badge database cached with', Object.keys(data.users).length, 'user entries');
    }
    ffzFetchPromise = null;
    return data;
  }).catch(err => {
    console.error('[FFZ Badges] Failed to fetch:', err);
    ffzFetchPromise = null;
    return ffzBadgeCache; // Return stale cache if available
  });

  return ffzFetchPromise;
}

// FrankerFaceZ Badges - lookup from cached global database
export async function getFFZBadges(userId: string): Promise<ThirdPartyBadge[]> {
  const badgeDb = await getFFZBadgeDatabase();
  if (!badgeDb) return [];

  const badges: ThirdPartyBadge[] = [];

  // Check if user has any FFZ badges
  if (badgeDb.users && badgeDb.users[userId]) {
    const userBadgeIds = badgeDb.users[userId];

    for (const badgeId of userBadgeIds) {
      const badgeInfo = badgeDb.badges?.find((b: any) => b.id === badgeId);
      if (badgeInfo) {
        // Get the highest resolution image
        const imageUrl = badgeInfo.urls?.['4'] || badgeInfo.urls?.['2'] || badgeInfo.urls?.['1'];

        if (imageUrl) {
          badges.push({
            id: `ffz-${badgeId}`,
            provider: 'ffz',
            title: badgeInfo.title || badgeInfo.name || `FFZ Badge ${badgeId}`,
            imageUrl: imageUrl,
            link: `https://www.frankerfacez.com/badges`
          });
        }
      }
    }
  }

  return badges;
}

// ============================================================================
// CHATTERINO BADGE FETCHING
// ============================================================================

async function fetchChatterinoBadgeDatabase(): Promise<ChatterinoBadgeData | null> {
  try {
    const response = await fetch('https://api.chatterino.com/badges');
    if (!response.ok) {
      console.warn('[Chatterino Badges] Failed to fetch badge database:', response.status);
      return null;
    }

    const data = await response.json();
    return {
      badges: data.badges || [],
      timestamp: Date.now()
    };
  } catch (error) {
    console.error('[Chatterino Badges] Failed to fetch badge database:', error);
    return null;
  }
}

async function getChatterinoBadgeDatabase(): Promise<ChatterinoBadgeData | null> {
  const now = Date.now();

  // Return memory cached data if valid
  if (chatterinoBadgeCache && (now - chatterinoBadgeCache.timestamp) < BADGE_CACHE_DURATION) {
    return chatterinoBadgeCache;
  }

  // If a fetch is already in progress, wait for it
  if (chatterinoFetchPromise) {
    return chatterinoFetchPromise;
  }

  // Start a new fetch from API
  chatterinoFetchPromise = fetchChatterinoBadgeDatabase().then(data => {
    if (data) {
      chatterinoBadgeCache = data;
      console.log('[Chatterino Badges] Badge database cached with', data.badges.length, 'badge types');
    }
    chatterinoFetchPromise = null;
    return data;
  }).catch(err => {
    console.error('[Chatterino Badges] Failed to fetch:', err);
    chatterinoFetchPromise = null;
    return chatterinoBadgeCache; // Return stale cache if available
  });

  return chatterinoFetchPromise;
}

// Chatterino Badges - lookup from cached global database
export async function getChatterinoBadges(userId: string): Promise<ThirdPartyBadge[]> {
  const badgeDb = await getChatterinoBadgeDatabase();
  if (!badgeDb) return [];

  const badges: ThirdPartyBadge[] = [];

  // Check if user has any Chatterino badges
  for (const badge of badgeDb.badges) {
    if (badge.users && badge.users.includes(userId)) {
      badges.push({
        id: `chatterino-${badge.tooltip}`,
        provider: 'chatterino',
        title: badge.tooltip || 'Chatterino Badge',
        imageUrl: badge.image3 || badge.image2 || badge.image1,
        link: 'https://chatterino.com/'
      });
    }
  }

  return badges;
}

// ============================================================================
// HOMIES BADGE FETCHING
// ============================================================================

async function fetchHomiesBadgeDatabase(): Promise<HomiesBadgeData | null> {
  try {
    // Fetch both badge sources
    const [badges1Response, badges2Response] = await Promise.all([
      fetch('https://itzalex.github.io/badges').catch(() => null),
      fetch('https://itzalex.github.io/badges2').catch(() => null)
    ]);

    let allBadges: any[] = [];

    // Merge badge data from both sources
    if (badges1Response?.ok) {
      const data1 = await badges1Response.json();
      allBadges = data1.badges || [];
    }

    if (badges2Response?.ok) {
      const data2 = await badges2Response.json();
      const badges2 = data2.badges || [];

      // Merge badges, avoiding duplicates
      badges2.forEach((badge: any) => {
        const existing = allBadges.find((b) => b.tooltip === badge.tooltip);
        if (existing) {
          if (badge.users && badge.users.length) {
            existing.users = [...(existing.users || []), ...badge.users];
          }
        } else {
          allBadges.push(badge);
        }
      });
    }

    return {
      badges: allBadges,
      timestamp: Date.now()
    };
  } catch (error) {
    console.error('[Homies Badges] Failed to fetch badge database:', error);
    return null;
  }
}

async function getHomiesBadgeDatabase(): Promise<HomiesBadgeData | null> {
  const now = Date.now();

  // Return memory cached data if valid
  if (homiesBadgeCache && (now - homiesBadgeCache.timestamp) < BADGE_CACHE_DURATION) {
    return homiesBadgeCache;
  }

  // If a fetch is already in progress, wait for it
  if (homiesFetchPromise) {
    return homiesFetchPromise;
  }

  // Start a new fetch from API
  homiesFetchPromise = fetchHomiesBadgeDatabase().then(data => {
    if (data) {
      homiesBadgeCache = data;
      console.log('[Homies Badges] Badge database cached with', data.badges.length, 'badge types');
    }
    homiesFetchPromise = null;
    return data;
  }).catch(err => {
    console.error('[Homies Badges] Failed to fetch:', err);
    homiesFetchPromise = null;
    return homiesBadgeCache; // Return stale cache if available
  });

  return homiesFetchPromise;
}

// Homies Badges - lookup from cached global database
export async function getHomiesBadges(userId: string): Promise<ThirdPartyBadge[]> {
  const badgeDb = await getHomiesBadgeDatabase();
  if (!badgeDb) return [];

  const userBadges: ThirdPartyBadge[] = [];

  // Find badges for this user
  for (const badge of badgeDb.badges) {
    if (badge.users && badge.users.includes(userId)) {
      userBadges.push({
        id: `homies-${badge.tooltip}`,
        provider: 'homies',
        title: badge.tooltip || 'Homies Badge',
        imageUrl: badge.image3 || badge.image2 || badge.image1,
        link: 'https://chatterinohomies.com/'
      });
    }
  }

  return userBadges;
}

// ============================================================================
// PUBLIC API
// ============================================================================

// Get all third-party badges for a user
export async function getAllThirdPartyBadges(userId: string): Promise<ThirdPartyBadge[]> {
  try {
    const [ffzBadges, chatterinoBadges, homiesBadges] = await Promise.all([
      getFFZBadges(userId),
      getChatterinoBadges(userId),
      getHomiesBadges(userId)
    ]);

    const allBadges = [...ffzBadges, ...chatterinoBadges, ...homiesBadges];

    // Fetch cached files map
    let cachedFiles: Record<string, string> = {};
    try {
      cachedFiles = await invoke('get_cached_files', { cacheType: 'third-party-badge' });
    } catch (e) {
      console.warn('Failed to get cached third-party badge files:', e);
    }

    // Attach local URLs
    const badgesWithCache = allBadges.map(badge => {
      const localPath = cachedFiles[badge.id];
      return {
        ...badge,
        localUrl: localPath ? convertFileSrc(localPath) : undefined
      };
    });

    // Trigger background caching for badges without local URLs
    const badgesToCache = badgesWithCache.filter(b => !b.localUrl);
    if (badgesToCache.length > 0) {
      cacheThirdPartyBadgeImages(badgesToCache).catch(e =>
        console.error('Background third-party badge caching failed:', e)
      );
    }

    return badgesWithCache;
  } catch (error) {
    console.error('[Third Party Badges] Failed to fetch all badges:', error);
    return [];
  }
}

// Pre-warm the global badge caches (call on app startup or channel join)
export async function preloadThirdPartyBadgeDatabases(): Promise<void> {
  console.log('[ThirdPartyBadges] Pre-warming global badge databases...');
  await Promise.all([
    getFFZBadgeDatabase(),
    getChatterinoBadgeDatabase(),
    getHomiesBadgeDatabase()
  ]);
  console.log('[ThirdPartyBadges] Badge databases ready');
}

// Clear all caches (useful for testing or manual refresh)
export function clearThirdPartyBadgeCaches(): void {
  ffzBadgeCache = null;
  chatterinoBadgeCache = null;
  homiesBadgeCache = null;
  console.log('[ThirdPartyBadges] All caches cleared');
}
