use anyhow::Result;
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use tokio::time::{Duration, interval};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

const PUBSUB_URL: &str = "wss://pubsub-edge.twitch.tv";
const MAX_TOPICS_PER_CONNECTION: usize = 50;

#[derive(Debug, Clone)]
pub struct ChannelPointsWebSocketService {
    connections: Arc<RwLock<Vec<WebSocketConnection>>>,
    auth_token: Arc<RwLock<String>>,
    user_id: Arc<RwLock<String>>,
    app_handle: Option<AppHandle>,
    // Mapping of channel_id to channel_login for resolving channel names in events
    channel_id_to_login: Arc<RwLock<HashMap<String, String>>>,
}

#[derive(Debug)]
struct WebSocketConnection {
    id: String,
    topics: Vec<String>,
    is_connected: bool,
    last_ping: chrono::DateTime<Utc>,
    last_pong: chrono::DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PubSubMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<PubSubData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PubSubData {
    topic: String,
    message: String,
}

impl ChannelPointsWebSocketService {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(RwLock::new(Vec::new())),
            auth_token: Arc::new(RwLock::new(String::new())),
            user_id: Arc::new(RwLock::new(String::new())),
            app_handle: None,
            channel_id_to_login: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Register channel ID to login mapping for resolving channel names in events
    pub async fn register_channel_mapping(&self, channel_id: &str, channel_login: &str) {
        let mut mapping = self.channel_id_to_login.write().await;
        mapping.insert(channel_id.to_string(), channel_login.to_lowercase());
        println!(
            "📝 Registered channel mapping: {} -> {}",
            channel_id, channel_login
        );
    }

    /// Get channel login from channel ID
    pub async fn get_channel_login(&self, channel_id: &str) -> Option<String> {
        let mapping = self.channel_id_to_login.read().await;
        mapping.get(channel_id).cloned()
    }

    /// Connect to multiple channels for real-time channel points monitoring
    pub async fn connect_to_channels(
        &mut self,
        channel_ids: Vec<String>,
        user_id: &str,
        auth_token: &str,
        app_handle: AppHandle,
    ) -> Result<()> {
        self.app_handle = Some(app_handle.clone());
        *self.auth_token.write().await = auth_token.to_string();
        *self.user_id.write().await = user_id.to_string();

        // Each channel now generates 2 topics (video-playback, predictions) - removed raid
        // Plus 2 global topics (community-points-user and predictions-user)
        // Use 10 channels per connection - testing shows 48 topics fails but 6 succeeds
        // 10 channels * 2 topics + 2 global = 22 topics (very safe, matches working config)
        const MAX_CHANNELS_PER_CONNECTION: usize = 10;

        // Calculate how many WebSocket connections we need
        let num_connections =
            (channel_ids.len() + MAX_CHANNELS_PER_CONNECTION - 1) / MAX_CHANNELS_PER_CONNECTION;

        println!(
            "🔌 Creating {} WebSocket connection(s) for {} channels",
            num_connections.min(10),
            channel_ids.len()
        );

        // Split channels into chunks for each connection (max 10 connections)
        let chunks: Vec<_> = channel_ids
            .chunks(MAX_CHANNELS_PER_CONNECTION)
            .take(10) // Max 10 connections per IP as recommended
            .collect();

        for (index, chunk) in chunks.iter().enumerate() {
            // Add longer delay before first connection and between connections
            if index == 0 {
                // Give token validation time before first connection
                tokio::time::sleep(Duration::from_millis(500)).await;
            } else {
                // Longer delay between subsequent connections
                tokio::time::sleep(Duration::from_secs(2)).await;
            }

            let connection_id = Uuid::new_v4().to_string();
            let topics = self.build_topics_for_channels(chunk, user_id);

            // Store connection info
            {
                let mut connections = self.connections.write().await;
                connections.push(WebSocketConnection {
                    id: connection_id.clone(),
                    topics: topics.clone(),
                    is_connected: false,
                    last_ping: Utc::now(),
                    last_pong: Utc::now(),
                });
            }

            // Spawn WebSocket connection handler
            let auth_token = auth_token.to_string();
            let app_handle_clone = app_handle.clone();
            let connections = self.connections.clone();
            let channel_mapping = self.channel_id_to_login.clone();

            tokio::spawn(async move {
                if let Err(e) = Self::handle_connection(
                    connection_id.clone(),
                    topics,
                    auth_token,
                    connections,
                    app_handle_clone,
                    index,
                    channel_mapping,
                )
                .await
                {
                    eprintln!("❌ WebSocket connection {} failed: {}", index, e);
                }
            });
        }

        // Start ping/pong keeper
        self.start_ping_keeper(app_handle).await;

        Ok(())
    }

