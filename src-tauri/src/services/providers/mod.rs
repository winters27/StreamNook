//! Multi-platform chat + activity providers.
//!
//! Each platform is an adapter that normalises into the shared `ChatMessage` /
//! `ActivityEvent` model and publishes onto the same local-WS broadcast the
//! frontend already consumes. This module owns the cross-cutting pieces: the
//! source-key codec, and (added per phase) the provider trait + registry +
//! generic chat webview. Twitch keeps its own dedicated path in `irc_service`.

pub mod key;
pub mod kick;
pub mod kick_emotes;
pub mod tiktok;
pub mod youtube;

use crate::models::chat_layout::ChatMessage;
use crate::services::irc_service::IrcService;
use anyhow::Result;
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::OnceCell;

/// Count of active non-Twitch provider connections on the shared local-WS
/// bridge. While > 0, the Twitch start path preserves the bridge instead of
/// tearing it down (see `IrcService::start`). It is zero in a Twitch-only
/// session, so that path is byte-identical when no providers are in use.
static BRIDGE_USERS: AtomicUsize = AtomicUsize::new(0);

pub fn has_active_bridge_users() -> bool {
    BRIDGE_USERS.load(Ordering::SeqCst) > 0
}

pub(crate) fn inc_bridge_users() {
    BRIDGE_USERS.fetch_add(1, Ordering::SeqCst);
}

pub(crate) fn dec_bridge_users() {
    // Saturating: never wrap below zero if a disconnect races a failed connect.
    let _ = BRIDGE_USERS.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
        Some(n.saturating_sub(1))
    });
}

/// The app handle, stored at startup so providers can spawn the hidden webviews
/// some platforms need (e.g. Kick's Cloudflare-gated channel lookup).
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn set_app_handle(handle: tauri::AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

pub fn app_handle() -> Option<tauri::AppHandle> {
    APP_HANDLE.get().cloned()
}

/// Whether the active connection can send to a source right now. Drives the
/// chat input's read-only vs sendable state on the frontend.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SendCapability {
    /// Reading only; no send path on this platform (or in this build).
    ReadOnly,
    /// A connected account / session can send here.
    Sendable,
    /// Sending is possible but the user must connect / sign in first.
    NeedsLogin,
}

/// Result of a provider send, mirroring the Twitch `SendResult` shape so the
/// frontend can treat both the same way.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SendOutcome {
    pub message_id: Option<String>,
    pub is_sent: bool,
    pub drop_reason: Option<String>,
}

/// A non-Twitch chat platform adapter. Each implementation connects to the
/// platform, normalizes incoming chat into the shared `ChatMessage`, and
/// publishes it onto the same local-WS bus the frontend already consumes via
/// `publish_chat_message`. Twitch keeps its dedicated path in `irc_service`.
#[async_trait]
pub trait ChatProvider: Send + Sync {
    /// Stable provider id ("kick", "youtube", ...). Matches ProviderId on the frontend.
    fn id(&self) -> &'static str;
    /// Begin streaming `channel`'s chat for `window` (a consumer label).
    async fn connect(&self, channel: &str, window: &str) -> Result<()>;
    /// Drop `window`'s claim; disconnect when the last consumer leaves.
    async fn disconnect(&self, channel: &str, window: &str) -> Result<()>;
    /// Send `text` to `channel` as the connected account, if any. `reply_to` is the
    /// platform message id being replied to (None for a normal message).
    async fn send(&self, channel: &str, text: &str, reply_to: Option<&str>)
        -> Result<SendOutcome>;
    /// Whether sending to `channel` is currently possible.
    async fn send_capability(&self, channel: &str) -> SendCapability;
}

/// Registry of available platform adapters, keyed by provider id.
#[derive(Default)]
pub struct ProviderRegistry {
    providers: HashMap<&'static str, Arc<dyn ChatProvider>>,
}

impl ProviderRegistry {
    pub fn register(&mut self, provider: Arc<dyn ChatProvider>) {
        self.providers.insert(provider.id(), provider);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn ChatProvider>> {
        self.providers.get(id).cloned()
    }
}

static REGISTRY: OnceCell<ProviderRegistry> = OnceCell::const_new();

/// The process-wide adapter registry, built once. Per-platform adapters are
/// added here as each ships (Kick first); until then it is empty and the
/// provider commands report the provider as unavailable.
pub async fn registry() -> &'static ProviderRegistry {
    REGISTRY
        .get_or_init(|| async {
            let mut reg = ProviderRegistry::default();
            reg.register(Arc::new(kick::KickProvider::new()));
            reg.register(Arc::new(youtube::YouTubeProvider::new()));
            reg.register(Arc::new(tiktok::TikTokProvider::new()));
            reg
        })
        .await
}

/// Serialize a normalized chat message and publish it onto the local-WS bus the
/// frontend already listens to. The bridge is brought up on demand so an adapter
/// can publish whether or not a Twitch chat is open.
pub async fn publish_chat_message(msg: &ChatMessage) {
    if let Ok(json) = serde_json::to_string(msg) {
        if let Some(tx) = IrcService::broadcaster().await {
            let _ = tx.send(json);
        }
    }
}

/// Publish a pre-built JSON control frame (e.g. a `CLEARCHAT`/`CLEARMSG`
/// moderation frame) onto the same bus. The frontend already routes these by
/// their `channel` field, so a provider can drive the existing deletion display
/// + mod log by emitting the same frame shape Twitch's IRC path does.
pub async fn publish_frame(json: String) {
    if let Some(tx) = IrcService::broadcaster().await {
        let _ = tx.send(json);
    }
}
