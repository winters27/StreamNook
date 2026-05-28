import { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } from 'react';
import { MessageCircle, UserPlus, UserMinus, Loader2, ChevronDown, ChevronUp, Pencil, X, Gift } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { setUserNickname, setUserColor } from '../utils/userChatOverrides';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { openBadgesWithPaintInMain, openBadgesOnStreamNookInMain } from '../utils/openBadgesInMain';
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
import { getStreamNookUserNumber, subscribeStreamNookRegistryVersion, getStreamNookRegistryVersion, getOwnedCosmeticSlugs, getActiveCosmeticSlug, getCosmeticBySlug, getCosmeticsVersion, subscribeCosmeticsVersion } from '../services/supabaseService';
import { COSMETIC_ASSET_BY_SLUG } from './cosmeticAssets';
import { StreamNookBadge } from './StreamNookBadge';
import streamNookLogo from '../assets/streamnook-logo.png';

// messageHistory arrives from two sources:
//   1. The frontend's in-session userMessageHistory Map (full ParsedMessage shape
//      with username/color/badges/tags). Used by the inline-popup fallback path.
//   2. The Rust user_message_history_service via get_user_message_history,
//      which returns a compact UserMessageSummary { id, content, timestamp, color }.
//      Used by the popout window path (the default).
// The reader below prefers top-level `id`/`timestamp` when present and falls back
// to the IRC tags map for the frontend-cache shape.
interface ParsedMessage {
  username?: string;
  content: string;
  color?: string;
  badges?: Array<{ key: string; info: any }>;
  tags?: Map<string, string> | Record<string, string>;
  emotes?: string;
  // Rust UserMessageSummary fields
  id?: string;
  timestamp?: string;
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
  last_broadcast_at: string | null;
  last_broadcast_title: string | null;
  follows_count: number | null;
  sub_tier: string | null;
  sub_type: string | null;
  sub_gifter_login: string | null;
  sub_gifter_display_name: string | null;
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
  // Historical chat logs pulled from the merged Twitch GQL + Justlog + Robotty
  // pipeline in Rust. Each entry carries the Twitch IRC message UUID in `id`
  // (when available) which the frontend uses to dedupe against in-session
  // messages — without that cross-source dedupe, the same message can appear
  // both as in-session (we saw it land in chat) and as historical (Robotty or
  // Twitch's MessageBufferChatHistory included it), showing as a duplicate.
  const [historicalMessages, setHistoricalMessages] = useState<{ timestamp: string; content: string; id?: string }[]>([]);
  const [historicalLoading, setHistoricalLoading] = useState(false);
  const [historicalAttempted, setHistoricalAttempted] = useState(false);
  const [historicalChannelLogged, setHistoricalChannelLogged] = useState(true);

  // Re-render when the StreamNook registry updates so the #N chip appears as soon as it loads
  useSyncExternalStore(subscribeStreamNookRegistryVersion, getStreamNookRegistryVersion, getStreamNookRegistryVersion);
  // Re-render when the cosmetics registry updates so this user's owned-but-not-active
  // StreamNook badges appear / refresh as ownership changes (e.g. a grant from a
  // streamnook.app purchase lands while the popup is open).
  useSyncExternalStore(subscribeCosmeticsVersion, getCosmeticsVersion, getCosmeticsVersion);
  const streamNookUserNumber = getStreamNookUserNumber(userId);
  // Only enumerate owned StreamNook cosmetics for users who are actually in the
  // registry. `getOwnedCosmeticSlugs` includes every `is_default` cosmetic for
  // ANY userId by design (so the picker can preview defaults), which means
  // calling it for a non-StreamNook user returns the defaults set — and any
  // surface that renders those would falsely show the default badge to people
  // who aren't members. Gate at the source: empty list when not registered.
  const isStreamNookMember = streamNookUserNumber !== null;
  const ownedStreamNookSlugs = useMemo(
    () => (isStreamNookMember ? Array.from(getOwnedCosmeticSlugs(userId)) : []),
    [userId, isStreamNookMember, getCosmeticsVersion()],
  );
  const activeStreamNookSlug = isStreamNookMember && userId ? getActiveCosmeticSlug(userId) : null;
  // Non-active owned badges, sorted by catalog sort_order so the UI order stays stable.
  const inactiveOwnedSlugs = useMemo(() => {
    return ownedStreamNookSlugs
      .filter((s) => s !== activeStreamNookSlug && COSMETIC_ASSET_BY_SLUG[s])
      .map((s) => ({ slug: s, cosmetic: getCosmeticBySlug(s) }))
      .filter((entry): entry is { slug: string; cosmetic: NonNullable<ReturnType<typeof getCosmeticBySlug>> } => entry.cosmetic !== null)
      .sort((a, b) => a.cosmetic.sort_order - b.cosmetic.sort_order);
  }, [ownedStreamNookSlugs, activeStreamNookSlug]);
  const streamNookBadgeCount = isStreamNookMember ? 1 + inactiveOwnedSlugs.length : 0;
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

