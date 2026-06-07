import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { TwitchUser } from '../types';

import { Logger } from '../utils/logger';
import { getActiveSeasonalAccoladeIds, isCakeDay, CAKE_DAY_ID } from '../utils/seasonalAccolades';
import { fetchIVRUserData } from './ivrService';
import type { Atmosphere } from './atmospheres';
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
    // How many times other members have opened this member's public profile.
    // Bumped by the `increment_profile_view` RPC; optional so older rows / a
    // pre-migration DB don't break the read.
    profile_views?: number;
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

// Profiles already counted this app session, so reopening a member's profile in
// the same session doesn't keep inflating their view count (deduped total).
const countedProfileViews = new Set<string>();

/**
 * Record a profile view: bump the VIEWED member's `profile_views` via the
 * `increment_profile_view` RPC (security definer, so a viewer can increment
 * someone else's count). Deduped per session. Returns the new total, or null if
 * it was deduped / the RPC isn't available yet (best-effort, never throws).
 */
export const incrementProfileView = async (userId: string): Promise<number | null> => {
    if (!supabase || !userId) return null;
    if (countedProfileViews.has(userId)) return null; // already counted this session
    countedProfileViews.add(userId);
    try {
        const { data, error } = await supabase.rpc('increment_profile_view', { p_user_id: userId });
        if (error) {
            // Missing column / RPC (pre-migration DB): degrade silently. Drop the
            // session mark so it can retry once the backend exists.
            countedProfileViews.delete(userId);
            Logger.debug('[Supabase] increment_profile_view unavailable:', error.message);
            return null;
        }
        return typeof data === 'number' ? data : null;
    } catch (error) {
        countedProfileViews.delete(userId);
        Logger.debug('[Supabase] incrementProfileView failed:', error);
        return null;
    }
};

/**
 * Read a member's current `profile_views` count without incrementing (used when
 * we shouldn't count: own profile, the live preview, or an already-counted view).
 * Returns null if unavailable.
 */
export const getProfileViews = async (userId: string): Promise<number | null> => {
    if (!supabase || !userId) return null;
    try {
        const { data, error } = await supabase
            .from('user_stats')
            .select('profile_views')
            .eq('user_id', userId)
            .maybeSingle();
        if (error) {
            Logger.debug('[Supabase] getProfileViews failed:', error.message);
            return null;
        }
        const n = (data as { profile_views?: number } | null)?.profile_views;
        return typeof n === 'number' ? n : null;
    } catch (error) {
        Logger.debug('[Supabase] getProfileViews failed:', error);
        return null;
    }
};

/**
 * Get the award-badge ids this user has earned (seasonal / limited, etc.).
 * Returns [] when Supabase is unconfigured or the table is missing, so the UI
 * shows everything locked rather than breaking.
 */
export const getAccolades = async (userId: string): Promise<string[]> => {
    if (!supabase || !userId) return [];
    try {
        const { data, error } = await supabase
            .from('user_accolades')
            .select('accolade_id')
            .eq('twitch_user_id', userId);
        if (error) {
            Logger.error('[Supabase] Failed to get award badges:', error.message);
            return [];
        }
        return (data || []).map((r: { accolade_id: string }) => r.accolade_id);
    } catch (error) {
        Logger.error('[Supabase] Failed to get award badges:', error);
        return [];
    }
};

/**
 * Grant an award badge to a user (idempotent). Insert-only; re-granting an
 * already-earned badge is a no-op via ON CONFLICT.
 */
export const grantAccolade = async (userId: string, accoladeId: string): Promise<void> => {
    if (!supabase || !userId || !accoladeId) return;
    try {
        const { error } = await supabase
            .from('user_accolades')
            .upsert(
                { twitch_user_id: userId, accolade_id: accoladeId, earned_at: new Date().toISOString() },
                { onConflict: 'twitch_user_id,accolade_id', ignoreDuplicates: true },
            );
        if (error) Logger.error('[Supabase] Failed to grant award badge:', error.message);
    } catch (error) {
        Logger.error('[Supabase] Failed to grant award badge:', error);
    }
};

