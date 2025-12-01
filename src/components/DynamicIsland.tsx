import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bell, Radio, MessageCircle, ChevronRight, User, Download, Gift, Coins } from 'lucide-react';
import { X, SpeakerHigh, SpeakerSlash } from 'phosphor-react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import type {
    DynamicIslandNotification,
    LiveNotificationData,
    WhisperNotificationData,
    UpdateNotificationData,
    DropsNotificationData,
    ChannelPointsNotificationData,
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

interface ChannelPointsClaimedEvent {
    channel_name: string;
    points_earned: number;
    total_points?: number;
}

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

    const { startStream, settings, setShowWhispersOverlay, openWhisperWithUser, openSettings, addToast, setShowDropsOverlay } = useAppStore();

    const soundEnabled = settings.live_notifications?.play_sound ?? true;
    const notificationsEnabled = settings.live_notifications?.enabled ?? true;
    const showLiveNotifications = settings.live_notifications?.show_live_notifications ?? true;
    const showWhisperNotifications = settings.live_notifications?.show_whisper_notifications ?? true;
    const showUpdateNotifications = settings.live_notifications?.show_update_notifications ?? true;
    const showDropsNotifications = settings.live_notifications?.show_drops_notifications ?? true;
    const showChannelPointsNotifications = settings.live_notifications?.show_channel_points_notifications ?? true;
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

    // Listen for channel points claimed notifications
    useEffect(() => {
        const unlisten = listen<ChannelPointsClaimedEvent>('channel-points-claimed', (event) => {
            if (!notificationsEnabled || !showChannelPointsNotifications) return;

            const data = event.payload;

            // Add to Dynamic Island if enabled
            if (useDynamicIsland) {
                const notification: DynamicIslandNotification = {
                    id: `points-${Date.now()}-${data.channel_name}`,
                    type: 'channel_points',
                    timestamp: Date.now(),
                    read: false,
                    data: {
                        channel_name: data.channel_name,
                        points_earned: data.points_earned,
                        total_points: data.total_points,
                    } as ChannelPointsNotificationData,
                };

                addNotification(notification);

                if (soundEnabled) {
                    playNotificationSound();
                }
            }

            // Show toast if enabled
            if (useToast) {
                addToast(
                    `+${data.points_earned.toLocaleString()} points from ${data.channel_name}`,
                    'success'
                );
            }
        });

        return () => {
            unlisten.then((fn) => fn());
        };
    }, [addNotification, notificationsEnabled, showChannelPointsNotifications, useDynamicIsland, useToast, addToast, soundEnabled, playNotificationSound]);

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
                                                <Coins size={11} className="text-orange-400 flex-shrink-0" />
                                                <span className="text-white text-[11px] font-medium truncate flex-1">
                                                    +{(latestNotification.data as ChannelPointsNotificationData).points_earned.toLocaleString()}
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

                                        {/* Notification count badge with color pulse animation - centered */}
                                        {hasUnread && unreadCount > 0 && (
                                            <div className="flex-1 flex justify-center">
                                                <motion.div
                                                    initial={{ scale: 0 }}
                                                    animate={{
                                                        scale: 1,
                                                        backgroundColor: ['#ef4444', '#f87171', '#ef4444'],
                                                    }}
                                                    transition={{
                                                        scale: { type: 'spring', stiffness: 500, damping: 25 },
                                                        backgroundColor: {
                                                            duration: 1.2,
                                                            repeat: Infinity,
                                                            ease: 'easeInOut',
                                                        },
                                                    }}
                                                    className="flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full"
                                                >
                                                    <span className="text-white text-[10px] font-bold leading-none">
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
                                <div className="relative flex items-center justify-between px-5 py-4 border-b border-white/10">
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
                                        {soundEnabled ? (
                                            <SpeakerHigh size={16} className="text-white/40" />
                                        ) : (
                                            <SpeakerSlash size={16} className="text-white/30" />
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setIsExpanded(false);
                                                setShowWhispersOverlay(true);
                                            }}
                                            className="text-purple-400 hover:text-purple-300 text-xs transition-colors flex items-center gap-1"
                                            title="Open Whispers"
                                        >
                                            <MessageCircle size={12} />
                                            Whispers
                                        </button>
                                        {notifications.length > 0 && (
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    clearAllNotifications();
                                                }}
                                                className="text-white/50 hover:text-white text-xs transition-colors"
                                            >
                                                Clear all
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {/* Notifications List */}
                                <div className="flex-1 overflow-y-auto scrollbar-thin">
                                    {notifications.length === 0 ? (
                                        <div className="flex flex-col items-center justify-center py-12 text-white/40">
                                            <Bell size={28} className="mb-3" />
                                            <span className="text-sm">No notifications</span>
                                        </div>
                                    ) : (
                                        <div className="p-3 pb-4 space-y-2">
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
                                                                    <Coins size={18} className="text-orange-400" />
                                                                </div>
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2">
                                                                    <Coins size={14} className="text-orange-400 flex-shrink-0" />
                                                                    <span className="text-white text-sm font-semibold truncate">
                                                                        +{(notification.data as ChannelPointsNotificationData).points_earned.toLocaleString()} Points
                                                                    </span>
                                                                </div>
                                                                <p className="text-white/50 text-sm truncate mt-0.5">
                                                                    {(notification.data as ChannelPointsNotificationData).channel_name}
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
