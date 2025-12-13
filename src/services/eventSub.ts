import { invoke } from '@tauri-apps/api/core';

const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const HELIX_SUBSCRIPTION_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';

// Cooldown between connection attempts to avoid hitting Twitch's rate limits
const CONNECTION_COOLDOWN_MS = 5000; // 5 seconds minimum between connections
const SUBSCRIPTION_DELAY_MS = 500; // Delay between subscription requests

interface EventSubMessage {
    metadata: {
        message_id: string;
        message_type: 'session_welcome' | 'session_keepalive' | 'notification' | 'session_reconnect';
        message_timestamp: string;
    };
    payload: any;
}

// Event type interfaces
interface RaidEvent {
    from_broadcaster_user_id: string;
    from_broadcaster_user_login: string;
    from_broadcaster_user_name: string;
    to_broadcaster_user_id: string;
    to_broadcaster_user_login: string;
    to_broadcaster_user_name: string;
    viewers: number;
}

interface StreamOfflineEvent {
    broadcaster_user_id: string;
    broadcaster_user_login: string;
    broadcaster_user_name: string;
}

interface StreamOnlineEvent {
    id: string;
    broadcaster_user_id: string;
    broadcaster_user_login: string;
    broadcaster_user_name: string;
    type: 'live' | 'playlist' | 'watch_party' | 'premiere' | 'rerun';
    started_at: string;
}

interface ChannelUpdateEvent {
    broadcaster_user_id: string;
    broadcaster_user_login: string;
    broadcaster_user_name: string;
    title: string;
    language: string;
    category_id: string;
    category_name: string;
    content_classification_labels: string[];
}

// Callback types
export interface EventSubCallbacks {
    onRaid?: (targetLogin: string, viewerCount: number) => void;
    onStreamOffline?: () => void;
    onChannelUpdate?: (title: string, categoryName: string, categoryId: string) => void;
}

export class EventSubService {
    private socket: WebSocket | null = null;
    private sessionId: string | null = null;
    private currentChannelId: string | null = null;
    private callbacks: EventSubCallbacks = {};
    private keepAliveInterval: number | null = null;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 5;
    private lastConnectionTime: number = 0;
    private pendingConnect: { channelId: string; callbacks: EventSubCallbacks } | null = null;
    private connectTimeout: ReturnType<typeof setTimeout> | null = null;
    private isConnecting: boolean = false;
    private rateLimitBackoff: number = 0; // Exponential backoff on 429 errors

    constructor() { }

    public async connect(channelId: string, callbacks: EventSubCallbacks) {
        // If same channel, skip reconnection
        if (this.currentChannelId === channelId && this.socket && this.socket.readyState === WebSocket.OPEN) {
            console.log('[EventSub] Already connected to this channel, skipping');
            return;
        }

        // Calculate required cooldown (includes rate limit backoff)
        const timeSinceLastConnection = Date.now() - this.lastConnectionTime;
        const effectiveCooldown = CONNECTION_COOLDOWN_MS + this.rateLimitBackoff;
        const remainingCooldown = effectiveCooldown - timeSinceLastConnection;

        // If we're within cooldown, debounce the connection
        if (remainingCooldown > 0 || this.isConnecting) {
            console.log(`[EventSub] Connection cooldown active, will connect in ${Math.max(remainingCooldown, 1000)}ms`);
            
            // Store the pending connection request (overwrites previous pending)
            this.pendingConnect = { channelId, callbacks };
            
            // Clear existing timeout if any
            if (this.connectTimeout) {
                clearTimeout(this.connectTimeout);
            }
            
            // Schedule the connection after cooldown
            this.connectTimeout = setTimeout(() => {
                this.connectTimeout = null;
                const pending = this.pendingConnect;
                this.pendingConnect = null;
                if (pending) {
                    this.doConnect(pending.channelId, pending.callbacks);
                }
            }, Math.max(remainingCooldown, 1000));
            
            return;
        }

        await this.doConnect(channelId, callbacks);
    }

