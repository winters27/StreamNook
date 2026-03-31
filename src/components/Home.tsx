import { useEffect, useState, useRef, useCallback } from 'react';
import { useAppStore, HomeTab } from '../stores/AppStore';
import { createPortal } from 'react-dom';
import { Search, ArrowLeft, Heart, Maximize2, X, Gift, Pickaxe, LayoutGrid, Flame, ArrowUpRight, Undo2, Users, User, Loader2, MessageSquare } from 'lucide-react';
import { motion, LayoutGroup, AnimatePresence, useScroll, useTransform } from 'framer-motion';
import { usemultiNookStore } from '../stores/multiNookStore';

import { invoke } from '@tauri-apps/api/core';
import type { TwitchStream, TwitchCategory, CategoryInfo, TwitchClip, TwitchVideo } from '../types';
import LoadingWidget from './LoadingWidget';
import StreamTitleWithEmojis from './StreamTitleWithEmojis';
import { useContextMenuStore } from '../stores/contextMenuStore';
import { Tooltip } from './ui/Tooltip';
import { GlassSelect } from './ui/GlassSelect';

import { Logger } from '../utils/logger';
// Types for drops data
interface DropCampaign {
    id: string;
    name: string;
    game_id: string;
    game_name: string;
}

interface MiningChannel {
    id: string;
    name: string;
    display_name: string;
    game_name: string;
    viewer_count: number;
    is_live: boolean;
    drops_enabled: boolean;
}

interface CurrentDropInfo {
    campaign_id: string;
    campaign_name: string;
    drop_id: string;
    drop_name: string;
    required_minutes: number;
    current_minutes: number;
    game_name: string;
}

interface MiningStatus {
    is_mining: boolean;
    current_channel: MiningChannel | null;
    current_campaign: string | null;
    current_drop: CurrentDropInfo | null;
    eligible_channels: MiningChannel[];
    last_update: string;
}

const FlyingDot = ({ startX, startY, targetX, targetY }: { startX: number, startY: number, targetX: number, targetY: number }) => {
    const [isFlying, setIsFlying] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => setIsFlying(true), 10);
        return () => clearTimeout(timer);
    }, []);

    return (
        <div 
            className="fixed z-[9999] pointer-events-none flex h-5 w-5 items-center justify-center rounded-full bg-red-500 shadow-[0_0_15px_rgba(239,68,68,0.8)]"
            style={{
                left: isFlying ? targetX : startX,
                top: isFlying ? targetY : startY,
                opacity: isFlying ? 0.3 : 1,
                transform: isFlying ? 'scale(0.3)' : 'scale(1)',
                transition: 'all 500ms cubic-bezier(0.25, 1, 0.5, 1)'
            }}
        >
           <LayoutGrid size={12} className="text-white" />
        </div>
    );
};

const ReverseFlyingDot = ({ startX, startY, targetX, targetY }: { startX: number, startY: number, targetX: number, targetY: number }) => {
    const [isFlying, setIsFlying] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => setIsFlying(true), 10);
        return () => clearTimeout(timer);
    }, []);

    return (
        <div 
            className="fixed z-[9999] pointer-events-none flex h-5 w-5 items-center justify-center rounded-full bg-accent shadow-[0_0_15px_rgba(var(--color-accent-rgb),0.8)]"
            style={{
                left: isFlying ? targetX : startX,
                top: isFlying ? targetY : startY,
                opacity: isFlying ? 1 : 0.3,
                transform: isFlying ? 'scale(1)' : 'scale(0.3)',
                transition: 'all 500ms cubic-bezier(0.25, 1, 0.5, 1)'
            }}
        >
           <Undo2 size={10} className="text-white" />
        </div>
    );
};

const MultiNookToggle = () => {
    const { isMultiNookActive, toggleMultiNook, slots, flyingAnimation, recallAnimation } = usemultiNookStore();
    const { toggleHome } = useAppStore();
    const [animateBadge, setAnimateBadge] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [flyingDots, setFlyingDots] = useState<Array<{ id: number, startX: number, startY: number, targetX: number, targetY: number }>>([]);
    const [reverseDots, setReverseDots] = useState<Array<{ id: number, startX: number, startY: number, targetX: number, targetY: number }>>([]);

    useEffect(() => {
        if (flyingAnimation && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            // Target is the top right of the button where the badge will sit
            const targetX = rect.right - 10;
            const targetY = rect.top - 5;
            
            const newDot = {
                id: flyingAnimation.id,
                startX: flyingAnimation.x,
                startY: flyingAnimation.y,
                targetX,
                targetY
            };
            
            setFlyingDots(prev => [...prev, newDot]);
            
            setTimeout(() => {
                setFlyingDots(prev => prev.filter(d => d.id !== newDot.id));
                setAnimateBadge(true);
                setTimeout(() => setAnimateBadge(false), 200);
            }, 500); 
        }
    }, [flyingAnimation]);

    // Handle reverse recall animation — dot flies from badge to card
    useEffect(() => {
        if (recallAnimation) {
            const newDot = {
                id: recallAnimation.id,
                startX: recallAnimation.sourceX,
                startY: recallAnimation.sourceY,
                targetX: recallAnimation.targetX,
                targetY: recallAnimation.targetY,
            };
            
            queueMicrotask(() => setReverseDots(prev => [...prev, newDot]));
            
            setTimeout(() => {
                setReverseDots(prev => prev.filter(d => d.id !== newDot.id));
            }, 600);
        }
    }, [recallAnimation]);

    return (
        <>
            <Tooltip content={isMultiNookActive ? 'Return to MultiNook' : 'Enter MultiNook'} side="bottom">
                <button
                    id="multinook-return-button"
                    ref={buttonRef}
                    onClick={() => {
                        if (isMultiNookActive) {
                            toggleHome();
                        } else {
                            toggleMultiNook();
                        }
                    }}
                    className={`relative px-3 py-1.5 text-sm font-medium rounded-lg transition-all whitespace-nowrap mr-0.5 ${
                        isMultiNookActive
                            ? 'glass-button text-accent shadow-[0_0_15px_rgba(var(--color-accent-rgb),0.3)]'
                            : 'text-textSecondary hover:text-textPrimary'
                    }`}
                >
                    {isMultiNookActive ? 'Return' : 'MultiNook'}
                    {!isMultiNookActive && slots.length > 0 && (
                        <span 
                            className={`absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full glass-button !bg-red-500/30 text-[9px] font-extrabold text-white !shadow-[0_2px_10px_rgba(239,68,68,0.4),inset_0_1px_rgba(255,255,255,0.2)] z-50 ${
                                animateBadge ? 'scale-150 ring-2 ring-red-500 transition-transform duration-200' : 'scale-100 transition-transform duration-500'
                            }`}
                        >
                            {slots.length}
                        </span>
                    )}
                </button>
            </Tooltip>
            {flyingDots.length > 0 && typeof document !== 'undefined' && createPortal(
                flyingDots.map(dot => (
                    <FlyingDot key={dot.id} {...dot} />
                )),
                document.body
            )}
            {reverseDots.length > 0 && typeof document !== 'undefined' && createPortal(
                reverseDots.map(dot => (
                    <ReverseFlyingDot key={dot.id} {...dot} />
                )),
                document.body
            )}
        </>
    );
};

