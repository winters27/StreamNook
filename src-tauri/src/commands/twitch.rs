use crate::models::settings::AppState;
use crate::models::stream::{TwitchClip, TwitchStream, TwitchVideo};
use crate::models::user::{ChannelInfo, UserInfo};
use crate::services::drops_auth_service::DropsAuthService;
use crate::services::twitch_service::{DeviceCodeInfo, TokenHealthStatus, TwitchService};
use crate::services::whisper_history_service::{
    WhisperHistoryService, WhisperMessage, WhisperThread,
};
use crate::services::whisper_service::WhisperService;
use anyhow::Result;
use log::{debug, error};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, WebviewUrl};
use tokio::sync::Mutex as TokioMutex;

// Device Code Flow - the main login command
#[tauri::command]
pub async fn twitch_login(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(String, String), String> {
    // Single device flow: the poller spawned inside login() waits on the same
    // code we hand back to the UI, so authorizing the displayed code completes
    // the login (no orphaned second device code that hangs the poller).
    let (verification_uri, user_code) = TwitchService::login(&state, app)
        .await
        .map_err(|e| e.to_string())?;

    Ok((verification_uri, user_code))
}

#[derive(serde::Serialize)]
pub struct CreateClipResult {
    pub id: String,
    pub edit_url: String,
}

/// Create a clip of the given live broadcaster (the channel currently being
/// watched). On failure the error is a short code — REAUTH / OFFLINE / DISABLED
/// / FORBIDDEN / NOTFOUND / NETWORK / ERROR — that the frontend maps to a
/// friendly message.
#[tauri::command]
pub async fn create_clip(broadcaster_id: String) -> Result<CreateClipResult, String> {
    TwitchService::create_clip(&broadcaster_id)
        .await
        .map(|(id, edit_url)| CreateClipResult { id, edit_url })
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct LiveBroadcast {
    /// The live stream id — this is the `broadcastID` `CreateRawMedia` wants.
    pub broadcast_id: String,
    /// ISO start time; the frontend derives the live offset = now − started_at.
    pub started_at: String,
}

/// Resolve the channel's current live broadcast (id + start) so a live clip can
/// go through the same GQL raw-media editor as a VOD. Errors map like create_clip
/// (OFFLINE / REAUTH / …).
#[tauri::command]
pub async fn get_live_broadcast(broadcaster_id: String) -> Result<LiveBroadcast, String> {
    TwitchService::get_live_broadcast(&broadcaster_id)
        .await
        .map(|(broadcast_id, started_at)| LiveBroadcast {
            broadcast_id,
            started_at,
        })
        .map_err(|e| e.to_string())
}

// --- VOD clip creation via the GQL "raw media" pipeline ---------------------
// Helix Create Clip is live-only; clipping a VOD at a timestamp uses Twitch's
// web GQL flow (CreateRawMedia -> CreateClipFromRawMedia). Reuses the Android-
// client, no-integrity GQL pattern the watch-event path's sendSpadeEvents uses,
// with the drops (Android-client) token. Hashes/shape were reverse-engineered
// from a real capture (see Brain: references/Twitch_Clip_Creation_GQL).

const ANDROID_CLIENT_ID: &str = env!("TWITCH_ANDROID_CLIENT_ID");
const H_CREATE_RAW_MEDIA: &str = "19cbfe94f0aff2e1338fd8ee472d90c8d334e17a84ebe8b06dcb236bd9394dfd";
const H_CREATE_CLIP_FROM_RAW: &str =
    "dfc972bc2a6d70778cb63256123fd1a6a024bec914a947de47ea500b75fc9216";
const H_SHARE_CLIP_RENDER_STATUS: &str =
    "324783ea014524fa10a88739aa507de7a52f9624574dba9739a52b8c97d885cf";
const H_DELETE_CLIPS: &str = "df142a7eec57c5260d274b92abddb0bd1229dc538341434c90367cf1f22d71c4";
const H_GET_RAW_MEDIA: &str = "a702cc4a4701f0e32fd666630ca707806dc502103f5810323c3ab32d98179fac";

/// Twitch's suggested portrait crop varies; this centered frame is a safe
/// default for the 9:16 variant and doesn't affect the landscape clip.
fn default_portrait_frame() -> serde_json::Value {
    serde_json::json!({
        "topLeft": { "xPercentage": 34.1796875, "yPercentage": 0 },
        "bottomRight": { "xPercentage": 65.8203125, "yPercentage": 100 }
    })
}

/// Twitch echoes `__typename` into objects it returns; the mutation input
/// rejects them, so drop them before reusing the suggested-crop frame.
fn strip_typename(v: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(k, _)| k != "__typename")
                .map(|(k, val)| (k, strip_typename(val)))
                .collect(),
        ),
        Value::Array(arr) => Value::Array(arr.into_iter().map(strip_typename).collect()),
        other => other,
    }
}

async fn clip_gql(
    client: &reqwest::Client,
    token: &str,
    operation: &str,
    variables: serde_json::Value,
    hash: &str,
) -> Result<serde_json::Value> {
    let body = serde_json::json!({
        "operationName": operation,
        "variables": variables,
        "extensions": { "persistedQuery": { "version": 1, "sha256Hash": hash } }
    });
    // X-Device-Id / Client-Session-Id matter: without a device id, Twitch drops
    // GQL into a harsh anonymous rate-limit bucket and clip creation gets
    // REQUEST_THROTTLED almost immediately. Every other GQL caller in the app
    // (chat_identity / channel_points / drops) sends these; the clip path must too.
    let device_id = uuid::Uuid::new_v4().to_string().replace('-', "");
    let session_id = uuid::Uuid::new_v4().to_string().replace('-', "");
    let resp = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-ID", ANDROID_CLIENT_ID)
        .header("Authorization", format!("OAuth {}", token))
        .header("Origin", "https://www.twitch.tv")
        .header("Referer", "https://www.twitch.tv")
        .header("Accept-Language", "en-US")
        .header("X-Device-Id", device_id)
        .header("Client-Session-Id", session_id)
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("NETWORK"))?;
    let status = resp.status();
    let json: serde_json::Value = resp.json().await.map_err(|_| anyhow::anyhow!("ERROR"))?;
    if !status.is_success() {
        return Err(anyhow::anyhow!(
            "HTTP {} from {}",
            status.as_u16(),
            operation
        ));
    }
    // Surface GQL-level errors verbatim (PersistedQueryNotFound, integrity, etc.)
    // so the first live test tells us exactly what Twitch rejected.
    if let Some(errs) = json.get("errors").filter(|e| !e.is_null()) {
        return Err(anyhow::anyhow!("{}: {}", operation, errs));
    }
    Ok(json)
}

