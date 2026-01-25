import { useEffect, useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowUpDown, RefreshCw, Check, Trophy, Award, ChevronUp, Search } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { getAllUserBadgesWithEarned } from '../services/badgeService';
import { getProfileFromMemoryCache, getFullProfileWithFallback } from '../services/cosmeticsCache';

// Tab navigation types
type AttainableTab = 'twitch-badges' | '7tv-badges' | '7tv-paints';

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

// 7TV Types
interface SevenTVImage {
  url: string;
  mime: string | null;
  scale: number | null;
  width: number | null;
  height: number | null;
  frameCount: number | null;  // camelCase from Rust serde rename
}

interface SevenTVGlobalBadge {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  images: SevenTVImage[];
  updatedAt: string | null;  // camelCase from Rust serde rename
}

interface SevenTVPaintLayer {
  id: string;
  opacity: number;
  ty: any; // Rust renames to "ty" - Complex union type from API
}

interface SevenTVPaintShadow {
  color: { hex: string; r: number; g: number; b: number; a: number };
  offsetX: number;  // camelCase from Rust serde rename
  offsetY: number;  // camelCase from Rust serde rename
  blur: number;
}

interface SevenTVGlobalPaint {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  data: {
    layers: SevenTVPaintLayer[];
    shadows: SevenTVPaintShadow[];
  } | null;
  updatedAt: string | null;  // camelCase from Rust serde rename
}

interface BadgesOverlayProps {
  onClose: () => void;
  onBadgeClick: (badge: BadgeVersion, setId: string) => void;
}