    private async doConnect(channelId: string, callbacks: EventSubCallbacks) {
        // Disconnect existing connection first and wait for cleanup
        if (this.socket) {
            this.disconnect();
            // Small delay to ensure socket cleanup completes
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        this.isConnecting = true;
        this.lastConnectionTime = Date.now();
        this.currentChannelId = channelId;
        this.callbacks = callbacks;
        this.reconnectAttempts = 0;

        console.log('[EventSub] Connecting to EventSub WebSocket...');
        this.socket = new WebSocket(EVENTSUB_WS_URL);

        this.socket.onopen = () => {
            console.log('[EventSub] WebSocket Connected');
            this.reconnectAttempts = 0;
        };

        this.socket.onmessage = (event) => {
            try {
                const message: EventSubMessage = JSON.parse(event.data);
                this.handleMessage(message);
            } catch (err) {
                console.error('[EventSub] Error parsing message:', err);
            }
        };

        this.socket.onclose = (event) => {
            console.log('[EventSub] WebSocket Disconnected:', event.code, event.reason);
            this.cleanup();

            // Attempt reconnect if not intentional close
            if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                console.log(`[EventSub] Attempting reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`);
                setTimeout(() => {
                    if (this.currentChannelId && Object.keys(this.callbacks).length > 0) {
                        this.connect(this.currentChannelId, this.callbacks);
                    }
                }, 3000 * this.reconnectAttempts);
            }
        };

        this.socket.onerror = (error) => {
            console.error('[EventSub] WebSocket Error:', error);
        };
    }

    public disconnect() {
        if (this.socket) {
            console.log('[EventSub] Disconnecting...');
            this.socket.close(1000, 'User disconnected');
            this.socket = null;
        }
        this.cleanup();
    }

