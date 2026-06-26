use std::fmt;

/// Errors that can occur when connecting to or reading from a TikTok Live stream.
///
/// Most variants come from underlying network/decode layers. The ones you'll
/// typically want to match on:
///
/// - [`UserNotFound`](TikTokLiveError::UserNotFound) — the username doesn't exist
/// - [`HostNotOnline`](TikTokLiveError::HostNotOnline) — the user exists but isn't live
/// - [`DeviceBlocked`](TikTokLiveError::DeviceBlocked) — ttwid was flagged, needs rotation
/// - [`ConnectionClosed`](TikTokLiveError::ConnectionClosed) — WebSocket dropped
#[derive(Debug, thiserror::Error)]
pub enum TikTokLiveError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),

    #[error("websocket: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),

    #[error("protobuf decode: {0}")]
    Proto(#[from] prost::DecodeError),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("user not found: {0}")]
    UserNotFound(String),

    #[error("host not online: {0}")]
    HostNotOnline(String),

    #[error("room id missing from response")]
    RoomIdMissing,

    #[error("age-restricted stream: {0}")]
    AgeRestricted(String),

    #[error("device blocked — ttwid was flagged, fetch a fresh one")]
    DeviceBlocked,

    #[error("invalid response: {0}")]
    InvalidResponse(String),

    #[error("connection closed")]
    ConnectionClosed,

    #[error("invalid url: {0}")]
    InvalidUrl(String),

    #[error("decode: {0}")]
    Decode(String),

    #[error("profile is private: @{0}")]
    ProfilePrivate(String),

    #[error("profile not found: @{0}")]
    ProfileNotFound(String),

    #[error("failed to scrape profile: {0}")]
    ProfileScrape(String),

    #[error("profile fetch error: statusCode={0}")]
    ProfileError(i64),
}

impl TikTokLiveError {
    pub fn decode(msg: impl fmt::Display) -> Self {
        Self::Decode(msg.to_string())
    }

    pub fn invalid(msg: impl fmt::Display) -> Self {
        Self::InvalidResponse(msg.to_string())
    }

    pub fn ttwid(msg: impl fmt::Display) -> Self {
        Self::InvalidResponse(format!("ttwid: {msg}"))
    }
}
