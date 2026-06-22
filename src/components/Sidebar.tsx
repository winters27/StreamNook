import { useEffect, useState, useRef, useCallback, memo } from 'react';
import { useAppStore } from '../stores/AppStore';
import { ChevronLeft, ChevronRight, Users, Sparkles, Radio, Heart, Gift, Flame } from 'lucide-react';
import type { TwitchStream } from '../types';
import { invoke } from '@tauri-apps/api/core';
import { getSidebarSettings, type SidebarMode } from './settings/InterfaceSettings';

import { useContextMenuStore } from '../stores/contextMenuStore';
import { usemultiNookStore } from '../stores/multiNookStore';
import { Tooltip } from './ui/Tooltip';

import { Logger } from '../utils/logger';
import { useVisibleInterval } from '../utils/useVisibleInterval';
// Width constants
const COMPACT_WIDTH = 56;
const DEFAULT_EXPANDED_WIDTH = 280;
const MIN_EXPANDED_WIDTH = 200;
const MAX_EXPANDED_WIDTH = 450;
const HIDDEN_TRIGGER_ZONE = 16; // pixels from left edge to trigger sidebar
const SIDEBAR_CLOSE_DELAY = 150; // milliseconds delay before closing in hidden mode
const SIDEBAR_EXPAND_MS = 200; // width-animation duration for compact / expand-on-hover
const SIDEBAR_BLUR_SETTLE_DELAY = SIDEBAR_EXPAND_MS + 40; // fade the glass in just after the expand settles
const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar-expanded-width';

// Get persisted sidebar width from localStorage
const getPersistedWidth = (): number => {
    try {
        const saved = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
        if (saved) {
            const width = parseInt(saved, 10);
            if (width >= MIN_EXPANDED_WIDTH && width <= MAX_EXPANDED_WIDTH) {
                return width;
            }
        }
    } catch (e) {
        Logger.error('[Sidebar] Failed to read persisted width:', e);
    }
    return DEFAULT_EXPANDED_WIDTH;
};

// Save sidebar width to localStorage
const persistWidth = (width: number): void => {
    try {
        localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, width.toString());
    } catch (e) {
        Logger.error('[Sidebar] Failed to persist width:', e);
    }
};

// Pure helper: format a viewer count like 12300 -> "12.3K".
const formatViewerCount = (count: number): string => {
    if (count >= 1000000) {
        return (count / 1000000).toFixed(1) + 'M';
    } else if (count >= 1000) {
        return (count / 1000).toFixed(1) + 'K';
    }
    return count.toString();
};

type HypeTrainStatus = { level: number; isGolden: boolean };

interface SectionHeaderProps {
    icon: any;
    label: string;
    count: number;
    showExpanded: boolean;
}

// Hoisted to module scope (and memoized) so it keeps a stable component
// identity across Sidebar re-renders. Defining it inside Sidebar made React
// treat it as a brand-new component type on every render, which unmounted and
// remounted the whole list on each background refresh — the visible "glitch".
const SectionHeader = memo(({ icon: Icon, label, count, showExpanded }: SectionHeaderProps) => (
    <div className={`
        flex items-center gap-2 px-2 py-2 text-textSecondary
        ${showExpanded ? 'justify-start' : 'justify-center'}
    `}>
        <Icon size={16} className="flex-shrink-0" />
        {showExpanded && (
            <>
                <span className="text-xs font-semibold uppercase tracking-wider">{label}</span>
                <span className="text-xs text-textMuted">({count})</span>
            </>
        )}
    </div>
));

interface StreamItemProps {
    stream: TwitchStream;
    showFavorite?: boolean;
    showExpanded: boolean;
    isCurrentStream: boolean;
    isFavorite: boolean;
    hasDrops: boolean;
    hypeTrainStatus: HypeTrainStatus | undefined;
    watchStreak: number;
    isHeartAnimating: boolean;
    profileImage: string;
    onStreamClick: (e: React.MouseEvent, stream: TwitchStream) => void;
    onFavoriteClick: (e: React.MouseEvent, userId: string) => void;
}

