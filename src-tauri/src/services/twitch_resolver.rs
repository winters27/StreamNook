// Native Twitch stream resolution (no Streamlink subprocess).
//
// This is the in-Rust replacement for what Streamlink did with `--stream-url`:
// turn a channel + quality into the media-playlist URL the player loads.
//
// The fragile core (GQL PlaybackAccessToken, usher fetch, TTV-LOL proxy race,
// splice, out-of-band entitlement) already lives in `auth_proxy` and is reused
// here as plain function calls. The genuinely new pieces are the HLS master
// playlist parser (`parse_master`) and variant selection (`select_variant`),
// which mirror what Streamlink was doing after it received the master.
//
// Phase 1: this path runs behind the `native_resolver` settings flag (default
// off) and an agreement harness (`verify_resolver`) that logs native-vs-
// Streamlink resolution differences on real streams. VOD/clip land in Phase 2.

use crate::services::auth_proxy::{self, PlaybackStatus};
use crate::services::proxy_health;
use crate::services::quality::{pick_closest_quality, sort_qualities_descending};
use anyhow::{anyhow, Context, Result};
use log::debug;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// Clip access-token GQL op (`VideoAccessToken_Clip`). Sent as the full inline
/// query rather than a persisted-query hash: Twitch rotates the stored hashes and
/// returns `PersistedQueryNotFound` when ours goes stale, which would null out
/// `data.clip` and surface as a bogus "clip not found". The inline query has no
/// hash to look up, so it survives those rotations.
const CLIP_ACCESS_TOKEN_QUERY: &str = "\
query VideoAccessToken_Clip($slug: ID!) {\n\
  clip(slug: $slug) {\n\
    id\n\
    playbackAccessToken(params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: \"site\"}) {\n\
      signature\n\
      value\n\
    }\n\
    videoQualities {\n\
      frameRate\n\
      quality\n\
      sourceURL\n\
    }\n\
  }\n\
}";

/// One rendition from a Twitch master playlist (an `EXT-X-MEDIA` /
/// `EXT-X-STREAM-INF` / url triple).
#[derive(Debug, Clone)]
pub struct Variant {
    /// The `NAME` attribute, e.g. "1080p60", "480p", "audio_only". This is the
    /// quality label Streamlink surfaces; Twitch ships two shapes in the wild
    /// ("480p" vs "480p30"), so we keep it verbatim and let `pick_closest_quality`
    /// reconcile against the user's saved preference.
    pub name: String,
    /// The `GROUP-ID`. The source tier is `"chunked"`; that's what "best" maps to.
    pub group_id: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub codecs: Option<String>,
    pub bandwidth: Option<u64>,
    /// The media-playlist URL (absolute Twitch CDN / weaver URL). This is exactly
    /// what Streamlink printed under `--stream-url`.
    pub url: String,
}

/// Result of a native live resolution, shaped to fill `StreamStartResult`.
#[derive(Debug, Clone)]
pub struct ResolvedLive {
    /// Selected variant's media-playlist URL (what `StreamServer` should relay).
    pub url: String,
    /// The quality label actually served (sentinel kept for best/worst/audio_only;
    /// the matched variant name for numeric requests, so fallback notices fire).
    pub quality: String,
    /// Quality menu (variant names + best/worst), sorted highest-first.
    pub available: Vec<String>,
    /// Entitlement / proxy decision, for the UI ad-source badge.
    pub status: PlaybackStatus,
    /// The master playlist we parsed (kept for the agreement harness / debugging).
    pub master: String,
}

/// Parse a Twitch master playlist into its video renditions.
///
/// Anchored on `#EXT-X-STREAM-INF` (one per rendition), each paired with the next
/// non-comment URI line. This mirrors what Streamlink's HLS parser did and is the
/// reason it tolerated both master layouts Twitch ships:
///   - Legacy: a `#EXT-X-MEDIA:TYPE=VIDEO,NAME="1080p60",GROUP-ID="chunked"` tag
///     precedes each `#EXT-X-STREAM-INF` (the label lives in the MEDIA tag, linked
///     by the STREAM-INF's `VIDEO="..."` group).
///   - Modern (the "Transcode-ELT" / IVS stack served over the web/proxy path):
///     no `#EXT-X-MEDIA` tags at all; the label rides on the STREAM-INF itself as
///     `IVS-NAME="1080p60"` / `STABLE-VARIANT-ID` and the source rendition is
///     flagged `IVS-VARIANT-SOURCE="source"` instead of `GROUP-ID="chunked"`.
///
/// The previous version keyed off `#EXT-X-MEDIA:TYPE=VIDEO` and so silently parsed
/// to zero variants on the modern, MEDIA-less masters — the "master playlist had
/// no variants" failure.
pub fn parse_master(master: &str) -> Vec<Variant> {
    let lines: Vec<&str> = master.lines().collect();

    // Pass 1: legacy `#EXT-X-MEDIA:TYPE=VIDEO` renditions, keyed GROUP-ID → NAME.
    // Empty on modern masters; that's fine, the STREAM-INF carries the label there.
    let mut media_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for line in &lines {
        let l = line.trim();
        if l.starts_with("#EXT-X-MEDIA:") && l.contains("TYPE=VIDEO") {
            if let Some(gid) = auth_proxy::extract_attr(l, "GROUP-ID") {
                let name = auth_proxy::extract_attr(l, "NAME").unwrap_or_default();
                media_names.insert(gid, name);
            }
        }
    }

    // Pass 2: every `#EXT-X-STREAM-INF` + its following URI line is one variant.
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let inf = lines[i].trim();
        if !inf.starts_with("#EXT-X-STREAM-INF:") {
            i += 1;
            continue;
        }
        // The URL is the next non-comment, non-empty line.
        let mut j = i + 1;
        while j < lines.len() {
            let u = lines[j].trim();
            if u.is_empty() || u.starts_with('#') {
                j += 1;
                continue;
            }
            break;
        }
        if j >= lines.len() {
            break; // dangling STREAM-INF with no URL; nothing more to parse
        }

        let (width, height) = parse_resolution(inf);
        let fps = auth_proxy::extract_attr(inf, "FRAME-RATE").and_then(|s| s.parse().ok());
        let codecs = auth_proxy::extract_attr(inf, "CODECS");
        let bandwidth = auth_proxy::extract_attr(inf, "BANDWIDTH").and_then(|s| s.parse().ok());
        let video_group = auth_proxy::extract_attr(inf, "VIDEO");

        // The source ("best") rendition: legacy `GROUP-ID="chunked"` (via the
        // STREAM-INF's VIDEO link) or the modern `IVS-VARIANT-SOURCE="source"`.
        let is_source = video_group.as_deref() == Some("chunked")
            || auth_proxy::extract_attr(inf, "IVS-VARIANT-SOURCE")
                .is_some_and(|s| s.eq_ignore_ascii_case("source"));

        // Quality label, in priority: legacy MEDIA NAME (by group) → modern
        // IVS-NAME → STABLE-VARIANT-ID → derived from resolution → group id.
        let name = video_group
            .as_ref()
            .and_then(|g| media_names.get(g).cloned())
            .filter(|n| !n.is_empty())
            .or_else(|| auth_proxy::extract_attr(inf, "IVS-NAME"))
            .or_else(|| auth_proxy::extract_attr(inf, "STABLE-VARIANT-ID"))
            .or_else(|| derive_name(height, fps, codecs.as_deref()))
            .or_else(|| video_group.clone())
            .unwrap_or_default();

        let group_id = if is_source {
            "chunked".to_string()
        } else {
            video_group.clone().unwrap_or_default()
        };

        out.push(Variant {
            name,
            group_id,
            width,
            height,
            fps,
            codecs,
            bandwidth,
            url: lines[j].trim().to_string(),
        });
        i = j + 1;
    }
    out
}

