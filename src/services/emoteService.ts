// Emote service to fetch emotes from multiple providers
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';

export interface Emote {
  id: string;
  name: string;
  url: string;
  provider: 'twitch' | 'bttv' | '7tv' | 'ffz';
  isZeroWidth?: boolean;
  localUrl?: string;
}

export interface EmoteSet {
  twitch: Emote[];
  bttv: Emote[];
  '7tv': Emote[];
  ffz: Emote[];
}

// Cache for emotes (keyed by channel ID or 'global')
const emoteCache: Map<string, { set: EmoteSet, timestamp: number }> = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes for memory cache

// Module-level registry of cached emote files (id -> localPath)
// This allows us to quickly look up if we have a file for any emote ID
const cachedEmoteFiles: Map<string, string> = new Map();

// Pending downloads to prevent duplicate requests
const pendingDownloads: Map<string, Promise<string | null>> = new Map();

// Global Twitch emotes (most popular ones)
const GLOBAL_TWITCH_EMOTES: Emote[] = [
  { id: '25', name: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0', provider: 'twitch' },
  { id: '354', name: '4Head', url: 'https://static-cdn.jtvnw.net/emoticons/v2/354/default/dark/1.0', provider: 'twitch' },
  { id: '425618', name: 'LUL', url: 'https://static-cdn.jtvnw.net/emoticons/v2/425618/default/dark/1.0', provider: 'twitch' },
  { id: '305954156', name: 'Pog', url: 'https://static-cdn.jtvnw.net/emoticons/v2/305954156/default/dark/1.0', provider: 'twitch' },
  { id: '88', name: 'PogChamp', url: 'https://static-cdn.jtvnw.net/emoticons/v2/88/default/dark/1.0', provider: 'twitch' },
  { id: '81273', name: 'BibleThump', url: 'https://static-cdn.jtvnw.net/emoticons/v2/81273/default/dark/1.0', provider: 'twitch' },
  { id: '81248', name: 'Kreygasm', url: 'https://static-cdn.jtvnw.net/emoticons/v2/81248/default/dark/1.0', provider: 'twitch' },
  { id: '81249', name: 'ResidentSleeper', url: 'https://static-cdn.jtvnw.net/emoticons/v2/81249/default/dark/1.0', provider: 'twitch' },
  { id: '81274', name: 'FailFish', url: 'https://static-cdn.jtvnw.net/emoticons/v2/81274/default/dark/1.0', provider: 'twitch' },
  { id: '81997', name: 'NotLikeThis', url: 'https://static-cdn.jtvnw.net/emoticons/v2/81997/default/dark/1.0', provider: 'twitch' },
  { id: '166266', name: 'CoolCat', url: 'https://static-cdn.jtvnw.net/emoticons/v2/166266/default/dark/1.0', provider: 'twitch' },
  { id: '191762', name: 'CoolStoryBob', url: 'https://static-cdn.jtvnw.net/emoticons/v2/191762/default/dark/1.0', provider: 'twitch' },
  { id: '196892', name: 'SeemsGood', url: 'https://static-cdn.jtvnw.net/emoticons/v2/196892/default/dark/1.0', provider: 'twitch' },
  { id: '245', name: 'KappaHD', url: 'https://static-cdn.jtvnw.net/emoticons/v2/245/default/dark/1.0', provider: 'twitch' },
  { id: '1902', name: 'Keepo', url: 'https://static-cdn.jtvnw.net/emoticons/v2/1902/default/dark/1.0', provider: 'twitch' },
];

// Settings cache to avoid repeated calls
let cachedSettings: { enabled: boolean; expiryDays: number } | null = null;

// Interface for disk cached emote data (without localUrl which needs to be resolved at runtime)
interface StoredEmote {
  id: string;
  name: string;
  url: string;
  provider: 'twitch' | 'bttv' | '7tv' | 'ffz';
  isZeroWidth?: boolean;
}

interface StoredEmoteSet {
  twitch: StoredEmote[];
  bttv: StoredEmote[];
  '7tv': StoredEmote[];
  ffz: StoredEmote[];
}

// Save emote set to disk cache via Tauri backend
async function saveEmotesToDiskCache(cacheKey: string, emoteSet: EmoteSet): Promise<void> {
  try {
    const settings = await getEmoteCacheSettings();

    // Strip localUrl before saving (it needs to be resolved at runtime from cachedEmoteFiles)
    const storedSet: StoredEmoteSet = {
      twitch: emoteSet.twitch.map(({ localUrl, ...rest }) => rest),
      bttv: emoteSet.bttv.map(({ localUrl, ...rest }) => rest),
      '7tv': emoteSet['7tv'].map(({ localUrl, ...rest }) => rest),
      ffz: emoteSet.ffz.map(({ localUrl, ...rest }) => rest),
    };

    await invoke('save_emotes_to_cache', {
      channelId: cacheKey,
      data: JSON.stringify(storedSet),
      expiryDays: settings.expiryDays
    });
    console.log(`[EmoteService] Saved emotes to disk cache for ${cacheKey}`);
  } catch (e) {
    console.warn('[EmoteService] Failed to save emotes to disk cache:', e);
  }
}

// Load emote set from disk cache via Tauri backend (returns null if not found or expired)
async function loadEmotesFromDiskCache(cacheKey: string): Promise<EmoteSet | null> {
  try {
    const cachedData = await invoke<string | null>('load_emotes_from_cache', { channelId: cacheKey });
    if (!cachedData) return null;

    const storedSet: StoredEmoteSet = JSON.parse(cachedData);

    // Restore localUrl from cachedEmoteFiles
    const emoteSet: EmoteSet = {
      twitch: storedSet.twitch.map(emote => ({
        ...emote,
        localUrl: cachedEmoteFiles.has(emote.id) ? convertFileSrc(cachedEmoteFiles.get(emote.id)!) : undefined
      })),
      bttv: storedSet.bttv.map(emote => ({
        ...emote,
        localUrl: cachedEmoteFiles.has(emote.id) ? convertFileSrc(cachedEmoteFiles.get(emote.id)!) : undefined
      })),
      '7tv': storedSet['7tv'].map(emote => ({
        ...emote,
        localUrl: cachedEmoteFiles.has(emote.id) ? convertFileSrc(cachedEmoteFiles.get(emote.id)!) : undefined
      })),
      ffz: storedSet.ffz.map(emote => ({
        ...emote,
        localUrl: cachedEmoteFiles.has(emote.id) ? convertFileSrc(cachedEmoteFiles.get(emote.id)!) : undefined
      })),
    };

    console.log(`[EmoteService] Loaded emotes from disk cache for ${cacheKey}`);
    return emoteSet;
  } catch (e) {
    console.warn('[EmoteService] Failed to load emotes from disk cache:', e);
    return null;
  }
}

async function getEmoteCacheSettings(): Promise<{ enabled: boolean; expiryDays: number }> {
  if (cachedSettings) return cachedSettings;
  try {
    const settings = await invoke('load_settings') as any;
    cachedSettings = {
      enabled: settings.cache?.enabled !== false,
      expiryDays: settings.cache?.expiry_days ?? 7
    };
    return cachedSettings;
  } catch (e) {
    console.warn('[EmoteService] Failed to load settings:', e);
    return { enabled: true, expiryDays: 7 };
  }
}

// Queue system for downloads to prevent freezing the UI
const MAX_CONCURRENT_DOWNLOADS = 3;
const downloadQueue: Array<{ id: string, url: string }> = [];
let activeDownloads = 0;

async function processDownloadQueue() {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS || downloadQueue.length === 0) {
    return;
  }

  const next = downloadQueue.shift();
  if (!next) return;

  activeDownloads++;

  try {
    await downloadEmoteIfNeeded(next.id, next.url);
  } catch (e) {
    console.debug(`[EmoteService] Error processing queue item ${next.id}:`, e);
  } finally {
    activeDownloads--;
    // Process next item
    processDownloadQueue();
  }
}