// Hoisted + memoized for the same reason as SectionHeader: a stable identity
// means a background stream refresh reconciles each row in place (text/badges
// update) instead of tearing the avatar <img> down and replaying its fade-in.
// All per-row data is passed in as props so memo can skip rows whose data is
// unchanged when an unrelated piece of state (e.g. hover) updates the parent.
const StreamItem = memo(({
    stream,
    showFavorite = false,
    showExpanded,
    isCurrentStream,
    isFavorite,
    hasDrops,
    hypeTrainStatus,
    watchStreak,
    isHeartAnimating,
    profileImage,
    onStreamClick,
    onFavoriteClick,
}: StreamItemProps) => {
    return (
        <Tooltip content={showExpanded ? null : `${stream.user_name} - ${stream.game_name}${hasDrops ? ' (Drops enabled)' : ''}`} delay={300} side="right">
            <div
                className={`group
                    flex items-center px-2 py-1.5 cursor-pointer rounded transition-all duration-200
                    ${isCurrentStream
                        ? 'border-l-2 border-accent hover:bg-surface-hover'
                        : 'hover:bg-surface-hover border-l-2 border-transparent'
                    }
                    ${showExpanded ? 'gap-2 justify-start' : 'gap-0 justify-center'}
                `}
                onClick={(e) => onStreamClick(e, stream)}
                onContextMenu={(e) => useContextMenuStore.getState().openMenu(e, stream)}
            >
            {/* Avatar with live indicator */}
            <div className="relative flex-shrink-0 transition-all duration-200">
                <img
                    src={profileImage}
                    alt={stream.user_name}
                    className={`rounded-full object-cover transition-all duration-200 ${showExpanded ? 'w-8 h-8' : 'w-9 h-9'}`}
                    onError={(e) => {
                        (e.target as HTMLImageElement).src = 'https://static-cdn.jtvnw.net/user-default-pictures-uv/75305d54-c7cc-40d1-bb9c-91c46bf27829-profile_image-70x70.png';
                    }}
                />
                {/* Live presence dot: static at rest (the sidebar only ever lists
                    live channels, so a per-row pulse is redundant and, stacked
                    across an expanded list, needless idle animation). Reuses the
                    stream-card `pulse-dot` keyframes (transform-scale, GPU-cheap)
                    and only animates on the hovered row via group-hover. */}
                <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-background group-hover:animate-[pulse-dot_2s_ease-in-out_infinite]" style={{ backgroundColor: '#eb0000' }} />
                {/* Drops indicator on avatar - only show in compact mode */}
                {hasDrops && !showExpanded && (
                    <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-accent flex items-center justify-center border border-background">
                        <Gift size={10} className="text-white" />
                    </div>
                )}
                {/* Hype Train indicator on avatar - only show in compact mode when no drops */}
                {hypeTrainStatus && !showExpanded && !hasDrops && (
                    <Tooltip content={`Hype Train LVL ${hypeTrainStatus.level}`} delay={100} side="right">
                        <div className={`absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center border border-background ${hypeTrainStatus.isGolden ? 'bg-yellow-500' : 'bg-purple-600'}`}>
                            <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 15 13" fill="none">
                                <path fillRule="evenodd" clipRule="evenodd" d="M4.10001 0.549988H2.40001V4.79999H0.700012V10.75H1.55001C1.55001 11.6889 2.31113 12.45 3.25001 12.45C4.1889 12.45 4.95001 11.6889 4.95001 10.75H5.80001C5.80001 11.6889 6.56113 12.45 7.50001 12.45C8.4389 12.45 9.20001 11.6889 9.20001 10.75H10.05C10.05 11.6889 10.8111 12.45 11.75 12.45C12.6889 12.45 13.45 11.6889 13.45 10.75H14.3V0.549988H6.65001V2.24999H7.50001V4.79999H4.10001V0.549988ZM12.6 9.04999V6.49999H2.40001V9.04999H12.6ZM9.20001 4.79999H12.6V2.24999H9.20001V4.79999Z" fill="currentColor" />
                            </svg>
                        </div>
                    </Tooltip>
                )}
            </div>

            {/* Stream info - only show when expanded */}
            {showExpanded && (
                <div className="flex-1 min-w-0 overflow-hidden animate-fade-in">
                    <div className="flex items-center gap-1">
                        <span className="text-textPrimary text-sm font-medium truncate">
                            {stream.user_name}
                        </span>
                        {stream.broadcaster_type === 'partner' && (
                            <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 16 16" fill="#9146FF">
                                <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd" />
                            </svg>
                        )}
                        {watchStreak > 0 && (
                            <Tooltip content={`${watchStreak} Watch Streak`} delay={200} side="top">
                                <div className="flex items-center gap-[2px] ml-0.5 text-orange-400 opacity-90 transition-opacity hover:opacity-100 cursor-default">
                                    <span className="text-[10px] font-bold leading-none translate-y-[0.5px]">{watchStreak}</span>
                                    <Flame size={12} strokeWidth={2.5} className="text-orange-500 fill-orange-500/20" />
                                </div>
                            </Tooltip>
                        )}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-textMuted truncate">
                        <span className="truncate">{stream.game_name || 'Just Chatting'}</span>
                        {/* Drops indicator - show next to game name */}
                        {hasDrops && (
                            <Tooltip content="Drops enabled" delay={100} side="top">
                                <span>
                                    <Gift size={10} className="text-accent flex-shrink-0" />
                                </span>
                            </Tooltip>
                        )}
                        {/* Hype Train indicator - show next to game name */}
                        {hypeTrainStatus && (
                            <Tooltip content={`Hype Train LVL ${hypeTrainStatus.level}`} delay={100} side="top">
                                <span className={`flex items-center gap-0.5 ${hypeTrainStatus.isGolden ? 'text-yellow-400' : 'text-purple-400'} flex-shrink-0`}>
                                    <svg className="w-2.5 h-2.5" viewBox="0 0 15 13" fill="none">
                                        <path fillRule="evenodd" clipRule="evenodd" d="M4.10001 0.549988H2.40001V4.79999H0.700012V10.75H1.55001C1.55001 11.6889 2.31113 12.45 3.25001 12.45C4.1889 12.45 4.95001 11.6889 4.95001 10.75H5.80001C5.80001 11.6889 6.56113 12.45 7.50001 12.45C8.4389 12.45 9.20001 11.6889 9.20001 10.75H10.05C10.05 11.6889 10.8111 12.45 11.75 12.45C12.6889 12.45 13.45 11.6889 13.45 10.75H14.3V0.549988H6.65001V2.24999H7.50001V4.79999H4.10001V0.549988ZM12.6 9.04999V6.49999H2.40001V9.04999H12.6ZM9.20001 4.79999H12.6V2.24999H9.20001V4.79999Z" fill="currentColor" />
                                    </svg>
                                </span>
                            </Tooltip>
                        )}
                    </div>
                </div>
            )}

            {/* Viewer count and favorite button */}
            {showExpanded && (
                <div className="flex items-center gap-1 flex-shrink-0 animate-fade-in">
                    <div className="flex items-center gap-1 text-xs text-textSecondary">
                        <Radio size={10} style={{ color: '#eb0000' }} />
                        <span>{formatViewerCount(stream.viewer_count)}</span>
                    </div>
                    {showFavorite && (
                        <Tooltip content={isFavorite ? 'Remove from favorites' : 'Add to favorites'} delay={200} side="top">
                            <button
                                onClick={(e) => onFavoriteClick(e, stream.user_id)}
                                className={`p-1 flex items-center justify-center bg-transparent transition-transform duration-300 hover:scale-110 active:scale-95`}
                            >
                                <Heart
                                    size={14}
                                    fill={isFavorite ? 'url(#glass-heart-fill)' : 'none'}
                                    stroke={isFavorite ? 'url(#glass-heart-stroke)' : 'currentColor'}
                                    strokeWidth={isFavorite ? 1.5 : 2}
                                    className={`transition-all duration-300 ${isFavorite ? 'drop-shadow-[0_4px_8px_rgba(236,72,153,0.5)]' : 'text-textMuted hover:text-white opacity-0 group-hover:opacity-100'} ${isHeartAnimating ? 'animate-heart-break' : ''}`}
                                />
                            </button>
                        </Tooltip>
                    )}

                </div>
            )}
        </div>
    </Tooltip>
    );
});

