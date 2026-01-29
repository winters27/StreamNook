import React, { useMemo, useState, useEffect, memo } from 'react';
import { Gift } from 'lucide-react';
import { parseMessage, MessageSegment } from '../services/twitchChat';
import { queueEmoteForCaching, EmoteSet, Emote } from '../services/emoteService';
import { getCachedEmojiUrl, parseEmojisSync } from '../services/emojiService';
import { calculateHalfPadding } from '../utils/chatLayoutUtils';
import { computePaintStyle, getBadgeImageUrl, getBadgeFallbackUrls, queueCosmeticForCaching } from '../services/seventvService';
import { FallbackImage } from './FallbackImage';
import { getCosmeticsWithFallback, getThirdPartyBadgesFromMemoryCache, getCosmeticsFromMemoryCache, getTwitchBadgesWithFallback } from '../services/cosmeticsCache';
import { ThirdPartyBadge } from '../services/thirdPartyBadges';
import { SevenTVBadge, SevenTVPaint } from '../types';
import { useAppStore } from '../stores/AppStore';
import { useChatUserStore } from '../stores/chatUserStore';
import { queueBadgeForCaching, getCachedBadgeUrl } from '../services/badgeImageCacheService';

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
function getTwitchBadgeUrl(badgeKey: string, badgeInfo: any): string {
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
    badges: Array<{ key: string; info: any }>,
    event: React.MouseEvent
  ) => void;
  onReplyClick?: (parentMsgId: string) => void;
  isHighlighted?: boolean;
  moderationContext?: { type: 'timeout' | 'ban' | 'deleted'; duration?: number } | null; // Moderation context from CLEARMSG/CLEARCHAT
  onEmoteRightClick?: (emoteName: string) => void;
  onUsernameRightClick?: (messageId: string, username: string) => void;
  onBadgeClick?: (badgeKey: string, badgeInfo: any) => void;
  emotes?: EmoteSet | null;
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
  const [apiUserColor, setApiUserColor] = useState<string | null>(null);
  const [apiUserPaint, setApiUserPaint] = useState<any>(null);
  
  // If user is in chat store, use their data directly
  const userColor = cachedUser?.color || apiUserColor || '#9147FF';
  const userPaint = cachedUser?.paint || apiUserPaint;
  const userId = cachedUser?.userId;
  
  // Only do API lookup if user is NOT in the chat store
  useEffect(() => {
    if (cachedUser) return; // Already have data from store
    
    // Try to look up via API and get cosmetics
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<{ id: string; login: string; display_name: string }>('get_user_by_login', { login: username })
        .then((user) => {
          if (user) {
            // Try to get cosmetics for this user (includes paint)
            getCosmeticsWithFallback(user.id).then((cosmetics) => {
              if (cosmetics) {
                const selectedPaint = cosmetics.paints?.find((p: any) => p.selected);
                if (selectedPaint) {
                  setApiUserPaint(selectedPaint);
                }
              }
            }).catch(() => {});
          }
        })
        .catch(() => {});
    });
  }, [username, cachedUser]);
  
  // Compute paint style - use user's Twitch color as fallback (not accent)
  const nameStyle = useMemo(() => {
    if (userPaint) {
      return computePaintStyle(userPaint, userColor);
    }
    // Use user's Twitch chat color as fallback
    return { color: userColor };
  }, [userPaint, userColor]);
  
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
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded bg-accent/15 font-medium cursor-pointer hover:bg-accent/25 transition-colors"
      style={nameStyle}
      title={`View ${username}'s profile`}
      onClick={handleClick}
    >
      @{username}
    </span>
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