// Download a single emote on-demand (lazy caching)
// Returns the local path if successful, null otherwise
async function downloadEmoteIfNeeded(id: string, url: string): Promise<string | null> {
  // Already cached?
  if (cachedEmoteFiles.has(id)) {
    return cachedEmoteFiles.get(id)!;
  }

  // Already downloading (in map)?
  if (pendingDownloads.has(id)) {
    return pendingDownloads.get(id)!;
  }

  const settings = await getEmoteCacheSettings();
  if (!settings.enabled) return null;

  // Start download
  const downloadPromise = (async () => {
    try {
      const localPath = await invoke('download_and_cache_file', {
        cacheType: 'emote',
        id,
        url,
        expiryDays: settings.expiryDays
      }) as string;

      if (localPath) {
        cachedEmoteFiles.set(id, localPath);
        return localPath;
      }
      return null;
    } catch (e) {
      console.debug(`[EmoteService] Failed to cache emote ${id}:`, e);
      return null;
    } finally {
      pendingDownloads.delete(id);
    }
  })();

  pendingDownloads.set(id, downloadPromise);
  return downloadPromise;
}

// Queue an emote to be cached (reactive caching) - called when emote is displayed
export function queueEmoteForCaching(id: string, url: string) {
  // If already cached, or downloading, or already in queue, skip
  if (cachedEmoteFiles.has(id) || pendingDownloads.has(id) || downloadQueue.some(item => item.id === id)) {
    return;
  }

  // Add to queue instead of firing immediately
  downloadQueue.push({ id, url });
  processDownloadQueue();
}