const Sidebar = ({ side = 'left' }: { side?: 'left' | 'right' }) => {
    // Mirror the sidebar to the right edge (used when chat is docked left with
    // reveal-on-hover, so the left edge belongs to the chat and the two don't fight
    // over the same hover zone).
    const onRight = side === 'right';
    const {
        followedStreams,
        recommendedStreams,
        loadFollowedStreams,
        loadRecommendedStreams,
        loadMoreRecommendedStreams,
        hasMoreRecommended,
        isLoadingMore,
        currentStream,
        isAuthenticated,
        isFavoriteStreamer,
        // Hype Train status for stream badges
        activeHypeTrainChannels,
        refreshHypeTrainStatuses,
        watchStreaks,
    } = useAppStore();


    // Sidebar mode from settings
    const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() => {
        const settings = getSidebarSettings();
        return settings.mode;
    });
    const [expandOnHover, setExpandOnHover] = useState(() => {
        const settings = getSidebarSettings();
        return settings.expandOnHover;
    });
    const [showRecommended, setShowRecommended] = useState(() => {
        const settings = getSidebarSettings();
        return settings.showRecommended;
    });

    // Hover and manual expand states
    const [isHovered, setIsHovered] = useState(false);
    const [isEdgeHovered, setIsEdgeHovered] = useState(false);
    const [isManuallyExpanded, setIsManuallyExpanded] = useState(false);

    // Resizable width state
    const [expandedWidth, setExpandedWidth] = useState<number>(getPersistedWidth);
    const [isResizing, setIsResizing] = useState(false);

    // Whether the frosted-glass blur has faded in. It is held back until the
    // panel has finished expanding so the blur is never re-rasterized mid-resize.
    const [blurReady, setBlurReady] = useState(false);

    const sidebarRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const edgeTriggerRef = useRef<HTMLDivElement>(null);
    const closeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const [animatingHearts, setAnimatingHearts] = useState<Set<string>>(new Set());

    // Cache for profile images fetched from Twitch Helix API
    const [profileImages, setProfileImages] = useState<Map<string, string>>(new Map());
    const fetchingProfilesRef = useRef<Set<string>>(new Set());

    // Drops-enabled games tracking (by game_name lowercase)
    const [dropsGameNames, setDropsGameNames] = useState<Set<string>>(new Set());

    // Load drops data to know which games have active drops. Per user
    // direction: do NOT fetch at idle — only after the user has opened the
    // drops overlay at least once this session. The DropsCenter overlay
    // does its own fresh fetch when it opens, so this sidebar indicator
    // simply piggybacks: once the overlay was opened, we refresh on a
    // 60-min cadence to keep the sidebar gift-icon indicator in sync.
    // Until then, the sidebar just doesn't show drops indicators — that's
    // the explicit trade-off.
    const dropsOverlayEverOpened = useAppStore((s) => s.dropsOverlayEverOpened);
    const loadActiveDrops = useCallback(async () => {
        if (!dropsOverlayEverOpened) return;
        try {
            const inventory = await invoke<{ items: Array<{ campaign: { game_name: string }; status: string }> }>('get_drops_inventory');
            if (inventory?.items) {
                const gameNames = new Set<string>();
                for (const item of inventory.items) {
                    if (item.status === 'Active' && item.campaign.game_name) {
                        gameNames.add(item.campaign.game_name.toLowerCase());
                    }
                }
                setDropsGameNames(gameNames);
            }
        } catch (err) {
            // Silently fail - drops indicator is optional
            Logger.warn('[Sidebar] Could not load drops data:', err);
        }
    }, [dropsOverlayEverOpened]);
    useEffect(() => {
        loadActiveDrops();
    }, [loadActiveDrops]);
    useVisibleInterval(loadActiveDrops, 60 * 60 * 1000);

    // Refresh Hype Train status for sidebar streams periodically.
    // Visibility-gated: when the window is in the tray, hype-train indicators
    // can't be seen anyway, so we skip the Helix calls.
    const refreshHypeTrains = useCallback(() => {
        const ids = new Set<string>();
        followedStreams.forEach(s => ids.add(s.user_id));
        recommendedStreams.forEach(s => ids.add(s.user_id));
        if (ids.size > 0) {
            refreshHypeTrainStatuses(Array.from(ids));
        }
    }, [followedStreams, recommendedStreams, refreshHypeTrainStatuses]);

    useEffect(() => {
        refreshHypeTrains();
    }, [refreshHypeTrains]);

    useVisibleInterval(refreshHypeTrains, 30000);

    // Listen for settings changes from InterfaceSettings
    useEffect(() => {
        const handleSettingsChange = (event: CustomEvent<{ mode: SidebarMode; expandOnHover: boolean; showRecommended: boolean }>) => {
            setSidebarMode(event.detail.mode);
            setExpandOnHover(event.detail.expandOnHover);
            setShowRecommended(event.detail.showRecommended);
        };

        window.addEventListener('sidebar-settings-changed', handleSettingsChange as EventListener);
        return () => window.removeEventListener('sidebar-settings-changed', handleSettingsChange as EventListener);
    }, []);

    // Cleanup close timeout on unmount
    useEffect(() => {
        return () => {
            if (closeTimeoutRef.current) {
                clearTimeout(closeTimeoutRef.current);
            }
        };
    }, []);

    // Close sidebar when mouse leaves the document/window entirely (for hidden mode)
    useEffect(() => {
        if (sidebarMode !== 'hidden') return;

        const handleDocumentMouseLeave = (e: MouseEvent) => {
            // Don't close while resizing
            if (isResizing) return;
            // Check if mouse is actually leaving the document (not just moving to another element)
            if (e.relatedTarget === null) {
                setIsHovered(false);
                setIsEdgeHovered(false);
            }
        };

        const handleWindowBlur = () => {
            // Don't close while resizing
            if (isResizing) return;
            // Close sidebar when app loses focus
            setIsHovered(false);
            setIsEdgeHovered(false);
        };

        // Track mouse position to detect if cursor is outside the viewport
        const handleMouseMove = (e: MouseEvent) => {
            // Don't close while resizing
            if (isResizing) return;
            // If mouse moves and we're in hidden mode with sidebar visible,
            // check if mouse is still within sidebar bounds
            if ((isHovered || isEdgeHovered) && sidebarRef.current) {
                const rect = sidebarRef.current.getBoundingClientRect();
                const isInsideSidebar =
                    e.clientX >= 0 &&
                    e.clientX <= rect.right &&
                    e.clientY >= rect.top &&
                    e.clientY <= rect.bottom;

                // Also check edge trigger zone
                const isInEdgeZone = e.clientX >= 0 && e.clientX <= HIDDEN_TRIGGER_ZONE;

                if (!isInsideSidebar && !isInEdgeZone) {
                    setIsHovered(false);
                    setIsEdgeHovered(false);
                }
            }
        };

        document.addEventListener('mouseleave', handleDocumentMouseLeave);
        window.addEventListener('blur', handleWindowBlur);
        document.addEventListener('mousemove', handleMouseMove);

        return () => {
            document.removeEventListener('mouseleave', handleDocumentMouseLeave);
            window.removeEventListener('blur', handleWindowBlur);
            document.removeEventListener('mousemove', handleMouseMove);
        };
    }, [sidebarMode, isHovered, isEdgeHovered, isResizing]);

    // Load streams on mount and when auth changes
    useEffect(() => {
        if (isAuthenticated) {
            loadFollowedStreams();
        }
        loadRecommendedStreams();
    }, [isAuthenticated, loadFollowedStreams, loadRecommendedStreams]);

    // Track previous "sidebar visible" state to detect rising edge (opening)
    const prevSidebarVisibleRef = useRef(false);

    // Background Sync & Layout Shift Prevention
    // Instead of fetching on OPEN (which causes a 500ms delay followed by an instant layout jump
    // as stream arrays reshuffle), we fetch on CLOSE and via a slow background interval.
    useEffect(() => {
        const isSidebarVisible = isHovered || isEdgeHovered || isManuallyExpanded;
        const wasVisible = prevSidebarVisibleRef.current;
        prevSidebarVisibleRef.current = isSidebarVisible;

        // In expanded mode the sidebar is permanently open, so a hover-out is not
        // a "close" — refreshing here just reshuffles the list under the user's
        // cursor. The periodic background sync keeps expanded mode fresh instead.
        if (sidebarMode === 'expanded') return;

        // Refresh on falling edge (sidebar just closed)
        if (!isSidebarVisible && wasVisible) {
            Logger.debug('[Sidebar] Refreshing streams on sidebar close (Layout Shift Prevention)');
            if (isAuthenticated) {
                loadFollowedStreams();
            }
            loadRecommendedStreams();
        }
    }, [isHovered, isEdgeHovered, isManuallyExpanded, isAuthenticated, loadFollowedStreams, loadRecommendedStreams, sidebarMode]);

    // Constant background freshness (every 3 minutes)
    // Ensures sidebar is fresh even if user hasn't opened/closed it in hours.
    // Visibility-gated: tray-backgrounded sessions stop syncing entirely.
    const backgroundStreamSync = useCallback(() => {
        const isSidebarVisible = isHovered || isEdgeHovered || isManuallyExpanded;
        // In collapsible modes, only sync while HIDDEN to avoid mid-reading layout
        // shifts. Expanded mode is always on-screen, but rows now reconcile in
        // place (no remount), so a periodic sync there is smooth — keep it fresh.
        if (sidebarMode === 'expanded' || !isSidebarVisible) {
            Logger.debug('[Sidebar] Background stream sync');
            if (isAuthenticated) {
                loadFollowedStreams();
            }
        }
    }, [isHovered, isEdgeHovered, isManuallyExpanded, isAuthenticated, loadFollowedStreams, sidebarMode]);
    useVisibleInterval(backgroundStreamSync, 3 * 60 * 1000);

    // Infinite scroll for recommended streams
    useEffect(() => {
        const scrollContainer = scrollContainerRef.current;
        if (!scrollContainer) return;

        const handleScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
            if (showRecommended && scrollHeight - scrollTop - clientHeight < 100 && hasMoreRecommended && !isLoadingMore) {
                loadMoreRecommendedStreams();
            }
        };

        scrollContainer.addEventListener('scroll', handleScroll);
        return () => scrollContainer.removeEventListener('scroll', handleScroll);
    }, [showRecommended, hasMoreRecommended, isLoadingMore, loadMoreRecommendedStreams]);

    // Fetch profile images from Twitch Helix API
    useEffect(() => {
        const fetchProfileImages = async () => {
            const allStreams = [...followedStreams, ...recommendedStreams];

            const streamsNeedingImages = allStreams.filter(stream =>
                !stream.profile_image_url &&
                !profileImages.has(stream.user_id) &&
                !fetchingProfilesRef.current.has(stream.user_id)
            );

            if (streamsNeedingImages.length === 0) return;

            const userIds = streamsNeedingImages.map(s => s.user_id);
            const uniqueUserIds = [...new Set(userIds)];

            uniqueUserIds.forEach(id => fetchingProfilesRef.current.add(id));

            try {
                const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');

                for (let i = 0; i < uniqueUserIds.length; i += 100) {
                    const batch = uniqueUserIds.slice(i, i + 100);
                    const queryParams = batch.map(id => `id=${id}`).join('&');

                    const response = await fetch(`https://api.twitch.tv/helix/users?${queryParams}`, {
                        headers: {
                            'Client-ID': clientId,
                            'Authorization': `Bearer ${token}`
                        }
                    });

                    if (response.ok) {
                        const data = await response.json();
                        if (data.data && Array.isArray(data.data)) {
                            setProfileImages(prev => {
                                const newMap = new Map(prev);
                                data.data.forEach((user: { id: string; profile_image_url: string }) => {
                                    if (user.profile_image_url) {
                                        newMap.set(user.id, user.profile_image_url);
                                    }
                                });
                                return newMap;
                            });
                        }
                    }
                }
            } catch (error) {
                Logger.error('[Sidebar] Failed to fetch profile images from Twitch:', error);
            } finally {
                uniqueUserIds.forEach(id => fetchingProfilesRef.current.delete(id));
            }
        };

        fetchProfileImages();
    }, [followedStreams, recommendedStreams]);

    // Handle resize drag
    useEffect(() => {
        if (!isResizing) return;

        const handleMouseMove = (e: MouseEvent) => {
            const newWidth = Math.min(MAX_EXPANDED_WIDTH, Math.max(MIN_EXPANDED_WIDTH, e.clientX));
            setExpandedWidth(newWidth);
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            // Persist the width when done resizing
            persistWidth(expandedWidth);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        // Prevent text selection while resizing
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'ew-resize';

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
        };
    }, [isResizing, expandedWidth]);

    // Calculate visibility and width based on mode
    const calculateSidebarState = useCallback(() => {
        switch (sidebarMode) {
            case 'expanded':
                // Always fully expanded
                return { visible: true, width: expandedWidth, showExpanded: true, isOverlay: false };

            case 'compact': {
                // Show compact, expand on hover if enabled, or if manually expanded
                const shouldExpand = isManuallyExpanded || (expandOnHover && isHovered);
                // When expand-on-hover is enabled, always use overlay mode (whether hovering or not)
                // This prevents layout jumps during expand/contract animations
                const isCompactOverlay = expandOnHover && !isManuallyExpanded;
                return {
                    visible: true,
                    width: shouldExpand ? expandedWidth : COMPACT_WIDTH,
                    showExpanded: shouldExpand,
                    isOverlay: isCompactOverlay
                };
            }

            case 'hidden': {
                // Hidden until edge hover, then fully expanded
                // Keep visible while resizing to allow drag to complete
                const isVisible = isEdgeHovered || isHovered || isResizing;
                return {
                    visible: isVisible,
                    width: isVisible ? expandedWidth : 0,
                    showExpanded: isVisible,
                    isOverlay: true
                };
            }

            case 'disabled':
                // Completely disabled - never show
                return { visible: false, width: 0, showExpanded: false, isOverlay: false };

            default:
                return { visible: true, width: COMPACT_WIDTH, showExpanded: false, isOverlay: false };
        }
    }, [sidebarMode, expandOnHover, isHovered, isEdgeHovered, isManuallyExpanded, expandedWidth, isResizing]);

    // Start resize handler
    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizing(true);
    }, []);

    // Get profile image - must be defined before early return to maintain hook order
    const getProfileImage = useCallback((stream: TwitchStream): string => {
        if (stream.profile_image_url) {
            return stream.profile_image_url;
        }
        const cachedImage = profileImages.get(stream.user_id);
        if (cachedImage) {
            return cachedImage;
        }
        if (stream.thumbnail_url) {
            return stream.thumbnail_url.replace('{width}', '150').replace('{height}', '150');
        }
        return `https://static-cdn.jtvnw.net/user-default-pictures-uv/75305d54-c7cc-40d1-bb9c-91c46bf27829-profile_image-70x70.png`;
    }, [profileImages]);

    // Stable across renders (defined before the early return to keep hook order
    // constant) so memoized StreamItem rows aren't invalidated by a new callback
    // identity each render. Reactive store values are read via getState() at call
    // time rather than captured in deps.
    const handleStreamClick = useCallback((e: React.MouseEvent, stream: TwitchStream) => {
        // Ctrl/Cmd+click adds the stream to multinook instead of switching to it.
        // The flying-card animation originates from the click point so it visually
        // matches the right-click context-menu "Add to MultiNook" action.
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            usemultiNookStore.getState().triggerAddAnimation(e.clientX, e.clientY, stream.user_login);
            usemultiNookStore.getState().addSlot(stream.user_login);
            return;
        }
        // Exit home/PIP mode when clicking on a new stream from sidebar
        // This ensures the user goes directly to the stream view
        const { isHomeActive, toggleHome, startStream } = useAppStore.getState();
        if (isHomeActive) {
            toggleHome();
        }
        startStream(stream.user_login, stream);
    }, []);

    const handleFavoriteClick = useCallback((e: React.MouseEvent, userId: string) => {
        e.stopPropagation();

        const { isFavoriteStreamer, toggleFavoriteStreamer } = useAppStore.getState();
        const isFavorite = isFavoriteStreamer(userId);

        if (isFavorite) {
            setAnimatingHearts(prev => new Set(prev).add(userId));
            setTimeout(() => {
                setAnimatingHearts(prev => {
                    const newSet = new Set(prev);
                    newSet.delete(userId);
                    return newSet;
                });
                toggleFavoriteStreamer(userId);
            }, 1000);
        } else {
            toggleFavoriteStreamer(userId);
        }
    }, []);

    const { visible, width, showExpanded, isOverlay } = calculateSidebarState();

    // Expand the panel unblurred (cheap) and only fade the frosted glass in once
    // it has finished widening. Blurring an element while its width animates forces
    // a per-frame backdrop re-raster, which is what made the expand choppy. Gating
    // the blur behind the resize keeps the expand/collapse at full frame rate, then
    // the glass settles in with a soft fade.
    useEffect(() => {
        if (showExpanded) {
            const t = setTimeout(() => setBlurReady(true), SIDEBAR_BLUR_SETTLE_DELAY);
            return () => clearTimeout(t);
        }
        setBlurReady(false);
    }, [showExpanded]);

    // If sidebar is completely disabled, render nothing
    if (sidebarMode === 'disabled') {
        return null;
    }

    // Split followed (live) channels into Favorites and the rest, so each gets
    // its own labeled section — mirroring how Followed is separated from
    // Recommended. The sidebar only ever lists live channels, so these are the
    // live favorites vs. the live non-favorite follows.
    const favoriteStreams = followedStreams.filter(s => isFavoriteStreamer(s.user_id));
    const followedNonFavoriteStreams = followedStreams.filter(s => !isFavoriteStreamer(s.user_id));

    // Section-presence flags drive both the headers and the dividers between them.
    const hasFavorites = isAuthenticated && favoriteStreams.length > 0;
    const hasFollowed = isAuthenticated && followedNonFavoriteStreams.length > 0;
    const hasRecommended = showRecommended && recommendedStreams.length > 0;

    // Shared row renderer so Favorites / Followed / Recommended stay identical.
    const renderStreamItem = (stream: TwitchStream, showFavorite: boolean) => (
        <StreamItem
            key={stream.id}
            stream={stream}
            showFavorite={showFavorite}
            showExpanded={showExpanded}
            isCurrentStream={currentStream?.user_login === stream.user_login}
            isFavorite={isFavoriteStreamer(stream.user_id)}
            hasDrops={stream.game_name ? dropsGameNames.has(stream.game_name.toLowerCase()) : false}
            hypeTrainStatus={activeHypeTrainChannels.get(stream.user_id)}
            watchStreak={watchStreaks[stream.user_id] ?? 0}
            isHeartAnimating={animatingHearts.has(stream.user_id)}
            profileImage={getProfileImage(stream)}
            onStreamClick={handleStreamClick}
            onFavoriteClick={handleFavoriteClick}
        />
    );

    return (
        <>
            {/* SVG Definitions for Liquid Glass Heart */}
            <svg width="0" height="0" className="absolute pointer-events-none">
                <defs>
                    <linearGradient id="glass-heart-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(255, 255, 255, 0.4)" />
                        <stop offset="30%" stopColor="rgba(236, 72, 153, 0.2)" />
                        <stop offset="100%" stopColor="rgba(236, 72, 153, 0.6)" />
                    </linearGradient>
                    <linearGradient id="glass-heart-stroke" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(255, 255, 255, 0.8)" />
                        <stop offset="100%" stopColor="rgba(255, 255, 255, 0.1)" />
                    </linearGradient>
                </defs>
            </svg>

            {/* Edge trigger zone for hidden mode. z-[50] sits above Home's
                full-screen overlay (z-40) so hover-to-reveal works in home
                view, but stays below modal dialogs (which render later in DOM). */}
            {sidebarMode === 'hidden' && !visible && (
                <div
                    ref={edgeTriggerRef}
                    className={`fixed ${onRight ? 'right-0' : 'left-0'} top-0 h-full z-50`}
                    style={{ width: HIDDEN_TRIGGER_ZONE }}
                    onMouseEnter={() => setIsEdgeHovered(true)}
                />
            )}

            {/* Spacer for compact overlay mode to maintain layout - only when in overlay mode */}
            {sidebarMode === 'compact' && expandOnHover && isOverlay && (
                <div style={{ width: COMPACT_WIDTH, minWidth: COMPACT_WIDTH, flexShrink: 0, order: onRight ? 1 : 0 }} />
            )}

            {/* Main sidebar */}
            <div
                ref={sidebarRef}
                className={`
                    ${onRight ? 'border-l' : 'border-r'} border-borderSubtle flex flex-col flex-shrink-0
                    transition-[width,min-width,opacity,transform] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]
                    ${isOverlay
                        // Overlay panels are position:fixed, so a percentage height
                        // resolves against the viewport. Anchoring top (below the
                        // 40px title bar) AND bottom makes the panel exactly as tall
                        // as the content area — a full `h-full` shoved down would
                        // resolve to 100vh and hide the bottom of the scroll list
                        // off-screen at every non-fullscreen height. The top offset
                        // MUST track the title bar height (h-[40px] in TitleBar.tsx);
                        // when it lagged at top-8 the panel rode up under the bar and
                        // its frosted backing clipped the title-bar action icons.
                        ? `fixed ${onRight ? 'right-0' : 'left-0'} top-10 bottom-0 z-50`
                        : 'relative h-full'
                    }
                `}
                style={{
                    width: width,
                    minWidth: isOverlay ? 0 : width,
                    opacity: visible ? 1 : 0,
                    pointerEvents: visible ? 'auto' : 'none',
                    transform: visible ? 'translateX(0)' : `translateX(${onRight ? '10px' : '-10px'})`,
                    order: onRight ? 1 : 0,
                }}
                onMouseEnter={() => {
                    // Cancel any pending close timeout
                    if (closeTimeoutRef.current) {
                        clearTimeout(closeTimeoutRef.current);
                        closeTimeoutRef.current = null;
                    }
                    setIsHovered(true);
                }}
                onMouseLeave={() => {
                    // Don't close while resizing
                    if (isResizing) return;

                    // Add a delay before closing in hidden mode or compact overlay mode
                    const shouldDelay = sidebarMode === 'hidden' || (sidebarMode === 'compact' && expandOnHover);
                    if (shouldDelay) {
                        closeTimeoutRef.current = setTimeout(() => {
                            setIsHovered(false);
                            setIsEdgeHovered(false);
                            closeTimeoutRef.current = null;
                        }, SIDEBAR_CLOSE_DELAY);
                    } else {
                        setIsHovered(false);
                        setIsEdgeHovered(false);
                    }
                }}
            >
                {/* Background layers, kept separate from the content so the costly
                    frosted blur can fade in independently of the width change. While
                    the panel is widening only the cheap solid backing shows; once the
                    expand has settled (blurReady) the glass blur fades in, so the blur
                    is never re-rasterized mid-resize. These sit at z-0; the content
                    below is lifted to z-10 so it always paints above them. */}
                {/* Glass fades in FIRST, over the still-opaque solid, then the solid
                    fades out (200ms delay) to reveal the translucency. Sequencing them
                    this way keeps the panel fully opaque until the glass is fully in, so
                    it never dips more transparent than its final state mid-transition. */}
                <div
                    aria-hidden
                    className="absolute inset-0 z-0 bg-tertiary pointer-events-none"
                    style={{
                        opacity: blurReady ? 0 : 1,
                        transition: `opacity 260ms ease-out ${blurReady ? '200ms' : '0ms'}`,
                    }}
                />
                <div
                    aria-hidden
                    className="absolute inset-0 z-0 transition-opacity duration-200 ease-out pointer-events-none"
                    style={{
                        opacity: blurReady ? 1 : 0,
                        // Glassiness-aware frosted backing — tracks the global
                        // Glassiness slider in lockstep with every other glass
                        // surface. Same two-part recipe as .glass-panel: an opaque
                        // tertiary base fades IN as --glass-strength drops toward 0
                        // (so the panel goes fully solid at 0%), with the signature
                        // dark tint always layered on top via background-image.
                        backgroundColor: 'color-mix(in srgb, var(--color-background-tertiary) calc((1 - var(--glass-strength)) * 100%), transparent)',
                        backgroundImage: 'linear-gradient(rgba(26, 26, 27, 0.75), rgba(26, 26, 27, 0.75))',
                        // Frost scales with the slider; the html[data-glass="off"]
                        // floor hard-strips any remaining blur at 0%.
                        backdropFilter: blurReady ? 'blur(calc(24px * var(--glass-strength)))' : undefined,
                        WebkitBackdropFilter: blurReady ? 'blur(calc(24px * var(--glass-strength)))' : undefined,
                    }}
                />

                {/* Resize handle - only show when expanded */}
                {showExpanded && (
                    <Tooltip content="Drag to resize sidebar" delay={500} side="right">
                        <div
                            className={`
                                absolute ${onRight ? 'left-0' : 'right-0'} top-0 w-1 h-full cursor-ew-resize z-10
                                hover:bg-accent/50 active:bg-accent transition-colors
                                ${isResizing ? 'bg-accent' : 'bg-transparent'}
                            `}
                            onMouseDown={handleResizeStart}
                        />
                    </Tooltip>
                )}

                {/* Header — only rendered when it actually carries something: the
                    "Streams" label (expanded) or the manual collapse/expand toggle
                    (compact with expand-on-hover OFF). In the collapsed
                    expand-on-hover state it would hold neither, so rendering it then
                    just leaves an empty padded, bordered bar below the title bar. */}
                {(showExpanded || (sidebarMode === 'compact' && !expandOnHover)) && (
                    <div className={`
                        relative z-10 flex items-center p-2 border-b border-borderSubtle
                        ${showExpanded ? 'justify-between' : 'justify-center'}
                    `}>
                        {showExpanded && (
                            <span className="text-sm font-semibold text-textPrimary">Streams</span>
                        )}
                        {sidebarMode === 'compact' && !expandOnHover && (
                            <Tooltip content={isManuallyExpanded ? 'Collapse sidebar' : 'Expand sidebar'} delay={200} side="right">
                                <button
                                    onClick={() => setIsManuallyExpanded(!isManuallyExpanded)}
                                    className="p-1.5 rounded hover:bg-surface-hover text-textSecondary hover:text-textPrimary transition-all"
                                >
                                    {isManuallyExpanded ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
                                </button>
                            </Tooltip>
                        )}
                    </div>
                )}

                {/* Scrollable stream list */}
                <div
                    ref={scrollContainerRef}
                    className={`relative z-10 flex-1 min-h-0 overflow-x-hidden py-1 ${
                        // Hide scrollbar in compact mode with expand-on-hover when not expanded
                        sidebarMode === 'compact' && expandOnHover && !showExpanded
                            ? 'overflow-y-hidden'
                            : 'overflow-y-auto scrollbar-thin'
                        }`}
                >
                    {/* Favorites Section — favorited live channels, pulled out of
                        Followed into their own labeled group. */}
                    {hasFavorites && (
                        <div className="mb-2">
                            <SectionHeader icon={Heart} label="Favorites" count={favoriteStreams.length} showExpanded={showExpanded} />
                            <div className="space-y-0.5">
                                {favoriteStreams.map(stream => renderStreamItem(stream, true))}
                            </div>
                        </div>
                    )}

                    {/* Divider between Favorites and Followed */}
                    {hasFavorites && hasFollowed && (
                        <div className="mx-2 my-2 border-t border-borderSubtle" />
                    )}

                    {/* Followed Streams Section — live follows that aren't favorited. */}
                    {hasFollowed && (
                        <div className="mb-2">
                            <SectionHeader icon={Users} label="Followed" count={followedNonFavoriteStreams.length} showExpanded={showExpanded} />
                            <div className="space-y-0.5">
                                {followedNonFavoriteStreams.map(stream => renderStreamItem(stream, true))}
                            </div>
                        </div>
                    )}

                    {/* Divider before Recommended */}
                    {hasRecommended && (hasFavorites || hasFollowed) && (
                        <div className="mx-2 my-2 border-t border-borderSubtle" />
                    )}

                    {/* Recommended Streams Section */}
                    {hasRecommended && (
                        <div>
                            <SectionHeader icon={Sparkles} label="Recommended" count={recommendedStreams.length} showExpanded={showExpanded} />
                            <div className="space-y-0.5">
                                {recommendedStreams.map(stream => renderStreamItem(stream, false))}
                            </div>

                            {/* Loading more indicator */}
                            {isLoadingMore && (
                                <div className="flex justify-center py-2">
                                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-borderSubtle border-t-accent" />
                                </div>
                            )}
                        </div>
                    )}

                    {/* Empty state */}
                    {!isAuthenticated && !hasRecommended && (
                        <div className={`
                            flex items-center justify-center text-center p-4
                            ${showExpanded ? '' : 'flex-col'}
                        `}>
                            {showExpanded ? (
                                <p className="text-xs text-textMuted">
                                    Log in to see followed streams
                                </p>
                            ) : (
                                <Users size={16} className="text-textMuted" />
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Spacer for hidden mode to maintain layout */}
            {sidebarMode === 'hidden' && (
                <div style={{ width: 0, minWidth: 0, flexShrink: 0 }} />
            )}
        </>
    );
};

export default Sidebar;
