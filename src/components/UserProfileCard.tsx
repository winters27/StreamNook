import { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } from 'react';
import { MessageCircle, UserPlus, UserMinus, Loader2, ChevronDown, ChevronUp, Pencil, X } from 'lucide-react';
import { setUserNickname, setUserColor } from '../utils/userChatOverrides';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { openBadgesWithPaintInMain } from '../utils/openBadgesInMain';
import { computePaintStyle, getBadgeImageUrls, getBadgeFallbackUrls, queueCosmeticForCaching } from '../services/seventvService';
import { FallbackImage } from './FallbackImage';
import { formatIVRDate, formatSubTenure } from '../services/ivrService';
import { Logger } from '../utils/logger';
import {
  getProfileFromMemoryCache,
  getFullProfileWithFallback,
  refreshProfileInBackground,
  CachedProfile
} from '../services/cosmeticsCache';
import { Tooltip } from './ui/Tooltip';
import { getStreamNookUserNumber, subscribeStreamNookRegistryVersion, getStreamNookRegistryVersion } from '../services/supabaseService';
import { StreamNookBadge } from './StreamNookBadge';
import streamNookLogo from '../assets/streamnook-logo.png';

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
  isModerator?: boolean;
  broadcasterId?: string;
  onPreFillCommand?: (cmd: string) => void;
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
  /** Channel page header banner. Distinct from offline_image_url (player offline placeholder). */
  banner_image_url: string | null;
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

interface NicknameEditorProps {
  userId: string;
  username: string;
  displayName: string;
  // The user's real Twitch color (parsed from the IRC tags). Used as the
  // initial value of the color picker when no override is set, and as the
  // visual baseline after "Reset color" is clicked.
  twitchColor: string;
}