#[tauri::command]
pub async fn create_vod_clip(
    vod_id: String,
    offset_seconds: f64,
    title: Option<String>,
) -> Result<CreateClipResult, String> {
    create_vod_clip_inner(&vod_id, offset_seconds, title)
        .await
        .map_err(|e| e.to_string())
}

async fn create_vod_clip_inner(
    vod_id: &str,
    offset_seconds: f64,
    title: Option<String>,
) -> Result<CreateClipResult> {
    let token = DropsAuthService::get_token()
        .await
        .map_err(|_| anyhow::anyhow!("REAUTH"))?;
    let client = crate::services::http::client().clone();
    let offset = offset_seconds.max(0.0).round() as i64;

    // 1. Capture the raw media around the VOD offset.
    let raw = clip_gql(
        &client,
        &token,
        "CreateRawMedia",
        serde_json::json!({
            "input": { "vodID": vod_id, "broadcastID": null, "offsetSeconds": offset }
        }),
        H_CREATE_RAW_MEDIA,
    )
    .await?;
    let raw_media = raw
        .pointer("/data/createRawMedia/rawMedia")
        .ok_or_else(|| anyhow::anyhow!("CreateRawMedia: no rawMedia in response"))?;
    let raw_media_id = raw_media
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("CreateRawMedia: no rawMedia id"))?
        .to_string();

    // Carry Twitch's suggested portrait crop through; default to a full frame.
    let main_frame = raw_media
        .pointer("/suggestedCropping/fullTemplateMetadata/mainFrame")
        .cloned()
        .map(strip_typename)
        .unwrap_or_else(|| {
            serde_json::json!({
                "topLeft": { "xPercentage": 0, "yPercentage": 0 },
                "bottomRight": { "xPercentage": 100, "yPercentage": 100 }
            })
        });

    let clip_title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Clip".to_string());

    // 2. Cut a 30s clip from the start of that raw media. The raw media needs a
    // moment to process before a clip can be made from it (the web client polls
    // GetRawMedia in between); until it's ready this mutation returns a null
    // `clip` + a payload `error`. So retry until the slug appears, surfacing the
    // last payload error if it never does.
    let clip_vars = serde_json::json!({
        "input": {
            "rawMediaID": raw_media_id,
            "shouldFeature": false,
            "shouldIncludeCaptions": false,
            "title": clip_title,
            "segments": [{ "durationSeconds": 30, "offsetSeconds": 0 }],
            "portraitMetadata": {
                "layout": "FULL",
                "fullHeightMetadata": { "mainFrame": main_frame }
            }
        }
    });

    let mut last_detail = String::from("(no clip, no error field)");
    for attempt in 0..12u32 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        }
        let made = clip_gql(
            &client,
            &token,
            "ClipCreation_CreateClipFromRawMedia",
            clip_vars.clone(),
            H_CREATE_CLIP_FROM_RAW,
        )
        .await?;
        let payload = made.pointer("/data/createClipFromRawMedia");
        if let Some(slug) = payload
            .and_then(|p| p.get("clip"))
            .and_then(|c| c.get("slug"))
            .and_then(|v| v.as_str())
        {
            return Ok(CreateClipResult {
                id: slug.to_string(),
                edit_url: format!("https://clips.twitch.tv/{}/edit", slug),
            });
        }
        // No slug yet — remember why (the payload's `error`) and retry.
        last_detail = payload
            .and_then(|p| p.get("error"))
            .filter(|e| !e.is_null())
            .map(|e| e.to_string())
            .unwrap_or_else(|| last_detail.clone());
    }

    Err(anyhow::anyhow!("clip never finalized: {}", last_detail))
}

#[derive(serde::Serialize)]
pub struct ClipRenderStatus {
    /// True once Twitch has finished rendering the clip (creationState CREATED).
    pub ready: bool,
    /// Direct playable MP4 once ready (highest quality), else null.
    pub src: Option<String>,
    pub thumbnail: Option<String>,
}

/// Poll a clip's render state via `ShareClipRenderStatus`. A just-created clip
/// reports `CREATING` for a few seconds (its asset is a black/empty frame until
/// done), so the UI polls this and only plays once `ready` + `src` are set —
/// instead of grabbing the not-yet-rendered asset and showing black.
#[tauri::command]
pub async fn get_clip_render_status(slug: String) -> Result<ClipRenderStatus, String> {
    get_clip_render_status_inner(&slug)
        .await
        .map_err(|e| e.to_string())
}

