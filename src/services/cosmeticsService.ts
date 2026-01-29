// Unified service for fetching user cosmetics from multiple providers (7TV, FFZ, BTTV)
import { invoke } from '@tauri-apps/api/core';

import { Logger } from '../utils/logger';
// 7TV Types
interface Paint7TV {
  id: string;
  name: string;
  description?: string;
  data: {
    layers: Array<{
      id: string;
      ty: {
        __typename: string;
        angle?: number;
        repeating?: boolean;
        shape?: string;
        stops?: Array<{
          at: number;
          color: { hex: string; r: number; g: number; b: number; a: number };
        }>;
        color?: { hex: string; r: number; g: number; b: number; a: number };
        images?: Array<{
          url: string;
          mime: string;
          size: number;
          scale: number;
          width: number;
          height: number;
          frameCount: number;
        }>;
      };
      opacity: number;
    }>;
    shadows: Array<{
      offsetX: number;
      offsetY: number;
      blur: number;
      color: { hex: string; r: number; g: number; b: number; a: number };
    }>;
  };
  selected?: boolean;
}

interface Badge7TV {
  id: string;
  name: string;
  description?: string;
  selected?: boolean;
}

// FFZ Types
interface BadgeFFZ {
  id: string;
  name: string;
  title: string;
  slot: number;
  replaces?: string;
  color: string;
  image: string;
  urls: {
    '1': string;
    '2': string;
    '4': string;
  };
}

// Unified Types
export interface UserCosmetics {
  userId: string;
  username: string;
  providers: {
    '7tv': {
      paints: Paint7TV[];
      badges: Badge7TV[];
    };
    ffz: {
      badges: BadgeFFZ[];
    };
  };
  fetchedAt: number;
}

// Memory cache
const cosmeticsCache = new Map<string, { data: UserCosmetics; timestamp: number }>();
const MEMORY_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Persistent cache via Tauri
const DISK_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// 7TV GraphQL queries
const full7TVPaintQueryFields = /* GraphQL */ `
  {
    id
    name
    description
    data {
      layers {
        id
        ty {
          ... on PaintLayerTypeImage {
            __typename
            images {
              url
              mime
              size
              scale
              width
              height
              frameCount
            }
          }
          ... on PaintLayerTypeRadialGradient {
            __typename
            repeating
            shape
            stops {
              at
              color {
                hex
                r
                g
                b
                a
              }
            }
          }
          ... on PaintLayerTypeLinearGradient {
            __typename
            angle
            repeating
            stops {
              at
              color {
                hex
                r
                g
                b
                a
              }
            }
          }
          ... on PaintLayerTypeSingleColor {
            __typename
            color {
              hex
              r
              g
              b
              a
            }
          }
        }
        opacity
      }
      shadows {
        offsetX
        offsetY
        blur
        color {
          hex
          r
          g
          b
          a
        }
      }
    }
  }
`;

const full7TVBadgeQueryFields = /* GraphQL */ `
  {
    id
    name
    description
  }
`;

const full7TVUserQuery = (id: string) => /* GraphQL */ `{ 
  users {
    userByConnection(platform: TWITCH, platformId: "${id}") {
      id
      username
      style {
        activePaint { id }
        activeBadge { id }
      }
      inventory {
        paints {
          to {
            paint ${full7TVPaintQueryFields}
          }
        }
        badges {
          to {
            badge ${full7TVBadgeQueryFields}
          }
        }
      }
    }
  }
}`;

const cleanQuery = (query: string): string => {
  return query.replace(/\n/g, '').replace(/\s+/g, ' ');
};

// Fetch 7TV cosmetics
async function fetch7TVCosmetics(twitchUserId: string): Promise<{ paints: Paint7TV[]; badges: Badge7TV[] }> {
  try {
    const response = await fetch('https://7tv.io/v4/gql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: cleanQuery(full7TVUserQuery(twitchUserId)) })
    });

    if (!response.ok) {
      return { paints: [], badges: [] };
    }

    const data = await response.json();
    
    if (!data?.data?.users?.userByConnection) {
      return { paints: [], badges: [] };
    }

    const userData = data.data.users.userByConnection;
    const activePaintId = userData.style?.activePaint?.id;
    const activeBadgeId = userData.style?.activeBadge?.id;

    const paints: Paint7TV[] = [];
    for (const paint of userData.inventory?.paints ?? []) {
      if (paint.to?.paint) {
        const paintData = paint.to.paint;
        if (paintData.id === activePaintId) {
          paintData.selected = true;
        }
        paints.push(paintData);
      }
    }

    const badges: Badge7TV[] = [];
    for (const badge of userData.inventory?.badges ?? []) {
      const badgeData = badge.to?.badge;
      if (!badgeData) continue;

      if (badgeData.id === activeBadgeId) {
        badgeData.selected = true;
      }
      badges.push(badgeData);
    }

    return {
      paints: paints.filter((p) => p !== null),
      badges: badges.filter((b) => b !== null)
    };
  } catch (error) {
    Logger.error('[7TV] Failed to fetch cosmetics:', error);
    return { paints: [], badges: [] };
  }
}

