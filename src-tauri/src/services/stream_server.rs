use crate::services::ll_origin::{
    empty_cors, media_response, opt_raw_query, parse_directive, parse_part_path,
    playlist_response,
};
use anyhow::Result;
use log::{error, info};
use once_cell::sync::Lazy;
use rand::Rng;
use reqwest::Client;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};
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
    // Per-stream relay flags reset alongside the ad state (called on stream
    // start, hot-swap, and stop). Low-latency is unknown until the new stream's
    // first playlist is scanned.
    LOW_LATENCY.store(false, Ordering::Relaxed);
    // The stable-URL segment map and its sticky flag belong to the previous stream.
    SEGMENT_MAP.lock().unwrap().clear();
    STABILIZING.store(false, Ordering::Relaxed);
    // Tear down the LL-HLS origin (background reader + live edge) for the old stream.
    crate::services::ll_origin::stop();
}

/// Fold a relayed media playlist into the solo stream's ad-detection state.
/// Detection here is read-only: the relay serves the playlist untouched and
/// only RECORDS whether ad markers are present, for the UI counter and the
/// `on_ad_window` plugin event. On an ad-state transition the subscribed
/// plugins are notified; a resolution-owning plugin reacts by handing the
/// relay a new upstream via `set_upstream`.
fn detect_ads_in_playlist(playlist: &str) {
    let (was, now) = {
        let mut st = AD_STATE.lock().unwrap();
        let was = st.ads_present;
        if let Some(n) = crate::services::ad_detect::update(&mut st, playlist) {
            info!(
                "[StreamServer] ad markers detected in live playlist (break #{}): {:?}",
                n, st.matched_markers
            );
        }
        (was, st.ads_present)
    };
    if was != now {
        notify_ad_window(SOLO_STREAM_ID, now);
    }
}

/// The stream id the solo relay session is addressed by in the plugin
/// protocol (`set_upstream`, `on_ad_window`). MultiNook tiles use their own
/// per-tile ids.
pub const SOLO_STREAM_ID: &str = "solo";

/// The channel the solo relay is currently serving, when it is a live stream
/// (None for VOD/clip playback and when stopped). This is what makes the solo
/// session addressable by plugins.
static SOLO_CHANNEL: Lazy<std::sync::Mutex<Option<String>>> =
    Lazy::new(|| std::sync::Mutex::new(None));
static APP_HANDLE: once_cell::sync::OnceCell<tauri::AppHandle> = once_cell::sync::OnceCell::new();
/// Whether the currently-relayed stream is a low-latency broadcast (the relay
/// sees Twitch's PREFETCH hints on it). The player reads this via the
/// `get_stream_low_latency` command to decide whether to ride a ~2s cushion,
/// instead of re-downloading the manifest itself just to look.
static LOW_LATENCY: AtomicBool = AtomicBool::new(false);

/// True ONLY when the LL-HLS origin is actively serving parts for this stream. This
/// is what the player keys `lowLatencyMode` on: it means a real spec LL-HLS playlist
/// (`#EXT-X-PART` + blocking reload) is being served, so hls.js's native low-latency
/// controller has parts to consume. It must NOT be true merely because the upstream
/// has PREFETCH hints — driving hls.js into low-latency mode against a no-parts
/// (promotion) playlist mistimes its blocking reloads and stalls (the regression
/// behind the "plays then hangs 15-20s behind" reports on H.264/TS channels, where
/// the CMAF origin can't activate).
pub fn is_low_latency() -> bool {
    crate::services::ll_origin::is_active()
}

/// True when the upstream is a low-latency broadcast (carries PREFETCH hints),
/// regardless of whether the LL-HLS origin took over. When the origin is inactive
/// (e.g. an H.264/TS channel with the TS origin off), the relay still promotes the
/// hints, so the player can ride a tighter cushion than a normal-latency channel —
/// WITHOUT entering hls.js low-latency mode. Seeded from the start probe and kept
/// fresh by the per-poll playlist scan.
pub fn prefetch_present() -> bool {
    crate::services::ll_origin::is_active() || LOW_LATENCY.load(Ordering::Relaxed)
}

