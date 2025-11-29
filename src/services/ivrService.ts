// IVR API Service for fetching additional Twitch user data
// API Documentation: https://api.ivr.fi

interface IVRUserData {
    id: string;
    login: string;
    displayName: string;
    createdAt: string;
    roles: {
        isAffiliate: boolean;
        isPartner: boolean;
        isSiteAdmin: boolean;
        isStaff: boolean;
    };
    profileImageUrl: string;
    banned: boolean;
    banReason: string | null;
    chatColor: string;
    emotePrefix: string | null;
    followers: number;
}

interface IVRSubageData {
    user: {
        id: string;
        login: string;
        displayName: string;
    };
    channel: {
        id: string;
        login: string;
        displayName: string;
    };
    statusHidden: boolean;
    followedAt: string | null;
    subscriber: boolean;
    subscriptionTier: number | null;
    cumulative: {
        months: number;
    } | null;
    streak: {
        months: number;
    } | null;
    gift: boolean;
    founder: boolean;
    giftCount: number | null;
    meta: {
        subMonths: number;
        subStreak: number;
        subGiftCount: number;
    } | null;
}

interface IVRModVipData {
    id: string;
    login: string;
    displayName: string;
    isMod: boolean;
    isVip: boolean;
    modGrantedAt: string | null;
    vipGrantedAt: string | null;
}

export interface IVRProfileData {
    createdAt: string | null;
    followingSince: string | null;
    statusHidden: boolean;
    isSubscribed: boolean;
    subStreak: number | null;
    subCumulative: number | null;
    isFounder: boolean;
    isMod: boolean;
    modSince: string | null;
    isVip: boolean;
    vipSince: string | null;
    isLoading: boolean;
    error: string | null;
}

export interface IVRRecentMessage {
    id: string;
    timestamp: string;
    user: {
        id: string;
        login: string;
        displayName: string;
        chatColor: string | null;
    };
    message: string;
    badges: Array<{
        setID: string;
        version: string;
        title: string;
    }>;
    emotes: Array<{
        id: string;
        name: string;
        positions: Array<{ start: number; end: number }>;
    }>;
}

// Cache for IVR API results
interface CacheEntry<T> {
    data: T;
    timestamp: number;
}

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache
const RECENT_MESSAGES_CACHE_DURATION = 30 * 1000; // 30 seconds cache for recent messages
const userDataCache = new Map<string, CacheEntry<IVRUserData | null>>();
const subageCache = new Map<string, CacheEntry<IVRSubageData | null>>();
const modVipCache = new Map<string, CacheEntry<IVRModVipData | null>>();
const recentMessagesCache = new Map<string, CacheEntry<string[] | null>>();

/**
 * Fetches user data from IVR API
 * @param username - The Twitch username to look up
 * @returns User data or null if not found
 */
export async function fetchIVRUserData(username: string): Promise<IVRUserData | null> {
    const cacheKey = username.toLowerCase();
    const cached = userDataCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        console.log('[IVR] Using cached user data for:', username);
        return cached.data;
    }

    try {
        console.log('[IVR] Fetching user data for:', username);
        const response = await fetch(`https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(username)}`);

        if (!response.ok) {
            console.error('[IVR] API error:', response.status, response.statusText);
            userDataCache.set(cacheKey, { data: null, timestamp: Date.now() });
            return null;
        }

        const data = await response.json();

        // API returns an array, get first result
        if (Array.isArray(data) && data.length > 0) {
            const userData = data[0] as IVRUserData;
            userDataCache.set(cacheKey, { data: userData, timestamp: Date.now() });
            return userData;
        }

        userDataCache.set(cacheKey, { data: null, timestamp: Date.now() });
        return null;
    } catch (error) {
        console.error('[IVR] Failed to fetch user data:', error);
        return null;
    }
}

/**
 * Fetches subage/follow data from IVR API
 * @param username - The Twitch username to look up
 * @param channel - The channel to check following status for
 * @returns Subage data or null if not found
 */
export async function fetchIVRSubage(username: string, channel: string): Promise<IVRSubageData | null> {
    const cacheKey = `${username.toLowerCase()}:${channel.toLowerCase()}`;
    const cached = subageCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        console.log('[IVR] Using cached subage data for:', username, 'in', channel);
        return cached.data;
    }

    try {
        console.log('[IVR] Fetching subage data for:', username, 'in', channel);
        const response = await fetch(
            `https://api.ivr.fi/v2/twitch/subage/${encodeURIComponent(username)}/${encodeURIComponent(channel)}`
        );

        if (!response.ok) {
            console.error('[IVR] Subage API error:', response.status, response.statusText);
            subageCache.set(cacheKey, { data: null, timestamp: Date.now() });
            return null;
        }

        const data = await response.json() as IVRSubageData;
        subageCache.set(cacheKey, { data, timestamp: Date.now() });
        return data;
    } catch (error) {
        console.error('[IVR] Failed to fetch subage data:', error);
        return null;
    }
}