/**
 * If today falls within a seasonal badge window, grant that badge. Called once
 * per session on login so holidays are captured without opening the profile.
 */
export const grantActiveSeasonalAccolades = async (userId: string): Promise<void> => {
    const ids = getActiveSeasonalAccoladeIds(new Date());
    for (const id of ids) {
        await grantAccolade(userId, id);
    }
};

/**
 * Grant the Cake Day badge if today is the user's Twitch account anniversary.
 * Reads the creation date from IVR; best-effort.
 */
export const grantCakeDayAccolade = async (userId: string, login: string): Promise<void> => {
    if (!userId || !login) return;
    try {
        const u = await fetchIVRUserData(login);
        if (u?.createdAt && isCakeDay(u.createdAt, new Date())) {
            await grantAccolade(userId, CAKE_DAY_ID);
        }
    } catch {
        // best effort
    }
};

// ---------------------------------------------------------------------------
// Emote usage (most-used emotes from the member's own sent messages)
// ---------------------------------------------------------------------------

export interface EmoteUsage {
    emote_id: string;
    emote_name: string;
    provider: string;
    image_url: string | null;
    count: number;
}

/**
 * Increment usage of an emote for a user. Atomic via the `increment_emote_usage`
 * RPC, with a manual-upsert fallback. Fire-and-forget; never throws.
 */
export const incrementEmoteUsage = async (
    userId: string,
    emote: { id: string; name: string; provider: string; url: string },
    amount: number = 1,
): Promise<void> => {
    if (!supabase || !userId || !emote?.id) return;
    try {
        const { error } = await supabase.rpc('increment_emote_usage', {
            p_user_id: userId,
            p_emote_id: emote.id,
            p_emote_name: emote.name,
            p_provider: emote.provider,
            p_image_url: emote.url,
            p_amount: amount,
        });
        if (!error) return;
        await manualIncrementEmote(userId, emote, amount);
    } catch (error) {
        Logger.warn('[Supabase] incrementEmoteUsage failed:', error);
    }
};

const manualIncrementEmote = async (
    userId: string,
    emote: { id: string; name: string; provider: string; url: string },
    amount: number,
): Promise<void> => {
    if (!supabase) return;
    try {
        const { data: existing } = await supabase
            .from('user_emote_usage')
            .select('count')
            .eq('twitch_user_id', userId)
            .eq('emote_id', emote.id)
            .maybeSingle();
        const newCount = ((existing as { count?: number } | null)?.count || 0) + amount;
        await supabase.from('user_emote_usage').upsert(
            {
                twitch_user_id: userId,
                emote_id: emote.id,
                emote_name: emote.name,
                provider: emote.provider,
                image_url: emote.url,
                count: newCount,
                updated_at: new Date().toISOString(),
            },
            { onConflict: 'twitch_user_id,emote_id' },
        );
    } catch (error) {
        Logger.warn('[Supabase] manual emote increment failed:', error);
    }
};

/**
 * Get a user's most-used emotes, highest count first. Returns [] when Supabase
 * is unconfigured or the table is missing.
 */
export interface EmoteUsageSummary {
    top: EmoteUsage[];
    uniqueCount: number;
    totalCount: number;
}

/**
 * Get a user's emote usage: the top emotes (highest count first), the count of
 * distinct emotes used, and total uses. Returns zeros when Supabase is
 * unconfigured or the table is missing.
 */
