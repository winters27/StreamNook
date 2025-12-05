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

// Cache for emotes
let emoteCache: EmoteSet | null = null;
let cacheTimestamp: number = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Module-level registry of cached emote files (id -> localPath)
// This allows us to quickly look up if we have a file for any emote ID
const cachedEmoteFiles: Map<string, string> = new Map();
const pendingCacheQueue: Set<string> = new Set();
let cacheQueueTimer: ReturnType<typeof setTimeout> | null = null;


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

// Helper to cache emotes in background
async function cacheEmotes(emotes: Emote[]) {
  // Load settings to check if caching is enabled and get expiry
  let expiryDays = 7; // Default to 7 days for emotes
  try {
    const settings = await invoke('load_settings') as any;
    if (settings.cache?.enabled === false) {
      return; // Caching disabled
    }
    expiryDays = settings.cache?.expiry_days ?? 7;
  } catch (e) {
    console.warn('[EmoteService] Failed to load settings for cache config:', e);
  }

  // Process in chunks to avoid overwhelming the network/backend
  const CHUNK_SIZE = 10;
  for (let i = 0; i < emotes.length; i += CHUNK_SIZE) {
    const chunk = emotes.slice(i, i + CHUNK_SIZE);
    await Promise.allSettled(chunk.map(async (emote) => {
      try {
        // Only cache if not already cached
        if (emote.localUrl || cachedEmoteFiles.has(emote.id)) return;

        const localPath = await invoke('download_and_cache_file', {
          cacheType: 'emote',
          id: emote.id,
          url: emote.url,
          expiryDays
        }) as string;

        // Update registry
        if (localPath) {
          cachedEmoteFiles.set(emote.id, localPath);
          // Also update the emote object in place if possible
          emote.localUrl = convertFileSrc(localPath);
        }
      } catch (e) {
        console.warn(`Failed to cache emote ${emote.name}:`, e);
      }
    }));
    // Small delay between chunks
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// Queue an emote to be cached (reactive caching)
export function queueEmoteForCaching(id: string, url: string) {
  // If already cached or pending, skip
  if (cachedEmoteFiles.has(id) || pendingCacheQueue.has(id)) {
    return;
  }

  pendingCacheQueue.add(id);

  // Debounce the actual caching operation
  if (cacheQueueTimer) {
    clearTimeout(cacheQueueTimer);
  }

  cacheQueueTimer = setTimeout(() => {
    processCacheQueue();
  }, 2000); // Process queue every 2 seconds if active

  // Also define the processor function here to capture the closure vars
  async function processCacheQueue() {
    if (pendingCacheQueue.size === 0) return;

    const emotesToCache: Emote[] = [];
    pendingCacheQueue.forEach(emoteId => {
      // We reconstruct a minimal emote object for the cacheEmotes function
      // For Twitch emotes, the URL is standard if not provided, but here we expect URL to be passed
      // or we can reconstruct it if it's a Twitch ID
      let emoteUrl = url;
      if (!emoteUrl && /^\d+$/.test(emoteId)) {
        // It's likely a Twitch ID, construct URL
        emoteUrl = `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/1.0`;
      }

      if (emoteUrl) {
        emotesToCache.push({
          id: emoteId,
          name: emoteId, // Name doesn't matter for caching
          url: emoteUrl,
          provider: 'twitch' // Default to twitch, doesn't matter for file cache
        });
      }
    });

    // Clear queue before processing to allow new additions
    pendingCacheQueue.clear();
    cacheQueueTimer = null;

    console.log(`[EmoteService] Processing reactive cache queue for ${emotesToCache.length} emotes`);
    await cacheEmotes(emotesToCache);
  }
}

// Get local URL for an emote if cached
export function getCachedEmoteUrl(id: string): string | undefined {
  const path = cachedEmoteFiles.get(id);
  return path ? convertFileSrc(path) : undefined;
}

export async function fetchBTTVEmotes(_channelName?: string, channelId?: string): Promise<Emote[]> {
  try {
    const emotes: Emote[] = [];

    // Fetch cached files map
    let cachedFiles: Record<string, string> = {};
    try {
      console.log('[EmoteService] Requesting cached files list for BTTV...');
      cachedFiles = await invoke('get_cached_files', { cacheType: 'emote' });
      console.log(`[EmoteService] Received ${Object.keys(cachedFiles).length} cached files for BTTV`);
    } catch (e) {
      console.warn('Failed to get cached files:', e);
    }

    // Fetch global BTTV emotes
    const globalResponse = await fetch('https://api.betterttv.net/3/cached/emotes/global');
    if (globalResponse.ok) {
      const globalData = await globalResponse.json();
      emotes.push(...globalData.map((emote: any) => {
        const localPath = cachedFiles[emote.id];
        if (localPath) console.debug(`[BTTV] Cache hit for ${emote.code}: ${localPath}`);
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
        // Use the Twitch user ID (providerId) as required by the API
        const userResponse = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`);
        if (userResponse.ok) {
          const userData = await userResponse.json();
          if (userData.channelEmotes) {
            emotes.push(...userData.channelEmotes.map((emote: any) => {
              const localPath = cachedFiles[emote.id];
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
              const localPath = cachedFiles[emote.id];
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

    // Trigger background caching
    cacheEmotes(emotes).catch(e => console.error('Background caching failed:', e));

    return emotes;
  } catch (error) {
    console.error('Failed to fetch BTTV emotes:', error);
    return [];
  }
}

export async function fetch7TVEmotes(_channelName?: string, channelId?: string): Promise<Emote[]> {
  try {
    const emotes: Emote[] = [];

    // Fetch cached files map
    let cachedFiles: Record<string, string> = {};
    try {
      console.log('[EmoteService] Requesting cached files list for 7TV...');
      cachedFiles = await invoke('get_cached_files', { cacheType: 'emote' });
      console.log(`[EmoteService] Received ${Object.keys(cachedFiles).length} cached files for 7TV`);
    } catch (e) {
      console.warn('Failed to get cached files:', e);
    }

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
        perPage: 300, // Get top 300 trending emotes
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
          const localPath = cachedFiles[emote.id];
          if (localPath) console.debug(`[7TV] Cache hit for ${emote.name}: ${localPath}`);
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
            const localPath = cachedFiles[emote.id];
            if (localPath) console.debug(`[7TV] Cache hit for ${emote.name}: ${localPath}`);
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
    // The 7TV API requires the Twitch user ID, not the username
    if (channelId) {
      try {
        // Get user data which includes the emote_set with emotes array
        // Use the Twitch user ID instead of username
        const userResponse = await fetch(`https://7tv.io/v3/users/twitch/${channelId}`);
        if (userResponse.ok) {
          const userData = await userResponse.json();

          console.log(`[7TV] Fetched user data for channel ID ${channelId}:`, {
            username: userData.username,
            emote_set_id: userData.emote_set_id,
            has_emote_set: !!userData.emote_set
          });

          // The emote_set object contains both the ID and the emotes array
          const emoteSet = userData.emote_set;
          if (emoteSet?.emotes && Array.isArray(emoteSet.emotes)) {
            console.log(`[7TV] Found ${emoteSet.emotes.length} emotes in emote set ${emoteSet.id}`);

            // Parse emotes from the emote_set.emotes array
            // Each item has: { id, name, flags, data: { host: { url, files: [...] } } }
            emotes.push(...emoteSet.emotes.map((activeEmote: any) => {
              // The emote data structure has the actual emote info
              const emoteData = activeEmote.data || activeEmote;
              const emoteId = emoteData.id || activeEmote.id;
              const localPath = cachedFiles[emoteId];
              if (localPath) console.debug(`[7TV] Cache hit for ${activeEmote.name}: ${localPath}`);

              return {
                id: emoteId,
                name: activeEmote.name,
                url: `https://cdn.7tv.app/emote/${emoteId}/1x.webp`,
                provider: '7tv' as const,
                isZeroWidth: (activeEmote.flags & 256) === 256,
                localUrl: localPath ? convertFileSrc(localPath) : undefined
              };
            }));

            console.log(`[7TV] Successfully parsed ${emoteSet.emotes.length} channel emotes`);
          } else {
            console.log(`[7TV] No emotes found in emote_set for channel ID ${channelId}`);
          }
        } else {
          console.warn(`[7TV] Failed to fetch user data: ${userResponse.status} ${userResponse.statusText}`);
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

    // Trigger background caching
    cacheEmotes(uniqueEmotes).catch(e => console.error('Background caching failed:', e));

    return uniqueEmotes;
  } catch (error) {
    console.error('Failed to fetch 7TV emotes:', error);
    return [];
  }
}

export async function fetchFFZEmotes(channelName?: string): Promise<Emote[]> {
  try {
    const emotes: Emote[] = [];

    // Fetch cached files map
    let cachedFiles: Record<string, string> = {};
    try {
      console.log('[EmoteService] Requesting cached files list for FFZ...');
      cachedFiles = await invoke('get_cached_files', { cacheType: 'emote' });
      console.log(`[EmoteService] Received ${Object.keys(cachedFiles).length} cached files for FFZ`);
    } catch (e) {
      console.warn('Failed to get cached files:', e);
    }

    // Fetch global FFZ emotes
    const globalResponse = await fetch('https://api.frankerfacez.com/v1/set/global');
    if (globalResponse.ok) {
      const globalData = await globalResponse.json();
      if (globalData.sets) {
        Object.values(globalData.sets).forEach((set: any) => {
          if (set.emoticons) {
            emotes.push(...set.emoticons.map((emote: any) => {
              const localPath = cachedFiles[emote.id.toString()];
              if (localPath) console.debug(`[FFZ] Cache hit for ${emote.name}: ${localPath}`);
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
                  const localPath = cachedFiles[emote.id.toString()];
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

    // Trigger background caching
    cacheEmotes(emotes).catch(e => console.error('Background caching failed:', e));

    return emotes;
  } catch (error) {
    console.error('Failed to fetch FFZ emotes:', error);
    return [];
  }
}

export async function fetchAllEmotes(channelName?: string, channelId?: string): Promise<EmoteSet> {
  // Check memory cache first
  const now = Date.now();
  if (emoteCache && (now - cacheTimestamp) < CACHE_DURATION) {
    return emoteCache;
  }

  console.log('[EmoteService] Fetching emotes for channel:', channelName, 'ID:', channelId);

  // Fetch all emotes in parallel
  const [bttvEmotes, sevenTVEmotes, ffzEmotes] = await Promise.all([
    fetchBTTVEmotes(channelName, channelId),
    fetch7TVEmotes(channelName, channelId),
    fetchFFZEmotes(channelName)
  ]);

  // Fetch cached files for global emotes
  let cachedFiles: Record<string, string> = {};
  try {
    console.log('[EmoteService] Requesting cached files list for Global/All...');
    cachedFiles = await invoke('get_cached_files', { cacheType: 'emote' });
    console.log(`[EmoteService] Received ${Object.keys(cachedFiles).length} cached files for Global/All`);

    if (Object.keys(cachedFiles).length === 0) {
      console.log('[EmoteService] WARNING: Cache is empty! This explains why images are re-downloading. Check backend paths.');
    }

    const firstKey = Object.keys(cachedFiles)[0];
    if (firstKey) {
      console.log(`[EmoteService] Sample path conversion: ${cachedFiles[firstKey]} -> ${convertFileSrc(cachedFiles[firstKey])}`);
    }

    // Populate module-level registry
    Object.entries(cachedFiles).forEach(([id, path]) => {
      cachedEmoteFiles.set(id, path);
    });
  } catch (e) {
    console.warn('Failed to get cached files:', e);
  }

  // Process global Twitch emotes with cache
  const twitchEmotes = GLOBAL_TWITCH_EMOTES.map(emote => {
    const localPath = cachedFiles[emote.id];
    return {
      ...emote,
      localUrl: localPath ? convertFileSrc(localPath) : undefined
    };
  });

  // Trigger background caching for global emotes
  cacheEmotes(twitchEmotes).catch(e => console.error('Background caching failed for global emotes:', e));

  // Combine all emotes
  const allEmotes = [
    ...twitchEmotes,
    ...bttvEmotes,
    ...sevenTVEmotes,
    ...ffzEmotes
  ];

  // Try to load cached emotes and merge with fetched ones
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const settings = await invoke('load_settings') as any;

    if (settings.cache?.enabled) {
      const expiryDays = settings.cache?.expiry_days || 7;

      // Load cached emotes and filter out ones we already have
      const cachedEmotes: Emote[] = [];
      const fetchedEmoteIds = new Set(allEmotes.map(e => e.id));

      // Check cache for each emote we fetched and save new ones
      for (const emote of allEmotes) {
        try {
          const cached = await invoke('load_emote_by_id', { emoteId: emote.id }) as string | null;
          if (!cached) {
            // Save new emote to cache
            await invoke('save_emote_by_id', {
              emoteId: emote.id,
              data: JSON.stringify(emote),
              expiryDays
            });
          }
        } catch (e) {
          // Ignore individual cache errors
        }
      }

      console.log('[EmoteService] Cached emotes by ID');
    }
  } catch (e) {
    console.warn('[EmoteService] Failed to process emote cache:', e);
  }

  const emoteSet: EmoteSet = {
    twitch: twitchEmotes,
    bttv: bttvEmotes,
    '7tv': sevenTVEmotes,
    ffz: ffzEmotes
  };

  // Update memory cache
  emoteCache = emoteSet;
  cacheTimestamp = now;

  console.log('[EmoteService] Fetched emotes:', {
    twitch: emoteSet.twitch.length,
    bttv: emoteSet.bttv.length,
    '7tv': emoteSet['7tv'].length,
    ffz: emoteSet.ffz.length
  });

  return emoteSet;
}

export function clearEmoteCache() {
  emoteCache = null;
  cacheTimestamp = 0;
}
