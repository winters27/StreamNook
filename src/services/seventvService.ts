// Service for fetching 7TV badges and paints using the v4 GraphQL API
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { SevenTVBadge, SevenTVPaint } from '../types';

import { Logger } from '../utils/logger';
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

interface BadgeImageV4 {
  url: string;
  mime?: string;
  scale?: number;
  frameCount?: number;
}

interface BadgeV4 {
  id: string;
  name: string;
  description?: string;
  selected?: boolean;
  localUrl?: string;
  // Authoritative image URLs from the V4 API. A badge's id is NOT its image id
  // in V4, so these must be used rather than constructing a URL from `id`.
  images?: BadgeImageV4[];
}

interface UserCosmeticsResponse {
  paints: PaintV4[];
  badges: BadgeV4[];
  seventvUserId?: string; // The user's 7TV profile ID
}

// Cache for 7TV user data.
//   - Successful lookups (user is on 7TV, with or without inventory; or user
//     genuinely not on 7TV) ride the full TTL — they're stable answers.
//   - Hard failures (network error, 5xx, retry-exhausted) get a much shorter
//     TTL so a transient 7TV blip can't strand a real user without a paint
//     for 5 minutes. The next request retries.
const userCache = new Map<string, { data: UserCosmeticsResponse; hardFail: boolean; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000;
const HARD_FAIL_CACHE_DURATION = 30 * 1000;

// Public result shape for getUserCosmetics. hardFail distinguishes "we never
// got a real answer from 7TV" from "API said this user has no cosmetics."
// Callers (cosmeticsCache.ts) use this to decide whether to short-TTL the
// outer cache too.
export interface UserCosmeticsResult {
  data: UserCosmeticsResponse;
  hardFail: boolean;
}

// Cache for cosmetic file paths (id -> localPath) to avoid repeated IPC calls
let cachedCosmeticFiles: Record<string, string> | null = null;

// Track pending requests to prevent duplicate fetches
const pendingRequests = new Map<string, Promise<UserCosmeticsResult>>();
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
    images {
      url
      mime
      scale
      frameCount
    }
  }
`;

// Field selection for `userByConnection`. Reused by the batched drain to build
// aliased multi-user queries.
const fullUserSelection = /* GraphQL */ `{
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
        // [7TV-diag] Surface the real error on EVERY attempt (it was only logged
        // after 5 retries) to confirm whether MultiChat load makes 7TV reject or
        // rate-limit the core app's cosmetic queries. Temporary diagnostic.
        Logger.warn(`[7TV-diag] gql error (attempt ${retryCount}):`, response.message || response.errors);
        if (retryCount === 5) {
          Logger.error('[7TV] Error fetching user cosmetics:', response.errors || response.message);
          return undefined;
        }
        await new Promise((r) => setTimeout(r, 500));
        retryCount++;
        continue;
      }

      return response;
    } catch (error) {
      if (retryCount === 5) {
        Logger.error('[7TV] Network error:', error);
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

// Queue system for cosmetic downloads (matches emoteService/badgeImageCacheService pattern)
const MAX_CONCURRENT_COSMETIC_DOWNLOADS = 5;
const cosmeticDownloadQueue: Array<{ id: string, url: string }> = [];
let activeCosmeticDownloads = 0;

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
    Logger.warn('[7TVService] Failed to load settings:', e);
    return { enabled: true, expiryDays: 7 };
  }
}

