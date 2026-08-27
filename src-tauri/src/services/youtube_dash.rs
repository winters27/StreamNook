//! Serves YouTube's video-only DASH renditions to hls.js as ordinary HLS.
//!
//! YouTube publishes 1440p and 2160p live only as video-only `adaptiveFormats`
//! itags, delivered as manifestless DASH fragments addressed by `&sq=N`, in
//! WebM. hls.js plays neither WebM nor DASH. Rather than put a second media
//! engine in the frontend, this rewrites the container (`webm_fmp4`) and the
//! packaging, so the player, Plyr chrome and quality menu stay exactly as they
//! are and simply gain rungs.
//!
//! What is served:
//!
//! ```text
//! /stream.m3u8   master: one video variant plus an audio rendition group
//! /video.m3u8    rolling live media playlist, EXT-X-MAP + fMP4 segments
//! /audio.m3u8    the same for audio
//! /init_v.mp4    generated from the WebM track header
//! /init_a.mp4    YouTube's own audio ftyp+moov, split out of a fragment
//! /v/<sq>.m4s    fetched, transmuxed WebM -> fMP4
//! /a/<sq>.m4s    fetched, moof+mdat sliced out of a self-contained fragment
//! ```
//!
//! This is a separate server from `stream_server` on purpose. That relay is the
//! Twitch low-latency path and is load-bearing; nothing here needs its ad
//! detection, segment projection or LL origin, and keeping them apart means a
//! bug in this path cannot reach Twitch playback.
//!
//! Timestamps are passed through absolutely rather than rebased. YouTube gives
//! video (millisecond ticks) and audio (44100 ticks) positions on one shared
//! media timeline, so leaving them alone is what keeps the two tracks in sync
//! without this module having to understand either clock.

use crate::services::providers::youtube_media::HighRendition;
use crate::services::webm_fmp4::{self, Parsed, Vp9Config};
use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use once_cell::sync::Lazy;
use rand::Rng;
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use warp::Filter;

/// itag 140 is AAC-LC in an MP4 container, which is the only audio these
/// renditions are ever paired with.
const AUDIO_CODEC: &str = "mp4a.40.2";

/// How much wall-clock the advertised window should cover.
///
/// Counted in SECONDS rather than segments because segment length varies by
/// broadcast: a fixed count is a 30s window at 5s segments and a 4s window at
/// 0.66s ones, and the short case is far too shallow to survive a hiccup.
const WINDOW_SECONDS: f64 = 30.0;

/// Floor on the number of advertised segments, so a long-segment stream still
/// offers the player somewhere to seek.
const WINDOW_MIN: u64 = 6;

fn window_for(target: f64) -> u64 {
    if target <= 0.0 {
        return WINDOW_MIN;
    }
    ((WINDOW_SECONDS / target).ceil() as u64).max(WINDOW_MIN)
}

/// How stale the live edge may be before a playlist request refreshes it. The
/// player polls the playlist about every target duration, so this rides its
/// cadence rather than adding a timer of its own.
const HEAD_TTL: Duration = Duration::from_secs(2);

/// How far behind `X-Head-Seqnum` the newest ADVERTISED segment starts.
///
/// The head is the sequence being written, and the one before it has only just
/// closed, so neither is reliably retrievable. Measured on a live broadcast:
/// 16388 fetched fine while 16390 through 16392 all 404ed, putting the real edge
/// around head-3.
const EDGE_BACKOFF_START: u64 = 3;

/// Ceiling for the adaptive backoff. Each step costs one segment of latency, so
/// this caps the damage when something else entirely is wrong.
const EDGE_BACKOFF_MAX: u64 = 8;

/// The upstream status, attached to segment errors so the handler can tell a
/// sequence that has not been written yet (404) from one we are no longer
/// allowed to fetch (403). They need opposite responses and conflating them cost
/// several debugging rounds.
#[derive(Debug, Clone, Copy)]
struct UpstreamStatus(u16);

impl std::fmt::Display for UpstreamStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "upstream {}", self.0)
    }
}

impl std::error::Error for UpstreamStatus {}

fn upstream_status(e: &anyhow::Error) -> Option<u16> {
    e.chain()
        .find_map(|c| c.downcast_ref::<UpstreamStatus>())
        .map(|s| s.0)
}

static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

struct Session {
    /// Kept so an expired url can be re-issued without unwinding playback.
    video_id: String,
    /// The floor the renditions were resolved against, so a refresh asks the
    /// same question and gets the same rungs back.
    above: u32,
    /// Identifies which rendition to pick out of a refreshed ladder.
    itag: u64,
    /// When the urls below were issued.
    issued: Instant,
    video_url: String,
    audio_url: String,
    width: u32,
    height: u32,
    fps: f64,
    bandwidth: u64,
    video_codec: String,
    /// `Bytes`, so serving an init is a refcount clone rather than a copy.
    init_video: Bytes,
    init_audio: Bytes,
    /// Segment length in seconds, from the media itself.
    target: f64,
    /// Head sequence per track. These are NOT the same number: measured on a
    /// live broadcast, video reported 13305 while audio reported 13306. Sharing
    /// one head makes the lagging track ask for a segment that does not exist
    /// yet, and every request for it 404s until the stream is restarted.
    video_head: u64,
    audio_head: u64,
    video_head_at: Instant,
    audio_head_at: Instant,
    /// Segments held back from the edge, per track, grown when the origin proves
    /// the edge is further back than assumed. Self-tuning because the right
    /// value differs per broadcast and a fixed constant is just a guess that
    /// happens to work on the stream it was measured against.
    video_backoff: u64,
    audio_backoff: u64,
}

static SESSION: Lazy<Mutex<Option<Session>>> = Lazy::new(|| Mutex::new(None));

/// Client playback nonce: one per playback session, sent on every media request.
///
/// YouTube's own player sends `cpn` and an incrementing `rn` on every
/// videoplayback request (captured: `&cpn=2T698qjkaUcd0OL8&cver=...&rn=10`), so
/// these are sent to match it.
///
/// They are NOT what fixed the 403 wall, despite an earlier note here saying so.
/// Adding them changed nothing. Gated urls expire about thirty seconds after
/// they are issued and the cure is to re-issue them; see `rotate_if_stale`.
static CPN: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));
static RN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn playback_nonce() -> String {
    let mut g = match CPN.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    if g.is_empty() {
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut r = rand::rng();
        *g = (0..16).map(|_| A[r.random_range(0..A.len())] as char).collect();
    }
    g.clone()
}

