//! HLS master-playlist handling: the high-tier splice and the small parse and
//! variant-select used when pivoting a session to a new upstream.
//!
//! Twitch caps anonymous viewers at 1080p, so a proxy-resolved master never
//! carries the 1440p/2160p tiers. When the host hands over the viewer's own
//! signed-in master alongside a resolve request, `splice` grafts those
//! above-1080p variant blocks onto the proxy master so high tiers survive.

/// Pull an attribute value out of an HLS tag line. Handles both quoted
/// (CODECS="...", VIDEO="...") and unquoted (RESOLUTION=1920x1080) forms.
pub fn extract_attr(line: &str, key: &str) -> Option<String> {
    let needle_q = format!("{}=\"", key);
    if let Some(pos) = line.find(&needle_q) {
        let rest = &line[pos + needle_q.len()..];
        let end = rest.find('"')?;
        return Some(rest[..end].to_string());
    }
    let needle = format!("{}=", key);
    let pos = line.find(&needle)?;
    let rest = &line[pos + needle.len()..];
    let end = rest.find(',').unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// Parse the height (e.g. `1440`) from a `NAME="1440p60"` attribute.
fn parse_name_height(line: &str) -> Option<u32> {
    let pos = line.find("NAME=\"")? + 6;
    let rest = &line[pos..];
    let end = rest.find('"')?;
    let name = &rest[..end];
    let digits: String = name.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Pull the playlist blocks for tiers above 1080p (1440p / 2160p) so they can
/// be merged into an anonymous proxy master. Anchored on `#EXT-X-STREAM-INF`
/// so it works on both master layouts Twitch ships: it reads the height from
/// `RESOLUTION` (falling back to the `NAME` label) and emits the STREAM-INF
/// plus URL, preceded by the legacy `#EXT-X-MEDIA` tag when one is present so
/// the label survives on older masters.
fn extract_high_tier_blocks(master: &str) -> Vec<String> {
    let lines: Vec<&str> = master.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let inf = lines[i];
        if !inf.trim_start().starts_with("#EXT-X-STREAM-INF:") {
            i += 1;
            continue;
        }
        // URL = next non-comment, non-empty line.
        let mut j = i + 1;
        while j < lines.len()
            && (lines[j].trim().is_empty() || lines[j].trim_start().starts_with('#'))
        {
            j += 1;
        }
        if j >= lines.len() {
            break;
        }
        let res_h = extract_attr(inf, "RESOLUTION")
            .and_then(|r| {
                r.split(['x', 'X'])
                    .nth(1)
                    .and_then(|h| h.trim().parse::<u32>().ok())
            })
            .unwrap_or(0);
        let height = res_h.max(parse_name_height(inf).unwrap_or(0));
        if height > 1080 {
            let mut block = String::new();
            // Carry the preceding legacy MEDIA tag along if there is one.
            if i > 0 {
                let prev = lines[i - 1].trim_start();
                if prev.starts_with("#EXT-X-MEDIA:") && prev.contains("TYPE=VIDEO") {
                    block.push_str(lines[i - 1]);
                    block.push('\n');
                }
            }
            block.push_str(inf);
            block.push('\n');
            block.push_str(lines[j].trim());
            out.push(block);
        }
        i = j + 1;
    }
    out
}

/// Splice strategy: keep the proxy master entirely as the base, then append
/// the variant blocks for any tier in the signed-in master that resolves
/// higher than 1080p. Those tiers do not exist in the anonymous proxy master.
pub fn splice(proxy_master: &str, auth_master: &str) -> String {
    let mut out = proxy_master.trim_end().to_string();
    let blocks = extract_high_tier_blocks(auth_master);
    if !blocks.is_empty() {
        out.push('\n');
        for b in &blocks {
            out.push_str(b);
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    out
}

/// One video rendition parsed from a master, just enough for variant
/// selection when pivoting (the host does the full parse for playback).
#[derive(Debug, Clone)]
pub struct Variant {
    pub name: String,
    pub height: Option<u32>,
    pub is_source: bool,
    pub url: String,
}

/// Parse a Twitch master playlist's renditions. Handles both layouts: the
/// legacy one (a `#EXT-X-MEDIA:TYPE=VIDEO,NAME="..."` tag precedes each
/// STREAM-INF) and the modern IVS one (no MEDIA tags; the label rides on the
/// STREAM-INF as `IVS-NAME` and the source rendition is flagged
/// `IVS-VARIANT-SOURCE="source"`).
pub fn parse_master(master: &str) -> Vec<Variant> {
    let lines: Vec<&str> = master.lines().collect();
    let mut media_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for line in &lines {
        let l = line.trim();
        if l.starts_with("#EXT-X-MEDIA:") && l.contains("TYPE=VIDEO") {
            if let Some(gid) = extract_attr(l, "GROUP-ID") {
                let name = extract_attr(l, "NAME").unwrap_or_default();
                media_names.insert(gid, name);
            }
        }
    }

    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let inf = lines[i].trim();
        if !inf.starts_with("#EXT-X-STREAM-INF:") {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < lines.len() {
            let u = lines[j].trim();
            if u.is_empty() || u.starts_with('#') {
                j += 1;
                continue;
            }
            break;
        }
        if j >= lines.len() {
            break;
        }

        let height = extract_attr(inf, "RESOLUTION").and_then(|r| {
            r.split(['x', 'X'])
                .nth(1)
                .and_then(|h| h.trim().parse::<u32>().ok())
        });
        let video_group = extract_attr(inf, "VIDEO");
        let is_source = video_group.as_deref() == Some("chunked")
            || extract_attr(inf, "IVS-VARIANT-SOURCE").is_some_and(|s| {
                s.eq_ignore_ascii_case("source")
            });
        let name = video_group
            .as_ref()
            .and_then(|g| media_names.get(g).cloned())
            .filter(|n| !n.is_empty())
            .or_else(|| extract_attr(inf, "IVS-NAME"))
            .or_else(|| extract_attr(inf, "STABLE-VARIANT-ID"))
            .or_else(|| height.map(|h| format!("{}p", h)))
            .unwrap_or_default();

        out.push(Variant {
            name,
            height,
            is_source,
            url: lines[j].trim().to_string(),
        });
        i = j + 1;
    }
    out
}

/// Map a requested quality label to a variant URL, for feeding `set_upstream`
/// during a pivot. Exact name match first; numeric requests fall to the
/// closest available height at or below the request; `best`/`source` is the
/// source rendition (or the tallest), `worst` the shortest video rendition,
/// `audio_only` the audio rendition.
pub fn select_variant(variants: &[Variant], requested: &str) -> Option<String> {
    if variants.is_empty() {
        return None;
    }
    let req = requested.trim().to_lowercase();

    let best = || {
        variants
            .iter()
            .find(|v| v.is_source)
            .or_else(|| variants.iter().filter(|v| v.height.is_some()).max_by_key(|v| v.height))
            .or(variants.first())
            .map(|v| v.url.clone())
    };

    if req == "best" || req == "source" {
        return best();
    }
    if req == "worst" {
        return variants
            .iter()
            .filter(|v| v.height.is_some())
            .min_by_key(|v| v.height)
            .map(|v| v.url.clone())
            .or_else(best);
    }
    if req == "audio_only" || req == "audio-only" || req == "audio" {
        return variants
            .iter()
            .find(|v| v.name.to_lowercase().contains("audio"))
            .map(|v| v.url.clone())
            .or_else(best);
    }

    // Exact label match (case-insensitive), then closest height at or below
    // the requested one, then best.
    if let Some(v) = variants.iter().find(|v| v.name.eq_ignore_ascii_case(&req)) {
        return Some(v.url.clone());
    }
    let req_height: u32 = req
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0);
    if req_height > 0 {
        if let Some(v) = variants
            .iter()
            .filter(|v| v.height.is_some_and(|h| h <= req_height))
            .max_by_key(|v| v.height)
        {
            return Some(v.url.clone());
        }
    }
    best()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROXY_MASTER: &str = "#EXTM3U\n\
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,IVS-NAME=\"1080p60\",IVS-VARIANT-SOURCE=\"source\"\n\
https://x/1080.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1280x720,FRAME-RATE=60.000,IVS-NAME=\"720p60\",IVS-VARIANT-SOURCE=\"transcode\"\n\
https://x/720.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS=\"mp4a.40.2\",IVS-NAME=\"audio_only\",IVS-VARIANT-SOURCE=\"transcode\"\n\
https://x/audio.m3u8\n";

    #[test]
    fn splice_appends_high_tier_blocks() {
        let auth = "#EXTM3U\n\
#EXT-X-STREAM-INF:BANDWIDTH=14000000,RESOLUTION=2560x1440,FRAME-RATE=60.000,IVS-NAME=\"1440p60\",IVS-VARIANT-SOURCE=\"source\"\n\
https://x/auth-1440.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,IVS-NAME=\"1080p60\",IVS-VARIANT-SOURCE=\"transcode\"\n\
https://x/auth-1080.m3u8\n";
        let merged = splice(PROXY_MASTER, auth);
        assert!(merged.contains("https://x/1080.m3u8"), "proxy base preserved");
        assert!(merged.contains("auth-1440.m3u8"), "1440p tier merged in");
        assert!(!merged.contains("auth-1080.m3u8"), "1080p not duplicated");
    }

    #[test]
    fn splice_carries_legacy_media_tag() {
        let auth = "#EXTM3U\n\
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"1440p60\",NAME=\"1440p60\",AUTOSELECT=YES,DEFAULT=YES\n\
#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=2560x1440,CODECS=\"av01.0.13M.08,mp4a.40.2\",VIDEO=\"1440p60\",FRAME-RATE=60.000\n\
https://x/auth-1440.m3u8\n";
        let merged = splice(PROXY_MASTER, auth);
        assert!(merged.contains("NAME=\"1440p60\""));
        assert!(merged.contains("auth-1440.m3u8"));
    }

    #[test]
    fn parses_and_selects_variants() {
        let v = parse_master(PROXY_MASTER);
        assert_eq!(v.len(), 3);
        assert_eq!(
            select_variant(&v, "best").as_deref(),
            Some("https://x/1080.m3u8")
        );
        assert_eq!(
            select_variant(&v, "720p60").as_deref(),
            Some("https://x/720.m3u8")
        );
        assert_eq!(
            select_variant(&v, "worst").as_deref(),
            Some("https://x/720.m3u8")
        );
        assert_eq!(
            select_variant(&v, "audio_only").as_deref(),
            Some("https://x/audio.m3u8")
        );
        // A request above the proxy ceiling falls to the closest tier below.
        assert_eq!(
            select_variant(&v, "1440p60").as_deref(),
            Some("https://x/1080.m3u8")
        );
    }
}
