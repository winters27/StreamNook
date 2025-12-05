// Service for fetching 7TV badges and paints using the v4 GraphQL API
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { SevenTVBadge, SevenTVPaint } from '../types';

// v4 GraphQL API Types
interface PaintLayer {
  id: string;
  ty: {
    __typename: string;
    // For LinearGradient
    angle?: number;
    repeating?: boolean;
    // For RadialGradient
    shape?: string;
    // For both gradients
    stops?: Array<{
      at: number;
      color: {
        hex: string;
        r: number;
        g: number;
        b: number;
        a: number;
      };
    }>;
    // For SingleColor
    color?: {
      hex: string;
      r: number;
      g: number;
      b: number;
      a: number;
    };
    // For Image
    images?: Array<{
      url: string;
      mime: string;
      size: number;
      scale: number;
      width: number;
      height: number;
      frameCount: number;
      localUrl?: string;
    }>;
  };
  opacity: number;
}

interface PaintShadow {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: {
    hex: string;
    r: number;
    g: number;
    b: number;
    a: number;
  };
}

interface PaintV4 {
  id: string;
  name: string;
  description?: string;
  data: {
    layers: PaintLayer[];
    shadows: PaintShadow[];
  };
  selected?: boolean;
}

interface BadgeV4 {
  id: string;
  name: string;
  description?: string;
  selected?: boolean;
  localUrl?: string;
}

interface UserCosmeticsResponse {
  paints: PaintV4[];
  badges: BadgeV4[];
}