async fn get_clip_render_status_inner(slug: &str) -> Result<ClipRenderStatus> {
    let token = DropsAuthService::get_token()
        .await
        .map_err(|_| anyhow::anyhow!("REAUTH"))?;
    let client = crate::services::http::client().clone();
    let json = clip_gql(
        &client,
        &token,
        "ShareClipRenderStatus",
        serde_json::json!({ "slug": slug }),
        H_SHARE_CLIP_RENDER_STATUS,
    )
    .await?;

    let asset = json.pointer("/data/clip/assets/0");
    let ready = asset
        .and_then(|a| a.get("creationState"))
        .and_then(|v| v.as_str())
        .map(|s| s.eq_ignore_ascii_case("CREATED"))
        .unwrap_or(false);
    let thumbnail = asset
        .and_then(|a| a.get("thumbnailURL"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    // videoQualities is ordered best-first; take the first non-empty source.
    let src = if ready {
        asset
            .and_then(|a| a.get("videoQualities"))
            .and_then(|q| q.as_array())
            .and_then(|arr| {
                arr.iter().find_map(|q| {
                    q.get("sourceURL")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                })
            })
            .map(String::from)
    } else {
        None
    };

    Ok(ClipRenderStatus {
        ready,
        src,
        thumbnail,
    })
}

/// Delete a clip the user owns via `Clips_DeleteClips`.
#[tauri::command]
pub async fn delete_clip(slug: String) -> Result<(), String> {
    delete_clip_inner(&slug).await.map_err(|e| e.to_string())
}

async fn delete_clip_inner(slug: &str) -> Result<()> {
    let token = DropsAuthService::get_token()
        .await
        .map_err(|_| anyhow::anyhow!("REAUTH"))?;
    let client = crate::services::http::client().clone();
    clip_gql(
        &client,
        &token,
        "Clips_DeleteClips",
        serde_json::json!({ "input": { "slugs": [slug] } }),
        H_DELETE_CLIPS,
    )
    .await?;
    Ok(())
}

// --- Clip trim editor (raw-media flow) --------------------------------------
// The editor captures a ~90s raw-media window around the VOD offset, lets the
// user scrub it and pick an exact [start, start+duration] segment + title, then
// finalizes. `begin_clip_edit` does CreateRawMedia + polls GetRawMedia for the
// SIGNED footage URL + length; `finalize_clip` does CreateClipFromRawMedia.

#[derive(serde::Serialize)]
pub struct ClipEditSession {
    pub raw_media_id: String,
    /// Length of the captured window in seconds (≈90) — the trim range.
    pub duration_seconds: f64,
    /// Signed, directly-playable MP4 of the captured footage (for scrubbing).
    pub preview_url: String,
}

#[tauri::command]
pub async fn begin_clip_edit(
    vod_id: Option<String>,
    broadcast_id: Option<String>,
    offset_seconds: f64,
) -> Result<ClipEditSession, String> {
    begin_clip_edit_inner(vod_id.as_deref(), broadcast_id.as_deref(), offset_seconds)
        .await
        .map_err(|e| e.to_string())
}

async fn begin_clip_edit_inner(
    vod_id: Option<&str>,
    broadcast_id: Option<&str>,
    offset_seconds: f64,
) -> Result<ClipEditSession> {
    let token = DropsAuthService::get_token()
        .await
        .map_err(|_| anyhow::anyhow!("REAUTH"))?;
    let client = crate::services::http::client().clone();
    let offset = offset_seconds.max(0.0).round() as i64;

    // 1. Capture the raw-media window around the offset. The input differs only in
    // which source id is set: a VOD sends `vodID`, a live broadcast sends
    // `broadcastID` (with the live offset = stream uptime). Everything after is
    // identical. Twitch rate-limits raw media creation (payload error code
    // REQUEST_THROTTLED) under heavy use; retry through a short throttle.
    let input = if let Some(bid) = broadcast_id {
        serde_json::json!({ "vodID": null, "broadcastID": bid, "offsetSeconds": offset })
    } else {
        serde_json::json!({ "vodID": vod_id, "broadcastID": null, "offsetSeconds": offset })
    };
    let vars = serde_json::json!({ "input": input });
    let mut raw_media_id: Option<String> = None;
    let mut last_err = String::from("(no rawMedia, no error field)");
    for attempt in 0..4u32 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        }
        let raw = clip_gql(
            &client,
            &token,
            "CreateRawMedia",
            vars.clone(),
            H_CREATE_RAW_MEDIA,
        )
        .await?;
        if let Some(id) = raw
            .pointer("/data/createRawMedia/rawMedia/id")
            .and_then(|v| v.as_str())
        {
            raw_media_id = Some(id.to_string());
            break;
        }
        last_err = raw
            .pointer("/data/createRawMedia/error")
            .filter(|e| !e.is_null())
            .map(|e| e.to_string())
            .unwrap_or_else(|| raw.to_string().chars().take(300).collect());
        // Only a throttle is worth retrying; any other error is terminal.
        if !last_err.contains("THROTTLED") {
            break;
        }
    }
    let raw_media_id = raw_media_id.ok_or_else(|| {
        if last_err.contains("THROTTLED") {
            anyhow::anyhow!(
                "Twitch is rate-limiting clip creation right now — wait a minute and try again"
            )
        } else {
            anyhow::anyhow!("CreateRawMedia: {}", last_err)
        }
    })?;

    // 2. Poll GetRawMedia until the footage has processed (status CREATED), then
    // grab its signed source + duration.
    for attempt in 0..30u32 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        }
        let g = clip_gql(
            &client,
            &token,
            "GetRawMedia",
            serde_json::json!({ "id": raw_media_id }),
            H_GET_RAW_MEDIA,
        )
        .await?;
        let rm = g.pointer("/data/rawMedia");
        let ready = rm
            .and_then(|m| m.get("status"))
            .and_then(|v| v.as_str())
            .map(|s| s.eq_ignore_ascii_case("CREATED"))
            .unwrap_or(false);
        if !ready {
            continue;
        }
        let asset_rendition = rm.and_then(|m| m.pointer("/assets/0/renditions/0"));
        let duration_seconds = asset_rendition
            .and_then(|r| r.get("duration"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let preview_url = asset_rendition
            .and_then(|r| r.get("sourceURL"))
            .and_then(|v| v.as_str())
            .or_else(|| {
                rm.and_then(|m| m.pointer("/renditions/0/sourceURL"))
                    .and_then(|v| v.as_str())
            })
            .map(String::from);
        if let Some(preview_url) = preview_url.filter(|s| !s.is_empty()) {
            return Ok(ClipEditSession {
                raw_media_id,
                duration_seconds,
                preview_url,
            });
        }
    }
    Err(anyhow::anyhow!("raw media never finished processing"))
}

#[tauri::command]
pub async fn finalize_clip(
    raw_media_id: String,
    start_seconds: f64,
    duration_seconds: f64,
    title: Option<String>,
) -> Result<CreateClipResult, String> {
    finalize_clip_inner(&raw_media_id, start_seconds, duration_seconds, title)
        .await
        .map_err(|e| e.to_string())
}

