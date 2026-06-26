use crate::errors::TikTokLiveError;
use crate::http::ua::random_ua;

const TIKTOK_URL: &str = "https://www.tiktok.com/";

/// Fetch a fresh ttwid cookie from TikTok via unauthenticated GET.
///
/// The ttwid is a device fingerprint token set via `Set-Cookie` on any
/// request to tiktok.com. It requires no login, no signing, no browser.
/// This is the sole credential needed for WSS live stream connections.
///
/// Uses a random UA from the built-in pool. Pass a custom UA to override.
pub async fn fetch_ttwid(timeout: std::time::Duration, user_agent: Option<&str>, proxy: Option<&str>) -> Result<String, TikTokLiveError> {
    let ua = user_agent.unwrap_or_else(|| random_ua());

    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(ua)
        .redirect(reqwest::redirect::Policy::none());

    if let Some(proxy_url) = proxy {
        builder = builder.proxy(reqwest::Proxy::all(proxy_url).map_err(TikTokLiveError::Http)?);
    }

    let client = builder.build().map_err(TikTokLiveError::Http)?;

    let resp = client.get(TIKTOK_URL).send().await?;

    for cookie_header in resp.headers().get_all("set-cookie") {
        let value = cookie_header
            .to_str()
            .map_err(|e| TikTokLiveError::invalid(format!("set-cookie header: {e}")))?;

        if let Some(ttwid) = extract_ttwid(value) {
            return Ok(ttwid);
        }
    }

    Err(TikTokLiveError::invalid("no ttwid cookie in tiktok.com response"))
}

/// Extract the ttwid value from a Set-Cookie header string.
/// Format: `ttwid=1|<base64>|<ts>|<hmac>; Path=/; ...`
fn extract_ttwid(set_cookie: &str) -> Option<String> {
    if !set_cookie.starts_with("ttwid=") {
        return None;
    }

    let value = set_cookie.strip_prefix("ttwid=")?;
    let end = match value.find(';') {
        Some(pos) => pos,
        None => value.len(),
    };
    let ttwid = &value[..end];

    if ttwid.is_empty() {
        return None;
    }

    Some(ttwid.to_string())
}
