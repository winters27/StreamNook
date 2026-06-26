use rand::Rng;

const USER_AGENTS: &[&str] = &[
    "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:139.0) Gecko/20100101 Firefox/139.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

const FALLBACK_TZ: &str = "UTC";

/// Pick a random user agent from the built-in pool.
pub fn random_ua() -> &'static str {
    let idx = rand::rng().random_range(0..USER_AGENTS.len());
    USER_AGENTS[idx]
}

/// Detect the system's IANA timezone name.
///
/// Tries `TZ` env, `/etc/timezone`, `/etc/localtime` symlink.
/// Falls back to `"UTC"` when detection fails.
pub fn system_timezone() -> String {
    if let Some(tz) = tz_from_env() {
        return tz;
    }
    if let Some(tz) = tz_from_etc_timezone() {
        return tz;
    }
    if let Some(tz) = tz_from_localtime_link() {
        return tz;
    }
    FALLBACK_TZ.to_string()
}

fn tz_from_env() -> Option<String> {
    match std::env::var("TZ") {
        Ok(tz) => {
            let tz = tz.trim().to_string();
            if !tz.is_empty() && tz.contains('/') { Some(tz) } else { None }
        }
        Err(_) => None,
    }
}

fn tz_from_etc_timezone() -> Option<String> {
    match std::fs::read_to_string("/etc/timezone") {
        Ok(content) => {
            let tz = content.trim().to_string();
            if !tz.is_empty() && tz.contains('/') { Some(tz) } else { None }
        }
        Err(_) => None,
    }
}

fn tz_from_localtime_link() -> Option<String> {
    match std::fs::read_link("/etc/localtime") {
        Ok(link) => {
            let path = link.to_string_lossy();
            match path.split("/zoneinfo/").nth(1) {
                Some(tz) if !tz.is_empty() => Some(tz.to_string()),
                _ => None,
            }
        }
        Err(_) => None,
    }
}

const FALLBACK_LANG: &str = "en";
const FALLBACK_REGION: &str = "US";

/// Detect system language code (e.g. `"en"`, `"ro"`, `"pt"`).
///
/// Parses `LANG` / `LC_ALL` env vars. Falls back to `"en"`.
pub fn system_language() -> String {
    system_locale().0
}

/// Detect system region/country code (e.g. `"US"`, `"RO"`, `"BR"`).
///
/// Parses `LANG` / `LC_ALL` env vars. Falls back to `"US"`.
pub fn system_region() -> String {
    system_locale().1
}

/// Returns `(language, region)` from system locale.
///
/// Parses POSIX locale format: `ll_CC.encoding` or `ll_CC` or `ll`.
/// Tries `LC_ALL`, then `LANG`. Falls back to `("en", "US")`.
pub fn system_locale() -> (String, String) {
    for var in ["LC_ALL", "LANG"] {
        if let Ok(val) = std::env::var(var) {
            let val = val.trim().to_string();
            if val.is_empty() || val == "C" || val == "POSIX" {
                continue;
            }
            if let Some(parsed) = parse_posix_locale(&val) {
                return parsed;
            }
        }
    }
    (FALLBACK_LANG.into(), FALLBACK_REGION.into())
}

/// Parse `ll_CC.encoding` / `ll_CC` / `ll-CC` → `(lang, region)`.
fn parse_posix_locale(s: &str) -> Option<(String, String)> {
    // strip encoding: "en_US.UTF-8" → "en_US"
    let base = match s.split('.').next() {
        Some(b) => b,
        None => s,
    };
    // split on _ or -
    let parts: Vec<&str> = base.splitn(2, |c| c == '_' || c == '-').collect();
    let lang = parts.first()?.to_lowercase();
    if lang.len() < 2 {
        return None;
    }
    let region = match parts.get(1) {
        Some(r) => r.to_uppercase(),
        None => FALLBACK_REGION.into(),
    };
    Some((lang, region))
}
