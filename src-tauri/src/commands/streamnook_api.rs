//! One authenticated POST to StreamNook's own API, for the whole frontend.
//!
//! Every privileged write (profile theme, equipped cosmetic, user sync) used to
//! go straight to Supabase from the webview under the publishable anon key. That
//! key is in the shipped bundle, and the tables it wrote were world-writable by
//! user id, so anyone could set another member's theme, badge, or profile row.
//! Those writes now go to streamnook.app, which derives the acting user from the
//! bearer token instead of believing the request body.
//!
//! ONE command rather than one per endpoint, deliberately. A Tauri command in
//! this app is three edits (the `fn`, `generate_handler!`, and the ACL manifest),
//! and a command that reaches the handler but not the allowlist is silently
//! DENIED at invoke with no error anywhere a human would look. That has shipped
//! real bugs here three times. Five endpoints would have been fifteen chances to
//! miss one; this is three, once.
//!
//! The token stays in Rust. The frontend names a PATH, never a URL, and the path
//! is checked against a hardcoded allowlist below, so a compromised webview
//! cannot aim an authenticated request carrying the user's Twitch token at an
//! arbitrary host. That matters because streamer-authored HTML renders in this
//! webview.

use crate::services::account_store::AccountStore;
use crate::services::twitch_service::TwitchService;
use serde::Serialize;

const API_BASE: &str = "https://streamnook.app";

/// Paths the frontend may POST to. Exact matches only: no prefixes, no
/// interpolation, nothing derived from caller input. Adding an entry here is a
/// deliberate act, which is the point.
const ALLOWED_PATHS: &[&str] = &[
    "/api/v1/user/sync",
    "/api/cosmetics/theme",
    "/api/cosmetics/equip",
];

#[derive(Debug, Serialize)]
pub struct ApiResponse {
    /// HTTP status, so the caller can distinguish "rejected" from "offline".
    pub status: u16,
    pub ok: bool,
    /// Raw body. Callers parse what they expect; this stays generic so adding an
    /// endpoint needs no new Rust type.
    pub body: String,
}

/// POST to an allowlisted StreamNook API path, authenticated as the current
/// account (or a named linked account).
///
/// Returns Err only for conditions the caller can act on differently from an
/// HTTP error: no token, a disallowed path, or the request never completing. A
/// 4xx/5xx comes back as Ok with `ok: false` so callers can inspect the body.
#[tauri::command]
pub async fn streamnook_api_post(
    path: String,
    body: serde_json::Value,
    account_id: Option<String>,
) -> Result<ApiResponse, String> {
    if !ALLOWED_PATHS.contains(&path.as_str()) {
        return Err(format!("path_not_allowed: {}", path));
    }

    // Authenticate as the chosen account when one is given (a linked secondary),
    // else the primary. The server upserts whichever account the bearer resolves
    // to, so each account can only ever write its own row.
    let token = match account_id {
        Some(id) => AccountStore::get_token_for(&id)
            .await
            .map_err(|e| format!("no_token_for_account:{}: {}", id, e))?,
        None => TwitchService::get_token()
            .await
            .map_err(|e| format!("no_token: {}", e))?,
    };

    let client = crate::services::http::client();
    let resp = client
        .post(format!("{}{}", API_BASE, path))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    Ok(ApiResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body: text,
    })
}

#[cfg(test)]
mod tests {
    use super::ALLOWED_PATHS;

    #[test]
    fn allowlist_holds_only_exact_streamnook_paths() {
        for p in ALLOWED_PATHS {
            assert!(p.starts_with('/'), "{p} must be a path, not a URL");
            assert!(!p.contains("://"), "{p} must not carry a scheme");
            assert!(!p.contains('*'), "{p} must be exact, not a pattern");
        }
    }

    #[test]
    fn allowlist_rejects_traversal_and_foreign_hosts() {
        // The command compares with `contains`, so these can never match. Asserted
        // so a future refactor to prefix matching fails here instead of in the wild.
        for bad in [
            "https://evil.example/api",
            "/api/v1/user/sync/../../admin",
            "//evil.example/api/v1/user/sync",
            "/api/admin/membership",
        ] {
            assert!(!ALLOWED_PATHS.contains(&bad), "{bad} must not be allowed");
        }
    }
}
