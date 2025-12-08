import { invoke } from '@tauri-apps/api/core';

const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const HELIX_SUBSCRIPTION_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';

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

    constructor() { }

    public async connect(channelId: string, callbacks: EventSubCallbacks) {
        if (this.socket) {
            this.disconnect();
        }

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
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
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

        // Subscribe to each event type based on which callbacks are provided
        const subscriptionPromises: Promise<void>[] = [];

        if (this.callbacks.onRaid) {
            subscriptionPromises.push(this.subscribeToEvent('channel.raid', '1', {
                from_broadcaster_user_id: broadcasterId,
            }));
        }

        if (this.callbacks.onStreamOffline) {
            subscriptionPromises.push(this.subscribeToEvent('stream.offline', '1', {
                broadcaster_user_id: broadcasterId,
            }));
        }

        if (this.callbacks.onChannelUpdate) {
            subscriptionPromises.push(this.subscribeToEvent('channel.update', '2', {
                broadcaster_user_id: broadcasterId,
            }));
        }

        await Promise.all(subscriptionPromises);
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
                console.error(`[EventSub] ${type} subscription failed: ${response.status} ${response.statusText}`, errorText);
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
