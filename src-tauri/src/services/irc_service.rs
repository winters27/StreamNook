use crate::models::chat_layout::{
    Badge, ChatMessage, EmotePos, LayoutResult, MessageMetadata, MessageSegment, ReplyInfo,
};
use crate::models::settings::AppState;
use crate::services::emoji_service;
use crate::services::emote_service::{Emote, EmoteService, EmoteSet};
use crate::services::layout_service::LayoutService;
use crate::services::twitch_service::TwitchService;
use crate::services::user_message_history_service::UserMessageHistoryService;
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::OnceLock;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, Mutex};
use warp::Filter;

pub struct IrcService;

static WS_SERVER_HANDLE: OnceLock<Mutex<Option<tokio::task::JoinHandle<()>>>> = OnceLock::new();
static CURRENT_CHANNELS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static MESSAGE_BROADCASTER: OnceLock<Mutex<Option<Arc<broadcast::Sender<String>>>>> =
    OnceLock::new();
static MESSAGE_QUEUE: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
static IRC_HANDLE: OnceLock<Mutex<Option<tokio::task::JoinHandle<()>>>> = OnceLock::new();
static IRC_WRITER: OnceLock<Mutex<Option<Arc<Mutex<tokio::io::WriteHalf<TcpStream>>>>>> =
    OnceLock::new();
static SHARED_CHAT_ROOMS: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();
static USER_BADGES_CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static CHANNEL_EMOTES: OnceLock<Mutex<Option<EmoteSet>>> = OnceLock::new();

const IRC_SERVER: &str = "irc.chat.twitch.tv";
const IRC_PORT: u16 = 6667;

fn get_ws_server_handle() -> &'static Mutex<Option<tokio::task::JoinHandle<()>>> {
    WS_SERVER_HANDLE.get_or_init(|| Mutex::new(None))
}

fn get_current_channels() -> &'static Mutex<HashSet<String>> {
    CURRENT_CHANNELS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn get_message_broadcaster() -> &'static Mutex<Option<Arc<broadcast::Sender<String>>>> {
    MESSAGE_BROADCASTER.get_or_init(|| Mutex::new(None))
}

fn get_message_queue() -> &'static Mutex<VecDeque<String>> {
    MESSAGE_QUEUE.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn get_irc_handle() -> &'static Mutex<Option<tokio::task::JoinHandle<()>>> {
    IRC_HANDLE.get_or_init(|| Mutex::new(None))
}

fn get_irc_writer() -> &'static Mutex<Option<Arc<Mutex<tokio::io::WriteHalf<TcpStream>>>>> {
    IRC_WRITER.get_or_init(|| Mutex::new(None))
}

fn get_shared_chat_rooms() -> &'static Mutex<HashMap<String, Vec<String>>> {
    SHARED_CHAT_ROOMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_user_badges_cache() -> &'static Mutex<Option<String>> {
    USER_BADGES_CACHE.get_or_init(|| Mutex::new(None))
}

fn get_channel_emotes() -> &'static Mutex<Option<EmoteSet>> {
    CHANNEL_EMOTES.get_or_init(|| Mutex::new(None))
}

impl IrcService {
    pub async fn start(channel: &str, state: &AppState) -> Result<u16> {
        let layout_service = state.layout_service.clone();
        let emote_service = state.emote_service.clone();
        // Stop any existing chat connection first
        Self::stop().await?;

        println!(
            "[IRC Chat] Starting IRC chat service for channel: {}",
            channel
        );

        // Store current channel
        get_current_channels()
            .lock()
            .await
            .insert(channel.to_string());

        // Check if token exists before attempting to connect
        let token = match TwitchService::get_token().await {
            Ok(t) => t,
            Err(_) => {
                return Err(anyhow::anyhow!(
                    "Not authenticated. Please log in to Twitch first."
                ));
            }
        };

        // Get user info
        let user_info = TwitchService::get_user_info().await?;

        println!("[IRC Chat] User: {} ({})", user_info.login, user_info.id);

        // Create broadcast channel for messages with larger buffer
        let (tx, _rx) = broadcast::channel::<String>(1000);
        let tx = Arc::new(tx);

        // Store broadcaster globally
        *get_message_broadcaster().lock().await = Some(tx.clone());

        // Start local WS server for frontend
        let port = rand::rng().random_range(20000..30000);
        let addr = SocketAddr::from(([127, 0, 0, 1], port));

        let tx_for_warp = tx.clone();
        let local_ws = warp::ws().map(move |ws: warp::ws::Ws| {
            let tx_clone = tx_for_warp.clone();
            ws.on_upgrade(move |socket| Self::handle_local_ws(socket, tx_clone))
        });

        let handle = tokio::spawn(async move {
            warp::serve(local_ws).run(addr).await;
        });

        *get_ws_server_handle().lock().await = Some(handle);

        // Give the server time to start listening
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        // Start IRC connection
        let tx_for_irc = tx.clone();
        let username = user_info.login.clone();
        let initial_channel = channel.to_string();

        let irc_handle = tokio::spawn(async move {
            if let Err(e) = Self::run_irc_connection(
                &username,
                &token,
                &initial_channel,
                tx_for_irc,
                layout_service,
                Arc::clone(&emote_service),
            )
            .await
            {
                eprintln!("[IRC Chat] Connection error: {}", e);
            }
        });

        *get_irc_handle().lock().await = Some(irc_handle);

        println!("[IRC Chat] Chat service started on port {}", port);

        Ok(port)
    }