/// Start a new playback session, so a fresh stream is not seen as a continuation
/// of the last one.
fn reset_nonce() {
    if let Ok(mut g) = CPN.lock() {
        g.clear();
    }
    RN.store(0, std::sync::atomic::Ordering::Relaxed);
}
static PORT: Lazy<Mutex<Option<u16>>> = Lazy::new(|| Mutex::new(None));
static SERVER: Lazy<Mutex<Option<tokio::task::JoinHandle<()>>>> = Lazy::new(|| Mutex::new(None));

/// Fetch one fragment. `sq` of `None` asks for the live edge, which is also the
/// cheapest way to learn the current head sequence number.
async fn fragment(base: &str, sq: Option<u64>, video: bool) -> Result<(Vec<u8>, Option<u64>)> {
    // Every media request carries the playback session identity, the way the
    // real player does.
    let rn = RN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let url = match sq {
        Some(n) => format!("{}&sq={}&cpn={}&rn={}", base, n, playback_nonce(), rn),
        None => format!("{}&cpn={}&rn={}", base, playback_nonce(), rn),
    };
    let resp = HTTP.get(&url).send().await?;
    let head = resp
        .headers()
        .get("x-head-seqnum")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok());
    let status = resp.status();
    // Record the head from EVERY response, including failures. A 404 for a
    // sequence past the edge still reports where the edge actually is, and that
    // correction is the only way an over-eager head recovers.
    note_head(video, head);
    if !status.is_success() {
        // Logged, not just returned. A 403 here means the urls stopped being
        // authorised — the difference between "this segment is not written yet"
        // (404, normal at the edge) and "playback is about to die". Returning it
        // silently meant the only symptom was the player giving up.
        if status.as_u16() == 403 {
            // The credential that signed these urls has been refused, so the next
            // resolve must rebuild the resolver's warm session rather than hand
            // back more urls signed with the same dead one. Without this the
            // relay never recovered: it fell back to HLS (1080p ceiling) and
            // every later attempt 403'd instantly on its first fetch.
            crate::services::youtube_potoken::invalidate_session();
            // Recover on the NEXT segment request rather than waiting out the
            // rotation clock, so the viewer keeps the resolution they picked
            // instead of watching it stall and drop to the HLS ceiling.
            FORCE_ROTATE.store(true, std::sync::atomic::Ordering::SeqCst);
            log::warn!(
                "[YouTubeDash] UPSTREAM 403 for {} sq={:?} — urls no longer authorised (age {:?})",
                if video { "video" } else { "audio" },
                sq,
                SESSION
                    .lock()
                    .ok()
                    .and_then(|g| g.as_ref().map(|s| s.issued.elapsed()))
            );
        } else if status.as_u16() != 404 {
            log::warn!(
                "[YouTubeDash] upstream {} for {} sq={:?}",
                status,
                if video { "video" } else { "audio" },
                sq
            );
        }
        return Err(anyhow!(
            "segment {:?} returned {} (origin says head={:?})",
            sq,
            status,
            head
        )
        .context(UpstreamStatus(status.as_u16())));
    }
    // `Bytes` is already one contiguous buffer; `to_vec` here copied every
    // megabyte of every segment for nothing.
    Ok((resp.bytes().await?.into(), head))
}

