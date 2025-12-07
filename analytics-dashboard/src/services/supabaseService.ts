import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

// Define types locally since we can't import from the parent project comfortably
export interface TwitchUser {
    access_token: string;
    username: string;
    user_id: string;
    login?: string;
    display_name?: string;
    profile_image_url?: string;
    broadcaster_type?: string;
}

// Supabase client singleton
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Only initialize if credentials are provided
const isConfigured = supabaseUrl && supabaseAnonKey &&
    supabaseUrl !== 'your_supabase_url_here' &&
    supabaseAnonKey !== 'your_supabase_anon_key_here';

let supabase: SupabaseClient | null = null;

if (isConfigured) {
    supabase = createClient(supabaseUrl, supabaseAnonKey);
    console.log('[Supabase] Client initialized');
} else {
    console.warn('[Supabase] Not configured - analytics features disabled. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env');
}

// Presence channel reference
let presenceChannel: RealtimeChannel | null = null;

// Type for presence payload
interface PresencePayload {
    user_id?: string;
    display_name?: string;
    app_version?: string;
    online_at: string;
}

/**
 * Get the Supabase client instance
 */
export const getSupabaseClient = (): SupabaseClient | null => supabase;

/**
 * Check if Supabase is configured and ready to use
 */
export const isSupabaseConfigured = (): boolean => !!isConfigured;

/**
 * Get the current count of online users via presence
 * @returns Current online user count
 */
export const getOnlineCount = (): number => {
    if (!presenceChannel) {
        return 0;
    }

    const state = presenceChannel.presenceState();
    return Object.keys(state).length;
};

/**
 * Get the list of online user IDs (extracts user_id from presence state data)
 * @returns Array of online user IDs
 */
export const getOnlineUserIds = (): string[] => {
    if (!presenceChannel) {
        return [];
    }
    const state = presenceChannel.presenceState<PresencePayload>();
    const userIds: string[] = [];

    // Iterate through presence state and extract user_id from each presence
    Object.values(state).forEach((presenceArray) => {
        if (Array.isArray(presenceArray)) {
            presenceArray.forEach((presence) => {
                if (presence.user_id) {
                    userIds.push(presence.user_id);
                }
            });
        }
    });

    return userIds;
};

/**
 * Get detailed online user info including app version
 * @returns Map of user_id to presence data (display_name, app_version, online_at)
 */
export const getOnlineUsersInfo = (): Map<string, { display_name?: string; app_version?: string; online_at: string }> => {
    const info = new Map<string, { display_name?: string; app_version?: string; online_at: string }>();

    if (!presenceChannel) {
        return info;
    }

    const state = presenceChannel.presenceState<PresencePayload>();

    Object.values(state).forEach((presenceArray) => {
        if (Array.isArray(presenceArray)) {
            presenceArray.forEach((presence) => {
                if (presence.user_id) {
                    info.set(presence.user_id, {
                        display_name: presence.display_name,
                        app_version: presence.app_version,
                        online_at: presence.online_at
                    });
                }
            });
        }
    });

    return info;
};

/**
 * Subscribe to online count changes
 * @param callback - Function to call when online count changes
 * @returns Unsubscribe function
 */
export const subscribeToOnlineCount = (
    callback: (count: number) => void
): (() => void) | null => {
    // For the dashboard, we want to subscribe to the global presence channel even if we aren't tracking our OWN presence
    if (!supabase) return null;

    // Listen for presence changes
    const handleSync = () => {
        const count = getOnlineCount();
        const onlineIds = getOnlineUserIds();
        console.log('[Supabase] Presence sync - online count:', count, 'user IDs:', onlineIds);
        callback(count);
    };

    if (!presenceChannel) {
        presenceChannel = supabase.channel('global-presence', {
            config: {
                presence: {
                    key: 'dashboard_observer_' + Date.now(),
                },
            },
        });

        // IMPORTANT: Set up event handlers BEFORE subscribing
        presenceChannel
            .on('presence', { event: 'sync' }, handleSync)
            .on('presence', { event: 'join' }, ({ key, newPresences }) => {
                console.log('[Supabase] User joined:', key, newPresences);
                handleSync();
            })
            .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
                console.log('[Supabase] User left:', key, leftPresences);
                handleSync();
            })
            .subscribe(async (status) => {
                if (status === 'SUBSCRIBED') {
                    console.log('[Supabase] Dashboard subscribed to presence');
                    // Get initial state after subscription is complete
                    handleSync();
                }
            });
    } else {
        // Channel already exists, just get current count
        handleSync();
    }

    // Return unsubscribe function
    return () => {
        if (presenceChannel) {
            presenceChannel.unsubscribe();
            presenceChannel = null;
        }
    };
};

