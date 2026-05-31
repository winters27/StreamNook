// Local HTTP splice server.
//
// Streamlink can take a `--twitch-proxy-playlist=<URL>` and treat the response
// as the master playlist. We point it at this server. Per request, we:
//   1) Call Twitch's GQL playbackAccessToken with the viewer's web cookie → 1440p tier
//   2) Fetch usher.ttvnw.net with the auth sig/token → auth'd master
//   3) Fetch the user's TTVLOL proxy in parallel → anonymous, ad-free master
//   4) Splice: TTVLOL master as base (ad-free for 160p–1080p), append the
//      1440p+ variants from the auth'd master.
// Streamlink then plays normally, segments fetched direct from Twitch CDN.

use crate::services::twitch_auth_service::{AuthError, TwitchAuthService};
use anyhow::{anyhow, Context, Result};
use futures::stream::{FuturesUnordered, StreamExt};
use log::{debug, info, warn};
use once_cell::sync::OnceCell;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use warp::{Filter, Reply};

/// Cache spliced master playlists briefly so streamlink's retries don't
/// trigger fresh upstream fetches every time.
const MASTER_TTL: Duration = Duration::from_secs(20);

#[derive(Clone)]
struct CachedMaster {
    body: String,
    cached_at: Instant,
}

static MASTER_CACHE: OnceCell<Mutex<HashMap<String, CachedMaster>>> = OnceCell::new();

fn cache_get(channel: &str) -> Option<String> {
    let lock = MASTER_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let map = lock.lock().unwrap();
    map.get(channel)
        .filter(|c| c.cached_at.elapsed() < MASTER_TTL)
        .map(|c| c.body.clone())
}

fn cache_put(channel: &str, body: String) {
    let lock = MASTER_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = lock.lock().unwrap();
    map.insert(
        channel.to_string(),
        CachedMaster {
            body,
            cached_at: Instant::now(),
        },
    );
}

const TWITCH_WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const PLAYBACK_ACCESS_TOKEN_HASH: &str =
    "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9";
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0";

#[derive(Clone)]
struct ServerConfig {
    ttvlol_proxy_bases: Vec<String>,
    twitch_auth: TwitchAuthService,
}

static SERVER: OnceCell<Mutex<RunningServer>> = OnceCell::new();

struct RunningServer {
    port: u16,
    config: std::sync::Arc<std::sync::RwLock<ServerConfig>>,
}

/// Serializes the splice server's first-time startup. MultiNook starts every
/// tile concurrently, so without this each `ensure_running` call would bind its
/// own server and race `SERVER.set` — the losers would error out and the caller
/// would fall back to the raw, ad-leaking proxy. The fast "already running" path
/// never touches this lock.
fn server_init_lock() -> &'static tokio::sync::Mutex<()> {
    static INIT: OnceCell<tokio::sync::Mutex<()>> = OnceCell::new();
    INIT.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Spin up (or reconfigure) the splice server, return its localhost port.
/// The `twitch_auth` service is the only path through which the playlist
/// handler obtains Twitch web cookies — no direct SQLite/cookie access here.
pub async fn ensure_running(ttvlol_proxy_arg: &str, twitch_auth: TwitchAuthService) -> Result<u16> {
    let bases = parse_proxy_bases(ttvlol_proxy_arg);

    // Already running: hot-swap config (proxy list and auth service ref) and
    // reuse the port. The shared `Arc<RwLock>` is what warp's route closure
    // reads on each request, so writes here are visible immediately.
    if let Some(lock) = SERVER.get() {
        let s = lock.lock().unwrap();
        {
            let mut cfg = s.config.write().unwrap();
            cfg.ttvlol_proxy_bases = bases;
            cfg.twitch_auth = twitch_auth;
        }
        return Ok(s.port);
    }

    // Not running yet — serialize startup so a burst of concurrent callers (every
    // MultiNook tile at once) elects a single server instead of racing.
    let _init = server_init_lock().lock().await;

    // Re-check under the lock: another caller may have started it while we waited.
    if let Some(lock) = SERVER.get() {
        let s = lock.lock().unwrap();
        {
            let mut cfg = s.config.write().unwrap();
            cfg.ttvlol_proxy_bases = bases;
            cfg.twitch_auth = twitch_auth;
        }
        return Ok(s.port);
    }

    let listener = std::net::TcpListener::bind("127.0.0.1:0").context("bind ephemeral port")?;
    let port = listener.local_addr()?.port();
    drop(listener);

    let config = std::sync::Arc::new(std::sync::RwLock::new(ServerConfig {
        ttvlol_proxy_bases: bases,
        twitch_auth,
    }));
    let cfg_for_route = config.clone();

    let cfg_filter = warp::any().map(move || cfg_for_route.clone());
    let route = warp::path!("playlist" / String)
        .and(warp::query::<HashMap<String, String>>())
        .and(cfg_filter)
        .and_then(handle_playlist);

    tokio::spawn(async move {
        warp::serve(route).run(([127, 0, 0, 1], port)).await;
    });

    SERVER
        .set(Mutex::new(RunningServer { port, config }))
        .map_err(|_| anyhow!("splice server already initialized"))?;

    info!("[AuthProxy] splice server listening on 127.0.0.1:{}", port);
    Ok(port)
}

