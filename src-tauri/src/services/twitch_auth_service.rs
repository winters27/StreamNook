// Centralized owner of the Twitch web session token.
//
// Replaces the old `webview_cookie` SQLite-scraping path: we now ask WebView2
// for the cookie through `ICoreWebView2CookieManager`, which is the only
// supported API surface and the only one that doesn't fight Chromium for
// the locked SQLite file or care about encryption schema changes.
//
// Architecture (see chat on 2026-05-15):
//   - One instance per app, owned by `AppState`.
//   - Callers (auth_proxy, streamlink invoker, quality probe) request the
//     token via `get_token()`; they never touch cookies directly.
//   - The service caches the token with a short TTL so concurrent callers
//     share a single fetch, and so retries don't hammer the COM bridge.
//   - On 401/403 from a Twitch endpoint, callers should call `invalidate()`
//     to force a re-fetch on the next request.
//
// On non-Windows the WebView2 bridge is stubbed to `WebViewUnavailable` so
// the service compiles cross-platform; StreamNook only ships on Windows
// today so this is just future-proofing.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tokio::sync::{oneshot, Mutex, RwLock};

/// How long a successfully-fetched token stays hot. Twitch web tokens last
/// for weeks, but a short TTL means a logout in the embedded browser is
/// noticed within minutes without us subscribing to cookie-change events.
const CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Debug, Clone)]
pub enum AuthError {
    /// The user isn't logged in to twitch.tv in the embedded WebView, or
    /// the auth-token cookie is empty.
    NotLoggedIn,
    /// WebView2 wasn't available to query (main window not yet created,
    /// or non-Windows platform).
    WebViewUnavailable,
    /// COM / WebView2 call failure with a diagnostic string. These are
    /// always loggable, never user-facing.
    Internal(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::NotLoggedIn => f.write_str("not logged in to twitch.tv in WebView"),
            AuthError::WebViewUnavailable => f.write_str("WebView2 not available"),
            AuthError::Internal(s) => write!(f, "internal: {}", s),
        }
    }
}

impl std::error::Error for AuthError {}

#[derive(Clone)]
struct CachedToken {
    value: String,
    cached_at: Instant,
}

struct Inner {
    app: AppHandle,
    cache: RwLock<Option<CachedToken>>,
    /// Single-flight gate: at most one in-flight WebView2 fetch at a time.
    /// Callers that race past a cache miss queue here and the second one
    /// finds the freshly-cached value once the lock releases.
    fetch_gate: Mutex<()>,
}

#[derive(Clone)]
pub struct TwitchAuthService {
    inner: Arc<Inner>,
}

impl TwitchAuthService {
    pub fn new(app: AppHandle) -> Self {
        Self {
            inner: Arc::new(Inner {
                app,
                cache: RwLock::new(None),
                fetch_gate: Mutex::new(()),
            }),
        }
    }

    /// Returns the current twitch.tv `auth-token` cookie value. Cached for
    /// `CACHE_TTL`; on miss falls through to the WebView2 cookie API.
    pub async fn get_token(&self) -> Result<String, AuthError> {
        if let Some(t) = self.cached().await {
            return Ok(t);
        }

        // Serialize concurrent fetches. A queued caller usually finds the
        // value cached by the time it acquires the lock — re-check.
        let _gate = self.inner.fetch_gate.lock().await;
        if let Some(t) = self.cached().await {
            return Ok(t);
        }

        let token = fetch_from_webview(&self.inner.app).await?;
        *self.inner.cache.write().await = Some(CachedToken {
            value: token.clone(),
            cached_at: Instant::now(),
        });
        Ok(token)
    }

    /// Drop the cached token. Call this when a Twitch API or Streamlink
    /// returns 401/403 with this token, so the next `get_token()` re-fetches.
    pub async fn invalidate(&self) {
        *self.inner.cache.write().await = None;
    }

    async fn cached(&self) -> Option<String> {
        let guard = self.inner.cache.read().await;
        guard
            .as_ref()
            .filter(|c| c.cached_at.elapsed() < CACHE_TTL)
            .map(|c| c.value.clone())
    }
}

// ---------------------------------------------------------------------------
// WebView2 bridge — Windows-only.
//
// Tauri's `with_webview` gives us the live `ICoreWebView2Controller` on the
// UI thread. We cast to `ICoreWebView2_2` (for `CookieManager`), call
// `GetCookies(https://twitch.tv, handler)`, and the handler fires back on
// the UI thread when WebView2 has the result. The handler signals a
// `oneshot::Sender` that we await from the async caller.
//
// We never marshal COM objects across threads — every COM call happens on
// the UI thread inside either `with_webview` or its callback dispatch.
// ---------------------------------------------------------------------------

