import React, { useRef, useEffect, useCallback, memo } from 'react';
import ChatMessage from './ChatMessage';
import { EmoteSet } from '../services/emoteService';
import { BackendChatMessage } from '../services/twitchChat';
import { ModerationContext } from '../hooks/useTwitchChat';

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
    badges: Array<{ key: string; info: any }>,
    event: React.MouseEvent
  ) => void;
  onReplyClick: (parentMsgId: string) => void;
  onEmoteRightClick: (emoteName: string) => void;
  onUsernameRightClick: (messageId: string, username: string) => void;
  onBadgeClick: (badgeKey: string, badgeInfo: any) => void;
  highlightedMessageId: string | null;
  deletedMessageIds: Set<string>;
  clearedUserContexts: Map<string, ModerationContext>;
  emotes: EmoteSet | null;
  getMessageId: (message: string | BackendChatMessage) => string | null;
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
  onEmoteRightClick,
  onUsernameRightClick,
  onBadgeClick,
  highlightedMessageId,
  deletedMessageIds,
  clearedUserContexts,
  emotes,
  getMessageId,
}: ChatMessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isScrollingProgrammatically = useRef(false);
  const wasAtBottomRef = useRef(true); // Track if we were at bottom BEFORE new messages
  const prevMessageCountRef = useRef(0); // Track previous message count for channel switch detection
  
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    (window as any).__chatScrollToBottom = scrollToBottom;
    return () => {
      delete (window as any).__chatScrollToBottom;
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
      <div className="flex flex-col min-h-full justify-end pt-10">
        {messages.map((message, index) => {
          const messageId = getMessageId(message);
          
          // Check if message is deleted/moderated
          let moderationContext: ModerationContext | null = null;
          
          if (messageId && deletedMessageIds.has(messageId)) {
            // Single message deleted by mod
            moderationContext = { type: 'deleted' };
          } else {
            const userId = typeof message !== 'string'
              ? message.user_id
              : message.match(/user-id=([^;]+)/)?.[1];
            if (userId && clearedUserContexts.has(userId)) {
              moderationContext = clearedUserContexts.get(userId)!;
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
                // Hint for browser about expected size when not rendered
                // This prevents scroll jumping when scrolling quickly
                containIntrinsicBlockSize: 'auto 50px',
              }}
            >
              <ChatMessage
                message={message}
                messageIndex={index}
                onUsernameClick={onUsernameClick}
                onReplyClick={onReplyClick}
                isHighlighted={highlightedMessageId === messageId}
                moderationContext={moderationContext}
                onEmoteRightClick={onEmoteRightClick}
                onUsernameRightClick={onUsernameRightClick}
                onBadgeClick={onBadgeClick}
                emotes={emotes}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default ChatMessageList;
