use std::time::Duration;

use serde_json::Value;

use crate::errors::TikTokLiveError;
use crate::http::ua::{random_ua, system_locale, system_timezone};
use crate::structs::events::{RoomInfo, StreamUrl};

const TIKTOK_URL_WEB: &str = "https://www.tiktok.com/";
const TIKTOK_URL_WEBCAST: &str = "https://webcast.tiktok.com/webcast/";

pub struct RoomIdResponse {
    pub room_id: String,
}

/// Shared parameters for standalone HTTP API calls.
///
/// All fields default to auto-detected or `None`. Use struct update syntax:
/// ```ignore
/// fetch_room_id("user", FetchParams { timeout: Duration::from_secs(5), ..Default::default() })
/// ```
#[derive(Clone, Debug)]
pub struct FetchParams<'a> {
    pub timeout: Duration,
    pub cookies: Option<&'a str>,
    pub user_agent: Option<&'a str>,
    pub proxy: Option<&'a str>,
    pub language: Option<&'a str>,
    pub region: Option<&'a str>,
}

impl Default for FetchParams<'_> {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(10),
            cookies: None,
            user_agent: None,
            proxy: None,
            language: None,
            region: None,
        }
    }
}

impl<'a> FetchParams<'a> {
    fn resolve_locale(&self) -> (String, String, String) {
        let (sys_lang, sys_region) = system_locale();
        let lang = match self.language {
            Some(l) => l.to_string(),
            None => sys_lang,
        };
        let reg = match self.region {
            Some(r) => r.to_string(),
            None => sys_region,
        };
        let browser_lang = format!("{lang}-{reg}");
        (lang, reg, browser_lang)
    }
}

fn build_client(params: &FetchParams<'_>) -> Result<reqwest::Client, TikTokLiveError> {
    let ua = params.user_agent.unwrap_or_else(|| random_ua());
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("Referer", "https://www.tiktok.com/".parse().map_err(|e| TikTokLiveError::invalid(e))?);
    if let Some(c) = params.cookies {
        if !c.is_empty() {
            headers.insert("Cookie", c.parse().map_err(|e| TikTokLiveError::invalid(e))?);
        }
    }

    let mut builder = reqwest::Client::builder().timeout(params.timeout).user_agent(ua).default_headers(headers);

    if let Some(proxy_url) = params.proxy {
        builder = builder.proxy(reqwest::Proxy::all(proxy_url).map_err(TikTokLiveError::Http)?);
    }

    builder.build().map_err(TikTokLiveError::Http)
}

/// Resolve a TikTok username to a room ID.
///
/// Returns an error if the user doesn't exist or isn't currently live.
/// Language/region auto-detected from system locale when not set in params.
pub async fn fetch_room_id(username: &str, params: FetchParams<'_>) -> Result<RoomIdResponse, TikTokLiveError> {
    let client = build_client(&params)?;
    let clean = username.trim().trim_start_matches('@');
    let (lang, reg, browser_lang) = params.resolve_locale();

    let url = format!(
        "{}api-live/user/room?aid=1988&app_name=tiktok_web&device_platform=web_pc\
        &app_language={lang}&browser_language={browser_lang}&region={reg}&user_is_login=false\
        &uniqueId={}&sourceType=54&staleTime=600000",
        TIKTOK_URL_WEB, clean
    );

    let resp = client.get(&url).send().await?.text().await?;
    let json: Value = serde_json::from_str(&resp)?;

    let status_code = json.get("statusCode").and_then(|v| v.as_i64());
    match status_code {
        Some(0) => {}
        Some(19881007) => return Err(TikTokLiveError::UserNotFound(clean.to_string())),
        Some(code) => return Err(TikTokLiveError::invalid(format!("tiktok api statusCode={code}"))),
        None => return Err(TikTokLiveError::invalid("no statusCode in response")),
    }

    let room_id = json.pointer("/data/user/roomId").and_then(|r| r.as_str()).ok_or(TikTokLiveError::RoomIdMissing)?;

    if room_id.is_empty() || room_id == "0" {
        return Err(TikTokLiveError::HostNotOnline("no active room".into()));
    }

    let live_status = match json.pointer("/data/liveRoom/status").and_then(|v| v.as_i64()) {
        Some(s) => s,
        None => match json.pointer("/data/user/status").and_then(|v| v.as_i64()) {
            Some(s) => s,
            None => 0,
        },
    };

    if live_status != 2 {
        return Err(TikTokLiveError::HostNotOnline(format!("status={live_status}")));
    }

    Ok(RoomIdResponse { room_id: room_id.to_string() })
}

