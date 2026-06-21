//! Odesli (song.link) enrichment.
//!
//! Shazam names the track and gives us one platform link (usually Apple Music),
//! but its in-band "open in" links are spotty (it returns an `unsupported.shazam`
//! placeholder for tracks it can't deep-link). Feeding any one real platform URL
//! to Odesli returns a clean set of links for every service plus the song.link
//! aggregator page, which is what the chat card shows. Keyless, rate-limited per
//! IP (fine for on-demand use); any failure just leaves the Shazam-only links.

use std::sync::LazyLock;
use std::time::Duration;

use serde_json::Value;

use super::shazam::Provider;

pub struct OdesliResult {
    pub page_url: Option<String>,
    pub providers: Vec<Provider>,
    pub thumbnail: Option<String>,
}

// Platforms we surface, in display order. Keys match Odesli's `linksByPlatform`.
const PLATFORMS: &[(&str, &str)] = &[
    ("spotify", "Spotify"),
    ("appleMusic", "Apple Music"),
    ("youtubeMusic", "YouTube Music"),
    ("youtube", "YouTube"),
    ("soundcloud", "SoundCloud"),
    ("tidal", "Tidal"),
    ("deezer", "Deezer"),
    ("amazonMusic", "Amazon Music"),
    ("pandora", "Pandora"),
];

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("StreamNook")
        .build()
        .expect("Failed to build Odesli HTTP client")
});

pub async fn enrich(seed_url: &str) -> Option<OdesliResult> {
    let api = format!(
        "https://api.song.link/v1-alpha.1/links?url={}&userCountry=US&songIfSingle=true",
        urlencoding::encode(seed_url)
    );

    let resp = CLIENT.get(&api).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: Value = resp.json().await.ok()?;

    let page_url = json
        .get("pageUrl")
        .and_then(Value::as_str)
        .map(str::to_string);

    let mut providers: Vec<Provider> = Vec::new();
    for (key, label) in PLATFORMS {
        if let Some(url) = json
            .pointer(&format!("/linksByPlatform/{}/url", key))
            .and_then(Value::as_str)
        {
            providers.push(Provider {
                name: label.to_string(),
                url: url.to_string(),
            });
        }
    }

    // First entity with a thumbnail (used only if Shazam gave us no cover art).
    let thumbnail = json
        .get("entitiesByUniqueId")
        .and_then(Value::as_object)
        .and_then(|entities| {
            entities
                .values()
                .find_map(|e| e.get("thumbnailUrl").and_then(Value::as_str))
        })
        .map(str::to_string);

    if page_url.is_none() && providers.is_empty() {
        return None;
    }

    Some(OdesliResult {
        page_url,
        providers,
        thumbnail,
    })
}
