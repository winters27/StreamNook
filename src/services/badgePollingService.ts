// Badge Polling Service
// Polls for new badges and emits notifications when new badges are detected
// or when badges become available

import { invoke } from '@tauri-apps/api/core';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const KNOWN_BADGES_KEY = 'streamnook_known_badges';
const NOTIFIED_AVAILABLE_KEY = 'streamnook_notified_available_badges';

export interface BadgeVersion {
    id: string;
    image_url_1x: string;
    image_url_2x: string;
    image_url_4x: string;
    title: string;
    description: string;
}

export interface BadgeMetadata {
    date_added: string | null;
    usage_stats: string | null;
    more_info: string | null;
    info_url: string;
}

export interface BadgeSet {
    set_id: string;
    versions: BadgeVersion[];
}

export interface BadgeWithStatus {
    set_id: string;
    version: BadgeVersion;
    status: 'available' | 'coming_soon' | 'expired' | null;
    metadata?: BadgeMetadata;
}

export interface BadgeNotification {
    badge_name: string;
    badge_set_id: string;
    badge_version: string;
    badge_image_url: string;
    badge_description?: string;
    status: 'new' | 'available' | 'coming_soon';
    date_info?: string;
}

type BadgeEventCallback = (badges: BadgeNotification[]) => void;

class BadgePollingService {
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private isPolling = false;
    private listeners: BadgeEventCallback[] = [];
    private lastPollTimestamp: number = 0;

    // Start polling for badges
    start() {
        if (this.intervalId) {
            console.log('[BadgePolling] Already running');
            return;
        }

        console.log('[BadgePolling] Starting badge polling service');

        // Do an initial poll after a short delay to let the app settle
        setTimeout(() => {
            this.poll();
        }, 10000); // 10 seconds

        // Then poll every 5 minutes
        this.intervalId = setInterval(() => {
            this.poll();
        }, POLL_INTERVAL_MS);
    }

