// Twitch stream resolution primitives (GQL PlaybackAccessToken → usher master,
// TTV-LOL proxy racing, splice, and out-of-band entitlement detection). These
// are the building blocks `twitch_resolver` composes; this module no longer runs
// any local HTTP server (that only existed to feed a Streamlink subprocess).

use crate::services::proxy_health;
use anyhow::{anyhow, Context, Result};
use futures::stream::{FuturesUnordered, StreamExt};
use log::{debug, info, warn};
use once_cell::sync::OnceCell;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(crate) const TWITCH_WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
pub(crate) const PLAYBACK_ACCESS_TOKEN_HASH: &str =
    "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9";
pub(crate) const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0";

// Out-of-band entitlement detection.
//
// The PlaybackAccessToken `turbo`/`subscriber` flags are vestigial — verified
// 2026-06-02 they read false even for a Turbo account fetched from twitch.tv
// itself, so they CANNOT decide ad-free routing. Instead we ask Twitch
// directly: `currentUser.hasTurbo` (account-wide) and
// `user.self.subscriptionBenefit` (per channel). Twitch applies the ad bypass
// at the usher/SSAI layer keyed on the authenticated session, so the authed
// manifest is genuinely ad-free for an entitled viewer (proven: anonymous
// manifests stitch a `twitch-stitched-ad` pod at the same instant the authed
// one stays clean). When entitled we serve the authed master directly and skip
// the proxy entirely.
const TURBO_TTL: Duration = Duration::from_secs(1800); // 30 min; Turbo rarely changes
const SUB_TTL: Duration = Duration::from_secs(600); // 10 min per channel

static TURBO_CACHE: OnceCell<Mutex<Option<(bool, Instant)>>> = OnceCell::new();
static SUB_CACHE: OnceCell<Mutex<HashMap<String, (bool, Instant)>>> = OnceCell::new();

/// POST an inline GQL query with the viewer's web cookie; return the JSON body.
async fn gql_query(oauth_token: &str, body: serde_json::Value) -> Result<serde_json::Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(USER_AGENT)
        .build()?;
    let resp: serde_json::Value = client
        .post("https://gql.twitch.tv/gql")
        .header("Authorization", format!("OAuth {}", oauth_token))
        .header("Client-ID", TWITCH_WEB_CLIENT_ID)
        .json(&body)
        .send()
        .await
        .context("gql request failed")?
        .json()
        .await
        .context("gql response not JSON")?;
    Ok(resp)
}

/// Account-wide Turbo status (`currentUser.hasTurbo`). Cached for `TURBO_TTL`.
/// A Turbo account is ad-free on EVERY channel via the authenticated stream.
pub(crate) async fn account_has_turbo(oauth_token: &str) -> bool {
    {
        let lock = TURBO_CACHE.get_or_init(|| Mutex::new(None));
        if let Some((val, at)) = *lock.lock().unwrap() {
            if at.elapsed() < TURBO_TTL {
                return val;
            }
        }
    }
    let body = serde_json::json!({ "query": "query{currentUser{hasTurbo}}" });
    let turbo = match gql_query(oauth_token, body).await {
        Ok(v) => v
            .pointer("/data/currentUser/hasTurbo")
            .and_then(|x| x.as_bool())
            .unwrap_or(false),
        Err(e) => {
            warn!("[AuthProxy] hasTurbo query failed: {}", e);
            false
        }
    };
    TURBO_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap()
        .replace((turbo, Instant::now()));
    turbo
}

/// Whether the viewer has an active sub to `channel`
/// (`user.self.subscriptionBenefit` non-null). Cached per channel for `SUB_TTL`.
/// A subbed channel is ad-free via the authenticated stream — same usher
/// mechanism as Turbo, scoped to that channel.
pub(crate) async fn is_subscribed(channel: &str, oauth_token: &str) -> bool {
    {
        let lock = SUB_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        if let Some((val, at)) = lock.lock().unwrap().get(channel).copied() {
            if at.elapsed() < SUB_TTL {
                return val;
            }
        }
    }
    let body = serde_json::json!({
        "query": "query($l:String!){user(login:$l){self{subscriptionBenefit{id}}}}",
        "variables": { "l": channel }
    });
    let subbed = match gql_query(oauth_token, body).await {
        Ok(v) => v
            .pointer("/data/user/self/subscriptionBenefit")
            .map(|x| !x.is_null())
            .unwrap_or(false),
        Err(e) => {
            warn!("[AuthProxy] sub-status query for {} failed: {}", channel, e);
            false
        }
    };
    SUB_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .insert(channel.to_string(), (subbed, Instant::now()));
    subbed
}

