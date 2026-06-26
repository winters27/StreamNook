use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::errors::TikTokLiveError;
use crate::http::sigi::{scrape_profile, SigiProfile};
use crate::http::ttwid::fetch_ttwid;

const DEFAULT_TTL: Duration = Duration::from_secs(300);
const TTWID_TIMEOUT: Duration = Duration::from_secs(10);
const SCRAPE_TIMEOUT: Duration = Duration::from_secs(15);

enum CacheEntry {
    Profile(SigiProfile, Instant),
    Error(TikTokLiveError, Instant),
}

struct CacheInner {
    entries: HashMap<String, CacheEntry>,
    ttwid: Option<String>,
    ttl: Duration,
    proxy: Option<String>,
    user_agent: Option<String>,
    cookies: Option<String>,
}

/// Cached profile fetcher that scrapes TikTok profile pages for HD avatars
/// and profile metadata.
///
/// Thread-safe via `Arc<Mutex>` — clone freely across tasks.
///
/// ```no_run
/// use piratetok_live_rs::helpers::profile_cache::ProfileCache;
///
/// # async fn example() {
/// let cache = ProfileCache::new();
/// let profile = cache.fetch("tiktok").await.unwrap();
/// println!("{} — {} followers", profile.nickname, profile.follower_count);
/// println!("HD avatar: {}", profile.avatar_large);
///
/// // Second call is instant (cached)
/// let cached = cache.fetch("tiktok").await.unwrap();
/// # }
/// ```
#[derive(Clone)]
pub struct ProfileCache {
    inner: Arc<Mutex<CacheInner>>,
}

impl ProfileCache {
    /// Create a new cache with default TTL (5 minutes).
    pub fn new() -> Self {
        Self::with_ttl(DEFAULT_TTL)
    }

    /// Create a new cache with a custom TTL.
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(CacheInner {
                entries: HashMap::new(),
                ttwid: None,
                ttl,
                proxy: None,
                user_agent: None,
                cookies: None,
            })),
        }
    }

    /// Set proxy URL for all HTTP requests.
    pub fn proxy(self, url: impl Into<String>) -> Self {
        self.lock().proxy = Some(url.into());
        self
    }

    /// Override the user agent for all requests.
    pub fn user_agent(self, ua: impl Into<String>) -> Self {
        self.lock().user_agent = Some(ua.into());
        self
    }

    /// Set session cookies (e.g. `"sessionid=xxx; sid_tt=xxx"`).
    /// Required for profiles that return statusCode 209002 (login required).
    pub fn cookies(self, cookies: impl Into<String>) -> Self {
        self.lock().cookies = Some(cookies.into());
        self
    }

    /// Fetch a profile, returning cached data if available and not expired.
    /// On cache miss, scrapes the profile page and caches the result.
    ///
    /// Private/not-found profiles are negatively cached — repeated lookups
    /// for known-bad usernames return the cached error without an HTTP request.
    pub async fn fetch(&self, username: &str) -> Result<SigiProfile, TikTokLiveError> {
        let key = normalize_key(username);

        // Check cache
        {
            let inner = self.lock();
            let ttl = inner.ttl;
            if let Some(entry) = inner.entries.get(&key) {
                match entry {
                    CacheEntry::Profile(profile, ts) if ts.elapsed() < ttl => {
                        return Ok(profile.clone());
                    }
                    CacheEntry::Error(err, ts) if ts.elapsed() < ttl => {
                        return Err(clone_profile_error(err));
                    }
                    _ => {} // expired
                }
            }
        }

        // Ensure ttwid
        let ttwid = self.ensure_ttwid().await?;

        // Read config, drop lock before await
        let (proxy, user_agent, cookies) = {
            let inner = self.lock();
            (inner.proxy.clone(), inner.user_agent.clone(), inner.cookies.clone())
        };

        let result = scrape_profile(
            &key,
            &ttwid,
            SCRAPE_TIMEOUT,
            user_agent.as_deref(),
            proxy.as_deref(),
            cookies.as_deref(),
        )
        .await;

        // Cache the result
        {
            let mut inner = self.lock();
            let now = Instant::now();
            match &result {
                Ok(profile) => {
                    inner.entries.insert(key, CacheEntry::Profile(profile.clone(), now));
                }
                Err(err) if is_negative_cacheable(err) => {
                    inner.entries.insert(key, CacheEntry::Error(clone_profile_error(err), now));
                }
                Err(_) => {} // transient errors not cached
            }
        }

        result
    }

    /// Return a cached profile without fetching. Returns `None` on miss or expiry.
    pub fn cached(&self, username: &str) -> Option<SigiProfile> {
        let key = normalize_key(username);
        let inner = self.lock();
        match inner.entries.get(&key) {
            Some(CacheEntry::Profile(profile, ts)) if ts.elapsed() < inner.ttl => {
                Some(profile.clone())
            }
            _ => None,
        }
    }

    /// Remove a single entry from the cache.
    pub fn invalidate(&self, username: &str) {
        let key = normalize_key(username);
        self.lock().entries.remove(&key);
    }

    /// Clear the entire cache.
    pub fn invalidate_all(&self) {
        self.lock().entries.clear();
    }

    async fn ensure_ttwid(&self) -> Result<String, TikTokLiveError> {
        {
            let inner = self.lock();
            if let Some(ref ttwid) = inner.ttwid {
                return Ok(ttwid.clone());
            }
        }

        let (proxy, user_agent) = {
            let inner = self.lock();
            (inner.proxy.clone(), inner.user_agent.clone())
        };

        let ttwid = fetch_ttwid(TTWID_TIMEOUT, user_agent.as_deref(), proxy.as_deref()).await?;

        self.lock().ttwid = Some(ttwid.clone());
        Ok(ttwid)
    }

    /// Lock the inner mutex, recovering from poisoning.
    fn lock(&self) -> MutexGuard<'_, CacheInner> {
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

fn normalize_key(username: &str) -> String {
    username.trim().trim_start_matches('@').to_lowercase()
}

fn is_negative_cacheable(err: &TikTokLiveError) -> bool {
    matches!(
        err,
        TikTokLiveError::ProfilePrivate(_)
            | TikTokLiveError::ProfileNotFound(_)
            | TikTokLiveError::ProfileError(_)
    )
}

fn clone_profile_error(err: &TikTokLiveError) -> TikTokLiveError {
    match err {
        TikTokLiveError::ProfilePrivate(u) => TikTokLiveError::ProfilePrivate(u.clone()),
        TikTokLiveError::ProfileNotFound(u) => TikTokLiveError::ProfileNotFound(u.clone()),
        TikTokLiveError::ProfileError(c) => TikTokLiveError::ProfileError(*c),
        other => TikTokLiveError::invalid(format!("{other}")),
    }
}