async fn finalize_clip_inner(
    raw_media_id: &str,
    start_seconds: f64,
    duration_seconds: f64,
    title: Option<String>,
) -> Result<CreateClipResult> {
    let token = DropsAuthService::get_token()
        .await
        .map_err(|_| anyhow::anyhow!("REAUTH"))?;
    let client = crate::services::http::client().clone();
    let clip_title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Clip".to_string());

    let vars = serde_json::json!({
        "input": {
            "rawMediaID": raw_media_id,
            "shouldFeature": false,
            "shouldIncludeCaptions": false,
            "title": clip_title,
            "segments": [{
                "durationSeconds": duration_seconds.max(0.5),
                "offsetSeconds": start_seconds.max(0.0)
            }],
            "portraitMetadata": {
                "layout": "FULL",
                "fullHeightMetadata": { "mainFrame": default_portrait_frame() }
            }
        }
    });

    // The raw media is already CREATED (begin_clip_edit waited), so this usually
    // succeeds first try; a couple retries cover a brief readiness lag.
    let mut last_detail = String::from("(no clip, no error field)");
    for attempt in 0..5u32 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        }
        let made = clip_gql(
            &client,
            &token,
            "ClipCreation_CreateClipFromRawMedia",
            vars.clone(),
            H_CREATE_CLIP_FROM_RAW,
        )
        .await?;
        let payload = made.pointer("/data/createClipFromRawMedia");
        if let Some(slug) = payload
            .and_then(|p| p.get("clip"))
            .and_then(|c| c.get("slug"))
            .and_then(|v| v.as_str())
        {
            return Ok(CreateClipResult {
                id: slug.to_string(),
                edit_url: format!("https://clips.twitch.tv/{}/edit", slug),
            });
        }
        last_detail = payload
            .and_then(|p| p.get("error"))
            .filter(|e| !e.is_null())
            .map(|e| e.to_string())
            .unwrap_or_else(|| last_detail.clone());
    }
    Err(anyhow::anyhow!("clip never finalized: {}", last_detail))
}

// Device code commands (kept for backward compatibility)
#[tauri::command]
pub async fn twitch_start_device_login(
    state: State<'_, AppState>,
) -> Result<DeviceCodeInfo, String> {
    TwitchService::start_device_login(&state)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn twitch_complete_device_login(
    device_code: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let result = TwitchService::complete_device_login(&device_code, &state)
        .await
        .map_err(|e| e.to_string());
    if result.is_ok() {
        // A fresh login: clear any logged-out state and re-harvest the session
        // for the newly signed-in account on the next resolve.
        state.twitch_auth.on_account_changed().await;
        crate::services::auth_proxy::clear_entitlement_caches();
    }
    result
}

#[tauri::command]
pub async fn twitch_logout(state: State<'_, AppState>) -> Result<(), String> {
    let result = TwitchService::logout().await.map_err(|e| e.to_string());
    // Reads stay logged-out (no fallback to the default store's lingering
    // cookie) until the next login, and cached entitlement is dropped.
    state.twitch_auth.on_logged_out().await;
    crate::services::auth_proxy::clear_entitlement_caches();
    // Channel points and drops run off a SEPARATE credential (its own device
    // login); clear it too so the watch heartbeat stops crediting the account
    // that just signed out.
    let _ = crate::services::drops_auth_service::DropsAuthService::logout().await;
    result
}

#[tauri::command]
pub async fn get_category_info(
    game_name: String,
) -> Result<Option<crate::models::stream::CategoryInfo>, String> {
    TwitchService::get_category_info(&game_name)
        .await
        .map_err(|e| e.to_string())
}

/// Clear WebView2 browsing data (cookies, cache, etc.) to force re-login
/// This is used during migrations or when a full logout is required
#[tauri::command]
pub async fn clear_webview_data(app: AppHandle) -> Result<(), String> {
    use std::fs;
    use tauri::Manager;

    debug!("[CLEAR_WEBVIEW] Starting WebView2 data cleanup...");

    // Try multiple possible locations for WebView2 data
    let mut paths_to_clear = Vec::new();

    // 1. Tauri's app_data_dir (typically AppData/Local/com.streamnook.dev/)
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        paths_to_clear.push(app_data_dir.join("EBWebView"));
    }

    // 2. Config directory (AppData/Roaming/StreamNook/)
    if let Some(config_dir) = dirs::config_dir() {
        paths_to_clear.push(config_dir.join("StreamNook").join("EBWebView"));
    }

    // 3. Local data directory (AppData/Local/)
    if let Some(local_dir) = dirs::data_local_dir() {
        paths_to_clear.push(local_dir.join("StreamNook").join("EBWebView"));
        paths_to_clear.push(local_dir.join("com.streamnook.dev").join("EBWebView"));
    }

    // 4. Roaming data directory
    if let Some(data_dir) = dirs::data_dir() {
        paths_to_clear.push(data_dir.join("StreamNook").join("EBWebView"));
    }

    let mut cleared_any = false;
    for webview_data_path in paths_to_clear {
        if webview_data_path.exists() {
            debug!(
                "[CLEAR_WEBVIEW] Found WebView2 data at: {:?}",
                webview_data_path
            );

            // Remove the entire WebView2 data directory
            if let Err(e) = fs::remove_dir_all(&webview_data_path) {
                error!(
                    "[CLEAR_WEBVIEW] Warning: Could not fully remove {:?}: {}",
                    webview_data_path, e
                );
            } else {
                debug!(
                    "[CLEAR_WEBVIEW] Successfully cleared: {:?}",
                    webview_data_path
                );
                cleared_any = true;
            }
        }
    }

    if !cleared_any {
        debug!("[CLEAR_WEBVIEW] No WebView2 data directories found to clear");
    }

    Ok(())
}

/// The WebView2 profile holding the active account's twitch.tv web session.
///
/// Both the login window and the subscribe window resolve through here so they
/// can never disagree about which session to show. When an account is linked
/// it's that account's own profile (adopting a freshly-staged first login if
/// one is waiting); before any account is recorded it's the staging profile the
/// login window writes to, which the first per-account window later adopts.
fn active_twitch_web_profile_dir() -> Result<PathBuf, String> {
    crate::services::twitch_service::active_twitch_web_profile_dir().map_err(|e| e.to_string())
}


/// JS injected into the Twitch webview so the URL bar tracks where the page
/// actually is. Twitch is a single-page app: after the first load most route
/// changes are `history.pushState`/`replaceState`/`popstate` with no document
/// load, so a top-level navigation hook alone would miss them. This reports
/// `location.href` on load and on each in-page navigation, deduped, to the
/// `report_login_popup_url` command, which pushes it into this window's bar.
fn spa_url_report_script(window_label: &str, is_overlay: bool) -> String {
    let label = serde_json::to_string(window_label).unwrap_or_else(|_| "\"\"".to_string());
    // For the in-app overlay there's no close button, so Esc dismisses it even while
    // focus is in the Twitch page. A separate window (subscribe) has its own close.
    let escape = if is_overlay {
        "\n  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { try { window.__TAURI_INTERNALS__.invoke('close_login_overlay', { label: label }); } catch (e) {} } });"
    } else {
        ""
    };
    format!(
        r#"(function() {{
  var label = {label};
  var last = "";
  function report() {{
    try {{
      if (window.top !== window.self) return;
      var u = location.href;
      if (!u || u === "about:blank") return;
      if (u === last) return;
      last = u;
      window.__TAURI_INTERNALS__.invoke('report_login_popup_url', {{ windowLabel: label, url: u }});
    }} catch (e) {{}}
  }}
  var _push = history.pushState;
  history.pushState = function() {{ var r = _push.apply(this, arguments); report(); return r; }};
  var _replace = history.replaceState;
  history.replaceState = function() {{ var r = _replace.apply(this, arguments); report(); return r; }};
  window.addEventListener('popstate', report);
  window.addEventListener('hashchange', report);
  report();
  setTimeout(report, 800);{escape}
}})();"#
    )
}

