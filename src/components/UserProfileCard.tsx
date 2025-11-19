import { useState, useEffect, useMemo, useRef } from 'react';
import { getUserCosmetics, computePaintStyle, getBadgeImageUrl, getBadgeImageUrlForProvider } from '../services/seventvService';
import { getAllUserBadges, TwitchBadge } from '../services/badgeService';
import { getAllThirdPartyBadges, ThirdPartyBadge } from '../services/thirdPartyBadges';
import { SevenTVBadge, SevenTVPaint } from '../types';

interface ParsedMessage {
  username: string;
  content: string;
  color: string;
  badges: Array<{ key: string; info: any }>;
  tags: Map<string, string>;
  emotes: string;
}

interface UserProfileCardProps {
  userId: string;
  username: string;
  displayName: string;
  color: string;
  badges: Array<{ key: string; info: any }>;
  messageHistory: ParsedMessage[];
  onClose: () => void;
  position: { x: number; y: number };
  channelId?: string;
  channelName?: string;
}

interface TwitchUserProfile {
  id: string;
  login: string;
  display_name: string;
  type: string;
  broadcaster_type: string;
  description: string;
  profile_image_url: string;
  offline_image_url: string;
  view_count: number;
  created_at: string;
}

const UserProfileCard = ({
  userId,
  username,
  displayName,
  color,
  messageHistory,
  onClose,
  position,
  channelId: propChannelId,
  channelName: propChannelName
}: UserProfileCardProps) => {
  const [twitchProfile, setTwitchProfile] = useState<TwitchUserProfile | null>(null);
  const [twitchBadges, setTwitchBadges] = useState<TwitchBadge[]>([]);
  const [thirdPartyBadges, setThirdPartyBadges] = useState<ThirdPartyBadge[]>([]);
  const [seventvBadge, setSeventvBadge] = useState<SevenTVBadge | null>(null);
  const [seventvBadges, setSeventvBadges] = useState<SevenTVBadge[]>([]);
  const [seventvPaint, setSeventvPaint] = useState<SevenTVPaint | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'profile' | 'messages'>('profile');
  
  // Dragging state
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [cardPosition, setCardPosition] = useState({ x: 0, y: 0 });
  const cardRef = useRef<HTMLDivElement>(null);

  // Fetch user data
  useEffect(() => {
    const fetchUserData = async () => {
      setIsLoading(true);
      
      try {
        // Fetch Twitch profile using the app's credentials
        const { invoke } = await import('@tauri-apps/api/core');
        const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
        
        const twitchResponse = await fetch(
          `https://api.twitch.tv/helix/users?id=${userId}`,
          {
            headers: {
              'Client-ID': clientId,
              'Authorization': `Bearer ${token}`
            }
          }
        );
        
        if (twitchResponse.ok) {
          const twitchData = await twitchResponse.json();
          if (twitchData.data && twitchData.data.length > 0) {
            setTwitchProfile(twitchData.data[0]);
          }
        }
        
        // Get current channel info from props (if in standalone window) or AppStore
        let channelId: string;
        let channelName: string;
        
        if (propChannelId && propChannelName) {
          // Use props if provided (standalone window mode)
          channelId = propChannelId;
          channelName = propChannelName;
        } else {
          // Fall back to AppStore (inline mode)
          const { useAppStore } = await import('../stores/AppStore');
          const currentStream = useAppStore.getState().currentStream;
          channelId = currentStream?.user_id || userId;
          channelName = currentStream?.user_login || username;
        }
        
        console.log('[UserProfileCard] Fetching badges for:', { userId, username, channelId, channelName });
        
        // Fetch all badges using comprehensive badge service
        try {
          const badgeData = await getAllUserBadges(userId, username, channelId, channelName);
          console.log('[UserProfileCard] Badge data received:', badgeData);
          console.log('[UserProfileCard] Display badges:', badgeData.displayBadges);
          console.log('[UserProfileCard] Earned badges:', badgeData.earnedBadges);
          
          // Prioritize display badges (badges the user is actively showing in chat)
          // Then add earned badges that aren't already in display badges
          const uniqueBadges = new Map<string, TwitchBadge>();
          
          // Add display badges first (these are what the user shows in chat)
          badgeData.displayBadges.forEach(badge => {
            uniqueBadges.set(badge.id, badge);
          });
          
          // Add earned badges that aren't already displayed
          badgeData.earnedBadges.forEach(badge => {
            if (!uniqueBadges.has(badge.id)) {
              uniqueBadges.set(badge.id, badge);
            }
          });
          
          // Filter out broadcaster badge if viewing someone else's profile in a different channel
          const badgesArray = Array.from(uniqueBadges.values()).filter(badge => {
            // If it's a broadcaster badge and the user is not the current channel owner, filter it out
            if (badge.setID === 'broadcaster' && userId !== channelId) {
              console.log('[UserProfileCard] Filtering out broadcaster badge for non-broadcaster user', {
                userId,
                channelId,
                badgeSetID: badge.setID
              });
              return false;
            }
            return true;
          });
          console.log('[UserProfileCard] Setting unique badges:', badgesArray);
          console.log('[UserProfileCard] Badge count:', badgesArray.length);
          setTwitchBadges(badgesArray);
        } catch (err) {
          console.error('[UserProfileCard] Failed to fetch badges:', err);
          setTwitchBadges([]);
        }
        
        // Fetch 7TV cosmetics using v4 API
        const cosmetics = await getUserCosmetics(userId);
        if (cosmetics) {
          // Find selected paint
          const selectedPaint = cosmetics.paints.find((p) => p.selected);
          if (selectedPaint) {
            setSeventvPaint(selectedPaint as any);
          }

          // Find selected badge
          const selectedBadge = cosmetics.badges.find((b) => b.selected);
          if (selectedBadge) {
            setSeventvBadge(selectedBadge as any);
          }

          // Store all badges
          setSeventvBadges(cosmetics.badges as any);
        }
        
        // Fetch third-party badges (FFZ, Chatterino, Homies)
        try {
          const thirdPartyBadgeData = await getAllThirdPartyBadges(userId);
          console.log('[UserProfileCard] Third-party badges:', thirdPartyBadgeData);
          setThirdPartyBadges(thirdPartyBadgeData);
        } catch (err) {
          console.error('[UserProfileCard] Failed to fetch third-party badges:', err);
          setThirdPartyBadges([]);
        }
      } catch (error) {
        console.error('Failed to fetch user profile:', error);
      } finally {
        setIsLoading(false);
      }
    };
    
    fetchUserData();
  }, [userId]);

  // Create username style with 7TV paint
  const usernameStyle = useMemo(() => {
    if (!seventvPaint) {
      return { color };
    }
    
    // Use the new computePaintStyle function
    return computePaintStyle(seventvPaint as any, color);
  }, [seventvPaint, color]);

  // Format account creation date
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
  };

  // Calculate initial position to pop out to the left of chat
  useEffect(() => {
    const cardWidth = 320;
    const cardHeight = 500;
    const padding = 10;
    const gap = 10; // Gap between chat and profile card
    
    // Position card to the left of the chat widget
    let x = position.x - cardWidth - gap;
    let y = position.y;
    
    // If card would go off left edge, position it to the right instead
    if (x < padding) {
      x = position.x + gap;
    }
    
    // Adjust if card would go off bottom edge
    if (y + cardHeight > window.innerHeight - padding) {
      y = window.innerHeight - cardHeight - padding;
    }
    
    // Ensure card doesn't go off top edge
    y = Math.max(padding, y);
    
    setCardPosition({ x, y });
  }, [position]);

  // Handle drag start
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only allow dragging from the header area
    const target = e.target as HTMLElement;
    const isHeader = target.closest('.profile-card-header');
    if (!isHeader) return;
    
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - cardPosition.x,
      y: e.clientY - cardPosition.y
    });
  };

  // Handle drag move
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      
      const newX = e.clientX - dragOffset.x;
      const newY = e.clientY - dragOffset.y;
      
      // Constrain to window bounds
      const cardWidth = cardRef.current?.offsetWidth || 320;
      const cardHeight = cardRef.current?.offsetHeight || 500;
      const padding = 10;
      
      const constrainedX = Math.max(padding, Math.min(newX, window.innerWidth - cardWidth - padding));
      const constrainedY = Math.max(padding, Math.min(newY, window.innerHeight - cardHeight - padding));
      
      setCardPosition({ x: constrainedX, y: constrainedY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset, cardPosition]);

  const cardStyle = useMemo(() => {
    return {
      left: `${cardPosition.x}px`,
      top: `${cardPosition.y}px`,
      cursor: isDragging ? 'grabbing' : 'default'
    };
  }, [cardPosition, isDragging]);

  // Check if we're in a standalone window (no backdrop needed)
  const isStandaloneWindow = window.location.hash.startsWith('#/profile');

  return (
    <>
      {/* Backdrop - only show in inline mode */}
      {!isStandaloneWindow && (
        <div 
          className="fixed inset-0 z-40 group"
        >
          {/* Hover-sensitive background overlay */}
          <div 
            className="absolute inset-0 group-hover:pointer-events-none"
            onClick={onClose}
          />
        </div>
      )}
      
      {/* Profile Card */}
      <div 
        ref={cardRef}
        className={`${isStandaloneWindow ? 'w-full h-full' : 'fixed z-50 w-80'} user-profile-card backdrop-blur-xl shadow-2xl border border-borderSubtle rounded-lg overflow-hidden`}
        style={isStandaloneWindow ? { backgroundColor: 'rgba(0, 0, 0, 0.75)' } : cardStyle}
        onMouseDown={isStandaloneWindow ? undefined : handleMouseDown}
      >
        {/* Header */}
        <div className="relative profile-card-header cursor-grab active:cursor-grabbing">
          {/* Banner */}
          <div 
            className="h-20 bg-gradient-to-br from-accent/20 to-purple-600/20"
            style={{
              backgroundImage: twitchProfile?.offline_image_url 
                ? `url(${twitchProfile.offline_image_url})` 
                : undefined,
              backgroundSize: 'cover',
              backgroundPosition: 'center'
            }}
          />
          
          {/* Profile Picture */}
          <div className="absolute -bottom-8 left-4">
            <div className="w-16 h-16 rounded-full border-4 border-secondary bg-glass overflow-hidden">
              {twitchProfile?.profile_image_url ? (
                <img 
                  src={twitchProfile.profile_image_url} 
                  alt={displayName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-accent/20">
                  <span className="text-2xl font-bold text-textPrimary">
                    {displayName[0].toUpperCase()}
                  </span>
                </div>
              )}
            </div>
          </div>
          
          {/* Close Button */}
          <button
            onClick={onClose}
            className="absolute top-2 right-2 p-1.5 glass-button text-textSecondary hover:text-textPrimary rounded-full"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        {/* User Info */}
        <div className="px-4 pt-10 pb-3">
          <div className="mb-2">
            <div className="flex items-start justify-between mb-1">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <h3 
                    className="text-lg font-bold truncate"
                    style={usernameStyle}
                  >
                    {displayName}
                  </h3>
                  {twitchProfile?.broadcaster_type === 'partner' && (
                    <div title="Verified Partner">
                      <svg 
                        className="w-5 h-5 flex-shrink-0" 
                        viewBox="0 0 16 16" 
                        fill="#9146FF"
                      >
                        <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd"></path>
                      </svg>
                    </div>
                  )}
                </div>
                <p className="text-sm text-textSecondary">@{username}</p>
              </div>
            </div>
            
            {/* Badges Section - Twitch, 7TV, and Third-Party */}
            {(twitchBadges.length > 0 || seventvBadges.length > 0 || thirdPartyBadges.length > 0) && (
              <div className="mt-2 space-y-2">
                {/* Twitch Badges */}
                {twitchBadges.length > 0 && (
                  <div>
                    <p className="text-[10px] text-textSecondary mb-1 font-semibold uppercase tracking-wide">Twitch Badges</p>
                    <div className="flex items-center gap-1 flex-wrap">
                      {twitchBadges.map((badge, idx) => (
                        <img 
                          key={`twitch-gql-${badge.id}-${idx}`}
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
                    <p className="text-[10px] text-textSecondary mb-1 font-semibold uppercase tracking-wide">7TV Badges</p>
                    <div className="flex items-center gap-1 flex-wrap">
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
                
                {/* Third-Party Badges (FFZ, Chatterino, Homies) */}
                {thirdPartyBadges.length > 0 && (
                  <div>
                    <p className="text-[10px] text-textSecondary mb-1 font-semibold uppercase tracking-wide">Other Badges</p>
                    <div className="flex items-center gap-1 flex-wrap">
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
          </div>
          
          {/* Description */}
          {twitchProfile?.description && (
            <p className="text-sm text-textSecondary mb-3 line-clamp-2">
              {twitchProfile.description}
            </p>
          )}
          
          {/* Stats */}
          {twitchProfile && (
            <div className="flex items-center gap-4 text-xs text-textSecondary mb-3">
              <div className="flex items-center gap-1">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
                  <path fillRule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                </svg>
                <span>{twitchProfile.view_count.toLocaleString()} views</span>
              </div>
              <div className="flex items-center gap-1">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd" />
                </svg>
                <span>Joined {formatDate(twitchProfile.created_at)}</span>
              </div>
            </div>
          )}
          
          {/* Action Buttons */}
          <div className="flex gap-2">
            <a
              href={`https://www.twitch.tv/${username}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 glass-button text-white text-sm py-2 px-3 rounded text-center hover:bg-accent/20 transition-colors"
            >
              View Channel
            </a>
            <a
              href={`https://www.twitch.tv/popout/${username}/chat`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 glass-button text-white text-sm py-2 px-3 rounded text-center hover:bg-accent/20 transition-colors"
            >
              Pop-out Chat
            </a>
          </div>
        </div>
        
        {/* Tabs */}
        <div className="border-t border-borderSubtle">
          <div className="flex">
            <button
              onClick={() => setActiveTab('profile')}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                activeTab === 'profile'
                  ? 'text-accent border-b-2 border-accent'
                  : 'text-textSecondary hover:text-textPrimary'
              }`}
            >
              Profile
            </button>
            <button
              onClick={() => setActiveTab('messages')}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${
                activeTab === 'messages'
                  ? 'text-accent border-b-2 border-accent'
                  : 'text-textSecondary hover:text-textPrimary'
              }`}
            >
              Messages ({messageHistory.length})
            </button>
          </div>
        </div>
        
        {/* Tab Content */}
        <div className="p-4 max-h-64 overflow-y-auto scrollbar-thin">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
            </div>
          ) : activeTab === 'profile' ? (
            <div className="space-y-3">
              {twitchProfile?.broadcaster_type && (
                <div>
                  <p className="text-xs text-textSecondary mb-1">Account Type</p>
                  <p className="text-sm text-textPrimary capitalize">
                    {twitchProfile.broadcaster_type || 'Normal'}
                  </p>
                </div>
              )}
              
              <div>
                <p className="text-xs text-textSecondary mb-1">User ID</p>
                <p className="text-sm text-textPrimary font-mono">{userId}</p>
              </div>
              
              {twitchBadges.length > 0 && (
                <div>
                  <p className="text-xs text-textSecondary mb-1">All Twitch Badges</p>
                  <div className="flex items-center gap-2 flex-wrap">
                    {twitchBadges.map((badge) => (
                      <div key={badge.id} className="px-2 py-1 glass-panel rounded text-xs flex items-center gap-1 cursor-pointer hover:bg-accent/10 transition-colors">
                        <img src={badge.image1x} alt="" className="w-4 h-4" />
                        <span className="text-textPrimary">{badge.title}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {thirdPartyBadges.length > 0 && (
                <div>
                  <p className="text-xs text-textSecondary mb-1">Third-Party Badges</p>
                  <div className="flex flex-col gap-2">
                    {thirdPartyBadges.map((badge) => (
                      <a
                        key={badge.id}
                        href={badge.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2 py-1.5 glass-panel rounded text-xs hover:bg-accent/10 transition-colors cursor-pointer"
                        onClick={async (e) => {
                          e.preventDefault();
                          if (badge.link) {
                            try {
                              const { open } = await import('@tauri-apps/plugin-shell');
                              await open(badge.link);
                            } catch (err) {
                              console.error('Failed to open URL:', err);
                            }
                          }
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <img src={badge.imageUrl} alt="" className="w-4 h-4" />
                          <span className="text-textPrimary font-semibold">{badge.title}</span>
                          <span className="text-[10px] text-textSecondary uppercase">{badge.provider}</span>
                          <svg className="w-3 h-3 text-accent ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              )}
              
              {(seventvPaint || seventvBadges.length > 0) && (
                <div>
                  <p className="text-xs text-textSecondary mb-1">7TV Cosmetics</p>
                  <div className="flex flex-col gap-2">
                    {seventvPaint && (
                      <a
                        href={`https://7tv.app/paints/${seventvPaint.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2 py-1.5 glass-panel rounded text-xs hover:bg-accent/10 transition-colors cursor-pointer"
                        onClick={async (e) => {
                          e.preventDefault();
                          try {
                            const { open } = await import('@tauri-apps/plugin-shell');
                            await open(`https://7tv.app/paints/${seventvPaint.id}`);
                          } catch (err) {
                            console.error('Failed to open URL:', err);
                          }
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span style={usernameStyle} className="font-semibold">Paint: {seventvPaint.name}</span>
                          <svg className="w-3 h-3 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </div>
                        {(seventvPaint as any).description && (
                          <p className="text-textSecondary text-[10px] mt-0.5">{(seventvPaint as any).description}</p>
                        )}
                      </a>
                    )}
                    {seventvBadges.map((badge) => (
                      <a
                        key={badge.id}
                        href={`https://7tv.app/badges/${badge.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2 py-1.5 glass-panel rounded text-xs hover:bg-accent/10 transition-colors cursor-pointer"
                        onClick={async (e) => {
                          e.preventDefault();
                          try {
                            const { open } = await import('@tauri-apps/plugin-shell');
                            await open(`https://7tv.app/badges/${badge.id}`);
                          } catch (err) {
                            console.error('Failed to open URL:', err);
                          }
                        }}
                      >
                        <div className="flex items-center gap-2">
                          {badge.urls && badge.urls.length > 0 && (
                            <img src={badge.urls[0][1]} alt="" className="w-4 h-4" />
                          )}
                          <span className="text-textPrimary font-semibold">Badge: {badge.name}</span>
                          <svg className="w-3 h-3 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </div>
                        {(badge as any).description && (
                          <p className="text-textSecondary text-[10px] mt-0.5">{(badge as any).description}</p>
                        )}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {messageHistory.length === 0 ? (
                <p className="text-sm text-textSecondary text-center py-4">
                  No messages yet
                </p>
              ) : (
                messageHistory.slice().reverse().map((msg, idx) => (
                  <div key={idx} className="p-2 glass-panel rounded text-sm">
                    <p className="text-textPrimary break-words">{msg.content}</p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default UserProfileCard;
