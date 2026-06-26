//! YouTube webview-session auth.
//!
//! There is no OAuth app / Data-API path here (its per-project quota caps the whole
//! userbase at ~200 actions/day). Instead we drive the user's own logged-in YouTube
//! web session — exactly how StreamNook already drives authenticated Twitch/Kick
//! sessions, and how masterchat / YouTube.js work: the user signs into YouTube in a
//! webview, we harvest the session cookies from a persistent per-platform WebView2
//! profile, and authenticate private `youtubei/v1` requests (send / moderate) with
//! the `SAPISIDHASH` scheme the web client uses.
//!
//! The harvested cookies are cached + persisted (keyring, obfuscated-file fallback)
//! so a send doesn't re-open a webview every launch; the WebView2 profile also keeps
//! the login itself across restarts.

use crate::services::twitch_service::get_app_data_dir;
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const ORIGIN: &str = "https://www.youtube.com";
const LOGIN_WINDOW_LABEL: &str = "youtube-login";
const HARVEST_WINDOW_LABEL: &str = "youtube-harvest";
// We harvest + send the ENTIRE youtube.com cookie set (not a cherry-picked list),
// exactly what the browser sends. Modern YouTube validates more than the classic
// SAPISID/APISID/HSID/SID/SSID set (e.g. the __Secure-*PSIDTS session-timestamp
// cookies), so sending all of them is what stops the 401 "must be signed in".
const KEYRING_SERVICE: &str = "streamnook_youtube_session";
const KEYRING_USER: &str = "default";
const OBF_KEY: &[u8] = b"StreamNookYouTubeKey2026";

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
struct YouTubeSession {
    cookies: HashMap<String, String>,
    #[serde(default)]
    account_name: Option<String>,
    // True once harvested with the full-cookie-set logic. Sessions persisted before
    // that (serde default false) report disconnected so a frictionless reconnect
    // re-harvests the complete set from the still-signed-in profile.
    #[serde(default)]
    complete: bool,
}

static SESSION: OnceLock<Mutex<Option<YouTubeSession>>> = OnceLock::new();

fn session_cell() -> &'static Mutex<Option<YouTubeSession>> {
    SESSION.get_or_init(|| Mutex::new(load_persisted()))
}

fn session_path() -> Option<PathBuf> {
    get_app_data_dir().ok().map(|d| d.join(".youtube_session"))
}

fn obfuscate(data: &[u8]) -> Vec<u8> {
    data.iter()
        .enumerate()
        .map(|(i, b)| b ^ OBF_KEY[i % OBF_KEY.len()])
        .collect()
}

fn persist(sess: &YouTubeSession) {
    let Ok(json) = serde_json::to_string(sess) else {
        return;
    };
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        let _ = entry.set_password(&json);
    }
    if let Some(p) = session_path() {
        let _ = std::fs::write(p, obfuscate(json.as_bytes()));
    }
}

fn load_persisted() -> Option<YouTubeSession> {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        if let Ok(json) = entry.get_password() {
            if let Ok(s) = serde_json::from_str::<YouTubeSession>(&json) {
                return Some(s);
            }
        }
    }
    let p = session_path()?;
    let raw = std::fs::read(p).ok()?;
    let json = String::from_utf8(obfuscate(&raw)).ok()?;
    serde_json::from_str(&json).ok()
}