/// Fetch detailed room info: title, viewer counts, stream URLs.
///
/// This is an **optional** call — not needed for WSS event streaming.
///
/// For 18+ rooms, pass session cookies (`"sessionid=xxx; sid_tt=xxx"`) via
/// `FetchParams { cookies: Some("..."), ..Default::default() }`.
/// Without cookies, 18+ rooms return [`TikTokLiveError::AgeRestricted`].
pub async fn fetch_room_info(room_id: &str, params: FetchParams<'_>) -> Result<RoomInfo, TikTokLiveError> {
    let client = build_client(&params)?;
    let tz_raw = system_timezone();
    let tz = urlencoding::encode(&tz_raw);
    let (lang, _reg, browser_lang) = params.resolve_locale();
    let url = format!(
        "{}room/info/?aid=1988&app_name=tiktok_web&device_platform=web_pc\
        &app_language={lang}&browser_language={browser_lang}&browser_name=Mozilla\
        &browser_online=true&browser_platform=Win32\
        &browser_version=5.0+(Windows+NT+10.0%3B+Win64%3B+x64)\
        &cookie_enabled=true&focus_state=true&from_page=user\
        &screen_height=1080&screen_width=1920\
        &tz_name={tz}&webcast_language={lang}\
        &room_id={}",
        TIKTOK_URL_WEBCAST, room_id
    );

    let resp = client.get(&url).send().await?;
    let status = resp.status();
    let body = resp.text().await?;

    if body.is_empty() {
        return Err(TikTokLiveError::invalid(format!("empty response from room/info (http {})", status)));
    }

    let json: Value = serde_json::from_str(&body)?;

    match json.get("status_code").and_then(|v| v.as_i64()) {
        Some(0) => {}
        Some(4003110) => {
            return Err(TikTokLiveError::AgeRestricted(
                "18+ room — pass session cookies to fetch_room_info()".into(),
            ));
        }
        Some(code) => {
            return Err(TikTokLiveError::invalid(format!("room/info status_code={code}")));
        }
        None => {}
    }

    let data = json["data"].as_object().ok_or_else(|| TikTokLiveError::invalid("missing 'data' in room info"))?;

    let title = data.get("title").and_then(|v| v.as_str()).unwrap_or_default();
    let viewers = data.get("user_count").and_then(|v| v.as_i64()).unwrap_or_default();
    let stats = data.get("stats").and_then(|v| v.as_object());
    let likes = stats.and_then(|s| s.get("like_count")).and_then(|v| v.as_i64()).unwrap_or_default();
    let total_viewers = stats.and_then(|s| s.get("total_user")).and_then(|v| v.as_i64()).unwrap_or_default();

    let stream_url = parse_stream_urls(&json);

    Ok(RoomInfo {
        title: title.to_string(),
        viewers,
        likes,
        total_viewers,
        stream_url,
        raw_json: body,
    })
}

fn parse_stream_urls(json: &Value) -> Option<StreamUrl> {
    let stream_data_str = json.pointer("/data/stream_url/live_core_sdk_data/pull_data/stream_data").and_then(|v| v.as_str())?;

    let nested: Value = match serde_json::from_str(stream_data_str) {
        Ok(v) => v,
        Err(_) => return None,
    };

    Some(StreamUrl {
        flv_origin: nested.pointer("/data/origin/main/flv").and_then(|v| v.as_str()).map(|s| s.to_string()),
        flv_hd: nested.pointer("/data/hd/main/flv").or_else(|| nested.pointer("/data/uhd/main/flv")).and_then(|v| v.as_str()).map(|s| s.to_string()),
        flv_sd: nested.pointer("/data/sd/main/flv").and_then(|v| v.as_str()).map(|s| s.to_string()),
        flv_ld: nested.pointer("/data/ld/main/flv").and_then(|v| v.as_str()).map(|s| s.to_string()),
        flv_ao: nested.pointer("/data/ao/main/flv").and_then(|v| v.as_str()).map(|s| s.to_string()),
    })
}
