//! Inline link previews for chat.
//!
//! Given a URL pasted in chat, returns a small metadata card payload the UI can
//! render inline. Three shapes:
//!   - YouTube: keyless oEmbed for title/author + the always-present hqdefault
//!     thumbnail derived from the video id.
//!   - Direct image: the URL itself is the image.
//!   - Generic: fetch the page and read its OpenGraph / Twitter-card / <title>
//!     meta tags via `scraper`.
//!
//! The fetch runs here (not in the webview) so it sidesteps CORS, and so the UI
//! never has to touch arbitrary chat-pasted URLs directly. Results are cached
//! in-process with a TTL: many chatters paste the same link, and several chat
//! widgets/windows share this backend. The frontend gates WHICH urls reach this
//! command (a trusted-domain allowlist), so this never auto-fetches the whole
//! firehose.

use crate::services::twitch_service::TwitchService;
use log::debug;
use regex::Regex;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LinkPreview {
    pub url: String,
    /// "youtube" | "image" | "generic" | "tweet"
    pub kind: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub site_name: Option<String>,
    pub author: Option<String>,
    /// Author avatar (used by the "tweet" kind).
    pub author_avatar: Option<String>,
    /// Present for the "youtube" and "clip" kinds.
    pub video_id: Option<String>,
    /// View count (the "clip" kind).
    pub view_count: Option<u64>,
    /// Length in seconds (the "clip" kind).
    pub duration: Option<f64>,
}

// Chat links are ephemeral — no preview cache is kept. Each request resolves
// fresh and is forgotten. We read only the page <head> (OG / Twitter-card /
// <title> meta all live there), capped so a huge page never downloads in full —
// that full-body download + full-DOM parse is what made slow/large pages take
// many seconds to preview.
const HEAD_SCAN_CAP: usize = 512 * 1024;

// --- HTTP client -----------------------------------------------------------

/// Dedicated client with a desktop browser UA. Many sites only emit OG tags to
/// "real" browsers, and a short timeout keeps a slow/hostile host from holding
/// a slot. 10s is plenty for a HEAD-of-document meta read.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        )
        .timeout(Duration::from_secs(10))
        .build()
        .expect("Failed to build link-preview HTTP client")
});

// --- Tauri command ---------------------------------------------------------

#[tauri::command]
pub async fn fetch_link_preview(url: String) -> Result<LinkPreview, String> {
    // Only ever touch http(s). Guards against `javascript:` / `file:` / `data:`
    // and other schemes the regex on the frontend shouldn't pass anyway.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Unsupported URL scheme".to_string());
    }

    build_preview(&url).await
}

async fn build_preview(url: &str) -> Result<LinkPreview, String> {
    // twitter.com now redirects to x.com — normalize so both get identical
    // handling (and the card opens the x.com variant).
    let canonical = canonicalize_x(url);
    let url = canonical.as_str();

    if let Some(video_id) = youtube_id(url) {
        return Ok(youtube_preview(url, &video_id).await);
    }
    if is_youtube_channel(url) {
        return youtube_channel_preview(url).await;
    }
    if let Some((handle, id)) = tweet_ref(url) {
        return tweet_preview(url, handle.as_deref(), &id).await;
    }
    if let Some(handle) = x_profile_handle(url) {
        return x_profile_preview(url, &handle).await;
    }
    if is_giphy(url) {
        return giphy_preview(url).await;
    }
    if let Some(clip_id) = twitch_clip_id(url) {
        return twitch_clip_preview(url, &clip_id).await;
    }
    if let Some(vod_id) = twitch_vod_id(url) {
        return twitch_vod_preview(url, &vod_id).await;
    }
    if is_image_url(url) {
        return Ok(LinkPreview {
            url: url.to_string(),
            kind: "image".to_string(),
            title: None,
            description: None,
            image: Some(url.to_string()),
            site_name: None,
            author: None,
            author_avatar: None,
            video_id: None,
            view_count: None,
            duration: None,
        });
    }

    let mut preview = fetch_generic(url).await?;
    // Imgur gallery/album/post pages: the og:image IS the real image, but the
    // og:description is Imgur's generic site boilerplate ("Discover the magic of
    // the internet at Imgur..."). Render it image-led (the "media" kind) and
    // drop the boilerplate so it reads like a picture, not an ad for Imgur.
    if is_imgur_page(url) {
        if preview.image.is_some() {
            preview.kind = "media".to_string();
        }
        preview.description = None;
    }
    Ok(preview)
}

