use serde_json::Value;

use crate::errors::TikTokLiveError;
use crate::http::ua::{random_ua, system_locale};

const SIGI_MARKER: &str = r#"id="__UNIVERSAL_DATA_FOR_REHYDRATION__""#;

/// Profile data scraped from a TikTok profile page via SIGI state.
///
/// Contains HD avatar URLs (720x720 and 1080x1080) plus basic profile
/// metadata. All fields except `bio_link` are guaranteed present on
/// public profiles.
#[derive(Clone, Debug)]
pub struct SigiProfile {
    pub user_id: String,
    pub unique_id: String,
    pub nickname: String,
    pub bio: String,
    /// 100x100 pre-signed CDN URL.
    pub avatar_thumb: String,
    /// 720x720 pre-signed CDN URL.
    pub avatar_medium: String,
    /// 1080x1080 pre-signed CDN URL.
    pub avatar_large: String,
    pub verified: bool,
    pub private_account: bool,
    pub is_organization: bool,
    /// Non-empty if user is currently live.
    pub room_id: String,
    /// Only present if the user set a link in their bio.
    pub bio_link: Option<String>,
    pub follower_count: i64,
    pub following_count: i64,
    pub heart_count: i64,
    pub video_count: i64,
    pub friend_count: i64,
}

/// Scrape a TikTok profile page and extract profile data from the
/// embedded SIGI JSON blob.
///
/// This is a stateless function — no caching. Use [`super::profile_cache::ProfileCache`]
/// for cached access.
pub async fn scrape_profile(
    username: &str,
    ttwid: &str,
    timeout: std::time::Duration,
    user_agent: Option<&str>,
    proxy: Option<&str>,
    cookies: Option<&str>,
) -> Result<SigiProfile, TikTokLiveError> {
    let clean = username.trim().trim_start_matches('@').to_lowercase();
    let ua = user_agent.unwrap_or_else(|| random_ua());

    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(ua);

    if let Some(proxy_url) = proxy {
        builder = builder.proxy(reqwest::Proxy::all(proxy_url).map_err(TikTokLiveError::Http)?);
    }

    let client = builder.build().map_err(TikTokLiveError::Http)?;

    let cookie_header = match cookies {
        Some(c) => {
            // Strip user-provided ttwid so the cache-managed fresh one always wins
            let filtered: String = c
                .split("; ")
                .filter(|pair| !pair.starts_with("ttwid="))
                .collect::<Vec<_>>()
                .join("; ");
            if filtered.is_empty() {
                format!("ttwid={ttwid}")
            } else {
                format!("ttwid={ttwid}; {filtered}")
            }
        }
        None => format!("ttwid={ttwid}"),
    };

    let resp = client
        .get(format!("https://www.tiktok.com/@{clean}"))
        .header("Cookie", cookie_header)
        .header("Accept-Language", {
            let (l, r) = system_locale();
            format!("{l}-{r},{l};q=0.9")
        })
        .send()
        .await?;

    let html = resp.text().await?;
    let json_str = extract_sigi_json(&html)?;
    let blob: Value = serde_json::from_str(json_str)?;

    let user_detail = blob
        .pointer("/__DEFAULT_SCOPE__/webapp.user-detail")
        .ok_or_else(|| TikTokLiveError::ProfileScrape("missing __DEFAULT_SCOPE__/webapp.user-detail".into()))?;

    let status_code = user_detail
        .get("statusCode")
        .and_then(|v| v.as_i64())
        .unwrap_or_default();

    match status_code {
        0 => {}
        10222 => return Err(TikTokLiveError::ProfilePrivate(clean)),
        10221 | 10223 => return Err(TikTokLiveError::ProfileNotFound(clean)),
        code => return Err(TikTokLiveError::ProfileError(code)),
    }

    let user = user_detail
        .pointer("/userInfo/user")
        .ok_or_else(|| TikTokLiveError::ProfileScrape("missing userInfo.user".into()))?;

    let stats = user_detail
        .pointer("/userInfo/stats")
        .ok_or_else(|| TikTokLiveError::ProfileScrape("missing userInfo.stats".into()))?;

    let bio_link = user
        .pointer("/bioLink/link")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    Ok(SigiProfile {
        user_id: str_field(user, "id"),
        unique_id: str_field(user, "uniqueId"),
        nickname: str_field(user, "nickname"),
        bio: str_field(user, "signature"),
        avatar_thumb: str_field(user, "avatarThumb"),
        avatar_medium: str_field(user, "avatarMedium"),
        avatar_large: str_field(user, "avatarLarger"),
        verified: bool_field(user, "verified"),
        private_account: bool_field(user, "privateAccount"),
        is_organization: i64_field(user, "isOrganization") != 0,
        room_id: str_field(user, "roomId"),
        bio_link,
        follower_count: i64_field(stats, "followerCount"),
        following_count: i64_field(stats, "followingCount"),
        heart_count: i64_field(stats, "heartCount"),
        video_count: i64_field(stats, "videoCount"),
        friend_count: i64_field(stats, "friendCount"),
    })
}

/// Extract the JSON string from the SIGI `<script>` tag via string searching.
/// No regex, no HTML parser.
fn extract_sigi_json(html: &str) -> Result<&str, TikTokLiveError> {
    let marker_pos = html
        .find(SIGI_MARKER)
        .ok_or_else(|| TikTokLiveError::ProfileScrape("SIGI script tag not found in HTML".into()))?;

    let after_marker = &html[marker_pos..];
    let gt_offset = after_marker
        .find('>')
        .ok_or_else(|| TikTokLiveError::ProfileScrape("no > after SIGI marker".into()))?;

    let json_start = marker_pos + gt_offset + 1;
    let after_json = &html[json_start..];
    let script_end = after_json
        .find("</script>")
        .ok_or_else(|| TikTokLiveError::ProfileScrape("no </script> after SIGI JSON".into()))?;

    let json_str = &html[json_start..json_start + script_end];
    if json_str.is_empty() {
        return Err(TikTokLiveError::ProfileScrape("empty SIGI JSON blob".into()));
    }

    Ok(json_str)
}

fn str_field(obj: &Value, key: &str) -> String {
    obj.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

fn bool_field(obj: &Value, key: &str) -> bool {
    obj.get(key).and_then(|v| v.as_bool()).unwrap_or_default()
}

fn i64_field(obj: &Value, key: &str) -> i64 {
    obj.get(key).and_then(|v| v.as_i64()).unwrap_or_default()
}
