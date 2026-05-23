import React, { useRef, useEffect, useCallback, useMemo, memo } from 'react';
import ChatMessage from './ChatMessage';
import { EmoteSet } from '../services/emoteService';
import { BackendChatMessage } from '../services/twitchChat';
import { ModerationContext } from '../hooks/useTwitchChat';
import { useAppStore } from '../stores/AppStore';

import { Logger } from '../utils/logger';
interface ChatMessageListProps {
  messages: (string | BackendChatMessage)[];
  isPaused: boolean;
  onScroll: (distanceToBottom: number, isUserScroll: boolean) => void;
  onUsernameClick: (
    userId: string,
    username: string,
    displayName: string,
    color: string,
    badges: Array<{ key: string; info: Record<string, unknown> }>,
    event: React.MouseEvent
  ) => void;
  onReplyClick: (parentMsgId: string) => void;
  onMessageCopy?: (content: string) => void;
  onEmoteRightClick: (emoteName: string) => void;
  onUsernameRightClick: (messageId: string, username: string) => void;
  onBadgeClick: (badgeKey: string, badgeInfo: Record<string, unknown>) => void;
  highlightedMessageId: string | null;
  deletedMessageIds: Set<string>;
  // Messages whose IDs are in this set are filtered out entirely (rendered
  // nothing). Used by /clearmessages for visual-only chat clears, distinct
  // from `deletedMessageIds` which renders moderation context (strikethrough).
  hiddenMessageIds?: Set<string>;
  clearedUserContexts: Map<string, { context: ModerationContext; affectedMessageIds: Set<string> }>;
  emotes: EmoteSet | null;
  getMessageId: (message: string | BackendChatMessage) => string | null;
  isModerator?: boolean;
  broadcasterId?: string;
}

/**
 * ChatMessageList - Scrollable chat message container
 * 
 * Uses CSS `content-visibility: auto` for browser-native virtualization.
 * No JavaScript height estimation or measurement - the browser handles everything.
 * 
 * Benefits:
 * - Zero jitter: Heights are never "estimated" or "corrected"
 * - Stable scrolling: No ResizeObserver callbacks causing layout shifts
 * - Simpler architecture: Just render messages, browser does the rest
 */
