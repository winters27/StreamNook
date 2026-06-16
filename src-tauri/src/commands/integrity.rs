// Client-Integrity token provider for web-client GQL mutations.
//
// Twitch gates `gql.twitch.tv/integrity` behind Kasada bot-protection: a raw
// (non-browser) request gets a token, but it's an unverified one the mutation
// rejects with `IntegrityCheckFailed`. A token minted inside a real browser
// context, however, is accepted from any client (including our plain Rust
// requests) for the duration of its ~24h expiration, as long as the mutation
// reuses the `Client-Session-Id` the token was minted with.
//
// So we mint once in a hidden twitch.tv WebView2 (where Kasada runs), cache the
// {token, session_id, expiration}, and hand it to follow/unfollow/etc. which
// then call GQL directly from Rust. Minting happens rarely (cache miss / expiry).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use log::{info, warn};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

const MINT_WINDOW_PREFIX: &str = "sn-integrity-mint-";
/// Re-mint this far before the real expiry so an in-flight follow never races a
/// token that lapses mid-request.
const EXPIRY_SKEW_MS: u64 = 120_000;

#[derive(Clone)]
pub struct Integrity {
    pub token: String,
    pub session_id: String,
    pub expiration_ms: u64,
}

struct MintResult {
    ok: bool,
    token: Option<String>,
    session_id: Option<String>,
    expiration: Option<f64>,
    error: Option<String>,
}

lazy_static::lazy_static! {
    static ref CACHE: Mutex<Option<Integrity>> = Mutex::new(None);
    static ref PENDING: Mutex<HashMap<String, oneshot::Sender<MintResult>>> = Mutex::new(HashMap::new());
    /// Serializes minting so a burst of follows opens one window, not many.
    static ref MINT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::new(());
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn cached_valid() -> Option<Integrity> {
    CACHE
        .lock()
        .unwrap()
        .clone()
        .filter(|c| c.expiration_ms > now_ms() + EXPIRY_SKEW_MS)
}

/// Return a usable Client-Integrity token (token + the session id it's bound to),
/// minting a fresh one via a hidden twitch.tv webview if the cache is empty/stale.
pub async fn get_integrity(app: &AppHandle) -> Result<Integrity, String> {
    if let Some(c) = cached_valid() {
        return Ok(c);
    }
    // Only one mint at a time; the loser of the race finds the fresh cache.
    let _guard = MINT_LOCK.lock().await;
    if let Some(c) = cached_valid() {
        return Ok(c);
    }
    info!("[integrity] no valid cached token — minting via hidden twitch.tv webview");
    let minted = mint_via_webview(app).await?;
    *CACHE.lock().unwrap() = Some(minted.clone());
    save_to_disk(&minted);
    info!(
        "[integrity] minted new token, valid for ~{}s",
        minted.expiration_ms.saturating_sub(now_ms()) / 1000
    );
    Ok(minted)
}

fn cache_file() -> Option<PathBuf> {
    let mut p = dirs::config_dir()?;
    p.push("StreamNook");
    let _ = std::fs::create_dir_all(&p);
    p.push(".integrity_cache");
    Some(p)
}

/// Persist the token so a recent one survives a restart (it's a short-lived,
/// limited-scope integrity token, so plain JSON in the app config dir is fine).
fn save_to_disk(i: &Integrity) {
    if let Some(p) = cache_file() {
        let json = serde_json::json!({
            "token": i.token,
            "session_id": i.session_id,
            "expiration_ms": i.expiration_ms,
        });
        let _ = std::fs::write(p, json.to_string());
    }
}

fn load_from_disk() -> Option<Integrity> {
    let p = cache_file()?;
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
    Some(Integrity {
        token: v.get("token")?.as_str()?.to_string(),
        session_id: v.get("session_id")?.as_str()?.to_string(),
        expiration_ms: v.get("expiration_ms")?.as_u64()?,
    })
}

/// Background warmer: keep a valid integrity token ready at all times so a follow
/// never waits on a mint. Seeds from disk on launch, mints ahead when none is
/// valid (only while signed in — minting needs a live twitch.tv session), and
/// wakes shortly before expiry to re-mint. Spawned once at startup.
pub async fn warm_integrity(app: AppHandle) {
    if CACHE.lock().unwrap().is_none() {
        if let Some(disk) = load_from_disk() {
            *CACHE.lock().unwrap() = Some(disk);
        }
    }
    // Let the main window settle before the first hidden-webview mint.
    tokio::time::sleep(Duration::from_secs(8)).await;

    loop {
        if let Some(c) = cached_valid() {
            // Re-mint a touch before it lapses; never sleep less than 30s.
            let wait = c
                .expiration_ms
                .saturating_sub(now_ms())
                .saturating_sub(EXPIRY_SKEW_MS)
                .max(30_000);
            tokio::time::sleep(Duration::from_millis(wait)).await;
            continue;
        }

        // No valid token. Only mint when there's a web session to mint against;
        // otherwise the hidden page would just fail. Re-check until logged in.
        let logged_in = app
            .state::<crate::models::settings::AppState>()
            .twitch_auth
            .get_token()
            .await
            .is_ok();
        if !logged_in {
            tokio::time::sleep(Duration::from_secs(60)).await;
            continue;
        }

        if let Err(e) = get_integrity(&app).await {
            warn!("[integrity] background mint failed: {}; retrying in 60s", e);
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    }
}

async fn mint_via_webview(app: &AppHandle) -> Result<Integrity, String> {
    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = oneshot::channel::<MintResult>();
    PENDING.lock().unwrap().insert(request_id.clone(), tx);

    let label = format!("{}{}", MINT_WINDOW_PREFIX, request_id);
    let profile = crate::services::twitch_service::active_twitch_web_profile_dir()
        .map_err(|e| format!("integrity: no web profile: {}", e))?;
    let url = WebviewUrl::External(
        "https://www.twitch.tv/"
            .parse()
            .map_err(|e| format!("integrity: bad url: {}", e))?,
    );
    let script = mint_script(&request_id);

    let build = WebviewWindowBuilder::new(app, &label, url)
        .title("")
        .inner_size(480.0, 640.0)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .data_directory(profile)
        .initialization_script(&script)
        .build();

    if let Err(e) = build {
        PENDING.lock().unwrap().remove(&request_id);
        return Err(format!("integrity: mint window build failed: {}", e));
    }
    info!(
        "[integrity] mint webview opened ({}), waiting for token…",
        label
    );

    // Kasada needs a beat to initialize after load; the page-side script retries,
    // so give it a generous overall ceiling.
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(35), rx).await;

    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.destroy();
    }
    PENDING.lock().unwrap().remove(&request_id);

    match outcome {
        Ok(Ok(r)) if r.ok => {
            let token = r.token.ok_or("integrity: mint ok but no token")?;
            let session_id = r.session_id.ok_or("integrity: mint ok but no session id")?;
            // Twitch returns an absolute ms epoch; fall back to a short window.
            let expiration_ms = r
                .expiration
                .map(|e| e as u64)
                .filter(|e| *e > now_ms())
                .unwrap_or_else(|| now_ms() + 10 * 60 * 1000);
            Ok(Integrity {
                token,
                session_id,
                expiration_ms,
            })
        }
        Ok(Ok(r)) => {
            let msg = format!(
                "integrity: mint failed in webview: {}",
                r.error.unwrap_or_else(|| "unknown".into())
            );
            warn!("[integrity] {}", msg);
            Err(msg)
        }
        Ok(Err(_)) => {
            warn!("[integrity] mint channel dropped before a result arrived");
            Err("integrity: mint channel dropped".into())
        }
        Err(_) => {
            warn!("[integrity] mint timed out after 35s (page never reported back)");
            Err("integrity: mint timed out (Kasada not ready / not logged in)".into())
        }
    }
}

