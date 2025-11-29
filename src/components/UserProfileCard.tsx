import { useState, useEffect, useMemo, useRef } from 'react';
import { getUserCosmetics, computePaintStyle, getBadgeImageUrl } from '../services/seventvService';
import { getAllUserBadges, TwitchBadge } from '../services/badgeService';
import { getAllThirdPartyBadges, ThirdPartyBadge } from '../services/thirdPartyBadges';
import { fetchIVRUserData, fetchIVRSubage, fetchIVRModVip, formatIVRDate, formatSubTenure } from '../services/ivrService';
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

interface IVRData {
  createdAt: string | null;
  followingSince: string | null;
  statusHidden: boolean;
  isSubscribed: boolean;
  subStreak: number | null;
  subCumulative: number | null;
  isFounder: boolean;
  isMod: boolean;
  modSince: string | null;
  isVip: boolean;
  vipSince: string | null;
  isLoading: boolean;
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
  channelName: propChannelName
}: UserProfileCardProps) => {
  const [twitchProfile, setTwitchProfile] = useState<TwitchUserProfile | null>(null);
  const [twitchBadges, setTwitchBadges] = useState<TwitchBadge[]>([]);
  const [thirdPartyBadges, setThirdPartyBadges] = useState<ThirdPartyBadge[]>([]);
  const [seventvBadge, setSeventvBadge] = useState<SevenTVBadge | null>(null);
  const [seventvBadges, setSeventvBadges] = useState<SevenTVBadge[]>([]);
  const [seventvPaint, setSeventvPaint] = useState<SevenTVPaint | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showMessages, setShowMessages] = useState(false);
  const [ivrData, setIvrData] = useState<IVRData>({
    createdAt: null, followingSince: null, statusHidden: false, isSubscribed: false,
    subStreak: null, subCumulative: null, isFounder: false, isMod: false,
    modSince: null, isVip: false, vipSince: null, isLoading: true, error: null
  });

  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [cardPosition, setCardPosition] = useState({ x: 0, y: 0 });
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchUserData = async () => {
      setIsLoading(true);
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
        const twitchResponse = await fetch(`https://api.twitch.tv/helix/users?id=${userId}`, {
          headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${token}` }
        });
        if (twitchResponse.ok) {
          const twitchData = await twitchResponse.json();
          if (twitchData.data?.[0]) setTwitchProfile(twitchData.data[0]);
        }

        let channelId: string, channelName: string;
        if (propChannelId && propChannelName) {
          channelId = propChannelId; channelName = propChannelName;
        } else {
          const { useAppStore } = await import('../stores/AppStore');
          const currentStream = useAppStore.getState().currentStream;
          channelId = currentStream?.user_id || userId;
          channelName = currentStream?.user_login || username;
        }

        try {
          const badgeData = await getAllUserBadges(userId, username, channelId, channelName);
          const uniqueBadges = new Map<string, TwitchBadge>();
          badgeData.displayBadges.forEach(b => uniqueBadges.set(b.id, b));
          badgeData.earnedBadges.forEach(b => { if (!uniqueBadges.has(b.id)) uniqueBadges.set(b.id, b); });
          setTwitchBadges(Array.from(uniqueBadges.values()).filter(b => !(b.setID === 'broadcaster' && userId !== channelId)));
        } catch { setTwitchBadges([]); }

        const cosmetics = await getUserCosmetics(userId);
        if (cosmetics) {
          const selectedPaint = cosmetics.paints.find(p => p.selected);
          if (selectedPaint) setSeventvPaint(selectedPaint as any);
          const selectedBadge = cosmetics.badges.find(b => b.selected);
          if (selectedBadge) setSeventvBadge(selectedBadge as any);
          setSeventvBadges(cosmetics.badges as any);
        }

        try { setThirdPartyBadges(await getAllThirdPartyBadges(userId)); } catch { setThirdPartyBadges([]); }

        try {
          const [ivrUserData, ivrSubageData, ivrModVipData] = await Promise.all([
            fetchIVRUserData(username), fetchIVRSubage(username, channelName), fetchIVRModVip(username, channelName)
          ]);
          setIvrData({
            createdAt: ivrUserData?.createdAt || null, followingSince: ivrSubageData?.followedAt || null,
            statusHidden: ivrSubageData?.statusHidden || false, isSubscribed: ivrSubageData?.subscriber || false,
            subStreak: ivrSubageData?.streak?.months ?? null, subCumulative: ivrSubageData?.cumulative?.months ?? null,
            isFounder: ivrSubageData?.founder || false, isMod: ivrModVipData?.isMod || false,
            modSince: ivrModVipData?.modGrantedAt || null, isVip: ivrModVipData?.isVip || false,
            vipSince: ivrModVipData?.vipGrantedAt || null, isLoading: false, error: null
          });
        } catch { setIvrData(prev => ({ ...prev, isLoading: false, error: 'Failed to fetch additional data' })); }
      } catch (error) { console.error('Failed to fetch user profile:', error); }
      finally { setIsLoading(false); }
    };
    fetchUserData();
  }, [userId]);

  const usernameStyle = useMemo(() => seventvPaint ? computePaintStyle(seventvPaint as any, color) : { color }, [seventvPaint, color]);
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
    if (isDragging) { document.addEventListener('mousemove', handleMouseMove); document.addEventListener('mouseup', handleMouseUp); }
    return () => { document.removeEventListener('mousemove', handleMouseMove); document.removeEventListener('mouseup', handleMouseUp); };
  }, [isDragging, dragOffset]);

  const cardStyle = useMemo(() => ({
    left: `${cardPosition.x}px`,
    top: `${cardPosition.y}px`,
    cursor: isDragging ? 'grabbing' : 'default'
  }), [cardPosition, isDragging]);

  const isStandaloneWindow = window.location.hash.startsWith('#/profile');

  // Combine all badges into one array for display
  const allBadges = useMemo(() => {
    const badges: Array<{ id: string; src: string; srcSet?: string; title: string; type: string }> = [];
    twitchBadges.forEach(b => {
      badges.push({ id: `t-${b.id}`, src: b.image1x, srcSet: `${b.image1x} 1x, ${b.image2x} 2x, ${b.image4x} 4x`, title: b.title, type: 'twitch' });
    });
    seventvBadges.forEach(b => {
      const url = getBadgeImageUrl(b as any);
      if (url) badges.push({ id: `7-${b.id}`, src: url, title: b.tooltip || b.name, type: '7tv' });
    });
    thirdPartyBadges.forEach(b => {
      badges.push({ id: `3-${b.id}`, src: b.imageUrl, title: `${b.title} (${b.provider})`, type: b.provider });
    });
    return badges;
  }, [twitchBadges, seventvBadges, thirdPartyBadges]);

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
            {seventvPaint && (
              <span
                className="px-2 py-0.5 rounded-full text-[10px] font-semibold border border-current opacity-80"
                style={usernameStyle}
                title={`7TV Paint: ${seventvPaint.name}`}
              >
                🎨 {seventvPaint.name}
              </span>
            )}
          </div>
          <p className="text-sm text-textSecondary mb-3">@{username}</p>

          {/* Bio */}
          {twitchProfile?.description && (
            <p className="text-sm text-textSecondary mb-3 line-clamp-2">{twitchProfile.description}</p>
          )}

          {/* All Badges in one row */}
          {allBadges.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap mb-3">
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
          )}

          {/* Stats Grid */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            {(ivrData.followingSince || ivrData.statusHidden) ? (
              <div className="glass-panel rounded p-2">
                <p className="text-[10px] text-textSecondary uppercase">Following Since</p>
                {ivrData.statusHidden ? (
                  <p className="text-sm font-bold text-textSecondary italic">Hidden</p>
                ) : (
                  <p className="text-sm font-bold text-textPrimary">{formatIVRDate(ivrData.followingSince!)}</p>
                )}
              </div>
            ) : !ivrData.isLoading && (
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
          <div className="space-y-1 text-xs mb-3">
            {ivrData.isSubscribed && (
              <div className="flex items-center gap-2">
                <span className="text-textSecondary">Subbed:</span>
                <span className="text-purple-400">{formatSubTenure(ivrData.subStreak, ivrData.subCumulative)}</span>
                {ivrData.isFounder && <span className="px-1 py-0.5 bg-purple-500/20 text-purple-400 rounded text-[9px] font-semibold">FOUNDER</span>}
              </div>
            )}
            {ivrData.isMod && (
              <div className="flex items-center gap-2">
                <span className="text-textSecondary">Mod:</span>
                <span className="text-green-400">{ivrData.modSince ? formatIVRDate(ivrData.modSince) : 'Yes'}</span>
              </div>
            )}
            {ivrData.isVip && (
              <div className="flex items-center gap-2">
                <span className="text-textSecondary">VIP:</span>
                <span className="text-pink-400">{ivrData.vipSince ? formatIVRDate(ivrData.vipSince) : 'Yes'}</span>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2">
            <a href={`https://www.twitch.tv/${username}`} target="_blank" rel="noopener noreferrer" className="flex-1 glass-button text-white text-xs py-2 px-3 rounded text-center hover:bg-accent/20 transition-colors">
              View Channel
            </a>
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
