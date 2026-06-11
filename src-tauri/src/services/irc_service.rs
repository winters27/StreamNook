use crate::models::chat_layout::{
    Badge, ChatMessage, EmotePos, LayoutResult, MessageMetadata, MessageSegment, ReplyInfo,
};
use crate::models::settings::AppState;
use crate::services::emoji_service;
use crate::services::emote_service::{Emote, EmoteService, EmoteSet};
use crate::services::layout_service::LayoutService;
use crate::services::twitch_service::TwitchService;
use crate::services::user_message_history_service::UserMessageHistoryService;
use crate::plugin_host::PluginHost;
use crate::services::chat_logger_service::ChatLoggerService;
use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use log::{debug, error};
use rand::Rng;
use serde_json::{json, Value};
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
// Process-wide port of the local WebSocket bridge. Stored so a second
// `start_chat` call (typically from a popout window like StreamNook MultiChat
// opening its own JS store) can be made idempotent — instead of tearing the
// running IRC connection down, we return the existing port and JOIN the new
// channel onto the connection that's already live.
static WS_PORT: OnceLock<Mutex<Option<u16>>> = OnceLock::new();
// Per-channel caches (lowercase channel name -> value). Multi-channel chat
// (StreamNook MultiChat) needs each JOINed channel to retain its own badges,
// room state, and emote set so split-mode rendering and late-mount tab opens
// don't get cross-channel state.
static USER_BADGES_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static ROOM_STATE_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static CHANNEL_EMOTES: OnceLock<Mutex<HashMap<String, EmoteSet>>> = OnceLock::new();
// Per-channel consumer refcount. Each `start_chat` / `join_chat_channel`
// from a window increments; each `leave_chat_channel` decrements. Actual IRC
// JOIN / PART only happens at the 0->1 / 1->0 transitions, so a popout
// opening for xqc while main's ChatWidget is unmounting (also for xqc)
// doesn't lose the channel — whichever IPC arrives first, the channel stays
// JOINed as long as any window still wants it.
static CHANNEL_REFCOUNT: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
// Handle to the plugin host so parsed chat lines can be forwarded to plugins
// subscribed to on_chat_message. Set once, on the first chat start.
static PLUGIN_HOST: OnceLock<Arc<PluginHost>> = OnceLock::new();
// The logged-in user's (login, user id), for attributing locally sent
// messages: Twitch IRC does not echo your own PRIVMSG back.
static OWN_IDENTITY: OnceLock<Mutex<Option<(String, String)>>> = OnceLock::new();

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

fn get_user_badges_cache() -> &'static Mutex<HashMap<String, String>> {
    USER_BADGES_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_room_state_cache() -> &'static Mutex<HashMap<String, String>> {
    ROOM_STATE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_channel_emotes() -> &'static Mutex<HashMap<String, EmoteSet>> {
    CHANNEL_EMOTES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_ws_port() -> &'static Mutex<Option<u16>> {
    WS_PORT.get_or_init(|| Mutex::new(None))
}

fn get_channel_refcount() -> &'static Mutex<HashMap<String, u32>> {
    CHANNEL_REFCOUNT.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_own_identity() -> &'static Mutex<Option<(String, String)>> {
    OWN_IDENTITY.get_or_init(|| Mutex::new(None))
}

/// The lean wire shape of the on_chat_message plugin event (PROTOCOL.md):
/// identity, text, and event metadata only. Render data (segments, layout,
/// emote URLs) stays out so the payload is small and stable.
fn chat_event_params(msg: &ChatMessage) -> Value {
    let ts = msg
        .timestamp
        .parse::<i64>()
        .ok()
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    json!({
        "channel": msg.channel,
        "message": {
            "id": msg.id,
            "user_id": msg.user_id,
            "login": msg.username,
            "display_name": msg.display_name,
            "color": msg.color,
            "badges": msg
                .badges
                .iter()
                .map(|b| json!({ "name": b.name, "version": b.version }))
                .collect::<Vec<_>>(),
            "text": msg.content,
            "is_action": msg.metadata.is_action,
            "msg_type": msg.metadata.msg_type,
            "system_message": msg.metadata.system_message,
            "bits": msg.metadata.bits_amount,
            "ts": ts,
        }
    })
}

// Extract the channel name (lowercase, no leading #) from a raw IRC line.
// Used by ROOMSTATE/USERSTATE/CLEARMSG/CLEARCHAT parsing to key per-channel
// caches and tag synthetic WS messages.
fn extract_channel_from_irc_line(line: &str) -> Option<String> {
    let idx = line.find(" #")?;
    let after = &line[idx + 2..];
    let end = after.find([' ', '\r', '\n']).unwrap_or(after.len());
    let name = &after[..end];
    if name.is_empty() {
        None
    } else {
        Some(name.to_lowercase())
    }
}