// Get local URL for an emote if cached
export function getCachedEmoteUrl(id: string): string | undefined {
  const path = cachedEmoteFiles.get(id);
  return path ? convertFileSrc(path) : undefined;
}

let initializationPromise: Promise<void> | null = null;

// Helper to ensure emote file cache is populated (batch load existing cache)
async function ensureEmoteFileCache() {
  if (cachedEmoteFiles.size > 0) return;

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      console.log('[EmoteService] Initializing emote file cache...');
      const files = await invoke('get_cached_files', { cacheType: 'emote' }) as Record<string, string>;
      Object.entries(files).forEach(([id, path]) => cachedEmoteFiles.set(id, path));
      console.log(`[EmoteService] Emote file cache initialized with ${cachedEmoteFiles.size} entries`);
    } catch (e) {
      console.warn('[EmoteService] Failed to init emote file cache:', e);
    } finally {
      initializationPromise = null;
    }
  })();

  return initializationPromise;
}

// Preload emotes into browser memory only (no downloading)
// This just loads images into the browser cache for instant display
export function preloadChannelEmotes(emotes: Emote[]) {
  if (emotes.length === 0) return;

  // Only preload emotes that have a URL (cached or remote)
  const cached = emotes.filter(e => e.localUrl);
  const remote = emotes.filter(e => !e.localUrl);

  console.log(`[EmoteService] Browser preload: ${cached.length} cached, ${remote.length} remote`);

  // Preload cached emotes first (instant from disk)
  if (cached.length > 0) {
    preloadImagesIntoMemory(cached.map(e => e.localUrl!));
  }

  // Then preload remote URLs (these will download when displayed anyway)
  // Use idle callback for remote to not block
  if (remote.length > 0 && typeof window.requestIdleCallback === 'function') {
    // @ts-ignore
    window.requestIdleCallback(() => {
      preloadImagesIntoMemory(remote.map(e => e.url));
    }, { timeout: 2000 });
  }
}

