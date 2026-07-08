use crate::services::ll_origin::{
    empty_cors, media_response, opt_raw_query, parse_directive, parse_part_path, playlist_response,
};
use anyhow::Result;
use log::{error, info};
use once_cell::sync::Lazy;
use rand::Rng;
use reqwest::Client;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use warp::Filter;

pub struct StreamServer;

static SERVER_HANDLE: Lazy<Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));
static PROXY_URL: Lazy<Arc<Mutex<Option<String>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));
static CURRENT_PORT: Lazy<Arc<Mutex<Option<u16>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));
/// Serializes solo `start_proxy_server` calls end to end. The existence check,
/// `ll_origin::start` (a multi-second backfill await), and the SERVER_HANDLE write
/// are otherwise non-atomic, so two concurrent cold starts (e.g. a fast channel
/// re-trigger) could both see "no server", both bind warp, and both run the shared
/// SOLO origin's start — one silently wiping the other's edge mid-setup. Held for
/// the whole function so the second caller observes a fully-initialized server and
/// takes the reuse path.
static SOLO_START_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

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
    // Tear down the LL-HLS origin (background reader + live edge) for the old stream.
    crate::services::ll_origin::stop();
    // Drop the stable-projection segment map for the old stream so a synthetic
    // `vseg/<sn>.ts` can never resolve to a previous stream's segment.
    crate::services::hls_projection::reset(SOLO_STREAM_ID);
}

/// Fold a relayed media playlist into the solo stream's ad-detection state.
/// Read-only and for the core's own playback only: the relay serves the
/// playlist untouched and only RECORDS whether ad markers are present, which
/// gates the low-latency prefetch promotion (`ads_now`) so it never
/// fast-forwards into an ad. The core never acts on ads beyond that and never
/// reports them to a plugin; a resolution-owning plugin detects ads itself.
fn detect_ads_in_playlist(playlist: &str) {
    let mut st = AD_STATE.lock().unwrap();
    if let Some(n) = crate::services::ad_detect::update(&mut st, playlist) {
        info!(
            "[StreamServer] ad markers detected in live playlist (break #{}): {:?}",
            n, st.matched_markers
        );
    }
}

/// The stream id the solo relay session is addressed by in the plugin
/// protocol (`set_upstream`). MultiNook tiles use their own per-tile ids.
pub const SOLO_STREAM_ID: &str = "solo";

/// The channel the solo relay is currently serving, when it is a live stream
/// (None for VOD/clip playback and when stopped). This is what makes the solo
/// session addressable by plugins.
static SOLO_CHANNEL: Lazy<std::sync::Mutex<Option<String>>> =
    Lazy::new(|| std::sync::Mutex::new(None));
static APP_HANDLE: once_cell::sync::OnceCell<tauri::AppHandle> = once_cell::sync::OnceCell::new();
/// True when the LL-HLS origin is actively serving parts for this stream — what the
/// player keys `lowLatencyMode` on. A real spec LL-HLS playlist (`#EXT-X-PART` +
/// blocking reload) is being served, so hls.js's native low-latency controller has
/// parts to consume. Driven by the experimental-low-latency setting (the origin kill
/// switch); false on the stable whole-segment path.
pub fn is_low_latency() -> bool {
    crate::services::ll_origin::is_active()
}

/// Store the app handle so the relay can emit reload events and reach the
/// plugin host for `on_ad_window` notifications.
pub fn set_app_handle(handle: tauri::AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

/// Record (or clear) the live channel the solo relay serves. Live starts set
/// it; VOD/clip starts and stops clear it.
pub fn set_solo_session(channel: Option<String>) {
    *SOLO_CHANNEL.lock().unwrap() = channel;
}

/// True while the solo relay is serving a live channel (the precondition for
/// a plugin to swap its upstream).
pub fn solo_session_active() -> bool {
    SOLO_CHANNEL.lock().unwrap().is_some()
}

/// Replace the solo relay's upstream playlist with one a resolution-owning
/// plugin supplied via `set_upstream`, and tell the player to reload onto it.
/// This is the mid-stream escalation path (e.g. the plugin re-resolved through
/// a different region after a leaked ad window).
pub async fn swap_upstream(playlist_url: String) -> Result<()> {
    let channel = SOLO_CHANNEL
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| anyhow::anyhow!("no live solo relay session"))?;
    let port = StreamServer::start_proxy_server(playlist_url).await?;
    if let Some(app) = APP_HANDLE.get() {
        let url = format!(
            "http://localhost:{}/stream.m3u8?t={}",
            port,
            chrono::Utc::now().timestamp_millis()
        );
        let _ = app.emit(
            "ad-pivot",
            serde_json::json!({ "url": url, "channel": channel }),
        );
    }
    info!(
        "[StreamServer] {} upstream swapped by a playback plugin",
        channel
    );
    Ok(())
}