const QuickAddButton = ({ stream }: { stream: TwitchStream }) => {
    const { addSlot, slots, triggerAddAnimation } = usemultiNookStore();
    const [rotation, setRotation] = useState(0); 
    const buttonRef = useRef<HTMLButtonElement>(null);

    // Compute the dynamic rotation pointing toward the return button
    const handleHover = () => {
        if (!buttonRef.current) return;
        const targetBtn = document.getElementById('multinook-return-button');
        if (targetBtn) {
            const targetRect = targetBtn.getBoundingClientRect();
            const sourceRect = buttonRef.current.getBoundingClientRect();
            
            const targetX = targetRect.left + (targetRect.width / 2);
            const targetY = targetRect.top + (targetRect.height / 2);
            const sourceX = sourceRect.left + (sourceRect.width / 2);
            const sourceY = sourceRect.top + (sourceRect.height / 2);
            
            const angle = Math.atan2(targetY - sourceY, targetX - sourceX) * (180 / Math.PI);
            // ArrowUpRight points initially to top right (-45 Cartesian). Offset sets it naturally.
            setRotation(angle + 45);
        }
    };

    useEffect(() => {
        handleHover(); // Initial calculation

        // Attach a listener to the parent card so angle calculates perfectly when the card is hovered
        const groupAncestor = buttonRef.current?.closest('.group');
        if (groupAncestor) {
            groupAncestor.addEventListener('mouseenter', handleHover);
            return () => groupAncestor.removeEventListener('mouseenter', handleHover);
        }
    }, []);

    // Also update on resize to ensure arrow points perfectly in different window dimensions
    useEffect(() => {
        const resizeListener = () => handleHover();
        window.addEventListener('resize', resizeListener);
        return () => window.removeEventListener('resize', resizeListener);
    }, []);

    if (slots.some(s => s.channelLogin.toLowerCase() === stream.user_login.toLowerCase())) return null;

    return (
        <div 
            className="absolute -top-2.5 -right-2.5 z-20 opacity-0 group-hover:opacity-100 transition-all duration-300 scale-90 group-hover:scale-100 group-hover:-translate-y-1 group-hover:translate-x-1"
            onMouseEnter={handleHover}    
        >
            <Tooltip content="Add to MultiNook" side="top">
                <button
                    ref={buttonRef}
                    onClick={(e) => {
                        e.stopPropagation();
                        triggerAddAnimation(e.clientX, e.clientY, stream.user_login);
                        addSlot(stream.user_login);
                    }}
                    className="flex items-center justify-center glass-button !rounded-full aspect-square !p-1.5 text-white shadow-[0_4px_10px_rgba(0,0,0,0.5)]"
                >
                    <ArrowUpRight 
                        size={14} 
                        strokeWidth={2} 
                        style={{ transform: `rotate(${rotation}deg)`, transition: 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)' }}
                    />
                </button>
            </Tooltip>
        </div>
    );
};



const Home = () => {
    const {
        followedStreams,
        recommendedStreams,
        loadFollowedStreams,
        loadRecommendedStreams,
        loadMoreRecommendedStreams,
        hasMoreRecommended,
        isLoadingMore,
        startStream,
        isAuthenticated,
        toggleFavoriteStreamer,
        isFavoriteStreamer,
        loginToTwitch,
        isLoading,
        streamUrl,
        toggleHome,
        // Navigation state from AppStore
        homeActiveTab,
        homeSelectedCategory,
        setHomeActiveTab,
        setHomeSelectedCategory,
        // Category cache
        cachedTopGames,
        cachedGamesCursor,
        cachedHasMoreGames,
        cachedTopGamesTimestamp,
        setCachedTopGames,
        appendCachedTopGames,
        // Hype Train status for stream badges
        activeHypeTrainChannels,
        refreshHypeTrainStatuses,
        watchStreaks,
        offlineFollowedChannels,
        setOfflineFollowedChannels,
        setProfileModalUser,
        openDropsWithSearch,
        playMedia,
        homeCategoryTab,
        setHomeCategoryTab,
        clipsPeriod, setClipsPeriod,
        videosSort, setVideosSort,
        videosPeriod, setVideosPeriod,
        mediaSearchQuery, setMediaSearchQuery,
    } = useAppStore();

    const [isLoadingOfflineChannels, setIsLoadingOfflineChannels] = useState(false);
    const [offlineChannelsFetched, setOfflineChannelsFetched] = useState(false);
    const [offlineLastBroadcasts, setOfflineLastBroadcasts] = useState<Record<string, string | null>>({});

    // Fetch offline followed channels when viewing the following tab
    useEffect(() => {
        if (homeActiveTab === 'following' && isAuthenticated && !offlineChannelsFetched && !isLoadingOfflineChannels) {
            const fetchOfflineChannels = async () => {
                setIsLoadingOfflineChannels(true);
                try {
                    const result = await invoke('get_all_followed_channels', { limit: 100, cursor: null }) as [TwitchStream[], string | null];
                    const channels = result[0];
                    
                    // Filter out already live ones (that are in followedStreams)
                    const liveIds = new Set(followedStreams.map(s => s.user_id));
                    const offline = channels.filter(c => !liveIds.has(c.user_id));
                    
                    setOfflineFollowedChannels(offline);
                    setOfflineChannelsFetched(true);

                    // Fetch "last broadcast" metadata natively via GQL
                    if (offline.length > 0) {
                        try {
                            const userIds = offline.map(c => c.user_id);
                            const broadcasts = await invoke('get_offline_last_broadcasts', { userIds }) as Record<string, string | null>;
                            Logger.info('Fetched offline last broadcasts:', broadcasts);
                            setOfflineLastBroadcasts(prev => ({ ...prev, ...broadcasts }));
                        } catch(e) {
                            Logger.error('Failed to fetch offline last broadcasts:', e);
                        }
                    }
                } catch (e) {
                    Logger.error('Failed to fetch offline followed channels:', e);
                } finally {
                    setIsLoadingOfflineChannels(false);
                }
            };
            fetchOfflineChannels();
        }
    }, [homeActiveTab, isAuthenticated, followedStreams, offlineChannelsFetched, isLoadingOfflineChannels, setOfflineFollowedChannels]);

    // MultiNook ghost card state
    const multiNookSlots = usemultiNookStore(s => s.slots);
    const isMultiNookActive = usemultiNookStore(s => s.isMultiNookActive);
    const suckUpLogin = usemultiNookStore(s => s.suckUpLogin);
    const materializingLogin = usemultiNookStore(s => s.materializingLogin);
    const triggerRecallAnimation = usemultiNookStore(s => s.triggerRecallAnimation);
    
    // Determine if Home is acting as an overlay over a playing stream/multinook
    const isOverlayMode = !!streamUrl || isMultiNookActive;
    const isInMultiNook = useCallback((login: string) => 
        multiNookSlots.some(s => s.channelLogin.toLowerCase() === login.toLowerCase()), 
        [multiNookSlots]
    );

    // Use store state directly
    const activeTab = homeActiveTab;
    const selectedCategory = homeSelectedCategory;

    // Wrapper functions to update store state
    const setActiveTab = (tab: HomeTab) => setHomeActiveTab(tab);
    const setSelectedCategory = (category: TwitchCategory | null) => setHomeSelectedCategory(category);

    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<TwitchStream[]>([]);
    const [categorySearchResults, setCategorySearchResults] = useState<TwitchCategory[]>([]);
    const [searchMode, setSearchMode] = useState<'streamers' | 'categories'>('streamers');
    const [isSearching, setIsSearching] = useState(false);
    const topGames = cachedTopGames;
    const [isLoadingGames, setIsLoadingGames] = useState(false);
    const gamesCursor = cachedGamesCursor;
    const hasMoreGames = cachedHasMoreGames;
    const [isLoadingMoreGames, setIsLoadingMoreGames] = useState(false);
    const [categoryStreams, setCategoryStreams] = useState<TwitchStream[]>([]);
    const [categoryStreamsCursor, setCategoryStreamsCursor] = useState<string | null>(null);
    const [hasMoreCategoryStreams, setHasMoreCategoryStreams] = useState(true);
    const [isLoadingMoreCategoryStreams, setIsLoadingMoreCategoryStreams] = useState(false);
    const [isLoadingCategoryStreams, setIsLoadingCategoryStreams] = useState(false);
    
    // Category Tabs State
    const [categoryActiveTab, setCategoryActiveTabLocal] = useState<'live' | 'clips' | 'videos'>(homeCategoryTab);
    // Wrapper that syncs local and store state
    const setCategoryActiveTab = useCallback((tab: 'live' | 'clips' | 'videos') => {
        setCategoryActiveTabLocal(tab);
        setHomeCategoryTab(tab);
    }, [setHomeCategoryTab]);
    // Sync from store → local when navigating back from a clip/VOD
    useEffect(() => {
        setCategoryActiveTabLocal(homeCategoryTab);
    }, [homeCategoryTab]);
    const [categoryClips, setCategoryClips] = useState<TwitchClip[]>([]);
    const [categoryClipsCursor, setCategoryClipsCursor] = useState<string | null>(null);
    const [hasMoreCategoryClips, setHasMoreCategoryClips] = useState(true);
    const [isLoadingClips, setIsLoadingClips] = useState(false);
    const [isLoadingMoreClips, setIsLoadingMoreClips] = useState(false);
    
    const [categoryVideos, setCategoryVideos] = useState<TwitchVideo[]>([]);
    const [categoryVideosCursor, setCategoryVideosCursor] = useState<string | null>(null);
    const [hasMoreCategoryVideos, setHasMoreCategoryVideos] = useState(true);
    const [isLoadingVideos, setIsLoadingVideos] = useState(false);
    const [isLoadingMoreVideos, setIsLoadingMoreVideos] = useState(false);

    const [categoryDetails, setCategoryDetails] = useState<CategoryInfo | null>(null);
    const [isLoadingCategoryDetails, setIsLoadingCategoryDetails] = useState(false);
    const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
    const [isDescriptionClamped, setIsDescriptionClamped] = useState(true);
    const [animatingHearts, setAnimatingHearts] = useState<Set<string>>(new Set());
    const [isSearchExpanded, setIsSearchExpanded] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    // Drops-enabled categories tracking (by game_id)
    const [dropsGameIds, setDropsGameIds] = useState<Map<string, DropCampaign>>(new Map());
    // Drops by game name (for stream cards which have game_name)
    const [dropsGameNames, setDropsGameNames] = useState<Map<string, DropCampaign>>(new Map());

    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const { scrollY } = useScroll({ container: scrollContainerRef });
    
    // Smooth scroll-linked math for the compact Top UI floating pill
    const heroOpacity = useTransform(scrollY, [10, 80], [1, 0]);
    // The floating Pill Title fades in strictly as the Hero finishes fading out
    const compactTitleOpacity = useTransform(scrollY, [60, 100], [0, 1]);
    const compactTitleY = useTransform(scrollY, [60, 100], [10, 0]);
    const loadingRef = useRef(false);
    
    // Debounce ref for Hype Train status refresh
    const hypeTrainRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Track if the Home component has initialized (to avoid showing LoadingWidget on user-initiated login)
    const [hasInitialized, setHasInitialized] = useState(false);

    useEffect(() => {
        // Mark as initialized immediately so we render cached store data if available
        setHasInitialized(true);

        // Delay background fetches to allow AnimatePresence fade-in to complete smoothly
        // and prevent HTTP connection pool starvation for active HLS video streams.
        const initTimer = setTimeout(() => {
            loadFollowedStreams();
            loadRecommendedStreams();
            loadActiveDrops(); // Load drops data so we can show indicators on stream cards
        }, 300);

        return () => clearTimeout(initTimer);
    }, [loadFollowedStreams, loadRecommendedStreams]);

    // Scroll-Collapse Header Observer has been completely replaced by native framer-motion useScroll progressive tracking!    // Auto-select the appropriate tab based on auth status on initial mount only
    // This effect should NOT run when user clicks tabs - remove homeActiveTab from deps
    useEffect(() => {
        // Don't override if user has navigated to a specific tab
        // Only auto-select on initial mount or when auth status truly changes
        if (homeActiveTab === 'category' || homeActiveTab === 'search' || homeActiveTab === 'browse') {
            return;
        }
        if (isAuthenticated && followedStreams.length > 0) {
            setActiveTab('following');
        } else if (!isAuthenticated || followedStreams.length === 0) {
            setActiveTab('recommended');
        }
        // Note: homeActiveTab intentionally not in deps to prevent feedback loop
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthenticated, followedStreams.length]);

    // Focus search input when expanded
    useEffect(() => {
        if (isSearchExpanded && searchInputRef.current) {
            searchInputRef.current.focus();
        }
    }, [isSearchExpanded]);

    const loadTopGames = async (background = false) => {
        if (!background) {
            setIsLoadingGames(true);
        }
        try {
            const [games, cursor] = await invoke('get_top_games_paginated', {
                cursor: null,
                limit: 40
            }) as [TwitchCategory[], string | null];
            
            if (background && cachedTopGames.length > 40) {
                // Preserve scroll-loaded pages: replace only page 1, keep pages 2+
                const preservedPages = cachedTopGames.slice(40);
                setCachedTopGames([...games, ...preservedPages], cachedGamesCursor, cachedHasMoreGames);
            } else {
                setCachedTopGames(games, cursor, !!cursor);
            }
        } catch (e) {
            Logger.error('Failed to load top games:', e);
            if (!background) {
                setCachedTopGames([], null, false);
            }
        } finally {
            if (!background) {
                setIsLoadingGames(false);
            }
        }
    };

    const loadMoreTopGames = useCallback(async () => {
        if (!hasMoreGames || isLoadingMoreGames || !gamesCursor) return;

        setIsLoadingMoreGames(true);
        try {
            const [games, cursor] = await invoke('get_top_games_paginated', {
                cursor: gamesCursor,
                limit: 40
            }) as [TwitchCategory[], string | null];
            appendCachedTopGames(games, cursor, !!cursor);
        } catch (e) {
            Logger.error('Failed to load more top games:', e);
        } finally {
            setIsLoadingMoreGames(false);
        }
    }, [hasMoreGames, isLoadingMoreGames, gamesCursor, appendCachedTopGames]);

    // Load active drops campaigns and build maps for both game_id and game_name lookup
    const loadActiveDrops = async () => {
        try {
            // Use get_active_drop_campaigns for ALL active campaigns (not just inventory)
            const campaigns = await invoke<DropCampaign[]>('get_active_drop_campaigns');
            if (campaigns && campaigns.length > 0) {
                const dropsIdMap = new Map<string, DropCampaign>();
                const dropsNameMap = new Map<string, DropCampaign>();
                for (const campaign of campaigns) {
                    if (campaign.game_id) {
                        dropsIdMap.set(campaign.game_id, campaign);
                    }
                    if (campaign.game_name) {
                        dropsNameMap.set(campaign.game_name.toLowerCase(), campaign);
                    }
                }
                setDropsGameIds(dropsIdMap);
                setDropsGameNames(dropsNameMap);
                Logger.debug(`[Home] Found ${dropsIdMap.size} categories with active drops`);

                // Also check current mining status to sync state
                try {
                    const miningStatus = await invoke<MiningStatus>('get_mining_status');
                    if (miningStatus.is_mining) {
                        // Find campaign ID by matching game_name from current_drop or current_channel
                        const miningGameName = miningStatus.current_drop?.game_name?.toLowerCase() ||
                            miningStatus.current_channel?.game_name?.toLowerCase();
                        if (miningGameName) {
                            for (const campaign of campaigns) {
                                if (campaign.game_name?.toLowerCase() === miningGameName) {
                                    Logger.debug(`[Home] Already mining campaign: ${campaign.name}`);
                                    setActiveMiningIds(prev => new Set(prev).add(campaign.id));
                                    break;
                                }
                            }
                        }
                    }
                } catch (e) {
                    Logger.warn('Could not get mining status:', e);
                }
            } else {
                setDropsGameIds(new Map());
                setDropsGameNames(new Map());
            }
        } catch (e) {
            Logger.error('Failed to load active drops:', e);
            setDropsGameIds(new Map());
            setDropsGameNames(new Map());
        }
    };

    // State for mining animation and tracking actively mining campaigns
    const [activeMiningIds, setActiveMiningIds] = useState<Set<string>>(new Set());
    const [flyingDroplet, setFlyingDroplet] = useState<{ visible: boolean; x: number; y: number } | null>(null);

    // Create a map from campaign name to campaign ID for reverse lookup
    const campaignNameToIdRef = useRef<Map<string, string>>(new Map());

    // Effect to refresh Hype Train status when streams are loaded or changed
    useEffect(() => {
        // Collect all channel IDs from all visible streams
        const channelIds = new Set<string>();
        followedStreams.forEach(s => channelIds.add(s.user_id));
        recommendedStreams.forEach(s => channelIds.add(s.user_id));
        categoryStreams.forEach(s => channelIds.add(s.user_id));
        searchResults.forEach(s => channelIds.add(s.user_id));
        
        if (channelIds.size > 0) {
            // Debounce the refresh to avoid rapid API calls and network starvation
            if (hypeTrainRefreshTimeoutRef.current) {
                clearTimeout(hypeTrainRefreshTimeoutRef.current);
            }
            hypeTrainRefreshTimeoutRef.current = setTimeout(() => {
                refreshHypeTrainStatuses(Array.from(channelIds));
            }, 2000); // 2000ms delay to prioritize HLS segments
        }
        
        return () => {
            if (hypeTrainRefreshTimeoutRef.current) {
                clearTimeout(hypeTrainRefreshTimeoutRef.current);
            }
        };
    }, [followedStreams, recommendedStreams, categoryStreams, searchResults, refreshHypeTrainStatuses]);

    // Effect to poll mining status and keep UI in sync with backend
    useEffect(() => {
        const syncMiningStatus = async () => {
            try {
                const miningStatus = await invoke<MiningStatus>('get_mining_status');

                if (miningStatus.is_mining) {
                    // Find campaign ID by matching game_name from current_drop or current_channel
                    const miningGameName = miningStatus.current_drop?.game_name?.toLowerCase() ||
                        miningStatus.current_channel?.game_name?.toLowerCase();

                    if (miningGameName) {
                        // Find the campaign for this game
                        let foundCampaignId: string | null = null;
                        dropsGameNames.forEach((campaign, gameName) => {
                            if (gameName === miningGameName) {
                                foundCampaignId = campaign.id;
                            }
                        });

                        if (foundCampaignId) {
                            setActiveMiningIds(prev => {
                                if (prev.size === 1 && prev.has(foundCampaignId!)) {
                                    return prev; // No change needed
                                }
                                return new Set([foundCampaignId!]);
                            });
                        }
                    }
                } else {
                    // Not mining - clear the active mining IDs
                    setActiveMiningIds(prev => {
                        if (prev.size > 0) {
                            return new Set<string>();
                        }
                        return prev;
                    });
                }
            } catch {
                // Silently fail - might not be authenticated or backend not ready
            }
        };

        // Initial sync
        syncMiningStatus();

        // Poll every 5 seconds
        const interval = setInterval(syncMiningStatus, 5000);

        // Also listen for mining status change events
        let unlisten: (() => void) | null = null;
        let isMounted = true;
        const setupListener = async () => {
            try {
                const { listen } = await import('@tauri-apps/api/event');
                const unlistenFn = await listen('mining-status-changed', syncMiningStatus);
                if (isMounted) {
                    unlisten = unlistenFn;
                } else {
                    unlistenFn();
                }
            } catch {
                // Event listener not available
            }
        };
        setupListener();

        return () => {
            isMounted = false;
            clearInterval(interval);
            if (unlisten) unlisten();
        };
    }, [dropsGameNames]);

    // Update campaign name-to-ID map when drops data loads
    useEffect(() => {
        const nameToId = new Map<string, string>();
        dropsGameIds.forEach((campaign) => {
            nameToId.set(campaign.name, campaign.id);
        });
        campaignNameToIdRef.current = nameToId;
    }, [dropsGameIds]);

    // Handler to toggle mining drops for a category (start or stop)
    const handleToggleMining = async (e: React.MouseEvent, campaign: DropCampaign) => {
        e.stopPropagation(); // Don't trigger category click

        const isCurrentlyMining = activeMiningIds.has(campaign.id);

        if (isCurrentlyMining) {
            // Stop mining
            try {
                await invoke('stop_auto_mining');
                Logger.debug(`[Home] Stopped mining drops for ${campaign.name}`);
                setActiveMiningIds(new Set()); // Clear all mining IDs
                useAppStore.getState().addToast(`Stopped mining drops for ${campaign.game_name}`, 'info');
            } catch (error) {
                Logger.error('Failed to stop mining:', error);
                useAppStore.getState().addToast('Failed to stop mining drops', 'error');
            }
        } else {
            // Start mining
            // Get button position for flying animation
            const button = e.currentTarget as HTMLElement;
            const rect = button.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            try {
                await invoke('start_campaign_mining', { campaignId: campaign.id });
                Logger.debug(`[Home] Started mining drops for ${campaign.name}`);

                // Add to active mining set
                setActiveMiningIds(new Set([campaign.id]));

                // Start flying droplet animation
                setFlyingDroplet({ visible: true, x: centerX, y: centerY });

                // Clear flying animation after it completes
                setTimeout(() => setFlyingDroplet(null), 1000);

                useAppStore.getState().addToast(`Started mining drops for ${campaign.game_name}`, 'success');
            } catch (error) {
                Logger.error('Failed to start mining:', error);
                useAppStore.getState().addToast('Failed to start mining drops', 'error');
            }
        }
    };

    const CATEGORY_CACHE_TTL = 60_000; // 60 seconds

    const handleBrowseClick = () => {
        setActiveTab('browse');
        setIsSearchExpanded(false);
        
        const isCacheStale = Date.now() - cachedTopGamesTimestamp > CATEGORY_CACHE_TTL;
        
        if (topGames.length === 0) {
            loadTopGames(false);
        } else if (isCacheStale) {
            loadTopGames(true);
        }
        
        // Also load drops data
        if (dropsGameIds.size === 0) {
            loadActiveDrops();
        }
    };

    const handleCategoryClick = async (category: TwitchCategory) => {
        setSelectedCategory(category);
        setActiveTab('category');
        setIsLoadingCategoryStreams(true);
        setCategoryStreams([]);
        setIsLoadingCategoryDetails(true);
        setCategoryDetails(null);
        setIsDescriptionExpanded(false);
        setCategoryActiveTab('live');
        setCategoryClips([]);
        setCategoryClipsCursor(null);
        setHasMoreCategoryClips(true);
        setCategoryVideos([]);
        setCategoryVideosCursor(null);
        setHasMoreCategoryVideos(true);

        invoke('get_streams_by_game', { gameId: category.id, cursor: null, limit: 40 })
            .then(res => {
                const [streams, cursor] = res as [TwitchStream[], string | null];
                setCategoryStreams(streams);
                setCategoryStreamsCursor(cursor);
                setHasMoreCategoryStreams(!!cursor && streams.length > 0);
            })
            .catch(e => {
                Logger.error('Failed to load category streams:', e);
                setCategoryStreams([]);
                setCategoryStreamsCursor(null);
                setHasMoreCategoryStreams(false);
            })
            .finally(() => setIsLoadingCategoryStreams(false));

        invoke('get_category_info', { gameName: category.name })
            .then(details => setCategoryDetails(details as CategoryInfo | null))
            .catch(e => Logger.error('Failed to load category details:', e))
            .finally(() => setIsLoadingCategoryDetails(false));
    };

    // Load streams by game name when navigating from badge overlay (category has no ID)
    const loadCategoryStreamsByName = async (gameName: string) => {
        setIsLoadingCategoryStreams(true);
        setCategoryStreams([]);
        setIsLoadingCategoryDetails(true);
        setCategoryDetails(null);
        setIsDescriptionExpanded(false);
        setCategoryActiveTab('live');
        setCategoryClips([]);
        setCategoryClipsCursor(null);
        setHasMoreCategoryClips(true);
        setCategoryVideos([]);
        setCategoryVideosCursor(null);
        setHasMoreCategoryVideos(true);

        invoke('get_streams_by_game_name', { gameName: gameName, excludeUserLogin: null, cursor: null, limit: 40 })
            .then(res => {
                const [streams, cursor] = res as [TwitchStream[], string | null];
                setCategoryStreams(streams);
                setCategoryStreamsCursor(cursor);
                setHasMoreCategoryStreams(!!cursor && streams.length > 0);
            })
            .catch(e => {
                Logger.error('Failed to load category streams by name:', e);
                setCategoryStreams([]);
                setCategoryStreamsCursor(null);
                setHasMoreCategoryStreams(false);
            })
            .finally(() => setIsLoadingCategoryStreams(false));

        invoke('get_category_info', { gameName: gameName })
            .then(details => setCategoryDetails(details as CategoryInfo | null))
            .catch(e => Logger.error('Failed to load category details:', e))
            .finally(() => setIsLoadingCategoryDetails(false));
    };

    // Effect to handle category view re-mount or navigation from badge overlay
    useEffect(() => {
        if (activeTab === 'category' && selectedCategory) {
            if (selectedCategory.id) {
                // Normal category — re-fetch if streams are empty (e.g., after remount from watching a stream)
                if (categoryStreams.length === 0 && !isLoadingCategoryStreams) {
                    // Don't call handleCategoryClick here — it resets categoryActiveTab to 'live'.
                    // When navigating back from a clip/VOD, we need to preserve the sub-tab.
                    // Just reload the stream data without touching tab state.
                    setIsLoadingCategoryStreams(true);
                    invoke('get_streams_by_game', { gameId: selectedCategory.id, cursor: null, limit: 40 })
                        .then(res => {
                            const [streams, cursor] = res as [TwitchStream[], string | null];
                            setCategoryStreams(streams);
                            setCategoryStreamsCursor(cursor);
                            setHasMoreCategoryStreams(!!cursor && streams.length > 0);
                        })
                        .catch(e => {
                            Logger.error('Failed to load category streams:', e);
                            setCategoryStreams([]);
                            setCategoryStreamsCursor(null);
                            setHasMoreCategoryStreams(false);
                        })
                        .finally(() => setIsLoadingCategoryStreams(false));
                }
            } else if (selectedCategory.name) {
                // Badge overlay navigation — category has no ID, load by name
                loadCategoryStreamsByName(selectedCategory.name);
            }
        }
    // categoryStreams.length intentionally excluded to avoid re-fetch loops after legitimate empty results
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab, selectedCategory]);

    // Effect to auto-load categories when browse tab is active but topGames were lost (e.g., remount)
    useEffect(() => {
        const isCacheStale = Date.now() - cachedTopGamesTimestamp > CATEGORY_CACHE_TTL;
        if (activeTab === 'browse' && topGames.length === 0 && !isLoadingGames) {
            loadTopGames(false);
        } else if (activeTab === 'browse' && isCacheStale && !isLoadingGames) {
            loadTopGames(true);
        }
        if (activeTab === 'browse' && dropsGameIds.size === 0) {
            loadActiveDrops();
        }
    // topGames.length intentionally excluded to avoid re-fetch loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab]);

    const handleBackToBrowse = () => {
        setActiveTab('browse');
        setSelectedCategory(null);
        setCategoryStreams([]);
        setCategoryStreamsCursor(null);
        setHasMoreCategoryStreams(true);
        
        const isCacheStale = Date.now() - cachedTopGamesTimestamp > CATEGORY_CACHE_TTL;
        
        // Re-fetch categories if lost on remount
        if (topGames.length === 0) {
            loadTopGames(false);
        } else if (isCacheStale) {
            loadTopGames(true);
        }
        
        if (dropsGameIds.size === 0) {
            loadActiveDrops();
        }
    };

    const loadMoreCategoryStreams = useCallback(async () => {
        if (!selectedCategory || !hasMoreCategoryStreams || isLoadingMoreCategoryStreams) return;
        setIsLoadingMoreCategoryStreams(true);
        try {
            if (selectedCategory.id) {
                const res = await invoke('get_streams_by_game', { 
                    gameId: selectedCategory.id, 
                    cursor: categoryStreamsCursor, 
                    limit: 40 
                }) as [TwitchStream[], string | null];
                const [newStreams, newCursor] = res;
                if (newStreams.length > 0) {
                    setCategoryStreams(prev => [...prev, ...newStreams]);
                    setCategoryStreamsCursor(newCursor);
                    setHasMoreCategoryStreams(!!newCursor);
                } else {
                    setHasMoreCategoryStreams(false);
                }
            } else if (selectedCategory.name) {
                const res = await invoke('get_streams_by_game_name', { 
                    gameName: selectedCategory.name, 
                    excludeUserLogin: null, 
                    cursor: categoryStreamsCursor, 
                    limit: 40 
                }) as [TwitchStream[], string | null];
                const [newStreams, newCursor] = res;
                if (newStreams.length > 0) {
                    setCategoryStreams(prev => [...prev, ...newStreams]);
                    setCategoryStreamsCursor(newCursor);
                    setHasMoreCategoryStreams(!!newCursor);
                } else {
                    setHasMoreCategoryStreams(false);
                }
            }
        } catch (e) {
            Logger.error('Failed to load more category streams:', e);
            setHasMoreCategoryStreams(false);
        } finally {
            setIsLoadingMoreCategoryStreams(false);
        }
    }, [selectedCategory, hasMoreCategoryStreams, isLoadingMoreCategoryStreams, categoryStreamsCursor]);

    const loadCategoryClips = async () => {
        if (!selectedCategory?.id) return;
        setIsLoadingClips(true);
        setCategoryClips([]);
        setCategoryClipsCursor(null);
        setHasMoreCategoryClips(true);
        try {
            const res = await invoke('get_clips_by_game', { gameId: selectedCategory.id, limit: 40, cursor: null, period: clipsPeriod }) as [TwitchClip[], string | null];
            setCategoryClips(res[0]);
            setCategoryClipsCursor(res[1]);
            // Clips often don't have cursors if they reach the end in the first page, Twitch pagination is finicky
            setHasMoreCategoryClips(!!res[1] && res[0].length >= 40);
        } catch (e) {
            Logger.error('Failed to load category clips:', e);
            setHasMoreCategoryClips(false);
        } finally {
            setIsLoadingClips(false);
        }
    };

    const loadMoreCategoryClips = useCallback(async () => {
        if (!selectedCategory?.id || !hasMoreCategoryClips || isLoadingMoreClips) return;
        setIsLoadingMoreClips(true);
        try {
            const res = await invoke('get_clips_by_game', { gameId: selectedCategory.id, limit: 40, cursor: categoryClipsCursor, period: clipsPeriod }) as [TwitchClip[], string | null];
            if (res[0].length > 0) {
                setCategoryClips(prev => [...prev, ...res[0]]);
                setCategoryClipsCursor(res[1]);
                setHasMoreCategoryClips(!!res[1] && res[0].length >= 40);
            } else {
                setHasMoreCategoryClips(false);
            }
        } catch (e) {
            Logger.error('Failed to load more category clips:', e);
            setHasMoreCategoryClips(false);
        } finally {
            setIsLoadingMoreClips(false);
        }
    }, [selectedCategory, hasMoreCategoryClips, isLoadingMoreClips, categoryClipsCursor, clipsPeriod]);

    const loadCategoryVideos = async () => {
        if (!selectedCategory?.id) return;
        setIsLoadingVideos(true);
        setCategoryVideos([]);
        setCategoryVideosCursor(null);
        setHasMoreCategoryVideos(true);
        try {
            const res = await invoke('get_videos_by_game', { gameId: selectedCategory.id, sort: videosSort, period: videosPeriod, limit: 40, cursor: null }) as [TwitchVideo[], string | null];
            setCategoryVideos(res[0]);
            setCategoryVideosCursor(res[1]);
            setHasMoreCategoryVideos(!!res[1] && res[0].length >= 40);
        } catch (e) {
            Logger.error('Failed to load category videos:', e);
            setHasMoreCategoryVideos(false);
        } finally {
            setIsLoadingVideos(false);
        }
    };

    const loadMoreCategoryVideos = useCallback(async () => {
        if (!selectedCategory?.id || !hasMoreCategoryVideos || isLoadingMoreVideos) return;
        setIsLoadingMoreVideos(true);
        try {
            const res = await invoke('get_videos_by_game', { gameId: selectedCategory.id, sort: videosSort, period: videosPeriod, limit: 40, cursor: categoryVideosCursor }) as [TwitchVideo[], string | null];
            if (res[0].length > 0) {
                setCategoryVideos(prev => [...prev, ...res[0]]);
                setCategoryVideosCursor(res[1]);
                setHasMoreCategoryVideos(!!res[1] && res[0].length >= 40);
            } else {
                setHasMoreCategoryVideos(false);
            }
        } catch (e) {
            Logger.error('Failed to load more category videos:', e);
            setHasMoreCategoryVideos(false);
        } finally {
            setIsLoadingMoreVideos(false);
        }
    }, [selectedCategory, hasMoreCategoryVideos, isLoadingMoreVideos, categoryVideosCursor, videosSort, videosPeriod]);

    // Effect to trigger fetching clips/videos on tab change
    useEffect(() => {
        if (activeTab === 'category' && selectedCategory?.id) {
            if (categoryActiveTab === 'clips' && categoryClips.length === 0 && !isLoadingClips) {
                loadCategoryClips();
            } else if (categoryActiveTab === 'videos' && categoryVideos.length === 0 && !isLoadingVideos) {
                loadCategoryVideos();
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab, categoryActiveTab, selectedCategory]);

    // Refresh clips when period changes
    useEffect(() => {
        if (activeTab === 'category' && categoryActiveTab === 'clips' && selectedCategory?.id) {
            loadCategoryClips();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clipsPeriod]);

    // Refresh videos when sort or period changes
    useEffect(() => {
        if (activeTab === 'category' && categoryActiveTab === 'videos' && selectedCategory?.id) {
            loadCategoryVideos();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videosSort, videosPeriod]);

    const handleSearch = async () => {
        if (!searchQuery.trim()) return;

        setIsSearching(true);
        try {
            if (activeTab === 'browse' || (activeTab === 'search' && searchMode === 'categories')) {
                setSearchMode('categories');
                setActiveTab('search');
                const results = await invoke('search_categories', { query: searchQuery, limit: 40 }) as TwitchCategory[];
                setCategorySearchResults(results);
                setSearchResults([]);
            } else if ((activeTab === 'category' && selectedCategory) || (activeTab === 'search' && searchMode === 'streamers' && selectedCategory)) {
                setSearchMode('streamers');
                setActiveTab('search');
                const results = await invoke('search_channels', { query: searchQuery }) as TwitchStream[];
                
                const filtered = results.filter(s => 
                    (selectedCategory.id && s.game_id === selectedCategory.id) || 
                    (selectedCategory.name && s.game_name?.toLowerCase() === selectedCategory.name.toLowerCase())
                );
                
                setSearchResults(filtered);
                setCategorySearchResults([]);
            } else {
                setSearchMode('streamers');
                setActiveTab('search');
                const results = await invoke('search_channels', { query: searchQuery }) as TwitchStream[];
                setSearchResults(results);
                setCategorySearchResults([]);
            }
        } catch (e) {
            Logger.error('Search failed:', e);
            setSearchResults([]);
            setCategorySearchResults([]);
        } finally {
            setIsSearching(false);
        }
    };

    const handleSearchKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSearch();
        } else if (e.key === 'Escape') {
            setIsSearchExpanded(false);
            setSearchQuery('');
            setSearchResults([]);
            setCategorySearchResults([]);
            if (activeTab === 'search') {
                setActiveTab(isAuthenticated ? 'following' : 'recommended');
            }
        }
    };

    const getThumbnailUrl = (url: string) => {
        return url
            .replace('%{width}', '1280').replace('%{height}', '720')
            .replace('{width}', '1280').replace('{height}', '720');
    };

    const getGameBoxArt = (url: string) => {
        if (!url) return '';
        if (url.includes('{width}') && url.includes('{height}')) {
            return url.replace('{width}', '1200').replace('{height}', '1600');
        }
        return url.replace(/-\d+x\d+\.(jpg|jpeg|png)$/i, '-1200x1600.$1');
    };

    const handleStreamClick = (stream: TwitchStream) => {
        // Track which category this stream was started from (if any)
        useAppStore.getState().setStreamOriginCategory(
            activeTab === 'category' && selectedCategory ? selectedCategory : null
        );
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

    const sortStreamsByFavorites = (streams: TwitchStream[]) => {
        return [...streams].sort((a, b) => {
            const aIsFavorite = isFavoriteStreamer(a.user_id);
            const bIsFavorite = isFavoriteStreamer(b.user_id);

            if (aIsFavorite && !bIsFavorite) return -1;
            if (!aIsFavorite && bIsFavorite) return 1;
            return 0;
        });
    };

    const handleScroll = useCallback(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        const { scrollTop, scrollHeight, clientHeight } = container;
        const scrollPercentage = (scrollTop + clientHeight) / scrollHeight;

        // Handle recommended streams infinite scroll
        if (activeTab === 'recommended' && hasMoreRecommended && !isLoadingMore && !loadingRef.current) {
            if (scrollPercentage > 0.8) {
                loadingRef.current = true;
                loadMoreRecommendedStreams().finally(() => {
                    loadingRef.current = false;
                });
            }
        }

        // Handle categories (browse) infinite scroll
        if (activeTab === 'browse' && hasMoreGames && !isLoadingMoreGames && !loadingRef.current) {
            if (scrollPercentage > 0.8) {
                loadingRef.current = true;
                loadMoreTopGames().finally(() => {
                    loadingRef.current = false;
                });
            }
        }

        // Handle category content infinite scroll
        if (activeTab === 'category') {
            if (categoryActiveTab === 'live' && hasMoreCategoryStreams && !isLoadingMoreCategoryStreams && !loadingRef.current) {
                if (scrollPercentage > 0.8) {
                    loadingRef.current = true;
                    loadMoreCategoryStreams().finally(() => {
                        loadingRef.current = false;
                    });
                }
            } else if (categoryActiveTab === 'clips' && hasMoreCategoryClips && !isLoadingMoreClips && !loadingRef.current) {
                if (scrollPercentage > 0.8) {
                    loadingRef.current = true;
                    loadMoreCategoryClips().finally(() => {
                        loadingRef.current = false;
                    });
                }
            } else if (categoryActiveTab === 'videos' && hasMoreCategoryVideos && !isLoadingMoreVideos && !loadingRef.current) {
                if (scrollPercentage > 0.8) {
                    loadingRef.current = true;
                    loadMoreCategoryVideos().finally(() => {
                        loadingRef.current = false;
                    });
                }
            }
        }
    }, [
        activeTab, hasMoreRecommended, isLoadingMore, loadMoreRecommendedStreams, 
        hasMoreGames, isLoadingMoreGames, loadMoreTopGames, 
        categoryActiveTab,
        hasMoreCategoryStreams, isLoadingMoreCategoryStreams, loadMoreCategoryStreams,
        hasMoreCategoryClips, isLoadingMoreClips, loadMoreCategoryClips,
        hasMoreCategoryVideos, isLoadingMoreVideos, loadMoreCategoryVideos
    ]);

    useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        container.addEventListener('scroll', handleScroll);
        return () => container.removeEventListener('scroll', handleScroll);
    }, [handleScroll]);

    const displayStreams = activeTab === 'following'
        ? sortStreamsByFavorites(followedStreams)
        : activeTab === 'recommended'
            ? recommendedStreams
            : activeTab === 'category'
                ? categoryStreams
                : searchResults.filter(s => s.viewer_count > 0 || s.is_live);

    const offlineSearchResults = activeTab === 'search' ? searchResults.filter(s => s.viewer_count === 0 && !s.is_live) : [];

    const renderCategoryCard = (game: TwitchCategory) => {
        const dropsCampaign = dropsGameIds.get(game.id);
        const hasDrops = !!dropsCampaign;

        return (
            <div
                key={game.id}
                className={`glass-panel cursor-pointer hover:bg-glass-hover transition-all duration-200 group overflow-hidden relative ${isOverlayMode ? '!bg-black/40 !border-white/5' : ''} ${hasDrops ? 'ring-2 ring-accent shadow-accent/40' : ''}`}
                style={hasDrops ? { boxShadow: '0 0 15px var(--color-accent-muted)' } : undefined}
                onClick={() => handleCategoryClick(game)}
            >
                <div className="relative overflow-hidden">
                    <img
                        loading="lazy"
                        src={getGameBoxArt(game.box_art_url)}
                        alt={game.name}
                        className="w-full aspect-[3/4] object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                    {hasDrops && (
                        <div className="absolute inset-0 bg-gradient-to-t from-accent/40 via-transparent to-accent/20 pointer-events-none" />
                    )}
                    {hasDrops && (
                        <div className="absolute top-2 left-2 z-10">
                            <div className="drops-badge-glass-lg">
                                <Gift size={14} className="drop-shadow-lg" />
                                <span>DROPS</span>
                            </div>
                        </div>
                    )}
                    {hasDrops && (
                        <Tooltip content={activeMiningIds.has(dropsCampaign.id) ? `Click to stop mining ${dropsCampaign.name}` : `Start mining ${dropsCampaign.name}`} side="top">
                        <button
                            onClick={(e) => handleToggleMining(e, dropsCampaign)}
                            className={`absolute bottom-2 right-2 left-2 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-semibold transition-all duration-300 glass-button ${activeMiningIds.has(dropsCampaign.id)
                                ? '!bg-green-500/20 text-green-400 border-green-500/30 !shadow-[0_2px_10px_rgba(34,197,94,0.3),inset_0_1px_rgba(255,255,255,0.2)] ring-1 ring-green-500/20 hover:!bg-red-500/30 hover:text-red-400 hover:border-red-500/30 hover:ring-red-500/30 hover:!shadow-[0_2px_10px_rgba(239,68,68,0.3),inset_0_1px_rgba(255,255,255,0.2)]'
                                : '!bg-accent/30 text-white border-accent/40 !shadow-[0_2px_10px_rgba(var(--color-accent-rgb),0.4),inset_0_1px_rgba(255,255,255,0.2)] ring-1 ring-accent/20 hover:!bg-accent/50 hover:scale-[1.02]'
                                }`}
                        >
                            {activeMiningIds.has(dropsCampaign.id) ? (
                                <>
                                    <Pickaxe size={14} className="animate-pulse" />
                                    <span>Mining</span>
                                </>
                            ) : (
                                <>
                                    <Pickaxe size={14} />
                                    <span>Mine Drops</span>
                                </>
                            )}
                        </button>
                        </Tooltip>
                    )}
                </div>
                <div className="p-2">
                    <Tooltip content={game.name} side="bottom"><h3 className="text-textPrimary font-medium text-sm line-clamp-2 group-hover:text-accent transition-colors">
                        {game.name}
                    </h3></Tooltip>
                    {game.viewer_count !== undefined && (
                        <p className="text-textSecondary text-xs mt-0.5">
                            {game.viewer_count.toLocaleString()} viewers
                        </p>
                    )}
                </div>
            </div>
        );
    };

    const hasCategoryDrops = activeTab === 'category' && selectedCategory && (!!(
        (selectedCategory.id && dropsGameIds.has(selectedCategory.id)) ||
        (selectedCategory.name && dropsGameNames.has(selectedCategory.name.toLowerCase()))
    ));

    const renderClipCard = (clip: TwitchClip) => {
        return (
            <div
                key={clip.id}
                className={`glass-panel cursor-pointer hover:bg-glass-hover transition-all duration-200 group overflow-hidden relative ${isOverlayMode ? '!bg-black/40 !border-white/5' : ''}`}
                onClick={() => {
                    setHomeCategoryTab('clips');
                    playMedia('clip', clip.url, clip);
                }}
            >
                <div className="relative overflow-hidden rounded">
                    <img
                        loading="lazy"
                        src={clip.thumbnail_url || 'https://vod-secure.twitch.tv/_404/404_processing_320x180.png'}
                        alt={clip.title}
                        onError={(e) => { e.currentTarget.src = 'https://vod-secure.twitch.tv/_404/404_processing_320x180.png'; }}
                        className="w-full aspect-video object-cover group-hover:scale-105 transition-transform duration-200 bg-black/20"
                    />
                    <div className="absolute bottom-1.5 left-1.5 px-2 py-0.5 glass-badge text-white text-[10px] font-medium rounded">
                        {clip.duration.toFixed(1)}s
                    </div>
                    <div className="absolute top-1.5 left-1.5 px-2 py-0.5 glass-badge text-white text-[10px] font-medium rounded flex items-center gap-1">
                        <Users size={10} />
                        {clip.view_count.toLocaleString()}
                    </div>
                </div>
                <div className="px-1 py-2 space-y-0.5">
                    <h3 className="text-textPrimary font-medium text-[13px] leading-tight line-clamp-2 group-hover:text-accent transition-colors">
                        {clip.title}
                    </h3>
                    <div className="flex items-center justify-between text-[11px] text-textSecondary mt-1 pt-1 border-t border-white/5">
                        <span className="truncate max-w-[50%]">{clip.broadcaster_name}</span>
                        <span className="shrink-0">{new Date(clip.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    </div>
                    <p className="text-[10px] text-textSecondary/60 truncate italic">Clipped by {clip.creator_name}</p>
                </div>
            </div>
        );
    };

    const renderVideoCard = (video: TwitchVideo) => {
        return (
            <div
                key={video.id}
                className={`glass-panel cursor-pointer hover:bg-glass-hover transition-all duration-200 group overflow-hidden relative ${isOverlayMode ? '!bg-black/40 !border-white/5' : ''}`}
                onClick={() => {
                    setHomeCategoryTab('videos');
                    playMedia('video', video.url, video);
                }}
            >
                <div className="relative overflow-hidden rounded">
                    <img
                        loading="lazy"
                        src={video.thumbnail_url ? video.thumbnail_url.replace('%{width}', '440').replace('%{height}', '248') : 'https://vod-secure.twitch.tv/_404/404_processing_320x180.png'}
                        alt={video.title}
                        onError={(e) => { e.currentTarget.src = 'https://vod-secure.twitch.tv/_404/404_processing_320x180.png'; }}
                        className="w-full aspect-video object-cover group-hover:scale-105 transition-transform duration-200 bg-black/20"
                    />
                    <div className="absolute bottom-1.5 left-1.5 px-2 py-0.5 glass-badge text-white text-[10px] font-medium rounded">
                        {video.duration}
                    </div>
                    <div className="absolute top-1.5 left-1.5 px-2 py-0.5 glass-badge text-white text-[10px] font-medium rounded flex items-center gap-1">
                        <Users size={10} />
                        {video.view_count.toLocaleString()}
                    </div>
                </div>
                <div className="px-1 py-2 space-y-0.5">
                    <h3 className="text-textPrimary font-medium text-[13px] leading-tight line-clamp-2 group-hover:text-accent transition-colors">
                        {video.title}
                    </h3>
                    <div className="flex items-center justify-between text-[11px] text-textSecondary mt-1 pt-1 border-t border-white/5">
                        <span className="truncate max-w-[50%]">{video.user_name}</span>
                        <span className="shrink-0">{new Date(video.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className="flex flex-col h-full">
            {/* Global SVG Definitions for Liquid Glass Heart */}
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

            {/* Top Navigation Frame - Always Center Navigation */}
            {!(activeTab === 'category' && selectedCategory) && (
                <div className="flex flex-col relative box-border overflow-hidden z-20">
                    <div className="flex gap-3 relative z-30 px-4 py-2.5 min-h-[48px] items-center justify-center border-b border-borderSubtle bg-background/95 backdrop-blur-md">
                    <div className="relative flex items-center glass-panel px-1.5 py-1 !rounded-xl">
                        {/* Navigation buttons - fade out when search is expanded */}
                        <LayoutGroup>
                        <div className={`flex items-center gap-1 transition-opacity duration-300 ${isSearchExpanded ? 'opacity-0' : 'opacity-100'}`}>
                            <MultiNookToggle />
                            <div className="border-l border-borderSubtle h-5 mx-0.5" />
                            {isAuthenticated && (
                                <button
                                    onClick={() => { setActiveTab('following'); setIsSearchExpanded(false); }}
                                    className={`group relative px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-300 whitespace-nowrap ${activeTab === 'following'
                                        ? 'text-white'
                                        : 'text-textSecondary hover:text-textPrimary'
                                        }`}
                                >
                                    {activeTab === 'following' && (
                                        <motion.div
                                            layoutId="homeTabHighlight"
                                            className="absolute inset-0 glass-button-static rounded-lg"
                                            transition={{ type: "spring", stiffness: 350, damping: 30 }}
                                        />
                                    )}
                                    <span className={`relative z-10 flex items-center transition-all duration-300 ${activeTab !== 'following' ? 'group-hover:drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]' : ''}`}>
                                        Following
                                        {followedStreams.length > 0 && (
                                            <span className="ml-1.5 text-xs opacity-80">
                                                {followedStreams.length}
                                            </span>
                                        )}
                                    </span>
                                </button>
                            )}
                            <button
                                onClick={() => { setActiveTab('recommended'); setIsSearchExpanded(false); }}
                                className={`group relative px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-300 whitespace-nowrap ${activeTab === 'recommended'
                                    ? 'text-white'
                                    : 'text-textSecondary hover:text-textPrimary'
                                    }`}
                            >
                                {activeTab === 'recommended' && (
                                    <motion.div
                                        layoutId="homeTabHighlight"
                                        className="absolute inset-0 glass-button-static rounded-lg"
                                        transition={{ type: "spring", stiffness: 350, damping: 30 }}
                                    />
                                )}
                                <span className={`relative z-10 inline-block transition-all duration-300 ${activeTab !== 'recommended' ? 'group-hover:drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]' : ''}`}>Discover</span>
                            </button>
                            <button
                                onClick={handleBrowseClick}
                                className={`group relative px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-300 whitespace-nowrap ${activeTab === 'browse'
                                    ? 'text-white'
                                    : 'text-textSecondary hover:text-textPrimary'
                                    }`}
                            >
                                {activeTab === 'browse' && (
                                    <motion.div
                                        layoutId="homeTabHighlight"
                                        className="absolute inset-0 glass-button-static rounded-lg"
                                        transition={{ type: "spring", stiffness: 350, damping: 30 }}
                                    />
                                )}
                                <span className={`relative z-10 inline-block transition-all duration-300 ${activeTab !== 'browse' ? 'group-hover:drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]' : ''}`}>Categories</span>
                            </button>
                            {(searchResults.length > 0 || categorySearchResults.length > 0) && (
                                <button
                                    onClick={() => setActiveTab('search')}
                                    className={`group relative px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-300 whitespace-nowrap ${activeTab === 'search'
                                        ? 'text-white'
                                        : 'text-textSecondary hover:text-textPrimary'
                                        }`}
                                >
                                    {activeTab === 'search' && (
                                        <motion.div
                                            layoutId="homeTabHighlight"
                                            className="absolute inset-0 glass-button-static rounded-lg"
                                            transition={{ type: "spring", stiffness: 350, damping: 30 }}
                                        />
                                    )}
                                    <span className={`relative z-10 flex items-center transition-all duration-300 ${activeTab !== 'search' ? 'group-hover:drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]' : ''}`}>
                                        Results
                                        <span className="ml-1 text-xs opacity-80">{searchMode === 'categories' ? categorySearchResults.length : searchResults.length}</span>
                                    </span>
                                </button>
                            )}
                            <div className="border-l border-borderSubtle h-6 ml-1" />
                            {/* Search button - opens search */}
                            <Tooltip content="Search channels" side="top">
                            <button
                                onClick={() => setIsSearchExpanded(true)}
                                className="p-1.5 text-textSecondary hover:text-textPrimary rounded-lg transition-all ml-0.5"
                            >
                                <Search size={16} />
                            </button>
                            </Tooltip>
                        </div>
                        </LayoutGroup>

                        {/* Search overlay - expands from right to cover buttons */}
                        <motion.div
                            initial={false}
                            animate={{ 
                                clipPath: isSearchExpanded 
                                    ? 'inset(0% 0% 0% 0% round 12px)' 
                                    : 'inset(0% 0% 0% 100% round 12px)',
                                opacity: isSearchExpanded ? 1 : 0
                            }}
                            transition={{ type: "spring", stiffness: 350, damping: 30 }}
                            className="absolute -inset-[1px] flex items-center glass-input !rounded-xl z-20"
                            style={{ pointerEvents: isSearchExpanded ? 'auto' : 'none' }}
                        >
                            <input
                                ref={searchInputRef}
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onKeyDown={handleSearchKeyPress}
                                onBlur={() => {
                                    if (!searchQuery.trim()) {
                                        setIsSearchExpanded(false);
                                    }
                                }}
                                className="flex-1 bg-transparent text-center text-white text-sm px-10 py-1.5 focus:outline-none h-full w-full"
                            />

                            {/* Close button - ONLY visible when text exists */}
                            <AnimatePresence>
                            {searchQuery.trim() && (
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.8 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.8 }}
                                    transition={{ duration: 0.15 }}
                                    className="absolute right-1.5"
                                >
                                    <Tooltip content="Close Search" side="top">
                                    <button
                                        onClick={() => {
                                            setIsSearchExpanded(false);
                                            setSearchQuery('');
                                            setSearchResults([]);
                                            setCategorySearchResults([]);
                                            if (activeTab === 'search') {
                                                setActiveTab(isAuthenticated ? 'following' : 'recommended');
                                            }
                                        }}
                                        disabled={isSearching}
                                        className={`p-1.5 rounded-full transition-all text-white/60 hover:text-white hover:bg-white/10 ${isSearching ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                                    >
                                        <X size={16} />
                                    </button>
                                    </Tooltip>
                                </motion.div>
                            )}
                            </AnimatePresence>
                        </motion.div>
                    </div>
                {/* Return to Stream Button - absolute right */}
                {streamUrl && (
                    <Tooltip content="Return to Stream" side="bottom">
                    <button
                        onClick={toggleHome}
                        className="absolute right-4 flex items-center gap-1.5 px-3 py-1.5 glass-button text-accent shadow-[0_0_15px_rgba(var(--color-accent-rgb),0.2)] text-sm font-medium rounded-lg transition-all hover:text-white"
                    >
                        <Maximize2 size={14} />
                        <span className="hidden sm:inline">Return</span>
                    </button>
                    </Tooltip>
                )}
            </div>

        </div>
        )}

            {/* Content */}
            <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4 scrollbar-thin relative">
                
                {/* FLOATING GLASS PILL HEADER (Only in Category View) */}
                {activeTab === 'category' && selectedCategory && (
                    <div className="sticky top-4 mt-2 z-30 h-0 overflow-visible flex items-center justify-between w-full pointer-events-none">
                        <div className="flex items-center gap-3 text-textPrimary">
                            {/* Back Button */}
                            <Tooltip content="Back to Browse" side="right">
                                <button
                                    onClick={handleBackToBrowse}
                                    className="h-[44px] w-[44px] glass-panel hover:bg-glass-hover rounded-xl flex items-center justify-center shadow-lg pointer-events-auto bg-background/80 backdrop-blur-md transition-colors"
                                >
                                    <ArrowLeft size={20} className="text-textSecondary hover:text-textPrimary transition-colors" />
                                </button>
                            </Tooltip>

                            {/* Tiny Category Pill - Dropping in playfully */}
                            <motion.div
                                style={{ opacity: compactTitleOpacity, y: compactTitleY }}
                                className="h-[44px] glass-panel rounded-xl px-4 flex items-center shadow-lg pointer-events-auto bg-background/80 backdrop-blur-md border border-white/5"
                            >
                                <span className="font-bold text-sm truncate max-w-[200px] sm:max-w-[400px]">
                                    {selectedCategory.name}
                                </span>
                            </motion.div>
                        </div>
                        
                        {/* Return to Stream Button (In Category Mode) */}
                        {streamUrl && (
                            <Tooltip content="Return to Stream" side="left">
                                <button
                                    onClick={toggleHome}
                                    className="flex items-center gap-1.5 px-3 h-[44px] glass-button text-accent shadow-[0_0_15px_rgba(var(--color-accent-rgb),0.2)] text-sm font-medium rounded-xl transition-all hover:text-white pointer-events-auto backdrop-blur-md"
                                >
                                    <Maximize2 size={14} />
                                    <span className="hidden sm:inline">Return</span>
                                </button>
                            </Tooltip>
                        )}
                    </div>
                )}
                
                {/* NATURAL SCROLLING HERO BANNER */}
                {activeTab === 'category' && selectedCategory && (
                    <motion.div 
                        style={{ opacity: heroOpacity }}
                        className="flex gap-4 sm:gap-6 w-full max-w-[900px] items-start pb-6 mt-2 ml-[56px] relative z-10"
                    >
                        {/* Hero Box Art */}
                        <div className="flex-shrink-0">
                            <div className={`w-[108px] h-[144px] sm:w-[144px] sm:h-[192px] bg-white/5 rounded-xl overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.6)] border border-white/10 flex items-center justify-center ${isLoadingCategoryDetails && !categoryDetails?.boxArtUrl && !selectedCategory?.box_art_url ? 'animate-pulse' : ''}`}>
                                {(categoryDetails?.boxArtUrl || selectedCategory?.box_art_url) ? (
                                    <img 
                                        src={getGameBoxArt(categoryDetails?.boxArtUrl || selectedCategory.box_art_url)} 
                                        alt={selectedCategory.name}
                                        className={`w-full h-full object-cover transition-opacity duration-300 ${isLoadingCategoryDetails && !categoryDetails?.boxArtUrl ? 'opacity-50' : 'opacity-100'}`}
                                        loading="lazy"
                                    />
                                ) : (
                                    <LayoutGrid size={32} className="text-white/20" />
                                )}
                            </div>
                        </div>
                        
                        {/* Category Metadata Column */}
                        <div className="flex flex-col flex-1 min-w-0 pr-16 mt-1 sm:mt-2 max-w-[600px]">
                            {/* Title & Followers */}
                            <div className="flex items-center gap-3 mb-2 flex-wrap">
                                <h1 className="text-2xl sm:text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-textPrimary to-textSecondary truncate leading-tight">
                                    {categoryDetails?.displayName || selectedCategory.name}
                                </h1>
                               {categoryDetails?.followersCount != null && (
                                    <div className="glass-badge flex items-center gap-1.5 whitespace-nowrap !bg-white/5 backdrop-blur-md px-2.5 py-1 shrink-0">
                                        <Users size={12} className="text-accent" />
                                        <span className="text-[11px] font-bold text-textPrimary tracking-wide">
                                            {new Intl.NumberFormat('en-US', { notation: "compact", compactDisplay: "short" }).format(categoryDetails.followersCount)} Followers
                                        </span>
                                    </div>
                                )}
                            </div>
                            
                            {/* Tags */}
                            <div className="flex flex-wrap gap-1.5 mb-3">
                                {hasCategoryDrops && (
                                    <button 
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (selectedCategory?.name) {
                                                openDropsWithSearch(selectedCategory.name);
                                            }
                                        }}
                                        className="drops-badge-glass hover:brightness-125 hover:scale-105 active:scale-95 transition-all cursor-pointer !text-[10px] !px-2 !py-0.5 mr-1"
                                    >
                                        <Gift size={11} />
                                        <span>DROPS ENABLED</span>
                                    </button>
                                )}
                                {isLoadingCategoryDetails ? (
                                    <>
                                        <div className="h-5 w-16 bg-white/5 rounded-full animate-pulse px-2"></div>
                                        <div className="h-5 w-20 bg-white/5 rounded-full animate-pulse px-2"></div>
                                        <div className="h-5 w-14 bg-white/5 rounded-full animate-pulse px-2"></div>
                                    </>
                                ) : categoryDetails?.tags && categoryDetails.tags.length > 0 ? (
                                    categoryDetails.tags.slice(0, 5).map(tag => (
                                        <span key={tag.id} className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-textSecondary truncate max-w-[150px] shadow-sm tracking-wide">
                                            {tag.localizedName}
                                        </span>
                                    ))
                                ) : null}
                            </div>
                            
                            {/* Description Accordion */}
                            <div className="relative group">
                                {isLoadingCategoryDetails ? (
                                     <div className="space-y-2 mt-1 w-full max-w-[400px]">
                                         <div className="h-3 bg-white/10 rounded w-full animate-pulse"></div>
                                         <div className="h-3 bg-white/10 rounded w-5/6 animate-pulse"></div>
                                     </div>
                                ) : categoryDetails?.description ? (
                                    <div className="relative">
                                        <motion.div 
                                            initial={false}
                                            animate={{ height: isDescriptionExpanded ? "auto" : 48 }}
                                            transition={{ duration: 0.25, ease: "easeOut" }}
                                            onAnimationComplete={() => {
                                                if (!isDescriptionExpanded) {
                                                    setIsDescriptionClamped(true);
                                                }
                                            }}
                                            className="overflow-hidden"
                                        >
                                            <p className={`text-[13px] sm:text-[14px] text-textSecondary/90 font-medium leading-[24px] ${isDescriptionClamped ? 'line-clamp-2' : ''}`}>
                                                {categoryDetails.description}
                                            </p>
                                        </motion.div>
                                        {!isDescriptionExpanded && categoryDetails.description.length > 100 && (
                                            <div className="mt-1 flex items-center justify-start pointer-events-none">
                                                <button 
                                                    onClick={(e) => { 
                                                        e.stopPropagation(); 
                                                        setIsDescriptionClamped(false);
                                                        setIsDescriptionExpanded(true); 
                                                    }}
                                                    className="text-[12px] font-bold text-accent hover:text-white pointer-events-auto transition-colors"
                                                >
                                                    Read More
                                                </button>
                                            </div>
                                        )}
                                        {isDescriptionExpanded && (
                                            <div className="mt-1">
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); setIsDescriptionExpanded(false); }}
                                                    className="text-[11px] font-bold text-textSecondary hover:text-textPrimary transition-colors"
                                                >
                                                    Show Less
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <p className="text-[13px] text-textSecondary/40 italic">No description available</p>
                                )}
                            </div>
                        </div>
                    </motion.div>
                )}

                {/* Only show full LoadingWidget during initial app load, not user-initiated login */}
                {isLoading && !isAuthenticated && !hasInitialized && (
                    <LoadingWidget useFunnyMessages={true} />
                )}

                {/* Progressive Scroll Category Profile is now perfectly enclosed within the Top Navigation Frame! */}
                {/* Browse View - Game Categories */}
                {activeTab === 'browse' && (
                    <>
                        {isLoadingGames ? (
                            <div className="relative h-full min-h-[400px] flex items-center justify-center">
                                <LoadingWidget useFunnyMessages={false} message="Loading categories..." fullScreen={false} />
                            </div>
                        ) : topGames.length === 0 ? (
                            <div className="flex items-center justify-center h-full">
                                <div className="text-center glass-panel p-6 max-w-sm">
                                    <h3 className="text-base font-bold text-textPrimary mb-1">No Categories Found</h3>
                                    <p className="text-textSecondary text-sm">Could not load categories.</p>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-3">
                                    {topGames.map(game => renderCategoryCard(game))}
                                </div>
                                {/* Loading indicator for infinite scroll */}
                                {isLoadingMoreGames && (
                                    <div className="flex justify-center items-center py-6">
                                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent"></div>
                                    </div>
                                )}
                                {/* End of categories message */}
                                {!hasMoreGames && topGames.length > 0 && (
                                    <div className="text-center py-6">
                                        <p className="text-textSecondary text-xs">No more categories</p>
                                    </div>
                                )}
                            </>
                        )}
                    </>
                )}

                {/* Category Streams View */}
                {activeTab === 'category' && (
                    <div className="pt-2">
                        {/* Category Sub-Navigation Tabs and Toolbar */}
                        <div className="flex items-center justify-between gap-4 mb-4 border-b border-white/5 pb-3 w-full mt-2">
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setCategoryActiveTab('live')}
                                    className={`px-4 py-1.5 text-sm font-bold !rounded-lg transition-all relative ${categoryActiveTab === 'live' ? 'glass-input text-textPrimary' : 'glass-button text-textSecondary/80 hover:text-textPrimary'}`}
                                >
                                    Live
                                </button>
                                <button
                                    onClick={() => setCategoryActiveTab('clips')}
                                    className={`px-4 py-1.5 text-sm font-bold !rounded-lg transition-all relative ${categoryActiveTab === 'clips' ? 'glass-input text-textPrimary' : 'glass-button text-textSecondary/80 hover:text-textPrimary'}`}
                                >
                                    Clips
                                </button>
                                <button
                                    onClick={() => setCategoryActiveTab('videos')}
                                    className={`px-4 py-1.5 text-sm font-bold !rounded-lg transition-all relative ${categoryActiveTab === 'videos' ? 'glass-input text-textPrimary' : 'glass-button text-textSecondary/80 hover:text-textPrimary'}`}
                                >
                                    Videos
                                </button>
                            </div>

                            {/* Filter/Search Toolbar for Clips and Videos */}
                            {(categoryActiveTab === 'clips' || categoryActiveTab === 'videos') && (
                                <div className="flex items-center gap-2">
                                    {/* Search Box */}
                                    <div className="relative group">
                                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-textSecondary group-focus-within:text-accent transition-colors">
                                            <Search size={14} />
                                        </div>
                                        <input
                                            type="text"
                                            placeholder={`Search ${categoryActiveTab}...`}
                                            value={mediaSearchQuery}
                                            onChange={(e) => setMediaSearchQuery(e.target.value)}
                                            className="glass-input !rounded-lg pl-9 pr-3 py-1.5 w-[140px] focus:w-[220px] outline-none text-sm text-textPrimary placeholder-textSecondary/50 font-medium transition-all"
                                        />
                                        {mediaSearchQuery && (
                                            <button 
                                                onClick={() => setMediaSearchQuery('')}
                                                className="absolute inset-y-0 right-0 pr-3 flex items-center text-textSecondary hover:text-accent transition-colors"
                                            >
                                                <X size={14} />
                                            </button>
                                        )}
                                    </div>
                                    <div className="h-5 w-px bg-white/10 mx-1"></div>
                                    {/* Dropdowns */}
                                    {categoryActiveTab === 'clips' && (
                                        <GlassSelect
                                            value={clipsPeriod}
                                            onChange={(val) => setClipsPeriod(val)}
                                            options={[
                                                { value: '24h', label: 'Last 24 Hours' },
                                                { value: '7d', label: 'Last 7 Days' },
                                                { value: '30d', label: 'Last 30 Days' },
                                                { value: 'all', label: 'All Time' }
                                            ]}
                                        />
                                    )}
                                    {categoryActiveTab === 'videos' && (
                                        <>
                                            <GlassSelect
                                                value={videosSort}
                                                onChange={(val) => setVideosSort(val)}
                                                options={[
                                                    { value: 'time', label: 'Recent' },
                                                    { value: 'trending', label: 'Trending' },
                                                    { value: 'views', label: 'Most Viewed' }
                                                ]}
                                            />
                                            <GlassSelect
                                                value={videosPeriod}
                                                onChange={(val) => setVideosPeriod(val)}
                                                options={[
                                                    { value: 'all', label: 'All Time' },
                                                    { value: 'day', label: 'Last 24 Hours' },
                                                    { value: 'week', label: 'Last 7 Days' },
                                                    { value: 'month', label: 'Last 30 Days' }
                                                ]}
                                            />
                                        </>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Rendering Logic based on categoryActiveTab */}
                        {categoryActiveTab === 'live' && (
                            <>
                                {isLoadingCategoryStreams ? (
                                    <div className="flex items-center justify-center h-full">
                                        <div className="text-center">
                                            <div className="animate-spin rounded-full h-12 w-12 border-4 border-glass border-t-accent mx-auto mb-3" />
                                            <p className="text-textSecondary text-xs">Loading streams...</p>
                                        </div>
                                    </div>
                                ) : categoryStreams.length === 0 ? (
                                    <div className="flex items-center justify-center h-full">
                                        <div className="text-center glass-panel p-6 max-w-sm">
                                            <h3 className="text-base font-bold text-textPrimary mb-1">No Live Streams</h3>
                                            <p className="text-textSecondary text-sm">
                                                No one is streaming {selectedCategory?.name}.
                                            </p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
                                        {categoryStreams.map(stream => {
                                            // Drops indicator is elevated to the hero banner in Category view!
                                            // We explicitly disable drops badging on individual stream cards here to reduce noise.
                                            const hasDrops = false;

                                            return (() => {
                                                const isQueued = isInMultiNook(stream.user_login);
                                                const isSuckingUp = suckUpLogin === stream.user_login.toLowerCase();
                                                const isMaterializing = materializingLogin === stream.user_login.toLowerCase();

                                                return (
                                                    <motion.div
                                                        layout
                                                        transition={{ type: "spring", stiffness: 350, damping: 25 }}
                                                        key={stream.id}
                                                        className={`p-2.5 transition-all duration-200 group relative ${
                                                            isQueued && !isSuckingUp
                                                                ? 'ghost-card rounded-lg cursor-default'
                                                                : isQueued && isSuckingUp
                                                                    ? `glass-panel cursor-default ${isOverlayMode ? '!bg-black/40 !border-white/5' : ''}`
                                                                    : `glass-panel cursor-pointer hover:bg-glass-hover ${isOverlayMode ? '!bg-black/40 !border-white/5' : ''} ${hasDrops ? 'ring-2 ring-accent/60' : ''}`
                                                        }`}
                                                        style={!isQueued && hasDrops ? { boxShadow: '0 0 12px var(--color-accent-muted)' } : undefined}
                                                        onClick={() => !isQueued && handleStreamClick(stream)}
                                                        onContextMenu={(e) => !isQueued && useContextMenuStore.getState().openMenu(e, stream)}
                                                    >
                                                        {isQueued && !isSuckingUp ? (
                                                            /* Ghost state — recall button + label */
                                                            <>
                                                                <div className="invisible">
                                                                    <div className="relative mb-2 overflow-hidden rounded aspect-video" />
                                                                    <div className="space-y-0.5">
                                                                        <div className="h-4" />
                                                                        <div className="h-3" />
                                                                    </div>
                                                                </div>
                                                                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 animate-ghost-label">
                                                                    <LayoutGrid size={18} className="text-accent/50" />
                                                                    <span className="text-accent text-xs font-semibold truncate max-w-[80%]">{stream.user_name}</span>
                                                                    <span className="text-textSecondary text-[10px]">Queued in MultiNook</span>
                                                                    <Tooltip content="Recall from MultiNook" side="bottom">
                                                                        <button
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                const card = (e.currentTarget as HTMLElement).closest('.ghost-card');
                                                                                const rect = card?.getBoundingClientRect();
                                                                                const cx = rect ? rect.left + rect.width / 2 : e.clientX;
                                                                                const cy = rect ? rect.top + rect.height / 2 : e.clientY;
                                                                                triggerRecallAnimation(stream.user_login, cx, cy);
                                                                            }}
                                                                            className="glass-button !rounded-full !p-1.5 mt-1 text-textSecondary hover:text-accent transition-colors"
                                                                        >
                                                                            <Undo2 size={14} strokeWidth={2} />
                                                                        </button>
                                                                    </Tooltip>
                                                                </div>
                                                            </>
                                                        ) : (
                                                            /* Normal content, suck-up, or materialize animation */
                                                            <div className={isSuckingUp ? 'animate-multinook-suck-up' : isMaterializing ? 'animate-multinook-materialize' : undefined}>
                                                                {!isSuckingUp && <QuickAddButton stream={stream} />}
                                                                <div className="relative mb-2 overflow-hidden rounded">
                                                                    <img
                                                                        loading="lazy"
                                                                        src={getThumbnailUrl(stream.thumbnail_url)}
                                                                        alt={stream.title}
                                                                        className="w-full aspect-video object-cover group-hover:scale-105 transition-transform duration-200"
                                                                    />
                                                                    <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
                                                                        <div className="live-dot text-xs px-1.5 py-0.5">LIVE</div>
                                                                        {hasDrops && (
                                                                            <div className="drops-badge-glass">
                                                                                <Gift size={10} />
                                                                                <span>DROPS</span>
                                                                            </div>
                                                                        )}
                                                                        {activeHypeTrainChannels.get(stream.user_id) && (
                                                                            <div className={activeHypeTrainChannels.get(stream.user_id)?.isGolden ? 'hype-train-badge-glass-golden' : 'hype-train-badge-glass'}>
                                                                                <svg className="w-2.5 h-2.5" viewBox="0 0 15 13" fill="none">
                                                                                    <path fillRule="evenodd" clipRule="evenodd" d="M4.10001 0.549988H2.40001V4.79999H0.700012V10.75H1.55001C1.55001 11.6889 2.31113 12.45 3.25001 12.45C4.1889 12.45 4.95001 11.6889 4.95001 10.75H5.80001C5.80001 11.6889 6.56113 12.45 7.50001 12.45C8.4389 12.45 9.20001 11.6889 9.20001 10.75H10.05C10.05 11.6889 10.8111 12.45 11.75 12.45C12.6889 12.45 13.45 11.6889 13.45 10.75H14.3V0.549988H6.65001V2.24999H7.50001V4.79999H4.10001V0.549988ZM12.6 9.04999V6.49999H2.40001V9.04999H12.6ZM9.20001 4.79999H12.6V2.24999H9.20001V4.79999Z" fill="currentColor" />
                                                                                </svg>
                                                                                <span>LVL {activeHypeTrainChannels.get(stream.user_id)?.level}</span>
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                    <div className="absolute bottom-1.5 left-1.5 px-2 py-0.5 glass-badge text-white text-[10px] font-medium rounded">
                                                                        {stream.viewer_count.toLocaleString()} viewers
                                                                    </div>
                                                                    {watchStreaks[stream.user_id] > 0 && (
                                                                        <div className="absolute bottom-1.5 right-1.5">
                                                                            <Tooltip content={`${watchStreaks[stream.user_id]} Stream Watch Streak`} side="top">
                                                                            <div className="flex items-center gap-1 font-bold text-[10px] leading-tight px-1.5 py-0.5 rounded shadow-[0_0_10px_rgba(245,158,11,0.25)] bg-amber-500/10 text-amber-400 border border-amber-500/30 backdrop-blur-md">
                                                                                <Flame size={10} className="stroke-[2.5]" />
                                                                                <span>{watchStreaks[stream.user_id]}</span>
                                                                            </div>
                                                                            </Tooltip>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                                <div className="space-y-0.5">
                                                                    <h3 className="text-textPrimary font-medium text-[13px] leading-tight line-clamp-1 group-hover:text-accent transition-colors">
                                                                        <StreamTitleWithEmojis title={stream.title} />
                                                                    </h3>
                                                                    <div className="flex items-center justify-between">
                                                                        <div className="flex items-center gap-1">
                                                                            <p className="text-textSecondary text-[11px] font-medium">{stream.user_name}</p>
                                                                            {stream.broadcaster_type === 'partner' && (
                                                                                <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 16 16" fill="#9146FF">
                                                                                    <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd"></path>
                                                                                </svg>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </motion.div>
                                                );
                                            })();
                                        })}
                                    </div>
                                )}
                                {/* Loading indicator for infinite scroll */}
                                {isLoadingMoreCategoryStreams && (
                                    <div className="flex justify-center items-center py-6 w-full">
                                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent"></div>
                                    </div>
                                )}
                                {/* End of streams message */}
                                {!hasMoreCategoryStreams && categoryStreams.length > 0 && (
                                    <div className="text-center py-6 w-full">
                                        <p className="text-textSecondary text-xs">No more category streams</p>
                                    </div>
                                )}
                            </>
                        )}
                        
                        {categoryActiveTab === 'clips' && (
                            <>
                                {isLoadingClips ? (
                                    <div className="flex items-center justify-center h-full pt-10">
                                        <div className="text-center">
                                            <div className="animate-spin rounded-full h-12 w-12 border-4 border-glass border-t-accent mx-auto mb-3" />
                                            <p className="text-textSecondary text-xs">Loading clips...</p>
                                        </div>
                                    </div>
                                ) : categoryClips.length === 0 ? (
                                    <div className="flex items-center justify-center h-[300px]">
                                        <div className="text-center glass-panel p-6 max-w-sm">
                                            <h3 className="text-base font-bold text-textPrimary mb-1">No Clips Found</h3>
                                            <p className="text-textSecondary text-sm">
                                                No clips have been generated for {selectedCategory?.name} yet.
                                            </p>
                                        </div>
                                    </div>
                                ) : (() => {
                                     const filteredClips = categoryClips.filter(c => 
                                         !mediaSearchQuery || 
                                         c.title.toLowerCase().includes(mediaSearchQuery.toLowerCase()) || 
                                         c.broadcaster_name.toLowerCase().includes(mediaSearchQuery.toLowerCase())
                                     );
                                     
                                     if (filteredClips.length === 0) {
                                         return (
                                             <div className="flex items-center justify-center h-[300px]">
                                                 <div className="text-center glass-panel p-6 max-w-sm">
                                                     <h3 className="text-base font-bold text-textPrimary mb-1">No Results Search</h3>
                                                     <p className="text-textSecondary text-sm">
                                                         No clips match your search "{mediaSearchQuery}".
                                                     </p>
                                                 </div>
                                             </div>
                                         );
                                     }

                                     return (
                                         <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                                             {filteredClips.map(clip => renderClipCard(clip))}
                                         </div>
                                     );
                                 })()}
                                {/* Loading indicator for infinite scroll */}
                                {isLoadingMoreClips && (
                                    <div className="flex justify-center items-center py-6 w-full">
                                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent"></div>
                                    </div>
                                )}
                                {/* End of clips message */}
                                {!hasMoreCategoryClips && categoryClips.length > 0 && (
                                    <div className="text-center py-6 w-full">
                                        <p className="text-textSecondary text-xs">End of clips</p>
                                    </div>
                                )}
                            </>
                        )}
                        
                        {categoryActiveTab === 'videos' && (
                            <>
                                {isLoadingVideos ? (
                                    <div className="flex items-center justify-center h-full pt-10">
                                        <div className="text-center">
                                            <div className="animate-spin rounded-full h-12 w-12 border-4 border-glass border-t-accent mx-auto mb-3" />
                                            <p className="text-textSecondary text-xs">Loading videos...</p>
                                        </div>
                                    </div>
                                ) : categoryVideos.length === 0 ? (
                                    <div className="flex items-center justify-center h-[300px]">
                                        <div className="text-center glass-panel p-6 max-w-sm">
                                            <h3 className="text-base font-bold text-textPrimary mb-1">No Videos Found</h3>
                                            <p className="text-textSecondary text-sm">
                                                No videos exist for {selectedCategory?.name}.
                                            </p>
                                        </div>
                                    </div>
                                ) : (() => {
                                     const filteredVideos = categoryVideos.filter(v => 
                                         !mediaSearchQuery || 
                                         v.title.toLowerCase().includes(mediaSearchQuery.toLowerCase()) || 
                                         v.user_name.toLowerCase().includes(mediaSearchQuery.toLowerCase())
                                     );

                                     if (filteredVideos.length === 0) {
                                         return (
                                             <div className="flex items-center justify-center h-[300px]">
                                                 <div className="text-center glass-panel p-6 max-w-sm">
                                                     <h3 className="text-base font-bold text-textPrimary mb-1">No Results Search</h3>
                                                     <p className="text-textSecondary text-sm">
                                                         No videos match your search "{mediaSearchQuery}".
                                                     </p>
                                                 </div>
                                             </div>
                                         );
                                     }

                                     return (
                                         <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                                             {filteredVideos.map(video => renderVideoCard(video))}
                                         </div>
                                     );
                                 })()}
                                {/* Loading indicator for infinite scroll */}
                                {isLoadingMoreVideos && (
                                    <div className="flex justify-center items-center py-6 w-full">
                                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent"></div>
                                    </div>
                                )}
                                {/* End of videos message */}
                                {!hasMoreCategoryVideos && categoryVideos.length > 0 && (
                                    <div className="text-center py-6 w-full">
                                        <p className="text-textSecondary text-xs">End of videos</p>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                )}

                {/* Following/Recommended/Search Views */}
                {(activeTab === 'following' || activeTab === 'recommended' || activeTab === 'search') && (
                    <>
                        {isSearching ? (
                            <div className="flex items-center justify-center h-full">
                                <div className="text-center">
                                    <div className="animate-spin rounded-full h-12 w-12 border-4 border-glass border-t-accent mx-auto mb-3" />
                                    <p className="text-textSecondary text-xs">Searching...</p>
                                </div>
                            </div>
                        ) : !isAuthenticated && activeTab === 'following' ? (
                            <div className="flex items-center justify-center h-full">
                                <div className="text-center glass-panel p-6 max-w-sm">
                                    <h3 className="text-base font-bold text-textPrimary mb-1">Not Logged In</h3>
                                    <p className="text-textSecondary text-sm mb-4">
                                        Log in to see your followed streams.
                                    </p>
                                    <button
                                        onClick={loginToTwitch}
                                        disabled={isLoading}
                                        className="flex items-center justify-center gap-2 px-4 py-2 bg-[#9146FF] hover:bg-[#7c3aed] text-white text-sm font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed mx-auto"
                                    >
                                        <svg fill="currentColor" viewBox="0 0 512 512" className="w-4 h-4">
                                            <path d="M80,32,48,112V416h96v64h64l64-64h80L464,304V32ZM416,288l-64,64H256l-64,64V352H112V80H416Z" />
                                            <rect x="320" y="143" width="48" height="129" />
                                            <rect x="208" y="143" width="48" height="129" />
                                        </svg>
                                        <span>{isLoading ? 'Logging in...' : 'Login with Twitch'}</span>
                                    </button>
                                </div>
                            </div>
                        ) : displayStreams.length === 0 && categorySearchResults.length === 0 && (activeTab !== 'search' || offlineSearchResults.length === 0) ? (
                            <div className="flex items-center justify-center h-full">
                                <div className="text-center glass-panel p-6 max-w-sm">
                                    <h3 className="text-base font-bold text-textPrimary mb-1">
                                        {activeTab === 'following' ? 'No Live Streams' : activeTab === 'recommended' ? 'No Streams' : 'No Results'}
                                    </h3>
                                    <p className="text-textSecondary text-sm">
                                        {activeTab === 'following'
                                            ? 'None of your followed channels are live.'
                                            : activeTab === 'recommended'
                                                ? 'Could not load streams.'
                                                : searchMode === 'categories' 
                                                    ? `No categories found for "${searchQuery}".`
                                                    : `No channels found for "${searchQuery}".`}
                                    </p>
                                    {/* Login prompt for unauthenticated users when streams fail to load */}
                                    {!isAuthenticated && activeTab === 'recommended' && (
                                        <div className="mt-4 pt-4 border-t border-borderSubtle">
                                            <p className="text-textSecondary text-xs mb-3">
                                                Log in for a better experience
                                            </p>
                                            <button
                                                onClick={loginToTwitch}
                                                disabled={isLoading}
                                                className="glass-button flex items-center justify-center gap-2 px-4 py-2.5 text-white text-sm font-medium rounded-lg transition-all hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 mx-auto"
                                            >
                                                <svg fill="currentColor" viewBox="0 0 512 512" className="w-4 h-4">
                                                    <path d="M80,32,48,112V416h96v64h64l64-64h80L464,304V32ZM416,288l-64,64H256l-64,64V352H112V80H416Z" />
                                                    <rect x="320" y="143" width="48" height="129" />
                                                    <rect x="208" y="143" width="48" height="129" />
                                                </svg>
                                                <span>{isLoading ? 'Logging in...' : 'Login with Twitch'}</span>
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <>
                                {activeTab === 'search' && searchMode === 'categories' && categorySearchResults.length > 0 && (
                                    <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-3">
                                        {categorySearchResults.map(game => renderCategoryCard(game))}
                                    </div>
                                )}
                                {displayStreams.length > 0 && !(activeTab === 'search' && searchMode === 'categories') && (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
                                        {displayStreams.map(stream => {
                                        const isFavorite = isFavoriteStreamer(stream.user_id);
                                        // Check if stream's game has active drops
                                        const streamDropsCampaign = stream.game_name ? dropsGameNames.get(stream.game_name.toLowerCase()) : undefined;
                                        const hasDrops = !!streamDropsCampaign;
                                        return (() => {
                                            const isQueued = isInMultiNook(stream.user_login);
                                            const isSuckingUp = suckUpLogin === stream.user_login.toLowerCase();
                                            const isMaterializing = materializingLogin === stream.user_login.toLowerCase();

                                            return (
                                                <motion.div
                                                    layout
                                                    transition={{ type: "spring", stiffness: 350, damping: 25 }}
                                                    key={stream.id}
                                                    className={`p-2.5 transition-all duration-200 group relative ${
                                                        isQueued && !isSuckingUp
                                                            ? 'ghost-card rounded-lg cursor-default'
                                                            : isQueued && isSuckingUp
                                                                ? `glass-panel cursor-default ${isOverlayMode ? '!bg-black/40 !border-white/5' : ''}`
                                                                : `glass-panel cursor-pointer hover:bg-glass-hover ${isOverlayMode ? '!bg-black/40 !border-white/5' : ''} ${stream.has_shared_chat === true ? 'iridescent-border' : ''}`
                                                    }`}
                                                    onClick={() => !isQueued && handleStreamClick(stream)}
                                                    onContextMenu={(e) => !isQueued && useContextMenuStore.getState().openMenu(e, stream)}
                                                >
                                                    {isQueued && !isSuckingUp ? (
                                                        /* Ghost state — recall button + label */
                                                        <>
                                                            <div className="invisible">
                                                                <div className="relative mb-2 overflow-hidden rounded aspect-video" />
                                                                <div className="flex items-end justify-between mt-1">
                                                                    <div className="space-y-0.5 flex-1 min-w-0 pr-2 pb-1">
                                                                        <div className="h-4" />
                                                                        <div className="h-3" />
                                                                        <div className="h-3" />
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 animate-ghost-label">
                                                                <LayoutGrid size={18} className="text-accent/50" />
                                                                <span className="text-accent text-xs font-semibold truncate max-w-[80%]">{stream.user_name}</span>
                                                                <span className="text-textSecondary text-[10px]">Queued in MultiNook</span>
                                                                <Tooltip content="Recall from MultiNook" side="bottom">
                                                                    <button
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            const card = (e.currentTarget as HTMLElement).closest('.ghost-card');
                                                                            const rect = card?.getBoundingClientRect();
                                                                            const cx = rect ? rect.left + rect.width / 2 : e.clientX;
                                                                            const cy = rect ? rect.top + rect.height / 2 : e.clientY;
                                                                            triggerRecallAnimation(stream.user_login, cx, cy);
                                                                        }}
                                                                        className="glass-button !rounded-full !p-1.5 mt-1 text-textSecondary hover:text-accent transition-colors"
                                                                    >
                                                                        <Undo2 size={14} strokeWidth={2} />
                                                                    </button>
                                                                </Tooltip>
                                                            </div>
                                                        </>
                                                    ) : (
                                                        /* Normal content, suck-up, or materialize animation */
                                                        <div className={isSuckingUp ? 'animate-multinook-suck-up' : isMaterializing ? 'animate-multinook-materialize' : undefined}>
                                                            {!isSuckingUp && <QuickAddButton stream={stream} />}
                                                            <div className="relative mb-2 overflow-hidden rounded">
                                                                <img
                                                                    loading="lazy"
                                                                    src={getThumbnailUrl(stream.thumbnail_url)}
                                                                    alt={stream.title}
                                                                    className="w-full aspect-video object-cover group-hover:scale-105 transition-transform duration-200"
                                                                />
                                                                <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
                                                                    <div className="live-dot text-xs px-1.5 py-0.5">LIVE</div>
                                                                    {hasDrops && (
                                                                        <div className="drops-badge-glass">
                                                                            <Gift size={10} />
                                                                            <span>DROPS</span>
                                                                        </div>
                                                                    )}
                                                                    {activeHypeTrainChannels.get(stream.user_id) && (
                                                                        <div className={activeHypeTrainChannels.get(stream.user_id)?.isGolden ? 'hype-train-badge-glass-golden' : 'hype-train-badge-glass'}>
                                                                            <svg className="w-2.5 h-2.5" viewBox="0 0 15 13" fill="none">
                                                                                <path fillRule="evenodd" clipRule="evenodd" d="M4.10001 0.549988H2.40001V4.79999H0.700012V10.75H1.55001C1.55001 11.6889 2.31113 12.45 3.25001 12.45C4.1889 12.45 4.95001 11.6889 4.95001 10.75H5.80001C5.80001 11.6889 6.56113 12.45 7.50001 12.45C8.4389 12.45 9.20001 11.6889 9.20001 10.75H10.05C10.05 11.6889 10.8111 12.45 11.75 12.45C12.6889 12.45 13.45 11.6889 13.45 10.75H14.3V0.549988H6.65001V2.24999H7.50001V4.79999H4.10001V0.549988ZM12.6 9.04999V6.49999H2.40001V9.04999H12.6ZM9.20001 4.79999H12.6V2.24999H9.20001V4.79999Z" fill="currentColor" />
                                                                            </svg>
                                                                            <span>LVL {activeHypeTrainChannels.get(stream.user_id)?.level}</span>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                                <div className="absolute bottom-1.5 left-1.5 px-2 py-0.5 glass-badge text-white text-xs font-medium rounded">
                                                                    {stream.viewer_count.toLocaleString()} viewers
                                                                </div>
                                                                {watchStreaks[stream.user_id] > 0 && (
                                                                    <div className="absolute bottom-1.5 right-1.5">
                                                                        <Tooltip content={`${watchStreaks[stream.user_id]} Stream Watch Streak`} side="top">
                                                                        <div className="flex items-center gap-1 font-bold text-[10px] leading-tight px-1.5 py-0.5 rounded shadow-[0_0_10px_rgba(245,158,11,0.25)] bg-amber-500/10 text-amber-400 border border-amber-500/30 backdrop-blur-md">
                                                                            <Flame size={10} className="stroke-[2.5]" />
                                                                            <span>{watchStreaks[stream.user_id]}</span>
                                                                        </div>
                                                                        </Tooltip>
                                                                    </div>
                                                                )}
                                                            </div>
                                                            <div className="flex items-end justify-between mt-1">
                                                                <div className="space-y-0.5 flex-1 min-w-0 pr-2 pb-1">
                                                                    <h3 className="text-textPrimary font-medium text-sm line-clamp-1 group-hover:text-accent transition-colors">
                                                                        <StreamTitleWithEmojis title={stream.title} />
                                                                    </h3>
                                                                    <button 
                                                                        onClick={(e) => { 
                                                                            e.stopPropagation(); 
                                                                            useAppStore.getState().setProfileModalUser(stream); 
                                                                        }}
                                                                        className="flex items-center gap-1 text-textSecondary text-xs hover:text-white hover:bg-white/10 px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded transition-all cursor-pointer text-left focus:outline-none w-max max-w-full"
                                                                    >
                                                                        <span className="truncate">{stream.user_name}</span>
                                                                        {stream.broadcaster_type === 'partner' && (
                                                                            <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 16 16" fill="#9146FF">
                                                                                <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd"></path>
                                                                            </svg>
                                                                        )}
                                                                    </button>
                                                                    <div className="flex items-center w-full">
                                                                        <Tooltip content={stream.game_name} side="bottom">
                                                                            <button 
                                                                                onClick={(e) => {
                                                                                    e.stopPropagation();
                                                                                    if (stream.game_id && stream.game_name) {
                                                                                        handleCategoryClick({ 
                                                                                            id: stream.game_id, 
                                                                                            name: stream.game_name, 
                                                                                            box_art_url: '' 
                                                                                        });
                                                                                    }
                                                                                }}
                                                                                className="flex items-center gap-1 text-textSecondary text-xs hover:text-white hover:bg-white/10 px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded transition-all text-left cursor-pointer focus:outline-none overflow-hidden"
                                                                            >
                                                                                <span className="line-clamp-1">{stream.game_name}</span>
                                                                                {hasDrops && (
                                                                                    <Gift size={10} className="text-accent flex-shrink-0" />
                                                                                )}
                                                                            </button>
                                                                        </Tooltip>
                                                                    </div>
                                                                </div>

                                                                {activeTab === 'following' && (
                                                                    <Tooltip content={isFavorite ? 'Remove from favorites' : 'Add to favorites'} side="top">
                                                                    <button
                                                                        onClick={(e) => handleFavoriteClick(e, stream.user_id)}
                                                                        className={`p-1 flex items-center justify-center bg-transparent transition-transform duration-300 hover:scale-110 active:scale-95`}
                                                                    >
                                                                        <Heart
                                                                            size={16}
                                                                            fill={isFavorite ? "url(#glass-heart-fill)" : "none"}
                                                                            stroke={isFavorite ? "url(#glass-heart-stroke)" : "currentColor"}
                                                                            strokeWidth={isFavorite ? 1.5 : 2}
                                                                            className={`transition-all duration-300 ${isFavorite ? 'drop-shadow-[0_4px_8px_rgba(236,72,153,0.5)]' : 'text-textSecondary hover:text-white opacity-0 group-hover:opacity-100'} ${animatingHearts.has(stream.user_id) ? 'animate-heart-break' : ''}`}
                                                                        />
                                                                    </button>
                                                                    </Tooltip>
                                                                )}
                                                            </div>
                                                        </div>
                                                    )}
                                                </motion.div>
                                            );
                                        })();
                                    })}
                                    </div>
                                )}

                                {/* Offline Followed Channels Section */}
                                {activeTab === 'following' && offlineFollowedChannels.length > 0 && (
                                    <div className={displayStreams.length > 0 ? "mt-6 pt-4 relative" : "pt-2"}>
                                        {displayStreams.length > 0 && (
                                            <div className="absolute top-0 left-0 right-0 h-px bg-borderSubtle/30" />
                                        )}
                                        <div className="col-span-full pb-3 px-2 flex justify-between items-center">
                                            <h3 className="text-sm font-semibold text-textSecondary uppercase tracking-wide flex items-center gap-2">
                                                <User size={14} className="text-textSecondary/70" />
                                                Offline Channels
                                            </h3>
                                        </div>
                                        <div className="flex flex-wrap gap-3 px-2 pb-6 relative z-0 mt-2">
                                            {[...offlineFollowedChannels].sort((a, b) => {
                                                const timeA = offlineLastBroadcasts[a.id] ? new Date(offlineLastBroadcasts[a.id]!).getTime() : 0;
                                                const timeB = offlineLastBroadcasts[b.id] ? new Date(offlineLastBroadcasts[b.id]!).getTime() : 0;
                                                return timeB - timeA;
                                            }).map((user) => {
                                                const lastOnline = offlineLastBroadcasts[user.id];
                                                let relativeTimeResult = '';
                                                if (lastOnline) {
                                                    const date = new Date(lastOnline);
                                                    if (!isNaN(date.getTime())) {
                                                        const diffInSeconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
                                                        if (diffInSeconds < 60) relativeTimeResult = `${diffInSeconds}s ago`;
                                                        else if (diffInSeconds < 3600) relativeTimeResult = `${Math.floor(diffInSeconds / 60)}m ago`;
                                                        else if (diffInSeconds < 86400) relativeTimeResult = `${Math.floor(diffInSeconds / 3600)}h ago`;
                                                        else if (diffInSeconds < 2592000) relativeTimeResult = `${Math.floor(diffInSeconds / 86400)}d ago`;
                                                        else if (diffInSeconds < 31536000) relativeTimeResult = `${Math.floor(diffInSeconds / 2592000)}mo ago`;
                                                        else relativeTimeResult = `${Math.floor(diffInSeconds / 31536000)}y ago`;
                                                    }
                                                }

                                                return (
                                                    <div
                                                        key={user.id}
                                                        className="relative group w-[180px] sm:w-[200px] rounded-xl overflow-hidden glass-panel border border-borderSubtle hover:border-white/20 transition-all shadow-sm"
                                                    >
                                                        {/* Base Card Content */}
                                                        <div className="w-full flex items-center gap-3 px-3 py-2">
                                                            <div className="w-10 h-10 rounded-full bg-glass flex items-center justify-center overflow-hidden ring-1 ring-borderSubtle group-hover:ring-accent/40 flex-shrink-0 relative transition-all">
                                                                {user.thumbnail_url ? (
                                                                    <img src={user.thumbnail_url} alt={user.user_name} className="w-full h-full object-cover" />
                                                                ) : (
                                                                    <User size={14} className="text-textSecondary" />
                                                                )}
                                                            </div>
                                                            <div className="flex-1 min-w-0 transition-opacity duration-200">
                                                                <h4 className="text-sm font-semibold text-textPrimary truncate transition-colors">
                                                                    {user.user_name}
                                                                </h4>
                                                                <p className="text-[10px] text-textSecondary truncate">
                                                                    {relativeTimeResult ? `Last live ${relativeTimeResult}` : 'Offline'}
                                                                </p>
                                                            </div>
                                                        </div>

                                                        {/* Action Overlay (Optimized - No blur on hidden elements) */}
                                                        <div className="absolute inset-0 bg-[#0c0c0d]/90 opacity-0 group-hover:opacity-100 transition-all duration-200 flex items-center justify-center gap-2 z-10">
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    const store = useAppStore.getState();
                                                                    if (store.isHomeActive) store.toggleHome();
                                                                    store.startOfflineChat(user.user_login, user);
                                                                }}
                                                                className="px-3 py-1.5 rounded-lg glass-button text-[12px] font-bold text-white hover:bg-white/20 transition-all border border-white/10 hover:border-white/30 shadow-lg flex items-center gap-1.5"
                                                            >
                                                                <MessageSquare size={14} strokeWidth={2.5} />
                                                                <span>Offline Chat</span>
                                                            </button>
                                                            
                                                            <Tooltip content="Profile" side="top">
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        setProfileModalUser(user);
                                                                    }}
                                                                    className="p-[7px] rounded-lg glass-button text-textSecondary hover:text-white hover:bg-white/20 transition-all border border-white/10 hover:border-white/30 shadow-lg"
                                                                >
                                                                    <User size={14} strokeWidth={2.5} />
                                                                </button>
                                                            </Tooltip>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                            {isLoadingOfflineChannels && (
                                                <div className="flex items-center justify-center p-2 w-[180px] sm:w-[200px]">
                                                    <Loader2 size={16} className="animate-spin text-accent" />
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Offline Users Search Section */}
                                {activeTab === 'search' && offlineSearchResults.length > 0 && (
                                    <div className={displayStreams.length > 0 ? "mt-4 border-t border-borderSubtle/30 pt-4" : "pt-2"}>
                                        <div className="col-span-full pb-3 px-2">
                                            <h3 className="text-sm font-semibold text-textSecondary uppercase tracking-wide flex items-center gap-2">
                                                <User size={14} className="text-textSecondary/70" />
                                                Offline Channels
                                            </h3>
                                        </div>
                                        <div className="flex flex-wrap gap-3 px-2 pb-6 relative z-0">
                                            {offlineSearchResults.map((user) => (
                                                <button
                                                    key={user.id}
                                                    onClick={() => setProfileModalUser(user)}
                                                    className="flex items-center gap-3 px-3 py-2 rounded-xl glass-panel hover:bg-white/[0.05] border border-borderSubtle hover:border-accent/40 transition-all text-left shadow-sm group w-[180px] sm:w-[200px]"
                                                >
                                                    <div className="w-10 h-10 rounded-full bg-glass flex items-center justify-center overflow-hidden ring-1 ring-borderSubtle group-hover:ring-accent/40 flex-shrink-0">
                                                        {user.thumbnail_url ? (
                                                            <img src={user.thumbnail_url} alt={user.user_name} className="w-full h-full object-cover" />
                                                        ) : (
                                                            <User size={14} className="text-textSecondary" />
                                                        )}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <h4 className="text-sm font-semibold text-textPrimary truncate group-hover:text-accent transition-colors">
                                                            {user.user_name}
                                                        </h4>
                                                        <p className="text-[10px] text-textSecondary truncate">
                                                            {user.game_name || 'Channel'}
                                                        </p>
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {activeTab === 'recommended' && isLoadingMore && (
                                    <div className="flex justify-center items-center py-6">
                                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent"></div>
                                    </div>
                                )}
                                {activeTab === 'recommended' && !hasMoreRecommended && displayStreams.length > 0 && (
                                    <div className="text-center py-6">
                                        <p className="text-textSecondary text-xs">No more streams</p>
                                    </div>
                                )}
                            </>
                        )}
                    </>
                )}

                {/* Flying Gift Animation - flies up toward title bar */}
                {flyingDroplet && (
                    <div
                        className="fixed pointer-events-none z-50"
                        style={{
                            left: flyingDroplet?.x ?? 0,
                            top: flyingDroplet?.y ?? 0,
                            transform: 'translate(-50%, -50%)',
                        }}
                    >
                        <div className="animate-fly-up-fade">
                            <Gift
                                size={24}
                                className="gift-shimmer-gold drop-shadow-[0_0_10px_rgba(255,215,0,0.8)]"
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default Home;