/// Forward the live page URL to the React address bar. Called by the injected
/// reporter in the Twitch webview on load and on each in-page navigation. The bar
/// is now part of the React app, so this emits an event keyed by overlay label
/// instead of poking a second webview.
#[tauri::command]
pub fn report_login_popup_url(app: AppHandle, window_label: String, url: String) {
    use tauri::Emitter;
    let _ = app.emit(
        "twitch-overlay-url",
        serde_json::json!({ "label": window_label, "url": url }),
    );
}

/// Open the Twitch page for an in-app overlay (login, drops sign-in, or subscribe) as
/// a SEPARATE borderless window owned by the main window, positioned at the screen
/// rect the React overlay measured. React draws all the chrome (the read-only URL
/// bar, and for subscribe the centered panel frame); this window is only the Twitch
/// page, which can't be an iframe.
///
/// It is a top-level *owned* window, NOT a child composited onto the main window via
/// `add_child`. A composited child wedges the main window's UI thread when the
/// Alt+Tab switcher (a fullscreen overlay) occludes it: that was the 8.0.8 login
/// "Not Responding". An owned top-level window has its own windowed WebView2
/// controller (the same hosting that never froze pre-8.0.8), stays above the main
/// window, and is hidden/destroyed with it. `x`/`y` are screen coords (the React
/// chrome lives on the main window, so the frontend adds the main window's client
/// origin to the body rect before calling here).
#[tauri::command]
pub async fn mount_twitch_overlay(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;

    debug!(
        "[overlay] open '{}' at screen ({}, {}) {}x{} -> {}",
        label, x, y, width, height, url
    );

    // Replace any stale window under this label so a reopen is clean.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.close();
    }

    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let profile = active_twitch_web_profile_dir()?;
    let parsed = url.parse().map_err(|e| format!("Invalid URL: {}", e))?;

    let win = WebviewWindowBuilder::new(&app, label.clone(), WebviewUrl::External(parsed))
        .data_directory(profile)
        .initialization_script(spa_url_report_script(&label, true))
        .decorations(false)
        .shadow(false)
        .skip_taskbar(true)
        .position(x, y)
        .inner_size(width.max(1.0), height.max(1.0))
        .focused(true)
        .parent(&main)
        .map_err(|e| format!("Failed to own overlay to main window: {}", e))?
        .build()
        .map_err(|e| {
            let msg = format!("Failed to open Twitch overlay window: {}", e);
            error!("[overlay] {}", msg);
            msg
        })?;

    // The content sits inside React's rounded panel frame, so it must be a crisp
    // rectangle; suppress the DWM rounded corners Win11 gives borderless windows.
    #[cfg(windows)]
    square_window_corners(&win);

    debug!("[overlay] open '{}' ok", label);
    // Tag the hang watchdog with what's on screen, so a "Not Responding" report names
    // the overlay and URL that were up when the UI thread wedged.
    crate::services::ui_hang_watchdog::set_active_overlay(Some(format!("{label} @ {url}")));
    Ok(())
}

/// Suppress the rounded corners DWM applies to borderless windows on Windows 11, so
/// the overlay content reads as a crisp rectangle inside React's rounded panel frame.
#[cfg(windows)]
fn square_window_corners(win: &tauri::WebviewWindow) {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };
    if let Ok(h) = win.hwnd() {
        let pref = DWMWCP_DONOTROUND;
        unsafe {
            let _ = DwmSetWindowAttribute(
                HWND(h.0),
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &pref as *const _ as *const c_void,
                std::mem::size_of_val(&pref) as u32,
            );
        }
    }
}

/// Reposition/resize the overlay window to the screen rect React measured. Called when
/// the main window moves or resizes so the content keeps tracking the chrome.
#[tauri::command]
pub async fn set_twitch_overlay_bounds(app: AppHandle, label: String, x: f64, y: f64, width: f64, height: f64) {
    use tauri::{LogicalPosition, LogicalSize};
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_position(LogicalPosition::new(x, y));
        let _ = win.set_size(LogicalSize::new(width.max(1.0), height.max(1.0)));
    }
}

/// Show/hide the overlay window. The owned window already hides with the main window
/// on minimize; this stays as a belt-and-suspenders driven from React on
/// `visibilitychange`, and toggles the whole window (no per-webview controller call
/// that could touch native state from a window-event path).
#[tauri::command]
pub async fn set_twitch_overlay_visible(app: AppHandle, label: String, visible: bool) {
    if let Some(win) = app.get_webview_window(&label) {
        let _ = if visible { win.show() } else { win.hide() };
    }
}

/// Close the overlay's Twitch window and tell the React overlay to clear its chrome.
/// Safe to call when nothing is open (no-op). Driven from the backend on login success
/// AND from the frontend (Esc, close, completion), so dismissal never hangs on
/// frontend timing.
pub fn dismiss_login_overlay(app: &AppHandle, label: &str) {
    use tauri::Emitter;
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.close();
    }
    crate::services::ui_hang_watchdog::set_active_overlay(None);
    let _ = app.emit("twitch-overlay-close", serde_json::json!({ "label": label }));
}

/// Command form for the frontend completion / Esc handlers.
#[tauri::command]
pub fn close_login_overlay(app: AppHandle, label: String) {
    dismiss_login_overlay(&app, &label);
}

/// Tell the React overlay to take over the app body (or, for subscribe, a centered
/// panel) with a Twitch page. React renders the chrome and mounts the single Twitch
/// webview at the rect it measures. `mode` is "fullbody" (login, drops) or "panel"
/// (subscribe).
fn emit_overlay_open(app: &AppHandle, label: &str, url: &str, mode: &str) -> Result<(), String> {
    use tauri::Emitter;
    app.emit(
        "twitch-overlay-open",
        serde_json::json!({ "label": label, "url": url, "mode": mode }),
    )
    .map_err(|e| e.to_string())
}

