import { useEffect, useState, useMemo } from 'react';
import { X, ArrowUpDown, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

interface BadgeVersion {
  id: string;
  image_url_1x: string;
  image_url_2x: string;
  image_url_4x: string;
  title: string;
  description: string;
  click_action: string | null;
  click_url: string | null;
}

interface BadgeMetadata {
  date_added: string | null;
  usage_stats: string | null;
  more_info: string | null;
  info_url: string;
}

interface BadgeWithMetadata extends BadgeVersion {
  set_id: string;
  badgebase_info?: BadgeMetadata;
}

type SortOption = 'date-newest' | 'date-oldest' | 'usage-high' | 'usage-low' | 'available' | 'coming-soon';

interface BadgeSet {
  set_id: string;
  versions: BadgeVersion[];
}

interface BadgesOverlayProps {
  onClose: () => void;
  onBadgeClick: (badge: BadgeVersion, setId: string) => void;
}

const BadgesOverlay = ({ onClose, onBadgeClick }: BadgesOverlayProps) => {
  const [badges, setBadges] = useState<BadgeSet[]>([]);
  const [badgesWithMetadata, setBadgesWithMetadata] = useState<BadgeWithMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>('date-newest');
  const [cacheAge, setCacheAge] = useState<number | null>(null);
  const [newBadgesCount, setNewBadgesCount] = useState(0);

  useEffect(() => {
    loadBadges();
  }, []);

  const loadBadges = async () => {
    try {
      setLoading(true);
      setError(null);

      // Try to load from cache first
      console.log('[BadgesOverlay] Checking for cached badges...');
      const cachedBadges = await invoke<{ data: BadgeSet[] } | null>('get_cached_global_badges');
      
      // Also check cache age
      const age = await invoke<number | null>('get_badge_cache_age');
      setCacheAge(age);
      
      if (cachedBadges && cachedBadges.data && cachedBadges.data.length > 0) {
        console.log('[BadgesOverlay] Found cached badges, loading immediately');
        setBadges(cachedBadges.data);
        
        // Flatten all badge versions
        const flattened = cachedBadges.data.flatMap(set => 
          set.versions.map(version => ({ ...version, set_id: set.set_id } as BadgeWithMetadata))
        );
        
        // Pre-load metadata from cache to enable instant sorting
        const badgesWithPreloadedMetadata = await Promise.all(
          flattened.map(async (badge) => {
            const cacheKey = `metadata:${badge.set_id}-v${badge.id}`;
            try {
              const cached = await invoke<{ data: any; position?: number } | null>('get_universal_cached_item', {
                cacheType: 'badge',
                id: cacheKey,
              });
              
              if (cached) {
                return {
                  ...badge,
                  badgebase_info: {
                    ...cached.data,
                    position: cached.position
                  }
                };
              }
            } catch (err) {
              // Silently fail for individual badges
            }
            return badge;
          })
        );
        
        setBadgesWithMetadata(badgesWithPreloadedMetadata);
        setLoading(false);
        
        // Fetch any missing metadata in the background
        fetchAllBadgeMetadata(badgesWithPreloadedMetadata);
        
        // Check for badges missing metadata (new badges that need BadgeBase data)
        checkAndFetchMissingMetadata();
        
        return;
      }

      // No cache available, fetch from API
      console.log('[BadgesOverlay] No cached badges, fetching from API...');
      
      // Get credentials
      const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
      
      // Fetch global badges (this will cache them)
      const response = await invoke<{ data: BadgeSet[] }>('fetch_global_badges', {
        clientId,
        token,
      });

      setBadges(response.data);
      
      // Flatten all badge versions
      const flattened = response.data.flatMap(set => 
        set.versions.map(version => ({ ...version, set_id: set.set_id } as BadgeWithMetadata))
      );
      
      setBadgesWithMetadata(flattened);
      
      // Fetch metadata for all badges in the background
      fetchAllBadgeMetadata(flattened);
    } catch (err) {
      console.error('Failed to load badges:', err);
      setError('Failed to load badges. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Check for badges that don't have metadata and fetch from BadgeBase
  const checkAndFetchMissingMetadata = async () => {
    try {
      console.log('[BadgesOverlay] Checking for badges missing metadata...');
      const missing = await invoke<[string, string][]>('get_badges_missing_metadata');
      
      if (missing.length > 0) {
        console.log(`[BadgesOverlay] Found ${missing.length} badges missing metadata, fetching...`);
        setNewBadgesCount(missing.length);
        
        // Fetch metadata for missing badges in batches
        const batchSize = 5;
        for (let i = 0; i < missing.length; i += batchSize) {
          const batch = missing.slice(i, i + batchSize);
          
          await Promise.allSettled(
            batch.map(([setId, version]) =>
              invoke<BadgeMetadata>('fetch_badge_metadata', {
                badgeSetId: setId,
                badgeVersion: version,
              })
            )
          );
          
          // Update progress
          setNewBadgesCount(Math.max(0, missing.length - (i + batchSize)));
        }
        
        console.log('[BadgesOverlay] Finished fetching missing badge metadata');
        setNewBadgesCount(0);
        
        // Reload metadata to update display
        if (badgesWithMetadata.length > 0) {
          fetchAllBadgeMetadata(badgesWithMetadata);
        }
      }
    } catch (err) {
      console.error('[BadgesOverlay] Error checking for missing metadata:', err);
    }
  };

  // Force refresh badges from Twitch API (bypasses cache)
  const forceRefreshBadges = async () => {
    try {
      setRefreshing(true);
      console.log('[BadgesOverlay] Force refreshing badges from Twitch API...');
      
      const response = await invoke<{ data: BadgeSet[] }>('force_refresh_global_badges');
      
      console.log(`[BadgesOverlay] Refreshed ${response.data.length} badge sets from Twitch API`);
      
      // Log all badge set IDs for debugging
      const badgeSetIds = response.data.map(s => s.set_id);
      console.log('[BadgesOverlay] Badge set IDs received:', badgeSetIds);
      
      // Count total versions
      const totalVersions = response.data.reduce((acc, set) => acc + set.versions.length, 0);
      console.log(`[BadgesOverlay] Total badge versions: ${totalVersions}`);
      
      // Log each badge set with its versions
      response.data.forEach(set => {
        console.log(`[BadgesOverlay] Set "${set.set_id}": ${set.versions.length} versions - ${set.versions.map(v => v.title).join(', ')}`);
      });
      
      setBadges(response.data);
      setCacheAge(0);
      
      // Flatten all badge versions
      const flattened = response.data.flatMap(set => 
        set.versions.map(version => ({ ...version, set_id: set.set_id } as BadgeWithMetadata))
      );
      
      console.log(`[BadgesOverlay] Flattened to ${flattened.length} badge items`);
      
      setBadgesWithMetadata(flattened);
      
      // Fetch metadata for all badges
      await fetchAllBadgeMetadata(flattened);
      
      // Check for and fetch any new badges that don't have metadata yet
      await checkAndFetchMissingMetadata();
      
    } catch (err) {
      console.error('Failed to refresh badges:', err);
      setError('Failed to refresh badges. Please try again.');
    } finally {
      setRefreshing(false);
    }
  };

  const fetchAllBadgeMetadata = async (badgeList: BadgeWithMetadata[]) => {
    setLoadingMetadata(true);
    
    // First, check cache for ALL badges at once to minimize API calls
    const metadataCache: Record<string, BadgeMetadata> = {};
    const uncachedBadges: BadgeWithMetadata[] = [];
    
    // Check cache for all badges first
    console.log('[BadgesOverlay] Checking cache for all badges first...');
    for (const badge of badgeList) {
      const cacheKey = `metadata:${badge.set_id}-v${badge.id}`;
      
      try {
        // Try to get from universal cache first
        const cached = await invoke<{ data: any; position?: number } | null>('get_universal_cached_item', {
          cacheType: 'badge',
          id: cacheKey,
        });
        
        if (cached) {
          // Found in cache, use it - include position from top level
          const metadata = cached.data as BadgeMetadata;
          // Add position from the cache entry itself
          (metadata as any).position = cached.position;
          metadataCache[`${badge.set_id}/${badge.id}`] = metadata;
          console.log(`[BadgesOverlay] Found ${cacheKey} in cache with position ${cached.position}`);
        } else {
          // Not in cache, add to list to fetch
          uncachedBadges.push(badge);
        }
      } catch (err) {
        // Cache check failed, add to list to fetch
        uncachedBadges.push(badge);
      }
    }
    
    // Update UI with cached data immediately
    if (Object.keys(metadataCache).length > 0) {
      const updatedBadges = badgeList.map(badge => ({
        ...badge,
        badgebase_info: metadataCache[`${badge.set_id}/${badge.id}`]
      }));
      setBadgesWithMetadata(updatedBadges);
    }
    
    console.log(`[BadgesOverlay] Found ${Object.keys(metadataCache).length} badges in cache, need to fetch ${uncachedBadges.length} from API`);
    
    // Now fetch only the uncached badges in batches
    if (uncachedBadges.length > 0) {
      const batchSize = 10; // Process 10 badges at a time
      
      for (let i = 0; i < uncachedBadges.length; i += batchSize) {
        const batch = uncachedBadges.slice(i, i + batchSize);
        
        const batchResults = await Promise.allSettled(
          batch.map(badge =>
            invoke<BadgeMetadata>('fetch_badge_metadata', {
              badgeSetId: badge.set_id,
              badgeVersion: badge.id,
            })
          )
        );
        
        // Process batch results
        batch.forEach((badge, index) => {
          const result = batchResults[index];
          if (result.status === 'fulfilled') {
            metadataCache[`${badge.set_id}/${badge.id}`] = result.value;
          }
        });
        
        // Update UI after each batch
        const updatedBadges = badgeList.map(badge => ({
          ...badge,
          badgebase_info: metadataCache[`${badge.set_id}/${badge.id}`]
        }));
        setBadgesWithMetadata(updatedBadges);
      }
    }
    
    setLoadingMetadata(false);
  };

  // Parse usage stats to get numeric value for sorting
  const parseUsageStats = (stats: string | null | undefined): number => {
    if (!stats) return 0;
    
    // Extract number from strings like "1,234 users seen with this badge" or "None users"
    const match = stats.match(/(\d+(?:,\d+)*)/);
    if (match) {
      return parseInt(match[1].replace(/,/g, ''), 10);
    }
    return 0;
  };

  // Parse date for sorting - handles format like "12 November 2025"
  const parseDate = (dateStr: string | null | undefined): number => {
    if (!dateStr) return 0;
    try {
      // Handle the "DD Month YYYY" format from BadgeBase
      // Example: "12 November 2025"
      const months: Record<string, number> = {
        'January': 0, 'February': 1, 'March': 2, 'April': 3,
        'May': 4, 'June': 5, 'July': 6, 'August': 7,
        'September': 8, 'October': 9, 'November': 10, 'December': 11
      };
      
      // Try to match "DD Month YYYY" format
      const match = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
      if (match) {
        const day = parseInt(match[1], 10);
        const monthName = match[2];
        const year = parseInt(match[3], 10);
        
        if (months.hasOwnProperty(monthName)) {
          const date = new Date(year, months[monthName], day);
          if (!isNaN(date.getTime())) {
            return date.getTime();
          }
        }
      }
      
      // Fallback: try parsing the date string directly
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        return parsed.getTime();
      }
      return 0;
    } catch {
      return 0;
    }
  };

  // Check badge availability status
  const getBadgeStatus = (badge: BadgeWithMetadata): 'available' | 'coming-soon' | 'expired' | null => {
    const moreInfo = badge.badgebase_info?.more_info;
    if (!moreInfo) return null;

    // Extract ISO timestamps from the more_info text
    const isoRegex = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z)?)/g;
    const timestamps = moreInfo.match(isoRegex);
    
    if (!timestamps || timestamps.length < 2) return null;

    try {
      // Assume first timestamp is start, last is end
      const startTime = new Date(timestamps[0]).getTime();
      const endTime = new Date(timestamps[timestamps.length - 1]).getTime();
      const now = Date.now();

      if (now < startTime) {
        return 'coming-soon';
      } else if (now >= startTime && now <= endTime) {
        return 'available';
      } else {
        return 'expired';
      }
    } catch {
      return null;
    }
  };

  const isBadgeAvailable = (badge: BadgeWithMetadata): boolean => {
    return getBadgeStatus(badge) === 'available';
  };

  const isBadgeComingSoon = (badge: BadgeWithMetadata): boolean => {
    return getBadgeStatus(badge) === 'coming-soon';
  };

  // Sort badges based on selected option - use useMemo to prevent re-sorting on every render
  const sortedBadges = useMemo(() => {
    console.log(`[BadgesOverlay] Sorting ${badgesWithMetadata.length} badges by ${sortBy}`);
    
    // Check if we can use pre-computed positions for date-newest sort
    // Only use positions if at least 90% of badges have them (to handle edge cases)
    const badgesWithPositions = badgesWithMetadata.filter(b => 
      b.badgebase_info && typeof (b.badgebase_info as any).position === 'number'
    ).length;
    
    const canUsePositions = sortBy === 'date-newest' && 
      badgesWithMetadata.length > 0 && 
      badgesWithPositions >= badgesWithMetadata.length * 0.9;
    
    if (canUsePositions) {
      console.log(`[BadgesOverlay] Using pre-computed positions for sorting (${badgesWithPositions}/${badgesWithMetadata.length} badges have positions)`);
      return [...badgesWithMetadata].sort((a, b) => {
        const aPos = (a.badgebase_info as any)?.position;
        const bPos = (b.badgebase_info as any)?.position;
        
        // If both have positions, use them
        if (typeof aPos === 'number' && typeof bPos === 'number') {
          return aPos - bPos;
        }
        
        // If only one has a position, sort by date for fair comparison
        const dateCompare = parseDate(b.badgebase_info?.date_added) - parseDate(a.badgebase_info?.date_added);
        if (dateCompare !== 0) return dateCompare;
        
        // Fallback to stable sort
        return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
      });
    }
    
    // Log sample badge data for debugging
    if (badgesWithMetadata.length > 0) {
      const sample = badgesWithMetadata[0];
      console.log('[BadgesOverlay] Sample badge:', {
        set_id: sample.set_id,
        id: sample.id,
        title: sample.title,
        date_added: sample.badgebase_info?.date_added,
        usage_stats: sample.badgebase_info?.usage_stats,
        more_info: sample.badgebase_info?.more_info
      });
    }
    
    return [...badgesWithMetadata].sort((a, b) => {
      switch (sortBy) {
        case 'available': {
          // Available badges first, then by newest
          const aAvailable = isBadgeAvailable(a) ? 1 : 0;
          const bAvailable = isBadgeAvailable(b) ? 1 : 0;
          if (aAvailable !== bAvailable) {
            return bAvailable - aAvailable;
          }
          // Secondary sort by date
          const dateCompare = parseDate(b.badgebase_info?.date_added) - parseDate(a.badgebase_info?.date_added);
          if (dateCompare !== 0) return dateCompare;
          // Tertiary sort by set_id and id for stability
          return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
        }
        case 'coming-soon': {
          // Coming soon badges first, then by newest
          const aComingSoon = isBadgeComingSoon(a) ? 1 : 0;
          const bComingSoon = isBadgeComingSoon(b) ? 1 : 0;
          if (aComingSoon !== bComingSoon) {
            return bComingSoon - aComingSoon;
          }
          // Secondary sort by date
          const dateCompare = parseDate(b.badgebase_info?.date_added) - parseDate(a.badgebase_info?.date_added);
          if (dateCompare !== 0) return dateCompare;
          // Tertiary sort by set_id and id for stability
          return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
        }
        case 'date-newest': {
          const dateCompare = parseDate(b.badgebase_info?.date_added) - parseDate(a.badgebase_info?.date_added);
          if (dateCompare !== 0) return dateCompare;
          // Fallback to stable sort
          return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
        }
        case 'date-oldest': {
          const dateCompare = parseDate(a.badgebase_info?.date_added) - parseDate(b.badgebase_info?.date_added);
          if (dateCompare !== 0) return dateCompare;
          // Fallback to stable sort
          return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
        }
        case 'usage-high': {
          const usageCompare = parseUsageStats(b.badgebase_info?.usage_stats) - parseUsageStats(a.badgebase_info?.usage_stats);
          if (usageCompare !== 0) return usageCompare;
          // Fallback to stable sort
          return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
        }
        case 'usage-low': {
          const usageCompare = parseUsageStats(a.badgebase_info?.usage_stats) - parseUsageStats(b.badgebase_info?.usage_stats);
          if (usageCompare !== 0) return usageCompare;
          // Fallback to stable sort
          return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
        }
        default:
          return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
      }
    });
  }, [badgesWithMetadata, sortBy]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm group">
      {/* Hover-sensitive background overlay */}
      <div 
        className="absolute inset-0 group-hover:pointer-events-none"
        onClick={onClose}
      />
      
      <div className="bg-secondary border border-borderSubtle rounded-lg shadow-2xl w-[90vw] h-[85vh] max-w-7xl flex flex-col relative z-10">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-borderSubtle">
          <div>
            <h2 className="text-xl font-bold text-textPrimary">Twitch Global Badges</h2>
            <p className="text-sm text-textSecondary mt-1">
              Click on any badge to view detailed information
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-glass rounded-lg transition-colors"
            title="Close"
          >
            <X size={20} className="text-textSecondary" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent mx-auto mb-4"></div>
                <p className="text-textSecondary">Loading badges...</p>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <p className="text-red-400 mb-4">{error}</p>
                <button
                  onClick={loadBadges}
                  className="px-4 py-2 bg-accent hover:bg-accent/80 rounded-lg transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {!loading && !error && sortedBadges.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <p className="text-textSecondary">No badges found</p>
            </div>
          )}

          {!loading && !error && sortedBadges.length > 0 && (
            <>
              {/* Sort Controls */}
              <div className="flex items-center gap-3 mb-6">
                <div className="flex items-center gap-2 text-textSecondary">
                  <ArrowUpDown size={16} />
                  <span className="text-sm font-medium">Sort by:</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSortBy('date-newest')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      sortBy === 'date-newest'
                        ? 'bg-accent text-white'
                        : 'bg-glass text-textSecondary hover:bg-glass/80'
                    }`}
                  >
                    Newest First
                  </button>
                  <button
                    onClick={() => setSortBy('date-oldest')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      sortBy === 'date-oldest'
                        ? 'bg-accent text-white'
                        : 'bg-glass text-textSecondary hover:bg-glass/80'
                    }`}
                  >
                    Oldest First
                  </button>
                  <button
                    onClick={() => setSortBy('usage-high')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      sortBy === 'usage-high'
                        ? 'bg-accent text-white'
                        : 'bg-glass text-textSecondary hover:bg-glass/80'
                    }`}
                  >
                    Most Used
                  </button>
                  <button
                    onClick={() => setSortBy('usage-low')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      sortBy === 'usage-low'
                        ? 'bg-accent text-white'
                        : 'bg-glass text-textSecondary hover:bg-glass/80'
                    }`}
                  >
                    Least Used
                  </button>
                  <button
                    onClick={() => setSortBy('available')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors flex items-center gap-2 ${
                      sortBy === 'available'
                        ? 'bg-green-600 text-white'
                        : 'bg-glass text-textSecondary hover:bg-glass/80'
                    }`}
                  >
                    <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                    Available Now
                  </button>
                  <button
                    onClick={() => setSortBy('coming-soon')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors flex items-center gap-2 ${
                      sortBy === 'coming-soon'
                        ? 'bg-blue-600 text-white'
                        : 'bg-glass text-textSecondary hover:bg-glass/80'
                    }`}
                  >
                    <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
                    Coming Soon
                  </button>
                </div>
              {loadingMetadata && (
                  <div className="ml-auto flex items-center gap-2 text-textSecondary text-sm">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-accent"></div>
                    <span>Loading badge data...</span>
                  </div>
                )}
                {newBadgesCount > 0 && !loadingMetadata && (
                  <div className="ml-auto flex items-center gap-2 text-yellow-500 text-sm">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-yellow-500"></div>
                    <span>Fetching {newBadgesCount} new badge{newBadgesCount !== 1 ? 's' : ''}...</span>
                  </div>
                )}
                {!loadingMetadata && newBadgesCount === 0 && (
                  <div className="ml-auto flex items-center gap-2">
                    {cacheAge !== null && cacheAge > 0 && (
                      <span className="text-textSecondary text-xs">
                        Cache age: {cacheAge} day{cacheAge !== 1 ? 's' : ''}
                      </span>
                    )}
                    <button
                      onClick={forceRefreshBadges}
                      disabled={refreshing}
                      className="flex items-center gap-1 px-2 py-1 bg-glass hover:bg-glass/80 rounded text-xs text-textSecondary hover:text-textPrimary transition-colors disabled:opacity-50"
                      title="Force refresh badges from Twitch API"
                    >
                      <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
                      {refreshing ? 'Refreshing...' : 'Refresh'}
                    </button>
                  </div>
                )}
              </div>

              {/* Badge Grid */}
              <div className="grid grid-cols-8 gap-6">
                {sortedBadges.map((badge, index) => {
                  const isAvailable = isBadgeAvailable(badge);
                  const isComingSoon = isBadgeComingSoon(badge);
                  return (
                    <button
                      key={`${badge.set_id}-${badge.id}-${index}`}
                      onClick={() => onBadgeClick(badge, badge.set_id)}
                      className={`flex flex-col items-center gap-2 p-3 rounded-lg hover:bg-glass transition-all duration-200 group relative ${
                        isAvailable ? 'ring-2 ring-green-500/50' : isComingSoon ? 'ring-2 ring-blue-500/50' : ''
                      }`}
                      title={badge.title}
                    >
                      <div className={`w-18 h-18 flex items-center justify-center bg-glass rounded-lg group-hover:scale-110 transition-transform duration-200 ${
                        isAvailable ? 'shadow-[0_0_20px_rgba(34,197,94,0.4)]' : 
                        isComingSoon ? 'shadow-[0_0_20px_rgba(59,130,246,0.4)]' : ''
                      }`}>
                        <img
                          src={badge.image_url_4x}
                          alt={badge.title}
                          className="w-16 h-16 object-contain"
                          loading="lazy"
                        />
                      </div>
                      {isAvailable && (
                        <span className="absolute top-1 right-1 w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                      )}
                      {isComingSoon && (
                        <span className="absolute top-1 right-1 w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
                      )}
                      <span className="text-xs text-textSecondary text-center line-clamp-2 group-hover:text-textPrimary transition-colors">
                        {badge.title}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default BadgesOverlay;
