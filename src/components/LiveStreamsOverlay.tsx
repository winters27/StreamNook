import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/AppStore';
import { X, Search, Grid3x3, ArrowLeft, Heart } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { TwitchStream, TwitchCategory } from '../types';

const LiveStreamsOverlay = () => {
  const { 
    showLiveStreamsOverlay, 
    setShowLiveStreamsOverlay, 
    followedStreams, 
    recommendedStreams,
    loadFollowedStreams,
    loadRecommendedStreams,
    startStream,
    isAuthenticated,
    toggleFavoriteStreamer,
    isFavoriteStreamer
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

  useEffect(() => {
    if (showLiveStreamsOverlay) {
      // Only load streams, don't reset state
      loadFollowedStreams();
      loadRecommendedStreams();
    }
  }, [showLiveStreamsOverlay, loadFollowedStreams, loadRecommendedStreams]);
  
  // Reset state when overlay opens
  useEffect(() => {
    if (showLiveStreamsOverlay) {
      setSearchQuery('');
      setSearchResults([]);
      setActiveTab('following');
      setSelectedCategory(null);
    }
  }, [showLiveStreamsOverlay]);

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
    }
  };

  if (!showLiveStreamsOverlay) return null;

  const getThumbnailUrl = (url: string) => {
    // Using HD 1280x720 for crisp quality when displayed in the overlay
    return url.replace('{width}', '1280').replace('{height}', '720');
  };

  const getGameBoxArt = (url: string) => {
    // Using high resolution 1200x1600 for crisp quality when displayed large
    return url.replace('{width}', '1200').replace('{height}', '1600');
  };

  const handleStreamClick = (stream: TwitchStream) => {
    startStream(stream.user_login, stream);
    setShowLiveStreamsOverlay(false);
  };

  const handleFavoriteClick = (e: React.MouseEvent, userId: string) => {
    e.stopPropagation(); // Prevent stream click
    
    const isFavorite = isFavoriteStreamer(userId);
    
    // If unfavoriting, trigger animation
    if (isFavorite) {
      setAnimatingHearts(prev => new Set(prev).add(userId));
      
      // Remove from animating set after animation completes
      setTimeout(() => {
        setAnimatingHearts(prev => {
          const newSet = new Set(prev);
          newSet.delete(userId);
          return newSet;
        });
        toggleFavoriteStreamer(userId);
      }, 1000); // Animation duration
    } else {
      // If favoriting, just toggle immediately
      toggleFavoriteStreamer(userId);
    }
  };

  // Sort streams to show favorites first
  const sortStreamsByFavorites = (streams: TwitchStream[]) => {
    return [...streams].sort((a, b) => {
      const aIsFavorite = isFavoriteStreamer(a.user_id);
      const bIsFavorite = isFavoriteStreamer(b.user_id);
      
      if (aIsFavorite && !bIsFavorite) return -1;
      if (!aIsFavorite && bIsFavorite) return 1;
      return 0;
    });
  };

  const displayStreams = activeTab === 'following' 
    ? sortStreamsByFavorites(followedStreams)
    : activeTab === 'recommended' 
    ? recommendedStreams 
    : activeTab === 'category'
    ? categoryStreams
    : searchResults;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 group">
      {/* Hover-sensitive background overlay */}
      <div 
        className="absolute inset-0 group-hover:pointer-events-none"
        onClick={() => setShowLiveStreamsOverlay(false)}
      />
      
      <div className="glass-panel backdrop-blur-lg rounded-lg w-[90%] h-[85%] flex flex-col shadow-2xl relative z-10">
        {/* Header */}
        <div className="flex flex-col gap-3 p-4 border-b border-borderSubtle">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {activeTab === 'category' && selectedCategory && (
                <button
                  onClick={handleBackToBrowse}
                  className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all"
                  title="Back to Browse"
                >
                  <ArrowLeft size={20} />
                </button>
              )}
              <h2 className="text-xl font-bold text-textPrimary">
                {activeTab === 'category' && selectedCategory 
                  ? selectedCategory.name 
                  : 'Live Streams'}
              </h2>
            </div>
            
            <button
              onClick={() => setShowLiveStreamsOverlay(false)}
              className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all"
              title="Close"
            >
              <X size={20} />
            </button>
          </div>

          {/* Search Bar */}
          {activeTab !== 'browse' && activeTab !== 'category' && (
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyPress={handleSearchKeyPress}
                  placeholder="Search channels..."
                  className="w-full glass-input text-textPrimary text-sm px-3 py-2 pl-10 placeholder-textSecondary"
                />
                <Search size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-textSecondary" />
              </div>
              <button
                onClick={handleSearch}
                disabled={!searchQuery.trim() || isSearching}
                className="px-4 py-2 glass-button text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSearching ? 'Searching...' : 'Search'}
              </button>
            </div>
          )}

          {/* Tabs */}
          {activeTab !== 'category' && (
            <div className="flex gap-2">
              <button
                onClick={() => setActiveTab('following')}
                className={`px-4 py-2 text-sm font-medium rounded transition-all ${
                  activeTab === 'following'
                    ? 'glass-button text-white'
                    : 'bg-glass text-textSecondary hover:bg-glass-hover'
                }`}
              >
                Following ({followedStreams.length})
              </button>
              <button
                onClick={() => setActiveTab('recommended')}
                className={`px-4 py-2 text-sm font-medium rounded transition-all ${
                  activeTab === 'recommended'
                    ? 'glass-button text-white'
                    : 'bg-glass text-textSecondary hover:bg-glass-hover'
                }`}
              >
                Recommended ({recommendedStreams.length})
              </button>
              <button
                onClick={handleBrowseClick}
                className={`px-4 py-2 text-sm font-medium rounded transition-all flex items-center gap-2 ${
                  activeTab === 'browse'
                    ? 'glass-button text-white'
                    : 'bg-glass text-textSecondary hover:bg-glass-hover'
                }`}
              >
                <Grid3x3 size={16} />
                Browse
              </button>
              {searchResults.length > 0 && (
                <button
                  onClick={() => setActiveTab('search')}
                  className={`px-4 py-2 text-sm font-medium rounded transition-all ${
                    activeTab === 'search'
                      ? 'glass-button text-white'
                      : 'bg-glass text-textSecondary hover:bg-glass-hover'
                  }`}
                >
                  Search Results ({searchResults.length})
                </button>
              )}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
          {/* Browse View - Game Categories */}
          {activeTab === 'browse' && (
            <>
              {isLoadingGames ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-16 w-16 border-4 border-glass border-t-accent mx-auto mb-4" />
                    <p className="text-textSecondary text-sm font-medium">Loading categories...</p>
                  </div>
                </div>
              ) : topGames.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center glass-panel p-8 max-w-md">
                    <h3 className="text-lg font-bold text-textPrimary mb-2">No Categories Found</h3>
                    <p className="text-textSecondary">Could not load game categories at this time.</p>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
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
                        {game.tags && game.tags.length > 0 && (
                          <div className="absolute top-2 left-2">
                            <span className="px-2 py-1 bg-accent text-white text-xs font-bold rounded">
                              {game.tags[0]}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="p-3 space-y-1">
                        <h3 className="text-textPrimary font-medium text-sm line-clamp-2 group-hover:text-accent transition-colors">
                          {game.name}
                        </h3>
                        {game.viewer_count !== undefined && (
                          <p className="text-textSecondary text-xs">
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
                    <div className="animate-spin rounded-full h-16 w-16 border-4 border-glass border-t-accent mx-auto mb-4" />
                    <p className="text-textSecondary text-sm font-medium">Loading streams...</p>
                  </div>
                </div>
              ) : categoryStreams.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center glass-panel p-8 max-w-md">
                    <h3 className="text-lg font-bold text-textPrimary mb-2">No Live Streams</h3>
                    <p className="text-textSecondary">
                      No one is currently streaming {selectedCategory?.name}.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {categoryStreams.map(stream => (
                    <div 
                      key={stream.id} 
                      className="glass-panel p-3 cursor-pointer hover:bg-glass-hover transition-all duration-200 group"
                      onClick={() => handleStreamClick(stream)}
                    >
                      <div className="relative mb-3 overflow-hidden rounded">
                        <img 
                          src={getThumbnailUrl(stream.thumbnail_url)} 
                          alt={stream.title} 
                          className="w-full aspect-video object-cover group-hover:scale-105 transition-transform duration-200"
                        />
                        <div className="absolute top-2 left-2 live-dot">
                          LIVE
                        </div>
                        <div className="absolute bottom-2 left-2 px-2 py-1 glass-button text-white text-xs font-medium rounded">
                          {stream.viewer_count.toLocaleString()} viewers
                        </div>
                      </div>
                      <div className="space-y-1">
                        <h3 className="text-textPrimary font-medium text-sm line-clamp-2 group-hover:text-accent transition-colors">
                          {stream.title}
                        </h3>
                        <div className="flex items-center gap-1">
                          <p className="text-textSecondary text-xs">{stream.user_name}</p>
                          {stream.broadcaster_type === 'partner' && (
                            <div title="Verified Partner">
                              <svg 
                                className="w-3 h-3 flex-shrink-0" 
                                viewBox="0 0 16 16" 
                                fill="#9146FF"
                              >
                                <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd"></path>
                              </svg>
                            </div>
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
                    <div className="animate-spin rounded-full h-16 w-16 border-4 border-glass border-t-accent mx-auto mb-4" />
                    <p className="text-textSecondary text-sm font-medium">Searching...</p>
                  </div>
                </div>
              ) : !isAuthenticated && activeTab === 'following' ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center glass-panel p-8 max-w-md">
                    <h3 className="text-lg font-bold text-textPrimary mb-2">Not Logged In</h3>
                    <p className="text-textSecondary">
                      Please log in to Twitch to see your followed streams.
                    </p>
                  </div>
                </div>
              ) : displayStreams.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center glass-panel p-8 max-w-md">
                    <h3 className="text-lg font-bold text-textPrimary mb-2">
                      {activeTab === 'following' 
                        ? 'No Live Streams' 
                        : activeTab === 'recommended' 
                        ? 'No Recommended Streams'
                        : 'No Results Found'}
                    </h3>
                    <p className="text-textSecondary">
                      {activeTab === 'following' 
                        ? 'None of your followed channels are currently live.'
                        : activeTab === 'recommended'
                        ? 'Could not load recommended streams at this time.'
                        : `No channels found matching "${searchQuery}". Try a different search term.`}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {displayStreams.map(stream => {
                    const isFavorite = isFavoriteStreamer(stream.user_id);
                    return (
                      <div 
                        key={stream.id} 
                        className={`glass-panel p-3 cursor-pointer hover:bg-glass-hover transition-all duration-200 group relative ${stream.has_shared_chat === true ? 'iridescent-border' : ''}`}
                        onClick={() => handleStreamClick(stream)}
                      >
                        <div className="relative mb-3 overflow-hidden rounded">
                          <img 
                            src={getThumbnailUrl(stream.thumbnail_url)} 
                            alt={stream.title} 
                            className="w-full aspect-video object-cover group-hover:scale-105 transition-transform duration-200"
                          />
                          <div className="absolute top-2 left-2 live-dot">
                            LIVE
                          </div>
                          <div className="absolute bottom-2 left-2 px-2 py-1 glass-button text-white text-xs font-medium rounded">
                            {stream.viewer_count.toLocaleString()} viewers
                          </div>
                          {activeTab === 'following' && (
                            <button
                              onClick={(e) => handleFavoriteClick(e, stream.user_id)}
                              className={`absolute bottom-2 right-2 p-1.5 rounded transition-all ${
                                isFavorite 
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
                        <div className="space-y-1">
                          <h3 className="text-textPrimary font-medium text-sm line-clamp-2 group-hover:text-accent transition-colors">
                            {stream.title}
                          </h3>
                          <div className="flex items-center gap-1">
                            <p className="text-textSecondary text-xs">{stream.user_name}</p>
                            {stream.broadcaster_type === 'partner' && (
                              <div title="Verified Partner">
                                <svg 
                                  className="w-3 h-3 flex-shrink-0" 
                                  viewBox="0 0 16 16" 
                                  fill="#9146FF"
                                >
                                  <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd"></path>
                                </svg>
                              </div>
                            )}
                          </div>
                          <p className="text-textSecondary text-xs">{stream.game_name}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default LiveStreamsOverlay;
