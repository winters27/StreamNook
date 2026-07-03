//! Scoped Twitch credential for moderator rooms.
//!
//! This is deliberately SEPARATE from the primary login's broad app token. The
//! mod-room gate (a Cloudflare Worker) needs to verify, server-side, which
//! channels the user moderates, and to do that it is handed a token. So the token
//! it receives is minted with ONLY `user:read:moderated_channels` and nothing
//! else: a read-only credential that cannot ban, edit a channel, or read chat.
//! The broad primary token never leaves the desktop.
//!
//! It is also on-demand: the consent runs the first time a user opens a mod room,
//! not at login, so users who never touch the feature grant nothing and there is
//! no global re-auth. The credential lives in its own obfuscated file in the app
//! data dir, independent of the primary token storage.

use anyhow::{anyhow, Result};
use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use tokio::sync::Mutex;

use crate::services::twitch_service::get_app_data_dir;

const CLIENT_ID: &str = env!("TWITCH_APP_CLIENT_ID");
const CLIENT_SECRET: &str = env!("TWITCH_APP_CLIENT_SECRET");

/// The only scope this credential ever requests.
const SCOPE: &str = "user:read:moderated_channels";

/// Fixed loopback redirect registered on the Twitch app for this flow. Distinct
/// from the add-account flow's `:3000/callback` so the two never collide.
const REDIRECT_URI: &str = "http://localhost:8765/modroom/callback";

const CRED_FILE_NAME: &str = ".modroom_token";

/// Light at-rest XOR obfuscation, matching the scheme the primary/secondary token
/// files use. Not encryption; it just keeps the token out of plain sight on disk.
const OBFUSCATION_KEY: &[u8] = b"StreamNookModRoomKey2026";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModRoomCredential {
    pub user_id: String,
    pub login: String,
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds when the access token expires.
    pub expires_at: i64,
}

/// Bare result of a token endpoint round trip, before we attach identity.
struct FreshToken {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

fn cred_file_path() -> Result<PathBuf> {
    let mut path = get_app_data_dir()?;
    if !path.exists() {
        fs::create_dir_all(&path)?;
    }
    path.push(CRED_FILE_NAME);
    Ok(path)
}

fn xor(data: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, b)| b ^ OBFUSCATION_KEY[i % OBFUSCATION_KEY.len()])
        .collect()
}

fn store(cred: &ModRoomCredential) -> Result<()> {
    let bytes = serde_json::to_vec(cred)?;
    fs::write(cred_file_path()?, xor(&bytes))?;
    Ok(())
}

fn load() -> Option<ModRoomCredential> {
    let path = cred_file_path().ok()?;
    let raw = fs::read(path).ok()?;
    let json = xor(&raw);
    serde_json::from_slice::<ModRoomCredential>(&json).ok()
}

/// Whether a scoped credential is on file (does not check freshness).
pub fn is_connected() -> bool {
    load().is_some()
}

/// Login of the connected scoped account, for a "Connected as X" surface.
pub fn connected_login() -> Option<String> {
    load().map(|c| c.login)
}

/// Forget the scoped credential. The user can reconnect later.
pub fn disconnect() -> Result<()> {
    let path = cred_file_path()?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

/// Authorize URL for the scoped consent. No `force_verify`, so it reuses the
/// user's existing browser Twitch session and only asks to grant the one scope.
pub fn build_authorize_url(state: &str) -> Result<String> {
    let url = reqwest::Url::parse_with_params(
        "https://id.twitch.tv/oauth2/authorize",
        &[
            ("client_id", CLIENT_ID),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", SCOPE),
            ("state", state),
        ],
    )?;
    Ok(url.to_string())
}

async fn post_token(params: &[(&str, &str)]) -> Result<FreshToken> {
    let client = crate::services::http::client().clone();
    let resp = client
        .post("https://id.twitch.tv/oauth2/token")
        .form(params)
        .send()
        .await?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("mod-room token request failed: {}", body));
    }
    let tr: TokenResponse = resp.json().await?;
    let expires_at = Utc::now() + ChronoDuration::seconds(tr.expires_in.unwrap_or(3600) as i64);
    Ok(FreshToken {
        access_token: tr.access_token,
        refresh_token: tr.refresh_token.unwrap_or_default(),
        expires_at: expires_at.timestamp(),
    })
}