// ──── Stable-URL relay scheme ────
// The load-bearing piece that makes PREFETCH promotion refresh-stable. hls.js with
// lowLatencyMode:false requires a given media-sequence number to keep the SAME URL
// path across playlist refreshes (it rejects a change with a fatal
// "media sequence mismatch" / levelParsingError). But Twitch re-signs segment URLs
// poll-to-poll — especially PREFETCH hints, whose URL differs from the same
// segment's URL once finalized — so promoting them with their raw URL freezes the
// player. Fix: give every media segment a STABLE synthetic URL `seg/<sn>.ts` in the
// served playlist and 302-redirect it to the freshest real CDN URL via this map. The
// player's cross-refresh URL identity never changes; bytes still come straight from
// the CDN (the relay only serves a tiny redirect, never the segment body).

/// sn -> freshest real (absolute) segment URL, for the `seg/<sn>.ts` redirect.
static SEGMENT_MAP: Lazy<std::sync::Mutex<std::collections::BTreeMap<u64, String>>> =
    Lazy::new(|| std::sync::Mutex::new(std::collections::BTreeMap::new()));

/// Sticky: set once we've promoted prefetch on a stream, so EVERY subsequent media
/// playlist for that stream is stabilized too — including ad-break polls that carry
/// no prefetch. Without this, a poll that skipped stabilization would serve a
/// previously-synthetic sn under its raw URL, which is the exact cross-refresh
/// mismatch we're preventing. Reset on stream (re)start via `reset_ad_state`.
static STABILIZING: AtomicBool = AtomicBool::new(false);

/// Media-sequence numbers to retain in SEGMENT_MAP behind the live edge. The live
/// window is ~12-15 segments and the player sits a few behind; 120 is a generous
/// margin so a just-rolled-off segment the player still wants resolves, while the
/// map stays tiny.
const SEGMENT_MAP_RETAIN: u64 = 120;

/// Resolve a (possibly relative) segment URI against the upstream manifest base.
/// Twitch segments are absolute cloudfront URLs (returned as-is); the join covers
/// proxied playlists that use relative chunk paths.
fn resolve_segment_url(uri: &str, base_url: &str) -> String {
    if uri.starts_with("http://") || uri.starts_with("https://") {
        uri.to_string()
    } else {
        format!("{base_url}{uri}")
    }
}

