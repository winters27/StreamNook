import { useEffect, useRef, useCallback, useState } from 'react';
import { useAppStore } from '../stores/AppStore';
import { Heart } from 'lucide-react';
import LoadingWidget from './LoadingWidget';

const LiveOverlay = () => {
  const { 
    followedStreams, 
    recommendedStreams, 
    loadFollowedStreams, 
    loadRecommendedStreams, 
    loadMoreRecommendedStreams,
    startStream, 
    isAuthenticated,
    hasMoreRecommended,
    isLoadingMore,
    toggleFavoriteStreamer,
    isFavoriteStreamer,
    loginToTwitch,
    isLoading
  } = useAppStore();
  
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const [animatingHearts, setAnimatingHearts] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadFollowedStreams();
    loadRecommendedStreams();
  }, [loadFollowedStreams, loadRecommendedStreams]);

  const getThumbnailUrl = (url: string) => {
    // Replace {width} and {height} placeholders with actual dimensions
    // Using HD 1280x720 for crisp quality when displayed
    return url.replace('{width}', '1280').replace('{height}', '720');
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

  // Sort followed streams to show favorites first
  const sortedFollowedStreams = [...followedStreams].sort((a, b) => {
    const aIsFavorite = isFavoriteStreamer(a.user_id);
    const bIsFavorite = isFavoriteStreamer(b.user_id);
    
    if (aIsFavorite && !bIsFavorite) return -1;
    if (!aIsFavorite && bIsFavorite) return 1;
    return 0;
  });

  const displayStreams = followedStreams.length > 0 ? sortedFollowedStreams : recommendedStreams;
  const showingRecommended = followedStreams.length === 0 && recommendedStreams.length > 0;
  const showingFollowed = followedStreams.length > 0;

  const handleScroll = useCallback(() => {
    if (!showingRecommended || !hasMoreRecommended || isLoadingMore || loadingRef.current) {
      return;
    }

    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const scrollPercentage = (scrollTop + clientHeight) / scrollHeight;

    // Load more when user scrolls to 80% of the content
    if (scrollPercentage > 0.8) {
      loadingRef.current = true;
      loadMoreRecommendedStreams().finally(() => {
        loadingRef.current = false;
      });
    }
  }, [showingRecommended, hasMoreRecommended, isLoadingMore, loadMoreRecommendedStreams]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-6 bg-background scrollbar-thin relative">
      {isLoading && !isAuthenticated && (
        <LoadingWidget useFunnyMessages={true} />
      )}
      {displayStreams.length === 0 ? (
        <div className="flex items-center justify-center h-full">
          <div className="text-center glass-panel p-8 max-w-md">
            <h2 className="text-xl font-bold text-textPrimary mb-2">No Live Streams</h2>
            <p className="text-textSecondary mb-4">
              {isAuthenticated 
                ? "None of your followed channels are currently live. Check back later!"
                : "Log in to see your followed channels and access chat features."}
            </p>
            {!isAuthenticated && (
              <button
                onClick={loginToTwitch}
                disabled={isLoading}
                className="flex items-center justify-center gap-2 px-6 py-3 glass-button hover:bg-glass-hover text-textPrimary font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed mx-auto"
              >
                <svg 
                  fill="currentColor" 
                  viewBox="0 0 512 512" 
                  xmlns="http://www.w3.org/2000/svg"
                  className="w-5 h-5 text-[#9146FF]"
                >
                  <path d="M80,32,48,112V416h96v64h64l64-64h80L464,304V32ZM416,288l-64,64H256l-64,64V352H112V80H416Z"/>
                  <rect x="320" y="143" width="48" height="129"/>
                  <rect x="208" y="143" width="48" height="129"/>
                </svg>
                <span>{isLoading ? 'Logging in...' : 'Login to Twitch'}</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          {showingRecommended && (
            <div className="mb-4">
              <h2 className="text-2xl font-bold text-textPrimary mb-2">Recommended Channels</h2>
              <p className="text-textSecondary">
                {isAuthenticated 
                  ? "None of your followed channels are live right now. Here are some popular streams:"
                  : "Popular live streams on Twitch:"}
              </p>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {displayStreams.map(stream => {
              const isFavorite = isFavoriteStreamer(stream.user_id);
              return (
                <div 
                  key={stream.id} 
                  className="glass-panel p-3 cursor-pointer hover:bg-glass-hover transition-all duration-200 group relative"
                  onClick={() => startStream(stream.user_login)}
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
                    {showingFollowed && (
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
          {showingRecommended && isLoadingMore && (
            <div className="flex justify-center items-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
            </div>
          )}
          {showingRecommended && !hasMoreRecommended && displayStreams.length > 0 && (
            <div className="text-center py-8">
              <p className="text-textSecondary text-sm">No more streams to load</p>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default LiveOverlay;