/// Ask for the live edge purely to read `X-Head-Seqnum`. Sequence 0 is always
/// outside the window, so this answers with a 404 and no body.
async fn probe_head(base: &str) -> Option<u64> {
    let resp = HTTP.get(format!("{}&sq=0", base)).send().await.ok()?;
    resp.headers()
        .get("x-head-seqnum")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

fn note_head(video: bool, head: Option<u64>) {
    if let (Some(h), Ok(mut g)) = (head, SESSION.lock()) {
        if let Some(s) = g.as_mut() {
            let (cur, at) = if video {
                (&mut s.video_head, &mut s.video_head_at)
            } else {
                (&mut s.audio_head, &mut s.audio_head_at)
            };
            // Follow the origin in BOTH directions. Taking the maximum made a
            // single over-reported head permanent, and every later request for
            // a segment past the real edge 404ed forever: measured in the app as
            // playback dying after a few seconds and never recovering.
            //
            // A BACKWARDS step is the interesting case: the playlist shrinks under
            // the player, which it sees as the live edge moving away from it. One
            // suspect is the url rotation — the next probe after a swap asks a
            // freshly-issued url, which can disagree with the old one about the
            // edge. Logged with the delta so a stutter can be matched to it.
            if h < *cur {
                log::warn!(
                    "[YouTubeDash] {} head went BACKWARDS {} -> {} ({} segments, rotation in flight: {})",
                    if video { "video" } else { "audio" },
                    *cur,
                    h,
                    *cur - h,
                    ROTATING.load(std::sync::atomic::Ordering::SeqCst)
                );
            } else if h > *cur + 3 {
                log::warn!(
                    "[YouTubeDash] {} head JUMPED {} -> {} (+{} segments)",
                    if video { "video" } else { "audio" },
                    *cur,
                    h,
                    h - *cur
                );
            }
            *cur = h;
            *at = Instant::now();
        }
    }
}

/// A segment we advertised turned out not to exist, so hold back one more.
///
/// Only counts failures at or past the edge we published: an older sequence
/// failing means it aged out of the DVR window, which says nothing about how
/// close to the head is safe.
fn widen_backoff(video: bool, sq: u64) {
    if let Ok(mut g) = SESSION.lock() {
        if let Some(s) = g.as_mut() {
            let (head, backoff) = if video {
                (s.video_head, &mut s.video_backoff)
            } else {
                (s.audio_head, &mut s.audio_backoff)
            };
            if sq + 1 >= head.saturating_sub(*backoff) && *backoff < EDGE_BACKOFF_MAX {
                *backoff += 1;
                log::info!(
                    "[YouTubeDash] {} edge backoff -> {} (sq {} was not there yet, head {})",
                    if video { "video" } else { "audio" },
                    *backoff,
                    sq,
                    head
                );
            }
        }
    }
}

/// Point the server at a rendition, priming everything the playlists need.
///
/// Returns the local URL the player should load. Safe to call again for a
/// quality change: the server and its port are reused.
pub async fn start(video_id: &str, above: u32, r: &HighRendition) -> Result<String> {
    reset_nonce();
    // The bare url answers with the live EDGE, which is a chunk of whatever the
    // origin has buffered rather than one addressable segment. It is the cheapest
    // way to learn the head sequence, and that is all it is used for.
    let (_edge, vhead) = fragment(&r.video_url, None, true).await?;
    let head = vhead.unwrap_or(0);
    if head == 0 {
        return Err(anyhow!("origin reported no head sequence"));
    }

    // Everything else comes from a REAL numbered segment.
    //
    // Taking the duration from the edge chunk was the bug behind playback dying
    // after a few seconds: the chunk covers several segments, so EXTINF came out
    // far too long, the player paced itself slower than the origin produced, and
    // it fell behind until it was chasing sequences that did not exist. The
    // symptom looked like an edge problem (404s near the head) but the cause was
    // the advertised segment duration.
    let probe_sq = head.saturating_sub(EDGE_BACKOFF_START);
    let (vbytes, _) = fragment(&r.video_url, Some(probe_sq), true).await?;
    let parsed: Parsed = webm_fmp4::parse(&vbytes)?;
    let cfg = Vp9Config::from_keyframe(
        &parsed.samples[0].data,
        parsed.track.width,
        parsed.track.height,
        r.fps,
    );
    let init_video = webm_fmp4::init_segment(&parsed.track, &cfg);
    let target = (parsed.duration() as f64 / parsed.track.timescale as f64).max(0.2);

    let (abytes, ahead) = fragment(&r.audio_url, Some(probe_sq), false).await?;
    let (init_audio, _) = webm_fmp4::split_audio_fragment(&abytes)?;
    if init_audio.is_empty() {
        return Err(anyhow!("audio fragment carried no init"));
    }

    // Sequence numbers restart per broadcast, so entries from the previous one
    // would collide by key and serve the wrong video's bytes.
    clear_segment_cache();
    *SESSION.lock().map_err(|_| anyhow!("session poisoned"))? = Some(Session {
        video_id: video_id.to_string(),
        above,
        itag: r.itag,
        issued: Instant::now(),
        video_url: r.video_url.clone(),
        audio_url: r.audio_url.clone(),
        width: r.width,
        height: r.height,
        fps: r.fps,
        bandwidth: r.bandwidth.max(1),
        video_codec: cfg.codec_string(),
        init_video: init_video.into(),
        init_audio: init_audio.into(),
        target,
        video_head: head,
        audio_head: ahead.unwrap_or(head),
        video_head_at: Instant::now(),
        audio_head_at: Instant::now(),
        video_backoff: EDGE_BACKOFF_START,
        audio_backoff: EDGE_BACKOFF_START,
    });

    log::info!(
        "[YouTubeDash] {} ({}x{}@{}) itag={} codec={} segment={:.3}s head={}",
        r.name,
        r.width,
        r.height,
        r.fps,
        r.itag,
        cfg.codec_string(),
        target,
        head
    );

    let port = ensure_server().await?;
    Ok(format!(
        "http://localhost:{}/stream.m3u8?t={}",
        port,
        chrono::Utc::now().timestamp_millis()
    ))
}

/// Drop the session so a later stream cannot serve this one's fragments. The
/// server itself is left running; it is inert without a session.
pub fn stop() {
    if let Ok(mut g) = SESSION.lock() {
        *g = None;
    }
    // Same reason the session is dropped: cached fragments belong to the stream
    // that just ended.
    clear_segment_cache();
    // The resolver webview is kept alive BETWEEN rotations, so something has to
    // close it when there are no more rotations coming.
    crate::services::youtube_potoken::close_resolver();
}

async fn ensure_server() -> Result<u16> {
    if let Some(p) = *PORT.lock().map_err(|_| anyhow!("port poisoned"))? {
        return Ok(p);
    }
    let port = rand::rng().random_range(20000..30000);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    let route = warp::path::full()
        .and_then(|p: warp::path::FullPath| async move { handle(p.as_str().to_string()).await })
        .boxed();

    let socket = tokio::net::TcpSocket::new_v4()?;
    socket.set_reuseaddr(true)?;
    socket.bind(addr)?;
    let listener = socket.listen(512)?;
    let handle = tokio::spawn(async move {
        warp::serve(route).incoming(listener).run().await;
    });
    *SERVER.lock().map_err(|_| anyhow!("server poisoned"))? = Some(handle);
    *PORT.lock().map_err(|_| anyhow!("port poisoned"))? = Some(port);
    log::info!("[YouTubeDash] serving on port {}", port);
    Ok(port)
}

fn cors(body: impl Into<Bytes>, content_type: &str) -> warp::http::Response<Bytes> {
    warp::http::Response::builder()
        .status(200)
        .header("Content-Type", content_type)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-cache")
        .body(body.into())
        .unwrap_or_else(|_| warp::http::Response::new(Bytes::new()))
}

fn fail(code: u16) -> warp::http::Response<Bytes> {
    fail_because(code, String::new())
}

/// Answer with the REASON attached, in the body and in a header.
///
/// The relay's own logs go to the Rust terminal while the person debugging is
/// usually looking at the browser console, where a bare 404 says nothing. This
/// puts the cause where the failure is already visible: hls.js prints the status,
/// and the Network tab shows the body.
fn fail_because(code: u16, why: String) -> warp::http::Response<Bytes> {
    let mut b = warp::http::Response::builder()
        .status(code)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store");
    if !why.is_empty() {
        // Header values cannot carry newlines or non-ASCII.
        let one_line: String = why
            .chars()
            .map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { ' ' })
            .take(400)
            .collect();
        b = b.header("X-SN-Reason", one_line);
    }
    b.body(Bytes::from(why.into_bytes()))
        .unwrap_or_else(|_| warp::http::Response::new(Bytes::new()))
}

/// Snapshot the parts of the session a handler needs, so no lock is held across
/// an await.
fn snapshot() -> Option<(String, String, u64, f64)> {
    let g = SESSION.lock().ok()?;
    let s = g.as_ref()?;
    Some((s.video_url.clone(), s.audio_url.clone(), s.video_head, s.target))
}

fn head_is_stale(video: bool) -> bool {
    SESSION
        .lock()
        .ok()
        .and_then(|g| {
            g.as_ref().map(|s| {
                let (h, at) = if video {
                    (s.video_head, s.video_head_at)
                } else {
                    (s.audio_head, s.audio_head_at)
                };
                at.elapsed() > HEAD_TTL || h == 0
            })
        })
        .unwrap_or(false)
}

