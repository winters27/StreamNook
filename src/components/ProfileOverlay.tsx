import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/AppStore';
import { X, User } from 'lucide-react';
import { getUserCosmetics, computePaintStyle, getBadgeImageUrl } from '../services/seventvService';
import { getAllUserBadges, TwitchBadge } from '../services/badgeService';
import { getAllThirdPartyBadges, ThirdPartyBadge } from '../services/thirdPartyBadges';
import { SevenTVBadge, SevenTVPaint } from '../types';

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
  const [isLoadingBadges, setIsLoadingBadges] = useState(false);

  // Fetch badges when overlay opens and user is authenticated
  useEffect(() => {
    const fetchBadges = async () => {
      if (!isOpen || !isAuthenticated || !currentUser) {
        return;
      }

      setIsLoadingBadges(true);
      
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
        
        // Get channel context - use current stream if available, otherwise use user's own channel
        const channelId = currentStream?.user_id || currentUser.user_id;
        const channelName = currentStream?.user_login || currentUser.login || currentUser.username;
        
        console.log('[ProfileOverlay] Fetching badges for:', { 
          userId: currentUser.user_id, 
          username: currentUser.login, 
          channelId, 
          channelName 
        });
        
        // Fetch Twitch badges
        try {
          const badgeData = await getAllUserBadges(
            currentUser.user_id, 
            currentUser.login || currentUser.username, 
            channelId, 
            channelName
          );
          
          const uniqueBadges = new Map<string, TwitchBadge>();
          
          // Add display badges first
          badgeData.displayBadges.forEach(badge => {
            uniqueBadges.set(badge.id, badge);
          });
          
          // Add earned badges that aren't already displayed
          badgeData.earnedBadges.forEach(badge => {
            if (!uniqueBadges.has(badge.id)) {
              uniqueBadges.set(badge.id, badge);
            }
          });
          
          setTwitchBadges(Array.from(uniqueBadges.values()));
        } catch (err) {
          console.error('[ProfileOverlay] Failed to fetch Twitch badges:', err);
          setTwitchBadges([]);
        }
        
        // Fetch 7TV cosmetics
        try {
          const cosmetics = await getUserCosmetics(currentUser.user_id);
          if (cosmetics) {
            const selectedPaint = cosmetics.paints.find((p) => p.selected);
            if (selectedPaint) {
              setSeventvPaint(selectedPaint as any);
            }
            setSeventvBadges(cosmetics.badges as any);
          }
        } catch (err) {
          console.error('[ProfileOverlay] Failed to fetch 7TV cosmetics:', err);
        }
        
        // Fetch third-party badges
        try {
          const thirdPartyBadgeData = await getAllThirdPartyBadges(currentUser.user_id);
          setThirdPartyBadges(thirdPartyBadgeData);
        } catch (err) {
          console.error('[ProfileOverlay] Failed to fetch third-party badges:', err);
          setThirdPartyBadges([]);
        }
      } catch (error) {
        console.error('[ProfileOverlay] Failed to fetch badges:', error);
      } finally {
        setIsLoadingBadges(false);
      }
    };
    
    fetchBadges();
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
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p 
                      className="text-textSecondary text-sm truncate"
                      style={seventvPaint ? computePaintStyle(seventvPaint as any, '#9146FF') : undefined}
                    >
                      @{currentUser?.login || 'user'}
                    </p>
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
                </div>
              </div>

              {/* Badges Section */}
              {(twitchBadges.length > 0 || seventvBadges.length > 0 || thirdPartyBadges.length > 0) && (
                <div className="space-y-3">
                  {/* Twitch Badges */}
                  {twitchBadges.length > 0 && (
                    <div>
                      <p className="text-[10px] text-textSecondary mb-1.5 font-semibold uppercase tracking-wide">Twitch Badges</p>
                      <div className="flex items-center gap-1.5 flex-wrap p-2 glass-panel rounded-lg">
                        {twitchBadges.map((badge, idx) => (
                          <img 
                            key={`twitch-${badge.id}-${idx}`}
                            src={badge.image1x}
                            srcSet={`${badge.image1x} 1x, ${badge.image2x} 2x, ${badge.image4x} 4x`}
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
                          const badgeUrl = getBadgeImageUrl(badge as any);
                          return badgeUrl ? (
                            <img 
                              key={`7tv-${badge.id}-${idx}`}
                              src={badgeUrl}
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
                        {thirdPartyBadges.map((badge, idx) => (
                          <img 
                            key={`${badge.provider}-${badge.id}-${idx}`}
                            src={badge.imageUrl}
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
                    <path d="M80,32,48,112V416h96v64h64l64-64h80L464,304V32ZM416,288l-64,64H256l-64,64V352H112V80H416Z"/>
                    <rect x="320" y="143" width="48" height="129"/>
                    <rect x="208" y="143" width="48" height="129"/>
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
                  <path d="M80,32,48,112V416h96v64h64l64-64h80L464,304V32ZM416,288l-64,64H256l-64,64V352H112V80H416Z"/>
                  <rect x="320" y="143" width="48" height="129"/>
                  <rect x="208" y="143" width="48" height="129"/>
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