/// Take over the app body with the Twitch device-code login, isolated to the active
/// account's web profile. A per-account profile means a re-login lands on the same
/// account and can't silently inherit a different account's web session. The React
/// overlay shows the live URL in a bar at the top.
#[tauri::command]
pub fn open_twitch_login_window(app: AppHandle, url: String) -> Result<(), String> {
    emit_overlay_open(&app, "twitch-login", &url, "fullbody")
}

/// Take over the app body with the drops/points device-code login. The active
/// account's profile already holds its twitch.tv session, so the user is shown as
/// signed in and only authorizes the device. Shows the live URL in a bar at the top.
#[tauri::command]
pub fn open_drops_login_window(app: AppHandle, url: String) -> Result<(), String> {
    emit_overlay_open(&app, "drops-login", &url, "fullbody")
}

/// Open the Twitch subscribe page for a channel as a centered in-app panel, isolated
/// to the active (main) account's web profile so you subscribe as the account you
/// watch and stream as. Returns the overlay label so the caller can dismiss it when a
/// subscription is detected. The panel header shows the live URL.
#[tauri::command]
pub fn open_subscribe_window(
    app: AppHandle,
    channel_login: String,
    title: Option<String>,
) -> Result<String, String> {
    let _ = title; // the panel header shows the live URL, not a window title
    let label = format!(
        "subscribe-{}-{}",
        channel_login,
        chrono::Utc::now().timestamp_millis()
    );
    let url = format!("https://www.twitch.tv/subs/{}", channel_login);
    emit_overlay_open(&app, &label, &url, "panel")?;
    Ok(label)
}

/// Check if stored credentials exist (for showing appropriate toasts)
#[tauri::command]
pub async fn has_stored_credentials() -> Result<bool, String> {
    Ok(TwitchService::has_stored_credentials().await)
}