export const getEmoteUsageSummary = async (
    userId: string,
    topLimit: number = 12,
): Promise<EmoteUsageSummary> => {
    const empty: EmoteUsageSummary = { top: [], uniqueCount: 0, totalCount: 0 };
    if (!supabase || !userId) return empty;
    try {
        const { data, error } = await supabase
            .from('user_emote_usage')
            .select('emote_id, emote_name, provider, image_url, count')
            .eq('twitch_user_id', userId)
            .order('count', { ascending: false })
            .limit(1000);
        if (error) {
            Logger.error('[Supabase] Failed to get emote usage:', error.message);
            return empty;
        }
        const rows = (data as EmoteUsage[]) || [];
        return {
            top: rows.slice(0, topLimit),
            uniqueCount: rows.length,
            totalCount: rows.reduce((s, e) => s + e.count, 0),
        };
    } catch (error) {
        Logger.error('[Supabase] Failed to get emote usage:', error);
        return empty;
    }
};

// ---------------------------------------------------------------------------
// Per-channel watch time (drives the "favorite channel" stat)
// ---------------------------------------------------------------------------

export interface ChannelWatch {
    channel_id: string;
    channel_login: string;
    channel_name: string;
    minutes: number;
}

/**
 * Add watch minutes to a channel for a user. Atomic via the
 * `increment_channel_watch` RPC, with a manual-upsert fallback. Fire-and-forget.
 */
export const incrementChannelWatch = async (
    userId: string,
    channel: { id: string; login: string; name: string },
    amount: number = 1,
): Promise<void> => {
    if (!supabase || !userId || !channel?.id) return;
    try {
        const { error } = await supabase.rpc('increment_channel_watch', {
            p_user_id: userId,
            p_channel_id: channel.id,
            p_channel_login: channel.login,
            p_channel_name: channel.name,
            p_amount: amount,
        });
        if (!error) return;
        const { data: existing } = await supabase
            .from('user_channel_watch')
            .select('minutes')
            .eq('twitch_user_id', userId)
            .eq('channel_id', channel.id)
            .maybeSingle();
        const newMinutes = ((existing as { minutes?: number } | null)?.minutes || 0) + amount;
        await supabase.from('user_channel_watch').upsert(
            {
                twitch_user_id: userId,
                channel_id: channel.id,
                channel_login: channel.login,
                channel_name: channel.name,
                minutes: newMinutes,
                updated_at: new Date().toISOString(),
            },
            { onConflict: 'twitch_user_id,channel_id' },
        );
    } catch (error) {
        Logger.warn('[Supabase] incrementChannelWatch failed:', error);
    }
};

/** The channel a user has spent the most time watching, or null. */
export const getFavoriteChannel = async (userId: string): Promise<ChannelWatch | null> => {
    if (!supabase || !userId) return null;
    try {
        const { data, error } = await supabase
            .from('user_channel_watch')
            .select('channel_id, channel_login, channel_name, minutes')
            .eq('twitch_user_id', userId)
            .order('minutes', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) {
            Logger.error('[Supabase] Failed to get favorite channel:', error.message);
            return null;
        }
        return (data as ChannelWatch) || null;
    } catch (error) {
        Logger.error('[Supabase] Failed to get favorite channel:', error);
        return null;
    }
};

// ---------------------------------------------------------------------------
// Profile preferences (e.g. use your 7TV paint as your profile theme)
// ---------------------------------------------------------------------------

export interface ProfilePrefs {
    // True when the chosen theme is the 7TV paint (derived from profileTheme;
    // kept for back-compat with existing callers).
    paintTheme: boolean;
    // The theme source: 'tier' (free default) | 'paint' (7TV paint) | an
    // Atmosphere id like 'void'. Source of truth for the profile background.
    profileTheme: string;
    // Section keys the member has HIDDEN from their public profile (what other
    // members see). Empty = all visible. Keys: roast, twitch, lifetime, emotes,
    // accolades.
    hiddenSections: string[];
}

