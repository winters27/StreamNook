import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { TwitchUser } from '../types';

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
let currentPresenceKey: string | null = null;

// Types for presence tracking
interface PresenceState {
    online_at: string;
    user_id?: string;
    display_name?: string;
    app_version?: string;
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
 * Track user presence in the app
 * @param userId - Optional Twitch user ID for logged-in users
 * @param displayName - Optional display name for logged-in users
 * @param appVersion - Optional app version
 * @returns Unsubscribe function to clean up presence on unmount
 */
export const trackPresence = async (
    userId?: string,
    displayName?: string,
    appVersion?: string
): Promise<(() => void) | null> => {
    if (!supabase) {
        console.log('[Supabase] Skipping presence tracking - not configured');
        return null;
    }

    try {
        // Clean up existing presence if any
        if (presenceChannel) {
            await presenceChannel.unsubscribe();
            presenceChannel = null;
        }

        // Create a unique key for this presence session
        currentPresenceKey = userId || `anon_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Join the global presence channel
        presenceChannel = supabase.channel('global-presence', {
            config: {
                presence: {
                    key: currentPresenceKey,
                },
            },
        });

        // Set up presence state
        const presenceState: PresenceState = {
            online_at: new Date().toISOString(),
            ...(userId && { user_id: userId }),
            ...(displayName && { display_name: displayName }),
            ...(appVersion && { app_version: appVersion }),
        };

        // Subscribe and track presence
        presenceChannel
            .on('presence', { event: 'sync' }, () => {
                const state = presenceChannel?.presenceState();
                console.log('[Supabase] Presence sync:', Object.keys(state || {}).length, 'users online');
            })
            .on('presence', { event: 'join' }, ({ key, newPresences }) => {
                console.log('[Supabase] User joined:', key, newPresences);
            })
            .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
                console.log('[Supabase] User left:', key, leftPresences);
            })
            .subscribe(async (status) => {
                if (status === 'SUBSCRIBED') {
                    await presenceChannel?.track(presenceState);
                    console.log('[Supabase] Presence tracking started for:', currentPresenceKey);
                }
            });

        // Return cleanup function
        return () => {
            if (presenceChannel) {
                console.log('[Supabase] Cleaning up presence tracking');
                presenceChannel.unsubscribe();
                presenceChannel = null;
                currentPresenceKey = null;
            }
        };
    } catch (error) {
        console.error('[Supabase] Failed to track presence:', error);
        return null;
    }
};

/**
 * Update presence state when user logs in
 * @param userId - Twitch user ID
 * @param displayName - Display name
 * @param appVersion - App version
 */
export const updatePresence = async (userId: string, displayName: string, appVersion?: string): Promise<void> => {
    if (!supabase || !presenceChannel) {
        console.log('[Supabase] Skipping presence update - not configured or not tracking');
        return;
    }

    try {
        const presenceState: PresenceState = {
            online_at: new Date().toISOString(),
            user_id: userId,
            display_name: displayName,
            ...(appVersion && { app_version: appVersion }),
        };

        await presenceChannel.track(presenceState);
        console.log('[Supabase] Presence updated for user:', displayName);
    } catch (error) {
        console.error('[Supabase] Failed to update presence:', error);
    }
};

/**
 * Upsert user data to the users table on login
 * @param user - TwitchUser object
 * @param appVersion - Optional app version
 */
export const upsertUser = async (user: TwitchUser, appVersion?: string): Promise<void> => {
    if (!supabase) {
        console.log('[Supabase] Skipping user upsert - not configured');
        return;
    }

    try {
        const payload: any = {
            id: user.user_id,
            username: user.login || user.username,
            display_name: user.display_name || user.username,
            avatar_url: user.profile_image_url || null,
            last_seen: new Date().toISOString(),
        };

        if (appVersion) {
            payload.app_version = appVersion;
        }

        const { error } = await supabase
            .from('users')
            .upsert(payload, {
                onConflict: 'id',
            });

        if (error) {
            console.error('[Supabase] Failed to upsert user:', error);
            return;
        }

        console.log('[Supabase] User upserted:', user.display_name || user.username);

        // Also update presence with user info
        await updatePresence(user.user_id, user.display_name || user.username, appVersion);
    } catch (error) {
        console.error('[Supabase] Failed to upsert user:', error);
    }
};

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
 * Subscribe to online count changes
 * @param callback - Function to call when online count changes
 * @returns Unsubscribe function
 */
export const subscribeToOnlineCount = (
    callback: (count: number) => void
): (() => void) | null => {
    if (!presenceChannel) {
        console.log('[Supabase] Cannot subscribe to online count - not tracking presence');
        return null;
    }

    // Initial count
    callback(getOnlineCount());

    // Listen for presence changes
    const handleSync = () => {
        callback(getOnlineCount());
    };

    presenceChannel.on('presence', { event: 'sync' }, handleSync);

    // Return unsubscribe function
    return () => {
        // Note: Supabase doesn't have a removeListener, but unsubscribing the channel handles it
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
 * Subscribe to real-time changes in users table
 * @param callback - Function to call when users change
 * @returns Unsubscribe function
 */
export const subscribeToUsersChanges = (
    callback: (users: SupabaseUser[]) => void
): (() => void) | null => {
    if (!supabase) {
        return null;
    }

    // Get initial users
    getAllUsers().then(callback);

    // Subscribe to all changes on the users table
    const channel = supabase
        .channel('users-all-changes')
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'users',
            },
            async () => {
                const users = await getAllUsers();
                callback(users);
            }
        )
        .subscribe();

    // Return unsubscribe function
    return () => {
        channel.unsubscribe();
    };
};

/**
 * Get the total count of users from the database
 * @returns Total user count
 */
export const getTotalUsersCount = async (): Promise<number> => {
    if (!supabase) {
        return 0;
    }

    try {
        const { count, error } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true });

        if (error) {
            console.error('[Supabase] Failed to get total users count:', error);
            return 0;
        }

        return count || 0;
    } catch (error) {
        console.error('[Supabase] Failed to get total users count:', error);
        return 0;
    }
};

/**
 * Subscribe to real-time changes in total users count
 * @param callback - Function to call when count changes
 * @returns Unsubscribe function
 */
export const subscribeToTotalUsers = (
    callback: (count: number) => void
): (() => void) | null => {
    if (!supabase) {
        return null;
    }

    // Get initial count
    getTotalUsersCount().then(callback);

    // Subscribe to inserts on the users table
    const channel = supabase
        .channel('users-changes')
        .on(
            'postgres_changes',
            {
                event: 'INSERT',
                schema: 'public',
                table: 'users',
            },
            async () => {
                const count = await getTotalUsersCount();
                callback(count);
            }
        )
        .subscribe();

    // Return unsubscribe function
    return () => {
        channel.unsubscribe();
    };
};

/**
 * Increment a user stat
 * @param userId - User ID
 * @param stat - Stat to increment ('channel_points_farmed' | 'hours_watched' | 'messages_sent' | 'streams_watched')
 * @param amount - Amount to increment by (default 1)
 */
export const incrementStat = async (
    userId: string,
    stat: 'channel_points_farmed' | 'hours_watched' | 'messages_sent' | 'streams_watched',
    amount: number = 1
): Promise<void> => {
    if (!supabase) {
        console.warn('[Supabase] Cannot increment stat - Supabase not configured');
        return;
    }
    if (!userId) {
        console.warn('[Supabase] Cannot increment stat - No user ID provided');
        return;
    }

    console.log(`[Supabase] Attempting to increment ${stat} by ${amount} for user ${userId}`);

    try {
        // Use the Postgres function for atomic increment
        const { error } = await supabase.rpc('increment_user_stat', {
            p_user_id: userId,
            p_stat: stat,
            p_amount: amount
        });

        if (error) {
            // If function doesn't exist, fall back to manual upsert
            if (error.message?.includes('function') || error.code === '42883') {
                console.log('[Supabase] RPC function not found, using manual upsert fallback');
                await manualIncrementStat(userId, stat, amount);
                return;
            }
            console.error('[Supabase] Failed to increment stat via RPC:', error.message, error.code);
            // Try manual fallback for any error
            console.log('[Supabase] Trying manual upsert as fallback...');
            await manualIncrementStat(userId, stat, amount);
            return;
        }

        console.log(`[Supabase] ✓ Incremented ${stat} by ${amount} for user ${userId}`);
    } catch (error) {
        console.error('[Supabase] Exception incrementing stat:', error);
        // Try manual fallback as last resort
        try {
            await manualIncrementStat(userId, stat, amount);
        } catch (fallbackError) {
            console.error('[Supabase] Manual fallback also failed:', fallbackError);
        }
    }
};

/**
 * Manual stat increment fallback (when RPC not available)
 */
const manualIncrementStat = async (
    userId: string,
    stat: 'channel_points_farmed' | 'hours_watched' | 'messages_sent' | 'streams_watched',
    amount: number
): Promise<void> => {
    if (!supabase) return;

    try {
        // First, try to get existing stats
        const { data: existing } = await supabase
            .from('user_stats')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (existing) {
            // Update existing record
            const newValue = (existing[stat] || 0) + amount;
            await supabase
                .from('user_stats')
                .update({ [stat]: newValue, updated_at: new Date().toISOString() })
                .eq('user_id', userId);
        } else {
            // Insert new record
            await supabase
                .from('user_stats')
                .insert({
                    user_id: userId,
                    [stat]: amount,
                    updated_at: new Date().toISOString()
                });
        }
    } catch (error) {
        console.error('[Supabase] Manual increment failed:', error);
    }
};

/**
 * Get stats for a specific user
 * @param userId - User ID
 * @returns User stats or null
 */
export const getUserStats = async (userId: string): Promise<UserStats | null> => {
    if (!supabase || !userId) {
        return null;
    }

    try {
        const { data, error } = await supabase
            .from('user_stats')
            .select('*')
            .eq('user_id', userId)
            .single();

        if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
            console.error('[Supabase] Failed to get user stats:', error);
            return null;
        }

        return data as UserStats || null;
    } catch (error) {
        console.error('[Supabase] Failed to get user stats:', error);
        return null;
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

// Export default object for convenience
export default {
    getSupabaseClient,
    isSupabaseConfigured,
    trackPresence,
    updatePresence,
    upsertUser,
    getOnlineCount,
    subscribeToOnlineCount,
    getTotalUsersCount,
    subscribeToTotalUsers,
    incrementStat,
    getUserStats,
    getGlobalStats,
    getAllUsersWithStats,
    subscribeToStatsChanges,
};