// Simple browser image preload (no downloading to cache, just browser memory)
function preloadImagesIntoMemory(urls: string[]) {
  const CHUNK_SIZE = 10;
  let index = 0;

  function processChunk() {
    const chunk = urls.slice(index, index + CHUNK_SIZE);
    if (chunk.length === 0) return;

    chunk.forEach(url => {
      const img = new Image();
      img.src = url;
    });

    index += CHUNK_SIZE;
    if (index < urls.length) {
      setTimeout(processChunk, 50);
    }
  }

  processChunk();
}

export async function fetchBTTVEmotes(_channelName?: string, channelId?: string): Promise<Emote[]> {
  try {
    await ensureEmoteFileCache();
    const emotes: Emote[] = [];

    // Fetch global BTTV emotes
    const globalResponse = await fetch('https://api.betterttv.net/3/cached/emotes/global');
    if (globalResponse.ok) {
      const globalData = await globalResponse.json();
      emotes.push(...globalData.map((emote: any) => {
        const localPath = cachedEmoteFiles.get(emote.id);
        return {
          id: emote.id,
          name: emote.code,
          url: `https://cdn.betterttv.net/emote/${emote.id}/1x`,
          provider: 'bttv' as const,
          isZeroWidth: emote.imageType === 'gif',
          localUrl: localPath ? convertFileSrc(localPath) : undefined
        };
      }));
    }

    // Fetch channel-specific BTTV emotes if channel ID is provided
    if (channelId) {
      try {
        const userResponse = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`);
        if (userResponse.ok) {
          const userData = await userResponse.json();
          if (userData.channelEmotes) {
            emotes.push(...userData.channelEmotes.map((emote: any) => {
              const localPath = cachedEmoteFiles.get(emote.id);
              return {
                id: emote.id,
                name: emote.code,
                url: `https://cdn.betterttv.net/emote/${emote.id}/1x`,
                provider: 'bttv' as const,
                isZeroWidth: emote.imageType === 'gif',
                localUrl: localPath ? convertFileSrc(localPath) : undefined
              };
            }));
          }
          if (userData.sharedEmotes) {
            emotes.push(...userData.sharedEmotes.map((emote: any) => {
              const localPath = cachedEmoteFiles.get(emote.id);
              return {
                id: emote.id,
                name: emote.code,
                url: `https://cdn.betterttv.net/emote/${emote.id}/1x`,
                provider: 'bttv' as const,
                isZeroWidth: emote.imageType === 'gif',
                localUrl: localPath ? convertFileSrc(localPath) : undefined
              };
            }));
          }
        }
      } catch (err) {
        console.warn('Failed to fetch channel BTTV emotes:', err);
      }
    }

    // NO aggressive caching here - emotes will be cached lazily when used

    return emotes;
  } catch (error) {
    console.error('Failed to fetch BTTV emotes:', error);
    return [];
  }
}

