import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { fetchRecentMessagesAsIRC } from '../services/ivrService';

// Hardcoded message limit for optimal performance and stability (Twitch-style: 50 visible messages)
const CHAT_HISTORY_MAX = 50;
// Buffer size to allow when chat is paused (scrolled up)
const CHAT_BUFFER_SIZE = 150;
// Total max including buffer
const CHAT_MAX_WITH_BUFFER = CHAT_HISTORY_MAX + CHAT_BUFFER_SIZE;

export const useTwitchChat = () => {
  const [messages, setMessages] = useState<any[]>([]);
  const [isPausedForBuffer, setIsPausedForBuffer] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use refs for all mutable state that needs to be accessed in callbacks
  const wsRef = useRef<WebSocket | null>(null);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const isConnectingRef = useRef(false);
  const currentChannelRef = useRef<string | null>(null);
  const currentUserIdRef = useRef<string | null>(null);
  const isPausedForBufferRef = useRef(false);

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

  // Cleanup function to properly close WebSocket and clear handlers
  const cleanupWebSocket = useCallback(() => {
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

    // Clear old messages and seen IDs
    setMessages([]);
    seenMessageIdsRef.current = new Set();

    // Fetch recent messages from IVR API if roomId is provided
    if (roomId) {
      try {
        console.log('[Chat] Fetching recent messages from IVR API for:', channel);
        const recentMessages = await fetchRecentMessagesAsIRC(channel, roomId);
        if (recentMessages.length > 0) {
          console.log(`[Chat] Prepending ${recentMessages.length} recent messages`);
          // Add message IDs to seen set
          recentMessages.forEach(msg => {
            const idMatch = msg.match(/(?:^|;)id=([^;]+)/);
            if (idMatch) {
              seenMessageIdsRef.current.add(idMatch[1]);
            }
          });
          setMessages(recentMessages);
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

        // Check if message is JSON (new format with layout)
        if (message.startsWith('{')) {
          try {
            const parsed = JSON.parse(message);

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
                // Update cached badges for future optimistic messages
                if (parsed.badges) {
                  userBadgesFromIrcRef.current = parsed.badges;
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
        const threeMinutes = 3 * 60 * 1000;
        const fiveMinutes = 5 * 60 * 1000;

        // Use ref for current connected state
        if (!isConnectedRef.current) {
          return; // Skip health check if not connected
        }

        // If no messages for 3 minutes, show warning
        if (timeSinceLastMessage > threeMinutes && timeSinceLastMessage <= fiveMinutes) {
          console.warn('[Chat] No messages received for 3 minutes, connection may be stale');
          setError(`No activity for ${Math.floor(timeSinceLastMessage / 1000)}s - connection may be stale`);
        }

        // If no messages for 5 minutes, the stream might be offline
        // Trigger the auto-switch check which will verify via Twitch API
        if (timeSinceLastMessage > fiveMinutes) {
          console.log('[Chat] No messages for 5+ minutes, triggering stream offline check');

          // Get the handleStreamOffline function from AppStore
          // This will verify if the stream is actually offline via Twitch API
          // and trigger auto-switch if enabled
          const { handleStreamOffline, currentStream, isAutoSwitching } = useAppStore.getState();

          // Only trigger if we have a current stream and aren't already switching
          if (currentStream && !isAutoSwitching) {
            console.log('[Chat] Triggering handleStreamOffline from chat inactivity detection');
            handleStreamOffline();

            // Reset last message time to prevent repeated triggers
            // The handleStreamOffline will verify and handle appropriately
            lastMessageTimeRef.current = Date.now();
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
    // Prefer IRC badges from previous messages, fall back to provided badges
    const badges = userBadgesFromIrcRef.current || userInfo.badges || '';
    console.log('[Chat] Using badges for optimistic message:', badges, '(from IRC:', !!userBadgesFromIrcRef.current, ')');

    // Build reply tags if replying
    let replyTags = '';
    if (replyParentMsgId) {
      setMessages(currentMessages => {
        const parentMessage = currentMessages.find(msg => msg.includes(`id=${replyParentMsgId}`));

        if (parentMessage) {
          const parentDisplayNameMatch = parentMessage.match(/display-name=([^;]+)/);
          const parentUsernameMatch = parentMessage.match(/:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG/);
          const parentUserIdMatch = parentMessage.match(/user-id=([^;]+)/);
          const parentMsgBodyMatch = parentMessage.match(/PRIVMSG #\w+ :(.+)$/);

          const parentDisplayName = parentDisplayNameMatch ? parentDisplayNameMatch[1] : '';
          const parentUsername = parentUsernameMatch ? parentUsernameMatch[1] : '';
          const parentUserId = parentUserIdMatch ? parentUserIdMatch[1] : '';
          const parentMsgBody = parentMsgBodyMatch ? parentMsgBodyMatch[1] : '';

          const escapedParentMsgBody = parentMsgBody.replace(/\\/g, '\\\\').replace(/;/g, '\\:').replace(/ /g, '\\s').replace(/\r/g, '\\r').replace(/\n/g, '\\n');

          replyTags = `reply-parent-msg-id=${replyParentMsgId};reply-parent-user-id=${parentUserId};reply-parent-user-login=${parentUsername};reply-parent-display-name=${parentDisplayName};reply-parent-msg-body=${escapedParentMsgBody};`;
        } else {
          replyTags = `reply-parent-msg-id=${replyParentMsgId};`;
        }

        return currentMessages; // Don't modify messages in this setter
      });
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
      setMessages(prev => prev.filter(msg => !msg.includes(`id=${tempId}`)));
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      console.log('[Chat] Cleanup: unmounting');
      isIntentionalDisconnectRef.current = true;
      cleanupWebSocket();
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

  return { messages, connectChat, sendMessage, isConnected, error, setPaused };
};
