import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bell, Radio, MessageCircle, ChevronRight, User, Download, Gift, Award } from 'lucide-react';
import { X, SpeakerHigh, SpeakerSlash } from 'phosphor-react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { badgePollingService, type BadgeNotification } from '../services/badgePollingService';
import type {
    DynamicIslandNotification,
    LiveNotificationData,
    WhisperNotificationData,
    UpdateNotificationData,
    DropsNotificationData,
    ChannelPointsNotificationData,
    BadgeNotificationData,
} from '../types';

const MAX_NOTIFICATIONS = 20;
const CACHE_KEY = 'streamnook_notifications';
const CACHE_EXPIRY_DAYS = 7;

interface LiveNotificationFromBackend {
    streamer_name: string;
    streamer_login: string;
    streamer_avatar?: string;
    game_name?: string;
    game_image?: string;
    stream_title?: string;
    stream_url: string;
    is_test?: boolean;
}

interface WhisperFromBackend {
    from_user_id: string;
    from_user_login: string;
    from_user_name: string;
    to_user_id: string;
    to_user_login: string;
    to_user_name: string;
    whisper_id: string;
    text: string;
}

interface BundleUpdateStatus {
    update_available: boolean;
    current_version: string;
    latest_version: string;
    download_url: string | null;
    bundle_name: string | null;
    download_size: string | null;
}

interface DropClaimedEvent {
    drop_name: string;
    game_name: string;
    benefit_name?: string;
    benefit_image_url?: string;
}

interface ChannelPointsEarnedEvent {
    channel_id: string | null;
    channel_login: string | null;
    channel_display_name: string | null;
    points: number;
    reason: string;
    balance: number;
}

// Individual channel points event for history
interface ChannelPointsHistoryEvent {
    id: string;
    points: number;
    reason: string;
    channel_name: string | null;
    timestamp: number;
}

// Extended notification data for channel points with stacking
interface ChannelPointsStackData extends ChannelPointsNotificationData {
    history: ChannelPointsHistoryEvent[];
    latestEvent: ChannelPointsHistoryEvent | null;
}

// Clustering state for channel points (batching rapid events)
interface ClusteredChannelPoints {
    totalPoints: number;
    events: Array<{
        points: number;
        reason: string;
        channel_name: string | null;
        timestamp: number;
    }>;
    lastUpdate: number;
    lastBalance?: number; // Track the most recent balance
}

// Cache key for channel points stack
const CHANNEL_POINTS_STACK_KEY = 'streamnook_channel_points_stack';

// Cache helpers
const loadCachedNotifications = (): DynamicIslandNotification[] => {
    try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (!cached) return [];

        const { notifications, timestamp } = JSON.parse(cached);
        const expiryTime = CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

        // Filter out notifications older than expiry time
        const validNotifications = notifications.filter(
            (n: DynamicIslandNotification) => Date.now() - n.timestamp < expiryTime
        );

        return validNotifications.slice(0, MAX_NOTIFICATIONS);
    } catch {
        return [];
    }
};

const saveCachedNotifications = (notifications: DynamicIslandNotification[]) => {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            notifications: notifications.slice(0, MAX_NOTIFICATIONS),
            timestamp: Date.now(),
        }));
    } catch (error) {
        console.warn('Failed to cache notifications:', error);
    }
};