    // Stop polling
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            console.log('[BadgePolling] Stopped badge polling service');
        }
    }

    // Subscribe to badge notifications
    subscribe(callback: BadgeEventCallback) {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter(l => l !== callback);
        };
    }

    // Emit badge notifications to all listeners
    private emit(badges: BadgeNotification[]) {
        this.listeners.forEach(listener => listener(badges));
    }

    // Get known badges from localStorage
    private getKnownBadges(): Set<string> {
        try {
            const stored = localStorage.getItem(KNOWN_BADGES_KEY);
            if (stored) {
                return new Set(JSON.parse(stored));
            }
        } catch {
            // Ignore parse errors
        }
        return new Set();
    }

    // Save known badges to localStorage
    private saveKnownBadges(badges: Set<string>) {
        try {
            localStorage.setItem(KNOWN_BADGES_KEY, JSON.stringify([...badges]));
        } catch (error) {
            console.warn('[BadgePolling] Failed to save known badges:', error);
        }
    }

    // Get badges we've already notified about being available
    private getNotifiedAvailable(): Set<string> {
        try {
            const stored = localStorage.getItem(NOTIFIED_AVAILABLE_KEY);
            if (stored) {
                return new Set(JSON.parse(stored));
            }
        } catch {
            // Ignore parse errors
        }
        return new Set();
    }

    // Save notified available badges to localStorage
    private saveNotifiedAvailable(badges: Set<string>) {
        try {
            localStorage.setItem(NOTIFIED_AVAILABLE_KEY, JSON.stringify([...badges]));
        } catch (error) {
            console.warn('[BadgePolling] Failed to save notified available badges:', error);
        }
    }

    // Parse date range from more_info field
    private parseDateRange(text: string): { start: Date; end: Date } | null {
        const months: Record<string, number> = {
            'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3,
            'May': 4, 'Jun': 5, 'Jul': 6, 'Aug': 7,
            'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
        };
        const currentYear = new Date().getFullYear();

        // Match "Mon DD – Mon DD" format (e.g., "Dec 06 – Dec 07")
        const fullRangeMatch = text.match(/(\w{3})\s+(\d{1,2})\s*[–-]\s*(\w{3})\s+(\d{1,2})/);
        if (fullRangeMatch) {
            const startMonthAbbrev = fullRangeMatch[1];
            const startDay = parseInt(fullRangeMatch[2], 10);
            const endMonthAbbrev = fullRangeMatch[3];
            const endDay = parseInt(fullRangeMatch[4], 10);

            if (months.hasOwnProperty(startMonthAbbrev) && months.hasOwnProperty(endMonthAbbrev)) {
                const startDate = new Date(currentYear, months[startMonthAbbrev], startDay, 0, 0, 0);
                const endDate = new Date(currentYear, months[endMonthAbbrev], endDay, 23, 59, 59);
                return { start: startDate, end: endDate };
            }
        }

        // Match "Mon D-D" or "Mon D - D" format (e.g., "Dec 1-12" or "Dec 1 - 12")
        const shortRangeMatch = text.match(/(\w{3})\s+(\d{1,2})\s*[–-]\s*(\d{1,2})(?!\s*\w)/);
        if (shortRangeMatch) {
            const monthAbbrev = shortRangeMatch[1];
            const startDay = parseInt(shortRangeMatch[2], 10);
            const endDay = parseInt(shortRangeMatch[3], 10);

            if (months.hasOwnProperty(monthAbbrev)) {
                const monthNum = months[monthAbbrev];
                const startDate = new Date(currentYear, monthNum, startDay, 0, 0, 0);
                const endDate = new Date(currentYear, monthNum, endDay, 23, 59, 59);
                return { start: startDate, end: endDate };
            }
        }

        return null;
    }

    // Get badge status based on more_info metadata
    private getBadgeStatus(metadata?: BadgeMetadata): { status: 'available' | 'coming_soon' | 'expired' | null; dateInfo?: string } {
        const moreInfo = metadata?.more_info;
        if (!moreInfo) return { status: null };

        const now = Date.now();
        const dateRange = this.parseDateRange(moreInfo);

        if (dateRange) {
            const startTime = dateRange.start.getTime();
            const endTime = dateRange.end.getTime();

            // Extract date info for display
            const dateMatch = moreInfo.match(/(\w{3}\s+\d{1,2}(?:\s*[–-]\s*(?:\w{3}\s+)?\d{1,2})?)/);
            const dateInfo = dateMatch ? dateMatch[1] : undefined;

            if (now < startTime) {
                return { status: 'coming_soon', dateInfo };
            } else if (now >= startTime && now <= endTime) {
                return { status: 'available', dateInfo };
            } else {
                return { status: 'expired', dateInfo };
            }
        }

        return { status: null };
    }

    // Main poll function
    async poll() {
        if (this.isPolling) {
            console.log('[BadgePolling] Already polling, skipping');
            return;
        }

        this.isPolling = true;
        console.log('[BadgePolling] Polling for badge updates...');

        try {
            // Get cached badges first
            const cachedBadges = await invoke<{ data: BadgeSet[] } | null>('get_cached_global_badges');

            if (!cachedBadges || !cachedBadges.data || cachedBadges.data.length === 0) {
                console.log('[BadgePolling] No cached badges, skipping poll');
                this.isPolling = false;
                return;
            }

            // Get known badges and notified available badges
            const knownBadges = this.getKnownBadges();
            const notifiedAvailable = this.getNotifiedAvailable();
            const notifications: BadgeNotification[] = [];

            // Flatten badges
            const allBadges: { set_id: string; version: BadgeVersion }[] = [];
            for (const set of cachedBadges.data) {
                for (const version of set.versions) {
                    allBadges.push({ set_id: set.set_id, version });
                }
            }

            // Check each badge
            for (const { set_id, version } of allBadges) {
                const badgeKey = `${set_id}-v${version.id}`;

                // Try to get metadata for this badge
                let metadata: BadgeMetadata | undefined;
                try {
                    const cached = await invoke<{ data: BadgeMetadata } | null>('get_universal_cached_item', {
                        cacheType: 'badge',
                        id: `metadata:${badgeKey}`,
                    });
                    if (cached) {
                        metadata = cached.data;
                    }
                } catch {
                    // Metadata not available, that's okay
                }

                // Get current status
                const { status, dateInfo } = this.getBadgeStatus(metadata);

                // Check if this is a new badge we haven't seen before
                if (!knownBadges.has(badgeKey)) {
                    console.log(`[BadgePolling] New badge detected: ${version.title} (${badgeKey})`);

                    // Only notify for new badges if they're available or coming soon
                    if (status === 'available' || status === 'coming_soon') {
                        notifications.push({
                            badge_name: version.title,
                            badge_set_id: set_id,
                            badge_version: version.id,
                            badge_image_url: version.image_url_4x || version.image_url_2x || version.image_url_1x,
                            badge_description: version.description,
                            status: 'new',
                            date_info: dateInfo,
                        });
                    } else if (!status) {
                        // If no time-sensitive status, still notify as new
                        notifications.push({
                            badge_name: version.title,
                            badge_set_id: set_id,
                            badge_version: version.id,
                            badge_image_url: version.image_url_4x || version.image_url_2x || version.image_url_1x,
                            badge_description: version.description,
                            status: 'new',
                        });
                    }

                    // Mark as known
                    knownBadges.add(badgeKey);
                }

                // Check if a known badge just became available (status changed)
                if (knownBadges.has(badgeKey) && status === 'available' && !notifiedAvailable.has(badgeKey)) {
                    console.log(`[BadgePolling] Badge now available: ${version.title} (${badgeKey})`);

                    notifications.push({
                        badge_name: version.title,
                        badge_set_id: set_id,
                        badge_version: version.id,
                        badge_image_url: version.image_url_4x || version.image_url_2x || version.image_url_1x,
                        badge_description: version.description,
                        status: 'available',
                        date_info: dateInfo,
                    });

                    // Mark as notified for availability
                    notifiedAvailable.add(badgeKey);
                }
            }

            // Save updated known badges and notified available
            this.saveKnownBadges(knownBadges);
            this.saveNotifiedAvailable(notifiedAvailable);

            // Emit only the most recent/latest badge notification (not the entire list)
            if (notifications.length > 0) {
                // Take only the most recent badge (last one added)
                const latestBadge = notifications[notifications.length - 1];
                console.log(`[BadgePolling] Emitting 1 badge notification (${latestBadge.badge_name}) out of ${notifications.length} detected`);
                this.emit([latestBadge]);
            }

            this.lastPollTimestamp = Date.now();
            console.log('[BadgePolling] Poll complete');
        } catch (error) {
            console.error('[BadgePolling] Error during poll:', error);
        } finally {
            this.isPolling = false;
        }
    }

    // Force a refresh - useful when user manually refreshes badges
    async forceRefresh() {
        console.log('[BadgePolling] Force refresh triggered');
        await this.poll();
    }

    // Clear known badges (useful for testing or reset)
    clearKnownBadges() {
        localStorage.removeItem(KNOWN_BADGES_KEY);
        localStorage.removeItem(NOTIFIED_AVAILABLE_KEY);
        console.log('[BadgePolling] Cleared known badges cache');
    }

    // Get last poll timestamp
    getLastPollTimestamp(): number {
        return this.lastPollTimestamp;
    }
}

// Export singleton instance
export const badgePollingService = new BadgePollingService();
