//! # piratetok-live-rs
//!
//! Connect to any TikTok Live stream and receive real-time events:
//! chat messages, gifts, likes, joins, viewer counts, and more.
//!
//! ## Quick start
//!
//! ```no_run
//! use piratetok_live_rs::TikTokLive;
//! use piratetok_live_rs::structs::TikTokLiveEvent;
//!
//! #[tokio::main]
//! async fn main() {
//!     let mut stream = TikTokLive::builder("some_username")
//!         .connect()
//!         .await
//!         .unwrap();
//!
//!     while let Some(event) = stream.next_event().await {
//!         match event {
//!             TikTokLiveEvent::Chat(msg) => {
//!                 println!("chat: {}", msg.comment);
//!             }
//!             TikTokLiveEvent::Disconnected => break,
//!             _ => {}
//!         }
//!     }
//! }
//! ```
//!
//! ## How it works
//!
//! 1. Resolves the TikTok username to a room ID
//! 2. Acquires a ttwid cookie (anonymous GET to tiktok.com)
//! 3. Opens a WebSocket connection and streams protobuf-encoded events
//!
//! No signing server, no x_bogus, no msToken. Just ttwid.
//!
//! ## Room info (optional)
//!
//! Room metadata (title, viewer counts, stream URLs) is a separate call:
//!
//! ```no_run
//! use piratetok_live_rs::http::api::{fetch_room_info, FetchParams};
//!
//! # async fn example() {
//! let info = fetch_room_info("ROOM_ID", FetchParams::default()).await;
//! # }
//! ```
//!
//! For 18+ rooms, pass session cookies:
//!
//! ```no_run
//! # use piratetok_live_rs::http::api::{fetch_room_info, FetchParams};
//! # async fn example() {
//! let info = fetch_room_info("ROOM_ID", FetchParams {
//!     cookies: Some("sessionid=abc; sid_tt=abc"), ..Default::default()
//! }).await;
//! # }
//! ```

pub mod decode;
pub mod errors;
pub mod helpers;
pub mod http;
pub mod structs;
pub mod websocket;

use std::time::Duration;

use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::info;

use crate::errors::TikTokLiveError;
use crate::http::api::{fetch_room_id, FetchParams};
use crate::http::ttwid::fetch_ttwid;
use crate::http::ua::{random_ua, system_timezone};
use crate::structs::config::{CdnEndpoint, TikTokLiveConfig};
use crate::structs::TikTokLiveEvent;
use crate::websocket::connection::run_websocket;

/// Entry point for connecting to TikTok Live streams.
///
/// This struct only provides the [`builder`](TikTokLive::builder) method.
/// All configuration happens on [`TikTokLiveBuilder`].
pub struct TikTokLive;

impl TikTokLive {
    /// Create a new connection builder for the given TikTok username.
    ///
    /// The username can be with or without the `@` prefix — both work.
    pub fn builder(username: &str) -> TikTokLiveBuilder {
        TikTokLiveBuilder { config: TikTokLiveConfig::new(username) }
    }
}

/// Builder for configuring a TikTok Live connection.
///
/// Created via [`TikTokLive::builder`]. Chain configuration methods,
/// then call [`connect`](TikTokLiveBuilder::connect) to start streaming.
pub struct TikTokLiveBuilder {
    config: TikTokLiveConfig,
}

impl TikTokLiveBuilder {
    /// Set the CDN endpoint. Defaults to Global.
    pub fn cdn(mut self, cdn: CdnEndpoint) -> Self {
        self.config.cdn = cdn;
        self
    }