    /// Build PubSub topics for a set of channels
    fn build_topics_for_channels(&self, channel_ids: &[String], user_id: &str) -> Vec<String> {
        let mut topics = Vec::new();

        // Add community points topics for the user (global) - MOST IMPORTANT
        topics.push(format!("community-points-user-v1.{}", user_id));

        // For each channel, add only essential topics (2 per channel instead of 3)
        for channel_id in channel_ids {
            // Video playback events (stream up/down)
            topics.push(format!("video-playback-by-id.{}", channel_id));

            // Predictions (if we want to participate)
            topics.push(format!("predictions-channel-v1.{}", channel_id));
        }

        // User predictions results
        topics.push(format!("predictions-user-v1.{}", user_id));

        // Note: Removed raid topics to reduce count per channel
        // This allows 24 channels per connection: 24*2 + 2 global = 50 topics exactly

        topics
    }

    /// Handle a single WebSocket connection
    async fn handle_connection(
        connection_id: String,
        topics: Vec<String>,
        auth_token: String,
        connections: Arc<RwLock<Vec<WebSocketConnection>>>,
        app_handle: AppHandle,
        index: usize,
        channel_id_to_login: Arc<RwLock<HashMap<String, String>>>,
    ) -> Result<()> {
        println!(
            "🔗 Connecting WebSocket #{} with {} topics",
            index,
            topics.len()
        );

        let (ws_stream, _) = connect_async(PUBSUB_URL).await?;
        let (mut write, mut read) = ws_stream.split();

        // Mark as connected
        {
            let mut conns = connections.write().await;
            if let Some(conn) = conns.iter_mut().find(|c| c.id == connection_id) {
                conn.is_connected = true;
            }
        }

        // Send LISTEN message for all topics
        let listen_message = json!({
            "type": "LISTEN",
            "nonce": Uuid::new_v4().to_string(),
            "data": {
                "topics": topics,
                "auth_token": auth_token
            }
        });

        write
            .send(Message::text(listen_message.to_string()))
            .await?;
        println!(
            "📡 WebSocket #{} sent LISTEN for {} topics",
            index,
            topics.len()
        );

        let connections_ping = connections.clone();
        let connection_id_ping = connection_id.clone();

        // Spawn ping task to keep connection alive
        let ping_task = tokio::spawn(async move {
            let mut ping_interval = interval(Duration::from_secs(240)); // Ping every 4 minutes
            ping_interval.tick().await; // Skip first immediate tick

            loop {
                ping_interval.tick().await;

                let ping_message = json!({
                    "type": "PING"
                });

                if let Err(e) = write.send(Message::text(ping_message.to_string())).await {
                    eprintln!("❌ WebSocket #{} failed to send PING: {}", index, e);
                    break;
                }

                // Update last ping time
                {
                    let mut conns = connections_ping.write().await;
                    if let Some(conn) = conns.iter_mut().find(|c| c.id == connection_id_ping) {
                        conn.last_ping = Utc::now();
                    }
                }

                println!("💓 WebSocket #{} sent PING", index);
            }
        });

        // Handle incoming messages
        let mut should_reconnect = false;
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if let Ok(pubsub_msg) = serde_json::from_str::<PubSubMessage>(&text) {
                        Self::handle_pubsub_message(
                            pubsub_msg,
                            &app_handle,
                            &connections,
                            &connection_id,
                            index,
                            &channel_id_to_login,
                        )
                        .await;
                    }
                }
                Ok(Message::Close(_)) => {
                    println!("🔌 WebSocket #{} closed by server", index);
                    should_reconnect = true;
                    break;
                }
                Err(e) => {
                    eprintln!("❌ WebSocket #{} error: {}", index, e);
                    should_reconnect = true;
                    break;
                }
                _ => {}
            }
        }

        // Signal ping task to stop
        ping_task.abort();

        // Mark as disconnected
        {
            let mut conns = connections.write().await;
            if let Some(conn) = conns.iter_mut().find(|c| c.id == connection_id) {
                conn.is_connected = false;
            }
        }

        // Attempt reconnection after delay if needed
        if should_reconnect {
            tokio::time::sleep(Duration::from_secs(60)).await;
            println!("🔄 Attempting to reconnect WebSocket #{}...", index);

            // Recursively reconnect
            Box::pin(Self::handle_connection(
                connection_id,
                topics,
                auth_token,
                connections,
                app_handle,
                index,
                channel_id_to_login,
            ))
            .await
        } else {
            Ok(())
        }
    }

    /// Handle incoming PubSub messages
    async fn handle_pubsub_message(
        msg: PubSubMessage,
        app_handle: &AppHandle,
        connections: &Arc<RwLock<Vec<WebSocketConnection>>>,
        connection_id: &str,
        index: usize,
        channel_id_to_login: &Arc<RwLock<HashMap<String, String>>>,
    ) {
        match msg.msg_type.as_str() {
            "MESSAGE" => {
                if let Some(data) = msg.data {
                    if let Ok(message_data) = serde_json::from_str::<Value>(&data.message) {
                        // Parse the topic to get the type
                        let topic_parts: Vec<&str> = data.topic.split('.').collect();
                        let topic_type = topic_parts[0];
                        let channel_id = if topic_parts.len() > 1 {
                            Some(topic_parts[1].to_string())
                        } else {
                            None
                        };

                        match topic_type {
                            "community-points-user-v1" => {
                                Self::handle_points_event(
                                    message_data,
                                    app_handle,
                                    channel_id,
                                    channel_id_to_login,
                                )
                                .await;
                            }
                            "video-playback-by-id" => {
                                Self::handle_stream_event(message_data, app_handle, channel_id)
                                    .await;
                            }
                            "raid" => {
                                Self::handle_raid_event(message_data, app_handle, channel_id).await;
                            }
                            "predictions-channel-v1" => {
                                Self::handle_prediction_event(message_data, app_handle, channel_id)
                                    .await;
                            }
                            _ => {}
                        }
                    }
                }
            }
            "PONG" => {
                println!("🏓 WebSocket #{} received PONG", index);

                // Update last pong time
                let mut conns = connections.write().await;
                if let Some(conn) = conns.iter_mut().find(|c| c.id == *connection_id) {
                    conn.last_pong = Utc::now();
                }
            }
            "RECONNECT" => {
                println!("⚠️ WebSocket #{} received RECONNECT request", index);
                // Connection will automatically reconnect when closed
            }
            "RESPONSE" => {
                if let Some(error) = msg.error {
                    // Only treat non-empty errors as actual errors
                    if !error.is_empty() {
                        eprintln!("❌ WebSocket #{} error response: {}", index, error);
                    } else {
                        println!("✅ WebSocket #{} LISTEN acknowledged", index);
                    }
                } else {
                    println!("✅ WebSocket #{} LISTEN acknowledged", index);
                }
            }
            _ => {}
        }
    }

    /// Handle channel points events
    async fn handle_points_event(
        message_data: Value,
        app_handle: &AppHandle,
        _topic_channel_id: Option<String>,
        channel_id_to_login: &Arc<RwLock<HashMap<String, String>>>,
    ) {
        if let Some(event_type) = message_data["type"].as_str() {
            match event_type {
                "points-earned" => {
                    let points = message_data["data"]["point_gain"]["total_points"]
                        .as_i64()
                        .unwrap_or(0);
                    let reason = message_data["data"]["point_gain"]["reason_code"]
                        .as_str()
                        .unwrap_or("unknown");
                    let balance = message_data["data"]["balance"]["balance"]
                        .as_i64()
                        .unwrap_or(0);

                    // Extract channel_id from point_gain or balance objects (where it actually is)
                    let channel_id = message_data["data"]["point_gain"]["channel_id"]
                        .as_str()
                        .or_else(|| message_data["data"]["balance"]["channel_id"].as_str())
                        .or_else(|| message_data["data"]["channel_id"].as_str())
                        .map(|s| s.to_string());

                    // Try to extract channel login from various possible paths
                    let mut channel_login = message_data["data"]["channel_login"]
                        .as_str()
                        .or_else(|| message_data["data"]["channel"]["login"].as_str())
                        .or_else(|| message_data["data"]["point_gain"]["channel_login"].as_str())
                        .map(|s| s.to_string());

                    // If we don't have the channel_login but we have channel_id, try to resolve from mapping
                    if channel_login.is_none() {
                        if let Some(ref cid) = channel_id {
                            let mapping = channel_id_to_login.read().await;
                            channel_login = mapping.get(cid).cloned();
                        }
                    }

                    let channel_display_name = message_data["data"]["channel"]["display_name"]
                        .as_str()
                        .or_else(|| message_data["data"]["point_gain"]["channel_name"].as_str())
                        .map(|s| s.to_string());

                    // Unwrap values for cleaner logging
                    let channel_id_str = channel_id.as_deref().unwrap_or("unknown");
                    let channel_login_str = channel_login.as_deref().unwrap_or("unknown");
                    let channel_display_str = channel_display_name.as_deref().unwrap_or("unknown");

                    println!(
                        "💰 Points earned: +{} (reason: {}) - New balance: {} - Channel: {} (ID: {}, Login: {})",
                        points,
                        reason,
                        balance,
                        channel_display_str,
                        channel_id_str,
                        channel_login_str
                    );

                    let _ = app_handle.emit(
                        "channel-points-earned",
                        json!({
                            "channel_id": channel_id,
                            "channel_login": channel_login,
                            "channel_display_name": channel_display_name,
                            "points": points,
                            "reason": reason,
                            "balance": balance
                        }),
                    );
                }
                "claim-available" => {
                    let claim_id = message_data["data"]["claim"]["id"].as_str().unwrap_or("");
                    let claim_channel_id = message_data["data"]["claim"]["channel_id"]
                        .as_str()
                        .map(|s| s.to_string());

                    println!("🎁 Bonus claim available! ID: {}", claim_id);

                    let _ = app_handle.emit(
                        "channel-points-claim-available",
                        json!({
                            "channel_id": claim_channel_id,
                            "claim_id": claim_id
                        }),
                    );
                }
                "points-spent" => {
                    let points = message_data["data"]["point_cost"]["cost"]
                        .as_i64()
                        .unwrap_or(0);
                    let balance = message_data["data"]["balance"]["balance"]
                        .as_i64()
                        .unwrap_or(0);
                    let spent_channel_id = message_data["data"]["channel_id"]
                        .as_str()
                        .map(|s| s.to_string());

                    println!("💸 Points spent: -{} - New balance: {}", points, balance);

                    let _ = app_handle.emit(
                        "channel-points-spent",
                        json!({
                            "channel_id": spent_channel_id,
                            "points": points,
                            "balance": balance
                        }),
                    );
                }
                _ => {}
            }
        }
    }

    /// Handle stream up/down events
    async fn handle_stream_event(
        message_data: Value,
        app_handle: &AppHandle,
        channel_id: Option<String>,
    ) {
        if let Some(event_type) = message_data["type"].as_str() {
            match event_type {
                "stream-up" => {
                    println!("📺 Stream went live: {:?}", channel_id);
                    let _ = app_handle.emit(
                        "stream-up",
                        json!({
                            "channel_id": channel_id
                        }),
                    );
                }
                "stream-down" => {
                    println!("📴 Stream went offline: {:?}", channel_id);
                    let _ = app_handle.emit(
                        "stream-down",
                        json!({
                            "channel_id": channel_id
                        }),
                    );
                }
                _ => {}
            }
        }
    }

    /// Handle raid events
    async fn handle_raid_event(
        message_data: Value,
        _app_handle: &AppHandle,
        channel_id: Option<String>,
    ) {
        if let Some(raid_id) = message_data["raid"]["id"].as_str() {
            let target = message_data["raid"]["target_login"].as_str().unwrap_or("");
            println!("🎯 Raid detected from {:?} to {}", channel_id, target);
        }
    }

    /// Handle prediction events
    async fn handle_prediction_event(
        message_data: Value,
        _app_handle: &AppHandle,
        channel_id: Option<String>,
    ) {
        if let Some(event_type) = message_data["type"].as_str() {
            if event_type == "event-created" {
                let title = message_data["data"]["event"]["title"]
                    .as_str()
                    .unwrap_or("");
                println!("🔮 Prediction created on {:?}: {}", channel_id, title);
            }
        }
    }

    /// Start ping keeper to maintain connections
    async fn start_ping_keeper(&self, app_handle: AppHandle) {
        let connections = self.connections.clone();

        tokio::spawn(async move {
            let mut interval = interval(Duration::from_secs(240)); // Ping every 4 minutes

            loop {
                interval.tick().await;

                let conns = connections.read().await;
                for (index, conn) in conns.iter().enumerate() {
                    if conn.is_connected {
                        let elapsed = Utc::now().signed_duration_since(conn.last_pong);
                        if elapsed.num_minutes() > 5 {
                            println!(
                                "⚠️ WebSocket #{} hasn't received PONG in {} minutes",
                                index,
                                elapsed.num_minutes()
                            );
                        }
                    }
                }
            }
        });
    }

    /// Disconnect all WebSocket connections
    pub async fn disconnect_all(&self) {
        let mut connections = self.connections.write().await;
        connections.clear();
        println!("🔌 All WebSocket connections closed");
    }
}
