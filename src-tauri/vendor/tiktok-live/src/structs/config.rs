use std::fmt;
use std::time::Duration;

use crate::http::ua::system_locale;

/// CDN endpoint for the TikTok WebSocket live stream.
///
/// All three resolve to the same Akamai backend — the actual edge
/// you hit depends on your IP geography, not the hostname.
#[derive(Clone, Debug, Default)]
pub enum CdnEndpoint {
    Eu,
    Us,
    #[default]
    Global,
}

impl CdnEndpoint {
    pub fn host(&self) -> &str {
        match self {
            CdnEndpoint::Eu => "webcast-ws.eu.tiktok.com",
            CdnEndpoint::Us => "webcast-ws.us.tiktok.com",
            CdnEndpoint::Global => "webcast-ws.tiktok.com",
        }
    }
}

impl fmt::Display for CdnEndpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.host())
    }
}

/// Internal configuration for a TikTok Live connection.
///
/// You don't create this directly — use [`TikTokLive::builder`](crate::TikTokLive::builder)
/// which sets sane defaults and exposes configuration via builder methods.
#[derive(Clone, Debug)]
pub struct TikTokLiveConfig {
    pub username: String,
    pub cdn: CdnEndpoint,
    pub timeout: Duration,
    pub heartbeat_interval: Duration,
    pub max_retries: u32,
    pub stale_timeout: Duration,
    pub proxy: Option<String>,
    /// Custom user agent. When `None`, a random UA is picked from the built-in
    /// pool on each reconnect (recommended — reduces DEVICE_BLOCKED risk).
    pub user_agent: Option<String>,
    /// Session cookies for WSS connection. Only needed if you want to pass
    /// authenticated cookies alongside ttwid. For room info on 18+ rooms,
    /// pass cookies directly to `fetch_room_info()` instead.
    pub cookies: Option<String>,
    /// Language code for API requests and Accept-Language header.
    /// Auto-detected from system locale (`LANG`/`LC_ALL`), falls back to `"en"`.
    pub language: String,
    /// Region/country code for API requests.
    /// Auto-detected from system locale (`LANG`/`LC_ALL`), falls back to `"US"`.
    pub region: String,
    /// Whether to request gzip-compressed frames from the WSS server.
    /// Defaults to `true`. The decode layer handles both compressed and
    /// uncompressed data regardless of this setting.
    pub compress: bool,
}

impl TikTokLiveConfig {
    pub fn new(username: impl Into<String>) -> Self {
        let (language, region) = system_locale();
        Self {
            username: username.into(),
            cdn: CdnEndpoint::default(),
            timeout: Duration::from_secs(10),
            heartbeat_interval: Duration::from_secs(10),
            max_retries: 5,
            stale_timeout: Duration::from_secs(60),
            proxy: None,
            user_agent: None,
            cookies: None,
            language,
            region,
            compress: true,
        }
    }

    /// Returns `browser_language` value, e.g. `"en-US"`.
    pub fn browser_language(&self) -> String {
        format!("{}-{}", self.language, self.region)
    }

    /// Returns `Accept-Language` header value, e.g. `"en-US,en;q=0.9"`.
    pub fn accept_language(&self) -> String {
        format!("{}-{},{};q=0.9", self.language, self.region, self.language)
    }
}