#[cfg(windows)]
async fn fetch_from_webview(app: &AppHandle) -> Result<String, AuthError> {
    use tauri::Manager;

    let webview = app
        .get_webview_window("main")
        .ok_or(AuthError::WebViewUnavailable)?;

    let (tx, rx) = oneshot::channel::<Result<String, AuthError>>();
    // The handler closure runs on the UI thread, so it doesn't need Send,
    // but `with_webview`'s closure does — wrap in a Send-safe slot.
    let tx_slot: Arc<std::sync::Mutex<Option<oneshot::Sender<_>>>> =
        Arc::new(std::sync::Mutex::new(Some(tx)));

    let tx_for_closure = tx_slot.clone();
    let with_webview_result = webview.with_webview(move |platform_webview| {
        let setup_result = unsafe { request_cookies(platform_webview, tx_for_closure.clone()) };
        if let Err(e) = setup_result {
            if let Some(sender) = tx_for_closure.lock().unwrap().take() {
                let _ = sender.send(Err(AuthError::Internal(format!(
                    "WebView2 GetCookies setup failed: {}",
                    e
                ))));
            }
        }
    });

    if let Err(e) = with_webview_result {
        // `with_webview` failed to dispatch — sender was never consumed, so
        // synthesize the error directly.
        return Err(AuthError::Internal(format!("with_webview: {}", e)));
    }

    rx.await
        .map_err(|_| AuthError::Internal("WebView2 cookie callback was dropped".into()))?
}

#[cfg(windows)]
unsafe fn request_cookies(
    platform_webview: tauri::webview::PlatformWebview,
    tx_slot: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, AuthError>>>>>,
) -> windows::core::Result<()> {
    use webview2_com::GetCookiesCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
    use windows::core::{Interface, HSTRING};

    let controller = platform_webview.controller();
    let core = controller.CoreWebView2()?;
    let core2: ICoreWebView2_2 = core.cast()?;
    let manager = core2.CookieManager()?;

    let uri = HSTRING::from("https://twitch.tv");

    let handler = GetCookiesCompletedHandler::create(Box::new(move |error_code, cookie_list| {
        let result = extract_auth_token(error_code, cookie_list);
        if let Some(sender) = tx_slot.lock().unwrap().take() {
            let _ = sender.send(result);
        }
        Ok(())
    }));

    manager.GetCookies(&uri, &handler)?;
    Ok(())
}

#[cfg(windows)]
fn extract_auth_token(
    completion: windows::core::Result<()>,
    cookie_list: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CookieList>,
) -> Result<String, AuthError> {
    use webview2_com::take_pwstr;
    use windows::core::PWSTR;

    completion.map_err(|e| AuthError::Internal(format!("GetCookies: {}", e)))?;

    let list = cookie_list
        .ok_or_else(|| AuthError::Internal("WebView2 returned null cookie list".into()))?;

    let mut count: u32 = 0;
    unsafe { list.Count(&mut count as *mut u32) }
        .map_err(|e| AuthError::Internal(format!("CookieList::Count: {}", e)))?;

    for i in 0..count {
        let cookie = unsafe { list.GetValueAtIndex(i) }
            .map_err(|e| AuthError::Internal(format!("CookieList[{}]: {}", i, e)))?;

        let mut name_ptr = PWSTR::null();
        unsafe { cookie.Name(&mut name_ptr as *mut PWSTR) }
            .map_err(|e| AuthError::Internal(format!("cookie.Name: {}", e)))?;
        let name = take_pwstr(name_ptr);

        if name == "auth-token" {
            let mut value_ptr = PWSTR::null();
            unsafe { cookie.Value(&mut value_ptr as *mut PWSTR) }
                .map_err(|e| AuthError::Internal(format!("cookie.Value: {}", e)))?;
            let value = take_pwstr(value_ptr);
            if value.is_empty() {
                return Err(AuthError::NotLoggedIn);
            }
            return Ok(value);
        }
    }
    Err(AuthError::NotLoggedIn)
}

#[cfg(not(windows))]
async fn fetch_from_webview(_app: &AppHandle) -> Result<String, AuthError> {
    Err(AuthError::WebViewUnavailable)
}