impl StreamServer {
    pub async fn start_proxy_server(stream_url: String) -> Result<u16> {
        // The upstream media-playlist URL the LL-HLS origin will poll. `reset_ad_state`
        // (below) stops any prior origin; `ll_origin::start` probes this URL and, if it's
        // a low-latency broadcast, builds the live edge before we return — so the player
        // can read `get_stream_low_latency` and pick the right hls.js mode.
        let upstream = stream_url.clone();

        // A region-relayed upstream (its playlist proxied through our relay for
        // geo-unlock) is inherently higher-latency, and its segments come from a
        // distant CDN. The parts-based low-latency origin's tight per-segment
        // deadlines can't ride that latency and abandon segments (a freeze), so
        // force the stable whole-segment path, which buffers and waits instead.
        let region_relayed = upstream.contains("/quality-media");

        // Serialize the whole start sequence (TOCTOU guard): without this two
        // concurrent cold starts could both spawn a warp server and both run the
        // shared SOLO origin's start, racing each other's edge setup.
        let _init_guard = SOLO_START_LOCK.lock().await;

        // Check if server is already running
        let server_exists = SERVER_HANDLE.lock().await.is_some();

        if server_exists {
            // Server already running - just update the URL
            *PROXY_URL.lock().await = Some(stream_url);
            // New stream on the existing server: clear stale ad-detection state.
            reset_ad_state();
            // Bring up the parts-based LL-HLS origin for the new stream (a no-op unless
            // the experimental setting enabled it and the channel is low-latency).
            // Skipped for a region-relayed upstream (stable buffered path only).
            if region_relayed {
                log::info!("[StreamServer] region-relayed upstream; stable path (LL origin skipped)");
            } else {
                let outcome = crate::services::ll_origin::start(upstream).await;
                log::debug!(
                    "[StreamServer] LL origin start (reuse): active={}",
                    outcome.active
                );
            }
            // Return the existing port by parsing it from a static variable
            return Self::get_current_port().await;
        }

        // Start new server
        let port = rand::rng().random_range(10000..20000);

        *PROXY_URL.lock().await = Some(stream_url);
        reset_ad_state();
        if region_relayed {
            log::info!("[StreamServer] region-relayed upstream; stable path (LL origin skipped)");
        } else {
            let outcome = crate::services::ll_origin::start(upstream).await;
            log::debug!("[StreamServer] LL origin start: active={}", outcome.active);
        }

        // Store the port
        *CURRENT_PORT.lock().await = Some(port);

        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let proxy_url_clone = PROXY_URL.clone();

        // Use a wildcard proxy that catches ALL paths so relative chunks are automatically mapped.
        // The raw query string is captured too, for the LL-HLS blocking-reload directives
        // (`_HLS_msn`/`_HLS_part`).
        let proxy = warp::path::full()
            .and(warp::method())
            .and(opt_raw_query())
            .and(warp::any().map(move || proxy_url_clone.clone()))
            .and_then(Self::dynamic_proxy_handler)
            .boxed();

        // Bind with a deep listen backlog. The relay shares the app's async
        // runtime with the CPU-bound TS->fMP4 transmux, so a transmux burst can
        // briefly keep the acceptor task off a worker thread. With the default
        // (small) backlog the OS then refuses the next connection (an RST, which
        // hls.js reports as ERR_CONNECTION_REFUSED, dropping a part and setting
        // off a fragGap cascade). A deep backlog turns that momentary stall into
        // a sub-second queue wait instead of a hard refusal.
        let socket = tokio::net::TcpSocket::new_v4()?;
        socket.set_reuseaddr(true)?;
        socket.bind(addr)?;
        let listener = socket.listen(1024)?;

        let handle = tokio::spawn(async move {
            warp::serve(proxy).incoming(listener).run().await;
        });

        *SERVER_HANDLE.lock().await = Some(handle);

        Ok(port)
    }