export const getProfilePrefs = async (userId: string): Promise<ProfilePrefs> => {
    if (!supabase || !userId) return { paintTheme: false, profileTheme: 'tier', hiddenSections: [] };
    try {
        const { data, error } = await supabase
            .from('user_profile_prefs')
            .select('paint_theme, profile_theme, hidden_sections')
            .eq('twitch_user_id', userId)
            .maybeSingle();
        if (error) {
            Logger.error('[Supabase] Failed to get profile prefs:', error.message);
            return { paintTheme: false, profileTheme: 'tier', hiddenSections: [] };
        }
        const row = data as { paint_theme?: boolean; profile_theme?: string; hidden_sections?: string[] } | null;
        const profileTheme = row?.profile_theme || (row?.paint_theme ? 'paint' : 'tier');
        return {
            paintTheme: profileTheme === 'paint',
            profileTheme,
            hiddenSections: Array.isArray(row?.hidden_sections) ? row!.hidden_sections! : [],
        };
    } catch (error) {
        Logger.error('[Supabase] Failed to get profile prefs:', error);
        return { paintTheme: false, profileTheme: 'tier', hiddenSections: [] };
    }
};

export const setProfileTheme = async (userId: string, theme: string): Promise<void> => {
    if (!supabase || !userId) return;
    try {
        const { error } = await supabase.from('user_profile_prefs').upsert(
            {
                twitch_user_id: userId,
                profile_theme: theme,
                paint_theme: theme === 'paint', // keep the legacy flag in sync
                updated_at: new Date().toISOString(),
            },
            { onConflict: 'twitch_user_id' },
        );
        if (error) Logger.error('[Supabase] Failed to set profile theme:', error.message);
    } catch (error) {
        Logger.warn('[Supabase] setProfileTheme failed:', error);
    }
};

export const setHiddenSections = async (userId: string, sections: string[]): Promise<void> => {
    if (!supabase || !userId) return;
    try {
        const { error } = await supabase.from('user_profile_prefs').upsert(
            { twitch_user_id: userId, hidden_sections: sections, updated_at: new Date().toISOString() },
            { onConflict: 'twitch_user_id' },
        );
        if (error) Logger.error('[Supabase] Failed to set hidden sections:', error.message);
    } catch (error) {
        Logger.warn('[Supabase] setHiddenSections failed:', error);
    }
};

/**
 * Whether a member has an active StreamNook subscription, read from the
 * `stripe_subscriptions` table (the Stripe-backed support flow writes it). A
 * subscription counts when its latest row's status is 'active' or 'past_due' (the
 * payment-retry grace window). Requires the table to be SELECT-readable by the
 * anon key (the same way the cosmetics registry is).
 */
export const isStripeSubscriber = async (userId: string): Promise<boolean> => {
    if (!supabase || !userId) return false;
    try {
        const { data, error } = await supabase
            .from('stripe_subscriptions')
            .select('status')
            .eq('twitch_user_id', userId)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) {
            Logger.warn('[Supabase] subscriber status read failed:', error.message);
            return false;
        }
        const status = (data as { status?: string } | null)?.status;
        // Entitled-while-active set mirrors the webhook's grant gate: active +
        // past_due (payment retrying, keep access during the grace window) +
        // trialing (no trial is configured today, but stay forward-safe).
        return status === 'active' || status === 'past_due' || status === 'trialing';
    } catch (error) {
        Logger.warn('[Supabase] isStripeSubscriber failed:', error);
        return false;
    }
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
        // See subscribeToCosmeticsRegistry for the reconnect rationale: realtime
        // does not replay events missed while disconnected, so re-pull on every
        // reconnect (not the initial connect) to self-heal without a restart.
        let connectedOnce = false;
        snRegistryChannel = supabase
            .channel('streamnook-registry')
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'users',
            }, () => {
                loadStreamNookRegistry();
            })
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    if (connectedOnce) loadStreamNookRegistry();
                    connectedOnce = true;
                }
            });
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
        // Supabase fires SUBSCRIBED on the initial connect AND on every reconnect
        // after a drop (sleep/wake, network blip, server hiccup). Realtime does
        // NOT replay events missed while disconnected, so a grant that landed
        // during the gap (e.g. a streamnook.app purchase completing while the
        // socket was down) would otherwise only show after an app restart.
        // Re-pull on every reconnect (skipping the first connect, which the eager
        // load above already covered) so a running client self-heals on its own.
        let connectedOnce = false;
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
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    if (connectedOnce) loadCosmetics();
                    connectedOnce = true;
                }
            });
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

