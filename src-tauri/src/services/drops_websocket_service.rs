use anyhow::Result;
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use log::{debug, error};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub struct DropsWebSocketService {
    is_connected: Arc<RwLock<bool>>,
    app_handle: Option<AppHandle>,
    /// Handle to the spawned reconnect loop. Used by `disconnect()` to actually
    /// terminate the loop (which previously had no way to exit on demand —
    /// the old `disconnect()` just flipped a flag the loop never read).
    task_handle: Arc<tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl DropsWebSocketService {
    pub fn new() -> Self {
        Self {
            is_connected: Arc::new(RwLock::new(false)),
            app_handle: None,
            task_handle: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    /// Connect to Twitch PubSub and subscribe to user-scoped drop topics.
    /// Idempotent: if a live reconnect-loop task already exists, this is a
    /// no-op. Multiple mining mode entry paths (campaign-specific, multi-
    /// campaign, auto-mining) all call this safely.
    pub async fn connect(
        &mut self,
        user_id: &str,
        access_token: &str,
        app_handle: AppHandle,
    ) -> Result<()> {
        {
            let handle_guard = self.task_handle.lock().await;
            if let Some(h) = handle_guard.as_ref() {
                if !h.is_finished() {
                    debug!("WebSocket already connected; skipping duplicate connect");
                    return Ok(());
                }
            }
        }

        self.app_handle = Some(app_handle.clone());

        let is_connected = self.is_connected.clone();
        let user_id = user_id.to_string();
        let access_token = access_token.to_string();

        let handle = tokio::spawn(async move {
            loop {
                match Self::websocket_loop(&user_id, &access_token, &app_handle, &is_connected)
                    .await
                {
                    Ok(_) => {
                        debug!("WebSocket disconnected normally");
                    }
                    Err(e) => {
                        error!("WebSocket error: {}", e);
                        // Emit error to frontend for Discord reporting
                        let _ = app_handle.emit(
                            "drops-error",
                            json!({
                                "category": "DropsWebSocket",
                                "message": format!("WebSocket error: {}", e),
                                "timestamp": chrono::Utc::now().to_rfc3339()
                            }),
                        );
                    }
                }

                // Wait before reconnecting. If disconnect() is called during
                // this sleep, the task is aborted and the sleep future is
                // dropped cleanly at its await point.
                debug!("Reconnecting WebSocket in 5 seconds...");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });

        *self.task_handle.lock().await = Some(handle);

        Ok(())
    }

    async fn websocket_loop(
        user_id: &str,
        access_token: &str,
        app_handle: &AppHandle,
        is_connected: &Arc<RwLock<bool>>,
    ) -> Result<()> {
        debug!("Connecting to Twitch PubSub WebSocket...");

        let url = "wss://pubsub-edge.twitch.tv";
        let (ws_stream, _) = connect_async(url).await?;
        let (mut write, mut read) = ws_stream.split();

        {
            let mut connected = is_connected.write().await;
            *connected = true;
        }

        debug!("WebSocket connected to Twitch PubSub");

        // Generate a nonce for the LISTEN message
        let nonce = uuid::Uuid::new_v4().to_string();

        // Subscribe to drops topics
        let topics = vec![
            format!("user-drop-events.{}", user_id), // Drop progress updates
            format!("onsite-notifications.{}", user_id), // Drop ready notifications
        ];

        let listen_message = json!({
            "type": "LISTEN",
            "nonce": nonce,
            "data": {
                "topics": topics,
                "auth_token": access_token
            }
        });

        debug!("Subscribing to topics: {:?}", topics);
        write
            .send(Message::Text(listen_message.to_string().into()))
            .await?;

        // Start PING task to keep connection alive
        let mut ping_interval = tokio::time::interval(Duration::from_secs(240)); // 4 minutes

        // Handle incoming messages
        loop {
            tokio::select! {
                _ = ping_interval.tick() => {
                    // Send PING to keep connection alive
                    let ping_message = json!({
                        "type": "PING"
                    });
                    write.send(Message::Text(ping_message.to_string().into())).await?;
                    debug!("Sent PING to WebSocket");
                }

                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            debug!("[DropsWS] Received raw message: {}", &text[..text.len().min(200)]);
                            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) {
                                Self::handle_message(data, app_handle).await;
                            } else {
                                debug!("[DropsWS] Failed to parse JSON message");
                            }
                        }
                        Some(Ok(Message::Close(_))) => {
                            debug!("WebSocket closed by server");
                            break;
                        }
                        Some(Err(e)) => {
                            error!("WebSocket error: {}", e);
                            break;
                        }
                        None => {
                            debug!("WebSocket stream ended");
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        {
            let mut connected = is_connected.write().await;
            *connected = false;
        }

        Ok(())
    }

    async fn handle_message(message: serde_json::Value, app_handle: &AppHandle) {
        let msg_type = message["type"].as_str().unwrap_or("");
        debug!("[DropsWS] Message type: {}", msg_type);

        match msg_type {
            "MESSAGE" => {
                // Parse the actual message data
                if let Some(topic) = message["data"]["topic"].as_str() {
                    debug!("[DropsWS] MESSAGE on topic: {}", topic);
                    if let Some(message_str) = message["data"]["message"].as_str() {
                        debug!(
                            "[DropsWS] Inner message: {}",
                            &message_str[..message_str.len().min(300)]
                        );
                        if let Ok(msg_data) = serde_json::from_str::<serde_json::Value>(message_str)
                        {
                            Self::handle_topic_message(topic, msg_data, app_handle).await;
                        } else {
                            debug!("[DropsWS] Failed to parse inner message JSON");
                        }
                    } else {
                        debug!("[DropsWS] No message field in data");
                    }
                } else {
                    debug!("[DropsWS] No topic field in MESSAGE: {:?}", message["data"]);
                }
            }
            "RESPONSE" => {
                if let Some(error) = message["error"].as_str() {
                    if !error.is_empty() {
                        error!("WebSocket RESPONSE error: {}", error);
                        // Emit error to frontend for Discord reporting
                        let _ = app_handle.emit(
                            "drops-error",
                            json!({
                                "category": "DropsWebSocket",
                                "message": format!("PubSub subscription error: {}", error),
                                "timestamp": Utc::now().to_rfc3339()
                            }),
                        );
                    } else {
                        debug!("WebSocket subscription successful");
                    }
                }
            }
            "PONG" => {
                debug!("Received PONG from WebSocket");
            }
            "RECONNECT" => {
                debug!("Server requested reconnect");
                // The loop will handle reconnection
            }
            _ => {
                debug!("Unknown WebSocket message type: {}", msg_type);
            }
        }
    }

    async fn handle_topic_message(topic: &str, message: serde_json::Value, app_handle: &AppHandle) {
        if topic.contains("user-drop-events") {
            // Handle drop progress updates
            if let Some(msg_type) = message["type"].as_str() {
                match msg_type {
                    "drop-progress" => {
                        let current_progress = message["data"]["current_progress_min"]
                            .as_i64()
                            .unwrap_or(0);
                        let required_progress = message["data"]["required_progress_min"]
                            .as_i64()
                            .unwrap_or(0);
                        let drop_id = message["data"]["drop_id"].as_str().unwrap_or("");

                        debug!(
                            "Drop progress update: {}/{} minutes for drop {}",
                            current_progress, required_progress, drop_id
                        );

                        // Emit progress update to frontend
                        let _ = app_handle.emit(
                            "drops-progress-update",
                            json!({
                                "drop_id": drop_id,
                                "current_minutes": current_progress,
                                "required_minutes": required_progress,
                                "timestamp": Utc::now().to_rfc3339()
                            }),
                        );
                    }
                    "drop-claim" => {
                        let drop_id = message["data"]["drop_id"].as_str().unwrap_or("");
                        let drop_instance_id =
                            message["data"]["drop_instance_id"].as_str().unwrap_or("");

                        debug!(
                            "Drop ready to claim: {} (instance: {})",
                            drop_id, drop_instance_id
                        );

                        // Emit claim ready event to frontend
                        let _ = app_handle.emit(
                            "drops-claim-ready",
                            json!({
                                "drop_id": drop_id,
                                "drop_instance_id": drop_instance_id,
                                "timestamp": Utc::now().to_rfc3339()
                            }),
                        );
                    }
                    _ => {
                        debug!("Unknown drop event type: {}", msg_type);
                    }
                }
            }
        } else if topic.contains("onsite-notifications") {
            // Handle notifications (like drop ready reminders)
            if let Some(notification_type) = message["type"].as_str() {
                if notification_type == "user_drop_reward_reminder_notification" {
                    debug!("Drop reward reminder notification received");

                    // Emit notification to frontend
                    let _ = app_handle.emit(
                        "drops-reminder-notification",
                        json!({
                            "timestamp": Utc::now().to_rfc3339()
                        }),
                    );
                }
            }
        }
    }

    pub async fn is_connected(&self) -> bool {
        *self.is_connected.read().await
    }

    /// Terminate the reconnect loop and close the WebSocket. Aborts the
    /// spawned task — tokio drops its future at the next await point, which
    /// releases the socket and exits the reconnect loop. After this returns,
    /// `connect()` can be called again to start a fresh connection.
    pub async fn disconnect(&self) {
        if let Some(h) = self.task_handle.lock().await.take() {
            h.abort();
            debug!("Aborted DropsWebSocket reconnect loop");
        }
        let mut connected = self.is_connected.write().await;
        *connected = false;
    }
}
