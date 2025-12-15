import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { MessageCircle, UserPlus, UserMinus, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { computePaintStyle } from '../services/seventvService';
import { formatIVRDate, formatSubTenure } from '../services/ivrService';

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
  onStartWhisper?: (user: { id: string; login: string; display_name: string; profile_image_url?: string }) => void;
}

interface UserProfileComplete {
  twitch_profile: TwitchUserProfile | null;
  badges: BadgeData;
  seventv_cosmetics: SevenTVCosmetics | null;
  ivr_data: IVRData;
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

interface BadgeData {
  display_badges: Badge[];
  earned_badges: Badge[];
  third_party_badges: ThirdPartyBadge[];
}

interface Badge {
  id: string;
  setID: string;
  version: string;
  title: string;
  description: string;
  image1x: string;
  image2x: string;
  image4x: string;
}

interface ThirdPartyBadge {
  id: string;
  provider: string;
  title: string;
  imageUrl: string;
  image1x: string | null;
  image2x: string | null;
  image4x: string | null;
}

interface SevenTVCosmetics {
  paints: SevenTVPaint[];
  badges: SevenTVBadge[];
}

// v4 API Paint structure with layers
interface SevenTVPaint {
  id: string;
  name: string;
  description: string | null;
  selected: boolean;
  data: {
    layers: SevenTVPaintLayer[];
    shadows: SevenTVPaintShadow[];
  };
}

interface SevenTVPaintLayer {
  id: string;
  ty: {
    __typename: string;
    angle?: number;
    repeating?: boolean;
    shape?: string;
    stops?: Array<{ at: number; color: SevenTVColor }>;
    color?: SevenTVColor;
    images?: SevenTVImage[];
  };
  opacity: number;
}

interface SevenTVColor {
  hex: string;
  r: number;
  g: number;
  b: number;
  a: number;
}

interface SevenTVImage {
  url: string;
  mime: string | null;
  size: number | null;
  scale: number | null;
  width: number | null;
  height: number | null;
  frameCount: number | null;
}

interface SevenTVPaintShadow {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: SevenTVColor;
}

interface SevenTVBadge {
  id: string;
  name: string;
  description: string | null;
  selected: boolean;
}

interface IVRData {
  created_at: string | null;
  following_since: string | null;
  status_hidden: boolean;
  is_subscribed: boolean;
  sub_streak: number | null;
  sub_cumulative: number | null;
  is_founder: boolean;
  is_mod: boolean;
  mod_since: string | null;
  is_vip: boolean;
  vip_since: string | null;
  error: string | null;
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
  channelName: propChannelName,
  onStartWhisper
}: UserProfileCardProps) => {
  const [profileData, setProfileData] = useState<UserProfileComplete | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showMessages, setShowMessages] = useState(false);
  const [showAllBadges, setShowAllBadges] = useState(false);

  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [cardPosition, setCardPosition] = useState({ x: 0, y: 0 });
  const cardRef = useRef<HTMLDivElement>(null);

  // Follow state
  const [isFollowing, setIsFollowing] = useState<boolean | null>(null);
  const [followLoading, setFollowLoading] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);

  useEffect(() => {
    const fetchUserData = async () => {
      setIsLoading(true);
      try {
        let channelId: string, channelName: string;
        if (propChannelId && propChannelName) {
          channelId = propChannelId;
          channelName = propChannelName;
        } else {
          const currentStream = useAppStore.getState().currentStream;
          channelId = currentStream?.user_id || userId;
          channelName = currentStream?.user_login || username;
        }

        console.log('[UserProfileCard] Fetching complete profile via Rust:', { userId, username, channelId, channelName });

        // Single unified call to Rust backend - replaces 5 separate API calls!
        const profile = await invoke<UserProfileComplete>('get_user_profile_complete', {
          userId,
          username,
          channelId,
          channelName,
        });

        console.log('[UserProfileCard] Profile data received:', profile);
        setProfileData(profile);
      } catch (error) {
        console.error('Failed to fetch user profile:', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchUserData();
  }, [userId, username, propChannelId, propChannelName]);

  const selectedPaint = useMemo(() => {
    return profileData?.seventv_cosmetics?.paints.find(p => p.selected) || null;
  }, [profileData?.seventv_cosmetics]);

  const usernameStyle = useMemo(() => 
    selectedPaint ? computePaintStyle(selectedPaint as any, color) : { color }, 
    [selectedPaint, color]
  );

  const formatDate = (ds: string) => new Date(ds).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  useEffect(() => {
    const cardWidth = 500, padding = 10, gap = 10;
    const estimatedHeight = showMessages ? 700 : 400;
    let x = position.x - cardWidth - gap, y = position.y;
    if (x < padding) x = position.x + gap;
    if (y + estimatedHeight > window.innerHeight - padding) y = window.innerHeight - estimatedHeight - padding;
    y = Math.max(padding, y);
    setCardPosition({ x, y });
  }, [position, showMessages]);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!(e.target as HTMLElement).closest('.profile-card-header')) return;
    setIsDragging(true);
    setDragOffset({ x: e.clientX - cardPosition.x, y: e.clientY - cardPosition.y });
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const cardWidth = cardRef.current?.offsetWidth || 500;
      const cardHeight = cardRef.current?.offsetHeight || 400;
      const padding = 10;
      setCardPosition({
        x: Math.max(padding, Math.min(e.clientX - dragOffset.x, window.innerWidth - cardWidth - padding)),
        y: Math.max(padding, Math.min(e.clientY - dragOffset.y, window.innerHeight - cardHeight - padding))
      });
    };
    const handleMouseUp = () => setIsDragging(false);
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  const cardStyle = useMemo(() => ({
    left: `${cardPosition.x}px`,
    top: `${cardPosition.y}px`,
    cursor: isDragging ? 'grabbing' : 'default'
  }), [cardPosition, isDragging]);

  const isStandaloneWindow = window.location.hash.startsWith('#/profile');

  // Handle follow/unfollow action using browser automation
  const handleFollowAction = useCallback(async () => {
    if (followLoading) return;

    setFollowLoading(true);
    setFollowError(null);

    const action = isFollowing ? 'unfollow' : 'follow';
    console.log(`[UserProfileCard] Initiating ${action} for ${username}`);

    try {
      const result = await invoke<{ success: boolean; message: string; action: string }>('automate_connection', {
        channel: username,
        action: action
      });

      console.log('[UserProfileCard] Automation result:', result);

      if (result.success) {
        setIsFollowing(prev => !prev);
        console.log(`[UserProfileCard] Successfully ${action}ed ${username}`);
      } else {
        setFollowError(result.message);
        console.error(`[UserProfileCard] ${action} failed:`, result.message);
        useAppStore.getState().addToast(
          `Follow/Unfollow failed. Try logging out and back in via Settings to re-authenticate.`,
          'error'
        );
      }
    } catch (err: any) {
      console.error(`[UserProfileCard] ${action} error:`, err);
      setFollowError(err?.message || `Failed to ${action}`);
      useAppStore.getState().addToast(
        `Follow/Unfollow failed. Try logging out and back in via Settings to re-authenticate.`,
        'error'
      );
    } finally {
      setFollowLoading(false);
    }
  }, [username, isFollowing, followLoading]);

  // Combine all badges into one array for display
  const allBadges = useMemo(() => {
    if (!profileData) return [];
    
    const badges: Array<{ id: string; src: string; srcSet?: string; title: string; type: string }> = [];
    
    profileData.badges.display_badges.forEach((b) => {
      badges.push({
        id: `t-${b.id}`,
        src: b.image4x || b.image1x,
        srcSet: `${b.image1x} 1x, ${b.image2x} 2x, ${b.image4x} 4x`,
        title: b.title,
        type: 'twitch'
      });
    });
    
    profileData.seventv_cosmetics?.badges.forEach(b => {
      // 7TV v4 badges use CDN URLs: https://cdn.7tv.app/badge/{id}/{size}
      const baseUrl = `https://cdn.7tv.app/badge/${b.id}`;
      badges.push({
        id: `7-${b.id}`,
        src: `${baseUrl}/4x`,
        srcSet: `${baseUrl}/1x 1x, ${baseUrl}/2x 2x, ${baseUrl}/4x 4x`,
        title: b.description || b.name,
        type: '7tv'
      });
    });
    
    profileData.badges.third_party_badges.forEach((b) => {
      const srcSet = b.image1x && b.image2x && b.image4x 
        ? `${b.image1x} 1x, ${b.image2x} 2x, ${b.image4x} 4x`
        : undefined;
      badges.push({ 
        id: `3-${b.id}`, 
        src: b.image4x || b.imageUrl, 
        srcSet,
        title: `${b.title} (${b.provider})`, 
        type: b.provider 
      });
    });
    
    return badges;
  }, [profileData]);

  const twitchProfile = profileData?.twitch_profile;
  const ivrData = profileData?.ivr_data;

  return (
    <>
      {!isStandaloneWindow && (
        <div className="fixed inset-0 z-40 group">
          <div className="absolute inset-0 group-hover:pointer-events-none" onClick={onClose} />
        </div>
      )}
      <div
        ref={cardRef}
        className={`${isStandaloneWindow ? 'w-full h-full' : 'fixed z-50 w-[500px]'} user-profile-card backdrop-blur-xl shadow-2xl border border-borderSubtle rounded-lg overflow-hidden`}
        style={isStandaloneWindow ? { backgroundColor: 'rgba(0, 0, 0, 0.75)' } : cardStyle}
        onMouseDown={isStandaloneWindow ? undefined : handleMouseDown}
      >
        {/* Header with Banner */}
        <div className="relative profile-card-header cursor-grab active:cursor-grabbing flex-shrink-0">
          <div
            className="h-24 bg-gradient-to-br from-accent/30 via-purple-600/20 to-accent/10"
            style={{
              backgroundImage: twitchProfile?.offline_image_url
                ? `url(${twitchProfile.offline_image_url})`
                : `linear-gradient(135deg, ${color || '#9146FF'}40 0%, ${color || '#9146FF'}10 50%, #9146FF20 100%)`,
              backgroundSize: 'cover', backgroundPosition: 'center'
            }}
          />
          <div className="absolute -bottom-10 left-4">
            <div className="w-20 h-20 rounded-full border-4 border-secondary bg-glass overflow-hidden">
              {twitchProfile?.profile_image_url ? (
                <img src={twitchProfile.profile_image_url} alt={displayName} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-accent/20">
                  <span className="text-3xl font-bold text-textPrimary">{displayName[0].toUpperCase()}</span>
                </div>
              )}
            </div>
          </div>
          <button onClick={onClose} className="absolute top-2 right-2 p-1.5 glass-button text-textSecondary hover:text-textPrimary rounded-full">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Profile Info Section */}
        <div className="px-4 pt-12 pb-3 flex-shrink-0">
          {/* Username row with paint badge */}
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="text-xl font-bold truncate" style={usernameStyle}>{displayName}</h3>
            {twitchProfile?.broadcaster_type === 'partner' && (
              <div title="Verified Partner">
                <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 16 16" fill="#9146FF">
                  <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd" />
                </svg>
              </div>
            )}
            {selectedPaint && (
              <div
                className="px-1.5 py-px rounded text-[9px] font-bold inline-block relative overflow-hidden"
                style={{
                  ...computePaintStyle(selectedPaint as any, color),
                  WebkitBackgroundClip: 'padding-box',
                  backgroundClip: 'padding-box',
                }}
                title={`7TV Paint: ${selectedPaint.name}`}
              >
                <span
                  style={{
                    ...computePaintStyle(selectedPaint as any, color),
                    filter: 'invert(1) contrast(1.5)',
                    WebkitBackgroundClip: 'text',
                    backgroundClip: 'text',
                  }}
                >
                  🎨 {selectedPaint.name}
                </span>
              </div>
            )}
          </div>
          <p className="text-sm text-textSecondary mb-3">@{username}</p>

          {/* Bio */}
          {twitchProfile?.description && (
            <p className="text-sm text-textSecondary mb-3 line-clamp-2">{twitchProfile.description}</p>
          )}

          {/* Active Badges Row */}
          {allBadges.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center gap-2 mb-1.5">
                <p className="text-[10px] text-textSecondary uppercase">Active Badges</p>
                {profileData?.badges.earned_badges && profileData.badges.earned_badges.length > 0 && (
                  <button
                    onClick={() => setShowAllBadges(!showAllBadges)}
                    className="text-[10px] text-accent hover:text-accent/80 transition-colors"
                  >
                    {showAllBadges ? 'Hide' : 'Show'} All ({profileData.badges.earned_badges.length})
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {allBadges.map((b, i) => (
                  <img
                    key={`${b.id}-${i}`}
                    src={b.src}
                    srcSet={b.srcSet}
                    alt={b.title}
                    title={b.title}
                    className="w-5 h-5 cursor-pointer hover:scale-110 transition-transform"
                    onError={e => { e.currentTarget.style.display = 'none'; }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* All Earned Badges (Expandable) */}
          {showAllBadges && profileData?.badges.earned_badges && profileData.badges.earned_badges.length > 0 && (
            <div className="mb-3 glass-panel rounded p-2">
              <p className="text-[10px] text-textSecondary uppercase mb-1.5">All Earned Badges</p>
              <div className="flex items-center gap-1.5 flex-wrap max-h-[120px] overflow-y-auto scrollbar-thin">
                {profileData.badges.earned_badges.map((b, i) => (
                  <img
                    key={`earned-${b.id}-${i}`}
                    src={b.image4x || b.image1x}
                    srcSet={`${b.image1x} 1x, ${b.image2x} 2x, ${b.image4x} 4x`}
                    alt={b.title}
                    title={`${b.title}\n${b.description}`}
                    className="w-5 h-5 cursor-pointer hover:scale-110 transition-transform"
                    onError={e => { e.currentTarget.style.display = 'none'; }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Stats Grid */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            {ivrData && (ivrData.following_since || ivrData.status_hidden) ? (
              <div className="glass-panel rounded p-2">
                <p className="text-[10px] text-textSecondary uppercase">Following Since</p>
                {ivrData.status_hidden ? (
                  <p className="text-sm font-bold text-textSecondary italic">Hidden</p>
                ) : (
                  <p className="text-sm font-bold text-textPrimary">{formatIVRDate(ivrData.following_since!)}</p>
                )}
              </div>
            ) : ivrData && !isLoading && (
              <div className="glass-panel rounded p-2">
                <p className="text-[10px] text-textSecondary uppercase">Following</p>
                <p className="text-sm font-bold text-textSecondary">Not following</p>
              </div>
            )}
            {twitchProfile && (
              <div className="glass-panel rounded p-2">
                <p className="text-[10px] text-textSecondary uppercase">Joined</p>
                <p className="text-sm font-bold text-textPrimary">{formatDate(twitchProfile.created_at)}</p>
              </div>
            )}
          </div>

          {/* IVR Info - compact inline display */}
          {ivrData && (
            <div className="space-y-1 text-xs mb-3">
              {ivrData.is_subscribed && (
                <div className="flex items-center gap-2">
                  <span className="text-textSecondary">Subbed:</span>
                  <span className="text-purple-400">{formatSubTenure(ivrData.sub_streak, ivrData.sub_cumulative)}</span>
                  {ivrData.is_founder && <span className="px-1 py-0.5 bg-purple-500/20 text-purple-400 rounded text-[9px] font-semibold">FOUNDER</span>}
                </div>
              )}
              {ivrData.is_mod && (
                <div className="flex items-center gap-2">
                  <span className="text-textSecondary">Mod:</span>
                  <span className="text-green-400">{ivrData.mod_since ? formatIVRDate(ivrData.mod_since) : 'Yes'}</span>
                </div>
              )}
              {ivrData.is_vip && (
                <div className="flex items-center gap-2">
                  <span className="text-textSecondary">VIP:</span>
                  <span className="text-pink-400">{ivrData.vip_since ? formatIVRDate(ivrData.vip_since) : 'Yes'}</span>
                </div>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-2 flex-wrap">
            {/* Follow/Unfollow Button */}
            <button
              onClick={handleFollowAction}
              disabled={followLoading}
              className={`glass-button text-white text-xs py-2 px-3 rounded text-center transition-colors flex items-center justify-center gap-1.5 min-w-[90px] ${followLoading
                ? 'opacity-50 cursor-wait'
                : isFollowing
                  ? 'hover:bg-red-500/20 border-red-500/30'
                  : 'hover:bg-green-500/20 border-green-500/30'
                }`}
              title={followLoading ? 'Processing...' : isFollowing ? `Unfollow ${displayName}` : `Follow ${displayName}`}
            >
              {followLoading ? (
                <>
                  <Loader2 size={14} className="animate-spin text-purple-400" />
                  <span className="hidden sm:inline">Working...</span>
                </>
              ) : isFollowing ? (
                <>
                  <UserMinus size={14} className="text-red-400" />
                  <span>Unfollow</span>
                </>
              ) : (
                <>
                  <UserPlus size={14} className="text-green-400" />
                  <span>Follow</span>
                </>
              )}
            </button>
            <a href={`https://www.twitch.tv/${username}`} target="_blank" rel="noopener noreferrer" className="flex-1 glass-button text-white text-xs py-2 px-3 rounded text-center hover:bg-accent/20 transition-colors">
              View Channel
            </a>
            <button
              onClick={async () => {
                const user = {
                  id: userId,
                  login: username,
                  display_name: displayName,
                  profile_image_url: twitchProfile?.profile_image_url
                };
                if (onStartWhisper) {
                  onStartWhisper(user);
                } else if (isStandaloneWindow) {
                  try {
                    const { emit } = await import('@tauri-apps/api/event');
                    await emit('start-whisper', user);
                    const { getCurrentWindow } = await import('@tauri-apps/api/window');
                    const currentWindow = getCurrentWindow();
                    await currentWindow.close();
                  } catch (err) {
                    console.error('Failed to emit whisper event:', err);
                  }
                } else {
                  useAppStore.getState().openWhisperWithUser(user);
                }
                onClose();
              }}
              className="glass-button text-white text-xs py-2 px-3 rounded text-center hover:bg-purple-500/20 transition-colors flex items-center justify-center gap-1.5"
              title="Send Whisper"
            >
              <MessageCircle size={14} className="text-purple-400" />
              Whisper
            </button>
            <button
              onClick={() => setShowMessages(!showMessages)}
              className={`flex-1 glass-button text-white text-xs py-2 px-3 rounded text-center transition-colors flex items-center justify-center gap-1.5 ${showMessages ? 'bg-accent/20' : 'hover:bg-accent/20'}`}
            >
              <svg className={`w-3.5 h-3.5 transition-transform ${showMessages ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
              Messages ({messageHistory.length})
            </button>
          </div>
        </div>

        {/* Expandable Messages Section */}
        {showMessages && (
          <div className="border-t border-borderSubtle">
            <div className="px-4 py-2 border-b border-borderSubtle/50">
              <p className="text-xs font-semibold text-textSecondary uppercase tracking-wide">
                Recent Messages
              </p>
            </div>
            <div className="px-4 py-2 max-h-[300px] overflow-y-auto scrollbar-thin">
              {messageHistory.length === 0 ? (
                <p className="text-sm text-textSecondary text-center py-4">No messages yet</p>
              ) : (
                <div className="space-y-2 pb-2">
                  {messageHistory.slice().reverse().map((msg, idx) => (
                    <div key={idx} className="p-2 glass-panel rounded text-sm">
                      <p className="text-textPrimary break-words">{msg.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default UserProfileCard;