/// Build the streamlink `--twitch-proxy-playlist` value pointing at this server.
pub fn streamlink_proxy_arg(port: u16) -> String {
    format!(
        "--twitch-proxy-playlist=http://127.0.0.1:{}/playlist/[channel]",
        port
    )
}

/// Parse `--twitch-proxy-playlist=URL1,URL2 --twitch-proxy-playlist-fallback`
/// down to a list of proxy base URLs.
fn parse_proxy_bases(arg: &str) -> Vec<String> {
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

async fn handle_playlist(
    channel: String,
    _query: HashMap<String, String>,
    config: std::sync::Arc<std::sync::RwLock<ServerConfig>>,
) -> Result<warp::reply::Response, std::convert::Infallible> {
    let channel = channel.trim_end_matches(".m3u8").to_string();
    let (bases, twitch_auth) = {
        let c = config.read().unwrap();
        (c.ttvlol_proxy_bases.clone(), c.twitch_auth.clone())
    };
    debug!("[AuthProxy] /playlist/{} (bases={})", channel, bases.len());

    if let Some(cached) = cache_get(&channel) {
        debug!("[AuthProxy] {} cache hit ({} bytes)", channel, cached.len());
        return Ok(warp::reply::with_header(
            cached,
            "content-type",
            "application/vnd.apple.mpegurl",
        )
        .into_response());
    }

    let token = match twitch_auth.get_token().await {
        Ok(t) => {
            info!("[AuthProxy] auth token acquired (len={})", t.len());
            Some(t)
        }
        Err(AuthError::NotLoggedIn) => {
            info!("[AuthProxy] no twitch login in WebView; serving anonymous master");
            None
        }
        Err(e) => {
            warn!(
                "[AuthProxy] auth service error: {}; serving anonymous master",
                e
            );
            None
        }
    };

    let ttvlol_fut = fetch_ttvlol_master_racing(&channel, &bases);
    let auth_fut = async {
        match &token {
            Some(t) => fetch_auth_master(&channel, t).await,
            None => Err(anyhow!("no auth token")),
        }
    };
    let (ttvlol, auth) = tokio::join!(ttvlol_fut, auth_fut);

    let body = match (ttvlol, auth) {
        (Ok(t), Ok(a)) => {
            let merged = splice(&t, &a);
            info!(
                "[AuthProxy] {} served spliced master ({} bytes)",
                channel,
                merged.len()
            );
            merged
        }
        (Ok(t), Err(e)) => {
            warn!(
                "[AuthProxy] {} auth fetch failed ({}); serving TTVLOL master only",
                channel, e
            );
            t
        }
        (Err(e), Ok(a)) => {
            warn!(
                "[AuthProxy] {} TTVLOL fetch failed ({}); serving auth master only",
                channel, e
            );
            a
        }
        (Err(e1), Err(e2)) => {
            warn!(
                "[AuthProxy] {} both fetches failed: ttvlol={} auth={}",
                channel, e1, e2
            );
            let err_body = format!("splice failed: ttvlol={} auth={}", e1, e2);
            return Ok(
                warp::reply::with_status(err_body, warp::http::StatusCode::BAD_GATEWAY)
                    .into_response(),
            );
        }
    };

    cache_put(&channel, body.clone());

    Ok(
        warp::reply::with_header(body, "content-type", "application/vnd.apple.mpegurl")
            .into_response(),
    )
}

/// GET TTVLOL proxy's master playlist (anonymous, region-shifted, ad-free).
/// Races all configured proxies in parallel, returns the first 2xx response.
async fn fetch_ttvlol_master_racing(channel: &str, bases: &[String]) -> Result<String> {
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
            Ok::<(String, String), anyhow::Error>((label, body))
        });
    }

    let mut last_err: Option<anyhow::Error> = None;
    while let Some(res) = futs.next().await {
        match res {
            Ok((label, body)) => {
                debug!("[AuthProxy] TTVLOL winner: {}", label);
                return Ok(body);
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
async fn fetch_auth_master(channel: &str, oauth_token: &str) -> Result<String> {
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
fn splice(ttvlol_master: &str, auth_master: &str) -> String {
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
fn extract_attr(line: &str, key: &str) -> Option<String> {
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

/// Pull `(EXT-X-MEDIA, EXT-X-STREAM-INF, url)` triples for tiers above 1080p.
fn extract_high_tier_blocks(master: &str) -> Vec<String> {
    let lines: Vec<&str> = master.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.starts_with("#EXT-X-MEDIA:") && line.contains("TYPE=VIDEO") {
            let height = parse_name_height(line).unwrap_or(0);
            if height > 1080 {
                let media_line = line;
                let mut block = String::new();
                if i + 1 < lines.len() && lines[i + 1].starts_with("#EXT-X-STREAM-INF:") {
                    let inf_line = lines[i + 1];
                    if i + 2 < lines.len() && !lines[i + 2].starts_with('#') {
                        let url_line = lines[i + 2];
                        block.push_str(media_line);
                        block.push('\n');
                        block.push_str(inf_line);
                        block.push('\n');
                        block.push_str(url_line);
                        out.push(block);
                        i += 3;
                        continue;
                    }
                }
            }
        }
        i += 1;
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
}