/// Gated urls stop working about thirty seconds after they are issued, so they
/// are swapped out before they get there. Measured on a live broadcast
/// 2026-08-21: 28 back-to-back segments in 26.6s, or 5 segments in 14s when
/// paced two seconds apart. Same wall clock, very different request counts, so
/// this is an age limit rather than a quota.
///
/// Fifteen leaves roughly half the window as headroom, because the refresh runs
/// in the background and a webview resolve is not instant. Playback keeps using
/// the current urls the whole time it is in flight.
pub(crate) const ROTATE_AFTER: Duration = Duration::from_secs(15);

/// Rotate on the next segment request regardless of url age.
///
/// Age is the right trigger for the ordinary case (urls expire on a clock), but
/// a REFUSED url can be seconds old, and waiting out the rest of `ROTATE_AFTER`
/// with a credential the origin has already rejected is dead air. Set on a 403 so
/// recovery starts on the next request instead of at the next tick.
static FORCE_ROTATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Only urls carrying a Proof-of-Origin token expire this way. The ones the
/// visionos client hands out are plain and last as long as their `expire` says,
/// so they are left alone rather than being churned for nothing.
pub(crate) fn is_gated(url: &str) -> bool {
    url.contains("&pot=") || url.contains("?pot=")
}

/// Re-issue the media urls if the ones in hand are about to go stale.
///
/// Playback continues across the swap untouched: only the base urls change, and
/// the sequence numbers, heads and backoffs all carry forward, because the new
/// urls address the same segments of the same broadcast.
/// One refresh at a time. Requests arrive far faster than a re-resolve
/// completes, so without this every segment in the window would start its own.
static ROTATING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// Rate limiting for the slow-serve warning: it is per-request and otherwise
// floods the app log on any sluggish stream.
const SLOW_SERVE_LOG_EVERY_MS: u64 = 30_000;
static SLOW_SERVE_EPOCH: OnceLock<Instant> = OnceLock::new();
static SLOW_SERVE_LAST_LOG_MS: AtomicU64 = AtomicU64::new(0);
static SLOW_SERVE_SUPPRESSED: AtomicU64 = AtomicU64::new(0);

/// Start a refresh if the urls in hand are getting old. Returns immediately.
///
/// This deliberately does NOT wait for the new urls. A re-resolve takes seconds
/// (on the gated path it spawns a webview), and blocking a segment request on it
/// stalls playback for exactly as long as it takes, which shows up as a stutter
/// on a fixed cadence. The gap between `ROTATE_AFTER` and the ~30s wall is the
/// headroom that lets the swap land while the current urls still work.
fn rotate_if_stale() {
    let Some((video_id, above, itag)) = ({
        let g = match SESSION.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        g.as_ref().and_then(|s| {
            let forced = FORCE_ROTATE.load(std::sync::atomic::Ordering::SeqCst);
            let due = is_gated(&s.video_url) && (forced || s.issued.elapsed() >= ROTATE_AFTER);
            due.then(|| (s.video_id.clone(), s.above, s.itag))
        })
    }) else {
        return;
    };

    use std::sync::atomic::Ordering;
    if ROTATING.swap(true, Ordering::SeqCst) {
        return;
    }
    // Cleared only once a rotation is actually under way, so a refusal can never
    // be swallowed by a concurrent caller that then declined to rotate.
    FORCE_ROTATE.store(false, Ordering::SeqCst);

    tokio::spawn(async move {
        let outcome = refresh_urls(&video_id, above, itag).await;
        ROTATING.store(false, Ordering::SeqCst);
        if let Err(e) = outcome {
            log::warn!("[YouTubeDash] could not re-issue urls for itag {}: {}", itag, e);
        }
    });
}

/// Swap the host of a videoplayback url, keeping everything else byte for byte.
///
/// The signature covers query parameters, not the host, so an edge in the same
/// pool serves the same url happily. Verified 2026-08-21: a url issued for
/// `rr1---sn-iv` returned 200 from `rr9---sn-iv`.
fn with_host(url: &str, host: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let slash = rest.find('/')?;
    Some(format!("https://{}{}", host, &rest[slash..]))
}

fn host_of(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("https://")?;
    Some(&rest[..rest.find('/')?])
}

