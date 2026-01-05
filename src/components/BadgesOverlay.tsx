import { useEffect, useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowUpDown, RefreshCw, Check, Trophy, Award, ChevronUp } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { getAllUserBadgesWithEarned } from '../services/badgeService';

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
  const { isAuthenticated, currentUser, currentStream } = useAppStore();
  const [badges, setBadges] = useState<BadgeSet[]>([]);
  const [badgesWithMetadata, setBadgesWithMetadata] = useState<BadgeWithMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>('date-newest');
  const [cacheAge, setCacheAge] = useState<number | null>(null);
  const [newBadgesCount, setNewBadgesCount] = useState(0);
  const [showRankList, setShowRankList] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number } | null>(null);
  const rankButtonRef = useRef<HTMLButtonElement>(null);
  
  // User's collected global badges (Set of "setId_version" keys)
  const [collectedBadgeKeys, setCollectedBadgeKeys] = useState<Set<string>>(new Set());
  const [loadingUserBadges, setLoadingUserBadges] = useState(false);

  useEffect(() => {
    loadBadges();
  }, []);

  // Load user's collected badges when authenticated
  useEffect(() => {
    if (isAuthenticated && currentUser) {
      loadUserBadges();
    }
  }, [isAuthenticated, currentUser]);

  // Load user's badges using unified badge service
  const loadUserBadges = async () => {
    if (!currentUser) return;
    
    setLoadingUserBadges(true);
    try {
      const channelId = currentStream?.user_id || currentUser.user_id;
      const channelName = currentStream?.user_login || currentUser.login || currentUser.username;
      
      // Use unified badge service with full earned badge collection
      const badgeData = await getAllUserBadgesWithEarned(
        currentUser.user_id,
        currentUser.login || currentUser.username,
        channelId,
        channelName
      );
      
      // Create a Set of badge keys the user owns (display badges + earned badges)
      const keys = new Set<string>();
      
      // Add display badges
      badgeData.displayBadges?.forEach((badge: any) => {
        if (badge && badge.setID && badge.version) {
          keys.add(`${badge.setID}_${badge.version}`);
        }
      });
      
      // Add earned badges
      badgeData.earnedBadges?.forEach((badge: any) => {
        if (badge && badge.setID && badge.version) {
          keys.add(`${badge.setID}_${badge.version}`);
        }
      });
      
      setCollectedBadgeKeys(keys);
      console.log(`[BadgesOverlay] User has ${keys.size} collected badges`);
    } catch (err) {
      console.error('[BadgesOverlay] Failed to load user badges:', err);
    } finally {
      setLoadingUserBadges(false);
    }
  };

  // Check if user has collected a specific badge
  const isCollected = (badge: BadgeWithMetadata): boolean => {
    return collectedBadgeKeys.has(`${badge.set_id}_${badge.id}`);
  };

  // Badge set IDs that are NOT true global collectibles and shouldn't count towards collection
  // These badges are either: channel-specific, role-based, paid-only, or not earnable by regular users
  const channelSpecificBadgeSets = new Set([
    // Channel-specific badges
    'subscriber',          // Channel subscriptions (1-month, 2-month, 3-month, 6-month, etc.)
    'sub-gifter',          // Gift sub badges (varies by count)
    'sub-gift-leader',     // Sub gift leaderboard
    'founder',             // Channel founder
    'vip',                 // Channel VIP
    'moderator',           // Channel moderator
    'artist-badge',        // Channel artist
    'moments',             // Channel moments
    
    // Cheering / Bits badges
    'bits',                // Bits cheering badges (Cheer 1, 100, 1000, 5000, 10000, 100000)
    'bits-leader',         // Bits leaderboard
    'bits-charity',        // Bits for charity
    'anonymous-cheerer',   // Anonymous cheering
    
    // Hype Train
    'hype-train',          // Hype train conductors
    
    // Predictions
    'predictions',         // Predicted badges (blue/pink)
    
    // GIF-related badges
    'sub-gift-count',      // GIF subs
    'clip-champ',          // Clips Leader
    'clips-leader',        // Clips Leader alternate
    'gift-leader',         // GIF Leader / GIFter Leader
    'gifter-leader',       // GIFter Leader alternate
    
    // Twitch Staff & Special Roles (not earnable by regular users)
    'staff',               // Twitch staff
    'admin',               // Twitch admin
    'global_mod',          // Global mod
    'broadcaster',         // Broadcaster badge
    'verified-moderator',  // Verified Moderator
    'automod',             // AutoMod
    'chatbot',             // ChatBot badge
    'twitch-intern',       // Twitch Intern badges
    'lead-moderator',      // Lead Moderator
    
    // Paid / Subscription-based badges (not globally earnable)
    'turbo',               // Twitch Turbo
    'prime',               // Prime Gaming
    'prime-gaming',        // Prime Gaming alternate
    
    // Ambassador / Partner program badges
    'ambassador',          // Twitch Ambassador
    'partner',             // Twitch Partner
    
    // Anniversary badges
    'twitchanniversary',   // Twitch Anniversary
    'twitch-anniversary',  // Twitch Anniversary alternate
    
    // Developer badges
    'game-developer',      // Game Developer badge
    'extension',           // Extension developer
    
    // Accessibility badges (not collectibles)
    'no_audio',            // Watching without audio
    'no_video',            // Listening only
    
    // Event-specific / Limited badges that aren't collectible
    'survival-cup-4',      // Survival Cup 4
  ]);

  // Check if a badge is a true "global" collectible badge
  const isGlobalCollectibleBadge = (badge: BadgeWithMetadata): boolean => {
    return !channelSpecificBadgeSets.has(badge.set_id);
  };

  // Filter badges to only include true global collectibles
  const globalCollectibleBadges = useMemo(() => {
    return badgesWithMetadata.filter(isGlobalCollectibleBadge);
  }, [badgesWithMetadata]);

  // Count collected global badges
  const collectedCount = useMemo(() => {
    if (collectedBadgeKeys.size === 0) return 0;
    return globalCollectibleBadges.filter(badge => isCollected(badge)).length;
  }, [globalCollectibleBadges, collectedBadgeKeys]);

  // Total global collectible badges
  const totalGlobalBadges = globalCollectibleBadges.length;

  // Collection rank system based on percentage collected - Epic tier system
  const getCollectionRank = (collected: number, total: number) => {
    if (total === 0) return null;
    const percentage = (collected / total) * 100;
    
    // 10 Epic rank tiers with unique themes
    if (percentage >= 95) {
      return {
        title: 'APEX',
        tier: 'apex',
        description: 'The final form',
        animationClass: 'rank-apex',
        colors: {
          from: '#ff0080',
          via: '#7928ca',
          to: '#00d4ff',
          glow: 'rgba(121, 40, 202, 0.5)',
          bg: 'from-[#ff0080]/20 via-[#7928ca]/20 to-[#00d4ff]/20',
          border: '[#7928ca]/50',
          sparkle: ['#ff0080', '#7928ca', '#00d4ff', '#ff6b6b', '#feca57']
        }
      };
    } else if (percentage >= 85) {
      return {
        title: 'TITAN',
        tier: 'titan',
        description: 'Diamond incarnate',
        animationClass: 'rank-titan',
        colors: {
          from: '#e8e8e8',
          via: '#c0c0c0',
          to: '#a8d8ea',
          glow: 'rgba(200, 200, 220, 0.5)',
          bg: 'from-[#e8e8e8]/15 via-[#c0c0c0]/15 to-[#a8d8ea]/15',
          border: '[#c0c0c0]/40',
          sparkle: ['#ffffff', '#e8e8e8', '#a8d8ea', '#ffd700']
        }
      };
    } else if (percentage >= 73) {
      return {
        title: 'AEON',
        tier: 'aeon',
        description: 'Cosmic wanderer',
        animationClass: 'rank-aeon',
        colors: {
          from: '#1a1a2e',
          via: '#4a0080',
          to: '#ffd700',
          glow: 'rgba(74, 0, 128, 0.4)',
          bg: 'from-[#1a1a2e]/20 via-[#4a0080]/20 to-[#ffd700]/10',
          border: '[#ffd700]/30',
          sparkle: ['#ffd700', '#4a0080', '#ffffff', '#ff6b6b']
        }
      };
    } else if (percentage >= 59) {
      return {
        title: 'NEXUS',
        tier: 'nexus',
        description: 'Grid architect',
        animationClass: 'rank-nexus',
        colors: {
          from: '#7c3aed',
          via: '#a855f7',
          to: '#c084fc',
          glow: 'rgba(124, 58, 237, 0.4)',
          bg: 'from-[#7c3aed]/15 via-[#a855f7]/15 to-[#c084fc]/15',
          border: '[#7c3aed]/40',
          sparkle: ['#7c3aed', '#a855f7', '#c084fc', '#e879f9']
        }
      };
    } else if (percentage >= 47) {
      return {
        title: 'AURORA',
        tier: 'aurora',
        description: 'Northern light bearer',
        animationClass: 'rank-aurora',
        colors: {
          from: '#14b8a6',
          via: '#a855f7',
          to: '#ec4899',
          glow: 'rgba(20, 184, 166, 0.35)',
          bg: 'from-[#14b8a6]/12 via-[#a855f7]/12 to-[#ec4899]/12',
          border: '[#14b8a6]/35',
          sparkle: ['#14b8a6', '#a855f7', '#ec4899', '#06b6d4']
        }
      };
    } else if (percentage >= 35) {
      return {
        title: 'VANGUARD',
        tier: 'vanguard',
        description: 'Chrome sentinel',
        animationClass: 'rank-vanguard',
        colors: {
          from: '#94a3b8',
          via: '#64748b',
          to: '#cbd5e1',
          glow: 'rgba(148, 163, 184, 0.35)',
          bg: 'from-[#94a3b8]/12 via-[#64748b]/12 to-[#cbd5e1]/12',
          border: '[#94a3b8]/35',
          sparkle: ['#94a3b8', '#cbd5e1', '#e2e8f0', '#f1f5f9']
        }
      };
    } else if (percentage >= 23) {
      return {
        title: 'PHANTOM',
        tier: 'phantom',
        description: 'Ethereal presence',
        animationClass: 'rank-phantom',
        colors: {
          from: '#06b6d4',
          via: '#22d3d1',
          to: '#67e8f9',
          glow: 'rgba(6, 182, 212, 0.35)',
          bg: 'from-[#06b6d4]/12 via-[#22d3d1]/12 to-[#67e8f9]/12',
          border: '[#06b6d4]/35',
          sparkle: ['#06b6d4', '#22d3d1', '#67e8f9', '#a5f3fc']
        }
      };
    } else if (percentage >= 13) {
      return {
        title: 'RONIN',
        tier: 'ronin',
        description: 'Blade of the void',
        animationClass: 'rank-ronin',
        colors: {
          from: '#3b82f6',
          via: '#60a5fa',
          to: '#0ea5e9',
          glow: 'rgba(59, 130, 246, 0.4)',
          bg: 'from-[#3b82f6]/15 via-[#60a5fa]/15 to-[#0ea5e9]/15',
          border: '[#3b82f6]/40',
          sparkle: ['#3b82f6', '#60a5fa', '#0ea5e9', '#38bdf8']
        }
      };
    } else if (percentage >= 6) {
      return {
        title: 'NOMAD',
        tier: 'nomad',
        description: 'Desert wanderer',
        animationClass: 'rank-nomad',
        colors: {
          from: '#78716c',
          via: '#a8a29e',
          to: '#d4a84b',
          glow: 'rgba(212, 168, 75, 0.25)',
          bg: 'from-[#78716c]/10 via-[#a8a29e]/10 to-[#d4a84b]/10',
          border: '[#d4a84b]/25',
          sparkle: ['#78716c', '#a8a29e', '#d4a84b', '#f5d0a9']
        }
      };
    } else if (percentage >= 0.1) {
      return {
        title: 'DRIFTER',
        tier: 'drifter',
        description: 'Signal in the static',
        animationClass: 'rank-drifter',
        colors: {
          from: '#6b7280',
          via: '#9ca3af',
          to: '#e5e7eb',
          glow: 'rgba(156, 163, 175, 0.2)',
          bg: 'from-[#6b7280]/8 via-[#9ca3af]/8 to-[#e5e7eb]/8',
          border: '[#9ca3af]/20',
          sparkle: ['#6b7280', '#9ca3af', '#e5e7eb', '#f3f4f6']
        }
      };
    }
    return null;
  };

  // Get current rank
  const currentRank = useMemo(() => {
    return getCollectionRank(collectedCount, totalGlobalBadges);
  }, [collectedCount, totalGlobalBadges]);

  // All ranks for display in ranks list - Epic 10-tier system
  const allRanks = [
    {
      title: 'APEX',
      requirement: '95%+',
      description: 'The final form',
      tier: 'apex',
      colors: { from: '#ff0080', via: '#7928ca', to: '#00d4ff' }
    },
    {
      title: 'TITAN',
      requirement: '85%+',
      description: 'Diamond incarnate',
      tier: 'titan',
      colors: { from: '#e8e8e8', via: '#c0c0c0', to: '#a8d8ea' }
    },
    {
      title: 'AEON',
      requirement: '73%+',
      description: 'Cosmic wanderer',
      tier: 'aeon',
      colors: { from: '#1a1a2e', via: '#4a0080', to: '#ffd700' }
    },
    {
      title: 'NEXUS',
      requirement: '59%+',
      description: 'Grid architect',
      tier: 'nexus',
      colors: { from: '#7c3aed', via: '#a855f7', to: '#c084fc' }
    },
    {
      title: 'AURORA',
      requirement: '47%+',
      description: 'Northern light bearer',
      tier: 'aurora',
      colors: { from: '#14b8a6', via: '#a855f7', to: '#ec4899' }
    },
    {
      title: 'VANGUARD',
      requirement: '35%+',
      description: 'Chrome sentinel',
      tier: 'vanguard',
      colors: { from: '#94a3b8', via: '#64748b', to: '#cbd5e1' }
    },
    {
      title: 'PHANTOM',
      requirement: '23%+',
      description: 'Ethereal presence',
      tier: 'phantom',
      colors: { from: '#06b6d4', via: '#22d3d1', to: '#67e8f9' }
    },
    {
      title: 'RONIN',
      requirement: '13%+',
      description: 'Blade of the void',
      tier: 'ronin',
      colors: { from: '#3b82f6', via: '#60a5fa', to: '#0ea5e9' }
    },
    {
      title: 'NOMAD',
      requirement: '6%+',
      description: 'Desert wanderer',
      tier: 'nomad',
      colors: { from: '#78716c', via: '#a8a29e', to: '#d4a84b' }
    },
    {
      title: 'DRIFTER',
      requirement: '0.1%+',
      description: 'Signal in the static',
      tier: 'drifter',
      colors: { from: '#6b7280', via: '#9ca3af', to: '#e5e7eb' }
    }
  ];

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

        // Pre-load ALL badge metadata from cache in ONE call (fast batch lookup)
        let badgesWithPreloadedMetadata: BadgeWithMetadata[] = flattened;
        try {
          const allBadgeCache = await invoke<Record<string, { data: any; position?: number }>>('get_all_universal_cached_items', {
            cacheType: 'badge',
          });

          if (allBadgeCache && Object.keys(allBadgeCache).length > 0) {
            console.log(`[BadgesOverlay] Loaded ${Object.keys(allBadgeCache).length} cached badge entries in single call`);
            badgesWithPreloadedMetadata = flattened.map(badge => {
              const cacheKey = `metadata:${badge.set_id}-v${badge.id}`;
              const cached = allBadgeCache[cacheKey];
              if (cached) {
                return {
                  ...badge,
                  badgebase_info: {
                    ...cached.data,
                    position: cached.position
                  }
                };
              }
              return badge;
            });
          }
        } catch (err) {
          console.error('[BadgesOverlay] Failed to batch load cache:', err);
        }

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

      // Fetch metadata for all badges with force=true to bypass cache
      await fetchAllBadgeMetadata(flattened, true);

      // Check for and fetch any new badges that don't have metadata yet
      await checkAndFetchMissingMetadata();

    } catch (err) {
      console.error('Failed to refresh badges:', err);
      setError('Failed to refresh badges. Please try again.');
    } finally {
      setRefreshing(false);
    }
  };

  const fetchAllBadgeMetadata = async (badgeList: BadgeWithMetadata[], forceRefresh: boolean = false) => {
    setLoadingMetadata(true);

    // First, load ALL badge cache in ONE call (fast batch lookup)
    const metadataCache: Record<string, BadgeMetadata> = {};
    let uncachedBadges: BadgeWithMetadata[] = [];

    // If force refresh, skip cache and fetch all badges fresh
    if (forceRefresh) {
      console.log('[BadgesOverlay] Force refresh requested, fetching ALL badge metadata from BadgeBase...');
      uncachedBadges = [...badgeList];
    } else {
      console.log('[BadgesOverlay] Batch loading all badge cache...');
      try {
        const allBadgeCache = await invoke<Record<string, { data: any; position?: number }>>('get_all_universal_cached_items', {
          cacheType: 'badge',
        });

        // Map badges to their cache entries
        for (const badge of badgeList) {
          const cacheKey = `metadata:${badge.set_id}-v${badge.id}`;
          const cached = allBadgeCache[cacheKey];

          if (cached) {
            const metadata = cached.data as BadgeMetadata;
            (metadata as any).position = cached.position;
            metadataCache[`${badge.set_id}/${badge.id}`] = metadata;
          } else {
            uncachedBadges.push(badge);
          }
        }

        console.log(`[BadgesOverlay] Found ${Object.keys(metadataCache).length} badges in cache (batch), need to fetch ${uncachedBadges.length} from API`);
      } catch (err) {
        console.error('[BadgesOverlay] Failed to batch load cache, falling back to uncached:', err);
        // If batch load fails, treat all as uncached
        uncachedBadges.push(...badgeList);
      }

      // Update UI with cached data immediately
      if (Object.keys(metadataCache).length > 0) {
        const updatedBadges = badgeList.map(badge => ({
          ...badge,
          badgebase_info: metadataCache[`${badge.set_id}/${badge.id}`]
        }));
        setBadgesWithMetadata(updatedBadges);
      }
    }

    // Now fetch badges from API (all badges if force refresh, or only uncached badges)
    if (uncachedBadges.length > 0) {
      const batchSize = 10; // Process 10 badges at a time

      for (let i = 0; i < uncachedBadges.length; i += batchSize) {
        const batch = uncachedBadges.slice(i, i + batchSize);

        const batchResults = await Promise.allSettled(
          batch.map(badge =>
            invoke<BadgeMetadata>('fetch_badge_metadata', {
              badgeSetId: badge.set_id,
              badgeVersion: badge.id,
              force: forceRefresh,
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

  // Parse date for sorting - handles multiple formats
  const parseDate = (dateStr: string | null | undefined): number => {
    if (!dateStr) return 0;
    try {
      // Month name mappings (full and abbreviated)
      const months: Record<string, number> = {
        'January': 0, 'February': 1, 'March': 2, 'April': 3,
        'May': 4, 'June': 5, 'July': 6, 'August': 7,
        'September': 8, 'October': 9, 'November': 10, 'December': 11,
        'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3,
        'Jun': 5, 'Jul': 6, 'Aug': 7,
        'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
      };

      // Try to match "DD Month YYYY" format (e.g., "12 November 2025")
      const fullMatch = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
      if (fullMatch) {
        const day = parseInt(fullMatch[1], 10);
        const monthName = fullMatch[2];
        const year = parseInt(fullMatch[3], 10);

        if (months.hasOwnProperty(monthName)) {
          const date = new Date(year, months[monthName], day);
          if (!isNaN(date.getTime())) {
            return date.getTime();
          }
        }
      }

      // Try to match abbreviated format "Mon D-D" or "Mon D - D" (e.g., "Dec 1-12" or "Dec 1 - 12")
      const abbrevMatch = dateStr.match(/(\w{3})\s+(\d{1,2})\s*-\s*(\d{1,2})/);
      if (abbrevMatch) {
        const monthAbbrev = abbrevMatch[1];
        const startDay = parseInt(abbrevMatch[2], 10);
        // Use current year since it's not provided
        const currentYear = new Date().getFullYear();

        if (months.hasOwnProperty(monthAbbrev)) {
          const date = new Date(currentYear, months[monthAbbrev], startDay);
          if (!isNaN(date.getTime())) {
            return date.getTime();
          }
        }
      }

      // Try to match "Month YYYY" format (e.g., "May 2016", "November 2025")
      // IMPORTANT: Must come BEFORE "Mon D" to prevent "2016" being parsed as day 20
      const monthYearMatch = dateStr.match(/^(\w+)\s+(\d{4})$/);
      if (monthYearMatch) {
        const monthName = monthYearMatch[1];
        const year = parseInt(monthYearMatch[2], 10);

        if (months.hasOwnProperty(monthName)) {
          // Use the 1st day of the month for sorting (earliest possible date in that month)
          const date = new Date(year, months[monthName], 1);
          if (!isNaN(date.getTime())) {
            return date.getTime();
          }
        }
      }

      // Try to match "Mon D" format (e.g., "Dec 1")
      const singleDayMatch = dateStr.match(/(\w{3})\s+(\d{1,2})(?!\s*-)/);
      if (singleDayMatch) {
        const monthAbbrev = singleDayMatch[1];
        const day = parseInt(singleDayMatch[2], 10);
        const currentYear = new Date().getFullYear();

        if (months.hasOwnProperty(monthAbbrev)) {
          const date = new Date(currentYear, months[monthAbbrev], day);
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

  // Decode HTML entities like &#8211; → – in text
  const decodeHtmlEntities = (text: string): string => {
    let result = text;

    // Decode numeric HTML entities (&#NNNN;)
    result = result.replace(/&#(\d+);/g, (_match, dec) => {
      const code = parseInt(dec, 10);
      return String.fromCharCode(code);
    });

    // Decode hex HTML entities (&#xHHHH;)
    result = result.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => {
      const code = parseInt(hex, 16);
      return String.fromCharCode(code);
    });

    // Decode common named entities
    const entities: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
      '&nbsp;': ' ',
      '&ndash;': '–',
      '&mdash;': '—',
    };

    for (const [entity, char] of Object.entries(entities)) {
      result = result.split(entity).join(char);
    }

    return result;
  };

  // Parse abbreviated date range format like "Dec 1-12", "Dec 1 - 12", or "Dec 06 – Dec 07"
  // Also handles natural language formats like "December 4, 2025 at 9:00 AM"
  // NOTE: Handles both regular dashes (-), en-dashes (–), and em-dashes (—)
  const parseDateRange = (inputText: string): { start: Date; end: Date } | null => {
    // First decode any HTML entities in the text
    const text = decodeHtmlEntities(inputText);
    const months: Record<string, number> = {
      'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3,
      'May': 4, 'Jun': 5, 'Jul': 6, 'Aug': 7,
      'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
    };
    const fullMonths: Record<string, number> = {
      'January': 0, 'February': 1, 'March': 2, 'April': 3,
      'May': 4, 'June': 5, 'July': 6, 'August': 7,
      'September': 8, 'October': 9, 'November': 10, 'December': 11
    };
    const currentYear = new Date().getFullYear();

    // Regex pattern for dashes (regular dash, en-dash, em-dash)
    const dashPattern = '[-–—]';

    // Try to parse "Event duration: Dec 19 – Jan 01" format
    const eventDurationMatch = text.match(/Event duration:\s*(\w{3})\s+(\d{1,2})\s*[-–—]\s*(\w{3})\s+(\d{1,2})/i);
    if (eventDurationMatch) {
      const startMonthAbbrev = eventDurationMatch[1];
      const startDay = parseInt(eventDurationMatch[2], 10);
      const endMonthAbbrev = eventDurationMatch[3];
      const endDay = parseInt(eventDurationMatch[4], 10);

      if (months.hasOwnProperty(startMonthAbbrev) && months.hasOwnProperty(endMonthAbbrev)) {
        const startMonthNum = months[startMonthAbbrev];
        const endMonthNum = months[endMonthAbbrev];

        // Determine year - if end month is before start month, it crosses into next year
        let startYear = currentYear;
        let endYear = currentYear;

        // If event starts in Dec and ends in Jan, the end is in next year
        if (startMonthNum > endMonthNum) {
          endYear = currentYear + 1;
        }

        const startDate = new Date(startYear, startMonthNum, startDay, 0, 0, 0);
        const endDate = new Date(endYear, endMonthNum, endDay, 23, 59, 59);

        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
          return { start: startDate, end: endDate };
        }
      }
    }

    // Try to parse "Event duration: Dec 19-25" format (same month)
    const eventDurationSameMonthMatch = text.match(/Event duration:\s*(\w{3})\s+(\d{1,2})\s*[-–—]\s*(\d{1,2})/i);
    if (eventDurationSameMonthMatch) {
      const monthAbbrev = eventDurationSameMonthMatch[1];
      const startDay = parseInt(eventDurationSameMonthMatch[2], 10);
      const endDay = parseInt(eventDurationSameMonthMatch[3], 10);

      if (months.hasOwnProperty(monthAbbrev)) {
        const monthNum = months[monthAbbrev];
        const startDate = new Date(currentYear, monthNum, startDay, 0, 0, 0);
        const endDate = new Date(currentYear, monthNum, endDay, 23, 59, 59);

        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
          return { start: startDate, end: endDate };
        }
      }
    }

    // Try to parse ISO format: "Event start: 2025-12-04T15:00:00Z"
    const isoEventStartMatch = text.match(/Event start:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)/i);
    if (isoEventStartMatch) {
      try {
        const startDate = new Date(isoEventStartMatch[1]);
        if (!isNaN(startDate.getTime())) {
          // Look for an end time in ISO format
          const isoEndMatch = text.match(/Event end:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)/i);
          let endDate: Date;

          if (isoEndMatch) {
            endDate = new Date(isoEndMatch[1]);
          } else {
            // No explicit end, assume event lasts until end of that day
            endDate = new Date(startDate);
            endDate.setHours(23, 59, 59, 999);
          }

          if (!isNaN(endDate.getTime())) {
            return { start: startDate, end: endDate };
          }
        }
      } catch {
        // Fall through to other parsers
      }
    }

    // Try to parse ISO date range: "2025-12-04T15:00:00Z – 2025-12-04T23:59:00Z"
    const isoRangeMatch = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)\s*[-–—]\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)/);
    if (isoRangeMatch) {
      try {
        const startDate = new Date(isoRangeMatch[1]);
        const endDate = new Date(isoRangeMatch[2]);
        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
          return { start: startDate, end: endDate };
        }
      } catch {
        // Fall through to other parsers
      }
    }

    // Try to parse natural language format: "Month Day, Year at HH:MM AM/PM – Month Day, Year at HH:MM AM/PM"
    // Example: "December 4, 2025 at 7:00 AM – December 4, 2025 at 11:59 PM"
    const fullDateRangeMatch = text.match(
      new RegExp(`(\\w+)\\s+(\\d{1,2}),?\\s+(\\d{4})\\s+at\\s+(\\d{1,2}):(\\d{2})\\s*(AM|PM)\\s*${dashPattern}\\s*(\\w+)\\s+(\\d{1,2}),?\\s+(\\d{4})\\s+at\\s+(\\d{1,2}):(\\d{2})\\s*(AM|PM)`, 'i')
    );
    if (fullDateRangeMatch) {
      const parseDateTime = (monthName: string, day: string, year: string, hours: string, minutes: string, meridiem: string): Date | null => {
        let h = parseInt(hours, 10);
        const m = parseInt(minutes, 10);
        const y = parseInt(year, 10);
        const d = parseInt(day, 10);

        if (meridiem.toUpperCase() === 'PM' && h !== 12) h += 12;
        else if (meridiem.toUpperCase() === 'AM' && h === 12) h = 0;

        if (fullMonths.hasOwnProperty(monthName)) {
          return new Date(y, fullMonths[monthName], d, h, m, 0);
        }
        return null;
      };

      const startDate = parseDateTime(
        fullDateRangeMatch[1], fullDateRangeMatch[2], fullDateRangeMatch[3],
        fullDateRangeMatch[4], fullDateRangeMatch[5], fullDateRangeMatch[6]
      );
      const endDate = parseDateTime(
        fullDateRangeMatch[7], fullDateRangeMatch[8], fullDateRangeMatch[9],
        fullDateRangeMatch[10], fullDateRangeMatch[11], fullDateRangeMatch[12]
      );

      if (startDate && endDate && !isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
        return { start: startDate, end: endDate };
      }
    }

    // Try to parse natural language format: "Event start: Month Day, Year at HH:MM AM/PM"
    // Example: "Event start: December 4, 2025 at 9:00 AM"
    const eventStartMatch = text.match(/Event start:\s*(\w+)\s+(\d{1,2}),?\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (eventStartMatch) {
      const monthName = eventStartMatch[1];
      const day = parseInt(eventStartMatch[2], 10);
      const year = parseInt(eventStartMatch[3], 10);
      let hours = parseInt(eventStartMatch[4], 10);
      const minutes = parseInt(eventStartMatch[5], 10);
      const meridiem = eventStartMatch[6].toUpperCase();

      // Convert to 24-hour format
      if (meridiem === 'PM' && hours !== 12) {
        hours += 12;
      } else if (meridiem === 'AM' && hours === 12) {
        hours = 0;
      }

      if (fullMonths.hasOwnProperty(monthName)) {
        const monthNum = fullMonths[monthName];
        const startDate = new Date(year, monthNum, day, hours, minutes, 0);

        // For events with a start time but no explicit end, assume the event lasts for the rest of that day
        // or we can look for duration in the text
        let endDate = new Date(year, monthNum, day, 23, 59, 59);

        // Try to find duration hint (e.g., "60 minutes", "2 hours")
        const durationMatch = text.match(/(\d+)\s+(minute|hour)s?/i);
        if (durationMatch) {
          const duration = parseInt(durationMatch[1], 10);
          const unit = durationMatch[2].toLowerCase();
          endDate = new Date(startDate);
          if (unit === 'minute') {
            endDate.setMinutes(endDate.getMinutes() + duration);
          } else if (unit === 'hour') {
            endDate.setHours(endDate.getHours() + duration);
          }
        }

        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
          return { start: startDate, end: endDate };
        }
      }
    }

    // Match "Mon DD – Mon DD" format (e.g., "Dec 06 – Dec 07") - with en-dash or regular dash
    const fullRangeMatch = text.match(/(\w{3})\s+(\d{1,2})\s*[–-]\s*(\w{3})\s+(\d{1,2})/);
    if (fullRangeMatch) {
      const startMonthAbbrev = fullRangeMatch[1];
      const startDay = parseInt(fullRangeMatch[2], 10);
      const endMonthAbbrev = fullRangeMatch[3];
      const endDay = parseInt(fullRangeMatch[4], 10);

      if (months.hasOwnProperty(startMonthAbbrev) && months.hasOwnProperty(endMonthAbbrev)) {
        const startMonthNum = months[startMonthAbbrev];
        const endMonthNum = months[endMonthAbbrev];
        // Start at beginning of the day, end at end of the day
        const startDate = new Date(currentYear, startMonthNum, startDay, 0, 0, 0);
        const endDate = new Date(currentYear, endMonthNum, endDay, 23, 59, 59);

        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
          return { start: startDate, end: endDate };
        }
      }
    }

    // Match "Mon D-D" or "Mon D - D" format (e.g., "Dec 1-12" or "Dec 1 - 12")
    const shortRangeMatch = text.match(/(\w{3})\s+(\d{1,2})\s*[–-]\s*(\d{1,2})(?!\s*\w)/);
    if (shortRangeMatch) {
      const monthAbbrev = shortRangeMatch[1];
      const startDay = parseInt(shortRangeMatch[2], 10);
      const endDay = parseInt(shortRangeMatch[3], 10);

      if (months.hasOwnProperty(monthAbbrev)) {
        const monthNum = months[monthAbbrev];
        // Start at beginning of the day, end at end of the day
        const startDate = new Date(currentYear, monthNum, startDay, 0, 0, 0);
        const endDate = new Date(currentYear, monthNum, endDay, 23, 59, 59);

        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
          return { start: startDate, end: endDate };
        }
      }
    }

    return null;
  };

  // Check badge availability status
  const getBadgeStatus = (badge: BadgeWithMetadata): 'available' | 'coming-soon' | 'expired' | null => {
    const moreInfo = badge.badgebase_info?.more_info;
    if (!moreInfo) return null;

    const now = Date.now();

    // Try to parse date range from more_info (supports multiple formats)
    const dateRange = parseDateRange(moreInfo);
    if (dateRange) {
      const startTime = dateRange.start.getTime();
      const endTime = dateRange.end.getTime();

      if (now < startTime) {
        return 'coming-soon';
      } else if (now >= startTime && now <= endTime) {
        return 'available';
      } else {
        return 'expired';
      }
    }

    // Fallback: Extract ISO timestamps from the more_info text
    const isoRegex = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z)?)/g;
    const timestamps = moreInfo.match(isoRegex);

    if (!timestamps || timestamps.length === 0) return null;

    try {
      if (timestamps.length === 1) {
        // Single timestamp - assume it's the start time
        const startTime = new Date(timestamps[0]).getTime();
        let endTime: number;

        // Try to find duration hint (e.g., "60 minutes", "2 hours")
        const durationMatch = moreInfo.match(/(\d+)\s+(minute|hour)s?/i);
        if (durationMatch) {
          const duration = parseInt(durationMatch[1], 10);
          const unit = durationMatch[2].toLowerCase();
          const startDate = new Date(timestamps[0]);
          if (unit === 'minute') {
            startDate.setMinutes(startDate.getMinutes() + duration);
          } else if (unit === 'hour') {
            startDate.setHours(startDate.getHours() + duration);
          }
          endTime = startDate.getTime();
        } else {
          // No duration found, assume event lasts until end of that day
          const startDate = new Date(timestamps[0]);
          endTime = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 23, 59, 59).getTime();
        }

        if (now < startTime) {
          return 'coming-soon';
        } else if (now >= startTime && now <= endTime) {
          return 'available';
        } else {
          return 'expired';
        }
      } else {
        // Multiple timestamps - assume first is start, last is end
        const startTime = new Date(timestamps[0]).getTime();
        const endTime = new Date(timestamps[timestamps.length - 1]).getTime();

        if (now < startTime) {
          return 'coming-soon';
        } else if (now >= startTime && now <= endTime) {
          return 'available';
        } else {
          return 'expired';
        }
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
          <div className="flex items-center gap-4">
            <div>
              <h2 className="text-xl font-bold text-textPrimary">Twitch Global Badges</h2>
              <p className="text-sm text-textSecondary mt-1">
                Click on any badge to view detailed information
              </p>
            </div>
            
            {/* Collection Counter - only shows truly global collectible badges */}
            {isAuthenticated && totalGlobalBadges > 0 && (
              <div 
                className={`flex items-center gap-3 px-4 py-2.5 bg-gradient-to-r ${
                  currentRank?.colors.bg || 'from-[#6b7280]/10 via-[#9ca3af]/10 to-[#d1d5db]/10'
                } border border-${currentRank?.colors.border || '[#6b7280]/30'} rounded-xl relative overflow-visible cursor-pointer hover:brightness-110 transition-all`}
                style={{ 
                  borderColor: currentRank ? `${currentRank.colors.from}30` : 'rgba(107, 114, 128, 0.3)',
                  boxShadow: currentRank ? `0 0 20px ${currentRank.colors.glow}` : 'none'
                }}
                onClick={() => {
                  // Set dropdown position when opening
                  if (!showRankList && rankButtonRef.current) {
                    const rect = rankButtonRef.current.getBoundingClientRect();
                    setDropdownPosition({ top: rect.bottom + 8, left: rect.left - 280 });
                  }
                  setShowRankList(!showRankList);
                }}
              >
                {/* Sparkle effects - using rank colors */}
                <div className="absolute inset-0 overflow-hidden pointer-events-none">
                  {(currentRank?.colors.sparkle || ['#6b7280', '#9ca3af', '#d1d5db', '#4b5563']).map((color, i) => (
                    <div 
                      key={i}
                      className="absolute w-1 h-1 rounded-full animate-ping"
                      style={{ 
                        backgroundColor: color,
                        opacity: 0.5 + (i * 0.1),
                        top: `${20 + (i * 20)}%`, 
                        left: `${15 + (i * 25)}%`,
                        animationDelay: `${i * 0.5}s`,
                        animationDuration: `${2 + (i * 0.3)}s`
                      }} 
                    />
                  ))}
                </div>
                <div 
                  className="flex items-center justify-center w-9 h-9 rounded-lg shadow-lg relative"
                  style={{
                    background: currentRank 
                      ? `linear-gradient(to bottom right, ${currentRank.colors.from}, ${currentRank.colors.via}, ${currentRank.colors.to})`
                      : 'linear-gradient(to bottom right, #6b7280, #9ca3af, #d1d5db)'
                  }}
                >
                  <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/20 to-transparent rounded-lg" />
                  <Trophy size={18} className="text-white drop-shadow-sm relative z-10" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))' }} />
                </div>
                <div className="flex flex-col relative z-10">
                  {currentRank && (
                    <span 
                      className="text-xs font-bold uppercase tracking-wider"
                      style={{
                        background: `linear-gradient(to right, ${currentRank.colors.from}, ${currentRank.colors.via}, ${currentRank.colors.to})`,
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text'
                      }}
                    >
                      {currentRank.title}
                    </span>
                  )}
                  <div className="flex items-baseline gap-1">
                    {loadingUserBadges ? (
                      <div 
                        className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" 
                        style={{ borderColor: currentRank?.colors.from || '#6b7280' }}
                      />
                    ) : (
                      <>
                        <span 
                          className="text-lg font-bold"
                          style={{
                            background: currentRank 
                              ? `linear-gradient(to right, ${currentRank.colors.from}, ${currentRank.colors.via}, ${currentRank.colors.to})`
                              : 'linear-gradient(to right, #6b7280, #9ca3af, #d1d5db)',
                            WebkitBackgroundClip: 'text',
                            WebkitTextFillColor: 'transparent',
                            backgroundClip: 'text'
                          }}
                        >
                          {collectedCount}
                        </span>
                        <span className="text-textSecondary text-sm">/ {totalGlobalBadges}</span>
                      </>
                    )}
                  </div>
                </div>
                {collectedCount > 0 && !loadingUserBadges && totalGlobalBadges > 0 && (
                  <div 
                    className="ml-2 px-2 py-0.5 rounded-full relative z-10"
                    style={{
                      background: currentRank 
                        ? `linear-gradient(to right, ${currentRank.colors.from}20, ${currentRank.colors.to}20)`
                        : 'linear-gradient(to right, rgba(107, 114, 128, 0.2), rgba(156, 163, 175, 0.2))',
                      border: `1px solid ${currentRank?.colors.from || '#6b7280'}30`
                    }}
                  >
                    <span 
                      className="text-xs font-medium"
                      style={{
                        background: currentRank 
                          ? `linear-gradient(to right, ${currentRank.colors.from}, ${currentRank.colors.via})`
                          : 'linear-gradient(to right, #6b7280, #9ca3af)',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text'
                      }}
                    >
                      {Math.round((collectedCount / totalGlobalBadges) * 100)}%
                    </span>
                  </div>
                )}
                {/* View Ranks Button */}
                <button
                  ref={rankButtonRef}
                  onClick={(e) => { 
                    e.stopPropagation(); 
                    if (!showRankList && rankButtonRef.current) {
                      const rect = rankButtonRef.current.getBoundingClientRect();
                      setDropdownPosition({ top: rect.bottom + 8, left: rect.left - 280 });
                    }
                    setShowRankList(!showRankList); 
                  }}
                  className="ml-1 p-1.5 rounded-lg hover:bg-white/10 transition-colors relative z-10"
                  title="View all collector ranks"
                >
                  <Award size={16} className="text-textSecondary hover:text-textPrimary transition-colors" />
                </button>
              </div>
            )}
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
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${sortBy === 'date-newest'
                      ? 'bg-accent text-white'
                      : 'bg-glass text-textSecondary hover:bg-glass/80'
                      }`}
                  >
                    Newest First
                  </button>
                  <button
                    onClick={() => setSortBy('date-oldest')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${sortBy === 'date-oldest'
                      ? 'bg-accent text-white'
                      : 'bg-glass text-textSecondary hover:bg-glass/80'
                      }`}
                  >
                    Oldest First
                  </button>
                  <button
                    onClick={() => setSortBy('usage-high')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${sortBy === 'usage-high'
                      ? 'bg-accent text-white'
                      : 'bg-glass text-textSecondary hover:bg-glass/80'
                      }`}
                  >
                    Most Used
                  </button>
                  <button
                    onClick={() => setSortBy('usage-low')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${sortBy === 'usage-low'
                      ? 'bg-accent text-white'
                      : 'bg-glass text-textSecondary hover:bg-glass/80'
                      }`}
                  >
                    Least Used
                  </button>
                  <button
                    onClick={() => setSortBy('available')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors flex items-center gap-2 ${sortBy === 'available'
                      ? 'bg-green-600 text-white'
                      : 'bg-glass text-textSecondary hover:bg-glass/80'
                      }`}
                  >
                    <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                    Available Now
                  </button>
                  <button
                    onClick={() => setSortBy('coming-soon')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors flex items-center gap-2 ${sortBy === 'coming-soon'
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
                  const hasCollected = isAuthenticated && isCollected(badge);
                  return (
                    <button
                      key={`${badge.set_id}-${badge.id}-${index}`}
                      onClick={() => onBadgeClick(badge, badge.set_id)}
                      className={`flex flex-col items-center gap-2 p-3 rounded-lg hover:bg-glass transition-all duration-200 group relative ${
                        hasCollected ? 'ring-2 ring-[#d4a84b]/50 bg-[#d4a84b]/5' :
                        isAvailable ? 'ring-2 ring-green-500/50' : 
                        isComingSoon ? 'ring-2 ring-blue-500/50' : ''
                      }`}
                      title={hasCollected ? `${badge.title} (Collected!)` : badge.title}
                    >
                      <div className={`w-18 h-18 flex items-center justify-center bg-glass rounded-lg group-hover:scale-110 transition-transform duration-200 relative ${
                        hasCollected ? 'shadow-[0_0_20px_rgba(212,168,75,0.35)]' :
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
                      {/* Collected indicator - takes priority over other indicators */}
                      {hasCollected && (
                        <span className="absolute top-1 right-1 w-5 h-5 bg-gradient-to-br from-[#d4a84b] via-[#f0d78c] to-[#b8860b] rounded-full flex items-center justify-center shadow-lg overflow-hidden">
                          <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/30 to-transparent" />
                          <Check size={12} className="text-[#2a1a0a] relative z-10" strokeWidth={3} />
                        </span>
                      )}
                      {/* Status indicators - only show if not collected */}
                      {!hasCollected && isAvailable && (
                        <span className="absolute top-1 right-1 w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                      )}
                      {!hasCollected && isComingSoon && (
                        <span className="absolute top-1 right-1 w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
                      )}
                      <span className={`text-xs text-center line-clamp-2 transition-colors font-medium ${
                        hasCollected ? 'bg-gradient-to-r from-[#d4a84b] via-[#f0d78c] to-[#c9a227] bg-clip-text text-transparent' : 'text-textSecondary group-hover:text-textPrimary'
                      }`}>
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
      
      {/* Ranks Dropdown Portal - rendered outside the DOM hierarchy to prevent cursor flicker */}
      {showRankList && dropdownPosition && createPortal(
        <>
          {/* Invisible overlay to capture clicks */}
          <div 
            className="fixed inset-0"
            style={{ zIndex: 99998 }}
            onClick={() => setShowRankList(false)}
          />
          <div 
            className="fixed w-80 bg-primary border border-borderSubtle rounded-xl shadow-2xl overflow-hidden backdrop-blur-xl"
            style={{ 
              zIndex: 99999,
              top: dropdownPosition.top,
              left: Math.max(8, dropdownPosition.left)
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-3 border-b border-borderSubtle bg-secondary">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Trophy size={16} className="text-accent" />
                  <span className="font-semibold text-textPrimary">Collector Ranks</span>
                </div>
                <button
                  onClick={() => setShowRankList(false)}
                  className="p-1 hover:bg-glass rounded-lg transition-colors"
                >
                  <X size={14} className="text-textSecondary" />
                </button>
              </div>
              <p className="text-xs text-textSecondary mt-1">Collect global badges to rank up!</p>
            </div>
            {/* Epic tier animations */}
            <style>{`
              /* DRIFTER - VHS static fade */
              @keyframes drifter-static { 0%, 100% { opacity: 0.7; } 50% { opacity: 0.9; } }
              @keyframes drifter-flare { 0% { opacity: 0; transform: translateX(-100%); } 50% { opacity: 0.3; } 100% { opacity: 0; transform: translateX(100%); } }
              .rank-drifter-icon { animation: drifter-static 2s ease-in-out infinite; }
              .rank-drifter-text { animation: drifter-static 3s ease-in-out infinite; }
              
              /* NOMAD - Sand particles, golden glow */
              @keyframes nomad-dust { 0%, 100% { opacity: 0.5; transform: translateX(0); } 50% { opacity: 0.8; transform: translateX(2px); } }
              @keyframes nomad-glow { 0%, 100% { box-shadow: 0 0 8px rgba(212, 168, 75, 0.3); } 50% { box-shadow: 0 0 16px rgba(212, 168, 75, 0.5); } }
              .rank-nomad-icon { animation: nomad-glow 3s ease-in-out infinite; }
              .rank-nomad-text { animation: nomad-dust 4s ease-in-out infinite; }
              
              /* RONIN - Neon katana slash, electric blue */
              @keyframes ronin-slash { 0% { background-position: -200% center; } 100% { background-position: 200% center; } }
              @keyframes ronin-pulse { 0%, 100% { box-shadow: 0 0 10px rgba(59, 130, 246, 0.4), 0 0 20px rgba(14, 165, 233, 0.2); } 50% { box-shadow: 0 0 20px rgba(59, 130, 246, 0.6), 0 0 40px rgba(14, 165, 233, 0.4); } }
              .rank-ronin-icon { animation: ronin-pulse 1.5s ease-in-out infinite; }
              .rank-ronin-text { background: linear-gradient(90deg, #3b82f6, #60a5fa, #0ea5e9, #38bdf8, #3b82f6); background-size: 200% auto; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; animation: ronin-slash 2s linear infinite; }
              
              /* PHANTOM - Ghostly cyan, chromatic aberration */
              @keyframes phantom-ghost { 0%, 100% { opacity: 0.8; filter: blur(0px); } 50% { opacity: 1; filter: blur(0.5px); } }
              @keyframes phantom-aberration { 0%, 100% { text-shadow: -1px 0 #06b6d4, 1px 0 #67e8f9; } 50% { text-shadow: -2px 0 #06b6d4, 2px 0 #67e8f9; } }
              .rank-phantom-icon { animation: phantom-ghost 2s ease-in-out infinite; }
              .rank-phantom-text { animation: phantom-aberration 3s ease-in-out infinite; }
              
              /* VANGUARD - Chrome holographic, rotation */
              @keyframes vanguard-holo { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
              @keyframes vanguard-shine { 0%, 100% { opacity: 0.2; } 50% { opacity: 0.4; } }
              .rank-vanguard-icon { background: linear-gradient(45deg, #94a3b8, #cbd5e1, #e2e8f0, #94a3b8); background-size: 200% 200%; animation: vanguard-holo 4s ease infinite; }
              .rank-vanguard-text { background: linear-gradient(90deg, #94a3b8, #cbd5e1, #e2e8f0, #94a3b8); background-size: 200% auto; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; animation: vanguard-holo 3s ease infinite; }
              
              /* AURORA - Northern lights flow */
              @keyframes aurora-flow { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
              @keyframes aurora-shimmer { 0%, 100% { opacity: 0.8; } 50% { opacity: 1; } }
              .rank-aurora-icon { background: linear-gradient(135deg, #14b8a6, #a855f7, #ec4899, #14b8a6); background-size: 300% 300%; animation: aurora-flow 6s ease infinite; }
              .rank-aurora-text { background: linear-gradient(90deg, #14b8a6, #a855f7, #ec4899, #06b6d4, #14b8a6); background-size: 200% auto; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; animation: aurora-flow 4s ease infinite; }
              
              /* NEXUS - Wireframe grid, glitch */
              @keyframes nexus-grid { 0%, 100% { opacity: 0.9; } 50% { opacity: 1; } }
              @keyframes nexus-glitch { 0%, 92%, 100% { transform: translate(0); } 93% { transform: translate(-2px, 1px); } 95% { transform: translate(2px, -1px); } 97% { transform: translate(-1px, 2px); } }
              .rank-nexus-icon { animation: nexus-grid 2s ease-in-out infinite, nexus-glitch 4s step-end infinite; }
              .rank-nexus-text { background: linear-gradient(90deg, #7c3aed, #a855f7, #c084fc, #e879f9, #7c3aed); background-size: 200% auto; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; animation: aurora-flow 3s ease infinite, nexus-glitch 5s step-end infinite; }
              
              /* AEON - Cosmic nebula, golden filaments */
              @keyframes aeon-nebula { 0% { background-position: 0% 0%; } 100% { background-position: 100% 100%; } }
              @keyframes aeon-pulse { 0%, 100% { box-shadow: 0 0 15px rgba(255, 215, 0, 0.3), 0 0 30px rgba(74, 0, 128, 0.2); } 50% { box-shadow: 0 0 25px rgba(255, 215, 0, 0.5), 0 0 50px rgba(74, 0, 128, 0.3); } }
              .rank-aeon-icon { background: linear-gradient(135deg, #1a1a2e, #4a0080, #ffd700); animation: aeon-pulse 3s ease-in-out infinite; }
              .rank-aeon-text { background: linear-gradient(90deg, #ffd700, #4a0080, #ffffff, #ffd700); background-size: 300% auto; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; animation: aeon-nebula 8s linear infinite; }
              
              /* TITAN - Liquid mercury, prismatic diamond */
              @keyframes titan-mercury { 0%, 100% { background-position: 0% 50%; filter: brightness(1); } 25% { filter: brightness(1.1); } 50% { background-position: 100% 50%; filter: brightness(1.2); } 75% { filter: brightness(1.1); } }
              @keyframes titan-flare { 0%, 100% { box-shadow: 0 0 20px rgba(255, 255, 255, 0.3), 0 0 40px rgba(168, 216, 234, 0.2); } 50% { box-shadow: 0 0 30px rgba(255, 255, 255, 0.5), 0 0 60px rgba(168, 216, 234, 0.4), 0 0 80px rgba(255, 215, 0, 0.2); } }
              .rank-titan-icon { background: linear-gradient(135deg, #e8e8e8, #ffffff, #c0c0c0, #a8d8ea, #e8e8e8); background-size: 200% 200%; animation: titan-mercury 4s ease infinite, titan-flare 3s ease-in-out infinite; }
              .rank-titan-text { background: linear-gradient(90deg, #e8e8e8, #ffffff, #a8d8ea, #ffd700, #e8e8e8); background-size: 300% auto; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; animation: titan-mercury 5s ease infinite; }
              
              /* APEX - Full adaptive RGB, floating effect */
              @keyframes apex-rgb { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
              @keyframes apex-float { 0%, 100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-2px) scale(1.02); } }
              @keyframes apex-glow { 0%, 100% { box-shadow: 0 0 20px rgba(255, 0, 128, 0.4), 0 0 40px rgba(121, 40, 202, 0.3), 0 0 60px rgba(0, 212, 255, 0.2); } 33% { box-shadow: 0 0 25px rgba(121, 40, 202, 0.5), 0 0 50px rgba(0, 212, 255, 0.4), 0 0 70px rgba(255, 0, 128, 0.3); } 66% { box-shadow: 0 0 30px rgba(0, 212, 255, 0.5), 0 0 55px rgba(255, 0, 128, 0.4), 0 0 80px rgba(121, 40, 202, 0.3); } }
              .rank-apex-icon { background: linear-gradient(135deg, #ff0080, #7928ca, #00d4ff, #ff0080); background-size: 300% 300%; animation: apex-rgb 3s ease infinite, apex-float 2s ease-in-out infinite, apex-glow 4s ease-in-out infinite; }
              .rank-apex-text { background: linear-gradient(90deg, #ff0080, #7928ca, #00d4ff, #ff6b6b, #feca57, #ff0080); background-size: 300% auto; -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; animation: apex-rgb 2s ease infinite; }
            `}</style>
            <div className="p-2 space-y-1 max-h-96 overflow-y-auto custom-scrollbar">
              {allRanks.map((rank) => {
                const isCurrentRank = currentRank?.title === rank.title;
                const currentPercentage = totalGlobalBadges > 0 ? Math.round((collectedCount / totalGlobalBadges) * 100) : 0;
                const requiredPercentage = parseFloat(rank.requirement.replace(/[^0-9.]/g, '')) || 0;
                const isAchieved = currentPercentage >= requiredPercentage;
                
                return (
                  <div 
                    key={rank.title}
                    className={`flex items-center gap-3 p-2.5 rounded-lg transition-all ${
                      isCurrentRank 
                        ? 'bg-gradient-to-r from-[#ffffff08] to-transparent' 
                        : isAchieved 
                          ? 'bg-[#ffffff05]' 
                          : 'opacity-60'
                    }`}
                    style={{
                      boxShadow: isCurrentRank ? `inset 0 0 0 1px ${rank.colors.from}50` : undefined
                    }}
                  >
                    {/* Rank Icon */}
                    <div 
                      className={`w-8 h-8 rounded-lg flex items-center justify-center shadow-md relative overflow-hidden flex-shrink-0 rank-${rank.tier}-icon`}
                      style={{
                        background: `linear-gradient(to bottom right, ${rank.colors.from}, ${rank.colors.via}, ${rank.colors.to})`
                      }}
                    >
                      <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/20 to-transparent" />
                      <Trophy 
                        size={14} 
                        className="text-white relative z-10"
                        style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))' }}
                      />
                    </div>
                    
                    {/* Rank Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span 
                          className={`font-bold text-sm tracking-wider rank-${rank.tier}-text`}
                          style={{
                            background: `linear-gradient(to right, ${rank.colors.from}, ${rank.colors.via}, ${rank.colors.to})`,
                            WebkitBackgroundClip: 'text',
                            WebkitTextFillColor: 'transparent',
                            backgroundClip: 'text'
                          }}
                        >
                          {rank.title}
                        </span>
                        {isCurrentRank && (
                          <span className="px-1.5 py-0.5 bg-accent/20 text-accent text-[10px] font-bold rounded uppercase">
                            Current
                          </span>
                        )}
                        {isAchieved && !isCurrentRank && (
                          <Check size={12} className="text-green-500" />
                        )}
                      </div>
                      <p className="text-[11px] text-textSecondary truncate">{rank.description}</p>
                    </div>
                    
                    {/* Requirement Badge */}
                    <div 
                      className="px-2 py-1 rounded-md text-xs font-medium flex-shrink-0"
                      style={{
                        background: `linear-gradient(to right, ${rank.colors.from}15, ${rank.colors.to}15)`,
                        color: rank.colors.from
                      }}
                    >
                      {rank.requirement}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Progress to next rank */}
            {currentRank && currentRank.title !== 'APEX' && (
              <div className="p-3 border-t border-borderSubtle bg-glass/30">
                <div className="flex items-center gap-2 text-xs text-textSecondary">
                  <ChevronUp size={12} />
                  <span>
                    {(() => {
                      const nextRankIndex = allRanks.findIndex(r => r.title === currentRank.title) - 1;
                      if (nextRankIndex >= 0) {
                        const nextRank = allRanks[nextRankIndex];
                        const nextRequired = parseFloat(nextRank.requirement.replace(/[^0-9.]/g, '')) || 100;
                        const badgesNeeded = Math.ceil((nextRequired / 100) * totalGlobalBadges) - collectedCount;
                        return `${badgesNeeded} more badge${badgesNeeded !== 1 ? 's' : ''} to ${nextRank.title}`;
                      }
                      return 'Keep collecting!';
                    })()}
                  </span>
                </div>
              </div>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  );
};

export default BadgesOverlay;