/// What the splice server decided for a channel, surfaced to the UI (so it can
/// say "Subscribed — native ad-free, no proxy" vs "Ad-block proxy: EU") and
/// read by the pivot logic to know which region is currently in use.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PlaybackStatus {
    pub channel: String,
    /// "turbo" | "subscribed" | "hide_ads" | "proxy" | "auth-only"
    pub mode: String,
    /// True when relying on Twitch's own ad-free entitlement (no proxy).
    pub entitled: bool,
    /// Winning proxy base URL when the proxy path was used.
    pub proxy_base: Option<String>,
    /// Region label for that base (NA/EU/RU/...), best-effort.
    pub proxy_region: Option<String>,
}

static STATUS: OnceCell<Mutex<HashMap<String, PlaybackStatus>>> = OnceCell::new();

pub(crate) fn set_status(status: PlaybackStatus) {
    let lock = STATUS.get_or_init(|| Mutex::new(HashMap::new()));
    lock.lock().unwrap().insert(status.channel.clone(), status);
}

/// Most recent playback decision for a channel (for the UI and pivot logic).
pub fn get_status(channel: &str) -> Option<PlaybackStatus> {
    let lock = STATUS.get_or_init(|| Mutex::new(HashMap::new()));
    let map = lock.lock().unwrap();
    map.get(channel).cloned()
}

/// Parse `--twitch-proxy-playlist=URL1,URL2 --twitch-proxy-playlist-fallback`
/// down to a list of proxy base URLs.
pub(crate) fn parse_proxy_bases(arg: &str) -> Vec<String> {
    let mut out = Vec::new();
    for tok in arg.split_whitespace() {
        if let Some(val) = tok.strip_prefix("--twitch-proxy-playlist=") {
            for u in val.split(',') {
                let u = u.trim().trim_end_matches('/');
                if !u.is_empty() && (u.starts_with("http://") || u.starts_with("https://")) {
                    out.push(u.to_string());
                }
            }
        }
    }
    out
}

/// Race the configured proxies first; if they ALL fail, fall back to racing the
/// rest of the bundled pool. A single optimized proxy going down (or the health
/// check picking one that pings but can't actually serve a playlist) must not
/// take ad-blocking down with it — as long as any bundled proxy is alive, we
/// serve an ad-free master rather than silently dropping to the ad-bearing
/// authenticated stream. Returns `(winning_base, master_body)`.
pub(crate) async fn fetch_ttvlol_with_fallback(
    channel: &str,
    configured: &[String],
) -> Result<(String, String)> {
    match fetch_ttvlol_master_racing(channel, configured).await {
        Ok(win) => Ok(win),
        Err(e) => {
            let configured_set: std::collections::HashSet<&str> =
                configured.iter().map(|s| s.trim_end_matches('/')).collect();
            let pool: Vec<String> = proxy_health::get_bundled_proxies()
                .proxies
                .into_iter()
                .map(|p| p.url.trim_end_matches('/').to_string())
                .filter(|u| !configured_set.contains(u.as_str()))
                .collect();
            if pool.is_empty() {
                return Err(e);
            }
            warn!(
                "[AuthProxy] {} configured proxies failed ({}); falling back to {} bundled proxies",
                channel,
                e,
                pool.len()
            );
            fetch_ttvlol_master_racing(channel, &pool).await
        }
    }
}

/// True if `body` is actually an HLS master playlist (carries at least one
/// `#EXT-X-STREAM-INF`). The TTVLOL proxies are flaky and routinely answer with
/// HTTP 200 + an HTML "Server error!" page or a JSON `{"error":...}` body; without
/// this check those sail past the status test into the parser, which then finds no
/// variants and fails the whole stream. Treating a non-master 2xx as a miss lets
/// the race try another proxy and ultimately fall back to the authenticated master
/// (the chain Streamlink relied on).
pub(crate) fn looks_like_master(body: &str) -> bool {
    body.contains("#EXT-X-STREAM-INF")
}