// --- YouTube ---------------------------------------------------------------

static YT_ID_RE: LazyLock<Regex> = LazyLock::new(|| {
    // watch?v=, &v=, youtu.be/, shorts/, live/, embed/, v/
    Regex::new(r"(?:youtu\.be/|youtube\.com/(?:shorts/|live/|embed/|v/)|[?&]v=)([A-Za-z0-9_-]{11})")
        .expect("youtube id regex")
});

fn youtube_id(url: &str) -> Option<String> {
    if !(url.contains("youtube.com") || url.contains("youtu.be")) {
        return None;
    }
    YT_ID_RE
        .captures(url)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

async fn youtube_preview(url: &str, video_id: &str) -> LinkPreview {
    // hqdefault always exists for a valid id (maxresdefault can 404).
    let thumbnail = format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", video_id);
    let mut title = None;
    let mut author = None;

    // Keyless oEmbed for title/author. Failure is non-fatal: we still have a
    // perfectly good thumbnail card.
    match CLIENT
        .get("https://www.youtube.com/oembed")
        .query(&[("url", url), ("format", "json")])
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                title = json
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(|s| truncate(s, 300));
                author = json
                    .get("author_name")
                    .and_then(|v| v.as_str())
                    .map(|s| truncate(s, 120));
            }
        }
        Ok(resp) => debug!("[LinkPreview] yt oembed status {}", resp.status()),
        Err(e) => debug!("[LinkPreview] yt oembed error: {}", e),
    }

    LinkPreview {
        url: url.to_string(),
        kind: "youtube".to_string(),
        title,
        description: None,
        image: Some(thumbnail),
        site_name: Some("YouTube".to_string()),
        author,
        author_avatar: None,
        video_id: Some(video_id.to_string()),
        view_count: None,
        duration: None,
    }
}

// --- YouTube channels / profiles -------------------------------------------

static YT_CHANNEL_RE: LazyLock<Regex> = LazyLock::new(|| {
    // @handle, /channel/<id>, /c/<name>, /user/<name>. A bare /@handle is the
    // modern form; the others are legacy. Trailing subpaths (/videos, /about)
    // are fine — we only need to know it's a channel, not a video.
    Regex::new(r"youtube\.com/(?:@[A-Za-z0-9_.\-]+|channel/[A-Za-z0-9_\-]+|c/[^/?#]+|user/[^/?#]+)")
        .expect("youtube channel regex")
});

fn is_youtube_channel(url: &str) -> bool {
    url.contains("youtube.com") && YT_CHANNEL_RE.is_match(url)
}

/// A YouTube channel page serves the channel name (og:title), the square avatar
/// (og:image, e.g. a 900x900 `yt3.googleusercontent.com` image), and the channel
/// description (og:description) to a normal browser UA, so a plain OG scrape is
/// enough. We just reshape it into a profile-style card: the avatar moves to
/// `author_avatar` so the UI renders it as a centered circle (the generic card's
/// square left-thumbnail crops oddly for an avatar), and the kind is tagged so it
/// gets the YouTube glyph.
async fn youtube_channel_preview(url: &str) -> Result<LinkPreview, String> {
    let mut preview = fetch_generic(url).await?;
    preview.kind = "youtube_channel".to_string();
    preview.author_avatar = preview.image.take();
    preview.site_name = Some("YouTube".to_string());
    Ok(preview)
}

// --- Twitter / X -----------------------------------------------------------

/// Rewrite a twitter.com (or www/mobile/m subdomain) URL to its x.com
/// equivalent so both variants get identical handling. Anchored at the scheme so
/// a stray "twitter.com" inside a path/query isn't touched.
fn canonicalize_x(url: &str) -> String {
    let lower = url.to_lowercase();
    for host in [
        "twitter.com",
        "www.twitter.com",
        "mobile.twitter.com",
        "m.twitter.com",
    ] {
        for scheme in ["https://", "http://"] {
            let prefix = format!("{}{}", scheme, host);
            if lower.starts_with(&prefix) {
                let rest = &url[prefix.len()..];
                if rest.is_empty() || rest.starts_with(['/', '?', '#']) {
                    return format!("{}x.com{}", scheme, rest);
                }
            }
        }
    }
    url.to_string()
}

