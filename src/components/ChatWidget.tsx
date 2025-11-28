import React, { useEffect, useRef, useState, useMemo, useCallback, useLayoutEffect, memo } from 'react';
import { VariableSizeList as List } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useTwitchChat } from '../hooks/useTwitchChat';
import { useAppStore } from '../stores/AppStore';
import ChatMessage from './ChatMessage';
import UserProfileCard from './UserProfileCard';
import { fetchAllEmotes, Emote, EmoteSet } from '../services/emoteService';
import { initializeBadges, getBadgeInfo } from '../services/twitchBadges';
import { parseMessage } from '../services/twitchChat';
import { fetchStreamViewerCount } from '../services/twitchService';
import {
  loadFavoriteEmotes,
  addFavoriteEmote,
  removeFavoriteEmote,
  isFavoriteEmote,
  getAvailableFavorites,
  getFavoriteEmotes
} from '../services/favoriteEmoteService';

interface ParsedMessage {
  username: string;
  content: string;
  color: string;
  badges: Array<{ key: string; info: any }>;
  tags: Map<string, string>;
  emotes: string;
}

// ChatMessageRow component with ResizeObserver for dynamic height measurement
interface ChatMessageRowProps {
  message: string;
  messageIndex: number;
  messageId: string | null;
  emoteSet: EmoteSet | null;
  onUsernameClick: (
    userId: string,
    username: string,
    displayName: string,
    color: string,
    badges: Array<{ key: string; info: any }>,
    event: React.MouseEvent
  ) => void;
  onReplyClick: (parentMsgId: string) => void;
  isHighlighted: boolean;
  onEmoteRightClick: (emoteName: string) => void;
  onUsernameRightClick: (messageId: string, username: string) => void;
  onBadgeClick: (badgeKey: string, badgeInfo: any) => void;
  setItemSize: (index: number, size: number, messageId?: string | null) => void;
}

const ChatMessageRow = memo(({
  message,
  messageIndex,
  messageId,
  emoteSet,
  onUsernameClick,
  onReplyClick,
  isHighlighted,
  onEmoteRightClick,
  onUsernameRightClick,
  onBadgeClick,
  setItemSize,
}: ChatMessageRowProps) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const lastHeightRef = useRef<number>(0);
  const heightStableRef = useRef<boolean>(false);
  const measureTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) return;

    const measureHeight = (isInitial: boolean = false) => {
      if (element) {
        const height = element.getBoundingClientRect().height;
        // Only update if height changed significantly (more than 2px)
        // and if this is initial measurement OR height hasn't stabilized yet
        if (Math.abs(height - lastHeightRef.current) > 2) {
          lastHeightRef.current = height;
          heightStableRef.current = false;
          setItemSize(messageIndex, height, messageId);

          // Mark as stable after a delay if no more changes
          if (measureTimeoutRef.current) {
            clearTimeout(measureTimeoutRef.current);
          }
          measureTimeoutRef.current = setTimeout(() => {
            heightStableRef.current = true;
          }, 500);
        } else if (isInitial) {
          // First measurement, always report
          lastHeightRef.current = height;
          setItemSize(messageIndex, height, messageId);
        }
      }
    };

    measureHeight(true);

    observerRef.current = new ResizeObserver((entries) => {
      // Skip updates if height has stabilized (prevents animation jitter)
      if (heightStableRef.current) return;

      for (const entry of entries) {
        const height = entry.contentRect.height;
        const computedStyle = getComputedStyle(entry.target);
        const paddingTop = parseFloat(computedStyle.paddingTop) || 0;
        const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0;
        const totalHeight = height + paddingTop + paddingBottom;

        // Only update for significant height changes (more than 3px)
        if (Math.abs(totalHeight - lastHeightRef.current) > 3) {
          lastHeightRef.current = totalHeight;
          setItemSize(messageIndex, totalHeight, messageId);

          // Reset stability timer
          if (measureTimeoutRef.current) {
            clearTimeout(measureTimeoutRef.current);
          }
          measureTimeoutRef.current = setTimeout(() => {
            heightStableRef.current = true;
          }, 500);
        }
      }
    });

    observerRef.current.observe(element);

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      if (measureTimeoutRef.current) {
        clearTimeout(measureTimeoutRef.current);
      }
    };
  }, [messageIndex, messageId, setItemSize]);

  return (
    <div ref={rowRef}>
      <ChatMessage
        message={message}
        emoteSet={emoteSet}
        messageIndex={messageIndex}
        onUsernameClick={onUsernameClick}
        onReplyClick={onReplyClick}
        isHighlighted={isHighlighted}
        onEmoteRightClick={onEmoteRightClick}
        onUsernameRightClick={onUsernameRightClick}
        onBadgeClick={onBadgeClick}
      />
    </div>
  );
});

ChatMessageRow.displayName = 'ChatMessageRow';