async function processCosmeticDownloadQueue() {
  if (activeCosmeticDownloads >= MAX_CONCURRENT_COSMETIC_DOWNLOADS || cosmeticDownloadQueue.length === 0) {
    return;
  }

  const next = cosmeticDownloadQueue.shift();
  if (!next) return;

  activeCosmeticDownloads++;

  try {
    await downloadCosmeticIfNeeded(next.id, next.url);
  } catch (e) {
    Logger.debug(`[7TVService] Error processing queue item ${next.id}:`, e);
  } finally {
    activeCosmeticDownloads--;
    processCosmeticDownloadQueue();
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
      Logger.debug(`[7TVService] Failed to cache cosmetic ${id}:`, e);
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
  if (cosmeticDownloadQueue.some(item => item.id === id)) {
    return;
  }
  cosmeticDownloadQueue.push({ id, url });
  processCosmeticDownloadQueue();
}

// Parse a single user's GraphQL payload (the `userByConnection` value) into
// the frontend-facing cosmetics shape. Extracted so both single-fetch and
// batched-fetch paths can share it.
function parseUserCosmetics(
  data: any,
  cachedFiles: Record<string, string>,
): UserCosmeticsResponse {
  const seventvUserId = data.id;
  const activePaintId = data.style?.activePaint?.id;
  const activeBadgeId = data.style?.activeBadge?.id;

  const paints: PaintV4[] = [];
  for (const paint of data.inventory?.paints ?? []) {
    if (paint.to?.paint) {
      const paintData = paint.to.paint;
      if (paintData.id === activePaintId) {
        paintData.selected = true;
      }
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

  const badges: BadgeV4[] = [];
  for (const badge of data.inventory?.badges ?? []) {
    const badgeData = badge.to?.badge;
    if (!badgeData) continue;
    if (badgeData.id === activeBadgeId) {
      badgeData.selected = true;
    }
    const localPath = cachedFiles[badgeData.id];
    if (localPath) {
      badgeData.localUrl = convertFileSrc(localPath);
    }
    badges.push(badgeData);
  }

  return {
    paints: paints.filter((p) => p !== null),
    badges: badges.filter((b) => b !== null),
    seventvUserId,
  };
}

// Batch coordinator: collects twitchIds requested within the current tick and
// fires a single aliased GraphQL query at microtask boundary. A flood of 50
// new chatters (hype train, channel switch, replay) collapses from 50 parallel
// HTTP round-trips into one. Microtask drain means there's no human-visible
// delay; the batch fires at end-of-tick.
//
// 7TV's `users.userByConnection` is a per-user field, so we use GraphQL
// aliasing (`u_<id>: users { userByConnection(...) { ... } }`) to multiplex N
// users into one request. Chunked at BATCH_MAX_SIZE to stay under 7TV's
// server-side query-complexity limit (about 400). Each aliased user with the
// full paint field selection scores about 71, so 5 users (about 355) is the
// largest chunk that passes. 6 or more is rejected outright with
// "Query is too complex." and the ENTIRE batch returns null, stranding every
// user in it without cosmetics. Do NOT raise this without re-checking 7TV's
// live complexity ceiling first.
const BATCH_MAX_SIZE = 5;
// Cap parallel in-flight chunks so an extreme cold-start burst (e.g.
// scrollback dump from a 10k-viewer hype-train channel join → 40+ chunks)
// doesn't fire dozens of concurrent HTTP requests at 7TV. Five is the
// sweet spot: 125 users in flight at any moment is plenty for snappy
// resolution while staying polite to the upstream API. Bigger drains
// process the rest in subsequent waves, still way faster than the
// pre-fix sequential O(N/25).
const MAX_PARALLEL_CHUNKS = 5;
type CosmeticsResolver = (data: UserCosmeticsResponse | null) => void;
const batchQueue = new Map<string, CosmeticsResolver[]>();
let batchScheduled = false;

// Cosmetics ids are namespaced by platform for non-Twitch chatters (e.g.
// "kick:12345"); a 7TV account's cosmetics are user-level and resolve from any
// linked platform. Twitch stays a BARE numeric id, so its query, cache key, and
// alias are all byte-identical to before — the no-prefix path is unchanged.
const cosmeticPlatform = (id: string): { platform: string; platformId: string } =>
  id.startsWith('kick:')
    ? { platform: 'KICK', platformId: id.slice(5) }
    : { platform: 'TWITCH', platformId: id };

// GraphQL aliases must match /[_A-Za-z][_0-9A-Za-z]*/, so a "kick:123" id can't be
// used raw. Sanitize to a stable token used identically when building the query
// and when reading the response back. Bare numeric Twitch ids are unaffected.
const cosmeticAlias = (id: string): string => `u_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;

const requestUserCosmeticsBatched = (
  twitchId: string,
): Promise<UserCosmeticsResponse | null> => {
  return new Promise((resolve) => {
    let resolvers = batchQueue.get(twitchId);
    if (!resolvers) {
      resolvers = [];
      batchQueue.set(twitchId, resolvers);
    }
    resolvers.push(resolve);
    if (!batchScheduled) {
      batchScheduled = true;
      queueMicrotask(drainBatch);
    }
  });
};

const drainBatch = async () => {
  batchScheduled = false;
  if (batchQueue.size === 0) return;

  // Wait for the cosmetic file cache to finish loading before reading it below,
  // so a batch that drains mid-init doesn't render image paints/badges without
  // their local files.
  if (filesInitializationPromise) await filesInitializationPromise;

  // Snapshot the queue and clear it so new requests during this drain start a
  // fresh batch (will get their own microtask).
  const snapshot = new Map(batchQueue);
  batchQueue.clear();

  const cachedFiles = cachedCosmeticFiles || {};
  const ids = Array.from(snapshot.keys());

  // Build the chunk list, then run them through a worker-pool so at most
  // MAX_PARALLEL_CHUNKS are in flight at once. Previously this awaited each
  // chunk in sequence, so a flood of new chatters at channel-join paid
  // O(N/25) sequential round-trips before the last user's paint resolved.
  // Unbounded parallelism would resolve fastest but risks 429s from 7TV on
  // extreme bursts; the worker-pool gets most of the win while staying
  // polite to the upstream API.
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += BATCH_MAX_SIZE) {
    chunks.push(ids.slice(i, i + BATCH_MAX_SIZE));
  }

  const runChunk = async (chunk: string[]) => {
    const query = `{ ${chunk
      .map((id) => {
        const { platform, platformId } = cosmeticPlatform(id);
        return `${cosmeticAlias(id)}: users { userByConnection(platform: ${platform}, platformId: "${platformId}") ${fullUserSelection} }`;
      })
      .join(' ')} }`;

    try {
      const response = await requestGql({ query });

      // requestGql swallows errors and returns undefined after exhausting its
      // retries (network error, 5xx, or 7TV rejecting the query outright, e.g.
      // "Query is too complex."). A missing data payload is a HARD FAILURE for
      // the whole chunk, not a confirmed "these users have no cosmetics."
      // Resolve null so getUserCosmetics marks the entry hardFail (short TTL)
      // and self-heals on the next read, instead of caching a bogus empty for
      // the full 5-minute TTL and stranding everyone in the chunk.
      if (!response?.data) {
        // [7TV-diag] 200 OK but no data payload = a degraded/empty response.
        Logger.warn(`[7TV-diag] chunk HARD FAIL (200, no data) for ${chunk.length} user(s)`);
        for (const id of chunk) {
          snapshot.get(id)?.forEach((r) => r(null));
        }
        return;
      }

      let resolved = 0;
      for (const id of chunk) {
        const userByConnection = response.data[cosmeticAlias(id)]?.userByConnection;
        if (userByConnection) resolved++;
        const result = userByConnection
          ? parseUserCosmetics(userByConnection, cachedFiles)
          : { paints: [], badges: [], seventvUserId: undefined };
        snapshot.get(id)?.forEach((r) => r(result));
      }
      // [7TV-diag] If this drops to 0/N while MultiChat is open, 7TV is silently
      // returning empty user entries (soft throttling) rather than erroring.
      Logger.warn(`[7TV-diag] chunk resolved ${resolved}/${chunk.length} user(s) with a 7TV connection`);
    } catch (error) {
      Logger.error('[7TV] Batch cosmetics fetch failed:', error);
      for (const id of chunk) {
        snapshot.get(id)?.forEach((r) => r(null));
      }
    }
  };

  let chunkIdx = 0;
  const worker = async () => {
    while (chunkIdx < chunks.length) {
      const myIdx = chunkIdx++;
      await runChunk(chunks[myIdx]);
    }
  };
  const workerCount = Math.min(MAX_PARALLEL_CHUNKS, chunks.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
};

// Fetch user cosmetics from 7TV v4 API.
// Content-first: lazy cache initialization in the background; cached URLs are
// used only if already in memory. Requests for distinct users in the same tick
// are batched into one HTTP round-trip via requestUserCosmeticsBatched above.
export async function getUserCosmetics(twitchId: string): Promise<UserCosmeticsResult> {
  const cached = userCache.get(twitchId);
  const now = Date.now();

  if (cached) {
    const ttl = cached.hardFail ? HARD_FAIL_CACHE_DURATION : CACHE_DURATION;
    if ((now - cached.timestamp) < ttl) {
      return { data: cached.data, hardFail: cached.hardFail };
    }
  }

  if (cachedCosmeticFiles === null && !filesInitializationPromise) {
    filesInitializationPromise = (async () => {
      try {
        cachedCosmeticFiles = await invoke('get_cached_files', { cacheType: 'cosmetic' });
      } catch (e) {
        Logger.warn('Failed to get cached cosmetic files:', e);
        // Leave it null (NOT {}) so the next cosmetic resolve retries. A
        // transient failure here (e.g. the shared Rust file cache contended
        // while another window is also hitting it) used to poison the cache as
        // {} forever, which left 7TV paints/badges broken until an app restart.
        cachedCosmeticFiles = null;
      } finally {
        filesInitializationPromise = null;
      }
    })();
  }

  const pending = pendingRequests.get(twitchId);
  if (pending) {
    return pending;
  }

  const request: Promise<UserCosmeticsResult> = (async () => {
    try {
      // requestUserCosmeticsBatched returns null only for hard failures
      // (network error, retry-exhausted batch query). Successful responses
      // — including ones that legitimately say "this user has no 7TV
      // account / no inventory" — return a UserCosmeticsResponse with
      // empty arrays + seventvUserId undefined.
      const result = await requestUserCosmeticsBatched(twitchId);
      if (result === null) {
        const empty: UserCosmeticsResponse = { paints: [], badges: [], seventvUserId: undefined };
        userCache.set(twitchId, { data: empty, hardFail: true, timestamp: now });
        return { data: empty, hardFail: true };
      }
      userCache.set(twitchId, { data: result, hardFail: false, timestamp: now });
      return { data: result, hardFail: false };
    } catch (error) {
      Logger.error('[7TV] Failed to fetch user cosmetics:', error);
      const empty: UserCosmeticsResponse = { paints: [], badges: [], seventvUserId: undefined };
      userCache.set(twitchId, { data: empty, hardFail: true, timestamp: now });
      return { data: empty, hardFail: true };
    } finally {
      pendingRequests.delete(twitchId);
    }
  })();

  pendingRequests.set(twitchId, request);
  return request;
}

/**
 * Drop this user's entry from the low-level 7TV cosmetics cache so the next
 * getUserCosmetics call genuinely re-hits the API. The cosmeticsCache-layer
 * invalidate does NOT reach this map, so a poisoned success-empty (e.g. an
 * app-mount prefetch that raced 7TV's warmup, cached hardFail=false for the
 * full CACHE_DURATION) would otherwise keep being served even after a
 * "force refresh". Pairs with cosmeticsCache.forceRefreshCosmetics.
 */
export function invalidateUserCosmeticsCache(twitchId: string): void {
  userCache.delete(twitchId);
}

// Legacy function for backwards compatibility — unwraps to the historical
// `UserCosmeticsResponse | null` shape (null = hard failure).
export async function fetch7TVUserData(twitchUserId: string): Promise<UserCosmeticsResponse | null> {
  const { data, hardFail } = await getUserCosmetics(twitchUserId);
  return hardFail ? null : data;
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

// Paint shadow render mode. 'all' = render every shadow the artist defined
// (default). 'one' = first shadow only (lighter visual). 'none' = no shadows
// (cleanest, most readable on busy backgrounds).
export type PaintShadowMode = 'all' | 'one' | 'none';

const computeDropShadows = (shadows: PaintShadow[], mode: PaintShadowMode = 'all') => {
  if (shadows.length === 0 || mode === 'none') {
    return undefined;
  }

  const picked = mode === 'one' ? shadows.slice(0, 1) : shadows;
  return picked
    .map((s) => `drop-shadow(${s.color.hex} ${s.offsetX}px ${s.offsetY}px ${s.blur}px)`)
    .join(' ');
};

// Bounded LRU memo for computePaintStyle. A chat with 100 visible messages from
// 30 distinct chatters used to compute 100 paint styles per render pass; with
// this cache it's at most one compute per unique (paint, color, shadowMode)
// combo. Returning the same object reference across calls also lets React's
// shallow prop comparison short-circuit downstream renders.
const PAINT_STYLE_CACHE_MAX = 256;
const paintStyleCache = new Map<string, React.CSSProperties>();

const computePaintStyleUncached = (
  paint: PaintV4,
  userColor?: string,
  shadowMode: PaintShadowMode = 'all',
): React.CSSProperties => {
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

  const filter = computeDropShadows(paint.data.shadows, shadowMode);

  const opacities = layers.map((l) => l.opacity).filter((o) => o < 1);
  const minOpacity = opacities.length > 0 ? Math.min(...opacities) : 1;

  const style: React.CSSProperties = {
    backgroundColor: backgroundColor,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    backgroundSize: '100% 100%', // Per 7TV docs: ensures paint spans full text width
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

// Compute the full CSS style for a paint.
// Memoized: same (paintId, userColor, shadowMode) returns the same object ref.
export const computePaintStyle = (
  paint: PaintV4,
  userColor?: string,
  shadowMode: PaintShadowMode = 'all',
): React.CSSProperties => {
  // Defensive: anonymous/test paints without an id fall through uncached.
  if (!paint?.id) {
    return computePaintStyleUncached(paint, userColor, shadowMode);
  }
  const key = `${paint.id}|${userColor ?? ''}|${shadowMode}`;
  const cached = paintStyleCache.get(key);
  if (cached) {
    // Touch-on-hit: re-insert to move to most-recent in Map iteration order.
    paintStyleCache.delete(key);
    paintStyleCache.set(key, cached);
    return cached;
  }
  const style = computePaintStyleUncached(paint, userColor, shadowMode);
  paintStyleCache.set(key, style);
  if (paintStyleCache.size > PAINT_STYLE_CACHE_MAX) {
    // Evict oldest (first key per insertion order).
    const oldest = paintStyleCache.keys().next().value;
    if (oldest !== undefined) paintStyleCache.delete(oldest);
  }
  return style;
};

// Get badge image URL (7TV v4 badges need to be fetched from CDN).
// The .webp suffix is REQUIRED — 7TV's CDN serves animated badges as
// animated WebP at that path. Without the extension the CDN returns a
// default/static representation, breaking animation on badges like the
// year-streak crowns. See https://cdn.7tv.app/badge/<id>/<res>.webp
// Pick the best image URL from a V4 badge's images[] for a target scale. A
// badge's id is NOT its image id in V4, so these API-provided URLs are the only
// reliable source. Prefers the requested scale, the animated (non-_static)
// form, and webp > avif > png > gif.
const pickBadgeImage = (images: BadgeImageV4[] | undefined, scale: number): string | undefined => {
  if (!images?.length) return undefined;
  const rank = (img: BadgeImageV4): number => {
    let s = Math.abs((img.scale ?? 1) - scale) * 10;
    if (img.url.includes('_static')) s += 3;
    const m = img.mime ?? '';
    s += m.includes('webp') ? 0 : m.includes('avif') ? 1 : m.includes('png') ? 2 : 4;
    return s;
  };
  return [...images].sort((a, b) => rank(a) - rank(b))[0]?.url;
};

export const getBadgeImageUrl = (badge: BadgeV4): string => {
  if (badge.localUrl) return badge.localUrl;
  return pickBadgeImage(badge.images, 4) ?? `https://cdn.7tv.app/badge/${badge.id}/4x.webp`;
};

// Get all resolution URLs for a 7TV badge (for srcSet)
export const getBadgeImageUrls = (badge: BadgeV4): { url1x: string; url2x: string; url3x: string; url4x: string } => {
  if (badge.localUrl) {
    // If we have a local URL, use it for all resolutions
    return { url1x: badge.localUrl, url2x: badge.localUrl, url3x: badge.localUrl, url4x: badge.localUrl };
  }
  const legacy = `https://cdn.7tv.app/badge/${badge.id}`;
  return {
    url1x: pickBadgeImage(badge.images, 1) ?? `${legacy}/1x.webp`,
    url2x: pickBadgeImage(badge.images, 2) ?? `${legacy}/2x.webp`,
    url3x: pickBadgeImage(badge.images, 3) ?? `${legacy}/3x.webp`,
    url4x: pickBadgeImage(badge.images, 4) ?? `${legacy}/4x.webp`,
  };
};

// Get badge URLs with fallback priority (highest to lowest resolution)
// Used when 4x may 404 - tries 3x, 2x, 1x as fallbacks
export const getBadgeFallbackUrls = (badgeId: string): string[] => {
  const baseUrl = `https://cdn.7tv.app/badge/${badgeId}`;
  return [
    `${baseUrl}/4x.webp`,
    `${baseUrl}/3x.webp`,
    `${baseUrl}/2x.webp`,
    `${baseUrl}/1x.webp`,
  ];
};

// Get badge image URL for any provider
export const getBadgeImageUrlForProvider = (badge: any, provider: '7tv' | 'ffz'): string => {
  if (provider === '7tv') {
    if (badge.localUrl) return badge.localUrl;
    return pickBadgeImage(badge.images, 3) ?? `https://cdn.7tv.app/badge/${badge.id}/3x.webp`;
  } else if (provider === 'ffz') {
    return badge.urls?.['4'] || badge.urls?.['2'] || badge.urls?.['1'] || badge.image;
  }
  return '';
};

export function clearUserCache() {
  userCache.clear();
  cachedCosmeticFiles = null; // Also clear the file cache so it re-fetches
}