    /// Set the HTTP request timeout. Defaults to 10 seconds.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.config.timeout = timeout;
        self
    }

    /// Set the WebSocket heartbeat interval. Defaults to 10 seconds.
    pub fn heartbeat_interval(mut self, interval: Duration) -> Self {
        self.config.heartbeat_interval = interval;
        self
    }

    /// Set max reconnection attempts. Defaults to 5. Set to 0 to disable.
    pub fn max_retries(mut self, n: u32) -> Self {
        self.config.max_retries = n;
        self
    }

    /// Set stale connection timeout. Defaults to 60s. If no data arrives
    /// for this duration, the connection is closed and reconnect is attempted.
    pub fn stale_timeout(mut self, timeout: Duration) -> Self {
        self.config.stale_timeout = timeout;
        self
    }

    /// Set proxy URL for all connections (HTTP + WSS).
    /// Accepts HTTP/HTTPS/SOCKS5 URLs.
    pub fn proxy(mut self, url: impl Into<String>) -> Self {
        self.config.proxy = Some(url.into());
        self
    }

    /// Override the user agent for all requests (HTTP + WSS).
    ///
    /// When not set, a random UA from the built-in pool is picked on each
    /// reconnect attempt. This is recommended for reducing DEVICE_BLOCKED risk.
    /// Only set this if you have a specific UA you want to use.
    pub fn user_agent(mut self, ua: impl Into<String>) -> Self {
        self.config.user_agent = Some(ua.into());
        self
    }

    /// Set session cookies for the WSS connection.
    ///
    /// These are appended alongside the ttwid cookie. Only needed if you have
    /// a specific reason to pass session cookies to the WebSocket handshake.
    ///
    /// For fetching room info on 18+ rooms, pass cookies directly to
    /// [`fetch_room_info()`](crate::http::api::fetch_room_info) instead.
    pub fn cookies(mut self, cookies: impl Into<String>) -> Self {
        self.config.cookies = Some(cookies.into());
        self
    }

    /// Override language code for API requests and headers.
    /// Auto-detected from system locale, falls back to `"en"`.
    pub fn language(mut self, lang: impl Into<String>) -> Self {
        self.config.language = lang.into();
        self
    }

    /// Override region/country code for API requests.
    /// Auto-detected from system locale, falls back to `"US"`.
    pub fn region(mut self, region: impl Into<String>) -> Self {
        self.config.region = region.into();
        self
    }

    /// Enable or disable gzip compression for WSS frames. Defaults to `true`.
    ///
    /// The decode layer handles both compressed and uncompressed data
    /// regardless of this setting, so toggling it is always safe.
    pub fn compress(mut self, compress: bool) -> Self {
        self.config.compress = compress;
        self
    }

    /// Connect to the live stream with auto-reconnection.
    ///
    /// Resolves the username to a room ID, then enters a reconnect loop
    /// that fetches a fresh ttwid on each attempt. Emits `Reconnecting`
    /// events between attempts and `Disconnected` when done.
    pub async fn connect(self) -> Result<TikTokLiveStream, TikTokLiveError> {
        let config = self.config;

        let ua_for_resolve = config.user_agent.as_deref();
        let proxy_ref = config.proxy.as_deref();
        info!("fetching room id for {}", config.username);
        let room_id_resp = fetch_room_id(&config.username, FetchParams {
            timeout: config.timeout,
            user_agent: ua_for_resolve,
            proxy: proxy_ref,
            language: Some(&config.language),
            region: Some(&config.region),
            ..Default::default()
        }).await?;
        let room_id = room_id_resp.room_id;

        let (tx, rx) = mpsc::channel(256);

        tx.send(TikTokLiveEvent::Connected { room_id: room_id.clone() })
            .await
            .map_err(|_| TikTokLiveError::ConnectionClosed)?;

        let handle = tokio::spawn(async move {
            let tz = system_timezone();
            let mut attempt: u32 = 0;
            loop {
                // Pick UA: user override or random from pool (fresh each attempt)
                let ua = config.user_agent.as_deref()
                    .unwrap_or_else(|| random_ua())
                    .to_string();

                let proxy_ref = config.proxy.as_deref();
                let ttwid = match fetch_ttwid(config.timeout, Some(&ua), proxy_ref).await {
                    Ok(t) => t,
                    Err(e) => {
                        tracing::error!("ttwid fetch failed: {e}");
                        break;
                    }
                };

                let ws_url = build_ws_url(config.cdn.host(), &room_id, &tz, &config);
                let ws_cookie = match &config.cookies {
                    Some(extra) => format!("ttwid={ttwid}; {extra}"),
                    None => format!("ttwid={ttwid}"),
                };

                let accept_lang = config.accept_language();
                let err = match run_websocket(
                    &ws_url, &ws_cookie, &ua, &room_id,
                    config.heartbeat_interval, config.stale_timeout, proxy_ref, &accept_lang, tx.clone(),
                ).await {
                    Ok(()) => None,
                    Err(e) => Some(e),
                };

                let is_device_blocked = matches!(&err, Some(TikTokLiveError::DeviceBlocked));
                if let Some(ref e) = err {
                    if is_device_blocked {
                        tracing::warn!("DEVICE_BLOCKED — rotating ttwid + UA");
                    } else {
                        tracing::error!("websocket error: {e}");
                    }
                }

                attempt += 1;
                if attempt > config.max_retries {
                    info!("max retries ({}) exceeded", config.max_retries);
                    break;
                }

                // On DEVICE_BLOCKED: short delay (2s) since we're getting a fresh
                // ttwid + UA anyway. On other errors: exponential backoff.
                let delay = if is_device_blocked {
                    Duration::from_secs(2)
                } else {
                    Duration::from_secs((1u64 << attempt).min(30))
                };

                let _ = tx.send(TikTokLiveEvent::Reconnecting {
                    attempt,
                    max_retries: config.max_retries,
                    delay_secs: delay.as_secs(),
                }).await;
                info!("reconnecting in {}s (attempt {}/{})", delay.as_secs(), attempt, config.max_retries);
                tokio::time::sleep(delay).await;
            }

            let _ = tx.send(TikTokLiveEvent::Disconnected).await;
        });

        Ok(TikTokLiveStream { rx, _handle: handle })
    }
}

