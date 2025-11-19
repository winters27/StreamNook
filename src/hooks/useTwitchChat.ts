import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';

export const useTwitchChat = () => {
  const [messages, setMessages] = useState<any[]>([]);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seenMessageIds, setSeenMessageIds] = useState<Set<string>>(new Set());
  const isConnectingRef = useRef(false);
  const currentChannelRef = useRef<string | null>(null);
  const currentUserIdRef = useRef<string | null>(null);

  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const maxReconnectAttempts = 10;
  const healthCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastMessageTimeRef = useRef<number>(Date.now());

  const connectChat = useCallback(async (channel: string) => {
    // Prevent duplicate connection attempts
    if (isConnectingRef.current && currentChannelRef.current === channel) {
      console.log('[Chat] Already connecting to this channel, skipping duplicate request');
      return;
    }
    
    isConnectingRef.current = true;
    currentChannelRef.current = channel;
    console.log(`[Chat] Attempting to connect to channel: ${channel}`);
    setError(null);
    
    try {
      // Close existing connection if any
      setWs(prevWs => {
        if (prevWs && prevWs.readyState !== WebSocket.CLOSED) {
          console.log('[Chat] Closing existing WebSocket connection');
          prevWs.close();
        }
        return null;
      });
      
      // Small delay to ensure cleanup
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Clear old messages and seen IDs
      setMessages([]);
      setSeenMessageIds(new Set());
      
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
      
      // Set connected state immediately since connectWithRetry already waited for connection
      console.log('[Chat] Setting connected state to true');
      setIsConnected(true);
      reconnectAttemptsRef.current = 0; // Reset reconnect attempts on successful connection
      
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
          // Don't show error to user - handle silently in background
          setIsConnected(false);
          return;
        }
        
        if (message.startsWith('RECONNECT_FAILED:')) {
          const attempt = message.split(':')[1];
          console.log(`[Chat] Reconnection attempt ${attempt} failed`);
          // Don't show error to user - handle silently in background
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
        
        console.log('[Chat] Received message:', message);
        
        // Extract message ID and user ID from IRC tags
        // IMPORTANT: Match the actual message ID, not reply-parent-msg-id
        // Use word boundary to ensure we match 'id=' and not 'reply-parent-msg-id=' or other IDs
        const idMatch = message.match(/(?:^|;)id=([^;]+)/);
        const messageId = idMatch ? idMatch[1] : null;
        const userIdMatch = message.match(/user-id=([^;]+)/);
        const userId = userIdMatch ? userIdMatch[1] : null;
        
        // Filter out our own messages from the server (we show optimistic versions)
        if (userId && currentUserIdRef.current && userId === currentUserIdRef.current) {
          console.log('[Chat] Filtering out own message from server:', messageId);
          return;
        }
        
        if (messageId) {
          // Check if we've seen this message before
          setSeenMessageIds(prev => {
            if (prev.has(messageId)) {
              console.log('[Chat] Duplicate message detected, skipping:', messageId);
              return prev;
            }
            
            // New message - add it
            console.log('[Chat] New message:', messageId);
            setMessages(prevMessages => {
              const { settings } = useAppStore.getState();
              const chatHistoryMax = settings.chat_history_max || 500; // Default to 500 if not set
              
              const updated = [...prevMessages, message];
              // Trim chat history if it exceeds the max
              if (updated.length > chatHistoryMax) {
                return updated.slice(updated.length - chatHistoryMax);
              }
              console.log(`[Chat] Total messages: ${updated.length}`);
              return updated;
            });
            
            // Add to seen messages
            const newSet = new Set(prev);
            newSet.add(messageId);
            
            // Keep only last `chatHistoryMax` message IDs to prevent memory issues
            const { settings } = useAppStore.getState();
            const chatHistoryMax = settings.chat_history_max || 500; // Default to 500 if not set
            if (newSet.size > chatHistoryMax) {
              const arr = Array.from(newSet);
              return new Set(arr.slice(-chatHistoryMax));
            }
            
            return newSet;
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
        
        // Attempt to reconnect the local WebSocket (not the backend IRC connection)
        // The backend handles IRC reconnection, but we need to handle local WS reconnection
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
              if (channelToReconnect) {
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
        
        // If no messages for 3 minutes, show warning
        if (timeSinceLastMessage > threeMinutes && isConnected) {
          console.warn('[Chat] No messages received for 3 minutes, connection may be stale');
          setError(`No activity for ${Math.floor(timeSinceLastMessage / 1000)}s - connection may be stale`);
        }
        
        // If no messages for 5 minutes, force reconnect
        if (timeSinceLastMessage > 5 * 60 * 1000 && isConnected) {
          console.error('[Chat] No messages for 5 minutes, forcing reconnect');
          setError('Connection appears dead - reconnecting...');
          setIsConnected(false);
          
          // Close and reconnect
          if (newWs.readyState === WebSocket.OPEN) {
            newWs.close();
          }
          
          // Trigger reconnection
          isConnectingRef.current = false;
          if (currentChannelRef.current) {
            connectChat(currentChannelRef.current);
          }
        }
      }, 30000); // Check every 30 seconds
      
      setWs(newWs);
      console.log('[Chat] Connection setup complete with health monitoring');
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error('[Chat] Failed to connect to chat:', errorMsg);
      setError(errorMsg);
      setIsConnected(false);
    } finally {
      isConnectingRef.current = false;
    }
  }, []);

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
    const badges = userInfo.badges || '';
    
    // Build reply tags if replying - need to include parent message info for proper display
    let replyTags = '';
    if (replyParentMsgId) {
      // Find the parent message to extract its details
      const parentMessage = messages.find(msg => msg.includes(`id=${replyParentMsgId}`));
      
      if (parentMessage) {
        // Extract parent message details
        const parentDisplayNameMatch = parentMessage.match(/display-name=([^;]+)/);
        const parentUsernameMatch = parentMessage.match(/:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG/);
        const parentUserIdMatch = parentMessage.match(/user-id=([^;]+)/);
        const parentMsgBodyMatch = parentMessage.match(/PRIVMSG #\w+ :(.+)$/);
        
        const parentDisplayName = parentDisplayNameMatch ? parentDisplayNameMatch[1] : '';
        const parentUsername = parentUsernameMatch ? parentUsernameMatch[1] : '';
        const parentUserId = parentUserIdMatch ? parentUserIdMatch[1] : '';
        const parentMsgBody = parentMsgBodyMatch ? parentMsgBodyMatch[1] : '';
        
        // Escape special characters in the message body for IRC format
        const escapedParentMsgBody = parentMsgBody.replace(/\\/g, '\\\\').replace(/;/g, '\\:').replace(/ /g, '\\s').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
        
        replyTags = `reply-parent-msg-id=${replyParentMsgId};reply-parent-user-id=${parentUserId};reply-parent-user-login=${parentUsername};reply-parent-display-name=${parentDisplayName};reply-parent-msg-body=${escapedParentMsgBody};`;
      } else {
        // Fallback if parent message not found
        replyTags = `reply-parent-msg-id=${replyParentMsgId};`;
      }
    }
    
    const optimisticMessage = `@badge-info=;badges=${badges};color=${color};display-name=${userInfo.displayName};emotes=;first-msg=0;flags=;id=${tempId};mod=0;${replyTags}returning-chatter=0;room-id=;subscriber=0;tmi-sent-ts=${timestamp};turbo=0;user-id=${userInfo.userId};user-type= :${userInfo.username}!${userInfo.username}@${userInfo.username}.tmi.twitch.tv PRIVMSG #${currentChannelRef.current} :${messageText}`;

    // Always append optimistic message to the end (newest message)
    setMessages(prev => [...prev, optimisticMessage]);
    
    setSeenMessageIds(prev => {
      const newSet = new Set(prev);
      newSet.add(tempId);
      return newSet;
    });

    try {
      // Send the message - the real message from server will be filtered out
      await invoke('send_chat_message', { 
        message: messageText,
        replyParentMsgId: replyParentMsgId || null
      });
      console.log('[Chat] Message sent successfully:', messageText, replyParentMsgId ? `(replying to ${replyParentMsgId})` : '');
    } catch (err) {
      console.error('[Chat] Failed to send message:', err);
      
      // Remove the optimistic message on error
      setMessages(prev => prev.filter(msg => !msg.includes(`id=${tempId}`)));
      setSeenMessageIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(tempId);
        return newSet;
      });
      
      // Re-throw so the UI can show an error
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
        if (ws && ws.readyState !== WebSocket.OPEN && currentChannelRef.current) {
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
  }, [ws, connectChat]);

  useEffect(() => {
    return () => {
      // Clear reconnect timeout on unmount
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      
      // Clear health check interval
      if (healthCheckIntervalRef.current) {
        clearInterval(healthCheckIntervalRef.current);
      }
      
      if (ws) {
        console.log('[Chat] Cleanup: closing WebSocket');
        ws.close();
      }
    };
  }, [ws]);

  return { messages, connectChat, sendMessage, isConnected, error };
};
