import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Logger } from '../utils/logger';

const CHAT_HISTORY_MAX = 500; // multi-nook needs more history since it's merged

export const useMultiChat = () => {
  const [messages, setMessages] = useState<any[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const isConnectingRef = useRef(false);
  const currentChannelsRef = useRef<string[]>([]);
  
  const cleanupWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.onclose = null;
      wsRef.current.onopen = null;
      if (wsRef.current.readyState !== WebSocket.CLOSED && wsRef.current.readyState !== WebSocket.CLOSING) {
        wsRef.current.close(1000, 'Cleanup');
      }
      wsRef.current = null;
    }
    
    // Stop all backend chats when we cleanup multi-chat
    invoke('stop_chat').catch(() => {
      // Ignore
    });
  }, []);

  const connectMultiChat = useCallback(async (channels: string[]) => {
    if (channels.length === 0) return;
    
    // Prevent duplicate connections
    if (isConnectingRef.current && JSON.stringify(currentChannelsRef.current) === JSON.stringify(channels)) {
      return;
    }

    Logger.debug(`[MultiChat] Connecting to channels: ${channels.join(', ')}`);
    cleanupWebSocket();

    isConnectingRef.current = true;
    currentChannelsRef.current = [...channels];
    setError(null);
    setMessages([]);
    seenMessageIdsRef.current = new Set();

    try {
      // 1. Start Multi Chat backend
      const port = await invoke<number>('start_multi_chat', { channels });
      Logger.debug(`[MultiChat] Backend ready on port ${port}`);

      // 2. Connect WebSocket
      const wsUrl = `ws://127.0.0.1:${port}/chat`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        Logger.debug('[MultiChat] WebSocket connected');
        setIsConnected(true);
        isConnectingRef.current = false;
        setError(null);
      };

      ws.onclose = (event) => {
        setIsConnected(false);
        if (event.code !== 1000) {
          Logger.debug(`[MultiChat] Disconnected: ${event.reason || 'Unknown error'}`);
          setError('Disconnected from chat service');
        }
      };

      ws.onerror = (err) => {
        Logger.error('[MultiChat] WebSocket error:', err);
        setError('Connection error');
      };

      // We rely on Tauri events for incoming messages, not the WS, because useTwitchChat does the same
      // Wait, useTwitchChat uses WS for commands but listen() for messages!

    } catch (err: any) {
      Logger.error('[MultiChat] Failed to start:', err);
      setError(err.toString());
      isConnectingRef.current = false;
    }
  }, [cleanupWebSocket]);

  // Listen to global Tauri events for messages
  useEffect(() => {
    const unlistenMessage = listen('incoming-chat-message', (event) => {
      const msg = event.payload as any;
      if (msg && msg.id && !seenMessageIdsRef.current.has(msg.id)) {
        seenMessageIdsRef.current.add(msg.id);
        
        setMessages(prev => {
          const newMessages = [...prev, msg];
          if (newMessages.length > CHAT_HISTORY_MAX) {
            return newMessages.slice(newMessages.length - CHAT_HISTORY_MAX);
          }
          return newMessages;
        });
      }
    });

    return () => {
      unlistenMessage.then(f => f());
    };
  }, []);

  const sendMessage = useCallback(async (text: string, channelName: string) => {
    if (!text || text.trim() === '') return false;
    
    try {
      await invoke('send_chat_message', {
        message: text,
        replyParentMsgId: null,
        targetChannel: channelName
      });
      return true;
    } catch (err) {
      Logger.error(`[MultiChat] Failed to send to ${channelName}:`, err);
      return false;
    }
  }, []);

  return {
    messages,
    connectMultiChat,
    sendMessage,
    isConnected,
    error,
    cleanupWebSocket
  };
};