const ChatMessageList = memo(function ChatMessageList({
  messages,
  isPaused,
  onScroll,
  onUsernameClick,
  onReplyClick,
  onMessageCopy,
  onEmoteRightClick,
  onUsernameRightClick,
  onBadgeClick,
  highlightedMessageId,
  hiddenMessageIds,
  deletedMessageIds,
  clearedUserContexts,
  emotes,
  getMessageId,
  isModerator,
  broadcasterId,
}: ChatMessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Inner messages-wrapper div. We observe its size with a ResizeObserver so
  // that any height change (badge/emote/cosmetic images settling in after a
  // new message's first paint, content-visibility resolving to a slightly
  // different actual size, etc.) re-pins the scroll to bottom while the user
  // was already there. Without this, every new message left a brief upward
  // shimmer for the time between the first scrollTop=scrollHeight call and
  // when async content finished sizing.
  const contentRef = useRef<HTMLDivElement>(null);
  const isScrollingProgrammatically = useRef(false);
  const wasAtBottomRef = useRef(true); // Track if we were at bottom BEFORE new messages
  const prevMessageCountRef = useRef(0); // Track previous message count for channel switch detection

  // Per-row CSS `contain-intrinsic-block-size` placeholder size. The browser
  // uses this for off-screen messages (content-visibility: auto). Picking a
  // value close to the real rendered height prevents a layout shift on the
  // FIRST render of each message — the prior hardcoded 50px was tuned for
  // single-line messages, which was way off when timestamps add a second line.
  // The `auto` keyword still lets the browser remember the actual size after
  // first render, so this is just the initial-paint guess.
  const chatDesign = useAppStore((s) => s.settings.chat_design);
  const intrinsicSizeCSS = useMemo(() => {
    const fontSize = chatDesign?.font_size ?? 14;
    const messageSpacing = chatDesign?.message_spacing ?? 2;
    // One content line ≈ font_size * 1.5 (browser default leading) plus
    // top + bottom padding (each = max(4, spacing / 2)) and the optional
    // 1px divider border underneath.
    const padding = Math.max(4, messageSpacing / 2) * 2;
    const contentLine = Math.round(fontSize * 1.5);
    // Timestamp row is a 10px text line with line-height tight (~1.25) plus
    // mb-0.5 (~2px). Total ≈ 14-15px when enabled.
    const timestampHeight = chatDesign?.show_timestamps ? 15 : 0;
    const total = contentLine + timestampHeight + padding + 1; // +1 for divider
    return `auto ${total}px`;
  }, [chatDesign?.font_size, chatDesign?.message_spacing, chatDesign?.show_timestamps]);
  
  // Track if user explicitly scrolled UP via wheel (negative deltaY = scroll up)
  // This is the ONLY reliable way to detect user scroll intent
  // Flag persists until user scrolls DOWN or reaches bottom
  const userScrolledUpRef = useRef(false);
  const lastTouchY = useRef(0);

  // Handle wheel events - detect scroll-up intent directly from deltaY
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY < 0) {
      // Scrolling UP (away from bottom)
      Logger.debug('[ChatMessageList] 🔼 WHEEL UP detected, setting userScrolledUpRef=true');
      userScrolledUpRef.current = true;
    } else if (e.deltaY > 0) {
      // Scrolling DOWN (toward bottom) - clear the flag
      userScrolledUpRef.current = false;
    }
  }, []);

  // Handle touch scrolling - track direction via Y position change
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    lastTouchY.current = e.touches[0].clientY;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const currentY = e.touches[0].clientY;
    const deltaY = lastTouchY.current - currentY; // positive = scrolling up
    lastTouchY.current = currentY;
    
    if (deltaY > 0) {
      // Swiping up (scrolling up, away from bottom)
      userScrolledUpRef.current = true;
    } else if (deltaY < 0) {
      // Swiping down (scrolling down, toward bottom) - clear the flag
      userScrolledUpRef.current = false;
    }
  }, []);

  // ResizeObserver: re-pin to bottom whenever the inner messages-wrapper
  // grows (badge/emote images settling, paint shaders sizing, etc.). This is
  // the secondary safety net beyond the explicit auto-scroll-on-new-message
  // effect below — it catches any height change the explicit path missed,
  // and is the actual fix for the "timestamp shimmer" where a new row's
  // height grows a few pixels after first paint.
  useEffect(() => {
    if (!contentRef.current) return;
    const target = contentRef.current;
    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      if (isPaused) return;
      // Only re-pin when the user was already at bottom — never YANK them
      // down if they've scrolled up to read history.
      if (!wasAtBottomRef.current) return;
      isScrollingProgrammatically.current = true;
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      // Brief lock so the synthetic scroll event the browser emits doesn't
      // get interpreted as a "user scrolled away" event.
      setTimeout(() => {
        isScrollingProgrammatically.current = false;
      }, 60);
    });
    ro.observe(target);
    return () => ro.disconnect();
  }, [isPaused]);

  // Auto-scroll to bottom when new messages arrive
  // SIMPLE RULE: If not paused, always scroll to bottom
  const lastMessageId = messages.length > 0 ? getMessageId(messages[messages.length - 1]) : null;

  useEffect(() => {
    if (!containerRef.current) return;
    
    const prevCount = prevMessageCountRef.current;
    const currentCount = messages.length;
    
    // Detect channel switch: messages went from 0 to N (bulk load from IVR history)
    const isChannelLoad = prevCount === 0 && currentCount > 0;
    
    // Update ref for next render
    prevMessageCountRef.current = currentCount;
    
    // If paused (and not a channel load), don't auto-scroll
    if (!isChannelLoad && isPaused) return;
    
    // NOT PAUSED: Always scroll to bottom
    // Use double-scroll pattern to ensure we catch the final height after content-visibility resolves
    
    // First scroll: immediate RAF to catch initial render
    requestAnimationFrame(() => {
      if (!containerRef.current) return;
      isScrollingProgrammatically.current = true;
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      wasAtBottomRef.current = true;
    });
    
    // Second scroll: short delay to catch content-visibility final height calculation
    // This fixes the issue where new messages appear partially behind the input box
    setTimeout(() => {
      if (!containerRef.current || isPaused) return;
      isScrollingProgrammatically.current = true;
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      wasAtBottomRef.current = true;
      
      // Extend lock to 150ms to swallow any layout-shift scroll events
      setTimeout(() => {
        isScrollingProgrammatically.current = false;
      }, 150);
    }, 50);
    
    // For channel loads, do a third scroll after longer delay
    if (isChannelLoad) {
      setTimeout(() => {
        if (containerRef.current) {
          isScrollingProgrammatically.current = true;
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
          setTimeout(() => {
            isScrollingProgrammatically.current = false;
          }, 150);
        }
      }, 150);
    }
  }, [lastMessageId, isPaused, messages.length]); // Track lastMessageId to handle buffer trimming updates

  // Handle scroll events - this updates wasAtBottomRef for the NEXT message arrival
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const distanceToBottom = scrollHeight - clientHeight - scrollTop;
    
    // Update "was at bottom" state (used by the NEXT render's auto-scroll check)
    // Only update if this wasn't a programmatic scroll
    if (!isScrollingProgrammatically.current) {
      const atBottom = distanceToBottom < 100;
      wasAtBottomRef.current = atBottom;
      
      // Only report as user scroll if:
      // 1. User explicitly scrolled UP via wheel/touch (userScrolledUpRef is true)
      // 2. AND we're actually away from bottom now
      const isUserScroll = userScrolledUpRef.current && distanceToBottom > 50;
      
      // Clear flag only when reaching bottom (user scrolled back down)
      if (atBottom) {
        userScrolledUpRef.current = false;
      }
      
      onScroll(distanceToBottom, isUserScroll);
    } else {
      // For programmatic scrolls, we ARE at bottom
      wasAtBottomRef.current = true;
      userScrolledUpRef.current = false; // Clear any stale flag
    }
  }, [onScroll]);

  // Scroll to bottom (for resume button)
  const scrollToBottom = useCallback(() => {
    if (!containerRef.current) return;
    isScrollingProgrammatically.current = true;
    wasAtBottomRef.current = true;
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
    requestAnimationFrame(() => {
      isScrollingProgrammatically.current = false;
    });
  }, []);

  // Expose scrollToBottom to parent via ref callback pattern
  useEffect(() => {
    // This makes the scroll function available outside
    (window as Window & typeof globalThis & { __chatScrollToBottom?: () => void }).__chatScrollToBottom = scrollToBottom;
    return () => {
      delete (window as Window & typeof globalThis & { __chatScrollToBottom?: () => void }).__chatScrollToBottom;
    };
  }, [scrollToBottom]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto overflow-x-hidden scrollbar-thin"
      onScroll={handleScroll}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      style={{ overflowAnchor: 'auto' }} // Ensure browser helps anchor to bottom
    >
      {/* Messages container with native virtualization - pt-10 for header */}
      <div ref={contentRef} className="flex flex-col min-h-full justify-end pt-10">
        {messages.map((message, index) => {
          const messageId = getMessageId(message);
          
          // /clearmessages — skip rendering entirely for messages snapshotted
          // into the locally-hidden set. Distinct from the deleted/moderated
          // path below, which renders strikethrough chrome.
          if (messageId && hiddenMessageIds?.has(messageId)) {
            return null;
          }

          // Check if message is deleted/moderated
          let moderationContext: ModerationContext | null = null;

          if (messageId && deletedMessageIds.has(messageId)) {
            // Single message deleted by mod
            moderationContext = { type: 'deleted' };
          } else if (messageId) {
            const userId = typeof message !== 'string'
              ? message.user_id
              : message.match(/user-id=([^;]+)/)?.[1];
            if (userId && clearedUserContexts.has(userId)) {
              const entry = clearedUserContexts.get(userId)!;
              if (entry.affectedMessageIds.has(messageId)) {
                moderationContext = entry.context;
              }
            }
          }

          return (
            <div
              key={messageId || `msg-${index}`}
              data-message-id={messageId || undefined}
              className="chat-message-row"
              style={{
                // Native virtualization: browser skips rendering off-screen items
                contentVisibility: 'auto',
                // Hint for browser about expected size when not rendered.
                // Computed per-user from font size, spacing, and whether
                // timestamps are on — the prior fixed 50px caused visible
                // layout shifts on every new message when timestamps were
                // enabled (real height was ~45-50px, close enough to the
                // placeholder that the FIRST-paint mismatch shimmered).
                containIntrinsicBlockSize: intrinsicSizeCSS,
              }}
            >
              <ChatMessage
                message={message}
                messageIndex={index}
                onUsernameClick={onUsernameClick}
                onReplyClick={onReplyClick}
                onMessageCopy={onMessageCopy}
                isHighlighted={highlightedMessageId === messageId}
                moderationContext={moderationContext}
                onEmoteRightClick={onEmoteRightClick}
                onUsernameRightClick={onUsernameRightClick}
                onBadgeClick={onBadgeClick}
                emotes={emotes}
                isModerator={isModerator}
                broadcasterId={broadcasterId}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default ChatMessageList;
