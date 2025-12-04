import { useEffect, useState, useRef, useCallback } from 'react';
import { useAppStore } from '../stores/AppStore';
import { Search, Grid3x3, ArrowLeft, Heart, Maximize2, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { TwitchStream, TwitchCategory } from '../types';
import LoadingWidget from './LoadingWidget';

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
        toggleHome
    } = useAppStore();

    const [activeTab, setActiveTab] = useState<'following' | 'recommended' | 'browse' | 'search' | 'category'>('following');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<TwitchStream[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [topGames, setTopGames] = useState<TwitchCategory[]>([]);
    const [isLoadingGames, setIsLoadingGames] = useState(false);
    const [selectedCategory, setSelectedCategory] = useState<TwitchCategory | null>(null);
    const [categoryStreams, setCategoryStreams] = useState<TwitchStream[]>([]);
    const [isLoadingCategoryStreams, setIsLoadingCategoryStreams] = useState(false);
    const [animatingHearts, setAnimatingHearts] = useState<Set<string>>(new Set());
    const [isSearchExpanded, setIsSearchExpanded] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const loadingRef = useRef(false);

    useEffect(() => {
        loadFollowedStreams();
        loadRecommendedStreams();
    }, [loadFollowedStreams, loadRecommendedStreams]);

    // Auto-select the appropriate tab based on auth status
    useEffect(() => {
        if (isAuthenticated && followedStreams.length > 0) {
            setActiveTab('following');
        } else if (!isAuthenticated || followedStreams.length === 0) {
            setActiveTab('recommended');
        }
    }, [isAuthenticated, followedStreams.length]);

    // Focus search input when expanded
    useEffect(() => {
        if (isSearchExpanded && searchInputRef.current) {
            searchInputRef.current.focus();
        }
    }, [isSearchExpanded]);

    const loadTopGames = async () => {
        setIsLoadingGames(true);
        try {
            const games = await invoke('get_top_games', { limit: 40 }) as TwitchCategory[];
            setTopGames(games);
        } catch (e) {
            console.error('Failed to load top games:', e);
            setTopGames([]);
        } finally {
            setIsLoadingGames(false);
        }
    };

    const handleBrowseClick = () => {
        setActiveTab('browse');
        setIsSearchExpanded(false);
        if (topGames.length === 0) {
            loadTopGames();
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
        const showingRecommended = activeTab === 'recommended';
        if (!showingRecommended || !hasMoreRecommended || isLoadingMore || loadingRef.current) {
            return;
        }

        const container = scrollContainerRef.current;
        if (!container) return;

        const { scrollTop, scrollHeight, clientHeight } = container;
        const scrollPercentage = (scrollTop + clientHeight) / scrollHeight;

        if (scrollPercentage > 0.8) {
            loadingRef.current = true;
            loadMoreRecommendedStreams().finally(() => {
                loadingRef.current = false;
            });
        }
    }, [activeTab, hasMoreRecommended, isLoadingMore, loadMoreRecommendedStreams]);

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
        <div className="flex flex-col h-full bg-background">
            {/* Compact Header */}
            <div className="flex items-center justify-center gap-3 px-4 py-2.5 border-b border-borderSubtle relative">
                {/* Category back button - absolute left */}
                {activeTab === 'category' && selectedCategory && (
                    <div className="absolute left-4 flex items-center gap-1">
                        <button
                            onClick={handleBackToBrowse}
                            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all"
                            title="Back to Browse"
                        >
                            <ArrowLeft size={18} />
                        </button>
                        <span className="text-textPrimary font-medium text-sm truncate max-w-[150px]">
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
                                className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-all flex items-center gap-1 whitespace-nowrap ${activeTab === 'browse'
                                    ? 'glass-button text-white'
                                    : 'text-textSecondary hover:text-textPrimary hover:bg-glass-hover'
                                    }`}
                            >
                                <Grid3x3 size={14} />
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
                                <div className="flex-1 flex items-center glass-button rounded-lg">
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
                {isLoading && !isAuthenticated && (
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
                            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-3">
                                {topGames.map(game => (
                                    <div
                                        key={game.id}
                                        className="glass-panel cursor-pointer hover:bg-glass-hover transition-all duration-200 group overflow-hidden"
                                        onClick={() => handleCategoryClick(game)}
                                    >
                                        <div className="relative overflow-hidden">
                                            <img
                                                src={getGameBoxArt(game.box_art_url)}
                                                alt={game.name}
                                                className="w-full aspect-[3/4] object-cover group-hover:scale-105 transition-transform duration-200"
                                            />
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
                                ))}
                            </div>
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
                                {categoryStreams.map(stream => (
                                    <div
                                        key={stream.id}
                                        className="glass-panel p-2.5 cursor-pointer hover:bg-glass-hover transition-all duration-200 group"
                                        onClick={() => handleStreamClick(stream)}
                                    >
                                        <div className="relative mb-2 overflow-hidden rounded">
                                            <img
                                                src={getThumbnailUrl(stream.thumbnail_url)}
                                                alt={stream.title}
                                                className="w-full aspect-video object-cover group-hover:scale-105 transition-transform duration-200"
                                            />
                                            <div className="absolute top-1.5 left-1.5 live-dot text-xs px-1.5 py-0.5">
                                                LIVE
                                            </div>
                                            <div className="absolute bottom-1.5 left-1.5 px-2 py-0.5 glass-button text-white text-xs font-medium rounded">
                                                {stream.viewer_count.toLocaleString()} viewers
                                            </div>
                                        </div>
                                        <div className="space-y-0.5">
                                            <h3 className="text-textPrimary font-medium text-sm line-clamp-1 group-hover:text-accent transition-colors">
                                                {stream.title}
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
                                ))}
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
                                </div>
                            </div>
                        ) : (
                            <>
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
                                    {displayStreams.map(stream => {
                                        const isFavorite = isFavoriteStreamer(stream.user_id);
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
                                                    <div className="absolute top-1.5 left-1.5 live-dot text-xs px-1.5 py-0.5">
                                                        LIVE
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
                                                        {stream.title}
                                                    </h3>
                                                    <div className="flex items-center gap-1">
                                                        <p className="text-textSecondary text-xs">{stream.user_name}</p>
                                                        {stream.broadcaster_type === 'partner' && (
                                                            <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 16 16" fill="#9146FF">
                                                                <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd"></path>
                                                            </svg>
                                                        )}
                                                    </div>
                                                    <p className="text-textSecondary text-xs line-clamp-1">{stream.game_name}</p>
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
            </div>
        </div>
    );
};

export default Home;