fn clear_persisted() {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        let _ = entry.delete_credential();
    }
    if let Some(p) = session_path() {
        let _ = std::fs::remove_file(p);
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn sha1_hex(input: &str) -> String {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(input.as_bytes());
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

/// The per-platform WebView2 profile that persists the YouTube login (mirrors the
/// Kick resolver profile layout).
fn youtube_profile_dir() -> PathBuf {
    let base = get_app_data_dir().unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join("platform_web_profiles").join("youtube");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

// --- Public surface ---------------------------------------------------------

/// Whether we hold a usable YouTube session. Requires SAPISID (the hashed cookie)
/// AND APISID — a session missing APISID (e.g. one harvested before APISID was
/// captured) reports disconnected so a reconnect re-harvests the full set from the
/// still-logged-in profile rather than failing every authenticated request.
pub fn is_connected() -> bool {
    session_cell()
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .map(|s| s.complete && sapisid(&s.cookies).is_some() && s.cookies.contains_key("APISID"))
        .unwrap_or(false)
}

/// The cached connected-account name (None if not yet fetched).
pub fn account_name() -> Option<String> {
    session_cell().lock().ok().and_then(|s| s.clone()).and_then(|s| s.account_name)
}

/// The connected account's name for the Connections UI: cached, else fetched once
/// (and cached/persisted) so an already-connected session gets its name without a
/// reconnect. None when signed out or the fetch fails.
pub async fn account_name_lazy() -> Option<String> {
    if let Some(n) = account_name() {
        return Some(n);
    }
    if !is_connected() {
        return None;
    }
    let name = fetch_account_name().await?;
    if let Ok(mut s) = session_cell().lock() {
        if let Some(sess) = s.as_mut() {
            sess.account_name = Some(name.clone());
        }
    }
    if let Some(sess) = session_cell().lock().ok().and_then(|s| s.clone()) {
        persist(&sess);
    }
    Some(name)
}

/// The headers that authenticate a private `youtubei/v1` request as this user:
/// the Cookie header + the per-request `SAPISIDHASH` Authorization. None when not
/// connected. Recomputed each call (the hash is timestamped).
pub fn auth_headers() -> Option<Vec<(String, String)>> {
    let sess = session_cell().lock().ok()?.clone()?;
    let sapisid = sapisid(&sess.cookies)?;
    let ts = now();
    let digest = sha1_hex(&format!("{} {} {}", ts, sapisid, ORIGIN));
    let cookie = sess
        .cookies
        .iter()
        .map(|(k, v)| format!("{}={};", k, v))
        .collect::<Vec<_>>()
        .join(" ");
    Some(vec![
        ("Cookie".to_string(), cookie),
        ("Authorization".to_string(), format!("SAPISIDHASH {}_{}", ts, digest)),
        ("Origin".to_string(), ORIGIN.to_string()),
        ("X-Origin".to_string(), ORIGIN.to_string()),
        ("X-Goog-AuthUser".to_string(), "0".to_string()),
    ])
}

fn sapisid(cookies: &HashMap<String, String>) -> Option<&String> {
    cookies
        .get("SAPISID")
        .or_else(|| cookies.get("__Secure-3PAPISID"))
        .or_else(|| cookies.get("__Secure-1PAPISID"))
}

/// Sign out: drop the cached/persisted session and wipe the YouTube webview profile
/// so the next connect is a fresh login.
pub fn disconnect() {
    if let Ok(mut s) = session_cell().lock() {
        *s = None;
    }
    clear_persisted();
    let _ = std::fs::remove_dir_all(youtube_profile_dir());
}

// --- Connect (login webview + cookie harvest) -------------------------------

#[cfg(windows)]
pub async fn connect() -> Result<()> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    let app = crate::services::providers::app_handle()
        .ok_or_else(|| anyhow!("app handle not available for YouTube login"))?;

    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = existing.set_focus();
        let _ = existing.destroy();
    }

    let url = WebviewUrl::External(
        tauri::Url::parse(ORIGIN).map_err(|e| anyhow!("bad url: {}", e))?,
    );
    WebviewWindowBuilder::new(&app, LOGIN_WINDOW_LABEL, url)
        .title("Sign in to YouTube")
        .inner_size(480.0, 680.0)
        .data_directory(youtube_profile_dir())
        .build()
        .map_err(|e| anyhow!("YouTube login window failed: {}", e))?;

    // Poll the login window's cookies until the user finishes signing in (SAPISID
    // lands on youtube.com after the redirect back). Cap at ~5 minutes; if the user
    // closes the window we stop early.
    let mut harvested: Option<HashMap<String, String>> = None;
    for _ in 0..200 {
        if app.get_webview_window(LOGIN_WINDOW_LABEL).is_none() {
            break; // user closed the window
        }
        if let Ok(map) = fetch_cookies_from_window(&app, LOGIN_WINDOW_LABEL, &[]).await {
            // Wait for the full auth set (SAPISID + APISID), not just SAPISID, so we
            // never persist a half-harvested session that 401s every request.
            if sapisid(&map).is_some() && map.contains_key("APISID") {
                harvested = Some(map);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }

    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = window.destroy();
    }

    let cookies = harvested.ok_or_else(|| anyhow!("YouTube sign-in wasn't completed"))?;
    let mut sess = YouTubeSession {
        cookies,
        account_name: None,
        complete: true,
    };
    // Store first so auth_headers() (used by the account-name fetch) sees the session.
    if let Ok(mut s) = session_cell().lock() {
        *s = Some(sess.clone());
    }
    sess.account_name = fetch_account_name().await;
    persist(&sess);
    if let Ok(mut s) = session_cell().lock() {
        *s = Some(sess);
    }
    Ok(())
}

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// The connected account's display name, via the authenticated account-menu endpoint
/// (best-effort; None on any failure). The public web key works for authed calls too.
async fn fetch_account_name() -> Option<String> {
    let headers = auth_headers()?;
    let body = serde_json::json!({
        "context": { "client": { "clientName": "WEB", "clientVersion": "2.20240101.00.00", "hl": "en", "gl": "US" } }
    });
    let url = "https://www.youtube.com/youtubei/v1/account/account_menu?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false";
    let mut req = reqwest::Client::new().post(url).header("User-Agent", UA);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req.json(&body).send().await.ok()?;
    let v: serde_json::Value = resp.json().await.ok()?;
    find_account_name(&v)
}

/// Recursively pull `activeAccountHeaderRenderer.accountName` out of the account-menu
/// response (its exact action index varies).
fn find_account_name(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Object(map) => {
            if let Some(h) = map.get("activeAccountHeaderRenderer") {
                if let Some(name) = h.pointer("/accountName/simpleText").and_then(|x| x.as_str()) {
                    return Some(name.to_string());
                }
                if let Some(runs) = h.pointer("/accountName/runs").and_then(|r| r.as_array()) {
                    let s: String = runs
                        .iter()
                        .filter_map(|r| r.get("text").and_then(|t| t.as_str()))
                        .collect();
                    if !s.is_empty() {
                        return Some(s);
                    }
                }
            }
            map.values().find_map(find_account_name)
        }
        serde_json::Value::Array(arr) => arr.iter().find_map(find_account_name),
        _ => None,
    }
}

#[cfg(not(windows))]
pub async fn connect() -> Result<()> {
    Err(anyhow!(
        "YouTube login (webview cookie harvest) is only implemented on Windows so far"
    ))
}

/// Re-read the auth cookies from the (still-logged-in) YouTube profile via a hidden
/// webview — used to recover when a cached session goes stale without making the
/// user sign in again. Returns true if a SAPISID was found.
#[cfg(windows)]
pub async fn reharvest() -> bool {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    let Some(app) = crate::services::providers::app_handle() else {
        return false;
    };
    if let Some(existing) = app.get_webview_window(HARVEST_WINDOW_LABEL) {
        let _ = existing.destroy();
    }
    let Ok(url) = tauri::Url::parse("about:blank") else {
        return false;
    };
    if WebviewWindowBuilder::new(&app, HARVEST_WINDOW_LABEL, WebviewUrl::External(url))
        .title("")
        .inner_size(1.0, 1.0)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .data_directory(youtube_profile_dir())
        .build()
        .is_err()
    {
        return false;
    }
    let mut found = false;
    for attempt in 0..12 {
        if let Ok(map) = fetch_cookies_from_window(&app, HARVEST_WINDOW_LABEL, &[]).await {
            if sapisid(&map).is_some() && map.contains_key("APISID") {
                let sess = YouTubeSession {
                    cookies: map,
                    account_name: account_name(),
                    complete: true,
                };
                persist(&sess);
                if let Ok(mut s) = session_cell().lock() {
                    *s = Some(sess);
                }
                found = true;
                break;
            }
            if attempt >= 3 {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    if let Some(window) = app.get_webview_window(HARVEST_WINDOW_LABEL) {
        let _ = window.destroy();
    }
    found
}

#[cfg(not(windows))]
pub async fn reharvest() -> bool {
    false
}

// --- WebView2 cookie read (Windows) — mirrors twitch_auth_service ------------

#[cfg(windows)]
async fn fetch_cookies_from_window(
    app: &tauri::AppHandle,
    window_label: &str,
    names: &[&str],
) -> Result<HashMap<String, String>> {
    use std::sync::Arc;
    use tauri::Manager;
    use tokio::sync::oneshot;

    let webview = app
        .get_webview_window(window_label)
        .ok_or_else(|| anyhow!("webview window '{}' unavailable", window_label))?;

    let (tx, rx) = oneshot::channel::<Result<HashMap<String, String>>>();
    let tx_slot: Arc<std::sync::Mutex<Option<oneshot::Sender<_>>>> =
        Arc::new(std::sync::Mutex::new(Some(tx)));
    let tx_for_closure = tx_slot.clone();
    let targets: Vec<String> = names.iter().map(|s| s.to_string()).collect();

    let dispatched = webview.with_webview(move |platform_webview| {
        let setup = unsafe { request_cookies(platform_webview, tx_for_closure.clone(), targets.clone()) };
        if let Err(e) = setup {
            if let Some(sender) = tx_for_closure.lock().unwrap().take() {
                let _ = sender.send(Err(anyhow!("WebView2 GetCookies setup failed: {}", e)));
            }
        }
    });
    if let Err(e) = dispatched {
        return Err(anyhow!("with_webview: {}", e));
    }
    rx.await
        .map_err(|_| anyhow!("WebView2 cookie callback dropped"))?
}

#[cfg(windows)]
unsafe fn request_cookies(
    platform_webview: tauri::webview::PlatformWebview,
    tx_slot: std::sync::Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<HashMap<String, String>>>>>>,
    targets: Vec<String>,
) -> windows::core::Result<()> {
    use webview2_com::GetCookiesCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
    use windows::core::{Interface, HSTRING};

    let controller = platform_webview.controller();
    let core = controller.CoreWebView2()?;
    let core2: ICoreWebView2_2 = core.cast()?;
    let manager = core2.CookieManager()?;
    let uri = HSTRING::from(ORIGIN);

    let handler = GetCookiesCompletedHandler::create(Box::new(move |error_code, cookie_list| {
        let result = extract_cookies(error_code, cookie_list, &targets);
        if let Some(sender) = tx_slot.lock().unwrap().take() {
            let _ = sender.send(result);
        }
        Ok(())
    }));
    manager.GetCookies(&uri, &handler)?;
    Ok(())
}

#[cfg(windows)]
fn extract_cookies(
    completion: windows::core::Result<()>,
    cookie_list: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CookieList>,
    targets: &[String],
) -> Result<HashMap<String, String>> {
    use webview2_com::take_pwstr;
    use windows::core::PWSTR;

    completion.map_err(|e| anyhow!("GetCookies: {}", e))?;
    let list = cookie_list.ok_or_else(|| anyhow!("WebView2 returned null cookie list"))?;

    let mut count: u32 = 0;
    unsafe { list.Count(&mut count as *mut u32) }.map_err(|e| anyhow!("CookieList::Count: {}", e))?;

    let mut found: HashMap<String, String> = HashMap::new();
    for i in 0..count {
        let cookie = unsafe { list.GetValueAtIndex(i) }.map_err(|e| anyhow!("CookieList[{}]: {}", i, e))?;
        let mut name_ptr = PWSTR::null();
        unsafe { cookie.Name(&mut name_ptr as *mut PWSTR) }.map_err(|e| anyhow!("cookie.Name: {}", e))?;
        let name = take_pwstr(name_ptr);
        // Empty targets = capture every cookie (the whole browser Cookie set).
        if targets.is_empty() || targets.iter().any(|t| t == &name) {
            let mut value_ptr = PWSTR::null();
            unsafe { cookie.Value(&mut value_ptr as *mut PWSTR) }.map_err(|e| anyhow!("cookie.Value: {}", e))?;
            let value = take_pwstr(value_ptr);
            if !value.is_empty() {
                found.insert(name, value);
            }
        }
    }
    Ok(found)
}
