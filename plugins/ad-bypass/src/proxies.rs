//! The community playlist-proxy pool and the master-playlist race.
//!
//! These proxies fetch a Twitch master playlist from their own region with an
//! anonymous session, which Twitch's server-side ad insertion does not stitch
//! ads into. The race fires every candidate in parallel and takes the first
//! response that is actually a master playlist; the proxies are flaky enough
//! (HTTP 200 error pages, empty bodies) that validating the body shape is
//! what keeps a dead proxy from killing the whole resolve.

use anyhow::{anyhow, Result};
use futures::stream::{FuturesUnordered, StreamExt};
use reqwest::Client;

pub const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0";

/// Bundled proxy pool: (base URL, region label). Order is the rough priority
/// when no region preference applies; the race makes exact order mostly moot.
pub const BUNDLED: &[(&str, &str)] = &[
    ("https://lb-na.cdn-perfprod.com", "NA"),
    ("https://lb-eu.cdn-perfprod.com", "EU"),
    ("https://lb-eu2.cdn-perfprod.com", "EU"),
    ("https://lb-eu3.cdn-perfprod.com", "RU"),
    ("https://lb-eu4.cdn-perfprod.com", "EU"),
    ("https://lb-eu5.cdn-perfprod.com", "EU"),
    ("https://lb-as.cdn-perfprod.com", "AS"),
    ("https://lb-sa.cdn-perfprod.com", "SA"),
    ("https://eu.luminous.dev", "EU"),
    ("https://eu2.luminous.dev", "EU"),
    ("https://as.luminous.dev", "AS"),
    ("https://twitch.nadeko.net", "RU"),
];

/// Region label for a base URL, when it is one of the bundled proxies.
pub fn region_for_base(base: &str) -> Option<String> {
    let norm = base.trim_end_matches('/');
    BUNDLED
        .iter()
        .find(|(url, _)| *url == norm)
        .map(|(_, region)| (*region).to_string())
}

/// True if `body` is actually an HLS master playlist (carries at least one
/// `#EXT-X-STREAM-INF`). The proxies routinely answer HTTP 200 with an HTML
/// error page or a JSON error body; treating those as misses lets the race
/// try the next proxy instead of failing the resolve on garbage.
pub fn looks_like_master(body: &str) -> bool {
    body.contains("#EXT-X-STREAM-INF")
}

/// Percent-encodes everything except RFC 3986 unreserved chars plus `:` and
/// `/`. The proxies expect the whole playlist URL in this shape, query string
/// folded into the path (`%3F`, `%3D`, `%26`, `%2C`); a clean `?param=value`
/// URL gets a 500 from them.
fn quote_safe_colon_slash(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for ch in s.chars() {
        let safe = matches!(ch,
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '.' | '_' | '~' | ':' | '/'
        );
        if safe {
            out.push(ch);
        } else {
            let mut buf = [0u8; 4];
            let bytes = ch.encode_utf8(&mut buf).as_bytes().to_owned();
            for b in &bytes {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

/// Race the given proxy bases for `channel`'s master playlist in parallel.
/// Returns `(winning_base, master_body)` from the first valid answer.
pub async fn race(client: &Client, channel: &str, bases: &[String]) -> Result<(String, String)> {
    if bases.is_empty() {
        return Err(anyhow!("no proxy bases to try"));
    }
    let mut futs = FuturesUnordered::new();
    for base in bases {
        let raw = format!(
            "{}/playlist/{}.m3u8?platform=web&allow_source=true&allow_audio_only=true&fast_bread=true&supported_codecs=av1,h264,h265",
            base.trim_end_matches('/'),
            channel
        );
        let url = quote_safe_colon_slash(&raw);
        let c = client.clone();
        let label = base.trim_end_matches('/').to_string();
        futs.push(async move {
            let resp = c
                .get(&url)
                .header("Referer", "https://player.twitch.tv")
                .header("Origin", "https://player.twitch.tv")
                .send()
                .await
                .map_err(|e| anyhow!("{} -> {}", label, e))?;
            if !resp.status().is_success() {
                return Err(anyhow!("{} -> HTTP {}", label, resp.status()));
            }
            let body = resp
                .text()
                .await
                .map_err(|e| anyhow!("{} -> body: {}", label, e))?;
            if !looks_like_master(&body) {
                let first = body.lines().next().unwrap_or("").trim().to_string();
                return Err(anyhow!(
                    "{} -> 2xx but not a master playlist ({} bytes, first line: {:?})",
                    label,
                    body.len(),
                    first
                ));
            }
            Ok::<(String, String), anyhow::Error>((label, body))
        });
    }

    let mut last_err: Option<anyhow::Error> = None;
    while let Some(res) = futs.next().await {
        match res {
            Ok(win) => return Ok(win),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("all proxies failed")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_encodes_all_but_colon_slash() {
        let raw = "https://eu.luminous.dev/playlist/somechannel.m3u8?platform=web&supported_codecs=av1,h264,h265";
        let got = quote_safe_colon_slash(raw);
        assert_eq!(
            got,
            "https://eu.luminous.dev/playlist/somechannel.m3u8%3Fplatform%3Dweb%26supported_codecs%3Dav1%2Ch264%2Ch265"
        );
    }

    #[test]
    fn error_bodies_are_not_masters() {
        assert!(!looks_like_master(
            "<!DOCTYPE html><html><head><title>Server error!</title></head></html>"
        ));
        assert!(!looks_like_master(
            "{\"code\":404,\"error\":\"HTTP status client error\"}"
        ));
        assert!(looks_like_master(
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://x/v.m3u8\n"
        ));
    }

    #[test]
    fn bundled_pool_has_region_labels() {
        assert!(BUNDLED.len() >= 10);
        assert_eq!(
            region_for_base("https://lb-eu.cdn-perfprod.com/").as_deref(),
            Some("EU")
        );
        assert_eq!(region_for_base("https://unknown.example.com"), None);
    }
}