static TWEET_RE: LazyLock<Regex> = LazyLock::new(|| {
    // Optional handle, then status/<id>. Covers x.com, twitter.com, and the
    // /i/status/<id> form (no handle).
    Regex::new(r"(?:twitter\.com|x\.com)/(?:([A-Za-z0-9_]{1,15})/)?status(?:es)?/(\d+)")
        .expect("tweet url regex")
});

fn tweet_ref(url: &str) -> Option<(Option<String>, String)> {
    if !(url.contains("x.com") || url.contains("twitter.com")) {
        return None;
    }
    let caps = TWEET_RE.captures(url)?;
    let handle = caps
        .get(1)
        .map(|m| m.as_str().to_string())
        .filter(|h| h != "i" && h != "web"); // /i/status, /web/status are not handles
    let id = caps.get(2)?.as_str().to_string();
    Some((handle, id))
}

async fn tweet_preview(url: &str, handle: Option<&str>, id: &str) -> Result<LinkPreview, String> {
    // FixTweet's keyless JSON unfurler. Fetching through it (rather than x.com
    // directly) is what makes tweets render at all now that X bot-walls its own
    // pages to logged-out clients, and as a side effect X never sees the
    // viewer's IP. Any failure falls back to a plain OG scrape of the URL.
    let handle_seg = handle.unwrap_or("i");
    let api = format!("https://api.fxtwitter.com/{}/status/{}", handle_seg, id);

    let resp = match CLIENT
        .get(&api)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            debug!("[LinkPreview] fxtwitter status {}", r.status());
            return fetch_generic(url).await;
        }
        Err(e) => {
            debug!("[LinkPreview] fxtwitter error: {}", e);
            return fetch_generic(url).await;
        }
    };

    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(e) => {
            debug!("[LinkPreview] fxtwitter json error: {}", e);
            return fetch_generic(url).await;
        }
    };

    let tweet = match json.get("tweet") {
        Some(t) => t,
        None => return fetch_generic(url).await,
    };

    let text = tweet
        .get("text")
        .and_then(|v| v.as_str())
        .map(|s| truncate(s, 600));
    let author = tweet.get("author");
    let name = author
        .and_then(|a| a.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| truncate(s, 120));
    let screen = author
        .and_then(|a| a.get("screen_name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let avatar = author
        .and_then(|a| a.get("avatar_url"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // First usable media image: a photo's url, otherwise a video/gif thumbnail.
    let image = tweet
        .get("media")
        .and_then(|m| m.get("all"))
        .and_then(|all| all.as_array())
        .and_then(|arr| {
            arr.iter().find_map(|item| {
                let media_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if media_type == "photo" {
                    item.get("url").and_then(|v| v.as_str()).map(String::from)
                } else {
                    item.get("thumbnail_url")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                }
            })
        });

    // Nothing usable -> let the generic path have a go at the raw URL.
    if text.is_none() && name.is_none() {
        return fetch_generic(url).await;
    }

    Ok(LinkPreview {
        url: url.to_string(),
        kind: "tweet".to_string(),
        title: name,
        description: text,
        image,
        site_name: Some("X".to_string()),
        author: screen.map(|s| format!("@{}", s)),
        author_avatar: avatar,
        video_id: None,
        view_count: None,
        duration: None,
    })
}

// X profile links (x.com/<handle>, no /status/). Bare handle only — paths like
// /home, /i/..., /<handle>/status/... are excluded.
static X_PROFILE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^https?://x\.com/([A-Za-z0-9_]{1,15})/?(?:\?|#|$)").expect("x profile regex")
});

// First-path segments on x.com that are routes, not user handles.
const X_RESERVED: &[&str] = &[
    "i",
    "home",
    "explore",
    "search",
    "notifications",
    "messages",
    "settings",
    "compose",
    "intent",
    "hashtag",
    "share",
    "login",
    "signup",
    "about",
    "tos",
    "privacy",
    "help",
    "account",
    "logout",
    "status",
];

fn x_profile_handle(url: &str) -> Option<String> {
    let handle = X_PROFILE_RE.captures(url)?.get(1)?.as_str();
    if X_RESERVED.contains(&handle.to_lowercase().as_str()) {
        return None;
    }
    Some(handle.to_string())
}

async fn x_profile_preview(url: &str, handle: &str) -> Result<LinkPreview, String> {
    // FixTweet's keyless user endpoint — same rationale as the tweet path.
    let api = format!("https://api.fxtwitter.com/{}", handle);
    let resp = match CLIENT
        .get(&api)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            debug!("[LinkPreview] fxtwitter user status {}", r.status());
            return fetch_generic(url).await;
        }
        Err(e) => {
            debug!("[LinkPreview] fxtwitter user error: {}", e);
            return fetch_generic(url).await;
        }
    };

    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(_) => return fetch_generic(url).await,
    };
    let user = match json.get("user") {
        Some(u) => u,
        None => return fetch_generic(url).await,
    };

    let name = user
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| truncate(s, 120));
    let screen = user
        .get("screen_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let bio = user
        .get("description")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| truncate(s, 400));
    // Upscale the avatar from the API's _normal (48px) to _400x400.
    let avatar = user
        .get("avatar_url")
        .and_then(|v| v.as_str())
        .map(|s| s.replace("_normal.", "_400x400."));
    let banner = user
        .get("banner_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if name.is_none() && screen.is_none() {
        return fetch_generic(url).await;
    }

    // Reuse the "tweet" card layout: avatar + name + @handle + X glyph, bio as
    // the body text, banner as the media image.
    Ok(LinkPreview {
        url: url.to_string(),
        kind: "tweet".to_string(),
        title: name,
        description: bio,
        image: banner,
        site_name: Some("X".to_string()),
        author: screen.map(|s| format!("@{}", s)),
        author_avatar: avatar,
        video_id: None,
        view_count: None,
        duration: None,
    })
}