// ─── Atmosphere catalog registry ───────────────────────────────────────────
// Server-driven Atmosphere definitions (the `atmospheres` table), mirroring the
// cosmetics registry above: an in-memory map filled at startup + realtime, sync
// reads, a version counter for useSyncExternalStore, and a ready-promise the
// async resolvers await so they never resolve against an empty catalog. Ownership
// is NOT here (an Atmosphere is unlocked by subscription or an accolade), so this
// is a pure global catalog.

let atmospheresCatalog: Map<string, Atmosphere> = new Map();
let atmospheresChannel: RealtimeChannel | null = null;
let atmospheresLoaded = false;
let atmospheresLoading: Promise<void> | null = null;
let atmospheresVersion = 0;
const atmospheresVersionSubscribers = new Set<() => void>();

const bumpAtmospheresVersion = () => {
    atmospheresVersion++;
    for (const cb of atmospheresVersionSubscribers) {
        try { cb(); } catch (e) { Logger.error('[Supabase] Atmospheres subscriber error:', e); }
    }
};

interface AtmosphereRow {
    id: string;
    name: string;
    accent: string;
    swatch: string;
    base_color: string;
    base_layers: string | null;
    image: string | null;
    image_profile_portrait: boolean;
    layers: string | null;
    layers2: string | null;
    motion: string;
    chat_edge: string;
    unlock_kind: string;
    unlock_accolade_id: string | null;
    sort_order: number;
}

const rowToAtmosphere = (row: AtmosphereRow): Atmosphere => ({
    id: row.id,
    name: row.name,
    accent: row.accent,
    swatch: row.swatch,
    baseColor: row.base_color,
    baseLayers: row.base_layers ?? undefined,
    image: row.image ?? undefined,
    imageProfilePortrait: row.image_profile_portrait,
    layers: row.layers ?? undefined,
    layers2: row.layers2 ?? undefined,
    motion: row.motion === 'drift' ? 'drift' : 'aurora',
    chatEdge: row.chat_edge,
    unlock: row.unlock_kind === 'accolade' && row.unlock_accolade_id
        ? { kind: 'accolade', accoladeId: row.unlock_accolade_id }
        : { kind: 'subscriber' },
});

const loadAtmospheres = async (): Promise<void> => {
    if (!supabase) return;
    if (atmospheresLoading) return atmospheresLoading;
    atmospheresLoading = (async () => {
        try {
            const res = await supabase!
                .from('atmospheres')
                .select('*')
                .eq('is_active', true)
                .order('sort_order');
            if (res.error) Logger.error('[Supabase] atmospheres catalog load failed:', res.error);
            const next = new Map<string, Atmosphere>();
            for (const row of (res.data || []) as AtmosphereRow[]) {
                next.set(row.id, rowToAtmosphere(row));
            }
            atmospheresCatalog = next;
            atmospheresLoaded = true;
            // Warm the browser cache for image-backed atmospheres so a profile or
            // chat row that shows one paints instantly instead of fetching the
            // webp on first sighting. Cheap (a handful of small files); the
            // browser dedupes repeats across reloads.
            if (typeof Image !== 'undefined') {
                for (const atm of next.values()) {
                    if (atm.image) { const img = new Image(); img.src = atm.image; }
                }
            }
            Logger.debug('[Supabase] Atmospheres loaded:', { catalog: next.size });
            bumpAtmospheresVersion();
        } catch (e) {
            Logger.error('[Supabase] loadAtmospheres exception:', e);
        } finally {
            atmospheresLoading = null;
        }
    })();
    return atmospheresLoading;
};

/**
 * Subscribe to the atmospheres registry. Idempotent. The first call triggers the
 * initial fetch and opens a realtime channel on the `atmospheres` table itself
 * (so a new/edited row reaches running clients with no relaunch).
 */