const BadgesOverlay = ({ onClose, onBadgeClick }: BadgesOverlayProps) => {
  const { isAuthenticated, currentUser, currentStream } = useAppStore();
  
  // Tab state
  const [activeTab, setActiveTab] = useState<AttainableTab>('twitch-badges');
  
  // Twitch badges state
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
  
  // 7TV state
  const [seventvBadges, setSeventvBadges] = useState<SevenTVGlobalBadge[]>([]);
  const [seventvPaints, setSeventvPaints] = useState<SevenTVGlobalPaint[]>([]);
  const [loadingSeventvBadges, setLoadingSeventvBadges] = useState(false);
  const [loadingSeventvPaints, setLoadingSeventvPaints] = useState(false);
  const [seventvBadgesError, setSeventvBadgesError] = useState<string | null>(null);
  const [seventvPaintsError, setSeventvPaintsError] = useState<string | null>(null);
  
  // Selected 7TV item for detail view
  const [selectedSeventvBadge, setSelectedSeventvBadge] = useState<SevenTVGlobalBadge | null>(null);
  const [selectedSeventvPaint, setSelectedSeventvPaint] = useState<SevenTVGlobalPaint | null>(null);
  
  // User's collected global badges (Set of "setId_version" keys)
  const [collectedBadgeKeys, setCollectedBadgeKeys] = useState<Set<string>>(new Set());
  const [loadingUserBadges, setLoadingUserBadges] = useState(false);
  
  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  
  // User's owned 7TV cosmetics
  const [userOwned7TVBadgeIds, setUserOwned7TVBadgeIds] = useState<Set<string>>(new Set());
  const [userOwned7TVPaintIds, setUserOwned7TVPaintIds] = useState<Set<string>>(new Set());
  const [loadingUser7TVCosmetics, setLoadingUser7TVCosmetics] = useState(false);

  // Load all data on mount (eager load for tab counts)
  useEffect(() => {
    loadBadges();
    // Eager load 7TV data for tab counts
    loadSeventvBadges();
    loadSeventvPaints();
  }, []);

  // Load user's collected badges when authenticated
  useEffect(() => {
    if (isAuthenticated && currentUser) {
      loadUserBadges();
      loadUser7TVCosmetics();
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

  // Load user's 7TV cosmetics for collection counters
  const loadUser7TVCosmetics = async () => {
    if (!currentUser) return;
    
    setLoadingUser7TVCosmetics(true);
    try {
      const channelId = currentStream?.user_id || currentUser.user_id;
      const channelName = currentStream?.user_login || currentUser.login || currentUser.username;
      
      // Try memory cache first
      let profile = getProfileFromMemoryCache(currentUser.user_id);
      
      // If no cache, fetch from API
      if (!profile) {
        profile = await getFullProfileWithFallback(
          currentUser.user_id,
          currentUser.login || currentUser.username,
          channelId,
          channelName
        );
      }
      
      // Extract owned badge and paint IDs
      const badgeIds = new Set<string>();
      const paintIds = new Set<string>();
      
      profile.seventvCosmetics.badges?.forEach((badge: any) => {
        if (badge?.id) badgeIds.add(badge.id);
      });
      
      profile.seventvCosmetics.paints?.forEach((paint: any) => {
        if (paint?.id) paintIds.add(paint.id);
      });
      
      setUserOwned7TVBadgeIds(badgeIds);
      setUserOwned7TVPaintIds(paintIds);
      console.log(`[BadgesOverlay] User owns ${badgeIds.size} 7TV badges and ${paintIds.size} 7TV paints`);
    } catch (err) {
      console.error('[BadgesOverlay] Failed to load user 7TV cosmetics:', err);
    } finally {
      setLoadingUser7TVCosmetics(false);
    }
  };

  // Load 7TV badges when tab is activated
  const loadSeventvBadges = async () => {
    if (seventvBadges.length > 0 || loadingSeventvBadges) return; // Already loaded or loading
    
    setLoadingSeventvBadges(true);
    setSeventvBadgesError(null);
    try {
      console.log('[Attainables] Fetching 7TV badges...');
      const badges = await invoke<SevenTVGlobalBadge[]>('get_all_seventv_badges');
      setSeventvBadges(badges);
      console.log(`[Attainables] Loaded ${badges.length} 7TV badges`);
    } catch (err) {
      console.error('[Attainables] Failed to load 7TV badges:', err);
      setSeventvBadgesError('Failed to load 7TV badges');
    } finally {
      setLoadingSeventvBadges(false);
    }
  };

  // Load 7TV paints when tab is activated
  const loadSeventvPaints = async () => {
    if (seventvPaints.length > 0 || loadingSeventvPaints) return; // Already loaded or loading
    
    setLoadingSeventvPaints(true);
    setSeventvPaintsError(null);
    try {
      console.log('[Attainables] Fetching 7TV paints...');
      const paints = await invoke<SevenTVGlobalPaint[]>('get_all_seventv_paints');
      setSeventvPaints(paints);
      console.log(`[Attainables] Loaded ${paints.length} 7TV paints`);
    } catch (err) {
      console.error('[Attainables] Failed to load 7TV paints:', err);
      setSeventvPaintsError('Failed to load 7TV paints');
    } finally {
      setLoadingSeventvPaints(false);
    }
  };

  // Load data when tab changes
  useEffect(() => {
    if (activeTab === '7tv-badges') {
      loadSeventvBadges();
    } else if (activeTab === '7tv-paints') {
      loadSeventvPaints();
    }
  }, [activeTab]);

  // Check if a 7TV badge/image is animated (frameCount > 1)
  const isAnimatedBadge = (badge: SevenTVGlobalBadge): boolean => {
    return badge.images?.some(img => (img.frameCount || 0) > 1) || false;
  };

  // Get best image URL for 7TV badge (prefer animated webp if available)
  const getSeventvBadgeImageUrl = (badge: SevenTVGlobalBadge, preferAnimated = true): string => {
    if (!badge.images || badge.images.length === 0) return '';
    
    // Prefer webp format (supports animation)
    const webpImages = badge.images.filter(img => img.mime === 'image/webp');
    
    // Check for animated versions first (frameCount > 1)
    if (preferAnimated) {
      const animatedImages = webpImages.filter(img => (img.frameCount || 0) > 1);
      if (animatedImages.length > 0) {
        // Get highest scale animated image
        const scale4 = animatedImages.find(img => img.scale === 4);
        const scale3 = animatedImages.find(img => img.scale === 3);
        const scale2 = animatedImages.find(img => img.scale === 2);
        if (scale4?.url) return scale4.url;
        if (scale3?.url) return scale3.url;
        if (scale2?.url) return scale2.url;
        return animatedImages[0]?.url || '';
      }
    }
    
    // Fall back to static highest scale
    const scale4 = webpImages.find(img => img.scale === 4);
    const scale2 = webpImages.find(img => img.scale === 2);
    const scale1 = webpImages.find(img => img.scale === 1);
    
    return scale4?.url || scale2?.url || scale1?.url || badge.images[0]?.url || '';
  };

  // Check if a 7TV paint is animated (has image layer with frameCount > 1)
  const isAnimatedPaint = (paint: SevenTVGlobalPaint): boolean => {
    if (!paint.data?.layers?.[0]?.ty) return false;
    const layerType = paint.data.layers[0].ty;
    if (layerType.__typename !== 'PaintLayerTypeImage' || !layerType.images) return false;
    return layerType.images.some((img: any) => (img.frameCount || 0) > 1);
  };

  // Get animated paint image URL (prefer animated webp)
  const getAnimatedPaintImageUrl = (paint: SevenTVGlobalPaint): string | null => {
    if (!paint.data?.layers?.[0]?.ty) return null;
    const layerType = paint.data.layers[0].ty;
    if (layerType.__typename !== 'PaintLayerTypeImage' || !layerType.images) return null;
    
    // Find animated webp images (frameCount > 1, not containing '_static')
    const animatedImages = layerType.images.filter((img: any) => 
      img.mime === 'image/webp' && 
      (img.frameCount || 0) > 1 && 
      !img.url.includes('_static')
    );
    
    if (animatedImages.length === 0) return null;
    
    // Prefer highest scale
    const scale4 = animatedImages.find((img: any) => img.scale === 4);
    const scale3 = animatedImages.find((img: any) => img.scale === 3);
    const scale2 = animatedImages.find((img: any) => img.scale === 2);
    
    return scale4?.url || scale3?.url || scale2?.url || animatedImages[0]?.url || null;
  };

  // Generate CSS gradient from 7TV paint layers
  const generatePaintGradient = (paint: SevenTVGlobalPaint): string => {
    if (!paint.data || !paint.data.layers || paint.data.layers.length === 0) {
      return 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'; // Default fallback
    }

    const layer = paint.data.layers[0];
    const layerType = layer.ty;
    
    if (!layerType) return 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';

    // Handle different layer types
    if (layerType.__typename === 'PaintLayerTypeSingleColor' && layerType.color) {
      return layerType.color.hex;
    }

    if (layerType.__typename === 'PaintLayerTypeLinearGradient' && layerType.stops) {
      const angle = layerType.angle || 90;
      const stops = layerType.stops
        .map((stop: any) => `${stop.color.hex} ${Math.round(stop.at * 100)}%`)
        .join(', ');
      return `linear-gradient(${angle}deg, ${stops})`;
    }

    if (layerType.__typename === 'PaintLayerTypeRadialGradient' && layerType.stops) {
      const stops = layerType.stops
        .map((stop: any) => `${stop.color.hex} ${Math.round(stop.at * 100)}%`)
        .join(', ');
      return `radial-gradient(circle, ${stops})`;
    }

    if (layerType.__typename === 'PaintLayerTypeImage' && layerType.images?.[0]?.url) {
      // For image paints, prefer animated webp if available
      const animatedUrl = getAnimatedPaintImageUrl(paint);
      return `url(${animatedUrl || layerType.images[0].url})`;
    }

    return 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
  };

  // Generate CSS text-shadow from 7TV paint shadows
  const generatePaintShadow = (paint: SevenTVGlobalPaint): string => {
    if (!paint.data?.shadows || paint.data.shadows.length === 0) {
      return 'none';
    }

    // Convert each shadow to CSS text-shadow format
    // Format: offsetX offsetY blur color
    const shadows = paint.data.shadows.map(shadow => {
      const offsetX = shadow.offsetX || 0;
      const offsetY = shadow.offsetY || 0;
      const blur = (shadow.blur || 0) * 10; // Scale up blur for visibility
      const color = shadow.color?.hex || '#000000';
      return `${offsetX}px ${offsetY}px ${blur}px ${color}`;
    });

    return shadows.join(', ');
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
            {/* Tab Navigation */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setActiveTab('twitch-badges')}
                className={`px-4 py-2 rounded-lg transition-all flex items-center gap-2 ${
                  activeTab === 'twitch-badges'
                    ? 'bg-[#9147ff] text-white shadow-lg shadow-[#9147ff]/30'
                    : 'bg-glass text-textSecondary hover:bg-glass/80 hover:text-textPrimary'
                }`}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
                </svg>
                Twitch Badges
                <span className="text-xs opacity-70">({badgesWithMetadata.length})</span>
              </button>
              
              <button
                onClick={() => setActiveTab('7tv-badges')}
                className={`px-4 py-2 rounded-lg transition-all flex items-center gap-2 ${
                  activeTab === '7tv-badges'
                    ? 'bg-[#29b6f6] text-white shadow-lg shadow-[#29b6f6]/30'
                    : 'bg-glass text-textSecondary hover:bg-glass/80 hover:text-textPrimary'
                }`}
              >
                <svg className="w-4 h-4" viewBox="0 0 28 21" fill="currentColor">
                  <path d="M20.7465 5.48825L21.9799 3.33745L22.646 2.20024L21.4125 0.0494437V0H14.8259L17.2928 4.3016L17.9836 5.48825H20.7465Z" />
                  <path d="M7.15395 19.9258L14.5546 7.02104L15.4673 5.43884L13.0004 1.13724L12.3097 0.0247596H1.8995L0.666057 2.17556L0 3.31276L1.23344 5.46356V5.51301H9.12745L2.96025 16.267L2.09685 17.7998L3.33029 19.9506V20H7.15395" />
                  <path d="M17.4655 19.9257H21.2398L26.1736 11.3225L27.037 9.83924L25.8036 7.68844V7.63899H22.0046L19.5377 11.9406L19.365 12.262L16.8981 7.96038L16.7255 7.63899L14.2586 11.9406L13.5679 13.1272L17.2682 19.5796L17.4655 19.9257Z" />
                </svg>
                7TV Badges
                <span className="text-xs opacity-70">({loadingSeventvBadges ? '...' : seventvBadges.length})</span>
              </button>
              
              <button
                onClick={() => setActiveTab('7tv-paints')}
                className={`px-4 py-2 rounded-lg transition-all flex items-center gap-2 ${
                  activeTab === '7tv-paints'
                    ? 'bg-[#29b6f6] text-white shadow-lg shadow-[#29b6f6]/30'
                    : 'bg-glass text-textSecondary hover:bg-glass/80 hover:text-textPrimary'
                }`}
              >
                <svg className="w-4 h-4" viewBox="0 0 28 21" fill="currentColor">
                  <path d="M20.7465 5.48825L21.9799 3.33745L22.646 2.20024L21.4125 0.0494437V0H14.8259L17.2928 4.3016L17.9836 5.48825H20.7465Z" />
                  <path d="M7.15395 19.9258L14.5546 7.02104L15.4673 5.43884L13.0004 1.13724L12.3097 0.0247596H1.8995L0.666057 2.17556L0 3.31276L1.23344 5.46356V5.51301H9.12745L2.96025 16.267L2.09685 17.7998L3.33029 19.9506V20H7.15395" />
                  <path d="M17.4655 19.9257H21.2398L26.1736 11.3225L27.037 9.83924L25.8036 7.68844V7.63899H22.0046L19.5377 11.9406L19.365 12.262L16.8981 7.96038L16.7255 7.63899L14.2586 11.9406L13.5679 13.1272L17.2682 19.5796L17.4655 19.9257Z" />
                </svg>
                7TV Paints
                <span className="text-xs opacity-70">({loadingSeventvPaints ? '...' : seventvPaints.length})</span>
              </button>
              
              {/* Search Input */}
              <div className="relative ml-auto">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={`Search ${activeTab === 'twitch-badges' ? 'badges' : activeTab === '7tv-badges' ? '7TV badges' : '7TV paints'}...`}
                  className="w-48 pl-9 pr-3 py-2 bg-glass border border-borderSubtle rounded-lg text-sm text-textPrimary placeholder-textSecondary focus:outline-none focus:border-accent transition-colors"
                />
              </div>
            </div>
            
            {/* Collection Counter - shows collected/total for current tab */}
            {isAuthenticated && (
              <>
                {/* Twitch Badges Counter */}
                {activeTab === 'twitch-badges' && totalGlobalBadges > 0 && (
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-glass rounded-lg border border-borderSubtle">
                    <Check size={14} className="text-green-400" />
                    {loadingUserBadges ? (
                      <div className="w-4 h-4 border-2 border-t-transparent border-accent rounded-full animate-spin" />
                    ) : (
                      <span className="text-sm text-textPrimary">
                        <span className="font-semibold text-accent">{collectedCount}</span>
                        <span className="text-textSecondary"> / {totalGlobalBadges} collected</span>
                      </span>
                    )}
                  </div>
                )}
                
                {/* 7TV Badges Counter */}
                {activeTab === '7tv-badges' && seventvBadges.length > 0 && (
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-glass rounded-lg border border-borderSubtle">
                    <Check size={14} className="text-[#29b6f6]" />
                    {loadingUser7TVCosmetics ? (
                      <div className="w-4 h-4 border-2 border-t-transparent border-[#29b6f6] rounded-full animate-spin" />
                    ) : (
                      <span className="text-sm text-textPrimary">
                        <span className="font-semibold text-[#29b6f6]">{userOwned7TVBadgeIds.size}</span>
                        <span className="text-textSecondary"> / {seventvBadges.length} owned</span>
                      </span>
                    )}
                  </div>
                )}
                
                {/* 7TV Paints Counter */}
                {activeTab === '7tv-paints' && seventvPaints.length > 0 && (
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-glass rounded-lg border border-borderSubtle">
                    <Check size={14} className="text-[#29b6f6]" />
                    {loadingUser7TVCosmetics ? (
                      <div className="w-4 h-4 border-2 border-t-transparent border-[#29b6f6] rounded-full animate-spin" />
                    ) : (
                      <span className="text-sm text-textPrimary">
                        <span className="font-semibold text-[#29b6f6]">{userOwned7TVPaintIds.size}</span>
                        <span className="text-textSecondary"> / {seventvPaints.length} owned</span>
                      </span>
                    )}
                  </div>
                )}
              </>
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
          {/* ========== TWITCH BADGES TAB ========== */}
          {activeTab === 'twitch-badges' && (
            <>
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
            </>
          )}

          {/* ========== 7TV BADGES TAB ========== */}
          {activeTab === '7tv-badges' && (
            <>
              {loadingSeventvBadges && (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#29b6f6] mx-auto mb-4"></div>
                    <p className="text-textSecondary">Loading 7TV badges...</p>
                  </div>
                </div>
              )}

              {seventvBadgesError && (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <p className="text-red-400 mb-4">{seventvBadgesError}</p>
                    <button
                      onClick={() => { setSeventvBadges([]); loadSeventvBadges(); }}
                      className="px-4 py-2 bg-[#29b6f6] hover:bg-[#29b6f6]/80 rounded-lg transition-colors text-white"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}

              {!loadingSeventvBadges && !seventvBadgesError && seventvBadges.length === 0 && (
                <div className="flex items-center justify-center h-full">
                  <p className="text-textSecondary">No 7TV badges found</p>
                </div>
              )}

              {!loadingSeventvBadges && !seventvBadgesError && seventvBadges.length > 0 && (
                <div className="grid grid-cols-8 gap-2">
                  {seventvBadges
                    .filter(badge => !searchQuery || badge.name.toLowerCase().includes(searchQuery.toLowerCase()))
                    .map((badge) => {
                    const animated = isAnimatedBadge(badge);
                    const isOwned = userOwned7TVBadgeIds.has(badge.id);
                    return (
                      <button
                        key={badge.id}
                        onClick={() => setSelectedSeventvBadge(badge)}
                        className={`flex flex-col items-center gap-2 p-3 rounded-lg hover:bg-glass transition-all duration-200 group cursor-pointer relative ${
                          isOwned ? 'ring-2 ring-[#29b6f6]/50 bg-[#29b6f6]/10' : ''
                        }`}
                        title={badge.description || badge.name}
                      >
                        {/* Owned indicator */}
                        {isOwned && (
                          <div className="absolute top-1 right-1 w-5 h-5 bg-[#29b6f6] rounded-full flex items-center justify-center shadow-lg z-10">
                            <Check size={12} className="text-white" />
                          </div>
                        )}
                        <div className={`w-18 h-18 flex items-center justify-center bg-glass rounded-lg group-hover:scale-110 transition-transform duration-200 ${
                          isOwned ? 'ring-1 ring-[#29b6f6]/30' : ''
                        }`}>
                          <img
                            src={getSeventvBadgeImageUrl(badge)}
                            alt={badge.name}
                            className="w-16 h-16 object-contain"
                            loading="lazy"
                          />
                        </div>
                        <span className={`text-xs text-center line-clamp-2 transition-colors font-medium ${
                          isOwned ? 'text-[#29b6f6]' : 'text-textSecondary group-hover:text-textPrimary'
                        }`}>
                          {badge.name}
                        </span>

                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* ========== 7TV PAINTS TAB ========== */}
          {activeTab === '7tv-paints' && (
            <>
              {loadingSeventvPaints && (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#29b6f6] mx-auto mb-4"></div>
                    <p className="text-textSecondary">Loading 7TV paints...</p>
                  </div>
                </div>
              )}

              {seventvPaintsError && (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <p className="text-red-400 mb-4">{seventvPaintsError}</p>
                    <button
                      onClick={() => { setSeventvPaints([]); loadSeventvPaints(); }}
                      className="px-4 py-2 bg-[#29b6f6] hover:bg-[#29b6f6]/80 rounded-lg transition-colors text-white"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}

              {!loadingSeventvPaints && !seventvPaintsError && seventvPaints.length === 0 && (
                <div className="flex items-center justify-center h-full">
                  <p className="text-textSecondary">No 7TV paints found</p>
                </div>
              )}

              {!loadingSeventvPaints && !seventvPaintsError && seventvPaints.length > 0 && (
                <div className="grid grid-cols-8 gap-2">
                  {seventvPaints
                    .filter(paint => !searchQuery || paint.name.toLowerCase().includes(searchQuery.toLowerCase()))
                    .map((paint) => {
                    const animated = isAnimatedPaint(paint);
                    const animatedUrl = animated ? getAnimatedPaintImageUrl(paint) : null;
                    const isOwned = userOwned7TVPaintIds.has(paint.id);
                    
                    return (
                      <button
                        key={paint.id}
                        onClick={() => setSelectedSeventvPaint(paint)}
                        className={`flex flex-col items-center gap-2 p-3 rounded-lg hover:bg-glass transition-all duration-200 group cursor-pointer relative ${
                          isOwned ? 'ring-2 ring-[#29b6f6]/50 bg-[#29b6f6]/10' : ''
                        }`}
                        title={paint.description || paint.name}
                      >
                        {/* Owned indicator */}
                        {isOwned && (
                          <div className="absolute top-1 right-1 w-5 h-5 bg-[#29b6f6] rounded-full flex items-center justify-center shadow-lg z-10">
                            <Check size={12} className="text-white" />
                          </div>
                        )}
                        <div 
                          className={`w-20 h-14 flex items-center justify-center rounded-lg group-hover:scale-110 transition-transform duration-200 overflow-hidden bg-secondary relative ${
                            isOwned ? 'ring-1 ring-[#29b6f6]/30' : ''
                          }`}
                        >
                          {/* For animated image paints, show the animated image with text overlay */}
                          {animated && animatedUrl ? (
                            <>
                              <img 
                                src={animatedUrl} 
                                alt="" 
                                className="absolute inset-0 w-full h-full object-cover"
                                style={{ 
                                  maskImage: 'linear-gradient(black, black)',
                                  WebkitMaskImage: 'linear-gradient(black, black)'
                                }}
                              />
                              <span 
                                className="text-base font-bold px-1 truncate relative z-10 mix-blend-overlay text-white"
                                style={{ textShadow: '0 0 2px rgba(0,0,0,0.8)' }}
                              >
                                {paint.name}
                              </span>
                            </>
                          ) : (
                            /* For gradient paints, use background-clip text effect with shadow */
                            <span 
                              className="text-base font-bold px-1 truncate relative"
                              data-text={paint.name}
                              style={{ 
                                background: generatePaintGradient(paint),
                                backgroundClip: 'text',
                                WebkitBackgroundClip: 'text',
                                WebkitTextFillColor: 'transparent',
                                filter: generatePaintShadow(paint) !== 'none' ? `drop-shadow(${generatePaintShadow(paint).split(',')[0]})` : 'none'
                              }}
                            >
                              {paint.name}
                            </span>
                          )}
                        </div>
                        <span className={`text-xs text-center line-clamp-2 transition-colors font-medium ${
                          isOwned ? 'text-[#29b6f6]' : 'text-textSecondary group-hover:text-textPrimary'
                        }`}>
                          {paint.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      
      {/* 7TV Badge Detail Modal */}
      {selectedSeventvBadge && createPortal(
        <div 
          className="fixed inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          style={{ zIndex: 100000 }}
          onClick={() => setSelectedSeventvBadge(null)}
        >
          <div 
            className="bg-secondary border border-borderSubtle rounded-xl shadow-2xl p-6 max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-xl font-bold text-textPrimary">{selectedSeventvBadge.name}</h3>
              <button
                onClick={() => setSelectedSeventvBadge(null)}
                className="p-1 hover:bg-glass rounded-lg transition-colors"
              >
                <X size={18} className="text-textSecondary" />
              </button>
            </div>
            
            {/* Large badge preview */}
            <div className="flex justify-center mb-6">
              <div className={`w-32 h-32 flex items-center justify-center bg-glass rounded-xl ${isAnimatedBadge(selectedSeventvBadge) ? 'ring-4 ring-[#29b6f6]/50' : ''}`}>
                <img
                  src={getSeventvBadgeImageUrl(selectedSeventvBadge)}
                  alt={selectedSeventvBadge.name}
                  className="w-28 h-28 object-contain"
                />
              </div>
            </div>
            
            {/* Badge info */}
            <div className="space-y-3">
              {selectedSeventvBadge.description && (
                <div>
                  <span className="text-xs text-textSecondary uppercase tracking-wider">Description</span>
                  <p className="text-textPrimary mt-1">{selectedSeventvBadge.description}</p>
                </div>
              )}
              

              
              {isAnimatedBadge(selectedSeventvBadge) && (
                <div className="flex items-center gap-2 text-[#29b6f6]">
                  <span className="w-2 h-2 bg-[#29b6f6] rounded-full animate-pulse"></span>
                  <span className="text-sm">Animated Badge</span>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 7TV Paint Detail Modal */}
      {selectedSeventvPaint && createPortal(
        <div 
          className="fixed inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          style={{ zIndex: 100000 }}
          onClick={() => setSelectedSeventvPaint(null)}
        >
          <div 
            className="bg-secondary border border-borderSubtle rounded-xl shadow-2xl p-6 max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-xl font-bold text-textPrimary">{selectedSeventvPaint.name}</h3>
              <button
                onClick={() => setSelectedSeventvPaint(null)}
                className="p-1 hover:bg-glass rounded-lg transition-colors"
              >
                <X size={18} className="text-textSecondary" />
              </button>
            </div>
            
            {/* Large paint preview with user's name */}
            <div className="flex justify-center mb-6">
              <div className="px-8 py-6 bg-glass rounded-xl border border-borderSubtle">
                <span 
                  className="text-3xl font-bold"
                  style={{ 
                    background: generatePaintGradient(selectedSeventvPaint),
                    backgroundClip: 'text',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    filter: generatePaintShadow(selectedSeventvPaint) !== 'none' ? `drop-shadow(${generatePaintShadow(selectedSeventvPaint).split(',')[0]})` : 'none'
                  }}
                >
                  {currentUser?.display_name || currentUser?.login || 'YourName'}
                </span>
              </div>
            </div>
            
            {/* Paint gradient preview bar */}
            <div 
              className="h-8 rounded-lg mb-6"
              style={{ background: generatePaintGradient(selectedSeventvPaint) }}
            />
            
            {/* Paint info */}
            <div className="space-y-3">
              {selectedSeventvPaint.description && (
                <div>
                  <span className="text-xs text-textSecondary uppercase tracking-wider">Description</span>
                  <p className="text-textPrimary mt-1">{selectedSeventvPaint.description}</p>
                </div>
              )}
              
              {selectedSeventvPaint.tags.length > 0 && (
                <div>
                  <span className="text-xs text-textSecondary uppercase tracking-wider">Tags</span>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {selectedSeventvPaint.tags.map((tag, i) => (
                      <span key={i} className="px-2 py-1 bg-[#29b6f6]/10 text-[#29b6f6] text-xs rounded-lg">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default BadgesOverlay;