impl IrcService {
    pub async fn start(channel: &str, state: &AppState) -> Result<u16> {
        let layout_service = state.layout_service.clone();
        let emote_service = state.emote_service.clone();
        let _ = PLUGIN_HOST.set(state.plugin_host.clone());
        ChatLoggerService::init(state.settings.clone());

        // Idempotency: if the IRC service is already running, don't tear it
        // down. Instead, JOIN the requested channel onto the existing
        // connection (if not already joined) and return the existing WS port.
        // This is critical for multi-window setups — the MultiChat popout's JS
        // store calls start_chat as its first action, and if we tore down the
        // main app's connection here every popout would freeze the main app's
        // chat.
        {
            let irc_alive = get_irc_handle().lock().await.is_some();
            let ws_alive = get_ws_server_handle().lock().await.is_some();
            let existing_port = *get_ws_port().lock().await;
            if irc_alive && ws_alive {
                if let Some(port) = existing_port {
                    let key = channel.to_lowercase();
                    // `join_channel` is refcount-aware: it bumps the
                    // per-channel consumer count and only sends IRC JOIN on
                    // the 0->1 transition. Best-effort: failures here just
                    // mean the channel hasn't been added to the existing IRC
                    // session; the caller will see that messages aren't
                    // arriving and can recover.
                    if let Err(e) = Self::join_channel(&key).await {
                        log::warn!("[IRC Chat] idempotent JOIN failed for {}: {}", key, e);
                    }
                    // Fetch emotes for this channel so segment parsing
                    // matches what the user sees in chat. Cheap when already
                    // cached on the Rust side from an earlier consumer.
                    Self::fetch_and_store_emotes(&key, emote_service.clone()).await;
                    return Ok(port);
                }
            }
        }

        // Stop any partially-alive remnants of a previous connection before
        // fresh setup. (Idempotent guard above handles the healthy-alive case;
        // this stop() is for when only some of the handles are present.)
        Self::stop().await?;

        debug!(
            "[IRC Chat] Starting IRC chat service for channel: {}",
            channel
        );

        // Store current channel (lowercased so set lookups match IRC frames,
        // which always carry lowercase channel names).
        get_current_channels()
            .lock()
            .await
            .insert(channel.to_lowercase());

        // Clear all per-channel caches on a fresh start. stop() also clears these,
        // but be defensive in case start() is called without a preceding stop().
        get_user_badges_cache().lock().await.clear();
        get_room_state_cache().lock().await.clear();
        get_channel_emotes().lock().await.clear();
        // Seed the consumer refcount: this is the first window to ask for the
        // initial channel; the IRC JOIN is performed implicitly by
        // run_irc_connection below, so we just account for it here.
        {
            let mut refcounts = get_channel_refcount().lock().await;
            refcounts.clear();
            refcounts.insert(channel.to_lowercase(), 1);
        }

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

        debug!("[IRC Chat] User: {} ({})", user_info.login, user_info.id);

        *get_own_identity().lock().await =
            Some((user_info.login.clone(), user_info.id.clone()));

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
        // Remember the port so subsequent start_chat calls (from popout
        // windows etc.) can be served idempotently without tearing down.
        *get_ws_port().lock().await = Some(port);

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
                error!("[IRC Chat] Connection error: {}", e);
            }
        });

        *get_irc_handle().lock().await = Some(irc_handle);

        debug!("[IRC Chat] Chat service started on port {}", port);

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
            debug!("[IRC Chat] Connecting to Twitch IRC...");

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
                debug!("[IRC Chat] Requesting capabilities...");
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

                debug!("[IRC Chat] Server response: {}", line.trim());

                if line.contains("CAP * ACK") {
                    cap_acknowledged = true;
                    debug!("[IRC Chat] Capabilities acknowledged");
                }
            }

            // Step 3: Now authenticate with PASS and NICK
            {
                let mut w = writer.lock().await;
                // IRC requires "oauth:" prefix for the password
                let auth_token = format!("oauth:{}", token);

                debug!("[IRC Chat] Authenticating with username: {}", username);
                debug!(
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

                debug!("[IRC Chat] Auth response: {}", line.trim());

                if line.contains("001") {
                    authenticated = true;
                    debug!("[IRC Chat] Successfully authenticated");
                } else if line.contains("NOTICE")
                    && (line.contains("Login unsuccessful")
                        || line.contains("Login authentication failed"))
                {
                    return Err(anyhow::anyhow!(
                        "IRC authentication failed - token may be invalid or expired. Try logging out and back in."
                    ));
                }
            }

            // Join every channel we're tracking — not just the initial one. On a
            // fresh connect `current_channels` holds only the initial channel; on a
            // reconnect it also holds every additional channel added during the
            // session (MultiNook tiles, MultiChat tabs) via `join_channel`. Those
            // must be re-JOINed here or they stay silently PARTed after a reconnect:
            // `join_channel` won't re-issue a JOIN for them because their refcount
            // is still > 0, and `run_irc_connection` previously only re-joined the
            // initial channel. That left every extra channel dead after the first
            // IRC drop.
            {
                let mut channels: Vec<String> = get_current_channels()
                    .lock()
                    .await
                    .iter()
                    .cloned()
                    .collect();
                // On a fresh connect the set already holds the initial channel;
                // this fallback only covers the unexpected-empty case so we never
                // connect with zero joins.
                if channels.is_empty() {
                    channels.push(initial_channel.to_lowercase());
                }
                let mut w = writer.lock().await;
                for ch in &channels {
                    w.write_all(format!("JOIN #{}\r\n", ch).as_bytes()).await?;
                }
                w.flush().await?;
                debug!(
                    "[IRC Chat] Joined {} channel(s): {:?}",
                    channels.len(),
                    channels
                );
            }

            // Fetch channel emotes
            let initial_channel_id =
                Self::fetch_and_store_emotes(initial_channel, Arc::clone(&emote_service)).await;

            // Subscribe the initial channel to the 7TV EventAPI (live emote set
            // updates). Idempotent, so the IRC reconnect loop re-calling this is
            // a no-op for an already-subscribed channel.
            if let Some(cid) = initial_channel_id {
                crate::services::seventv_eventapi::subscribe_channel(initial_channel, &cid).await;
                // Subscribe the moderator view (channel.moderate) for this chat.
                // Silently skipped server-side if you don't moderate the channel.
                crate::services::eventsub_moderation::subscribe_channel(initial_channel, &cid)
                    .await;
            }

            // Send connection success notification
            let _ = tx.send("IRC_CONNECTED".to_string());

            // Flush queued messages
            let mut queue = get_message_queue().lock().await;
            if !queue.is_empty() {
                debug!("[IRC Chat] Flushing {} queued messages", queue.len());
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
                        debug!("[IRC Chat] Connection closed by server");
                        true
                    }
                    Ok(_) => {
                        if let Err(e) =
                            Self::handle_irc_message(&line, &tx, &writer, &layout_service).await
                        {
                            error!("[IRC Chat] Error handling message: {}", e);
                        }
                        false
                    }
                    Err(e) => {
                        error!("[IRC Chat] Read error: {}", e);
                        true
                    }
                };

                if should_reconnect {
                    ping_handle.abort();
                    heartbeat_handle.abort();
                    debug!("[IRC Chat] Reconnecting in 5 seconds...");
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

            // Debug: Log cheer/bits messages (raw IRC data)
            if enhanced_message.contains("bits=") {
                debug!(
                    "\n[IRC CHEER DEBUG] ========== RAW BITS MESSAGE ==========\n{}\n[IRC CHEER DEBUG] =========================================\n",
                    enhanced_message
                );
            }

            // Debug: Log the received IRC message to see what we're parsing
            if enhanced_message.contains(":Stare") || enhanced_message.contains(" Stare ") {
                debug!(
                    "[IRC Chat DEBUG] Received PRIVMSG with 'Stare': {}",
                    enhanced_message
                );
            }

            // Parse and layout
            if let Some(mut chat_msg) = Self::parse_privmsg(&enhanced_message) {
                debug!(
                    "[IRC Chat DEBUG] Parsed message from {}: content='{}', {} segments",
                    chat_msg.username,
                    chat_msg.content,
                    chat_msg.segments.len()
                );

                // DOM-FIRST ARCHITECTURE: Frontend measures heights via ResizeObserver
                // Backend only provides message data, not layout calculations
                // Set a placeholder height - frontend will measure and set the real value
                chat_msg.layout = LayoutResult {
                    height: 60.0, // Placeholder - frontend DOM measurement is authoritative
                    width: 0.0,   // Not used anymore
                    has_reply: chat_msg.metadata.reply_info.is_some(),
                    is_first_message: chat_msg.metadata.is_first_message,
                };

                // Store a compact summary (id/content/timestamp/color) in the user
                // history LRU for profile cards. Avoids cloning the full ChatMessage.
                if !chat_msg.user_id.is_empty() {
                    let history_service = UserMessageHistoryService::global();
                    history_service
                        .add_message(&chat_msg.user_id, &chat_msg)
                        .await;
                }

                ChatLoggerService::log_message(&chat_msg);

                if let Some(host) = PLUGIN_HOST.get() {
                    if host.wants_chat_messages().await {
                        host.emit_chat_message(chat_event_params(&chat_msg)).await;
                    }
                }

                if let Ok(json_msg) = serde_json::to_string(&chat_msg) {
                    if tx.send(json_msg).is_err() {
                        // debug!("[IRC Chat] No active receivers, queueing message");
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
            // Parse USERNOTICE messages - layout will be measured by frontend
            if let Some(mut chat_msg) = Self::parse_usernotice(trimmed) {
                // Skip USERNOTICE messages with no visible content
                // These render as blank/ghost messages (e.g., "onetapgiftredeemed" with no text)
                let has_content = !chat_msg.content.is_empty();
                let has_system_msg = chat_msg
                    .metadata
                    .system_message
                    .as_ref()
                    .is_some_and(|s| !s.is_empty());

                if !has_content && !has_system_msg {
                    debug!(
                        "[IRC Chat] Skipping empty USERNOTICE: type={:?}",
                        chat_msg.metadata.msg_type
                    );
                    return Ok(());
                }

                // DOM-FIRST ARCHITECTURE: Frontend measures heights via ResizeObserver
                // Backend only provides message data, not layout calculations
                chat_msg.layout = LayoutResult {
                    height: 100.0, // Larger placeholder for subscription messages
                    width: 0.0,
                    has_reply: false,
                    is_first_message: false,
                };

                debug!(
                    "[IRC Chat] Parsed USERNOTICE: type={:?}, user_content_len={}",
                    chat_msg.metadata.msg_type,
                    chat_msg.content.len()
                );

                ChatLoggerService::log_message(&chat_msg);

                if let Some(host) = PLUGIN_HOST.get() {
                    if host.wants_chat_messages().await {
                        host.emit_chat_message(chat_event_params(&chat_msg)).await;
                    }
                }

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
            debug!("[IRC Chat] Room state update: {}", trimmed);

            // Extract channel so the synthetic message is routable and the cache
            // is keyed per channel.
            let channel_name = extract_channel_from_irc_line(trimmed);

            // Forward room state to frontend — only include tags actually present
            // Twitch sends FULL roomstate on join, PARTIAL on setting changes
            let mut room_state = serde_json::Map::new();
            room_state.insert("type".into(), serde_json::json!("ROOMSTATE"));
            if let Some(ref ch) = channel_name {
                room_state.insert("channel".into(), serde_json::json!(ch));
            }

            if let Some(v) = Self::extract_tag_value(trimmed, "followers-only") {
                if let Ok(n) = v.parse::<i64>() {
                    room_state.insert("followers_only".into(), serde_json::json!(n));
                }
            }
            if let Some(v) = Self::extract_tag_value(trimmed, "slow") {
                if let Ok(n) = v.parse::<u64>() {
                    room_state.insert("slow".into(), serde_json::json!(n));
                }
            }
            if let Some(v) = Self::extract_tag_value(trimmed, "subs-only") {
                if let Ok(n) = v.parse::<u8>() {
                    room_state.insert("subs_only".into(), serde_json::json!(n == 1));
                }
            }
            if let Some(v) = Self::extract_tag_value(trimmed, "emote-only") {
                if let Ok(n) = v.parse::<u8>() {
                    room_state.insert("emote_only".into(), serde_json::json!(n == 1));
                }
            }
            if let Some(v) = Self::extract_tag_value(trimmed, "r9k") {
                if let Ok(n) = v.parse::<u8>() {
                    room_state.insert("r9k".into(), serde_json::json!(n == 1));
                }
            }

            let room_state_str = serde_json::Value::Object(room_state).to_string();

            // Cache the room state per channel so late-mounting MultiChat tabs
            // for any subscribed channel get its current state on connect.
            if let Some(ref ch) = channel_name {
                get_room_state_cache()
                    .lock()
                    .await
                    .insert(ch.clone(), room_state_str.clone());
            }

            let _ = tx.send(room_state_str);

            // Check for shared chat information
            if let Some(room_id) = Self::extract_tag_value(trimmed, "room-id") {
                Self::check_shared_chat_status(&room_id).await;
            }
        } else if trimmed.contains("USERSTATE") {
            // User state in channel (mod status, badges, etc.)
            // USERSTATE is sent when joining a channel AND after sending a message
            // It contains the user's badges which we need for optimistic message display
            debug!("[IRC Chat] User state update: {}", trimmed);

            // Extract channel so the user's per-channel badges are keyed and the
            // synthetic wire message carries the channel for frontend routing.
            let channel_name = extract_channel_from_irc_line(trimmed);

            // Extract badges from USERSTATE and cache them per channel
            if let Some(badges) = Self::extract_tag_value(trimmed, "badges") {
                debug!(
                    "[IRC Chat] Caching user badges from USERSTATE for {:?}: {}",
                    channel_name, badges
                );
                if let Some(ref ch) = channel_name {
                    get_user_badges_cache()
                        .lock()
                        .await
                        .insert(ch.clone(), badges.clone());
                }

                // Send badges to frontend tagged with the channel they apply to.
                // Format: USER_BADGES:#<channel>:<badges>. The leading '#' lets
                // the frontend parser locate the channel-prefix segment unambiguously.
                let badges_message = match &channel_name {
                    Some(ch) => format!("USER_BADGES:#{}:{}", ch, badges),
                    None => format!("USER_BADGES:{}", badges),
                };
                let _ = tx.send(badges_message);
            }

            // Extract emote-sets to fetch user's subscribed emotes
            if let Some(emote_sets) = Self::extract_tag_value(trimmed, "emote-sets") {
                debug!(
                    "[IRC Chat] User has {} emote sets available",
                    emote_sets.split(',').count()
                );
                // TODO: Fetch emotes from user's subscribed sets
                // This would require additional API calls to get emotes from each set
            }
        } else if trimmed.contains("CLEARMSG") {
            // Single message deleted by mod
            // Format: @login=<user>;room-id=<room>;target-msg-id=<msg-id>;tmi-sent-ts=<ts> :tmi.twitch.tv CLEARMSG #<channel> :<message>
            debug!("[IRC Chat] Message deleted: {}", trimmed);

            if let Some(target_msg_id) = Self::extract_tag_value(trimmed, "target-msg-id") {
                let channel_name = extract_channel_from_irc_line(trimmed);
                // The deleted message text is the trailing param after the last " :".
                let deleted_text = trimmed
                    .rfind(" :")
                    .map(|idx| trimmed[idx + 2..].trim().to_string());
                let login = Self::extract_tag_value(trimmed, "login").unwrap_or_default();
                if let Some(ch) = &channel_name {
                    ChatLoggerService::log_deleted_message(ch, &login, deleted_text.as_deref());
                }
                // Send deletion event to frontend, tagged with channel for routing
                let delete_event = json!({
                    "type": "CLEARMSG",
                    "channel": channel_name,
                    "target_msg_id": target_msg_id,
                    "login": login,
                    "message": deleted_text
                });
                let _ = tx.send(delete_event.to_string());
            }
        } else if trimmed.contains("CLEARCHAT") {
            // User timed out/banned (clear all their messages) or chat cleared
            // Format: @ban-duration=<sec>;room-id=<room>;target-user-id=<id>;tmi-sent-ts=<ts> :tmi.twitch.tv CLEARCHAT #<channel> :<user>
            // Or for full chat clear: :tmi.twitch.tv CLEARCHAT #<channel>
            debug!("[IRC Chat] Chat clear/timeout: {}", trimmed);

            let target_user_id = Self::extract_tag_value(trimmed, "target-user-id");
            let ban_duration = Self::extract_tag_value(trimmed, "ban-duration");
            let channel_name = extract_channel_from_irc_line(trimmed);

            // Extract target username from the message content (after the colon at the end).
            // For full chat clears there's no trailing " :" so be careful not to misinterpret
            // an earlier inline colon as the username delimiter.
            let target_user = if let Some(idx) = trimmed.rfind(" :") {
                Some(trimmed[idx + 2..].trim().to_string())
            } else {
                None
            };

            let ban_duration_secs = ban_duration.map(|d| d.parse::<u64>().unwrap_or(0));
            if let Some(ch) = &channel_name {
                match &target_user {
                    Some(user) => ChatLoggerService::log_timeout(ch, user, ban_duration_secs),
                    None => ChatLoggerService::log_chat_cleared(ch),
                }
            }

            let clear_event = json!({
                "type": "CLEARCHAT",
                "channel": channel_name,
                "target_user_id": target_user_id,
                "target_user": target_user,
                "ban_duration": ban_duration_secs
            });
            let _ = tx.send(clear_event.to_string());
        } else if trimmed.contains("NOTICE") {
            // System notices — forward to frontend for user-facing handling
            debug!("[IRC Chat] Notice: {}", trimmed);

            // Extract the msg-id tag (e.g. "msg_followersonly", "msg_subsonly")
            // Present when twitch.tv/tags capability is active (requested at connect)
            let msg_id = Self::extract_tag_value(trimmed, "msg-id");

            // Extract the human-readable notice text after the last " :"
            let notice_text = trimmed
                .rfind(" :")
                .map(|idx| trimmed[idx + 2..].trim().to_string());

            let notice_event = serde_json::json!({
                "type": "NOTICE",
                "channel": extract_channel_from_irc_line(trimmed),
                "msg_id": msg_id,
                "message": notice_text,
            });
            let _ = tx.send(notice_event.to_string());
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
                let client = crate::services::http::client().clone();
                let url = format!(
                    "https://api.twitch.tv/helix/shared_chat/session?broadcaster_id={}",
                    room_id
                );

                match client
                    .get(&url)
                    .header("Client-Id", env!("TWITCH_APP_CLIENT_ID"))
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

                                            debug!(
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
                        error!("[IRC Chat] Failed to check shared chat status: {}", e);
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

        debug!("[WS] New local WebSocket client connected");

        // Replay cached per-channel state to the new client. The state for each
        // currently JOINed channel is sent so a late-mounting MultiChat tab
        // sees room state and user badges without waiting for the next
        // ROOMSTATE/USERSTATE roundtrip.
        //
        // Snapshot under the lock then release before awaiting sends to avoid
        // holding the cache lock across await points (deadlock risk if the
        // IRC reader concurrently tries to write).
        let room_states: Vec<String> = {
            let cache = get_room_state_cache().lock().await;
            cache.values().cloned().collect()
        };
        for state in room_states {
            let _ = local_tx.send(warp::ws::Message::text(state)).await;
        }

        let badge_entries: Vec<(String, String)> = {
            let cache = get_user_badges_cache().lock().await;
            cache
                .iter()
                .map(|(ch, badges)| (ch.clone(), badges.clone()))
                .collect()
        };
        for (channel, badges) in badge_entries {
            let badges_message = format!("USER_BADGES:#{}:{}", channel, badges);
            let _ = local_tx.send(warp::ws::Message::text(badges_message)).await;
        }

        // Send any queued messages first
        let mut queue = get_message_queue().lock().await;
        let queued_count = queue.len();
        if queued_count > 0 {
            debug!(
                "[WS] Sending {} queued messages to new client",
                queued_count
            );
            while let Some(msg) = queue.pop_front() {
                if local_tx.send(warp::ws::Message::text(msg)).await.is_err() {
                    debug!("[WS] Client disconnected while sending queued messages");
                    return;
                }
            }
        }
        drop(queue);

        // Forward messages from broadcast to local client.
        //
        // Note: `while let Ok(text) = rx.recv().await` is wrong here — it exits
        // on `RecvError::Lagged`, which fires when a subscriber falls behind by
        // more than the channel capacity. In fast chats a freshly-mounted
        // MultiChat popout window does enough first-render work that its
        // browser-side WS read drains slowly, the tokio TCP write blocks, this
        // receiver stops being polled, the broadcast buffer overflows, and the
        // next poll returns Lagged. Exiting the loop on Lagged silently closed
        // the WS — visible to the user as chat "freezing" the moment the
        // popout opened in a busy channel. Treat Lagged as a recoverable miss:
        // log it and keep draining; only Closed actually tears the handler
        // down.
        loop {
            match rx.recv().await {
                Ok(text) => {
                    if local_tx.send(warp::ws::Message::text(text)).await.is_err() {
                        debug!("[WS] Client disconnected");
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    log::warn!(
                        "[WS] Subscriber lagged behind by {} messages; continuing",
                        n
                    );
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    debug!("[WS] Broadcast channel closed");
                    break;
                }
            }
        }
    }

    pub async fn send_message(
        message: &str,
        reply_parent_msg_id: Option<&str>,
        target_channel: Option<&str>,
    ) -> Result<()> {
        // Resolve the target channel without locking the channel set across the
        // send. Falls back to "the only currently-joined channel" when the caller
        // didn't supply one (legacy single-channel callers); otherwise uses the
        // caller's explicit target.
        let channel = match target_channel {
            Some(c) => c.to_lowercase(),
            None => {
                let channels = get_current_channels().lock().await;
                channels
                    .iter()
                    .next()
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("No active chat connection"))?
            }
        };

        // Per-window refcounting doesn't exist on the Rust side yet — each
        // browser window has its own JS-side refcount, and when one window
        // releases a channel it issues PART regardless of whether another
        // window still wants it. So MultiChat can find itself in a state
        // where it believes it's JOINed but Rust's `current_channels` no
        // longer contains the channel (and Twitch IRC has likewise PARTed).
        // Re-JOIN defensively when the caller is sending to a channel we
        // don't think is active. Cheap on success, recoverable on conflict.
        let needs_join = !get_current_channels().lock().await.contains(&channel);
        if needs_join {
            log::warn!(
                "[IRC Chat] send_message for {} but channel not in current set; defensive re-JOIN",
                channel
            );
            if let Err(e) = Self::join_channel(&channel).await {
                return Err(anyhow::anyhow!(
                    "Failed to re-JOIN channel {} before send: {}",
                    channel,
                    e
                ));
            }
        }

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

        debug!("[IRC Chat] Sending message: {}", message);
        w.write_all(formatted_message.as_bytes()).await?;
        w.flush().await?;
        drop(w);

        // Messages sent over THIS connection get no IRC echo (Helix sends do,
        // and reach the parsed-message path like anyone else's). Surface them
        // to the chat logger and plugins from here, mirroring the chat UI's
        // local echo. Slash-commands other than /me are not chat lines (their
        // effects, like timeouts, are logged where the server reports them).
        let is_command = message.starts_with('/') && !message.starts_with("/me ");
        if !is_command {
            let login = get_own_identity()
                .lock()
                .await
                .as_ref()
                .map(|(login, _)| login.clone())
                .unwrap_or_default();
            ChatLoggerService::log_own_message(&channel, &login, message);
        }
        // Plugin delivery uses an empty id (no server-assigned id exists).
        if !is_command {
            if let Some(host) = PLUGIN_HOST.get() {
                if host.wants_chat_messages().await {
                    let (login, user_id) = get_own_identity()
                        .lock()
                        .await
                        .clone()
                        .unwrap_or_default();
                    let (text, is_action) = match message.strip_prefix("/me ") {
                        Some(rest) => (rest, true),
                        None => (message, false),
                    };
                    host.emit_chat_message(json!({
                        "channel": channel,
                        "message": {
                            "id": "",
                            "user_id": user_id,
                            "login": login,
                            "display_name": login,
                            "color": Value::Null,
                            "badges": [],
                            "text": text,
                            "is_action": is_action,
                            "msg_type": Value::Null,
                            "system_message": Value::Null,
                            "bits": Value::Null,
                            "ts": chrono::Utc::now().to_rfc3339(),
                        }
                    }))
                    .await;
                }
            }
        }

        Ok(())
    }

    /// Wait up to `max_attempts` × 50ms for the IRC writer to be set. `start`
    /// spawns `run_irc_connection` (which sets the writer once the TCP socket is
    /// up) and returns the WS port *before* that task has connected. So a JOIN
    /// issued right after a fresh `start_chat` — e.g. several chats opening at
    /// once, where the first channel's connection is still in flight — can
    /// momentarily see no writer. Polling smooths over that startup window
    /// instead of failing the JOIN outright.
    async fn wait_for_irc_writer(
        max_attempts: u32,
    ) -> Option<Arc<Mutex<tokio::io::WriteHalf<TcpStream>>>> {
        for attempt in 0..max_attempts {
            if let Some(writer) = get_irc_writer().lock().await.as_ref() {
                return Some(writer.clone());
            }
            if attempt + 1 < max_attempts {
                tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            }
        }
        None
    }

    pub async fn join_channel(channel: &str) -> Result<()> {
        let key = channel.to_lowercase();

        // Refcount first. Multiple windows may JOIN the same channel
        // concurrently (main + N MultiChat popouts); only the first one
        // actually sends JOIN to IRC. Subsequent consumers just bump the
        // count so leave_channel knows the channel is still wanted.
        let new_count = {
            let mut refcounts = get_channel_refcount().lock().await;
            let entry = refcounts.entry(key.clone()).or_insert(0);
            *entry += 1;
            *entry
        };

        if new_count > 1 {
            debug!(
                "[IRC Chat] join_channel({}): refcount now {}, reusing existing JOIN",
                key, new_count
            );
            return Ok(());
        }

        // The connection may still be establishing: start_chat spawns the IRC
        // task and returns before the writer is set, so when several chats open
        // at once an additional channel's JOIN can arrive before the first
        // channel finishes connecting. Wait for the writer instead of failing —
        // bailing here would also skip the per-channel mod-view / 7TV
        // subscriptions below, which is exactly why a second chat opened in the
        // same burst would silently receive no moderator events.
        let writer = match Self::wait_for_irc_writer(100).await {
            Some(w) => w,
            None => {
                // Give back the consumer slot we claimed so a later retry or the
                // reconnect path can JOIN cleanly instead of seeing refcount > 1.
                let mut refcounts = get_channel_refcount().lock().await;
                if let Some(entry) = refcounts.get_mut(&key) {
                    *entry = entry.saturating_sub(1);
                    if *entry == 0 {
                        refcounts.remove(&key);
                    }
                }
                return Err(anyhow::anyhow!("IRC connection not established"));
            }
        };

        let mut w = writer.lock().await;
        w.write_all(format!("JOIN #{}\r\n", key).as_bytes()).await?;
        w.flush().await?;

        get_current_channels().lock().await.insert(key.clone());

        debug!("[IRC Chat] Joined channel: #{} (first consumer)", key);

        // Check for shared chat in the new channel, and subscribe it to the 7TV
        // EventAPI for live emote set updates. Both reuse the same lookup.
        if let Ok(broadcaster_info) = TwitchService::get_user_by_login(channel).await {
            Self::check_shared_chat_status(&broadcaster_info.id).await;
            crate::services::seventv_eventapi::subscribe_channel(&key, &broadcaster_info.id).await;
            crate::services::eventsub_moderation::subscribe_channel(&key, &broadcaster_info.id)
                .await;
        }

        Ok(())
    }

    pub async fn leave_channel(channel: &str) -> Result<()> {
        let key = channel.to_lowercase();

        // Refcount first. The MultiChat popout flow fires `start_chat` for
        // the new window's channel and then unmounts main's ChatWidget,
        // which fires `leave_chat_channel` for the same channel. Without
        // refcounting, the unconditional PART here would race with — and
        // usually lose to — the popout's start_chat, leaving the popout
        // subscribed to a channel nobody is JOINed to. Only the last
        // consumer's leave actually PARTs.
        let new_count = {
            let mut refcounts = get_channel_refcount().lock().await;
            let entry = refcounts.entry(key.clone()).or_insert(1);
            *entry = entry.saturating_sub(1);
            let n = *entry;
            if n == 0 {
                refcounts.remove(&key);
            }
            n
        };

        if new_count > 0 {
            debug!(
                "[IRC Chat] leave_channel({}): refcount now {}, keeping JOIN",
                key, new_count
            );
            return Ok(());
        }

        let writer_lock = get_irc_writer().lock().await;
        let writer = writer_lock
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("IRC connection not established"))?
            .clone();
        drop(writer_lock);

        let mut w = writer.lock().await;
        w.write_all(format!("PART #{}\r\n", key).as_bytes()).await?;
        w.flush().await?;
        drop(w);

        get_current_channels().lock().await.remove(&key);

        // Drop per-channel caches so PARTed channels don't accumulate memory.
        // If the user re-JOINs later, fetch_and_store_emotes runs again and
        // USERSTATE/ROOMSTATE refill from the next IRC frames.
        get_channel_emotes().lock().await.remove(&key);
        get_user_badges_cache().lock().await.remove(&key);
        get_room_state_cache().lock().await.remove(&key);

        // Stop receiving 7TV EventAPI updates for this channel.
        crate::services::seventv_eventapi::unsubscribe_channel(&key).await;
        // Stop the moderator-view subscription for this channel.
        crate::services::eventsub_moderation::unsubscribe_channel(&key).await;

        debug!("[IRC Chat] Left channel: #{} (last consumer)", key);

        Ok(())
    }

    /// Fetch and store channel emotes for the current channel. Returns the
    /// resolved Twitch channel id (broadcaster user id) on success so callers
    /// can drive the 7TV EventAPI subscription off the same lookup.
    pub async fn fetch_and_store_emotes(
        channel_name: &str,
        emote_service: Arc<tokio::sync::RwLock<EmoteService>>,
    ) -> Option<String> {
        debug!("[IRC Chat] Fetching emotes for channel: {}", channel_name);

        // Pull the OAuth token so the cache write here matches what the
        // frontend's token-bearing fetch produces. Without this, an IRC-side
        // write can race ahead of the frontend's call and leave the shared
        // EmoteService cache containing only the 15 hardcoded globals — which
        // a freshly-opened MultiChat popout then reads and displays.
        let access_token = TwitchService::get_token().await.ok();

        // Get broadcaster ID from channel name
        match TwitchService::get_user_by_login(channel_name).await {
            Ok(user) => {
                let key = channel_name.to_lowercase();

                // Disk-first: seed the chat parse map from the saved per-channel
                // dictionary so chat recognizes this channel's emotes instantly,
                // with no network round-trip, even when 7TV is slow or down. The
                // prefetch and earlier good fetches populate this on disk. Only
                // seed when the saved set is more complete (by 7TV count) than
                // whatever is already in memory, so a second window joining the
                // same channel can't downgrade a good live set.
                if let Some(disk_set) = crate::services::emote_set_cache::load(&user.id) {
                    let mut map = get_channel_emotes().lock().await;
                    let current = map.get(&key).map(|s| s.seven_tv.len()).unwrap_or(0);
                    if disk_set.seven_tv.len() > current {
                        debug!(
                            "[IRC Chat] Seeded {} from disk dictionary (7TV: {})",
                            channel_name,
                            disk_set.seven_tv.len()
                        );
                        map.insert(key.clone(), disk_set);
                    }
                }

                // Live refresh. Replace the parse map only when 7TV's channel
                // fetch definitively succeeded (seven_tv_ok); a deficient fetch
                // (globals-only from a tripped circuit breaker, or a timed-out
                // channel set) keeps the disk-seeded set instead of poisoning
                // chat. An authoritative result is written through to disk too, so
                // the next join is disk-first and legit removals persist.
                {
                    let emote_svc = emote_service.read().await;
                    match emote_svc
                        .fetch_channel_emotes_checked(
                            Some(channel_name.to_string()),
                            Some(user.id.clone()),
                            access_token,
                        )
                        .await
                    {
                        Ok((emote_set, seven_tv_ok)) => {
                            debug!(
                                "[IRC Chat] Fetched {} total emotes for {} (Twitch: {}, BTTV: {}, 7TV: {}, FFZ: {}); 7TV channel ok: {}",
                                emote_set.total_count(),
                                channel_name,
                                emote_set.twitch.len(),
                                emote_set.bttv.len(),
                                emote_set.seven_tv.len(),
                                emote_set.ffz.len(),
                                seven_tv_ok
                            );
                            if seven_tv_ok {
                                crate::services::emote_set_cache::save_force(&user.id, &emote_set);
                                get_channel_emotes().lock().await.insert(key, emote_set);
                            } else {
                                debug!(
                                    "[IRC Chat] Keeping disk-seeded set for {}; 7TV channel fetch was deficient (7TV {})",
                                    channel_name,
                                    emote_set.seven_tv.len()
                                );
                            }
                        }
                        Err(e) => {
                            error!("[IRC Chat] Failed to fetch channel emotes: {}", e);
                        }
                    }
                }
                Some(user.id)
            }
            Err(e) => {
                error!(
                    "[IRC Chat] Failed to get user info for {}: {}",
                    channel_name, e
                );
                None
            }
        }
    }

    /// Parse message content into segments (text, emotes, emojis, links)
    /// This is the "endgame" - all parsing done in Rust, zero regex on main thread
    ///
    /// `channel` selects which channel's 7TV/FFZ/BTTV emote set to use. Empty string
    /// (or a channel with no cached emotes) yields no third-party emote matches but
    /// still parses Twitch native emotes and URLs.
    async fn parse_message_segments(
        content: &str,
        twitch_emotes: &[EmotePos],
        channel: &str,
    ) -> Vec<MessageSegment> {
        let mut segments = Vec::new();

        // Handle empty content
        if content.is_empty() {
            return segments;
        }

        // CRITICAL: Twitch sends emote positions as CHARACTER indices, not byte indices!
        // Rust strings are byte-indexed, so we need to convert.
        // Build a mapping from character index to byte index for safe slicing.
        let char_to_byte: Vec<usize> = content
            .char_indices()
            .map(|(byte_idx, _)| byte_idx)
            .collect();
        let char_count = char_to_byte.len();

        // Helper to safely convert char index to byte index
        let char_to_byte_idx = |char_idx: usize| -> Option<usize> {
            if char_idx < char_count {
                Some(char_to_byte[char_idx])
            } else if char_idx == char_count {
                // One past the last character = end of string
                Some(content.len())
            } else {
                None
            }
        };

        // First, split by Twitch native emotes
        let mut last_char_index = 0;
        let mut sorted_emotes = twitch_emotes.to_vec();
        sorted_emotes.sort_by_key(|e| e.start);

        // Acquire emote set lock ONCE before the loop to avoid repeated lock acquisition
        // which can cause deadlocks when called inside block_in_place + block_on
        let emote_set_lock = get_channel_emotes().lock().await;
        let seventv_emotes: Vec<_> = if let Some(emote_set) = emote_set_lock.get(channel) {
            emote_set.seven_tv.clone()
        } else {
            Vec::new()
        };
        drop(emote_set_lock); // Release lock before loop

        for emote in &sorted_emotes {
            // Validate emote bounds (character indices)
            if emote.start >= char_count || emote.end >= char_count || emote.start > emote.end {
                error!(
                    "[IRC Chat] Skipping invalid emote position: start={}, end={}, char_count={}",
                    emote.start, emote.end, char_count
                );
                continue;
            }

            // Convert character indices to byte indices
            let Some(start_byte) = char_to_byte_idx(emote.start) else {
                continue;
            };
            let Some(end_byte_exclusive) = char_to_byte_idx(emote.end + 1) else {
                continue;
            };
            let Some(last_byte) = char_to_byte_idx(last_char_index) else {
                continue;
            };

            // Add text before emote
            if emote.start > last_char_index {
                let text = &content[last_byte..start_byte];
                if !text.is_empty() {
                    // Parse text for third-party emotes, emojis, and links
                    segments.extend(Self::parse_text_segment(text, channel).await);
                }
            }

            // Add Twitch emote (check for 7TV override) - bounds already validated above
            let emote_name = &content[start_byte..end_byte_exclusive];

            // Check if 7TV has an emote with the same name (7TV takes priority)
            let seventv_override = seventv_emotes
                .iter()
                .find(|e| e.name == emote_name)
                .cloned();

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

            last_char_index = emote.end + 1;
        }

        // Add remaining text
        if last_char_index < char_count {
            if let Some(last_byte) = char_to_byte_idx(last_char_index) {
                let text = &content[last_byte..];
                if !text.is_empty() {
                    segments.extend(Self::parse_text_segment(text, channel).await);
                }
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

    /// Parse a text segment for third-party emotes, emojis, and links.
    /// `channel` selects which JOINed channel's emote set to use.
    async fn parse_text_segment(text: &str, channel: &str) -> Vec<MessageSegment> {
        let mut segments = Vec::new();

        // URL regex pattern - matches http://, https://, and www. URLs
        let url_regex = regex::Regex::new(r"(https?://[^\s]+|www\.[^\s]+)").unwrap();

        // Get this channel's emotes (returns None if the channel hasn't been
        // fetched, e.g. just-JOINed; first messages may then render without
        // third-party emotes until fetch_and_store_emotes lands).
        let emote_set_lock = get_channel_emotes().lock().await;
        let emote_set = emote_set_lock.get(channel);

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
            } else if let Some((prefix, bits, tier, color, cheermote_url)) =
                Self::parse_cheermote(word)
            {
                // Found a cheermote pattern (e.g., Cheer500, Party1000)
                segments.push(MessageSegment::Cheermote {
                    content: word.to_string(),
                    prefix,
                    bits,
                    tier,
                    color,
                    cheermote_url,
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
                // Convert emoji shortcodes first
                let converted = emoji_service::convert_emoji_shortcodes(word);

                // Parse for Unicode emojis (both converted shortcodes and direct emoji input)
                // This will emit Emoji segments with Apple CDN URLs for iOS-style rendering
                let emoji_segments = emoji_service::parse_emoji_segments(&converted);

                if emoji_segments.is_empty() {
                    // No content (shouldn't happen, but safety)
                    segments.push(MessageSegment::Text {
                        content: word.to_string(),
                    });
                } else {
                    // Add all parsed segments (text and emoji)
                    segments.extend(emoji_segments);
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

    /// Parse a potential cheermote pattern (e.g., Cheer500, Party1000)
    /// Returns Some((prefix, bits, tier, color, url)) if valid, None otherwise
    fn parse_cheermote(word: &str) -> Option<(String, u32, String, String, String)> {
        // Known cheermote prefixes on Twitch
        // Only these specific prefixes should be treated as cheermotes
        const CHEERMOTE_PREFIXES: &[&str] = &[
            "cheer",
            "cheerwhal",
            "corgo",
            "scoops",
            "uni",
            "showlove",
            "party",
            "seemsgood",
            "pride",
            "kappa",
            "frankerz",
            "heyguys",
            "dansgame",
            "elegiggle",
            "trihard",
            "kreygasm",
            "4head",
            "swiftrage",
            "notlikethis",
            "failfish",
            "vohiyo",
            "pjsalt",
            "mrdestructoid",
            "bday",
            "ripcheer",
            "shamrock",
            "biblethump",
            "doodlecheer",
            "streamlabs",
            "muxy",
            "bitboss",
            "anon",
        ];

        // Case-insensitive prefix matching
        let word_lower = word.to_lowercase();

        // Find which prefix (if any) matches
        let matched_prefix = CHEERMOTE_PREFIXES
            .iter()
            .find(|&&prefix| word_lower.starts_with(prefix))?;

        // Extract the amount part after the prefix
        let amount_str = &word_lower[matched_prefix.len()..];

        // Must have only digits after the prefix
        if amount_str.is_empty() || !amount_str.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }

        let bits: u32 = amount_str.parse().ok()?;

        // Must have at least 1 bit
        if bits == 0 {
            return None;
        }

        // Determine tier and color based on bits amount
        let (tier, color) = match bits {
            10000.. => ("10000", "#ff1f1f"),    // Red
            5000..=9999 => ("5000", "#0099fe"), // Blue
            1000..=4999 => ("1000", "#1db2a6"), // Teal
            100..=999 => ("100", "#9c3ee8"),    // Purple
            _ => ("1", "#979797"),              // Gray
        };

        // Construct the animated GIF URL using Twitch CDN pattern
        let cheermote_url = format!(
            "https://d3aqoihi2n8ty8.cloudfront.net/actions/{}/dark/animated/{}/2.gif",
            matched_prefix, tier
        );

        Some((
            matched_prefix.to_string(),
            bits,
            tier.to_string(),
            color.to_string(),
            cheermote_url,
        ))
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
            let mut result_msg = "".to_string();

            // Support both standard IRC format " :" and optimized IVR format (space after channel)
            if let Some(colon) = rest.find(" :") {
                result_msg = rest[colon + 2..].trim_end().to_string();
            } else if let Some(space_idx) = rest.find(" #") {
                let after_hash = &rest[space_idx + 1..];
                if let Some(payload_start) = after_hash.find(' ') {
                    result_msg = after_hash[payload_start + 1..].trim_end().to_string();
                }
            }

            let mut msg = result_msg;
            // Check for ACTION wrapper: \x01ACTION message\x01
            // Minimum valid: "\x01ACTION X\x01" = 10 chars (8 for header + 1 content + 1 closing)
            if msg.len() >= 10 && msg.starts_with("\x01ACTION ") && msg.ends_with('\x01') {
                is_action = true;
                msg = msg[8..msg.len() - 1].to_string();
            }
            msg
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
                                // url: https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/3.0
                                let url = format!(
                                    "https://static-cdn.jtvnw.net/emoticons/v2/{}/default/dark/3.0",
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

        // Parse reply info FIRST (needed to strip @mention before segment parsing)
        let reply_parent_user_login = tag_map
            .get("reply-parent-user-login")
            .map(|s| s.to_string());
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
                parent_user_login: reply_parent_user_login.clone().unwrap_or_default(),
            });

        // Strip redundant @mention from reply messages BEFORE parsing segments
        // The UI shows reply context, so the leading @username is redundant
        let content_for_segments = if let Some(ref login) = reply_parent_user_login {
            // Case-insensitive regex to strip "@username " from the start
            let pattern = format!(r"(?i)^@{}\s*", regex::escape(login));
            if let Ok(re) = regex::Regex::new(&pattern) {
                re.replace(&content, "").trim().to_string()
            } else {
                content.clone()
            }
        } else {
            content.clone()
        };

        // Also update emote positions if we stripped the @mention
        let emotes_adjusted = if content_for_segments.len() < content.len() {
            let offset = content.len() - content_for_segments.len();
            emotes
                .into_iter()
                .filter_map(|mut e| {
                    // Skip emotes that were in the stripped portion
                    if e.start < offset {
                        return None;
                    }
                    e.start -= offset;
                    e.end -= offset;
                    Some(e)
                })
                .collect()
        } else {
            emotes
        };

        // Extract the channel this PRIVMSG was sent to so segment parsing uses
        // the right per-channel emote set. Falls back to empty string if the
        // line is malformed (third-party emotes simply won't match).
        let privmsg_channel = extract_channel_from_irc_line(raw).unwrap_or_default();

        // Parse message content into segments (using stripped content)
        let segments = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(Self::parse_message_segments(
                &content_for_segments,
                &emotes_adjusted,
                &privmsg_channel,
            ))
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

        // Extract channel
        let channel = if let Some(idx) = raw.find(" PRIVMSG #") {
            let rest = &raw[idx + 10..];
            if let Some(space_idx) = rest.find(' ') {
                rest[..space_idx].to_string()
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        Some(ChatMessage {
            id,
            user_id,
            username,
            display_name,
            color,
            badges,
            timestamp,
            content: content_for_segments,
            channel,
            emotes: emotes_adjusted,
            tags: tags_owned,
            layout: LayoutResult {
                height: 0.0,
                width: 0.0,
                has_reply: metadata.reply_info.is_some(),
                is_first_message: metadata.is_first_message,
            },
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
            // Support both standard IRC format " :" and optimized IVR format (space after channel)
            if let Some(colon) = rest.find(" :") {
                rest[colon + 2..].trim_end().to_string()
            } else if let Some(space_idx) = rest.find(" #") {
                let after_hash = &rest[space_idx + 1..];
                if let Some(payload_start) = after_hash.find(' ') {
                    after_hash[payload_start + 1..].trim_end().to_string()
                } else {
                    "".to_string()
                }
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
                                    "https://static-cdn.jtvnw.net/emoticons/v2/{}/default/dark/3.0",
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

        // Extract channel from the USERNOTICE line so segment parsing uses the
        // correct per-channel emote set.
        let usernotice_channel = extract_channel_from_irc_line(raw).unwrap_or_default();

        // Parse message content into segments (if there's user content)
        let segments = if !content.is_empty() {
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(Self::parse_message_segments(
                    &content,
                    &emotes,
                    &usernotice_channel,
                ))
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

        // Extract channel
        let channel = if let Some(idx) = raw.find(" USERNOTICE #") {
            let rest = &raw[idx + 13..];
            if let Some(space_idx) = rest.find(' ') {
                rest[..space_idx].to_string()
            } else if let Some(colon_idx) = rest.find(" :") {
                rest[..colon_idx].to_string()
            } else {
                rest.trim().to_string()
            }
        } else {
            String::new()
        };

        Some(ChatMessage {
            id,
            user_id,
            username,
            display_name,
            color,
            badges,
            timestamp,
            content,
            channel,
            emotes,
            tags: tags_owned,
            layout: LayoutResult {
                height: 0.0,
                width: 0.0,
                has_reply: false,
                is_first_message: false,
            },
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

    /// Parse multiple IRC messages (historical messages from IVR API)
    /// Layout height is set to 0.0 - the browser handles all layout via CSS content-visibility
    pub async fn parse_historical_messages(raw_messages: Vec<String>) -> Vec<ChatMessage> {
        let mut results = Vec::with_capacity(raw_messages.len());

        for raw in raw_messages {
            if let Some(mut chat_msg) = Self::parse_privmsg(&raw) {
                // Layout is handled by browser - just use placeholder values
                chat_msg.layout = LayoutResult {
                    height: 0.0,
                    width: 0.0,
                    has_reply: false,
                    is_first_message: false,
                };

                results.push(chat_msg);
            }
        }

        results
    }

    pub async fn stop() -> Result<()> {
        debug!("[IRC Chat] Stopping chat service");

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

        // Clear all per-channel caches
        get_channel_emotes().lock().await.clear();
        get_user_badges_cache().lock().await.clear();
        get_room_state_cache().lock().await.clear();
        get_channel_refcount().lock().await.clear();

        // Drop all 7TV EventAPI subscriptions so the idle socket stops
        // receiving updates for channels nobody is viewing anymore.
        crate::services::seventv_eventapi::clear_all().await;
        // Same for the moderator-view subscriptions.
        crate::services::eventsub_moderation::clear_all().await;

        // Drop the WS port marker so the next start_chat does a full cold
        // bring-up rather than thinking a stale port is still serving.
        *get_ws_port().lock().await = None;

        debug!("[IRC Chat] Chat service stopped");

        Ok(())
    }
}