// Memoized ChatMessage component to prevent unnecessary re-renders
// This is critical for preventing animation restarts when new messages arrive
const ChatMessage = memo(function ChatMessageInner({ message, messageIndex = 0, onUsernameClick, onReplyClick, isHighlighted = false, moderationContext = null, onEmoteRightClick, onUsernameRightClick, onBadgeClick, emotes }: ChatMessageProps) {
  const { settings, currentUser, currentStream } = useAppStore();
  const chatDesign = settings.chat_design;
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
  const [contentWithEmotes, setContentWithEmotes] = useState<EmoteSegment[]>([]);

  // PHASE 3.1 - THE ENDGAME: Use pre-parsed segments from Rust
  useEffect(() => {
    // Convert Rust MessageSegment to EmoteSegment format for rendering
    if (parsed.segments && parsed.segments.length > 0) {
      const convertedSegments: EmoteSegment[] = parsed.segments.map((seg) => {
        if (seg.type === 'emote') {
          return {
            type: 'emote' as const,
            content: seg.content,
            emoteId: seg.emote_id,
            emoteUrl: seg.emote_url,
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
      
      setContentWithEmotes(convertedSegments);
    } else if (emotes) {
       // Fallback for local messages (no segments from Rust yet): Parse text using the provided emotes prop
       const words = parsed.content.split(' ');
       const newSegments: EmoteSegment[] = [];

       words.forEach((word, i) => {
           // Check providers for exact match
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
                   emoteUrl: emote.url, // The emote object from ChatWidget already has localUrl merged if available
               });
           } else {
               // Parse the word for emojis - this enables iOS-style emoji for optimistic messages
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
           if (coalesced.length > 0 && coalesced[coalesced.length-1].type === 'text' && seg.type === 'text') {
               coalesced[coalesced.length-1].content += seg.content;
           } else {
               coalesced.push(seg);
           }
       });
       setContentWithEmotes(coalesced);
    } else {
      // No segments and no emotes loaded - parse for emojis at minimum
      const emojiParsed = parseEmojisSync(parsed.content);
      const segments: EmoteSegment[] = emojiParsed.map(seg => {
        if (seg.type === 'emoji' && seg.emojiUrl) {
          return {
            type: 'emoji' as const,
            content: seg.content,
            emojiUrl: seg.emojiUrl,
          };
        }
        return { type: 'text' as const, content: seg.content };
      });
      setContentWithEmotes(segments);
    }
  }, [parsed.segments, parsed.content, emotes]);

  // Extract userId once to prevent re-renders
  const userId = useMemo(() => parsed.tags.get('user-id'), [message]);

  // Initialize state from synchronous memory cache (avoids null -> data flash)
  const [seventvBadge, setSeventvBadge] = useState<any>(() => {
    if (!userId) return null;
    const cached = getCosmeticsFromMemoryCache(userId);
    return cached?.badges.find((b: any) => b.selected) || null;
  });
  const [seventvPaint, setSeventvPaint] = useState<any>(() => {
    if (!userId) return null;
    const cached = getCosmeticsFromMemoryCache(userId);
    return cached?.paints.find((p: any) => p.selected) || null;
  });
  const [thirdPartyBadges, setThirdPartyBadges] = useState<any[]>(() => {
    if (!userId) return [];
    return getThirdPartyBadgesFromMemoryCache(userId) || [];
  });
  const [broadcasterType, setBroadcasterType] = useState<string | null>(null);
  const [isMentioned, setIsMentioned] = useState(false);
  const [isReplyToMe, setIsReplyToMe] = useState(false);

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

  // Fetch 7TV user cosmetics and third-party badges (only if not already loaded from cache)
  useEffect(() => {
    if (!userId) {
      return;
    }

    let cancelled = false;

    // Only fetch 7TV cosmetics if we don't already have data from initial cache
    // This prevents redundant API calls when cache already populated the state
    const cachedCosmetics = getCosmeticsFromMemoryCache(userId);
    if (!cachedCosmetics) {
      getCosmeticsWithFallback(userId).then((cosmetics) => {
        if (cancelled || !cosmetics) return;

        // Find selected paint (the 'selected' property is added by seventvService)
        const selectedPaint = cosmetics.paints.find((p: any) => p.selected);
        if (selectedPaint) {
          setSeventvPaint(selectedPaint);
        }

        // Find selected badge (the 'selected' property is added by seventvService)
        const selectedBadge = cosmetics.badges.find((b: any) => b.selected);
        if (selectedBadge) {
          setSeventvBadge(selectedBadge);
        }
      });
    }

    // Third-party badges are populated as part of the unified Rust badge call.
    // We trigger that call here (only if needed) to ensure these badges show
    // consistently in chat.
    const cachedThirdParty = getThirdPartyBadgesFromMemoryCache(userId);
    if (!cachedThirdParty) {
      const effectiveChannelId =
        parsed.tags.get('source-room-id') ||
        parsed.tags.get('room-id') ||
        currentStream?.user_id ||
        '';

      const effectiveChannelName =
        currentStream?.user_login ||
        currentStream?.user_name ||
        parsed.tags.get('room') ||
        '';

      // This call also populates the third-party badge in-memory cache.
      getTwitchBadgesWithFallback(userId, parsed.username, effectiveChannelId, effectiveChannelName).then(() => {
        if (cancelled) return;
        setThirdPartyBadges(getThirdPartyBadgesFromMemoryCache(userId) || []);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [userId]);

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

  // Create username style with paint
  const usernameStyle = useMemo(() => {
    if (!seventvPaint) {
      return { color: parsed.color };
    }

    // Use the new computePaintStyle function
    return computePaintStyle(seventvPaint, parsed.color);
  }, [seventvPaint, parsed.color]);


  const renderContent = (segments: EmoteSegment[]) => {
    return segments.map((segment, index) => {
      if (segment.type === 'emote') {
        const emoteUrl = segment.emoteUrl ||
          (segment.emoteId ? `https://static-cdn.jtvnw.net/emoticons/v2/${segment.emoteId}/default/dark/3.0` : '');

        // Reactive caching: If we're using a remote URL, queue it for caching
        // We check if it's NOT a local URL (doesn't start with asset:// or http://asset.localhost)
        if (emoteUrl && !emoteUrl.startsWith('asset://') && !emoteUrl.includes('asset.localhost') && segment.emoteId) {
          queueEmoteForCaching(segment.emoteId, emoteUrl);
        }

        return (
          <img
            key={`${segment.emoteId || segment.content}-${index}`}
            src={emoteUrl}
            alt={segment.content}
            loading="lazy"
            className="inline-block h-7 w-auto max-w-[96px] align-middle mx-0.5 cursor-pointer hover:scale-110 transition-transform crisp-image"
            referrerPolicy="no-referrer"
            title={`Right-click to copy: ${segment.content}`}
            onContextMenu={(e) => {
              e.preventDefault();
              if (onEmoteRightClick) {
                onEmoteRightClick(segment.content);
              }
            }}
            onError={(e) => {
              // Fallback to text if image fails to load
              e.currentTarget.style.display = 'none';
              e.currentTarget.insertAdjacentText('afterend', segment.content);
            }}
          />
        );
      }

      if (segment.type === 'emoji' && segment.emojiUrl) {
        // Get cached/proxied URL to bypass tracking prevention
        const emojiSrc = getCachedEmojiUrl(segment.content, segment.emojiUrl);
        return (
          <img
            key={`emoji-${segment.content}-${index}`}
            src={emojiSrc}
            alt={segment.content}
            loading="lazy"
            className="inline h-5 w-5 align-middle mx-0.5 crisp-image"
            title={segment.content}
            onError={(e) => {
              // Fallback to native emoji if image fails to load
              e.currentTarget.style.display = 'none';
              e.currentTarget.insertAdjacentText('afterend', segment.content);
            }}
          />
        );
      }

      // Handle cheermote segments (animated bits like Cheer500)
      if (segment.type === 'cheermote') {
        const bits = segment.bits ?? 0;
        return (
          <span key={`cheermote-${segment.content}-${index}`} className="inline-flex items-center gap-0.5 align-middle">
            <img
              src={segment.cheermoteUrl}
              alt={segment.content}
              loading="lazy"
              className="inline-block h-7 w-auto align-middle crisp-image"
              referrerPolicy="no-referrer"
              title={`${bits.toLocaleString()} bits`}
              onError={(e) => {
                // Fallback to text if GIF fails to load
                e.currentTarget.style.display = 'none';
                e.currentTarget.insertAdjacentText('afterend', segment.content);
              }}
            />
            <span 
              className="font-bold text-sm" 
              style={{ color: segment.color ?? '#979797' }}
            >
              {bits}
            </span>
          </span>
        );
      }

      // Parse text for URLs and make them clickable
      return <span key={index}>{parseTextWithLinks(segment.content)}</span>;
    });
  };

  // Helper function to detect URLs and @mentions, making them styled and clickable
  const parseTextWithLinks = (text: string) => {
    // Combined regex: URLs and @mentions
    // @mentions: @username (alphanumeric + underscores, 1-25 chars per Twitch rules)
    const combinedRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|@[a-zA-Z0-9_]{1,25})(?=\s|$|[.,!?:;'")>\]}\-])/g;
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

  // Check if this is a bits cheer message
  const bitsAmount = parsed.tags.get('bits');
  const isBitsCheer = bitsAmount && parseInt(bitsAmount, 10) > 0;

  // Get system message for subscriptions and donations
  const systemMessage = parsed.tags.get('system-msg')?.replace(/\\s/g, ' ');

  // Check if this is a first-time message
  const isFirstMessage = parsed.tags.get('first-msg') === '1';

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

    // Fetch the channel name and profile image
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<any>('get_user_by_id', { userId: sourceRoomId })
        .then((user) => {
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

    // Helper function to render username as clickable
    const renderClickableUsername = (username: string, displayName?: string) => {
      const userIdForClick = userId;
      return (
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
          title="Click to view profile"
        >
          {displayName || username}
        </span>
      );
    };

    // Helper function to render badges
    const renderBadges = () => {
      if (parsed.badges.length === 0 && !seventvBadge && thirdPartyBadges.length === 0) return null;

      return (
        <span className="inline-flex items-center gap-1 mr-1">
          {parsed.badges.map((badge, idx) => {
            // Handle both old format (key/info) and new format (name/version)
            if (!badge.info) return null;
            return (
              <img
                key={`bits-badge-${badge.key}-${idx}`}
                src={getTwitchBadgeUrl(badge.key, badge.info)}
                alt={badge.info.title}
                loading="lazy"
                title={badge.info.title}
                className="w-5 h-5 inline-block cursor-pointer hover:scale-110 transition-transform crisp-image"
                onClick={() => onBadgeClick?.(badge.key, badge.info)}
                onError={(e) => {
                  Logger.warn('[Badge] Failed to load badge:', badge.key, badge.info.image_url_1x);
                  e.currentTarget.style.display = 'none';
                }}
              />
            );
          })}
          {seventvBadge && (
            <button
              onClick={() => useAppStore.getState().openBadgesWithBadge(seventvBadge.id)}
              className="inline-block cursor-pointer hover:scale-110 transition-transform"
              title={`Click for details: ${seventvBadge.description || seventvBadge.name}`}
            >
              <FallbackImage
                src={getBadgeImageUrl(seventvBadge)}
                fallbackUrls={getBadgeFallbackUrls(seventvBadge.id).slice(1)}
                alt={seventvBadge.description || seventvBadge.name}
                className="w-5 h-5 inline-block crisp-image"
              />
            </button>
          )}
          {thirdPartyBadges.filter(badge => badge && badge.imageUrl).map((badge, idx) => (
            <img
              key={`bits-tp-badge-${badge.id}-${idx}`}
              src={badge.imageUrl}
              alt={badge.title}
              title={`${badge.title} (${badge.provider.toUpperCase()})`}
              className="w-5 h-5 inline-block crisp-image"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ))}
        </span>
      );
    };

    // Use dynamic spacing from user settings
    const eventPadding = calculateHalfPadding(chatDesign?.message_spacing ?? 8);

    return (
      <div key={messageId} className="px-3 border-b border-borderSubtle bits-gradient" style={{ paddingTop: `${eventPadding}px`, paddingBottom: `${eventPadding}px` }}>
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

    // Helper function to render username as clickable
    const renderClickableUsername = (username: string, displayName?: string) => {
      const userIdForClick = userId;
      return (
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
          title="Click to view profile"
        >
          {displayName || username}
        </span>
      );
    };

    // Helper function to render badges
    const renderBadges = () => {
      if (parsed.badges.length === 0 && !seventvBadge && thirdPartyBadges.length === 0) return null;

      return (
        <span className="inline-flex items-center gap-1 mr-1">
          {parsed.badges.map((badge, idx) => {
            if (!badge.info) return null;
            return (
              <img
                key={`donation-badge-${badge.key}-${idx}`}
                src={getTwitchBadgeUrl(badge.key, badge.info)}
                alt={badge.info.title}
                loading="lazy"
                title={badge.info.title}
                className="w-5 h-5 inline-block cursor-pointer hover:scale-110 transition-transform crisp-image"
                onClick={() => onBadgeClick?.(badge.key, badge.info)}
                onError={(e) => {
                  Logger.warn('[Badge] Failed to load badge:', badge.key, badge.info.image_url_1x);
                  e.currentTarget.style.display = 'none';
                }}
              />
            );
          })}
          {seventvBadge && (
            <button
              onClick={() => useAppStore.getState().openBadgesWithBadge(seventvBadge.id)}
              className="inline-block cursor-pointer hover:scale-110 transition-transform"
              title={`Click for details: ${seventvBadge.description || seventvBadge.name}`}
            >
              <FallbackImage
                src={getBadgeImageUrl(seventvBadge)}
                fallbackUrls={getBadgeFallbackUrls(seventvBadge.id).slice(1)}
                alt={seventvBadge.description || seventvBadge.name}
                className="w-5 h-5 inline-block crisp-image"
              />
            </button>
          )}
          {thirdPartyBadges.filter(badge => badge && badge.imageUrl).map((badge, idx) => (
            <img
              key={`donation-tp-badge-${badge.id}-${idx}`}
              src={badge.imageUrl}
              alt={badge.title}
              title={`${badge.title} (${badge.provider.toUpperCase()})`}
              className="w-5 h-5 inline-block crisp-image"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ))}
        </span>
      );
    };

    // Use dynamic spacing from user settings
    const eventPadding = calculateHalfPadding(chatDesign?.message_spacing ?? 8);

    return (
      <div key={messageId} className="px-3 border-b border-borderSubtle donation-gradient" style={{ paddingTop: `${eventPadding}px`, paddingBottom: `${eventPadding}px` }}>
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
                  title={`Switch to ${fetchedChannelName}'s stream`}
                >
                  {fetchedChannelName}
                </button>
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
          title="Click to view profile"
        >
          {displayNameProp || username}
        </span>
      );
    };

    // Helper function to render badges
    const renderBadges = () => {
      if (parsed.badges.length === 0 && !seventvBadge && thirdPartyBadges.length === 0) return null;

      return (
        <span className="inline-flex items-center gap-1 mr-1">
          {parsed.badges.map((badge, idx) => {
            if (!badge.info) return null;
            return (
              <img
                key={`watchstreak-badge-${badge.key}-${idx}`}
                src={getTwitchBadgeUrl(badge.key, badge.info)}
                alt={badge.info.title}
                title={badge.info.title}
                className="w-5 h-5 inline-block cursor-pointer hover:scale-110 transition-transform crisp-image"
                onClick={() => onBadgeClick?.(badge.key, badge.info)}
                onError={(e) => {
                  Logger.warn('[Badge] Failed to load badge:', badge.key, badge.info.image_url_1x);
                  e.currentTarget.style.display = 'none';
                }}
              />
            );
          })}
          {seventvBadge && (
            <button
              onClick={() => useAppStore.getState().openBadgesWithBadge(seventvBadge.id)}
              className="inline-block cursor-pointer hover:scale-110 transition-transform"
              title={`Click for details: ${seventvBadge.description || seventvBadge.name}`}
            >
              <FallbackImage
                src={getBadgeImageUrl(seventvBadge)}
                fallbackUrls={getBadgeFallbackUrls(seventvBadge.id).slice(1)}
                alt={seventvBadge.description || seventvBadge.name}
                className="w-5 h-5 inline-block crisp-image"
              />
            </button>
          )}
          {thirdPartyBadges.filter(badge => badge && badge.imageUrl).map((badge, idx) => (
            <img
              key={`watchstreak-tp-badge-${badge.id}-${idx}`}
              src={badge.imageUrl}
              alt={badge.title}
              title={`${badge.title} (${badge.provider.toUpperCase()})`}
              className="w-5 h-5 inline-block crisp-image"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ))}
        </span>
      );
    };

    // Use dynamic spacing from user settings
    const eventPadding = calculateHalfPadding(chatDesign?.message_spacing ?? 8);

    return (
      <div key={messageId} className="px-3 border-b border-borderSubtle watchstreak-gradient" style={{ paddingTop: `${eventPadding}px`, paddingBottom: `${eventPadding}px` }}>
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
    const msgParamSubPlanName = parsed.tags.get('msg-param-sub-plan-name')?.replace(/\\s/g, ' ');
    const msgParamMonths = parsed.tags.get('msg-param-cumulative-months') || parsed.tags.get('msg-param-months');
    const msgParamMassGiftCount = parsed.tags.get('msg-param-mass-gift-count');
    const msgParamSenderCount = parsed.tags.get('msg-param-sender-count');

    // Check if this is a shared chat notice (from another channel)
    const isSharedChat = subMsgId === 'sharedchatnotice';
    const isFromDifferentChannel = isSharedChat && isFromSharedChat;

    // Helper function to render username as clickable
    const renderClickableUsername = (username: string, displayName?: string) => {
      const userIdForClick = userId; // Use the userId from the message
      return (
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
          title="Click to view profile"
        >
          {displayName || username}
        </span>
      );
    };

    // Helper function to render badges
    const renderBadges = () => {
      if (parsed.badges.length === 0 && !seventvBadge && thirdPartyBadges.length === 0) return null;

      return (
        <span className="inline-flex items-center align-middle gap-1 mr-1">
          {parsed.badges.map((badge, idx) => {
            if (!badge.info) return null;
            return (
              <img
                key={`sub-badge-${badge.key}-${idx}`}
                src={getTwitchBadgeUrl(badge.key, badge.info)}
                alt={badge.info.title}
                title={badge.info.title}
                className="w-5 h-5 inline-block cursor-pointer hover:scale-110 transition-transform crisp-image"
                onClick={() => onBadgeClick?.(badge.key, badge.info)}
                onError={(e) => {
                  Logger.warn('[Badge] Failed to load badge:', badge.key, badge.info.image_url_1x);
                  e.currentTarget.style.display = 'none';
                }}
              />
            );
          })}
          {seventvBadge && (
            <button
              onClick={() => useAppStore.getState().openBadgesWithBadge(seventvBadge.id)}
              className="inline-block cursor-pointer hover:scale-110 transition-transform"
              title={`Click for details: ${seventvBadge.description || seventvBadge.name}`}
            >
              <FallbackImage
                src={getBadgeImageUrl(seventvBadge)}
                fallbackUrls={getBadgeFallbackUrls(seventvBadge.id).slice(1)}
                alt={seventvBadge.description || seventvBadge.name}
                className="w-5 h-5 inline-block crisp-image"
              />
            </button>
          )}
          {thirdPartyBadges.filter(badge => badge && badge.imageUrl).map((badge, idx) => (
            <img
              key={`sub-tp-badge-${badge.id}-${idx}`}
              src={badge.imageUrl}
              alt={badge.title}
              title={`${badge.title} (${badge.provider.toUpperCase()})`}
              className="w-5 h-5 inline-block crisp-image"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ))}
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
      const [userBadges, setUserBadges] = useState<Array<{ key: string; info: any }>>([]);

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

      const userStyle = useMemo(() => {
        if (!userPaint) {
          return { color: '#9147FF' }; // Default Twitch purple
        }
        return computePaintStyle(userPaint, '#9147FF');
      }, [userPaint]);

      return (
        <span className="inline-flex items-center align-middle">
          {userBadge && (
            <span className="inline-flex items-center align-middle gap-1 mr-1">
              <img
                src={getBadgeImageUrl(userBadge)}
                alt={userBadge.description || userBadge.name}
                title={userBadge.description || userBadge.name}
                className="w-5 h-5 inline-block crisp-image"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            </span>
          )}
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
            title="Click to view profile"
          >
            {displayName || username}
          </span>
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
                title="Click to view profile"
              >
                {matchedName}
              </span>
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
      <div key={messageId} className="px-3 border-b border-borderSubtle subscription-gradient" style={{ paddingTop: `${eventPadding}px`, paddingBottom: `${eventPadding}px` }}>
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
                  title={`Switch to ${fetchedChannelName}'s stream`}
                >
                  {fetchedChannelName}
                </button>
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

  // PHASE 3.1 - THE ENDGAME: Use pre-formatted timestamps from Rust
  // Zero Date parsing on main thread!
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
  const borderClass = chatDesign?.show_dividers !== false ? 'border-b border-borderSubtle' : '';

  return (
    <div
      className={`px-3 hover:bg-glass transition-colors ${borderClass} ${animationClass
        } ${isHighlightedMessage ? 'highlight-message-gradient' : ''
        } ${isFirstMessage ? 'bg-gradient-to-r from-purple-500/20 via-purple-400/10 to-transparent' : ''} ${isFromSharedChat ? 'border-l-2 border-l-accent/50 bg-accent/5' : ''
        } ${backgroundClass} ${moderationContext ? 'opacity-50' : ''}`}
      style={{
        ...messageStyle,
        borderLeftColor: (isMentioned || isReplyToMe) && borderLeftColor ? borderLeftColor : undefined,
        borderLeftWidth: (isMentioned || isReplyToMe) ? '4px' : undefined,
      }}
    >

      {/* First message indicator */}
      {isFirstMessage && (
        <div className="flex items-center justify-end gap-1.5">
          <span className="text-xs text-purple-400 font-normal opacity-60">First message in chat</span>
        </div>
      )}
      {/* Highlighted message indicator */}
      {isHighlightedMessage && (
        <div className="flex items-center justify-end gap-1">
          <svg className="w-3 h-3 text-cyan-400 opacity-60" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10 6a4 4 0 014 4h-2a2 2 0 00-2-2V6z" />
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-2 0a6 6 0 11-12 0 6 6 0 0112 0z" clipRule="evenodd" />
          </svg>
          <span className="text-xs text-cyan-400 font-normal opacity-60">Redeemed Highlight My Message</span>
        </div>
      )}
      {/* Reply indicator */}
      {parsed.replyInfo && (
        <div
          className="mb-1.5 pl-2 border-l-2 border-textSecondary/40 cursor-pointer hover:border-textSecondary/60 transition-colors"
          onClick={() => onReplyClick?.(parsed.replyInfo!.parentMsgId)}
          title="Click to view parent message"
        >
          <div className="flex items-center gap-1.5 text-xs text-textSecondary">
            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            <span className="font-semibold">{parsed.replyInfo.parentDisplayName}</span>
            <span className="truncate flex-1">{parsed.replyInfo.parentMsgBody}</span>
          </div>
        </div>
      )}

      <div className="flex items-start">
        {/* Timestamp - displayed first before everything */}
        {formattedTimestamp && (
          <span className="text-textSecondary text-xs mr-1.5 opacity-60 flex-shrink-0 mt-0.5">{formattedTimestamp}</span>
        )}
        {/* Badges and Message content - inline flow so wrapped text starts at left edge */}
        <div className="flex-1 min-w-0">
          {/* Badges */}
          {(isFromSharedChat && channelProfileImage) || parsed.badges.length > 0 || seventvBadge || thirdPartyBadges.length > 0 ? (
            <span className="inline-flex items-center gap-1 mr-1.5 align-middle">
              {/* Shared chat channel profile image badge */}
              {isFromSharedChat && channelProfileImage && (
                <img
                  src={channelProfileImage}
                  alt={`${fetchedChannelName || 'Channel'} profile`}
                  title={`Chatting from ${fetchedChannelName || 'shared channel'}`}
                  className="w-5 h-5 cursor-pointer hover:scale-110 transition-transform object-cover crisp-image"
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
              )}
              {parsed.badges.map((badge, idx) => {
                if (!badge.info) return null;
                return (
                  <img
                    key={`${badge.key}-${idx}`}
                    src={getTwitchBadgeUrl(badge.key, badge.info)}
                    alt={badge.info.title}
                    title={badge.info.title}
                    className="w-5 h-5 cursor-pointer hover:scale-110 transition-transform crisp-image"
                    onClick={() => onBadgeClick?.(badge.key, badge.info)}
                    onError={(e) => {
                      // Hide broken badge images
                      Logger.warn('[Badge] Failed to load badge:', badge.key, badge.info.image_url_1x);
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                );
              })}
              {seventvBadge && (
                <button
                  onClick={() => useAppStore.getState().openBadgesWithBadge(seventvBadge.id)}
                  className="inline-block cursor-pointer hover:scale-110 transition-transform"
                  title={`Click for details: ${seventvBadge.description || seventvBadge.name}`}
                >
                  <FallbackImage
                    src={getBadgeImageUrl(seventvBadge)}
                    fallbackUrls={getBadgeFallbackUrls(seventvBadge.id).slice(1)}
                    alt={seventvBadge.description || seventvBadge.name}
                    className="w-5 h-5 crisp-image"
                  />
                </button>
              )}
              {/* Third-party badges (FFZ, Chatterino, Homies) */}
              {thirdPartyBadges.filter(badge => badge && badge.imageUrl).map((badge, idx) => (
                <img
                  key={`tp-badge-${badge.id}-${idx}`}
                  src={badge.imageUrl}
                  alt={badge.title}
                  title={`${badge.title} (${badge.provider.toUpperCase()})`}
                  className="w-5 h-5 crisp-image"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              ))}
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
                  title="Right-click to reply"
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
                {' '}{renderContent(contentWithEmotes)}
              </span>
            ) : (
              // Regular messages: username in color, content in default color
              <>
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
                  title="Right-click to reply"
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
                <span style={{ fontWeight: 300 }} className="text-textPrimary break-words">
                  {' '}{renderContent(contentWithEmotes)}
                  {moderationContext && (
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
    </div>
  );
}, chatMessageAreEqual);

export default ChatMessage;
