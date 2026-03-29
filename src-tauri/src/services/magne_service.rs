/**
 * services/magne_service.rs
 *
 * Magne IPC rich presence client.
 * Speaks the same binary framing protocol as Discord RPC (opcode + length + JSON)
 * over \\.\pipe\magne-ipc-0, enabling StreamNook to broadcast watching activity
 * to Magne.
 *
 * Always active — no settings toggle needed. If Magne isn't running,
 * all calls silently no-op. A background reconnect loop polls every 5s
 * so Magne picks up the current activity even if launched after StreamNook.
 *
 */
use anyhow::{Context, Result};
use lazy_static::lazy_static;
use rand::prelude::IndexedRandom;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

// ── Constants ────────────────────────────────────────────────────────

const PIPE_NAME: &str = r"\\.\pipe\magne-ipc-0";
const CLIENT_ID: &str = "streamnook-magne-rpc";
const RECONNECT_INTERVAL_SECS: u64 = 5;

// Opcodes (same as Discord IPC)
const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;

const STREAMNOOK_LOGO_URL: &str =
    "https://raw.githubusercontent.com/winters27/StreamNook/refs/heads/main/src-tauri/icons/icon.ico";
const TWITCH_ICON_URL: &str =
    "https://raw.githubusercontent.com/winters27/StreamNook/refs/heads/main/src-tauri/images/logo_1704751143960.JPG";

const BROWSING_PHRASES: &[&str] = &[
    "Channel Surfing for Poggers",
    "Lost in the Twitch Jungle",
    "Hunting for the next Hype Train",
    "Just Chatting... with myself",
    "AFK, but my eyes are still watching",
    "Searching for the legendary Kappa",
    "Dodging spoilers like a pro gamer",
    "Vibing in the VODs",
    "Exploring the emote-verse",
    "Where's the 'unfollow' button for reality?",
];

const IDLE_PHRASES: &[&str] = &[
    "AFK (Away From Keyboard, but not from Twitch)",
    "Just chilling, waiting for the next stream",
    "Buffering... please wait",
    "In a staring contest with my screen",
    "My brain is in emote-only mode",
    "Currently respawning...",
    "Thinking about what to raid next",
    "Lost in thought, probably about subs",
    "Powered by caffeine and good vibes",
    "Waiting for the next 'clip that!' moment",
];

// ── State ────────────────────────────────────────────────────────────

struct MagneState {
    pipe: Option<std::fs::File>,
    start_time: i64,
    nonce_counter: u64,
    /// Last SET_ACTIVITY payload — replayed on reconnect so Magne picks up
    /// the current activity even if it launches after StreamNook.
    last_payload: Option<serde_json::Value>,
    /// Whether idle presence has been sent at least once (prevents phrase rotation on poll)
    idle_sent: bool,
    /// Last sent details+state key for deduplication (prevents spam on 5s poll)
    last_activity_key: Option<String>,
}

lazy_static! {
    static ref MAGNE_STATE: Arc<Mutex<MagneState>> = Arc::new(Mutex::new(MagneState {
        pipe: None,
        start_time: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64,
        nonce_counter: 0,
        last_payload: None,
        idle_sent: false,
        last_activity_key: None,
    }));
    static ref RECONNECT_STARTED: AtomicBool = AtomicBool::new(false);
}

pub struct MagneService;

// ── Game image resolution ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DiscordApp {
    id: String,
    name: String,
    #[serde(default)]
    icon_hash: Option<String>,
    #[serde(default)]
    cover_image: Option<String>,
}

// ── Wire helpers ─────────────────────────────────────────────────────

/// Encode a frame: [opcode: u32 LE][length: u32 LE][json: utf8]
fn encode_frame(opcode: u32, data: &serde_json::Value) -> Vec<u8> {
    let json_bytes = serde_json::to_vec(data).unwrap_or_default();
    let mut buf = Vec::with_capacity(8 + json_bytes.len());
    buf.extend_from_slice(&opcode.to_le_bytes());
    buf.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(&json_bytes);
    buf
}

/// Read a single frame response (blocking). Returns (opcode, json).
fn read_frame(pipe: &mut std::fs::File) -> Result<(u32, serde_json::Value)> {
    let mut header = [0u8; 8];
    pipe.read_exact(&mut header)
        .context("Failed to read frame header from Magne pipe")?;

    let opcode = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;

    let mut body = vec![0u8; length];
    pipe.read_exact(&mut body)
        .context("Failed to read frame body from Magne pipe")?;

    let data: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));

    Ok((opcode, data))
}

// ── Public API ───────────────────────────────────────────────────────