// --- Giphy -----------------------------------------------------------------

static GIPHY_ID_RE: LazyLock<Regex> = LazyLock::new(|| {
    // Trailing alphanumeric id within a single path segment (the slug ends in
    // `-<id>`; embed/media forms have the bare id).
    Regex::new(r"giphy\.com/(?:gifs|clips|embed|stickers|media)/(?:[^/?#]*-)?([A-Za-z0-9]{5,})")
        .expect("giphy id regex")
});

fn is_giphy(url: &str) -> bool {
    url.contains("giphy.com") || url.contains("gph.is")
}

fn giphy_gif_from_url(url: &str) -> Option<String> {
    let id = GIPHY_ID_RE.captures(url)?.get(1)?.as_str();
    Some(format!("https://media.giphy.com/media/{}/giphy.gif", id))
}

async fn giphy_preview(url: &str) -> Result<LinkPreview, String> {
    let make = |gif: String| LinkPreview {
        url: url.to_string(),
        kind: "image".to_string(),
        title: None,
        description: None,
        image: Some(gif),
        site_name: Some("GIPHY".to_string()),
        author: None,
        author_avatar: None,
        video_id: None,
        view_count: None,
        duration: None,
    };

    // Giphy's keyless oEmbed resolves any giphy page/clip/short-link to the
    // direct gif URL. The gif renders inline animated via a plain <img>.
    match CLIENT
        .get("https://giphy.com/services/oembed")
        .query(&[("url", url)])
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(gif) = json.get("url").and_then(|v| v.as_str()) {
                    return Ok(make(gif.to_string()));
                }
            }
        }
        Ok(resp) => debug!("[LinkPreview] giphy oembed status {}", resp.status()),
        Err(e) => debug!("[LinkPreview] giphy oembed error: {}", e),
    }

    // Fallback: derive the gif URL straight from the id in the page URL.
    if let Some(gif) = giphy_gif_from_url(url) {
        return Ok(make(gif));
    }

    // Last resort (e.g. a gph.is short link the regex can't read): let the
    // generic path follow redirects and read the page's og:image.
    fetch_generic(url).await
}

// --- Twitch clips ----------------------------------------------------------