export const subscribeToAtmospheresRegistry = (
    callback?: () => void,
): (() => void) | null => {
    if (!supabase) return null;

    const cb = () => callback?.();
    atmospheresVersionSubscribers.add(cb);

    if (!atmospheresLoaded && !atmospheresLoading) {
        loadAtmospheres();
    } else if (atmospheresLoaded) {
        callback?.();
    }

    if (!atmospheresChannel) {
        // See subscribeToCosmeticsRegistry for the reconnect rationale.
        let connectedOnce = false;
        atmospheresChannel = supabase
            .channel('atmospheres-registry')
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'atmospheres',
            }, () => { loadAtmospheres(); })
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    if (connectedOnce) loadAtmospheres();
                    connectedOnce = true;
                }
            });
    }

    return () => {
        atmospheresVersionSubscribers.delete(cb);
        if (atmospheresVersionSubscribers.size === 0 && atmospheresChannel) {
            atmospheresChannel.unsubscribe();
            atmospheresChannel = null;
        }
    };
};

/** Sync read: an atmosphere definition by id (null if unknown / not loaded). */
export const getAtmosphereEntry = (id: string | undefined | null): Atmosphere | null => {
    if (!id) return null;
    return atmospheresCatalog.get(id) ?? null;
};

/** Sync read: the full catalog (already in sort_order from the load query). */
export const listAtmosphereEntries = (): Atmosphere[] =>
    Array.from(atmospheresCatalog.values());

/** For React useSyncExternalStore: subscribe to / read the catalog version. */
export const subscribeAtmospheresVersion = (cb: () => void): (() => void) => {
    atmospheresVersionSubscribers.add(cb);
    if (!atmospheresLoaded && !atmospheresLoading && supabase) {
        loadAtmospheres();
    }
    return () => { atmospheresVersionSubscribers.delete(cb); };
};
export const getAtmospheresVersion = (): number => atmospheresVersion;

/** Resolves once the catalog has loaded (or immediately if Supabase is off), so
 *  async resolvers never read an empty catalog. */
export const whenAtmospheresReady = (): Promise<void> => {
    if (atmospheresLoaded || !supabase) return Promise.resolve();
    return loadAtmospheres();
};

/**
 * Force a re-pull of the entitlement-bearing registries (cosmetics + user
 * registry + atmospheres). Wired to window focus in App.tsx so that when the
 * user returns to the app after completing a purchase on streamnook.app in their
 * browser, any grant the realtime channel happened to miss (e.g. it was
 * mid-reconnect) still shows immediately, with no app restart. All three loaders
 * are single-flight + idempotent, so calling this freely is safe.
 */
export const refreshEntitlementRegistries = (): void => {
    if (!supabase) return;
    loadCosmetics();
    loadStreamNookRegistry();
    loadAtmospheres();
};

// ─── Profile snapshot cache (stale-while-revalidate) ───────────────────────
// A per-user CACHE of a member's fully-resolved profile so the public profile
// overlay can paint instantly from ONE read, then revalidate the live sources
// in the background. NOT a source of truth (7TV/Twitch stay authoritative); a
// stale row self-corrects on the next open. See migration 20260605000001.

// Single JSONB blob; `v` lets the shape evolve without a migration. Cosmetic
// sub-objects are kept loose (resolved upstream) to avoid coupling to deep 7TV
// types — consumers treat them as opaque render data.
export interface ProfileSnapshot {
    v: 1;
    identity: { login: string; displayName: string; avatar: string };
    profileTheme: string; // 'tier' | 'paint' | <atmosphere id>
    hiddenSections: string[];
    memberNumber: number | null;
    cosmeticSlug: string | null; // active StreamNook cosmetic
    namePaint: Record<string, unknown> | null; // resolved 7TV paint style (CSSProperties)
    seventvBadge: Record<string, unknown> | null; // active 7TV badge
    wornBadges: {
        twitch: { src: string; title: string } | null;
        thirdParty: Array<{ key?: string; provider?: string; title?: string; src: string }>;
        bttvPro: { src: string; title: string } | null;
    };
    counts: { paints: number; badges: number; sn: number };
    stats: { messages: number; streams: number; hours: number } | null;
    accolades: string[]; // earned accolade ids
    favoriteChannel: unknown | null;
    ivr: { followers: number | null; createdAt: string | null; roles: unknown } | null;
}