    async fn run_irc_connection(
        username: &str,
        token: &str,
        initial_channel: &str,
        tx: Arc<broadcast::Sender<String>>,
        layout_service: Arc<LayoutService>,
        emote_service: Arc<tokio::sync::RwLock<EmoteService>>,
    ) -> Result<()> {
        loop {
            println!("[IRC Chat] Connecting to Twitch IRC...");

            // Connect to Twitch IRC
            let stream = TcpStream::connect((IRC_SERVER, IRC_PORT)).await?;
            let (reader, writer) = tokio::io::split(stream);
            let mut reader = BufReader::new(reader);
            let writer = Arc::new(Mutex::new(writer));

            // Store writer globally for sending messages
            *get_irc_writer().lock().await = Some(writer.clone());

            // IMPORTANT: CAP negotiation must happen BEFORE authentication
            // Step 1: Request capabilities first
            {
                let mut w = writer.lock().await;
                println!("[IRC Chat] Requesting capabilities...");
                w.write_all(b"CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership\r\n")
                    .await?;
                w.flush().await?;
            }

            // Step 2: Wait for CAP ACK before authenticating
            let mut line = String::new();
            let mut cap_acknowledged = false;

            while !cap_acknowledged {
                line.clear();
                if reader.read_line(&mut line).await? == 0 {
                    return Err(anyhow::anyhow!(
                        "Connection closed during capability negotiation"
                    ));
                }

                println!("[IRC Chat] Server response: {}", line.trim());

                if line.contains("CAP * ACK") {
                    cap_acknowledged = true;
                    println!("[IRC Chat] Capabilities acknowledged");
                }
            }

            // Step 3: Now authenticate with PASS and NICK
            {
                let mut w = writer.lock().await;
                // IRC requires "oauth:" prefix for the password
                let auth_token = format!("oauth:{}", token);

                println!("[IRC Chat] Authenticating with username: {}", username);
                println!(
                    "[IRC Chat] Using token: oauth:{}...",
                    &token[..10.min(token.len())]
                );

                w.write_all(format!("PASS {}\r\n", auth_token).as_bytes())
                    .await?;
                w.write_all(format!("NICK {}\r\n", username.to_lowercase()).as_bytes())
                    .await?;
                w.flush().await?;
            }

            // Step 4: Wait for authentication confirmation
            let mut authenticated = false;

            while !authenticated {
                line.clear();
                if reader.read_line(&mut line).await? == 0 {
                    return Err(anyhow::anyhow!("Connection closed during authentication"));
                }

                println!("[IRC Chat] Auth response: {}", line.trim());

                if line.contains("001") {
                    authenticated = true;
                    println!("[IRC Chat] Successfully authenticated");
                } else if line.contains("NOTICE")
                    && (line.contains("Login unsuccessful")
                        || line.contains("Login authentication failed"))
                {
                    return Err(anyhow::anyhow!(
                        "IRC authentication failed - token may be invalid or expired. Try logging out and back in."
                    ));
                }
            }

            // Join initial channel
            {
                let mut w = writer.lock().await;
                w.write_all(format!("JOIN #{}\r\n", initial_channel.to_lowercase()).as_bytes())
                    .await?;
                w.flush().await?;
            }

            println!("[IRC Chat] Joined channel: #{}", initial_channel);

            // Fetch channel emotes
            Self::fetch_and_store_emotes(initial_channel, Arc::clone(&emote_service)).await;

            // Send connection success notification
            let _ = tx.send("IRC_CONNECTED".to_string());

            // Flush queued messages
            let mut queue = get_message_queue().lock().await;
            if !queue.is_empty() {
                println!("[IRC Chat] Flushing {} queued messages", queue.len());
                while let Some(msg) = queue.pop_front() {
                    let _ = tx.send(msg);
                }
            }
            drop(queue);

            // Start ping task to keep IRC connection alive (every 240s = 4 min)
            let writer_clone = writer.clone();
            let ping_handle = tokio::spawn(async move {
                let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(240));
                loop {
                    interval.tick().await;
                    let mut w = writer_clone.lock().await;
                    if w.write_all(b"PING :tmi.twitch.tv\r\n").await.is_err() {
                        break;
                    }
                }
            });

            // Start heartbeat task to notify frontend that connection is alive (every 30s)
            // This prevents false "stale connection" warnings when chat is quiet
            let tx_heartbeat = tx.clone();
            let heartbeat_handle = tokio::spawn(async move {
                let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
                loop {
                    interval.tick().await;
                    if tx_heartbeat.send("HEARTBEAT".to_string()).is_err() {
                        // No receivers, stop heartbeat
                        break;
                    }
                }
            });

            // Listen for messages
            loop {
                line.clear();
                let should_reconnect = match reader.read_line(&mut line).await {
                    Ok(0) => {
                        println!("[IRC Chat] Connection closed by server");
                        true
                    }
                    Ok(_) => {
                        if let Err(e) =
                            Self::handle_irc_message(&line, &tx, &writer, &layout_service).await
                        {
                            eprintln!("[IRC Chat] Error handling message: {}", e);
                        }
                        false
                    }
                    Err(e) => {
                        eprintln!("[IRC Chat] Read error: {}", e);
                        true
                    }
                };

                if should_reconnect {
                    ping_handle.abort();
                    heartbeat_handle.abort();
                    println!("[IRC Chat] Reconnecting in 5 seconds...");
                    let _ = tx.send("IRC_RECONNECTING".to_string());
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    break;
                }
            }
        }
    }

    async fn handle_irc_message(
        line: &str,
        tx: &Arc<broadcast::Sender<String>>,
        writer: &Arc<Mutex<tokio::io::WriteHalf<TcpStream>>>,
        layout_service: &LayoutService,
    ) -> Result<()> {
        let trimmed = line.trim();

        if trimmed.is_empty() {
            return Ok(());
        }

        // Handle PING - extract the server data after "PING "
        if trimmed.starts_with("PING") {
            let mut w = writer.lock().await;
            // Safe slice: extract everything after "PING " (5 chars), or empty if too short
            let ping_data = if trimmed.len() > 5 { &trimmed[5..] } else { "" };
            w.write_all(format!("PONG {}\r\n", ping_data).as_bytes())
                .await?;
            w.flush().await?;
            return Ok(());
        }

        // Parse and handle different message types
        if trimmed.contains("PRIVMSG") {
            // Regular chat message - forward as-is with shared chat detection
            let enhanced_message = Self::enhance_message_with_shared_chat(trimmed).await;

            // Debug: Log the received IRC message to see what we're parsing
            if enhanced_message.contains(":Stare") || enhanced_message.contains(" Stare ") {
                println!(
                    "[IRC Chat DEBUG] Received PRIVMSG with 'Stare': {}",
                    enhanced_message
                );
            }

            // Parse and layout
            if let Some(mut chat_msg) = Self::parse_privmsg(&enhanced_message) {
                println!(
                    "[IRC Chat DEBUG] Parsed message from {}: content='{}', {} segments",
                    chat_msg.username,
                    chat_msg.content,
                    chat_msg.segments.len()
                );

                // PHASE 3 OPTIMIZATION: Use extended layout config for precise height pre-calculation
                // This eliminates the need for ResizeObserver in the frontend
                let config = layout_service.get_current_config_extended();

                // Check if this is a reply message
                let has_reply = chat_msg.metadata.reply_info.is_some();

                // Check if this is a first message
                let is_first_message = chat_msg.metadata.is_first_message;

                // Count badges and emotes for layout calculation
                let badge_count = chat_msg.badges.len();
                let emote_count = chat_msg
                    .segments
                    .iter()
                    .filter(|s| matches!(s, MessageSegment::Emote { .. }))
                    .count();

                // Check for shared chat
                let is_shared_chat = chat_msg.metadata.is_from_shared_chat;

                // Use extended layout calculation with all context for precise height
                // PHASE 3.2: Pass display_name and is_action to account for username width on first line
                let is_action = chat_msg.metadata.is_action;
                let layout = layout_service.layout_message_extended(
                    &chat_msg.content,
                    config.width,
                    config.font_size,
                    has_reply,
                    is_first_message,
                    badge_count,
                    emote_count,
                    config.show_timestamps,
                    is_shared_chat,
                    &chat_msg.segments,
                    &chat_msg.display_name,
                    is_action,
                );
                chat_msg.layout = layout;

                // Store message in user history LRU cache for profile cards
                if !chat_msg.user_id.is_empty() {
                    let history_service = UserMessageHistoryService::global();
                    history_service
                        .add_message(&chat_msg.user_id, chat_msg.clone())
                        .await;
                }

                if let Ok(json_msg) = serde_json::to_string(&chat_msg) {
                    if tx.send(json_msg).is_err() {
                        // println!("[IRC Chat] No active receivers, queueing message");
                        let mut queue = get_message_queue().lock().await;
                        // Store serialized JSON in queue
                        queue.push_back(
                            serde_json::to_string(&chat_msg).unwrap_or(enhanced_message),
                        );

                        // Keep queue size manageable
                        if queue.len() > 500 {
                            queue.pop_front();
                        }
                    }
                }
            } else {
                // Fallback to sending raw string if parsing fails
                if tx.send(enhanced_message.clone()).is_err() {
                    let mut queue = get_message_queue().lock().await;
                    queue.push_back(enhanced_message);
                    if queue.len() > 500 {
                        queue.pop_front();
                    }
                }
            }
        } else if trimmed.contains("USERNOTICE") {
            // Subscription, resub, gift sub, etc.
            // Parse USERNOTICE messages to calculate proper layout height
            // This is critical for subscription messages with attached user messages
            if let Some(mut chat_msg) = Self::parse_usernotice(trimmed) {
                // Calculate layout using extended config
                let config = layout_service.get_current_config_extended();

                // Check if this is from shared chat
                let is_shared_chat = chat_msg.metadata.is_from_shared_chat;

                // Count badges and emotes for layout calculation
                let badge_count = chat_msg.badges.len();
                let emote_count = chat_msg
                    .segments
                    .iter()
                    .filter(|s| matches!(s, MessageSegment::Emote { .. }))
                    .count();

                // Calculate layout for the user message content (if present)
                let mut layout = layout_service.layout_message_extended(
                    &chat_msg.content,
                    config.width,
                    config.font_size,
                    false, // no reply for subscription messages
                    false, // not a first message indicator
                    badge_count,
                    emote_count,
                    config.show_timestamps,
                    is_shared_chat,
                    &chat_msg.segments,
                    &chat_msg.display_name,
                    false, // not an action message
                );

                // Add extra height for subscription-specific UI elements:
                // - System message line (text-sm = 14px, leading-relaxed = 1.625)
                let system_msg_line_height = 14.0 * 1.625;

                // - Icon column (w-5 h-5 = 20px) + gap-2.5 (10px) - already accounted for in width
                // - px-3 py-2 padding = 12px horizontal, 8px vertical
                let subscription_padding = 16.0; // py-2 top + bottom = 8px * 2

                // - System message height (estimate based on length, wrapping at ~40 chars per line)
                let system_msg = chat_msg.metadata.system_message.as_deref().unwrap_or("");
                let system_msg_chars = system_msg.len();
                // Approximate characters per line at standard width
                let chars_per_line = 45;
                let system_msg_lines =
                    ((system_msg_chars as f32 / chars_per_line as f32).ceil() as usize).max(1);
                let system_msg_height = system_msg_lines as f32 * system_msg_line_height;

                // - If there's user content, add mt-1 (4px) spacing between system msg and content
                let content_spacing = if !chat_msg.content.is_empty() {
                    4.0
                } else {
                    0.0
                };

                // - If shared chat indicator is present, add its height (~28px for indicator + border)
                let shared_chat_indicator_height = if is_shared_chat { 32.0 } else { 0.0 };

                // Calculate total height
                // If there's no user message content, the layout height is just for the empty message
                let user_message_height = if chat_msg.content.is_empty() {
                    0.0
                } else {
                    layout.height
                };

                layout.height = subscription_padding
                    + shared_chat_indicator_height
                    + system_msg_height
                    + content_spacing
                    + user_message_height
                    + 4.0; // safety buffer

                chat_msg.layout = layout;

                println!(
                    "[IRC Chat] Parsed USERNOTICE: type={:?}, system_msg_lines={}, user_content_len={}, total_height={}",
                    chat_msg.metadata.msg_type,
                    system_msg_lines,
                    chat_msg.content.len(),
                    chat_msg.layout.height
                );

                if let Ok(json_msg) = serde_json::to_string(&chat_msg) {
                    if tx.send(json_msg).is_err() {
                        let mut queue = get_message_queue().lock().await;
                        queue.push_back(
                            serde_json::to_string(&chat_msg).unwrap_or(trimmed.to_string()),
                        );
                        if queue.len() > 500 {
                            queue.pop_front();
                        }
                    }
                }
            } else {
                // Fallback to raw string if parsing fails
                if tx.send(trimmed.to_string()).is_err() {
                    let mut queue = get_message_queue().lock().await;
                    queue.push_back(trimmed.to_string());
                    if queue.len() > 500 {
                        queue.pop_front();
                    }
                }
            }
        } else if trimmed.contains("ROOMSTATE") {
            // Room state updates (slow mode, sub-only, etc.)
            println!("[IRC Chat] Room state update: {}", trimmed);

            // Check for shared chat information
            if let Some(room_id) = Self::extract_tag_value(trimmed, "room-id") {
                Self::check_shared_chat_status(&room_id).await;
            }
        } else if trimmed.contains("USERSTATE") {
            // User state in channel (mod status, badges, etc.)
            // USERSTATE is sent when joining a channel AND after sending a message
            // It contains the user's badges which we need for optimistic message display
            println!("[IRC Chat] User state update: {}", trimmed);

            // Extract badges from USERSTATE and cache them
            if let Some(badges) = Self::extract_tag_value(trimmed, "badges") {
                println!("[IRC Chat] Caching user badges from USERSTATE: {}", badges);
                *get_user_badges_cache().lock().await = Some(badges.clone());

                // Send badges to frontend via special message
                let badges_message = format!("USER_BADGES:{}", badges);
                let _ = tx.send(badges_message);
            }

            // Extract emote-sets to fetch user's subscribed emotes
            if let Some(emote_sets) = Self::extract_tag_value(trimmed, "emote-sets") {
                println!(
                    "[IRC Chat] User has {} emote sets available",
                    emote_sets.split(',').count()
                );
                // TODO: Fetch emotes from user's subscribed sets
                // This would require additional API calls to get emotes from each set
            }
        } else if trimmed.contains("CLEARMSG") {
            // Single message deleted by mod
            // Format: @login=<user>;room-id=<room>;target-msg-id=<msg-id>;tmi-sent-ts=<ts> :tmi.twitch.tv CLEARMSG #<channel> :<message>
            println!("[IRC Chat] Message deleted: {}", trimmed);

            if let Some(target_msg_id) = Self::extract_tag_value(trimmed, "target-msg-id") {
                // Send deletion event to frontend
                let delete_event = json!({
                    "type": "CLEARMSG",
                    "target_msg_id": target_msg_id,
                    "login": Self::extract_tag_value(trimmed, "login").unwrap_or_default()
                });
                let _ = tx.send(delete_event.to_string());
            }
        } else if trimmed.contains("CLEARCHAT") {
            // User timed out/banned (clear all their messages) or chat cleared
            // Format: @ban-duration=<sec>;room-id=<room>;target-user-id=<id>;tmi-sent-ts=<ts> :tmi.twitch.tv CLEARCHAT #<channel> :<user>
            // Or for full chat clear: :tmi.twitch.tv CLEARCHAT #<channel>
            println!("[IRC Chat] Chat clear/timeout: {}", trimmed);

            let target_user_id = Self::extract_tag_value(trimmed, "target-user-id");
            let ban_duration = Self::extract_tag_value(trimmed, "ban-duration");

            // Extract target username from the message content (after the colon at the end)
            let target_user = if let Some(idx) = trimmed.rfind(" :") {
                Some(trimmed[idx + 2..].trim().to_string())
            } else {
                None
            };

            let clear_event = json!({
                "type": "CLEARCHAT",
                "target_user_id": target_user_id,
                "target_user": target_user,
                "ban_duration": ban_duration.map(|d| d.parse::<u64>().unwrap_or(0))
            });
            let _ = tx.send(clear_event.to_string());
        } else if trimmed.contains("NOTICE") {
            // System notices
            println!("[IRC Chat] Notice: {}", trimmed);
        }

        Ok(())
    }

    async fn enhance_message_with_shared_chat(message: &str) -> String {
        // Extract room-id from the message to determine source channel
        if let Some(room_id) = Self::extract_tag_value(message, "room-id") {
            // Check if this room is part of a shared chat session
            let shared_rooms = get_shared_chat_rooms().lock().await;

            // If this room has shared chat partners
            if let Some(_partners) = shared_rooms.get(&room_id) {
                // Add shared-chat-room tag to indicate which room the message is from
                if let Some(_user_login) = Self::extract_user_login_from_message(message) {
                    // Try to determine which partner room this user is from
                    // This would require additional API calls to check user's subscription status
                    // For now, we'll just mark it as shared chat

                    let mut enhanced = message.to_string();

                    // Insert shared-chat-room tag
                    if let Some(tag_end) = enhanced.find(" :") {
                        let shared_tag = format!("shared-chat-room={};", room_id);
                        enhanced.insert_str(tag_end - 1, &shared_tag);
                    }

                    return enhanced;
                }
            }
        }

        message.to_string()
    }

    async fn check_shared_chat_status(room_id: &str) {
        // Check if this broadcaster is in a shared chat session
        match TwitchService::get_token().await {
            Ok(token) => {
                let client = reqwest::Client::new();
                let url = format!(
                    "https://api.twitch.tv/helix/shared_chat/session?broadcaster_id={}",
                    room_id
                );

                match client
                    .get(&url)
                    .header("Client-Id", "1qgws7yzcp21g5ledlzffw3lmqdvie")
                    .header("Authorization", format!("Bearer {}", token))
                    .send()
                    .await
                {
                    Ok(response) => {
                        if response.status().is_success() {
                            if let Ok(json) = response.json::<serde_json::Value>().await {
                                if let Some(data) = json.get("data").and_then(|d| d.as_array()) {
                                    if let Some(session) = data.first() {
                                        // Extract participant broadcaster IDs
                                        if let Some(participants) =
                                            session.get("participants").and_then(|p| p.as_array())
                                        {
                                            let mut shared_rooms =
                                                get_shared_chat_rooms().lock().await;
                                            let partner_ids: Vec<String> = participants
                                                .iter()
                                                .filter_map(|p| {
                                                    p.get("broadcaster_id")
                                                        .and_then(|id| id.as_str())
                                                })
                                                .map(|s| s.to_string())
                                                .collect();

                                            // Store all participants as shared chat partners
                                            for id in &partner_ids {
                                                shared_rooms
                                                    .insert(id.clone(), partner_ids.clone());
                                            }

                                            println!(
                                                "[IRC Chat] Detected shared chat session with {} participants",
                                                partner_ids.len()
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[IRC Chat] Failed to check shared chat status: {}", e);
                    }
                }
            }
            Err(_) => {}
        }
    }

    fn extract_tag_value(message: &str, tag_name: &str) -> Option<String> {
        if !message.starts_with('@') {
            return None;
        }

        let tag_section = message.split(' ').next()?;
        let tags = &tag_section[1..]; // Skip the '@'

        for tag in tags.split(';') {
            let parts: Vec<&str> = tag.splitn(2, '=').collect();
            if parts.len() == 2 && parts[0] == tag_name {
                return Some(parts[1].to_string());
            }
        }

        None
    }

    fn extract_user_login_from_message(message: &str) -> Option<String> {
        // Extract from the prefix: :username!username@username.tmi.twitch.tv
        let parts: Vec<&str> = message.split(' ').collect();
        if parts.len() > 1 {
            let prefix = parts[1];
            if prefix.starts_with(':') && prefix.contains('!') {
                let username = prefix[1..].split('!').next()?;
                return Some(username.to_string());
            }
        }
        None
    }

    async fn handle_local_ws(
        local_socket: warp::ws::WebSocket,
        tx: Arc<broadcast::Sender<String>>,
    ) {
        let (mut local_tx, _local_rx) = local_socket.split();
        let mut rx = tx.subscribe();

        println!("[WS] New local WebSocket client connected");

        // Send any queued messages first
        let mut queue = get_message_queue().lock().await;
        let queued_count = queue.len();
        if queued_count > 0 {
            println!(
                "[WS] Sending {} queued messages to new client",
                queued_count
            );
            while let Some(msg) = queue.pop_front() {
                if local_tx.send(warp::ws::Message::text(msg)).await.is_err() {
                    println!("[WS] Client disconnected while sending queued messages");
                    return;
                }
            }
        }
        drop(queue);

        // Forward messages from broadcast to local client
        while let Ok(text) = rx.recv().await {
            if local_tx.send(warp::ws::Message::text(text)).await.is_err() {
                println!("[WS] Client disconnected");
                break;
            }
        }
    }

    pub async fn send_message(message: &str, reply_parent_msg_id: Option<&str>) -> Result<()> {
        let channels = get_current_channels().lock().await;
        if channels.is_empty() {
            return Err(anyhow::anyhow!("No active chat connection"));
        }

        let channel = channels.iter().next().unwrap().clone();
        drop(channels);

        let writer_lock = get_irc_writer().lock().await;
        let writer = writer_lock
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("IRC connection not established"))?
            .clone();
        drop(writer_lock);

        let mut w = writer.lock().await;

        // Format message with reply if needed
        let formatted_message = if let Some(parent_id) = reply_parent_msg_id {
            format!(
                "@reply-parent-msg-id={} PRIVMSG #{} :{}\r\n",
                parent_id, channel, message
            )
        } else {
            format!("PRIVMSG #{} :{}\r\n", channel, message)
        };

        println!("[IRC Chat] Sending message: {}", message);
        w.write_all(formatted_message.as_bytes()).await?;
        w.flush().await?;

        Ok(())
    }

    pub async fn join_channel(channel: &str) -> Result<()> {
        let writer_lock = get_irc_writer().lock().await;
        let writer = writer_lock
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("IRC connection not established"))?
            .clone();
        drop(writer_lock);

        let mut w = writer.lock().await;
        w.write_all(format!("JOIN #{}\r\n", channel.to_lowercase()).as_bytes())
            .await?;
        w.flush().await?;

        get_current_channels()
            .lock()
            .await
            .insert(channel.to_string());

        println!("[IRC Chat] Joined additional channel: #{}", channel);

        // Check for shared chat in the new channel
        if let Ok(broadcaster_info) = TwitchService::get_user_by_login(channel).await {
            Self::check_shared_chat_status(&broadcaster_info.id).await;
        }

        Ok(())
    }

    pub async fn leave_channel(channel: &str) -> Result<()> {
        let writer_lock = get_irc_writer().lock().await;
        let writer = writer_lock
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("IRC connection not established"))?
            .clone();
        drop(writer_lock);

        let mut w = writer.lock().await;
        w.write_all(format!("PART #{}\r\n", channel.to_lowercase()).as_bytes())
            .await?;
        w.flush().await?;

        get_current_channels().lock().await.remove(channel);

        println!("[IRC Chat] Left channel: #{}", channel);

        Ok(())
    }

    /// Fetch and store channel emotes for the current channel
    async fn fetch_and_store_emotes(
        channel_name: &str,
        emote_service: Arc<tokio::sync::RwLock<EmoteService>>,
    ) {
        println!("[IRC Chat] Fetching emotes for channel: {}", channel_name);

        // Get broadcaster ID from channel name
        match TwitchService::get_user_by_login(channel_name).await {
            Ok(user) => {
                let emote_svc = emote_service.read().await;
                match emote_svc
                    .fetch_channel_emotes(Some(channel_name.to_string()), Some(user.id.clone()))
                    .await
                {
                    Ok(emote_set) => {
                        println!(
                            "[IRC Chat] Fetched {} total emotes (Twitch: {}, BTTV: {}, 7TV: {}, FFZ: {})",
                            emote_set.total_count(),
                            emote_set.twitch.len(),
                            emote_set.bttv.len(),
                            emote_set.seven_tv.len(),
                            emote_set.ffz.len()
                        );
                        *get_channel_emotes().lock().await = Some(emote_set);
                    }
                    Err(e) => {
                        eprintln!("[IRC Chat] Failed to fetch channel emotes: {}", e);
                    }
                }
            }
            Err(e) => {
                eprintln!(
                    "[IRC Chat] Failed to get user info for {}: {}",
                    channel_name, e
                );
            }
        }
    }

    /// Parse message content into segments (text, emotes, emojis, links)
    /// This is the "endgame" - all parsing done in Rust, zero regex on main thread
    async fn parse_message_segments(
        content: &str,
        twitch_emotes: &[EmotePos],
    ) -> Vec<MessageSegment> {
        let mut segments = Vec::new();

        // Handle empty content
        if content.is_empty() {
            return segments;
        }

        let content_len = content.len();

        // First, split by Twitch native emotes
        let mut last_index = 0;
        let mut sorted_emotes = twitch_emotes.to_vec();
        sorted_emotes.sort_by_key(|e| e.start);

        for emote in &sorted_emotes {
            // Validate emote bounds to prevent panics
            if emote.start >= content_len || emote.end >= content_len || emote.start > emote.end {
                eprintln!(
                    "[IRC Chat] Skipping invalid emote position: start={}, end={}, content_len={}",
                    emote.start, emote.end, content_len
                );
                continue;
            }

            // Add text before emote
            if emote.start > last_index && last_index < content_len {
                let safe_end = emote.start.min(content_len);
                let text = &content[last_index..safe_end];
                if !text.is_empty() {
                    // Parse text for third-party emotes, emojis, and links
                    segments.extend(Self::parse_text_segment(text).await);
                }
            }

            // Add Twitch emote (check for 7TV override) - bounds already validated above
            let emote_name = &content[emote.start..=emote.end];

            // Check if 7TV has an emote with the same name (7TV takes priority)
            let emote_set_lock = get_channel_emotes().lock().await;
            let seventv_override = if let Some(emote_set) = emote_set_lock.as_ref() {
                emote_set
                    .seven_tv
                    .iter()
                    .find(|e| e.name == emote_name)
                    .cloned()
            } else {
                None
            };
            drop(emote_set_lock);

            if let Some(seventv_emote) = &seventv_override {
                // Use 7TV version instead of Twitch
                segments.push(MessageSegment::Emote {
                    content: emote_name.to_string(),
                    emote_id: Some(seventv_emote.id.clone()),
                    emote_url: seventv_emote.url.clone(),
                    is_zero_width: seventv_emote.is_zero_width,
                });
            } else {
                // Use Twitch emote
                segments.push(MessageSegment::Emote {
                    content: emote_name.to_string(),
                    emote_id: Some(emote.id.clone()),
                    emote_url: emote.url.clone(),
                    is_zero_width: None,
                });
            }

            last_index = emote.end + 1;
        }

        // Add remaining text
        if last_index < content.len() {
            let text = &content[last_index..];
            if !text.is_empty() {
                segments.extend(Self::parse_text_segment(text).await);
            }
        }

        // If no segments were created, return the original content as text
        if segments.is_empty() {
            segments.push(MessageSegment::Text {
                content: content.to_string(),
            });
        }

        segments
    }

    /// Parse a text segment for third-party emotes, emojis, and links
    async fn parse_text_segment(text: &str) -> Vec<MessageSegment> {
        let mut segments = Vec::new();

        // URL regex pattern - matches http://, https://, and www. URLs
        let url_regex = regex::Regex::new(r"(https?://[^\s]+|www\.[^\s]+)").unwrap();

        // Get channel emotes
        let emote_set_lock = get_channel_emotes().lock().await;
        let emote_set = emote_set_lock.as_ref();

        // Build emote lookup maps with priority: 7TV > FFZ > BTTV
        let mut emote_map: HashMap<&str, &Emote> = HashMap::new();
        if let Some(emotes) = emote_set {
            // Add in reverse priority order so higher priority overwrites
            for emote in &emotes.bttv {
                emote_map.insert(&emote.name, emote);
            }
            for emote in &emotes.ffz {
                emote_map.insert(&emote.name, emote);
            }
            for emote in &emotes.seven_tv {
                emote_map.insert(&emote.name, emote);
            }
        }

        // Split by spaces to check each word
        let words: Vec<&str> = text.split(' ').collect();

        for (i, word) in words.iter().enumerate() {
            // Check if word is a URL
            if url_regex.is_match(word) {
                let url = if word.starts_with("http") {
                    word.to_string()
                } else {
                    format!("https://{}", word)
                };

                segments.push(MessageSegment::Link {
                    content: word.to_string(),
                    url,
                });
            } else if let Some(emote) = emote_map.get(word) {
                // Found a third-party emote (BTTV, FFZ, or 7TV)
                segments.push(MessageSegment::Emote {
                    content: word.to_string(),
                    emote_id: Some(emote.id.clone()),
                    emote_url: emote.url.clone(),
                    is_zero_width: emote.is_zero_width,
                });
            } else {
                // Convert emoji shortcodes
                let converted = emoji_service::convert_emoji_shortcodes(word);

                // If conversion happened (text changed), it means we found emojis
                if converted != *word {
                    // For now, just add as text since we don't have emoji URLs in this context
                    // The frontend can handle native emoji rendering
                    segments.push(MessageSegment::Text { content: converted });
                } else {
                    // Regular text
                    segments.push(MessageSegment::Text {
                        content: word.to_string(),
                    });
                }
            }

            // Add space between words (except after last word)
            if i < words.len() - 1 {
                segments.push(MessageSegment::Text {
                    content: " ".to_string(),
                });
            }
        }

        drop(emote_set_lock);
        segments
    }

    fn parse_privmsg(raw: &str) -> Option<ChatMessage> {
        let tags = if raw.starts_with('@') {
            let tag_end = raw.find(' ')?;
            &raw[1..tag_end]
        } else {
            ""
        };

        let mut tag_map = HashMap::new();
        for tag in tags.split(';') {
            let mut parts = tag.splitn(2, '=');
            if let (Some(key), Some(val)) = (parts.next(), parts.next()) {
                tag_map.insert(key, val);
            }
        }

        // Parsing similar to frontend logic
        let username = tag_map
            .get("display-name")
            .map(|s| s.to_string())
            .or_else(|| {
                // extract from :user!user@...
                if let Some(idx) = raw.find(" PRIVMSG") {
                    let prefix = &raw[..idx];
                    if let Some(excl) = prefix.find('!') {
                        // find start of prefix (after tags space)
                        let start = raw.find(' ').map(|i| i + 1).unwrap_or(0);
                        if start < excl {
                            Some(prefix[start + 1..excl].to_string())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
            .unwrap_or_else(|| "unknown".to_string());

        // Content - check for ACTION message (/me command)
        let mut is_action = false;
        let content = if let Some(idx) = raw.find("PRIVMSG") {
            let rest = &raw[idx..];
            if let Some(colon) = rest.find(" :") {
                let mut msg = rest[colon + 2..].trim_end().to_string();
                // Check for ACTION wrapper: \x01ACTION message\x01
                // Minimum valid: "\x01ACTION X\x01" = 10 chars (8 for header + 1 content + 1 closing)
                if msg.len() >= 10 && msg.starts_with("\x01ACTION ") && msg.ends_with('\x01') {
                    is_action = true;
                    msg = msg[8..msg.len() - 1].to_string();
                }
                msg
            } else {
                "".to_string()
            }
        } else {
            "".to_string()
        };

        let id = tag_map
            .get("id")
            .map(|s| s.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let tags_owned: HashMap<String, String> = tag_map
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();

        let display_name = tag_map
            .get("display-name")
            .map(|s| s.to_string())
            .unwrap_or_else(|| username.clone());

        let color = tag_map.get("color").map(|s| s.to_string());

        let user_id = tag_map
            .get("user-id")
            .map(|s| s.to_string())
            .unwrap_or_default();

        let timestamp = tag_map
            .get("tmi-sent-ts")
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
                    .to_string()
            });

        // Pre-format timestamps for frontend (THE ENDGAME - no date parsing in React)
        let (formatted_timestamp, formatted_timestamp_with_seconds) =
            Self::format_timestamp(&timestamp);

        // For shared chat messages, prefer source-badges over badges
        let badges_str = tag_map
            .get("source-badges")
            .or_else(|| tag_map.get("badges"))
            .unwrap_or(&"");

        let badges: Vec<Badge> = badges_str
            .split(',')
            .filter(|s| !s.is_empty())
            .map(|b_str| {
                let mut p = b_str.split('/');
                Badge {
                    name: p.next().unwrap_or("").to_string(),
                    version: p.next().unwrap_or("").to_string(),
                    image_url_1x: None,
                    image_url_2x: None,
                    image_url_4x: None,
                    title: None,
                    description: None,
                }
            })
            .collect();

        // Use EmotePos struct
        // emotes format: 25:0-4,12-16/1902:6-10 ...
        let emotes_str = tag_map.get("emotes").unwrap_or(&"");
        let mut emotes = Vec::new();
        if !emotes_str.is_empty() {
            for emote_group in emotes_str.split('/') {
                let mut parts = emote_group.split(':');
                if let (Some(id), Some(ranges)) = (parts.next(), parts.next()) {
                    for range in ranges.split(',') {
                        let mut bounds = range.split('-');
                        if let (Some(start_s), Some(end_s)) = (bounds.next(), bounds.next()) {
                            if let (Ok(start), Ok(end)) =
                                (start_s.parse::<usize>(), end_s.parse::<usize>())
                            {
                                // url: https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/1.0
                                let url = format!(
                                    "https://static-cdn.jtvnw.net/emoticons/v2/{}/default/dark/1.0",
                                    id
                                );
                                emotes.push(EmotePos {
                                    id: id.to_string(),
                                    start,
                                    end,
                                    url,
                                });
                            }
                        }
                    }
                }
            }
        }

        // Parse message content into segments
        let segments = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current()
                .block_on(Self::parse_message_segments(&content, &emotes))
        });

        // Parse reply info (THE ENDGAME - all reply parsing done in Rust)
        let reply_info = tag_map
            .get("reply-parent-msg-id")
            .map(|parent_id| ReplyInfo {
                parent_msg_id: parent_id.to_string(),
                parent_display_name: tag_map
                    .get("reply-parent-display-name")
                    .map(|s| s.to_string())
                    .unwrap_or_default(),
                parent_msg_body: tag_map
                    .get("reply-parent-msg-body")
                    .map(|s| s.replace("\\s", " "))
                    .unwrap_or_default(),
                parent_user_id: tag_map
                    .get("reply-parent-user-id")
                    .map(|s| s.to_string())
                    .unwrap_or_default(),
                parent_user_login: tag_map
                    .get("reply-parent-user-login")
                    .map(|s| s.to_string())
                    .unwrap_or_default(),
            });

        // Shared chat detection
        let source_room_id = tag_map.get("source-room-id").map(|s| s.to_string());
        let room_id = tag_map.get("room-id").map(|s| s.to_string());
        let is_from_shared_chat = source_room_id.is_some()
            && room_id.is_some()
            && source_room_id.as_ref() != room_id.as_ref();

        // First message detection
        let is_first_message = tag_map.get("first-msg").is_some_and(|v| *v == "1");

        // Bits amount for cheer messages
        let bits_amount = tag_map
            .get("bits")
            .and_then(|s| s.parse::<u32>().ok())
            .filter(|&b| b > 0);

        // Message type
        let msg_type = tag_map.get("msg-id").map(|s| s.to_string());

        // System message (for subscriptions, etc.)
        let system_message = tag_map.get("system-msg").map(|s| s.replace("\\s", " "));

        // Build metadata (THE ENDGAME - all computation done here)
        let metadata = MessageMetadata {
            is_action,
            is_mentioned: false, // Set by frontend based on current user context
            is_first_message,
            formatted_timestamp,
            formatted_timestamp_with_seconds,
            reply_info,
            source_room_id,
            is_from_shared_chat,
            msg_type,
            bits_amount,
            system_message,
        };

        Some(ChatMessage {
            id,
            username,
            display_name,
            color,
            user_id,
            timestamp,
            content,
            badges,
            emotes,
            layout: LayoutResult {
                height: 0.0,
                width: 0.0,
                has_reply: metadata.reply_info.is_some(),
                is_first_message: metadata.is_first_message,
            },
            tags: tags_owned,
            segments,
            metadata,
        })
    }

    /// Parse USERNOTICE messages (subscriptions, resubs, gift subs, etc.)
    /// These have a different format than PRIVMSG but contain similar data
    fn parse_usernotice(raw: &str) -> Option<ChatMessage> {
        let tags = if raw.starts_with('@') {
            let tag_end = raw.find(' ')?;
            &raw[1..tag_end]
        } else {
            ""
        };

        let mut tag_map = HashMap::new();
        for tag in tags.split(';') {
            let mut parts = tag.splitn(2, '=');
            if let (Some(key), Some(val)) = (parts.next(), parts.next()) {
                tag_map.insert(key, val);
            }
        }

        // Extract username from login tag or display-name
        let username = tag_map
            .get("login")
            .or_else(|| tag_map.get("display-name"))
            .map(|s| s.to_string())
            .unwrap_or_else(|| "unknown".to_string());

        // Content - extract optional user message after USERNOTICE
        // Format: :tmi.twitch.tv USERNOTICE #channel :optional message
        let content = if let Some(idx) = raw.find("USERNOTICE") {
            let rest = &raw[idx..];
            if let Some(colon) = rest.find(" :") {
                rest[colon + 2..].trim_end().to_string()
            } else {
                "".to_string()
            }
        } else {
            "".to_string()
        };

        let id = tag_map
            .get("id")
            .map(|s| s.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let tags_owned: HashMap<String, String> = tag_map
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();

        let display_name = tag_map
            .get("display-name")
            .map(|s| s.to_string())
            .unwrap_or_else(|| username.clone());

        let color = tag_map.get("color").map(|s| s.to_string());

        let user_id = tag_map
            .get("user-id")
            .map(|s| s.to_string())
            .unwrap_or_default();

        let timestamp = tag_map
            .get("tmi-sent-ts")
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
                    .to_string()
            });

        // Pre-format timestamps
        let (formatted_timestamp, formatted_timestamp_with_seconds) =
            Self::format_timestamp(&timestamp);

        // For shared chat messages, prefer source-badges over badges
        let badges_str = tag_map
            .get("source-badges")
            .or_else(|| tag_map.get("badges"))
            .unwrap_or(&"");

        let badges: Vec<Badge> = badges_str
            .split(',')
            .filter(|s| !s.is_empty())
            .map(|b_str| {
                let mut p = b_str.split('/');
                Badge {
                    name: p.next().unwrap_or("").to_string(),
                    version: p.next().unwrap_or("").to_string(),
                    image_url_1x: None,
                    image_url_2x: None,
                    image_url_4x: None,
                    title: None,
                    description: None,
                }
            })
            .collect();

        // Parse emotes from user's message content (if any)
        let emotes_str = tag_map.get("emotes").unwrap_or(&"");
        let mut emotes = Vec::new();
        if !emotes_str.is_empty() && !content.is_empty() {
            for emote_group in emotes_str.split('/') {
                let mut parts = emote_group.split(':');
                if let (Some(id), Some(ranges)) = (parts.next(), parts.next()) {
                    for range in ranges.split(',') {
                        let mut bounds = range.split('-');
                        if let (Some(start_s), Some(end_s)) = (bounds.next(), bounds.next()) {
                            if let (Ok(start), Ok(end)) =
                                (start_s.parse::<usize>(), end_s.parse::<usize>())
                            {
                                let url = format!(
                                    "https://static-cdn.jtvnw.net/emoticons/v2/{}/default/dark/1.0",
                                    id
                                );
                                emotes.push(EmotePos {
                                    id: id.to_string(),
                                    start,
                                    end,
                                    url,
                                });
                            }
                        }
                    }
                }
            }
        }

        // Parse message content into segments (if there's user content)
        let segments = if !content.is_empty() {
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current()
                    .block_on(Self::parse_message_segments(&content, &emotes))
            })
        } else {
            Vec::new()
        };

        // Shared chat detection
        let source_room_id = tag_map.get("source-room-id").map(|s| s.to_string());
        let room_id = tag_map.get("room-id").map(|s| s.to_string());
        let is_from_shared_chat = source_room_id.is_some()
            && room_id.is_some()
            && source_room_id.as_ref() != room_id.as_ref();

        // Message type (sub, resub, subgift, submysterygift, etc.)
        // For shared chat, check source-msg-id first
        let msg_type = tag_map
            .get("source-msg-id")
            .or_else(|| tag_map.get("msg-id"))
            .map(|s| s.to_string());

        // System message (the auto-generated subscription message)
        let system_message = tag_map.get("system-msg").map(|s| s.replace("\\s", " "));

        // Build metadata
        let metadata = MessageMetadata {
            is_action: false,
            is_mentioned: false,
            is_first_message: false,
            formatted_timestamp,
            formatted_timestamp_with_seconds,
            reply_info: None,
            source_room_id,
            is_from_shared_chat,
            msg_type,
            bits_amount: None,
            system_message,
        };

        Some(ChatMessage {
            id,
            username,
            display_name,
            color,
            user_id,
            timestamp,
            content,
            badges,
            emotes,
            layout: LayoutResult {
                height: 0.0,
                width: 0.0,
                has_reply: false,
                is_first_message: false,
            },
            tags: tags_owned,
            segments,
            metadata,
        })
    }

    /// Format timestamp for display - pre-computed in Rust (THE ENDGAME)
    /// Returns (formatted_without_seconds, formatted_with_seconds)
    fn format_timestamp(tmi_sent_ts: &str) -> (Option<String>, Option<String>) {
        if let Ok(ts_ms) = tmi_sent_ts.parse::<i64>() {
            use chrono::{Local, TimeZone};

            if let Some(datetime) = Local.timestamp_millis_opt(ts_ms).single() {
                // Format without seconds: "3:45 PM" or "15:45" depending on locale
                let without_seconds = datetime.format("%l:%M %p").to_string().trim().to_string();
                // Format with seconds: "3:45:30 PM" or "15:45:30"
                let with_seconds = datetime
                    .format("%l:%M:%S %p")
                    .to_string()
                    .trim()
                    .to_string();

                return (Some(without_seconds), Some(with_seconds));
            }
        }
        (None, None)
    }

    /// Parse historical IRC messages through the same pipeline as live messages
    /// This ensures historical messages (from IVR API) get proper layout calculation
    pub async fn parse_historical_messages(
        raw_messages: Vec<String>,
        layout_service: &LayoutService,
    ) -> Vec<ChatMessage> {
        let mut results = Vec::with_capacity(raw_messages.len());

        for raw in raw_messages {
            if let Some(mut chat_msg) = Self::parse_privmsg(&raw) {
                // Calculate layout using the same logic as live messages
                let config = layout_service.get_current_config_extended();

                let has_reply = chat_msg.metadata.reply_info.is_some();
                let is_first_message = chat_msg.metadata.is_first_message;
                let badge_count = chat_msg.badges.len();
                let emote_count = chat_msg
                    .segments
                    .iter()
                    .filter(|s| matches!(s, MessageSegment::Emote { .. }))
                    .count();
                let is_shared_chat = chat_msg.metadata.is_from_shared_chat;
                let is_action = chat_msg.metadata.is_action;

                let layout = layout_service.layout_message_extended(
                    &chat_msg.content,
                    config.width,
                    config.font_size,
                    has_reply,
                    is_first_message,
                    badge_count,
                    emote_count,
                    config.show_timestamps,
                    is_shared_chat,
                    &chat_msg.segments,
                    &chat_msg.display_name,
                    is_action,
                );
                chat_msg.layout = layout;

                results.push(chat_msg);
            }
        }

        results
    }

    pub async fn stop() -> Result<()> {
        println!("[IRC Chat] Stopping chat service");

        // Stop IRC connection
        if let Some(handle) = get_irc_handle().lock().await.take() {
            handle.abort();
        }

        // Clear IRC writer
        *get_irc_writer().lock().await = None;

        // Stop WS server
        if let Some(handle) = get_ws_server_handle().lock().await.take() {
            handle.abort();
        }

        // Clear message queue
        get_message_queue().lock().await.clear();

        // Clear channels
        get_current_channels().lock().await.clear();

        // Clear shared chat rooms
        get_shared_chat_rooms().lock().await.clear();

        // Clear channel emotes
        *get_channel_emotes().lock().await = None;

        println!("[IRC Chat] Chat service stopped");

        Ok(())
    }
}