/// Synthesize a quality label when the master carries no explicit name (neither a
/// legacy MEDIA NAME nor a modern IVS label). Resolution-bearing renditions become
/// `"1080p60"` / `"480p"`; a resolution-less audio rendition becomes `"audio_only"`.
fn derive_name(height: Option<u32>, fps: Option<f64>, codecs: Option<&str>) -> Option<String> {
    match height {
        Some(h) => {
            let f = fps.unwrap_or(30.0).round() as u32;
            // Twitch suffixes the framerate only for high-fps tiers ("1080p60"),
            // leaving 30fps tiers bare ("480p"), matching its own NAME shapes.
            if f >= 50 {
                Some(format!("{}p{}", h, f))
            } else {
                Some(format!("{}p", h))
            }
        }
        None => {
            let audio = codecs.is_some_and(|c| {
                c.contains("mp4a")
                    && !c.contains("avc")
                    && !c.contains("av01")
                    && !c.contains("hvc")
                    && !c.contains("hev")
            });
            audio.then(|| "audio_only".to_string())
        }
    }
}

/// Parse `RESOLUTION=1920x1080` into `(Some(1920), Some(1080))`.
fn parse_resolution(inf_line: &str) -> (Option<u32>, Option<u32>) {
    match auth_proxy::extract_attr(inf_line, "RESOLUTION") {
        Some(res) => {
            let mut parts = res.split(['x', 'X']);
            let w = parts.next().and_then(|p| p.trim().parse().ok());
            let h = parts.next().and_then(|p| p.trim().parse().ok());
            (w, h)
        }
        None => (None, None),
    }
}

/// The quality menu the player should show: every variant name plus the
/// `best`/`worst` aliases Streamlink synthesizes, sorted highest-first using the
/// existing ordering logic.
pub fn quality_names(variants: &[Variant]) -> Vec<String> {
    let mut names: Vec<String> = variants.iter().map(|v| v.name.clone()).collect();
    if !names.iter().any(|n| n.eq_ignore_ascii_case("best")) {
        names.push("best".to_string());
    }
    if !names.iter().any(|n| n.eq_ignore_ascii_case("worst")) {
        names.push("worst".to_string());
    }
    sort_qualities_descending(&mut names);
    names
}

/// Map a requested quality to a variant index plus the label actually served.
///
/// Mirrors Streamlink's behavior: `best`/`source` → the source ("chunked")
/// rendition (highest), `worst` → lowest video, `audio_only` → the audio
/// rendition, and a numeric request goes through `pick_closest_quality` so the
/// two Twitch naming shapes ("480p" vs "480p30") reconcile against the user's
/// saved preference. Returns `(index, label_to_report)`.
pub fn select_variant(variants: &[Variant], requested: &str) -> Option<(usize, String)> {
    if variants.is_empty() {
        return None;
    }
    let req = requested.trim().to_lowercase();

    if req == "best" || req == "source" {
        return best_index(variants).map(|i| (i, "best".to_string()));
    }
    if req == "worst" {
        return worst_index(variants).map(|i| (i, "worst".to_string()));
    }
    if req == "audio_only" || req == "audio-only" || req == "audio" {
        return audio_index(variants)
            .map(|i| (i, "audio_only".to_string()))
            .or_else(|| best_index(variants).map(|i| (i, "best".to_string())));
    }

    // Numeric request: reuse the exact matching the Streamlink path used.
    let names: Vec<String> = variants.iter().map(|v| v.name.clone()).collect();
    let chosen = pick_closest_quality(&req, &names)?;
    let idx = variants
        .iter()
        .position(|v| v.name.eq_ignore_ascii_case(&chosen))?;
    Some((idx, variants[idx].name.clone()))
}