/// Confirm a url plays, and leave a warm connection to its host behind.
///
/// `HEAD` answers in about a tenth of a second with no body, so this costs
/// almost nothing, and it runs off the playback path.
async fn probe(url: &str) -> bool {
    match HTTP.head(url).send().await {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}

/// Choose between a freshly issued url and the same url pointed back at the host
/// already in use.
///
/// Every resolve lands on a different edge (`rr1` -> `rr13` -> `rr10` observed
/// back to back). Following it means a DNS lookup, a TCP connect and a TLS
/// handshake before the very next segment, which is a visible hitch mid
/// playback. Staying put keeps the pooled connection.
async fn pick_url(fresh: &str, current: &str) -> String {
    if let Some(host) = host_of(current) {
        if host_of(fresh) != Some(host) {
            if let Some(pinned) = with_host(fresh, host) {
                if probe(&pinned).await {
                    return pinned;
                }
                log::debug!("[YouTubeDash] host {} would not serve the new url", host);
            }
        }
    }
    // Either the host was unchanged, or it refused: warm the new one instead so
    // the handshake is paid here rather than on the next segment.
    probe(fresh).await;
    fresh.to_string()
}

async fn refresh_urls(video_id: &str, above: u32, itag: u64) -> Result<()> {
    // The resolver caches for the rest of the hour, which is the right call for
    // a fresh session and exactly wrong here, so the entry is dropped first.
    crate::services::youtube_potoken::invalidate_streams(video_id);
    // Straight to the gated resolver rather than through `high_renditions`.
    // Nothing but a gated url is ever rotated, so re-asking the visionos client
    // every fifteen seconds would only re-learn that it has nothing to offer,
    // at the cost of a watch-page scrape and a player call each time.
    let resolved = crate::services::youtube_potoken::resolve_streams(video_id, above).await?;
    let fresh = resolved
        .videos
        .iter()
        .find(|v| v.itag as u64 == itag)
        .ok_or_else(|| anyhow!("itag {} is no longer offered by '{}'", itag, video_id))?;

    let (cur_video, cur_audio) = {
        let g = SESSION.lock().map_err(|_| anyhow!("session poisoned"))?;
        let s = g.as_ref().ok_or_else(|| anyhow!("session ended mid-refresh"))?;
        (s.video_url.clone(), s.audio_url.clone())
    };
    // Both settled BEFORE the swap, so the urls that go live are already proven
    // and already have a connection open.
    let video_url = pick_url(&fresh.url, &cur_video).await;
    let audio_url = pick_url(&resolved.audio_url, &cur_audio).await;

    let mut g = SESSION.lock().map_err(|_| anyhow!("session poisoned"))?;
    let s = g.as_mut().ok_or_else(|| anyhow!("session ended mid-refresh"))?;
    // The session may have been restarted onto a different rendition while this
    // was in flight; overwriting it then would silently switch quality.
    if s.itag != itag {
        return Err(anyhow!("session moved to itag {} mid-refresh", s.itag));
    }
    s.video_url = video_url;
    s.audio_url = audio_url;
    s.issued = Instant::now();
    log::info!("[YouTubeDash] re-issued urls for itag {}", itag);
    Ok(())
}

async fn handle(path: String) -> Result<warp::http::Response<Bytes>, std::convert::Infallible> {
    let started = Instant::now();
    let path = path.trim_start_matches('/').to_string();
    let path = path.split('?').next().unwrap_or("").to_string();

    if SESSION.lock().ok().map(|g| g.is_none()).unwrap_or(true) {
        return Ok(fail(503));
    }
    // Every request goes through here, so the refresh rides the player's own
    // cadence instead of needing a timer of its own. It does not block: the
    // current urls stay good for another ten seconds or so.
    let was_rotating = ROTATING.load(std::sync::atomic::Ordering::SeqCst);
    rotate_if_stale();

    // Anything the player waits on for more than a beat is a candidate for the
    // visible hitch, so name it with whether a url rotation was in flight. A
    // media playlist is served from memory and should be sub-millisecond; the
    // only awaits on this path are the live-edge head probes.
    let report = |kind: &str| {
        let ms = started.elapsed().as_millis();
        if ms >= 250 {
            // Rate limited: this fires per request and buried the app log
            // (thousands of lines an hour) under a stream that is merely slow,
            // which is exactly the noise that hides a real chat fault. One line
            // per window, carrying however many were suppressed, keeps the
            // signal without the flood.
            let suppressed = SLOW_SERVE_SUPPRESSED.fetch_add(1, Ordering::Relaxed);
            let now_ms = SLOW_SERVE_EPOCH
                .get_or_init(std::time::Instant::now)
                .elapsed()
                .as_millis() as u64;
            let last = SLOW_SERVE_LAST_LOG_MS.load(Ordering::Relaxed);
            // `last == 0` means nothing has been reported yet. Without this the
            // very first slow serve after startup, usually the most telling one,
            // was swallowed for the first 30 seconds of the process.
            let due = last == 0 || now_ms.saturating_sub(last) >= SLOW_SERVE_LOG_EVERY_MS;
            // Stamp at least 1 so the "never reported" sentinel cannot recur.
            let stamp = now_ms.max(1);
            if due
                && SLOW_SERVE_LAST_LOG_MS
                    .compare_exchange(last, stamp, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok()
            {
                SLOW_SERVE_SUPPRESSED.store(0, Ordering::Relaxed);
                log::warn!(
                    "[YouTubeDash] slow serve: {} took {}ms (rotation in flight: {}; {} more suppressed since the previous report)",
                    kind,
                    ms,
                    was_rotating || ROTATING.load(Ordering::SeqCst),
                    suppressed
                );
            }
        }
    };

    let res = match path.as_str() {
        "stream.m3u8" => master().map(|m| cors(m.into_bytes(), "application/vnd.apple.mpegurl")),
        "video.m3u8" | "audio.m3u8" => {
            let video = path.starts_with("video");
            // Refresh the live edge only when it has aged out, so this rides the
            // player's own playlist cadence instead of adding a timer.
            // Each track's own head, from its own url: they advance
            // independently and one cannot stand in for the other.
            if head_is_stale(video) {
                if let Some((v, a, _, _)) = snapshot() {
                    let base = if video { v } else { a };
                    note_head(video, probe_head(&base).await);
                }
            }
            media_playlist(video).map(|m| cors(m.into_bytes(), "application/vnd.apple.mpegurl"))
        }
        "init_v.mp4" | "init_a.mp4" => {
            let video = path.starts_with("init_v");
            SESSION
                .lock()
                .ok()
                .and_then(|g| {
                    g.as_ref().map(|s| {
                        if video {
                            s.init_video.clone()
                        } else {
                            s.init_audio.clone()
                        }
                    })
                })
                .map(|b| cors(b, "video/mp4"))
                .ok_or_else(|| anyhow!("no init"))
        }
        p if p.starts_with("v/") || p.starts_with("a/") => {
            let video = p.starts_with("v/");
            match p[2..].trim_end_matches(".m4s").parse::<u64>() {
                Ok(sq) => segment(video, sq).await.map(|b| cors(b, "video/mp4")),
                Err(_) => Err(anyhow!("bad sequence")),
            }
        }
        _ => Err(anyhow!("not found")),
    };
    report(&path);

    Ok(match res {
        Ok(r) => r,
        Err(e) => {
            // A failing fragment used to log at debug, so the first real stall in
            // the app showed as nothing but hls.js 404 spam with no cause. The
            // upstream status and the head it reported are the whole diagnosis,
            // so say them, throttled to one line a second rather than one per
            // retry.
            if path.starts_with("v/") || path.starts_with("a/") {
                static LAST: Lazy<Mutex<Option<Instant>>> = Lazy::new(|| Mutex::new(None));
                let say = LAST
                    .lock()
                    .ok()
                    .map(|mut g| {
                        let due = g.map(|t| t.elapsed() > Duration::from_secs(1)).unwrap_or(true);
                        if due {
                            *g = Some(Instant::now());
                        }
                        due
                    })
                    .unwrap_or(false);
                if say {
                    log::warn!("[YouTubeDash] {} -> {}", path, e);
                }
            } else {
                log::debug!("[YouTubeDash] {} -> {}", path, e);
            }
            fail_because(404, format!("{}: {}", path, e))
        }
    })
}

fn master() -> Result<String> {
    let g = SESSION.lock().map_err(|_| anyhow!("poisoned"))?;
    let s = g.as_ref().ok_or_else(|| anyhow!("no session"))?;
    Ok(format!(
        "#EXTM3U\n\
         #EXT-X-VERSION:7\n\
         #EXT-X-INDEPENDENT-SEGMENTS\n\
         #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"Audio\",DEFAULT=YES,AUTOSELECT=YES,URI=\"audio.m3u8\"\n\
         #EXT-X-STREAM-INF:BANDWIDTH={},RESOLUTION={}x{},FRAME-RATE={:.3},CODECS=\"{},{}\",AUDIO=\"aud\"\n\
         video.m3u8\n",
        s.bandwidth, s.width, s.height, s.fps, s.video_codec, AUDIO_CODEC
    ))
}

fn media_playlist(video: bool) -> Result<String> {
    let g = SESSION.lock().map_err(|_| anyhow!("poisoned"))?;
    let s = g.as_ref().ok_or_else(|| anyhow!("no session"))?;
    let head = if video { s.video_head } else { s.audio_head };
    if head == 0 {
        return Err(anyhow!("live edge unknown"));
    }
    let backoff = if video { s.video_backoff } else { s.audio_backoff };
    let newest = head.saturating_sub(backoff);
    let first = newest.saturating_sub(window_for(s.target) - 1);
    let (dir, init) = if video { ("v", "init_v.mp4") } else { ("a", "init_a.mp4") };

    let mut m = format!(
        "#EXTM3U\n\
         #EXT-X-VERSION:7\n\
         #EXT-X-TARGETDURATION:{}\n\
         #EXT-X-MEDIA-SEQUENCE:{}\n\
         #EXT-X-MAP:URI=\"{}\"\n",
        s.target.ceil() as u64,
        first,
        init
    );
    for n in first..=newest {
        m.push_str(&format!("#EXTINF:{:.3},\n{}/{}.m4s\n", s.target, dir, n));
    }
    Ok(m)
}

async fn segment(video: bool, sq: u64) -> Result<Bytes> {
    if let Some(hit) = cached_segment(video, sq) {
        return Ok(hit);
    }
    // `Bytes::from(Vec)` takes ownership of the remux buffer; the cache insert
    // and the served body then share it by refcount.
    let out = Bytes::from(fetch_and_remux(video, sq).await?);
    store_segment(video, sq, out.clone());
    // With this one served, warm the NEXT one so its round trip happens while the
    // player is still chewing on this segment instead of inside its next request.
    prefetch_next(video, sq);
    Ok(out)
}

/// Fetch one segment upstream and convert it to fMP4.
async fn fetch_and_remux(video: bool, sq: u64) -> Result<Vec<u8>> {
    let (vurl, aurl, _, _) = snapshot().ok_or_else(|| anyhow!("no session"))?;
    let base = if video { vurl } else { aurl };
    let (bytes, _head) = match fragment(&base, Some(sq), video).await {
        Ok(v) => v,
        Err(e) => {
            // Only a 404 means "not written yet". A 403 means the URL is no
            // longer authorised, and widening the backoff for it just walks
            // further from the edge while never fixing anything.
            if upstream_status(&e) != Some(403) {
                widen_backoff(video, sq);
            }
            return Err(e);
        }
    };
    // The remux is CPU-bound over a multi-megabyte buffer (a 1440p60 fragment
    // through a full WebM parser). Run inline it occupies an async worker for the
    // whole parse, so every other task on that thread — the playlist, the other
    // track's fetch, the next segment — waits behind it. That is invisible in a
    // serve-time measurement of THIS request and shows up as an unexplained
    // hitch elsewhere.
    tokio::task::spawn_blocking(move || {
        if video {
            let parsed = webm_fmp4::parse(&bytes)?;
            // Sequence number doubles as the moof sequence, which keeps it unique
            // and monotonic without tracking a separate counter.
            Ok(webm_fmp4::media_segment(sq as u32, &parsed))
        } else {
            let (_, media) = webm_fmp4::split_audio_fragment(&bytes)?;
            Ok(media)
        }
    })
    .await
    .map_err(|e| anyhow!("remux task failed: {}", e))?
}

/// Recently served segments, already remuxed. Bounded, and dropped whenever a
/// session starts so one broadcast can never serve another's bytes. Values are
/// `Bytes` so a cache hit serves by refcount instead of copying the segment.
static SEGMENTS: OnceLock<std::sync::Mutex<HashMap<(bool, u64), Bytes>>> = OnceLock::new();
/// Segments currently being prefetched, so a player request for the same one
/// does not start a second fetch alongside it.
static INFLIGHT: OnceLock<std::sync::Mutex<HashSet<(bool, u64)>>> = OnceLock::new();
/// A couple of seconds of look-ahead per track is all the player is ever ahead
/// by; more would just hold megabytes for segments it may never ask for.
const SEGMENT_CACHE_MAX: usize = 6;

fn segment_cache() -> &'static std::sync::Mutex<HashMap<(bool, u64), Bytes>> {
    SEGMENTS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn inflight() -> &'static std::sync::Mutex<HashSet<(bool, u64)>> {
    INFLIGHT.get_or_init(|| std::sync::Mutex::new(HashSet::new()))
}

fn cached_segment(video: bool, sq: u64) -> Option<Bytes> {
    segment_cache().lock().ok()?.get(&(video, sq)).cloned()
}

fn store_segment(video: bool, sq: u64, bytes: Bytes) {
    if let Ok(mut c) = segment_cache().lock() {
        // Keyed by sequence, so "oldest" is simply the lowest number on this
        // track. Live playback only ever moves forward.
        if c.len() >= SEGMENT_CACHE_MAX {
            if let Some(&oldest) = c.keys().filter(|(v, _)| *v == video).min_by_key(|(_, n)| *n) {
                c.remove(&oldest);
            }
        }
        c.insert((video, sq), bytes);
    }
}

/// Drop everything cached for the previous session.
fn clear_segment_cache() {
    if let Ok(mut c) = segment_cache().lock() {
        c.clear();
    }
    if let Ok(mut f) = inflight().lock() {
        f.clear();
    }
}

/// Warm `sq + 1` in the background.
///
/// Deliberately conservative: never past the live edge (that 404s, and a 404
/// widens the backoff, which would walk the playlist AWAY from live), never a
/// duplicate of something cached or already in flight, and failures are dropped
/// silently — this is an optimisation, and the real request will report any
/// genuine problem itself.
fn prefetch_next(video: bool, sq: u64) {
    let next = sq + 1;
    let head = {
        let Ok(g) = SESSION.lock() else { return };
        let Some(s) = g.as_ref() else { return };
        if video { s.video_head } else { s.audio_head }
    };
    if head == 0 || next >= head {
        return; // not written yet upstream
    }
    if cached_segment(video, next).is_some() {
        return;
    }
    {
        let Ok(mut f) = inflight().lock() else { return };
        if !f.insert((video, next)) {
            return; // already being fetched
        }
    }
    tokio::spawn(async move {
        let outcome = fetch_and_remux(video, next).await;
        if let Ok(bytes) = outcome {
            store_segment(video, next, Bytes::from(bytes));
        }
        if let Ok(mut f) = inflight().lock() {
            f.remove(&(video, next));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The relay keeps ONE session for the process, so these tests share it and
    /// must not overlap. Without this they pass or fail depending on scheduling,
    /// which is worse than failing.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_session<T>(target: f64, head: u64, f: impl FnOnce() -> T) -> T {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        *SESSION.lock().unwrap() = Some(Session {
            video_id: "vid".into(),
            above: 1080,
            itag: 308,
            issued: Instant::now(),
            video_url: "https://example/v".into(),
            audio_url: "https://example/a".into(),
            width: 2560,
            height: 1440,
            fps: 60.0,
            bandwidth: 9_016_000,
            video_codec: "vp09.00.50.08".into(),
            init_video: Bytes::from(vec![1, 2, 3]),
            init_audio: Bytes::from(vec![4, 5, 6]),
            target,
            video_head: head,
            audio_head: head,
            video_head_at: Instant::now(),
            audio_head_at: Instant::now(),
            video_backoff: EDGE_BACKOFF_START,
            audio_backoff: EDGE_BACKOFF_START,
        });
        let out = f();
        *SESSION.lock().unwrap() = None;
        out
    }


    /// Drive the WHOLE path against a live broadcast: VISIONOS resolve, relay
    /// start, playlist generation, fragment fetch, transmux. Writes the result
    /// so it can be handed to a real decoder, which is the only check that
    /// proves the bytes are playable rather than merely well-shaped.
    ///
    /// ```text
    /// STREAMNOOK_YT_LIVE_ID=<videoId> STREAMNOOK_DASH_OUT=<dir>     ///   cargo test end_to_end_against_a_live_broadcast -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "needs the network and a live 1440p+ broadcast"]
    async fn end_to_end_against_a_live_broadcast() {
        let id = std::env::var("STREAMNOOK_YT_LIVE_ID").expect("STREAMNOOK_YT_LIVE_ID");
        let highs =
            crate::services::providers::youtube_media::high_renditions(&id, 1080).await;
        assert!(!highs.is_empty(), "no renditions above 1080p");
        let r = &highs[0];
        println!("rendition {} itag={} {}x{}", r.name, r.itag, r.width, r.height);

        let url = start(&id, 1080, r).await.expect("start relay");
        println!("relay url {}", url);
        let base = url.split("/stream.m3u8").next().unwrap().to_string();

        let get = |p: String| {
            let c = HTTP.clone();
            async move { c.get(&p).send().await.expect("get").bytes().await.expect("body").to_vec() }
        };

        let master = String::from_utf8(get(format!("{}/stream.m3u8", base)).await).unwrap();
        println!("--- master ---
{}", master);
        assert!(master.contains("RESOLUTION="));
        assert!(master.contains("AUDIO=\"aud\""));

        let vpl = String::from_utf8(get(format!("{}/video.m3u8", base)).await).unwrap();
        println!("--- video.m3u8 (first lines) ---");
        for line in vpl.lines().take(8) {
            println!("{}", line);
        }
        assert!(vpl.contains("#EXT-X-MAP:URI=\"init_v.mp4\""));

        // Newest listed segment: the one the player would fetch first.
        let seg_name = vpl
            .lines()
            .filter(|l| l.starts_with("v/"))
            .next_back()
            .expect("a segment line")
            .to_string();

        let init_v = get(format!("{}/init_v.mp4", base)).await;
        let seg_v = get(format!("{}/{}", base, seg_name)).await;
        let init_a = get(format!("{}/init_a.mp4", base)).await;
        println!(
            "init_v={}B seg({})={}B init_a={}B",
            init_v.len(),
            seg_name,
            seg_v.len(),
            init_a.len()
        );
        assert!(init_v.len() > 100 && seg_v.len() > 10_000 && init_a.len() > 100);
        assert_eq!(&seg_v[4..8], b"moof", "segment must start with a moof");

        if let Ok(dir) = std::env::var("STREAMNOOK_DASH_OUT") {
            std::fs::create_dir_all(&dir).unwrap();
            let mut joined = init_v.clone();
            joined.extend_from_slice(&seg_v);
            std::fs::write(format!("{}/video.mp4", dir), &joined).unwrap();
            println!("wrote {}/video.mp4 ({} B)", dir, joined.len());
        }
        // Optionally keep serving so a real player can be pointed at it. This
        // is the only way to exercise hls.js and the WebView's own decoder,
        // which is where the remaining risk lives.
        if let Ok(secs) = std::env::var("STREAMNOOK_DASH_HOLD") {
            let secs: u64 = secs.parse().unwrap_or(60);
            println!("HOLDING relay at {} for {}s", base, secs);
            tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
        }
        stop();
    }

    #[test]
    fn master_pairs_the_video_variant_with_an_audio_group() {
        let m = with_session(5.0, 100, || master().unwrap());
        assert!(m.contains("RESOLUTION=2560x1440"));
        assert!(m.contains("CODECS=\"vp09.00.50.08,mp4a.40.2\""));
        // Without the audio group hls.js would play a silent video-only stream.
        assert!(m.contains("TYPE=AUDIO,GROUP-ID=\"aud\""));
        assert!(m.contains("AUDIO=\"aud\""));
    }

    #[test]
    fn media_playlist_holds_back_from_the_head() {
        // head is being written and head-1 has only just closed. Advertising
        // head-1 races the origin and 404s often enough to stall the player,
        // which is how this first failed in the app.
        let m = with_session(5.0, 100, || media_playlist(true).unwrap());
        assert!(m.contains("v/97.m4s"));
        assert!(!m.contains("v/98.m4s"), "the edge is further back than it looks");
        assert!(!m.contains("v/100.m4s"));
        assert!(m.contains("#EXT-X-MEDIA-SEQUENCE:92"));
        assert_eq!(m.matches("#EXTINF").count(), window_for(5.0) as usize);
        assert!(m.contains("#EXT-X-MAP:URI=\"init_v.mp4\""));
    }

    #[test]
    fn audio_playlist_points_at_its_own_init_and_directory() {
        let m = with_session(5.0, 100, || media_playlist(false).unwrap());
        assert!(m.contains("#EXT-X-MAP:URI=\"init_a.mp4\""));
        assert!(m.contains("a/97.m4s"));
        assert!(!m.contains("v/"));
    }

    #[test]
    fn the_playback_nonce_is_stable_within_a_session_and_new_between_them() {
        // Stable within a session because the origin reads it as playback
        // identity; new between sessions so a fresh stream is not taken for a
        // continuation of the last.
        reset_nonce();
        let a = playback_nonce();
        let b = playback_nonce();
        assert_eq!(a, b, "must not change mid-session");
        assert_eq!(a.chars().count(), 16);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        reset_nonce();
        assert_ne!(a, playback_nonce(), "a new session needs a new nonce");
    }

    #[test]
    fn the_window_covers_a_fixed_span_not_a_fixed_count() {
        // A count-based window is a 30s buffer at 5s segments and a 4s buffer at
        // 0.66s ones. The short case is what made playback fragile, so the span
        // is what is held constant.
        assert_eq!(window_for(5.0), 6);
        assert_eq!(window_for(2.0), 15);
        assert!(window_for(0.66) >= 45);
        // Degenerate input must not produce an empty playlist.
        assert_eq!(window_for(0.0), WINDOW_MIN);
    }

    #[test]
    fn each_track_uses_its_own_head() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // The bug this guards: audio and video number segments independently
        // (measured 13305 vs 13306 on one broadcast). Sharing a head makes the
        // lagging track request a segment that does not exist, and it 404s
        // forever because the head only ever moves forward.
        *SESSION.lock().unwrap() = Some(Session {
            video_id: "vid".into(),
            above: 1080,
            itag: 308,
            issued: Instant::now(),
            video_url: "https://example/v".into(),
            audio_url: "https://example/a".into(),
            width: 2560,
            height: 1440,
            fps: 60.0,
            bandwidth: 9_016_000,
            video_codec: "vp09.00.50.08".into(),
            init_video: Bytes::from(vec![1]),
            init_audio: Bytes::from(vec![2]),
            target: 5.0,
            video_head: 100,
            audio_head: 140,
            video_head_at: Instant::now(),
            audio_head_at: Instant::now(),
            video_backoff: EDGE_BACKOFF_START,
            audio_backoff: EDGE_BACKOFF_START,
        });
        let v = media_playlist(true).unwrap();
        let a = media_playlist(false).unwrap();
        *SESSION.lock().unwrap() = None;
        assert!(v.contains("v/97.m4s"), "video must follow the video head");
        assert!(!v.contains("138"), "video must not inherit the audio head");
        assert!(a.contains("a/137.m4s"), "audio must follow the audio head");
    }

    #[test]
    fn playlist_is_refused_until_the_live_edge_is_known() {
        // Serving a window computed from head 0 would advertise sequence 0, which
        // is always outside the DVR window and 404s every fragment.
        assert!(with_session(5.0, 0, || media_playlist(true)).is_err());
    }

    #[test]
    fn target_duration_rounds_up_so_it_never_understates_a_segment() {
        let m = with_session(4.967, 50, || media_playlist(true).unwrap());
        assert!(m.contains("#EXT-X-TARGETDURATION:5"));
        assert!(m.contains("#EXTINF:4.967,"));
    }

    #[test]
    fn window_clamps_at_the_start_of_a_stream() {
        let m = with_session(5.0, 3, || media_playlist(true).unwrap());
        assert!(m.contains("#EXT-X-MEDIA-SEQUENCE:0"));
        assert_eq!(m.matches("#EXTINF").count(), 1);
    }
}

#[cfg(test)]
mod rotation_tests {
    use super::*;

    #[test]
    fn only_proof_of_origin_urls_are_treated_as_perishable() {
        // visionos urls carry no token and last as long as their `expire` says,
        // so churning them would cost a player round trip for nothing.
        assert!(!is_gated("https://r1.googlevideo.com/videoplayback?itag=308&sq=5"));
        assert!(is_gated("https://r1.googlevideo.com/videoplayback?itag=308&pot=ABC"));
        assert!(is_gated("https://r1.googlevideo.com/videoplayback?pot=ABC&itag=308"));
        // `pot` has to be its own parameter, not a prefix of another one.
        assert!(!is_gated("https://r1.googlevideo.com/videoplayback?itag=308&potato=1"));
    }

    #[test]
    fn the_host_swaps_without_disturbing_anything_else() {
        let u = "https://rr1---sn-iv.googlevideo.com/videoplayback?itag=308&pot=A&sq=5";
        assert_eq!(
            with_host(u, "rr9---sn-iv.googlevideo.com").as_deref(),
            Some("https://rr9---sn-iv.googlevideo.com/videoplayback?itag=308&pot=A&sq=5")
        );
        assert_eq!(host_of(u), Some("rr1---sn-iv.googlevideo.com"));
        // A query string carrying slashes must not be mistaken for the path.
        let q = "https://a.example/videoplayback?u=x/y/z";
        assert_eq!(host_of(q), Some("a.example"));
        assert_eq!(
            with_host(q, "b.example").as_deref(),
            Some("https://b.example/videoplayback?u=x/y/z")
        );
    }

    #[test]
    fn a_url_without_a_path_is_left_alone_rather_than_mangled() {
        assert_eq!(with_host("https://a.example", "b.example"), None);
        assert_eq!(host_of("https://a.example"), None);
        assert_eq!(with_host("http://a.example/x", "b.example"), None);
    }

    #[test]
    fn the_window_stays_under_the_measured_wall() {
        // Gated urls were measured refusing at roughly thirty seconds; anything
        // at or above that would rotate only after playback had already broken.
        assert!(ROTATE_AFTER < Duration::from_secs(30));
        // The refresh is asynchronous, so there has to be real room for it to
        // finish while the current urls still work.
        assert!(
            Duration::from_secs(30) - ROTATE_AFTER >= Duration::from_secs(10),
            "not enough headroom for a background refresh to land"
        );
    }
}