const DynamicIsland = () => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [notifications, setNotifications] = useState<DynamicIslandNotification[]>(() => loadCachedNotifications());
    const [hasUnread, setHasUnread] = useState(false);
    const [latestNotification, setLatestNotification] = useState<DynamicIslandNotification | null>(null);
    const [showPreview, setShowPreview] = useState(false);
    const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });
    const islandRef = useRef<HTMLDivElement>(null);
    const previewTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const updateCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);

    const { startStream, settings, setShowWhispersOverlay, openWhisperWithUser, openSettings, addToast, setShowDropsOverlay, setShowBadgesOverlay } = useAppStore();

    const soundEnabled = settings.live_notifications?.play_sound ?? true;
    const notificationsEnabled = settings.live_notifications?.enabled ?? true;
    const showLiveNotifications = settings.live_notifications?.show_live_notifications ?? true;
    const showWhisperNotifications = settings.live_notifications?.show_whisper_notifications ?? true;
    const showUpdateNotifications = settings.live_notifications?.show_update_notifications ?? true;
    const showDropsNotifications = settings.live_notifications?.show_drops_notifications ?? true;
    const showChannelPointsNotifications = settings.live_notifications?.show_channel_points_notifications ?? true;
    const showBadgeNotifications = settings.live_notifications?.show_badge_notifications ?? true;
    const useDynamicIsland = settings.live_notifications?.use_dynamic_island ?? true;
    const useToast = settings.live_notifications?.use_toast ?? true;

    // Save notifications to cache whenever they change
    useEffect(() => {
        saveCachedNotifications(notifications);
    }, [notifications]);

    // Track window size for responsive notification center
    useEffect(() => {
        const handleResize = () => {
            setWindowSize({ width: window.innerWidth, height: window.innerHeight });
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Calculate responsive dimensions for notification center
    const getExpandedDimensions = () => {
        const { width, height } = windowSize;

        // Base dimensions
        let expandedWidth = 360;
        let maxHeight = 480;
        let itemHeight = 80;

        // Scale up for larger screens
        if (width >= 1920) {
            expandedWidth = Math.min(480, width * 0.25);
            maxHeight = Math.min(600, height * 0.6);
            itemHeight = 90;
        } else if (width >= 1440) {
            expandedWidth = Math.min(420, width * 0.28);
            maxHeight = Math.min(540, height * 0.55);
            itemHeight = 85;
        } else if (width >= 1280) {
            expandedWidth = Math.min(380, width * 0.3);
            maxHeight = Math.min(500, height * 0.5);
            itemHeight = 82;
        }

        return { expandedWidth, maxHeight, itemHeight };
    };

    const { expandedWidth, maxHeight, itemHeight } = getExpandedDimensions();

    // Check if a streamer is still live
    const checkIfStillLive = useCallback(async (userLogin: string): Promise<boolean> => {
        try {
            const streamData = await invoke('check_stream_online', { userLogin });
            return streamData !== null;
        } catch {
            return false;
        }
    }, []);

    // Play notification sound
    const playNotificationSound = useCallback(() => {
        try {
            const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            // Gentle whisper-like notification sound
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(520, audioContext.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(380, audioContext.currentTime + 0.12);
            gainNode.gain.setValueAtTime(0, audioContext.currentTime);
            gainNode.gain.linearRampToValueAtTime(0.07, audioContext.currentTime + 0.02);
            gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.25);
            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.25);
        } catch (error) {
            console.warn('Could not play notification sound:', error);
        }
    }, []);

    // Add notification
    const addNotification = useCallback((notification: DynamicIslandNotification) => {
        setNotifications(prev => {
            const newNotifications = [notification, ...prev].slice(0, MAX_NOTIFICATIONS);
            return newNotifications;
        });
        setHasUnread(true);
        setLatestNotification(notification);
        setShowPreview(true);

        // Auto-hide preview after 3 seconds
        if (previewTimeoutRef.current) {
            clearTimeout(previewTimeoutRef.current);
        }
        previewTimeoutRef.current = setTimeout(() => {
            setShowPreview(false);
        }, 3000);
    }, []);

    // Check for updates periodically
    const checkForUpdates = useCallback(async () => {
        if (!notificationsEnabled || !showUpdateNotifications) return;

        try {
            const status = await invoke('check_for_bundle_update') as BundleUpdateStatus;

            if (status.update_available) {
                // Check if we already have an update notification for this version
                const existingUpdateNotification = notifications.find(
                    n => n.type === 'update' &&
                        (n.data as UpdateNotificationData).latest_version === status.latest_version
                );

                if (!existingUpdateNotification) {
                    // Add to Dynamic Island if enabled
                    if (useDynamicIsland) {
                        const notification: DynamicIslandNotification = {
                            id: `update-${status.latest_version}-${Date.now()}`,
                            type: 'update',
                            timestamp: Date.now(),
                            read: false,
                            data: {
                                current_version: status.current_version,
                                latest_version: status.latest_version,
                                has_update: true,
                            } as UpdateNotificationData,
                        };

                        addNotification(notification);
                    }

                    // Show toast if enabled
                    if (useToast) {
                        addToast(
                            `Update available: v${status.latest_version}`,
                            'info',
                            {
                                label: 'View',
                                onClick: () => openSettings('Updates'),
                            }
                        );
                    }

                    if (soundEnabled) {
                        playNotificationSound();
                    }
                }
            }
        } catch (error) {
            console.warn('Could not check for updates:', error);
        }
    }, [notificationsEnabled, showUpdateNotifications, notifications, addNotification, soundEnabled, playNotificationSound, useDynamicIsland, useToast, addToast, openSettings]);

    // Check for updates on mount and periodically (every 30 minutes)
    useEffect(() => {
        // Initial check after 10 seconds (let app settle)
        const initialTimeout = setTimeout(() => {
            checkForUpdates();
        }, 10000);

        // Periodic check every 30 minutes
        updateCheckIntervalRef.current = setInterval(() => {
            checkForUpdates();
        }, 30 * 60 * 1000);

        return () => {
            clearTimeout(initialTimeout);
            if (updateCheckIntervalRef.current) {
                clearInterval(updateCheckIntervalRef.current);
            }
        };
    }, [checkForUpdates]);

    // Listen for live notifications
    useEffect(() => {
        const unlisten = listen<LiveNotificationFromBackend>('streamer-went-live', (event) => {
            // Check if notifications are enabled
            if (!notificationsEnabled || !showLiveNotifications) return;

            const data = event.payload;

            // Don't add to dynamic island if it's a test notification
            if (data.is_test) return;

            // Add to Dynamic Island if enabled
            if (useDynamicIsland) {
                const notification: DynamicIslandNotification = {
                    id: `live-${Date.now()}-${data.streamer_login}`,
                    type: 'live',
                    timestamp: Date.now(),
                    read: false,
                    data: {
                        streamer_name: data.streamer_name,
                        streamer_login: data.streamer_login,
                        streamer_avatar: data.streamer_avatar,
                        game_name: data.game_name,
                        game_image: data.game_image,
                        stream_title: data.stream_title,
                        is_live: true,
                    } as LiveNotificationData,
                };

                addNotification(notification);

                if (soundEnabled) {
                    playNotificationSound();
                }
            }

            // Show toast if enabled
            if (useToast) {
                addToast(
                    `${data.streamer_name} is now live${data.game_name ? ` playing ${data.game_name}` : ''}`,
                    'live',
                    {
                        label: 'Watch',
                        onClick: () => startStream(data.streamer_login),
                    }
                );
            }
        });

        return () => {
            unlisten.then((fn) => fn());
        };
    }, [addNotification, notificationsEnabled, showLiveNotifications, useDynamicIsland, useToast, addToast, startStream, soundEnabled, playNotificationSound]);

    // Listen for whisper notifications
    useEffect(() => {
        const unlisten = listen<WhisperFromBackend>('whisper-received', async (event) => {
            // Check if notifications are enabled
            if (!notificationsEnabled || !showWhisperNotifications) return;

            const data = event.payload;

            // Get profile image for the sender
            let profileImageUrl: string | undefined;
            try {
                const userInfo = await invoke<{ profile_image_url?: string }>('get_user_by_id', { userId: data.from_user_id });
                profileImageUrl = userInfo.profile_image_url;
            } catch {
                // Ignore error, profile image is optional
            }

            // Add to Dynamic Island if enabled
            if (useDynamicIsland) {
                const notification: DynamicIslandNotification = {
                    id: `whisper-${data.whisper_id}`,
                    type: 'whisper',
                    timestamp: Date.now(),
                    read: false,
                    data: {
                        from_user_id: data.from_user_id,
                        from_user_login: data.from_user_login,
                        from_user_name: data.from_user_name,
                        message: data.text,
                        whisper_id: data.whisper_id,
                        profile_image_url: profileImageUrl,
                    } as WhisperNotificationData,
                };

                addNotification(notification);

                if (soundEnabled) {
                    playNotificationSound();
                }
            }

            // Show toast if enabled
            if (useToast) {
                addToast(
                    `Whisper from ${data.from_user_name}: ${data.text.substring(0, 50)}${data.text.length > 50 ? '...' : ''}`,
                    'info',
                    {
                        label: 'Reply',
                        onClick: () => openWhisperWithUser({
                            id: data.from_user_id,
                            login: data.from_user_login,
                            display_name: data.from_user_name,
                            profile_image_url: profileImageUrl,
                        }),
                    }
                );
            }
            // Note: Whisper conversation storage is handled by WhispersWidget
        });

        return () => {
            unlisten.then((fn) => fn());
        };
    }, [addNotification, playNotificationSound, notificationsEnabled, showWhisperNotifications, soundEnabled, useDynamicIsland, useToast, addToast, openWhisperWithUser]);

    // Listen for drop claimed notifications
    useEffect(() => {
        const unlisten = listen<DropClaimedEvent>('drop-claimed', (event) => {
            if (!notificationsEnabled || !showDropsNotifications) return;

            const data = event.payload;

            // Add to Dynamic Island if enabled
            if (useDynamicIsland) {
                const notification: DynamicIslandNotification = {
                    id: `drop-${Date.now()}-${data.drop_name}`,
                    type: 'drops',
                    timestamp: Date.now(),
                    read: false,
                    data: {
                        drop_name: data.drop_name,
                        game_name: data.game_name,
                        benefit_name: data.benefit_name,
                        benefit_image_url: data.benefit_image_url,
                    } as DropsNotificationData,
                };

                addNotification(notification);

                if (soundEnabled) {
                    playNotificationSound();
                }
            }

            // Show toast if enabled
            if (useToast) {
                addToast(
                    `Drop claimed: ${data.drop_name} (${data.game_name})`,
                    'success',
                    {
                        label: 'View',
                        onClick: () => setShowDropsOverlay(true),
                    }
                );
            }
        });

        return () => {
            unlisten.then((fn) => fn());
        };
    }, [addNotification, notificationsEnabled, showDropsNotifications, useDynamicIsland, useToast, addToast, soundEnabled, playNotificationSound, setShowDropsOverlay]);

    // Listen for channel points earned notifications with clustering
    // Ref to track clustered channel points
    const channelPointsClusterRef = useRef<ClusteredChannelPoints>({
        totalPoints: 0,
        events: [],
        lastUpdate: 0,
    });
    const channelPointsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Function to format reason codes into human-readable text
    const formatReasonCode = (reason: string): string => {
        const reasonMap: Record<string, string> = {
            'WATCH': 'watching',
            'WATCH_STREAK': 'watch streak',
            'CLAIM': 'bonus claim',
            'RAID': 'raid',
            'PREDICTION': 'prediction',
            'BITS': 'bits',
            'SUB': 'subscription',
            'GIFT_SUB': 'gift sub',
        };
        return reasonMap[reason.toUpperCase()] || reason.toLowerCase();
    };

    // Function to flush clustered channel points as a single notification
    const flushChannelPointsCluster = useCallback(() => {
        const cluster = channelPointsClusterRef.current;
        if (cluster.events.length === 0) return;

        // Create a summary of the clustered events
        const totalPoints = cluster.totalPoints;
        const eventCount = cluster.events.length;

        // Get unique channel names
        const uniqueChannels = [...new Set(cluster.events.map(e => e.channel_name).filter(Boolean))];

        // Group events by channel for display
        const channelPoints: Record<string, number> = {};
        cluster.events.forEach(e => {
            const channel = e.channel_name || 'Unknown';
            channelPoints[channel] = (channelPoints[channel] || 0) + e.points;
        });

        // Group events by reason for display
        const reasonCounts: Record<string, number> = {};
        cluster.events.forEach(e => {
            const reason = formatReasonCode(e.reason);
            reasonCounts[reason] = (reasonCounts[reason] || 0) + e.points;
        });

        // Create notification data - we'll store the breakdown for expanded view
        const reasonSummary = Object.entries(reasonCounts)
            .map(([reason, points]) => `+${points.toLocaleString()} (${reason})`)
            .join(', ');

        // Determine channel name display - only use actual channel names, not reason summaries
        let channelNameDisplay: string | null = null;
        if (uniqueChannels.length === 1 && uniqueChannels[0]) {
            // Single channel - show its name
            channelNameDisplay = uniqueChannels[0];
        } else if (uniqueChannels.length > 1) {
            // Multiple channels - show count
            channelNameDisplay = `${uniqueChannels.length} channels`;
        }
        // If no channels, leave channelNameDisplay as null

        // Add to Dynamic Island if enabled
        if (useDynamicIsland) {
            const notification: DynamicIslandNotification = {
                id: `points-cluster-${Date.now()}`,
                type: 'channel_points',
                timestamp: Date.now(),
                read: false,
                data: {
                    // Store the channel name if available, otherwise show the reason summary as the "channel name" for display purposes
                    channel_name: channelNameDisplay || reasonSummary,
                    points_earned: totalPoints,
                    total_points: cluster.lastBalance, // Pass the balance through
                    // Mark if this is a reason summary (not a real channel name)
                    is_reason_summary: !channelNameDisplay,
                } as ChannelPointsNotificationData,
            };

            addNotification(notification);

            if (soundEnabled) {
                playNotificationSound();
            }
        }

        // Show toast if enabled - show rich formatted version
        if (useToast) {
            const toastContent = (
                <div className="flex items-center gap-3 w-full">
                    {/* Channel Points Icon */}
                    <div className="w-10 h-10 rounded-full bg-orange-500/20 flex items-center justify-center flex-shrink-0">
                        <svg width="20" height="20" viewBox="0 0 24 24" className="text-orange-400" fill="currentColor">
                            <path d="M12 5v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7Z"></path>
                            <path fillRule="evenodd" d="M1 12C1 5.925 5.925 1 12 1s11 4.925 11 11-4.925 11-11 11S1 18.075 1 12Zm11 9a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z" clipRule="evenodd"></path>
                        </svg>
                    </div>

                    {/* Text Content */}
                    <div className="flex-1 min-w-0">
                        <div className="text-base font-semibold text-textPrimary">
                            +{totalPoints.toLocaleString()} Channel Points
                        </div>
                        <div className="text-xs text-textSecondary">
                            {uniqueChannels.length === 1 && uniqueChannels[0] ? (
                                `${uniqueChannels[0]} • ${formatReasonCode(cluster.events[0]?.reason || 'watch')}`
                            ) : uniqueChannels.length > 1 ? (
                                `From ${uniqueChannels.length} channels`
                            ) : (
                                reasonSummary
                            )}
                        </div>
                    </div>
                </div>
            );

            addToast(toastContent, 'success');
        }

        // Reset the cluster
        channelPointsClusterRef.current = {
            totalPoints: 0,
            events: [],
            lastUpdate: 0,
        };
    }, [useDynamicIsland, useToast, addNotification, addToast, soundEnabled, playNotificationSound]);

    useEffect(() => {
        const unlisten = listen<ChannelPointsEarnedEvent>('channel-points-earned', (event) => {
            if (!notificationsEnabled || !showChannelPointsNotifications) return;

            const data = event.payload;

            // Skip if no points (shouldn't happen, but safety check)
            if (!data.points || data.points <= 0) return;

            // Get channel name from available sources
            const channelName = data.channel_display_name || data.channel_login || null;

            // Add to the cluster
            channelPointsClusterRef.current.totalPoints += data.points;
            channelPointsClusterRef.current.events.push({
                points: data.points,
                reason: data.reason || 'watch',
                channel_name: channelName,
                timestamp: Date.now(),
            });
            channelPointsClusterRef.current.lastUpdate = Date.now();

            // Store the latest balance
            if (data.balance) {
                channelPointsClusterRef.current.lastBalance = data.balance;
            }

            // Clear any existing timeout
            if (channelPointsTimeoutRef.current) {
                clearTimeout(channelPointsTimeoutRef.current);
            }

            // Set a new timeout to flush the cluster after 3 seconds of no new events
            // This batches rapid-fire notifications together
            channelPointsTimeoutRef.current = setTimeout(() => {
                flushChannelPointsCluster();
            }, 3000);
        });

        return () => {
            unlisten.then((fn) => fn());
            // Flush any remaining clustered notifications on unmount
            if (channelPointsTimeoutRef.current) {
                clearTimeout(channelPointsTimeoutRef.current);
            }
            if (channelPointsClusterRef.current.events.length > 0) {
                flushChannelPointsCluster();
            }
        };
    }, [notificationsEnabled, showChannelPointsNotifications, flushChannelPointsCluster]);

    // Start badge polling and listen for badge notifications
    useEffect(() => {
        if (!notificationsEnabled || !showBadgeNotifications) {
            return;
        }

        // Start the badge polling service
        badgePollingService.start();

        // Subscribe to badge notifications
        const unsubscribe = badgePollingService.subscribe((badges: BadgeNotification[]) => {
            badges.forEach((badge) => {
                // Add to Dynamic Island if enabled
                if (useDynamicIsland) {
                    const statusText = badge.status === 'new' ? 'New Badge' :
                        badge.status === 'available' ? 'Now Available' : 'Coming Soon';

                    const notification: DynamicIslandNotification = {
                        id: `badge-${badge.badge_set_id}-${badge.badge_version}-${Date.now()}`,
                        type: 'badge',
                        timestamp: Date.now(),
                        read: false,
                        data: {
                            badge_name: badge.badge_name,
                            badge_set_id: badge.badge_set_id,
                            badge_version: badge.badge_version,
                            badge_image_url: badge.badge_image_url,
                            badge_description: badge.badge_description,
                            status: badge.status,
                            date_info: badge.date_info,
                        } as BadgeNotificationData,
                    };

                    addNotification(notification);
                }

                // Show toast if enabled
                if (useToast) {
                    const statusEmoji = badge.status === 'new' ? '✨' :
                        badge.status === 'available' ? '🟢' : '🔵';
                    const statusText = badge.status === 'new' ? 'New badge' :
                        badge.status === 'available' ? 'Now available' : 'Coming soon';

                    addToast(
                        `${statusEmoji} ${statusText}: ${badge.badge_name}${badge.date_info ? ` (${badge.date_info})` : ''}`,
                        'info',
                        {
                            label: 'View',
                            onClick: () => setShowBadgesOverlay(true),
                        }
                    );
                }

                if (soundEnabled) {
                    playNotificationSound();
                }
            });
        });

        return () => {
            unsubscribe();
            badgePollingService.stop();
        };
    }, [notificationsEnabled, showBadgeNotifications, useDynamicIsland, useToast, addNotification, addToast, soundEnabled, playNotificationSound, setShowBadgesOverlay]);

    // Click outside to close
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (islandRef.current && !islandRef.current.contains(event.target as Node)) {
                setIsExpanded(false);
            }
        };

        if (isExpanded) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isExpanded]);

    // Handle notification click
    const handleNotificationClick = async (notification: DynamicIslandNotification) => {
        // Mark as read
        setNotifications(prev =>
            prev.map(n => n.id === notification.id ? { ...n, read: true } : n)
        );

        if (notification.type === 'live') {
            const data = notification.data as LiveNotificationData;

            // Check if still live
            const isStillLive = await checkIfStillLive(data.streamer_login);

            if (isStillLive) {
                await startStream(data.streamer_login);
                setIsExpanded(false);
            } else {
                // Update notification to show offline
                setNotifications(prev =>
                    prev.map(n => {
                        if (n.id === notification.id && n.type === 'live') {
                            return {
                                ...n,
                                data: { ...(n.data as LiveNotificationData), is_live: false },
                            };
                        }
                        return n;
                    })
                );
            }
        } else if (notification.type === 'whisper') {
            const data = notification.data as WhisperNotificationData;

            // Open the WhispersWidget overlay with this user's conversation selected
            openWhisperWithUser({
                id: data.from_user_id,
                login: data.from_user_login,
                display_name: data.from_user_name,
                profile_image_url: data.profile_image_url,
            });

            setIsExpanded(false);
        } else if (notification.type === 'update') {
            // Open settings to the Updates tab
            openSettings('Updates');
            setIsExpanded(false);
        } else if (notification.type === 'drops' || notification.type === 'channel_points') {
            // Open drops overlay
            setShowDropsOverlay(true);
            setIsExpanded(false);
        } else if (notification.type === 'badge') {
            // Open badges overlay
            setShowBadgesOverlay(true);
            setIsExpanded(false);
        }
    };

    // Clear notification
    const clearNotification = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setNotifications(prev => prev.filter(n => n.id !== id));
    };

    // Clear all notifications
    const clearAllNotifications = () => {
        setNotifications([]);
        setHasUnread(false);
    };

    // Get unread count
    const unreadCount = notifications.filter(n => !n.read).length;

    // Update hasUnread when notifications change
    useEffect(() => {
        setHasUnread(unreadCount > 0);
    }, [unreadCount]);

    // Format time ago
    const formatTimeAgo = (timestamp: number) => {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 60) return 'Just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    };

    // Calculate collapsed width based on notifications
    const getCollapsedWidth = () => {
        if (showPreview && latestNotification) {
            return 180;
        }
        if (hasUnread && unreadCount > 0) {
            // Morph longer based on notification count
            const baseWidth = 72;
            const extraWidth = Math.min(unreadCount * 8, 48);
            return baseWidth + extraWidth;
        }
        return 72;
    };

    return (
        <>
            <div
                ref={islandRef}
                className="absolute left-1/2 -translate-x-1/2 top-1 z-50"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
                <motion.div
                    layout
                    initial={false}
                    animate={{
                        width: isExpanded ? expandedWidth : getCollapsedWidth(),
                        height: isExpanded ? Math.min(maxHeight, 64 + notifications.length * itemHeight) : 24,
                    }}
                    transition={{
                        type: 'spring',
                        stiffness: 500,
                        damping: 35,
                        mass: 0.8,
                    }}
                    onClick={() => {
                        if (!isExpanded) {
                            setIsExpanded(true);
                            setShowPreview(false);
                            if (previewTimeoutRef.current) {
                                clearTimeout(previewTimeoutRef.current);
                            }
                        }
                    }}
                    className="dynamic-island overflow-hidden cursor-pointer"
                    style={{
                        backgroundColor: '#000000',
                        borderRadius: isExpanded ? 20 : 14,
                        boxShadow: isExpanded
                            ? '0 0 0 1px rgba(255, 255, 255, 0.12), 0 8px 32px rgba(0, 0, 0, 0.4)'
                            : hasUnread
                                ? '0 0 0 1px rgba(255, 255, 255, 0.15)'
                                : 'none',
                        transition: 'box-shadow 0.3s ease',
                    }}
                >
                    {/* Collapsed State */}
                    <AnimatePresence mode="wait">
                        {!isExpanded && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.15 }}
                                className="flex items-center h-full px-2"
                            >
                                {showPreview && latestNotification ? (
                                    // Preview latest notification
                                    <motion.div
                                        className="flex items-center gap-2 w-full pl-1"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        transition={{ duration: 0.2 }}
                                    >
                                        {latestNotification.type === 'live' ? (
                                            <>
                                                <div className="w-1.5 h-1.5 bg-red-500 rounded-full" />
                                                <span className="text-white text-[11px] font-medium truncate flex-1">
                                                    {(latestNotification.data as LiveNotificationData).streamer_name} is live
                                                </span>
                                            </>
                                        ) : latestNotification.type === 'whisper' ? (
                                            <>
                                                <MessageCircle size={11} className="text-purple-400 flex-shrink-0" />
                                                <span className="text-white text-[11px] font-medium truncate flex-1">
                                                    {(latestNotification.data as WhisperNotificationData).from_user_name}
                                                </span>
                                            </>
                                        ) : latestNotification.type === 'update' ? (
                                            <>
                                                <Download size={11} className="text-yellow-400 flex-shrink-0" />
                                                <span className="text-white text-[11px] font-medium truncate flex-1">
                                                    Update available
                                                </span>
                                            </>
                                        ) : latestNotification.type === 'drops' ? (
                                            <>
                                                <Gift size={11} className="text-green-400 flex-shrink-0" />
                                                <span className="text-white text-[11px] font-medium truncate flex-1">
                                                    Drop claimed
                                                </span>
                                            </>
                                        ) : latestNotification.type === 'channel_points' ? (
                                            <>
                                                <svg width="11" height="11" viewBox="0 0 24 24" className="text-orange-400 flex-shrink-0" fill="currentColor">
                                                    <path d="M12 5v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7Z"></path>
                                                    <path fillRule="evenodd" d="M1 12C1 5.925 5.925 1 12 1s11 4.925 11 11-4.925 11-11 11S1 18.075 1 12Zm11 9a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z" clipRule="evenodd"></path>
                                                </svg>
                                                <span className="text-white text-[11px] font-medium truncate flex-1">
                                                    +{(latestNotification.data as ChannelPointsNotificationData).points_earned.toLocaleString()}
                                                </span>
                                            </>
                                        ) : latestNotification.type === 'badge' ? (
                                            <>
                                                <Award size={11} className="text-cyan-400 flex-shrink-0" />
                                                <span className="text-white text-[11px] font-medium truncate flex-1">
                                                    {(latestNotification.data as BadgeNotificationData).badge_name}
                                                </span>
                                            </>
                                        ) : null}
                                    </motion.div>
                                ) : (
                                    // Default state with sound indicator and notification count
                                    <div className="flex items-center w-full">
                                        {/* Sound indicator */}
                                        {soundEnabled ? (
                                            <SpeakerHigh size={16} className="text-white/60" />
                                        ) : (
                                            <SpeakerSlash size={16} className="text-white/40" />
                                        )}

                                        {/* Notification count badge with solid accent color - centered */}
                                        {hasUnread && unreadCount > 0 && (
                                            <div className="flex-1 flex justify-center">
                                                <motion.div
                                                    initial={{ scale: 0 }}
                                                    animate={{
                                                        scale: 1,
                                                    }}
                                                    transition={{
                                                        scale: { type: 'spring', stiffness: 500, damping: 25 },
                                                    }}
                                                    className="flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full"
                                                    style={{
                                                        backgroundColor: 'var(--color-accent)',
                                                        boxShadow: '0 0 8px var(--color-accent-muted)',
                                                    }}
                                                >
                                                    <span className="text-[10px] font-bold leading-none text-black">
                                                        {unreadCount > 9 ? '9+' : unreadCount}
                                                    </span>
                                                </motion.div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* Expanded State */}
                    <AnimatePresence>
                        {isExpanded && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.15 }}
                                className="flex flex-col h-full"
                            >
                                {/* Header */}
                                <div
                                    className="relative flex items-center justify-between px-5 py-4"
                                    style={{
                                        borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                                    }}
                                >
                                    {/* Invisible close button in the middle third */}
                                    <div
                                        className="absolute left-1/3 right-1/3 top-0 bottom-0 cursor-pointer z-10"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setIsExpanded(false);
                                        }}
                                        title="Click to close"
                                    />
                                    <div className="flex items-center gap-2">
                                        <span className="text-white font-semibold text-base">Notifications</span>
                                        {unreadCount > 0 && (
                                            <span
                                                className="text-[10px] font-bold px-1.5 py-0.5 rounded-full text-black"
                                                style={{
                                                    backgroundColor: 'var(--color-accent)',
                                                }}
                                            >
                                                {unreadCount}
                                            </span>
                                        )}
                                        {soundEnabled ? (
                                            <SpeakerHigh size={16} className="text-white/40" />
                                        ) : (
                                            <SpeakerSlash size={16} className="text-white/30" />
                                        )}
                                    </div>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setIsExpanded(false);
                                            setShowWhispersOverlay(true);
                                        }}
                                        className="text-xs transition-all flex items-center gap-1.5 px-2.5 py-1 rounded-lg hover:bg-white/10"
                                        style={{
                                            color: 'var(--color-accent)',
                                            border: '1px solid rgba(255, 255, 255, 0.15)',
                                        }}
                                        title="Open Whispers"
                                    >
                                        <MessageCircle size={12} />
                                        Whispers
                                    </button>
                                </div>

                                {/* Notifications List */}
                                <div className="flex-1 overflow-y-auto scrollbar-thin">
                                    {notifications.length === 0 ? (
                                        <div className="flex flex-col items-center justify-center py-12 text-white/40">
                                            <Bell size={28} className="mb-3" />
                                            <span className="text-sm">No notifications</span>
                                        </div>
                                    ) : (
                                        <div className="p-3 space-y-2">
                                            {notifications.map((notification) => (
                                                <motion.div
                                                    key={notification.id}
                                                    layout
                                                    initial={{ opacity: 0, y: -10 }}
                                                    animate={{ opacity: 1, y: 0 }}
                                                    exit={{ opacity: 0, x: -100 }}
                                                    onClick={() => handleNotificationClick(notification)}
                                                    className={`
                                                        flex items-center gap-4 p-3 rounded-xl cursor-pointer
                                                        ${notification.read ? 'bg-white/5' : 'bg-white/10'}
                                                        hover:bg-white/15 transition-colors group
                                                    `}
                                                >
                                                    {notification.type === 'live' ? (
                                                        <>
                                                            {/* Live notification */}
                                                            <div className="relative flex-shrink-0">
                                                                {(notification.data as LiveNotificationData).streamer_avatar ? (
                                                                    <img
                                                                        src={(notification.data as LiveNotificationData).streamer_avatar}
                                                                        alt=""
                                                                        className="w-12 h-12 rounded-full object-cover"
                                                                    />
                                                                ) : (
                                                                    <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center">
                                                                        <User size={18} className="text-white/50" />
                                                                    </div>
                                                                )}
                                                                {(notification.data as LiveNotificationData).is_live && (
                                                                    <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-red-500 rounded-full border-2 border-black" />
                                                                )}
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2">
                                                                    <Radio size={14} className="text-red-500 flex-shrink-0" />
                                                                    <span className="text-white text-sm font-semibold truncate">
                                                                        {(notification.data as LiveNotificationData).streamer_name}
                                                                    </span>
                                                                </div>
                                                                <p className="text-white/50 text-sm truncate mt-0.5">
                                                                    {(notification.data as LiveNotificationData).is_live
                                                                        ? (notification.data as LiveNotificationData).game_name || 'Streaming'
                                                                        : 'Offline'
                                                                    }
                                                                </p>
                                                            </div>
                                                        </>
                                                    ) : notification.type === 'whisper' ? (
                                                        <>
                                                            {/* Whisper notification */}
                                                            <div className="relative flex-shrink-0">
                                                                {(notification.data as WhisperNotificationData).profile_image_url ? (
                                                                    <img
                                                                        src={(notification.data as WhisperNotificationData).profile_image_url}
                                                                        alt=""
                                                                        className="w-12 h-12 rounded-full object-cover"
                                                                    />
                                                                ) : (
                                                                    <div className="w-12 h-12 rounded-full bg-purple-500/20 flex items-center justify-center">
                                                                        <MessageCircle size={18} className="text-purple-400" />
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2">
                                                                    <MessageCircle size={14} className="text-purple-400 flex-shrink-0" />
                                                                    <span className="text-white text-sm font-semibold truncate">
                                                                        {(notification.data as WhisperNotificationData).from_user_name}
                                                                    </span>
                                                                </div>
                                                                <p className="text-white/50 text-sm truncate mt-0.5">
                                                                    {(notification.data as WhisperNotificationData).message}
                                                                </p>
                                                            </div>
                                                        </>
                                                    ) : notification.type === 'update' ? (
                                                        <>
                                                            {/* Update notification */}
                                                            <div className="relative flex-shrink-0">
                                                                <div className="w-12 h-12 rounded-full bg-yellow-500/20 flex items-center justify-center">
                                                                    <Download size={18} className="text-yellow-400" />
                                                                </div>
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2">
                                                                    <Download size={14} className="text-yellow-400 flex-shrink-0" />
                                                                    <span className="text-white text-sm font-semibold truncate">
                                                                        Update Available
                                                                    </span>
                                                                </div>
                                                                <p className="text-white/50 text-sm truncate mt-0.5">
                                                                    v{(notification.data as UpdateNotificationData).current_version} → v{(notification.data as UpdateNotificationData).latest_version}
                                                                </p>
                                                            </div>
                                                        </>
                                                    ) : notification.type === 'drops' ? (
                                                        <>
                                                            {/* Drops notification */}
                                                            <div className="relative flex-shrink-0">
                                                                {(notification.data as DropsNotificationData).benefit_image_url ? (
                                                                    <img
                                                                        src={(notification.data as DropsNotificationData).benefit_image_url}
                                                                        alt=""
                                                                        className="w-12 h-12 rounded-lg object-cover"
                                                                    />
                                                                ) : (
                                                                    <div className="w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center">
                                                                        <Gift size={18} className="text-green-400" />
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2">
                                                                    <Gift size={14} className="text-green-400 flex-shrink-0" />
                                                                    <span className="text-white text-sm font-semibold truncate">
                                                                        Drop Claimed
                                                                    </span>
                                                                </div>
                                                                <p className="text-white/50 text-sm truncate mt-0.5">
                                                                    {(notification.data as DropsNotificationData).drop_name} ({(notification.data as DropsNotificationData).game_name})
                                                                </p>
                                                            </div>
                                                        </>
                                                    ) : notification.type === 'channel_points' ? (
                                                        <>
                                                            {/* Channel Points notification */}
                                                            <div className="relative flex-shrink-0">
                                                                <div className="w-12 h-12 rounded-full bg-orange-500/20 flex items-center justify-center">
                                                                    <svg width="18" height="18" viewBox="0 0 24 24" className="text-orange-400" fill="currentColor">
                                                                        <path d="M12 5v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7Z"></path>
                                                                        <path fillRule="evenodd" d="M1 12C1 5.925 5.925 1 12 1s11 4.925 11 11-4.925 11-11 11S1 18.075 1 12Zm11 9a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z" clipRule="evenodd"></path>
                                                                    </svg>
                                                                </div>
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2">
                                                                    <svg width="14" height="14" viewBox="0 0 24 24" className="text-orange-400 flex-shrink-0" fill="currentColor">
                                                                        <path d="M12 5v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7Z"></path>
                                                                        <path fillRule="evenodd" d="M1 12C1 5.925 5.925 1 12 1s11 4.925 11 11-4.925 11-11 11S1 18.075 1 12Zm11 9a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z" clipRule="evenodd"></path>
                                                                    </svg>
                                                                    <span className="text-white text-sm font-semibold truncate">
                                                                        Channel Points +{(notification.data as ChannelPointsNotificationData).points_earned.toLocaleString()}
                                                                    </span>
                                                                </div>
                                                                <p className="text-white/50 text-sm truncate mt-0.5">
                                                                    {(() => {
                                                                        const data = notification.data as ChannelPointsNotificationData;
                                                                        const channelName = data.channel_name;
                                                                        const totalPoints = data.total_points;
                                                                        // Check if channel_name looks like a reason summary (contains parentheses)
                                                                        const isReasonSummary = channelName && channelName.includes('(');
                                                                        if (isReasonSummary) {
                                                                            // Just show the reason summary without "for"
                                                                            return channelName;
                                                                        } else if (channelName && totalPoints) {
                                                                            // Real channel name with total - show "channelname: total points"
                                                                            return `${channelName}: ${totalPoints.toLocaleString()} points`;
                                                                        } else if (channelName) {
                                                                            // Real channel name without total - just show channel name
                                                                            return channelName;
                                                                        } else {
                                                                            // No channel name at all
                                                                            return 'Points earned';
                                                                        }
                                                                    })()}
                                                                </p>
                                                            </div>
                                                        </>
                                                    ) : notification.type === 'badge' ? (
                                                        <>
                                                            {/* Badge notification */}
                                                            <div className="relative flex-shrink-0">
                                                                {(notification.data as BadgeNotificationData).badge_image_url ? (
                                                                    <img
                                                                        src={(notification.data as BadgeNotificationData).badge_image_url}
                                                                        alt=""
                                                                        className="w-12 h-12 rounded-lg object-cover"
                                                                    />
                                                                ) : (
                                                                    <div className="w-12 h-12 rounded-full bg-cyan-500/20 flex items-center justify-center">
                                                                        <Award size={18} className="text-cyan-400" />
                                                                    </div>
                                                                )}
                                                                {/* Status indicator */}
                                                                {(notification.data as BadgeNotificationData).status === 'available' && (
                                                                    <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-500 rounded-full border-2 border-black" />
                                                                )}
                                                                {(notification.data as BadgeNotificationData).status === 'coming_soon' && (
                                                                    <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-blue-500 rounded-full border-2 border-black" />
                                                                )}
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2">
                                                                    <Award size={14} className="text-cyan-400 flex-shrink-0" />
                                                                    <span className="text-white text-sm font-semibold truncate">
                                                                        {(notification.data as BadgeNotificationData).badge_name}
                                                                    </span>
                                                                </div>
                                                                <p className="text-white/50 text-sm truncate mt-0.5">
                                                                    {(() => {
                                                                        const data = notification.data as BadgeNotificationData;
                                                                        const statusText = data.status === 'new' ? 'New badge' :
                                                                            data.status === 'available' ? 'Now available' : 'Coming soon';
                                                                        return data.date_info ? `${statusText} • ${data.date_info}` : statusText;
                                                                    })()}
                                                                </p>
                                                            </div>
                                                        </>
                                                    ) : null}

                                                    <div className="flex items-center gap-2 flex-shrink-0">
                                                        <span className="text-white/30 text-xs">
                                                            {formatTimeAgo(notification.timestamp)}
                                                        </span>
                                                        <button
                                                            onClick={(e) => clearNotification(notification.id, e)}
                                                            className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-white transition-all"
                                                        >
                                                            <X size={16} />
                                                        </button>
                                                        <ChevronRight size={16} className="text-white/30" />
                                                    </div>
                                                </motion.div>
                                            ))}
                                            {/* Clear All Footer */}
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    clearAllNotifications();
                                                }}
                                                className="w-full mt-2 py-2 text-white/40 hover:text-white/70 text-xs transition-colors text-center rounded-lg hover:bg-white/5"
                                            >
                                                Clear all notifications
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </motion.div>
            </div>
        </>
    );
};

export default DynamicIsland;
