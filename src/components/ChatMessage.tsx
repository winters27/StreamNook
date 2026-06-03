import React, { useMemo, useState, useEffect, memo, useSyncExternalStore } from 'react';
import { Gift } from 'lucide-react';
import { Tooltip } from './ui/Tooltip';
import { parseMessage } from '../services/twitchChat';
import { queueEmoteForCaching, EmoteSet, Emote } from '../services/emoteService';
import { getCachedEmojiUrl, parseEmojisSync } from '../services/emojiService';
import { calculateHalfPadding } from '../utils/chatLayoutUtils';
import { computePaintStyle, getBadgeImageUrl, getBadgeFallbackUrls, queueCosmeticForCaching } from '../services/seventvService';
import { FallbackImage } from './FallbackImage';
import { getCosmeticsWithFallback } from '../services/cosmeticsCache';
import type { ThirdPartyBadge as ThirdPartyBadgeType } from '../services/thirdPartyBadges';
import { useAppStore } from '../stores/AppStore';
import { openBadgesWithBadgeInMain } from '../utils/openBadgesInMain';
import { useChatUserStore } from '../stores/chatUserStore';
import { queueBadgeForCaching, getCachedBadgeUrl } from '../services/badgeImageCacheService';
import { isStreamNookUser, getStreamNookUserNumber, subscribeStreamNookRegistryVersion, getStreamNookRegistryVersion } from '../services/supabaseService';
import { StreamNookBadge } from './StreamNookBadge';
import { AtmosphereBackground } from './AtmosphereBackground';
import { getAtmosphere } from '../services/atmospheres';
import { matchHighlightPhrase, matchHighlightUser, matchHighlightBadge, type HighlightMatch } from '../utils/chatHighlightMatcher';
import { flashTitle } from '../utils/titleFlasher';
import { playSoundThrottled } from '../utils/notificationSound';
import { getDisplayedName, getColorOverride } from '../utils/userChatOverrides';

/* eslint-disable @typescript-eslint/no-explicit-any */
// 7TV cosmetics have complex dynamic structures that vary by API version
// Using 'any' is pragmatic here given the API complexity
type SevenTVPaintWithSelection = any;
type SevenTVBadgeWithSelection = any;

// EmoteSegment type definition (migrated from emoteParser.ts)
interface EmoteSegment {
  type: 'text' | 'emote' | 'emoji' | 'cheermote';
  content: string;
  emoteId?: string;
  emoteUrl?: string;
  emojiUrl?: string;
  // Cheermote-specific properties
  cheermoteUrl?: string;
  prefix?: string;
  bits?: number;
  tier?: string;
  color?: string;
  isZeroWidth?: boolean;
}

// Global cache for channel names and profile images to prevent re-fetching and flashing
const channelNameCache = new Map<string, string>();
const channelProfileImageCache = new Map<string, string>();

// Badge sets that are channel-specific (different images per channel)
// These are NOT cached locally to avoid cross-channel pollution
const CHANNEL_SPECIFIC_BADGE_SETS = new Set([
  'subscriber', 'bits', 'sub-gifter', 'sub-gift-leader',
  'founder', 'hype-train', 'predictions'
]);

/**
 * Get the best URL for a Twitch badge, with reactive caching.
 * - Channel-specific badges (subscriber, bits, etc.) are never cached to avoid cross-channel pollution
 * - Global badges are cached locally for faster loading
 */
function getTwitchBadgeUrl(badgeKey: string, badgeInfo: { localUrl?: string; url?: string; image_url_4x?: string; image_url_2x?: string; image_url_1x?: string }): string {
  // If already has a local URL, use it
  if (badgeInfo.localUrl) {
    return badgeInfo.localUrl;
  }

  // Extract set ID from badge key (format: "set/version")
  const setId = badgeKey.split('/')[0];
  
  // Channel-specific badges are never cached - always use remote URL
  // This prevents cross-channel pollution where one streamer's sub badge appears in another's chat
  if (CHANNEL_SPECIFIC_BADGE_SETS.has(setId)) {
    return badgeInfo.image_url_4x || badgeInfo.image_url_1x || '';
  }

  // Global badges can be cached safely
  const cacheId = `twitch-${badgeKey}`;
  
  // Check if we have a cached version
  const cachedUrl = getCachedBadgeUrl(cacheId);
  if (cachedUrl) {
    return cachedUrl;
  }

  // Not cached - queue for caching and return remote 4x URL
  const remoteUrl = badgeInfo.image_url_4x;
  if (remoteUrl) {
    queueBadgeForCaching(cacheId, remoteUrl);
  }

  return remoteUrl || badgeInfo.image_url_1x || '';
}

import { BackendChatMessage } from '../services/twitchChat';

import { Logger } from '../utils/logger';
interface ChatMessageProps {
  message: string | BackendChatMessage; // Raw IRC message or Backend Message Object
  messageIndex?: number; // For alternating backgrounds
  onUsernameClick?: (
    userId: string,
    username: string,
    displayName: string,
    color: string,
    badges: Array<{ key: string; info: { url?: string; image_url_4x?: string } }>,

    event: React.MouseEvent
  ) => void;
  onReplyClick?: (parentMsgId: string) => void;
  isHighlighted?: boolean;
  moderationContext?: { type: 'timeout' | 'ban' | 'deleted'; duration?: number } | null; // Moderation context from CLEARMSG/CLEARCHAT
  onEmoteRightClick?: (emoteName: string) => void;
  onMessageCopy?: (content: string) => void;
  onUsernameRightClick?: (messageId: string, username: string) => void;
  onBadgeClick?: (badgeKey: string, badgeInfo: { url?: string; image_url_4x?: string }) => void;
  emotes?: EmoteSet | null;
  isModerator?: boolean;
  broadcasterId?: string;
}

/**
 * Component for rendering @mentions with user's 7TV paint styling
 */
const MentionSpan: React.FC<{
  username: string;
  onUsernameClick?: ChatMessageProps['onUsernameClick'];
}> = ({ username, onUsernameClick }) => {
  // Subscribe to the specific user from the store (reactive updates)
  const cachedUser = useChatUserStore((state) => state.getUserByUsername(username));
  
  // Local state for users not in chat store (fallback API lookup)
  const [apiUserPaint, setApiUserPaint] = useState<SevenTVPaintWithSelection | null>(null);
  
  // If user is in chat store, use their data directly
  const userColor = cachedUser?.color || '#9147FF';
  const userPaint = cachedUser?.paint || apiUserPaint;
  const paintShadowMode = useAppStore((s) => s.settings.cosmetics?.paint_shadows) ?? 'all';
  
  // Only do API lookup if user is NOT in the chat store
  useEffect(() => {
    if (cachedUser) return; // Already have data from store
    
    let isMounted = true;
    
    // Try to look up via API and get cosmetics
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<{ id: string; login: string; display_name: string }>('get_user_by_login', { login: username })
        .then((user) => {
          if (!isMounted) return;
          if (user) {
            // Try to get cosmetics for this user (includes paint)
            getCosmeticsWithFallback(user.id).then((cosmetics) => {
              if (!isMounted) return;
              if (cosmetics) {
                const selectedPaint = cosmetics.paints?.find((p: SevenTVPaintWithSelection) => p.selected);
                if (selectedPaint) {
                  setApiUserPaint(selectedPaint);
                }
              }
            }).catch(() => {});
          }
        })
        .catch(() => {});
    });
    
    return () => {
      isMounted = false;
    };
  }, [username, cachedUser]);
  
  // Compute paint style - use user's Twitch color as fallback (not accent).
  // When the user has turned off paint-on-mentions globally, fall back to the
  // flat color even if the user has a paint set.
  const paintMentionsInBody = useAppStore((s) => s.settings.chat_design?.paint_mentions_in_body) ?? true;
  const nameStyle = useMemo(() => {
    if (userPaint && paintMentionsInBody) {
      return computePaintStyle(userPaint, userColor, paintShadowMode);
    }
    // Use user's Twitch chat color as fallback
    return { color: userColor };
  }, [userPaint, userColor, paintShadowMode, paintMentionsInBody]);
  
  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onUsernameClick) return;
    
    // Use cached user data if available
    if (cachedUser) {
      onUsernameClick(
        cachedUser.userId,
        cachedUser.username,
        cachedUser.displayName,
        cachedUser.color,
        [],
        e
      );
      return;
    }
    
    // Fallback to API lookup
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const user = await invoke<{ id: string; login: string; display_name: string }>('get_user_by_login', { login: username });
      if (user) {
        onUsernameClick(
          user.id,
          user.login,
          user.display_name,
          userColor,
          [],
          e
        );
      }
    } catch (err) {
      Logger.warn('[MentionSpan] Could not look up mentioned user:', err);
    }
  };
  
  return (
    <Tooltip content={`View ${username}'s profile`} side="top">
      <span
        className="inline-flex items-center px-1.5 py-0.5 rounded bg-accent/15 font-medium cursor-pointer hover:bg-accent/25 transition-colors"
        style={nameStyle}
        onClick={handleClick}
      >
        @{username}
      </span>
    </Tooltip>
  );
};

// Custom comparison function for React.memo
// Only re-render if the message content or highlight state actually changes
const chatMessageAreEqual = (prevProps: ChatMessageProps, nextProps: ChatMessageProps): boolean => {
  // Only re-render if these props actually changed
  if (prevProps.message !== nextProps.message) {
    // If objects, compare IDs
    if (typeof prevProps.message !== 'string' && typeof nextProps.message !== 'string') {
      if (prevProps.message.id !== nextProps.message.id) return false;
    } else {
      return false;
    }
  }
  if (prevProps.messageIndex !== nextProps.messageIndex) return false;
  if (prevProps.isHighlighted !== nextProps.isHighlighted) return false;
  if (prevProps.moderationContext?.type !== nextProps.moderationContext?.type ||
      prevProps.moderationContext?.duration !== nextProps.moderationContext?.duration) return false;

  // All other props (callbacks) can be ignored for re-render decisions
  // since they don't affect the visual output of the message
  return true;
};

// Stable empty reference for the third-party badge read below, so the zustand
// selector returns the same array identity for every non-member chatter (a
// fresh [] each render would re-render every row on any store change).
const EMPTY_THIRD_PARTY: ThirdPartyBadgeType[] = [];