/// "best" = the source rendition. Twitch tags it `GROUP-ID="chunked"`; if that's
/// absent, fall back to the highest (height, fps, bandwidth) video rendition.
fn best_index(variants: &[Variant]) -> Option<usize> {
    if let Some(i) = variants
        .iter()
        .position(|v| v.group_id.eq_ignore_ascii_case("chunked"))
    {
        return Some(i);
    }
    variants
        .iter()
        .enumerate()
        .filter(|(_, v)| v.height.is_some())
        .max_by(|(_, a), (_, b)| {
            a.height
                .cmp(&b.height)
                .then(
                    a.fps
                        .partial_cmp(&b.fps)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
                .then(a.bandwidth.cmp(&b.bandwidth))
        })
        .map(|(i, _)| i)
        .or(Some(0))
}

/// "worst" = the lowest-height video rendition (audio_only has no resolution and
/// is excluded). Falls back to the first rendition if none carry a resolution.
fn worst_index(variants: &[Variant]) -> Option<usize> {
    variants
        .iter()
        .enumerate()
        .filter(|(_, v)| v.height.is_some())
        .min_by(|(_, a), (_, b)| {
            a.height.cmp(&b.height).then(
                a.fps
                    .partial_cmp(&b.fps)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
        })
        .map(|(i, _)| i)
        .or(Some(0))
}

fn audio_index(variants: &[Variant]) -> Option<usize> {
    variants
        .iter()
        .position(|v| v.name.to_lowercase().contains("audio"))
}

/// Resolve a live channel to a media-playlist URL, fully in Rust.
///
/// Faithfully mirrors `auth_proxy::handle_playlist`'s routing, then parses the
/// resulting master and selects the requested variant instead of serving the
/// master over HTTP to a Streamlink subprocess:
///   - Tier 1/2: Turbo or channel-sub → authenticated master directly (ad-free,
///     full quality, credits the streamer), no proxy.
///   - Tier 3 (`use_proxy`): race the TTV-LOL proxies (bundled-pool fallback) and
///     the authed master in parallel, splice in the 1440p/2160p tiers.
///   - `use_proxy = false`: authenticated master only (no proxy/splice).
pub async fn resolve_live(
    channel: &str,
    oauth_token: Option<&str>,
    proxy_bases: &[String],
    use_proxy: bool,
    quality: &str,
) -> Result<ResolvedLive> {
    let channel = channel.to_lowercase();

    // Tier 1/2 — entitlement-first (only when logged in).
    if let Some(token) = oauth_token {
        let reason = if auth_proxy::account_has_turbo(token).await {
            Some("turbo")
        } else if auth_proxy::is_subscribed(&channel, token).await {
            Some("subscribed")
        } else {
            None
        };
        if let Some(reason) = reason {
            match auth_proxy::fetch_auth_master(&channel, token).await {
                Ok(master) => {
                    debug!(
                        "[Resolver] {} entitled ({}) → authed master direct",
                        channel, reason
                    );
                    let status = PlaybackStatus {
                        channel: channel.clone(),
                        mode: reason.to_string(),
                        entitled: true,
                        proxy_base: None,
                        proxy_region: None,
                    };
                    return build(channel, master, status, quality);
                }
                Err(e) => debug!(
                    "[Resolver] {} entitled ({}) but auth master failed ({}); falling through",
                    channel, reason, e
                ),
            }
        }
    }

    // Non-entitled (or anonymous / auth fetch failed).
    if use_proxy {
        // Tier 3 — proxy + splice. Race ad-free proxy master and authed master.
        let ttvlol_fut = auth_proxy::fetch_ttvlol_with_fallback(&channel, proxy_bases);
        let auth_fut = async {
            match oauth_token {
                Some(t) => auth_proxy::fetch_auth_master(&channel, t).await.map(Some),
                None => Ok(None),
            }
        };
        let (ttvlol, auth) = tokio::join!(ttvlol_fut, auth_fut);
        let auth_master = auth.unwrap_or(None);
        let auth_fallback = auth_master.clone();

        let (mut master, mut status) = match (ttvlol, auth_master) {
            (Ok((base, t)), Some(a)) => {
                let region = proxy_health::region_for_base(&base);
                (
                    auth_proxy::splice(&t, &a),
                    PlaybackStatus {
                        channel: channel.clone(),
                        mode: "proxy".to_string(),
                        entitled: false,
                        proxy_base: Some(base),
                        proxy_region: region,
                    },
                )
            }
            (Ok((base, t)), None) => {
                let region = proxy_health::region_for_base(&base);
                (
                    t,
                    PlaybackStatus {
                        channel: channel.clone(),
                        mode: "proxy".to_string(),
                        entitled: false,
                        proxy_base: Some(base),
                        proxy_region: region,
                    },
                )
            }
            (Err(e), Some(a)) => {
                debug!(
                    "[Resolver] {} proxy failed ({}); auth master only (ads)",
                    channel, e
                );
                (
                    a,
                    PlaybackStatus {
                        channel: channel.clone(),
                        mode: "auth-only".to_string(),
                        entitled: false,
                        proxy_base: None,
                        proxy_region: None,
                    },
                )
            }
            (Err(e1), None) => return Err(anyhow!("both fetches failed: ttvlol={}", e1)),
        };

        // Defense in depth: if the chosen master still parses to nothing (a proxy
        // served a shape we can't read, or an empty body), fall back to the
        // authenticated master when we have a usable one. This is Streamlink's
        // proxy→upstream fallback: an ad-bearing stream beats no stream.
        if parse_master(&master).is_empty() {
            if let Some(a) = auth_fallback.filter(|a| !parse_master(a).is_empty()) {
                debug!(
                    "[Resolver] {} proxy master had no usable variants; falling back to authed master",
                    channel
                );
                master = a;
                status = PlaybackStatus {
                    channel: channel.clone(),
                    mode: "auth-only".to_string(),
                    entitled: false,
                    proxy_base: None,
                    proxy_region: None,
                };
            }
        }

        build(channel, master, status, quality)
    } else {
        // Direct auth, no proxy. Requires a login.
        let token = oauth_token.ok_or_else(|| anyhow!("non-proxy mode requires a twitch login"))?;
        let master = auth_proxy::fetch_auth_master(&channel, token).await?;
        let status = PlaybackStatus {
            channel: channel.clone(),
            mode: "auth-only".to_string(),
            entitled: false,
            proxy_base: None,
            proxy_region: None,
        };
        build(channel, master, status, quality)
    }
}

/// Retry `resolve_live` until it succeeds or the time budget elapses — the
/// native equivalent of Streamlink's `--retry-streams` (which retries fetching
/// the stream list, waiting `retry_delay_secs` between attempts). This restores
/// the "open a channel the instant it goes live and connect once the playlist
/// appears" behavior: Twitch's GQL live-status can lag the real playlist by up
/// to a minute, so the first resolve attempt may legitimately find nothing.
///
/// `retry_delay_secs == 0` makes a single attempt (Streamlink's default of no
/// retries). `budget_secs` caps the total wait — Streamlink's retry is uncapped
/// unless `--retry-max` is set, and StreamNook historically bounded it with the
/// subprocess timeout, so we reuse `stream_timeout` as that ceiling. The first
/// attempt always runs even if the budget is tiny.
#[allow(clippy::too_many_arguments)]
pub async fn resolve_live_resilient(
    channel: &str,
    oauth_token: Option<&str>,
    proxy_bases: &[String],
    use_proxy: bool,
    quality: &str,
    retry_delay_secs: u32,
    budget_secs: u32,
) -> Result<ResolvedLive> {
    let start = Instant::now();
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        match resolve_live(channel, oauth_token, proxy_bases, use_proxy, quality).await {
            Ok(r) => return Ok(r),
            Err(e) => {
                let elapsed = start.elapsed().as_secs() as u32;
                // Stop if retries are disabled, or sleeping again would exceed
                // the budget.
                if retry_delay_secs == 0 || elapsed.saturating_add(retry_delay_secs) >= budget_secs
                {
                    return Err(e);
                }
                debug!(
                    "[Resolver] {} resolve attempt {} failed ({}); retrying in {}s",
                    channel, attempt, e, retry_delay_secs
                );
                tokio::time::sleep(Duration::from_secs(retry_delay_secs as u64)).await;
            }
        }
    }
}

/// Parse a fetched master, select the variant, and assemble the result.
fn build(
    channel: String,
    master: String,
    status: PlaybackStatus,
    quality: &str,
) -> Result<ResolvedLive> {
    let variants = parse_master(&master);
    if variants.is_empty() {
        // Log enough to tell apart the failure modes (empty body, error page,
        // unrecognized master shape) without dumping the whole playlist.
        let first = master.lines().next().unwrap_or("").trim();
        debug!(
            "[Resolver] {} no variants: {} bytes, stream-inf={}, first line: {:?}",
            channel,
            master.len(),
            master.matches("#EXT-X-STREAM-INF").count(),
            first
        );
        return Err(anyhow!("{}: master playlist had no variants", channel));
    }
    let (idx, label) = select_variant(&variants, quality)
        .ok_or_else(|| anyhow!("{}: no variant matched '{}'", channel, quality))?;
    let available = quality_names(&variants);
    Ok(ResolvedLive {
        url: variants[idx].url.clone(),
        quality: label,
        available,
        status,
        master,
    })
}

// ----- VOD + clip resolution (Phase 2) -----

/// A resolved VOD or clip: the URL the player should load plus the quality menu.
/// VODs resolve to an HLS media-playlist URL (served through `StreamServer` like
/// live); clips resolve to a signed MP4 URL the player loads directly.
#[derive(Debug, Clone)]
pub struct ResolvedMedia {
    pub url: String,
    pub quality: String,
    pub available: Vec<String>,
}

/// Extract the numeric VOD id from a `.../videos/123456789` URL.
pub fn vod_id_from_url(url: &str) -> Option<String> {
    let after = url.split("/videos/").nth(1)?;
    let id: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

/// Extract a clip slug from either `clips.twitch.tv/SLUG` or
/// `twitch.tv/<channel>/clip/SLUG` (with optional query/fragment).
pub fn clip_slug_from_url(url: &str) -> Option<String> {
    let raw = url
        .split("clips.twitch.tv/")
        .nth(1)
        .or_else(|| url.split("/clip/").nth(1))?;
    let slug = raw.split(['/', '?', '#']).next()?.trim();
    // Guard against the `clips.twitch.tv/embed?clip=...` shape landing here as
    // "embed"; that form carries the slug in the query and isn't handled.
    if slug.is_empty() || slug.eq_ignore_ascii_case("embed") {
        None
    } else {
        Some(slug.to_string())
    }
}

/// GQL `PlaybackAccessToken` (VOD variant) → usher `/vod/{id}` master playlist.
/// Same persisted-query hash as live; the response carries
/// `videoPlaybackAccessToken` (not `streamPlaybackAccessToken`) and usher uses
/// the `nauthsig`/`nauth` param names. No client-integrity needed for VODs.
async fn fetch_vod_master(vod_id: &str, oauth_token: Option<&str>) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(auth_proxy::USER_AGENT)
        .build()?;

    let gql_body = json!({
        "operationName": "PlaybackAccessToken",
        "extensions": {
            "persistedQuery": {
                "version": 1,
                "sha256Hash": auth_proxy::PLAYBACK_ACCESS_TOKEN_HASH,
            }
        },
        "variables": {
            "isLive": false,
            "login": "",
            "isVod": true,
            "vodID": vod_id,
            "playerType": "embed",
            "platform": "web",
        }
    });

    let mut req = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-ID", auth_proxy::TWITCH_WEB_CLIENT_ID)
        .json(&gql_body);
    if let Some(t) = oauth_token {
        req = req.header("Authorization", format!("OAuth {}", t));
    }
    let gql_resp: Value = req
        .send()
        .await
        .context("VOD GQL request failed")?
        .json()
        .await
        .context("VOD GQL response not JSON")?;

    let pat = gql_resp
        .pointer("/data/videoPlaybackAccessToken")
        .ok_or_else(|| anyhow!("GQL missing videoPlaybackAccessToken: {}", gql_resp))?;
    let sig = pat
        .get("signature")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("no VOD sig"))?;
    let value = pat
        .get("value")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("no VOD token value"))?;

    let usher = format!(
        "https://usher.ttvnw.net/vod/{id}?platform=web&player_type=embed&allow_source=true\
         &allow_audio_only=true&playlist_include_framerate=true&supported_codecs=av1,h264,h265\
         &nauthsig={sig}&nauth={tok}",
        id = vod_id,
        sig = sig,
        tok = urlencoding::encode(value),
    );

    let master = client
        .get(&usher)
        .header("Referer", "https://player.twitch.tv")
        .header("Origin", "https://player.twitch.tv")
        .send()
        .await
        .context("VOD usher request failed")?;
    if !master.status().is_success() {
        return Err(anyhow!("VOD usher returned {}", master.status()));
    }
    Ok(master.text().await?)
}