/** Read a member's cached profile snapshot (null if none / unknown version). */
export const getProfileSnapshot = async (
    userId: string,
): Promise<{ snapshot: ProfileSnapshot; updatedAt: string } | null> => {
    if (!supabase || !userId) return null;
    try {
        const { data, error } = await supabase
            .from('user_profile_snapshot')
            .select('snapshot, updated_at')
            .eq('twitch_user_id', userId)
            .maybeSingle();
        if (error || !data) return null;
        const row = data as { snapshot: ProfileSnapshot | null; updated_at: string };
        if (!row.snapshot || row.snapshot.v !== 1) return null;
        return { snapshot: row.snapshot, updatedAt: row.updated_at };
    } catch (e) {
        Logger.warn('[Supabase] getProfileSnapshot failed:', e);
        return null;
    }
};

/** Write/refresh a member's cached profile snapshot (cache-aside fill). */
export const upsertProfileSnapshot = async (
    userId: string,
    snapshot: ProfileSnapshot,
): Promise<void> => {
    if (!supabase || !userId) return;
    try {
        const { error } = await supabase.from('user_profile_snapshot').upsert(
            { twitch_user_id: userId, snapshot, updated_at: new Date().toISOString() },
            { onConflict: 'twitch_user_id' },
        );
        if (error) Logger.warn('[Supabase] upsertProfileSnapshot failed:', error.message);
    } catch (e) {
        Logger.warn('[Supabase] upsertProfileSnapshot exception:', e);
    }
};

/**
 * Optimistically patch ONLY the profileTheme of a member's cached snapshot after
 * they change their atmosphere, so the next profile-card open (theirs or anyone
 * else's) reflects it without waiting for the lazy stale-rewrite, and so the
 * instant snapshot render can't clobber the fresh prefs with the old theme. The
 * other snapshot fields are untouched (a theme change doesn't affect them), so it
 * stays consistent. No-op when no snapshot exists yet (the overlay builds fresh).
 */
export const patchProfileSnapshotTheme = async (userId: string, theme: string): Promise<void> => {
    if (!supabase || !userId) return;
    try {
        const existing = await getProfileSnapshot(userId);
        if (!existing || existing.snapshot.profileTheme === theme) return;
        await upsertProfileSnapshot(userId, { ...existing.snapshot, profileTheme: theme });
    } catch (e) {
        Logger.warn('[Supabase] patchProfileSnapshotTheme failed:', e);
    }
};

/** Read a member's Twitch identity (login/display/avatar) from OUR `users` table,
 *  so the profile overlay can paint instantly without a Twitch Helix round-trip.
 *  Helix becomes a background revalidation. Null for users we've never recorded
 *  (e.g. non-members), which fall back to Helix. */
export const getUserIdentity = async (
    userId: string,
): Promise<{ login: string; displayName: string; avatar: string } | null> => {
    if (!supabase || !userId) return null;
    try {
        const { data, error } = await supabase
            .from('users')
            .select('username, display_name, avatar_url')
            .eq('id', userId)
            .maybeSingle();
        if (error || !data) return null;
        const row = data as { username?: string; display_name?: string; avatar_url?: string };
        if (!row.username) return null;
        return {
            login: row.username,
            displayName: row.display_name || row.username,
            avatar: row.avatar_url || '',
        };
    } catch (e) {
        Logger.warn('[Supabase] getUserIdentity failed:', e);
        return null;
    }
};

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
    incrementStat,
    getLastWriteIssue,
    subscribeToWriteIssues,
    getUserStats,
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
    refreshEntitlementRegistries,
};