// Memoized ChatMessage component to prevent unnecessary re-renders
// This is critical for preventing animation restarts when new messages arrive
const ChatMessage = memo(function ChatMessageInner({ message, messageIndex = 0, onUsernameClick, onReplyClick, isHighlighted = false, moderationContext = null, onEmoteRightClick, onMessageCopy, onUsernameRightClick, onBadgeClick, emotes, isModerator = false, broadcasterId }: ChatMessageProps) {
  // Field selectors, NOT a whole-store subscription. This component is mounted
  // once per chat row, so subscribing to the entire store made every row
  // re-render on every unrelated store tick (hours-watched, viewer count, etc.).
  // On a high-traffic channel that render storm pegs the main thread and freezes
  // the video. Selecting only what we read means a row re-renders only when its
  // own inputs change.
  const settings = useAppStore((s) => s.settings);
  const currentUser = useAppStore((s) => s.currentUser);
  const currentStream = useAppStore((s) => s.currentStream);
  const chatDesign = settings.chat_design;
  // Re-render this row when the StreamNook registry updates (async load / new signup)
  useSyncExternalStore(subscribeStreamNookRegistryVersion, getStreamNookRegistryVersion, getStreamNookRegistryVersion);
  const parsed = useMemo(() => {
    // Extract channel ID from the message tags if available
    // For shared chat messages, use source-room-id instead of room-id for badge lookup
    let sourceRoomId: string | undefined;
    let roomId: string | undefined;

    if (typeof message === 'string') {
      const sourceRoomIdMatch = message.match(/source-room-id=([^;]+)/);
      const roomIdMatch = message.match(/room-id=([^;]+)/);
      sourceRoomId = sourceRoomIdMatch ? sourceRoomIdMatch[1] : undefined;
      roomId = roomIdMatch ? roomIdMatch[1] : undefined;
    } else {
      // Backend message object - extract room-id from tags
      sourceRoomId = message.tags?.['source-room-id'];
      roomId = message.tags?.['room-id'];
    }

    // Prefer source-room-id for shared chat messages, fall back to room-id
    const channelId = sourceRoomId || roomId;

    return parseMessage(message, channelId);
  }, [message]);

  const isAction = parsed.isAction || false;

  // PHASE 3.1 - THE ENDGAME: Use pre-formatted timestamps from Rust
  // Zero Date parsing on main thread!
  // IMPORTANT: This useMemo MUST be at the top before any conditional returns
  const formattedTimestamp = useMemo(() => {
    if (!chatDesign?.show_timestamps) return null;

    // Use pre-computed timestamps from Rust metadata
    if (parsed.metadata) {
      return chatDesign?.show_timestamp_seconds
        ? parsed.metadata.formatted_timestamp_with_seconds
        : parsed.metadata.formatted_timestamp;
    }

    // Fallback: compute locally if metadata not available (legacy messages)
    const tmiSentTs = parsed.tags.get('tmi-sent-ts');
    if (!tmiSentTs) return null;

    try {
      const date = new Date(parseInt(tmiSentTs, 10));
      const options: Intl.DateTimeFormatOptions = {
        hour: 'numeric',
        minute: '2-digit',
      };
      if (chatDesign?.show_timestamp_seconds) {
        options.second = '2-digit';
      }
      return date.toLocaleTimeString(navigator.language || undefined, options);
    } catch {
      return null;
    }
  }, [chatDesign?.show_timestamps, chatDesign?.show_timestamp_seconds, parsed.metadata, parsed.tags]);

  // Computed in-render via useMemo rather than via useEffect+useState — the
  // previous useEffect pattern meant the FIRST render of a new message
  // committed with an empty content array; only the second render (after
  // useEffect fired) painted the actual text. In a fast burst that gap is
  // visible: the screen flashes a wall of usernames with no message bodies,
  // then the bodies pop in. Computing in-render closes the gap entirely —
  // first render contains the real content.
  const contentWithEmotes = useMemo<EmoteSegment[]>(() => {
    // Pre-parsed segments from Rust (the primary path)
    if (parsed.segments && parsed.segments.length > 0) {
      return parsed.segments.map((seg): EmoteSegment => {
        if (seg.type === 'emote') {
          return {
            type: 'emote' as const,
            content: seg.content,
            emoteId: seg.emote_id,
            emoteUrl: seg.emote_url,
            isZeroWidth: seg.is_zero_width,
          };
        } else if (seg.type === 'emoji') {
          return {
            type: 'emoji' as const,
            content: seg.content,
            emojiUrl: seg.emoji_url,
          };
        } else if (seg.type === 'link') {
          // Links are handled in parseTextWithLinks
          return {
            type: 'text' as const,
            content: seg.content,
          };
        } else if (seg.type === 'cheermote') {
          // Cheermote segment with animated GIF and bits amount
          return {
            type: 'cheermote' as const,
            content: seg.content,
            cheermoteUrl: seg.cheermote_url,
            prefix: seg.prefix,
            bits: seg.bits,
            tier: seg.tier,
            color: seg.color,
          };
        } else {
          return {
            type: 'text' as const,
            content: seg.content,
          };
        }
      });
    }

    // Fallback for local messages (no segments from Rust yet): parse text
    // using the provided emotes prop.
    if (emotes) {
      const words = parsed.content.split(' ');
      const newSegments: EmoteSegment[] = [];

      words.forEach((word, i) => {
        const emote = emotes['7tv'].find((e: Emote) => e.name === word) ||
                      emotes.bttv.find((e: Emote) => e.name === word) ||
                      emotes.ffz.find((e: Emote) => e.name === word) ||
                      emotes.twitch.find((e: Emote) => e.name === word);

        if (i > 0) newSegments.push({ type: 'text', content: ' ' });

        if (emote) {
          newSegments.push({
            type: 'emote',
            content: emote.name,
            emoteId: emote.id,
            emoteUrl: emote.url,
            isZeroWidth: emote.isZeroWidth || (emote as any).is_zero_width,
          });
        } else {
          // Parse the word for emojis for iOS-style emoji on optimistic msgs
          const emojiParsed = parseEmojisSync(word);
          emojiParsed.forEach(seg => {
            if (seg.type === 'emoji' && seg.emojiUrl) {
              newSegments.push({
                type: 'emoji' as const,
                content: seg.content,
                emojiUrl: seg.emojiUrl,
              });
            } else {
              newSegments.push({ type: 'text', content: seg.content });
            }
          });
        }
      });

      // Coalesce adjacent text segments
      const coalesced: EmoteSegment[] = [];
      newSegments.forEach(seg => {
        if (coalesced.length > 0 && coalesced[coalesced.length - 1].type === 'text' && seg.type === 'text') {
          coalesced[coalesced.length - 1].content += seg.content;
        } else {
          coalesced.push(seg);
        }
      });
      return coalesced;
    }

    // No segments and no emotes loaded - parse for emojis at minimum
    const emojiParsed = parseEmojisSync(parsed.content);
    return emojiParsed.map((seg): EmoteSegment => {
      if (seg.type === 'emoji' && seg.emojiUrl) {
        return {
          type: 'emoji' as const,
          content: seg.content,
          emojiUrl: seg.emojiUrl,
        };
      }
      return { type: 'text' as const, content: seg.content };
    });
  }, [parsed.segments, parsed.content, emotes]);

  // Extract userId once to prevent re-renders
  const userId = useMemo(() => parsed.tags.get('user-id'), [parsed.tags]);

  // Per-user nickname/color overrides. The original display name + username
  // stay in the click payload (so the profile card still opens to the real
  // person) and in the IRC mention insertion path (Twitch only resolves real
  // @logins, never nicknames). Render path swaps in the nickname.
  const userOverrides = settings.chat_customization?.user_overrides;
  const originalDisplayName = useMemo(
    () => parsed.tags.get('display-name') || parsed.username,
    [parsed.tags, parsed.username],
  );
  const effectiveDisplayName = useMemo(
    () => getDisplayedName(userId, originalDisplayName, userOverrides),
    [userId, originalDisplayName, userOverrides],
  );
  // Color override layers under the user's 7TV paint when one is selected
  // (the paint computes against this base color), or replaces parsed.color
  // outright when no paint is in play.
  const effectiveColor = useMemo(
    () => getColorOverride(userId, userOverrides) ?? parsed.color,
    [userId, userOverrides, parsed.color],
  );

  // Paint + 7TV badge are now derived from chatUserStore: ChatWidget's addUser
  // fires the cosmetics fetch once per user and stores the selected paint+badge.
  // Subscribing here means a 100-message scrollback renders 0 paint-fetches +
  // 0 paint-derivations per message — the store holds one resolved entry per
  // unique chatter and every message just reads from it.
  const seventvPaint = useChatUserStore(
    (s) => (userId ? s.users.get(userId)?.paint : undefined),
  ) as SevenTVPaintWithSelection | null | undefined;
  const seventvBadge = useChatUserStore(
    (s) => (userId ? s.users.get(userId)?.seventvBadge : undefined),
  ) as SevenTVBadgeWithSelection | null | undefined;
  // A StreamNook member's curated third-party badges (BTTV / FFZ / Chatterino /
  // Homies / Chatsen / Chatty / DankChat). Read synchronously from chatUserStore,
  // where ChatWidget's addUser resolves them ONCE per unique member via the
  // Identity API — never a network call in this per-message hot path (the cause
  // of the earlier lag/paint-starvation). Empty for non-members and for members
  // who haven't opted any badge into their loadout.
  const thirdPartyBadges = useChatUserStore((s) =>
    userId ? s.users.get(userId)?.thirdPartyBadges ?? EMPTY_THIRD_PARTY : EMPTY_THIRD_PARTY,
  );
  // The member's StreamNook Atmosphere (if any) -> the SAME animated wash as
  // their profile backdrop, rendered behind their message.
  const atmosphereId = useChatUserStore((s) => (userId ? s.users.get(userId)?.atmosphereId ?? null : null));
  const atmosphere = atmosphereId ? getAtmosphere(atmosphereId) : null;
  const [broadcasterType] = useState<string | null>(null);
  const [isMentioned, setIsMentioned] = useState(false);
  const [isReplyToMe, setIsReplyToMe] = useState(false);
  const highlightPhrases = settings.chat_highlights?.phrases;
  const highlightUsers = settings.chat_highlights?.users;
  const highlightBadges = settings.chat_highlights?.badges;

  // PHASE 3.1d - OPTIMIZED: Check if this message mentions the current user or is a reply to them
  // NO REGEX - simple case-insensitive string check is much faster
  useEffect(() => {
    if (!currentUser) return;

    // Optimized: Use case-insensitive indexOf instead of RegExp creation
    // This avoids creating a new RegExp object for every message
    const mentionTarget = `@${currentUser.username.toLowerCase()}`;
    const contentLower = parsed.content.toLowerCase();
    const mentionIndex = contentLower.indexOf(mentionTarget);

    // Check for word boundary after mention (space, punctuation, or end of string)
    let mentioned = false;
    if (mentionIndex !== -1) {
      const afterIndex = mentionIndex + mentionTarget.length;
      if (afterIndex >= contentLower.length) {
        // Mention at end of string
        mentioned = true;
      } else {
        const charAfter = contentLower[afterIndex];
        // Word boundary: space, punctuation, or non-alphanumeric
        mentioned = /[\s.,!?:;'")\]}>]/.test(charAfter) || !/[a-z0-9_]/.test(charAfter);
      }
    }
    setIsMentioned(mentioned);

    // Check if this is a reply to the current user
    const replyUserId = parsed.replyInfo?.parentUserId;
    const isReply = replyUserId === currentUser.user_id;
    setIsReplyToMe(isReply);
  }, [parsed.content, parsed.replyInfo, currentUser]);

  // User-defined highlight phrases. Computed synchronously so sound playback
  // (which fires in a separate effect below) sees the same value as the
  // initial render — avoiding a race where isMentioned hasn't settled yet.
  // Pre-checks for own-mention / reply-to-me happen inline so this useMemo
  // doesn't have to wait for the async useState effect that fills those flags.
  const phraseMatch = useMemo<HighlightMatch | null>(() => {
    // Mention/reply animations win over highlight matches; suppress here so
    // sound effects and animation don't double-fire.
    const mentionTarget = currentUser ? `@${currentUser.username.toLowerCase()}` : null;
    const isOwnMention = mentionTarget ? parsed.content.toLowerCase().includes(mentionTarget) : false;
    const isReplyToMe = !!currentUser && parsed.replyInfo?.parentUserId === currentUser.user_id;
    if (isOwnMention || isReplyToMe) return null;

    // Try phrase, then user, then badge highlights. First non-null wins.
    const phraseHit = matchHighlightPhrase(parsed.content, highlightPhrases);
    if (phraseHit) return phraseHit;

    const senderLogin = parsed.tags.get('display-name')?.toLowerCase() || parsed.tags.get('login') || null;
    const userHit = matchHighlightUser(senderLogin, highlightUsers);
    if (userHit) return userHit;

    // Build badge-key list from the message's IRC badges tag (format
    // "name1/v1,name2/v2"). Empty/missing tag → no badge match.
    const badgesRaw = parsed.tags.get('badges');
    const badgeKeys = badgesRaw ? badgesRaw.split(',').filter(Boolean) : null;
    const badgeHit = matchHighlightBadge(badgeKeys, highlightBadges);
    if (badgeHit) return badgeHit;

    return null;
  }, [parsed.content, parsed.replyInfo, parsed.tags, currentUser, highlightPhrases, highlightUsers, highlightBadges]);

  // Fire the phrase's sound on first render if one is configured. Cooldown +
  // backfill guard (see notificationSound.ts) make this safe to call on every
  // matched message — historical replays don't trigger, and fast-repeating
  // matches are throttled per phrase.
  useEffect(() => {
    if (!phraseMatch?.sound_id) return;
    const sentTsRaw = parsed.tags.get('tmi-sent-ts');
    const sentTs = sentTsRaw ? parseInt(sentTsRaw, 10) : NaN;
    playSoundThrottled({
      key: phraseMatch.phrase_id,
      soundId: phraseMatch.sound_id,
      cooldownMs: phraseMatch.cooldown_ms,
      sentAtMs: Number.isFinite(sentTs) ? sentTs : null,
    });
    // Only fire once per mount per match — phraseMatch is memoized so this
    // effect only re-runs when the message itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phraseMatch]);

  // Window-title flash. Fires on any highlight match (phrase/user/badge) when
  // the user has opted in globally AND the window is currently blurred.
  // Backfill-safe: skip messages older than 5s so loading history doesn't
  // trigger a flash storm. Mention/reply path doesn't go through phraseMatch,
  // so this only covers the highlight cases (mentions get their own animation
  // and don't need title flash to attract attention).
  useEffect(() => {
    if (!phraseMatch) return;
    if (!settings?.chat_highlights?.appearance?.flash_title_when_unfocused) return;
    const sentTsRaw = parsed.tags.get('tmi-sent-ts');
    const sentTs = sentTsRaw ? parseInt(sentTsRaw, 10) : NaN;
    if (Number.isFinite(sentTs) && Date.now() - sentTs > 5000) return;
    const who = parsed.tags.get('display-name') || parsed.tags.get('login') || 'chat';
    flashTitle(`${who}: highlight`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phraseMatch]);

  // All cosmetic resolution (paint, 7TV badge, third-party badges) lives in
  // chatUserStore.addUser. ChatMessage just subscribes via the selectors
  // above. No per-message useEffect / useState / fetch.

  // Reactive caching for 7TV cosmetics
  useEffect(() => {
    // Cache 7TV Badge - use id directly (BadgeV4 interface)
    if (seventvBadge?.id && !seventvBadge.localUrl) {
      const badgeUrl = getBadgeImageUrl(seventvBadge);
      if (badgeUrl && !badgeUrl.startsWith('asset') && !badgeUrl.includes('localhost')) {
        queueCosmeticForCaching(seventvBadge.id, badgeUrl);
      }
    }

    // Cache 7TV Paint Image Layers
    if (seventvPaint?.data?.layers) {
      seventvPaint.data.layers.forEach((layer: any) => {
        if (layer.ty.__typename === 'PaintLayerTypeImage' && layer.ty.images) {
          // Find the best image (scale 1 if available)
          const img = layer.ty.images.find((i: any) => i.scale === 1 && (layer.ty.images.some((x: any) => x.frameCount > 1) ? i.frameCount > 1 : true)) || layer.ty.images[0];

          if (img && !img.localUrl) {
            // Paints are cached by their layer ID
            queueCosmeticForCaching(layer.id, img.url);
          }
        }
      });
    }
  }, [seventvBadge, seventvPaint]);

  // Create username style with paint. effectiveColor is the override-aware
  // base color; the 7TV paint (if present) renders on top of it.
  const paintShadowMode = settings?.cosmetics?.paint_shadows ?? 'all';

  const usernameStyle = useMemo(() => {
    if (!seventvPaint) {
      return { color: effectiveColor };
    }

    // Use the new computePaintStyle function
    return computePaintStyle(seventvPaint, effectiveColor, paintShadowMode);
  }, [seventvPaint, effectiveColor, paintShadowMode]);

  // TEMP DIAGNOSTIC [selfpaint] — logs only for the current user's own messages.
  useEffect(() => {
    if (!currentUser?.user_id || userId !== currentUser.user_id) return;
    const entry = useChatUserStore.getState().users.get(userId);
    Logger.info('[selfpaint] render own', {
      userId,
      username: parsed.username,
      seventvPaintTruthy: !!seventvPaint,
      storePaintId: (entry?.paint as any)?.id ?? null,
      storeBadgeId: (entry?.seventvBadge as any)?.id ?? null,
      hasStoreEntry: !!entry,
      styleIsPaint: !!(usernameStyle as any)?.WebkitBackgroundClip,
    });
  }, [userId, currentUser?.user_id, seventvPaint, usernameStyle, parsed.username]);


  const renderSegment = (segment: EmoteSegment, key: string, inGrid: boolean, isOverlay: boolean = false) => {
    const gridStyle = inGrid ? { gridArea: '1/1' } : {};
    const marginClass = inGrid ? '' : 'mx-0.5';
    
    if (segment.type === 'emote') {
      const emoteUrl = segment.emoteUrl ||
        (segment.emoteId ? `https://static-cdn.jtvnw.net/emoticons/v2/${segment.emoteId}/default/dark/3.0` : '');

      if (emoteUrl && !emoteUrl.startsWith('asset://') && !emoteUrl.includes('asset.localhost') && segment.emoteId) {
        queueEmoteForCaching(segment.emoteId, emoteUrl);
      }

      // If it's an overlay (zero-width inside grid), it naturally sits on top and doesn't need negative margins
      // The grid "place-items-center" handles exact overlaying algorithmically!
      let srcSet: string | undefined = undefined;
      // Inject srcSet for 7TV emotes to support wide sizes natively at 2x, 3x, and 4x resolutions
      // Note: BTTV IDs are ALSO 24 hex characters, so we explicitly exclude betterttv
      if (segment.emoteId && (emoteUrl.includes('7tv') || segment.emoteId.length === 24 || segment.emoteId.length === 26)) {
        if (!emoteUrl.includes('jtvnw.net') && !emoteUrl.includes('frankerfacez') && !emoteUrl.includes('betterttv')) {
          srcSet = `https://cdn.7tv.app/emote/${segment.emoteId}/1x.avif 1x, https://cdn.7tv.app/emote/${segment.emoteId}/2x.avif 2x, https://cdn.7tv.app/emote/${segment.emoteId}/3x.avif 3x, https://cdn.7tv.app/emote/${segment.emoteId}/4x.avif 4x`;
        }
      }

      const imgElement = (
        <img
          src={emoteUrl}
          srcSet={srcSet}
          alt={segment.content}
          loading="lazy"
          className={`inline-block w-auto cursor-pointer ${inGrid ? '' : 'align-middle'} hover:scale-110 transition-transform ${isOverlay ? 'z-10 drop-shadow-[0_0_2px_rgba(0,0,0,0.5)] hover:drop-shadow-[0_0_4px_rgba(234,179,8,0.8)]' : ''}`}
          style={{
            ...gridStyle,
            height: 'calc(1.75rem * var(--sn-emote-scale, 1))',
            maxWidth: 'calc(128px * var(--sn-emote-scale, 1))',
            ...(inGrid ? {} : { marginLeft: 'var(--sn-emote-margin, 0.125rem)', marginRight: 'var(--sn-emote-margin, 0.125rem)' }),
          }}
          referrerPolicy="no-referrer"
          onContextMenu={(e) => {
            e.preventDefault();
            if (onEmoteRightClick) onEmoteRightClick(segment.content);
          }}
          onError={(e) => {
            e.currentTarget.style.display = 'none';
            e.currentTarget.insertAdjacentText('afterend', segment.content);
          }}
        />
      );

      // Big-preview tooltip mirroring the emote-picker's hover card. Compact
      // mode short-circuits to just the name (for users who find the
      // upscaled image distracting). The non-compact path now shows a 4x
      // preview, name, provider, optional Zero-Width chip, and the
      // "Right-click to copy" hint at the bottom so the copy affordance
      // still surfaces.
      const isCompactTooltip = !!settings?.chat_design?.compact_emote_tooltips;
      // Provider detection mirrors the srcSet logic a few lines up.
      const is7TVEmote = !!segment.emoteId && (
        emoteUrl.includes('7tv') ||
        ((segment.emoteId.length === 24 || segment.emoteId.length === 26) &&
          !emoteUrl.includes('jtvnw.net') &&
          !emoteUrl.includes('frankerfacez') &&
          !emoteUrl.includes('betterttv'))
      );
      const providerLabel =
        is7TVEmote || emoteUrl.includes('7tv') ? '7TV'
        : emoteUrl.includes('betterttv') ? 'BetterTTV'
        : emoteUrl.includes('frankerfacez') ? 'FrankerFaceZ'
        : emoteUrl.includes('jtvnw.net') ? 'Twitch'
        : 'Emote';
      const previewUrl = is7TVEmote && segment.emoteId
        ? `https://cdn.7tv.app/emote/${segment.emoteId}/4x.avif`
        : emoteUrl;
      const tooltipContent: React.ReactNode | string = isCompactTooltip
        ? segment.content
        : (
          <div className="flex flex-col items-center gap-1.5 py-0.5">
            <img
              src={previewUrl}
              alt={segment.content}
              className="h-16 w-auto max-w-[96px] object-contain mx-auto drop-shadow-md"
              referrerPolicy="no-referrer"
              onError={(e) => {
                // 7TV fallback chain: 4x avif → 2x → 1x. Matches the
                // picker's EmoteGridItem tooltip behavior.
                if (is7TVEmote && segment.emoteId) {
                  const t = e.currentTarget;
                  if (t.src.includes('/4x.avif')) {
                    t.src = `https://cdn.7tv.app/emote/${segment.emoteId}/2x.avif`;
                  } else if (t.src.includes('/2x.avif')) {
                    t.src = `https://cdn.7tv.app/emote/${segment.emoteId}/1x.avif`;
                  }
                }
              }}
            />
            <div className="text-center flex flex-col items-center gap-0.5">
              <span className="font-bold text-[13px] leading-tight">{segment.content}</span>
              <span className="text-[10px] text-white/60 leading-tight">{providerLabel}</span>
              {segment.isZeroWidth && (
                <span className="text-[9px] font-bold tracking-wider uppercase text-yellow-400 mt-0.5 mix-blend-screen drop-shadow-sm">
                  Zero-Width
                </span>
              )}
              <span className="text-[10px] text-white/50 mt-0.5">Right-click to copy</span>
            </div>
          </div>
        );
      return (
        <Tooltip key={key} content={tooltipContent} side="top">
          {isOverlay && !inGrid ? (
            // Fallback for standalone zero-width emote (e.g., at the start of a message)
            <span className="inline-block w-0 align-middle pointer-events-none" style={gridStyle}>
              <span className="pointer-events-auto -translate-x-full">
                {imgElement}
              </span>
            </span>
          ) : (
            imgElement
          )}
        </Tooltip>
      );
    }

    if (segment.type === 'emoji' && segment.emojiUrl) {
      const emojiSrc = getCachedEmojiUrl(segment.content, segment.emojiUrl);
      return (
        <Tooltip key={key} content={segment.content} side="top">
          <img
            src={emojiSrc}
            alt={segment.content}
            loading="lazy"
            className={`inline h-5 w-5 ${inGrid ? '' : 'align-middle'} ${marginClass}`}
            style={gridStyle}
            onError={(e) => {
              const t = e.currentTarget;
              // emoji-datasource-apple names some older text-default symbols
              // (clock, dove, heart, umbrella, etc.) WITH the -fe0f variation
              // selector in the filename, which our codepoint strips. Retry
              // once with it appended before giving up, so the real image loads
              // instead of leaving a blank.
              if (!t.dataset.fe0f && t.src.endsWith('.png') && !t.src.includes('-fe0f')) {
                t.dataset.fe0f = '1';
                t.src = t.src.replace(/\.png$/, '-fe0f.png');
                return;
              }
              // Truly unavailable: hide the broken image and drop in the native
              // emoji glyph so the slot is never blank.
              t.style.display = 'none';
              if (t.nextSibling?.textContent !== segment.content) {
                t.insertAdjacentText('afterend', segment.content);
              }
            }}
          />
        </Tooltip>
      );
    }

    if (segment.type === 'cheermote') {
      const bits = segment.bits ?? 0;
      return (
        <Tooltip key={key} content={`${bits.toLocaleString()} bits`} side="top">
          <span className={`inline-flex items-center gap-0.5 ${inGrid ? '' : 'align-middle'} ${marginClass}`} style={gridStyle}>
            <img
              src={segment.cheermoteUrl}
              alt={segment.content}
              loading="lazy"
              className="inline-block h-7 w-auto align-middle"
              referrerPolicy="no-referrer"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
                e.currentTarget.insertAdjacentText('afterend', segment.content);
              }}
            />
            <span className="font-bold text-sm" style={{ color: segment.color ?? '#979797' }}>
              {bits}
            </span>
          </span>
        </Tooltip>
      );
    }

    return (
      <span key={key} style={gridStyle} className={inGrid ? '' : 'align-middle'}>
        {parseTextWithLinks(segment.content)}
      </span>
    );
  };

  const renderContent = (segments: EmoteSegment[]) => {
    // Phase 1: Group zero-width emotes with their preceding visual elements
    const groupedSegments: (EmoteSegment | EmoteSegment[])[] = [];

    segments.forEach((segment) => {
      if (segment.type === 'emote' && segment.isZeroWidth) {
        if (groupedSegments.length > 0) {
          const last = groupedSegments[groupedSegments.length - 1];
          // If the last item is already a group, push into it
          if (Array.isArray(last)) {
            last.push(segment);
          } else if (last.type === 'text' && last.content.trim() === '') {
            // Twitch chat often puts spaces between typed emotes
            // If the last segment is just a space, check what's before the space
            if (groupedSegments.length > 1) {
              const beforeSpace = groupedSegments[groupedSegments.length - 2];
              if (Array.isArray(beforeSpace)) {
                beforeSpace.push(segment);
                groupedSegments.pop(); // Remove the space!
              } else if (beforeSpace.type === 'emote' || beforeSpace.type === 'emoji') {
                groupedSegments[groupedSegments.length - 2] = [beforeSpace, segment];
                groupedSegments.pop(); // Remove the space!
              } else {
                groupedSegments.push([segment]);
              }
            } else {
              groupedSegments.push([segment]);
            }
          } else if (last.type === 'emote' || last.type === 'emoji') {
            groupedSegments[groupedSegments.length - 1] = [last, segment];
          } else {
            groupedSegments.push([segment]);
          }
        } else {
          // Zero-width emote at the very start of the message
          groupedSegments.push([segment]);
        }
      } else {
        groupedSegments.push(segment);
      }
    });

    // Phase 2: Render groups
    return groupedSegments.map((group, index) => {
      if (Array.isArray(group)) {
        // Render stacked standard in an inline-grid
        return (
          <span key={`group-${index}`} className="inline-grid items-center justify-items-center align-middle mx-0.5">
            {group.map((seg, innerIndex) => renderSegment(seg, `${index}-${innerIndex}`, true, innerIndex > 0))}
          </span>
        );
      }
      return renderSegment(group, index.toString(), false, false);
    });
  };

  // Helper function to detect URLs and @mentions, making them styled and clickable
  const parseTextWithLinks = (text: string) => {
    // Combined regex: URLs and @mentions
    // @mentions: @username (alphanumeric + underscores, 1-25 chars per Twitch rules)
    const combinedRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|@[a-zA-Z0-9_]{1,25})(?=\s|$|[.,!?:;'")\]}>-])/g;
    const parts = text.split(combinedRegex);

    return parts.map((part, index) => {
      // Check if this part is a URL
      if (part.match(/^(https?:\/\/|www\.)/)) {
        const url = part.startsWith('http') ? part : `https://${part}`;

        return (
          <a
            key={index}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 underline cursor-pointer"
            onClick={async (e) => {
              e.preventDefault();
              try {
                // Use Tauri's shell plugin to open URL in default browser
                const { open } = await import('@tauri-apps/plugin-shell');
                await open(url);
              } catch (err) {
                Logger.error('[ChatMessage] Failed to open URL:', err);
              }
            }}
          >
            {part}
          </a>
        );
      }
      
      // Check if this part is an @mention
      if (part.match(/^@[a-zA-Z0-9_]{1,25}$/)) {
        const mentionedUsername = part.slice(1); // Remove @
        
        return (
          <MentionSpan
            key={index}
            username={mentionedUsername}
            onUsernameClick={onUsernameClick}
          />
        );
      }
      
      return part;
    });
  };

  // Check if this is a subscription message
  // Note: 'sharedchatnotice' is used for shared subscription events across channels
  const msgId = parsed.tags.get('msg-id');
  const sourceMsgId = parsed.tags.get('source-msg-id');
  const isSubscription = msgId === 'sub' ||
    msgId === 'resub' ||
    msgId === 'subgift' ||
    msgId === 'submysterygift' ||
    msgId === 'sharedchatnotice' ||
    sourceMsgId === 'sub' ||
    sourceMsgId === 'resub' ||
    sourceMsgId === 'subgift' ||
    sourceMsgId === 'submysterygift';

  // Check if this is a charity donation message
  const isDonation = msgId === 'charitydonation' || sourceMsgId === 'charitydonation';

  // Check if this is a viewer milestone (watch streak) message
  const isViewerMilestone = msgId === 'viewermilestone' || sourceMsgId === 'viewermilestone';
  const milestoneCategory = parsed.tags.get('msg-param-category');
  const isWatchStreak = isViewerMilestone && milestoneCategory === 'watch-streak';

  // Check if this is a highlighted message (channel points redemption)
  const isHighlightedMessage = msgId === 'highlighted-message' || sourceMsgId === 'highlighted-message';

  // Other chat-surfaced channel-points redemptions. They piggyback on the highlight
  // render path: same gradient background + a small label pill at the top right.
  // `custom-reward-id` is set on PRIVMSGs from custom rewards with "Skip the line for chat".
  // The named msg-id values cover the automatic message-style rewards.
  const customRewardId = parsed.tags.get('custom-reward-id');
  const hasCustomReward = !!customRewardId;
  const isGigantifiedEmote =
    msgId === 'gigantified-emote-message' || sourceMsgId === 'gigantified-emote-message';
  const isAnimatedMessage =
    msgId === 'animated-message' || sourceMsgId === 'animated-message';
  const isSubModeBypass =
    msgId === 'skip-subs-mode-message' || sourceMsgId === 'skip-subs-mode-message';
  const redemptionLabel: string | null = isHighlightedMessage
    ? 'Redeemed Highlight My Message'
    : isGigantifiedEmote
      ? 'Sent a Gigantified Emote'
      : isAnimatedMessage
        ? 'Sent an Animated Message'
        : isSubModeBypass
          ? 'Sent a Message in Sub-Only Mode'
          : hasCustomReward
            ? 'Redeemed a channel points reward'
            : null;
  const isRedemption = redemptionLabel !== null;

  // Check if this is a bits cheer message
  const bitsAmount = parsed.tags.get('bits');
  const isBitsCheer = bitsAmount && parseInt(bitsAmount, 10) > 0;

  // Check if this is a system message
  const isSystemMessage = parsed.username === 'System';

  // Get system message for subscriptions and donations
  const systemMessage = parsed.tags.get('system-msg')?.replace(/\\s/g, ' ');

  // Built-in event highlights (configurable per-event in Chat settings).
  // Defaults preserve prior behavior: first-time chatter ON (purple), all
  // others OFF. When ON, applies a tinted background + left border in the
  // configured color via the inline style stamp below.
  const builtInHighlights = settings?.chat_highlights?.built_in;
  const isFirstMessage = parsed.tags.get('first-msg') === '1';
  const isReturningChatter = parsed.tags.get('returning-chatter') === '1';
  const isOwnMessage = !!currentUser?.user_id && parsed.tags.get('user-id') === currentUser.user_id;
  const isRaidNotice = parsed.tags.get('msg-id') === 'raid';

  // Resolve which built-in event (if any) should drive the row's tint. Order
  // is intentional: raid > returning > first-time > self. Mention/reply flash
  // animations still win over all of these via the existing animationClass
  // cascade below.
  let builtInEventColor: string | null = null;
  let builtInEventLabel: string | null = null;
  if (isRaidNotice && (builtInHighlights?.raider?.enabled ?? false)) {
    builtInEventColor = builtInHighlights?.raider?.color ?? '#ef4444';
    builtInEventLabel = 'Raid';
  } else if (isReturningChatter && (builtInHighlights?.returning_chatter?.enabled ?? false)) {
    builtInEventColor = builtInHighlights?.returning_chatter?.color ?? '#22d3ee';
    builtInEventLabel = 'Returning chatter';
  } else if (isFirstMessage && (builtInHighlights?.first_time_chatter?.enabled ?? true)) {
    // Default ON for backwards compatibility — first-time chatter previously
    // had a hardcoded purple gradient. When the user re-colors it via the
    // settings panel, the new color flows through builtInEventColor.
    builtInEventColor = builtInHighlights?.first_time_chatter?.color ?? '#a855f7';
    builtInEventLabel = 'First message in chat';
  } else if (isOwnMessage && (builtInHighlights?.self_message?.enabled ?? false)) {
    builtInEventColor = builtInHighlights?.self_message?.color ?? '#facc15';
    builtInEventLabel = 'You';
  }

  // Extract source room info for shared chat (needed for all message types)
  const sourceRoomId = parsed.tags.get('source-room-id');
  const currentRoomId = parsed.tags.get('room-id');
  const isFromSharedChat = sourceRoomId && currentRoomId && sourceRoomId !== currentRoomId;

  // State to store the fetched channel name - initialize from cache if available
  // These hooks must be declared before any conditional returns
  const [fetchedChannelName, setFetchedChannelName] = useState<string | null>(() => {
    if (sourceRoomId && channelNameCache.has(sourceRoomId)) {
      return channelNameCache.get(sourceRoomId) || null;
    }
    return null;
  });

  // State to store the channel profile image
  const [channelProfileImage, setChannelProfileImage] = useState<string | null>(() => {
    if (sourceRoomId && channelProfileImageCache.has(sourceRoomId)) {
      return channelProfileImageCache.get(sourceRoomId) || null;
    }
    return null;
  });

  // Fetch source channel name and profile image if this is a shared chat message (only once per sourceRoomId)
  useEffect(() => {
    if (!isFromSharedChat || !sourceRoomId) return;

    // Check if we already have it in cache
    if (channelNameCache.has(sourceRoomId)) {
      const cachedName = channelNameCache.get(sourceRoomId);
      if (cachedName && cachedName !== fetchedChannelName) {
        setFetchedChannelName(cachedName);
      }
    }

    if (channelProfileImageCache.has(sourceRoomId)) {
      const cachedImage = channelProfileImageCache.get(sourceRoomId);
      if (cachedImage && cachedImage !== channelProfileImage) {
        setChannelProfileImage(cachedImage);
      }
      return;
    }

    let isMounted = true;

    // Fetch the channel name and profile image
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<any>('get_user_by_id', { userId: sourceRoomId })
        .then((user) => {
          if (!isMounted) return;
          if (user && user.login) {
            // Store name in cache
            channelNameCache.set(sourceRoomId, user.login);
            setFetchedChannelName(user.login);

            // Store profile image in cache
            if (user.profile_image_url) {
              channelProfileImageCache.set(sourceRoomId, user.profile_image_url);
              setChannelProfileImage(user.profile_image_url);
            }
          }
        })
        .catch((err) => {
          Logger.warn('[ChatMessage] Failed to fetch source channel info:', err);
        });
    });

    return () => {
      isMounted = false;
    };
  }, [isFromSharedChat, sourceRoomId, fetchedChannelName, channelProfileImage]);

  // Handle bits cheers
  if (isBitsCheer) {
    // Generate a unique key based on message ID to prevent animation restarts
    const messageId = parsed.tags.get('id') || `bits-${parsed.username}-${Date.now()}`;
    const bitsCount = parseInt(bitsAmount!, 10);

    // Format bits count with commas for readability
    const formattedBits = bitsCount.toLocaleString();

    // Determine bits tier color based on amount (matching Twitch's color scheme)
    const getBitsTierColor = (bits: number): string => {
      if (bits >= 10000) return '#ff1f1f'; // Red
      if (bits >= 5000) return '#0099fe'; // Blue
      if (bits >= 1000) return '#1db2a6'; // Teal
      if (bits >= 100) return '#9c3ee8'; // Purple
      return '#979797'; // Gray (1-99)
    };

    const bitsTierColor = getBitsTierColor(bitsCount);

    // Helper function to render username as clickable. Render path uses the
    // effective display name (so nicknames apply); the click payload keeps
    // the real display name so the profile card opens to the true identity.
    const renderClickableUsername = (username: string, displayName?: string) => {
      const userIdForClick = userId;
      return (
        <Tooltip content="Click to view profile" side="top">
          <span
            className="font-bold cursor-pointer hover:underline"
            style={usernameStyle}
            onClick={(e) => {
              if (userIdForClick && onUsernameClick) {
                onUsernameClick(
                  userIdForClick,
                  username,
                  displayName || username,
                  parsed.color,
                  parsed.badges,
                  e
                );
              }
            }}
          >
            {effectiveDisplayName || displayName || username}
          </span>
        </Tooltip>
      );
    };

    // Helper function to render badges
    const renderBadges = () => {
      const senderUserId = parsed.tags.get('user-id');
      const isSN = isStreamNookUser(senderUserId);
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        const w = window as any;
        if (!w.__snChatDebug) w.__snChatDebug = { totalCalls: 0, uniqueSenders: [], snHits: [], last10: [] };
        w.__snChatDebug.totalCalls++;
        w.__snChatDebug.last10.push({ senderUserId, isSN, displayName: parsed.tags.get('display-name') });
        if (w.__snChatDebug.last10.length > 10) w.__snChatDebug.last10.shift();
        if (!w.__snChatDebug.uniqueSenders.some((s: any) => s.senderUserId === senderUserId)) {
          w.__snChatDebug.uniqueSenders.push({
            senderUserId,
            isSN,
            displayName: parsed.tags.get('display-name'),
          });
        }
        if (isSN) {
          w.__snChatDebug.snHits.push({
            senderUserId,
            displayName: parsed.tags.get('display-name'),
            at: new Date().toISOString(),
          });
        }
      }

      if (parsed.badges.length === 0 && !seventvBadge && thirdPartyBadges.length === 0 && !isSN) return null;

      return (
        <span className="inline-flex items-center gap-1 mr-1">
          {parsed.badges.map((badge, idx) => {
            // Handle both old format (key/info) and new format (name/version)
            if (!badge.info) return null;
            return (
              <Tooltip key={`bits-badge-${badge.key}-${idx}`} content={badge.info.title} side="top">
                <img
                  src={getTwitchBadgeUrl(badge.key, badge.info)}
                  alt={badge.info.title}
                  loading="lazy"
                  className="w-5 h-5 inline-block cursor-pointer hover:scale-110 transition-transform"
                  onClick={() => onBadgeClick?.(badge.key, badge.info)}
                  onError={(e) => {
                    Logger.warn('[Badge] Failed to load badge:', badge.key, badge.info.image_url_1x);
                    e.currentTarget.style.display = 'none';
                  }}
                />
              </Tooltip>
            );
          })}
          {seventvBadge && (
            <Tooltip content={`Click for details: ${seventvBadge.description || seventvBadge.name}`} side="top">
              <button
                onClick={() => openBadgesWithBadgeInMain(seventvBadge.id)}
                className="inline-block cursor-pointer hover:scale-110 transition-transform"
              >
                <FallbackImage
                  src={getBadgeImageUrl(seventvBadge)}
                  fallbackUrls={getBadgeFallbackUrls(seventvBadge.id).slice(1)}
                  alt={seventvBadge.description || seventvBadge.name}
                  className="w-5 h-5 inline-block"
                />
              </button>
            </Tooltip>
          )}
          {thirdPartyBadges.filter(badge => badge && badge.imageUrl).map((badge, idx) => (
            <Tooltip key={`bits-tp-badge-${badge.id}-${idx}`} content={`${badge.title} (${badge.provider.toUpperCase()})`} side="top">
              <img
                src={badge.imageUrl}
                alt={badge.title}
                className="w-5 h-5 inline-block"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            </Tooltip>
          ))}
          {isSN && <StreamNookBadge userId={senderUserId} userNumber={getStreamNookUserNumber(senderUserId)} />}
        </span>
      );
    };

    // Use dynamic spacing from user settings
    const eventPadding = calculateHalfPadding(chatDesign?.message_spacing ?? 8);

    return (
      <div key={messageId} className="px-3 border-t border-borderSubtle bits-gradient" style={{ paddingTop: `${eventPadding}px`, paddingBottom: `${eventPadding}px` }}>
        <div className="flex items-center gap-2.5">
          <div className="flex-shrink-0">
            {/* Bits/gem icon */}
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill={bitsTierColor}>
              <path d="M10 2L3 10l7 8 7-8-7-8z" />
              <path d="M10 2L3 10h14L10 2z" opacity="0.7" />
              <path d="M10 18l7-8H3l7 8z" opacity="0.5" />
            </svg>
          </div>
          <div className="flex-1 min-w-0 flex items-center flex-wrap">
            <p className="text-white font-semibold text-sm leading-relaxed">
              {renderBadges()}
              {renderClickableUsername(parsed.username, parsed.tags.get('display-name') || parsed.username)}
              <span style={{ color: bitsTierColor }} className="font-bold"> cheered {formattedBits} bits</span>
            </p>
            {parsed.content && (
              <p className="text-textSecondary text-sm mt-1 leading-relaxed">
                {renderContent(contentWithEmotes)}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Handle charity donations
  if (isDonation) {
    // Generate a unique key based on message ID to prevent animation restarts
    const messageId = parsed.tags.get('id') || `donation-${parsed.username}-${Date.now()}`;

    // Get donation details
    const charityName = parsed.tags.get('msg-param-charity-name')?.replace(/\\s/g, ' ');
    const donationAmount = parsed.tags.get('msg-param-donation-amount');
    const donationCurrency = parsed.tags.get('msg-param-donation-currency') || 'USD';
    const exponent = parseInt(parsed.tags.get('msg-param-exponent') || '2', 10);

    // Calculate the actual donation amount (amount is in smallest currency unit)
    const actualAmount = donationAmount ? (parseInt(donationAmount, 10) / Math.pow(10, exponent)) : 0;

    // Format the amount with currency symbol
    const formattedAmount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: donationCurrency,
    }).format(actualAmount);

    // Check if this is a shared chat notice (from another channel)
    const isSharedChat = msgId === 'sharedchatnotice';
    const isFromDifferentChannel = isSharedChat && isFromSharedChat;

    // Helper function to render username as clickable. Render path uses the
    // effective display name (so nicknames apply); the click payload keeps
    // the real display name so the profile card opens to the true identity.
    const renderClickableUsername = (username: string, displayName?: string) => {
      const userIdForClick = userId;
      return (
        <Tooltip content="Click to view profile" side="top">
          <span
            className="font-bold cursor-pointer hover:underline"
            style={usernameStyle}
            onClick={(e) => {
              if (userIdForClick && onUsernameClick) {
                onUsernameClick(
                  userIdForClick,
                  username,
                  displayName || username,
                  parsed.color,
                  parsed.badges,
                  e
                );
              }
            }}
          >
            {effectiveDisplayName || displayName || username}
          </span>
        </Tooltip>
      );
    };

    // Helper function to render badges
    const renderBadges = () => {
      const senderUserId = parsed.tags.get('user-id');
      const isSN = isStreamNookUser(senderUserId);
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        const w = window as any;
        if (!w.__snChatDebug) w.__snChatDebug = { totalCalls: 0, uniqueSenders: [], snHits: [], last10: [] };
        w.__snChatDebug.totalCalls++;
        w.__snChatDebug.last10.push({ senderUserId, isSN, displayName: parsed.tags.get('display-name') });
        if (w.__snChatDebug.last10.length > 10) w.__snChatDebug.last10.shift();
        if (!w.__snChatDebug.uniqueSenders.some((s: any) => s.senderUserId === senderUserId)) {
          w.__snChatDebug.uniqueSenders.push({
            senderUserId,
            isSN,
            displayName: parsed.tags.get('display-name'),
          });
        }
        if (isSN) {
          w.__snChatDebug.snHits.push({
            senderUserId,
            displayName: parsed.tags.get('display-name'),
            at: new Date().toISOString(),
          });
        }
      }

      if (parsed.badges.length === 0 && !seventvBadge && thirdPartyBadges.length === 0 && !isSN) return null;

      return (
        <span className="inline-flex items-center gap-1 mr-1">
          {parsed.badges.map((badge, idx) => {
            if (!badge.info) return null;
            return (
              <Tooltip key={`donation-badge-${badge.key}-${idx}`} content={badge.info.title} side="top">
                <img
                  src={getTwitchBadgeUrl(badge.key, badge.info)}
                  alt={badge.info.title}
                  loading="lazy"
                  className="w-5 h-5 inline-block cursor-pointer hover:scale-110 transition-transform"
                  onClick={() => onBadgeClick?.(badge.key, badge.info)}
                  onError={(e) => {
                    Logger.warn('[Badge] Failed to load badge:', badge.key, badge.info.image_url_1x);
                    e.currentTarget.style.display = 'none';
                  }}
                />
              </Tooltip>
            );
          })}
          {seventvBadge && (
            <Tooltip content={`Click for details: ${seventvBadge.description || seventvBadge.name}`} side="top">
              <button
                onClick={() => openBadgesWithBadgeInMain(seventvBadge.id)}
                className="inline-block cursor-pointer hover:scale-110 transition-transform"
              >
                <FallbackImage
                  src={getBadgeImageUrl(seventvBadge)}
                  fallbackUrls={getBadgeFallbackUrls(seventvBadge.id).slice(1)}
                  alt={seventvBadge.description || seventvBadge.name}
                  className="w-5 h-5 inline-block"
                />
              </button>
            </Tooltip>
          )}
          {thirdPartyBadges.filter(badge => badge && badge.imageUrl).map((badge, idx) => (
            <Tooltip key={`donation-tp-badge-${badge.id}-${idx}`} content={`${badge.title} (${badge.provider.toUpperCase()})`} side="top">
              <img
                src={badge.imageUrl}
                alt={badge.title}
                className="w-5 h-5 inline-block"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            </Tooltip>
          ))}
          {isSN && <StreamNookBadge userId={senderUserId} userNumber={getStreamNookUserNumber(senderUserId)} />}
        </span>
      );
    };

    // Use dynamic spacing from user settings
    const eventPadding = calculateHalfPadding(chatDesign?.message_spacing ?? 8);

    return (
      <div key={messageId} className="px-3 border-t border-borderSubtle donation-gradient" style={{ paddingTop: `${eventPadding}px`, paddingBottom: `${eventPadding}px` }}>
        {/* Shared chat indicator */}
        {isFromDifferentChannel && (
          <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-borderSubtle">
            <svg className="w-3.5 h-3.5 text-accent flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span className="text-xs text-accent font-semibold">From Shared Chat</span>
            {fetchedChannelName && (
              <>
                <span className="text-xs text-textSecondary">-</span>
                <Tooltip content={`Switch to ${fetchedChannelName}'s stream`} side="top">
                  <button
                    onClick={async () => {
                      try {
                        const { useAppStore } = await import('../stores/AppStore');
                        await useAppStore.getState().startStream(fetchedChannelName);
                      } catch (err) {
                        Logger.error('[ChatMessage] Failed to switch to shared channel:', err);
                        const { useAppStore } = await import('../stores/AppStore');
                        useAppStore.getState().addToast(`Failed to switch to ${fetchedChannelName}'s stream`, 'error');
                      }
                    }}
                    className="text-xs text-blue-400 font-semibold hover:underline cursor-pointer"
                  >
                    {fetchedChannelName}
                  </button>
                </Tooltip>
              </>
            )}
          </div>
        )}

        <div className="flex items-center gap-2.5">
          <div className="flex-shrink-0">
            {/* Heart/Charity icon */}
            <svg className="w-5 h-5 text-green-400" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="flex-1 min-w-0 flex items-center flex-wrap">
            <p className="text-white font-semibold text-sm leading-relaxed">
              {renderBadges()}
              {renderClickableUsername(parsed.username, parsed.tags.get('display-name') || parsed.username)}
              <span className="text-green-400 font-bold"> donated {formattedAmount}</span>
              {charityName && <span className="text-textSecondary"> to support {charityName}</span>}
            </p>
            {parsed.content && (
              <p className="text-textSecondary text-sm mt-1 leading-relaxed">
                {renderContent(contentWithEmotes)}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Handle watch streak milestone messages
  if (isWatchStreak) {
    // Generate a unique key based on message ID to prevent animation restarts
    const messageId = parsed.tags.get('id') || `watchstreak-${parsed.username}-${Date.now()}`;

    // Get watch streak details
    const streakValue = parsed.tags.get('msg-param-value'); // Number of consecutive streams
    const channelPointsReward = parsed.tags.get('msg-param-copoReward'); // Channel points earned
    const displayName = parsed.tags.get('display-name') || parsed.username;

    // Helper function to render username as clickable
    const renderClickableUsername = (username: string, displayNameProp?: string) => {
      const userIdForClick = userId;
      return (
        <Tooltip content="Click to view profile" side="top">
          <span
            className="font-bold cursor-pointer hover:underline"
            style={usernameStyle}
            onClick={(e) => {
              if (userIdForClick && onUsernameClick) {
                onUsernameClick(
                  userIdForClick,
                  username,
                  displayNameProp || username,
                  parsed.color,
                  parsed.badges,
                  e
                );
              }
            }}
          >
            {effectiveDisplayName || displayNameProp || username}
          </span>
        </Tooltip>
      );
    };

    // Helper function to render badges
    const renderBadges = () => {
      const senderUserId = parsed.tags.get('user-id');
      const isSN = isStreamNookUser(senderUserId);
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        const w = window as any;
        if (!w.__snChatDebug) w.__snChatDebug = { totalCalls: 0, uniqueSenders: [], snHits: [], last10: [] };
        w.__snChatDebug.totalCalls++;
        w.__snChatDebug.last10.push({ senderUserId, isSN, displayName: parsed.tags.get('display-name') });
        if (w.__snChatDebug.last10.length > 10) w.__snChatDebug.last10.shift();
        if (!w.__snChatDebug.uniqueSenders.some((s: any) => s.senderUserId === senderUserId)) {
          w.__snChatDebug.uniqueSenders.push({
            senderUserId,
            isSN,
            displayName: parsed.tags.get('display-name'),
          });
        }
        if (isSN) {
          w.__snChatDebug.snHits.push({
            senderUserId,
            displayName: parsed.tags.get('display-name'),
            at: new Date().toISOString(),
          });
        }
      }

      if (parsed.badges.length === 0 && !seventvBadge && thirdPartyBadges.length === 0 && !isSN) return null;

      return (
        <span className="inline-flex items-center gap-1 mr-1">
          {parsed.badges.map((badge, idx) => {
            if (!badge.info) return null;
            return (
              <Tooltip key={`watchstreak-badge-${badge.key}-${idx}`} content={badge.info.title} side="top">
                <img
                  src={getTwitchBadgeUrl(badge.key, badge.info)}
                  alt={badge.info.title}
                  className="w-5 h-5 inline-block cursor-pointer hover:scale-110 transition-transform"
                  onClick={() => onBadgeClick?.(badge.key, badge.info)}
                  onError={(e) => {
                    Logger.warn('[Badge] Failed to load badge:', badge.key, badge.info.image_url_1x);
                    e.currentTarget.style.display = 'none';
                  }}
                />
              </Tooltip>
            );
          })}
          {seventvBadge && (
            <Tooltip content={`Click for details: ${seventvBadge.description || seventvBadge.name}`} side="top">
              <button
                onClick={() => openBadgesWithBadgeInMain(seventvBadge.id)}
                className="inline-block cursor-pointer hover:scale-110 transition-transform"
              >
                <FallbackImage
                  src={getBadgeImageUrl(seventvBadge)}
                  fallbackUrls={getBadgeFallbackUrls(seventvBadge.id).slice(1)}
                  alt={seventvBadge.description || seventvBadge.name}
                  className="w-5 h-5 inline-block"
                />
              </button>
            </Tooltip>
          )}
          {thirdPartyBadges.filter(badge => badge && badge.imageUrl).map((badge, idx) => (
            <Tooltip key={`watchstreak-tp-badge-${badge.id}-${idx}`} content={`${badge.title} (${badge.provider.toUpperCase()})`} side="top">
              <img
                src={badge.imageUrl}
                alt={badge.title}
                className="w-5 h-5 inline-block"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            </Tooltip>
          ))}
          {isSN && <StreamNookBadge userId={senderUserId} userNumber={getStreamNookUserNumber(senderUserId)} />}
        </span>
      );
    };

    // Use dynamic spacing from user settings
    const eventPadding = calculateHalfPadding(chatDesign?.message_spacing ?? 8);

    return (
      <div key={messageId} className="px-3 border-t border-borderSubtle watchstreak-gradient" style={{ paddingTop: `${eventPadding}px`, paddingBottom: `${eventPadding}px` }}>
        <div className="flex items-center gap-2.5">
          <div className="flex-shrink-0">
            {/* Fire/Watch Streak icon from Twitch */}
            <svg className="w-5 h-5 text-orange-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M11 4.5 9 2 4.8 6.9A7.48 7.48 0 0 0 3 11.77C3 15.2 5.8 18 9.23 18h1.65A6.12 6.12 0 0 0 17 11.88c0-1.86-.65-3.66-1.84-5.1L12 3l-1 1.5ZM6.32 8.2 9 5l2 2.5L12 6l1.62 2.07A5.96 5.96 0 0 1 15 11.88c0 2.08-1.55 3.8-3.56 4.08.36-.47.56-1.05.56-1.66 0-.52-.18-1.02-.5-1.43L10 11l-1.5 1.87c-.32.4-.5.91-.5 1.43 0 .6.2 1.18.54 1.64A4.23 4.23 0 0 1 5 11.77c0-1.31.47-2.58 1.32-3.57Z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="flex-1 min-w-0 flex items-center flex-wrap">
            <p className="text-white font-semibold text-sm leading-relaxed flex items-center flex-wrap gap-1">
              {renderBadges()}
              {renderClickableUsername(parsed.username, displayName)}
              {channelPointsReward && (
                <>
                  {/* Channel Points icon */}
                  <svg className="w-4 h-4 text-orange-400 inline-block ml-1" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 5v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7Z"></path>
                    <path fillRule="evenodd" d="M1 12C1 5.925 5.925 1 12 1s11 4.925 11 11-4.925 11-11 11S1 18.075 1 12Zm11 9a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z" clipRule="evenodd"></path>
                  </svg>
                  <span className="text-orange-400 font-bold">+{parseInt(channelPointsReward, 10).toLocaleString()}</span>
                </>
              )}
            </p>
            <p className="text-textSecondary text-sm mt-0.5 leading-relaxed">
              Watched {streakValue} consecutive streams and sparked a watch streak!
            </p>
            {parsed.content && (
              <p className="text-textPrimary text-sm mt-1 leading-relaxed">
                {renderContent(contentWithEmotes)}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (isSubscription) {
    // Generate a unique key based on message ID to prevent animation restarts
    const messageId = parsed.tags.get('id') || `sub-${parsed.username}-${Date.now()}`;

    // Get subscription details
    const subMsgId = parsed.tags.get('msg-id');
    const msgParamRecipientDisplayName = parsed.tags.get('msg-param-recipient-display-name');
    const msgParamSubPlan = parsed.tags.get('msg-param-sub-plan');
    const msgParamMonths = parsed.tags.get('msg-param-cumulative-months') || parsed.tags.get('msg-param-months');
    const msgParamMassGiftCount = parsed.tags.get('msg-param-mass-gift-count');

    // Check if this is a shared chat notice (from another channel)
    const isSharedChat = subMsgId === 'sharedchatnotice';
    const isFromDifferentChannel = isSharedChat && isFromSharedChat;

    // Helper function to render badges
    const renderBadges = () => {
      const senderUserId = parsed.tags.get('user-id');
      const isSN = isStreamNookUser(senderUserId);
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        const w = window as any;
        if (!w.__snChatDebug) w.__snChatDebug = { totalCalls: 0, uniqueSenders: [], snHits: [], last10: [] };
        w.__snChatDebug.totalCalls++;
        w.__snChatDebug.last10.push({ senderUserId, isSN, displayName: parsed.tags.get('display-name') });
        if (w.__snChatDebug.last10.length > 10) w.__snChatDebug.last10.shift();
        if (!w.__snChatDebug.uniqueSenders.some((s: any) => s.senderUserId === senderUserId)) {
          w.__snChatDebug.uniqueSenders.push({
            senderUserId,
            isSN,
            displayName: parsed.tags.get('display-name'),
          });
        }
        if (isSN) {
          w.__snChatDebug.snHits.push({
            senderUserId,
            displayName: parsed.tags.get('display-name'),
            at: new Date().toISOString(),
          });
        }
      }

      if (parsed.badges.length === 0 && !seventvBadge && thirdPartyBadges.length === 0 && !isSN) return null;

      return (
        <span className="inline-flex items-center align-middle gap-1 mr-1">
          {parsed.badges.map((badge, idx) => {
            if (!badge.info) return null;
            return (
              <Tooltip key={`sub-badge-${badge.key}-${idx}`} content={badge.info.title} side="top">
                <img
                  src={getTwitchBadgeUrl(badge.key, badge.info)}
                  alt={badge.info.title}
                  className="w-5 h-5 inline-block cursor-pointer hover:scale-110 transition-transform"
                  onClick={() => onBadgeClick?.(badge.key, badge.info)}
                  onError={(e) => {
                    Logger.warn('[Badge] Failed to load badge:', badge.key, badge.info.image_url_1x);
                    e.currentTarget.style.display = 'none';
                  }}
                />
              </Tooltip>
            );
          })}
          {seventvBadge && (
            <Tooltip content={`Click for details: ${seventvBadge.description || seventvBadge.name}`} side="top">
              <button
                onClick={() => openBadgesWithBadgeInMain(seventvBadge.id)}
                className="inline-block cursor-pointer hover:scale-110 transition-transform"
              >
                <FallbackImage
                  src={getBadgeImageUrl(seventvBadge)}
                  fallbackUrls={getBadgeFallbackUrls(seventvBadge.id).slice(1)}
                  alt={seventvBadge.description || seventvBadge.name}
                  className="w-5 h-5 inline-block"
                />
              </button>
            </Tooltip>
          )}
          {thirdPartyBadges.filter(badge => badge && badge.imageUrl).map((badge, idx) => (
            <Tooltip key={`sub-tp-badge-${badge.id}-${idx}`} content={`${badge.title} (${badge.provider.toUpperCase()})`} side="top">
              <img
                src={badge.imageUrl}
                alt={badge.title}
                className="w-5 h-5 inline-block"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            </Tooltip>
          ))}
          {isSN && <StreamNookBadge userId={senderUserId} userNumber={getStreamNookUserNumber(senderUserId)} />}
        </span>
      );
    };

    // Component to render a username with its own cosmetics
    const UsernameWithCosmetics = ({
      username,
      userIdProp,
      displayName
    }: {
      username: string;
      userIdProp: string | null;
      displayName?: string;
    }) => {
      const [userCosmetics, setUserCosmetics] = useState<{ badges: any[]; paints: any[] } | null>(null);
      const [userBadges] = useState<Array<{ key: string; info: any }>>([]);

      useEffect(() => {
        if (!userIdProp) return;

        let cancelled = false;

        // Fetch 7TV cosmetics (with cache fallback)
        getCosmeticsWithFallback(userIdProp).then((cosmetics) => {
          if (cancelled || !cosmetics) return;
          setUserCosmetics(cosmetics);
        });

        // Fetch Twitch badges - we don't have badge string from recipient, so skip for now
        // Recipients will just show their 7TV cosmetics

        return () => {
          cancelled = true;
        };
      }, [userIdProp]);

      const userPaint = userCosmetics?.paints.find((p) => p.selected);
      const userBadge = userCosmetics?.badges.find((b) => b.selected);

      // Resolve a per-recipient color override (separate from the message
      // author's override at the top of the component). Falls back to Twitch
      // purple when nothing is set, matching the prior behavior here.
      const recipientBaseColor = getColorOverride(userIdProp, userOverrides) ?? '#9147FF';

      const userStyle = useMemo(() => {
        if (!userPaint) {
          return { color: recipientBaseColor };
        }
        return computePaintStyle(userPaint, recipientBaseColor, paintShadowMode);
      }, [userPaint, recipientBaseColor, paintShadowMode]);

      return (
        <span className="inline-flex items-center align-middle">
          {userBadge && (
            <span className="inline-flex items-center align-middle gap-1 mr-1">
              <Tooltip content={userBadge.description || userBadge.name} side="top">
                <img
                  src={getBadgeImageUrl(userBadge)}
                  alt={userBadge.description || userBadge.name}
                  className="w-5 h-5 inline-block"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              </Tooltip>
            </span>
          )}
          <Tooltip content="Click to view profile" side="top">
            <span
              className="font-bold cursor-pointer hover:underline"
              style={userStyle}
              onClick={(e) => {
                if (userIdProp && onUsernameClick) {
                  onUsernameClick(
                    userIdProp,
                    username,
                    displayName || username,
                    userStyle.color as string || '#9147FF',
                    userBadges,
                    e
                  );
                }
              }}
            >
              {getDisplayedName(userIdProp, displayName || username, userOverrides)}
            </span>
          </Tooltip>
        </span>
      );
    };

    // Helper function to parse system message and make usernames clickable
    const parseSystemMessageWithClickableNames = (message: string) => {
      if (!message) return null;

      // Pattern to match usernames in the system message
      // This will match the subscriber's name and recipient names
      const usernamePattern = /\b([A-Za-z0-9_]{3,25})\b/g;
      const parts: (string | JSX.Element)[] = [];
      let lastIndex = 0;
      let match;
      let keyIndex = 0;

      // Get recipient info from tags
      const recipientUserId = parsed.tags.get('msg-param-recipient-id');
      const recipientUserName = parsed.tags.get('msg-param-recipient-user-name');
      const recipientDisplayName = msgParamRecipientDisplayName;

      while ((match = usernamePattern.exec(message)) !== null) {
        const matchedName = match[1];

        // Add text before the match
        if (match.index > lastIndex) {
          parts.push(message.substring(lastIndex, match.index));
        }

        // Check if this is the subscriber's username or recipient's username
        const isSubscriber = matchedName.toLowerCase() === parsed.username.toLowerCase();
        const isRecipient = recipientUserName &&
          matchedName.toLowerCase() === recipientUserName.toLowerCase();

        if (isSubscriber) {
          // Gifter with their badges and cosmetics
          parts.push(
            <span
              key={`username-${keyIndex++}`}
              className="inline-flex items-center align-middle"
            >
              {renderBadges()}
              <Tooltip content="Click to view profile" side="top">
                <span
                  className="font-bold cursor-pointer hover:underline"
                  style={usernameStyle}
                  onClick={(e) => {
                    if (userId && onUsernameClick) {
                      onUsernameClick(
                        userId,
                        parsed.username,
                        parsed.tags.get('display-name') || parsed.username,
                        parsed.color,
                        parsed.badges,
                        e
                      );
                    }
                  }}
                >
                  {effectiveDisplayName || matchedName}
                </span>
              </Tooltip>
            </span>
          );
        } else if (isRecipient && recipientUserId) {
          // Recipient with their own cosmetics
          parts.push(
            <UsernameWithCosmetics
              key={`username-${keyIndex++}`}
              username={recipientUserName}
              userIdProp={recipientUserId}
              displayName={recipientDisplayName}
            />
          );
        } else {
          // Keep as plain text
          parts.push(matchedName);
        }

        lastIndex = match.index + matchedName.length;
      }

      // Add remaining text
      if (lastIndex < message.length) {
        parts.push(message.substring(lastIndex));
      }

      return parts.length > 0 ? parts : message;
    };

    // Build a more detailed message for different subscription types
    let displayMessage = systemMessage;

    if (!displayMessage) {
      // Fallback messages if system-msg is not available
      if (msgId === 'sub') {
        displayMessage = `${parsed.username} subscribed!`;
      } else if (msgId === 'resub') {
        displayMessage = `${parsed.username} subscribed for ${msgParamMonths} months!`;
      } else if (msgId === 'subgift') {
        displayMessage = `${parsed.username} gifted a subscription to ${msgParamRecipientDisplayName}!`;
      } else if (msgId === 'submysterygift') {
        displayMessage = `${parsed.username} is gifting ${msgParamMassGiftCount} subscriptions to the community!`;
      } else {
        displayMessage = `${parsed.username} subscribed!`;
      }
    }

    // Use dynamic spacing from user settings
    const eventPadding = calculateHalfPadding(chatDesign?.message_spacing ?? 8);

    return (
      <div key={messageId} className="px-3 border-t border-borderSubtle subscription-gradient" style={{ paddingTop: `${eventPadding}px`, paddingBottom: `${eventPadding}px` }}>
        {/* Shared chat indicator */}
        {isFromDifferentChannel && (
          <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-borderSubtle">
            <svg className="w-3.5 h-3.5 text-accent flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span className="text-xs text-accent font-semibold">From Shared Chat</span>
            {fetchedChannelName && (
              <>
                <span className="text-xs text-textSecondary">-</span>
                <Tooltip content={`Switch to ${fetchedChannelName}'s stream`}>
                <button
                  onClick={async () => {
                    try {
                      const { useAppStore } = await import('../stores/AppStore');

                      // Use the startStream method to switch to the shared channel
                      await useAppStore.getState().startStream(fetchedChannelName);
                    } catch (err) {
                      Logger.error('[ChatMessage] Failed to switch to shared channel:', err);
                      const { useAppStore } = await import('../stores/AppStore');
                      useAppStore.getState().addToast(`Failed to switch to ${fetchedChannelName}'s stream`, 'error');
                    }
                  }}
                  className="text-xs text-blue-400 font-semibold hover:underline cursor-pointer"
                >
                  {fetchedChannelName}
                </button>
                </Tooltip>
              </>
            )}
          </div>
        )}

        <div className="flex items-center gap-2.5">
          <div className="flex-shrink-0">
            {/* Prime logo for Prime subs, Gift box for other subs */}
            {msgParamSubPlan === 'Prime' ? (
              <svg className="w-5 h-5 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" clipRule="evenodd" d="M18 5v8a2 2 0 0 1-2 2H4a2.002 2.002 0 0 1-2-2V5l4 3 4-4 4 4 4-3z" />
              </svg>
            ) : (
              <Gift size={20} className="text-purple-400" />
            )}
          </div>
          <div className="flex-1 min-w-0 flex items-center flex-wrap leading-relaxed">
            <p className="text-white font-semibold text-sm leading-relaxed">
              {parseSystemMessageWithClickableNames(displayMessage)}
            </p>
            {parsed.content && (
              <p className="text-textSecondary text-sm mt-1 leading-relaxed">
                {renderContent(contentWithEmotes)}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Handle system messages directly to apply strict yellow styling without username
  if (isSystemMessage) {
    const eventPadding = calculateHalfPadding(chatDesign?.message_spacing ?? 8);
    const messageId = parsed.tags.get('id') || `system-${Date.now()}`;
    
    return (
      <div 
        key={messageId} 
        className="px-3 border-y border-yellow-500/20 bg-yellow-500/10 mb-[1px]" 
        style={{ paddingTop: `${eventPadding}px`, paddingBottom: `${eventPadding}px` }}
      >
        <div className="flex items-center gap-2">
          {/* Information / Alert Icon */}
          <div className="flex-shrink-0">
            <svg className="w-4 h-4 text-yellow-500/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-yellow-200/90 font-medium text-xs leading-relaxed">
              {renderContent(contentWithEmotes)}
            </p>
          </div>
        </div>
      </div>
    );
  }


  // Build dynamic styles based on chat design settings
  // Use consistent padding on container - spacing between messages is handled via py classes
  const messageSpacing = chatDesign?.message_spacing ?? 8;
  const messageStyle: React.CSSProperties = {
    paddingTop: `${Math.max(4, messageSpacing / 2)}px`,
    paddingBottom: `${Math.max(4, messageSpacing / 2)}px`,
  };

  // Determine animation class and border color
  let animationClass = '';
  let borderLeftColor = '';

  if (isMentioned && chatDesign?.mention_animation !== false) {
    animationClass = 'animate-mention-flash';
    borderLeftColor = chatDesign?.mention_color ?? '#ff4444';
  } else if (isReplyToMe && chatDesign?.mention_animation !== false) {
    animationClass = 'animate-reply-flash';
    borderLeftColor = chatDesign?.reply_color ?? '#ff6b6b';
  } else if (phraseMatch) {
    animationClass = 'animate-phrase-highlight';
    borderLeftColor = phraseMatch.color;
  } else if (isHighlighted) {
    animationClass = 'animate-highlight-flash';
  }

  // Build background class based on alternating backgrounds setting
  // Uses theme's surface color for alternating rows
  let backgroundClass = '';

  if (chatDesign?.alternating_backgrounds) {
    // Alternate between theme's surface color and default background
    backgroundClass = messageIndex % 2 === 1 ? 'bg-surface' : '';
  }

  // Build border class based on settings
  // Divider anchored to the TOP of each message instead of the bottom. That
  // way the very last visible message has no line at its bottom edge, so
  // when a new message arrives, the "absolute bottom" of the chat has no
  // 1px line that needs to move with the layout. Removes a tiny vertical
  // shimmer at the bottom edge.
  const borderClass = chatDesign?.show_dividers !== false ? 'border-t border-borderSubtle' : '';

  // StreamNook badge: regular-message render path (the 5th badge render site).
  // Bits, donation, watchstreak, and subscription messages each have their own
  // renderBadges() helper above; everything else (regular text, replies, actions,
  // mentions, and the user's own outgoing messages) flows through the JSX below.
  const senderUserId = parsed.tags.get('user-id');
  const isSN = isStreamNookUser(senderUserId);
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const w = window as any;
    if (!w.__snChatDebug) w.__snChatDebug = { totalCalls: 0, uniqueSenders: [], snHits: [], last10: [] };
    w.__snChatDebug.totalCalls++;
    w.__snChatDebug.last10.push({ senderUserId, isSN, displayName: parsed.tags.get('display-name'), path: 'regular' });
    if (w.__snChatDebug.last10.length > 10) w.__snChatDebug.last10.shift();
    if (!w.__snChatDebug.uniqueSenders.some((s: any) => s.senderUserId === senderUserId)) {
      w.__snChatDebug.uniqueSenders.push({
        senderUserId,
        isSN,
        displayName: parsed.tags.get('display-name'),
      });
    }
    if (isSN) {
      w.__snChatDebug.snHits.push({
        senderUserId,
        displayName: parsed.tags.get('display-name'),
        at: new Date().toISOString(),
        path: 'regular',
      });
    }
  }

  // Global highlight appearance — applies to BOTH built-in event highlights
  // and the phrase/user/badge match (phraseMatch). Defaults preserve prior
  // visual: standard display style with ~20% opacity background.
  const appearance = settings?.chat_highlights?.appearance;
  const displayStyle = appearance?.display_style ?? 'standard';
  const tintOpacityPct = Math.max(0, Math.min(100, appearance?.opacity ?? 20));
  // Hex alpha 00-ff. 20% → 0x33, 100% → 0xff, 0% → 0x00.
  const tintAlphaHex = Math.round((tintOpacityPct / 100) * 255)
    .toString(16)
    .padStart(2, '0');
  const showHighlightBg = displayStyle === 'standard';
  const showHighlightBorder = displayStyle !== 'none';

  // Compose built-in event tint styles inline. The configurable color drives
  // a gradient (alpha controlled by tintOpacityPct). Phrase/mention/reply
  // flash still take precedence on the left border (their borderLeftColor
  // overrides below).
  const builtInEventBg =
    builtInEventColor && showHighlightBg
      ? `linear-gradient(to right, ${builtInEventColor}${tintAlphaHex}, ${builtInEventColor}${Math.round(
          (tintOpacityPct / 100) * 128,
        )
          .toString(16)
          .padStart(2, '0')}, transparent)`
      : undefined;

  return (
    <div
      className={`group relative isolate px-3 hover:bg-glass transition-colors ${borderClass} ${animationClass
        } ${isRedemption ? 'highlight-message-gradient' : ''
        } ${isFromSharedChat ? 'border-l-2 border-l-accent/50 bg-accent/5' : ''
        } ${backgroundClass} ${moderationContext && (chatDesign?.deleted_message_style ?? 'strikethrough') !== 'keep' ? 'opacity-50' : ''}`}
      style={{
        ...messageStyle,
        ...(builtInEventBg ? { backgroundImage: builtInEventBg } : {}),
        borderLeftColor: (isMentioned || isReplyToMe)
          ? borderLeftColor
          : phraseMatch && showHighlightBorder
            ? phraseMatch.color
            : builtInEventColor && showHighlightBorder
              ? builtInEventColor
              : undefined,
        borderLeftWidth:
          isMentioned || isReplyToMe || ((phraseMatch || builtInEventColor) && showHighlightBorder)
            ? '4px'
            : undefined,
        borderLeftStyle:
          (builtInEventColor || phraseMatch) && showHighlightBorder && !(isMentioned || isReplyToMe)
            ? 'solid'
            : undefined,
        ...(phraseMatch
          ? ({ '--phrase-flash-color': phraseMatch.color } as React.CSSProperties)
          : {}),
      }}
    >
      {/* Atmosphere wash: the same animated aurora as the member's profile
          backdrop, masked to fade out before the text so it stays readable. */}
      {atmosphere && <AtmosphereBackground atm={atmosphere} variant="chat" />}

      {/* Built-in event label (first-time chatter, returning, self, raid) */}
      {builtInEventLabel && (
        <div className="flex items-center justify-end gap-1.5">
          <span
            className="text-xs font-normal opacity-60"
            style={{ color: builtInEventColor ?? undefined }}
          >
            {builtInEventLabel}
          </span>
        </div>
      )}
      {/* Channel points redemption indicator (highlight, gigantify, animate, skip-subs-mode, custom reward) */}
      {redemptionLabel && (
        <div className="flex items-center justify-end gap-1">
          <svg className="w-3 h-3 text-cyan-400 opacity-60" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10 6a4 4 0 014 4h-2a2 2 0 00-2-2V6z" />
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-2 0a6 6 0 11-12 0 6 6 0 0112 0z" clipRule="evenodd" />
          </svg>
          <span className="text-xs text-cyan-400 font-normal opacity-60">{redemptionLabel}</span>
        </div>
      )}
      {/* Reply indicator */}
      {parsed.replyInfo && (
        <Tooltip content="Click to view parent message" side="top">
          <div
            className="mb-1.5 pl-2 border-l-2 border-textSecondary/40 cursor-pointer hover:border-textSecondary/60 transition-colors"
            onClick={() => onReplyClick?.(parsed.replyInfo!.parentMsgId)}
          >
            <div className="flex items-center gap-1.5 text-xs text-textSecondary">
              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
              <span className="font-semibold">{getDisplayedName(parsed.replyInfo.parentUserId, parsed.replyInfo.parentDisplayName, userOverrides)}</span>
              <span className="truncate flex-1">{parsed.replyInfo.parentMsgBody}</span>
            </div>
          </div>
        </Tooltip>
      )}

      <div>
        {/* Timestamp - own line above the badges/name/message when enabled */}
        {formattedTimestamp && (
          <div className="text-textSecondary text-[10px] opacity-50 leading-tight mb-0.5">{formattedTimestamp}</div>
        )}
        {/* Badges and Message content - inline flow so wrapped text starts at left edge */}
        <div className="min-w-0">
          {/* Badges */}
          {isSN || (isFromSharedChat && channelProfileImage) || parsed.badges.length > 0 || seventvBadge || thirdPartyBadges.length > 0 ? (
            <span className="inline-flex items-center gap-1 mr-1.5 align-middle">
              {/* Shared chat channel profile image badge */}
              {isFromSharedChat && channelProfileImage && (
                <Tooltip content={`Chatting from ${fetchedChannelName || 'shared channel'}`} side="top">
                  <img
                    src={channelProfileImage}
                    alt={`${fetchedChannelName || 'Channel'} profile`}
                    className="w-5 h-5 cursor-pointer hover:scale-110 transition-transform object-cover"
                    onClick={async () => {
                      if (fetchedChannelName) {
                        try {
                          const { useAppStore } = await import('../stores/AppStore');
                          await useAppStore.getState().startStream(fetchedChannelName);
                        } catch (err) {
                          Logger.error('[ChatMessage] Failed to switch to shared channel:', err);
                        }
                      }
                    }}
                    onError={(e) => {
                      Logger.warn('[Badge] Failed to load channel profile image');
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                </Tooltip>
              )}
              {parsed.badges.map((badge, idx) => {
                if (!badge.info) return null;
                return (
                  <Tooltip key={`${badge.key}-${idx}`} content={badge.info.title} side="top">
                    <img
                      src={getTwitchBadgeUrl(badge.key, badge.info)}
                      alt={badge.info.title}
                      className="w-5 h-5 cursor-pointer hover:scale-110 transition-transform"
                      onClick={() => onBadgeClick?.(badge.key, badge.info)}
                      onError={(e) => {
                        // Hide broken badge images
                        Logger.warn('[Badge] Failed to load badge:', badge.key, badge.info.image_url_1x);
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  </Tooltip>
                );
              })}
              {seventvBadge && (
                <Tooltip content={`Click for details: ${seventvBadge.description || seventvBadge.name}`} side="top">
                  <button
                    onClick={() => openBadgesWithBadgeInMain(seventvBadge.id)}
                    className="inline-block cursor-pointer hover:scale-110 transition-transform"
                  >
                    <FallbackImage
                      src={getBadgeImageUrl(seventvBadge)}
                      fallbackUrls={getBadgeFallbackUrls(seventvBadge.id).slice(1)}
                      alt={seventvBadge.description || seventvBadge.name}
                      className="w-5 h-5"
                    />
                  </button>
                </Tooltip>
              )}
              {/* Third-party badges (FFZ, Chatterino, Homies) */}
              {thirdPartyBadges.filter(badge => badge && badge.imageUrl).map((badge, idx) => (
                <Tooltip key={`tp-badge-${badge.id}-${idx}`} content={`${badge.title} (${badge.provider.toUpperCase()})`} side="top">
                  <img
                    src={badge.imageUrl}
                    alt={badge.title}
                    className="w-5 h-5"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                </Tooltip>
              ))}
              {/* StreamNook identity badge — rendered LAST so it sits closest
                  to the username, matching the profile card's badge order. */}
              {isSN && <StreamNookBadge userId={senderUserId} userNumber={getStreamNookUserNumber(senderUserId)} />}
            </span>
          ) : null}

          {/* Message content */}
          <span
            className="leading-relaxed align-middle"
            style={{
              fontSize: `${chatDesign?.font_size ?? 14}px`,
              fontWeight: chatDesign?.font_weight ?? 400,
            }}
          >
            {isAction ? (
              // ACTION messages: entire content in username color
              <span style={{ ...usernameStyle, fontWeight: 300 }} className="break-words italic">
                <Tooltip content="Right-click to reply" side="top">
                  <span
                    style={{ fontWeight: 700 }}
                    className="cursor-pointer hover:underline inline-flex items-center gap-1"
                    onClick={(e) => {
                      const userId = parsed.tags.get('user-id');
                      const displayName = parsed.tags.get('display-name') || parsed.username;
                      if (userId && onUsernameClick) {
                        onUsernameClick(
                          userId,
                          parsed.username,
                          displayName,
                          parsed.color,
                          parsed.badges,
                          e
                        );
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const messageId = parsed.tags.get('id');
                      if (messageId && onUsernameRightClick) {
                        onUsernameRightClick(messageId, parsed.username);
                      }
                    }}
                  >
                    {parsed.username}
                    {broadcasterType === 'partner' && (
                      <svg
                        className="w-3.5 h-3.5 inline-block flex-shrink-0"
                        viewBox="0 0 16 16"
                        fill="#9146FF"
                        style={{ verticalAlign: 'middle' }}
                      >
                        <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd"></path>
                      </svg>
                    )}
                  </span>
                </Tooltip>
                {' '}{renderContent(contentWithEmotes)}
              </span>
            ) : (
              // Regular messages: username in color, content in default color
              <>
                <Tooltip content="Right-click to reply" side="top">
                  <span
                    style={{ ...usernameStyle, fontWeight: 700 }}
                    className="cursor-pointer hover:underline inline-flex items-center gap-1"
                    onClick={(e) => {
                      const userId = parsed.tags.get('user-id');
                      const displayName = parsed.tags.get('display-name') || parsed.username;
                      if (userId && onUsernameClick) {
                        onUsernameClick(
                          userId,
                          parsed.username,
                          displayName,
                          parsed.color,
                          parsed.badges,
                          e
                        );
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const messageId = parsed.tags.get('id');
                      if (messageId && onUsernameRightClick) {
                        onUsernameRightClick(messageId, parsed.username);
                      }
                    }}
                  >
                    {parsed.username}
                    {broadcasterType === 'partner' && (
                      <svg
                        className="w-3.5 h-3.5 inline-block flex-shrink-0"
                        viewBox="0 0 16 16"
                        fill="#9146FF"
                        style={{ verticalAlign: 'middle' }}
                      >
                        <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd"></path>
                      </svg>
                    )}
                  </span>
                </Tooltip>
                <span style={{ fontWeight: 300 }} className="text-textPrimary break-words">
                  <span
                    style={
                      moderationContext && (chatDesign?.deleted_message_style ?? 'strikethrough') === 'strikethrough'
                        ? { textDecoration: 'line-through' }
                        : undefined
                    }
                  >
                    {' '}{renderContent(contentWithEmotes)}
                  </span>
                  {moderationContext && (chatDesign?.deleted_message_style ?? 'strikethrough') === 'strikethrough' && (
                    <span className="ml-1.5 text-xs text-red-400/70 font-medium">
                      {moderationContext.type === 'timeout'
                        ? `[timed out for ${moderationContext.duration}s]`
                        : moderationContext.type === 'ban'
                          ? '[banned]'
                          : '[deleted by mod]'}
                    </span>
                  )}
                </span>
              </>
            )}
          </span>
        </div>
      </div>
      {/* Quick Actions Dock: Copy for everyone, Mod tools for Mods */}
      {(isModerator || !!onMessageCopy) && broadcasterId && (
        <div 
          className="absolute top-1 right-2 opacity-0 group-hover:opacity-100 transition-all duration-200 flex items-center bg-zinc-900/90 backdrop-blur-md border border-white/10 shadow-lg rounded-lg overflow-visible z-[50] translate-y-1 group-hover:translate-y-0"
        >
          {/* Copy Message (Available to all) */}
          {onMessageCopy && (
            <Tooltip content="Copy message" side="top">
              <button
                onClick={(e) => { e.preventDefault(); onMessageCopy(parsed.content); }}
                className="p-1.5 m-0.5 rounded-md hover:bg-stone-500/20 text-white/50 hover:text-white transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
              </button>
            </Tooltip>
          )}

          {/* Moderator Tools Divider */}
          {onMessageCopy && isModerator && (
            <div className="w-px h-4 bg-white/10 mx-0.5" />
          )}

          {/* Moderator-Only Tools */}
          {isModerator && (
            <>
              {/* Delete Message */}
              <Tooltip content="Delete Message" side="top">
                <button
                  onClick={async (e) => {
                    e.preventDefault();
                    const msgId = parsed.tags.get('id');
                    if (msgId) {
                      try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        await invoke('delete_chat_message', { broadcasterId, messageId: msgId });
                      } catch (err) {
                        Logger.error('[ChatMessage] Failed to delete message:', err);
                      }
                    }
                  }}
                  className="p-1.5 m-0.5 rounded-md hover:bg-red-500/20 text-white/50 hover:text-red-400 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
              </Tooltip>

              <div className="w-px h-4 bg-white/10" />

              {/* Quick Timeout (10m) */}
              <div className="relative flex group/timeout">
            <Tooltip content="Timeout User (10m)" side="top">
              <button
                onClick={async (e) => {
                  e.preventDefault();
                  const targetUserId = parsed.tags.get('user-id');
                  if (targetUserId) {
                    try {
                      const { invoke } = await import('@tauri-apps/api/core');
                      await invoke('ban_user', { broadcasterId, targetUserId, duration: 600, reason: null });
                    } catch (err) {
                      Logger.error('[ChatMessage] Failed to timeout user:', err);
                    }
                  }
                }}
                className="p-1.5 m-0.5 rounded-md hover:bg-yellow-500/20 text-white/50 hover:text-yellow-400 transition-colors"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              </button>
            </Tooltip>
            
            {/* Timeout Dropdown */}
            <div className="absolute top-1/2 -translate-y-1/2 right-full opacity-0 pointer-events-none group-hover/timeout:opacity-100 group-hover/timeout:pointer-events-auto transition-opacity pr-1 py-4">
              <div className="flex bg-zinc-900 border border-white/10 rounded-md shadow-xl overflow-hidden">
                {[
                  { label: '1s', val: 1 }, 
                  { label: '10m', val: 600 }, 
                  { label: '1h', val: 3600 }, 
                  { label: '24h', val: 86400 }
                ].map(opt => (
                  <button
                    key={opt.val}
                    className="px-2 py-1 text-[10px] font-bold text-white/70 hover:text-yellow-400 hover:bg-white/10 transition-colors border-r border-white/5 last:border-0"
                    onClick={async (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const targetUserId = parsed.tags.get('user-id');
                      if (targetUserId) {
                        try {
                          const { invoke } = await import('@tauri-apps/api/core');
                          await invoke('ban_user', { broadcasterId, targetUserId, duration: opt.val, reason: null });
                        } catch (err) {
                          Logger.error('[ChatMessage] Failed to timeout user (quick value):', err);
                        }
                      }
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="w-px h-4 bg-white/10" />

          {/* Quick Ban */}
          <Tooltip content="Ban User" side="top">
            <button
              onClick={async (e) => {
                e.preventDefault();
                const targetUserId = parsed.tags.get('user-id');
                if (targetUserId) {
                  try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('ban_user', { broadcasterId, targetUserId, duration: null, reason: null });
                  } catch (err) {
                    Logger.error('[ChatMessage] Failed to ban user:', err);
                  }
                }
              }}
              className="p-1.5 m-0.5 rounded-md hover:bg-red-500/20 text-white/50 hover:text-red-500 transition-colors"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </Tooltip>
          </>
          )}
        </div>
      )}
    </div>
  );
}, chatMessageAreEqual);

export default ChatMessage;
