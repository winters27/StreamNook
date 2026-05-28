import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { TwitchUser } from '../types';

import { Logger } from '../utils/logger';
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
    Logger.debug('[Supabase] Client initialized');
} else {
    Logger.warn('[Supabase] Not configured - analytics features disabled. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env');
}

// Presence channel reference
let presenceChannel: RealtimeChannel | null = null;
let currentPresenceKey: string | null = null;
let currentPresencePayload: PresenceState | null = null;
let presenceReady = false;

// Listeners that want to be notified whenever presenceState changes (sync/join/leave).
// Stored as a Set so we can actually remove individual subscribers, unlike before.
const onlineCountSubscribers = new Set<(snapshot: OnlinePresenceSnapshot) => void>();

// Types for presence tracking
interface PresenceState {
    online_at: string;
    user_id?: string;
    display_name?: string;
    app_version?: string;
}

/**
 * Rich snapshot of who is currently online via the global presence channel.
 * Deduped by user_id; anonymous keys counted separately so the surfaces can
 * show "N users + M anonymous" if they want.
 */
export interface OnlinePresenceSnapshot {
    authedUserIds: Set<string>;
    anonKeyCount: number;
    /** Total unique participants = authed users + anon sessions. */
    totalUnique: number;
    /** Map of authed user_id -> richest known presence payload. */
    byUserId: Map<string, { display_name?: string; app_version?: string; online_at: string }>;
}

const emptySnapshot = (): OnlinePresenceSnapshot => ({
    authedUserIds: new Set(),
    anonKeyCount: 0,
    totalUnique: 0,
    byUserId: new Map(),
});

const computeSnapshot = (): OnlinePresenceSnapshot => {
    if (!presenceChannel) return emptySnapshot();
    const state = presenceChannel.presenceState<PresenceState>();
    const authedUserIds = new Set<string>();
    const byUserId = new Map<string, { display_name?: string; app_version?: string; online_at: string }>();
    let anonKeyCount = 0;

    for (const key of Object.keys(state)) {
        const presences = state[key];
        if (!Array.isArray(presences) || presences.length === 0) continue;
        // Pick the freshest payload for this key (Supabase usually returns one
        // per key, but be defensive against multi-tab same-key edge cases).
        const fresh = presences.reduce((a, b) =>
            new Date(b.online_at).getTime() > new Date(a.online_at).getTime() ? b : a
        );
        if (fresh.user_id) {
            if (!authedUserIds.has(fresh.user_id)) {
                authedUserIds.add(fresh.user_id);
                byUserId.set(fresh.user_id, {
                    display_name: fresh.display_name,
                    app_version: fresh.app_version,
                    online_at: fresh.online_at,
                });
            } else {
                // Already counted; keep the freshest payload.
                const existing = byUserId.get(fresh.user_id);
                if (!existing || new Date(fresh.online_at).getTime() > new Date(existing.online_at).getTime()) {
                    byUserId.set(fresh.user_id, {
                        display_name: fresh.display_name,
                        app_version: fresh.app_version,
                        online_at: fresh.online_at,
                    });
                }
            }
        } else {
            anonKeyCount++;
        }
    }

    return {
        authedUserIds,
        anonKeyCount,
        totalUnique: authedUserIds.size + anonKeyCount,
        byUserId,
    };
};

const notifyOnlineSubscribers = () => {
    if (onlineCountSubscribers.size === 0) return;
    const snap = computeSnapshot();
    for (const cb of onlineCountSubscribers) {
        try { cb(snap); } catch (e) { Logger.error('[Supabase] Online subscriber error:', e); }
    }
};

/**
 * Get the Supabase client instance
 */
export const getSupabaseClient = (): SupabaseClient | null => supabase;

/**
 * Check if Supabase is configured and ready to use
 */
export const isSupabaseConfigured = (): boolean => !!isConfigured;

/**
 * Build a stable presence key. Authenticated users key by `user:<id>` so
 * reconnects land in the same presence slot instead of inflating the count.
 * Anonymous sessions get a random key so unrelated tabs/installs stay distinct.
 */