/// Resolve a VOD id to a media-playlist URL (parsed + variant-selected, same as
/// live). Served through `StreamServer` by the caller.
pub async fn resolve_vod(
    vod_id: &str,
    oauth_token: Option<&str>,
    quality: &str,
) -> Result<ResolvedMedia> {
    let master = fetch_vod_master(vod_id, oauth_token).await?;
    let variants = parse_master(&master);
    if variants.is_empty() {
        return Err(anyhow!("VOD {}: master playlist had no variants", vod_id));
    }
    let (idx, label) = select_variant(&variants, quality)
        .ok_or_else(|| anyhow!("VOD {}: no variant matched '{}'", vod_id, quality))?;
    Ok(ResolvedMedia {
        url: variants[idx].url.clone(),
        quality: label,
        available: quality_names(&variants),
    })
}

/// Pick a clip quality. Clips ship a flat list of `<height>p<fps>` MP4 qualities
/// (no `chunked`/audio aliases), so best = highest, worst = lowest, numeric goes
/// through the shared closest-match.
fn pick_clip_quality(requested: &str, names: &[String]) -> Option<String> {
    let mut sorted = names.to_vec();
    sort_qualities_descending(&mut sorted);
    match requested.trim().to_lowercase().as_str() {
        "best" | "source" => sorted.first().cloned(),
        "worst" => sorted.last().cloned(),
        _ => pick_closest_quality(requested, names),
    }
}

