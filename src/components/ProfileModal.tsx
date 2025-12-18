import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../stores/AppStore';
import { X, User, ExternalLink, Link, Unlink, Maximize2, Settings, Crown } from 'lucide-react';
import { computePaintStyle, getBadgeImageUrls } from '../services/seventvService';
import { TwitchBadge } from '../services/badgeService';
import { ThirdPartyBadge } from '../services/thirdPartyBadges';
import { SevenTVBadge, SevenTVPaint } from '../types';
import {
  getProfileFromMemoryCache,
  getFullProfileWithFallback,
  refreshProfileInBackground,
  CachedProfile
} from '../services/cosmeticsCache';
import { clearUserCache as clear7TVCache } from '../services/seventvService';
import { chatIdentityCache, setChatIdentityCache, CHAT_IDENTITY_CACHE_TTL, CHAT_IDENTITY_BACKGROUND_REFRESH_TTL } from './ProfileOverlay';
import { invoke } from '@tauri-apps/api/core';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ChatIdentityBadge {
  id: string;
  version: string;
  title: string;
  image_url: string;
  is_selected: boolean;
}

const ProfileModal = ({ isOpen, onClose }: ProfileModalProps) => {
  const { isAuthenticated, currentUser, loginToTwitch, logoutFromTwitch, isLoading, currentStream } = useAppStore();
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
  const [isConnecting7TV, setIsConnecting7TV] = useState(false);
  const [chatIdentityBadges, setChatIdentityBadges] = useState<ChatIdentityBadge[]>([]);
  const [isFetchingIdentity, setIsFetchingIdentity] = useState(false);
  const [updatingBadgeId, setUpdatingBadgeId] = useState<string | null>(null);
  const hasInitializedRef = useRef(false);
  const lastUserIdRef = useRef<string | null>(null);

  // Listen for events
  useEffect(() => {
    let unlistenFound: (() => void) | undefined;
    let unlistenUpdate: (() => void) | undefined;
    let unlisten7TV: (() => void) | undefined;

    const setupListeners = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      
      unlistenFound = await listen('chat-identity-badges-found', (event: any) => {
        const result = event.payload;
        if (result.success) {
          setChatIdentityBadges(result.badges);
        }
        setIsFetchingIdentity(false);
      });

      unlistenUpdate = await listen('chat-identity-update-result', (event: any) => {
        const result = event.payload;
        if (result.success) {
          setChatIdentityBadges(prev => prev.map(b => ({
            ...b,
            is_selected: b.id === result.badge_id
          })));
        }
        setUpdatingBadgeId(null);
      });

      unlisten7TV = await listen('seventv-connected', () => {
        setSeventvAuthConnected(true);
        setIsConnecting7TV(false);
      });
    };

    if (isOpen) {
      setupListeners();
    }

    return () => {
      if (unlistenFound) unlistenFound();
      if (unlistenUpdate) unlistenUpdate();
      if (unlisten7TV) unlisten7TV();
    };
  }, [isOpen]);

  // Load profile data
  useEffect(() => {
    if (!isOpen || !isAuthenticated || !currentUser) return;

    const loadProfile = async () => {
      setIsLoadingBadges(true);
      
      // Check 7TV auth status
      try {
        const status = await invoke('get_seventv_auth_status') as { is_authenticated: boolean };
        setSeventvAuthConnected(status.is_authenticated);
      } catch (e) {
        setSeventvAuthConnected(false);
      }

      // Load cached profile
      const cachedProfile = getProfileFromMemoryCache(currentUser.user_id);
      if (cachedProfile) {
        applyProfileData(cachedProfile);
      }

      // Fetch fresh data
      const channelId = currentStream?.user_id || currentUser.user_id;
      const channelName = currentStream?.user_login || currentUser.login || currentUser.username;
      
      try {
        const profile = await getFullProfileWithFallback(
          currentUser.user_id,
          currentUser.login || currentUser.username,
          channelId,
          channelName
        );
        applyProfileData(profile);
      } catch (e) {
        console.error('[ProfileModal] Failed to load profile:', e);
      }
      
      setIsLoadingBadges(false);

      // Fetch chat identity badges
      fetchChatIdentity();
    };

    loadProfile();
  }, [isOpen, isAuthenticated, currentUser]);

  const applyProfileData = (profile: CachedProfile) => {
    setTwitchBadges(profile.twitchBadges);
    setThirdPartyBadges(profile.thirdPartyBadges);
    setSeventvBadges(profile.seventvCosmetics.badges);
    setSeventvUserId(profile.seventvCosmetics.seventvUserId || null);
    setHas7TVAccountChecked(true);
    setAllSeventvPaints(profile.seventvCosmetics.paints as SevenTVPaint[]);

    const selectedPaint = profile.seventvCosmetics.paints.find((p: any) => p.selected);
    if (selectedPaint) {
      setSeventvPaint(selectedPaint as SevenTVPaint);
    }
  };

  const fetchChatIdentity = async (showSpinner = true) => {
    if (!currentUser?.login) return;
    if (showSpinner) setIsFetchingIdentity(true);
    try {
      await invoke('fetch_chat_identity_badges', { channelName: currentUser.login });
    } catch (e) {
      setIsFetchingIdentity(false);
    }
  };

  // Load chat identity badges from shared cache on mount
  useEffect(() => {
    if (!isOpen || !currentUser?.user_id) return;

    // Immediately load from shared cache if available
    if (chatIdentityCache && 
        chatIdentityCache.userId === currentUser.user_id &&
        chatIdentityCache.badges.length > 0) {
      console.log('[ProfileModal] Loading chat identity badges from shared cache:', chatIdentityCache.badges.length);
      setChatIdentityBadges(chatIdentityCache.badges);
      
      const cacheAge = Date.now() - chatIdentityCache.lastFetched;
      
      // If cache is fresh, don't fetch
      if (cacheAge < CHAT_IDENTITY_BACKGROUND_REFRESH_TTL) {
        return;
      }
      
      // Silent background refresh - don't show loading spinner
      if (cacheAge < CHAT_IDENTITY_CACHE_TTL) {
        fetchChatIdentity(false);
        return;
      }
      
      // Cache too old, fetch with spinner
      fetchChatIdentity(true);
      return;
    }
    
    // No cache - fetch normally
    fetchChatIdentity(true);
  }, [isOpen, currentUser?.user_id]);

  const updateChatIdentity = async (badge: ChatIdentityBadge) => {
    if (!currentUser?.login || updatingBadgeId) return;
    setUpdatingBadgeId(badge.id);
    try {
      await invoke('update_chat_identity', { 
        channelName: currentUser.login,
        badgeId: badge.id,
        badgeVersion: badge.version
      });
    } catch (e) {
      setUpdatingBadgeId(null);
    }
  };

  const handleSelectSeventvPaint = async (paint: SevenTVPaint | null) => {
    if (!seventvUserId || updatingSeventvPaintId) return;
    
    const paintId = paint?.id || null;
    setUpdatingSeventvPaintId(paintId || 'none');
    
    try {
      const result = await invoke('set_seventv_paint', { userId: seventvUserId, paintId }) as { success: boolean };
      if (result.success) {
        setSeventvPaint(paint);
        setAllSeventvPaints(prev => prev.map(p => ({ ...p, selected: p.id === paintId })));
        // Clear cache so other components fetch fresh data
        clear7TVCache();
        console.log('[ProfileModal] Paint updated, cache cleared');
      }
    } catch (e) {
      console.error('[ProfileModal] Failed to update paint:', e);
    } finally {
      setUpdatingSeventvPaintId(null);
    }
  };

  const handleSelectSeventvBadge = async (badge: SevenTVBadge | null) => {
    if (!seventvUserId || updatingSeventvBadgeId) return;
    
    const badgeId = badge?.id || null;
    setUpdatingSeventvBadgeId(badgeId || 'none');
    
    try {
      const result = await invoke('set_seventv_badge', { userId: seventvUserId, badgeId }) as { success: boolean };
      if (result.success) {
        setSeventvBadges(prev => prev.map(b => ({ ...b, selected: b.id === badgeId })));
        // Clear cache so other components fetch fresh data
        clear7TVCache();
        console.log('[ProfileModal] Badge updated, cache cleared');
      }
    } catch (e) {
      console.error('[ProfileModal] Failed to update badge:', e);
    } finally {
      setUpdatingSeventvBadgeId(null);
    }
  };

  const handleOpen7TVCosmetics = async () => {
    if (!seventvUserId) return;
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(`https://7tv.app/users/${seventvUserId}/cosmetics`);
  };

  const handleOpenTwitchProfile = async () => {
    if (!currentUser?.login) return;
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(`https://twitch.tv/${currentUser.login}`);
  };

  if (!isOpen) return null;

  const selectedGlobalBadge = chatIdentityBadges.find(b => b.is_selected);
  const selected7TVBadge = seventvBadges.find((b: any) => b.selected);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div 
          className="pointer-events-auto w-full max-w-3xl max-h-[90vh] glass-panel backdrop-blur-xl border border-borderLight rounded-xl shadow-2xl overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-5 border-b border-borderSubtle">
            <div className="flex items-center gap-3">
              <Crown size={20} className="text-accent" />
              <h2 className="text-lg font-semibold text-textPrimary">Your Profile</h2>
            </div>
            <button
              onClick={onClose}
              className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-all"
            >
              <X size={20} />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
            {isAuthenticated && currentUser ? (
              <div className="space-y-6">
                {/* Profile Header */}
                <div className="flex items-start gap-6 p-5 glass-panel rounded-xl">
                  {/* Large Profile Picture */}
                  <div className="w-24 h-24 rounded-full bg-accent/20 flex-shrink-0 flex items-center justify-center overflow-hidden ring-4 ring-accent/20">
                    {currentUser.profile_image_url ? (
                      <img
                        src={currentUser.profile_image_url}
                        alt="Profile"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <User size={40} className="text-accent" />
                    )}
                  </div>

                  {/* User Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      {/* Badges */}
                      {selectedGlobalBadge && (
                        <img
                          src={selectedGlobalBadge.image_url}
                          alt={selectedGlobalBadge.title}
                          title={`Twitch: ${selectedGlobalBadge.title}`}
                          className="w-6 h-6"
                        />
                      )}
                      {selected7TVBadge && (() => {
                        const urls = getBadgeImageUrls(selected7TVBadge as any);
                        return urls.url4x ? (
                          <img
                            src={urls.url4x}
                            alt={selected7TVBadge.tooltip || selected7TVBadge.name}
                            title={`7TV: ${selected7TVBadge.tooltip || selected7TVBadge.name}`}
                            className="w-6 h-6"
                          />
                        ) : null;
                      })()}
                      <h3 
                        className="text-2xl font-bold"
                        style={seventvPaint ? computePaintStyle(seventvPaint as any, '#9146FF') : { color: 'var(--text-primary)' }}
                      >
                        {currentUser.display_name || currentUser.login}
                      </h3>
                      {currentUser.broadcaster_type === 'partner' && (
                        <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 16 16" fill="#9146FF">
                          <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd" />
                        </svg>
                      )}
                    </div>
                    <p className="text-textSecondary text-sm mb-3">@{currentUser.login}</p>
                    
                    {/* Current Paint Badge */}
                    {seventvPaint && (
                      <div
                        className="inline-block px-3 py-1 rounded-full text-xs font-bold"
                        style={computePaintStyle(seventvPaint as any, '#29b6f6')}
                      >
                        🎨 {seventvPaint.name}
                      </div>
                    )}
                  </div>

                  {/* Quick Actions */}
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={handleOpenTwitchProfile}
                      className="px-3 py-2 glass-button text-xs font-medium flex items-center gap-2"
                    >
                      <svg fill="currentColor" viewBox="0 0 512 512" className="w-3.5 h-3.5 text-[#9146FF]"><path d="M80,32,48,112V416h96v64h64l64-64h80L464,304V32ZM416,288l-64,64H256l-64,64V352H112V80H416Z" /><rect x="320" y="143" width="48" height="129" /><rect x="208" y="143" width="48" height="129" /></svg>
                      View Profile
                      <ExternalLink size={12} className="opacity-60" />
                    </button>
                    {seventvUserId && (
                      <button
                        onClick={handleOpen7TVCosmetics}
                        className="px-3 py-2 glass-button text-xs font-medium flex items-center gap-2 text-[#29b6f6]"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 28 21" fill="currentColor"><path d="M20.7465 5.48825L21.9799 3.33745L22.646 2.20024L21.4125 0.0494437V0H14.8259L17.2928 4.3016L17.9836 5.48825H20.7465Z" /><path d="M7.15395 19.9258L14.5546 7.02104L15.4673 5.43884L13.0004 1.13724L12.3097 0.0247596H1.8995L0.666057 2.17556L0 3.31276L1.23344 5.46356V5.51301H9.12745L2.96025 16.267L2.09685 17.7998L3.33029 19.9506V20H7.15395" /><path d="M17.4655 19.9257H21.2398L26.1736 11.3225L27.037 9.83924L25.8036 7.68844V7.63899H22.0046L19.5377 11.9406L19.365 12.262L16.8981 7.96038L16.7255 7.63899L14.2586 11.9406L13.5679 13.1272L17.2682 19.5796L17.4655 19.9257Z" /></svg>
                        Edit on Website
                        <ExternalLink size={12} className="opacity-60" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Twitch Global Badges */}
                <div className="glass-panel rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="text-sm font-semibold text-textPrimary uppercase tracking-wide flex items-center gap-1.5">
                      <svg fill="currentColor" viewBox="0 0 512 512" className="w-4 h-4 text-[#9146FF]"><path d="M80,32,48,112V416h96v64h64l64-64h80L464,304V32ZM416,288l-64,64H256l-64,64V352H112V80H416Z" /><rect x="320" y="143" width="48" height="129" /><rect x="208" y="143" width="48" height="129" /></svg>
                      Global Badges
                    </h4>
                    <button 
                      onClick={() => fetchChatIdentity(true)}
                      disabled={isFetchingIdentity}
                      className="p-1.5 text-textSecondary hover:text-accent hover:bg-glass rounded transition-all"
                    >
                      <svg 
                        width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" 
                        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        className={isFetchingIdentity ? "animate-spin" : ""}
                      >
                        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                        <path d="M16 21h5v-5" />
                      </svg>
                    </button>
                  </div>
                  
                  {chatIdentityBadges.length > 0 ? (
                    <div className="grid grid-cols-8 gap-2">
                      {chatIdentityBadges.map((badge) => (
                        <div 
                          key={`${badge.id}-${badge.version}`}
                          className={`
                            relative p-2 rounded-lg cursor-pointer transition-all border-2 flex items-center justify-center
                            ${badge.is_selected ? 'border-accent bg-accent/20' : 'border-transparent hover:bg-glass hover:border-borderLight'}
                            ${updatingBadgeId === badge.id ? 'opacity-50 cursor-wait' : ''}
                          `}
                          onClick={() => !updatingBadgeId && updateChatIdentity(badge)}
                          title={badge.title}
                        >
                          <img src={badge.image_url} alt={badge.title} className="w-8 h-8" />
                          {badge.is_selected && (
                            <div className="absolute -top-1 -right-1 w-3 h-3 bg-accent rounded-full border-2 border-background" />
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-textSecondary text-sm italic">
                      {isFetchingIdentity ? 'Loading badges...' : 'No badges available'}
                    </p>
                  )}
                </div>

                {/* 7TV Section */}
                {(allSeventvPaints.length > 0 || seventvBadges.length > 0) && (
                  <div className="glass-panel rounded-xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <h4 className="text-sm font-semibold text-textPrimary uppercase tracking-wide flex items-center gap-1.5">
                          <svg className="w-4 h-4 text-[#29b6f6]" viewBox="0 0 28 21" fill="currentColor"><path d="M20.7465 5.48825L21.9799 3.33745L22.646 2.20024L21.4125 0.0494437V0H14.8259L17.2928 4.3016L17.9836 5.48825H20.7465Z" /><path d="M7.15395 19.9258L14.5546 7.02104L15.4673 5.43884L13.0004 1.13724L12.3097 0.0247596H1.8995L0.666057 2.17556L0 3.31276L1.23344 5.46356V5.51301H9.12745L2.96025 16.267L2.09685 17.7998L3.33029 19.9506V20H7.15395" /><path d="M17.4655 19.9257H21.2398L26.1736 11.3225L27.037 9.83924L25.8036 7.68844V7.63899H22.0046L19.5377 11.9406L19.365 12.262L16.8981 7.96038L16.7255 7.63899L14.2586 11.9406L13.5679 13.1272L17.2682 19.5796L17.4655 19.9257Z" /></svg>
                          Cosmetics
                        </h4>
                        {seventvAuthConnected && (
                          <span className="px-2 py-0.5 text-[10px] font-medium bg-green-500/20 text-green-400 rounded-full">
                            Connected
                          </span>
                        )}
                      </div>
                      
                      {seventvUserId && (
                        seventvAuthConnected ? (
                          <button
                            onClick={async () => {
                              await invoke('logout_seventv');
                              setSeventvAuthConnected(false);
                            }}
                            className="px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 rounded-lg transition-all flex items-center gap-1.5"
                          >
                            <Unlink size={14} />
                            Disconnect
                          </button>
                        ) : (
                          <button
                            onClick={async () => {
                              setIsConnecting7TV(true);
                              await invoke('open_seventv_login_window');
                            }}
                            disabled={isConnecting7TV}
                            className="px-3 py-1.5 text-xs font-medium text-[#29b6f6] hover:bg-[#29b6f6]/10 rounded-lg transition-all flex items-center gap-1.5"
                          >
                            <Link size={14} />
                            {isConnecting7TV ? 'Connecting...' : 'Connect to Edit'}
                          </button>
                        )
                      )}
                    </div>

                    {/* 7TV Paints */}
                    {allSeventvPaints.length > 0 && (
                      <div className="mb-4">
                        <p className="text-xs text-textSecondary mb-2 font-medium">Paints</p>
                        <div className="flex flex-wrap gap-2">
                          {allSeventvPaints.map((paint) => {
                            const isSelected = seventvPaint?.id === paint.id;
                            const isUpdating = updatingSeventvPaintId === paint.id;
                            return (
                              <div 
                                key={paint.id}
                                className={`
                                  relative px-3 py-1.5 rounded-lg cursor-pointer transition-all border-2 text-sm font-bold
                                  ${isSelected ? 'border-[#29b6f6] bg-glass/50' : 'border-transparent hover:bg-glass hover:border-borderLight'}
                                  ${isUpdating ? 'opacity-50' : ''}
                                  ${!seventvAuthConnected ? 'cursor-default' : ''}
                                `}
                                onClick={() => seventvAuthConnected && !isUpdating && handleSelectSeventvPaint(isSelected ? null : paint)}
                                title={seventvAuthConnected ? paint.name : `${paint.name} - Connect to edit`}
                              >
                                <span style={computePaintStyle(paint as any, '#29b6f6')}>
                                  {paint.name}
                                </span>
                                {isSelected && (
                                  <div className="absolute -top-1 -right-1 w-3 h-3 bg-[#29b6f6] rounded-full border-2 border-background" />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* 7TV Badges */}
                    {seventvBadges.length > 0 && (
                      <div>
                        <p className="text-xs text-textSecondary mb-2 font-medium">Badges</p>
                        <div className="flex flex-wrap gap-2">
                          {seventvBadges.map((badge, idx) => {
                            const urls = getBadgeImageUrls(badge as any);
                            const isSelected = (badge as any).selected;
                            const isUpdating = updatingSeventvBadgeId === badge.id;
                            return urls.url4x ? (
                              <div
                                key={`${badge.id}-${idx}`}
                                className={`
                                  relative p-2 rounded-lg cursor-pointer transition-all border-2
                                  ${isSelected ? 'border-[#29b6f6] bg-[#29b6f6]/20' : 'border-transparent hover:bg-glass hover:border-borderLight'}
                                  ${isUpdating ? 'opacity-50' : ''}
                                  ${!seventvAuthConnected ? 'cursor-default' : ''}
                                `}
                                onClick={() => seventvAuthConnected && !isUpdating && handleSelectSeventvBadge(isSelected ? null : badge)}
                                title={badge.tooltip || badge.name}
                              >
                                <img src={urls.url4x} alt={badge.tooltip || badge.name} className="w-8 h-8" />
                                {isSelected && (
                                  <div className="absolute -top-1 -right-1 w-3 h-3 bg-[#29b6f6] rounded-full border-2 border-background" />
                                )}
                              </div>
                            ) : null;
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Other Badges */}
                {thirdPartyBadges.length > 0 && (
                  <div className="glass-panel rounded-xl p-5">
                    <h4 className="text-sm font-semibold text-textPrimary uppercase tracking-wide mb-4">
                      Other Badges
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {thirdPartyBadges.map((badge: any, idx) => (
                        <div
                          key={`${badge.provider}-${badge.id}-${idx}`}
                          className="p-2 rounded-lg hover:bg-glass transition-all cursor-pointer"
                          title={`${badge.title} (${badge.provider.toUpperCase()})`}
                          onClick={async () => {
                            if (badge.link) {
                              const { open } = await import('@tauri-apps/plugin-shell');
                              await open(badge.link);
                            }
                          }}
                        >
                          <img
                            src={badge.image4x || badge.imageUrl}
                            alt={badge.title}
                            className="w-8 h-8"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12">
                <div className="w-24 h-24 rounded-full bg-accent/10 flex items-center justify-center mb-4">
                  <User size={48} className="text-accent" />
                </div>
                <h3 className="text-xl font-semibold text-textPrimary mb-2">Not Logged In</h3>
                <p className="text-textSecondary mb-6">Login to view and customize your profile</p>
                <button
                  onClick={loginToTwitch}
                  className="px-6 py-3 bg-[#9146FF] hover:bg-[#772CE8] text-white font-medium rounded-lg transition-all flex items-center gap-2"
                >
                  <svg fill="currentColor" viewBox="0 0 512 512" className="w-5 h-5">
                    <path d="M80,32,48,112V416h96v64h64l64-64h80L464,304V32ZM416,288l-64,64H256l-64,64V352H112V80H416Z" />
                    <rect x="320" y="143" width="48" height="129" />
                    <rect x="208" y="143" width="48" height="129" />
                  </svg>
                  Login
                </button>
              </div>
            )}
          </div>

          {/* Footer */}
          {isAuthenticated && (
            <div className="p-4 border-t border-borderSubtle flex items-center justify-between">
              <p className="text-xs text-textSecondary">
                Logged in as <span className="text-textPrimary font-medium">@{currentUser?.login}</span>
              </p>
              {!showLogoutConfirm ? (
                <button
                  onClick={() => setShowLogoutConfirm(true)}
                  className="px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                >
                  Logout
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-textSecondary">Logout?</span>
                  <button
                    onClick={() => setShowLogoutConfirm(false)}
                    className="px-3 py-1.5 text-sm font-medium glass-button"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      logoutFromTwitch();
                      setShowLogoutConfirm(false);
                      onClose();
                    }}
                    className="px-3 py-1.5 text-sm font-medium bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-all"
                  >
                    Confirm
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default ProfileModal;
