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
  seventvUserId?: string; // The user's 7TV profile ID
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

// GraphQL response type from Rust backend
interface GraphQLResponse {
  data?: any;
  errors?: any[];
  message?: string;
}

// Request GraphQL API with retry logic via Tauri backend (bypasses CORS)
const requestGql = async ({ query }: { query: string }): Promise<any> => {
  let retryCount = 0;
  while (retryCount <= 5) {
    try {
      const response = await invoke('seventv_graphql', { query: cleanQuery(query) }) as GraphQLResponse;

      if (response.errors || response.message) {
        if (retryCount === 5) {
          console.error('[7TV] Error fetching user cosmetics:', response.errors || response.message);
          return undefined;
        }
        await new Promise((r) => setTimeout(r, 500));
        retryCount++;
        continue;
      }

      return response;
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

// Track pending cosmetic downloads to prevent duplicates
const pendingCosmeticDownloads = new Map<string, Promise<string | null>>();

// Settings cache for cosmetics
let cosmeticCacheSettings: { enabled: boolean; expiryDays: number } | null = null;

async function getCosmeticCacheSettings(): Promise<{ enabled: boolean; expiryDays: number }> {
  if (cosmeticCacheSettings) return cosmeticCacheSettings;
  try {
    const settings = await invoke('load_settings') as any;
    cosmeticCacheSettings = {
      enabled: settings.cache?.enabled !== false,
      expiryDays: settings.cache?.expiry_days ?? 7
    };
    return cosmeticCacheSettings;
  } catch (e) {
    console.warn('[7TVService] Failed to load settings:', e);
    return { enabled: true, expiryDays: 7 };
  }
}

// Lazy download a single cosmetic on-demand
async function downloadCosmeticIfNeeded(id: string, url: string): Promise<string | null> {
  // Already cached?
  if (cachedCosmeticFiles && cachedCosmeticFiles[id]) {
    return cachedCosmeticFiles[id];
  }

  // Already downloading?
  if (pendingCosmeticDownloads.has(id)) {
    return pendingCosmeticDownloads.get(id)!;
  }

  const settings = await getCosmeticCacheSettings();
  if (!settings.enabled) return null;

  // Start download
  const downloadPromise = (async () => {
    try {
      const localPath = await invoke('download_and_cache_file', {
        cacheType: 'cosmetic',
        id,
        url,
        expiryDays: settings.expiryDays
      }) as string;

      if (localPath && cachedCosmeticFiles) {
        cachedCosmeticFiles[id] = localPath;
        return localPath;
      }
      return null;
    } catch (e) {
      console.debug(`[7TVService] Failed to cache cosmetic ${id}:`, e);
      return null;
    } finally {
      pendingCosmeticDownloads.delete(id);
    }
  })();

  pendingCosmeticDownloads.set(id, downloadPromise);
  return downloadPromise;
}

// Queue a cosmetic for lazy caching - called when actually displayed
export function queueCosmeticForCaching(id: string, url: string) {
  if ((cachedCosmeticFiles && cachedCosmeticFiles[id]) || pendingCosmeticDownloads.has(id)) {
    return;
  }
  downloadCosmeticIfNeeded(id, url).catch(() => {
    // Silent fail
  });
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
          data: { paints: [], badges: [], seventvUserId: undefined },
          timestamp: now
        });
        return { paints: [], badges: [], seventvUserId: undefined };
      }

      const data = userData.data.users.userByConnection;
      const seventvUserId = data.id; // The user's 7TV profile ID
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
        badges: badges.filter((b) => b !== null),
        seventvUserId
      };

      // NO aggressive caching here - cosmetics will be cached lazily when displayed

      userCache.set(twitchId, { data: result, timestamp: now });
      return result;
    } catch (error) {
      console.error('[7TV] Failed to fetch user cosmetics:', error);
      const emptyResult = { paints: [], badges: [], seventvUserId: undefined };
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

  // Use longhand properties to avoid React warning about mixing shorthand/longhand
  const backgroundImage = backgroundImages.length > 0 ? backgroundImages.join(', ') : undefined;
  const backgroundColor = backgroundColors.length > 0 ? backgroundColors[0] : (userColor || 'var(--user-color)');

  const filter = computeDropShadows(paint.data.shadows);

  const opacities = layers.map((l) => l.opacity).filter((o) => o < 1);
  const minOpacity = opacities.length > 0 ? Math.min(...opacities) : 1;

  const style: React.CSSProperties = {
    backgroundColor: backgroundColor,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    color: 'transparent',
  };

  // Only add backgroundImage if we have gradient/image layers
  if (backgroundImage) {
    style.backgroundImage = backgroundImage;
  }

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
  // For v4 API, badges are served from the CDN - use highest quality (4x)
  return `https://cdn.7tv.app/badge/${badge.id}/4x`;
};

// Get all resolution URLs for a 7TV badge (for srcSet)
export const getBadgeImageUrls = (badge: BadgeV4): { url1x: string; url2x: string; url3x: string; url4x: string } => {
  if (badge.localUrl) {
    // If we have a local URL, use it for all resolutions
    return { url1x: badge.localUrl, url2x: badge.localUrl, url3x: badge.localUrl, url4x: badge.localUrl };
  }
  const baseUrl = `https://cdn.7tv.app/badge/${badge.id}`;
  return {
    url1x: `${baseUrl}/1x`,
    url2x: `${baseUrl}/2x`,
    url3x: `${baseUrl}/3x`,
    url4x: `${baseUrl}/4x`,
  };
};

// Get badge URLs with fallback priority (highest to lowest resolution)
// Used when 4x may 404 - tries 3x, 2x, 1x as fallbacks
export const getBadgeFallbackUrls = (badgeId: string): string[] => {
  const baseUrl = `https://cdn.7tv.app/badge/${badgeId}`;
  return [
    `${baseUrl}/4x`,
    `${baseUrl}/3x`,
    `${baseUrl}/2x`,
    `${baseUrl}/1x`,
  ];
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