    private cleanup() {
        this.sessionId = null;
        this.isConnecting = false;
        this.currentChannelId = null;
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        // Clear pending connection if any (we're disconnecting intentionally)
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
        }
        this.pendingConnect = null;
    }

    private async handleMessage(message: EventSubMessage) {
        const { message_type } = message.metadata;

        switch (message_type) {
            case 'session_welcome':
                this.sessionId = message.payload.session.id;
                console.log('[EventSub] Session Welcome, ID:', this.sessionId);
                if (this.currentChannelId) {
                    await this.subscribeToAllEvents(this.currentChannelId);
                }
                break;

            case 'session_keepalive':
                // Expected behavior, connection is healthy
                break;

            case 'notification':
                this.handleNotification(message.payload);
                break;

            case 'session_reconnect':
                // Handle reconnect - Twitch provides new WebSocket URL
                console.log('[EventSub] Session Reconnect requested', message.payload);
                const reconnectUrl = message.payload.session?.reconnect_url;
                if (reconnectUrl) {
                    this.handleReconnect(reconnectUrl);
                }
                break;
        }
    }

    private async handleReconnect(newUrl: string) {
        console.log('[EventSub] Reconnecting to new URL:', newUrl);
        const oldSocket = this.socket;

        // Connect to new URL
        this.socket = new WebSocket(newUrl);

        this.socket.onopen = () => {
            console.log('[EventSub] Reconnected to new WebSocket');
            // Close old socket after new one is connected
            if (oldSocket) {
                oldSocket.close();
            }
        };

        this.socket.onmessage = (event) => {
            try {
                const message: EventSubMessage = JSON.parse(event.data);
                this.handleMessage(message);
            } catch (err) {
                console.error('[EventSub] Error parsing message:', err);
            }
        };

        this.socket.onclose = (event) => {
            console.log('[EventSub] Reconnected WebSocket Disconnected:', event.code, event.reason);
        };

        this.socket.onerror = (error) => {
            console.error('[EventSub] Reconnected WebSocket Error:', error);
        };
    }

    private handleNotification(payload: any) {
        const { subscription, event } = payload;
        const eventType = subscription.type;

        console.log(`[EventSub] Notification received: ${eventType}`);

        switch (eventType) {
            case 'channel.raid': {
                const raidEvent = event as RaidEvent;
                console.log(`[EventSub] Raid detected! ${raidEvent.from_broadcaster_user_name} -> ${raidEvent.to_broadcaster_user_name} (${raidEvent.viewers} viewers)`);
                if (this.callbacks.onRaid) {
                    this.callbacks.onRaid(raidEvent.to_broadcaster_user_login, raidEvent.viewers);
                }
                break;
            }

            case 'stream.offline': {
                const offlineEvent = event as StreamOfflineEvent;
                console.log(`[EventSub] Stream offline: ${offlineEvent.broadcaster_user_name}`);
                if (this.callbacks.onStreamOffline) {
                    this.callbacks.onStreamOffline();
                }
                break;
            }

            case 'channel.update': {
                const updateEvent = event as ChannelUpdateEvent;
                console.log(`[EventSub] Channel updated: "${updateEvent.title}" - ${updateEvent.category_name}`);
                if (this.callbacks.onChannelUpdate) {
                    this.callbacks.onChannelUpdate(
                        updateEvent.title,
                        updateEvent.category_name,
                        updateEvent.category_id
                    );
                }
                break;
            }

            default:
                console.log(`[EventSub] Unhandled event type: ${eventType}`, event);
        }
    }

    private async subscribeToAllEvents(broadcasterId: string) {
        console.log(`[EventSub] Subscribing to all events for broadcaster: ${broadcasterId}`);

        // Mark connection as complete after session welcome
        this.isConnecting = false;
        
        // Reset rate limit backoff on successful connection
        this.rateLimitBackoff = 0;

        // Subscribe sequentially with delays to avoid rate limiting
        // This is safer than parallel requests
        const subscriptions: Array<{ type: string; version: string; condition: Record<string, string> }> = [];

        if (this.callbacks.onRaid) {
            subscriptions.push({
                type: 'channel.raid',
                version: '1',
                condition: { from_broadcaster_user_id: broadcasterId },
            });
        }

        if (this.callbacks.onStreamOffline) {
            subscriptions.push({
                type: 'stream.offline',
                version: '1',
                condition: { broadcaster_user_id: broadcasterId },
            });
        }

        if (this.callbacks.onChannelUpdate) {
            subscriptions.push({
                type: 'channel.update',
                version: '2',
                condition: { broadcaster_user_id: broadcasterId },
            });
        }

        // Subscribe sequentially with delays
        for (let i = 0; i < subscriptions.length; i++) {
            const sub = subscriptions[i];
            await this.subscribeToEvent(sub.type, sub.version, sub.condition);
            
            // Add delay between subscriptions (except after the last one)
            if (i < subscriptions.length - 1) {
                await new Promise(resolve => setTimeout(resolve, SUBSCRIPTION_DELAY_MS));
            }
        }
    }

    private async subscribeToEvent(type: string, version: string, condition: Record<string, string>) {
        if (!this.sessionId) {
            console.warn('[EventSub] Cannot subscribe: No session ID');
            return;
        }

        try {
            const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');

            console.log(`[EventSub] Subscribing to ${type}...`);

            const response = await fetch(HELIX_SUBSCRIPTION_URL, {
                method: 'POST',
                headers: {
                    'Client-ID': clientId,
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    type,
                    version,
                    condition,
                    transport: {
                        method: 'websocket',
                        session_id: this.sessionId,
                    },
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                
                // Handle 429 Too Many Requests - apply exponential backoff
                if (response.status === 429) {
                    console.warn(`[EventSub] Rate limited (429) on ${type} subscription. Applying backoff.`);
                    // Increase backoff exponentially: 5s -> 10s -> 20s -> 40s (max 60s)
                    this.rateLimitBackoff = Math.min(
                        this.rateLimitBackoff === 0 ? 5000 : this.rateLimitBackoff * 2,
                        60000
                    );
                    console.warn(`[EventSub] Rate limit backoff increased to ${this.rateLimitBackoff}ms`);
                    
                    // Don't retry here - the connection cooldown will handle it on next connect
                    return;
                }
                
                console.error(`[EventSub] ${type} subscription failed: ${response.status}`, errorText);
                return;
            }

            const data = await response.json();
            console.log(`[EventSub] ${type} subscription successful:`, data.data?.[0]?.id || 'OK');

        } catch (error) {
            console.error(`[EventSub] Error subscribing to ${type}:`, error);
        }
    }

    // Legacy method for backward compatibility
    public async connectWithRaidOnly(channelId: string, onRaid: (targetLogin: string) => void) {
        await this.connect(channelId, {
            onRaid: (targetLogin) => onRaid(targetLogin),
        });
    }
}

export const eventSubService = new EventSubService();