  // Lazily fetch the user's historical chat logs from Justlog the first time
  // the messages view is opened. We don't pre-fetch because most popup opens
  // never expand messages — paying the request cost upfront would be wasteful.
  useEffect(() => {
    if (!showMessages || historicalAttempted) return;
    const { channelName, channelId } = getChannelContext();
    if (!channelName || !username) return;

    let cancelled = false;
    setHistoricalAttempted(true);
    setHistoricalLoading(true);
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        // channelId + userId enable the Twitch GQL source (mod-gated, deep
        // history). When either is missing the Rust side silently skips
        // Twitch GQL and falls back to Justlog + Robotty.
        const messages = await invoke<{ timestamp: string; content: string; id?: string }[]>(
          'fetch_user_chat_logs',
          { channel: channelName, username, channelId, userId },
        );
        if (!cancelled) {
          setHistoricalMessages(messages);
          setHistoricalChannelLogged(messages.length > 0);
        }
      } catch (e) {
        Logger.warn('[UserProfileCard] Historical chat fetch failed:', e);
        if (!cancelled) setHistoricalChannelLogged(false);
      } finally {
        if (!cancelled) setHistoricalLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showMessages, historicalAttempted, getChannelContext, username, userId]);

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
        const badgeUrl = `https://cdn.7tv.app/badge/${badge.id}/4x.webp`;
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
  // Compact relative-time helper for the "Last live" row. Returns short forms
  // like "3d ago" / "5w ago" / "2mo ago" / "1y ago" that fit cleanly in the
  // tight stats panel. Falls back to the absolute date if anything fails.
  const formatRelative = (ds: string) => {
    try {
      const date = new Date(ds);
      const diffMs = Date.now() - date.getTime();
      const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (days < 1) return 'today';
      if (days < 7) return `${days}d ago`;
      if (days < 30) return `${Math.floor(days / 7)}w ago`;
      if (days < 365) return `${Math.floor(days / 30)}mo ago`;
      const years = Math.floor(days / 365);
      return years === 1 ? '1y ago' : `${years}y ago`;
    } catch {
      return formatDate(ds);
    }
  };

