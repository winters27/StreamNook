import React, { useEffect, useRef, useState, useMemo, useCallback, useLayoutEffect, memo } from 'react';
import { VariableSizeList as List } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Pickaxe, Gift } from 'lucide-react';

// Channel Points Icon (Twitch style)
const ChannelPointsIcon = ({ className = "", size = 14 }: { className?: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M12 5v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7Z"></path>
    <path fillRule="evenodd" d="M1 12C1 5.925 5.925 1 12 1s11 4.925 11 11-4.925 11-11 11S1 18.075 1 12Zm11 9a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z" clipRule="evenodd"></path>
  </svg>
);
import { MiningStatus } from '../types';
import { useTwitchChat } from '../hooks/useTwitchChat';
import { useAppStore } from '../stores/AppStore';
import { incrementStat } from '../services/supabaseService';
import ChatMessage from './ChatMessage';
import UserProfileCard from './UserProfileCard';
import ErrorBoundary from './ErrorBoundary';
import PredictionOverlay from './PredictionOverlay';
import { fetchAllEmotes, Emote, EmoteSet, preloadChannelEmotes, queueEmoteForCaching } from '../services/emoteService';
import { preloadThirdPartyBadgeDatabases } from '../services/thirdPartyBadges';
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

import { BackendChatMessage } from '../services/twitchChat';

interface ParsedMessage {
  username: string;
  content: string;
  color: string;
  badges: Array<{ key: string; info: any }>;
  tags: Map<string, string>;
  emotes: string;
}

import { EMOJI_CATEGORIES, EMOJI_KEYWORDS } from '../services/emojiCategories';

interface ChatMessageRowProps {
  message: string | BackendChatMessage;
  messageIndex: number;
  messageId: string | null;
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
  isDeleted: boolean;
  onEmoteRightClick: (emoteName: string) => void;
  onUsernameRightClick: (messageId: string, username: string) => void;
  onBadgeClick: (badgeKey: string, badgeInfo: any) => void;
  setItemSize: (index: number, size: number, messageId?: string | null, hasReply?: boolean) => void;
}

const ChatMessageRow = memo(({
  message,
  messageIndex,
  messageId,
  onUsernameClick,
  onReplyClick,
  isHighlighted,
  isDeleted,
  onEmoteRightClick,
  onUsernameRightClick,
  onBadgeClick,
  setItemSize,
}: ChatMessageRowProps) => {
  const rowRef = useRef<HTMLDivElement>(null);
  // Track if we've reported the height for this specific message+deleted state combo
  const reportedStateRef = useRef<string>('');

  // REFACTORED: Simplified height reporting strategy
  // - Backend messages: Use pre-calculated height immediately, no DOM measurement
  // - Legacy IRC strings: Measure DOM once per message
  // - Deleted state changes: Only re-measure for legacy strings (backend heights don't change)
  useLayoutEffect(() => {
    const isBackendMessage = typeof message !== 'string';
    const stateKey = `${messageId || messageIndex}-${isDeleted}`;
    
    // Skip if we've already reported for this exact state
    if (reportedStateRef.current === stateKey) return;
    
    if (isBackendMessage) {
      // Backend messages have pre-calculated heights from Rust
      // These are accurate for the current layout width - trust them completely
      const preCalculatedHeight = (message as BackendChatMessage).layout?.height || 0;
      if (preCalculatedHeight > 0) {
        // For deleted messages, add a small buffer for the "[deleted]" indicator
        // This is ~20px (text + margin), but we keep it simple
        const adjustedHeight = isDeleted ? preCalculatedHeight + 22 : preCalculatedHeight;
        setItemSize(messageIndex, adjustedHeight, messageId, false);
        reportedStateRef.current = stateKey;
        return;
      }
    }

    // Legacy IRC strings need DOM measurement (only happens for historical messages before Rust parsing)
    const element = rowRef.current;
    if (!element) return;

    // Use a single RAF to batch measurements
    requestAnimationFrame(() => {
      if (reportedStateRef.current === stateKey) return; // Double-check
      const height = element.getBoundingClientRect().height;
      if (height > 0) {
        setItemSize(messageIndex, height, messageId, false);
        reportedStateRef.current = stateKey;
      }
    });
  }, [messageIndex, messageId, setItemSize, message, isDeleted]);

  return (
    <div ref={rowRef}>
      <ChatMessage
        message={message}
        messageIndex={messageIndex}
        onUsernameClick={onUsernameClick}
        onReplyClick={onReplyClick}
        isHighlighted={isHighlighted}
        isDeleted={isDeleted}
        onEmoteRightClick={onEmoteRightClick}
        onUsernameRightClick={onUsernameRightClick}
        onBadgeClick={onBadgeClick}
      />
    </div>
  );
});

ChatMessageRow.displayName = 'ChatMessageRow';

// LayoutUpdater: Syncs container width with backend layout service.
// REFACTORED: Immediate sync on mount + smart debouncing for resize operations
// The goal is to ensure backend always knows the current width before calculating heights
const LayoutUpdater = memo(({ width, onWidthSynced }: { width: number; onWidthSynced?: (width: number) => void }) => {
  const lastSyncedWidthRef = useRef<number>(0);
  const isFirstSyncRef = useRef<boolean>(true);
  
  useEffect(() => {
    // Account for message padding (px-3 = 12px * 2 = 24px horizontal padding)
    const contentWidth = Math.max(width - 24, 100);
    
    // Skip if width hasn't meaningfully changed (within 2px tolerance)
    if (Math.abs(lastSyncedWidthRef.current - contentWidth) < 2 && !isFirstSyncRef.current) {
      return;
    }
    
    // First sync is immediate - critical for initial load
    // Subsequent syncs are debounced to avoid spam during resize
    const delay = isFirstSyncRef.current ? 0 : 100;
    
    const timeout = setTimeout(() => {
      invoke('update_layout_width', { width: contentWidth })
        .then(() => {
          lastSyncedWidthRef.current = contentWidth;
          if (isFirstSyncRef.current) {
            isFirstSyncRef.current = false;
          }
          // Notify parent that width is synced (for initial load coordination)
          onWidthSynced?.(contentWidth);
        })
        .catch(err => console.error('[LayoutUpdater] Failed to update width:', err));
    }, delay);
    
    return () => clearTimeout(timeout);
  }, [width, onWidthSynced]);
  
  return null;
});
LayoutUpdater.displayName = 'LayoutUpdater';

const ChatWidget = () => {
  const { messages, connectChat, sendMessage, isConnected, error, setPaused: setBufferPaused, deletedMessageIds, clearedUserIds } = useTwitchChat();
  const { currentStream, currentUser } = useAppStore();
  const listRef = useRef<List>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const messageHeightsById = useRef<Map<string, number>>(new Map());
  const rowHeights = useRef<{ [key: number]: number }>({});
  const messageRefs = useRef<{ [key: number]: HTMLDivElement | null }>({});
  const containerHeightRef = useRef<number>(0);
  const containerWidthRef = useRef<number>(0);
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
  const frozenMessagesRef = useRef<(string | BackendChatMessage)[] | null>(null);
  const frozenRowHeightsRef = useRef<{ [key: number]: number } | null>(null);
  const lastScrollPositionRef = useRef<number>(0);
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

  // Drops mining state
  const [dropsCampaign, setDropsCampaign] = useState<{ id: string; name: string; game_name: string } | null>(null);
  const [isMining, setIsMining] = useState(false);
  const [isLoadingDrops, setIsLoadingDrops] = useState(false);

  // Channel points state
  const [channelPoints, setChannelPoints] = useState<number | null>(null);
  const [channelPointsHovered, setChannelPointsHovered] = useState(false);
  const [isLoadingChannelPoints, setIsLoadingChannelPoints] = useState(false);

  // Refs for batching list resets to prevent UI freezing during resizing
  const resetRafIdRef = useRef<number | null>(null);
  const minResetIndexRef = useRef<number>(Infinity);

  // Track if we should auto-scroll to bottom (when user is at bottom)
  const shouldAutoScrollRef = useRef<boolean>(true);



  useEffect(() => {
    const newMessages = messages.slice(lastProcessedCountRef.current);
    newMessages.forEach((message, idx) => {
      try {
        let parsed: ParsedMessage;
        let msgId: string | undefined;
        let userId: string | undefined;

        if (typeof message === 'string') {
          const channelIdMatch = message.match(/room-id=([^;]+)/);
          const channelId = channelIdMatch ? channelIdMatch[1] : undefined;
          parsed = parseMessage(message, channelId);
          msgId = parsed.tags.get('id');
          userId = parsed.tags.get('user-id');
        } else {
          // Backend message object
          parsed = parseMessage(message);
          msgId = message.id;
          userId = message.tags['user-id'] || message.user_id;
        }

        if (msgId) {
          const actualIndex = lastProcessedCountRef.current + idx;
          messageIdToIndexRef.current.set(msgId, actualIndex);
        }
        if (userId) {
          const history = userMessageHistory.current.get(userId) || [];
          history.push(parsed);
          if (history.length > 50) history.shift();
          userMessageHistory.current.set(userId, history);
        }
      } catch (err) {
        console.error('[ChatWidget] Failed to parse message:', err, message);
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
      // PHASE 3: Clear Rust user message history when switching channels
      invoke('clear_user_message_history').catch(err => 
        console.warn('[ChatWidget] Failed to clear Rust user history:', err)
      );
      // Reset channel points when switching channels
      setChannelPoints(null);
    }
    return () => {
      if (currentStream?.user_login !== connectedChannelRef.current) connectedChannelRef.current = null;
    };
  }, [currentStream?.user_login, currentStream?.user_id]);

  // Fetch channel points for current channel from cached balances
  const fetchChannelPoints = useCallback(async () => {
    if (!currentStream?.user_id) return;
    
    console.log('[ChatWidget] fetchChannelPoints - looking for channel:', currentStream.user_id);
    
    try {
      // Get all cached channel points balances from background service
      const balances = await invoke<Array<{ channel_id: string; balance: number }>>('get_all_channel_points_balances');
      
      console.log('[ChatWidget] All balances:', balances);
      
      // Find balance for current channel
      const channelBalance = balances?.find(b => b.channel_id === currentStream.user_id);
      
      if (channelBalance && typeof channelBalance.balance === 'number') {
        console.log('[ChatWidget] ✅ Found cached balance:', channelBalance.balance);
        setChannelPoints(channelBalance.balance);
        return;
      }
      
      // If no cached balance, try direct query (may fail with outdated GQL schema)
      console.log('[ChatWidget] No cached balance, trying direct query...');
      
      try {
        const result = await invoke<any>('get_channel_points_balance', {
          channelId: currentStream.user_id
        });
        
        const balance = result?.balance || result?.points;
        if (typeof balance === 'number') {
          console.log('[ChatWidget] ✅ Got balance from direct query:', balance);
          setChannelPoints(balance);
          return;
        }
      } catch (err) {
        console.warn('[ChatWidget] Direct query failed (expected if GQL outdated):', err);
      }
      
      console.log('[ChatWidget] No channel points available yet - will update via events');
    } catch (err) {
      console.error('[ChatWidget] Failed to fetch channel points:', err);
    }
  }, [currentStream?.user_id]);

  // Listen for channel points updates from backend events
  useEffect(() => {
    if (!currentStream?.user_id) return;
    
    const unlistenSpent = listen<{ channel_id?: string | null; points: number; balance: number }>('channel-points-spent', (event) => {
      console.log('[ChatWidget] 💸 Points spent event:', event.payload, 'currentChannel:', currentStream.user_id);
      // Update if channel matches OR if no channel_id in event (prediction bets sometimes don't include it)
      if (!event.payload.channel_id || event.payload.channel_id === currentStream.user_id) {
        console.log('[ChatWidget] ✅ Updating channel points to:', event.payload.balance);
        setChannelPoints(event.payload.balance);
      }
    });

    const unlistenEarned = listen<{ channel_id?: string | null; points: number; balance: number }>('channel-points-earned', (event) => {
      console.log('[ChatWidget] 💰 Points earned event:', event.payload, 'currentChannel:', currentStream.user_id);
      // Update if channel matches OR if no channel_id in event
      if (!event.payload.channel_id || event.payload.channel_id === currentStream.user_id) {
        console.log('[ChatWidget] ✅ Updating channel points to:', event.payload.balance);
        setChannelPoints(event.payload.balance);
      }
    });

    return () => {
      unlistenSpent.then(fn => fn());
      unlistenEarned.then(fn => fn());
    };
  }, [currentStream?.user_id]);

  // Load drops data when stream changes to check if game has active drops
  useEffect(() => {
    const loadDropsForStream = async () => {
      if (!currentStream?.game_name) {
        setDropsCampaign(null);
        setIsMining(false);
        return;
      }
      setIsLoadingDrops(true);
      try {
        // Get active drop campaigns (not inventory - we want all active campaigns)
        const campaigns = await invoke<Array<{ id: string; name: string; game_name: string; game_id: string }>>('get_active_drop_campaigns');
        if (campaigns && campaigns.length > 0) {
          // Find active campaign matching current game
          const gameName = currentStream.game_name.toLowerCase();
          const matchingCampaign = campaigns.find(
            campaign => campaign.game_name?.toLowerCase() === gameName
          );
          if (matchingCampaign) {
            setDropsCampaign(matchingCampaign);
            // Check if already mining this game (check by game_name, not campaign name)
            const miningStatus = await invoke<MiningStatus>('get_mining_status');
            const miningGameName = miningStatus.current_drop?.game_name?.toLowerCase() ||
              miningStatus.current_channel?.game_name?.toLowerCase();
            setIsMining(miningStatus.is_mining && miningGameName === gameName);
          } else {
            setDropsCampaign(null);
            setIsMining(false);
          }
        } else {
          setDropsCampaign(null);
          setIsMining(false);
        }
      } catch (err) {
        console.warn('[ChatWidget] Could not load drops data:', err);
        setDropsCampaign(null);
      } finally {
        setIsLoadingDrops(false);
      }
    };
    loadDropsForStream();
  }, [currentStream?.game_name]);

  // Listen for mining status changes from anywhere in the app
  useEffect(() => {
    const handleMiningStatusChange = async () => {
      if (!dropsCampaign || !currentStream?.game_name) return;
      try {
        const miningStatus = await invoke<MiningStatus>('get_mining_status');
        const gameName = currentStream.game_name.toLowerCase();
        const miningGameName = miningStatus.current_drop?.game_name?.toLowerCase() ||
          miningStatus.current_channel?.game_name?.toLowerCase();
        setIsMining(miningStatus.is_mining && miningGameName === gameName);
      } catch (err) {
        console.warn('[ChatWidget] Failed to check mining status:', err);
      }
    };

    // Listen for mining events using dynamic import
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen('mining-status-changed', handleMiningStatusChange);
      } catch (err) {
        console.warn('[ChatWidget] Failed to set up mining event listener:', err);
      }
    };
    setupListener();

    // Also poll every 5 seconds as backup for state sync
    const pollInterval = setInterval(handleMiningStatusChange, 5000);

    return () => {
      if (unlisten) unlisten();
      clearInterval(pollInterval);
    };
  }, [dropsCampaign]);

  // Handler to toggle mining drops for current channel
  const handleToggleMining = async () => {
    if (!dropsCampaign) return;

    if (isMining) {
      // Stop mining
      try {
        await invoke('stop_auto_mining');
        setIsMining(false);
        useAppStore.getState().addToast(`Stopped mining drops for ${dropsCampaign.game_name}`, 'info');
      } catch (err) {
        console.error('[ChatWidget] Failed to stop mining:', err);
        useAppStore.getState().addToast('Failed to stop mining drops', 'error');
      }
    } else {
      // Start mining
      try {
        // Try to start mining with channel preference (use current channel's user_id)
        // If the channel is eligible for this campaign, it will use it
        // Otherwise, the backend will fall back to recommended channel
        if (currentStream?.user_id) {
          await invoke('start_campaign_mining_with_channel', {
            campaignId: dropsCampaign.id,
            channelId: currentStream.user_id
          });
        } else {
          // Fall back to automatic channel selection
          await invoke('start_campaign_mining', {
            campaignId: dropsCampaign.id
          });
        }
        setIsMining(true);
        useAppStore.getState().addToast(`Started mining drops for ${dropsCampaign.game_name}`, 'success');
      } catch (err) {
        console.error('[ChatWidget] Failed to start mining:', err);
        useAppStore.getState().addToast('Failed to start mining drops', 'error');
      }
    }
  };

  // Force re-measurement of all visible items after programmatic scrolls
  const triggerRemeasurement = useCallback(() => {
    if (!listRef.current) return;
    // Reset the list to force react-window to re-query sizes
    listRef.current.resetAfterIndex(0, false);
    // Schedule multiple resets to catch any async rendering
    // We execute these more thoroughly to ensure the layout is correct on initial load
    [50, 150, 300, 500, 800, 1200].forEach(delay => {
      setTimeout(() => listRef.current?.resetAfterIndex(0, false), delay);
    });
  }, []);

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

      // After a brief delay to allow rendering, scroll and trigger re-measurement
      setTimeout(() => {
        if (messages.length > 0) {
          lastResumeTimeRef.current = Date.now();
          setIsPaused(false);
          setBufferPaused(false);
          if (listRef.current) {
            listRef.current.scrollToItem(messages.length - 1, 'end');
            // Trigger multiple re-measurements to fix any overlap on initial load
            triggerRemeasurement();
          }
        }
      }, 100);

      // Keep the initial load flag active for a bit longer to prevent auto-pause
      initialLoadTimeoutRef.current = setTimeout(() => {
        isInitialLoadRef.current = false;
        console.log('[ChatWidget] Initial load complete, auto-pause now enabled');
        // One final re-measurement sweep after initial load completes
        triggerRemeasurement();
      }, 3000);
    } else if (!isPaused) {
      // Normal message append
      listRef.current.resetAfterIndex(Math.max(0, lastIndex - 1));
      listRef.current.scrollToItem(lastIndex, 'end');
    }

    lastMessageCountRef.current = messages.length;
  }, [messages, isPaused, triggerRemeasurement]);

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

  const getMessageId = useCallback((message: string | BackendChatMessage): string | null => {
    if (typeof message !== 'string') {
      return message.id;
    }
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

  // Helper function to estimate height for raw IRC string messages (historical messages)
  // This provides a better initial estimate than a fixed value to reduce layout jumping
  // Uses actual widget width and font size settings for accurate line estimation
  const estimateStringMessageHeight = useCallback((message: string): number => {
    // Get actual dimensions and settings
    const fontSize = settings.chat_design?.font_size || 14;
    const messageSpacing = settings.chat_design?.message_spacing ?? 8;
    const showTimestamps = settings.chat_design?.show_timestamps || false;
    
    // Calculate line height based on font size (1.625 line-height ratio)
    const lineHeight = Math.ceil(fontSize * 1.625);
    
    // Get content width - account for padding (24px) and badges (~60px estimate)
    // If containerWidthRef is not set yet, use a conservative default
    const containerWidth = containerWidthRef.current || 300;
    const contentWidth = Math.max(containerWidth - 24 - 60, 100);
    
    // Account for timestamp width if enabled (~55px)
    const effectiveWidth = showTimestamps ? contentWidth - 55 : contentWidth;
    
    // Estimate average character width based on font size
    // Satoshi font at 14px has roughly 7px average char width
    // Scale proportionally for different font sizes
    const avgCharWidth = fontSize * 0.5;
    
    // Calculate characters per line
    const charsPerLine = Math.floor(effectiveWidth / avgCharWidth);
    
    // Base height includes message spacing
    const baseHeight = messageSpacing + lineHeight;
    
    // Extract content after PRIVMSG
    const contentMatch = message.match(/PRIVMSG #\w+ :(.+)$/);
    const content = contentMatch ? contentMatch[1] : '';
    
    // Check for special message types that need extra height
    const hasReply = message.includes('reply-parent-msg-id=');
    const isFirstMessage = message.includes('first-msg=1');
    
    // Count emotes in message - each emote takes ~4 characters width worth of space (24px emote / ~6px char)
    const emoteMatches = message.match(/emotes=([^;]+)/);
    let emoteCount = 0;
    if (emoteMatches && emoteMatches[1].length > 0) {
      // Count emote entries (format: id:start-end,start-end/id:start-end)
      const emoteEntries = emoteMatches[1].split('/').filter(e => e.length > 0);
      emoteEntries.forEach(entry => {
        const [, positions] = entry.split(':');
        if (positions) {
          emoteCount += positions.split(',').length;
        }
      });
    }
    
    // Adjust content length: replace emote codes with 4-char placeholders
    // This approximates that emotes (24px) take more space than their text codes
    const adjustedLength = content.length + (emoteCount * 2); // Add 2 extra chars per emote for width estimation
    
    // Count approximate number of lines based on adjusted content length and actual chars per line
    const estimatedLines = Math.max(1, Math.ceil(adjustedLength / Math.max(charsPerLine, 20)));
    
    // Calculate estimated height
    let height = baseHeight + (estimatedLines - 1) * lineHeight;
    
    // Add extra height for replies (~28px)
    if (hasReply) height += 28;
    
    // Add extra height for first message indicator (~32px)
    if (isFirstMessage) height += 32;
    
    // Add buffer for emotes that are taller than text (emotes are 24px, might push line height)
    if (emoteCount > 0 && lineHeight < 24) {
      height += (24 - lineHeight);
    }
    
    // Add safety buffer for rendering variance
    height += 8;
    
    return Math.ceil(height);
  }, [settings.chat_design?.font_size, settings.chat_design?.message_spacing, settings.chat_design?.show_timestamps]);

  const getItemSize = useCallback((index: number) => {
    // ALWAYS check the live cache first. This ensures that if a row measures itself
    // and calls setItemSize, we actually use that new size immediately - even when paused.
    // This fixes chat message formatting issues when scrolling while paused.
    if (rowHeights.current[index]) return rowHeights.current[index];

    // Fallbacks for when we don't have a measured height yet
    if (isPaused && frozenRowHeightsRef.current) {
      if (frozenRowHeightsRef.current[index]) return frozenRowHeightsRef.current[index];
      const frozenMessages = frozenMessagesRef.current;
      if (frozenMessages && frozenMessages[index]) {
        // If frozen message is backend object, use its layout height fallback
        const msg = frozenMessages[index];
        if (typeof msg !== 'string') {
          return msg.layout.height;
        }

        const msgId = getMessageId(msg);
        if (msgId && messageHeightsById.current.has(msgId)) return messageHeightsById.current.get(msgId)!;
        
        // Better estimate for string messages
        return estimateStringMessageHeight(msg);
      }
      return 60;
    }

    const message = messages[index];
    if (message) {
      // If backend message, use pre-calculated height
      if (typeof message !== 'string') {
        const height = message.layout.height;
        // Cache it immediately so we don't check type every time?
        // Actually react-window caches it usually, but we have our own cache.
        rowHeights.current[index] = height;
        return height;
      }

      const msgId = getMessageId(message);
      if (msgId && messageHeightsById.current.has(msgId)) {
        const height = messageHeightsById.current.get(msgId)!;
        rowHeights.current[index] = height;
        return height;
      }
      
      // Use content-aware estimate for string messages (historical messages from IVR)
      return estimateStringMessageHeight(message);
    }
    return 60;
  }, [messages, getMessageId, isPaused, estimateStringMessageHeight]);

  const setItemSize = useCallback((index: number, size: number, messageId?: string | null, _hasReply?: boolean) => {
    const currentSize = rowHeights.current[index] || 0;
    const sizeDiff = Math.abs(currentSize - size);
    
    // REFACTORED: Higher threshold to reduce unnecessary resets
    // Most backend heights are accurate, so only update on meaningful differences
    const threshold = 2; // 2px tolerance
    if (sizeDiff <= threshold) return;
    
    // Update the caches
    rowHeights.current[index] = size;
    if (messageId) messageHeightsById.current.set(messageId, size);
    
    if (!listRef.current) return;
    
    // Track the minimum index that needs resetting
    minResetIndexRef.current = Math.min(minResetIndexRef.current, index);

    // REFACTORED: Single batched RAF for all height updates
    // This prevents the cascading reset problem
    if (resetRafIdRef.current === null) {
      resetRafIdRef.current = requestAnimationFrame(() => {
        if (listRef.current && minResetIndexRef.current !== Infinity) {
          // Single reset from the earliest changed index
          listRef.current.resetAfterIndex(minResetIndexRef.current, false);

          // Simple auto-scroll: if we're at bottom and not paused, scroll to end
          if (shouldAutoScrollRef.current && !isPaused && messages.length > 0) {
            listRef.current.scrollToItem(messages.length - 1, 'end');
          }
        }
        minResetIndexRef.current = Infinity;
        resetRafIdRef.current = null;
      });
    }
  }, [isPaused, messages.length]);

  const handleScroll = useCallback(({ scrollOffset, scrollUpdateWasRequested }: { scrollOffset: number; scrollUpdateWasRequested: boolean }) => {
    // Skip during grace period after resume to prevent false pauses
    if (Date.now() - lastResumeTimeRef.current < 500) {
      lastScrollPositionRef.current = scrollOffset;
      return;
    }

    // Skip auto-pause logic during initial load of historical messages
    if (isInitialLoadRef.current) {
      lastScrollPositionRef.current = scrollOffset;
      return;
    }

    // Calculate distance to bottom using outerRef for accurate measurement
    // This is more reliable than tracking maxScrollPosition which breaks when content resizes
    if (outerRef.current) {
      const { scrollHeight, clientHeight } = outerRef.current;
      const distanceToBottom = scrollHeight - clientHeight - scrollOffset;

      // Track if we should auto-scroll (within 50px of bottom = "at bottom")
      // This is used by setItemSize to know when to re-scroll after height updates
      shouldAutoScrollRef.current = distanceToBottom < 50;

      if (!scrollUpdateWasRequested) {
        // User is scrolling up (away from bottom) - pause chat
        // Only pause if they've scrolled more than 100px from the bottom
        if (distanceToBottom > 100 && scrollOffset < lastScrollPositionRef.current - 10) {
          if (!isPaused) {
            shouldAutoScrollRef.current = false;
            setIsPaused(true);
            setBufferPaused(true);
          }
        }
        // User scrolled back to bottom while paused - auto-resume
        else if (isPaused && distanceToBottom < 30) {
          handleResume();
        }
      }
    }

    lastScrollPositionRef.current = scrollOffset;
  }, [isPaused, setBufferPaused]);

  const handleResume = () => {
    lastResumeTimeRef.current = Date.now();
    shouldAutoScrollRef.current = true; // Re-enable auto-scroll when resuming
    setIsPaused(false);
    setBufferPaused(false);
    if (listRef.current && messages.length > 0) {
      listRef.current.scrollToItem(messages.length - 1, 'end');
      triggerRemeasurement();
    }
  };

  const handleBadgeClick = useCallback(async (badgeKey: string, badgeInfo: any) => {
    useAppStore.getState().setShowBadgesOverlay(true);
    const [setId] = badgeKey.split('/');
    window.dispatchEvent(new CustomEvent('show-badge-detail', { detail: { badge: badgeInfo, setId } }));
  }, []);

  // Helper function to scroll to a specific message by ID
  // This encapsulates the multi-step scroll logic for reliable positioning
  const scrollToMessage = useCallback((messageId: string, options?: { highlight?: boolean; align?: 'start' | 'center' | 'end' | 'auto' }) => {
    const { highlight = true, align = 'center' } = options || {};

    // Debug: Log search parameters
    console.log('[ChatWidget] scrollToMessage called:', { messageId, highlight, align });
    console.log('[ChatWidget] Total messages in buffer:', messages.length);

    // Find the message index
    const messageIndex = messages.findIndex(msg => getMessageId(msg) === messageId);

    // Debug: Log search result
    console.log('[ChatWidget] Message search result:', {
      found: messageIndex !== -1,
      index: messageIndex,
      messageIds: messages.slice(0, 5).map(m => getMessageId(m)).join(', ') + '...'
    });

    if (messageIndex === -1) {
      console.warn('[ChatWidget] Message not found in buffer. ID:', messageId);
      return false;
    }

    if (!listRef.current) {
      console.warn('[ChatWidget] List ref not available');
      return false;
    }

    // Calculate if padding is needed (same logic as render)
    const containerHeight = containerHeightRef.current || 0;
    const totalHeight = Object.values(rowHeights.current).reduce((sum, h) => sum + h, 0);
    const needsPadding = totalHeight < containerHeight;
    const actualIndex = needsPadding ? messageIndex + 1 : messageIndex;

    // Debug: Log scroll parameters
    console.log('[ChatWidget] Scroll parameters:', {
      messageIndex,
      actualIndex,
      needsPadding,
      containerHeight,
      totalHeight,
      knownHeight: rowHeights.current[messageIndex] || 'unknown'
    });

    // Step 1: Pause chat to prevent auto-scrolling interference
    setIsPaused(true);
    setBufferPaused(true);

    // Step 2: Reset the entire list to force fresh measurements
    // This is more aggressive but ensures items around the target get properly measured
    listRef.current.resetAfterIndex(0, false);

    // Step 3: First scroll attempt - brings item into approximate view
    listRef.current.scrollToItem(actualIndex, align);
    console.log('[ChatWidget] Step 3: Initial scroll to index', actualIndex);

    // Step 4: Set highlight immediately if requested
    if (highlight) {
      setHighlightedMessageId(messageId);
    }

    // Step 5: Secondary scroll after a microtask to allow browser layout
    // requestAnimationFrame ensures we wait for the next paint
    requestAnimationFrame(() => {
      if (!listRef.current) return;

      // Reset from the target area to force re-measurement of nearby items
      listRef.current.resetAfterIndex(Math.max(0, messageIndex - 10), false);

      // Second scroll with updated measurements
      listRef.current.scrollToItem(actualIndex, align);
      console.log('[ChatWidget] Step 5: RAF scroll correction');

      // Step 6: Tertiary scroll after a short delay for any async rendering
      setTimeout(() => {
        if (listRef.current) {
          listRef.current.resetAfterIndex(Math.max(0, messageIndex - 10), false);
          listRef.current.scrollToItem(actualIndex, align);
          console.log('[ChatWidget] Step 6: Final scroll correction');
        }
      }, 100);

      // Step 7: One more correction after longer delay for slow-loading content
      setTimeout(() => {
        if (listRef.current) {
          listRef.current.scrollToItem(actualIndex, align);
          console.log('[ChatWidget] Step 7: Late scroll correction');
        }
      }, 300);

      // Step 8: Full remeasurement sweep after all scroll corrections
      // This ensures any items that loaded content (emotes, badges) get properly sized
      setTimeout(() => {
        if (listRef.current) {
          // Trigger comprehensive remeasurement from the beginning
          triggerRemeasurement();
          console.log('[ChatWidget] Step 8: Full remeasurement triggered');
        }
      }, 500);
    });

    // Clear highlight after animation completes
    if (highlight) {
      setTimeout(() => setHighlightedMessageId(null), 2000);
    }

    return true;
  }, [messages, getMessageId, setBufferPaused, triggerRemeasurement]);

  const handleReplyClick = useCallback((parentMsgId: string) => {
    console.log('[ChatWidget] handleReplyClick called for parentMsgId:', parentMsgId);

    const success = scrollToMessage(parentMsgId, { highlight: true, align: 'center' });

    if (!success) {
      useAppStore.getState().addToast('Original message is no longer in chat history', 'info');
    }
  }, [scrollToMessage]);

  const loadEmotes = async (channelName: string, channelId?: string) => {
    setIsLoadingEmotes(true);
    try {
      // Pre-warm third-party badge databases in parallel (FFZ, Chatterino, Homies)
      // This ensures badge lookups are instant for chat messages
      preloadThirdPartyBadgeDatabases().catch(err =>
        console.warn('[ChatWidget] Failed to preload third-party badge databases:', err)
      );

      try {
        const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
        await initializeBadges(clientId, token, channelId);
      } catch (err) {
        console.error('[ChatWidget] Failed to initialize badges:', err);
      }
      const emoteSet = await fetchAllEmotes(channelName, channelId);
      setEmotes(emoteSet);

      // Preload channel-specific emotes with high priority for fast emote picker
      if (emoteSet) {
        // Prioritize channel emotes (7TV and BTTV channel emotes are most used)
        const channelEmotes = [
          ...emoteSet['7tv'],
          ...emoteSet.bttv,
          ...emoteSet.ffz
        ];

        // MODIFICATION: Removed aggressive preloading.
        // Previously we preloaded ALL channel emotes here, which caused UI freezes
        // on channels with many emotes (e.g. 500+ 7TV emotes).
        // Now we rely on the browser's natural loading or the Emote Picker's own virtualization.

        // If we really need preloading, we should only do the top 20-30 most used, not all.
        // For now, disabling is the safest fix for the freeze.
      }

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
        let sourceRoomId: string | null = null;
        let roomId: string | null = null;

        if (typeof message === 'string') {
          const sourceRoomIdMatch = message.match(/source-room-id=([^;]+)/);
          const roomIdMatch = message.match(/room-id=([^;]+)/);
          if (sourceRoomIdMatch) sourceRoomId = sourceRoomIdMatch[1];
          if (roomIdMatch) roomId = roomIdMatch[1];
        } else {
          sourceRoomId = message.tags['source-room-id'] || null;
          roomId = message.tags['room-id'] || null;
        }

        if (sourceRoomId && roomId && sourceRoomId !== roomId) {
          sourceRoomIds.add(sourceRoomId);
          hasSharedMessages = true;
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

        // Track message sent stat for analytics
        incrementStat(currentUser.user_id, 'messages_sent', 1).catch(err => {
          console.warn('[ChatWidget] Failed to track message sent stat:', err);
        });
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

  const emojiCategories = EMOJI_CATEGORIES;

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
    // Debug search
    console.log(`[EmojiSearch] Query: "${query}", Keywords loaded: ${Object.keys(EMOJI_KEYWORDS).length}`);
    return allEmojis.filter(({ emoji, category }) => {
      // Check category match
      if (category.toLowerCase().includes(query)) return true;
      // Check keywords match
      const keywords = EMOJI_KEYWORDS[emoji];
      if (keywords) {
        return keywords.some(k => k.includes(query));
      }
      return false;
    });
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
      
      // PHASE 3: Fetch message history from Rust LRU cache instead of frontend Map
      // This eliminates frontend memory overhead and provides more reliable history
      let messageHistory: any[] = [];
      try {
        messageHistory = await invoke<any[]>('get_user_message_history', { userId });
      } catch (err) {
        console.warn('[ChatWidget] Failed to fetch user history from Rust, using frontend cache:', err);
        messageHistory = userMessageHistory.current.get(userId) || [];
      }
      
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
        {/* Prediction Overlay - floating at top of chat */}
        <PredictionOverlay
          channelId={currentStream?.user_id}
          channelLogin={currentStream?.user_login}
        />

        {/* Chat header - absolute positioned at top */}
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

        {/* Chat messages area - flex-1 to take remaining space */}
        <div className="flex-1 overflow-hidden"
          onMouseEnter={() => { isHoveringChatRef.current = true; }}
          onMouseLeave={() => { isHoveringChatRef.current = false; }}>
          {messages.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-textSecondary text-sm">Waiting for messages...</p>
            </div>
          ) : (
            <AutoSizer>
              {({ height, width }) => (
                <>
                  <LayoutUpdater width={width} />
                  <ErrorBoundary componentName="ChatWidgetList" reportToLogService={true}>
                    {(() => {
                      containerHeightRef.current = height;
                      containerWidthRef.current = width;
                      const displayMessages = messages; // Always show all messages, even when paused
                      const totalHeight = Object.values(rowHeights.current).reduce((sum, height) => sum + height, 0);
                      const needsPadding = totalHeight < height;
                      const paddingHeight = needsPadding ? height - totalHeight : 0;
                      return (
                        <List ref={listRef} outerRef={outerRef} height={height} itemCount={displayMessages.length + (needsPadding ? 1 : 0)}
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
                            // Check if message is deleted (by message ID or user timeout/ban)
                            let isMessageDeleted = false;
                            if (currentMsgId && deletedMessageIds.has(currentMsgId)) {
                              isMessageDeleted = true;
                            } else {
                              // Check if user is cleared (timeout/ban)
                              const userId = typeof currentMessage !== 'string'
                                ? currentMessage.user_id
                                : currentMessage.match(/user-id=([^;]+)/)?.[1];
                              if (userId && clearedUserIds.has(userId)) {
                                isMessageDeleted = true;
                              }
                            }
                            return (
                              <div style={style}>
                                <ChatMessageRow message={currentMessage} messageIndex={messageIndex} messageId={currentMsgId}
                                  onUsernameClick={handleUsernameClick} onReplyClick={handleReplyClick}
                                  isHighlighted={highlightedMessageId !== null && currentMsgId === highlightedMessageId}
                                  isDeleted={isMessageDeleted}
                                  onEmoteRightClick={handleEmoteRightClick} onUsernameRightClick={handleUsernameRightClick}
                                  onBadgeClick={handleBadgeClick} setItemSize={setItemSize} />
                              </div>
                            );
                          }}
                        </List>
                      );
                    })()}
                  </ErrorBoundary>
                </>
              )}
            </AutoSizer>
          )}
        </div>

        {/* Chat Paused indicator - positioned above input */}
        {isPaused && (
          <div className="absolute bottom-[60px] left-1/2 transform -translate-x-1/2 z-50 pointer-events-auto">
            <button onClick={handleResume} className="flex items-center gap-2 px-4 py-2 glass-button text-white text-sm font-medium rounded-full shadow-lg bg-black/95">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              <span>Chat Paused ({messages.length - pausedMessageCount} new)</span>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
          </div>
        )}

        {/* Input container - static flex item at bottom */}
        <div className="flex-shrink-0 border-t border-borderSubtle backdrop-blur-ultra" style={{ backgroundColor: 'rgba(12, 12, 13, 0.9)' }}>
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
                                <img
                                  src={emote.localUrl || emote.url}
                                  alt={emote.name}
                                  className="w-8 h-8 object-contain"
                                  onLoad={() => {
                                    // Lazily cache this emote when it's displayed
                                    // Now safe to call due to download queue in service
                                    if (!emote.localUrl) {
                                      queueEmoteForCaching(emote.id, emote.url);
                                    }
                                  }}
                                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                                />
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
                {/* Channel Points button - shows tooltip on hover */}
                <div 
                  className="relative flex-shrink-0 group"
                  onMouseEnter={() => {
                    setChannelPointsHovered(true);
                    if (channelPoints === null && !isLoadingChannelPoints) {
                      setIsLoadingChannelPoints(true);
                      fetchChannelPoints().finally(() => setIsLoadingChannelPoints(false));
                    }
                  }}
                  onMouseLeave={() => setChannelPointsHovered(false)}
                >
                  <button
                    className="p-2 rounded transition-all text-textSecondary hover:text-orange-400 hover:bg-glass group-hover:text-orange-400"
                    title="Channel Points"
                  >
                    <ChannelPointsIcon size={18} />
                  </button>
                  {/* Points tooltip - visible on hover */}
                  {channelPointsHovered && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-black/95 border border-border rounded-lg shadow-lg whitespace-nowrap z-50">
                      <div className="flex items-center gap-1.5">
                        <ChannelPointsIcon size={14} className="text-orange-400" />
                        {isLoadingChannelPoints ? (
                          <span className="text-sm text-textSecondary">Loading...</span>
                        ) : channelPoints !== null ? (
                          <span className="text-sm font-bold text-orange-400">{channelPoints.toLocaleString()}</span>
                        ) : (
                          <span className="text-sm text-textSecondary">--</span>
                        )}
                      </div>
                      {/* Arrow pointing down */}
                      <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-black/95" />
                    </div>
                  )}
                </div>
                {/* Drops mining button - only shows if current game has active drops */}
                {dropsCampaign && (
                  <button
                    onClick={handleToggleMining}
                    disabled={isLoadingDrops}
                    className={`flex-shrink-0 p-2 rounded transition-all ${isMining
                      ? 'text-green-400 bg-glass hover:bg-glass-hover hover:text-red-400'
                      : 'text-accent bg-glass hover:bg-glass-hover hover:text-accent'
                      }`}
                    title={isMining ? `Stop mining drops for ${dropsCampaign.game_name}` : `Start mining drops for ${dropsCampaign.game_name}`}
                  >
                    <Pickaxe size={18} className={isMining ? 'animate-pulse' : ''} />
                  </button>
                )}
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
      {
        selectedUser && (
          <UserProfileCard userId={selectedUser.userId} username={selectedUser.username} displayName={selectedUser.displayName}
            color={selectedUser.color} badges={selectedUser.badges} messageHistory={userMessageHistory.current.get(selectedUser.userId) || []}
            onClose={() => setSelectedUser(null)} position={selectedUser.position} />
        )
      }
    </>
  );
};

export default ChatWidget;