impl MagneService {
    /// Connect to Magne's IPC pipe and send HANDSHAKE.
    /// Also starts the background reconnect loop (once) so that if Magne
    /// launches later, the current activity is replayed automatically.
    pub async fn connect() -> Result<()> {
        // Start the reconnect loop (idempotent — only spawns once)
        Self::start_reconnect_loop();

        let mut guard = MAGNE_STATE.lock().await;

        // Already connected AND idle was sent — don't re-send (avoids rotating phrases)
        if guard.pipe.is_some() && guard.idle_sent {
            return Ok(());
        }

        // Not connected — try opening
        if guard.pipe.is_none() {
            match Self::open_pipe() {
                Some(pipe) => {
                    guard.pipe = Some(pipe);
                    guard.start_time = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_secs() as i64;
                }
                None => return Ok(()),
            }
        }

        // Send idle (first time or after reconnect)
        guard.idle_sent = true;
        Self::set_idle_internal(&mut guard)
    }

    /// Disconnect from Magne
    pub async fn disconnect() -> Result<()> {
        let mut guard = MAGNE_STATE.lock().await;
        guard.last_payload = None;
        guard.idle_sent = false;
        guard.last_activity_key = None;
        if let Some(mut pipe) = guard.pipe.take() {
            let close = encode_frame(
                OP_CLOSE,
                &json!({ "code": 1000, "message": "Normal closure" }),
            );
            let _ = pipe.write_all(&close);
            let _ = pipe.flush();
        }
        Ok(())
    }

    /// Set idle/browsing presence
    pub async fn set_idle_presence() -> Result<()> {
        let mut guard = MAGNE_STATE.lock().await;
        Self::set_idle_internal(&mut guard)
    }

