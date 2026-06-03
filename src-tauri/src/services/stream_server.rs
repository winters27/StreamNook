use crate::services::twitch_auth_service::TwitchAuthService;
use anyhow::Result;
use log::{debug, error, info};
use once_cell::sync::Lazy;
use rand::Rng;
use reqwest::Client;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::Mutex;
use warp::Filter;

pub struct StreamServer;

static SERVER_HANDLE: Lazy<Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));
static PROXY_URL: Lazy<Arc<Mutex<Option<String>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));
static CURRENT_PORT: Lazy<Arc<Mutex<Option<u16>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));

/// Global HTTP client with optimized connection pooling
static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .tcp_keepalive(std::time::Duration::from_secs(15))
        .pool_idle_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .expect("Failed to build global HTTP client")
});

// Live ad-detection state for the solo stream. The marker logic is shared with
// MultiNook via `ad_detect` (single source of truth). The player re-polls the
// media playlist through this server every few seconds, so scanning those bytes
// is free (no extra requests) and closes the "trust the proxy blindly" gap.
pub use crate::services::ad_detect::AdDetectionState;

static AD_STATE: Lazy<std::sync::Mutex<AdDetectionState>> =
    Lazy::new(|| std::sync::Mutex::new(AdDetectionState::default()));

/// Snapshot the current ad-detection state (for the Tauri command / the pivot).
pub fn ad_state() -> AdDetectionState {
    AD_STATE.lock().unwrap().clone()
}

fn reset_ad_state() {
    *AD_STATE.lock().unwrap() = AdDetectionState::default();
}

/// Fold a relayed media playlist into the solo stream's ad-detection state. We
/// need our own scan because StreamNook resolves with `--stream-url`, so
/// Streamlink's plugin never filters segments on the live stream — this relay
/// is the only watcher.
fn detect_ads_in_playlist(playlist: &str) {
    let mut st = AD_STATE.lock().unwrap();
    if let Some(n) = crate::services::ad_detect::update(&mut st, playlist) {
        info!(
            "[StreamServer] ad markers detected in live playlist (break #{}): {:?}",
            n, st.matched_markers
        );
    }
}

// ----- Auto-pivot: escape a leaked ad on a proxied stream -----
//
// When the in-band detector sees a leaked ad persist on a proxied (non-entitled)
// stream, re-resolve the same channel/quality through a DIFFERENT proxy region,
// hot-swap the relay's upstream, and nudge the player to reload onto the clean
// source. Guardrails (from the ad architecture): fire only on a debounced
// confirmed ad, with a cooldown so a slow connection can't be thrashed. Only the
// proxy path can pivot — entitled (Turbo/sub) and direct streams never arm it.

const PIVOT_DEBOUNCE_POLLS: u32 = 2;
const PIVOT_COOLDOWN: Duration = Duration::from_secs(30);

/// Everything needed to re-resolve the currently-playing proxied stream.
struct ActiveStream {
    channel: String,
    quality: String,
    configured_bases: Vec<String>,
    current_base: Option<String>,
    tried_bases: Vec<String>,
    twitch_auth: TwitchAuthService,
    last_pivot: Option<Instant>,
    pivoting: bool,
}

static ACTIVE: Lazy<std::sync::Mutex<Option<ActiveStream>>> =
    Lazy::new(|| std::sync::Mutex::new(None));
static APP_HANDLE: once_cell::sync::OnceCell<tauri::AppHandle> = once_cell::sync::OnceCell::new();
/// Consecutive polls where inline filtering couldn't yield a playable (real)
/// segment — i.e. the region is serving an all-ad window. Drives the pivot.
static PIVOT_EMPTY_POLLS: AtomicU32 = AtomicU32::new(0);