/// Append the clip access token to a clip MP4 `sourceURL` as `sig`/`token` query
/// params (the clip equivalent of usher's signed playlist URL).
fn with_clip_token(src: &str, sig: &str, token: &str) -> String {
    let sep = if src.contains('?') { '&' } else { '?' };
    format!(
        "{}{}sig={}&token={}",
        src,
        sep,
        urlencoding::encode(sig),
        urlencoding::encode(token)
    )
}

/// Resolve a clip slug to a signed MP4 URL. Clips use the `VideoAccessToken_Clip`
/// GQL op (not usher/HLS): it returns the access token plus a list of MP4
/// `videoQualities`, and the chosen MP4 is signed by appending the token.
pub async fn resolve_clip(
    slug: &str,
    oauth_token: Option<&str>,
    quality: &str,
) -> Result<ResolvedMedia> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(auth_proxy::USER_AGENT)
        .build()?;

    let body = json!({
        "operationName": "VideoAccessToken_Clip",
        "query": CLIP_ACCESS_TOKEN_QUERY,
        "variables": { "slug": slug }
    });

    let mut req = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-ID", auth_proxy::TWITCH_WEB_CLIENT_ID)
        .json(&body);
    if let Some(t) = oauth_token {
        req = req.header("Authorization", format!("OAuth {}", t));
    }
    let resp: Value = req
        .send()
        .await
        .context("clip GQL request failed")?
        .json()
        .await
        .context("clip GQL response not JSON")?;

    // A GQL-level error (e.g. `PersistedQueryNotFound`, a rejected op, an auth
    // problem) nulls out `data`, which is a different failure from a clip that
    // genuinely doesn't exist. Surface it as-is so it isn't misread as "clip not
    // found".
    if let Some(errors) = resp.get("errors").and_then(|v| v.as_array()) {
        if !errors.is_empty() {
            let msg = errors
                .iter()
                .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(anyhow!("clip GQL error for {}: {}", slug, msg));
        }
    }

    let clip = resp
        .pointer("/data/clip")
        .filter(|c| !c.is_null())
        .ok_or_else(|| anyhow!("clip not found: {}", slug))?;
    let sig = clip
        .pointer("/playbackAccessToken/signature")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("clip missing signature"))?;
    let token = clip
        .pointer("/playbackAccessToken/value")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("clip missing token value"))?;
    let qualities = clip
        .get("videoQualities")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow!("clip missing videoQualities"))?;

    // (name, sourceURL) pairs, named like the player UI ("1080p60").
    let mut variants: Vec<(String, String)> = Vec::new();
    for q in qualities {
        let src = q.get("sourceURL").and_then(|v| v.as_str()).unwrap_or("");
        let qual = q.get("quality").and_then(|v| v.as_str()).unwrap_or("");
        let fr = q.get("frameRate").and_then(|v| v.as_f64()).unwrap_or(0.0) as i64;
        if src.is_empty() || qual.is_empty() {
            continue;
        }
        variants.push((format!("{}p{}", qual, fr), src.to_string()));
    }
    if variants.is_empty() {
        return Err(anyhow!("clip {} had no playable qualities", slug));
    }

    let names: Vec<String> = variants.iter().map(|(n, _)| n.clone()).collect();
    let chosen = pick_clip_quality(quality, &names)
        .ok_or_else(|| anyhow!("clip {}: no quality matched '{}'", slug, quality))?;
    let src = variants
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(&chosen))
        .map(|(_, u)| u.clone())
        .ok_or_else(|| anyhow!("clip {}: chosen quality vanished", slug))?;

    let mut available = names;
    sort_qualities_descending(&mut available);
    Ok(ResolvedMedia {
        url: with_clip_token(&src, sig, token),
        quality: chosen,
        available,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // A realistic Twitch master: source ("chunked") + standard tiers + audio_only,
    // in the nickmercs shape (fps suffix on every tier).
    const MASTER_NICKMERCS: &str = "#EXTM3U\n\
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"chunked\",NAME=\"1080p60\",AUTOSELECT=YES,DEFAULT=YES\n\
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS=\"avc1.4D402A,mp4a.40.2\",VIDEO=\"chunked\",FRAME-RATE=60.000\n\
https://video-weaver.example/chunked.m3u8\n\
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"720p60\",NAME=\"720p60\",AUTOSELECT=YES,DEFAULT=NO\n\
#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1280x720,CODECS=\"avc1.4D401F,mp4a.40.2\",VIDEO=\"720p60\",FRAME-RATE=60.000\n\
https://video-weaver.example/720p60.m3u8\n\
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"480p30\",NAME=\"480p30\",AUTOSELECT=YES,DEFAULT=NO\n\
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=852x480,CODECS=\"avc1.4D401F,mp4a.40.2\",VIDEO=\"480p30\",FRAME-RATE=30.000\n\
https://video-weaver.example/480p30.m3u8\n\
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"160p30\",NAME=\"160p30\",AUTOSELECT=YES,DEFAULT=NO\n\
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=284x160,CODECS=\"avc1.4D400C,mp4a.40.2\",VIDEO=\"160p30\",FRAME-RATE=30.000\n\
https://video-weaver.example/160p30.m3u8\n\
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"audio_only\",NAME=\"audio_only\",AUTOSELECT=NO,DEFAULT=NO\n\
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS=\"mp4a.40.2\",VIDEO=\"audio_only\"\n\
https://video-weaver.example/audio_only.m3u8\n";

    // The modern "Transcode-ELT" / IVS master Twitch serves over the web/proxy
    // path: NO `#EXT-X-MEDIA` tags at all; the label rides on the STREAM-INF as
    // `IVS-NAME` and the source rendition is flagged `IVS-VARIANT-SOURCE="source"`.
    // Trimmed from a real `forsen` proxy response. The old parser parsed this to
    // zero variants ("master playlist had no variants").
    const MASTER_MODERN_IVS: &str = "#EXTM3U\n\
#EXT-X-SESSION-DATA:DATA-ID=\"NODE\",VALUE=\"x.cloudfront.hls.ttvnw.net\"\n\
#EXT-X-SESSION-DATA:DATA-ID=\"TRANSCODESTACK\",VALUE=\"2025-Transcode-ELT-V1\"\n\
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS=\"mp4a.40.2\",STABLE-VARIANT-ID=\"audio_only\",IVS-NAME=\"audio_only\",IVS-VARIANT-SOURCE=\"transcode\"\n\
https://euc11.playlist.ttvnw.net/audio.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=6895917,RESOLUTION=1920x1080,CODECS=\"avc1.64002A,mp4a.40.2\",FRAME-RATE=60.000,STABLE-VARIANT-ID=\"1080p60\",IVS-NAME=\"1080p60\",IVS-VARIANT-SOURCE=\"source\"\n\
https://euc11.playlist.ttvnw.net/1080.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=3422999,RESOLUTION=1280x720,CODECS=\"avc1.4D401F,mp4a.40.2\",FRAME-RATE=60.000,STABLE-VARIANT-ID=\"720p60\",IVS-NAME=\"720p60\",IVS-VARIANT-SOURCE=\"transcode\"\n\
https://euc11.playlist.ttvnw.net/720.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=1427999,RESOLUTION=852x480,CODECS=\"avc1.4D401F,mp4a.40.2\",FRAME-RATE=30.000,STABLE-VARIANT-ID=\"480p30\",IVS-NAME=\"480p\",IVS-VARIANT-SOURCE=\"transcode\"\n\
https://euc11.playlist.ttvnw.net/480.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=630000,RESOLUTION=640x360,CODECS=\"avc1.4D401F,mp4a.40.2\",FRAME-RATE=30.000,STABLE-VARIANT-ID=\"360p30\",IVS-NAME=\"360p\",IVS-VARIANT-SOURCE=\"transcode\"\n\
https://euc11.playlist.ttvnw.net/360.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=230000,RESOLUTION=284x160,CODECS=\"avc1.4D401F,mp4a.40.2\",FRAME-RATE=30.000,STABLE-VARIANT-ID=\"160p30\",IVS-NAME=\"160p\",IVS-VARIANT-SOURCE=\"transcode\"\n\
https://euc11.playlist.ttvnw.net/160.m3u8\n";

    fn parse() -> Vec<Variant> {
        parse_master(MASTER_NICKMERCS)
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn parses_all_renditions() {
        let v = parse();
        assert_eq!(v.len(), 5);
        assert_eq!(v[0].name, "1080p60");
        assert_eq!(v[0].group_id, "chunked");
        assert_eq!(v[0].height, Some(1080));
        assert_eq!(v[0].fps, Some(60.0));
        assert_eq!(v[0].url, "https://video-weaver.example/chunked.m3u8");
        assert_eq!(v[4].name, "audio_only");
        assert_eq!(v[4].height, None);
    }

    #[test]
    fn best_maps_to_chunked_source() {
        let v = parse();
        let (idx, label) = select_variant(&v, "best").unwrap();
        assert_eq!(label, "best");
        assert_eq!(v[idx].group_id, "chunked");
        assert_eq!(v[idx].url, "https://video-weaver.example/chunked.m3u8");
    }

    #[test]
    fn worst_maps_to_lowest_video_not_audio() {
        let v = parse();
        let (idx, label) = select_variant(&v, "worst").unwrap();
        assert_eq!(label, "worst");
        assert_eq!(v[idx].name, "160p30");
    }

    #[test]
    fn audio_only_selects_audio() {
        let v = parse();
        let (idx, label) = select_variant(&v, "audio_only").unwrap();
        assert_eq!(label, "audio_only");
        assert_eq!(v[idx].name, "audio_only");
    }

    #[test]
    fn exact_numeric_match() {
        let v = parse();
        let (idx, label) = select_variant(&v, "720p60").unwrap();
        assert_eq!(label, "720p60");
        assert_eq!(v[idx].url, "https://video-weaver.example/720p60.m3u8");
    }

    #[test]
    fn closest_when_requested_tier_absent() {
        // 1440p60 saved but channel maxes at 1080p60 → fall to 1080p60 (source).
        let v = parse();
        let (idx, label) = select_variant(&v, "1440p60").unwrap();
        assert_eq!(label, "1080p60");
        assert_eq!(v[idx].name, "1080p60");
    }

    #[test]
    fn reconciles_fps_suffix_mismatch() {
        // User saved "480p" (caedrel shape) but this channel ships "480p30".
        let v = parse();
        let (idx, _label) = select_variant(&v, "480p").unwrap();
        assert_eq!(v[idx].name, "480p30");
    }

    #[test]
    fn quality_menu_includes_aliases_sorted() {
        let v = parse();
        let names = quality_names(&v);
        assert_eq!(names.first().map(String::as_str), Some("1080p60"));
        assert!(names.iter().any(|n| n == "best"));
        assert!(names.iter().any(|n| n == "worst"));
        assert!(names.iter().any(|n| n == "audio_only"));
    }

    #[test]
    fn empty_master_yields_no_variants() {
        assert!(parse_master("#EXTM3U\n").is_empty());
        assert!(select_variant(&[], "best").is_none());
    }

    #[test]
    fn parses_modern_media_less_master() {
        // The regression case: a master with zero `#EXT-X-MEDIA` tags.
        let v = parse_master(MASTER_MODERN_IVS);
        assert_eq!(v.len(), 6, "audio_only + 5 video tiers");
        // audio_only first, no resolution.
        assert_eq!(v[0].name, "audio_only");
        assert_eq!(v[0].height, None);
        // Source rendition flagged by IVS-VARIANT-SOURCE="source", not GROUP-ID.
        assert_eq!(v[1].name, "1080p60");
        assert_eq!(v[1].group_id, "chunked");
        assert_eq!(v[1].height, Some(1080));
        assert_eq!(v[1].fps, Some(60.0));
        assert_eq!(v[1].url, "https://euc11.playlist.ttvnw.net/1080.m3u8");
        // Label comes from IVS-NAME ("480p"), not STABLE-VARIANT-ID ("480p30").
        assert_eq!(v[3].name, "480p");
    }

    #[test]
    fn modern_best_worst_audio_select() {
        let v = parse_master(MASTER_MODERN_IVS);
        let (bi, _) = select_variant(&v, "best").unwrap();
        assert_eq!(v[bi].name, "1080p60", "best → IVS source rendition");
        let (wi, _) = select_variant(&v, "worst").unwrap();
        assert_eq!(v[wi].name, "160p", "worst → lowest video, not audio");
        let (ai, _) = select_variant(&v, "audio_only").unwrap();
        assert_eq!(v[ai].name, "audio_only");
    }

    #[test]
    fn anonymous_master_no_source_flag_still_picks_best() {
        // The anonymous proxy master (e.g. symfuhny via TTVLOL): every tier is a
        // "transcode" — none is flagged IVS-VARIANT-SOURCE="source" and there's no
        // GROUP-ID="chunked". "best" must still resolve to the highest video tier,
        // not audio_only or nothing.
        let m = "#EXTM3U\n\
#EXT-X-STREAM-INF:BANDWIDTH=8042999,RESOLUTION=1920x1080,FRAME-RATE=60.000,IVS-NAME=\"1080p60\",IVS-VARIANT-SOURCE=\"transcode\"\n\
https://x/1080.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=3322199,RESOLUTION=1280x720,FRAME-RATE=60.000,IVS-NAME=\"720p60\",IVS-VARIANT-SOURCE=\"transcode\"\n\
https://x/720.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS=\"mp4a.40.2\",IVS-NAME=\"audio_only\",IVS-VARIANT-SOURCE=\"transcode\"\n\
https://x/audio.m3u8\n";
        let v = parse_master(m);
        assert_eq!(v.len(), 3);
        assert!(
            v.iter().all(|x| x.group_id != "chunked"),
            "none source-flagged"
        );
        let (bi, _) = select_variant(&v, "best").unwrap();
        assert_eq!(
            v[bi].name, "1080p60",
            "best falls back to highest video tier"
        );
        let (wi, _) = select_variant(&v, "worst").unwrap();
        assert_eq!(v[wi].name, "720p60", "worst is lowest video, not audio");
    }

    #[test]
    fn accepts_arbitrary_custom_resolution() {
        // Enhanced broadcasting lets streamers output non-standard resolutions in
        // OBS; the parser must accept any STREAM-INF, not an allow-list of tiers.
        let m = "#EXTM3U\n\
#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=2560x1440,CODECS=\"av01.0.13M.08,mp4a.40.2\",FRAME-RATE=60.000,IVS-NAME=\"1440p60\",IVS-VARIANT-SOURCE=\"source\"\n\
https://x/1440.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1664x936,FRAME-RATE=60.000,CODECS=\"avc1.4D401F,mp4a.40.2\"\n\
https://x/936.m3u8\n";
        let v = parse_master(m);
        assert_eq!(v.len(), 2);
        // 1440p source: labeled from IVS-NAME, flagged as the source rendition.
        assert_eq!(v[0].name, "1440p60");
        assert_eq!(v[0].group_id, "chunked");
        assert_eq!(v[0].height, Some(1440));
        // Custom 936p tier carries no label → derived from RESOLUTION + FRAME-RATE.
        assert_eq!(v[1].name, "936p60");
        assert_eq!(v[1].height, Some(936));
        // best → the 1440 source; the custom tier is still selectable by name.
        let (bi, _) = select_variant(&v, "best").unwrap();
        assert_eq!(v[bi].name, "1440p60");
        let (ci, _) = select_variant(&v, "936p60").unwrap();
        assert_eq!(v[ci].name, "936p60");
    }

    #[test]
    fn derives_label_from_resolution_when_unlabeled() {
        // No MEDIA tag and no IVS-NAME — fall back to RESOLUTION + FRAME-RATE.
        let m = "#EXTM3U\n\
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS=\"avc1.4D402A\"\n\
https://x/1080.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=852x480,FRAME-RATE=30.000,CODECS=\"avc1.4D401F\"\n\
https://x/480.m3u8\n";
        let v = parse_master(m);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].name, "1080p60");
        assert_eq!(v[1].name, "480p");
    }

    #[test]
    fn tolerates_lines_between_streaminf_and_url() {
        // A vendor comment / blank line between the STREAM-INF and its URL must
        // not drop the rendition (the old i+1/i+2 adjacency would have).
        let m = "#EXTM3U\n\
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,IVS-NAME=\"1080p60\",IVS-VARIANT-SOURCE=\"source\"\n\
\n\
#VENDOR-TAG:foo\n\
https://x/1080.m3u8\n";
        let v = parse_master(m);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].name, "1080p60");
        assert_eq!(v[0].group_id, "chunked");
        assert_eq!(v[0].url, "https://x/1080.m3u8");
    }

    #[test]
    fn error_page_body_is_not_a_master() {
        // The HTML/JSON error bodies the flaky proxies return with HTTP 200.
        assert!(!auth_proxy::looks_like_master(
            "<!DOCTYPE html><html><head><title>Server error!</title></head></html>"
        ));
        assert!(!auth_proxy::looks_like_master(
            "{\"code\":404,\"error\":\"HTTP status client error\"}"
        ));
        assert!(auth_proxy::looks_like_master(MASTER_MODERN_IVS));
        assert!(auth_proxy::looks_like_master(MASTER_NICKMERCS));
    }

    #[test]
    fn extracts_vod_id() {
        assert_eq!(
            vod_id_from_url("https://www.twitch.tv/videos/1234567890").as_deref(),
            Some("1234567890")
        );
        assert_eq!(
            vod_id_from_url("https://twitch.tv/videos/987654321?t=1h2m3s").as_deref(),
            Some("987654321")
        );
        assert_eq!(vod_id_from_url("https://twitch.tv/shroud"), None);
    }

    #[test]
    fn extracts_clip_slug_both_shapes() {
        assert_eq!(
            clip_slug_from_url("https://clips.twitch.tv/FunnySlugName-abc123").as_deref(),
            Some("FunnySlugName-abc123")
        );
        assert_eq!(
            clip_slug_from_url("https://www.twitch.tv/somechannel/clip/CoolSlug-xyz?featured=true")
                .as_deref(),
            Some("CoolSlug-xyz")
        );
        assert_eq!(clip_slug_from_url("https://twitch.tv/shroud"), None);
        assert_eq!(clip_slug_from_url("https://twitch.tv/videos/123"), None);
    }

    #[test]
    fn clip_quality_best_worst_numeric() {
        let names = s(&["360p30", "480p30", "720p60", "1080p60"]);
        assert_eq!(
            pick_clip_quality("best", &names).as_deref(),
            Some("1080p60")
        );
        assert_eq!(
            pick_clip_quality("worst", &names).as_deref(),
            Some("360p30")
        );
        assert_eq!(
            pick_clip_quality("720p60", &names).as_deref(),
            Some("720p60")
        );
    }

    #[test]
    fn clip_token_appends_query_params() {
        assert_eq!(
            with_clip_token("https://clips-media.example/clip.mp4", "SIG", "TOK"),
            "https://clips-media.example/clip.mp4?sig=SIG&token=TOK"
        );
        assert!(
            with_clip_token("https://x.example/clip.mp4?foo=bar", "SIG", "TOK")
                .contains("?foo=bar&sig=SIG&token=TOK")
        );
    }
}