  useEffect(() => {
    // cardWidth MUST match the `w-[402px]` className on the card root below
    // (matches DEFAULT_CHAT_WIDTH from App.tsx, same as the popout window).
    // When this literal drifts out of sync with the className the math places
    // the left edge based on the wrong width — too-large value pushes the
    // modal far to the left of the cursor (looks like "opens super far away"),
    // too-small overhangs the cursor on the right. Tailwind JIT requires the
    // literal in the class string so we can't extract a shared constant — keep
    // both in lockstep manually.
    const cardWidth = 402, padding = 10, gap = 10;
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
      const cardWidth = cardRef.current?.offsetWidth || 402;
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
        src: urls.url4x || `https://cdn.7tv.app/badge/${b.id}/4x.webp`,
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
        className={`${isStandaloneWindow ? 'w-full h-full' : 'fixed z-50 w-[402px] max-h-[88vh]'} user-profile-card backdrop-blur-xl shadow-2xl border border-borderSubtle rounded-lg overflow-hidden flex flex-col`}
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
              {!showMessages && twitchProfile?.description && (
                <p className="text-sm text-textPrimary/85 mt-2.5 leading-relaxed">{twitchProfile.description}</p>
              )}
            </div>

            {/* Takeover animation. When showMessages flips true, the messages
                view slides DOWN from the top while the regular profile body
                slides UP off the top — a "curtain reveal" feel. AnimatePresence
                with `mode="wait"` ensures the exit animation completes before
                the enter animation starts. The wrapper has `overflow-hidden`
                so the slide-out doesn't leak above the identity section. */}
            <div className="relative overflow-hidden">
              <AnimatePresence mode="wait" initial={false}>
                {showMessages ? (
                  <motion.div
                    key="messages-view"
                    initial={{ y: -16, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: -16, opacity: 0 }}
                    transition={{ type: 'tween', duration: 0.22, ease: 'easeOut' }}
                    className="-mx-2"
                  >
                    <div className="flex items-center justify-between px-2 mb-2">
                      <button
                        type="button"
                        onClick={() => setShowMessages(false)}
                        className="inline-flex items-center gap-1 text-[11px] text-textSecondary hover:text-textPrimary transition-colors"
                      >
                        <ChevronDown size={14} />
                        Back to profile
                      </button>
                      <span className="text-[10px] text-textSecondary uppercase tracking-wider font-semibold">
                        Chat history{historicalLoading ? ' · loading…' : ''}
                      </span>
                    </div>
                    {(() => {
                      // Unified message timeline. Historical (Twitch GQL +
                      // Justlog + Robotty, merged in Rust) AND in-session
                      // sources normalize to { ts, content, id }, dedupe by
                      // Twitch IRC message UUID across BOTH layers, then
                      // sort + group by day. Same timeline shape 7TV's
                      // extension uses.
                      const readTag = (msg: any, key: string): string | undefined => {
                        const tags = msg?.tags;
                        if (!tags) return undefined;
                        if (tags instanceof Map) return tags.get(key);
                        if (typeof tags === 'object') return tags[key];
                        return undefined;
                      };
                      const sessionTimestamp = (msg: any): number | null => {
                        // Rust UserMessageSummary path: top-level unix-ms string.
                        if (typeof msg?.timestamp === 'string') {
                          const n = parseInt(msg.timestamp, 10);
                          if (Number.isFinite(n)) return n;
                        }
                        // Frontend ParsedMessage path: from IRC tags.
                        const raw = readTag(msg, 'tmi-sent-ts');
                        const n = raw ? parseInt(raw, 10) : NaN;
                        return Number.isFinite(n) ? n : null;
                      };
                      const historicalTs = (iso: string): number | null => {
                        const n = Date.parse(iso);
                        return Number.isFinite(n) ? n : null;
                      };

                      type TimelineEntry = { ts: number; content: string; id?: string };
                      const rawEntries: TimelineEntry[] = [];
                      for (const m of historicalMessages) {
                        const ts = historicalTs(m.timestamp);
                        if (ts !== null) rawEntries.push({ ts, content: m.content, id: m.id });
                      }
                      for (const m of messageHistory) {
                        const ts = sessionTimestamp(m) ?? Date.now();
                        // IRC `id` tag is the Twitch message UUID. Prefer the
                        // top-level field (UserMessageSummary path) and fall
                        // back to the tags map (ParsedMessage path). Same id
                        // each historical source carries, so it's the right
                        // cross-layer dedupe key.
                        const id = (m as any).id ?? readTag(m, 'id');
                        rawEntries.push({ ts, content: m.content, id });
                      }

                      // Dedupe by id when present; fall back to
                      // (content, ts within 2s) for the rare case a source
                      // didn't carry an id. The in-session buffer for a busy
                      // chatter can easily overlap with Robotty's last-100
                      // or MessageBufferChatHistory's ~30; without this pass
                      // the same message appears twice in the popup.
                      const seenIds = new Set<string>();
                      const entries: TimelineEntry[] = [];
                      for (const e of rawEntries) {
                        if (e.id) {
                          if (seenIds.has(e.id)) continue;
                          seenIds.add(e.id);
                        } else {
                          const dup = entries.find(
                            (x) => x.content === e.content && Math.abs(x.ts - e.ts) <= 2000,
                          );
                          if (dup) continue;
                        }
                        entries.push(e);
                      }
                      entries.sort((a, b) => a.ts - b.ts);

                      if (entries.length === 0 && !historicalLoading) {
                        return (
                          <div className="px-2">
                            <div className="flex flex-col items-center justify-center py-12 text-center">
                              <MessageCircle size={32} className="text-textSecondary/30 mb-2" />
                              <p className="text-sm text-textSecondary">No messages found</p>
                              <p className="text-xs text-textSecondary/60 mt-1">
                                {historicalChannelLogged
                                  ? 'New messages from this user will appear here.'
                                  : 'No historical messages available for this channel.'}
                              </p>
                            </div>
                          </div>
                        );
                      }

                      // Group entries by calendar day for the timeline separators.
                      const dayKey = (ts: number) => {
                        const d = new Date(ts);
                        return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
                      };
                      const groups: { key: string; label: string; entries: TimelineEntry[] }[] = [];
                      const todayKey = dayKey(Date.now());
                      const yesterdayKey = dayKey(Date.now() - 86_400_000);
                      const dayLabel = (ts: number, key: string): string => {
                        if (key === todayKey) return 'Today';
                        if (key === yesterdayKey) return 'Yesterday';
                        return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                      };
                      let currentKey = '';
                      for (const e of entries) {
                        const k = dayKey(e.ts);
                        if (k !== currentKey) {
                          groups.push({ key: k, label: dayLabel(e.ts, k), entries: [] });
                          currentKey = k;
                        }
                        groups[groups.length - 1].entries.push(e);
                      }

                      const formatTime = (ts: number) => {
                        const d = new Date(ts);
                        const h = d.getHours().toString().padStart(2, '0');
                        const m = d.getMinutes().toString().padStart(2, '0');
                        return `${h}:${m}`;
                      };

                      return (
                        <div className="px-2">
                          {groups.map((g) => (
                            <div key={g.key} className="mb-3 last:mb-0">
                              <div className="flex items-center gap-2 my-2">
                                <div className="flex-1 h-px bg-borderSubtle" />
                                <span className="text-[10px] text-textSecondary/70 uppercase tracking-wider tabular-nums">
                                  {g.label}
                                </span>
                                <div className="flex-1 h-px bg-borderSubtle" />
                              </div>
                              <div className="space-y-0.5">
                                {g.entries.map((e, idx) => (
                                  <div
                                    key={`${g.key}-${idx}`}
                                    className="flex items-baseline gap-2 py-1 px-2 rounded hover:bg-white/[0.03] transition-colors"
                                  >
                                    <span className="text-[10px] text-textSecondary/60 tabular-nums shrink-0 mt-px">
                                      {formatTime(e.ts)}
                                    </span>
                                    <span className="text-[13px] font-semibold shrink-0" style={{ color }}>
                                      {displayName}:
                                    </span>
                                    <span className="text-[13px] text-textPrimary break-words leading-snug min-w-0">
                                      {e.content}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </motion.div>
                ) : (
                  <motion.div
                    key="profile-body"
                    initial={{ y: -16, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: -16, opacity: 0 }}
                    transition={{ type: 'tween', duration: 0.22, ease: 'easeOut' }}
                    className="space-y-4"
                  >
                    {/* Everything below the identity section gets hidden during
                        the messages-takeover view so the message list can fill
                        the modal body. */}

            {/* Relationship: a single compact stats panel + the sub/mod/vip pills.
                Each row only renders if we have the data, so the panel grows
                organically without empty cells. */}
            <div className="space-y-2">
              {(() => {
                // Current-channel context for "Gift a sub" target. Hidden when we're
                // viewing this user's own channel (you'd be gifting them a sub to
                // themselves, which is awkward) or when there's no active stream.
                const { channelName: viewedChannel } = (propChannelId && propChannelName)
                  ? { channelName: propChannelName }
                  : { channelName: useAppStore.getState().currentStream?.user_login };
                const canGiftSub = !!viewedChannel
                  && !!username
                  && viewedChannel.toLowerCase() !== username.toLowerCase()
                  && !ivrData?.is_subscribed;
                const handleGiftSub = async () => {
                  try {
                    const { open } = await import('@tauri-apps/plugin-shell');
                    // ?giftrecipient= is a best-guess query param. If Twitch ignores
                    // it the user lands on the subs page and types the name manually,
                    // which is still a one-click improvement over leaving the app.
                    await open(`https://www.twitch.tv/subs/${viewedChannel}?giftrecipient=${username}`);
                  } catch (err) {
                    Logger.error('Failed to open gift sub URL:', err);
                  }
                };
                const hasAnyStat = !!twitchProfile
                  || !!ivrData?.following_since
                  || !!ivrData?.status_hidden
                  || !!ivrData?.last_broadcast_at
                  || (ivrData?.follows_count ?? 0) > 0
                  || (!ivrData?.is_subscribed && (ivrData?.sub_cumulative ?? 0) > 0);
                return (
                  <>
                    {hasAnyStat && (
                      <div className="glass-panel rounded-md px-3 py-2 space-y-1">
                        {twitchProfile && (
                          <div className="flex items-baseline justify-between gap-3 text-[11px]">
                            <span className="text-textSecondary">Joined Twitch</span>
                            <span className="text-textPrimary font-medium tabular-nums">{formatDate(twitchProfile.created_at)}</span>
                          </div>
                        )}
                        {ivrData && (ivrData.following_since || ivrData.status_hidden) ? (
                          <div className="flex items-baseline justify-between gap-3 text-[11px]">
                            <span className="text-textSecondary">Following since</span>
                            {ivrData.status_hidden ? (
                              <span className="text-textSecondary italic">Hidden</span>
                            ) : (
                              <span className="text-textPrimary font-medium tabular-nums">{formatDate(ivrData.following_since!)}</span>
                            )}
                          </div>
                        ) : ivrData && !isLoadingProfile && (
                          <div className="flex items-baseline justify-between gap-3 text-[11px]">
                            <span className="text-textSecondary">Following</span>
                            <span className="text-textSecondary italic">Not following</span>
                          </div>
                        )}
                        {(ivrData?.follows_count ?? 0) > 0 && (
                          <div className="flex items-baseline justify-between gap-3 text-[11px]">
                            <span className="text-textSecondary">Follows</span>
                            <span className="text-textPrimary font-medium tabular-nums">{ivrData!.follows_count!.toLocaleString()} channels</span>
                          </div>
                        )}
                        {ivrData && !ivrData.is_subscribed && (ivrData.sub_cumulative ?? 0) > 0 && (
                          <div className="flex items-baseline justify-between gap-3 text-[11px]">
                            <span className="text-textSecondary">Past subscriber</span>
                            <span className="text-textPrimary font-medium tabular-nums">
                              {ivrData.sub_cumulative === 1 ? '1mo total' : `${ivrData.sub_cumulative}mo total`}
                            </span>
                          </div>
                        )}
                        {ivrData?.last_broadcast_at && (
                          <Tooltip content={ivrData.last_broadcast_title ?? formatDate(ivrData.last_broadcast_at)} side="top">
                            <div className="flex items-baseline justify-between gap-3 text-[11px] cursor-default">
                              <span className="text-textSecondary">Last live</span>
                              <span className="text-textPrimary font-medium tabular-nums">{formatRelative(ivrData.last_broadcast_at)}</span>
                            </div>
                          </Tooltip>
                        )}
                      </div>
                    )}

                    {(ivrData?.is_subscribed || ivrData?.is_mod || ivrData?.is_vip) && (
                      <div className="flex flex-wrap gap-1.5">
                        {ivrData?.is_subscribed && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-purple-500/10 border border-purple-500/20 text-[11px] text-purple-300">
                            <span className="font-semibold">
                              {ivrData.sub_tier === 'Prime' ? 'Prime' : ivrData.sub_tier ? `Tier ${ivrData.sub_tier}` : ''}
                              {ivrData.sub_tier ? ' ' : ''}Subscriber
                            </span>
                            <span className="text-purple-300/70">{formatSubTenure(ivrData.sub_streak, ivrData.sub_cumulative)}</span>
                            {ivrData.sub_type === 'gift' && ivrData.sub_gifter_display_name && (
                              <span className="text-purple-300/70">gift from {ivrData.sub_gifter_display_name}</span>
                            )}
                            {ivrData.is_founder && <span className="px-1 py-px rounded bg-purple-500/20 text-[9px] font-bold tracking-wider">FOUNDER</span>}
                          </span>
                        )}
                        {ivrData?.is_mod && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-green-500/10 border border-green-500/20 text-[11px] text-green-300">
                            <span className="font-semibold">Moderator</span>
                            {ivrData.mod_since && <span className="text-green-300/70">since {formatIVRDate(ivrData.mod_since)}</span>}
                          </span>
                        )}
                        {ivrData?.is_vip && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-pink-500/10 border border-pink-500/20 text-[11px] text-pink-300">
                            <span className="font-semibold">VIP</span>
                            {ivrData.vip_since && <span className="text-pink-300/70">since {formatIVRDate(ivrData.vip_since)}</span>}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Gift-sub action. Text link, not a chip — keeps the
                        visual weight light and matches the "View Full Changelog"
                        / "Open Settings →" pattern. Hover state adds underline +
                        a small arrow nudge so it reads as clickable without
                        becoming a border-pill. */}
                    {canGiftSub && (
                      <button
                        type="button"
                        onClick={handleGiftSub}
                        className="group inline-flex items-center gap-1.5 text-[11px] text-accent hover:text-accent/90 hover:underline underline-offset-[3px] decoration-accent/60 transition-colors"
                      >
                        <Gift size={12} />
                        <span>Gift {displayName} a sub to {viewedChannel}</span>
                        <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">→</span>
                      </button>
                    )}
                  </>
                );
              })()}
            </div>

            {/* Badges, provider-grouped inside one panel, no inner scroll.
                Section also renders when the user has the StreamNook badge but
                no chat badges, so the StreamNook identity always surfaces.
                Order: StreamNook → Twitch → 7TV → Third-party. StreamNook leads
                because it's the strongest community signal in our app; Twitch
                is the platform tier; 7TV/other are cosmetic providers. */}
            {(totalBadgeCount > 0 || streamNookBadgeCount > 0) && (
              <div>
                <p className="text-[11px] text-textSecondary uppercase tracking-wider font-semibold mb-2">
                  Badges <span className="text-textSecondary/60 tabular-nums">{totalBadgeCount + streamNookBadgeCount}</span>
                </p>
                <div className="glass-panel rounded-md px-3 py-3 space-y-3">
                {/* StreamNook badges. The active selection renders with the full
                    tier-card tooltip (user identity surface). Other owned-but-
                    inactive badges render as simple thumbnails alongside it,
                    matching how 7TV / Third-party expose multiple owned items. */}
                {streamNookBadgeCount > 0 && (
                  <div>
                    <p className="text-[10px] text-textSecondary uppercase tracking-wider font-medium mb-2">
                      StreamNook <span className="text-textSecondary/50 tabular-nums">{streamNookBadgeCount}</span>
                    </p>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {streamNookUserNumber !== null && (
                        <StreamNookBadge userId={userId} userNumber={streamNookUserNumber} />
                      )}
                      {inactiveOwnedSlugs.map(({ slug, cosmetic }) => {
                        const asset = COSMETIC_ASSET_BY_SLUG[slug];
                        return (
                          <Tooltip key={`sn-${slug}`} content={cosmetic.name} side="top">
                            <img
                              src={asset}
                              alt={cosmetic.name}
                              className="w-6 h-6 inline-block object-contain cursor-pointer hover:scale-110 transition-transform"
                              draggable={false}
                              onClick={openBadgesOnStreamNookInMain}
                            />
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>
                )}
                {renderBadgeGroup('Twitch', twitchBadges, (b, i) => (
                  <Tooltip key={`twitch-${b.id}-${i}`} content={b.description ? `${b.title}\n${b.description}` : b.title} side="top">
                    <img
                      src={b.src}
                      alt={b.title}
                      className="w-5 h-5 cursor-pointer hover:scale-110 transition-transform"
                      onError={e => { e.currentTarget.style.display = 'none'; }}
                    />
                  </Tooltip>
                ))}
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

            {/* Trigger for the messages takeover. Chevron points UP because
                clicking expands the messages region upward into the body
                above. No count badge — the local in-session buffer is just
                one of three sources we pull from, so showing its count would
                be misleading (often 0 even when Justlog / robotty have
                plenty of history). */}
            <button
              onClick={() => setShowMessages(true)}
              className="w-full glass-button text-white text-xs py-2 px-3 rounded-md text-center transition-colors flex items-center justify-center gap-1.5 hover:bg-accent/15"
            >
              <ChevronUp size={14} />
              Show recent messages
            </button>
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

                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default UserProfileCard;
