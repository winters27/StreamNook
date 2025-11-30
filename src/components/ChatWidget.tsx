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
import { getAppleEmojiUrl } from '../services/emojiService';
import { fetchRecentMessagesAsIRC } from '../services/ivrService';

interface ParsedMessage {
  username: string;
  content: string;
  color: string;
  badges: Array<{ key: string; info: any }>;
  tags: Map<string, string>;
  emotes: string;
}

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
        if (Math.abs(height - lastHeightRef.current) > 2) {
          lastHeightRef.current = height;
          heightStableRef.current = false;
          setItemSize(messageIndex, height, messageId);
          if (measureTimeoutRef.current) {
            clearTimeout(measureTimeoutRef.current);
          }
          measureTimeoutRef.current = setTimeout(() => {
            heightStableRef.current = true;
          }, 500);
        } else if (isInitial) {
          lastHeightRef.current = height;
          setItemSize(messageIndex, height, messageId);
        }
      }
    };

    measureHeight(true);

    observerRef.current = new ResizeObserver((entries) => {
      if (heightStableRef.current) return;
      for (const entry of entries) {
        const height = entry.contentRect.height;
        const computedStyle = getComputedStyle(entry.target);
        const paddingTop = parseFloat(computedStyle.paddingTop) || 0;
        const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0;
        const totalHeight = height + paddingTop + paddingBottom;
        if (Math.abs(totalHeight - lastHeightRef.current) > 3) {
          lastHeightRef.current = totalHeight;
          setItemSize(messageIndex, totalHeight, messageId);
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
  const [selectedProvider, setSelectedProvider] = useState<'twitch' | 'bttv' | '7tv' | 'ffz' | 'favorites' | 'emoji'>('twitch');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoadingEmotes, setIsLoadingEmotes] = useState(false);
  const [favoriteEmotes, setFavoriteEmotes] = useState<Emote[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [pausedMessageCount, setPausedMessageCount] = useState(0);
  const isHoveringChatRef = useRef<boolean>(false);
  const frozenMessagesRef = useRef<string[] | null>(null);
  const frozenRowHeightsRef = useRef<{ [key: number]: number } | null>(null);
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
  const lastMessageCountRef = useRef<number>(0);
  const isInitialLoadRef = useRef<boolean>(false);
  const initialLoadTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
        if (history.length > 50) history.shift();
        userMessageHistory.current.set(userId, history);
      }
    });
    lastProcessedCountRef.current = messages.length;
  }, [messages]);

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
    return () => clearInterval(intervalId);
  }, [currentStream?.user_login]);

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
        if (!headerElement) headerElement = document.getElementById('stream-uptime-display');
        if (headerElement) headerElement.textContent = uptimeString;
      } else {
        streamUptimeRef.current = '';
        if (!headerElement) headerElement = document.getElementById('stream-uptime-display');
        if (headerElement) headerElement.textContent = '';
      }
    };
    updateUptime();
    intervalId = setInterval(updateUptime, 1000);
    return () => clearInterval(intervalId);
  }, [currentStream?.started_at]);

  useEffect(() => {
    const currentTheme = settings.theme;
    if (prevThemeRef.current && prevThemeRef.current !== currentTheme) {
      rowHeights.current = {};
      messageHeightsById.current.clear();
      if (listRef.current) listRef.current.resetAfterIndex(0, true);
    }
    prevThemeRef.current = currentTheme;
  }, [settings.theme]);

  useEffect(() => {
    if (currentStream?.user_login && connectedChannelRef.current !== currentStream.user_login) {
      connectedChannelRef.current = currentStream.user_login;
      // Pass roomId (user_id) to enable fetching recent messages from IVR API
      connectChat(currentStream.user_login, currentStream.user_id);
      loadEmotes(currentStream.user_login, currentStream.user_id);
      userMessageHistory.current.clear();
    }
    return () => {
      if (currentStream?.user_login !== connectedChannelRef.current) connectedChannelRef.current = null;
    };
  }, [currentStream?.user_login, currentStream?.user_id]);

  // Handle historical messages being loaded (bulk load) vs new messages being appended
  useEffect(() => {
    if (!listRef.current || messages.length === 0) return;
    const lastIndex = messages.length - 1;
    const prevCount = lastMessageCountRef.current;
    const countDiff = messages.length - prevCount;

    // Detect if this is a bulk load (many messages at once, likely historical)
    // vs a normal append (1-2 messages at a time)
    const isBulkLoad = prevCount === 0 && messages.length > 5;

    if (isBulkLoad) {
      // Historical messages were loaded - reset all heights and the entire list
      console.log('[ChatWidget] Bulk load detected, resetting list from index 0');
      isInitialLoadRef.current = true;

      // Clear any existing timeout
      if (initialLoadTimeoutRef.current) {
        clearTimeout(initialLoadTimeoutRef.current);
      }

      rowHeights.current = {};
      messageHeightsById.current.clear();
      listRef.current.resetAfterIndex(0, true);

      // After a brief delay to allow rendering, call handleResume to properly scroll and unpause
      setTimeout(() => {
        if (messages.length > 0) {
          // Use handleResume to properly set everything up
          lastResumeTimeRef.current = Date.now();
          setIsPaused(false);
          setBufferPaused(false);
          if (listRef.current) {
            listRef.current.scrollToItem(messages.length - 1, 'end');
          }
        }
      }, 100);

      // Keep the initial load flag active for a bit longer to prevent auto-pause
      initialLoadTimeoutRef.current = setTimeout(() => {
        isInitialLoadRef.current = false;
        console.log('[ChatWidget] Initial load complete, auto-pause now enabled');
      }, 3000);
    } else if (!isPaused) {
      // Normal message append
      listRef.current.resetAfterIndex(Math.max(0, lastIndex - 1));
      listRef.current.scrollToItem(lastIndex, 'end');
      setTimeout(() => {
        maxScrollPositionRef.current = lastScrollPositionRef.current;
      }, 50);
    }

    lastMessageCountRef.current = messages.length;
  }, [messages, isPaused]);

  useEffect(() => {
    if (isPaused && pausedMessageCount === 0) {
      setPausedMessageCount(messages.length);
      frozenMessagesRef.current = [...messages];
      frozenRowHeightsRef.current = { ...rowHeights.current };
    } else if (!isPaused) {
      setPausedMessageCount(0);
      frozenMessagesRef.current = null;
      frozenRowHeightsRef.current = null;
    }
  }, [isPaused, messages.length]);

  const getMessageId = useCallback((message: string): string | null => {
    const idMatch = message.match(/(?:^|;)id=([^;]+)/);
    return idMatch ? idMatch[1] : null;
  }, []);

  useEffect(() => {
    if (isPaused && frozenMessagesRef.current) return;
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
        if (!currentIds.has(id)) messageHeightsById.current.delete(id);
      }
    }
  }, [messages, isPaused, getMessageId]);

  const getItemSize = useCallback((index: number) => {
    if (isPaused && frozenRowHeightsRef.current) {
      if (frozenRowHeightsRef.current[index]) return frozenRowHeightsRef.current[index];
      const frozenMessages = frozenMessagesRef.current;
      if (frozenMessages && frozenMessages[index]) {
        const msgId = getMessageId(frozenMessages[index]);
        if (msgId && messageHeightsById.current.has(msgId)) return messageHeightsById.current.get(msgId)!;
      }
      return 60;
    }
    if (rowHeights.current[index]) return rowHeights.current[index];
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
      if (messageId) messageHeightsById.current.set(messageId, size);
      if (listRef.current) listRef.current.resetAfterIndex(index, false);
    }
  }, []);

  const handleScroll = useCallback(({ scrollOffset, scrollUpdateWasRequested }: { scrollOffset: number; scrollUpdateWasRequested: boolean }) => {
    if (Date.now() - lastResumeTimeRef.current < 500) {
      lastScrollPositionRef.current = scrollOffset;
      if (!isPaused) {
        maxScrollPositionRef.current = Math.max(maxScrollPositionRef.current, scrollOffset);
      }
      return;
    }

    // Skip auto-pause logic during initial load of historical messages
    if (isInitialLoadRef.current) {
      lastScrollPositionRef.current = scrollOffset;
      if (!isPaused) {
        maxScrollPositionRef.current = Math.max(maxScrollPositionRef.current, scrollOffset);
      }
      return;
    }

    if (!scrollUpdateWasRequested) {
      const scrolledAwayFromMax = maxScrollPositionRef.current - scrollOffset > 50;
      if (scrolledAwayFromMax && scrollOffset < lastScrollPositionRef.current - 10 && scrollOffset > 100) {
        if (!isPaused) {
          setIsPaused(true);
          setBufferPaused(true);
        }
      } else if (isPaused && scrollOffset >= maxScrollPositionRef.current - 10) {
        // User scrolled back to bottom while paused - auto-resume
        handleResume();
      }
    }
    lastScrollPositionRef.current = scrollOffset;
    // Only update max scroll position when not paused to prevent interference
    if (!isPaused) {
      maxScrollPositionRef.current = Math.max(maxScrollPositionRef.current, scrollOffset);
    }
  }, [isPaused, setBufferPaused]);

  const handleResume = () => {
    lastResumeTimeRef.current = Date.now();
    setIsPaused(false);
    setBufferPaused(false);
    if (listRef.current && messages.length > 0) listRef.current.scrollToItem(messages.length - 1, 'end');
  };

  const handleBadgeClick = useCallback(async (badgeKey: string, badgeInfo: any) => {
    useAppStore.getState().setShowBadgesOverlay(true);
    const [setId] = badgeKey.split('/');
    window.dispatchEvent(new CustomEvent('show-badge-detail', { detail: { badge: badgeInfo, setId } }));
  }, []);

  const handleReplyClick = useCallback((parentMsgId: string) => {
    const parentIndex = messages.findIndex(msg => getMessageId(msg) === parentMsgId);
    if (parentIndex !== -1 && listRef.current) {
      setIsPaused(true);
      setBufferPaused(true);
      const containerHeight = containerHeightRef.current || 0;
      const totalHeight = Object.values(rowHeights.current).reduce((sum, h) => sum + h, 0);
      const needsPadding = totalHeight < containerHeight;
      const actualIndex = needsPadding ? parentIndex + 1 : parentIndex;
      listRef.current.scrollToItem(actualIndex, 'center');
      setHighlightedMessageId(parentMsgId);
      setTimeout(() => setHighlightedMessageId(null), 2000);
    } else {
      useAppStore.getState().addToast('Parent message not found in current chat history', 'info');
    }
  }, [messages, getMessageId, setBufferPaused]);

  const loadEmotes = async (channelName: string, channelId?: string) => {
    setIsLoadingEmotes(true);
    try {
      try {
        const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
        await initializeBadges(clientId, token, channelId);
      } catch (err) {
        console.error('[ChatWidget] Failed to initialize badges:', err);
      }
      const emoteSet = await fetchAllEmotes(channelName, channelId);
      setEmotes(emoteSet);
      const favorites = await loadFavoriteEmotes();
      if (emoteSet) {
        const allEmotes = [...emoteSet.twitch, ...emoteSet.bttv, ...emoteSet['7tv'], ...emoteSet.ffz];
        const availableFavorites = getAvailableFavorites(allEmotes);
        setFavoriteEmotes(availableFavorites);
      }
    } catch (err) {
      console.error('Failed to load emotes:', err);
    } finally {
      setIsLoadingEmotes(false);
    }
  };

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
            try {
              await initializeBadges(clientId, token, sourceRoomId);
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
          const userBadges = await invoke<string>('get_user_badges', { userId: currentUser.user_id, channelId: currentStream?.user_id });
          badgeString = userBadges;
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
      if (prev.trim()) return prev + (prev.endsWith(' ') ? '' : ' ') + emoteName + ' ';
      return emoteName + ' ';
    });
    inputRef.current?.focus();
  };

  const handleUsernameRightClick = (messageId: string, username: string) => {
    setReplyingTo({ messageId, username });
    inputRef.current?.focus();
  };

  const emojiCategories = {
    'Smileys': ['😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐'],
    'Gestures': ['👍', '👎', '👊', '✊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👋', '🤚', '🖐️', '✋', '🖖', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁️', '👅', '👄'],
    'Hearts': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️', '💌', '💋'],
    'Animals': ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🦟', '🦗', '🕷️', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊'],
    'Food': ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗'],
    'Activities': ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '🤺', '⛹️', '🤾', '🏌️', '🏇', '🧘', '🏄', '🏊', '🤽', '🚣', '🧗', '🚵', '🚴', '🏆', '🥇', '🥈', '🥉'],
    'Objects': ['⌚', '📱', '💻', '⌨️', '🖥️', '💡', '🔦', '💎', '🔮', '🎮', '🎯', '🎨'],
    'Symbols': ['❤️', '💯', '✨', '⭐', '🔥', '💥', '✅', '❌', '➕', '➖', '✖️', '➡️', '⬅️', '⬆️', '⬇️']
  };

  const allEmojis = Object.entries(emojiCategories).flatMap(([category, emojis]) =>
    emojis.map(emoji => ({ emoji, category }))
  );

  const getFilteredEmotes = (): Emote[] => {
    if (selectedProvider === 'emoji') return [];
    if (selectedProvider === 'favorites') {
      const favs = favoriteEmotes;
      if (!searchQuery) return favs;
      const query = searchQuery.toLowerCase();
      return favs.filter((emote: Emote) => emote.name.toLowerCase().includes(query));
    }
    if (!emotes) return [];
    const providerEmotes = emotes[selectedProvider] || [];
    if (!searchQuery) return providerEmotes;
    const query = searchQuery.toLowerCase();
    return providerEmotes.filter((emote: Emote) => emote.name.toLowerCase().includes(query));
  };

  const getFilteredEmojis = () => {
    if (!searchQuery) return allEmojis;
    const query = searchQuery.toLowerCase();
    return allEmojis.filter(({ emoji, category }) =>
      emoji.includes(query) || category.toLowerCase().includes(query)
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
      if (x < 0) x = mainPosition.x + mainSize.width + gap;
      const windowLabel = `profile-${userId}-${Date.now()}`;
      const messageHistory = userMessageHistory.current.get(userId) || [];
      const params = new URLSearchParams({
        userId, username, displayName, color,
        badges: JSON.stringify(badges),
        channelId: currentStream?.user_id || '',
        channelName: currentStream?.user_login || '',
        messageHistory: JSON.stringify(messageHistory)
      });
      const profileWindow = new WebviewWindow(windowLabel, {
        url: `${window.location.origin}/#/profile?${params.toString()}`,
        title: `${displayName}'s Profile`,
        width: cardWidth, height: cardHeight, x, y,
        resizable: false, decorations: false, alwaysOnTop: true, skipTaskbar: true, transparent: true, focus: true
      });
      profileWindow.once('tauri://error', (e) => console.error('Error opening profile window:', e));
    } catch (err) {
      console.error('Failed to open profile window:', err);
      setSelectedUser({ userId, username, displayName, color, badges, position: { x: event.clientX, y: event.clientY } });
    }
  };

  return (
    <>
      <div className="h-full bg-secondary backdrop-blur-md overflow-hidden flex flex-col relative">
        <div className="absolute inset-0 overflow-hidden" style={{ paddingBottom: '55px' }}
          onMouseEnter={() => { isHoveringChatRef.current = true; }}
          onMouseLeave={() => { isHoveringChatRef.current = false; }}>
          {messages.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-textSecondary text-sm">Waiting for messages...</p>
            </div>
          ) : (
            <AutoSizer>
              {({ height, width }) => {
                containerHeightRef.current = height;
                const displayMessages = messages; // Always show all messages, even when paused
                const totalHeight = Object.values(rowHeights.current).reduce((sum, height) => sum + height, 0);
                const needsPadding = totalHeight < height;
                const paddingHeight = needsPadding ? height - totalHeight : 0;
                return (
                  <List ref={listRef} height={height} itemCount={displayMessages.length + (needsPadding ? 1 : 0)}
                    itemSize={(index) => {
                      if (needsPadding && index === 0) return paddingHeight;
                      const messageIndex = needsPadding ? index - 1 : index;
                      return getItemSize(messageIndex);
                    }}
                    width={width} className="scrollbar-thin" onScroll={handleScroll} estimatedItemSize={60}
                    initialScrollOffset={displayMessages.length > 0 ? 999999 : 0}>
                    {({ index, style }) => {
                      if (needsPadding && index === 0) return <div style={style} />;
                      const messageIndex = needsPadding ? index - 1 : index;
                      const currentMessage = displayMessages[messageIndex];
                      const currentMsgId = getMessageId(currentMessage);
                      return (
                        <div style={style}>
                          <ChatMessageRow message={currentMessage} messageIndex={messageIndex} messageId={currentMsgId}
                            emoteSet={emotes} onUsernameClick={handleUsernameClick} onReplyClick={handleReplyClick}
                            isHighlighted={highlightedMessageId !== null && currentMessage.includes(`id=${highlightedMessageId}`)}
                            onEmoteRightClick={handleEmoteRightClick} onUsernameRightClick={handleUsernameRightClick}
                            onBadgeClick={handleBadgeClick} setItemSize={setItemSize} />
                        </div>
                      );
                    }}
                  </List>
                );
              }}
            </AutoSizer>
          )}
        </div>

        {isPaused && (
          <div className="absolute bottom-[65px] left-1/2 transform -translate-x-1/2 z-50 pointer-events-auto">
            <button onClick={handleResume} className="flex items-center gap-2 px-4 py-2 glass-button text-white text-sm font-medium rounded-full shadow-lg bg-black/95">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              <span>Chat Paused ({messages.length - pausedMessageCount} new)</span>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
          </div>
        )}

        <div className={`absolute top-0 left-0 right-0 px-3 py-2 border-b backdrop-blur-ultra z-10 pointer-events-none shadow-lg ${isSharedChat ? 'iridescent-border' : 'border-borderSubtle'}`} style={{ backgroundColor: 'rgba(12, 12, 13, 0.9)' }}>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-400'}`}></div>
            <p className={`text-xs font-semibold ${isSharedChat ? 'iridescent-title' : 'text-textPrimary'}`}>
              {isConnected ? (isSharedChat ? 'SHARED STREAM CHAT' : 'STREAM CHAT') : 'DISCONNECTED'}
            </p>
            <div className="flex items-center gap-3 ml-auto">
              {viewerCount !== null && (
                <div className="flex items-center gap-1">
                  <svg className="w-3 h-3 text-textSecondary" fill="currentColor" viewBox="0 0 20 20"><path d="M10 12a2 2 0 100-4 2 2 0 000 4z" /><path fillRule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" /></svg>
                  <span className="text-xs text-textSecondary">{viewerCount.toLocaleString()}</span>
                </div>
              )}
              {currentStream?.started_at && (
                <div className="flex items-center gap-1">
                  <svg className="w-3 h-3 text-textSecondary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  <span id="stream-uptime-display" className="text-xs text-textSecondary">{streamUptimeRef.current}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 border-t border-borderSubtle backdrop-blur-ultra z-10" style={{ backgroundColor: 'rgba(12, 12, 13, 0.9)' }}>
          <div className="p-2">
            <div className="relative">
              {showEmotePicker && (
                <div className="absolute bottom-full left-0 right-0 mb-2 h-[520px] border border-borderSubtle rounded-lg shadow-lg flex flex-col overflow-hidden" style={{ backgroundColor: 'rgba(12, 12, 13, 0.95)' }}>
                  <div className="p-2 border-b border-borderSubtle">
                    <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search emotes..."
                      className="w-full glass-input text-xs px-3 py-1.5 placeholder-textSecondary" />
                    <div className="flex gap-1 mt-2">
                      <button onClick={() => setSelectedProvider('favorites')} className={`flex-1 py-1.5 text-xs rounded transition-all flex items-center justify-center gap-1 ${selectedProvider === 'favorites' ? 'glass-button text-white' : 'bg-glass text-textSecondary hover:bg-glass-hover'}`} title={`Favorites (${favoriteEmotes.length})`}>
                        <span className="text-yellow-400">★</span><span className="text-[10px] opacity-70">{favoriteEmotes.length}</span>
                      </button>
                      <button onClick={() => setSelectedProvider('emoji')} className={`flex-1 py-1.5 text-xs rounded transition-all flex items-center justify-center ${selectedProvider === 'emoji' ? 'glass-button text-white' : 'bg-glass text-textSecondary hover:bg-glass-hover'}`} title="Emoji"><img src={getAppleEmojiUrl('😀')} alt="😀" className="w-4 h-4" /></button>
                      <button onClick={() => setSelectedProvider('twitch')} className={`flex-1 py-1.5 text-xs rounded transition-all flex items-center justify-center gap-1 ${selectedProvider === 'twitch' ? 'glass-button text-white' : 'bg-glass text-textSecondary hover:bg-glass-hover'}`} title={`Twitch (${emotes?.twitch.length || 0})`}>
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" /></svg>
                        <span className="text-[10px] opacity-70">{emotes?.twitch.length || 0}</span>
                      </button>
                      <button onClick={() => setSelectedProvider('bttv')} className={`flex-1 py-1.5 text-xs rounded transition-all flex items-center justify-center gap-1 ${selectedProvider === 'bttv' ? 'glass-button text-white' : 'bg-glass text-textSecondary hover:bg-glass-hover'}`} title={`BetterTTV (${emotes?.bttv.length || 0})`}>
                        <svg className="w-4 h-4" viewBox="0 0 300 300" fill="currentColor"><path fill="transparent" d="M249.771 150A99.771 99.922 0 0 1 150 249.922 99.771 99.922 0 0 1 50.229 150 99.771 99.922 0 0 1 150 50.078 99.771 99.922 0 0 1 249.771 150Z" /><path d="M150 1.74C68.409 1.74 1.74 68.41 1.74 150S68.41 298.26 150 298.26h148.26V150.17h-.004c0-.057.004-.113.004-.17C298.26 68.409 231.59 1.74 150 1.74zm0 49c55.11 0 99.26 44.15 99.26 99.26 0 55.11-44.15 99.26-99.26 99.26-55.11 0-99.26-44.15-99.26-99.26 0-55.11 44.15-99.26 99.26-99.26z" /><path d="M161.388 70.076c-10.662 0-19.42 7.866-19.42 17.67 0 9.803 8.758 17.67 19.42 17.67 10.662 0 19.42-7.867 19.42-17.67 0-9.804-8.758-17.67-19.42-17.67zm45.346 24.554-.02.022-.004.002c-5.402 2.771-11.53 6.895-18.224 11.978l-.002.002-.004.002c-25.943 19.766-60.027 54.218-80.344 80.33h-.072l-1.352 1.768c-5.114 6.69-9.267 12.762-12.098 18.006l-.082.082.022.021v.002l.004.002.174.176.052-.053.102.053-.07.072c30.826 30.537 81.213 30.431 111.918-.273 30.783-30.784 30.8-81.352.04-112.152l-.005-.004zM87.837 142.216c-9.803 0-17.67 8.758-17.67 19.42 0 10.662 7.867 19.42 17.67 19.42 9.804 0 17.67-8.758 17.67-19.42 0-10.662-7.866-19.42-17.67-19.42z" /></svg>
                        <span className="text-[10px] opacity-70">{emotes?.bttv.length || 0}</span>
                      </button>
                      <button onClick={() => setSelectedProvider('7tv')} className={`flex-1 py-1.5 text-xs rounded transition-all flex items-center justify-center gap-1 ${selectedProvider === '7tv' ? 'glass-button text-white' : 'bg-glass text-textSecondary hover:bg-glass-hover'}`} title={`7TV (${emotes?.['7tv'].length || 0})`}>
                        <svg className="w-4 h-4" viewBox="0 0 28 21" fill="currentColor"><path d="M20.7465 5.48825L21.9799 3.33745L22.646 2.20024L21.4125 0.0494437V0H14.8259L17.2928 4.3016L17.9836 5.48825H20.7465Z" /><path d="M7.15395 19.9258L14.5546 7.02104L15.4673 5.43884L13.0004 1.13724L12.3097 0.0247596H1.8995L0.666057 2.17556L0 3.31276L1.23344 5.46356V5.51301H9.12745L2.96025 16.267L2.09685 17.7998L3.33029 19.9506V20H7.15395" /><path d="M17.4655 19.9257H21.2398L26.1736 11.3225L27.037 9.83924L25.8036 7.68844V7.63899H22.0046L19.5377 11.9406L19.365 12.262L16.8981 7.96038L16.7255 7.63899L14.2586 11.9406L13.5679 13.1272L17.2682 19.5796L17.4655 19.9257Z" /></svg>
                        <span className="text-[10px] opacity-70">{emotes?.['7tv'].length || 0}</span>
                      </button>
                      <button onClick={() => setSelectedProvider('ffz')} className={`flex-1 py-1.5 text-xs rounded transition-all flex items-center justify-center gap-1 ${selectedProvider === 'ffz' ? 'glass-button text-white' : 'bg-glass text-textSecondary hover:bg-glass-hover'}`} title={`FrankerFaceZ (${emotes?.ffz.length || 0})`}>
                        <svg className="w-4 h-4" viewBox="-0.5 -0.5 40 30" fill="currentColor"><path d="M 15.5,-0.5 C 17.8333,-0.5 20.1667,-0.5 22.5,-0.5C 24.6552,3.13905 26.8218,6.80572 29,10.5C 29.691,7.40943 31.5243,6.24276 34.5,7C 36.585,9.68221 38.2517,12.5155 39.5,15.5C 39.5,17.5 39.5,19.5 39.5,21.5C 34.66,25.2533 29.3267,27.92 23.5,29.5C 20.5,29.5 17.5,29.5 14.5,29.5C 9.11466,27.3005 4.11466,24.3005 -0.5,20.5C -0.5,17.5 -0.5,14.5 -0.5,11.5C 4.17691,4.45967 7.34358,5.12633 9,13.5C 10.6047,10.3522 11.6047,7.01889 12,3.5C 12.6897,1.64977 13.8564,0.316435 15.5,-0.5 Z" /></svg>
                        <span className="text-[10px] opacity-70">{emotes?.ffz.length || 0}</span>
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto p-3 scrollbar-thin">
                    {selectedProvider === 'emoji' ? (
                      getFilteredEmojis().length === 0 ? (
                        <div className="flex items-center justify-center h-32"><p className="text-xs text-textSecondary">No emojis found</p></div>
                      ) : (
                        <div className="space-y-4">
                          {Object.entries(emojiCategories).map(([category, emojis]) => {
                            const filteredCategoryEmojis = searchQuery ? emojis.filter(emoji => emoji.includes(searchQuery) || category.toLowerCase().includes(searchQuery.toLowerCase())) : emojis;
                            if (filteredCategoryEmojis.length === 0) return null;
                            return (
                              <div key={category}>
                                <h3 className="text-xs text-textSecondary font-semibold mb-2 px-1">{category}</h3>
                                <div className="grid grid-cols-8 gap-1">
                                  {filteredCategoryEmojis.map((emoji, idx) => (
                                    <button key={`${category}-${idx}`} onClick={() => insertEmote(emoji)} className="flex items-center justify-center p-1.5 hover:bg-glass rounded transition-colors" title={emoji}>
                                      <img src={getAppleEmojiUrl(emoji)} alt={emoji} className="w-6 h-6 object-contain" onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.insertAdjacentText('afterend', emoji); }} />
                                    </button>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )
                    ) : isLoadingEmotes ? (
                      <div className="flex items-center justify-center h-32"><p className="text-xs text-textSecondary">Loading emotes...</p></div>
                    ) : filteredEmotes.length === 0 ? (
                      <div className="flex items-center justify-center h-32"><p className="text-xs text-textSecondary">No emotes found</p></div>
                    ) : (
                      <div className="grid grid-cols-7 gap-2">
                        {filteredEmotes.map((emote) => {
                          const isFavorited = isFavoriteEmote(emote.id);
                          return (
                            <div key={`${emote.provider}-${emote.id}`} className="relative group">
                              <button onClick={() => insertEmote(emote.name)} className="flex flex-col items-center gap-1 p-1.5 hover:bg-glass rounded transition-colors w-full" title={emote.name}>
                                <img src={emote.url} alt={emote.name} className="w-8 h-8 object-contain" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                                <span className="text-xs text-textSecondary truncate w-full text-center">{emote.name}</span>
                              </button>
                              <button onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  if (isFavorited) {
                                    await removeFavoriteEmote(emote.id);
                                    if (selectedProvider === 'favorites') setFavoriteEmotes(prev => prev.filter(e => e.id !== emote.id));
                                    useAppStore.getState().addToast(`Removed ${emote.name} from favorites`, 'success');
                                  } else {
                                    await addFavoriteEmote(emote);
                                    if (emotes) {
                                      const allEmotes = [...emotes.twitch, ...emotes.bttv, ...emotes['7tv'], ...emotes.ffz];
                                      const availableFavorites = getAvailableFavorites(allEmotes);
                                      setFavoriteEmotes(availableFavorites);
                                    }
                                    useAppStore.getState().addToast(`Added ${emote.name} to favorites`, 'success');
                                  }
                                } catch (err) {
                                  console.error('Failed to toggle favorite:', err);
                                  useAppStore.getState().addToast('Failed to update favorites', 'error');
                                }
                              }} className={`absolute top-0 right-0 p-1 rounded-bl transition-all ${isFavorited ? 'text-yellow-400 opacity-100' : 'text-textSecondary opacity-0 group-hover:opacity-100'} hover:text-yellow-400 hover:bg-glass`} title={isFavorited ? 'Remove from favorites' : 'Add to favorites'}>
                                <svg className="w-3 h-3" fill={isFavorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {replyingTo && (
                <div className="mb-2 flex items-center gap-2 px-3 py-2 bg-glass rounded-lg border border-borderSubtle">
                  <svg className="w-4 h-4 text-accent flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
                  <span className="text-xs text-textSecondary flex-1">Replying to <span className="text-accent font-semibold">{replyingTo.username}</span></span>
                  <button onClick={() => setReplyingTo(null)} className="text-textSecondary hover:text-textPrimary transition-colors" title="Cancel reply">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              )}
              <div className="flex items-center gap-2 min-w-0">
                <button onClick={() => setShowEmotePicker(!showEmotePicker)} className="flex-shrink-0 p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all" title="Emotes">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 100-2 1 1 0 000 2zm7-1a1 1 0 11-2 0 1 1 0 012 0zm-.464 5.535a1 1 0 10-1.415-1.414 3 3 0 01-4.242 0 1 1 0 00-1.415 1.414 5 5 0 007.072 0z" clipRule="evenodd" /></svg>
                </button>
                <input ref={inputRef} type="text" value={messageInput} onChange={(e) => setMessageInput(e.target.value)} onKeyPress={handleKeyPress}
                  placeholder="Send a message" className="flex-1 min-w-0 glass-input text-textPrimary text-sm px-3 py-2 placeholder-textSecondary" disabled={!isConnected} />
                <button onClick={handleSendMessage} disabled={!messageInput.trim() || !isConnected} className="flex-shrink-0 p-2 glass-button text-white rounded disabled:opacity-50 disabled:cursor-not-allowed" title="Send message">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                </button>
              </div>
            </div>
            {!isConnected && <p className="text-xs text-yellow-400 mt-2">Chat is not connected. Messages cannot be sent.</p>}
          </div>
        </div>
      </div>
      {selectedUser && (
        <UserProfileCard userId={selectedUser.userId} username={selectedUser.username} displayName={selectedUser.displayName}
          color={selectedUser.color} badges={selectedUser.badges} messageHistory={userMessageHistory.current.get(selectedUser.userId) || []}
          onClose={() => setSelectedUser(null)} position={selectedUser.position} />
      )}
    </>
  );
};

export default ChatWidget;