// Cache for 7TV user data
const userCache = new Map<string, { data: UserCosmeticsResponse; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Cache for cosmetic file paths (id -> localPath) to avoid repeated IPC calls
let cachedCosmeticFiles: Record<string, string> | null = null;

// Track pending requests to prevent duplicate fetches
const pendingRequests = new Map<string, Promise<UserCosmeticsResponse | null>>();
let filesInitializationPromise: Promise<void> | null = null;

// GraphQL query fragments
const fullPaintQueryFields = /* GraphQL */ `
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
              __typename
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
                __typename
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
              __typename
              at
              color {
                __typename
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
              __typename
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
        __typename
        offsetX
        offsetY
        blur
        color {
          __typename
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

const fullBadgeQueryFields = /* GraphQL */ `
  {
    id
    name
    description
  }
`;

const fullUserQuery = (id: string) => /* GraphQL */ `{ 
  users {
    userByConnection(platform: TWITCH, platformId: "${id}") {
      id
      style {
        activePaint { id }
        activeBadge { id description }
      }
      inventory {
        paints {
          to {
            paint ${fullPaintQueryFields}
          }
        }
        badges {
          to {
            badge ${fullBadgeQueryFields}
          }
        }
      }
    }
  }
}`;

// Remove newlines and extra spaces from GraphQL query
const cleanQuery = (query: string): string => {
  return query.replace(/\n/g, '').replace(/\s+/g, ' ');
};

// Request GraphQL API with retry logic
const requestGql = async ({ query }: { query: string }): Promise<any> => {
  let retryCount = 0;
  while (retryCount <= 5) {
    try {
      const response = await fetch('https://7tv.io/v4/gql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: cleanQuery(query) })
      });

      if (!response.ok) {
        if (retryCount === 5) {
          return undefined;
        }
        await new Promise((r) => setTimeout(r, 500));
        retryCount++;
        continue;
      }

      const data = await response.json();
      if (data.errors || data.message) {
        if (retryCount === 5) {
          console.error('[7TV] Error fetching user cosmetics:', data.errors || data.message);
          return undefined;
        }
        await new Promise((r) => setTimeout(r, 500));
        retryCount++;
        continue;
      }

      return data;
    } catch (error) {
      if (retryCount === 5) {
        console.error('[7TV] Network error:', error);
        return undefined;
      }
      await new Promise((r) => setTimeout(r, 500));
      retryCount++;
    }
  }
  return undefined;
};

// Helper to cache 7TV cosmetics in background
async function cache7TVCosmetics(paints: PaintV4[], badges: BadgeV4[]) {
  // Load settings to check if caching is enabled and get expiry
  let expiryDays = 7; // Default to 7 days for cosmetics
  try {
    const settings = await invoke('load_settings') as any;
    if (settings.cache?.enabled === false) {
      return; // Caching disabled
    }
    expiryDays = settings.cache?.expiry_days ?? 7;
  } catch (e) {
    console.warn('[7TVService] Failed to load settings for cache config:', e);
  }

  const cacheItems: Array<{ id: string; url: string }> = [];

  // Collect badge images
  for (const badge of badges) {
    if (!badge.localUrl) {
      cacheItems.push({
        id: badge.id,
        url: `https://cdn.7tv.app/badge/${badge.id}/3x`
      });
    }
  }

  // Collect paint layer images
  for (const paint of paints) {
    for (const layer of paint.data.layers) {
      if (layer.ty.__typename === 'PaintLayerTypeImage' && layer.ty.images) {
        const isAnimated = layer.ty.images.some((img) => img.frameCount > 1);
        const img = layer.ty.images.find((i) => i.scale === 1 && (isAnimated ? i.frameCount > 1 : true));

        // Check if we already have a local URL for this layer (we check the first image's localUrl as a proxy)
        const hasLocal = layer.ty.images.some(i => !!i.localUrl);

        if (img && !hasLocal) {
          cacheItems.push({
            id: layer.id, // Use layer ID for caching paint images
            url: img.url
          });
        }
      }
    }
  }

  // Process in chunks
  const CHUNK_SIZE = 10;
  for (let i = 0; i < cacheItems.length; i += CHUNK_SIZE) {
    const chunk = cacheItems.slice(i, i + CHUNK_SIZE);
    await Promise.allSettled(chunk.map(async (item) => {
      try {
        const localPath = await invoke('download_and_cache_file', {
          cacheType: 'cosmetic',
          id: item.id,
          url: item.url,
          expiryDays
        }) as string;

        // Update local cache map if successful
        if (localPath && cachedCosmeticFiles) {
          cachedCosmeticFiles[item.id] = localPath;
        }
      } catch (e) {
        console.warn(`Failed to cache cosmetic ${item.id}:`, e);
      }
    }));
    // Small delay between chunks
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// Fetch user cosmetics from 7TV v4 API
export async function getUserCosmetics(twitchId: string): Promise<UserCosmeticsResponse | null> {
  // Check cache
  const cached = userCache.get(twitchId);
  const now = Date.now();

  if (cached && (now - cached.timestamp) < CACHE_DURATION) {
    return cached.data;
  }

  // Initialize cached files map if needed
  if (cachedCosmeticFiles === null) {
    if (filesInitializationPromise) {
      await filesInitializationPromise;
    } else {
      filesInitializationPromise = (async () => {
        try {
          cachedCosmeticFiles = await invoke('get_cached_files', { cacheType: 'cosmetic' });
        } catch (e) {
          console.warn('Failed to get cached cosmetic files:', e);
          cachedCosmeticFiles = {};
        } finally {
          filesInitializationPromise = null;
        }
      })();
      await filesInitializationPromise;
    }
  }

  const cachedFiles = cachedCosmeticFiles || {};

  // Check if there's already a pending request for this user
  const pending = pendingRequests.get(twitchId);
  if (pending) {
    return pending;
  }

  // Create new request
  const request = (async () => {
    try {
      const userData = await requestGql({ query: fullUserQuery(twitchId) });

      if (!userData?.data?.users?.userByConnection) {
        userCache.set(twitchId, {
          data: { paints: [], badges: [] },
          timestamp: now
        });
        return { paints: [], badges: [] };
      }

      const data = userData.data.users.userByConnection;
      const activePaintId = data.style?.activePaint?.id;
      const activeBadgeId = data.style?.activeBadge?.id;

      // Process paints
      const paints: PaintV4[] = [];
      for (const paint of data.inventory?.paints ?? []) {
        if (paint.to?.paint) {
          const paintData = paint.to.paint;
          if (paintData.id === activePaintId) {
            paintData.selected = true;
          }

          // Attach local URLs to image layers
          if (paintData.data?.layers) {
            for (const layer of paintData.data.layers) {
              if (layer.ty.__typename === 'PaintLayerTypeImage' && layer.ty.images) {
                const localPath = cachedFiles[layer.id];
                if (localPath) {
                  const localUrl = convertFileSrc(localPath);
                  layer.ty.images.forEach((img: any) => {
                    img.localUrl = localUrl;
                  });
                }
              }
            }
          }

          paints.push(paintData);
        }
      }

      // Process badges
      const badges: BadgeV4[] = [];
      for (const badge of data.inventory?.badges ?? []) {
        const badgeData = badge.to?.badge;
        if (!badgeData) continue;

        if (badgeData.id === activeBadgeId) {
          badgeData.selected = true;
        }

        // Attach local URL
        const localPath = cachedFiles[badgeData.id];
        if (localPath) {
          badgeData.localUrl = convertFileSrc(localPath);
        }

        badges.push(badgeData);
      }

      const result = {
        paints: paints.filter((p) => p !== null),
        badges: badges.filter((b) => b !== null)
      };

      // Trigger background caching
      cache7TVCosmetics(result.paints, result.badges).catch(e => console.error('Background cosmetic caching failed:', e));

      userCache.set(twitchId, { data: result, timestamp: now });
      return result;
    } catch (error) {
      console.error('[7TV] Failed to fetch user cosmetics:', error);
      const emptyResult = { paints: [], badges: [] };
      userCache.set(twitchId, { data: emptyResult, timestamp: now });
      return emptyResult;
    } finally {
      pendingRequests.delete(twitchId);
    }
  })();

  pendingRequests.set(twitchId, request);
  return request;
}

// Legacy function for backwards compatibility
export async function fetch7TVUserData(twitchUserId: string) {
  return getUserCosmetics(twitchUserId);
}

// Compute paint style layers
const computeLinearGradientLayer = (layer: PaintLayer['ty'], opacity: number) => {
  if (layer.__typename !== 'PaintLayerTypeLinearGradient' || !layer.stops || layer.stops.length === 0) {
    return undefined;
  }

  const prefix = layer.repeating ? 'repeating-' : '';
  const stops = layer.stops.map((stop) => `${stop.color.hex} ${stop.at * 100}%`).join(', ');
  const gradient = `${prefix}linear-gradient(${layer.angle || 0}deg, ${stops})`;

  return {
    opacity,
    image: gradient
  };
};

const computeRadialGradientLayer = (layer: PaintLayer['ty'], opacity: number) => {
  if (layer.__typename !== 'PaintLayerTypeRadialGradient' || !layer.stops || layer.stops.length === 0) {
    return undefined;
  }

  const prefix = layer.repeating ? 'repeating-' : '';
  const shape = layer.shape === 'CIRCLE' ? 'circle' : 'ellipse';
  const stops = layer.stops.map((stop) => `${stop.color.hex} ${stop.at * 100}%`).join(', ');
  const gradient = `${prefix}radial-gradient(${shape}, ${stops})`;

  return {
    opacity,
    image: gradient
  };
};

const computeImageLayer = (layer: PaintLayer['ty'], opacity: number) => {
  if (layer.__typename !== 'PaintLayerTypeImage' || !layer.images) {
    return undefined;
  }

  const isAnimated = layer.images.some((img) => img.frameCount > 1);
  const img = layer.images.find((i) => i.scale === 1 && (isAnimated ? i.frameCount > 1 : true));

  if (!img) {
    return undefined;
  }

  // Use local URL if available
  const url = img.localUrl || img.url;

  return {
    opacity,
    image: `url("${url}")`
  };
};

const computeSingleColorLayer = (layer: PaintLayer['ty'], opacity: number) => {
  if (layer.__typename !== 'PaintLayerTypeSingleColor' || !layer.color) {
    return undefined;
  }

  return {
    opacity,
    color: layer.color.hex
  };
};

const computeDropShadows = (shadows: PaintShadow[]) => {
  if (shadows.length === 0) {
    return undefined;
  }

  return shadows
    .map((s) => `drop-shadow(${s.color.hex} ${s.offsetX}px ${s.offsetY}px ${s.blur}px)`)
    .join(' ');
};

// Compute the full CSS style for a paint
export const computePaintStyle = (paint: PaintV4, userColor?: string): React.CSSProperties => {
  const layers = paint.data.layers
    .map((layer) => {
      switch (layer.ty.__typename) {
        case 'PaintLayerTypeLinearGradient':
          return computeLinearGradientLayer(layer.ty, layer.opacity);
        case 'PaintLayerTypeRadialGradient':
          return computeRadialGradientLayer(layer.ty, layer.opacity);
        case 'PaintLayerTypeImage':
          return computeImageLayer(layer.ty, layer.opacity);
        case 'PaintLayerTypeSingleColor':
          return computeSingleColorLayer(layer.ty, layer.opacity);
        default:
          return undefined;
      }
    })
    .filter((l) => l !== undefined) as Array<{ opacity: number; image?: string; color?: string }>;

  const backgroundImages = layers.flatMap((l) => (l.image ? [l.image] : []));
  const backgroundColors = layers.flatMap((l) => (l.color ? [l.color] : []));

  // Combine colors and images, with user color as fallback
  const background = [...backgroundColors, ...backgroundImages, userColor || 'var(--user-color)'].join(', ');

  const filter = computeDropShadows(paint.data.shadows);

  const opacities = layers.map((l) => l.opacity).filter((o) => o < 1);
  const minOpacity = opacities.length > 0 ? Math.min(...opacities) : 1;

  const style: React.CSSProperties = {
    background: background,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    color: 'transparent',
    display: 'inline-block', // Required for background-clip to work
    verticalAlign: 'baseline', // Prevent vertical shifting
  };

  if (filter) {
    style.filter = filter;
  }

  if (minOpacity < 1) {
    style.opacity = minOpacity;
  }

  return style;
};

// Get badge image URL (7TV v4 badges need to be fetched from CDN)
export const getBadgeImageUrl = (badge: BadgeV4): string => {
  if (badge.localUrl) {
    return badge.localUrl;
  }
  // For v4 API, badges are served from the CDN
  return `https://cdn.7tv.app/badge/${badge.id}/3x`;
};

// Get badge image URL for any provider
export const getBadgeImageUrlForProvider = (badge: any, provider: '7tv' | 'ffz'): string => {
  if (provider === '7tv') {
    if (badge.localUrl) return badge.localUrl;
    return `https://cdn.7tv.app/badge/${badge.id}/3x`;
  } else if (provider === 'ffz') {
    return badge.urls?.['4'] || badge.urls?.['2'] || badge.urls?.['1'] || badge.image;
  }
  return '';
};

export function clearUserCache() {
  userCache.clear();
  cachedCosmeticFiles = null; // Also clear the file cache so it re-fetches
}
