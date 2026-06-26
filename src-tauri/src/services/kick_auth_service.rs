//! Kick OAuth (Authorization Code + PKCE) — login so we can SEND Kick chat.
//!
//! Like the Twitch credentials, the app's client id/secret are compile-time env
//! vars baked from `.env` (via build.rs), read here with `option_env!` so a build
//! without them still compiles — `connect()` just reports "not configured".
//!
//! Flow: open the system browser to id.kick.com consent, catch the redirect on a
//! localhost:3000 loopback (the app's registered redirect URI), exchange the code
//! at id.kick.com/oauth/token (id + secret + PKCE verifier), cache the token.
//!
//! First slice keeps the token IN MEMORY (per session); keyring persistence like
//! the Twitch tokens is an easy follow-up.

use crate::services::twitch_service::get_app_data_dir;
use anyhow::{anyhow, Result};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::timeout;

const CLIENT_ID: Option<&str> = option_env!("KICK_APP_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("KICK_APP_CLIENT_SECRET");
const REDIRECT_URI: &str = "http://localhost:3000/callback";
const AUTHORIZE_URL: &str = "https://id.kick.com/oauth/authorize";
const TOKEN_URL: &str = "https://id.kick.com/oauth/token";
// Exactly the scopes the throwaway probe confirmed work for token exchange + send.
// (events:subscribe is for the future Activity-feed work; its scope string is
// unverified, and an unknown scope makes the whole authorize page bounce.)
const SCOPES: &str = "user:read channel:read chat:write moderation:ban moderation:chat_message:manage";
// Persisted so a Kick login survives app restarts (the token was in-memory only
// before). Keyring is primary; an obfuscated file is the fallback for machines
// where the OS keyring is unavailable.
const KEYRING_SERVICE: &str = "streamnook_kick_token";
const KEYRING_USER: &str = "default";
const OBF_KEY: &[u8] = b"StreamNookKickKey2026";

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct KickToken {
    access_token: String,
    refresh_token: String,
    expires_at: u64, // unix seconds
    #[serde(default)]
    username: Option<String>,
}

static TOKEN: OnceLock<Mutex<Option<KickToken>>> = OnceLock::new();

fn token_cell() -> &'static Mutex<Option<KickToken>> {
    // Seed from persisted storage on first access, so a prior login is restored.
    TOKEN.get_or_init(|| Mutex::new(load_persisted()))
}

fn token_path() -> Option<PathBuf> {
    get_app_data_dir().ok().map(|d| d.join(".kick_token"))
}

fn obfuscate(data: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, b)| b ^ OBF_KEY[i % OBF_KEY.len()])
        .collect()
}

fn persist(tok: &KickToken) {
    let Ok(json) = serde_json::to_string(tok) else {
        return;
    };
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        let _ = entry.set_password(&json);
    }
    if let Some(p) = token_path() {
        let _ = std::fs::write(p, obfuscate(json.as_bytes()));
    }
}

fn load_persisted() -> Option<KickToken> {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        if let Ok(json) = entry.get_password() {
            if let Ok(t) = serde_json::from_str::<KickToken>(&json) {
                return Some(t);
            }
        }
    }
    let p = token_path()?;
    let raw = std::fs::read(p).ok()?;
    let json = String::from_utf8(obfuscate(&raw)).ok()?;
    serde_json::from_str(&json).ok()
}

fn clear_persisted() {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        let _ = entry.delete_credential();
    }
    if let Some(p) = token_path() {
        let _ = std::fs::remove_file(p);
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn rand_b64(len: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; len];
    rand::rng().fill_bytes(&mut buf);
    b64url(&buf)
}

fn client_id() -> Option<&'static str> {
    CLIENT_ID.filter(|s| !s.is_empty())
}
fn client_secret() -> Option<&'static str> {
    CLIENT_SECRET.filter(|s| !s.is_empty())
}

pub fn is_connected() -> bool {
    token_cell().lock().map(|t| t.is_some()).unwrap_or(false)
}

/// The connected Kick account's username (for the Connections UI). Returns the
/// cached name; if it's missing (e.g. a token stored before we captured names)
/// but we're connected, it fetches + backfills it so no reconnect is needed.
pub async fn account_name() -> Option<String> {
    if let Some(name) = token_cell()
        .lock()
        .ok()
        .and_then(|t| t.as_ref().and_then(|k| k.username.clone()))
    {
        return Some(name);
    }
    let access = access_token().await?;
    let name = fetch_username(&access).await?;
    let mut updated: Option<KickToken> = None;
    if let Ok(mut t) = token_cell().lock() {
        if let Some(tok) = t.as_mut() {
            tok.username = Some(name.clone());
            updated = Some(tok.clone());
        }
    }
    if let Some(tok) = updated {
        persist(&tok);
    }
    Some(name)
}

/// Fetch the authenticated Kick user's username via the official API (user:read);
/// no query params returns the token owner.
async fn fetch_username(access_token: &str) -> Option<String> {
    let client = reqwest::Client::new();
    let resp = match client
        .get("https://api.kick.com/public/v1/users")
        .bearer_auth(access_token)
        .timeout(Duration::from_secs(8))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[Kick] fetch_username request failed: {e}");
            return None;
        }
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        log::warn!("[Kick] fetch_username HTTP {status}: {body}");
        return None;
    }
    let v: serde_json::Value = resp.json().await.ok()?;
    let name = v
        .pointer("/data/0/name")
        .and_then(|x| x.as_str())
        .map(String::from);
    if name.is_none() {
        log::warn!("[Kick] fetch_username: no /data/0/name in response: {v}");
    }
    name
}