const buildPresenceKey = (userId?: string): string => {
    if (userId) return `user:${userId}`;
    return `anon:${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
};

const buildPayload = (userId?: string, displayName?: string, appVersion?: string): PresenceState => ({
    online_at: new Date().toISOString(),
    ...(userId && { user_id: userId }),
    ...(displayName && { display_name: displayName }),
    ...(appVersion && { app_version: appVersion }),
});

const attachPresenceListeners = (channel: RealtimeChannel) => {
    channel
        .on('presence', { event: 'sync' }, () => {
            presenceReady = true;
            notifyOnlineSubscribers();
        })
        .on('presence', { event: 'join' }, () => {
            notifyOnlineSubscribers();
        })
        .on('presence', { event: 'leave' }, () => {
            notifyOnlineSubscribers();
        });
};

/**
 * Track user presence in the app. Safe to call repeatedly — when called with
 * a different identity (e.g. anon -> authed) it tears down the old channel
 * and rejoins with the new key, so the global presence count never carries
 * the old anonymous session forward.
 *
 * @returns Unsubscribe function to clean up presence on unmount
 */
export const trackPresence = async (
    userId?: string,
    displayName?: string,
    appVersion?: string
): Promise<(() => void) | null> => {
    if (!supabase) {
        Logger.debug('[Supabase] Skipping presence tracking - not configured');
        return null;
    }

    try {
        const nextKey = buildPresenceKey(userId);

        // If we are already tracking under the right key, just refresh the payload.
        if (presenceChannel && currentPresenceKey === nextKey) {
            currentPresencePayload = buildPayload(userId, displayName, appVersion);
            await presenceChannel.track(currentPresencePayload);
            return () => disposePresence();
        }

        // Otherwise tear down the old channel and rejoin under the new key.
        if (presenceChannel) {
            try { await presenceChannel.untrack(); } catch { /* best effort */ }
            try { await presenceChannel.unsubscribe(); } catch { /* best effort */ }
            presenceChannel = null;
            presenceReady = false;
        }

        currentPresenceKey = nextKey;
        currentPresencePayload = buildPayload(userId, displayName, appVersion);

        presenceChannel = supabase.channel('global-presence', {
            config: { presence: { key: currentPresenceKey } },
        });

        attachPresenceListeners(presenceChannel);

        presenceChannel.subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                if (currentPresencePayload) {
                    await presenceChannel?.track(currentPresencePayload);
                }
                Logger.debug('[Supabase] Presence tracking active as', currentPresenceKey);
                // Push an immediate snapshot so subscribers that registered
                // before SUBSCRIBED resolved get the first count without
                // waiting for another sync event.
                notifyOnlineSubscribers();
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                Logger.warn('[Supabase] Presence channel status:', status);
                presenceReady = false;
            }
        });

        return () => disposePresence();
    } catch (error) {
        Logger.error('[Supabase] Failed to track presence:', error);
        return null;
    }
};

const disposePresence = () => {
    if (!presenceChannel) return;
    Logger.debug('[Supabase] Cleaning up presence tracking');
    try { presenceChannel.untrack(); } catch { /* best effort */ }
    try { presenceChannel.unsubscribe(); } catch { /* best effort */ }
    presenceChannel = null;
    currentPresenceKey = null;
    currentPresencePayload = null;
    presenceReady = false;
};

/**
 * Update presence when the user logs in (or out). Re-keys the channel so the
 * authenticated user lands in their stable `user:<id>` slot. Safe to call
 * before trackPresence has finished — it will just defer until then.
 */
export const updatePresence = async (userId: string, displayName: string, appVersion?: string): Promise<void> => {
    if (!supabase) {
        Logger.debug('[Supabase] Skipping presence update - not configured');
        return;
    }

    // Re-key by delegating to trackPresence with the new identity.
    await trackPresence(userId, displayName, appVersion);
};

/**
 * Upsert user data to the users table on login
 * @param user - TwitchUser object
 * @param appVersion - Optional app version
 */
export const upsertUser = async (user: TwitchUser, appVersion?: string): Promise<void> => {
    if (!supabase) {
        Logger.debug('[Supabase] Skipping user upsert - not configured');
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
            Logger.error('[Supabase] Failed to upsert user:', error);
            return;
        }

        Logger.debug('[Supabase] User upserted:', user.display_name || user.username);

        // Also update presence with user info
        await updatePresence(user.user_id, user.display_name || user.username, appVersion);
    } catch (error) {
        Logger.error('[Supabase] Failed to upsert user:', error);
    }
};

/**
 * Get the current count of online users via presence. Deduped by user_id so a
 * user logged in on multiple machines counts as one; anonymous sessions each
 * count as one.
 */
export const getOnlineCount = (): number => computeSnapshot().totalUnique;

/**
 * Get the full presence snapshot (authed user_ids, anon count, per-user
 * payloads). Useful for the Settings panel and the dashboard.
 */
export const getOnlinePresenceSnapshot = (): OnlinePresenceSnapshot => computeSnapshot();

/**
 * Subscribe to presence snapshot changes. Works even before `trackPresence`
 * has finished initialising the channel — the callback will fire as soon as
 * the first sync arrives. Returns a real unsubscribe that removes only this
 * listener.
 */
export const subscribeToOnlinePresence = (
    callback: (snap: OnlinePresenceSnapshot) => void
): (() => void) => {
    onlineCountSubscribers.add(callback);
    // Push the current snapshot immediately so the caller always starts with
    // *something* (zeros if the channel hasn't subscribed yet).
    try { callback(computeSnapshot()); } catch (e) { Logger.error('[Supabase] Online subscriber error:', e); }
    return () => { onlineCountSubscribers.delete(callback); };
};

/**
 * Back-compat helper that just wraps subscribeToOnlinePresence and emits the
 * deduped count. Existing call sites keep working.
 */
export const subscribeToOnlineCount = (
    callback: (count: number) => void
): (() => void) => {
    return subscribeToOnlinePresence((snap) => callback(snap.totalUnique));
};

/**
 * True once the presence channel has received its first sync event.
 * Lets the UI distinguish "0 online" from "still connecting".
 */
export const isPresenceReady = (): boolean => presenceReady;

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
            Logger.error('[Supabase] Failed to get all users:', error);
            return [];
        }

        return (data as SupabaseUser[]) || [];
    } catch (error) {
        Logger.error('[Supabase] Failed to get all users:', error);
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
            Logger.error('[Supabase] Failed to get total users count:', error);
            return 0;
        }

        return count || 0;
    } catch (error) {
        Logger.error('[Supabase] Failed to get total users count:', error);
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

// ---------------------------------------------------------------------------
// Stat increment health tracking
// ---------------------------------------------------------------------------
// The dashboard needs to know whether writes are actually landing. Without
// this, a broken RLS policy or missing RPC silently zeros every chart.

export type StatWriteIssue =
    | { kind: 'rpc_missing'; lastSeen: string }
    | { kind: 'rls_denied'; lastSeen: string; detail: string }
    | { kind: 'other'; lastSeen: string; detail: string };

let lastWriteIssue: StatWriteIssue | null = null;
const writeIssueSubscribers = new Set<(issue: StatWriteIssue | null) => void>();

const reportWriteIssue = (issue: StatWriteIssue | null) => {
    lastWriteIssue = issue;
    for (const cb of writeIssueSubscribers) {
        try { cb(issue); } catch (e) { Logger.error('[Supabase] Write-issue subscriber error:', e); }
    }
};

export const getLastWriteIssue = (): StatWriteIssue | null => lastWriteIssue;

export const subscribeToWriteIssues = (cb: (issue: StatWriteIssue | null) => void): (() => void) => {
    writeIssueSubscribers.add(cb);
    try { cb(lastWriteIssue); } catch (e) { Logger.error('[Supabase] Write-issue subscriber error:', e); }
    return () => { writeIssueSubscribers.delete(cb); };
};

/**
 * Increment a user stat. Uses the `increment_user_stat` RPC when available
 * for atomicity; falls back to a manual upsert otherwise. Surfaces RLS /
 * permission failures via the write-issue subscription so the dashboard can
 * show a banner instead of silently zeroing the charts.
 */
export const incrementStat = async (
    userId: string,
    stat: 'channel_points_farmed' | 'hours_watched' | 'messages_sent' | 'streams_watched',
    amount: number = 1
): Promise<void> => {
    if (!supabase) {
        Logger.warn('[Supabase] Cannot increment stat - Supabase not configured');
        return;
    }
    if (!userId) {
        Logger.warn('[Supabase] Cannot increment stat - No user ID provided');
        return;
    }

    Logger.debug(`[Supabase] Attempting to increment ${stat} by ${amount} for user ${userId}`);

    try {
        const { error } = await supabase.rpc('increment_user_stat', {
            p_user_id: userId,
            p_stat: stat,
            p_amount: amount
        });

        if (!error) {
            Logger.debug(`[Supabase] Incremented ${stat} by ${amount} for user ${userId}`);
            // Successful write clears the last issue (recovered).
            if (lastWriteIssue) reportWriteIssue(null);
            return;
        }

        // 42883 = function does not exist; PGRST202 = RPC route missing in PostgREST.
        const rpcMissing = error.code === '42883'
            || error.code === 'PGRST202'
            || (typeof error.message === 'string' && error.message.toLowerCase().includes('function'));

        if (rpcMissing) {
            reportWriteIssue({ kind: 'rpc_missing', lastSeen: new Date().toISOString() });
            Logger.debug('[Supabase] RPC missing, using manual upsert fallback');
            await manualIncrementStat(userId, stat, amount);
            return;
        }

        // 42501 = insufficient_privilege (RLS denial).
        if (error.code === '42501') {
            reportWriteIssue({
                kind: 'rls_denied',
                lastSeen: new Date().toISOString(),
                detail: error.message || 'RLS denied',
            });
            Logger.error('[Supabase] Stat increment denied by RLS:', error.message);
            return;
        }

        Logger.error('[Supabase] Failed to increment stat via RPC:', error.message, error.code);
        reportWriteIssue({
            kind: 'other',
            lastSeen: new Date().toISOString(),
            detail: `${error.code || ''} ${error.message || ''}`.trim(),
        });
        await manualIncrementStat(userId, stat, amount);
    } catch (error: any) {
        Logger.error('[Supabase] Exception incrementing stat:', error);
        reportWriteIssue({
            kind: 'other',
            lastSeen: new Date().toISOString(),
            detail: String(error?.message || error),
        });
        try {
            await manualIncrementStat(userId, stat, amount);
        } catch (fallbackError) {
            Logger.error('[Supabase] Manual fallback also failed:', fallbackError);
        }
    }
};

/**
 * Manual stat increment fallback (when RPC not available). Not atomic;
 * concurrent increments can lose writes. The RPC path is preferred.
 */
const manualIncrementStat = async (
    userId: string,
    stat: 'channel_points_farmed' | 'hours_watched' | 'messages_sent' | 'streams_watched',
    amount: number
): Promise<void> => {
    if (!supabase) return;

    try {
        const { data: existing, error: selectError } = await supabase
            .from('user_stats')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (selectError && selectError.code !== 'PGRST116') {
            if (selectError.code === '42501') {
                reportWriteIssue({
                    kind: 'rls_denied',
                    lastSeen: new Date().toISOString(),
                    detail: selectError.message || 'RLS denied on select',
                });
            }
            throw selectError;
        }

        if (existing) {
            const newValue = ((existing as any)[stat] || 0) + amount;
            const { error } = await supabase
                .from('user_stats')
                .update({ [stat]: newValue, updated_at: new Date().toISOString() })
                .eq('user_id', userId);
            if (error) throw error;
        } else {
            const { error } = await supabase
                .from('user_stats')
                .insert({
                    user_id: userId,
                    [stat]: amount,
                    updated_at: new Date().toISOString(),
                });
            if (error) throw error;
        }

        if (lastWriteIssue) reportWriteIssue(null);
    } catch (error: any) {
        Logger.error('[Supabase] Manual increment failed:', error);
        if (error?.code === '42501') {
            reportWriteIssue({
                kind: 'rls_denied',
                lastSeen: new Date().toISOString(),
                detail: error.message || 'RLS denied',
            });
        } else {
            reportWriteIssue({
                kind: 'other',
                lastSeen: new Date().toISOString(),
                detail: `${error?.code || ''} ${error?.message || ''}`.trim(),
            });
        }
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
            Logger.error('[Supabase] Failed to get user stats:', error);
            return null;
        }

        return data as UserStats || null;
    } catch (error) {
        Logger.error('[Supabase] Failed to get user stats:', error);
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
            Logger.error('[Supabase] Failed to get global stats:', error);
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
        Logger.error('[Supabase] Failed to get global stats:', error);
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
            Logger.error('[Supabase] Failed to get users:', usersError);
            return [];
        }

        // Get all stats
        const { data: stats, error: statsError } = await supabase
            .from('user_stats')
            .select('*');

        if (statsError && statsError.code !== 'PGRST116') {
            Logger.error('[Supabase] Failed to get stats:', statsError);
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
        Logger.error('[Supabase] Failed to get users with stats:', error);
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

// ============================================================================
// StreamNook user registry (P2P badge)
// ============================================================================
// Backed by the `user_numbers` Postgres view (ROW_NUMBER ordered by users.created_at).
// Loaded once on app start, kept fresh via a realtime INSERT subscription on `users`.

let snRegistry: Map<string, number> = new Map();
let snRegistryChannel: RealtimeChannel | null = null;
let snRegistryLoaded = false;
let snRegistryLoading: Promise<void> | null = null;
let snRegistryVersion = 0;
const snRegistryVersionSubscribers = new Set<() => void>();

const bumpStreamNookRegistryVersion = () => {
    snRegistryVersion++;
    for (const cb of snRegistryVersionSubscribers) {
        try { cb(); } catch (e) { Logger.error('[Supabase] Registry version subscriber error:', e); }
    }
};

const loadStreamNookRegistry = async (): Promise<void> => {
    if (!supabase) return;
    if (snRegistryLoading) return snRegistryLoading;
    snRegistryLoading = (async () => {
        try {
            const { data, error } = await supabase!
                .from('user_numbers')
                .select('id, user_number');
            if (error) {
                Logger.error('[Supabase] Failed to load streamnook registry:', error);
                return;
            }
            snRegistry = new Map((data || []).map((r: any) => [r.id as string, r.user_number as number]));
            snRegistryLoaded = true;
            Logger.debug('[Supabase] StreamNook registry loaded:', snRegistry.size, 'users');
            bumpStreamNookRegistryVersion();
        } catch (e) {
            Logger.error('[Supabase] loadStreamNookRegistry exception:', e);
        } finally {
            snRegistryLoading = null;
        }
    })();
    return snRegistryLoading;
};

/**
 * Subscribe to the StreamNook user registry. Idempotent: only the first call
 * triggers a fetch + opens the realtime channel; subsequent calls just add
 * listeners. Returns an unsubscribe that tears the channel down when the last
 * listener leaves.
 */
export const subscribeToStreamNookRegistry = (
    callback?: (map: Map<string, number>) => void
): (() => void) | null => {
    if (!supabase) return null;

    const versionCb = () => callback?.(snRegistry);
    snRegistryVersionSubscribers.add(versionCb);

    if (!snRegistryLoaded) {
        loadStreamNookRegistry();
    } else {
        callback?.(snRegistry);
    }

    if (!snRegistryChannel) {
        snRegistryChannel = supabase
            .channel('streamnook-registry')
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'users',
            }, () => {
                loadStreamNookRegistry();
            })
            .subscribe();
    }

    return () => {
        snRegistryVersionSubscribers.delete(versionCb);
        if (snRegistryVersionSubscribers.size === 0 && snRegistryChannel) {
            snRegistryChannel.unsubscribe();
            snRegistryChannel = null;
        }
    };
};

/** Sync read: is this Twitch user in the registry? */
export const isStreamNookUser = (userId: string | undefined | null): boolean => {
    if (!userId) return false;
    return snRegistry.has(userId);
};

/** Sync read: get the user number, or null if not registered. */
export const getStreamNookUserNumber = (userId: string | undefined | null): number | null => {
    if (!userId) return null;
    return snRegistry.get(userId) ?? null;
};

/** For React useSyncExternalStore: subscribe to version bumps. */
export const subscribeStreamNookRegistryVersion = (cb: () => void): (() => void) => {
    snRegistryVersionSubscribers.add(cb);
    if (!snRegistryLoaded && !snRegistryLoading && supabase) {
        loadStreamNookRegistry();
    }
    return () => { snRegistryVersionSubscribers.delete(cb); };
};

/** For React useSyncExternalStore: read the current version. */
export const getStreamNookRegistryVersion = (): number => snRegistryVersion;

// ============================================================================
// Cosmetics registry (gold badge entitlements + active selection)
// ============================================================================
// Mirrors the StreamNook registry pattern above: single-flight load on first
// subscribe, version counter for useSyncExternalStore, realtime sub on
// user_cosmetics INSERT (entitlements) and user_cosmetic_active * (selection).
// Sync reads expose: catalog row by slug, entitlement set for a user, and
// the resolved active slug for a user.

export interface CosmeticCatalogEntry {
    slug: string;
    name: string;
    description: string | null;
    kind: string;
    asset_path: string;
    animated: boolean;
    payment_type: string | null;
    ko_fi_url: string | null;
    stripe_url: string | null;
    sort_order: number;
    is_active: boolean;
    is_default: boolean;
}

let cosmeticsCatalog: Map<string, CosmeticCatalogEntry> = new Map();
let cosmeticsEntitlements: Map<string, Set<string>> = new Map(); // twitch_user_id -> set of slugs
let cosmeticsActive: Map<string, string> = new Map();            // twitch_user_id -> active slug
let cosmeticsChannel: RealtimeChannel | null = null;
let cosmeticsLoaded = false;
let cosmeticsLoading: Promise<void> | null = null;
let cosmeticsVersion = 0;
const cosmeticsVersionSubscribers = new Set<() => void>();

const bumpCosmeticsVersion = () => {
    cosmeticsVersion++;
    for (const cb of cosmeticsVersionSubscribers) {
        try { cb(); } catch (e) { Logger.error('[Supabase] Cosmetics subscriber error:', e); }
    }
};

const loadCosmetics = async (): Promise<void> => {
    if (!supabase) return;
    if (cosmeticsLoading) return cosmeticsLoading;
    cosmeticsLoading = (async () => {
        try {
            const [catalogRes, entRes, activeRes] = await Promise.all([
                supabase!.from('cosmetics').select('*').eq('is_active', true).order('sort_order'),
                supabase!.from('user_cosmetics').select('twitch_user_id, slug'),
                supabase!.from('user_cosmetic_active').select('twitch_user_id, active_slug'),
            ]);
            if (catalogRes.error) Logger.error('[Supabase] cosmetics catalog load failed:', catalogRes.error);
            if (entRes.error) Logger.error('[Supabase] user_cosmetics load failed:', entRes.error);
            if (activeRes.error) Logger.error('[Supabase] user_cosmetic_active load failed:', activeRes.error);

            const nextCatalog = new Map<string, CosmeticCatalogEntry>();
            for (const row of (catalogRes.data || []) as CosmeticCatalogEntry[]) {
                nextCatalog.set(row.slug, row);
            }

            const nextEnt = new Map<string, Set<string>>();
            for (const row of (entRes.data || []) as { twitch_user_id: string; slug: string }[]) {
                let set = nextEnt.get(row.twitch_user_id);
                if (!set) { set = new Set(); nextEnt.set(row.twitch_user_id, set); }
                set.add(row.slug);
            }

            const nextActive = new Map<string, string>();
            for (const row of (activeRes.data || []) as { twitch_user_id: string; active_slug: string | null }[]) {
                if (row.active_slug) nextActive.set(row.twitch_user_id, row.active_slug);
            }

            cosmeticsCatalog = nextCatalog;
            cosmeticsEntitlements = nextEnt;
            cosmeticsActive = nextActive;
            cosmeticsLoaded = true;
            Logger.debug('[Supabase] Cosmetics loaded:', {
                catalog: nextCatalog.size,
                userEntitlements: nextEnt.size,
                userActive: nextActive.size,
            });
            bumpCosmeticsVersion();
        } catch (e) {
            Logger.error('[Supabase] loadCosmetics exception:', e);
        } finally {
            cosmeticsLoading = null;
        }
    })();
    return cosmeticsLoading;
};

/**
 * Subscribe to the cosmetics registry. Idempotent. The first call triggers
 * the initial fetch and opens the realtime channel; subsequent calls just
 * register the listener.
 */
export const subscribeToCosmeticsRegistry = (
    callback?: () => void,
): (() => void) | null => {
    if (!supabase) return null;

    const cb = () => callback?.();
    cosmeticsVersionSubscribers.add(cb);

    if (!cosmeticsLoaded && !cosmeticsLoading) {
        loadCosmetics();
    } else if (cosmeticsLoaded) {
        callback?.();
    }

    if (!cosmeticsChannel) {
        cosmeticsChannel = supabase
            .channel('cosmetics-registry')
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'user_cosmetics',
            }, () => { loadCosmetics(); })
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'user_cosmetic_active',
            }, () => { loadCosmetics(); })
            .subscribe();
    }

    return () => {
        cosmeticsVersionSubscribers.delete(cb);
        if (cosmeticsVersionSubscribers.size === 0 && cosmeticsChannel) {
            cosmeticsChannel.unsubscribe();
            cosmeticsChannel = null;
        }
    };
};

/** Sync read: catalog row by slug. */
export const getCosmeticBySlug = (slug: string | undefined | null): CosmeticCatalogEntry | null => {
    if (!slug) return null;
    return cosmeticsCatalog.get(slug) ?? null;
};

/** Sync read: full catalog, sorted by sort_order. */
export const getAllCosmetics = (): CosmeticCatalogEntry[] => {
    return Array.from(cosmeticsCatalog.values()).sort((a, b) => a.sort_order - b.sort_order);
};

/** Sync read: which slugs has this user been explicitly granted? Does NOT
 *  include `is_default` cosmetics that everyone can equip — use
 *  `getOwnedCosmeticSlugs` for the rendering / picker check. */
export const getUserCosmeticSlugs = (userId: string | undefined | null): Set<string> => {
    if (!userId) return new Set();
    return cosmeticsEntitlements.get(userId) ?? new Set();
};

/** Sync read: every slug this user can equip — explicit entitlements PLUS
 *  every `is_default` cosmetic. This is the right check for both the picker
 *  ("show what's mine") and the active-cosmetic resolver ("can the current
 *  active selection actually render"). */
export const getOwnedCosmeticSlugs = (userId: string | undefined | null): Set<string> => {
    const owned = new Set<string>();
    for (const cosmetic of cosmeticsCatalog.values()) {
        if (cosmetic.is_default) owned.add(cosmetic.slug);
    }
    if (userId) {
        const explicit = cosmeticsEntitlements.get(userId);
        if (explicit) for (const slug of explicit) owned.add(slug);
    }
    return owned;
};

/** Sync read: which slug is this user currently displaying? */
export const getActiveCosmeticSlug = (userId: string | undefined | null): string | null => {
    if (!userId) return null;
    const slug = cosmeticsActive.get(userId);
    if (!slug) return null;
    // Guard against an active row pointing at a slug the user no longer owns
    // (manual DB tamper, default flag flipped off after equip, etc.) Catalog
    // membership + is_default eligibility checked together.
    const owned = getOwnedCosmeticSlugs(userId);
    if (!owned.has(slug)) return null;
    return slug;
};

/** For React useSyncExternalStore: subscribe to version bumps. */
export const subscribeCosmeticsVersion = (cb: () => void): (() => void) => {
    cosmeticsVersionSubscribers.add(cb);
    if (!cosmeticsLoaded && !cosmeticsLoading && supabase) {
        loadCosmetics();
    }
    return () => { cosmeticsVersionSubscribers.delete(cb); };
};

/** For React useSyncExternalStore: read the current version. */
export const getCosmeticsVersion = (): number => cosmeticsVersion;

/**
 * Set the active cosmetic for a user. Pass null to revert to the default
 * (no cosmetic, render the plain StreamNook logo). Optimistic: updates the
 * in-memory map and bumps the version immediately so the picker UI flips,
 * then upserts to Supabase. The realtime sub on user_cosmetic_active is
 * what reconciles other windows.
 */
export const setActiveCosmetic = async (
    userId: string,
    slug: string | null,
): Promise<{ ok: boolean; error?: string }> => {
    if (!supabase) return { ok: false, error: 'supabase not configured' };
    if (!userId) return { ok: false, error: 'no userId' };

    // Optimistic local update so the swap is instant in this window.
    const prev = cosmeticsActive.get(userId) ?? null;
    if (slug) cosmeticsActive.set(userId, slug);
    else cosmeticsActive.delete(userId);
    bumpCosmeticsVersion();

    try {
        const { error } = await supabase
            .from('user_cosmetic_active')
            .upsert(
                {
                    twitch_user_id: userId,
                    active_slug: slug,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'twitch_user_id' },
            );
        if (error) {
            // Roll back the optimistic update.
            if (prev) cosmeticsActive.set(userId, prev);
            else cosmeticsActive.delete(userId);
            bumpCosmeticsVersion();
            Logger.error('[Supabase] setActiveCosmetic failed:', error);
            return { ok: false, error: error.message };
        }
        return { ok: true };
    } catch (e: unknown) {
        if (prev) cosmeticsActive.set(userId, prev);
        else cosmeticsActive.delete(userId);
        bumpCosmeticsVersion();
        Logger.error('[Supabase] setActiveCosmetic exception:', e);
        const msg = e instanceof Error ? e.message : 'unknown';
        return { ok: false, error: msg };
    }
};

if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as any).__snDebug = {
        registry: () => snRegistry,
        size: () => snRegistry.size,
        loaded: () => snRegistryLoaded,
        version: () => snRegistryVersion,
        isMember: (id: string) => snRegistry.has(id),
        number: (id: string) => snRegistry.get(id) ?? null,
        reload: () => loadStreamNookRegistry(),
        cosmetics: {
            catalog: () => cosmeticsCatalog,
            entitlements: () => cosmeticsEntitlements,
            active: () => cosmeticsActive,
            loaded: () => cosmeticsLoaded,
            version: () => cosmeticsVersion,
            reload: () => loadCosmetics(),
        },
    };
}

// Export default object for convenience
export default {
    getSupabaseClient,
    isSupabaseConfigured,
    trackPresence,
    updatePresence,
    upsertUser,
    getOnlineCount,
    getOnlinePresenceSnapshot,
    subscribeToOnlineCount,
    subscribeToOnlinePresence,
    isPresenceReady,
    getTotalUsersCount,
    subscribeToTotalUsers,
    incrementStat,
    getLastWriteIssue,
    subscribeToWriteIssues,
    getUserStats,
    getGlobalStats,
    getAllUsersWithStats,
    subscribeToStatsChanges,
    subscribeToStreamNookRegistry,
    isStreamNookUser,
    getStreamNookUserNumber,
    subscribeToCosmeticsRegistry,
    getCosmeticBySlug,
    getAllCosmetics,
    getUserCosmeticSlugs,
    getOwnedCosmeticSlugs,
    getActiveCosmeticSlug,
    subscribeCosmeticsVersion,
    getCosmeticsVersion,
    setActiveCosmetic,
};