    fn set_idle_internal(guard: &mut tokio::sync::MutexGuard<'_, MagneState>) -> Result<()> {
        let timestamp = guard.start_time;

        let mut rng = rand::rng();
        let browsing = BROWSING_PHRASES
            .choose(&mut rng)
            .unwrap_or(&"Browsing Twitch");
        let idle = IDLE_PHRASES.choose(&mut rng).unwrap_or(&"Just chilling");

        guard.nonce_counter += 1;
        let nonce = format!("magne-{}", guard.nonce_counter);

        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "nonce": nonce,
            "args": {
                "pid": std::process::id(),
                "activity": {
                    "type": 3,
                    "details": browsing,
                    "state": idle,
                    "timestamps": { "start": timestamp * 1000 },
                    "assets": {
                        "large_image": STREAMNOOK_LOGO_URL,
                        "large_text": "StreamNook",
                        "small_image": STREAMNOOK_LOGO_URL,
                        "small_text": "StreamNook",
                    },
                    "buttons": [{
                        "label": "Download StreamNook",
                        "url": "https://github.com/winters27/StreamNook/",
                    }],
                },
            },
        });

        guard.last_payload = Some(payload.clone());

        if guard.pipe.is_some() {
            let _ = Self::send_frame(guard, &payload);
        }
        Ok(())
    }

    /// Update presence when watching a stream.
    /// Resolves game cover art from Discord's public detectable games API
    /// so Magne gets actual image URLs, not Discord asset keys.
    pub async fn update_presence(
        details: &str,
        state: &str,
        _large_image: &str,
        _small_image: &str,
        _start_time: u64,
        game_name: &str,
        stream_url: &str,
    ) -> Result<()> {
        // Resolve game image outside the lock
        let game_image_url = if !game_name.is_empty() {
            Self::resolve_game_image(game_name).await.ok()
        } else {
            None
        };

        let mut guard = MAGNE_STATE.lock().await;

        // Dedup: skip if pipe is connected and same activity was already sent
        let activity_key = format!("{}|{}|{}", details, state, game_name);
        if guard.pipe.is_some() {
            if let Some(ref last) = guard.last_activity_key {
                if *last == activity_key {
                    return Ok(());
                }
            }
        }

        // Auto-connect if not connected
        if guard.pipe.is_none() {
            if let Some(pipe) = Self::open_pipe() {
                guard.pipe = Some(pipe);
                guard.start_time = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs() as i64;
            }
        }

        let timestamp = guard.start_time;
        guard.nonce_counter += 1;
        let nonce = format!("magne-{}", guard.nonce_counter);

        let (large_img, large_txt) = if let Some(ref url) = game_image_url {
            (url.as_str(), game_name)
        } else {
            (STREAMNOOK_LOGO_URL, "StreamNook")
        };

        let assets = json!({
            "large_image": large_img,
            "large_text": large_txt,
            "small_image": TWITCH_ICON_URL,
            "small_text": "Twitch",
        });

        let mut buttons = vec![];
        if !stream_url.is_empty() {
            buttons.push(json!({ "label": "Watch Stream", "url": stream_url }));
        }
        buttons.push(json!({
            "label": "Download StreamNook",
            "url": "https://github.com/winters27/StreamNook/",
        }));

        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "nonce": nonce,
            "args": {
                "pid": std::process::id(),
                "activity": {
                    "type": 3,
                    "details": details,
                    "state": state,
                    "timestamps": { "start": timestamp * 1000 },
                    "assets": assets,
                    "buttons": buttons,
                },
            },
        });

        // Store for reconnect replay + dedup
        guard.last_payload = Some(payload.clone());
        guard.last_activity_key = Some(activity_key);
        guard.idle_sent = false; // reset so switching back to idle works

        if guard.pipe.is_some() {
            if Self::send_frame(&mut guard, &payload).is_err() {
                guard.pipe = None;
                guard.last_activity_key = None; // clear dedup on failure
                if let Some(pipe) = Self::open_pipe() {
                    guard.pipe = Some(pipe);
                    let _ = Self::send_frame(&mut guard, &payload);
                }
            }
        }

        Ok(())
    }

    /// Clear presence
    pub async fn clear_presence() -> Result<()> {
        let mut guard = MAGNE_STATE.lock().await;
        guard.nonce_counter += 1;
        let nonce = format!("magne-{}", guard.nonce_counter);

        let payload = json!({
            "cmd": "SET_ACTIVITY",
            "nonce": nonce,
            "args": {
                "pid": std::process::id(),
                "activity": null,
            },
        });

        guard.last_payload = Some(payload.clone());
        let _ = Self::send_frame(&mut guard, &payload);
        Ok(())
    }

    // ── Background reconnect loop ───────────────────────────────────

    /// Spawns a background task that polls for Magne's pipe every 5 seconds.
    /// When it reconnects, it replays the last stored payload so Magne
    /// immediately shows the current activity.
    fn start_reconnect_loop() {
        // Only spawn once
        if RECONNECT_STARTED.swap(true, Ordering::SeqCst) {
            return;
        }

        tokio::spawn(async {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(RECONNECT_INTERVAL_SECS)).await;

                let mut guard = MAGNE_STATE.lock().await;

                // Already connected — nothing to do
                if guard.pipe.is_some() {
                    continue;
                }

                // Try connecting
                if let Some(pipe) = Self::open_pipe() {
                    guard.pipe = Some(pipe);
                    guard.start_time = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_secs() as i64;

                    // Replay the last payload so Magne picks up current state
                    if let Some(payload) = guard.last_payload.clone() {
                        let _ = Self::send_frame(&mut guard, &payload);
                    }
                }
            }
        });
    }

    // ── Game image resolution (independent of discord_service) ───────

    /// Resolve game name → Discord CDN cover art URL.
    /// Uses Discord's public detectable games API (no auth needed).
    async fn resolve_game_image(game_name: &str) -> Result<String> {
        let client = reqwest::Client::builder()
            .user_agent("StreamNook/1.0")
            .timeout(std::time::Duration::from_secs(6))
            .build()?;

        let apps: Vec<DiscordApp> = client
            .get("https://discord.com/api/v9/applications/detectable")
            .send()
            .await?
            .json()
            .await?;

        let needle = game_name.trim().to_lowercase();

        // Exact match first, then substring
        let matched = apps
            .iter()
            .find(|a| a.name.trim().to_lowercase() == needle)
            .or_else(|| {
                apps.iter().find(|a| {
                    let n = a.name.trim().to_lowercase();
                    n.contains(&needle) || needle.contains(&n)
                })
            });

        if let Some(app) = matched {
            if let Some(cover) = &app.cover_image {
                return Ok(format!(
                    "https://cdn.discordapp.com/app-assets/{}/{}.png?size=512",
                    app.id, cover
                ));
            }
            if let Some(icon) = &app.icon_hash {
                return Ok(format!(
                    "https://cdn.discordapp.com/app-icons/{}/{}.png?size=512",
                    app.id, icon
                ));
            }
        }

        Err(anyhow::anyhow!("Game image not found"))
    }

    // ── Internal helpers ─────────────────────────────────────────────

    /// Open the named pipe, send HANDSHAKE, read READY.
    fn open_pipe() -> Option<std::fs::File> {
        let mut pipe = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(PIPE_NAME)
            .ok()?;

        let handshake = encode_frame(OP_HANDSHAKE, &json!({ "v": 1, "client_id": CLIENT_ID }));
        pipe.write_all(&handshake).ok()?;
        pipe.flush().ok()?;
        let _ = read_frame(&mut pipe);
        Some(pipe)
    }

    fn send_frame(
        guard: &mut tokio::sync::MutexGuard<'_, MagneState>,
        payload: &serde_json::Value,
    ) -> Result<()> {
        if let Some(pipe) = &mut guard.pipe {
            let frame = encode_frame(OP_FRAME, payload);
            pipe.write_all(&frame)
                .context("Failed to write frame to Magne pipe")?;
            pipe.flush()?;
            Ok(())
        } else {
            Ok(())
        }
    }
}