static TWITCH_CLIP_RE: LazyLock<Regex> = LazyLock::new(|| {
    // clips.twitch.tv/<slug>, clips.twitch.tv/embed?clip=<slug>,
    // (www.|m.)twitch.tv/<channel>/clip/<slug>, twitch.tv/clip/<slug>.
    // Clip slugs are [A-Za-z0-9_-]; the optional channel segment has no hyphens.
    Regex::new(
        r"(?:clips\.twitch\.tv/(?:embed\?clip=)?|twitch\.tv/(?:[A-Za-z0-9_]{1,25}/)?clip/)([A-Za-z0-9_-]+)",
    )
    .expect("twitch clip regex")
});

fn twitch_clip_id(url: &str) -> Option<String> {
    if !url.contains("twitch.tv") {
        return None;
    }
    TWITCH_CLIP_RE
        .captures(url)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

/// Resolve a Twitch clip via Helix `/clips?id=`. A plain OG scrape of a clip page
/// only yields Twitch's generic "world's leading video platform" boilerplate
/// (the page is client-rendered), so we ask the API directly. Reuses the logged-
/// in user's token — they're in chat, so they have one. Any failure (not logged
/// in, network, deleted clip) falls back to the generic scrape, which is exactly
/// the prior behavior, so this never regresses an existing card.
async fn twitch_clip_preview(url: &str, clip_id: &str) -> Result<LinkPreview, String> {
    let token = match TwitchService::get_token().await {
        Ok(t) => t,
        Err(e) => {
            debug!("[LinkPreview] twitch clip: no token ({})", e);
            return fetch_generic(url).await;
        }
    };

    let resp = match CLIENT
        .get("https://api.twitch.tv/helix/clips")
        .query(&[("id", clip_id)])
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", token))
        .header("Client-Id", env!("TWITCH_APP_CLIENT_ID"))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            debug!("[LinkPreview] twitch clips status {}", r.status());
            return fetch_generic(url).await;
        }
        Err(e) => {
            debug!("[LinkPreview] twitch clips error: {}", e);
            return fetch_generic(url).await;
        }
    };

    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(_) => return fetch_generic(url).await,
    };

    // data[] is empty for a deleted/invalid clip — let the generic path try.
    let clip = match json
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
    {
        Some(c) => c,
        None => return fetch_generic(url).await,
    };

    let str_field = |key: &str| {
        clip.get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };

    let title = str_field("title").map(|s| truncate(&s, 300));
    let broadcaster = str_field("broadcaster_name");
    // "Clipped by X" goes in the description line.
    let description = str_field("creator_name").map(|c| format!("Clipped by {}", c));
    let image = str_field("thumbnail_url");
    let view_count = clip.get("view_count").and_then(|v| v.as_u64());
    let duration = clip.get("duration").and_then(|v| v.as_f64());

    Ok(LinkPreview {
        url: url.to_string(),
        kind: "clip".to_string(),
        title,
        description,
        image,
        site_name: Some("Twitch".to_string()),
        author: broadcaster,
        author_avatar: None,
        video_id: Some(clip_id.to_string()),
        view_count,
        duration,
    })
}

// --- Twitch VODs -----------------------------------------------------------

static TWITCH_VOD_RE: LazyLock<Regex> = LazyLock::new(|| {
    // twitch.tv/videos/<numeric id> (www / m subdomains included by substring).
    Regex::new(r"twitch\.tv/videos/(\d+)").expect("twitch vod regex")
});

static TWITCH_DURATION_RE: LazyLock<Regex> = LazyLock::new(|| {
    // Helix returns VOD length as e.g. "3h8m33s", "27m11s", "58s".
    Regex::new(r"^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$").expect("twitch duration regex")
});