// Normalize whatever shape the IRC color comes in as into a valid #RRGGBB
// hex string that <input type="color"> will accept. Empty / malformed input
// falls back to Twitch's default purple.
const TWITCH_DEFAULT_COLOR = '#9147FF';
function normalizeHex(input: string | null | undefined): string {
  if (!input) return TWITCH_DEFAULT_COLOR;
  const v = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v.toLowerCase()}`;
  return TWITCH_DEFAULT_COLOR;
}

// Inline editor for the nickname + color overrides we expose on each user.
// Reads the current override from the settings store on mount (lazy init)
// and on userId change. Nickname saves on blur or Enter; color saves on the
// native color picker's change event.
const NicknameEditor: React.FC<NicknameEditorProps> = ({ userId, username, displayName, twitchColor }) => {
  const readCurrentNickname = () =>
    useAppStore.getState().settings.chat_customization?.user_overrides?.[userId]?.nickname ?? '';
  const readCurrentColor = () =>
    useAppStore.getState().settings.chat_customization?.user_overrides?.[userId]?.color ?? '';

  const [draft, setDraft] = useState<string>(readCurrentNickname);
  const [savedNickname, setSavedNickname] = useState<string>(readCurrentNickname);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [savedColor, setSavedColor] = useState<string>(readCurrentColor);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const fallbackColor = normalizeHex(twitchColor);
  const pickerValue = normalizeHex(savedColor || twitchColor);
  const hasColorOverride = savedColor.trim().length > 0;

  useEffect(() => {
    const nextNickname = readCurrentNickname();
    const nextColor = readCurrentColor();
    setDraft(nextNickname);
    setSavedNickname(nextNickname);
    setSavedColor(nextColor);
    setIsEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const commitNickname = () => {
    const next = draft.trim();
    if (next === savedNickname) {
      setIsEditing(false);
      return;
    }
    setUserNickname(userId, username, next.length > 0 ? next : null);
    setSavedNickname(next);
    setIsEditing(false);
  };

  const cancelNickname = () => {
    setDraft(savedNickname);
    setIsEditing(false);
  };

  const clearNickname = () => {
    setUserNickname(userId, username, null);
    setSavedNickname('');
    setDraft('');
    setIsEditing(false);
  };

  const commitColor = (next: string) => {
    const normalized = normalizeHex(next);
    if (normalized === savedColor) return;
    setUserColor(userId, username, normalized);
    setSavedColor(normalized);
  };

  const resetColor = () => {
    setUserColor(userId, username, null);
    setSavedColor('');
  };

  return (
    <div className="space-y-1">
      {/* Nickname row */}
      {!isEditing ? (
        <div className="flex items-center gap-2 px-1 py-1 text-xs text-textSecondary">
          <span className="text-textMuted">Nickname:</span>
          {savedNickname ? (
            <>
              <span className="text-textPrimary font-medium">{savedNickname}</span>
              <button
                onClick={() => setIsEditing(true)}
                className="ml-auto p-1 hover:text-textPrimary transition-colors"
                aria-label="Edit nickname"
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={clearNickname}
                className="p-1 hover:text-red-400 transition-colors"
                aria-label="Clear nickname"
              >
                <X size={12} />
              </button>
            </>
          ) : (
            <button
              onClick={() => setIsEditing(true)}
              className="ml-auto inline-flex items-center gap-1 text-textSecondary hover:text-textPrimary transition-colors"
            >
              <Pencil size={12} />
              <span>Set nickname</span>
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 px-1 py-1">
          <span className="text-xs text-textMuted">Nickname:</span>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitNickname}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitNickname();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelNickname();
              }
            }}
            placeholder={displayName}
            maxLength={32}
            className="flex-1 glass-input text-textPrimary text-xs px-2 py-1"
            spellCheck={false}
          />
        </div>
      )}

      {/* Color row */}
      <div className="flex items-center gap-2 px-1 py-1 text-xs text-textSecondary">
        <span className="text-textMuted">Color:</span>
        <input
          type="color"
          value={pickerValue}
          onChange={(e) => commitColor(e.target.value)}
          className="w-7 h-7 rounded cursor-pointer bg-transparent border border-borderSubtle"
          aria-label="Override chat color"
        />
        {hasColorOverride ? (
          <>
            <span className="font-mono text-textPrimary">{savedColor}</span>
            <button
              onClick={resetColor}
              className="ml-auto p-1 hover:text-red-400 transition-colors"
              aria-label="Reset color"
            >
              <X size={12} />
            </button>
          </>
        ) : (
          <span className="font-mono">{fallbackColor}<span className="text-textMuted/70 ml-1">(Twitch)</span></span>
        )}
      </div>
    </div>
  );
};

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
  onStartWhisper,
  isModerator = false,
  broadcasterId,
  onPreFillCommand,
}: UserProfileCardProps) => {
  const [profileData, setProfileData] = useState<UserProfileComplete | null>(null);
  const [cachedProfile, setCachedProfile] = useState<CachedProfile | null>(null);
  const [isLoadingProfile, setIsLoadingProfile] = useState(true);
  const [showMessages, setShowMessages] = useState(false);

  // Re-render when the StreamNook registry updates so the #N chip appears as soon as it loads
  useSyncExternalStore(subscribeStreamNookRegistryVersion, getStreamNookRegistryVersion, getStreamNookRegistryVersion);
  const streamNookUserNumber = getStreamNookUserNumber(userId);
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as any).__snProfileDebug = { userId, username, displayName, streamNookUserNumber };
  }

  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [cardPosition, setCardPosition] = useState({ x: 0, y: 0 });
  const cardRef = useRef<HTMLDivElement>(null);

  // Follow state
  const [isFollowing, setIsFollowing] = useState<boolean | null>(null);
  const [followLoading, setFollowLoading] = useState(false);

  // Get channel context
  const getChannelContext = useCallback(() => {
    if (propChannelId && propChannelName) {
      return { channelId: propChannelId, channelName: propChannelName };
    }
    const currentStream = useAppStore.getState().currentStream;
    return {
      channelId: currentStream?.user_id || userId,
      channelName: currentStream?.user_login || username
    };
  }, [propChannelId, propChannelName, userId, username]);

  // Load cached cosmetics INSTANTLY (synchronous), then fetch fresh data
  useEffect(() => {
    const { channelId, channelName } = getChannelContext();

    // 1. Try to load from memory cache IMMEDIATELY (no await, synchronous)
    const cached = getProfileFromMemoryCache(userId);
    if (cached) {
      Logger.debug('[UserProfileCard] Instant load from cache:', cached);
      setCachedProfile(cached);
    }

    // 2. Fetch full profile from Rust (includes Twitch profile, IVR, etc.)
    const fetchFullProfile = async () => {
      setIsLoadingProfile(true);
      try {
        Logger.debug('[UserProfileCard] Fetching complete profile via Rust:', { userId, username, channelId, channelName });

        // Fetch Rust profile (Twitch info, IVR data) and fresh cosmetics in parallel
        const [rustProfile, freshCachedProfile] = await Promise.all([
          invoke<UserProfileComplete>('get_user_profile_complete', {
            userId,
            username,
            channelId,
            channelName,
          }),
          getFullProfileWithFallback(userId, username, channelId, channelName)
        ]);

        Logger.debug('[UserProfileCard] Profile data received:', rustProfile);
        setProfileData(rustProfile);
        setCachedProfile(freshCachedProfile);

        // Refresh in background for next time
        refreshProfileInBackground(userId, username, channelId, channelName);
      } catch (error) {
        Logger.error('Failed to fetch user profile:', error);
      } finally {
        setIsLoadingProfile(false);
      }
    };

    fetchFullProfile();
  }, [userId, username, getChannelContext]);

  // Compute selected paint from cached cosmetics (for instant display)
  const selectedPaint = useMemo(() => {
    // Prefer cached cosmetics for instant paint display
    const paints = cachedProfile?.seventvCosmetics?.paints || profileData?.seventv_cosmetics?.paints || [];
    return paints.find((p: any) => p.selected) || null;
  }, [cachedProfile?.seventvCosmetics, profileData?.seventv_cosmetics]);

  const usernameStyle = useMemo(() => 
    selectedPaint ? computePaintStyle(selectedPaint as any, color) : { color }, 
    [selectedPaint, color]
  );

  // Reactive caching for 7TV cosmetics displayed in profile
  useEffect(() => {
    // Cache 7TV badges
    const badges = cachedProfile?.seventvCosmetics?.badges || profileData?.seventv_cosmetics?.badges || [];
    badges.forEach((badge: any) => {
      if (badge?.id && !badge.localUrl) {
        const badgeUrl = `https://cdn.7tv.app/badge/${badge.id}/4x`;
        queueCosmeticForCaching(badge.id, badgeUrl);
      }
    });
    
    // Cache paint image layers
    if (selectedPaint?.data?.layers) {
      selectedPaint.data.layers.forEach((layer: any) => {
        if (layer.ty?.__typename === 'PaintLayerTypeImage' && layer.ty.images) {
          const img = layer.ty.images.find((i: any) => i.scale === 1) || layer.ty.images[0];
          if (img && !img.localUrl) {
            queueCosmeticForCaching(layer.id, img.url);
          }
        }
      });
    }
  }, [cachedProfile?.seventvCosmetics?.badges, profileData?.seventv_cosmetics?.badges, selectedPaint]);

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

  // Handle follow/unfollow action via GQL mutations
  const handleFollowAction = useCallback(async () => {
    setFollowLoading(true);

    const action = isFollowing ? 'unfollow' : 'follow';
    Logger.debug(`[UserProfileCard] Initiating ${action} for ${username} (ID: ${userId})`);

    try {
      const command = isFollowing ? 'unfollow_channel' : 'follow_channel';
      await invoke(command, { targetUserId: userId });

      setIsFollowing(prev => !prev);
      Logger.debug(`[UserProfileCard] Successfully ${action}ed ${username}`);
    } catch (err: any) {
      Logger.error(`[UserProfileCard] ${action} error:`, err);
      useAppStore.getState().addToast(
        `Follow/Unfollow failed. Try logging out and back in via Settings to re-authenticate.`,
        'error'
      );
    } finally {
      setFollowLoading(false);
    }
  }, [userId, username, isFollowing]);

  // Categorized badges - prefer cached profile for instant display
  const { twitchBadges, seventvBadges, thirdPartyBadges, totalBadgeCount } = useMemo(() => {
    // Use cached profile for instant display, fallback to rust profile data
    const twitchFromCache = cachedProfile?.twitchBadges || [];
    const twitchFromRust = profileData?.badges?.display_badges || [];
    const earnedFromRust = profileData?.badges?.earned_badges || [];
    
    // Merge display and earned badges for Twitch (deduped)
    const twitchMap = new Map<string, any>();
    [...twitchFromCache, ...twitchFromRust, ...earnedFromRust].forEach((b: any) => {
      if (!twitchMap.has(b.id || b.setID)) {
        twitchMap.set(b.id || b.setID, b);
      }
    });
    const twitchBadges = Array.from(twitchMap.values()).map((b: any) => ({
      id: b.id || `${b.setID}-${b.version}`,
      src: b.image4x || b.image_4x || b.image1x || b.image_1x,
      srcSet: `${b.image1x || b.image_1x} 1x, ${b.image2x || b.image_2x} 2x, ${b.image4x || b.image_4x} 4x`,
      title: b.title,
      description: b.description
    }));

    // 7TV badges - prefer cached
    const seventvFromCache = cachedProfile?.seventvCosmetics?.badges || [];
    const seventvFromRust = profileData?.seventv_cosmetics?.badges || [];
    const seventvMap = new Map<string, any>();
    [...seventvFromCache, ...seventvFromRust].forEach((b: any) => {
      if (!seventvMap.has(b.id)) {
        seventvMap.set(b.id, b);
      }
    });
    const seventvBadges = Array.from(seventvMap.values()).map((b: any) => {
      const urls = getBadgeImageUrls(b);
      return {
        id: b.id,
        src: urls.url4x || `https://cdn.7tv.app/badge/${b.id}/4x`,
        fallbackUrls: getBadgeFallbackUrls(b.id).slice(1),
        srcSet: urls.url1x ? `${urls.url1x} 1x, ${urls.url2x} 2x, ${urls.url4x} 4x` : undefined,
        title: b.tooltip || b.description || b.name,
        name: b.name
      };
    });

    // Third-party badges (FFZ, Chatterino, Homies) - prefer cached
    const thirdPartyFromCache = cachedProfile?.thirdPartyBadges || [];
    const thirdPartyFromRust = profileData?.badges?.third_party_badges || [];
    const thirdPartyMap = new Map<string, any>();
    [...thirdPartyFromCache, ...thirdPartyFromRust].forEach((b: any) => {
      if (!thirdPartyMap.has(b.id)) {
        thirdPartyMap.set(b.id, b);
      }
    });
    const thirdPartyBadges = Array.from(thirdPartyMap.values()).map((b: any) => ({
      id: b.id,
      src: b.image4x || b.imageUrl,
      srcSet: b.image1x && b.image2x && b.image4x 
        ? `${b.image1x} 1x, ${b.image2x} 2x, ${b.image4x} 4x`
        : undefined,
      title: b.title,
      provider: b.provider
    }));

    return {
      twitchBadges,
      seventvBadges,
      thirdPartyBadges,
      totalBadgeCount: twitchBadges.length + seventvBadges.length + thirdPartyBadges.length
    };
  }, [cachedProfile, profileData]);

  const twitchProfile = profileData?.twitch_profile;
  const ivrData = profileData?.ivr_data;

  const bannerStyle = useMemo(() => {
    const bannerUrl = twitchProfile?.banner_image_url || twitchProfile?.offline_image_url;
    if (bannerUrl) {
      return {
        backgroundImage: `url(${bannerUrl})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      } as const;
    }
    const accent = color || '#9146FF';
    return {
      backgroundImage: `linear-gradient(135deg, ${accent}40 0%, ${accent}10 50%, #9146FF20 100%)`,
    } as const;
  }, [twitchProfile?.banner_image_url, twitchProfile?.offline_image_url, color]);

  const handleWhisper = useCallback(async () => {
    const user = {
      id: userId,
      login: username,
      display_name: displayName,
      profile_image_url: twitchProfile?.profile_image_url,
    };
    if (onStartWhisper) {
      onStartWhisper(user);
    } else if (isStandaloneWindow) {
      try {
        const { emit } = await import('@tauri-apps/api/event');
        await emit('start-whisper', user);
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().close();
      } catch (err) {
        Logger.error('Failed to emit whisper event:', err);
      }
    } else {
      useAppStore.getState().openWhisperWithUser(user);
    }
    onClose();
  }, [userId, username, displayName, twitchProfile?.profile_image_url, onStartWhisper, isStandaloneWindow, onClose]);

  const renderBadgeGroup = (
    label: string,
    badges: any[],
    renderItem: (badge: any, index: number) => React.ReactNode,
  ) => {
    if (badges.length === 0) return null;
    return (
      <div>
        <p className="text-[10px] text-textSecondary uppercase tracking-wider font-medium mb-2">
          {label} <span className="text-textSecondary/50 tabular-nums">{badges.length}</span>
        </p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {badges.map(renderItem)}
        </div>
      </div>
    );
  };

  return (
    <>
      {!isStandaloneWindow && (
        <div className="fixed inset-0 z-40 group">
          <div className="absolute inset-0 group-hover:pointer-events-none" onClick={onClose} />
        </div>
      )}
      <div
        ref={cardRef}
        className={`${isStandaloneWindow ? 'w-full h-full' : 'fixed z-50 w-[500px] max-h-[85vh]'} user-profile-card backdrop-blur-xl shadow-2xl border border-borderSubtle rounded-lg overflow-hidden flex flex-col`}
        style={isStandaloneWindow ? { backgroundColor: 'rgba(0, 0, 0, 0.75)' } : cardStyle}
        onMouseDown={isStandaloneWindow ? undefined : handleMouseDown}
      >
        {/* Sticky header: banner + floating avatar (absolute, so it can overflow the banner without getting clipped by the scroll body below). */}
        <div className="relative profile-card-header cursor-grab active:cursor-grabbing flex-shrink-0">
          <div className="h-24" style={bannerStyle} />
          <div className="absolute -bottom-10 left-4">
            <div className="w-20 h-20 rounded-full border-4 border-secondary bg-secondary overflow-hidden shadow-lg">
              {twitchProfile?.profile_image_url ? (
                <img src={twitchProfile.profile_image_url} alt={displayName} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-accent/20">
                  <span className="text-2xl font-bold text-textPrimary">{displayName[0].toUpperCase()}</span>
                </div>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="absolute top-2.5 right-2.5 p-1.5 glass-button text-textSecondary hover:text-textPrimary rounded-full"
            aria-label="Close profile"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Single scroll body. One padded container, vertical rhythm via space-y, no section dividers. */}
        <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
          <div className="px-4 pt-12 pb-4 space-y-4">
            {/* Identity: name + chips inline (Twitch ✓ → 7TV paint → StreamNook #N), handle, bio */}
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-xl font-bold leading-tight" style={usernameStyle}>{displayName}</h3>
                {twitchProfile?.broadcaster_type === 'partner' && (
                  <Tooltip content="Verified Partner" side="top">
                    <span className="inline-flex flex-shrink-0">
                      <svg className="w-[18px] h-[18px]" viewBox="0 0 16 16" fill="#9146FF">
                        <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd" />
                      </svg>
                    </span>
                  </Tooltip>
                )}
                {selectedPaint && (
                  <Tooltip content={`Paint: ${selectedPaint.name}`} side="top">
                    <button
                      onClick={() => openBadgesWithPaintInMain(selectedPaint.id)}
                      className="px-2 py-0.5 rounded-md text-[11px] font-bold inline-block relative overflow-hidden cursor-pointer hover:ring-1 hover:ring-accent/50 transition-all border border-white/10"
                      style={{
                        ...computePaintStyle(selectedPaint as any, color),
                        WebkitBackgroundClip: 'padding-box',
                        backgroundClip: 'padding-box',
                      }}
                    >
                      <span
                        style={{
                          ...computePaintStyle(selectedPaint as any, color),
                          filter: 'invert(1) contrast(1.5)',
                          WebkitBackgroundClip: 'text',
                          backgroundClip: 'text',
                        }}
                      >
                        {selectedPaint.name}
                      </span>
                    </button>
                  </Tooltip>
                )}
                {streamNookUserNumber !== null && (
                  <Tooltip content="StreamNook user" side="top">
                    <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white/5 border border-white/10">
                      <img src={streamNookLogo} alt="StreamNook" className="w-3.5 h-3.5 object-contain" draggable={false} />
                      <span className="text-[11px] font-semibold text-textPrimary tabular-nums">#{streamNookUserNumber}</span>
                    </div>
                  </Tooltip>
                )}
              </div>
              <p className="text-sm text-textSecondary mt-0.5">@{username}</p>
              {twitchProfile?.description && (
                <p className="text-sm text-textPrimary/85 mt-2.5 leading-relaxed">{twitchProfile.description}</p>
              )}
            </div>

            {/* Relationship: joined / following stats + sub/mod/vip pills (one block, no inner divider) */}
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                {twitchProfile && (
                  <div className="glass-panel rounded-md px-3 py-2">
                    <p className="text-[10px] text-textSecondary uppercase tracking-wider font-medium">Joined Twitch</p>
                    <p className="text-sm font-semibold text-textPrimary mt-0.5">{formatDate(twitchProfile.created_at)}</p>
                  </div>
                )}
                {ivrData && (ivrData.following_since || ivrData.status_hidden) ? (
                  <div className="glass-panel rounded-md px-3 py-2">
                    <p className="text-[10px] text-textSecondary uppercase tracking-wider font-medium">Following since</p>
                    {ivrData.status_hidden ? (
                      <p className="text-sm font-semibold text-textSecondary italic mt-0.5">Hidden</p>
                    ) : (
                      <p className="text-sm font-semibold text-textPrimary mt-0.5">{formatIVRDate(ivrData.following_since!)}</p>
                    )}
                  </div>
                ) : ivrData && !isLoadingProfile && (
                  <div className="glass-panel rounded-md px-3 py-2">
                    <p className="text-[10px] text-textSecondary uppercase tracking-wider font-medium">Following</p>
                    <p className="text-sm font-semibold text-textSecondary mt-0.5">Not following</p>
                  </div>
                )}
              </div>

              {ivrData && (ivrData.is_subscribed || ivrData.is_mod || ivrData.is_vip) && (
                <div className="flex flex-wrap gap-1.5">
                  {ivrData.is_subscribed && (
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-purple-500/10 border border-purple-500/20 text-[11px] text-purple-300">
                      <span className="font-semibold">Subscriber</span>
                      <span className="text-purple-300/70">{formatSubTenure(ivrData.sub_streak, ivrData.sub_cumulative)}</span>
                      {ivrData.is_founder && <span className="px-1 py-px rounded bg-purple-500/20 text-[9px] font-bold tracking-wider">FOUNDER</span>}
                    </span>
                  )}
                  {ivrData.is_mod && (
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-green-500/10 border border-green-500/20 text-[11px] text-green-300">
                      <span className="font-semibold">Moderator</span>
                      {ivrData.mod_since && <span className="text-green-300/70">since {formatIVRDate(ivrData.mod_since)}</span>}
                    </span>
                  )}
                  {ivrData.is_vip && (
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-pink-500/10 border border-pink-500/20 text-[11px] text-pink-300">
                      <span className="font-semibold">VIP</span>
                      {ivrData.vip_since && <span className="text-pink-300/70">since {formatIVRDate(ivrData.vip_since)}</span>}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Badges, provider-grouped inside one panel, no inner scroll.
                Section also renders when the user has the StreamNook badge but
                no chat badges, so the StreamNook identity always surfaces. */}
            {(totalBadgeCount > 0 || streamNookUserNumber !== null) && (
              <div>
                <p className="text-[11px] text-textSecondary uppercase tracking-wider font-semibold mb-2">
                  Badges <span className="text-textSecondary/60 tabular-nums">{totalBadgeCount + (streamNookUserNumber !== null ? 1 : 0)}</span>
                </p>
                <div className="glass-panel rounded-md px-3 py-3 space-y-3">
                {renderBadgeGroup('Twitch', twitchBadges, (b, i) => (
                  <Tooltip key={`twitch-${b.id}-${i}`} content={b.description ? `${b.title}\n${b.description}` : b.title} side="top">
                    <img
                      src={b.src}
                      srcSet={b.srcSet}
                      alt={b.title}
                      className="w-5 h-5 cursor-pointer hover:scale-110 transition-transform"
                      onError={e => { e.currentTarget.style.display = 'none'; }}
                    />
                  </Tooltip>
                ))}
                {/* StreamNook badge. Sits between Twitch (the platform) and 7TV
                    (cosmetic provider). Default click opens BadgesOverlay on the
                    StreamNook tab via the badge component's own handler. */}
                {streamNookUserNumber !== null && (
                  <div>
                    <p className="text-[10px] text-textSecondary uppercase tracking-wider font-medium mb-2">
                      StreamNook <span className="text-textSecondary/50 tabular-nums">1</span>
                    </p>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <StreamNookBadge userNumber={streamNookUserNumber} />
                    </div>
                  </div>
                )}
                {renderBadgeGroup('7TV', seventvBadges, (b, i) => (
                  <Tooltip key={`7tv-${b.id}-${i}`} content={b.title} side="top">
                    <FallbackImage
                      src={b.src}
                      fallbackUrls={b.fallbackUrls}
                      alt={b.title}
                      className="w-5 h-5 cursor-pointer hover:scale-110 transition-transform"
                      onClick={async () => {
                        try {
                          const { open } = await import('@tauri-apps/plugin-shell');
                          await open(`https://7tv.app/badges/${b.id}`);
                        } catch (err) {
                          Logger.error('Failed to open URL:', err);
                        }
                      }}
                    />
                  </Tooltip>
                ))}
                {renderBadgeGroup('Other', thirdPartyBadges, (b, i) => (
                  <Tooltip key={`3p-${b.id}-${i}`} content={`${b.title} (${b.provider?.toUpperCase() || 'Other'})`} side="top">
                    <img
                      src={b.src}
                      srcSet={b.srcSet}
                      alt={b.title}
                      className="w-5 h-5 cursor-pointer hover:scale-110 transition-transform"
                      onError={e => { e.currentTarget.style.display = 'none'; }}
                    />
                  </Tooltip>
                ))}
              </div>
            </div>
          )}

            {/* Personal nickname + chat color (only visible to this user).
                Doesn't change @mention behavior — Twitch IRC still resolves
                real logins, and color is purely a display-layer override. */}
            <NicknameEditor userId={userId} username={username} displayName={displayName} twitchColor={color} />

            {/* Actions: 2x2 grid + messages toggle */}
            <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Tooltip content={followLoading ? 'Processing...' : isFollowing ? `Unfollow ${displayName}` : `Follow ${displayName}`} side="top">
                <button
                  onClick={handleFollowAction}
                  disabled={followLoading}
                  className={`glass-button text-white text-xs py-2.5 px-3 rounded-md text-center transition-colors flex items-center justify-center gap-1.5 w-full ${followLoading
                    ? 'opacity-50 cursor-wait'
                    : isFollowing
                      ? 'hover:bg-red-500/20 border-red-500/30'
                      : 'hover:bg-green-500/20 border-green-500/30'
                    }`}
                >
                  {followLoading ? (
                    <>
                      <Loader2 size={14} className="animate-spin text-purple-400" />
                      <span>Working...</span>
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
              </Tooltip>
              <button
                onClick={handleWhisper}
                className="glass-button text-white text-xs py-2.5 px-3 rounded-md text-center hover:bg-purple-500/20 transition-colors flex items-center justify-center gap-1.5 w-full"
              >
                <MessageCircle size={14} className="text-purple-400" />
                Whisper
              </button>
              <button
                onClick={() => {
                  useAppStore.getState().startOfflineChat(username);
                  onClose();
                }}
                className="glass-button text-white text-xs py-2.5 px-3 rounded-md text-center hover:bg-accent/20 transition-colors w-full"
              >
                Join Chat
              </button>
              <a
                href={`https://www.twitch.tv/${username}`}
                target="_blank"
                rel="noopener noreferrer"
                className="glass-button text-white text-xs py-2.5 px-3 rounded-md text-center hover:bg-accent/20 transition-colors flex items-center justify-center w-full"
              >
                Open on Twitch
              </a>
            </div>

            <button
              onClick={() => setShowMessages(!showMessages)}
              className={`w-full glass-button text-white text-xs py-2 px-3 rounded-md text-center transition-colors flex items-center justify-center gap-1.5 ${showMessages ? 'bg-accent/15' : 'hover:bg-accent/15'}`}
            >
              {showMessages ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {showMessages ? 'Hide' : 'Show'} recent messages
              <span className="text-textSecondary/70">({messageHistory.length})</span>
            </button>

            {showMessages && (
              <div className="pt-2">
                {messageHistory.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-6 text-center">
                    <MessageCircle size={28} className="text-textSecondary/30 mb-2" />
                    <p className="text-sm text-textSecondary">No messages yet</p>
                    <p className="text-xs text-textSecondary/60 mt-1">Messages will appear here as they chat</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {messageHistory.slice().reverse().map((msg, idx) => (
                      <div
                        key={idx}
                        className="px-3 py-2 glass-panel rounded-md text-sm hover:bg-white/5 transition-colors"
                      >
                        <p className="text-textPrimary break-words leading-relaxed">{msg.content}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

            {/* Mod zone. Kept inside body container; red top border is the only divider we keep, as a semantic danger-zone signal */}
            {isModerator && broadcasterId && (
              <div className="pt-3 border-t border-red-500/20">
                <div className="flex items-center gap-1.5 mb-2.5">
                  <svg className="w-3.5 h-3.5 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                  <span className="text-[10px] uppercase font-bold text-red-400 tracking-wider">Moderator Actions</span>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <Tooltip content="Purge recent messages" side="top">
                    <button
                      onClick={async () => {
                        if (onPreFillCommand) { onPreFillCommand(`/timeout ${username} 1 Purge`); onClose(); return; }
                        try {
                          const { invoke } = await import('@tauri-apps/api/core');
                          await invoke('ban_user', { broadcasterId, targetUserId: userId, duration: 1, reason: 'Purge' });
                          useAppStore.getState().addToast(`Purged messages for ${username}`, 'success');
                        } catch (err) {
                          Logger.error('[UserProfileCard] Failed to purge:', err);
                          useAppStore.getState().addToast('Failed to purge user', 'error');
                        }
                      }}
                      className="py-1.5 glass-button text-xs font-semibold text-white/70 hover:text-white hover:bg-orange-500/20 border hover:border-orange-500/30 rounded flex items-center justify-center transition-colors"
                    >
                      Purge
                    </button>
                  </Tooltip>
                  <Tooltip content="Timeout for 10 minutes" side="top">
                    <button
                      onClick={async () => {
                        if (onPreFillCommand) { onPreFillCommand(`/timeout ${username} 600 `); onClose(); return; }
                        try {
                          const { invoke } = await import('@tauri-apps/api/core');
                          await invoke('ban_user', { broadcasterId, targetUserId: userId, duration: 600, reason: null });
                          useAppStore.getState().addToast(`Timed out ${username} for 10m`, 'success');
                        } catch (err) {
                          Logger.error('[UserProfileCard] Failed to timeout:', err);
                          useAppStore.getState().addToast('Failed to timeout user', 'error');
                        }
                      }}
                      className="py-1.5 glass-button text-xs font-semibold text-white/70 hover:text-white hover:bg-yellow-500/20 border hover:border-yellow-500/30 rounded flex items-center justify-center transition-colors"
                    >
                      10m
                    </button>
                  </Tooltip>
                  <Tooltip content="Timeout for 24 hours" side="top">
                    <button
                      onClick={async () => {
                        if (onPreFillCommand) { onPreFillCommand(`/timeout ${username} 86400 `); onClose(); return; }
                        try {
                          const { invoke } = await import('@tauri-apps/api/core');
                          await invoke('ban_user', { broadcasterId, targetUserId: userId, duration: 86400, reason: null });
                          useAppStore.getState().addToast(`Timed out ${username} for 24h`, 'success');
                        } catch (err) {
                          Logger.error('[UserProfileCard] Failed to timeout:', err);
                          useAppStore.getState().addToast('Failed to timeout user', 'error');
                        }
                      }}
                      className="py-1.5 glass-button text-xs font-semibold text-white/70 hover:text-white hover:bg-orange-600/20 border hover:border-orange-600/30 rounded flex items-center justify-center transition-colors"
                    >
                      24h
                    </button>
                  </Tooltip>
                  <Tooltip content="Permanently Ban User" side="top">
                    <button
                      onClick={async () => {
                        if (onPreFillCommand) { onPreFillCommand(`/ban ${username} `); onClose(); return; }
                        if (window.confirm(`Are you sure you want to permanently ban ${username}?`)) {
                          try {
                            const { invoke } = await import('@tauri-apps/api/core');
                            await invoke('ban_user', { broadcasterId, targetUserId: userId, duration: null, reason: null });
                            useAppStore.getState().addToast(`Banned ${username}`, 'success');
                            onClose();
                          } catch (err) {
                            Logger.error('[UserProfileCard] Failed to ban:', err);
                            useAppStore.getState().addToast('Failed to ban user', 'error');
                          }
                        }
                      }}
                      className="py-1.5 text-xs font-semibold text-red-200 bg-red-900/50 hover:bg-red-600 border border-red-500/30 rounded flex items-center justify-center transition-colors shadow-lg"
                    >
                      Ban
                    </button>
                  </Tooltip>
                </div>
                <div className="mt-2 text-right">
                  <button
                    onClick={async () => {
                      if (window.confirm(`Unban ${username}?`)) {
                        try {
                          const { invoke } = await import('@tauri-apps/api/core');
                          await invoke('unban_user', { broadcasterId, targetUserId: userId });
                          useAppStore.getState().addToast(`Unbanned ${username}`, 'success');
                        } catch (err) {
                          Logger.error('[UserProfileCard] Failed to unban:', err);
                          useAppStore.getState().addToast('Failed to unban user', 'error');
                        }
                      }
                    }}
                    className="text-[10px] font-medium text-textSecondary hover:text-white hover:underline cursor-pointer"
                  >
                    Unban User
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default UserProfileCard;
