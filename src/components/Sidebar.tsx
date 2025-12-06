import { useEffect, useState, useRef, useCallback } from 'react';
import { useAppStore } from '../stores/AppStore';
import { ChevronLeft, ChevronRight, Users, Sparkles, Radio, Heart } from 'lucide-react';
import type { TwitchStream } from '../types';
import { invoke } from '@tauri-apps/api/core';
import { getSidebarSettings, type SidebarMode } from './settings/InterfaceSettings';

// Width constants
const COMPACT_WIDTH = 56;
const DEFAULT_EXPANDED_WIDTH = 280;
const MIN_EXPANDED_WIDTH = 200;
const MAX_EXPANDED_WIDTH = 450;
const HIDDEN_TRIGGER_ZONE = 16; // pixels from left edge to trigger sidebar
const SIDEBAR_CLOSE_DELAY = 150; // milliseconds delay before closing in hidden mode
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
        console.error('[Sidebar] Failed to read persisted width:', e);
    }
    return DEFAULT_EXPANDED_WIDTH;
};

// Save sidebar width to localStorage
const persistWidth = (width: number): void => {
    try {
        localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, width.toString());
    } catch (e) {
        console.error('[Sidebar] Failed to persist width:', e);
    }
};

const Sidebar = () => {
    const {
        followedStreams,
        recommendedStreams,
        loadFollowedStreams,
        loadRecommendedStreams,
        loadMoreRecommendedStreams,
        hasMoreRecommended,
        isLoadingMore,
        startStream,
        currentStream,
        isAuthenticated,
        isFavoriteStreamer,
        toggleFavoriteStreamer,
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

    // Hover and manual expand states
    const [isHovered, setIsHovered] = useState(false);
    const [isEdgeHovered, setIsEdgeHovered] = useState(false);
    const [isManuallyExpanded, setIsManuallyExpanded] = useState(false);

    // Resizable width state
    const [expandedWidth, setExpandedWidth] = useState<number>(getPersistedWidth);
    const [isResizing, setIsResizing] = useState(false);

    const sidebarRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const edgeTriggerRef = useRef<HTMLDivElement>(null);
    const closeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const [animatingHearts, setAnimatingHearts] = useState<Set<string>>(new Set());

    // Cache for profile images fetched from Twitch Helix API
    const [profileImages, setProfileImages] = useState<Map<string, string>>(new Map());
    const fetchingProfilesRef = useRef<Set<string>>(new Set());

    // Listen for settings changes from InterfaceSettings
    useEffect(() => {
        const handleSettingsChange = (event: CustomEvent<{ mode: SidebarMode; expandOnHover: boolean }>) => {
            setSidebarMode(event.detail.mode);
            setExpandOnHover(event.detail.expandOnHover);
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

    // Infinite scroll for recommended streams
    useEffect(() => {
        const scrollContainer = scrollContainerRef.current;
        if (!scrollContainer) return;

        const handleScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
            if (scrollHeight - scrollTop - clientHeight < 100 && hasMoreRecommended && !isLoadingMore) {
                loadMoreRecommendedStreams();
            }
        };

        scrollContainer.addEventListener('scroll', handleScroll);
        return () => scrollContainer.removeEventListener('scroll', handleScroll);
    }, [hasMoreRecommended, isLoadingMore, loadMoreRecommendedStreams]);

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
                console.error('[Sidebar] Failed to fetch profile images from Twitch:', error);
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
                return { visible: true, width: expandedWidth, showExpanded: true };

            case 'compact':
                // Show compact, expand on hover if enabled, or if manually expanded
                const shouldExpand = isManuallyExpanded || (expandOnHover && isHovered);
                return {
                    visible: true,
                    width: shouldExpand ? expandedWidth : COMPACT_WIDTH,
                    showExpanded: shouldExpand
                };

            case 'hidden':
                // Hidden until edge hover, then fully expanded
                // Keep visible while resizing to allow drag to complete
                const isVisible = isEdgeHovered || isHovered || isResizing;
                return {
                    visible: isVisible,
                    width: isVisible ? expandedWidth : 0,
                    showExpanded: isVisible
                };

            default:
                return { visible: true, width: COMPACT_WIDTH, showExpanded: false };
        }
    }, [sidebarMode, expandOnHover, isHovered, isEdgeHovered, isManuallyExpanded, expandedWidth, isResizing]);

    // Start resize handler
    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizing(true);
    }, []);

    const { visible, width, showExpanded } = calculateSidebarState();

    // Sort followed streams by favorites first
    const sortedFollowedStreams = [...followedStreams].sort((a, b) => {
        const aIsFavorite = isFavoriteStreamer(a.user_id);
        const bIsFavorite = isFavoriteStreamer(b.user_id);
        if (aIsFavorite && !bIsFavorite) return -1;
        if (!aIsFavorite && bIsFavorite) return 1;
        return 0;
    });

    const handleStreamClick = (stream: TwitchStream) => {
        startStream(stream.user_login, stream);
    };

    const handleFavoriteClick = (e: React.MouseEvent, userId: string) => {
        e.stopPropagation();

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
    };

    const formatViewerCount = (count: number): string => {
        if (count >= 1000000) {
            return (count / 1000000).toFixed(1) + 'M';
        } else if (count >= 1000) {
            return (count / 1000).toFixed(1) + 'K';
        }
        return count.toString();
    };

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

    const StreamItem = ({ stream, showFavorite = false }: { stream: TwitchStream; showFavorite?: boolean }) => {
        const isCurrentStream = currentStream?.user_login === stream.user_login;
        const isFavorite = isFavoriteStreamer(stream.user_id);

        return (
            <div
                className={`
                    flex items-center px-2 py-1.5 cursor-pointer rounded transition-all duration-200
                    ${isCurrentStream
                        ? 'bg-surface-active border-l-2 border-accent'
                        : 'hover:bg-surface-hover border-l-2 border-transparent'
                    }
                    ${showExpanded ? 'gap-2 justify-start' : 'gap-0 justify-center'}
                `}
                onClick={() => handleStreamClick(stream)}
                title={showExpanded ? undefined : `${stream.user_name} - ${stream.game_name}`}
            >
                {/* Avatar with live indicator */}
                <div className="relative flex-shrink-0 transition-all duration-200">
                    <img
                        src={getProfileImage(stream)}
                        alt={stream.user_name}
                        className={`rounded-full object-cover transition-all duration-200 ${showExpanded ? 'w-8 h-8' : 'w-9 h-9'}`}
                        onError={(e) => {
                            (e.target as HTMLImageElement).src = 'https://static-cdn.jtvnw.net/user-default-pictures-uv/75305d54-c7cc-40d1-bb9c-91c46bf27829-profile_image-70x70.png';
                        }}
                    />
                    <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-background animate-pulse" style={{ backgroundColor: '#eb0000' }} />
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
                        </div>
                        <div className="flex items-center gap-1 text-xs text-textMuted truncate">
                            <span className="truncate">{stream.game_name || 'Just Chatting'}</span>
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
                            <button
                                onClick={(e) => handleFavoriteClick(e, stream.user_id)}
                                className={`p-1 rounded transition-all ${isFavorite
                                    ? 'text-pink-500 hover:text-pink-600'
                                    : 'text-textMuted hover:text-pink-400 opacity-0 group-hover:opacity-100'
                                    }`}
                                title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                            >
                                <Heart
                                    size={12}
                                    fill={isFavorite ? 'currentColor' : 'none'}
                                    className={animatingHearts.has(stream.user_id) ? 'animate-heart-break' : ''}
                                />
                            </button>
                        )}
                    </div>
                )}
            </div>
        );
    };

    const SectionHeader = ({ icon: Icon, label, count }: { icon: any; label: string; count: number }) => (
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
    );

    return (
        <>
            {/* Edge trigger zone for hidden mode */}
            {sidebarMode === 'hidden' && !visible && (
                <div
                    ref={edgeTriggerRef}
                    className="fixed left-0 top-0 h-full z-40"
                    style={{ width: HIDDEN_TRIGGER_ZONE }}
                    onMouseEnter={() => setIsEdgeHovered(true)}
                />
            )}

            {/* Main sidebar */}
            <div
                ref={sidebarRef}
                className={`
                    h-full border-r border-borderSubtle flex flex-col flex-shrink-0 
                    transition-[width,min-width,opacity,transform,background-color,backdrop-filter] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]
                    ${sidebarMode === 'hidden' ? 'fixed left-0 top-0 z-30 mt-8' : 'relative'}
                    ${showExpanded ? 'backdrop-blur-xl' : 'bg-tertiary'}
                `}
                style={{
                    width: width,
                    minWidth: sidebarMode === 'hidden' ? 0 : width,
                    opacity: visible ? 1 : 0,
                    pointerEvents: visible ? 'auto' : 'none',
                    transform: visible ? 'translateX(0)' : 'translateX(-10px)',
                    backgroundColor: showExpanded ? 'rgba(26, 26, 27, 0.75)' : undefined,
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

                    // Add a delay before closing in hidden mode
                    if (sidebarMode === 'hidden') {
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
                {/* Resize handle - only show when expanded */}
                {showExpanded && (
                    <div
                        className={`
                            absolute right-0 top-0 w-1 h-full cursor-ew-resize z-10
                            hover:bg-accent/50 active:bg-accent transition-colors
                            ${isResizing ? 'bg-accent' : 'bg-transparent'}
                        `}
                        onMouseDown={handleResizeStart}
                        title="Drag to resize sidebar"
                    />
                )}

                {/* Header */}
                <div className={`
                    flex items-center p-2 border-b border-borderSubtle
                    ${showExpanded ? 'justify-between' : 'justify-center'}
                `}>
                    {showExpanded && (
                        <span className="text-sm font-semibold text-textPrimary">Streams</span>
                    )}
                    {/* Show toggle button in compact mode when expand-on-hover is disabled */}
                    {sidebarMode === 'compact' && !expandOnHover && (
                        <button
                            onClick={() => setIsManuallyExpanded(!isManuallyExpanded)}
                            className="p-1.5 rounded hover:bg-surface-hover text-textSecondary hover:text-textPrimary transition-all"
                            title={isManuallyExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
                        >
                            {isManuallyExpanded ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
                        </button>
                    )}
                </div>

                {/* Scrollable stream list */}
                <div
                    ref={scrollContainerRef}
                    className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin py-1"
                >
                    {/* Followed Streams Section */}
                    {isAuthenticated && sortedFollowedStreams.length > 0 && (
                        <div className="mb-2">
                            <SectionHeader icon={Users} label="Followed" count={sortedFollowedStreams.length} />
                            <div className="space-y-0.5">
                                {sortedFollowedStreams.map(stream => (
                                    <div key={stream.id} className="group">
                                        <StreamItem stream={stream} showFavorite={true} />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Divider */}
                    {isAuthenticated && sortedFollowedStreams.length > 0 && recommendedStreams.length > 0 && (
                        <div className="mx-2 my-2 border-t border-borderSubtle" />
                    )}

                    {/* Recommended Streams Section */}
                    {recommendedStreams.length > 0 && (
                        <div>
                            <SectionHeader icon={Sparkles} label="Recommended" count={recommendedStreams.length} />
                            <div className="space-y-0.5">
                                {recommendedStreams.map(stream => (
                                    <StreamItem key={stream.id} stream={stream} />
                                ))}
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
                    {!isAuthenticated && recommendedStreams.length === 0 && (
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