fn twitch_vod_id(url: &str) -> Option<String> {
    if !url.contains("twitch.tv") {
        return None;
    }
    TWITCH_VOD_RE
        .captures(url)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn parse_twitch_duration(s: &str) -> Option<f64> {
    let caps = TWITCH_DURATION_RE.captures(s.trim())?;
    let part = |i: usize| {
        caps.get(i)
            .and_then(|m| m.as_str().parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    let total = part(1) * 3600.0 + part(2) * 60.0 + part(3);
    if total > 0.0 {
        Some(total)
    } else {
        None
    }
}

/// Resolve a Twitch VOD via Helix `/videos?id=`. Same rationale and auth as the
/// clip path (a plain scrape only yields Twitch boilerplate). Falls back to the
/// generic scrape on any failure.
async fn twitch_vod_preview(url: &str, vod_id: &str) -> Result<LinkPreview, String> {
    let token = match TwitchService::get_token().await {
        Ok(t) => t,
        Err(e) => {
            debug!("[LinkPreview] twitch vod: no token ({})", e);
            return fetch_generic(url).await;
        }
    };

    let resp = match CLIENT
        .get("https://api.twitch.tv/helix/videos")
        .query(&[("id", vod_id)])
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", token))
        .header("Client-Id", env!("TWITCH_APP_CLIENT_ID"))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            debug!("[LinkPreview] twitch videos status {}", r.status());
            return fetch_generic(url).await;
        }
        Err(e) => {
            debug!("[LinkPreview] twitch videos error: {}", e);
            return fetch_generic(url).await;
        }
    };

    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(_) => return fetch_generic(url).await,
    };

    let vod = match json
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| arr.first())
    {
        Some(v) => v,
        None => return fetch_generic(url).await,
    };

    let str_field = |key: &str| {
        vod.get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };

    let title = str_field("title").map(|s| truncate(&s, 300));
    let author = str_field("user_name");
    // VOD thumbnails carry %{width}x%{height} placeholders that must be filled.
    // A still-processing VOD returns a "404_processing" template instead; that
    // resolves to a valid Twitch image, so it's fine to render.
    let image = str_field("thumbnail_url")
        .map(|s| s.replace("%{width}", "480").replace("%{height}", "272"))
        .filter(|s| !s.is_empty());
    let view_count = vod.get("view_count").and_then(|v| v.as_u64());
    let duration = str_field("duration").and_then(|s| parse_twitch_duration(&s));

    Ok(LinkPreview {
        url: url.to_string(),
        kind: "vod".to_string(),
        title,
        description: None,
        image,
        site_name: Some("Twitch".to_string()),
        author,
        author_avatar: None,
        video_id: Some(vod_id.to_string()),
        view_count,
        duration,
    })
}

// --- Imgur -----------------------------------------------------------------

fn is_imgur_page(url: &str) -> bool {
    // Gallery/album/post HTML pages, NOT i.imgur.com direct images (those are
    // handled by the image path before we ever get here).
    let lower = url.to_lowercase();
    lower.contains("://imgur.com/")
        || lower.contains("://www.imgur.com/")
        || lower.contains("://m.imgur.com/")
}

// --- Direct image ----------------------------------------------------------

fn is_image_url(url: &str) -> bool {
    // Strip query/fragment, then look at the extension.
    let path = url.split(['?', '#']).next().unwrap_or(url).to_lowercase();
    [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp"]
        .iter()
        .any(|ext| path.ends_with(ext))
}

// --- Generic OpenGraph scrape ----------------------------------------------

async fn fetch_generic(url: &str) -> Result<LinkPreview, String> {
    // A tighter per-request timeout than the client default: a generic preview is
    // a "nice to have", so don't let an unresponsive host hold the UI's loading
    // state for the full client budget.
    let mut resp = CLIENT
        .get(url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| format!("fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("status {}", resp.status()));
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    // The link's content-type can reveal it's actually an image (no extension
    // in the URL, e.g. a CDN redirect). Treat it as an image card.
    if content_type.starts_with("image/") {
        return Ok(LinkPreview {
            url: url.to_string(),
            kind: "image".to_string(),
            title: None,
            description: None,
            image: Some(url.to_string()),
            site_name: None,
            author: None,
            author_avatar: None,
            video_id: None,
            view_count: None,
            duration: None,
        });
    }

    // Anything that isn't HTML has no OG tags to read.
    if !content_type.is_empty() && !content_type.contains("html") {
        return Err("not an HTML page".to_string());
    }

    // Stream the body and stop the moment we've seen </head> (or hit the cap),
    // instead of `resp.text()` pulling the whole page. Meta tags live in <head>,
    // so this is all we need — and it turns a multi-MB download + full-DOM parse
    // into reading the first few KB of most pages.
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                let prev = buf.len();
                buf.extend_from_slice(&chunk);
                // Scan the newly appended bytes (with a 5-byte overlap so a tag
                // split across chunks is still caught) for the closing </head>.
                let from = prev.saturating_sub(5);
                if buf[from..]
                    .windows(6)
                    .any(|w| w.eq_ignore_ascii_case(b"</head"))
                {
                    break;
                }
                if buf.len() >= HEAD_SCAN_CAP {
                    break;
                }
            }
            Ok(None) => break,
            Err(e) => return Err(format!("read body failed: {}", e)),
        }
    }

    let html = String::from_utf8_lossy(&buf).into_owned();
    let preview = parse_meta(url, &html);

    // No usable signal -> error so the UI just leaves the plain link alone
    // instead of rendering an empty card.
    if preview.title.is_none() && preview.image.is_none() && preview.description.is_none() {
        return Err("no preview metadata".to_string());
    }

    Ok(preview)
}