const ChatWidget = () => {
  const { messages, connectChat, sendMessage, isConnected, error, setPaused: setBufferPaused } = useTwitchChat();
  const { currentStream, currentUser } = useAppStore();
  const listRef = useRef<List>(null);
  const messageHeightsById = useRef<Map<string, number>>(new Map());
  const rowHeights = useRef<{ [key: number]: number }>({});
  const messageRefs = useRef<{ [key: number]: HTMLDivElement | null }>({});
  const containerHeightRef = useRef<number>(0);
  const prevMessageCountRef = useRef<number>(0);
  const prevFirstMessageIdRef = useRef<string | null>(null);
  const [messageInput, setMessageInput] = useState('');
  const [showEmotePicker, setShowEmotePicker] = useState(false);
  const [emotes, setEmotes] = useState<EmoteSet | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<'twitch' | 'bttv' | '7tv' | 'ffz' | 'favorites'>('twitch');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoadingEmotes, setIsLoadingEmotes] = useState(false);
  const [favoriteEmotes, setFavoriteEmotes] = useState<Emote[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [pausedMessageCount, setPausedMessageCount] = useState(0);
  const isHoveringChatRef = useRef<boolean>(false);

  // Frozen messages snapshot when paused - prevents re-renders from new messages
  const frozenMessagesRef = useRef<string[] | null>(null);
  // Frozen row heights when paused
  const frozenRowHeightsRef = useRef<{ [key: number]: number } | null>(null);

  // SIMPLE SCROLL TRACKING - just track scroll position
  const lastScrollPositionRef = useRef<number>(0);
  const maxScrollPositionRef = useRef<number>(0);
  const lastResumeTimeRef = useRef<number>(0);

  const [viewerCount, setViewerCount] = useState<number | null>(null);
  const streamUptimeRef = useRef<string>('');
  const [, forceUpdate] = useState({});

  const { settings } = useAppStore();
  const prevThemeRef = useRef<string | undefined>(settings.theme);

  const [selectedUser, setSelectedUser] = useState<{
    userId: string;
    username: string;
    displayName: string;
    color: string;
    badges: Array<{ key: string; info: any }>;
    position: { x: number; y: number };
  } | null>(null);

  const userMessageHistory = useRef<Map<string, ParsedMessage[]>>(new Map());
  const connectedChannelRef = useRef<string | null>(null);
  const lastProcessedCountRef = useRef<number>(0);
  const messageIdToIndexRef = useRef<Map<string, number>>(new Map());
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [isSharedChat, setIsSharedChat] = useState<boolean>(false);
  const [replyingTo, setReplyingTo] = useState<{ messageId: string; username: string } | null>(null);

  // Parse messages and track user history
  useEffect(() => {
    const newMessages = messages.slice(lastProcessedCountRef.current);

    newMessages.forEach((message, idx) => {
      const channelIdMatch = message.match(/room-id=([^;]+)/);
      const channelId = channelIdMatch ? channelIdMatch[1] : undefined;
      const parsed = parseMessage(message, channelId);

      const msgId = parsed.tags.get('id');
      if (msgId) {
        const actualIndex = lastProcessedCountRef.current + idx;
        messageIdToIndexRef.current.set(msgId, actualIndex);
      }

      const userId = parsed.tags.get('user-id');
      if (userId) {
        const history = userMessageHistory.current.get(userId) || [];
        history.push(parsed);
        if (history.length > 50) {
          history.shift();
        }
        userMessageHistory.current.set(userId, history);
      }
    });

    lastProcessedCountRef.current = messages.length;
  }, [messages]);

  // Fetch viewer count periodically
  useEffect(() => {
    let intervalId: NodeJS.Timeout;

    const getViewerCount = async () => {
      if (currentStream?.user_login) {
        try {
          const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
          const count = await fetchStreamViewerCount(currentStream.user_login, clientId, token);
          setViewerCount(count);
        } catch (err) {
          console.error('[ChatWidget] Failed to fetch viewer count:', err);
          setViewerCount(null);
        }
      } else {
        setViewerCount(null);
      }
    };

    getViewerCount();
    intervalId = setInterval(getViewerCount, 180000);

    return () => {
      clearInterval(intervalId);
    };
  }, [currentStream?.user_login]);

  // Calculate and update stream uptime
  useEffect(() => {
    let intervalId: NodeJS.Timeout;
    let headerElement: HTMLElement | null = null;

    const updateUptime = () => {
      if (currentStream?.started_at) {
        const startTime = new Date(currentStream.started_at).getTime();
        const now = Date.now();
        const diffMs = now - startTime;

        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

        let uptimeString = '';
        if (hours > 0) {
          uptimeString = `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        } else {
          uptimeString = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }

        streamUptimeRef.current = uptimeString;

        if (!headerElement) {
          headerElement = document.getElementById('stream-uptime-display');
        }
        if (headerElement) {
          headerElement.textContent = uptimeString;
        }
      } else {
        streamUptimeRef.current = '';
        if (!headerElement) {
          headerElement = document.getElementById('stream-uptime-display');
        }
        if (headerElement) {
          headerElement.textContent = '';
        }
      }
    };

    updateUptime();
    intervalId = setInterval(updateUptime, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, [currentStream?.started_at]);

  // Reset height cache when theme changes
  useEffect(() => {
    const currentTheme = settings.theme;

    if (prevThemeRef.current && prevThemeRef.current !== currentTheme) {
      console.log('[ChatWidget] Theme changed from', prevThemeRef.current, 'to', currentTheme, '- resetting heights');
      rowHeights.current = {};
      messageHeightsById.current.clear();

      if (listRef.current) {
        listRef.current.resetAfterIndex(0, true);
      }
    }

    prevThemeRef.current = currentTheme;
  }, [settings.theme]);

  useEffect(() => {
    if (currentStream?.user_login && connectedChannelRef.current !== currentStream.user_login) {
      console.log('[ChatWidget] Connecting to chat for:', currentStream.user_login, 'User ID:', currentStream.user_id);
      connectedChannelRef.current = currentStream.user_login;
      connectChat(currentStream.user_login);
      loadEmotes(currentStream.user_login, currentStream.user_id);
      userMessageHistory.current.clear();
    }

    return () => {
      if (currentStream?.user_login !== connectedChannelRef.current) {
        connectedChannelRef.current = null;
      }
    };
  }, [currentStream?.user_login, currentStream?.user_id]);

  // Handle auto-scroll when not paused - SIMPLIFIED
  useEffect(() => {
    if (!listRef.current || messages.length === 0) return;

    const lastIndex = messages.length - 1;

    // Only update the list and scroll if NOT paused
    // This prevents visible items from re-rendering when paused
    if (!isPaused) {
      listRef.current.resetAfterIndex(Math.max(0, lastIndex - 1));
      listRef.current.scrollToItem(lastIndex, 'end');
      // Reset max scroll position after programmatic scroll
      // This prevents false pauses when heights change
      setTimeout(() => {
        maxScrollPositionRef.current = lastScrollPositionRef.current;
      }, 50);
    }
  }, [messages, isPaused]);

  // Store message count and freeze messages when pausing
  useEffect(() => {
    if (isPaused && pausedMessageCount === 0) {
      setPausedMessageCount(messages.length);
      // Freeze the messages array to prevent re-renders
      frozenMessagesRef.current = [...messages];
      // Also freeze the row heights
      frozenRowHeightsRef.current = { ...rowHeights.current };
    } else if (!isPaused) {
      setPausedMessageCount(0);
      // Unfreeze messages and heights
      frozenMessagesRef.current = null;
      frozenRowHeightsRef.current = null;
    }
  }, [isPaused, messages.length]);

  const getMessageId = useCallback((message: string): string | null => {
    const idMatch = message.match(/(?:^|;)id=([^;]+)/);
    return idMatch ? idMatch[1] : null;
  }, []);

  // Sync row heights from message ID map
  // Only run this when NOT paused to avoid disrupting frozen state
  useEffect(() => {
    // Skip all updates when paused and using frozen messages
    if (isPaused && frozenMessagesRef.current) {
      return;
    }

    const newRowHeights: { [key: number]: number } = {};

    messages.forEach((message, index) => {
      const msgId = getMessageId(message);
      if (msgId && messageHeightsById.current.has(msgId)) {
        newRowHeights[index] = messageHeightsById.current.get(msgId)!;
      }
    });

    rowHeights.current = newRowHeights;

    const currentFirstId = messages.length > 0 ? getMessageId(messages[0]) : null;

    prevMessageCountRef.current = messages.length;
    prevFirstMessageIdRef.current = currentFirstId;

    const cacheBufferAllowance = 50;
    if (messageHeightsById.current.size > messages.length + cacheBufferAllowance) {
      const currentIds = new Set(messages.map(m => getMessageId(m)).filter(Boolean));
      for (const [id] of messageHeightsById.current) {
        if (!currentIds.has(id)) {
          messageHeightsById.current.delete(id);
        }
      }
    }
  }, [messages, isPaused, getMessageId]);

  const getItemSize = useCallback((index: number) => {
    // Use frozen heights when paused
    if (isPaused && frozenRowHeightsRef.current) {
      if (frozenRowHeightsRef.current[index]) {
        return frozenRowHeightsRef.current[index];
      }
      // Check by message ID in frozen messages
      const frozenMessages = frozenMessagesRef.current;
      if (frozenMessages && frozenMessages[index]) {
        const msgId = getMessageId(frozenMessages[index]);
        if (msgId && messageHeightsById.current.has(msgId)) {
          return messageHeightsById.current.get(msgId)!;
        }
      }
      return 60;
    }

    // Normal mode - use live row heights
    if (rowHeights.current[index]) {
      return rowHeights.current[index];
    }

    const message = messages[index];
    if (message) {
      const msgId = getMessageId(message);
      if (msgId && messageHeightsById.current.has(msgId)) {
        const height = messageHeightsById.current.get(msgId)!;
        rowHeights.current[index] = height;
        return height;
      }
    }

    return 60;
  }, [messages, getMessageId, isPaused]);

  const setItemSize = useCallback((index: number, size: number, messageId?: string | null) => {
    const currentSize = rowHeights.current[index] || 0;
    const sizeDiff = Math.abs(currentSize - size);

    if (sizeDiff > 1) {
      rowHeights.current[index] = size;

      if (messageId) {
        messageHeightsById.current.set(messageId, size);
      }

      if (listRef.current) {
        listRef.current.resetAfterIndex(index, false);
      }
    }
  }, []);

  // SIMPLIFIED: Handle scroll events - detect if user scrolled UP (away from bottom)
  const handleScroll = useCallback(({ scrollOffset, scrollUpdateWasRequested }: { scrollOffset: number; scrollUpdateWasRequested: boolean }) => {
    // Don't process if we just resumed (within last 500ms)
    if (Date.now() - lastResumeTimeRef.current < 500) {
      lastScrollPositionRef.current = scrollOffset;
      maxScrollPositionRef.current = Math.max(maxScrollPositionRef.current, scrollOffset);
      return;
    }

    // Only check for manual scrolls (not programmatic)
    if (!scrollUpdateWasRequested) {
      // Calculate if we're significantly away from the maximum scroll position we've seen
      // This handles the case where heights change and scroll position adjusts
      const scrolledAwayFromMax = maxScrollPositionRef.current - scrollOffset > 50; // 50px threshold

      // Only pause if:
      // 1. We've scrolled away from the max by a significant amount
      // 2. The scroll position is actually decreasing (user scrolling up)
      // 3. We're not already at/near the beginning
      if (scrolledAwayFromMax && scrollOffset < lastScrollPositionRef.current - 10 && scrollOffset > 100) {
        if (!isPaused) {
          setIsPaused(true);
          setBufferPaused(true);
          console.log('[Chat] Paused - scrolled away from max. Current:', scrollOffset, 'Max:', maxScrollPositionRef.current);
        }
      }
    }

    lastScrollPositionRef.current = scrollOffset;
    maxScrollPositionRef.current = Math.max(maxScrollPositionRef.current, scrollOffset);
  }, [isPaused, setBufferPaused]);

  // Resume chat (scroll to bottom)
  const handleResume = () => {
    lastResumeTimeRef.current = Date.now();
    setIsPaused(false);
    setBufferPaused(false);

    if (listRef.current && messages.length > 0) {
      listRef.current.scrollToItem(messages.length - 1, 'end');
    }
  };

  const handleBadgeClick = useCallback(async (badgeKey: string, badgeInfo: any) => {
    useAppStore.getState().setShowBadgesOverlay(true);
    const [setId] = badgeKey.split('/');
    window.dispatchEvent(new CustomEvent('show-badge-detail', {
      detail: { badge: badgeInfo, setId }
    }));
  }, []);

  const handleReplyClick = useCallback((parentMsgId: string) => {
    // Search for the message directly in the current messages array
    // This is more reliable than using the cached index which can become stale
    const parentIndex = messages.findIndex(msg => {
      const msgId = getMessageId(msg);
      return msgId === parentMsgId;
    });

    if (parentIndex !== -1 && listRef.current) {
      // Pause auto-scroll
      setIsPaused(true);
      setBufferPaused(true);

      // Account for padding item if present
      const containerHeight = containerHeightRef.current || 0;
      const totalHeight = Object.values(rowHeights.current).reduce((sum, h) => sum + h, 0);
      const needsPadding = totalHeight < containerHeight;
      const actualIndex = needsPadding ? parentIndex + 1 : parentIndex;

      // Scroll to the parent message
      listRef.current.scrollToItem(actualIndex, 'center');

      // Highlight the message
      setHighlightedMessageId(parentMsgId);

      // Remove highlight after animation completes
      setTimeout(() => {
        setHighlightedMessageId(null);
      }, 2000);

      console.log('[Chat] Scrolled to parent message at index:', parentIndex, 'actual:', actualIndex);
    } else {
      console.warn('[Chat] Parent message not found in current chat history:', parentMsgId);
      useAppStore.getState().addToast('Parent message not found in current chat history', 'info');
    }
  }, [messages, getMessageId, setBufferPaused]);

  const loadEmotes = async (channelName: string, channelId?: string) => {
    setIsLoadingEmotes(true);
    try {
      console.log('[ChatWidget] Initializing badges for channel:', channelName, 'ID:', channelId);
      try {
        const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
        console.log('[ChatWidget] Got credentials, initializing badges...');
        await initializeBadges(clientId, token, channelId);
        console.log('[ChatWidget] Badges initialized successfully');
      } catch (err) {
        console.error('[ChatWidget] Failed to initialize badges:', err);
      }

      const emoteSet = await fetchAllEmotes(channelName, channelId);
      setEmotes(emoteSet);

      const favorites = await loadFavoriteEmotes();
      console.log('[ChatWidget] Loaded favorite emotes:', favorites.length);

      if (emoteSet) {
        const allEmotes = [
          ...emoteSet.twitch,
          ...emoteSet.bttv,
          ...emoteSet['7tv'],
          ...emoteSet.ffz
        ];
        const availableFavorites = getAvailableFavorites(allEmotes);
        setFavoriteEmotes(availableFavorites);
        console.log('[ChatWidget] Available favorites in this chat:', availableFavorites.length);
      }
    } catch (err) {
      console.error('Failed to load emotes:', err);
    } finally {
      setIsLoadingEmotes(false);
    }
  };

  // Initialize badges for shared chat channels
  useEffect(() => {
    const initializeSharedChannelBadges = async () => {
      const sourceRoomIds = new Set<string>();
      let hasSharedMessages = false;

      messages.forEach(message => {
        const sourceRoomIdMatch = message.match(/source-room-id=([^;]+)/);
        const roomIdMatch = message.match(/room-id=([^;]+)/);

        if (sourceRoomIdMatch && roomIdMatch) {
          const sourceRoomId = sourceRoomIdMatch[1];
          const roomId = roomIdMatch[1];

          if (sourceRoomId !== roomId) {
            sourceRoomIds.add(sourceRoomId);
            hasSharedMessages = true;
          }
        }
      });

      setIsSharedChat(hasSharedMessages);

      if (sourceRoomIds.size > 0) {
        try {
          const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');

          for (const sourceRoomId of sourceRoomIds) {
            console.log('[ChatWidget] Initializing badges for shared channel:', sourceRoomId);
            try {
              await initializeBadges(clientId, token, sourceRoomId);
              console.log('[ChatWidget] Badges initialized for shared channel:', sourceRoomId);
            } catch (err) {
              console.warn('[ChatWidget] Failed to initialize badges for shared channel:', sourceRoomId, err);
            }
          }
        } catch (err) {
          console.error('[ChatWidget] Failed to get credentials for shared channel badges:', err);
        }
      }
    };

    initializeSharedChannelBadges();
  }, [messages]);

  const handleSendMessage = async () => {
    if (messageInput.trim() && isConnected && currentUser) {
      const messageToSend = messageInput;
      const replyParentMsgId = replyingTo?.messageId;

      setMessageInput('');
      setReplyingTo(null);
      inputRef.current?.focus();

      try {
        let badgeString = '';
        try {
          const userBadges = await invoke<string>('get_user_badges', {
            userId: currentUser.user_id,
            channelId: currentStream?.user_id
          });
          badgeString = userBadges;
          console.log('[ChatWidget] User badges:', badgeString);
        } catch (badgeErr) {
          console.warn('[ChatWidget] Could not fetch user badges:', badgeErr);
        }

        await sendMessage(messageToSend, {
          username: currentUser.login || currentUser.username,
          displayName: currentUser.display_name || currentUser.username,
          userId: currentUser.user_id,
          color: undefined,
          badges: badgeString
        }, replyParentMsgId);
        console.log('Message sent:', messageToSend);
      } catch (err) {
        console.error('Failed to send message:', err);
        setMessageInput(messageToSend);
        useAppStore.getState().addToast('Failed to send message. Please try again.', 'error');
      }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const insertEmote = (emoteName: string) => {
    setMessageInput(prev => prev + (prev ? ' ' : '') + emoteName + ' ');
    inputRef.current?.focus();
  };

  const handleEmoteRightClick = (emoteName: string) => {
    setMessageInput(prev => {
      if (prev.trim()) {
        return prev + (prev.endsWith(' ') ? '' : ' ') + emoteName + ' ';
      }
      return emoteName + ' ';
    });
    inputRef.current?.focus();
  };

  const handleUsernameRightClick = (messageId: string, username: string) => {
    setReplyingTo({ messageId, username });
    inputRef.current?.focus();
  };

  const getFilteredEmotes = (): Emote[] => {
    if (selectedProvider === 'favorites') {
      const favs = favoriteEmotes;
      if (!searchQuery) return favs;

      const query = searchQuery.toLowerCase();
      return favs.filter((emote: Emote) =>
        emote.name.toLowerCase().includes(query)
      );
    }

    if (!emotes) return [];

    const providerEmotes = emotes[selectedProvider] || [];

    if (!searchQuery) return providerEmotes;

    const query = searchQuery.toLowerCase();
    return providerEmotes.filter((emote: Emote) =>
      emote.name.toLowerCase().includes(query)
    );
  };

  if (!currentStream) {
    return (
      <div className="h-full bg-secondary backdrop-blur-md flex items-center justify-center p-4">
        <p className="text-textSecondary">No stream selected</p>
      </div>
    );
  }

  const showLoadingScreen = !isConnected && messages.length === 0;

  if (showLoadingScreen) {
    return (
      <div className="h-full bg-secondary backdrop-blur-md flex items-center justify-center p-4">
        <p className="text-textSecondary">Connecting to chat...</p>
      </div>
    );
  }

  const filteredEmotes = getFilteredEmotes();

  const handleUsernameClick = async (userId: string, username: string, displayName: string, color: string, badges: Array<{ key: string; info: any }>, event: React.MouseEvent) => {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const { getCurrentWindow } = await import('@tauri-apps/api/window');

      const mainWindow = getCurrentWindow();
      const mainPosition = await mainWindow.outerPosition();
      const mainSize = await mainWindow.outerSize();

      const cardWidth = 320;
      const cardHeight = 600;
      const gap = 10;

      let x = mainPosition.x - cardWidth - gap;
      let y = mainPosition.y;

      if (x < 0) {
        x = mainPosition.x + mainSize.width + gap;
      }

      const windowLabel = `profile-${userId}-${Date.now()}`;
      const messageHistory = userMessageHistory.current.get(userId) || [];

      const params = new URLSearchParams({
        userId,
        username,
        displayName,
        color,
        badges: JSON.stringify(badges),
        channelId: currentStream?.user_id || '',
        channelName: currentStream?.user_login || '',
        messageHistory: JSON.stringify(messageHistory)
      });

      const profileWindow = new WebviewWindow(windowLabel, {
        url: `${window.location.origin}/#/profile?${params.toString()}`,
        title: `${displayName}'s Profile`,
        width: cardWidth,
        height: cardHeight,
        x,
        y,
        resizable: false,
        decorations: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        transparent: true,
        focus: true
      });

      profileWindow.once('tauri://error', (e) => {
        console.error('Error opening profile window:', e);
      });
    } catch (err) {
      console.error('Failed to open profile window:', err);
      let chatRect = { left: event.clientX, top: event.clientY };
      try {
        const chatElement = document.querySelector('.h-full.bg-secondary') as HTMLElement;
        if (chatElement) {
          chatRect = chatElement.getBoundingClientRect();
        }
      } catch (e) {
        console.warn('Could not find chat element for positioning');
      }

      setSelectedUser({
        userId,
        username,
        displayName,
        color,
        badges,
        position: {
          x: chatRect.left,
          y: chatRect.top
        }
      });
    }
  };

  return (
    <>
      <div className="h-full bg-secondary backdrop-blur-md overflow-hidden flex flex-col relative">
        {/* Messages Area */}
        <div
          className="absolute inset-0 overflow-hidden"
          style={{ paddingBottom: '55px' }}
          onMouseEnter={() => { isHoveringChatRef.current = true; }}
          onMouseLeave={() => { isHoveringChatRef.current = false; }}
        >
          {messages.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-textSecondary text-sm">Waiting for messages...</p>
            </div>
          ) : (
            <AutoSizer>
              {({ height, width }) => {
                containerHeightRef.current = height;
                // Use frozen messages when paused to prevent re-renders
                const displayMessages = isPaused && frozenMessagesRef.current
                  ? frozenMessagesRef.current
                  : messages;
                const totalHeight = Object.values(rowHeights.current).reduce((sum, height) => sum + height, 0);
                const needsPadding = totalHeight < height;
                const paddingHeight = needsPadding ? height - totalHeight : 0;

                return (
                  <List
                    ref={listRef}
                    height={height}
                    itemCount={displayMessages.length + (needsPadding ? 1 : 0)}
                    itemSize={(index) => {
                      if (needsPadding && index === 0) {
                        return paddingHeight;
                      }
                      const messageIndex = needsPadding ? index - 1 : index;
                      return getItemSize(messageIndex);
                    }}
                    width={width}
                    className="scrollbar-thin"
                    onScroll={handleScroll}
                    estimatedItemSize={60}
                    initialScrollOffset={displayMessages.length > 0 ? 999999 : 0}
                  >
                    {({ index, style }) => {
                      if (needsPadding && index === 0) {
                        return <div style={style} />;
                      }

                      const messageIndex = needsPadding ? index - 1 : index;
                      const currentMessage = displayMessages[messageIndex];
                      const currentMsgId = getMessageId(currentMessage);

                      return (
                        <div style={style}>
                          <ChatMessageRow
                            message={currentMessage}
                            messageIndex={messageIndex}
                            messageId={currentMsgId}
                            emoteSet={emotes}
                            onUsernameClick={handleUsernameClick}
                            onReplyClick={handleReplyClick}
                            isHighlighted={highlightedMessageId !== null && currentMessage.includes(`id=${highlightedMessageId}`)}
                            onEmoteRightClick={handleEmoteRightClick}
                            onUsernameRightClick={handleUsernameRightClick}
                            onBadgeClick={handleBadgeClick}
                            setItemSize={setItemSize}
                          />
                        </div>
                      );
                    }}
                  </List>
                );
              }}
            </AutoSizer>
          )}
        </div>

        {/* Pause Indicator */}
        {isPaused && (
          <div className="absolute bottom-[65px] left-1/2 transform -translate-x-1/2 z-50 pointer-events-auto">
            <button
              onClick={handleResume}
              className="flex items-center gap-2 px-4 py-2 glass-button text-white text-sm font-medium rounded-full shadow-lg bg-black/95"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
              <span>Chat Paused ({messages.length - pausedMessageCount} new)</span>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        )}

        {/* Floating Header */}
        <div className={`absolute top-0 left-0 right-0 px-3 py-2 border-b backdrop-blur-ultra z-10 pointer-events-none shadow-lg ${isSharedChat ? 'iridescent-border' : 'border-borderSubtle'}`} style={{ backgroundColor: 'rgba(12, 12, 13, 0.9)' }}>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-400'}`}></div>
            <p className={`text-xs font-semibold ${isSharedChat ? 'iridescent-title' : 'text-textPrimary'}`}>
              {isConnected ? (isSharedChat ? 'SHARED STREAM CHAT' : 'STREAM CHAT') : 'DISCONNECTED'}
            </p>
            <div className="flex items-center gap-3 ml-auto">
              {viewerCount !== null && (
                <div className="flex items-center gap-1">
                  <svg className="w-3 h-3 text-textSecondary" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
                    <path fillRule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
                  </svg>
                  <span className="text-xs text-textSecondary">{viewerCount.toLocaleString()}</span>
                </div>
              )}
              {currentStream?.started_at && (
                <div className="flex items-center gap-1">
                  <svg className="w-3 h-3 text-textSecondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span id="stream-uptime-display" className="text-xs text-textSecondary">{streamUptimeRef.current}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Input Area */}
        <div className="absolute bottom-0 left-0 right-0 border-t border-borderSubtle backdrop-blur-ultra z-10" style={{ backgroundColor: 'rgba(12, 12, 13, 0.9)' }}>
          <div className="p-2">
            <div className="relative">
              {/* Emote Picker */}
              {showEmotePicker && (
                <div className="absolute bottom-full left-0 mb-2 w-80 max-w-[calc(100vw-2rem)] h-72 border border-borderSubtle rounded-lg shadow-lg flex flex-col overflow-hidden" style={{ backgroundColor: 'rgba(12, 12, 13, 0.95)' }}>
                  {/* Emote Picker Header */}
                  <div className="p-2 border-b border-borderSubtle">
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search emotes..."
                      className="w-full glass-input text-xs px-3 py-1.5 placeholder-textSecondary"
                    />
                    <div className="flex gap-1 mt-2">
                      <button
                        onClick={() => setSelectedProvider('favorites')}
                        className={`flex-1 px-2 py-1 text-xs rounded transition-all ${selectedProvider === 'favorites'
                            ? 'glass-button text-white'
                            : 'bg-glass text-textSecondary hover:bg-glass-hover'
                          }`}
                      >
                        ★ ({favoriteEmotes.length})
                      </button>
                      <button
                        onClick={() => setSelectedProvider('twitch')}
                        className={`flex-1 px-2 py-1 text-xs rounded transition-all ${selectedProvider === 'twitch'
                            ? 'glass-button text-white'
                            : 'bg-glass text-textSecondary hover:bg-glass-hover'
                          }`}
                      >
                        Twitch ({emotes?.twitch.length || 0})
                      </button>
                      <button
                        onClick={() => setSelectedProvider('bttv')}
                        className={`flex-1 px-2 py-1 text-xs rounded transition-all ${selectedProvider === 'bttv'
                            ? 'glass-button text-white'
                            : 'bg-glass text-textSecondary hover:bg-glass-hover'
                          }`}
                      >
                        BTTV ({emotes?.bttv.length || 0})
                      </button>
                      <button
                        onClick={() => setSelectedProvider('7tv')}
                        className={`flex-1 px-2 py-1 text-xs rounded transition-all ${selectedProvider === '7tv'
                            ? 'glass-button text-white'
                            : 'bg-glass text-textSecondary hover:bg-glass-hover'
                          }`}
                      >
                        7TV ({emotes?.['7tv'].length || 0})
                      </button>
                      <button
                        onClick={() => setSelectedProvider('ffz')}
                        className={`flex-1 px-2 py-1 text-xs rounded transition-all ${selectedProvider === 'ffz'
                            ? 'glass-button text-white'
                            : 'bg-glass text-textSecondary hover:bg-glass-hover'
                          }`}
                      >
                        FFZ ({emotes?.ffz.length || 0})
                      </button>
                    </div>
                  </div>

                  {/* Emote Grid */}
                  <div className="flex-1 overflow-y-auto p-3 scrollbar-thin">
                    {isLoadingEmotes ? (
                      <div className="flex items-center justify-center h-32">
                        <p className="text-xs text-textSecondary">Loading emotes...</p>
                      </div>
                    ) : filteredEmotes.length === 0 ? (
                      <div className="flex items-center justify-center h-32">
                        <p className="text-xs text-textSecondary">No emotes found</p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-6 gap-2">
                        {filteredEmotes.map((emote) => {
                          const isFavorited = isFavoriteEmote(emote.id);

                          return (
                            <div key={`${emote.provider}-${emote.id}`} className="relative group">
                              <button
                                onClick={() => insertEmote(emote.name)}
                                className="flex flex-col items-center gap-1 p-2 hover:bg-glass rounded transition-colors w-full"
                                title={emote.name}
                              >
                                <img
                                  src={emote.url}
                                  alt={emote.name}
                                  className="w-7 h-7 object-contain"
                                  onError={(e) => {
                                    e.currentTarget.style.display = 'none';
                                  }}
                                />
                                <span className="text-xs text-textSecondary truncate w-full text-center">
                                  {emote.name}
                                </span>
                              </button>

                              {/* Favorite Star Button */}
                              <button
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  try {
                                    if (isFavorited) {
                                      await removeFavoriteEmote(emote.id);
                                      if (selectedProvider === 'favorites') {
                                        setFavoriteEmotes(prev => prev.filter(e => e.id !== emote.id));
                                      }
                                      useAppStore.getState().addToast(`Removed ${emote.name} from favorites`, 'success');
                                    } else {
                                      await addFavoriteEmote(emote);
                                      if (emotes) {
                                        const allEmotes = [
                                          ...emotes.twitch,
                                          ...emotes.bttv,
                                          ...emotes['7tv'],
                                          ...emotes.ffz
                                        ];
                                        const availableFavorites = getAvailableFavorites(allEmotes);
                                        setFavoriteEmotes(availableFavorites);
                                      }
                                      useAppStore.getState().addToast(`Added ${emote.name} to favorites`, 'success');
                                    }
                                  } catch (err) {
                                    console.error('Failed to toggle favorite:', err);
                                    useAppStore.getState().addToast('Failed to update favorites', 'error');
                                  }
                                }}
                                className={`absolute top-0 right-0 p-1 rounded-bl transition-all ${isFavorited
                                    ? 'text-yellow-400 opacity-100'
                                    : 'text-textSecondary opacity-0 group-hover:opacity-100'
                                  } hover:text-yellow-400 hover:bg-glass`}
                                title={isFavorited ? 'Remove from favorites' : 'Add to favorites'}
                              >
                                <svg className="w-3 h-3" fill={isFavorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} viewBox="0 0 20 20">
                                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                                </svg>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Reply Indicator */}
              {replyingTo && (
                <div className="mb-2 flex items-center gap-2 px-3 py-2 bg-glass rounded-lg border border-borderSubtle">
                  <svg className="w-4 h-4 text-accent flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                  </svg>
                  <span className="text-xs text-textSecondary flex-1">
                    Replying to <span className="text-accent font-semibold">{replyingTo.username}</span>
                  </span>
                  <button
                    onClick={() => setReplyingTo(null)}
                    className="text-textSecondary hover:text-textPrimary transition-colors"
                    title="Cancel reply"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              )}

              {/* Input Field */}
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => setShowEmotePicker(!showEmotePicker)}
                  className="flex-shrink-0 p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all"
                  title="Emotes"
                >
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 100-2 1 1 0 000 2zm7-1a1 1 0 11-2 0 1 1 0 012 0zm-.464 5.535a1 1 0 10-1.415-1.414 3 3 0 01-4.242 0 1 1 0 00-1.415 1.414 5 5 0 007.072 0z" clipRule="evenodd" />
                  </svg>
                </button>

                <button
                  onClick={async () => {
                    if (currentStream?.user_login) {
                      const webview = new WebviewWindow(`subscribe-${currentStream.user_login}`, {
                        url: `https://www.twitch.tv/subs/${currentStream.user_login}`,
                        title: `Subscribe to ${currentStream.user_name}`,
                        width: 800,
                        height: 900,
                        center: true,
                        resizable: true,
                        minimizable: true,
                        maximizable: true,
                      });

                      webview.once('tauri://error', (e) => {
                        console.error('Error opening subscribe window:', e);
                      });
                    }
                  }}
                  className="flex-shrink-0 p-1.5 text-textSecondary hover:text-accent hover:bg-glass rounded transition-all"
                  title="Subscribe to channel"
                  disabled={!currentStream}
                >
                  {(() => {
                    const subscriberBadge = currentStream?.user_id ? getBadgeInfo('subscriber/0', currentStream.user_id) : null;

                    if (subscriberBadge) {
                      return (
                        <img
                          src={subscriberBadge.image_url_2x}
                          alt="Subscribe"
                          className="w-5 h-5"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                      );
                    }

                    return (
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M5 4a2 2 0 00-2 2v3.879a2.5 2.5 0 002.5 2.5h1.879A2.5 2.5 0 0010 14.879V13h3a2 2 0 002-2V6a2 2 0 00-2-2H5zm6 7V9.5a.5.5 0 01.5-.5H13v2h-2zm-3-3.5V6H6v1.5a.5.5 0 00.5.5H8zm0 3H6.5a.5.5 0 01-.5-.5V9h2v1.5zM13 6h-1.5a.5.5 0 00-.5.5V8h2V6z" />
                      </svg>
                    );
                  })()}
                </button>

                <input
                  ref={inputRef}
                  type="text"
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Send a message"
                  className="flex-1 min-w-0 glass-input text-textPrimary text-sm px-3 py-2 placeholder-textSecondary"
                  disabled={!isConnected}
                />

                <button
                  onClick={handleSendMessage}
                  disabled={!messageInput.trim() || !isConnected}
                  className="flex-shrink-0 p-2 glass-button text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Send message"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                </button>
              </div>
            </div>

            {!isConnected && (
              <p className="text-xs text-yellow-400 mt-2">
                Chat is not connected. Messages cannot be sent.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* User Profile Card */}
      {selectedUser && (
        <UserProfileCard
          userId={selectedUser.userId}
          username={selectedUser.username}
          displayName={selectedUser.displayName}
          color={selectedUser.color}
          badges={selectedUser.badges}
          messageHistory={userMessageHistory.current.get(selectedUser.userId) || []}
          onClose={() => setSelectedUser(null)}
          position={selectedUser.position}
        />
      )}
    </>
  );
};

export default ChatWidget;
