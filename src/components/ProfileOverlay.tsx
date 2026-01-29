import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../stores/AppStore';
import { X, User, ExternalLink, Link, Unlink, Maximize2 } from 'lucide-react';
import ProfileModal from './ProfileModal';
import { computePaintStyle, getBadgeImageUrl, getBadgeImageUrls, getBadgeFallbackUrls, queueCosmeticForCaching } from '../services/seventvService';
import { FallbackImage } from './FallbackImage';
import { TwitchBadge } from '../services/badgeService';
import { ThirdPartyBadge } from '../services/thirdPartyBadges';
import { SevenTVBadge, SevenTVPaint } from '../types';
import {
  getProfileFromMemoryCache,
  getFullProfileWithFallback,
  refreshProfileInBackground,
  CachedProfile
} from '../services/cosmeticsCache';
import { invoke } from '@tauri-apps/api/core';

import { Logger } from '../utils/logger';
interface ProfileOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  anchorPosition: { x: number; y: number };
}

// Simple memory cache for chat identity badges
interface ChatIdentityCache {
  badges: ChatIdentityBadge[];
  lastFetched: number;
  userId: string;
}

interface ChatIdentityBadge {
  id: string;
  version: string;
  title: string;
  image_url: string;
  is_selected: boolean;
}

// Exported for sharing with ProfileModal
export let chatIdentityCache: ChatIdentityCache | null = null;
export const CHAT_IDENTITY_CACHE_TTL = 10 * 60 * 1000; // 10 minutes - badges rarely change
export const CHAT_IDENTITY_BACKGROUND_REFRESH_TTL = 2 * 60 * 1000; // 2 minutes before background refresh

export const setChatIdentityCache = (cache: ChatIdentityCache | null) => {
  chatIdentityCache = cache;
};