pub fn disconnect() {
    clear_persisted();
    if let Ok(mut t) = token_cell().lock() {
        *t = None;
    }
}

#[derive(serde::Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

/// Run the full Authorization-Code + PKCE flow and cache the resulting token.
pub async fn connect() -> Result<()> {
    let cid = client_id().ok_or_else(|| {
        anyhow!("Kick app not configured — KICK_APP_CLIENT_ID missing from .env at build time")
    })?;
    let secret = client_secret().ok_or_else(|| {
        anyhow!("Kick app not configured — KICK_APP_CLIENT_SECRET missing from .env at build time")
    })?;

    // PKCE: verifier (random) + S256 challenge.
    let verifier = rand_b64(48);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = rand_b64(16);

    // Bind the loopback BEFORE opening the browser so the redirect can't race us.
    let listener = TcpListener::bind("127.0.0.1:3000")
        .await
        .map_err(|e| anyhow!("couldn't bind localhost:3000 for the Kick login redirect: {}", e))?;

    let auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        AUTHORIZE_URL,
        urlencoding::encode(cid),
        urlencoding::encode(REDIRECT_URI),
        urlencoding::encode(SCOPES),
        challenge,
        urlencoding::encode(&state),
    );
    open_in_browser(&auth_url)?;

    // Wait up to 3 minutes for the user to approve.
    let (code, got_state) = timeout(Duration::from_secs(180), accept_redirect(listener))
        .await
        .map_err(|_| anyhow!("Kick login timed out (no redirect received)"))??;
    if got_state != state {
        return Err(anyhow!("Kick login state mismatch — aborting"));
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", cid),
            ("client_secret", secret),
            ("redirect_uri", REDIRECT_URI),
            ("code_verifier", verifier.as_str()),
            ("code", code.as_str()),
        ])
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Kick token exchange failed (HTTP {}): {}", status, body));
    }
    let tr: TokenResponse = resp.json().await?;
    let username = fetch_username(&tr.access_token).await;
    store(KickToken {
        access_token: tr.access_token,
        refresh_token: tr.refresh_token.unwrap_or_default(),
        expires_at: now() + tr.expires_in.unwrap_or(3600),
        username,
    });
    Ok(())
}

fn store(tok: KickToken) {
    persist(&tok);
    if let Ok(mut t) = token_cell().lock() {
        *t = Some(tok);
    }
}

/// Accept connections on the loopback until the `/callback` redirect arrives;
/// reply with a friendly page and return the (code, state).
async fn accept_redirect(listener: TcpListener) -> Result<(String, String)> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let first_line = req.lines().next().unwrap_or("");
        if !first_line.contains("/callback") {
            // favicon / preflight / stray request — ack and keep waiting.
            let _ = stream
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
            continue;
        }
        let query = first_line
            .split('?')
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .unwrap_or("");
        let mut code = String::new();
        let mut state = String::new();
        for pair in query.split('&') {
            let mut kv = pair.splitn(2, '=');
            match (kv.next(), kv.next()) {
                (Some("code"), Some(v)) => {
                    code = urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_else(|_| v.to_string())
                }
                (Some("state"), Some(v)) => {
                    state = urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_else(|_| v.to_string())
                }
                _ => {}
            }
        }
        let html = "<!doctype html><html><body style=\"font-family:system-ui,sans-serif;background:#0e0e10;color:#efeff1;text-align:center;padding-top:80px\"><h2>Kick connected to StreamNook ✓</h2><p>You can close this tab and return to the app.</p></body></html>";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            html.len(),
            html
        );
        let _ = stream.write_all(resp.as_bytes()).await;
        let _ = stream.flush().await;
        if code.is_empty() {
            return Err(anyhow!("Kick redirect carried no authorization code"));
        }
        return Ok((code, state));
    }
}

fn open_in_browser(url: &str) -> Result<()> {
    #[cfg(windows)]
    {
        // NOT `cmd /C start`: cmd treats the `&` between OAuth query params as a
        // command separator and truncates the URL at the first `&`. rundll32's
        // FileProtocolHandler takes the URL as a single arg and opens it verbatim.
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
            .map_err(|e| anyhow!("couldn't open the browser for Kick login: {}", e))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err(anyhow!("Kick login is only wired for Windows right now"))
    }
}

/// The current access token for the send path, refreshing if it's near expiry.
pub async fn access_token() -> Option<String> {
    let cur = token_cell().lock().ok().and_then(|t| t.clone())?;
    if cur.expires_at > now() + 60 {
        return Some(cur.access_token);
    }
    // Try a refresh; fall back to the (possibly stale) token if it fails.
    let (cid, secret) = match (client_id(), client_secret()) {
        (Some(a), Some(b)) => (a, b),
        _ => return Some(cur.access_token),
    };
    if cur.refresh_token.is_empty() {
        return Some(cur.access_token);
    }
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", cid),
            ("client_secret", secret),
            ("refresh_token", cur.refresh_token.as_str()),
        ])
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return Some(cur.access_token);
    }
    let tr: TokenResponse = resp.json().await.ok()?;
    let access = tr.access_token.clone();
    store(KickToken {
        access_token: tr.access_token,
        refresh_token: if tr.refresh_token.as_deref().unwrap_or("").is_empty() {
            cur.refresh_token
        } else {
            tr.refresh_token.unwrap()
        },
        expires_at: now() + tr.expires_in.unwrap_or(3600),
        username: cur.username,
    });
    Some(access)
}
