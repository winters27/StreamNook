use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{interval, Duration};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use crate::services::twitch_service::TwitchService;
use tauri::{AppHandle, Emitter};

const EVENTSUB_URL: &str = "wss://eventsub.wss.twitch.tv/ws";
const KEEPALIVE_TIMEOUT: u64 = 10; // Default keepalive timeout in seconds

#[derive(Debug, Deserialize)]
struct EventSubMessage {
    metadata: MessageMetadata,
    payload: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct MessageMetadata {
    message_id: String,
    message_type: String,
    message_timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subscription_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subscription_version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SessionPayload {
    session: Session,
}

#[derive(Debug, Deserialize)]
struct Session {
    id: String,
    status: String,
    connected_at: String,
    keepalive_timeout_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    reconnect_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NotificationPayload {
    subscription: Subscription,
    event: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct Subscription {
    id: String,
    #[serde(rename = "type")]
    subscription_type: String,
    version: String,
    status: String,
    cost: i32,
    condition: serde_json::Value,
    transport: Transport,
    created_at: String,
}

#[derive(Debug, Deserialize)]
struct Transport {
    method: String,
    session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelPointsRedemptionEvent {
    pub id: String,
    pub broadcaster_user_id: String,
    pub broadcaster_user_name: String,
    pub user_id: String,
    pub user_name: String,
    pub user_input: String,
    pub status: String,
    pub reward: RewardInfo,
    pub redeemed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewardInfo {
    pub id: String,
    pub title: String,
    pub cost: i32,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperReceivedEvent {
    pub from_user_id: String,
    pub from_user_login: String,
    pub from_user_name: String,
    pub to_user_id: String,
    pub to_user_login: String,
    pub to_user_name: String,
    pub whisper_id: String,
    pub whisper: WhisperContent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperContent {
    pub text: String,
}

pub struct EventSubService {
    connected: Arc<RwLock<bool>>,
    session_id: Arc<RwLock<Option<String>>>,
    subscriptions: Arc<RwLock<Vec<String>>>,
}

impl EventSubService {
    pub fn new() -> Self {
        Self {
            connected: Arc::new(RwLock::new(false)),
            session_id: Arc::new(RwLock::new(None)),
            subscriptions: Arc::new(RwLock::new(Vec::new())),
        }
    }

    pub async fn is_connected(&self) -> bool {
        *self.connected.read().await
    }

    pub async fn get_session_id(&self) -> Option<String> {
        self.session_id.read().await.clone()
    }

    pub async fn connect_and_listen(&self, broadcaster_id: String, app_handle: AppHandle) -> Result<()> {
        let connected = self.connected.clone();
        let session_id = self.session_id.clone();
        let subscriptions = self.subscriptions.clone();

        tokio::spawn(async move {
            loop {
                match Self::run_connection(
                    broadcaster_id.clone(),
                    app_handle.clone(),
                    connected.clone(),
                    session_id.clone(),
                    subscriptions.clone(),
                ).await {
                    Ok(_) => {
                        println!("🔌 EventSub connection closed normally");
                    }
                    Err(e) => {
                        eprintln!("❌ EventSub connection error: {}", e);
                    }
                }

                // Mark as disconnected
                {
                    let mut conn = connected.write().await;
                    *conn = false;
                    let mut sess = session_id.write().await;
                    *sess = None;
                }

                // Wait before reconnecting
                println!("🔄 Reconnecting to EventSub in 30 seconds...");
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        });

        Ok(())
    }

    async fn run_connection(
        broadcaster_id: String,
        app_handle: AppHandle,
        connected: Arc<RwLock<bool>>,
        session_id: Arc<RwLock<Option<String>>>,
        subscriptions: Arc<RwLock<Vec<String>>>,
    ) -> Result<()> {
        println!("🔌 Connecting to Twitch EventSub...");

        let (ws_stream, _) = connect_async(EVENTSUB_URL).await?;
        let (mut write, mut read) = ws_stream.split();

        println!("✅ Connected to Twitch EventSub, waiting for welcome message...");

        // Wait for welcome message
        let welcome_msg = read.next().await
            .ok_or_else(|| anyhow::anyhow!("Connection closed before welcome message"))??;

        // Handle different message types and extract text
        let welcome_text = match &welcome_msg {
            Message::Text(text) => {
                println!("📝 Received text message: {}", text);
                text.clone()
            },
            Message::Binary(data) => {
                let text = String::from_utf8(data.clone())
                    .map_err(|e| anyhow::anyhow!("Failed to decode binary message: {}", e))?;
                println!("📝 Received binary message (decoded): {}", text);
                text
            },
            Message::Close(frame) => {
                println!("🔌 Received close frame: {:?}", frame);
                return Err(anyhow::anyhow!("Connection closed by server"));
            },
            Message::Ping(_) | Message::Pong(_) => {
                println!("📝 Received ping/pong, waiting for welcome message...");
                // If we get a ping/pong, wait for the next message
                let next_msg = read.next().await
                    .ok_or_else(|| anyhow::anyhow!("Connection closed after ping/pong"))??;
                match &next_msg {
                    Message::Text(text) => text.clone(),
                    _ => return Err(anyhow::anyhow!("Unexpected message type after ping/pong")),
                }
            },
            Message::Frame(_) => {
                return Err(anyhow::anyhow!("Received raw frame instead of welcome message"));
            }
        };

        // Parse the welcome message - handle potential empty or malformed messages
        let welcome: EventSubMessage = match serde_json::from_str(&welcome_text) {
            Ok(msg) => msg,
            Err(e) => {
                eprintln!("❌ Failed to parse welcome message: {}", e);
                eprintln!("📝 Raw message: {}", welcome_text);
                return Err(anyhow::anyhow!("Failed to parse welcome message: {}", e));
            }
        };

        if welcome.metadata.message_type != "session_welcome" {
            eprintln!("❌ Expected session_welcome, got: {}", welcome.metadata.message_type);
            eprintln!("📝 Full message: {:?}", welcome);
            return Err(anyhow::anyhow!("Expected session_welcome message, got: {}", welcome.metadata.message_type));
        }

        let session_payload: SessionPayload = serde_json::from_value(welcome.payload)?;
        let session_info = session_payload.session;
        let keepalive_timeout = session_info.keepalive_timeout_seconds;

        // Store session ID
        {
            let mut sess = session_id.write().await;
            *sess = Some(session_info.id.clone());
        }

        // Mark as connected
        {
            let mut conn = connected.write().await;
            *conn = true;
        }

        println!("✅ EventSub session established: {}", session_info.id);
        println!("⏱️  Keepalive timeout: {} seconds", keepalive_timeout);

        // Subscribe to events using the session ID
        let sess_id = session_info.id.clone();
        tokio::spawn(async move {
            // Wait a moment for the connection to stabilize
            tokio::time::sleep(Duration::from_secs(1)).await;
            
            if let Err(e) = Self::subscribe_to_events(&broadcaster_id, &sess_id).await {
                eprintln!("❌ Failed to subscribe to EventSub events: {}", e);
            }
        });

        // Start keepalive monitoring
        let last_message_time = Arc::new(RwLock::new(std::time::Instant::now()));
        let last_message_clone = last_message_time.clone();
        let connected_clone = connected.clone();
        
        tokio::spawn(async move {
            let mut check_interval = interval(Duration::from_secs(1));
            loop {
                check_interval.tick().await;
                
                let elapsed = last_message_clone.read().await.elapsed();
                if elapsed > Duration::from_secs(keepalive_timeout + 5) {
                    eprintln!("❌ No message received for {} seconds, connection may be dead", elapsed.as_secs());
                    let mut conn = connected_clone.write().await;
                    *conn = false;
                    break;
                }
            }
        });

        // Listen for messages
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    // Update last message time
                    {
                        let mut last_msg = last_message_time.write().await;
                        *last_msg = std::time::Instant::now();
                    }

                    if let Err(e) = Self::handle_message(&text, &app_handle).await {
                        eprintln!("❌ Error handling message: {}", e);
                    }
                }
                Ok(Message::Close(_)) => {
                    println!("🔌 EventSub connection closed by server");
                    break;
                }
                Ok(Message::Ping(data)) => {
                    // Respond to ping with pong
                    if let Err(e) = write.send(Message::Pong(data)).await {
                        eprintln!("❌ Failed to send pong: {}", e);
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("❌ WebSocket error: {}", e);
                    break;
                }
                _ => {}
            }
        }

        Ok(())
    }

    async fn handle_message(text: &str, app_handle: &AppHandle) -> Result<()> {
        // Handle potential empty messages
        if text.trim().is_empty() {
            println!("⚠️ Received empty message, ignoring");
            return Ok(());
        }

        let message: EventSubMessage = match serde_json::from_str(text) {
            Ok(msg) => msg,
            Err(e) => {
                eprintln!("❌ Failed to parse EventSub message: {}", e);
                eprintln!("📝 Raw message: {}", text);
                return Err(anyhow::anyhow!("Failed to parse message: {}", e));
            }
        };

        match message.metadata.message_type.as_str() {
            "session_welcome" => {
                println!("✅ Received welcome message");
            }
            "session_keepalive" => {
                println!("💓 Received keepalive");
            }
            "notification" => {
                let notification: NotificationPayload = serde_json::from_value(message.payload)?;
                Self::handle_notification(notification, app_handle).await?;
            }
            "session_reconnect" => {
                println!("🔄 Server requested reconnection");
                let session_payload: SessionPayload = serde_json::from_value(message.payload)?;
                if let Some(reconnect_url) = session_payload.session.reconnect_url {
                    println!("🔗 Reconnect URL: {}", reconnect_url);
                    // TODO: Implement reconnection logic
                }
            }
            "revocation" => {
                println!("⚠️  Subscription revoked");
                let notification: NotificationPayload = serde_json::from_value(message.payload)?;
                println!("Revoked subscription: {:?}", notification.subscription);
            }
            _ => {
                println!("📨 Unknown message type: {}", message.metadata.message_type);
            }
        }

        Ok(())
    }

    async fn handle_notification(notification: NotificationPayload, app_handle: &AppHandle) -> Result<()> {
        println!("📬 Received notification: {}", notification.subscription.subscription_type);

        match notification.subscription.subscription_type.as_str() {
            "channel.channel_points_automatic_reward_redemption.add" => {
                // Handle automatic channel points rewards (like highlighted messages)
                println!("🎁 Automatic channel points reward redeemed");
                let _ = app_handle.emit("channel-points-automatic-reward", &notification.event);
            }
            "channel.channel_points_custom_reward_redemption.add" => {
                // Handle custom channel points reward redemptions
                if let Ok(redemption) = serde_json::from_value::<ChannelPointsRedemptionEvent>(notification.event.clone()) {
                    println!("🎁 Custom reward redeemed: {} by {}", redemption.reward.title, redemption.user_name);
                    let _ = app_handle.emit("channel-points-redemption", &redemption);
                }
            }
            "user.whisper.message" => {
                // Handle incoming whisper messages
                if let Ok(whisper_event) = serde_json::from_value::<WhisperReceivedEvent>(notification.event.clone()) {
                    println!("💬 Whisper received from {} (@{}): {}", 
                        whisper_event.from_user_name, 
                        whisper_event.from_user_login,
                        whisper_event.whisper.text
                    );
                    
                    // Emit to frontend for Dynamic Island notification
                    let whisper_data = serde_json::json!({
                        "from_user_id": whisper_event.from_user_id,
                        "from_user_login": whisper_event.from_user_login,
                        "from_user_name": whisper_event.from_user_name,
                        "to_user_id": whisper_event.to_user_id,
                        "to_user_login": whisper_event.to_user_login,
                        "to_user_name": whisper_event.to_user_name,
                        "whisper_id": whisper_event.whisper_id,
                        "text": whisper_event.whisper.text
                    });
                    
                    let _ = app_handle.emit("whisper-received", &whisper_data);
                }
            }
            _ => {
                println!("📨 Unhandled subscription type: {}", notification.subscription.subscription_type);
            }
        }

        Ok(())
    }

    async fn subscribe_to_events(broadcaster_id: &str, session_id: &str) -> Result<()> {
        let token = TwitchService::get_token().await?;
        // Use the same client ID as TwitchService for consistency
        let client_id = "1qgws7yzcp21g5ledlzffw3lmqdvie";

        let client = reqwest::Client::new();

        // Get the current user's ID for user-specific subscriptions (like whispers)
        let current_user_id = match TwitchService::get_user_info().await {
            Ok(user) => user.id,
            Err(e) => {
                eprintln!("❌ Failed to get current user info: {}", e);
                String::new()
            }
        };

        // Subscribe to automatic channel points rewards (v2)
        let subscription_body = serde_json::json!({
            "type": "channel.channel_points_automatic_reward_redemption.add",
            "version": "2",
            "condition": {
                "broadcaster_user_id": broadcaster_id
            },
            "transport": {
                "method": "websocket",
                "session_id": session_id
            }
        });

        let response = client
            .post("https://api.twitch.tv/helix/eventsub/subscriptions")
            .header("Client-ID", client_id)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&subscription_body)
            .send()
            .await?;

        if response.status().is_success() {
            println!("✅ Subscribed to automatic channel points rewards");
        } else {
            let error_text = response.text().await?;
            eprintln!("❌ Failed to subscribe to automatic rewards: {}", error_text);
        }

        // Subscribe to custom channel points rewards
        let custom_subscription_body = serde_json::json!({
            "type": "channel.channel_points_custom_reward_redemption.add",
            "version": "1",
            "condition": {
                "broadcaster_user_id": broadcaster_id
            },
            "transport": {
                "method": "websocket",
                "session_id": session_id
            }
        });

        let response = client
            .post("https://api.twitch.tv/helix/eventsub/subscriptions")
            .header("Client-ID", client_id)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&custom_subscription_body)
            .send()
            .await?;

        if response.status().is_success() {
            println!("✅ Subscribed to custom channel points rewards");
        } else {
            let error_text = response.text().await?;
            eprintln!("❌ Failed to subscribe to custom rewards: {}", error_text);
        }

        // Subscribe to whisper messages (requires user:read:whispers or user:manage:whispers scope)
        // This subscription is for the current logged-in user, not the broadcaster
        if !current_user_id.is_empty() {
            let whisper_subscription_body = serde_json::json!({
                "type": "user.whisper.message",
                "version": "1",
                "condition": {
                    "user_id": current_user_id
                },
                "transport": {
                    "method": "websocket",
                    "session_id": session_id
                }
            });

            let response = client
                .post("https://api.twitch.tv/helix/eventsub/subscriptions")
                .header("Client-ID", client_id)
                .header("Authorization", format!("Bearer {}", token))
                .header("Content-Type", "application/json")
                .json(&whisper_subscription_body)
                .send()
                .await?;

            if response.status().is_success() {
                println!("✅ Subscribed to whisper messages for user {}", current_user_id);
            } else {
                let error_text = response.text().await?;
                eprintln!("❌ Failed to subscribe to whispers: {}", error_text);
            }
        } else {
            eprintln!("⚠️ Skipping whisper subscription - no user ID available");
        }

        Ok(())
    }

    pub async fn disconnect(&self) {
        let mut conn = self.connected.write().await;
        *conn = false;
        
        let mut sess = self.session_id.write().await;
        *sess = None;
        
        let mut subs = self.subscriptions.write().await;
        subs.clear();
        
        println!("🔌 EventSub disconnected");
    }
}