/// Rewrite every media-segment URI in an already filtered/retargeted/promoted media
/// playlist to a stable synthetic `seg/<sn>.ts`, recording sn -> real absolute URL in
/// SEGMENT_MAP for the redirect handler. `#EXT-X-MAP` (the init segment) and all tags
/// pass through untouched (the init segment is fetched direct from the CDN; hls.js's
/// refresh check never compares it). Returns the rewritten playlist text.
fn stabilize_segment_urls(playlist: &str, base_url: &str) -> String {
    let mut sn: u64 = 0;
    let mut max_sn: Option<u64> = None;
    let mut expect_uri = false;
    let mut out = String::with_capacity(playlist.len());
    let mut map = SEGMENT_MAP.lock().unwrap();
    for line in playlist.lines() {
        let trimmed = line.trim();
        if let Some(v) = trimmed.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            sn = v.trim().parse().unwrap_or(0);
            out.push_str(line);
            out.push('\n');
        } else if trimmed.starts_with("#EXTINF:") {
            expect_uri = true;
            out.push_str(line);
            out.push('\n');
        } else if expect_uri && !trimmed.is_empty() && !trimmed.starts_with('#') {
            // The segment URI for the preceding #EXTINF.
            expect_uri = false;
            map.insert(sn, resolve_segment_url(trimmed, base_url));
            max_sn = Some(sn);
            out.push_str(&format!("seg/{sn}.ts\n"));
            sn += 1;
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    // Prune sns well behind the edge so the map can't grow without bound.
    if let Some(edge) = max_sn {
        let keep_from = edge.saturating_sub(SEGMENT_MAP_RETAIN);
        let stale: Vec<u64> = map.range(..keep_from).map(|(k, _)| *k).collect();
        for k in stale {
            map.remove(&k);
        }
    }
    out
}

/// Handle a synthetic `seg/<sn>.ts` request: 302-redirect to the freshest real CDN
/// URL recorded in SEGMENT_MAP. Returns `None` if the path isn't a segment request
/// (so the caller falls through to normal proxy handling).
fn segment_redirect(request_path: &str) -> Option<warp::http::Response<Vec<u8>>> {
    let rest = request_path.strip_prefix("seg/")?;
    let sn_str = rest.strip_suffix(".ts").unwrap_or(rest);
    let sn: u64 = sn_str.parse().ok()?;
    let real = SEGMENT_MAP.lock().unwrap().get(&sn).cloned();
    let resp = match real {
        Some(url) => warp::http::Response::builder()
            .status(302)
            .header("Location", url)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, OPTIONS")
            .header("Access-Control-Allow-Headers", "*")
            .header("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0")
            .body(vec![])
            .unwrap(),
        None => warp::http::Response::builder()
            .status(404)
            .header("Access-Control-Allow-Origin", "*")
            .body(vec![])
            .unwrap(),
    };
    Some(resp)
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

/// Forward an ad-window transition for a relay session to subscribed plugins
/// as the protocol's `on_ad_window` event. Fire-and-forget; called from the
/// relay's request path, so the actual emit runs on its own task. Shared with
/// MultiNook (per-tile stream ids).
pub(crate) fn notify_ad_window(stream_id: &str, active: bool) {
    let Some(app) = APP_HANDLE.get() else {
        return;
    };
    let app = app.clone();
    let stream_id = stream_id.to_string();
    tokio::spawn(async move {
        let state = app.state::<crate::models::settings::AppState>();
        state.plugin_host.emit_ad_window(&stream_id, active).await;
    });
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
    info!("[StreamServer] {} upstream swapped by a playback plugin", channel);
    Ok(())
}

impl StreamServer {
    pub async fn start_proxy_server(stream_url: String) -> Result<u16> {
        // The upstream media-playlist URL the LL-HLS origin will poll. `reset_ad_state`
        // (below) stops any prior origin; `ll_origin::start` probes this URL and, if it's
        // a low-latency broadcast, builds the live edge before we return — so the player
        // can read `get_stream_low_latency` and pick the right hls.js mode.
        let upstream = stream_url.clone();

        // Check if server is already running
        let server_exists = SERVER_HANDLE.lock().await.is_some();

        if server_exists {
            // Server already running - just update the URL
            *PROXY_URL.lock().await = Some(stream_url);
            // New stream on the existing server: clear stale ad-detection state.
            reset_ad_state();
            let outcome = crate::services::ll_origin::start(upstream).await;
            // Seed the low-latency flag from the start probe so the player's mode
            // query is correct before the first relay playlist fetch sets it. The
            // origin owns the playlist when active, so the per-poll scan never runs
            // for those channels — this is the only place it gets set there.
            LOW_LATENCY.store(outcome.has_prefetch, Ordering::Relaxed);
            log::debug!(
                "[StreamServer] LL origin start (reuse): active={} prefetch={}",
                outcome.active, outcome.has_prefetch
            );
            // Return the existing port by parsing it from a static variable
            return Self::get_current_port().await;
        }

        // Start new server
        let port = rand::rng().random_range(10000..20000);

        *PROXY_URL.lock().await = Some(stream_url);
        reset_ad_state();
        let outcome = crate::services::ll_origin::start(upstream).await;
        LOW_LATENCY.store(outcome.has_prefetch, Ordering::Relaxed);
        log::debug!(
            "[StreamServer] LL origin start: active={} prefetch={}",
            outcome.active, outcome.has_prefetch
        );

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

        let handle = tokio::spawn(async move {
            warp::serve(proxy).run(addr).await;
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

        // ── LL-HLS origin path (active only on low-latency channels) ──
        // When the origin is live it owns the media playlist, parts, and complete
        // segments (served from memory). This must come before the non-LL stable-URL
        // redirect, which shares the `seg/` prefix.
        if crate::services::ll_origin::is_active() {
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
                    crate::services::ll_diagnostics::event(&format!("\"ev\":\"o_seg_miss\",\"sn\":{sn}"));
                }
                return Ok(empty_cors(404));
            }
            if request_path == "stream.m3u8" || request_path.is_empty() {
                let msn = parse_directive(&raw_query, "_HLS_msn");
                let part = parse_directive(&raw_query, "_HLS_part");
                if let Some(pl) = crate::services::ll_origin::serve_playlist(msn, part).await {
                    return Ok(playlist_response(pl.into_bytes()));
                }
                // Origin went inactive between the check and now: fall through.
            }
        }

        // Stable-URL scheme: a synthetic `seg/<sn>.ts` is 302-redirected to the
        // freshest real CDN URL (see SEGMENT_MAP). Handled before any upstream fetch.
        if let Some(resp) = segment_redirect(request_path) {
            return Ok(resp);
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

        // Playlist handling (never on .ts payloads). These bytes are already
        // in hand, and the live media playlist is re-fetched on every
        // live-edge poll, so this is free. Detection is read-only: the relay
        // is ad-neutral and serves the upstream's segments as they are. Ad
        // markers are only RECORDED, for the UI counter and the `on_ad_window`
        // plugin event (a resolution-owning plugin escalates by swapping the
        // upstream; core never edits ads out).
        if !request_path.ends_with(".ts") {
            if let Ok(text) = std::str::from_utf8(&bytes) {
                detect_ads_in_playlist(text);
                // Snapshot whether THIS playlist carries an ad, to gate prefetch
                // promotion below (never fast-path an in-progress ad segment).
                let ads_now = AD_STATE.lock().unwrap().ads_present;
                // A playlist carrying PREFETCH hints is a low-latency broadcast.
                // Delivery on those is smooth, so the player can safely ride a
                // tighter cushion; tag it so the frontend knows (this is decided
                // from the RAW text, before promotion rewrites the hints away).
                let is_low_latency = text.contains("#EXT-X-TWITCH-PREFETCH:");

                // Build the served playlist: two latency rewrites on the
                // otherwise untouched upstream text.
                let mut work: String = text.to_string();

                // 1) Lower Twitch's over-declared #EXT-X-TARGETDURATION (6s for ~2s
                //    segments) to the real segment size so hls.js can ride closer to
                //    the live edge without stalling.
                if let Some(rt) = crate::services::ad_detect::retarget_playlist(&work) {
                    work = rt;
                }

                // 2) Promote Twitch's low-latency PREFETCH hints into real segments
                //    (moves the live edge ~4s closer on low-latency channels). hls.js
                //    ignores the raw PREFETCH tag, so this is what unlocks ~2s. Gated
                //    on an ad-free playlist so an in-progress ad segment is never
                //    fast-pathed to the live edge; ad-free streams always promote,
                //    normal-latency streams have no hints so this is a no-op.
                //
                // Promote PREFETCH hints into real segments (the only way to ride ~2s
                // on a low-latency channel), made refresh-stable by two cooperating
                // fixes: (a) `promote_prefetch` translates Twitch's
                // `#EXT-X-PREFETCH-DISCONTINUITY` into a real `#EXT-X-DISCONTINUITY` so
                // the discontinuity counter `cc` stays consistent across refreshes; and
                // (b) `stabilize_segment_urls` rewrites every segment to a stable
                // synthetic `seg/<sn>.ts` so its URL never changes across refreshes even
                // as Twitch re-signs the real URLs. Both are required: the live repro
                // that froze the player showed a "media sequence mismatch" (URL change),
                // not a "discontinuity sequence mismatch", so the `cc` fix alone was not
                // enough. Promotion is ad-gated (never fast-path an in-progress ad).
                // `enable_prefetch_promotion` is the one-line kill switch.
                let enable_prefetch_promotion = true;
                if enable_prefetch_promotion && !ads_now {
                    if let Some(pp) = crate::services::ad_detect::promote_prefetch(&work) {
                        work = pp;
                        STABILIZING.store(true, Ordering::Relaxed);
                    }
                }
                // Stabilize segment URLs once we've started promoting on this stream.
                // Sticky across polls (even ad-break polls with no prefetch): a segment
                // served as `seg/<sn>.ts` in one poll must never revert to its raw,
                // re-signed URL in the next, which would be the very cross-refresh
                // mismatch this prevents.
                if enable_prefetch_promotion && STABILIZING.load(Ordering::Relaxed) {
                    let uwq = manifest_url.split('?').next().unwrap_or(&manifest_url);
                    let base_url = match uwq.rfind('/') {
                        Some(i) => uwq[..=i].to_string(),
                        None => uwq.to_string(),
                    };
                    work = stabilize_segment_urls(&work, &base_url);
                }

                // 3) Record whether this is a low-latency broadcast so the player
                //    can adopt a ~2s cushion on it (and only it) via the
                //    `get_stream_low_latency` command — no manifest re-download.
                LOW_LATENCY.store(is_low_latency, Ordering::Relaxed);

                // Loud diagnostic: a media playlist hls.js can parse needs a target
                // duration AND at least one segment. If we're about to serve one
                // missing either, that's the shape that throws `levelParsingError`.
                // Log it, and whether the RAW upstream body had them — so we can tell
                // a rewrite bug (raw ok, served broken) from an empty/garbage upstream
                // (raw also broken, e.g. a 0-byte body during a reload race).
                if !work.contains("#EXTINF") || !work.contains("#EXT-X-TARGETDURATION") {
                    error!(
                        "[StreamServer] serving UNPARSEABLE playlist (served_len={} raw_len={} raw_had_segs={} raw_had_td={})",
                        work.len(),
                        text.len(),
                        text.contains("#EXTINF"),
                        text.contains("#EXT-X-TARGETDURATION"),
                    );
                }

                bytes = work.into_bytes();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stabilize_gives_each_sequence_a_stable_synthetic_url() {
        SEGMENT_MAP.lock().unwrap().clear();

        // Poll N: media-sequence 100, two segments (absolute CDN URLs, signed ?dna=AAA).
        let poll_n = "#EXTM3U\n\
#EXT-X-TARGETDURATION:2\n\
#EXT-X-MEDIA-SEQUENCE:100\n\
#EXT-X-MAP:URI=\"https://cdn/init.mp4\"\n\
#EXTINF:2.000,live\nhttps://cdn/a100.mp4?dna=AAA\n\
#EXTINF:2.000,live\nhttps://cdn/a101.mp4?dna=AAA\n";
        let out_n = stabilize_segment_urls(poll_n, "https://cdn/");
        // Segments become stable synthetic URLs keyed by media-sequence number.
        assert!(out_n.contains("seg/100.ts"));
        assert!(out_n.contains("seg/101.ts"));
        // The init segment (MAP) is left untouched (fetched direct from the CDN).
        assert!(out_n.contains("#EXT-X-MAP:URI=\"https://cdn/init.mp4\""));
        // Raw segment URLs no longer appear in the served playlist.
        assert!(!out_n.contains("a100.mp4"));
        // The map resolves the synthetic URL to the real one.
        assert_eq!(
            SEGMENT_MAP.lock().unwrap().get(&100).map(String::as_str),
            Some("https://cdn/a100.mp4?dna=AAA"),
        );

        // Poll N+1: window advanced by one; sn 101 is re-signed (?dna=BBB). hls.js
        // requires sn 101 to keep the SAME URL across refreshes — the synthetic URL
        // must be identical to poll N, while the redirect target updates to the fresh
        // signed URL. This is exactly what prevents the "media sequence mismatch" freeze.
        let poll_n1 = "#EXTM3U\n\
#EXT-X-TARGETDURATION:2\n\
#EXT-X-MEDIA-SEQUENCE:101\n\
#EXT-X-MAP:URI=\"https://cdn/init.mp4\"\n\
#EXTINF:2.000,live\nhttps://cdn/a101.mp4?dna=BBB\n\
#EXTINF:2.000,live\nhttps://cdn/a102.mp4?dna=BBB\n";
        let out_n1 = stabilize_segment_urls(poll_n1, "https://cdn/");
        assert!(out_n1.contains("seg/101.ts"));
        assert!(out_n1.contains("seg/102.ts"));
        // Same synthetic identity for sn 101 across both polls.
        assert!(out_n.contains("seg/101.ts") && out_n1.contains("seg/101.ts"));
        // Redirect target for sn 101 updated to the freshest signed URL.
        assert_eq!(
            SEGMENT_MAP.lock().unwrap().get(&101).map(String::as_str),
            Some("https://cdn/a101.mp4?dna=BBB"),
        );

        SEGMENT_MAP.lock().unwrap().clear();
    }

    #[test]
    fn segment_redirect_only_matches_seg_paths() {
        // Non-segment paths fall through (None) so normal proxying still runs.
        assert!(segment_redirect("stream.m3u8").is_none());
        assert!(segment_redirect("video/something.ts").is_none());
    }
}