/// Store the app handle so the pivot task can emit the `ad-pivot` reload event.
pub fn set_app_handle(handle: tauri::AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

/// Arm the pivot for a proxied solo stream. Call ONLY for `mode == "proxy"`;
/// entitled/direct streams are already ad-free and must not pivot.
pub fn set_active_stream(
    channel: String,
    quality: String,
    configured_bases: Vec<String>,
    current_base: Option<String>,
    twitch_auth: TwitchAuthService,
) {
    *ACTIVE.lock().unwrap() = Some(ActiveStream {
        channel,
        quality,
        configured_bases,
        current_base,
        tried_bases: Vec::new(),
        twitch_auth,
        last_pivot: None,
        pivoting: false,
    });
    PIVOT_EMPTY_POLLS.store(0, Ordering::Relaxed);
}

/// Disarm the pivot (stream stop, or a non-proxy / entitled start).
pub fn clear_active_stream() {
    *ACTIVE.lock().unwrap() = None;
    PIVOT_EMPTY_POLLS.store(0, Ordering::Relaxed);
}

/// Reset the in-flight flag and start a cooldown (used after a failed pivot so
/// we don't hammer re-resolution while ads keep leaking).
fn end_pivot_with_cooldown() {
    if let Some(a) = ACTIVE.lock().unwrap().as_mut() {
        a.pivoting = false;
        a.last_pivot = Some(Instant::now());
    }
    PIVOT_EMPTY_POLLS.store(0, Ordering::Relaxed);
}

/// Called after each playlist relay. Inline filtering removes leaked ads
/// seamlessly; the pivot is the escalation for the rare case filtering can't
/// help — a region serving an all-ad window (no real segment survives the
/// filter). When that persists past the debounce and we're not cooling down,
/// re-resolve through a clean region. Best-effort and non-blocking.
fn maybe_trigger_pivot(filtering_insufficient: bool) {
    if !filtering_insufficient {
        PIVOT_EMPTY_POLLS.store(0, Ordering::Relaxed);
        return;
    }
    if PIVOT_EMPTY_POLLS.fetch_add(1, Ordering::Relaxed) + 1 < PIVOT_DEBOUNCE_POLLS {
        return;
    }
    let go = {
        let mut guard = ACTIVE.lock().unwrap();
        match guard.as_mut() {
            Some(a)
                if !a.pivoting && a.last_pivot.is_none_or(|t| t.elapsed() >= PIVOT_COOLDOWN) =>
            {
                a.pivoting = true;
                true
            }
            _ => false,
        }
    };
    if go {
        tokio::spawn(async { do_pivot().await });
    }
}

async fn do_pivot() {
    // Gather re-resolve context and mark the leaking base as tried so the race
    // prefers a different region.
    let (channel, quality, bases, twitch_auth) = {
        let mut guard = ACTIVE.lock().unwrap();
        let a = match guard.as_mut() {
            Some(a) => a,
            None => return,
        };
        if let Some(cur) = a.current_base.clone() {
            if !a.tried_bases.contains(&cur) {
                a.tried_bases.push(cur);
            }
        }
        let clean: Vec<String> = a
            .configured_bases
            .iter()
            .filter(|b| !a.tried_bases.contains(b))
            .cloned()
            .collect();
        let bases = if clean.is_empty() {
            a.configured_bases.clone() // exhausted — let the race/fallback try anything
        } else {
            clean
        };
        (
            a.channel.clone(),
            a.quality.clone(),
            bases,
            a.twitch_auth.clone(),
        )
    };

    let oauth = twitch_auth.get_token().await.ok();
    let result = crate::services::twitch_resolver::resolve_live(
        &channel,
        oauth.as_deref(),
        &bases,
        true,
        &quality,
    )
    .await;

    match result {
        Ok(r) => match StreamServer::start_proxy_server(r.url).await {
            Ok(port) => {
                crate::services::auth_proxy::set_status(r.status.clone());
                {
                    let mut guard = ACTIVE.lock().unwrap();
                    if let Some(a) = guard.as_mut() {
                        a.current_base = r.status.proxy_base.clone();
                        a.last_pivot = Some(Instant::now());
                        a.pivoting = false;
                    }
                }
                PIVOT_EMPTY_POLLS.store(0, Ordering::Relaxed);
                if let Some(app) = APP_HANDLE.get() {
                    let url = format!(
                        "http://localhost:{}/stream.m3u8?t={}",
                        port,
                        chrono::Utc::now().timestamp_millis()
                    );
                    let _ = app.emit(
                        "ad-pivot",
                        serde_json::json!({
                            "url": url,
                            "region": r.status.proxy_region,
                            "channel": channel,
                        }),
                    );
                }
                info!(
                    "[AdPivot] {} re-resolved through region {:?} after a leaked ad",
                    channel, r.status.proxy_region
                );
            }
            Err(e) => {
                error!("[AdPivot] {} hot-swap failed: {}", channel, e);
                end_pivot_with_cooldown();
            }
        },
        Err(e) => {
            error!("[AdPivot] {} re-resolve failed: {}", channel, e);
            end_pivot_with_cooldown();
        }
    }
}

impl StreamServer {
    pub async fn start_proxy_server(stream_url: String) -> Result<u16> {
        // Check if server is already running
        let server_exists = SERVER_HANDLE.lock().await.is_some();

        if server_exists {
            // Server already running - just update the URL
            *PROXY_URL.lock().await = Some(stream_url);
            // New stream on the existing server: clear stale ad-detection state.
            reset_ad_state();
            // Return the existing port by parsing it from a static variable
            return Self::get_current_port().await;
        }

        // Start new server
        let port = rand::rng().random_range(10000..20000);

        *PROXY_URL.lock().await = Some(stream_url);
        reset_ad_state();

        // Store the port
        *CURRENT_PORT.lock().await = Some(port);

        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let proxy_url_clone = PROXY_URL.clone();

        // Use a wildcard proxy that catches ALL paths so relative chunks are automatically mapped
        let proxy = warp::path::full()
            .and(warp::method())
            .and(warp::any().map(move || proxy_url_clone.clone()))
            .and_then(Self::dynamic_proxy_handler)
            .boxed();

        let handle = tokio::spawn(async move {
            warp::serve(proxy).run(addr).await;
        });

        *SERVER_HANDLE.lock().await = Some(handle);

        Ok(port)
    }

    async fn dynamic_proxy_handler(
        path: warp::path::FullPath,
        method: warp::http::Method,
        proxy_url: Arc<Mutex<Option<String>>>,
    ) -> Result<warp::http::Response<Vec<u8>>, warp::Rejection> {
        let manifest_url = proxy_url
            .lock()
            .await
            .clone()
            .ok_or_else(|| warp::reject::not_found())?;

        // Handle CORS Preflight INSTANTLY without hitting Twitch
        if method == warp::http::Method::OPTIONS {
            return Ok(warp::http::Response::builder()
                .status(200)
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Methods", "GET, OPTIONS")
                .header("Access-Control-Allow-Headers", "*")
                .header("Access-Control-Max-Age", "86400")
                .body(vec![])
                .unwrap());
        }

        let request_path = path.as_str().trim_start_matches('/');

        // Map the local path to the upstream Twitch CDN
        let fetch_url = if request_path == "stream.m3u8" || request_path.is_empty() {
            manifest_url.clone()
        } else {
            // Extract query parameters from manifest_url (vital for Twitch auth on variant playlists!)
            let (url_without_query, query) = if let Some(q_idx) = manifest_url.find('?') {
                (&manifest_url[..q_idx], &manifest_url[q_idx..])
            } else {
                (manifest_url.as_str(), "")
            };

            // It's a chunk or variant request. Join with base URL of manifest_url (without query)
            let base_url = if let Some(last_slash) = url_without_query.rfind('/') {
                &url_without_query[..=last_slash]
            } else {
                url_without_query
            };
            format!("{}{}{}", base_url, request_path, query)
        };

        let response = match HTTP_CLIENT.get(&fetch_url).send().await {
            Ok(res) => res,
            Err(e) => {
                error!("[StreamServer] Upstream request failed: {}", e);
                return Ok(warp::http::Response::builder()
                    .status(502)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(vec![])
                    .unwrap());
            }
        };

        let status = response.status();
        let mut bytes = match response.bytes().await {
            Ok(b) => b.to_vec(),
            Err(e) => {
                error!("[StreamServer] Failed to read body bytes: {}", e);
                return Ok(warp::http::Response::builder()
                    .status(502)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(vec![])
                    .unwrap());
            }
        };

        // Ad handling on playlists (never on .ts payloads). These bytes are
        // already in hand, and the live media playlist is re-fetched on every
        // live-edge poll, so this is free. Two steps:
        //   1) detect — record markers for the UI counter / diagnostics;
        //   2) filter — strip leaked ad segments before the player sees them
        //      (the native port of the plugin's `should_filter_segment`), so a
        //      proxy leak is removed seamlessly with no reload.
        // The pivot is the escalation only when filtering yields no real segment
        // (an all-ad window); it never fires while filtering is coping.
        if !request_path.ends_with(".ts") {
            if let Ok(text) = std::str::from_utf8(&bytes) {
                detect_ads_in_playlist(text);
                let (filtered, dropped, real) =
                    crate::services::ad_detect::filter_ad_segments(text);
                if dropped > 0 {
                    debug!(
                        "[StreamServer] stripped {} ad segment(s); {} real remain",
                        dropped, real
                    );
                    bytes = filtered.into_bytes();
                }
                maybe_trigger_pivot(dropped > 0 && real == 0);
            }
        }

        // Determine content-type (chunks are video/MP2T, playlists are x-mpegURL)
        let content_type = if request_path.ends_with(".ts") {
            "video/MP2T"
        } else {
            "application/x-mpegURL"
        };

        Ok(warp::http::Response::builder()
            .status(status)
            .header("Content-Type", content_type)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, OPTIONS")
            .header("Access-Control-Allow-Headers", "*")
            .header(
                "Cache-Control",
                "no-cache, no-store, must-revalidate, max-age=0",
            )
            .header("Pragma", "no-cache")
            .header("Expires", "0")
            .body(bytes) // Return perfectly preserved source bytes!
            .unwrap())
    }

    async fn proxy_handler() -> Result<warp::http::Response<Vec<u8>>, warp::Rejection> {
        let url = PROXY_URL
            .lock()
            .await
            .clone()
            .ok_or_else(|| warp::reject::not_found())?;

        let response = match HTTP_CLIENT.get(&url).send().await {
            Ok(res) => res,
            Err(e) => {
                error!("[StreamServer] Upstream request failed: {}", e);
                return Ok(warp::http::Response::builder()
                    .status(502)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(vec![])
                    .unwrap());
            }
        };

        let status = response.status();
        let bytes = match response.bytes().await {
            Ok(b) => b.to_vec(),
            Err(e) => {
                error!("[StreamServer] Failed to read body bytes: {}", e);
                return Ok(warp::http::Response::builder()
                    .status(502)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(vec![])
                    .unwrap());
            }
        };

        let mut rewritten_bytes = bytes.clone();

        // Rewrite relative URLs to absolute URLs for VOD/Clip M3U8 manifests
        if let Ok(m3u8_str) = String::from_utf8(bytes) {
            if m3u8_str.starts_with("#EXTM3U") {
                let base_url = if let Some(last_slash) = url.rfind('/') {
                    &url[..=last_slash]
                } else {
                    &url
                };

                let mut new_m3u8 = String::with_capacity(m3u8_str.len() + 1024);
                for line in m3u8_str.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        new_m3u8.push('\n');
                        continue;
                    }
                    if trimmed.starts_with('#')
                        || trimmed.starts_with("http://")
                        || trimmed.starts_with("https://")
                    {
                        new_m3u8.push_str(line);
                        new_m3u8.push('\n');
                    } else {
                        new_m3u8.push_str(base_url);
                        new_m3u8.push_str(trimmed);
                        new_m3u8.push('\n');
                    }
                }
                rewritten_bytes = new_m3u8.into_bytes();
            }
        }

        Ok(warp::http::Response::builder()
            .status(status)
            .header("Content-Type", "application/x-mpegURL")
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, OPTIONS")
            .header(
                "Cache-Control",
                "no-cache, no-store, must-revalidate, max-age=0",
            )
            .header("Pragma", "no-cache")
            .header("Expires", "0")
            .body(rewritten_bytes)
            .unwrap())
    }

    pub async fn stop() -> Result<()> {
        if let Some(handle) = SERVER_HANDLE.lock().await.take() {
            handle.abort();
        }
        *PROXY_URL.lock().await = None;
        *CURRENT_PORT.lock().await = None;
        reset_ad_state();
        clear_active_stream();
        Ok(())
    }

    async fn get_current_port() -> Result<u16> {
        CURRENT_PORT
            .lock()
            .await
            .ok_or_else(|| anyhow::anyhow!("No server running"))
    }
}
