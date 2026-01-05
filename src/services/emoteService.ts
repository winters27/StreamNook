// Simplified emote service - now a thin wrapper around Rust backend
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';

export interface Emote {
  id: string;
  name: string;
  url: string;
  provider: 'twitch' | 'bttv' | '7tv' | 'ffz';
  isZeroWidth?: boolean;
  localUrl?: string;
  /** Type of emote: "globals", "subscriptions", "bitstier", "follower", "channelpoints", etc. */
  emote_type?: string;
  /** Owner/broadcaster ID for subscription emotes */
  owner_id?: string;
}

export interface EmoteSet {
  twitch: Emote[];
  bttv: Emote[];
  '7tv': Emote[];
  ffz: Emote[];
}

// Module-level registry of cached emote files (id -> localPath)
const cachedEmoteFiles: Map<string, string> = new Map();

// Pending downloads to prevent duplicate requests
const pendingDownloads: Map<string, Promise<string | null>> = new Map();

// Queue system for downloads
const MAX_CONCURRENT_DOWNLOADS = 3;
const downloadQueue: Array<{ id: string, url: string }> = [];
let activeDownloads = 0;

// Settings cache
let cachedSettings: { enabled: boolean; expiryDays: number } | null = null;

let initializationPromise: Promise<void> | null = null;

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
    processDownloadQueue();
  }
}

async function downloadEmoteIfNeeded(id: string, url: string): Promise<string | null> {
  if (cachedEmoteFiles.has(id)) {
    return cachedEmoteFiles.get(id)!;
  }

  if (pendingDownloads.has(id)) {
    return pendingDownloads.get(id)!;
  }

  const settings = await getEmoteCacheSettings();
  if (!settings.enabled) return null;

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

export function queueEmoteForCaching(id: string, url: string) {
  if (cachedEmoteFiles.has(id) || pendingDownloads.has(id) || downloadQueue.some(item => item.id === id)) {
    return;
  }

  downloadQueue.push({ id, url });
  processDownloadQueue();
}

export function getCachedEmoteUrl(id: string): string | undefined {
  const path = cachedEmoteFiles.get(id);
  return path ? convertFileSrc(path) : undefined;
}

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

export function preloadChannelEmotes(emotes: Emote[]) {
  if (emotes.length === 0) return;

  const cached = emotes.filter(e => e.localUrl);
  const remote = emotes.filter(e => !e.localUrl);

  console.log(`[EmoteService] Browser preload: ${cached.length} cached, ${remote.length} remote`);

  if (cached.length > 0) {
    preloadImagesIntoMemory(cached.map(e => e.localUrl!));
  }

  if (remote.length > 0 && typeof window.requestIdleCallback === 'function') {
    // @ts-ignore
    window.requestIdleCallback(() => {
      preloadImagesIntoMemory(remote.map(e => e.url));
    }, { timeout: 2000 });
  }
}

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

/**
 * Fetch all emotes for a channel using the high-performance Rust backend
 * This performs concurrent fetching from BTTV, 7TV, and FFZ with serde JSON parsing
 * Also fetches user-specific Twitch emotes (subscriptions, drops, etc.) if authenticated
 */
export async function fetchAllEmotes(channelName?: string, channelId?: string): Promise<EmoteSet> {
  await ensureEmoteFileCache();

  console.log('[EmoteService] Fetching emotes via Rust backend for channel:', channelName, 'ID:', channelId);

  try {
    // Try to get the auth token for user-specific Twitch emotes
    let accessToken: string | null = null;
    try {
      accessToken = await invoke<string>('get_twitch_token');
      console.log('[EmoteService] Auth token available, will fetch user-specific Twitch emotes');
    } catch {
      console.log('[EmoteService] No auth token available, Twitch emotes will be limited to globals');
    }

    // Call the Rust backend which does concurrent fetching with tokio::join!
    const emoteSet = await invoke<EmoteSet>('fetch_channel_emotes', {
      channelName: channelName || null,
      channelId: channelId || null,
      accessToken,
    });

    // Enhance with local URLs if available
    const enhanceWithLocalUrls = (emotes: Emote[]) => {
      return emotes.map(emote => {
        const localPath = cachedEmoteFiles.get(emote.id);
        return {
          ...emote,
          localUrl: localPath ? convertFileSrc(localPath) : undefined
        };
      });
    };

    const enhancedSet: EmoteSet = {
      twitch: enhanceWithLocalUrls(emoteSet.twitch),
      bttv: enhanceWithLocalUrls(emoteSet.bttv),
      '7tv': enhanceWithLocalUrls(emoteSet['7tv']),
      ffz: enhanceWithLocalUrls(emoteSet.ffz),
    };

    console.log('[EmoteService] Fetched emotes from Rust:', {
      twitch: enhancedSet.twitch.length,
      bttv: enhancedSet.bttv.length,
      '7tv': enhancedSet['7tv'].length,
      ffz: enhancedSet.ffz.length,
      cached: cachedEmoteFiles.size
    });

    return enhancedSet;
  } catch (error) {
    console.error('[EmoteService] Failed to fetch emotes from Rust backend:', error);
    // Return empty set on error
    return {
      twitch: [],
      bttv: [],
      '7tv': [],
      ffz: [],
    };
  }
}

/**
 * Get a specific emote by name from the Rust cache
 */
export async function getEmoteByName(channelId: string | null, emoteName: string): Promise<Emote | null> {
  try {
    const emote = await invoke<Emote | null>('get_emote_by_name', {
      channelId,
      emoteName,
    });
    
    if (emote) {
      // Enhance with local URL if available
      const localPath = cachedEmoteFiles.get(emote.id);
      return {
        ...emote,
        localUrl: localPath ? convertFileSrc(localPath) : undefined
      };
    }
    
    return null;
  } catch (error) {
    console.error('[EmoteService] Failed to get emote by name:', error);
    return null;
  }
}

/**
 * Clear the emote cache (both Rust and local file cache)
 */
export async function clearEmoteCache() {
  cachedEmoteFiles.clear();

  try {
    await invoke('clear_emote_cache');
    await invoke('clear_cache'); // Also clear disk cache
    console.log('[EmoteService] Cleared all emote caches');
  } catch (e) {
    console.warn('[EmoteService] Failed to clear emote cache:', e);
  }
}

// Legacy compatibility exports (kept for backward compatibility, but simplified)
export const fetchBTTVEmotes = async () => [];
export const fetch7TVEmotes = async () => [];
export const fetchFFZEmotes = async () => [];