// Type for user data returned from database
export interface SupabaseUser {
    id: string;
    username: string;
    display_name: string;
    avatar_url: string | null;
    last_seen: string;
    created_at: string;
    app_version?: string;
}

// Type for user stats
export interface UserStats {
    user_id: string;
    channel_points_farmed: number;
    hours_watched: number;
    messages_sent: number;
    streams_watched: number;
    updated_at: string;
}

// Type for user with stats combined
export interface UserWithStats extends SupabaseUser {
    stats?: UserStats;
}

// Type for global stats
export interface GlobalStats {
    total_channel_points: number;
    total_hours_watched: number;
    total_messages_sent: number;
    total_streams_watched: number;
}

/**
 * Get all users from the database
 * @returns Array of all users
 */
export const getAllUsers = async (): Promise<SupabaseUser[]> => {
    if (!supabase) {
        return [];
    }

    try {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .order('last_seen', { ascending: false });

        if (error) {
            console.error('[Supabase] Failed to get all users:', error);
            return [];
        }

        return (data as SupabaseUser[]) || [];
    } catch (error) {
        console.error('[Supabase] Failed to get all users:', error);
        return [];
    }
};

/**
 * Get global stats (sum of all users)
 * @returns Global stats
 */
export const getGlobalStats = async (): Promise<GlobalStats> => {
    if (!supabase) {
        return {
            total_channel_points: 0,
            total_hours_watched: 0,
            total_messages_sent: 0,
            total_streams_watched: 0
        };
    }

    try {
        const { data, error } = await supabase
            .from('user_stats')
            .select('channel_points_farmed, hours_watched, messages_sent, streams_watched');

        if (error) {
            console.error('[Supabase] Failed to get global stats:', error);
            return {
                total_channel_points: 0,
                total_hours_watched: 0,
                total_messages_sent: 0,
                total_streams_watched: 0
            };
        }

        // Sum up all stats
        const stats = (data || []).reduce((acc, row) => ({
            total_channel_points: acc.total_channel_points + (row.channel_points_farmed || 0),
            total_hours_watched: acc.total_hours_watched + (row.hours_watched || 0),
            total_messages_sent: acc.total_messages_sent + (row.messages_sent || 0),
            total_streams_watched: acc.total_streams_watched + (row.streams_watched || 0)
        }), {
            total_channel_points: 0,
            total_hours_watched: 0,
            total_messages_sent: 0,
            total_streams_watched: 0
        });

        return stats;
    } catch (error) {
        console.error('[Supabase] Failed to get global stats:', error);
        return {
            total_channel_points: 0,
            total_hours_watched: 0,
            total_messages_sent: 0,
            total_streams_watched: 0
        };
    }
};

/**
 * Get all users with their stats
 * @returns Array of users with stats
 */
export const getAllUsersWithStats = async (): Promise<UserWithStats[]> => {
    if (!supabase) {
        return [];
    }

    try {
        // Get all users
        const { data: users, error: usersError } = await supabase
            .from('users')
            .select('*')
            .order('last_seen', { ascending: false });

        if (usersError) {
            console.error('[Supabase] Failed to get users:', usersError);
            return [];
        }

        // Get all stats
        const { data: stats, error: statsError } = await supabase
            .from('user_stats')
            .select('*');

        if (statsError && statsError.code !== 'PGRST116') {
            console.error('[Supabase] Failed to get stats:', statsError);
        }

        // Create a map of stats by user_id
        const statsMap = new Map<string, UserStats>();
        (stats || []).forEach((stat: UserStats) => {
            statsMap.set(stat.user_id, stat);
        });

        // Combine users with stats
        const usersWithStats: UserWithStats[] = (users || []).map((user: SupabaseUser) => ({
            ...user,
            stats: statsMap.get(user.id)
        }));

        return usersWithStats;
    } catch (error) {
        console.error('[Supabase] Failed to get users with stats:', error);
        return [];
    }
};

/**
 * Subscribe to real-time changes in user stats
 * @param callback - Function to call when stats change
 * @returns Unsubscribe function
 */
export const subscribeToStatsChanges = (
    callback: (users: UserWithStats[], globalStats: GlobalStats) => void
): (() => void) | null => {
    if (!supabase) {
        return null;
    }

    // Get initial data
    const fetchData = async () => {
        const users = await getAllUsersWithStats();
        const globalStats = await getGlobalStats();
        callback(users, globalStats);
    };

    fetchData();

    // Subscribe to changes on both tables
    const channel = supabase
        .channel('stats-changes')
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'user_stats',
            },
            async () => {
                await fetchData();
            }
        )
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'users',
            },
            async () => {
                await fetchData();
            }
        )
        .subscribe();

    // Return unsubscribe function
    return () => {
        channel.unsubscribe();
    };
};
