// Emote service to fetch emotes from multiple providers
export interface Emote {
  id: string;
  name: string;
  url: string;
  provider: 'twitch' | 'bttv' | '7tv' | 'ffz';
  isZeroWidth?: boolean;
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

export async function fetchBTTVEmotes(channelName?: string, channelId?: string): Promise<Emote[]> {
  try {
    const emotes: Emote[] = [];
    
    // Fetch global BTTV emotes
    const globalResponse = await fetch('https://api.betterttv.net/3/cached/emotes/global');
    if (globalResponse.ok) {
      const globalData = await globalResponse.json();
      emotes.push(...globalData.map((emote: any) => ({
        id: emote.id,
        name: emote.code,
        url: `https://cdn.betterttv.net/emote/${emote.id}/1x`,
        provider: 'bttv' as const,
        isZeroWidth: emote.imageType === 'gif'
      })));
    }
    
    // Fetch channel-specific BTTV emotes if channel ID is provided
    if (channelId) {
      try {
        // Use the Twitch user ID (providerId) as required by the API
        const userResponse = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`);
        if (userResponse.ok) {
          const userData = await userResponse.json();
          if (userData.channelEmotes) {
            emotes.push(...userData.channelEmotes.map((emote: any) => ({
              id: emote.id,
              name: emote.code,
              url: `https://cdn.betterttv.net/emote/${emote.id}/1x`,
              provider: 'bttv' as const,
              isZeroWidth: emote.imageType === 'gif'
            })));
          }
          if (userData.sharedEmotes) {
            emotes.push(...userData.sharedEmotes.map((emote: any) => ({
              id: emote.id,
              name: emote.code,
              url: `https://cdn.betterttv.net/emote/${emote.id}/1x`,
              provider: 'bttv' as const,
              isZeroWidth: emote.imageType === 'gif'
            })));
          }
        }
      } catch (err) {
        console.warn('Failed to fetch channel BTTV emotes:', err);
      }
    }
    
    return emotes;
  } catch (error) {
    console.error('Failed to fetch BTTV emotes:', error);
    return [];
  }
}

export async function fetch7TVEmotes(_channelName?: string, channelId?: string): Promise<Emote[]> {
  try {
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
        emotes.push(...items.map((emote: any) => ({
          id: emote.id,
          name: emote.name,
          url: `https://cdn.7tv.app/emote/${emote.id}/1x.webp`,
          provider: '7tv' as const,
          isZeroWidth: emote.flags === 256
        })));
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
          emotes.push(...globalData.emotes.map((emote: any) => ({
            id: emote.id,
            name: emote.name,
            url: `https://cdn.7tv.app/emote/${emote.id}/1x.webp`,
            provider: '7tv' as const,
            isZeroWidth: emote.flags === 256
          })));
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
              
              return {
                id: emoteId,
                name: activeEmote.name,
                url: `https://cdn.7tv.app/emote/${emoteId}/1x.webp`,
                provider: '7tv' as const,
                isZeroWidth: (activeEmote.flags & 256) === 256
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
    
    return uniqueEmotes;
  } catch (error) {
    console.error('Failed to fetch 7TV emotes:', error);
    return [];
  }
}

export async function fetchFFZEmotes(channelName?: string): Promise<Emote[]> {
  try {
    const emotes: Emote[] = [];
    
    // Fetch global FFZ emotes
    const globalResponse = await fetch('https://api.frankerfacez.com/v1/set/global');
    if (globalResponse.ok) {
      const globalData = await globalResponse.json();
      if (globalData.sets) {
        Object.values(globalData.sets).forEach((set: any) => {
          if (set.emoticons) {
            emotes.push(...set.emoticons.map((emote: any) => ({
              id: emote.id.toString(),
              name: emote.name,
              url: emote.urls['1'] || `https://cdn.frankerfacez.com/emote/${emote.id}/1`,
              provider: 'ffz' as const
            })));
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
                emotes.push(...set.emoticons.map((emote: any) => ({
                  id: emote.id.toString(),
                  name: emote.name,
                  url: emote.urls['1'] || `https://cdn.frankerfacez.com/emote/${emote.id}/1`,
                  provider: 'ffz' as const
                })));
              }
            });
          }
        }
      } catch (err) {
        console.warn('Failed to fetch channel FFZ emotes:', err);
      }
    }
    
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
  
  // Combine all emotes
  const allEmotes = [
    ...GLOBAL_TWITCH_EMOTES,
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
    twitch: GLOBAL_TWITCH_EMOTES,
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