/// GET TTVLOL proxy's master playlist (anonymous, region-shifted, ad-free).
/// Races all configured proxies in parallel, returns the first 2xx response whose
/// body is a real master playlist.
async fn fetch_ttvlol_master_racing(channel: &str, bases: &[String]) -> Result<(String, String)> {
    if bases.is_empty() {
        return Err(anyhow!("no TTVLOL proxy bases configured"));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(USER_AGENT)
        .build()?;

    let mut futs = FuturesUnordered::new();
    for base in bases {
        let raw = format!(
            "{}/playlist/{}.m3u8?platform=web&allow_source=true&allow_audio_only=true&fast_bread=true&supported_codecs=av1,h264,h265",
            base, channel
        );
        // The 2bc4 plugin does `quote(url, safe=":/")` on the whole URL before
        // GET — that turns `?`, `=`, `&`, `,` into `%3F`, `%3D`, `%26`, `%2C`,
        // making the query string part of the URL path. TTVLOL proxies parse
        // this mangled shape; a clean `?param=value` URL gets 500'd.
        let url = quote_safe_colon_slash(&raw);
        let c = client.clone();
        let label = base.clone();
        futs.push(async move {
            let resp = c
                .get(&url)
                .header("Referer", "https://player.twitch.tv")
                .header("Origin", "https://player.twitch.tv")
                .send()
                .await
                .map_err(|e| anyhow!("{} → {}", label, e))?;
            if !resp.status().is_success() {
                return Err(anyhow!("{} → HTTP {}", label, resp.status()));
            }
            let body = resp
                .text()
                .await
                .map_err(|e| anyhow!("{} → body: {}", label, e))?;
            if !looks_like_master(&body) {
                let first = body.lines().next().unwrap_or("").trim().to_string();
                return Err(anyhow!(
                    "{} → 2xx but not a master playlist ({} bytes, first line: {:?})",
                    label,
                    body.len(),
                    first
                ));
            }
            Ok::<(String, String), anyhow::Error>((label, body))
        });
    }

    let mut last_err: Option<anyhow::Error> = None;
    while let Some(res) = futs.next().await {
        match res {
            Ok((label, body)) => {
                debug!("[AuthProxy] TTVLOL winner: {}", label);
                return Ok((label, body));
            }
            Err(e) => {
                debug!("[AuthProxy] TTVLOL miss: {}", e);
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("all TTVLOL proxies failed")))
}

/// Auth'd direct Twitch fetch: GQL playbackAccessToken → usher master.
/// Returns the master playlist body (which carries the 1440p variant).
pub(crate) async fn fetch_auth_master(channel: &str, oauth_token: &str) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(USER_AGENT)
        .build()?;

    let gql_body = serde_json::json!({
        "operationName": "PlaybackAccessToken",
        "extensions": {
            "persistedQuery": {
                "version": 1,
                "sha256Hash": PLAYBACK_ACCESS_TOKEN_HASH,
            }
        },
        "variables": {
            "isLive": true,
            "login": channel,
            "isVod": false,
            "vodID": "",
            "playerType": "embed",
            "platform": "site",
        }
    });

    let gql_resp: serde_json::Value = client
        .post("https://gql.twitch.tv/gql")
        .header("Authorization", format!("OAuth {}", oauth_token))
        .header("Client-ID", TWITCH_WEB_CLIENT_ID)
        .json(&gql_body)
        .send()
        .await
        .context("GQL request failed")?
        .json()
        .await
        .context("GQL response not JSON")?;

    let pat = gql_resp
        .get("data")
        .and_then(|d| d.get("streamPlaybackAccessToken"))
        .ok_or_else(|| anyhow!("GQL missing streamPlaybackAccessToken: {}", gql_resp))?;
    let sig = pat
        .get("signature")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("no sig"))?;
    let value = pat
        .get("value")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("no token value"))?;

    let usher = format!(
        "https://usher.ttvnw.net/api/channel/hls/{ch}.m3u8\
         ?platform=web&player_type=embed&allow_source=true&allow_audio_only=true\
         &playlist_include_framerate=true&supported_codecs=av1,h264,h265&fast_bread=true\
         &sig={sig}&token={tok}",
        ch = channel,
        sig = sig,
        tok = urlencoding::encode(value),
    );

    let master = client
        .get(&usher)
        .header("Referer", "https://player.twitch.tv")
        .header("Origin", "https://player.twitch.tv")
        .send()
        .await
        .context("usher request failed")?;
    if !master.status().is_success() {
        return Err(anyhow!("usher returned {}", master.status()));
    }
    Ok(master.text().await?)
}