/**
 * Fetches mod/VIP status from IVR API
 * @param username - The Twitch username to look up
 * @param channel - The channel to check mod/VIP status for
 * @returns Mod/VIP data or null if not found
 */
export async function fetchIVRModVip(username: string, channel: string): Promise<IVRModVipData | null> {
    const cacheKey = `${username.toLowerCase()}:${channel.toLowerCase()}`;
    const cached = modVipCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        console.log('[IVR] Using cached mod/vip data for:', username, 'in', channel);
        return cached.data;
    }

    try {
        console.log('[IVR] Fetching mod/vip data for:', username, 'in', channel);
        const response = await fetch(
            `https://api.ivr.fi/v2/twitch/modvip/${encodeURIComponent(channel)}?login=${encodeURIComponent(username)}`
        );

        if (!response.ok) {
            // 404 means user is not a mod/vip, which is normal
            if (response.status === 404) {
                const emptyData: IVRModVipData = {
                    id: '',
                    login: username,
                    displayName: username,
                    isMod: false,
                    isVip: false,
                    modGrantedAt: null,
                    vipGrantedAt: null
                };
                modVipCache.set(cacheKey, { data: emptyData, timestamp: Date.now() });
                return emptyData;
            }
            console.error('[IVR] ModVip API error:', response.status, response.statusText);
            modVipCache.set(cacheKey, { data: null, timestamp: Date.now() });
            return null;
        }

        const data = await response.json();

        // API returns an array of mods/vips, find our user
        if (Array.isArray(data)) {
            const userData = data.find((u: any) => u.login?.toLowerCase() === username.toLowerCase());
            if (userData) {
                const modVipData: IVRModVipData = {
                    id: userData.id || '',
                    login: userData.login || username,
                    displayName: userData.displayName || username,
                    isMod: userData.isMod || false,
                    isVip: userData.isVip || false,
                    modGrantedAt: userData.grantedAt && userData.isMod ? userData.grantedAt : null,
                    vipGrantedAt: userData.grantedAt && userData.isVip ? userData.grantedAt : null
                };
                modVipCache.set(cacheKey, { data: modVipData, timestamp: Date.now() });
                return modVipData;
            }
        }

        // User not in the list means they're not a mod/vip
        const emptyData: IVRModVipData = {
            id: '',
            login: username,
            displayName: username,
            isMod: false,
            isVip: false,
            modGrantedAt: null,
            vipGrantedAt: null
        };
        modVipCache.set(cacheKey, { data: emptyData, timestamp: Date.now() });
        return emptyData;
    } catch (error) {
        console.error('[IVR] Failed to fetch mod/vip data:', error);
        return null;
    }
}

/**
 * Fetches recent chat messages from recent-messages API (robotty.de)
 * @param channel - The channel to fetch messages for
 * @returns Array of raw IRC message strings
 */
export async function fetchRecentMessages(channel: string): Promise<string[]> {
    const cacheKey = channel.toLowerCase();
    const cached = recentMessagesCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < RECENT_MESSAGES_CACHE_DURATION) {
        console.log('[RecentMessages] Using cached recent messages for:', channel);
        return cached.data || [];
    }

    try {
        console.log('[RecentMessages] Fetching recent messages for:', channel);
        // Use the robotty.de recent-messages API which returns raw IRC messages
        const response = await fetch(
            `https://recent-messages.robotty.de/api/v2/recent-messages/${encodeURIComponent(channel)}?hide_moderation_messages=true&hide_moderated_messages=true`
        );

        if (!response.ok) {
            console.error('[RecentMessages] API error:', response.status, response.statusText);
            recentMessagesCache.set(cacheKey, { data: null, timestamp: Date.now() });
            return [];
        }

        const data = await response.json();

        // API returns { messages: [...] } where messages are raw IRC strings
        if (data && Array.isArray(data.messages)) {
            const messages = data.messages as string[];
            // Mark each message as historical by appending a tag
            const historicalMessages = messages.map(msg => {
                // Insert historical=1 tag into the IRC message
                if (msg.startsWith('@')) {
                    return msg.replace(/^@/, '@historical=1;');
                }
                return `@historical=1 ${msg}`;
            });
            recentMessagesCache.set(cacheKey, { data: historicalMessages, timestamp: Date.now() });
            console.log('[RecentMessages] Fetched', historicalMessages.length, 'recent messages');
            return historicalMessages;
        }

        recentMessagesCache.set(cacheKey, { data: [], timestamp: Date.now() });
        return [];
    } catch (error) {
        console.error('[RecentMessages] Failed to fetch recent messages:', error);
        return [];
    }
}

