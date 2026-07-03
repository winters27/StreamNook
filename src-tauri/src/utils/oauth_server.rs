//! Minimal localhost OAuth callback listener used by the "add account" flow.
//!
//! Twitch redirects the browser to `http://localhost:3000/callback?code=...`
//! after the user authorizes. The port is fixed at 3000 to match the redirect
//! URI registered on the Twitch app. We bind the port up front (so a port-in-use
//! failure surfaces immediately, and the socket is ready before the browser
//! opens), then accept the single redirect, serve a small result page, and parse
//! the result. Hand-rolled over a raw `TcpListener` rather than a framework: it's
//! one GET request, and this keeps the future `Send` for Tauri's runtime without
//! fighting a server library's connection internals.

use anyhow::Result;
use std::collections::HashMap;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub struct OAuthCallbackData {
    pub code: String,
    pub state: Option<String>,
    /// Set when Twitch redirected with an `error` (e.g. the user denied access).
    pub error: Option<String>,
}

/// A bound callback listener on the fixed redirect port (3000).
pub struct OAuthListener {
    listener: TcpListener,
}

/// Bind the fixed OAuth callback port (3000) and return a ready listener. Binding
/// happens here (not in `wait`), so a port-in-use failure surfaces before the
/// browser is opened, and a fast redirect is held in the OS accept backlog until
/// `wait` runs.
pub async fn start_oauth_listener() -> Result<OAuthListener> {
    start_oauth_listener_on(3000).await
}

/// Bind a specific loopback callback port. Flows that register their own redirect
/// URI on a distinct port use this to stay independent of the add-account flow on
/// 3000 (the mod-room consent uses 8765).
pub async fn start_oauth_listener_on(port: u16) -> Result<OAuthListener> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| anyhow::anyhow!("OAuth callback port {} unavailable: {}", port, e))?;
    Ok(OAuthListener { listener })
}

impl OAuthListener {
    /// Accept connections until the OAuth redirect arrives (carrying `code` or
    /// `error`) or `timeout` elapses. Consuming `self` releases the port on
    /// return, so the next attempt can rebind.
    pub async fn wait(self, timeout: Duration) -> Result<OAuthCallbackData> {
        match tokio::time::timeout(timeout, self.accept_loop()).await {
            Ok(result) => result,
            Err(_) => Err(anyhow::anyhow!("Timed out waiting for Twitch sign-in")),
        }
    }

    async fn accept_loop(&self) -> Result<OAuthCallbackData> {
        loop {
            let (stream, _) = self.listener.accept().await?;
            // Ignore unrelated hits (favicon, browser preconnects, etc.) and keep
            // listening until the real redirect lands.
            if let Some(data) = handle_connection(stream).await {
                return Ok(data);
            }
        }
    }
}

/// Read one request; if it carries OAuth params, write the result page and return
/// the parsed data. Returns `None` for anything that isn't the redirect.
async fn handle_connection(mut stream: TcpStream) -> Option<OAuthCallbackData> {
    let mut buf = vec![0u8; 8192];
    let n = stream.read(&mut buf).await.ok()?;
    if n == 0 {
        return None;
    }
    let request = String::from_utf8_lossy(&buf[..n]);

    // Request line: "GET /callback?code=...&state=... HTTP/1.1"
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("");

    let query = match target.split_once('?') {
        Some((_, q)) => q,
        None => {
            write_response(&mut stream, "404 Not Found", "").await;
            return None;
        }
    };

    let params = parse_query(query);

    if let Some(code) = params.get("code") {
        write_response(&mut stream, "200 OK", SUCCESS_HTML).await;
        Some(OAuthCallbackData {
            code: code.clone(),
            state: params.get("state").cloned(),
            error: None,
        })
    } else if let Some(error) = params.get("error") {
        let desc = params
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| "Unknown error".to_string());
        let html = render_error_html(error, &desc);
        write_response(&mut stream, "200 OK", &html).await;
        Some(OAuthCallbackData {
            code: String::new(),
            state: params.get("state").cloned(),
            error: Some(format!("{}: {}", error, desc)),
        })
    } else {
        write_response(&mut stream, "404 Not Found", "").await;
        None
    }
}

async fn write_response(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            Some((percent_decode(k), percent_decode(v)))
        })
        .collect()
}

/// Minimal `application/x-www-form-urlencoded` value decoder (`+` -> space,
/// `%XX` -> byte). Enough for the `code`, `state`, and `error*` params Twitch
/// returns; malformed escapes are passed through verbatim.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

const SUCCESS_HTML: &str = r#"
<!DOCTYPE html>
<html>
<head>
    <title>StreamNook - Account Linked</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .container {
            background: white;
            padding: 3rem;
            border-radius: 1rem;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
            max-width: 400px;
        }
        h1 { color: #667eea; margin-bottom: 1rem; }
        p { color: #666; line-height: 1.6; }
        .checkmark { font-size: 4rem; color: #4CAF50; margin-bottom: 1rem; }
    </style>
</head>
<body>
    <div class="container">
        <div class="checkmark">✓</div>
        <h1>Account Linked!</h1>
        <p>This account is now connected to StreamNook.</p>
        <p>You can close this tab and return to the app.</p>
    </div>
</body>
</html>
"#;

fn render_error_html(error: &str, error_description: &str) -> String {
    format!(
        r#"
<!DOCTYPE html>
<html>
<head>
    <title>StreamNook - Sign-in Failed</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
        }}
        .container {{
            background: white;
            padding: 3rem;
            border-radius: 1rem;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
            max-width: 400px;
        }}
        h1 {{ color: #f5576c; margin-bottom: 1rem; }}
        p {{ color: #666; line-height: 1.6; }}
        .error-icon {{ font-size: 4rem; color: #f5576c; margin-bottom: 1rem; }}
    </style>
</head>
<body>
    <div class="container">
        <div class="error-icon">✗</div>
        <h1>Sign-in Failed</h1>
        <p><strong>Error:</strong> {}</p>
        <p>{}</p>
        <p>Please close this tab and try again.</p>
    </div>
</body>
</html>
"#,
        error, error_description
    )
}
