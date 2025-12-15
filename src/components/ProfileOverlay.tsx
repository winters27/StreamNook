import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../stores/AppStore';
import { X, User, ExternalLink } from 'lucide-react';
import { computePaintStyle, getBadgeImageUrl, getBadgeImageUrls } from '../services/seventvService';
import { TwitchBadge } from '../services/badgeService';
import { ThirdPartyBadge } from '../services/thirdPartyBadges';
import { SevenTVBadge, SevenTVPaint } from '../types';
import {
  getProfileFromMemoryCache,
  getFullProfileWithFallback,
  refreshProfileInBackground,
  CachedProfile
} from '../services/cosmeticsCache';

interface ProfileOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  anchorPosition: { x: number; y: number };
}

const ProfileOverlay = ({ isOpen, onClose, anchorPosition }: ProfileOverlayProps) => {
  const { isAuthenticated, currentUser, loginToTwitch, logoutFromTwitch, isLoading, currentStream } = useAppStore();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [twitchBadges, setTwitchBadges] = useState<TwitchBadge[]>([]);
  const [thirdPartyBadges, setThirdPartyBadges] = useState<ThirdPartyBadge[]>([]);
  const [seventvBadges, setSeventvBadges] = useState<SevenTVBadge[]>([]);
  const [seventvPaint, setSeventvPaint] = useState<SevenTVPaint | null>(null);
  const [seventvUserId, setSeventvUserId] = useState<string | null>(null);
  const [has7TVAccountChecked, setHas7TVAccountChecked] = useState(false);
  const [isLoadingBadges, setIsLoadingBadges] = useState(false);
  const hasInitializedRef = useRef(false);
  const lastUserIdRef = useRef<string | null>(null);

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
      console.log('[ProfileOverlay] Using cached profile data');
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

    const selectedPaint = profile.seventvCosmetics.paints.find((p: any) => p.selected);
    if (selectedPaint) {
      setSeventvPaint(selectedPaint as SevenTVPaint);
    }
  };

  // Open 7TV cosmetics page
  const handleOpen7TVCosmetics = async () => {
    if (!seventvUserId) return;
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(`https://7tv.app/users/${seventvUserId}/cosmetics`);
    } catch (err) {
      console.error('Failed to open 7TV cosmetics page:', err);
    }
  };

  // Open 7TV homepage for account creation
  const handleCreate7TVAccount = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open('https://7tv.app/');
    } catch (err) {
      console.error('Failed to open 7TV page:', err);
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
      console.error('[ProfileOverlay] Failed to fetch profile:', error);
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
        console.log('[ProfileOverlay] Cache is stale, refreshing in background');
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
  }, [isOpen, isAuthenticated, currentUser, currentStream]);

  if (!isOpen) return null;

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
          <button
            onClick={onClose}
            className="p-1 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all"
          >
            <X size={18} />
          </button>
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
                  <div className="flex items-center gap-1.5">
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
                  {/* Current 7TV Paint Badge */}
                  {seventvPaint && (
                    <div
                      className="mt-1 px-1.5 py-px rounded text-[9px] font-bold inline-block cursor-pointer hover:scale-105 transition-transform relative overflow-hidden"
                      style={{
                        ...computePaintStyle(seventvPaint as any, '#9146FF'),
                        WebkitBackgroundClip: 'padding-box',
                        backgroundClip: 'padding-box',
                        isolation: 'isolate',
                        contain: 'paint',
                      }}
                      title={`Current Paint: ${seventvPaint.name}`}
                      onClick={handleOpen7TVCosmetics}
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

              {/* Badges Section - Filter out broadcaster and subscriber badges as they're irrelevant in profile context */}
              {(twitchBadges.filter(b => (b as any).setID !== 'broadcaster' && (b as any).setID !== 'subscriber').length > 0 || seventvBadges.length > 0 || thirdPartyBadges.length > 0) && (
                <div className="space-y-3">
                  {/* Twitch Badges */}
                  {twitchBadges.filter(b => (b as any).setID !== 'broadcaster' && (b as any).setID !== 'subscriber').length > 0 && (
                    <div>
                      <p className="text-[10px] text-textSecondary mb-1.5 font-semibold uppercase tracking-wide">Twitch Badges</p>
                      <div className="flex items-center gap-1.5 flex-wrap p-2 glass-panel rounded-lg">
                        {twitchBadges.filter(b => (b as any).setID !== 'broadcaster' && (b as any).setID !== 'subscriber').map((badge, idx) => (
                          <img
                            key={`twitch-${badge.id}-${idx}`}
                            src={(badge as any).image4x || (badge as any).image1x}
                            srcSet={`${(badge as any).image1x} 1x, ${(badge as any).image2x} 2x, ${(badge as any).image4x} 4x`}
                            alt={badge.title}
                            title={badge.title}
                            className="w-5 h-5 cursor-pointer hover:scale-110 transition-transform"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 7TV Badges */}
                  {seventvBadges.length > 0 && (
                    <div>
                      <p className="text-[10px] text-textSecondary mb-1.5 font-semibold uppercase tracking-wide">7TV Badges</p>
                      <div className="flex items-center gap-1.5 flex-wrap p-2 glass-panel rounded-lg">
                        {seventvBadges.map((badge, idx) => {
                          const urls = getBadgeImageUrls(badge as any);
                          return urls.url4x ? (
                            <img
                              key={`7tv-${badge.id}-${idx}`}
                              src={urls.url4x}
                              srcSet={`${urls.url1x} 1x, ${urls.url2x} 2x, ${urls.url4x} 4x`}
                              alt={badge.tooltip || badge.name}
                              title={badge.tooltip || badge.name}
                              className="w-5 h-5 cursor-pointer hover:scale-110 transition-transform"
                              onClick={async () => {
                                try {
                                  const { open } = await import('@tauri-apps/plugin-shell');
                                  await open(`https://7tv.app/badges/${badge.id}`);
                                } catch (err) {
                                  console.error('Failed to open URL:', err);
                                }
                              }}
                              onError={(e) => {
                                e.currentTarget.style.display = 'none';
                              }}
                            />
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
                                  console.error('Failed to open URL:', err);
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
              )}

              {/* Loading indicator for initial fetch */}
              {isLoadingBadges && twitchBadges.length === 0 && seventvBadges.length === 0 && thirdPartyBadges.length === 0 && (
                <div className="flex items-center justify-center py-4">
                  <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                  <span className="ml-2 text-textSecondary text-sm">Loading badges...</span>
                </div>
              )}

              {/* 7TV Button - Edit Cosmetics or Create Account */}
              {has7TVAccountChecked && (
                seventvUserId ? (
                  <button
                    onClick={handleOpen7TVCosmetics}
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
                    <span>Edit 7TV Cosmetics</span>
                  </button>
                ) : (
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
                    <span>Create 7TV Account</span>
                    <ExternalLink size={14} className="opacity-60" />
                  </button>
                )
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
                  <span>Logout from Twitch</span>
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
                <span>{isLoading ? 'Logging in...' : 'Login to Twitch'}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default ProfileOverlay;