// Fetch FFZ badges
async function fetchFFZBadges(_twitchUserId: string, username: string): Promise<BadgeFFZ[]> {
  try {
    // FFZ badges are fetched from the user endpoint
    const response = await fetch(`https://api.frankerfacez.com/v1/user/${username}`);
    
    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    
    if (!data.user?.badges) {
      return [];
    }

    const badges: BadgeFFZ[] = [];
    
    for (const badgeId of data.user.badges) {
      // Fetch badge details from FFZ badges endpoint
      try {
        const badgeResponse = await fetch(`https://api.frankerfacez.com/v1/badge/${badgeId}`);
        if (badgeResponse.ok) {
          const badgeData = await badgeResponse.json();
          if (badgeData.badge) {
            badges.push(badgeData.badge);
          }
        }
      } catch (err) {
        Logger.warn(`[FFZ] Failed to fetch badge ${badgeId}:`, err);
      }
    }

    return badges;
  } catch (error) {
    Logger.error('[FFZ] Failed to fetch badges:', error);
    return [];
  }
}

// Load from persistent cache
async function loadFromDiskCache(userId: string): Promise<UserCosmetics | null> {
  try {
    const cached = await invoke<string | null>('load_cosmetics_cache', { userId });
    
    if (!cached) {
      return null;
    }

    const data: UserCosmetics = JSON.parse(cached);
    
    // Check if cache is still valid
    const age = Date.now() - data.fetchedAt;
    if (age > DISK_CACHE_DURATION) {
      return null;
    }

    return data;
  } catch (error) {
    Logger.warn('[Cosmetics] Failed to load disk cache:', error);
    return null;
  }
}

// Save to persistent cache
async function saveToDiskCache(cosmetics: UserCosmetics): Promise<void> {
  try {
    await invoke('save_cosmetics_cache', {
      userId: cosmetics.userId,
      data: JSON.stringify(cosmetics)
    });
  } catch (error) {
    Logger.warn('[Cosmetics] Failed to save disk cache:', error);
  }
}

// Main fetch function with caching
export async function fetchUserCosmetics(twitchUserId: string, username: string): Promise<UserCosmetics> {
  // Check memory cache
  const memCached = cosmeticsCache.get(twitchUserId);
  const now = Date.now();
  
  if (memCached && (now - memCached.timestamp) < MEMORY_CACHE_DURATION) {
    return memCached.data;
  }

  // Check disk cache
  const diskCached = await loadFromDiskCache(twitchUserId);
  if (diskCached) {
    // Update memory cache
    cosmeticsCache.set(twitchUserId, { data: diskCached, timestamp: now });
    return diskCached;
  }

  // Fetch fresh data from all providers
  const [seventv, ffzBadges] = await Promise.all([
    fetch7TVCosmetics(twitchUserId),
    fetchFFZBadges(twitchUserId, username)
  ]);

  const cosmetics: UserCosmetics = {
    userId: twitchUserId,
    username,
    providers: {
      '7tv': seventv,
      ffz: {
        badges: ffzBadges
      }
    },
    fetchedAt: now
  };

  // Save to caches
  cosmeticsCache.set(twitchUserId, { data: cosmetics, timestamp: now });
  await saveToDiskCache(cosmetics);

  return cosmetics;
}

// Get selected paint from cosmetics
export function getSelectedPaint(cosmetics: UserCosmetics): Paint7TV | null {
  return cosmetics.providers['7tv'].paints.find((p) => p.selected) || null;
}

// Get selected badge from cosmetics
export function getSelectedBadge(cosmetics: UserCosmetics): Badge7TV | null {
  return cosmetics.providers['7tv'].badges.find((b) => b.selected) || null;
}

// Get all badges (7TV + FFZ)
export function getAllBadges(cosmetics: UserCosmetics): Array<{ provider: '7tv' | 'ffz'; badge: any }> {
  const badges: Array<{ provider: '7tv' | 'ffz'; badge: any }> = [];
  
  // Add 7TV badges
  for (const badge of cosmetics.providers['7tv'].badges) {
    badges.push({ provider: '7tv', badge });
  }
  
  // Add FFZ badges
  for (const badge of cosmetics.providers.ffz.badges) {
    badges.push({ provider: 'ffz', badge });
  }
  
  return badges;
}

// Clear memory cache
export function clearCosmeticsCache() {
  cosmeticsCache.clear();
}

// Export types
export type { Paint7TV, Badge7TV, BadgeFFZ };