/// Splice strategy: keep TTVLOL master entirely as the base, then append the
/// `EXT-X-MEDIA` + `EXT-X-STREAM-INF` + URL blocks for any tier in the auth'd
/// master that resolves higher than 1080 (i.e. 1440p, 2160p). Those tiers
/// don't exist in the TTVLOL anonymous master because Twitch caps anonymous
/// viewers at FULL_HD.
pub(crate) fn splice(ttvlol_master: &str, auth_master: &str) -> String {
    let mut out = ttvlol_master.trim_end().to_string();
    let blocks = extract_high_tier_blocks(auth_master);
    if !blocks.is_empty() {
        out.push('\n');
        for b in &blocks {
            // Log the actual RESOLUTION + CODECS of every high-tier variant we
            // merge in. This is the durable proof that what's labeled "1440p60"
            // in the final playlist really points to a 2560x1440 av01 variant
            // from Twitch's authenticated master, not a relabel of a lower tier.
            if let Some(stream_inf) = b.lines().find(|l| l.starts_with("#EXT-X-STREAM-INF:")) {
                let res = extract_attr(stream_inf, "RESOLUTION").unwrap_or("?".into());
                let codecs = extract_attr(stream_inf, "CODECS").unwrap_or("?".into());
                let video = extract_attr(stream_inf, "VIDEO").unwrap_or("?".into());
                info!(
                    "[AuthProxy] spliced variant VIDEO={} RESOLUTION={} CODECS={}",
                    video, res, codecs
                );
            }
            out.push_str(b);
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    out
}

/// Pull an attribute value out of an `EXT-X-STREAM-INF` line. Handles both
/// quoted (CODECS="...", VIDEO="...") and unquoted (RESOLUTION=1920x1080) forms.
pub(crate) fn extract_attr(line: &str, key: &str) -> Option<String> {
    let needle_q = format!("{}=\"", key);
    if let Some(pos) = line.find(&needle_q) {
        let rest = &line[pos + needle_q.len()..];
        let end = rest.find('"')?;
        return Some(rest[..end].to_string());
    }
    let needle = format!("{}=", key);
    let pos = line.find(&needle)?;
    let rest = &line[pos + needle.len()..];
    let end = rest.find(',').unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// Pull the playlist blocks for tiers above 1080p (1440p / 2160p) so they can be
/// spliced into the anonymous proxy master, which Twitch caps at FULL_HD.
///
/// Anchored on `#EXT-X-STREAM-INF` (same as the resolver's parser) so it works on
/// both master layouts: it reads the height from `RESOLUTION` (falling back to the
/// `NAME`/`IVS-NAME` label) and emits the STREAM-INF + URL, preceded by the legacy
/// `#EXT-X-MEDIA` tag when one is present so the label survives on older masters.
fn extract_high_tier_blocks(master: &str) -> Vec<String> {
    let lines: Vec<&str> = master.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let inf = lines[i];
        if !inf.trim_start().starts_with("#EXT-X-STREAM-INF:") {
            i += 1;
            continue;
        }
        // URL = next non-comment, non-empty line.
        let mut j = i + 1;
        while j < lines.len()
            && (lines[j].trim().is_empty() || lines[j].trim_start().starts_with('#'))
        {
            j += 1;
        }
        if j >= lines.len() {
            break;
        }
        let res_h = extract_attr(inf, "RESOLUTION")
            .and_then(|r| {
                r.split(['x', 'X'])
                    .nth(1)
                    .and_then(|h| h.trim().parse::<u32>().ok())
            })
            .unwrap_or(0);
        let height = res_h.max(parse_name_height(inf).unwrap_or(0));
        if height > 1080 {
            let mut block = String::new();
            // Carry the preceding legacy MEDIA tag along if there is one.
            if i > 0 {
                let prev = lines[i - 1].trim_start();
                if prev.starts_with("#EXT-X-MEDIA:") && prev.contains("TYPE=VIDEO") {
                    block.push_str(lines[i - 1]);
                    block.push('\n');
                }
            }
            block.push_str(inf);
            block.push('\n');
            block.push_str(lines[j].trim());
            out.push(block);
        }
        i = j + 1;
    }
    out
}

/// Percent-encodes everything except RFC 3986 unreserved chars + `:` and `/`.
/// The TTVLOL proxies require URLs in this shape.
fn quote_safe_colon_slash(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for ch in s.chars() {
        let safe = matches!(ch,
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '.' | '_' | '~' | ':' | '/'
        );
        if safe {
            out.push(ch);
        } else {
            let mut buf = [0u8; 4];
            let bytes = ch.encode_utf8(&mut buf).as_bytes().to_owned();
            for b in &bytes {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

/// Parse the height (e.g. `1440`) from a `NAME="1440p60"` attribute.
fn parse_name_height(line: &str) -> Option<u32> {
    let pos = line.find("NAME=\"")? + 6;
    let rest = &line[pos..];
    let end = rest.find('"')?;
    let name = &rest[..end];
    let digits: String = name.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_height_from_name() {
        assert_eq!(
            parse_name_height(r#"#EXT-X-MEDIA:NAME="1440p60",TYPE=VIDEO"#),
            Some(1440)
        );
        assert_eq!(
            parse_name_height(r#"#EXT-X-MEDIA:NAME="1080p60",TYPE=VIDEO"#),
            Some(1080)
        );
        assert_eq!(
            parse_name_height(r#"#EXT-X-MEDIA:NAME="audio_only",TYPE=VIDEO"#),
            None
        );
    }

    #[test]
    fn parses_proxy_bases_from_streamlink_arg() {
        let arg = "--twitch-proxy-playlist=https://lb-na.cdn-perfprod.com,https://eu.luminous.dev --twitch-proxy-playlist-fallback";
        let bases = parse_proxy_bases(arg);
        assert_eq!(
            bases,
            vec![
                "https://lb-na.cdn-perfprod.com".to_string(),
                "https://eu.luminous.dev".to_string(),
            ]
        );
    }

    #[test]
    fn quote_encodes_all_but_colon_slash() {
        // Verifies every byte except `:` and `/` is percent-encoded.
        let raw = "https://eu.luminous.dev/playlist/nickmercs.m3u8?platform=web&supported_codecs=av1,h264,h265";
        let got = quote_safe_colon_slash(raw);
        assert_eq!(
            got,
            "https://eu.luminous.dev/playlist/nickmercs.m3u8%3Fplatform%3Dweb%26supported_codecs%3Dav1%2Ch264%2Ch265"
        );
    }

    #[test]
    fn splice_appends_high_tier_blocks() {
        let ttvlol = "#EXTM3U\n\
            #EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"1080p60\",NAME=\"1080p60\",AUTOSELECT=YES,DEFAULT=YES\n\
            #EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS=\"avc1.4D401F,mp4a.40.2\",VIDEO=\"1080p60\",FRAME-RATE=60.000\n\
            https://example.com/ttvlol-1080.m3u8\n";
        let auth = "#EXTM3U\n\
            #EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"1440p60\",NAME=\"1440p60\",AUTOSELECT=YES,DEFAULT=YES\n\
            #EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=2560x1440,CODECS=\"av01.0.13M.08,mp4a.40.2\",VIDEO=\"1440p60\",FRAME-RATE=60.000\n\
            https://example.com/auth-1440.m3u8\n\
            #EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"1080p60\",NAME=\"1080p60\",AUTOSELECT=YES,DEFAULT=YES\n\
            #EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS=\"avc1.4D401F,mp4a.40.2\",VIDEO=\"1080p60\",FRAME-RATE=60.000\n\
            https://example.com/auth-1080.m3u8\n";
        let merged = splice(ttvlol, auth);
        assert!(
            merged.contains("ttvlol-1080.m3u8"),
            "ttvlol master preserved"
        );
        assert!(merged.contains("auth-1440.m3u8"), "1440p variant added");
        assert!(
            !merged.contains("auth-1080.m3u8"),
            "auth 1080p not duplicated"
        );
    }

    #[test]
    fn splice_handles_modern_media_less_auth_master() {
        // Modern IVS auth master (no MEDIA tags): the 1440p tier must still be
        // pulled in by RESOLUTION, and 1080p must not be duplicated.
        let ttvlol = "#EXTM3U\n\
            #EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS=\"avc1.4D401F\",FRAME-RATE=60.000,IVS-NAME=\"1080p60\",IVS-VARIANT-SOURCE=\"source\"\n\
            https://example.com/ttvlol-1080.m3u8\n";
        let auth = "#EXTM3U\n\
            #EXT-X-STREAM-INF:BANDWIDTH=14000000,RESOLUTION=2560x1440,CODECS=\"av01.0.13M.08\",FRAME-RATE=60.000,IVS-NAME=\"1440p60\",IVS-VARIANT-SOURCE=\"source\"\n\
            https://example.com/auth-1440.m3u8\n\
            #EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS=\"avc1.4D401F\",FRAME-RATE=60.000,IVS-NAME=\"1080p60\",IVS-VARIANT-SOURCE=\"transcode\"\n\
            https://example.com/auth-1080.m3u8\n";
        let blocks = extract_high_tier_blocks(auth);
        assert_eq!(blocks.len(), 1, "only the 1440p tier is above 1080p");
        assert!(blocks[0].contains("auth-1440.m3u8"));

        let merged = splice(ttvlol, auth);
        assert!(merged.contains("ttvlol-1080.m3u8"), "ttvlol base preserved");
        assert!(merged.contains("auth-1440.m3u8"), "1440p spliced in");
        assert!(!merged.contains("auth-1080.m3u8"), "1080p not duplicated");
    }
}