export async function fetch7TVEmotes(_channelName?: string, channelId?: string): Promise<Emote[]> {
  try {
    await ensureEmoteFileCache();
    const emotes: Emote[] = [];

    // Fetch trending 7TV emotes using GraphQL API
    try {
      const gqlQuery = `
      query EmoteSearch(
        $query: String,
        $tags: [String!],
        $sortBy: SortBy!,
        $filters: Filters,
        $page: Int,
        $perPage: Int!
      ) {
        emotes {
          search(
            query: $query
            tags: { tags: $tags, match: ANY }
            sort: { sortBy: $sortBy, order: DESCENDING }
            filters: $filters
            page: $page
            perPage: $perPage
          ) {
            items {
              id
              name
              flags
            }
          }
        }
      }
    `;

      const variables = {
        filters: { animated: true },
        page: 1,
        perPage: 300,
        query: null,
        sortBy: 'TRENDING_MONTHLY',
        tags: []
      };

      const gqlResponse = await fetch('https://api.7tv.app/v4/gql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/graphql-response+json, application/graphql+json, application/json',
        },
        body: JSON.stringify({
          operationName: 'EmoteSearch',
          query: gqlQuery,
          variables
        })
      });

      if (gqlResponse.ok) {
        const gqlData = await gqlResponse.json();
        const items = gqlData?.data?.emotes?.search?.items || [];
        emotes.push(...items.map((emote: any) => {
          const localPath = cachedEmoteFiles.get(emote.id);
          return {
            id: emote.id,
            name: emote.name,
            url: `https://cdn.7tv.app/emote/${emote.id}/1x.webp`,
            provider: '7tv' as const,
            isZeroWidth: emote.flags === 256,
            localUrl: localPath ? convertFileSrc(localPath) : undefined
          };
        }));
      }
    } catch (err) {
      console.warn('Failed to fetch trending 7TV emotes:', err);
    }

    // Fetch global 7TV emotes (v3 API)
    try {
      const globalResponse = await fetch('https://7tv.io/v3/emote-sets/global');
      if (globalResponse.ok) {
        const globalData = await globalResponse.json();
        if (globalData.emotes) {
          emotes.push(...globalData.emotes.map((emote: any) => {
            const localPath = cachedEmoteFiles.get(emote.id);
            return {
              id: emote.id,
              name: emote.name,
              url: `https://cdn.7tv.app/emote/${emote.id}/1x.webp`,
              provider: '7tv' as const,
              isZeroWidth: emote.flags === 256,
              localUrl: localPath ? convertFileSrc(localPath) : undefined
            };
          }));
        }
      }
    } catch (err) {
      console.warn('Failed to fetch global 7TV emotes:', err);
    }

    // Fetch channel-specific 7TV emotes if channel ID is provided
    if (channelId) {
      try {
        const userResponse = await fetch(`https://7tv.io/v3/users/twitch/${channelId}`);
        if (userResponse.ok) {
          const userData = await userResponse.json();

          const emoteSet = userData.emote_set;
          if (emoteSet?.emotes && Array.isArray(emoteSet.emotes)) {
            emotes.push(...emoteSet.emotes.map((activeEmote: any) => {
              const emoteData = activeEmote.data || activeEmote;
              const emoteId = emoteData.id || activeEmote.id;
              const localPath = cachedEmoteFiles.get(emoteId);

              return {
                id: emoteId,
                name: activeEmote.name,
                url: `https://cdn.7tv.app/emote/${emoteId}/1x.webp`,
                provider: '7tv' as const,
                isZeroWidth: (activeEmote.flags & 256) === 256,
                localUrl: localPath ? convertFileSrc(localPath) : undefined
              };
            }));
          }
        }
      } catch (err) {
        console.error('[7TV] Error fetching channel emotes:', err);
      }
    }

    // Deduplicate by ID
    const seen = new Set<string>();
    const uniqueEmotes = emotes.filter(emote => {
      if (seen.has(emote.id)) return false;
      seen.add(emote.id);
      return true;
    });

    // NO aggressive caching here - emotes will be cached lazily when used

    return uniqueEmotes;
  } catch (error) {
    console.error('Failed to fetch 7TV emotes:', error);
    return [];
  }
}

