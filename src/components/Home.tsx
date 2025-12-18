import { useEffect, useState, useRef, useCallback } from 'react';
import { useAppStore, HomeTab } from '../stores/AppStore';
import { Search, ArrowLeft, Heart, Maximize2, X, Gift, Pickaxe, Check } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { TwitchStream, TwitchCategory } from '../types';
import LoadingWidget from './LoadingWidget';
import { parseEmojisProxied, EmojiSegment } from '../services/emojiService';

// Component to render stream title with Apple-style emojis (inline)
const StreamTitleWithEmojis = ({ title }: { title: string }) => {
    const [segments, setSegments] = useState<EmojiSegment[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let mounted = true;

        parseEmojisProxied(title)
            .then((result) => {
                if (mounted) {
                    setSegments(result);
                    setIsLoading(false);
                }
            })
            .catch(() => {
                if (mounted) {
                    setSegments([{ type: 'text', content: title }]);
                    setIsLoading(false);
                }
            });

        return () => {
            mounted = false;
        };
    }, [title]);

    if (isLoading) {
        return <>{title}</>;
    }

    return (
        <>
            {segments.map((segment, idx) =>
                segment.type === 'emoji' && segment.emojiUrl && segment.emojiUrl.startsWith('data:') ? (
                    <img
                        key={idx}
                        src={segment.emojiUrl}
                        alt={segment.content}
                        className="inline-block w-4 h-4 object-contain align-text-bottom mx-px"
                        style={{ verticalAlign: '-3px' }}
                        loading="lazy"
                    />
                ) : (
                    <span key={idx}>{segment.content}</span>
                )
            )}
        </>
    );
};

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
    } = useAppStore();

    // Use store state directly
    const activeTab = homeActiveTab;
    const selectedCategory = homeSelectedCategory;

    // Wrapper functions to update store state
    const setActiveTab = (tab: HomeTab) => setHomeActiveTab(tab);
    const setSelectedCategory = (category: TwitchCategory | null) => setHomeSelectedCategory(category);

    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<TwitchStream[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [topGames, setTopGames] = useState<TwitchCategory[]>([]);
    const [isLoadingGames, setIsLoadingGames] = useState(false);
    const [gamesCursor, setGamesCursor] = useState<string | null>(null);
    const [hasMoreGames, setHasMoreGames] = useState(true);
    const [isLoadingMoreGames, setIsLoadingMoreGames] = useState(false);
    const [categoryStreams, setCategoryStreams] = useState<TwitchStream[]>([]);
    const [isLoadingCategoryStreams, setIsLoadingCategoryStreams] = useState(false);
    const [animatingHearts, setAnimatingHearts] = useState<Set<string>>(new Set());
    const [isSearchExpanded, setIsSearchExpanded] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    // Drops-enabled categories tracking (by game_id)
    const [dropsGameIds, setDropsGameIds] = useState<Map<string, DropCampaign>>(new Map());
    // Drops by game name (for stream cards which have game_name)
    const [dropsGameNames, setDropsGameNames] = useState<Map<string, DropCampaign>>(new Map());
    const [isLoadingDrops, setIsLoadingDrops] = useState(false);

    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const loadingRef = useRef(false);

    // Track if the Home component has initialized (to avoid showing LoadingWidget on user-initiated login)
    const [hasInitialized, setHasInitialized] = useState(false);

    useEffect(() => {
        loadFollowedStreams();
        loadRecommendedStreams();
        // Load drops data early so we can show indicators on stream cards
        loadActiveDrops();
        // Mark as initialized after first load attempt
        setHasInitialized(true);
    }, [loadFollowedStreams, loadRecommendedStreams]);

    // Auto-select the appropriate tab based on auth status on initial mount only
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

    const loadTopGames = async () => {
        setIsLoadingGames(true);
        setGamesCursor(null);
        setHasMoreGames(true);
        try {
            const [games, cursor] = await invoke('get_top_games_paginated', {
                cursor: null,
                limit: 40
            }) as [TwitchCategory[], string | null];
            setTopGames(games);
            setGamesCursor(cursor);
            setHasMoreGames(!!cursor);
        } catch (e) {
            console.error('Failed to load top games:', e);
            setTopGames([]);
            setHasMoreGames(false);
        } finally {
            setIsLoadingGames(false);
        }
    };

    const loadMoreTopGames = async () => {
        if (!hasMoreGames || isLoadingMoreGames || !gamesCursor) return;

        setIsLoadingMoreGames(true);
        try {
            const [games, cursor] = await invoke('get_top_games_paginated', {
                cursor: gamesCursor,
                limit: 40
            }) as [TwitchCategory[], string | null];
            setTopGames(prev => [...prev, ...games]);
            setGamesCursor(cursor);
            setHasMoreGames(!!cursor);
        } catch (e) {
            console.error('Failed to load more top games:', e);
        } finally {
            setIsLoadingMoreGames(false);
        }
    };

    // Load active drops campaigns and build maps for both game_id and game_name lookup
    const loadActiveDrops = async () => {
        setIsLoadingDrops(true);
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
                console.log(`[Home] Found ${dropsIdMap.size} categories with active drops`);

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
                                    console.log(`[Home] Already mining campaign: ${campaign.name}`);
                                    setActiveMiningIds(prev => new Set(prev).add(campaign.id));
                                    break;
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.warn('Could not get mining status:', e);
                }
            } else {
                setDropsGameIds(new Map());
                setDropsGameNames(new Map());
            }
        } catch (e) {
            console.error('Failed to load active drops:', e);
            setDropsGameIds(new Map());
            setDropsGameNames(new Map());
        } finally {
            setIsLoadingDrops(false);
        }
    };

    // State for mining animation and tracking actively mining campaigns
    const [activeMiningIds, setActiveMiningIds] = useState<Set<string>>(new Set());
    const [flyingDroplet, setFlyingDroplet] = useState<{ visible: boolean; x: number; y: number } | null>(null);

    // Create a map from campaign name to campaign ID for reverse lookup
    const campaignNameToIdRef = useRef<Map<string, string>>(new Map());

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
            } catch (e) {
                // Silently fail - might not be authenticated or backend not ready
            }
        };

        // Initial sync
        syncMiningStatus();

        // Poll every 5 seconds
        const interval = setInterval(syncMiningStatus, 5000);

        // Also listen for mining status change events
        let unlisten: (() => void) | null = null;
        const setupListener = async () => {
            try {
                const { listen } = await import('@tauri-apps/api/event');
                unlisten = await listen('mining-status-changed', syncMiningStatus);
            } catch (err) {
                // Event listener not available
            }
        };
        setupListener();

        return () => {
            clearInterval(interval);
            if (unlisten) unlisten();
        };
    }, []);

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
                console.log(`[Home] Stopped mining drops for ${campaign.name}`);
                setActiveMiningIds(new Set()); // Clear all mining IDs
                useAppStore.getState().addToast(`Stopped mining drops for ${campaign.game_name}`, 'info');
            } catch (error) {
                console.error('Failed to stop mining:', error);
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
                console.log(`[Home] Started mining drops for ${campaign.name}`);

                // Add to active mining set
                setActiveMiningIds(new Set([campaign.id]));

                // Start flying droplet animation
                setFlyingDroplet({ visible: true, x: centerX, y: centerY });

                // Clear flying animation after it completes
                setTimeout(() => setFlyingDroplet(null), 1000);

                useAppStore.getState().addToast(`Started mining drops for ${campaign.game_name}`, 'success');
            } catch (error) {
                console.error('Failed to start mining:', error);
                useAppStore.getState().addToast('Failed to start mining drops', 'error');
            }
        }
    };

    const handleBrowseClick = () => {
        setActiveTab('browse');
        setIsSearchExpanded(false);
        if (topGames.length === 0) {
            loadTopGames();
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

        try {
            const [streams] = await invoke('get_streams_by_game', {
                gameId: category.id,
                cursor: null,
                limit: 40
            }) as [TwitchStream[], string | null];
            setCategoryStreams(streams);
        } catch (e) {
            console.error('Failed to load category streams:', e);
            setCategoryStreams([]);
        } finally {
            setIsLoadingCategoryStreams(false);
        }
    };

    // Load streams by game name when navigating from badge overlay (category has no ID)
    const loadCategoryStreamsByName = async (gameName: string) => {
        setIsLoadingCategoryStreams(true);
        setCategoryStreams([]);

        try {
            const streams = await invoke('get_streams_by_game_name', {
                gameName: gameName,
                excludeUserLogin: null,
                limit: 40
            }) as TwitchStream[];
            setCategoryStreams(streams);
        } catch (e) {
            console.error('Failed to load category streams by name:', e);
            setCategoryStreams([]);
        } finally {
            setIsLoadingCategoryStreams(false);
        }
    };

    // Effect to handle navigation from badge overlay (category with empty ID)
    useEffect(() => {
        if (activeTab === 'category' && selectedCategory && !selectedCategory.id && selectedCategory.name) {
            loadCategoryStreamsByName(selectedCategory.name);
        }
    }, [activeTab, selectedCategory]);

    const handleBackToBrowse = () => {
        setActiveTab('browse');
        setSelectedCategory(null);
        setCategoryStreams([]);
    };

    const handleSearch = async () => {
        if (!searchQuery.trim()) return;

        setIsSearching(true);
        setActiveTab('search');
        try {
            const results = await invoke('search_channels', { query: searchQuery }) as TwitchStream[];
            setSearchResults(results);
        } catch (e) {
            console.error('Search failed:', e);
            setSearchResults([]);
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
        }
    };

    const getThumbnailUrl = (url: string) => {
        return url.replace('{width}', '1280').replace('{height}', '720');
    };

    const getGameBoxArt = (url: string) => {
        return url.replace('{width}', '1200').replace('{height}', '1600');
    };

    const handleStreamClick = (stream: TwitchStream) => {
        startStream(stream.user_login, stream);
        toggleHome();
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
    }, [activeTab, hasMoreRecommended, isLoadingMore, loadMoreRecommendedStreams, hasMoreGames, isLoadingMoreGames, loadMoreTopGames]);

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
                : searchResults;

    return (
        <div className="flex flex-col h-full">
            {/* Compact Header */}
            <div className="flex items-center justify-center gap-3 px-4 py-2.5 border-b border-borderSubtle relative min-h-[48px]">
                {/* Category back button and name - absolute left with proper spacing */}
                {activeTab === 'category' && selectedCategory && (
                    <div className="absolute left-4 flex items-center gap-2 max-w-[40%]">
                        <button
                            onClick={handleBackToBrowse}
                            className="p-2 glass-panel hover:bg-glass-hover rounded-lg transition-all group flex-shrink-0"
                            title="Back to Browse"
                        >
                            <ArrowLeft size={18} className="text-textSecondary group-hover:text-textPrimary transition-colors" />
                        </button>
                        <span className="text-textPrimary font-medium text-sm truncate">
                            {selectedCategory.name}
                        </span>
                    </div>
                )}

                {/* Centered Navigation - All tabs and search together */}
                {!(activeTab === 'category' && selectedCategory) && (
                    <div className="relative flex items-center glass-panel px-1.5 py-1 rounded-xl overflow-hidden">
                        {/* Navigation buttons - fade out when search is expanded */}
                        <div className={`flex items-center gap-1 transition-opacity duration-300 ${isSearchExpanded ? 'opacity-0' : 'opacity-100'}`}>
                            {isAuthenticated && (
                                <button
                                    onClick={() => { setActiveTab('following'); setIsSearchExpanded(false); }}
                                    className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-all whitespace-nowrap ${activeTab === 'following'
                                        ? 'glass-button text-white'
                                        : 'text-textSecondary hover:text-textPrimary hover:bg-glass-hover'
                                        }`}
                                >
                                    Following
                                    {followedStreams.length > 0 && (
                                        <span className="ml-1.5 text-xs opacity-80">
                                            {followedStreams.length}
                                        </span>
                                    )}
                                </button>
                            )}
                            <button
                                onClick={() => { setActiveTab('recommended'); setIsSearchExpanded(false); }}
                                className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-all whitespace-nowrap ${activeTab === 'recommended'
                                    ? 'glass-button text-white'
                                    : 'text-textSecondary hover:text-textPrimary hover:bg-glass-hover'
                                    }`}
                            >
                                Discover
                            </button>
                            <button
                                onClick={handleBrowseClick}
                                className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-all whitespace-nowrap ${activeTab === 'browse'
                                    ? 'glass-button text-white'
                                    : 'text-textSecondary hover:text-textPrimary hover:bg-glass-hover'
                                    }`}
                            >
                                Categories
                            </button>
                            {searchResults.length > 0 && (
                                <button
                                    onClick={() => setActiveTab('search')}
                                    className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-all whitespace-nowrap ${activeTab === 'search'
                                        ? 'glass-button text-white'
                                        : 'text-textSecondary hover:text-textPrimary hover:bg-glass-hover'
                                        }`}
                                >
                                    Results
                                    <span className="ml-1 text-xs opacity-80">{searchResults.length}</span>
                                </button>
                            )}
                            <div className="border-l border-borderSubtle h-6 ml-1" />
                            {/* Search button - opens search */}
                            <button
                                onClick={() => setIsSearchExpanded(true)}
                                className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-all ml-0.5"
                                title="Search channels"
                            >
                                <Search size={16} />
                            </button>
                        </div>

                        {/* Search overlay - expands from right to cover buttons */}
                        <div
                            className={`absolute inset-0 flex items-center transition-all duration-300 ease-out ${isSearchExpanded
                                ? 'opacity-100 visible'
                                : 'opacity-0 invisible pointer-events-none'
                                }`}
                        >
                            <div className="flex items-center gap-1.5 w-full px-1.5 py-1">
                                <div className="flex-1 flex items-center glass-button rounded-lg hover:shadow-none">
                                    <input
                                        ref={searchInputRef}
                                        type="text"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        onKeyDown={handleSearchKeyPress}
                                        placeholder="Search channels..."
                                        className="flex-1 bg-transparent text-white text-sm px-3 py-1.5 focus:outline-none placeholder:text-white/60"
                                    />
                                    {/* Toggle button: X when empty, Search when has text */}
                                    <button
                                        onClick={() => {
                                            if (searchQuery.trim()) {
                                                handleSearch();
                                            } else {
                                                setIsSearchExpanded(false);
                                                setSearchQuery('');
                                            }
                                        }}
                                        disabled={isSearching}
                                        className={`p-1.5 mr-1 rounded transition-all flex-shrink-0 ${searchQuery.trim()
                                            ? 'text-white hover:bg-white/20'
                                            : 'text-white/60 hover:text-white hover:bg-white/10'
                                            } ${isSearching ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                                        title={searchQuery.trim() ? "Search" : "Close"}
                                    >
                                        {searchQuery.trim() ? (
                                            <Search size={16} className={isSearching ? 'animate-pulse' : ''} />
                                        ) : (
                                            <X size={16} />
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Return to Stream Button - absolute right */}
                {streamUrl && (
                    <button
                        onClick={toggleHome}
                        className="absolute right-4 flex items-center gap-1.5 px-3 py-1.5 bg-accent text-white text-sm font-medium rounded-lg transition-all hover:bg-accent/90"
                        title="Return to Stream"
                    >
                        <Maximize2 size={14} />
                        <span className="hidden sm:inline">Return</span>
                    </button>
                )}
            </div>

            {/* Content */}
            <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4 scrollbar-thin relative">
                {/* Only show full LoadingWidget during initial app load, not user-initiated login */}
                {isLoading && !isAuthenticated && !hasInitialized && (
                    <LoadingWidget useFunnyMessages={true} />
                )}

                {/* Browse View - Game Categories */}
                {activeTab === 'browse' && (
                    <>
                        {isLoadingGames ? (
                            <div className="flex items-center justify-center h-full">
                                <div className="text-center">
                                    <div className="animate-spin rounded-full h-12 w-12 border-4 border-glass border-t-accent mx-auto mb-3" />
                                    <p className="text-textSecondary text-xs">Loading categories...</p>
                                </div>
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
                                    {topGames.map(game => {
                                        const dropsCampaign = dropsGameIds.get(game.id);
                                        const hasDrops = !!dropsCampaign;

                                        return (
                                            <div
                                                key={game.id}
                                                className={`glass-panel cursor-pointer hover:bg-glass-hover transition-all duration-200 group overflow-hidden relative ${hasDrops ? 'ring-2 ring-accent shadow-accent/40' : ''}`}
                                                style={hasDrops ? { boxShadow: '0 0 15px var(--color-accent-muted)' } : undefined}
                                                onClick={() => handleCategoryClick(game)}
                                            >
                                                <div className="relative overflow-hidden">
                                                    <img
                                                        src={getGameBoxArt(game.box_art_url)}
                                                        alt={game.name}
                                                        className="w-full aspect-[3/4] object-cover group-hover:scale-105 transition-transform duration-200"
                                                    />
                                                    {/* Drops overlay gradient */}
                                                    {hasDrops && (
                                                        <div className="absolute inset-0 bg-gradient-to-t from-accent/40 via-transparent to-accent/20 pointer-events-none" />
                                                    )}
                                                    {/* Drops Badge */}
                                                    {hasDrops && (
                                                        <div className="absolute top-2 left-2 z-10">
                                                            <div className="drops-badge-glass-lg">
                                                                <Gift size={14} className="drop-shadow-lg" />
                                                                <span>DROPS</span>
                                                            </div>
                                                        </div>
                                                    )}
                                                    {/* Mine Drops Button - Toggle start/stop mining */}
                                                    {hasDrops && (
                                                        <button
                                                            onClick={(e) => handleToggleMining(e, dropsCampaign)}
                                                            className={`absolute bottom-2 right-2 left-2 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-white text-xs font-semibold transition-all shadow-lg ${activeMiningIds.has(dropsCampaign.id)
                                                                ? 'bg-green-600 hover:bg-red-600 hover:scale-105'
                                                                : 'bg-accent hover:bg-accent-hover hover:scale-105'
                                                                }`}
                                                            title={activeMiningIds.has(dropsCampaign.id) ? `Click to stop mining ${dropsCampaign.name}` : `Start mining ${dropsCampaign.name}`}
                                                        >
                                                            {activeMiningIds.has(dropsCampaign.id) ? (
                                                                <>
                                                                    <Pickaxe size={14} className="animate-pulse" />
                                                                    <span>Mining</span>
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <Pickaxe size={14} />
                                                                    <span>Start Mining</span>
                                                                </>
                                                            )}
                                                        </button>
                                                    )}
                                                </div>
                                                <div className="p-2">
                                                    <h3 className="text-textPrimary font-medium text-sm line-clamp-2 group-hover:text-accent transition-colors">
                                                        {game.name}
                                                    </h3>
                                                    {game.viewer_count !== undefined && (
                                                        <p className="text-textSecondary text-xs mt-0.5">
                                                            {game.viewer_count.toLocaleString()} viewers
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
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
                                    // Check if the current category has active drops
                                    const categoryDropsCampaign = selectedCategory?.id
                                        ? dropsGameIds.get(selectedCategory.id)
                                        : (selectedCategory?.name ? dropsGameNames.get(selectedCategory.name.toLowerCase()) : undefined);
                                    const hasDrops = !!categoryDropsCampaign;

                                    return (
                                        <div
                                            key={stream.id}
                                            className={`glass-panel p-2.5 cursor-pointer hover:bg-glass-hover transition-all duration-200 group ${hasDrops ? 'ring-2 ring-accent/60' : ''}`}
                                            style={hasDrops ? { boxShadow: '0 0 12px var(--color-accent-muted)' } : undefined}
                                            onClick={() => handleStreamClick(stream)}
                                        >
                                            <div className="relative mb-2 overflow-hidden rounded">
                                                <img
                                                    src={getThumbnailUrl(stream.thumbnail_url)}
                                                    alt={stream.title}
                                                    className="w-full aspect-video object-cover group-hover:scale-105 transition-transform duration-200"
                                                />
                                                <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
                                                    <div className="live-dot text-xs px-1.5 py-0.5">
                                                        LIVE
                                                    </div>
                                                    {/* Drops indicator badge */}
                                                    {hasDrops && (
                                                        <div className="drops-badge-glass">
                                                            <Gift size={10} />
                                                            <span>DROPS</span>
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="absolute bottom-1.5 left-1.5 px-2 py-0.5 glass-button text-white text-xs font-medium rounded">
                                                    {stream.viewer_count.toLocaleString()} viewers
                                                </div>
                                            </div>
                                            <div className="space-y-0.5">
                                                <h3 className="text-textPrimary font-medium text-sm line-clamp-1 group-hover:text-accent transition-colors">
                                                    <StreamTitleWithEmojis title={stream.title} />
                                                </h3>
                                                <div className="flex items-center gap-1">
                                                    <p className="text-textSecondary text-xs">{stream.user_name}</p>
                                                    {stream.broadcaster_type === 'partner' && (
                                                        <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 16 16" fill="#9146FF">
                                                            <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd"></path>
                                                        </svg>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
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
                        ) : displayStreams.length === 0 ? (
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
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
                                    {displayStreams.map(stream => {
                                        const isFavorite = isFavoriteStreamer(stream.user_id);
                                        // Check if stream's game has active drops
                                        const streamDropsCampaign = stream.game_name ? dropsGameNames.get(stream.game_name.toLowerCase()) : undefined;
                                        const hasDrops = !!streamDropsCampaign;
                                        return (
                                            <div
                                                key={stream.id}
                                                className={`glass-panel p-2.5 cursor-pointer hover:bg-glass-hover transition-all duration-200 group relative ${stream.has_shared_chat === true ? 'iridescent-border' : ''}`}
                                                onClick={() => handleStreamClick(stream)}
                                            >
                                                <div className="relative mb-2 overflow-hidden rounded">
                                                    <img
                                                        src={getThumbnailUrl(stream.thumbnail_url)}
                                                        alt={stream.title}
                                                        className="w-full aspect-video object-cover group-hover:scale-105 transition-transform duration-200"
                                                    />
                                                    <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
                                                        <div className="live-dot text-xs px-1.5 py-0.5">
                                                            LIVE
                                                        </div>
                                                        {/* Drops indicator badge */}
                                                        {hasDrops && (
                                                            <div className="drops-badge-glass">
                                                                <Gift size={10} />
                                                                <span>DROPS</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="absolute bottom-1.5 left-1.5 px-2 py-0.5 glass-button text-white text-xs font-medium rounded">
                                                        {stream.viewer_count.toLocaleString()} viewers
                                                    </div>
                                                    {activeTab === 'following' && (
                                                        <button
                                                            onClick={(e) => handleFavoriteClick(e, stream.user_id)}
                                                            className={`absolute bottom-1.5 right-1.5 p-1.5 rounded transition-all ${isFavorite
                                                                ? 'text-pink-500 hover:text-pink-600'
                                                                : 'bg-black/50 text-white hover:bg-black/70'
                                                                }`}
                                                            title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                                                        >
                                                            <Heart
                                                                size={14}
                                                                fill="none"
                                                                className={animatingHearts.has(stream.user_id) ? 'animate-heart-break' : ''}
                                                            />
                                                        </button>
                                                    )}
                                                </div>
                                                <div className="space-y-0.5">
                                                    <h3 className="text-textPrimary font-medium text-sm line-clamp-1 group-hover:text-accent transition-colors">
                                                        <StreamTitleWithEmojis title={stream.title} />
                                                    </h3>
                                                    <div className="flex items-center gap-1">
                                                        <p className="text-textSecondary text-xs">{stream.user_name}</p>
                                                        {stream.broadcaster_type === 'partner' && (
                                                            <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 16 16" fill="#9146FF">
                                                                <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd"></path>
                                                            </svg>
                                                        )}
                                                    </div>
                                                    <div className="flex items-center gap-1">
                                                        <p className="text-textSecondary text-xs line-clamp-1">{stream.game_name}</p>
                                                        {hasDrops && (
                                                            <Gift size={10} className="text-accent flex-shrink-0" />
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
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
                            left: flyingDroplet.x,
                            top: flyingDroplet.y,
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