/// Called by the hidden mint webview's init script with the result.
#[tauri::command]
pub async fn receive_integrity_token(
    request_id: String,
    ok: bool,
    token: Option<String>,
    session_id: Option<String>,
    expiration: Option<f64>,
    error: Option<String>,
) -> Result<(), String> {
    if !ok {
        warn!(
            "[integrity] webview mint reported failure: {}",
            error.clone().unwrap_or_default()
        );
    }
    if let Some(tx) = PENDING.lock().unwrap().remove(&request_id) {
        let _ = tx.send(MintResult {
            ok,
            token,
            session_id,
            expiration,
            error,
        });
    }
    Ok(())
}

/// Page-side init script: runs at document start on the hidden twitch.tv page,
/// waits for Kasada to take over `fetch`, mints an integrity token, and reports
/// it back. Retries because Kasada isn't active the instant the document starts.
fn mint_script(request_id: &str) -> String {
    format!(
        r#"(function(){{
  if (window.top !== window.self) return; // top frame only, skip twitch iframes
  var REQ = "{req}";
  function send(p) {{ p.requestId = REQ; try {{ window.__TAURI_INTERNALS__.invoke('receive_integrity_token', p); }} catch (e) {{}} }}
  function ck(n) {{ var f = document.cookie.split('; ').find(function(c) {{ return c.indexOf(n + '=') === 0; }}); return f ? f.split('=')[1] : ''; }}
  function uid() {{ try {{ return crypto.randomUUID().replace(/-/g, ''); }} catch (e) {{ return (Date.now().toString(36) + Math.random().toString(36).slice(2)); }} }}
  var tries = 0;
  function attempt() {{
    tries++;
    var auth = ck('auth-token');
    var dev = ck('unique_id') || '';
    if (!auth) {{ if (tries < 14) return void setTimeout(attempt, 1500); return void send({{ ok: false, error: 'no auth-token cookie in profile' }}); }}
    var sid = uid();
    fetch('https://gql.twitch.tv/integrity', {{
      method: 'POST',
      headers: {{ 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Authorization': 'OAuth ' + auth, 'X-Device-Id': dev, 'Client-Session-Id': sid, 'Client-Request-Id': uid() }}
    }})
      .then(function(r) {{ return r.json(); }})
      .then(function(j) {{
        if (j && j.token) {{ send({{ ok: true, token: j.token, sessionId: sid, expiration: (j.expiration || 0) }}); }}
        else if (tries < 14) {{ setTimeout(attempt, 1500); }}
        else {{ send({{ ok: false, error: 'integrity endpoint returned no token after retries' }}); }}
      }})
      .catch(function(e) {{ if (tries < 14) {{ setTimeout(attempt, 1500); }} else {{ send({{ ok: false, error: 'fetch failed: ' + e }}); }} }});
  }}
  setTimeout(attempt, 1500); // let Kasada install its fetch wrapper first
}})();"#,
        req = request_id
    )
}
