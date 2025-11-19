// Service for fetching 7TV badges and paints using the v4 GraphQL API
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
}

interface UserCosmeticsResponse {
  paints: PaintV4[];
  badges: BadgeV4[];
}

// Cache for 7TV user data
const userCache = new Map<string, { data: UserCosmeticsResponse; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Track pending requests to prevent duplicate fetches
const pendingRequests = new Map<string, Promise<UserCosmeticsResponse | null>>();

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

// Fetch user cosmetics from 7TV v4 API
export async function getUserCosmetics(twitchId: string): Promise<UserCosmeticsResponse | null> {
  // Check cache
  const cached = userCache.get(twitchId);
  const now = Date.now();
  
  if (cached && (now - cached.timestamp) < CACHE_DURATION) {
    return cached.data;
  }
  
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
        badges.push(badgeData);
      }

      const result = {
        paints: paints.filter((p) => p !== null),
        badges: badges.filter((b) => b !== null)
      };

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

  return {
    opacity,
    image: `url("${img.url}")`
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
  // For v4 API, badges are served from the CDN
  return `https://cdn.7tv.app/badge/${badge.id}/3x`;
};

// Get badge image URL for any provider
export const getBadgeImageUrlForProvider = (badge: any, provider: '7tv' | 'ffz'): string => {
  if (provider === '7tv') {
    return `https://cdn.7tv.app/badge/${badge.id}/3x`;
  } else if (provider === 'ffz') {
    return badge.urls?.['4'] || badge.urls?.['2'] || badge.urls?.['1'] || badge.image;
  }
  return '';
};

export function clearUserCache() {
  userCache.clear();
}