#[tauri::command]
pub async fn get_followed_streams(state: State<'_, AppState>) -> Result<Vec<TwitchStream>, String> {
    TwitchService::get_followed_streams(&state)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_channel_info(
    channel_name: String,
    state: State<'_, AppState>,
) -> Result<ChannelInfo, String> {
    TwitchService::get_channel_info(&channel_name, &state)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_user_info(_state: State<'_, AppState>) -> Result<UserInfo, String> {
    TwitchService::get_user_info()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_recommended_streams(
    state: State<'_, AppState>,
) -> Result<Vec<TwitchStream>, String> {
    TwitchService::get_recommended_streams(&state)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_recommended_streams_paginated(
    state: State<'_, AppState>,
    cursor: Option<String>,
    limit: u32,
) -> Result<(Vec<TwitchStream>, Option<String>), String> {
    TwitchService::get_recommended_streams_paginated(&state, cursor, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_browser_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| format!("Failed to open browser: {}", e))
}

#[tauri::command]
pub async fn focus_window(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;

    if let Some(window) = app.get_webview_window("main") {
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus window: {}", e))?;

        // Also unminimize if minimized
        if window.is_minimized().unwrap_or(false) {
            window
                .unminimize()
                .map_err(|e| format!("Failed to unminimize window: {}", e))?;
        }

        Ok(())
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
pub async fn get_top_games(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<serde_json::Value>, String> {
    TwitchService::get_top_games(&state, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_top_games_paginated(
    state: State<'_, AppState>,
    cursor: Option<String>,
    limit: u32,
) -> Result<(Vec<serde_json::Value>, Option<String>), String> {
    TwitchService::get_top_games_paginated(&state, cursor, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_streams_by_game(
    state: State<'_, AppState>,
    game_id: String,
    cursor: Option<String>,
    limit: u32,
) -> Result<(Vec<TwitchStream>, Option<String>), String> {
    TwitchService::get_streams_by_game(&state, &game_id, cursor, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_channels(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<TwitchStream>, String> {
    TwitchService::search_channels(&state, &query)
        .await
        .map_err(|e| e.to_string())
}

/// Live streams in a category filtered by freeform tags (server-side via GQL).
#[tauri::command]
pub async fn get_streams_by_game_with_tags(
    game_name: String,
    tags: Vec<String>,
    cursor: Option<String>,
    limit: u32,
) -> Result<(Vec<TwitchStream>, Option<String>), String> {
    TwitchService::get_streams_by_game_with_tags(&game_name, tags, cursor, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_user_by_id(user_id: String) -> Result<UserInfo, String> {
    TwitchService::get_user_by_id(&user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_user_by_login(login: String) -> Result<UserInfo, String> {
    TwitchService::get_user_by_login(&login)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn follow_channel(target_user_id: String) -> Result<(), String> {
    TwitchService::follow_channel(&target_user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unfollow_channel(target_user_id: String) -> Result<(), String> {
    TwitchService::unfollow_channel(&target_user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_all_followed_channels(
    limit: u32,
    cursor: Option<String>,
) -> Result<(Vec<TwitchStream>, Option<String>), String> {
    TwitchService::get_all_followed_channels(limit, cursor)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_offline_last_broadcasts(
    user_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, Option<String>>, String> {
    TwitchService::get_offline_last_broadcasts(user_ids)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_following_status(target_user_id: String) -> Result<bool, String> {
    TwitchService::check_following_status(&target_user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_pinned_chat_messages(
    channel_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    TwitchService::get_pinned_chat_messages(&channel_id)
        .await
        .map_err(|e| e.to_string())
}

/// Verify the current token's health and return detailed status
/// This should be called on app startup to proactively check/refresh the token
#[tauri::command]
pub async fn verify_token_health() -> Result<TokenHealthStatus, String> {
    TwitchService::verify_token_health()
        .await
        .map_err(|e| e.to_string())
}

/// Force refresh the token even if it hasn't expired yet
#[tauri::command]
pub async fn force_refresh_token() -> Result<String, String> {
    TwitchService::force_refresh_token()
        .await
        .map_err(|e| e.to_string())
}

/// Get the current access token for authenticated API calls
/// Returns None (as error) if user is not logged in
#[tauri::command]
pub async fn get_twitch_token() -> Result<String, String> {
    TwitchService::get_token().await.map_err(|e| e.to_string())
}

/// Check if a specific stream is currently online by user login
/// Returns the stream data if online, None if offline
#[tauri::command]
pub async fn check_stream_online(user_login: String) -> Result<Option<TwitchStream>, String> {
    TwitchService::check_stream_online(&user_login)
        .await
        .map_err(|e| e.to_string())
}

/// Batched liveness check for many logins (chunked 100/call). Returns only the
/// logins that are currently live. Use this over N× check_stream_online for
/// large allow-lists (e.g. special-event ACL drops).
#[tauri::command]
pub async fn check_streams_online(user_logins: Vec<String>) -> Result<Vec<TwitchStream>, String> {
    TwitchService::check_streams_online(&user_logins)
        .await
        .map_err(|e| e.to_string())
}

/// Get streams by game name (convenience method that resolves game name to ID)
/// Returns streams sorted by viewer count (highest first)
#[tauri::command]
pub async fn get_streams_by_game_name(
    state: State<'_, AppState>,
    game_name: String,
    exclude_user_login: Option<String>,
    cursor: Option<String>,
    limit: u32,
) -> Result<(Vec<TwitchStream>, Option<String>), String> {
    TwitchService::get_streams_by_game_name(
        &state,
        &game_name,
        exclude_user_login.as_deref(),
        cursor.as_deref(),
        limit,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Get streams by category id directly (no name→id resolution)
/// Returns streams sorted by viewer count (highest first)
#[tauri::command]
pub async fn get_streams_by_game_id(
    state: State<'_, AppState>,
    game_id: String,
    exclude_user_login: Option<String>,
    cursor: Option<String>,
    limit: u32,
) -> Result<(Vec<TwitchStream>, Option<String>), String> {
    TwitchService::get_streams_by_game_id(
        &state,
        &game_id,
        exclude_user_login.as_deref(),
        cursor.as_deref(),
        limit,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Send a whisper message to another user
/// Requires user:manage:whispers scope
#[tauri::command]
pub async fn send_whisper(to_user_id: String, message: String) -> Result<(), String> {
    TwitchService::send_whisper(&to_user_id, &message)
        .await
        .map_err(|e| e.to_string())
}

/// Start listening for whisper messages via EventSub WebSocket
/// This should be called after the user is authenticated
#[tauri::command]
pub async fn start_whisper_listener(
    app: AppHandle,
    whisper_service: State<'_, Arc<TokioMutex<WhisperService>>>,
) -> Result<(), String> {
    // Get the current user's ID and token
    let user_info = TwitchService::get_user_info()
        .await
        .map_err(|e| format!("Failed to get user info: {}", e))?;

    let token = TwitchService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;

    // Start the whisper listener
    let service = whisper_service.lock().await;
    service
        .start_listening(user_info.id, token, app)
        .await
        .map_err(|e| format!("Failed to start whisper listener: {}", e))?;

    Ok(())
}

/// Get whisper message history for a specific user
/// Uses undocumented Twitch GraphQL API
#[tauri::command]
pub async fn get_whisper_history(
    other_user_id: String,
    cursor: Option<String>,
) -> Result<(Vec<WhisperMessage>, Option<String>), String> {
    let token = TwitchService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;

    let user_info = TwitchService::get_user_info()
        .await
        .map_err(|e| format!("Failed to get user info: {}", e))?;

    WhisperHistoryService::get_whisper_messages(
        &token,
        &user_info.id,
        &other_user_id,
        cursor.as_deref(),
    )
    .await
}

/// Search for a user to whisper using official Helix API
#[tauri::command]
pub async fn search_whisper_user(
    username: String,
) -> Result<Option<(String, String, String, Option<String>)>, String> {
    // Use the official Helix API to find user by login
    match TwitchService::get_user_by_login(&username).await {
        Ok(user) => Ok(Some((
            user.id,
            user.login,
            user.display_name,
            user.profile_image_url,
        ))),
        Err(_) => {
            // User not found
            Ok(None)
        }
    }
}

/// Import all whisper history for a list of known user IDs
/// Used to fetch all messages from existing conversations
#[tauri::command]
pub async fn import_all_whisper_history(
    user_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, Vec<WhisperMessage>>, String> {
    let token = TwitchService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;

    let user_info = TwitchService::get_user_info()
        .await
        .map_err(|e| format!("Failed to get user info: {}", e))?;

    let result =
        WhisperHistoryService::import_full_history(&token, &user_info.id, user_ids).await?;

    Ok(result.messages_by_user)
}

/// Refresh recent whispers for the given conversations. Fetches only the most
/// recent page per conversation (cheap), so messages sent from other clients
/// since the last sync show up; the frontend merges them into history by
/// timestamp. Authenticates with the active account's harvested web session
/// token, which matches the web Client-Id the whisper GQL requires (the main
/// app token does not, which is why the old GQL path failed). It's a read, so
/// no integrity token is needed.
#[tauri::command]
pub async fn refresh_whisper_history(
    state: State<'_, AppState>,
    user_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, Vec<WhisperMessage>>, String> {
    let token = state
        .twitch_auth
        .get_token()
        .await
        .map_err(|_| "You must be logged in to Twitch to refresh whispers.".to_string())?;

    let user_info = TwitchService::get_user_info()
        .await
        .map_err(|e| format!("Failed to get user info: {}", e))?;

    let mut out: std::collections::HashMap<String, Vec<WhisperMessage>> =
        std::collections::HashMap::new();
    for uid in user_ids {
        match WhisperHistoryService::get_whisper_messages(&token, &user_info.id, &uid, None).await {
            Ok((messages, _cursor)) => {
                if !messages.is_empty() {
                    out.insert(uid, messages);
                }
            }
            Err(e) => log::debug!("[WhisperRefresh] thread {} failed: {}", uid, e),
        }
    }
    Ok(out)
}

/// Search for categories by name (uses Twitch search API for fuzzy matching)
/// Returns a list of matching categories with id, name, and box_art_url
#[tauri::command]
pub async fn search_categories(
    query: String,
    limit: u32,
) -> Result<Vec<serde_json::Value>, String> {
    TwitchService::search_categories(&query, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_clips_by_game(
    _state: State<'_, AppState>,
    game_id: String,
    limit: u32,
    cursor: Option<String>,
    period: Option<String>,
) -> Result<(Vec<TwitchClip>, Option<String>), String> {
    TwitchService::get_clips_by_game(&game_id, limit, cursor.as_deref(), period.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_clips_by_broadcaster(
    _state: State<'_, AppState>,
    broadcaster_id: String,
    limit: u32,
    cursor: Option<String>,
    period: Option<String>,
) -> Result<(Vec<TwitchClip>, Option<String>), String> {
    TwitchService::get_clips_by_broadcaster(
        &broadcaster_id,
        limit,
        cursor.as_deref(),
        period.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_clip_reactions(
    _state: State<'_, AppState>,
    slugs: Vec<String>,
) -> Result<Vec<crate::models::stream::ClipReactions>, String> {
    TwitchService::get_clip_reactions(&slugs)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_games_by_ids(
    _state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<Vec<serde_json::Value>, String> {
    TwitchService::get_games_by_ids(&ids)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_videos_by_game(
    _state: State<'_, AppState>,
    game_id: String,
    sort: String,
    limit: u32,
    cursor: Option<String>,
    period: Option<String>,
) -> Result<(Vec<TwitchVideo>, Option<String>), String> {
    TwitchService::get_videos_by_game(&game_id, &sort, period.as_deref(), limit, cursor.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_user_videos(
    _state: State<'_, AppState>,
    user_id: String,
    sort: String,
    video_type: Option<String>,
    limit: u32,
    cursor: Option<String>,
) -> Result<(Vec<TwitchVideo>, Option<String>), String> {
    TwitchService::get_user_videos(
        &user_id,
        &sort,
        video_type.as_deref(),
        limit,
        cursor.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_chat_settings(
    broadcaster_id: String,
    settings: serde_json::Value,
) -> Result<(), String> {
    TwitchService::update_chat_settings(&broadcaster_id, settings)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_chat(broadcaster_id: String) -> Result<(), String> {
    TwitchService::clear_chat(&broadcaster_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_chat_message(broadcaster_id: String, message_id: String) -> Result<(), String> {
    TwitchService::delete_chat_message(&broadcaster_id, &message_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pin_chat_message(
    broadcaster_id: String,
    message_id: String,
    duration_seconds: Option<u32>,
) -> Result<(), String> {
    TwitchService::pin_chat_message(&broadcaster_id, &message_id, duration_seconds)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unpin_chat_message(broadcaster_id: String, message_id: String) -> Result<(), String> {
    TwitchService::unpin_chat_message(&broadcaster_id, &message_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ban_user(
    broadcaster_id: String,
    target_user_id: String,
    duration: Option<u32>,
    reason: Option<String>,
) -> Result<(), String> {
    TwitchService::ban_user(
        &broadcaster_id,
        &target_user_id,
        duration,
        reason.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unban_user(broadcaster_id: String, target_user_id: String) -> Result<(), String> {
    TwitchService::unban_user(&broadcaster_id, &target_user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_channel_moderator(
    broadcaster_id: String,
    target_user_id: String,
) -> Result<(), String> {
    TwitchService::add_channel_moderator(&broadcaster_id, &target_user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_channel_moderator(
    broadcaster_id: String,
    target_user_id: String,
) -> Result<(), String> {
    TwitchService::remove_channel_moderator(&broadcaster_id, &target_user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_channel_vip(broadcaster_id: String, target_user_id: String) -> Result<(), String> {
    TwitchService::add_channel_vip(&broadcaster_id, &target_user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_channel_vip(
    broadcaster_id: String,
    target_user_id: String,
) -> Result<(), String> {
    TwitchService::remove_channel_vip(&broadcaster_id, &target_user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_suspicious_user_status(
    broadcaster_id: String,
    target_user_id: String,
    status: String,
) -> Result<(), String> {
    TwitchService::update_suspicious_user_status(&broadcaster_id, &target_user_id, &status)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_user_chat_color(target_user_id: String, color: String) -> Result<(), String> {
    TwitchService::update_user_chat_color(&target_user_id, &color)
        .await
        .map_err(|e| e.to_string())
}

/// Batch-fetch users' chosen Twitch name colors (`user_id -> hex`). Never errors:
/// returns an empty map when unauthenticated or on request failure so the chat
/// render path degrades to its default color.
#[tauri::command]
pub async fn get_user_chat_colors(
    user_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    Ok(TwitchService::get_user_chat_colors(user_ids).await)
}

#[tauri::command]
pub async fn block_user(target_user_id: String) -> Result<(), String> {
    TwitchService::block_user(&target_user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unblock_user(target_user_id: String) -> Result<(), String> {
    TwitchService::unblock_user(&target_user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_channel_moderators(
    broadcaster_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    TwitchService::get_channel_moderators(&broadcaster_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_channel_vips(broadcaster_id: String) -> Result<Vec<serde_json::Value>, String> {
    TwitchService::get_channel_vips(&broadcaster_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_chatters_by_role(channel_login: String) -> Result<serde_json::Value, String> {
    TwitchService::get_chatters_by_role(&channel_login)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_channel_chatters(
    broadcaster_id: String,
    channel_login: String,
) -> Result<serde_json::Value, String> {
    TwitchService::get_channel_chatters(&broadcaster_id, &channel_login)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_chat_announcement(
    broadcaster_id: String,
    message: String,
    color: Option<String>,
) -> Result<(), String> {
    TwitchService::send_chat_announcement(&broadcaster_id, &message, color.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_shoutout(broadcaster_id: String, target_user_id: String) -> Result<(), String> {
    TwitchService::send_shoutout(&broadcaster_id, &target_user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_commercial(broadcaster_id: String, length: u32) -> Result<(), String> {
    TwitchService::start_commercial(&broadcaster_id, length)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_raid(broadcaster_id: String, target_user_id: String) -> Result<(), String> {
    TwitchService::start_raid(&broadcaster_id, &target_user_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_raid(broadcaster_id: String) -> Result<(), String> {
    TwitchService::cancel_raid(&broadcaster_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_stream_marker(
    user_id: String,
    description: Option<String>,
) -> Result<(), String> {
    TwitchService::create_stream_marker(&user_id, description.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn warn_chat_user(
    broadcaster_id: String,
    target_user_id: String,
    reason: String,
) -> Result<(), String> {
    TwitchService::warn_chat_user(&broadcaster_id, &target_user_id, &reason)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_shield_mode(broadcaster_id: String, is_active: bool) -> Result<(), String> {
    TwitchService::update_shield_mode(&broadcaster_id, is_active)
        .await
        .map_err(|e| e.to_string())
}