    async fn dynamic_proxy_handler(
        path: warp::path::FullPath,
        method: warp::http::Method,
        raw_query: String,
        proxy_url: Arc<Mutex<Option<String>>>,
    ) -> Result<warp::http::Response<Vec<u8>>, warp::Rejection> {
        // None means stop() already ran. The abort only kills the accept loop;
        // hyper's per-connection tasks survive it, so the player's keep-alive
        // connection can still deliver a final poll. A warp rejection here would
        // answer it with a bare 404 (no CORS headers), which the webview reports
        // as a CORS error. Answer with a CORS'd 404 so the straggler dies quietly.
        // First touch of every request. During famine incidents, playlist
        // requests provably leave hls.js and produce no o_pl for seconds: this
        // either shows them arriving here (blockage in our routing below) or
        // not arriving at all (blockage in the socket/accept layer or the
        // webview's pool) — the last unattributed hop.
        if crate::services::ll_diagnostics::is_active() {
            crate::services::ll_diagnostics::event(&format!(
                "\"ev\":\"o_req\",\"p\":{:?}",
                path.as_str()
            ));
        }
        let Some(manifest_url) = proxy_url.lock().await.clone() else {
            return Ok(empty_cors(404));
        };

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

        // ── LL-HLS origin path (active only on low-latency channels) ──
        // When the origin is live it owns the media playlist, parts, and complete
        // segments (served from memory). This must come before the non-LL stable-URL
        // redirect, which shares the `seg/` prefix.
        if crate::services::ll_origin::is_active() {
            // Origin-generated init segment (TS transmux path).
            if request_path == "init.mp4" {
                if let Some(bytes) = crate::services::ll_origin::get_init() {
                    crate::services::ll_diagnostics::event(&format!(
                        "\"ev\":\"o_init\",\"len\":{}",
                        bytes.len()
                    ));
                    return Ok(media_response(bytes.as_ref().clone()));
                }
                return Ok(empty_cors(404));
            }
            if let Some(rest) = request_path.strip_prefix("part/") {
                if let Some((sn, k)) = parse_part_path(rest) {
                    if let Some(bytes) = crate::services::ll_origin::get_part(sn, k) {
                        let h = if crate::services::ll_diagnostics::is_active() {
                            crate::services::ll_diagnostics::quick_hash(bytes.as_ref())
                        } else {
                            0
                        };
                        crate::services::ll_diagnostics::event(&format!(
                            "\"ev\":\"o_part\",\"sn\":{sn},\"k\":{k},\"len\":{},\"h\":{h}",
                            bytes.len()
                        ));
                        return Ok(media_response(bytes.as_ref().clone()));
                    }
                    crate::services::ll_diagnostics::event(&format!(
                        "\"ev\":\"o_part_miss\",\"sn\":{sn},\"k\":{k}"
                    ));
                }
                return Ok(empty_cors(404));
            }
            if let Some(rest) = request_path.strip_prefix("seg/") {
                if let Some(sn) = rest.strip_suffix(".ts").and_then(|s| s.parse::<u64>().ok()) {
                    if let Some(bytes) = crate::services::ll_origin::get_segment(sn) {
                        // Whole-segment fetch (the suspected A/V-skew trigger): record sn
                        // and size so it correlates with the frontend append burst.
                        crate::services::ll_diagnostics::event(&format!(
                            "\"ev\":\"o_seg\",\"sn\":{sn},\"len\":{}",
                            bytes.len()
                        ));
                        return Ok(media_response(bytes));
                    }
                    crate::services::ll_diagnostics::event(&format!(
                        "\"ev\":\"o_seg_miss\",\"sn\":{sn}"
                    ));
                }
                return Ok(empty_cors(404));
            }
            if request_path == "stream.m3u8" || request_path.is_empty() {
                let msn = parse_directive(&raw_query, "_HLS_msn");
                let part = parse_directive(&raw_query, "_HLS_part");
                // Serve-side timing: hls.js reports levelLoadTimeOut pairs before
                // stalls even though the blocking hold is bounded well under its
                // budget; this measures whether the server ever actually exceeds
                // it, separating origin-side delay from client-side accounting.
                let t0 = std::time::Instant::now();
                if let Some(pl) = crate::services::ll_origin::serve_playlist(msn, part).await {
                    if crate::services::ll_diagnostics::is_active() {
                        crate::services::ll_diagnostics::event(&format!(
                            "\"ev\":\"o_pl\",\"ms\":{},\"msn\":{},\"part\":{}",
                            t0.elapsed().as_millis(),
                            msn.map(|v| v as i64).unwrap_or(-1),
                            part.map(|v| v as i64).unwrap_or(-1)
                        ));
                    }
                    return Ok(playlist_response(pl.into_bytes()));
                }
                // Origin went inactive between the check and now: fall through.
            }
        }

        // Stable whole-segment projection: a synthetic `vseg/<sid>/<sn>.ts` is
        // 302-redirected to the freshest real CDN URL recorded when the playlist
        // was stabilized, so the player-visible path never changes even as Twitch
        // re-signs the real URL. Handled before any upstream fetch. The LL origin
        // owns `seg/` when active; this scheme uses a distinct `vseg/` prefix.
        if let Some((sid, sn)) = crate::services::hls_projection::parse_vseg_path(request_path) {
            return Ok(match crate::services::hls_projection::redirect_target(&sid, sn) {
                Some(url) => warp::http::Response::builder()
                    .status(302)
                    .header("Location", url)
                    .header("Access-Control-Allow-Origin", "*")
                    .header(
                        "Cache-Control",
                        "no-cache, no-store, must-revalidate, max-age=0",
                    )
                    .body(vec![])
                    .unwrap(),
                None => empty_cors(404),
            });
        }

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

        // Playlist handling (never on .ts payloads). These bytes are already in hand,
        // and the live media playlist is re-fetched on every live-edge poll, so this is
        // free. Detection is read-only: the relay is ad-neutral and serves the upstream's
        // segments as they are. Ad markers are only RECORDED, for the UI counter and the
        // resolution-owning plugin (which escalates by swapping the upstream; core never
        // edits ads out). The one rewrite is lowering Twitch's over-declared
        // #EXT-X-TARGETDURATION (6s for ~2s segments) to the real segment size, so hls.js
        // rides at its cushion instead of being forced several seconds back. The
        // parts-based low-latency origin (when enabled) owns its own playlist and never
        // reaches here.
        if !request_path.ends_with(".ts") {
            if let Ok(text) = std::str::from_utf8(&bytes) {
                detect_ads_in_playlist(text);
                // Lower the over-declared TARGETDURATION, then (LIVE only) pin every
                // segment URL stable across refreshes so Twitch re-signing a path
                // can't trip hls.js into replaying a segment. Gated two ways: a
                // VOD/ended playlist (#EXT-X-ENDLIST) is static and fully seekable so
                // rewriting+pruning it would break seeking; and the experimental
                // low-latency engine, when ON, owns the playlist with its own `seg/`
                // scheme (served from memory) — our `vseg/` rewrite alongside it
                // would hand the player two URLs for one media sequence and trip the
                // exact refresh-mismatch we fix, so we only stabilize when the engine
                // is off (the whole-segment path).
                let is_live = !text.contains("#EXT-X-ENDLIST");
                let stabilize_ok = is_live && crate::services::ll_origin::engine_disabled();
                let work: String = crate::services::ad_detect::retarget_playlist(text)
                    .unwrap_or_else(|| text.to_string());
                bytes = if stabilize_ok {
                    let base = crate::services::hls_projection::base_url_of(&manifest_url);
                    crate::services::hls_projection::stabilize(SOLO_STREAM_ID, &work, &base)
                        .into_bytes()
                } else {
                    work.into_bytes()
                };
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
        set_solo_session(None);
        Ok(())
    }

    async fn get_current_port() -> Result<u16> {
        CURRENT_PORT
            .lock()
            .await
            .ok_or_else(|| anyhow::anyhow!("No server running"))
    }
}
