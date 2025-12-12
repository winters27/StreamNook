use crate::models::chat_layout::{Badge, ChatMessage, EmotePos, LayoutResult};
use crate::models::settings::AppState;
use crate::services::layout_service::LayoutService;
use crate::services::twitch_service::TwitchService;
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

impl IrcService {
    pub async fn start(channel: &str, state: &AppState) -> Result<u16> {
        let layout_service = state.layout_service.clone();
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

            // Start ping task to keep connection alive
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

        // Handle PING
        if trimmed.starts_with("PING") {
            let mut w = writer.lock().await;
            w.write_all(format!("PONG {}\r\n", &trimmed[5..]).as_bytes())
                .await?;
            w.flush().await?;
            return Ok(());
        }

        // Parse and handle different message types
        if trimmed.contains("PRIVMSG") {
            // Regular chat message - forward as-is with shared chat detection
            let enhanced_message = Self::enhance_message_with_shared_chat(trimmed).await;

            // Parse and layout
            if let Some(mut chat_msg) = Self::parse_privmsg(&enhanced_message) {
                let (width, font_size) = layout_service.get_current_config();

                // Check if this is a reply message
                let has_reply = chat_msg.tags.contains_key("reply-parent-msg-id");

                // Check if this is a first message
                let is_first_message = chat_msg.tags.get("first-msg").is_some_and(|v| v == "1");

                let layout = layout_service.layout_message(
                    &chat_msg.content,
                    width,
                    font_size,
                    has_reply,
                    is_first_message,
                );
                chat_msg.layout = layout;

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
            // These already come with proper IRC formatting from Twitch
            if tx.send(trimmed.to_string()).is_err() {
                // println!("[IRC Chat] No active receivers, queueing USERNOTICE");
                let mut queue = get_message_queue().lock().await;
                queue.push_back(trimmed.to_string());

                if queue.len() > 500 {
                    queue.pop_front();
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

        // Content
        let content = if let Some(idx) = raw.find("PRIVMSG") {
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

        let badges_str = tag_map.get("badges").unwrap_or(&"");
        let badges: Vec<Badge> = badges_str
            .split(',')
            .filter(|s| !s.is_empty())
            .map(|b_str| {
                let mut p = b_str.split('/');
                Badge {
                    name: p.next().unwrap_or("").to_string(),
                    version: p.next().unwrap_or("").to_string(),
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
        })
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

        println!("[IRC Chat] Chat service stopped");

        Ok(())
    }
}