/// A live event stream from a TikTok Live room.
///
/// Call [`next_event`](TikTokLiveStream::next_event) in a loop to receive events.
/// The WebSocket connection is automatically closed when this is dropped.
pub struct TikTokLiveStream {
    rx: mpsc::Receiver<TikTokLiveEvent>,
    _handle: JoinHandle<()>,
}

impl TikTokLiveStream {
    /// Wait for the next event from the live stream.
    ///
    /// Returns `None` when the connection is closed.
    pub async fn next_event(&mut self) -> Option<TikTokLiveEvent> {
        self.rx.recv().await
    }
}

impl Drop for TikTokLiveStream {
    fn drop(&mut self) {
        self._handle.abort();
    }
}

fn build_ws_url(cdn_host: &str, room_id: &str, tz: &str, config: &TikTokLiveConfig) -> String {
    let last_rtt = format!("{:.3}", 100.0 + rand::random::<f64>() * 100.0);
    let browser_lang = config.browser_language();
    let params: &[(&str, &str)] = &[
        ("version_code", "180800"),
        ("device_platform", "web"),
        ("cookie_enabled", "true"),
        ("screen_width", "1920"),
        ("screen_height", "1080"),
        ("browser_language", &browser_lang),
        ("browser_platform", "Linux x86_64"),
        ("browser_name", "Mozilla"),
        ("browser_version", "5.0 (X11)"),
        ("browser_online", "true"),
        ("tz_name", tz),
        ("app_name", "tiktok_web"),
        ("sup_ws_ds_opt", "1"),
        ("update_version_code", "2.0.0"),
        ("compress", if config.compress { "gzip" } else { "" }),
        ("webcast_language", &config.language),
        ("ws_direct", "1"),
        ("aid", "1988"),
        ("live_id", "12"),
        ("app_language", &config.language),
        ("client_enter", "1"),
        ("room_id", room_id),
        ("identity", "audience"),
        ("history_comment_count", "6"),
        ("last_rtt", &last_rtt),
        ("heartbeat_duration", "10000"),
        ("resp_content_type", "protobuf"),
        ("did_rule", "3"),
    ];

    let query: String = params
        .iter()
        .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    format!("wss://{cdn_host}/webcast/im/ws_proxy/ws_reuse_supplement/?{query}")
}