export async function fetchFFZEmotes(channelName?: string): Promise<Emote[]> {
  try {
    await ensureEmoteFileCache();
    const emotes: Emote[] = [];

    // Fetch global FFZ emotes
    const globalResponse = await fetch('https://api.frankerfacez.com/v1/set/global');
    if (globalResponse.ok) {
      const globalData = await globalResponse.json();
      if (globalData.sets) {
        Object.values(globalData.sets).forEach((set: any) => {
          if (set.emoticons) {
            emotes.push(...set.emoticons.map((emote: any) => {
              const localPath = cachedEmoteFiles.get(emote.id.toString());
              return {
                id: emote.id.toString(),
                name: emote.name,
                url: emote.urls['1'] || `https://cdn.frankerfacez.com/emote/${emote.id}/1`,
                provider: 'ffz' as const,
                localUrl: localPath ? convertFileSrc(localPath) : undefined
              };
            }));
          }
        });
      }
    }

    // Fetch channel-specific FFZ emotes if channel is provided
    if (channelName) {
      try {
        const roomResponse = await fetch(`https://api.frankerfacez.com/v1/room/${channelName}`);
        if (roomResponse.ok) {
          const roomData = await roomResponse.json();
          if (roomData.sets) {
            Object.values(roomData.sets).forEach((set: any) => {
              if (set.emoticons) {
                emotes.push(...set.emoticons.map((emote: any) => {
                  const localPath = cachedEmoteFiles.get(emote.id.toString());
                  return {
                    id: emote.id.toString(),
                    name: emote.name,
                    url: emote.urls['1'] || `https://cdn.frankerfacez.com/emote/${emote.id}/1`,
                    provider: 'ffz' as const,
                    localUrl: localPath ? convertFileSrc(localPath) : undefined
                  };
                }));
              }
            });
          }
        }
      } catch (err) {
        console.warn('Failed to fetch channel FFZ emotes:', err);
      }
    }

    // NO aggressive caching here - emotes will be cached lazily when used

    return emotes;
  } catch (error) {
    console.error('Failed to fetch FFZ emotes:', error);
    return [];
  }
}

export async function fetchAllEmotes(channelName?: string, channelId?: string): Promise<EmoteSet> {
  const cacheKey = channelId || 'global';
  const now = Date.now();

  // Check memory cache first (fastest)
  const memoryCached = emoteCache.get(cacheKey);
  if (memoryCached && (now - memoryCached.timestamp) < CACHE_DURATION) {
    console.log(`[EmoteService] Returning memory-cached emotes for ${cacheKey}`);
    return memoryCached.set;
  }

  // Ensure file cache registry is ready before checking disk cache
  await ensureEmoteFileCache();

  // Check disk cache (persists across app restarts, respects user's cache expiry setting)
  const diskCached = await loadEmotesFromDiskCache(cacheKey);
  if (diskCached) {
    // Update memory cache with disk cache data
    emoteCache.set(cacheKey, { set: diskCached, timestamp: now });
    console.log(`[EmoteService] Returning disk-cached emotes for ${cacheKey}`);
    return diskCached;
  }

  console.log('[EmoteService] Fetching emotes from APIs for channel:', channelName, 'ID:', channelId);

  // Fetch all emotes in parallel from APIs
  const [bttvEmotes, sevenTVEmotes, ffzEmotes] = await Promise.all([
    fetchBTTVEmotes(channelName, channelId),
    fetch7TVEmotes(channelName, channelId),
    fetchFFZEmotes(channelName)
  ]);

  // Process global Twitch emotes with cache lookup
  const twitchEmotes = GLOBAL_TWITCH_EMOTES.map(emote => {
    const localPath = cachedEmoteFiles.get(emote.id);
    return {
      ...emote,
      localUrl: localPath ? convertFileSrc(localPath) : undefined
    };
  });

  const emoteSet: EmoteSet = {
    twitch: twitchEmotes,
    bttv: bttvEmotes,
    '7tv': sevenTVEmotes,
    ffz: ffzEmotes
  };

  // Update memory cache for this channel
  emoteCache.set(cacheKey, { set: emoteSet, timestamp: now });

  // Save to disk cache for persistence across app restarts
  saveEmotesToDiskCache(cacheKey, emoteSet);

  console.log('[EmoteService] Fetched emotes from APIs:', {
    twitch: emoteSet.twitch.length,
    bttv: emoteSet.bttv.length,
    '7tv': emoteSet['7tv'].length,
    ffz: emoteSet.ffz.length,
    cached: cachedEmoteFiles.size
  });

  return emoteSet;
}

export async function clearEmoteCache() {
  emoteCache.clear();
  cachedEmoteFiles.clear();

  // Also clear disk cache via Tauri backend
  try {
    await invoke('clear_cache');
    console.log('[EmoteService] Cleared disk emote cache');
  } catch (e) {
    console.warn('[EmoteService] Failed to clear disk emote cache:', e);
  }
}