const ProfileOverlay = ({ isOpen, onClose, anchorPosition }: ProfileOverlayProps) => {
  const { isAuthenticated, currentUser, loginToTwitch, logoutFromTwitch, isLoading, currentStream } = useAppStore();
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [twitchBadges, setTwitchBadges] = useState<TwitchBadge[]>([]);
  const [thirdPartyBadges, setThirdPartyBadges] = useState<ThirdPartyBadge[]>([]);
  const [seventvBadges, setSeventvBadges] = useState<SevenTVBadge[]>([]);
  const [seventvPaint, setSeventvPaint] = useState<SevenTVPaint | null>(null);
  const [allSeventvPaints, setAllSeventvPaints] = useState<SevenTVPaint[]>([]);
  const [seventvUserId, setSeventvUserId] = useState<string | null>(null);
  const [has7TVAccountChecked, setHas7TVAccountChecked] = useState(false);
  const [isLoadingBadges, setIsLoadingBadges] = useState(false);
  const [seventvAuthConnected, setSeventvAuthConnected] = useState(false);
  const [updatingSeventvPaintId, setUpdatingSeventvPaintId] = useState<string | null>(null);
  const [updatingSeventvBadgeId, setUpdatingSeventvBadgeId] = useState<string | null>(null);
  const [showSeventvTokenInput, setShowSeventvTokenInput] = useState(false);
  const [seventvTokenInput, setSeventvTokenInput] = useState('');
  const [isConnecting7TV, setIsConnecting7TV] = useState(false);
  const hasInitializedRef = useRef(false);
  const lastUserIdRef = useRef<string | null>(null);

  // Chat Identity State
  interface ChatIdentityBadge {
    id: string;
    version: string;
    title: string;
    image_url: string;
    is_selected: boolean;
  }

  const [chatIdentityBadges, setChatIdentityBadges] = useState<ChatIdentityBadge[]>([]);
  const [isFetchingIdentity, setIsFetchingIdentity] = useState(false);
  const [updatingBadgeId, setUpdatingBadgeId] = useState<string | null>(null);

  useEffect(() => {
    let unlistenFound: (() => void) | undefined;
    let unlistenUpdate: (() => void) | undefined;

    const setupListeners = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      
      unlistenFound = await listen('chat-identity-badges-found', (event: any) => {
        const result = event.payload;
        if (result.success && currentUser?.user_id) {
          setChatIdentityBadges(result.badges);
          // Update cache
          chatIdentityCache = {
            badges: result.badges,
            lastFetched: Date.now(),
            userId: currentUser.user_id
          };
          Logger.debug('[ProfileOverlay] Chat identity badges cached:', result.badges.length);
        }
        setIsFetchingIdentity(false);
      });

      unlistenUpdate = await listen('chat-identity-update-result', (event: any) => {
        const result = event.payload;
        if (result.success) {
          // Update local state to reflect change
          setChatIdentityBadges(prev => {
            const updated = prev.map(b => ({
              ...b,
              is_selected: b.id === result.badge_id
            }));
            // Also update cache
            if (chatIdentityCache) {
              chatIdentityCache.badges = updated;
            }
            return updated;
          });
        }
        setUpdatingBadgeId(null);
      });
    };

    setupListeners();

    return () => {
      if (unlistenFound) unlistenFound();
      if (unlistenUpdate) unlistenUpdate();
    };
  }, [currentUser?.user_id]);

  const fetchChatIdentity = async () => {
    if (!currentUser?.login) return;
    setIsFetchingIdentity(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('fetch_chat_identity_badges', { channelName: currentUser.login });
    } catch (e) {
      Logger.error('Failed to fetch identity:', e);
      setIsFetchingIdentity(false);
    }
  };

  const updateChatIdentity = async (badge: ChatIdentityBadge) => {
    if (!currentUser?.login || updatingBadgeId) return;
    setUpdatingBadgeId(badge.id);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('update_chat_identity', { 
        channelName: currentUser.login,
        badgeId: badge.id,
        badgeVersion: badge.version
      });
    } catch (e) {
      Logger.error('Failed to update identity:', e);
      setUpdatingBadgeId(null);
    }
  };

  // Load cached profile data immediately when user changes or on initial mount
  useEffect(() => {
    if (!isAuthenticated || !currentUser) {
      // Clear badges when not authenticated
      setTwitchBadges([]);
      setThirdPartyBadges([]);
      setSeventvBadges([]);
      setSeventvPaint(null);
      setSeventvUserId(null);
      setHas7TVAccountChecked(false);
      lastUserIdRef.current = null;
      hasInitializedRef.current = false;
      return;
    }

    // Check if user changed
    if (lastUserIdRef.current === currentUser.user_id && hasInitializedRef.current) {
      return; // Same user, already initialized
    }

    lastUserIdRef.current = currentUser.user_id;
    hasInitializedRef.current = true;

    // Try to load from memory cache immediately (synchronous, instant)
    const cachedProfile = getProfileFromMemoryCache(currentUser.user_id);
    if (cachedProfile) {
      Logger.debug('[ProfileOverlay] Using cached profile data');
      applyProfileData(cachedProfile);
    }

    // Fetch profile in background (will update cache)
    const channelId = currentStream?.user_id || currentUser.user_id;
    const channelName = currentStream?.user_login || currentUser.login || currentUser.username;

    // Start background fetch
    fetchAndCacheProfile(currentUser.user_id, currentUser.login || currentUser.username, channelId, channelName, !cachedProfile);
  }, [isAuthenticated, currentUser, currentStream]);

  // Helper to apply profile data to state
  const applyProfileData = (profile: CachedProfile) => {
    setTwitchBadges(profile.twitchBadges);
    setThirdPartyBadges(profile.thirdPartyBadges);
    setSeventvBadges(profile.seventvCosmetics.badges);
    setSeventvUserId(profile.seventvCosmetics.seventvUserId || null);
    setHas7TVAccountChecked(true);

    // Store all paints
    setAllSeventvPaints(profile.seventvCosmetics.paints as SevenTVPaint[]);

    const selectedPaint = profile.seventvCosmetics.paints.find((p: any) => p.selected);
    if (selectedPaint) {
      setSeventvPaint(selectedPaint as SevenTVPaint);
    }
  };

  // Reactive caching for 7TV cosmetics displayed in profile
  useEffect(() => {
    // Cache 7TV badges
    seventvBadges.forEach((badge: any) => {
      if (badge?.id && !badge.localUrl) {
        const badgeUrl = `https://cdn.7tv.app/badge/${badge.id}/4x`;
        queueCosmeticForCaching(badge.id, badgeUrl);
      }
    });
    
    // Cache paint image layers
    if ((seventvPaint as any)?.data?.layers) {
      ((seventvPaint as any).data.layers as any[]).forEach((layer: any) => {
        if (layer.ty?.__typename === 'PaintLayerTypeImage' && layer.ty.images) {
          const img = layer.ty.images.find((i: any) => i.scale === 1) || layer.ty.images[0];
          if (img && !img.localUrl) {
            queueCosmeticForCaching(layer.id, img.url);
          }
        }
      });
    }
  }, [seventvBadges, seventvPaint]);

  // Check 7TV auth status on mount and listen for connection events
  useEffect(() => {
    const check7TVAuth = async () => {
      try {
        const status = await invoke('get_seventv_auth_status') as { is_authenticated: boolean; user_id?: string };
        Logger.debug('[ProfileOverlay] 7TV auth status:', status);
        setSeventvAuthConnected(status.is_authenticated);
      } catch (e) {
        Logger.debug('[ProfileOverlay] 7TV auth check failed (expected if not connected):', e);
        setSeventvAuthConnected(false);
      }
    };
    if (isOpen && isAuthenticated) {
      check7TVAuth();
    }

    // Listen for 7TV connection success event
    let unlisten: (() => void) | undefined;
    const setupListener = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen('seventv-connected', () => {
        Logger.debug('[ProfileOverlay] 7TV connected event received!');
        setSeventvAuthConnected(true);
        setIsConnecting7TV(false);
      });
    };
    setupListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, [isOpen, isAuthenticated]);

  // Handle 7TV paint selection
  const handleSelectSeventvPaint = async (paint: SevenTVPaint | null) => {
    if (!seventvUserId || updatingSeventvPaintId) return;
    
    const paintId = paint?.id || null;
    setUpdatingSeventvPaintId(paintId || 'none');
    
    try {
      const result = await invoke('set_seventv_paint', { 
        userId: seventvUserId,
        paintId 
      }) as { success: boolean; error?: string };
      
      if (result.success) {
        // Update local state
        setSeventvPaint(paint);
        setAllSeventvPaints(prev => prev.map(p => ({
          ...p,
          selected: p.id === paintId
        })));
        Logger.debug('[ProfileOverlay] 7TV paint updated successfully');
      } else {
        Logger.error('[ProfileOverlay] Failed to update 7TV paint:', result.error);
      }
    } catch (e) {
      Logger.error('[ProfileOverlay] Failed to update 7TV paint:', e);
    } finally {
      setUpdatingSeventvPaintId(null);
    }
  };

  // Handle 7TV badge selection
  const handleSelectSeventvBadge = async (badge: SevenTVBadge | null) => {
    if (!seventvUserId || updatingSeventvBadgeId) return;
    
    const badgeId = badge?.id || null;
    setUpdatingSeventvBadgeId(badgeId || 'none');
    
    try {
      const result = await invoke('set_seventv_badge', { 
        userId: seventvUserId,
        badgeId 
      }) as { success: boolean; error?: string };
      
      if (result.success) {
        // Update local state
        setSeventvBadges(prev => prev.map(b => ({
          ...b,
          selected: b.id === badgeId
        })));
        Logger.debug('[ProfileOverlay] 7TV badge updated successfully');
      } else {
        Logger.error('[ProfileOverlay] Failed to update 7TV badge:', result.error);
      }
    } catch (e) {
      Logger.error('[ProfileOverlay] Failed to update 7TV badge:', e);
    } finally {
      setUpdatingSeventvBadgeId(null);
    }
  };

  // Open 7TV cosmetics page
  const handleOpen7TVCosmetics = async () => {
    if (!seventvUserId) return;
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(`https://7tv.app/users/${seventvUserId}/cosmetics`);
    } catch (err) {
      Logger.error('Failed to open 7TV cosmetics page:', err);
    }
  };

  // Open 7TV homepage for account creation
  const handleCreate7TVAccount = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open('https://7tv.app/');
    } catch (err) {
      Logger.error('Failed to open 7TV page:', err);
    }
  };

  // Fetch profile data and cache it
  const fetchAndCacheProfile = async (userId: string, username: string, channelId: string, channelName: string, showLoading: boolean) => {
    if (showLoading) {
      setIsLoadingBadges(true);
    }

    try {
      // If we already have cached data, refresh in background silently
      const existingCache = getProfileFromMemoryCache(userId);

      if (existingCache) {
        // Background refresh - don't show loading, just update when done
        refreshProfileInBackground(userId, username, channelId, channelName).then(() => {
          const updatedCache = getProfileFromMemoryCache(userId);
          if (updatedCache) {
            applyProfileData(updatedCache);
          }
        });
      } else {
        // No cache - fetch and wait
        const profile = await getFullProfileWithFallback(userId, username, channelId, channelName);
        applyProfileData(profile);
      }
    } catch (error) {
      Logger.error('[ProfileOverlay] Failed to fetch profile:', error);
    } finally {
      setIsLoadingBadges(false);
    }
  };

  // Refresh badges when overlay opens (background refresh for fresh data)
  useEffect(() => {
    if (!isOpen || !isAuthenticated || !currentUser) {
      return;
    }

    // If we have cached data, trigger a background refresh for any updates
    const cachedProfile = getProfileFromMemoryCache(currentUser.user_id);
    if (cachedProfile) {
      const channelId = currentStream?.user_id || currentUser.user_id;
      const channelName = currentStream?.user_login || currentUser.login || currentUser.username;

      // Only refresh if cache is older than 60 seconds
      const cacheAge = Date.now() - cachedProfile.lastUpdated;
      if (cacheAge > 60000) {
        Logger.debug('[ProfileOverlay] Cache is stale, refreshing in background');
        refreshProfileInBackground(
          currentUser.user_id,
          currentUser.login || currentUser.username,
          channelId,
          channelName
        ).then(() => {
          const updatedCache = getProfileFromMemoryCache(currentUser.user_id);
          if (updatedCache) {
            applyProfileData(updatedCache);
          }
        });
      }
    }

    // Chat Identity Badge Caching Logic - Always show cache first, fetch in background
    if (chatIdentityCache && 
        chatIdentityCache.userId === currentUser.user_id &&
        chatIdentityCache.badges.length > 0) {
      
      // Always apply cached data immediately (even if state already has badges)
      Logger.debug('[ProfileOverlay] Loading chat identity badges from cache:', chatIdentityCache.badges.length);
      setChatIdentityBadges(chatIdentityCache.badges);
      
      const cacheAge = Date.now() - chatIdentityCache.lastFetched;
      
      // If cache is fresh enough, don't fetch at all
      if (cacheAge < CHAT_IDENTITY_BACKGROUND_REFRESH_TTL) {
        Logger.debug('[ProfileOverlay] Cache is fresh, no fetch needed');
        return;
      }
      
      // If cache is slightly stale but within TTL, do a silent background refresh
      if (cacheAge < CHAT_IDENTITY_CACHE_TTL && !isFetchingIdentity) {
        Logger.debug('[ProfileOverlay] Cache slightly stale, silent background refresh');
        // Don't show loading spinner - badges are already visible
        const silentFetch = async () => {
          try {
            await invoke('fetch_chat_identity_badges', { channelName: currentUser.login });
          } catch (e) {
            // Silent fail - we already have cached badges
          }
        };
        silentFetch();
        return;
      }
      
      // Cache is too old, still show cached but fetch fresh
      if (!isFetchingIdentity) {
        Logger.debug('[ProfileOverlay] Cache too old, fetching fresh data');
        fetchChatIdentity();
      }
      return;
    }
    
    // No cache - need to fetch (this will show loading spinner)
    if (!isFetchingIdentity) {
      Logger.debug('[ProfileOverlay] No cache, fetching chat identity badges');
      fetchChatIdentity();
    }
  }, [isOpen, isAuthenticated, currentUser, currentStream]);

  // Show ProfileModal even when dropdown is closed
  if (!isOpen && !showProfileModal) return null;
  
  // If modal is open, only render the modal
  if (showProfileModal) {
    return (
      <ProfileModal
        isOpen={showProfileModal}
        onClose={() => setShowProfileModal(false)}
      />
    );
  }

  const handleLogin = async () => {
    await loginToTwitch();
    onClose();
  };

  const handleLogout = async () => {
    await logoutFromTwitch();
    setShowLogoutConfirm(false);
    onClose();
  };

  // Position the overlay near the profile icon
  const overlayStyle = {
    position: 'fixed' as const,
    top: `${anchorPosition.y + 10}px`,
    right: '10px',
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
      />

      {/* Overlay */}
      <div
        style={overlayStyle}
        className="z-50 w-72 glass-panel backdrop-blur-xl border border-borderLight rounded-lg shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-borderSubtle">
          <h3 className="text-textPrimary font-semibold">Profile</h3>
          <div className="flex items-center gap-1">
            {isAuthenticated && (
              <button
                onClick={() => {
                  setShowProfileModal(true);
                  onClose();
                }}
                className="p-1 text-textSecondary hover:text-accent hover:bg-glass rounded transition-all"
                title="Expand to full view"
              >
                <Maximize2 size={16} />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-4">
          {isAuthenticated ? (
            <div className="space-y-4">
              {/* User Info */}
              <div className="flex items-center gap-3 p-3 glass-panel rounded-lg">
                <div className="w-12 h-12 rounded-full bg-accent/20 flex items-center justify-center">
                  {currentUser?.profile_image_url ? (
                    <img
                      src={currentUser.profile_image_url}
                      alt="Profile"
                      className="w-full h-full rounded-full object-cover"
                    />
                  ) : (
                    <User size={24} className="text-accent" />
                  )}
                </div>
                <div className="flex-1 min-w-0" style={{ isolation: 'isolate' }}>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {/* Currently selected Twitch global badge */}
                    {chatIdentityBadges.find(b => b.is_selected) && (
                      <img
                        src={chatIdentityBadges.find(b => b.is_selected)?.image_url}
                        alt={chatIdentityBadges.find(b => b.is_selected)?.title}
                        title={`Twitch: ${chatIdentityBadges.find(b => b.is_selected)?.title}`}
                        className="w-5 h-5 flex-shrink-0"
                      />
                    )}
                    {/* Currently selected 7TV badge */}
                    {(() => {
                      const selected7TVBadge = seventvBadges.find((b: any) => b.selected);
                      if (selected7TVBadge) {
                        const urls = getBadgeImageUrls(selected7TVBadge as any);
                        return urls.url4x ? (
                          <FallbackImage
                            src={urls.url4x}
                            fallbackUrls={getBadgeFallbackUrls(selected7TVBadge.id).slice(1)}
                            alt={selected7TVBadge.tooltip || selected7TVBadge.name}
                            title={`7TV: ${selected7TVBadge.tooltip || selected7TVBadge.name}`}
                            className="w-5 h-5 flex-shrink-0"
                          />
                        ) : null;
                      }
                      return null;
                    })()}
                    <span
                      className="text-textSecondary text-sm truncate inline-block"
                      style={seventvPaint ? { ...computePaintStyle(seventvPaint as any, '#9146FF'), isolation: 'isolate' } : undefined}
                    >
                      @{currentUser?.login || 'user'}
                    </span>
                    {currentUser?.broadcaster_type === 'partner' && (
                      <div title="Verified Partner">
                        <svg
                          className="w-4 h-4 flex-shrink-0"
                          viewBox="0 0 16 16"
                          fill="#9146FF"
                        >
                          <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd"></path>
                        </svg>
                      </div>
                    )}
                  </div>
                  {/* Current 7TV Paint indicator */}
                  {seventvPaint && (
                    <div
                      className="mt-1 px-1.5 py-px rounded text-[9px] font-bold inline-block cursor-pointer hover:scale-105 hover:ring-1 hover:ring-accent/50 transition-all relative overflow-hidden"
                      style={{
                        ...computePaintStyle(seventvPaint as any, '#9146FF'),
                        WebkitBackgroundClip: 'padding-box',
                        backgroundClip: 'padding-box',
                        isolation: 'isolate',
                        contain: 'paint',
                      }}
                      title={`Click to view paint details: ${seventvPaint.name}`}
                      onClick={() => useAppStore.getState().openBadgesWithPaint(seventvPaint.id)}
                    >
                      <span
                        style={{
                          ...computePaintStyle(seventvPaint as any, '#9146FF'),
                          filter: 'invert(1) contrast(1.5)',
                          WebkitBackgroundClip: 'text',
                          backgroundClip: 'text',
                          isolation: 'isolate',
                        }}
                      >
                        🎨 {seventvPaint.name}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Badges Section */}
              <div className="space-y-3">
                {/* Twitch Global Badges (Combined: Display + Select) */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[10px] text-textSecondary font-semibold uppercase tracking-wide flex items-center gap-1">
                      <svg fill="currentColor" viewBox="0 0 512 512" className="w-3 h-3 text-[#9146FF]"><path d="M80,32,48,112V416h96v64h64l64-64h80L464,304V32ZM416,288l-64,64H256l-64,64V352H112V80H416Z" /><rect x="320" y="143" width="48" height="129" /><rect x="208" y="143" width="48" height="129" /></svg>
                      Global Badges
                    </p>
                    <button 
                      onClick={() => fetchChatIdentity()}
                      disabled={isFetchingIdentity}
                      className="p-1 text-textSecondary hover:text-accent hover:bg-glass rounded transition-all"
                      title="Refresh Available Badges"
                    >
                      <svg 
                        xmlns="http://www.w3.org/2000/svg" 
                        width="14" 
                        height="14" 
                        viewBox="0 0 24 24" 
                        fill="none" 
                        stroke="currentColor" 
                        strokeWidth="2" 
                        strokeLinecap="round" 
                        strokeLinejoin="round"
                        className={isFetchingIdentity ? "animate-spin" : ""}
                      >
                        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                        <path d="M16 21h5v-5" />
                      </svg>
                    </button>
                  </div>
                  
                  {isFetchingIdentity && chatIdentityBadges.length === 0 ? (
                    <div className="flex items-center justify-center py-3 glass-panel rounded-lg">
                      <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                      <span className="ml-2 text-xs text-textSecondary">Loading badges...</span>
                    </div>
                  ) : chatIdentityBadges.length > 0 ? (
                    <div className="flex items-center gap-1.5 flex-wrap p-2 glass-panel rounded-lg max-h-44 overflow-y-auto custom-scrollbar">
                      {chatIdentityBadges.map((badge) => (
                        <div 
                          key={`${badge.id}-${badge.version}`}
                          className={`
                            relative p-1 rounded cursor-pointer transition-all border-2
                            ${badge.is_selected ? 'border-accent bg-accent/20 ring-1 ring-accent/30' : 'border-transparent hover:bg-glass hover:border-borderLight'}
                            ${updatingBadgeId === badge.id ? 'opacity-50 cursor-wait' : ''}
                          `}
                          onClick={() => !updatingBadgeId && updateChatIdentity(badge)}
                          title={`${badge.title}${badge.is_selected ? ' (Active)' : ' - Click to select'}`}
                        >
                          <img 
                            src={badge.image_url} 
                            alt={badge.title}
                            className="w-5 h-5" 
                          />
                          {updatingBadgeId === badge.id && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded">
                              <div className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                            </div>
                          )}
                          {badge.is_selected && (
                            <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-accent rounded-full border border-background" />
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-3 glass-panel rounded-lg text-xs text-textSecondary">
                      <span className="italic">No badges loaded</span>
                    </div>
                  )}
                </div>

                  {/* 7TV Paints - Selectable if connected */}
                  {allSeventvPaints.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <p className="text-[10px] text-textSecondary font-semibold uppercase tracking-wide flex items-center gap-1">
                          <svg className="w-3 h-3 text-[#29b6f6]" viewBox="0 0 28 21" fill="currentColor"><path d="M20.7465 5.48825L21.9799 3.33745L22.646 2.20024L21.4125 0.0494437V0H14.8259L17.2928 4.3016L17.9836 5.48825H20.7465Z" /><path d="M7.15395 19.9258L14.5546 7.02104L15.4673 5.43884L13.0004 1.13724L12.3097 0.0247596H1.8995L0.666057 2.17556L0 3.31276L1.23344 5.46356V5.51301H9.12745L2.96025 16.267L2.09685 17.7998L3.33029 19.9506V20H7.15395" /><path d="M17.4655 19.9257H21.2398L26.1736 11.3225L27.037 9.83924L25.8036 7.68844V7.63899H22.0046L19.5377 11.9406L19.365 12.262L16.8981 7.96038L16.7255 7.63899L14.2586 11.9406L13.5679 13.1272L17.2682 19.5796L17.4655 19.9257Z" /></svg>
                          Paints {seventvAuthConnected && <span className="text-green-400">(Connected)</span>}
                        </p>
                        {!seventvAuthConnected && (
                          <span className="text-[9px] text-yellow-500/70 italic">View only</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap p-2 glass-panel rounded-lg max-h-32 overflow-y-auto custom-scrollbar">
                        {allSeventvPaints.map((paint) => {
                          const isSelected = seventvPaint?.id === paint.id;
                          const isUpdating = updatingSeventvPaintId === paint.id;
                          return (
                            <div 
                              key={`7tv-paint-${paint.id}`}
                              className={`
                                relative px-2 py-1 rounded cursor-pointer transition-all border-2 text-[10px] font-bold
                                ${isSelected ? 'border-[#29b6f6] bg-glass/50 ring-1 ring-[#29b6f6]/30' : 'border-transparent hover:bg-glass hover:border-borderLight'}
                                ${isUpdating ? 'opacity-50 cursor-wait' : ''}
                                ${!seventvAuthConnected ? 'cursor-default' : ''}
                              `}
                              onClick={() => seventvAuthConnected && !isUpdating && handleSelectSeventvPaint(isSelected ? null : paint)}
                              title={seventvAuthConnected 
                                ? `${paint.name}${isSelected ? ' (Active) - Click to unequip' : ' - Click to equip'}` 
                                : `${paint.name} - Connect 7TV to change`
                              }
                            >
                              <span style={computePaintStyle(paint as any, '#29b6f6')}>
                                {paint.name}
                              </span>
                              {isUpdating && (
                                <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded">
                                  <div className="w-3 h-3 border-2 border-[#29b6f6] border-t-transparent rounded-full animate-spin" />
                                </div>
                              )}
                              {isSelected && (
                                <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-[#29b6f6] rounded-full border border-background" />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* 7TV Badges - Selectable if connected */}
                  {seventvBadges.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <p className="text-[10px] text-textSecondary font-semibold uppercase tracking-wide flex items-center gap-1">
                          <svg className="w-3 h-3 text-[#29b6f6]" viewBox="0 0 28 21" fill="currentColor"><path d="M20.7465 5.48825L21.9799 3.33745L22.646 2.20024L21.4125 0.0494437V0H14.8259L17.2928 4.3016L17.9836 5.48825H20.7465Z" /><path d="M7.15395 19.9258L14.5546 7.02104L15.4673 5.43884L13.0004 1.13724L12.3097 0.0247596H1.8995L0.666057 2.17556L0 3.31276L1.23344 5.46356V5.51301H9.12745L2.96025 16.267L2.09685 17.7998L3.33029 19.9506V20H7.15395" /><path d="M17.4655 19.9257H21.2398L26.1736 11.3225L27.037 9.83924L25.8036 7.68844V7.63899H22.0046L19.5377 11.9406L19.365 12.262L16.8981 7.96038L16.7255 7.63899L14.2586 11.9406L13.5679 13.1272L17.2682 19.5796L17.4655 19.9257Z" /></svg>
                          Badges {seventvAuthConnected && <span className="text-green-400">(Connected)</span>}
                        </p>
                        {!seventvAuthConnected && (
                          <span className="text-[9px] text-yellow-500/70 italic">View only</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap p-2 glass-panel rounded-lg">
                        {seventvBadges.map((badge, idx) => {
                          const urls = getBadgeImageUrls(badge as any);
                          const isSelected = (badge as any).selected;
                          const isUpdating = updatingSeventvBadgeId === badge.id;
                          return urls.url4x ? (
                            <div
                              key={`7tv-${badge.id}-${idx}`}
                              className={`
                                relative p-1 rounded cursor-pointer transition-all border-2
                                ${isSelected ? 'border-[#29b6f6] bg-[#29b6f6]/20 ring-1 ring-[#29b6f6]/30' : 'border-transparent hover:bg-glass hover:border-borderLight'}
                                ${isUpdating ? 'opacity-50 cursor-wait' : ''}
                                ${!seventvAuthConnected ? 'cursor-default' : ''}
                              `}
                              onClick={() => seventvAuthConnected && !isUpdating && handleSelectSeventvBadge(isSelected ? null : badge)}
                              title={seventvAuthConnected 
                                ? `${badge.tooltip || badge.name}${isSelected ? ' (Active) - Click to unequip' : ' - Click to equip'}` 
                                : `${badge.tooltip || badge.name} - Connect 7TV to change`
                              }
                            >
                              <FallbackImage
                                src={urls.url4x}
                                fallbackUrls={getBadgeFallbackUrls(badge.id).slice(1)}
                                alt={badge.tooltip || badge.name}
                                className="w-5 h-5"
                              />
                              {isUpdating && (
                                <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded">
                                  <div className="w-3 h-3 border-2 border-[#29b6f6] border-t-transparent rounded-full animate-spin" />
                                </div>
                              )}
                              {isSelected && (
                                <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-[#29b6f6] rounded-full border border-background" />
                              )}
                            </div>
                          ) : null;
                        })}
                      </div>
                    </div>
                  )}

                  {/* Third-Party Badges */}
                  {thirdPartyBadges.length > 0 && (
                    <div>
                      <p className="text-[10px] text-textSecondary mb-1.5 font-semibold uppercase tracking-wide">Other Badges</p>
                      <div className="flex items-center gap-1.5 flex-wrap p-2 glass-panel rounded-lg">
                        {thirdPartyBadges.map((badge: any, idx) => (
                          <img
                            key={`${badge.provider}-${badge.id}-${idx}`}
                            src={badge.image4x || badge.imageUrl}
                            srcSet={badge.image1x && badge.image2x && badge.image4x 
                              ? `${badge.image1x} 1x, ${badge.image2x} 2x, ${badge.image4x} 4x`
                              : undefined}
                            alt={badge.title}
                            title={`${badge.title} (${badge.provider.toUpperCase()})`}
                            className="w-5 h-5 cursor-pointer hover:scale-110 transition-transform"
                            onClick={async () => {
                              if (badge.link) {
                                try {
                                  const { open } = await import('@tauri-apps/plugin-shell');
                                  await open(badge.link);
                                } catch (err) {
                                  Logger.error('Failed to open URL:', err);
                                }
                              }
                            }}
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>

              {/* Loading indicator for initial fetch */}
              {isLoadingBadges && twitchBadges.length === 0 && seventvBadges.length === 0 && thirdPartyBadges.length === 0 && (
                <div className="flex items-center justify-center py-4">
                  <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                  <span className="ml-2 text-textSecondary text-sm">Loading badges...</span>
                </div>
              )}

              {/* 7TV Buttons */}
              {has7TVAccountChecked && seventvUserId && (
                <div className="space-y-2">
                  {/* Connect/Disconnect 7TV button */}
                  {seventvAuthConnected ? (
                    <button
                      onClick={async () => {
                        try {
                          await invoke('logout_seventv');
                          setSeventvAuthConnected(false);
                          Logger.debug('[ProfileOverlay] Disconnected from 7TV');
                        } catch (e) {
                          Logger.error('[ProfileOverlay] Failed to disconnect from 7TV:', e);
                        }
                      }}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 glass-button text-red-400 font-medium group hover:bg-red-500/10"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 28 21" fill="currentColor"><path d="M20.7465 5.48825L21.9799 3.33745L22.646 2.20024L21.4125 0.0494437V0H14.8259L17.2928 4.3016L17.9836 5.48825H20.7465Z" /><path d="M7.15395 19.9258L14.5546 7.02104L15.4673 5.43884L13.0004 1.13724L12.3097 0.0247596H1.8995L0.666057 2.17556L0 3.31276L1.23344 5.46356V5.51301H9.12745L2.96025 16.267L2.09685 17.7998L3.33029 19.9506V20H7.15395" /><path d="M17.4655 19.9257H21.2398L26.1736 11.3225L27.037 9.83924L25.8036 7.68844V7.63899H22.0046L19.5377 11.9406L19.365 12.262L16.8981 7.96038L16.7255 7.63899L14.2586 11.9406L13.5679 13.1272L17.2682 19.5796L17.4655 19.9257Z" /></svg>
                      <span>Disconnect</span>
                      <Unlink size={14} className="opacity-60" />
                    </button>
                  ) : (
                    <button
                      onClick={async () => {
                        try {
                          setIsConnecting7TV(true);
                          await invoke('open_seventv_login_window');
                          Logger.debug('[ProfileOverlay] Opening 7TV login window. After logging in, the token will be captured automatically.');
                        } catch (e) {
                          Logger.error('[ProfileOverlay] Failed to open 7TV login window:', e);
                          setIsConnecting7TV(false);
                        }
                      }}
                      disabled={isConnecting7TV}
                      className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 glass-button text-[#29b6f6] font-medium group hover:bg-[#29b6f6]/10 ${isConnecting7TV ? 'opacity-70 cursor-wait' : ''}`}
                    >
                      {/* 7TV Logo */}
                      <svg
                        className="w-4 h-4 text-[#29b6f6] group-hover:scale-110 transition-transform"
                        viewBox="0 0 28 21"
                        fill="currentColor"
                      >
                        <path d="M20.7465 5.48825L21.9799 3.33745L22.646 2.20024L21.4125 0.0494437V0H14.8259L17.2928 4.3016L17.9836 5.48825H20.7465Z" />
                        <path d="M7.15395 19.9258L14.5546 7.02104L15.4673 5.43884L13.0004 1.13724L12.3097 0.0247596H1.8995L0.666057 2.17556L0 3.31276L1.23344 5.46356V5.51301H9.12745L2.96025 16.267L2.09685 17.7998L3.33029 19.9506V20H7.15395" />
                        <path d="M17.4655 19.9257H21.2398L26.1736 11.3225L27.037 9.83924L25.8036 7.68844V7.63899H22.0046L19.5377 11.9406L19.365 12.262L16.8981 7.96038L16.7255 7.63899L14.2586 11.9406L13.5679 13.1272L17.2682 19.5796L17.4655 19.9257Z" />
                      </svg>
                      <span>{isConnecting7TV ? 'Connecting...' : 'Connect'}</span>
                      {isConnecting7TV ? (
                        <div className="w-3.5 h-3.5 border-2 border-[#29b6f6] border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <Link size={14} className="opacity-60" />
                      )}
                    </button>
                  )}
                  
                  {/* Edit cosmetics on website button */}
                  <button
                    onClick={handleOpen7TVCosmetics}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 glass-button text-textSecondary text-sm font-medium group hover:text-textPrimary"
                  >
                    <svg className="w-3.5 h-3.5 text-[#29b6f6]" viewBox="0 0 28 21" fill="currentColor"><path d="M20.7465 5.48825L21.9799 3.33745L22.646 2.20024L21.4125 0.0494437V0H14.8259L17.2928 4.3016L17.9836 5.48825H20.7465Z" /><path d="M7.15395 19.9258L14.5546 7.02104L15.4673 5.43884L13.0004 1.13724L12.3097 0.0247596H1.8995L0.666057 2.17556L0 3.31276L1.23344 5.46356V5.51301H9.12745L2.96025 16.267L2.09685 17.7998L3.33029 19.9506V20H7.15395" /><path d="M17.4655 19.9257H21.2398L26.1736 11.3225L27.037 9.83924L25.8036 7.68844V7.63899H22.0046L19.5377 11.9406L19.365 12.262L16.8981 7.96038L16.7255 7.63899L14.2586 11.9406L13.5679 13.1272L17.2682 19.5796L17.4655 19.9257Z" /></svg>
                    <span>Edit on Website</span>
                    <ExternalLink size={12} className="opacity-60" />
                  </button>
                </div>
              )}

              {/* No 7TV account - Create account button */}
              {has7TVAccountChecked && !seventvUserId && (
                <button
                  onClick={handleCreate7TVAccount}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 glass-button text-textPrimary font-medium group"
                >
                  {/* 7TV Logo */}
                  <svg
                    className="w-4 h-4 text-[#29b6f6] group-hover:scale-110 transition-transform"
                    viewBox="0 0 28 21"
                    fill="currentColor"
                  >
                    <path d="M20.7465 5.48825L21.9799 3.33745L22.646 2.20024L21.4125 0.0494437V0H14.8259L17.2928 4.3016L17.9836 5.48825H20.7465Z" />
                    <path d="M7.15395 19.9258L14.5546 7.02104L15.4673 5.43884L13.0004 1.13724L12.3097 0.0247596H1.8995L0.666057 2.17556L0 3.31276L1.23344 5.46356V5.51301H9.12745L2.96025 16.267L2.09685 17.7998L3.33029 19.9506V20H7.15395" />
                    <path d="M17.4655 19.9257H21.2398L26.1736 11.3225L27.037 9.83924L25.8036 7.68844V7.63899H22.0046L19.5377 11.9406L19.365 12.262L16.8981 7.96038L16.7255 7.63899L14.2586 11.9406L13.5679 13.1272L17.2682 19.5796L17.4655 19.9257Z" />
                  </svg>
                  <span>Create Account</span>
                  <ExternalLink size={14} className="opacity-60" />
                </button>
              )}

              {/* Logout Button */}
              {!showLogoutConfirm ? (
                <button
                  onClick={() => setShowLogoutConfirm(true)}
                  disabled={isLoading}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 glass-button text-textPrimary font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg
                    fill="currentColor"
                    viewBox="0 0 512 512"
                    xmlns="http://www.w3.org/2000/svg"
                    className="w-5 h-5"
                  >
                    <path d="M80,32,48,112V416h96v64h64l64-64h80L464,304V32ZM416,288l-64,64H256l-64,64V352H112V80H416Z" />
                    <rect x="320" y="143" width="48" height="129" />
                    <rect x="208" y="143" width="48" height="129" />
                  </svg>
                  <span>Logout</span>
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-textSecondary text-sm text-center">
                    Are you sure you want to logout?
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowLogoutConfirm(false)}
                      className="flex-1 px-4 py-2 glass-button text-textPrimary font-medium"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleLogout}
                      disabled={isLoading}
                      className="flex-1 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Logout
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Not Logged In Message */}
              <div className="text-center py-4">
                <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-accent/10 flex items-center justify-center">
                  <User size={32} className="text-accent" />
                </div>
                <p className="text-textPrimary font-medium mb-1">Not Logged In</p>
                <p className="text-textSecondary text-sm">
                  Login to access your followed streams and chat
                </p>
              </div>

              {/* Login Button */}
              <button
                onClick={handleLogin}
                disabled={isLoading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[#9146FF] hover:bg-[#772CE8] text-white font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg
                  fill="currentColor"
                  viewBox="0 0 512 512"
                  xmlns="http://www.w3.org/2000/svg"
                  className="w-5 h-5"
                >
                  <path d="M80,32,48,112V416h96v64h64l64-64h80L464,304V32ZM416,288l-64,64H256l-64,64V352H112V80H416Z" />
                  <rect x="320" y="143" width="48" height="129" />
                  <rect x="208" y="143" width="48" height="129" />
                </svg>
                <span>{isLoading ? 'Logging in...' : 'Login'}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default ProfileOverlay;