/**
 * Converts IVR recent message to IRC format for display
 * @param msg - IVR message object
 * @param channel - Channel name
 * @param roomId - Channel/room ID
 * @returns IRC-formatted message string
 */
export function convertIVRMessageToIRC(msg: IVRRecentMessage, channel: string, roomId: string): string {
    // Build badges string (e.g., "subscriber/12,premium/1")
    const badgesStr = msg.badges.map(b => `${b.setID}/${b.version}`).join(',');

    // Build emotes string (e.g., "25:0-4,12-16/1902:6-10")
    const emotesStr = msg.emotes.map(e => {
        const positions = e.positions.map(p => `${p.start}-${p.end}`).join(',');
        return `${e.id}:${positions}`;
    }).join('/');

    // Parse timestamp to tmi-sent-ts format (milliseconds)
    const timestamp = new Date(msg.timestamp).getTime();

    // Build IRC message format
    const color = msg.user.chatColor || '';
    const tags = [
        `badge-info=`,
        `badges=${badgesStr}`,
        `color=${color}`,
        `display-name=${msg.user.displayName}`,
        `emotes=${emotesStr}`,
        `first-msg=0`,
        `flags=`,
        `id=${msg.id}`,
        `mod=0`,
        `returning-chatter=0`,
        `room-id=${roomId}`,
        `subscriber=0`,
        `tmi-sent-ts=${timestamp}`,
        `turbo=0`,
        `user-id=${msg.user.id}`,
        `user-type=`,
        `historical=1` // Mark as historical message from IVR
    ].join(';');

    const prefix = `:${msg.user.login}!${msg.user.login}@${msg.user.login}.tmi.twitch.tv`;
    const command = `PRIVMSG #${channel}`;
    const content = `:${msg.message}`;

    return `@${tags} ${prefix} ${command} ${content}`;
}

/**
 * Fetches recent messages (already in IRC format from robotty.de API)
 * @param channel - Channel name
 * @param _roomId - Channel/room ID (not used, kept for API compatibility)
 * @returns Array of IRC-formatted message strings
 */
export async function fetchRecentMessagesAsIRC(channel: string, _roomId: string): Promise<string[]> {
    // The robotty.de API already returns raw IRC messages, so just fetch them directly
    return fetchRecentMessages(channel);
}

/**
 * Formats a date string into a human-readable format
 * @param dateString - ISO date string
 * @param includeRelative - Whether to include relative time (e.g., "5 years ago")
 * @returns Formatted date string
 */
export function formatIVRDate(dateString: string, includeRelative: boolean = true): string {
    try {
        const date = new Date(dateString);
        const now = new Date();

        // Format the absolute date
        const absoluteDate = date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });

        if (!includeRelative) {
            return absoluteDate;
        }

        // Calculate relative time
        const diffMs = now.getTime() - date.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        const diffMonths = Math.floor(diffDays / 30);
        const diffYears = Math.floor(diffDays / 365);

        let relativeTime: string;
        if (diffYears > 0) {
            relativeTime = diffYears === 1 ? '1 year ago' : `${diffYears} years ago`;
        } else if (diffMonths > 0) {
            relativeTime = diffMonths === 1 ? '1 month ago' : `${diffMonths} months ago`;
        } else if (diffDays > 0) {
            relativeTime = diffDays === 1 ? '1 day ago' : `${diffDays} days ago`;
        } else {
            relativeTime = 'today';
        }

        return `${absoluteDate} (${relativeTime})`;
    } catch (error) {
        console.error('[IVR] Failed to format date:', error);
        return dateString;
    }
}

/**
 * Formats subscription tenure with streak and cumulative months
 * @param streak - Current streak months
 * @param cumulative - Total cumulative months
 * @returns Formatted tenure string
 */
export function formatSubTenure(streak: number | null, cumulative: number | null): string {
    if (streak === null && cumulative === null) return '';
    if (streak === null) return `${cumulative} months`;
    if (cumulative === null) return `${streak} months`;

    if (streak === cumulative) {
        return `${streak} ${streak === 1 ? 'month' : 'months'}`;
    }

    return `${streak} ${streak === 1 ? 'month' : 'months'} (${cumulative} cumulative)`;
}

/**
 * Clears the IVR cache
 */
export function clearIVRCache(): void {
    userDataCache.clear();
    subageCache.clear();
    modVipCache.clear();
    recentMessagesCache.clear();
    console.log('[IVR] Cache cleared');
}

/**
 * Gets the current cache size
 */
export function getIVRCacheSize(): { users: number; subages: number; modVips: number; recentMessages: number } {
    return {
        users: userDataCache.size,
        subages: subageCache.size,
        modVips: modVipCache.size,
        recentMessages: recentMessagesCache.size
    };
}
