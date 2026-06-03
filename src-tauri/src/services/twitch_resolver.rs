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

/// Clip access-token GQL op hash (`VideoAccessToken_Clip`). Clip-specific, so it
/// lives here rather than in auth_proxy (which only owns the live/VOD
/// `PlaybackAccessToken` hash).
const CLIP_ACCESS_TOKEN_HASH: &str =
    "36b89d2507fce29e5ca551df756d27c1cfe079e2609642b4390aa4c35796eb11";

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
/// Twitch interleaves each rendition as `EXT-X-MEDIA` (TYPE=VIDEO) → then
/// `EXT-X-STREAM-INF` → then the URL line, repeated. This is the same layout
/// `auth_proxy::extract_high_tier_blocks` already relies on for splicing, so the
/// assumption is production-proven.
pub fn parse_master(master: &str) -> Vec<Variant> {
    let lines: Vec<&str> = master.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();
        if line.starts_with("#EXT-X-MEDIA:") && line.contains("TYPE=VIDEO") {
            let name = auth_proxy::extract_attr(line, "NAME").unwrap_or_default();
            let group_id = auth_proxy::extract_attr(line, "GROUP-ID").unwrap_or_default();

            let inf_idx = i + 1;
            let url_idx = i + 2;
            let inf_ok = inf_idx < lines.len()
                && lines[inf_idx]
                    .trim_start()
                    .starts_with("#EXT-X-STREAM-INF:");
            let url_ok = url_idx < lines.len()
                && !lines[url_idx].trim_start().starts_with('#')
                && !lines[url_idx].trim().is_empty();

            if inf_ok && url_ok {
                let inf = lines[inf_idx].trim();
                let (width, height) = parse_resolution(inf);
                let fps = auth_proxy::extract_attr(inf, "FRAME-RATE").and_then(|s| s.parse().ok());
                let codecs = auth_proxy::extract_attr(inf, "CODECS");
                let bandwidth =
                    auth_proxy::extract_attr(inf, "BANDWIDTH").and_then(|s| s.parse().ok());
                out.push(Variant {
                    name,
                    group_id,
                    width,
                    height,
                    fps,
                    codecs,
                    bandwidth,
                    url: lines[url_idx].trim().to_string(),
                });
                i += 3;
                continue;
            }
        }
        i += 1;
    }
    out
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

        let (master, status) = match (ttvlol, auth_master) {
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
        "extensions": {
            "persistedQuery": {
                "version": 1,
                "sha256Hash": CLIP_ACCESS_TOKEN_HASH,
            }
        },
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
