import React, { useRef, useEffect, useCallback, memo } from 'react';
import ChatMessage from './ChatMessage';
import { EmoteSet } from '../services/emoteService';
import { BackendChatMessage } from '../services/twitchChat';

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
  clearedUserIds: Set<string>;
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
  clearedUserIds,
  emotes,
  getMessageId,
}: ChatMessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isScrollingProgrammatically = useRef(false);
  const wasAtBottomRef = useRef(true); // Track if we were at bottom BEFORE new messages
  const lastScrollTop = useRef(0);
  const prevMessageCountRef = useRef(0); // Track previous message count for channel switch detection
  
  // User Interaction Guard
  // Tracks the timestamp of the last *actual* user interaction (wheel, touch, click, key)
  // We only count a scroll as "User Scroll" if it happened shortly after an interaction.
  const lastInteractionTime = useRef<number>(0);

  const handleInteraction = useCallback(() => {
    lastInteractionTime.current = Date.now();
  }, []);

  // Auto-scroll to bottom when new messages arrive
  // Key: Use wasAtBottomRef which was set BEFORE new messages rendered
  const lastMessageId = messages.length > 0 ? getMessageId(messages[messages.length - 1]) : null;

  useEffect(() => {
    if (!containerRef.current) return;
    
    const prevCount = prevMessageCountRef.current;
    const currentCount = messages.length;
    
    // Detect channel switch: messages went from 0 to N (bulk load from IVR history)
    // In this case, always scroll to bottom regardless of wasAtBottomRef or isPaused
    const isChannelLoad = prevCount === 0 && currentCount > 0;
    
    // Update ref for next render
    prevMessageCountRef.current = currentCount;
    
    // For normal message flow, respect isPaused
    if (!isChannelLoad && isPaused) return;
    
    // Scroll to bottom if:
    // 1. This is a fresh channel load (messages went 0 -> N) - ALWAYS scroll, OR
    // 2. We were already at bottom (normal message flow)
    if (isChannelLoad || wasAtBottomRef.current) {
      // Use RAF to ensure DOM has painted new content
      requestAnimationFrame(() => {
        if (!containerRef.current) return;
        isScrollingProgrammatically.current = true;
        
        // Force overflow-anchor to auto during programmatic scrolls to let browser help
        containerRef.current.style.overflowAnchor = 'auto';
        
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
        wasAtBottomRef.current = true;
        
        // Extend lock to 150ms to swallow any layout-shift scroll events
        setTimeout(() => {
          isScrollingProgrammatically.current = false;
        }, 150);
      });
      
      // For channel loads, do a second scroll after content-visibility has resolved
      if (isChannelLoad) {
        setTimeout(() => {
          if (containerRef.current) {
            isScrollingProgrammatically.current = true;
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
            setTimeout(() => {
              isScrollingProgrammatically.current = false;
            }, 150);
          }
        }, 100);
      }
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
      wasAtBottomRef.current = distanceToBottom < 100;
      
      // Determine if this was a user scroll (scrolling up)
      // STRICT CHECK: Only consider it a user scroll if:
      // 1. The user actually performed a WHEEL or TOUCH interaction within 500ms
      // 2. AND they are scrolling UP (scrollTop < lastScrollTop) - this ignores layout expansions
      const timeSinceInteraction = Date.now() - lastInteractionTime.current;
      const hasRecentInteraction = timeSinceInteraction < 500;
      
      const isUserScroll = hasRecentInteraction && (scrollTop < lastScrollTop.current - 2);
      
      lastScrollTop.current = scrollTop;
      
      onScroll(distanceToBottom, isUserScroll);
    } else {
      // For programmatic scrolls, we ARE at bottom
      wasAtBottomRef.current = true;
      lastScrollTop.current = scrollTop;
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
      onWheel={handleInteraction}
      onTouchStart={handleInteraction}
      style={{ overflowAnchor: 'auto' }} // Ensure browser helps anchor to bottom
    >
      {/* Messages container with native virtualization - pt-10 for header */}
      <div className="flex flex-col min-h-full justify-end pt-10">
        {messages.map((message, index) => {
          const messageId = getMessageId(message);
          
          // Check if message is deleted
          let isDeleted = false;
          if (messageId && deletedMessageIds.has(messageId)) {
            isDeleted = true;
          } else {
            const userId = typeof message !== 'string'
              ? message.user_id
              : message.match(/user-id=([^;]+)/)?.[1];
            if (userId && clearedUserIds.has(userId)) {
              isDeleted = true;
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
                isDeleted={isDeleted}
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