async fn exchange_code(code: &str) -> Result<FreshToken> {
    post_token(&[
        ("client_id", CLIENT_ID),
        ("client_secret", CLIENT_SECRET),
        ("code", code),
        ("grant_type", "authorization_code"),
        ("redirect_uri", REDIRECT_URI),
    ])
    .await
}

async fn refresh(refresh_token: &str) -> Result<FreshToken> {
    let mut fresh = post_token(&[
        ("client_id", CLIENT_ID),
        ("client_secret", CLIENT_SECRET),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ])
    .await?;
    // Twitch may omit a new refresh token on refresh; keep the existing one.
    if fresh.refresh_token.is_empty() {
        fresh.refresh_token = refresh_token.to_string();
    }
    Ok(fresh)
}

/// Resolve the token to identity, so the gate's verdict and the connected-as
/// surface agree on who this credential belongs to.
async fn validate(access_token: &str) -> Result<(String, String)> {
    let client = crate::services::http::client().clone();
    let resp = client
        .get("https://id.twitch.tv/oauth2/validate")
        .header("Authorization", format!("OAuth {}", access_token))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(anyhow!("scoped token validation failed"));
    }
    #[derive(Deserialize)]
    struct V {
        user_id: String,
        #[serde(default)]
        login: String,
    }
    let v: V = resp.json().await?;
    Ok((v.user_id, v.login))
}

/// Finish the consent: trade the redirect code for the scoped token, attach
/// identity, and persist.
pub async fn connect_with_code(code: &str) -> Result<ModRoomCredential> {
    let token = exchange_code(code).await?;
    let (user_id, login) = validate(&token.access_token).await?;
    let cred = ModRoomCredential {
        user_id,
        login,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token.expires_at,
    };
    store(&cred)?;
    Ok(cred)
}

/// Serializes the check-and-refresh below so concurrent room-token requests can't
/// each fire their own refresh. Twitch may rotate (and invalidate) the refresh
/// token on use, so two overlapping refreshes could revoke each other and force a
/// needless reconnect. The lock makes late arrivers re-read the freshly-stored
/// credential and skip the refresh.
fn refresh_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// A currently-valid access token, refreshing if it is within five minutes of
/// expiry. Errors if not connected or if a refresh fails (the caller should then
/// prompt a reconnect).
pub async fn get_valid_access_token() -> Result<String> {
    // Take the lock before loading, so a caller that waited here reads the token
    // a concurrent refresh just persisted instead of refreshing again.
    let _guard = refresh_lock().lock().await;
    let mut cred = load().ok_or_else(|| anyhow!("mod rooms not connected"))?;
    let buffer = 300;
    if Utc::now().timestamp() >= cred.expires_at - buffer {
        if cred.refresh_token.is_empty() {
            return Err(anyhow!("scoped token expired and no refresh token; reconnect needed"));
        }
        let fresh = refresh(&cred.refresh_token).await?;
        cred.access_token = fresh.access_token;
        cred.refresh_token = fresh.refresh_token;
        cred.expires_at = fresh.expires_at;
        store(&cred)?;
    }
    Ok(cred.access_token)
}

#[derive(Deserialize)]
struct ModChannelsResp {
    data: Vec<ModChan>,
    pagination: Option<Pagination>,
}
#[derive(Deserialize)]
struct ModChan {
    broadcaster_id: String,
}
#[derive(Deserialize)]
struct Pagination {
    cursor: Option<String>,
}

/// The broadcaster ids of every channel this scoped account moderates, via the
/// Helix moderated-channels endpoint (paginated). Errs if not connected; the
/// caller treats that as "unknown" and falls back to per-channel detection.
pub async fn list_moderated_channels() -> Result<Vec<String>> {
    let cred = load().ok_or_else(|| anyhow!("mod rooms not connected"))?;
    let token = get_valid_access_token().await?;
    let client = crate::services::http::client().clone();
    let mut out: Vec<String> = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..20 {
        let mut url = reqwest::Url::parse("https://api.twitch.tv/helix/moderation/channels")?;
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("user_id", &cred.user_id);
            q.append_pair("first", "100");
            if let Some(a) = &after {
                q.append_pair("after", a);
            }
        }
        let resp = client
            .get(url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Client-Id", CLIENT_ID)
            .send()
            .await?;
        if !resp.status().is_success() {
            break;
        }
        let body: ModChannelsResp = resp.json().await?;
        for c in body.data {
            out.push(c.broadcaster_id);
        }
        after = body.pagination.and_then(|p| p.cursor).filter(|s| !s.is_empty());
        if after.is_none() {
            break;
        }
    }
    Ok(out)
}