fn parse_meta(url: &str, html: &str) -> LinkPreview {
    // html5ever decodes HTML entities in attribute values and text during
    // parsing, so the strings we pull out are already clean.
    let document = Html::parse_document(html);

    let title = meta(&document, "property", "og:title")
        .or_else(|| meta(&document, "name", "twitter:title"))
        .or_else(|| doc_title(&document))
        .map(|s| truncate(&s, 300));

    let description = meta(&document, "property", "og:description")
        .or_else(|| meta(&document, "name", "twitter:description"))
        .or_else(|| meta(&document, "name", "description"))
        .map(|s| truncate(&s, 500));

    let image = meta(&document, "property", "og:image")
        .or_else(|| meta(&document, "property", "og:image:url"))
        .or_else(|| meta(&document, "name", "twitter:image"))
        .or_else(|| meta(&document, "name", "twitter:image:src"))
        .map(|s| resolve_url(url, &s));

    let site_name = meta(&document, "property", "og:site_name").map(|s| truncate(&s, 120));

    LinkPreview {
        url: url.to_string(),
        kind: "generic".to_string(),
        title,
        description,
        image,
        site_name,
        author: None,
        author_avatar: None,
        video_id: None,
        view_count: None,
        duration: None,
    }
}

/// First non-empty `content` attr for `meta[<attr>="<key>"]`.
fn meta(document: &Html, attr: &str, key: &str) -> Option<String> {
    let selector = Selector::parse(&format!(r#"meta[{}="{}"]"#, attr, key)).ok()?;
    for el in document.select(&selector) {
        if let Some(content) = el.value().attr("content") {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn doc_title(document: &Html) -> Option<String> {
    let selector = Selector::parse("title").ok()?;
    let el = document.select(&selector).next()?;
    let text = el.text().collect::<String>();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Resolve a possibly-relative og:image against the page URL. Handles the three
/// common forms (absolute, scheme-relative `//host/..`, root-relative `/..`)
/// without pulling in a URL-parsing crate. Anything else is returned as-is.
fn resolve_url(base: &str, target: &str) -> String {
    let t = target.trim();
    if t.starts_with("http://") || t.starts_with("https://") {
        return t.to_string();
    }
    if let Some(rest) = t.strip_prefix("//") {
        let scheme = if base.starts_with("http://") {
            "http"
        } else {
            "https"
        };
        return format!("{}://{}", scheme, rest);
    }
    // Build the origin (scheme://host[:port]) from the base.
    let origin = origin_of(base);
    if t.starts_with('/') {
        return format!("{}{}", origin, t);
    }
    // Truly relative (rare for og:image). Fall back to origin + "/" + target.
    format!("{}/{}", origin, t)
}

fn origin_of(url: &str) -> String {
    // scheme://authority/...  -> scheme://authority
    if let Some(scheme_end) = url.find("://") {
        let after = scheme_end + 3;
        let authority_end = url[after..]
            .find('/')
            .map(|i| after + i)
            .unwrap_or(url.len());
        return url[..authority_end].to_string();
    }
    url.to_string()
}

fn truncate(s: &str, max_chars: usize) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars).collect();
    out.push('\u{2026}'); // ellipsis
    out
}
