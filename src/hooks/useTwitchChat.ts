import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { fetchRecentMessagesAsIRC } from '../services/ivrService';

// Hardcoded message limit for optimal performance and stability
const CHAT_HISTORY_MAX = 100;
// Buffer size to allow when chat is paused (scrolled up)
const CHAT_BUFFER_SIZE = 150;
// Total max including buffer
const CHAT_MAX_WITH_BUFFER = CHAT_HISTORY_MAX + CHAT_BUFFER_SIZE;

// Deletion event types from IRC
interface ClearMsgEvent {
  type: 'CLEARMSG';
  target_msg_id: string;
  login: string;
}

interface ClearChatEvent {
  type: 'CLEARCHAT';
  target_user_id?: string;
  target_user?: string;
  ban_duration?: number;
}

// Moderation context for cleared messages
export interface ModerationContext {
  type: 'timeout' | 'ban' | 'deleted';
  duration?: number; // seconds, only for timeouts
  username?: string; // affected user
}

export const useTwitchChat = () => {
  const [messages, setMessages] = useState<any[]>([]);
  const [isPausedForBuffer, setIsPausedForBuffer] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track deleted message IDs for showing "[deleted]" styling
  const [deletedMessageIds, setDeletedMessageIds] = useState<Set<string>>(new Set());
  // Track users whose messages are cleared (timeout/ban) with moderation context
  const [clearedUserContexts, setClearedUserContexts] = useState<Map<string, ModerationContext>>(new Map());

  // Use refs for all mutable state that needs to be accessed in callbacks
  const wsRef = useRef<WebSocket | null>(null);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const isConnectingRef = useRef(false);
  const currentChannelRef = useRef<string | null>(null);
  const currentUserIdRef = useRef<string | null>(null);
  const isPausedForBufferRef = useRef(false);
  // Ref for synchronous access to messages (needed for optimistic reply tags)
  const messagesRef = useRef<any[]>([]);


  // Track the user's badge string from IRC for optimistic updates
  const userBadgesFromIrcRef = useRef<string | null>(null);

  // Track intentional disconnects to prevent reconnection attempts
  const isIntentionalDisconnectRef = useRef(false);

  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const maxReconnectAttempts = 10;
  const healthCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastMessageTimeRef = useRef<number>(Date.now());
  const isConnectedRef = useRef(false);

  // Keep ref in sync with state
  useEffect(() => {
    isPausedForBufferRef.current = isPausedForBuffer;
  }, [isPausedForBuffer]);

  useEffect(() => {
    isConnectedRef.current = isConnected;
  }, [isConnected]);

  // Keep messagesRef in sync for synchronous access in sendMessage
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Cleanup function to properly close WebSocket and clear handlers
  // Note: We do NOT call stop_chat here because the Rust backend handles its own
  // cleanup at the start of start_chat. Calling stop_chat from here causes a race
  // condition where channels get cleared during reconnection attempts (e.g., after PIP mode).
  const cleanupWebSocket = useCallback((stopBackend: boolean = false) => {
    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Clear health check interval
    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
      healthCheckIntervalRef.current = null;
    }

    // Close existing WebSocket if any
    if (wsRef.current) {
      const ws = wsRef.current;

      // Remove event handlers to prevent any callbacks during cleanup
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.onopen = null;

      if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        console.log('[Chat] Closing existing WebSocket connection');
        ws.close(1000, 'Cleanup'); // Normal closure
      }

      wsRef.current = null;
    }

    // Only stop the backend IRC service when explicitly requested (e.g., channel switch or app cleanup)
    // The Rust start_chat already calls stop() at its beginning, so we don't need to call it
    // during normal reconnection flows.
    if (stopBackend) {
      invoke('stop_chat').catch(err => {
        console.warn('[Chat] Failed to stop backend chat service:', err);
      });
    }
  }, []);

  const connectChat = useCallback(async (channel: string, roomId?: string) => {
    // Prevent duplicate connection attempts to the same channel
    if (isConnectingRef.current && currentChannelRef.current === channel) {
      console.log('[Chat] Already connecting to this channel, skipping duplicate request');
      return;
    }

    console.log(`[Chat] Attempting to connect to channel: ${channel}`);

    // Mark as intentional disconnect before cleanup
    isIntentionalDisconnectRef.current = true;

    // Clean up any existing connection first
    cleanupWebSocket();

    isConnectingRef.current = true;
    currentChannelRef.current = channel;
    setError(null);

    // Clear old messages, seen IDs, and moderation contexts
    setMessages([]);
    seenMessageIdsRef.current = new Set();
    setDeletedMessageIds(new Set());
    setClearedUserContexts(new Map());

    // Initialize badge cache BEFORE fetching IVR messages
    // This ensures historical messages have badges populated correctly
    if (roomId) {
      try {
        console.log('[Chat] Initializing badge cache before fetching recent messages');
        const { initializeBadgeCache } = await import('../services/twitchBadges');
        await initializeBadgeCache(roomId);
      } catch (err) {
        console.warn('[Chat] Failed to initialize badge cache:', err);
        // Continue anyway - badges may not display but chat will still work
      }
    }

    // Fetch recent messages from IVR API if roomId is provided
    // Route through Rust backend for proper parsing and layout calculation
    if (roomId) {
      try {
        console.log('[Chat] Fetching recent messages from IVR API for:', channel);
        const recentMessagesRaw = await fetchRecentMessagesAsIRC(channel, roomId);
        if (recentMessagesRaw.length > 0) {
          console.log(`[Chat] Parsing ${recentMessagesRaw.length} recent messages through Rust backend`);
          
          // Parse historical messages through Rust for proper layout calculation
          // This ensures historical messages get the same accurate heights as live messages
          // Add retry logic to handle Tauri IPC initialization timing issues
          let parsedMessages: any[] | null = null;
          let parseAttempts = 0;
          const maxParseAttempts = 3;
          
          while (parseAttempts < maxParseAttempts && !parsedMessages) {
            try {
              // Small delay on retries to allow Tauri IPC to initialize
              if (parseAttempts > 0) {
                await new Promise(resolve => setTimeout(resolve, 200 * parseAttempts));
                console.log(`[Chat] Retrying parse_historical_messages (attempt ${parseAttempts + 1}/${maxParseAttempts})`);
              }
              
              parsedMessages = await invoke<any[]>('parse_historical_messages', { 
                messages: recentMessagesRaw 
              });
            } catch (parseErr: any) {
              parseAttempts++;
              // Check if it's an IPC connection error (Tauri not ready)
              const isIpcError = parseErr?.message?.includes('Failed to fetch') || 
                                 parseErr?.message?.includes('ERR_CONNECTION_REFUSED') ||
                                 parseErr?.toString?.().includes('Failed to fetch');
              
              if (isIpcError && parseAttempts < maxParseAttempts) {
                console.warn(`[Chat] Tauri IPC not ready, will retry (attempt ${parseAttempts}/${maxParseAttempts})`);
                continue;
              }
              
              // Final attempt failed or non-IPC error
              console.warn('[Chat] Rust parsing failed, falling back to raw IRC strings:', parseErr);
              break;
            }
          }
          
          if (parsedMessages && parsedMessages.length > 0) {
            console.log(`[Chat] Received ${parsedMessages.length} parsed messages from Rust backend`);
            // Add message IDs to seen set
            parsedMessages.forEach(msg => {
              if (msg.id) {
                seenMessageIdsRef.current.add(msg.id);
              }
            });
            setMessages(parsedMessages);
          } else {
            // Fallback to raw IRC strings if Rust parsing failed
            console.log('[Chat] Using raw IRC strings as fallback');
            recentMessagesRaw.forEach(msg => {
              const idMatch = msg.match(/(?:^|;)id=([^;]+)/);
              if (idMatch) {
                seenMessageIdsRef.current.add(idMatch[1]);
              }
            });
            setMessages(recentMessagesRaw);
          }
        }
      } catch (err) {
        console.error('[Chat] Failed to fetch recent messages:', err);
        // Continue without recent messages - not a critical failure
      }
    }

    // Reset reconnect attempts for new channel
    reconnectAttemptsRef.current = 0;

    // Allow time for cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 150));

    // Clear the intentional disconnect flag now that we're starting a new connection
    isIntentionalDisconnectRef.current = false;

    try {
      console.log('[Chat] Invoking start_chat command');
      const port = await invoke<number>('start_chat', { channel });
      console.log(`[Chat] Received port: ${port}`);

      // Retry logic for WebSocket connection
      const connectWithRetry = async (retries = 5): Promise<WebSocket> => {
        for (let i = 0; i < retries; i++) {
          try {
            // Wait longer on each retry
            const delay = 500 + (i * 500);
            console.log(`[Chat] Waiting ${delay}ms before connection attempt ${i + 1}/${retries}`);
            await new Promise(resolve => setTimeout(resolve, delay));

            // Check if we've been cleaned up or channel changed
            if (currentChannelRef.current !== channel) {
              throw new Error('Channel changed during connection attempt');
            }

            const wsUrl = `ws://localhost:${port}`;
            console.log(`[Chat] Connecting to ${wsUrl}`);
            const ws = new WebSocket(wsUrl);

            // Wait for connection to open or fail
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => {
                console.log('[Chat] Connection timeout');
                reject(new Error('Connection timeout'));
              }, 5000);

              ws.onopen = () => {
                clearTimeout(timeout);
                console.log('[Chat] WebSocket connected successfully');
                resolve();
              };

              ws.onerror = (err) => {
                clearTimeout(timeout);
                console.error('[Chat] WebSocket connection error:', err);
                reject(new Error('Connection failed'));
              };
            });

            return ws;
          } catch (err) {
            console.error(`[Chat] Connection attempt ${i + 1} failed:`, err);
            if (i === retries - 1) throw err;
          }
        }
        throw new Error('All connection attempts failed');
      };

      const newWs = await connectWithRetry();

      // Store the WebSocket reference
      wsRef.current = newWs;

      // Set connected state immediately since connectWithRetry already waited for connection
      console.log('[Chat] Setting connected state to true');
      setIsConnected(true);
      reconnectAttemptsRef.current = 0;
      lastMessageTimeRef.current = Date.now();

      newWs.onmessage = (event) => {
        const message = event.data;

        // Update last message time for health monitoring
        lastMessageTimeRef.current = Date.now();

        // Handle connection warnings
        if (message.startsWith('CONNECTION_WARNING:')) {
          const warning = message.split(':')[1];
          console.warn('[Chat] Connection warning:', warning);
          setError(`Warning: ${warning}`);
          return;
        }

        // Handle reconnection notifications - silently in the background
        if (message === 'RECONNECTED') {
          console.log('[Chat] Backend reconnected to Twitch IRC');
          setIsConnected(true);
          setError(null);
          reconnectAttemptsRef.current = 0;
          lastMessageTimeRef.current = Date.now();
          return;
        }

        if (message.startsWith('RECONNECTING:')) {
          const attempt = message.split(':')[1];
          console.log(`[Chat] Backend attempting to reconnect (attempt ${attempt})`);
          setIsConnected(false);
          return;
        }

        if (message.startsWith('RECONNECT_FAILED:')) {
          const attempt = message.split(':')[1];
          console.log(`[Chat] Reconnection attempt ${attempt} failed`);
          return;
        }

        if (message === 'RECONNECT_STOPPED') {
          console.log('[Chat] Reconnection stopped by backend');
          setError('Connection stopped');
          setIsConnected(false);
          return;
        }

        if (message === 'RECONNECT_EXHAUSTED') {
          console.log('[Chat] Max reconnection attempts reached');
          setError('Unable to reconnect to chat. Please refresh.');
          setIsConnected(false);
          return;
        }

        // Handle USER_BADGES message from backend - contains user's IRC badges
        if (message.startsWith('USER_BADGES:')) {
          const badges = message.substring('USER_BADGES:'.length);
          console.log('[Chat] Received user badges from IRC:', badges);
          userBadgesFromIrcRef.current = badges;
          return;
        }

        // Handle HEARTBEAT message from backend - just proves connection is alive
        // Don't add to messages, just update health check timestamp
        if (message === 'HEARTBEAT') {
          // lastMessageTimeRef is already updated at top of onmessage
          // Clear any stale connection errors since we just received proof of life
          setError(null);
          return;
        }

        // Handle IRC_CONNECTED and IRC_RECONNECTING status messages
        if (message === 'IRC_CONNECTED') {
          console.log('[Chat] IRC connection established');
          setIsConnected(true);
          setError(null);
          return;
        }

        if (message === 'IRC_RECONNECTING') {
          console.log('[Chat] IRC reconnecting...');
          setError('Reconnecting to chat...');
          return;
        }

        // Check if message is JSON (new format with layout, or deletion events)
        if (message.startsWith('{')) {
          try {
            const parsed = JSON.parse(message);

            // Handle CLEARMSG event - single message deleted by mod
            if (parsed.type === 'CLEARMSG' && parsed.target_msg_id) {
              console.log('[Chat] CLEARMSG: Message deleted by mod:', parsed.target_msg_id, 'user:', parsed.login);
              setDeletedMessageIds(prev => {
                const newSet = new Set(prev);
                newSet.add(parsed.target_msg_id);
                return newSet;
              });
              return;
            }

            // Handle CLEARCHAT event - user timed out/banned or chat cleared
            if (parsed.type === 'CLEARCHAT') {
              if (parsed.target_user_id) {
                // Determine moderation type based on ban_duration
                // If ban_duration is present (even 0), it's a timeout
                // If ban_duration is absent/undefined, it's a permanent ban
                const moderationType: 'timeout' | 'ban' = 
                  parsed.ban_duration !== undefined && parsed.ban_duration !== null 
                    ? 'timeout' 
                    : 'ban';
                
                console.log(
                  '[Chat] CLEARCHAT:', 
                  moderationType === 'timeout' 
                    ? `User timed out for ${parsed.ban_duration}s:` 
                    : 'User banned:',
                  parsed.target_user
                );
                
                setClearedUserContexts(prev => {
                  const newMap = new Map(prev);
                  newMap.set(parsed.target_user_id, {
                    type: moderationType,
                    duration: parsed.ban_duration,
                    username: parsed.target_user,
                  });
                  return newMap;
                });
              } else {
                // Full chat clear - this is rare, usually mod action
                console.log('[Chat] CLEARCHAT: Full chat clear');
              }
              return;
            }

            // It's a structured ChatMessage
            const messageId = parsed.id;

            if (messageId) {
              if (seenMessageIdsRef.current.has(messageId)) {
                // If we have an optimistic message with this ID (unlikely for uuid, but possible if we sync IDs), replace it?
                // Actually backend generates UUIDs.
                // We might want to match optimistic messages by content if possible?
                // The current logic matches by "id=local-..." vs regex content.
                // Let's keep simple duplicate check first.
                console.log('[Chat] Duplicate JSON message', messageId);
                return;
              }

              // Check if we can replace an optimistic message
              if (parsed.user_id === currentUserIdRef.current) {
                // Update cached badges for future optimistic messages.
                // `userBadgesFromIrcRef` is a STRING in IRC tag format.
                // JSON messages provide badges as an array.
                if (Array.isArray(parsed.badges)) {
                  userBadgesFromIrcRef.current = parsed.badges
                    .map((b: any) => `${b.name}/${b.version}`)
                    .join(',');
                }

                setMessages(prevMessages => {
                  // Calculate limit
                  const limit = isPausedForBufferRef.current ? CHAT_MAX_WITH_BUFFER : CHAT_HISTORY_MAX;

                  // Find optimistic message to replace
                  const optimisticIndex = prevMessages.findIndex(msg => {
                    if (typeof msg !== 'string') return false;
                    if (!msg.includes('id=local-')) return false;

                    // Extract content from optimistic string
                    const localContentMatch = msg.match(/PRIVMSG #\w+ :(.+)$/);
                    const localContent = localContentMatch ? localContentMatch[1] : null;

                    return localContent === parsed.content;
                  });

                  let updated;
                  if (optimisticIndex !== -1) {
                    console.log('[Chat] Replacing optimistic string with backend object at index', optimisticIndex);
                    updated = [...prevMessages];
                    updated[optimisticIndex] = parsed;
                  } else {
                    updated = [...prevMessages, parsed];
                  }

                  seenMessageIdsRef.current.add(messageId);

                  if (updated.length > limit) {
                    return updated.slice(updated.length - limit);
                  }
                  return updated;
                });
                return;
              }

              seenMessageIdsRef.current.add(messageId);

              setMessages(prev => {
                const updated = [...prev, parsed];
                const limit = isPausedForBufferRef.current ? CHAT_MAX_WITH_BUFFER : CHAT_HISTORY_MAX;
                if (updated.length > limit) {
                  return updated.slice(updated.length - limit);
                }
                return updated;
              });
              return;
            }
          } catch (e) {
            console.error('[Chat] Failed to parse JSON message:', e);
          }
        }

        // Legacy/System message handling (strings)
        console.log('[Chat] Received string message:', message);

        // Check for USERNOTICE (subscription events) and dispatch custom event
        if (message.includes('USERNOTICE')) {
          // Extract relevant fields from USERNOTICE
          const loginMatch = message.match(/(?:^|;)login=([^;]+)/);
          const msgIdMatch = message.match(/(?:^|;)msg-id=([^;]+)/);
          const displayNameMatch = message.match(/(?:^|;)display-name=([^;]+)/);
          
          const login = loginMatch ? loginMatch[1] : null;
          const msgId = msgIdMatch ? msgIdMatch[1] : null;
          const displayName = displayNameMatch ? displayNameMatch[1] : null;
          
          // Check if this is a subscription-related event
          const subTypes = ['sub', 'resub', 'subgift', 'submysterygift', 'giftpaidupgrade', 'primepaidupgrade', 'anongiftpaidupgrade'];
          if (login && msgId && subTypes.includes(msgId)) {
            console.log('[Chat] Detected subscription event:', { login, msgId, displayName });
            
            // Dispatch a custom event for subscription detection
            const subscriptionEvent = new CustomEvent('twitch-subscription-detected', {
              detail: {
                login: login.toLowerCase(),
                msgId,
                displayName,
                rawMessage: message
              }
            });
            window.dispatchEvent(subscriptionEvent);
          }
        }

        // Extract message ID and user ID from IRC tags
        // IMPORTANT: Match the actual message ID, not reply-parent-msg-id
        const idMatch = message.match(/(?:^|;)id=([^;]+)/);
        const messageId = idMatch ? idMatch[1] : null;
        const userIdMatch = message.match(/user-id=([^;]+)/);
        const userId = userIdMatch ? userIdMatch[1] : null;

        // Handle our own messages from the server - replace optimistic version with server version
        // This ensures we get the correct badges from IRC
        if (userId && currentUserIdRef.current && userId === currentUserIdRef.current) {
          console.log('[Chat] Received own message from server:', messageId);

          // Extract badges from the server message and store for future optimistic updates
          const badgesMatch = message.match(/(?:^|;)badges=([^;]*)/);
          if (badgesMatch && badgesMatch[1]) {
            userBadgesFromIrcRef.current = badgesMatch[1];
            console.log('[Chat] Stored user badges from IRC:', userBadgesFromIrcRef.current);
          }

          // Find and replace the optimistic message with the server message
          setMessages(prevMessages => {
            // Look for an optimistic message (local-*) from the same user with similar content
            const msgContentMatch = message.match(/PRIVMSG #\w+ :(.+)$/);
            const serverContent = msgContentMatch ? msgContentMatch[1] : null;

            if (serverContent) {
              // Find the optimistic message to replace
              const optimisticIndex = prevMessages.findIndex(msg => {
                // Check if it's a local/optimistic message (string or object?)
                // Optimistic are currently strings.
                if (typeof msg === 'string' && !msg.includes('id=local-')) return false;
                if (typeof msg !== 'string') return false; // Optimistic are strings for now

                // Check if content matches
                const localContentMatch = msg.match(/PRIVMSG #\w+ :(.+)$/);
                const localContent = localContentMatch ? localContentMatch[1] : null;

                return localContent === serverContent;
              });

              if (optimisticIndex !== -1) {
                console.log('[Chat] Replacing optimistic message at index', optimisticIndex, 'with server message');
                const updated = [...prevMessages];
                updated[optimisticIndex] = message;

                // Add the server message ID to seen set
                if (messageId) {
                  seenMessageIdsRef.current.add(messageId);
                }

                return updated;
              }
            }

            // If no optimistic message found to replace, just add the server message
            // (This handles cases where the optimistic message was already removed)
            console.log('[Chat] No optimistic message found to replace, adding server message');
            if (messageId) {
              seenMessageIdsRef.current.add(messageId);
            }
            return [...prevMessages, message];
          });

          return;
        }

        if (messageId) {
          // Check if we've seen this message before using ref
          if (seenMessageIdsRef.current.has(messageId)) {
            console.log('[Chat] Duplicate message detected, skipping:', messageId);
            return;
          }

          // New message - add to seen set
          console.log('[Chat] New message:', messageId);
          seenMessageIdsRef.current.add(messageId);

          // Keep seen IDs manageable
          if (seenMessageIdsRef.current.size > CHAT_MAX_WITH_BUFFER) {
            const arr = Array.from(seenMessageIdsRef.current);
            seenMessageIdsRef.current = new Set(arr.slice(-CHAT_MAX_WITH_BUFFER));
          }

          // Add message to state
          setMessages(prevMessages => {
            const updated = [...prevMessages, message];
            // Use ref for paused state to get current value
            const limit = isPausedForBufferRef.current ? CHAT_MAX_WITH_BUFFER : CHAT_HISTORY_MAX;

            if (updated.length > limit) {
              const trimmed = updated.slice(updated.length - limit);
              console.log(`[Chat] Total messages: ${trimmed.length} (limit: ${limit})`);
              return trimmed;
            }
            console.log(`[Chat] Total messages: ${updated.length} (limit: ${limit})`);
            return updated;
          });
        } else {
          // If no ID, just add it (shouldn't happen with Twitch messages)
          console.log('[Chat] Message without ID, adding anyway');
          setMessages(prev => [...prev, message]);
        }
      };

      newWs.onerror = (error) => {
        console.error('[Chat] WebSocket error:', error);
        setError('Connection error - attempting to reconnect');
        setIsConnected(false);
      };

      newWs.onclose = (event) => {
        console.log('[Chat] WebSocket closed:', event.code, event.reason);
        setIsConnected(false);

        // Don't attempt to reconnect if this was an intentional disconnect
        if (isIntentionalDisconnectRef.current) {
          console.log('[Chat] Intentional disconnect, not reconnecting');
          return;
        }

        // Don't reconnect if channel has changed
        if (currentChannelRef.current !== channel) {
          console.log('[Chat] Channel changed, not reconnecting to old channel');
          return;
        }

        // Attempt to reconnect the local WebSocket for abnormal closures
        if (event.code === 1006 || event.code === 1001) {
          console.log('[Chat] Abnormal closure detected, attempting to reconnect local WebSocket');

          // Clear any existing reconnect timeout
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
          }

          // Only attempt reconnect if we haven't exceeded max attempts
          if (reconnectAttemptsRef.current < maxReconnectAttempts && currentChannelRef.current) {
            reconnectAttemptsRef.current++;
            const backoffDelay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), 30000);

            console.log(`[Chat] Scheduling reconnect attempt ${reconnectAttemptsRef.current}/${maxReconnectAttempts} in ${backoffDelay}ms`);
            setError(`Connection lost - reconnecting in ${Math.round(backoffDelay / 1000)}s (attempt ${reconnectAttemptsRef.current}/${maxReconnectAttempts})`);

            reconnectTimeoutRef.current = setTimeout(() => {
              console.log('[Chat] Executing reconnect attempt');
              const channelToReconnect = currentChannelRef.current;
              if (channelToReconnect && !isIntentionalDisconnectRef.current) {
                // Reset the connecting flag to allow reconnection
                isConnectingRef.current = false;
                connectChat(channelToReconnect);
              }
            }, backoffDelay);
          } else if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
            setError('Connection lost - max reconnection attempts reached. Please refresh the chat.');
          }
        } else {
          setError('Connection closed');
        }
      };

      // Start health check monitoring
      if (healthCheckIntervalRef.current) {
        clearInterval(healthCheckIntervalRef.current);
      }

      healthCheckIntervalRef.current = setInterval(() => {
        const timeSinceLastMessage = Date.now() - lastMessageTimeRef.current;
        // With heartbeats every 30s, 2 minutes means ~4 missed heartbeats = real issue
        const twoMinutes = 2 * 60 * 1000;
        // 3 minutes without any signal (including heartbeats) = connection is dead
        const threeMinutes = 3 * 60 * 1000;

        // Use ref for current connected state
        if (!isConnectedRef.current) {
          return; // Skip health check if not connected
        }

        // If no messages (including heartbeats) for 2 minutes, show warning
        // This should only happen if the WebSocket connection is actually broken
        if (timeSinceLastMessage > twoMinutes && timeSinceLastMessage <= threeMinutes) {
          console.warn('[Chat] No messages/heartbeats received for 2 minutes, connection may be stale');
          setError(`Connection may be stale - no data for ${Math.floor(timeSinceLastMessage / 1000)}s`);
        }

        // If no messages (including heartbeats) for 3 minutes, the WebSocket is likely dead
        // Perform a silent stream check before deciding whether to reconnect chat or trigger offline
        if (timeSinceLastMessage > threeMinutes) {
          console.log('[Chat] No messages/heartbeats for 3+ minutes, connection appears dead');

          const { handleStreamOffline, currentStream, isAutoSwitching } = useAppStore.getState();

          // Only proceed if we have a current stream and aren't already switching
          if (currentStream && !isAutoSwitching) {
            // Reset last message time to prevent repeated triggers during this check
            lastMessageTimeRef.current = Date.now();

            // Perform a silent check to see if the stream is actually online
            // This prevents the "nuclear" option of tearing down the stream when only chat has stalled
            // Use IIFE to handle async code inside setInterval callback
            (async () => {
              try {
                console.log('[Chat] Performing silent stream online check before triggering offline...');
                const isOnline = await invoke<boolean>('check_stream_online', { 
                  channel: currentStream.user_login 
                });

                if (isOnline) {
                  // Stream is still online - this is just a chat connection issue
                  // Reconnect only the chat, don't trigger the full handleStreamOffline flow
                  console.log('[Chat] Stream is still online but chat is dead. Reconnecting chat only...');
                  
                  // Reset connecting flag and reconnect to the same channel
                  isConnectingRef.current = false;
                  connectChat(currentStream.user_login, currentStream.user_id);
                } else {
                  // Stream is actually offline - trigger the full offline handling
                  console.log('[Chat] Stream confirmed offline. Triggering handleStreamOffline...');
                  handleStreamOffline();
                }
              } catch (err) {
                // If the check fails, fall back to reconnecting chat as a safe default
                // This is better than potentially tearing down a working stream
                console.warn('[Chat] Failed to check stream status, attempting chat reconnect:', err);
                isConnectingRef.current = false;
                connectChat(currentStream.user_login, currentStream.user_id);
              }
            })();
          }
        }
      }, 30000); // Check every 30 seconds

      console.log('[Chat] Connection setup complete with health monitoring');
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error('[Chat] Failed to connect to chat:', errorMsg);
      setError(errorMsg);
      setIsConnected(false);
    } finally {
      isConnectingRef.current = false;
    }
  }, [cleanupWebSocket]);

  // Send message with optimistic update, filter out our own messages from server
  const sendMessage = useCallback(async (messageText: string, userInfo: { username: string; displayName: string; userId: string; color?: string; badges?: string }, replyParentMsgId?: string) => {
    if (!messageText.trim() || !isConnected) {
      return;
    }

    // Store current user ID for filtering
    currentUserIdRef.current = userInfo.userId;

    // Generate a unique ID for the optimistic message
    const tempId = `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Create an optimistic message in IRC format
    const timestamp = Date.now();
    const color = userInfo.color || '#8A2BE2';
    // Prefer provided badges (from fresh user info), fall back to IRC badges
    const badges = userInfo.badges || userBadgesFromIrcRef.current || '';
    console.log('[Chat] Using badges for optimistic message:', badges, '(is fresh:', !!userInfo.badges, ')');

    // Build reply tags synchronously if replying
    // Use messagesRef for synchronous access (setMessages callback is async)
    let replyTags = '';
    if (replyParentMsgId) {
      const currentMessages = messagesRef.current;
      
      // Handle both string (IRC format) and object (JSON format) messages
      const parentMessage = currentMessages.find(msg => {
        if (typeof msg === 'string') {
          return msg.includes(`id=${replyParentMsgId}`);
        } else if (msg && typeof msg === 'object') {
          return (msg as any).id === replyParentMsgId;
        }
        return false;
      });

      if (parentMessage) {
        let parentDisplayName = '';
        let parentUsername = '';
        let parentUserId = '';
        let parentMsgBody = '';

        if (typeof parentMessage === 'string') {
          // IRC string format
          const parentDisplayNameMatch = parentMessage.match(/display-name=([^;]+)/);
          const parentUsernameMatch = parentMessage.match(/:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG/);
          const parentUserIdMatch = parentMessage.match(/user-id=([^;]+)/);
          const parentMsgBodyMatch = parentMessage.match(/PRIVMSG #\w+ :(.+)$/);

          parentDisplayName = parentDisplayNameMatch ? parentDisplayNameMatch[1] : '';
          parentUsername = parentUsernameMatch ? parentUsernameMatch[1] : '';
          parentUserId = parentUserIdMatch ? parentUserIdMatch[1] : '';
          parentMsgBody = parentMsgBodyMatch ? parentMsgBodyMatch[1] : '';
        } else if (parentMessage && typeof parentMessage === 'object') {
          // JSON object format
          const pm = parentMessage as any;
          parentDisplayName = pm.display_name || '';
          parentUsername = pm.username || '';
          parentUserId = pm.user_id || '';
          parentMsgBody = pm.content || '';
        }

        const escapedParentMsgBody = parentMsgBody.replace(/\\/g, '\\\\').replace(/;/g, '\\:').replace(/ /g, '\\s').replace(/\r/g, '\\r').replace(/\n/g, '\\n');

        replyTags = `reply-parent-msg-id=${replyParentMsgId};reply-parent-user-id=${parentUserId};reply-parent-user-login=${parentUsername};reply-parent-display-name=${parentDisplayName};reply-parent-msg-body=${escapedParentMsgBody};`;
      } else {
        replyTags = `reply-parent-msg-id=${replyParentMsgId};`;
      }
    }

    const optimisticMessage = `@badge-info=;badges=${badges};color=${color};display-name=${userInfo.displayName};emotes=;first-msg=0;flags=;id=${tempId};mod=0;${replyTags}returning-chatter=0;room-id=;subscriber=0;tmi-sent-ts=${timestamp};turbo=0;user-id=${userInfo.userId};user-type= :${userInfo.username}!${userInfo.username}@${userInfo.username}.tmi.twitch.tv PRIVMSG #${currentChannelRef.current} :${messageText}`;

    // Add to seen IDs and messages
    seenMessageIdsRef.current.add(tempId);
    setMessages(prev => [...prev, optimisticMessage]);

    try {
      await invoke('send_chat_message', {
        message: messageText,
        replyParentMsgId: replyParentMsgId || null
      });
      console.log('[Chat] Message sent successfully:', messageText, replyParentMsgId ? `(replying to ${replyParentMsgId})` : '');
    } catch (err) {
      console.error('[Chat] Failed to send message:', err);

      // Remove the optimistic message on error
      setMessages(prev => prev.filter(msg => {
        if (typeof msg === 'string') {
          return !msg.includes(`id=${tempId}`);
        }
        // For objects, check the id property
        return msg?.id !== tempId;
      }));
      seenMessageIdsRef.current.delete(tempId);

      throw err;
    }
  }, [isConnected]);

  // Handle visibility change to keep connection alive
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        console.log('[Chat] App minimized/hidden - connection will be maintained');
      } else {
        console.log('[Chat] App visible again');
        // Check if connection is still alive
        const ws = wsRef.current;
        if (ws && ws.readyState !== WebSocket.OPEN && currentChannelRef.current && !isIntentionalDisconnectRef.current) {
          console.log('[Chat] Connection lost while hidden, reconnecting...');
          isConnectingRef.current = false;
          connectChat(currentChannelRef.current);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [connectChat]);

  // Cleanup on unmount - pass true to also stop the backend IRC service
  useEffect(() => {
    return () => {
      console.log('[Chat] Cleanup: unmounting');
      isIntentionalDisconnectRef.current = true;
      cleanupWebSocket(true); // Stop backend when component unmounts
    };
  }, [cleanupWebSocket]);

  // Trim messages back to normal limit (called when resuming from pause)
  const trimToLimit = useCallback(() => {
    setMessages(prev => {
      if (prev.length > CHAT_HISTORY_MAX) {
        console.log(`[Chat] Trimming from ${prev.length} to ${CHAT_HISTORY_MAX} messages`);
        return prev.slice(prev.length - CHAT_HISTORY_MAX);
      }
      return prev;
    });
  }, []);

  // Set pause state for buffering
  const setPaused = useCallback((paused: boolean) => {
    console.log(`[Chat] Buffer pause state: ${paused}`);
    setIsPausedForBuffer(paused);

    // If unpausing, trim messages back to limit
    if (!paused) {
      trimToLimit();
    }
  }, [trimToLimit]);

  return { messages, connectChat, sendMessage, isConnected, error, setPaused, deletedMessageIds, clearedUserContexts };
};
