use anyhow::Result;
use tokio::sync::RwLock;
use std::sync::Arc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{StreamExt, SinkExt};
use serde_json::json;
use chrono::Utc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct DropsWebSocketService {
    is_connected: Arc<RwLock<bool>>,
    app_handle: Option<AppHandle>,
}

impl DropsWebSocketService {
    pub fn new() -> Self {
        Self {
            is_connected: Arc::new(RwLock::new(false)),
            app_handle: None,
        }
    }

    pub async fn connect(&mut self, user_id: &str, access_token: &str, app_handle: AppHandle) -> Result<()> {
        self.app_handle = Some(app_handle.clone());
        
        let is_connected = self.is_connected.clone();
        let user_id = user_id.to_string();
        let access_token = access_token.to_string();
        
        // Spawn WebSocket connection task
        tokio::spawn(async move {
            loop {
                match Self::websocket_loop(&user_id, &access_token, &app_handle, &is_connected).await {
                    Ok(_) => {
                        println!("🔌 WebSocket disconnected normally");
                    }
                    Err(e) => {
                        eprintln!("❌ WebSocket error: {}", e);
                    }
                }
                
                // Wait before reconnecting
                println!("🔄 Reconnecting WebSocket in 5 seconds...");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
        
        Ok(())
    }
    
    async fn websocket_loop(
        user_id: &str,
        access_token: &str,
        app_handle: &AppHandle,
        is_connected: &Arc<RwLock<bool>>,
    ) -> Result<()> {
        println!("🔌 Connecting to Twitch PubSub WebSocket...");
        
        let url = "wss://pubsub-edge.twitch.tv/v1";
        let (ws_stream, _) = connect_async(url).await?;
        let (mut write, mut read) = ws_stream.split();
        
        {
            let mut connected = is_connected.write().await;
            *connected = true;
        }
        
        println!("✅ WebSocket connected to Twitch PubSub");
        
        // Generate a nonce for the LISTEN message
        let nonce = uuid::Uuid::new_v4().to_string();
        
        // Subscribe to drops topics
        let topics = vec![
            format!("user-drop-events.{}", user_id),  // Drop progress updates
            format!("onsite-notifications.{}", user_id),  // Drop ready notifications
        ];
        
        let listen_message = json!({
            "type": "LISTEN",
            "nonce": nonce,
            "data": {
                "topics": topics,
                "auth_token": access_token
            }
        });
        
        println!("📡 Subscribing to topics: {:?}", topics);
        write.send(Message::Text(listen_message.to_string().into())).await?;
        
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
                    println!("🏓 Sent PING to WebSocket");
                }
                
                msg = read.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) {
                                Self::handle_message(data, app_handle).await;
                            }
                        }
                        Some(Ok(Message::Close(_))) => {
                            println!("🔌 WebSocket closed by server");
                            break;
                        }
                        Some(Err(e)) => {
                            eprintln!("❌ WebSocket error: {}", e);
                            break;
                        }
                        None => {
                            println!("🔌 WebSocket stream ended");
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
        
        match msg_type {
            "MESSAGE" => {
                // Parse the actual message data
                if let Some(topic) = message["data"]["topic"].as_str() {
                    if let Some(message_str) = message["data"]["message"].as_str() {
                        if let Ok(msg_data) = serde_json::from_str::<serde_json::Value>(message_str) {
                            Self::handle_topic_message(topic, msg_data, app_handle).await;
                        }
                    }
                }
            }
            "RESPONSE" => {
                if let Some(error) = message["error"].as_str() {
                    if !error.is_empty() {
                        eprintln!("❌ WebSocket RESPONSE error: {}", error);
                    } else {
                        println!("✅ WebSocket subscription successful");
                    }
                }
            }
            "PONG" => {
                println!("🏓 Received PONG from WebSocket");
            }
            "RECONNECT" => {
                println!("🔄 Server requested reconnect");
                // The loop will handle reconnection
            }
            _ => {
                println!("🔍 Unknown WebSocket message type: {}", msg_type);
            }
        }
    }
    
    async fn handle_topic_message(topic: &str, message: serde_json::Value, app_handle: &AppHandle) {
        if topic.contains("user-drop-events") {
            // Handle drop progress updates
            if let Some(msg_type) = message["type"].as_str() {
                match msg_type {
                    "drop-progress" => {
                        let current_progress = message["data"]["current_progress_min"].as_i64().unwrap_or(0);
                        let required_progress = message["data"]["required_progress_min"].as_i64().unwrap_or(0);
                        let drop_id = message["data"]["drop_id"].as_str().unwrap_or("");
                        
                        println!("📊 Drop progress update: {}/{} minutes for drop {}", 
                            current_progress, required_progress, drop_id);
                        
                        // Emit progress update to frontend
                        let _ = app_handle.emit("drops-progress-update", json!({
                            "drop_id": drop_id,
                            "current_minutes": current_progress,
                            "required_minutes": required_progress,
                            "timestamp": Utc::now().to_rfc3339()
                        }));
                    }
                    "drop-claim" => {
                        let drop_id = message["data"]["drop_id"].as_str().unwrap_or("");
                        let drop_instance_id = message["data"]["drop_instance_id"].as_str().unwrap_or("");
                        
                        println!("🎁 Drop ready to claim: {} (instance: {})", drop_id, drop_instance_id);
                        
                        // Emit claim ready event to frontend
                        let _ = app_handle.emit("drops-claim-ready", json!({
                            "drop_id": drop_id,
                            "drop_instance_id": drop_instance_id,
                            "timestamp": Utc::now().to_rfc3339()
                        }));
                    }
                    _ => {
                        println!("🔍 Unknown drop event type: {}", msg_type);
                    }
                }
            }
        } else if topic.contains("onsite-notifications") {
            // Handle notifications (like drop ready reminders)
            if let Some(notification_type) = message["type"].as_str() {
                if notification_type == "user_drop_reward_reminder_notification" {
                    println!("🔔 Drop reward reminder notification received");
                    
                    // Emit notification to frontend
                    let _ = app_handle.emit("drops-reminder-notification", json!({
                        "timestamp": Utc::now().to_rfc3339()
                    }));
                }
            }
        }
    }
    
    pub async fn is_connected(&self) -> bool {
        *self.is_connected.read().await
    }
    
    pub async fn disconnect(&self) {
        let mut connected = self.is_connected.write().await;
        *connected = false;
        // The WebSocket loop will detect this and close
    }
}
