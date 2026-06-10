//! Shared Twitch SSAI ad handling — the single source of truth for the marker
//! strings AND the inline segment filter, so the solo player (`stream_server`)
//! and MultiNook (`multi_nook_server`) detect and strip ads identically.
//!
//! Markers come from the bundled Streamlink TTV-LOL plugin
//! (`streamlink/plugins/twitch.py` `_is_daterange_ad` / `_is_segment_ad`) and
//! were confirmed live: an ad pod is a `#EXT-X-DATERANGE CLASS="twitch-stitched-ad"`
//! (id `stitched-ad-…`) carrying `X-TV-TWITCH-AD-*` metadata, or an `#EXTINF`
//! segment whose title contains "Amazon".
//!
//! `filter_ad_segments` is the native port of the plugin's `should_filter_segment`
//! (which dropped ad-flagged segments from the output): it removes ad segments
//! and ad dateranges from the live media playlist before the player sees them.
//! This is the universal, seamless leaked-ad defense that works regardless of
//! proxy/entitlement, the capability that left with Streamlink.

use chrono::{DateTime, FixedOffset};

/// High-confidence Twitch ad signatures. `stitched-ad` matches both the
/// DATERANGE class (`twitch-stitched-ad`) and the id form (`stitched-ad-…`);
/// `X-TV-TWITCH-AD` matches the ad metadata attrs; `Amazon` is the ad EXTINF
/// title. `CUE-OUT` / `SCTE35` are intentionally absent — Twitch SSAI doesn't
/// use them, per the plugin.
const STRONG: &[&str] = &["stitched-ad", "X-TV-TWITCH-AD", "Amazon"];

/// Rolling ad-detection state for one stream. Cloneable/serializable so it can
/// be snapshotted for the UI or a Tauri command.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct AdDetectionState {
    /// True when the most recent media playlist carried ad-stitch markers.
    pub ads_present: bool,
    /// Consecutive ad-bearing polls (input to a future pivot debounce).
    pub consecutive_ad_polls: u32,
    /// Marker tags matched on the last scan.
    pub matched_markers: Vec<String>,
    /// Count of distinct ad breaks seen on the current stream.
    pub ad_events: u32,
}

/// Pure scan of a media playlist. Returns `(ads_present, matched_markers)`.
pub fn scan(playlist: &str) -> (bool, Vec<String>) {
    let mut matched = Vec::new();
    for n in STRONG {
        if playlist.contains(n) {
            matched.push((*n).to_string());
        }
    }
    (!matched.is_empty(), matched)
}

/// Fold a fresh scan into a running `state`. Returns `Some(break_number)` the
/// first poll a NEW ad break is seen (so callers can log it once), else `None`.
pub fn update(state: &mut AdDetectionState, playlist: &str) -> Option<u32> {
    let (ads, matched) = scan(playlist);
    let mut new_break = None;
    if ads {
        if !state.ads_present {
            state.ad_events = state.ad_events.saturating_add(1);
            new_break = Some(state.ad_events);
        }
        state.ads_present = true;
        state.consecutive_ad_polls = state.consecutive_ad_polls.saturating_add(1);
    } else {
        state.ads_present = false;
        state.consecutive_ad_polls = 0;
    }
    state.matched_markers = matched;
    new_break
}

/// True for an `#EXT-X-DATERANGE` line that marks a Twitch ad pod.
fn is_ad_daterange(line: &str) -> bool {
    line.contains("twitch-stitched-ad") || line.contains("stitched-ad-")
}

/// Pull an attribute value out of an HLS tag line (quoted or unquoted form).
fn tag_attr(line: &str, key: &str) -> Option<String> {
    let quoted = format!("{}=\"", key);
    if let Some(pos) = line.find(&quoted) {
        let rest = &line[pos + quoted.len()..];
        return rest.find('"').map(|end| rest[..end].to_string());
    }
    let bare = format!("{}=", key);
    let pos = line.find(&bare)?;
    let rest = &line[pos + bare.len()..];
    let end = rest.find(',').unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// Strip Twitch SSAI ad segments from a live media playlist — the native
/// equivalent of the plugin's `should_filter_segment`. A segment is an ad if its
/// `#EXTINF` title contains "Amazon" or its `#EXT-X-PROGRAM-DATE-TIME` falls
/// inside an ad daterange (`twitch-stitched-ad` / id `stitched-ad-…`). Those
/// segments (and their leading discontinuity/PDT/EXTINF tags) plus the ad
/// daterange tags are removed. `#EXT-X-MEDIA-SEQUENCE` is bumped by the number
/// of leading segments dropped so the player's sequence tracking stays
/// consistent. Returns `(filtered_playlist, dropped_segments, real_remaining)`.
///
/// Callers should only swap in the filtered output when `dropped > 0`, so an
/// ad-free playlist is passed through byte-for-byte untouched.
pub fn filter_ad_segments(playlist: &str) -> (String, u32, u32) {
    // Pass 1: collect ad time windows from ad dateranges (best-effort; a parse
    // failure just means we fall back to the "Amazon" title signal).
    let mut windows: Vec<(DateTime<FixedOffset>, DateTime<FixedOffset>)> = Vec::new();
    for line in playlist.lines() {
        let t = line.trim();
        if t.starts_with("#EXT-X-DATERANGE") && is_ad_daterange(t) {
            let start =
                tag_attr(t, "START-DATE").and_then(|s| DateTime::parse_from_rfc3339(&s).ok());
            if let Some(start) = start {
                let end = tag_attr(t, "END-DATE")
                    .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                    .or_else(|| {
                        tag_attr(t, "DURATION")
                            .and_then(|d| d.parse::<f64>().ok())
                            .map(|secs| {
                                start + chrono::Duration::milliseconds((secs * 1000.0) as i64)
                            })
                    });
                if let Some(end) = end {
                    windows.push((start, end));
                }
            }
        }
    }
    let in_ad_window =
        |pdt: &DateTime<FixedOffset>| windows.iter().any(|(s, e)| pdt >= s && pdt < e);

    // Pass 2: walk lines, dropping ad dateranges + ad segments.
    let mut out: Vec<String> = Vec::new();
    let mut pending: Vec<String> = Vec::new(); // buffered prefix tags for the next segment
    let mut cur_pdt: Option<DateTime<FixedOffset>> = None;
    let mut cur_title: Option<String> = None;
    let mut dropped = 0u32;
    let mut real = 0u32;
    let mut leading_dropped = 0u32;
    let mut seen_real = false;
    let mut mediaseq_idx: Option<usize> = None;
    let mut mediaseq_val: Option<u64> = None;

    for raw in playlist.lines() {
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with("#EXT-X-DATERANGE") {
            if is_ad_daterange(t) {
                continue; // drop the ad daterange tag
            }
            out.push(raw.to_string());
            continue;
        }
        if let Some(v) = t.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            mediaseq_val = v.trim().parse::<u64>().ok();
            mediaseq_idx = Some(out.len());
            out.push(raw.to_string()); // patched after the walk if leading ads were dropped
            continue;
        }
        if let Some(v) = t.strip_prefix("#EXT-X-PROGRAM-DATE-TIME:") {
            cur_pdt = DateTime::parse_from_rfc3339(v.trim()).ok();
            pending.push(raw.to_string());
            continue;
        }
        if t.starts_with("#EXTINF:") {
            cur_title = t.split_once(',').map(|(_, title)| title.to_string());
            pending.push(raw.to_string());
            continue;
        }
        if t == "#EXT-X-DISCONTINUITY"
            || t.starts_with("#EXT-X-BYTERANGE")
            || t.starts_with("#EXT-X-KEY")
            || t.starts_with("#EXT-X-MAP")
        {
            pending.push(raw.to_string());
            continue;
        }
        if t.starts_with('#') {
            // Any other tag is playlist-level (header, ENDLIST, DISCONTINUITY-SEQUENCE…).
            out.push(raw.to_string());
            continue;
        }

        // Non-comment line = the segment URI; this closes a segment.
        let is_ad = cur_title
            .as_deref()
            .is_some_and(|title| title.contains("Amazon"))
            || cur_pdt.as_ref().is_some_and(in_ad_window);
        if is_ad {
            dropped += 1;
            if !seen_real {
                leading_dropped += 1;
            }
        } else {
            out.append(&mut pending);
            out.push(raw.to_string());
            real += 1;
            seen_real = true;
        }
        pending.clear();
        cur_pdt = None;
        cur_title = None;
    }

    if leading_dropped > 0 {
        if let (Some(idx), Some(val)) = (mediaseq_idx, mediaseq_val) {
            out[idx] = format!("#EXT-X-MEDIA-SEQUENCE:{}", val + leading_dropped as u64);
        }
    }

    let mut joined = out.join("\n");
    joined.push('\n');
    (joined, dropped, real)
}

/// Lower the playlist's declared `#EXT-X-TARGETDURATION` to the real maximum
/// segment length. Twitch over-declares 6s even though its live segments are ~2s,
/// and hls.js refuses to hold the playhead closer than ~one target duration to the
/// live edge (so a 6s declaration pins viewers ~6-8s back no matter the configured
/// sync target). Rewriting it to `ceil(max #EXTINF)` lets the player ride much
/// closer to live without stalling, on every channel, with no dependence on the
/// low-latency PREFETCH tags (which normal-latency broadcasts don't send).
///
/// Spec-safe: TARGETDURATION must be >= every segment's duration, and this only
/// ever LOWERS it toward that true maximum, never below it. Returns `Some(rewrite)`
/// only when it actually changed the value, so an already-correct playlist (or a
/// master playlist with no segments) passes through untouched (`None`).
pub fn retarget_playlist(playlist: &str) -> Option<String> {
    let mut max_dur = 0.0f64;
    let mut has_extinf = false;
    for line in playlist.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("#EXTINF:") {
            has_extinf = true;
            if let Some(num) = rest.split(',').next() {
                if let Ok(d) = num.trim().parse::<f64>() {
                    if d > max_dur {
                        max_dur = d;
                    }
                }
            }
        }
    }
    // No media segments (master playlist) or unparseable durations: leave it alone.
    if !has_extinf || max_dur <= 0.0 {
        return None;
    }
    let new_td = (max_dur.ceil() as u64).max(1);

    let mut changed = false;
    let mut out = String::with_capacity(playlist.len());
    for line in playlist.lines() {
        if let Some(cur) = line.trim_start().strip_prefix("#EXT-X-TARGETDURATION:") {
            let cur_val = cur.trim().parse::<u64>().unwrap_or(0);
            if cur_val > new_td {
                out.push_str(&format!("#EXT-X-TARGETDURATION:{}", new_td));
                changed = true;
            } else {
                out.push_str(line);
            }
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    if changed {
        Some(out)
    } else {
        None
    }
}

/// Promote Twitch's low-latency `#EXT-X-TWITCH-PREFETCH:<url>` hints into real
/// `#EXTINF` segments so hls.js actually plays them. On a low-latency broadcast
/// Twitch appends the next ~2 in-progress segments as PREFETCH tags; hls.js
/// ignores that proprietary tag, so without this the player can never ride closer
/// than the last fully-published segment (~4s+ back even on a low-latency channel).
/// Each hint becomes `#EXTINF:<dur>,live\n<url>`, extending the live edge ~2s per
/// hint toward real time. The URLs are absolute (same CDN as the normal segments),
/// so the player fetches them directly, exactly as it already does for the others.
///
/// REFRESH-STABILITY (the load-bearing part — getting this wrong is what made the
/// player hard-freeze with a fatal `levelParsingError`):
/// hls.js reconciles every live-playlist refresh by matching segments on their
/// media-sequence number and requiring, for each segment present in both the old
/// and new playlist, that the URL path (after the trailing `?query` is stripped)
/// AND the discontinuity counter `cc` are identical. `cc` is the running count of
/// `#EXT-X-DISCONTINUITY` tags before a segment. Twitch signals a prefetch-boundary
/// discontinuity with the SEPARATE tag `#EXT-X-PREFETCH-DISCONTINUITY`, which hls.js
/// does not understand and silently drops. So a naive promotion (pass the marker
/// through, just rewrite the hint) gives a promoted segment `cc=X` now but `cc=X+1`
/// once Twitch finalizes it carrying a real `#EXT-X-DISCONTINUITY` — same SN, mismatched
/// `cc`, fatal `levelParsingError` on the first refresh, never recovers.
/// Fix: translate `#EXT-X-PREFETCH-DISCONTINUITY` into a real `#EXT-X-DISCONTINUITY`
/// emitted immediately before the promoted segment it precedes, so the promoted and
/// the eventual finalized form agree on `cc`. We deliberately do NOT touch
/// `#EXT-X-MEDIA-SEQUENCE` (appending hints at the tail gives them the same SN they
/// get when finalized) or `#EXT-X-DISCONTINUITY-SEQUENCE` (it seeds the cc of the
/// FIRST segment in the window; tail-appended hints never shift it, and adjusting it
/// would corrupt the already-published segments' cc). No cross-poll state is needed.
///
/// MUST only be called on an ad-free playlist: a prefetch segment landing inside an
/// ad break could be the ad itself, and promoting it would fast-path it past the
/// segment filter. Callers gate on the ad-detection state. Returns `None` when there
/// were no hints (so a normal-latency playlist passes through untouched).
pub fn promote_prefetch(playlist: &str) -> Option<String> {
    if !playlist.contains("#EXT-X-TWITCH-PREFETCH:") {
        return None;
    }
    // Estimate the segment duration from the playlist's own segments (Twitch is a
    // steady 2s; fall back to 2.0 if none parse).
    let dur = playlist
        .lines()
        .filter_map(|l| l.trim().strip_prefix("#EXTINF:"))
        .filter_map(|r| r.split(',').next())
        .filter_map(|n| n.trim().parse::<f64>().ok())
        .next_back()
        .unwrap_or(2.0);

    let mut out = String::with_capacity(playlist.len() + 96);
    let mut promoted = false;
    // Held when we've seen a `#EXT-X-PREFETCH-DISCONTINUITY` and are waiting to emit
    // the real `#EXT-X-DISCONTINUITY` immediately before the next promoted segment.
    let mut pending_discontinuity = false;
    for line in playlist.lines() {
        let trimmed = line.trim();
        // Match the prefetch-discontinuity marker BEFORE the prefetch hint check.
        // It carries no value; convert it to a real discontinuity in front of the
        // hint it precedes, never pass the proprietary tag through (hls.js drops it).
        if trimmed.starts_with("#EXT-X-PREFETCH-DISCONTINUITY") {
            pending_discontinuity = true;
            continue;
        }
        if let Some(url) = trimmed.strip_prefix("#EXT-X-TWITCH-PREFETCH:") {
            if pending_discontinuity {
                out.push_str("#EXT-X-DISCONTINUITY\n");
                pending_discontinuity = false;
            }
            out.push_str(&format!("#EXTINF:{:.3},live\n{}\n", dur, url.trim()));
            promoted = true;
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if promoted {
        Some(out)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_midroll_ad_pod_keeps_real() {
        let pl = "#EXTM3U\n\
#EXT-X-VERSION:3\n\
#EXT-X-TARGETDURATION:5\n\
#EXT-X-MEDIA-SEQUENCE:100\n\
#EXT-X-PROGRAM-DATE-TIME:2026-06-02T10:00:00.000Z\n\
#EXTINF:2.000,live\n\
seg100.ts\n\
#EXT-X-DATERANGE:ID=\"stitched-ad-200\",CLASS=\"twitch-stitched-ad\",START-DATE=\"2026-06-02T10:00:02.000Z\",DURATION=4.0,X-TV-TWITCH-AD-ROLL-TYPE=MIDROLL\n\
#EXT-X-DISCONTINUITY\n\
#EXT-X-PROGRAM-DATE-TIME:2026-06-02T10:00:02.000Z\n\
#EXTINF:2.000,Amazon\n\
ad0.ts\n\
#EXT-X-PROGRAM-DATE-TIME:2026-06-02T10:00:04.000Z\n\
#EXTINF:2.000,Amazon\n\
ad1.ts\n\
#EXT-X-DISCONTINUITY\n\
#EXT-X-PROGRAM-DATE-TIME:2026-06-02T10:00:06.000Z\n\
#EXTINF:2.000,live\n\
seg103.ts\n";
        let (out, dropped, real) = filter_ad_segments(pl);
        assert_eq!(dropped, 2);
        assert_eq!(real, 2);
        assert!(out.contains("seg100.ts") && out.contains("seg103.ts"));
        assert!(!out.contains("ad0.ts") && !out.contains("ad1.ts"));
        assert!(!out.contains("Amazon"));
        assert!(!out.contains("twitch-stitched-ad"));
        // No leading ads, so the media sequence is unchanged.
        assert!(out.contains("#EXT-X-MEDIA-SEQUENCE:100"));
    }

    #[test]
    fn leading_ads_bump_media_sequence() {
        let pl = "#EXTM3U\n\
#EXT-X-MEDIA-SEQUENCE:100\n\
#EXTINF:2.000,Amazon\n\
ad0.ts\n\
#EXTINF:2.000,Amazon\n\
ad1.ts\n\
#EXTINF:2.000,live\n\
seg102.ts\n";
        let (out, dropped, real) = filter_ad_segments(pl);
        assert_eq!(dropped, 2);
        assert_eq!(real, 1);
        assert!(out.contains("#EXT-X-MEDIA-SEQUENCE:102"));
        assert!(out.contains("seg102.ts") && !out.contains("ad0.ts"));
    }

    #[test]
    fn ad_free_playlist_keeps_all_segments() {
        let pl = "#EXTM3U\n\
#EXT-X-MEDIA-SEQUENCE:50\n\
#EXTINF:2.000,live\n\
a.ts\n\
#EXTINF:2.000,live\n\
b.ts\n";
        let (_out, dropped, real) = filter_ad_segments(pl);
        assert_eq!(dropped, 0);
        assert_eq!(real, 2);
    }

    #[test]
    fn retarget_lowers_overdeclared_targetduration() {
        let pl = "#EXTM3U\n\
#EXT-X-VERSION:3\n\
#EXT-X-TARGETDURATION:6\n\
#EXT-X-MEDIA-SEQUENCE:100\n\
#EXTINF:2.000,live\n\
a.ts\n\
#EXTINF:2.000,live\n\
b.ts\n";
        let out = retarget_playlist(pl).expect("should lower 6 -> 2");
        assert!(out.contains("#EXT-X-TARGETDURATION:2"));
        assert!(!out.contains("#EXT-X-TARGETDURATION:6"));
        // Segments and other tags survive untouched.
        assert!(out.contains("a.ts") && out.contains("b.ts"));
        assert!(out.contains("#EXT-X-MEDIA-SEQUENCE:100"));
    }

    #[test]
    fn retarget_noop_when_already_correct() {
        let pl = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000,live\na.ts\n";
        assert!(retarget_playlist(pl).is_none());
    }

    #[test]
    fn retarget_noop_on_master_playlist() {
        // No #EXTINF (a master/variant playlist) -> never touch the targetduration.
        let pl = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nchunked.m3u8\n";
        assert!(retarget_playlist(pl).is_none());
    }

    #[test]
    fn retarget_never_raises() {
        // Already-low (or low-latency) declaration must not be raised toward a
        // larger segment; only lower. Here max EXTINF is 2 but TD is 1, leave it.
        let pl = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:2.000,live\na.ts\n";
        assert!(retarget_playlist(pl).is_none());
    }

    #[test]
    fn promote_prefetch_converts_hints_to_segments() {
        let pl = "#EXTM3U\n\
#EXT-X-TARGETDURATION:2\n\
#EXTINF:2.000,live\n\
https://cdn/seg1.ts\n\
#EXT-X-TWITCH-PREFETCH:https://cdn/seg2.ts\n\
#EXT-X-TWITCH-PREFETCH:https://cdn/seg3.ts\n";
        let out = promote_prefetch(pl).expect("should promote hints");
        // Hints are gone, replaced by real segments at the inherited duration.
        assert!(!out.contains("#EXT-X-TWITCH-PREFETCH"));
        assert!(out.contains("#EXTINF:2.000,live\nhttps://cdn/seg2.ts"));
        assert!(out.contains("#EXTINF:2.000,live\nhttps://cdn/seg3.ts"));
        // The original published segment is untouched.
        assert!(out.contains("https://cdn/seg1.ts"));
        // Two promoted + one original = three EXTINF lines.
        assert_eq!(out.matches("#EXTINF:").count(), 3);
    }

    #[test]
    fn promote_prefetch_noop_without_hints() {
        let pl = "#EXTM3U\n#EXTINF:2.000,live\nhttps://cdn/seg1.ts\n";
        assert!(promote_prefetch(pl).is_none());
    }

    // ──── Refresh-stability harness ────
    // Model of how hls.js assigns each segment a (media-sequence number, URL with
    // the trailing `?query` stripped, discontinuity counter) so we can prove its
    // cross-refresh consistency check passes without running hls.js. Rules mirror the
    // bundled parser: SN seeds from `#EXT-X-MEDIA-SEQUENCE` (default 0) and bumps once
    // per segment URI; cc seeds from `#EXT-X-DISCONTINUITY-SEQUENCE` (default 0) and
    // bumps on each `#EXT-X-DISCONTINUITY`; the URL is compared with everything from
    // the first `?` onward removed.
    fn parse_segments(playlist: &str) -> Vec<(u64, String, u64)> {
        let lines: Vec<&str> = playlist.lines().collect();
        let mut sn: u64 = 0;
        let mut cc: u64 = 0;
        let mut out = Vec::new();
        let mut i = 0;
        while i < lines.len() {
            let t = lines[i].trim();
            if let Some(v) = t.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
                sn = v.trim().parse().unwrap_or(0);
            } else if let Some(v) = t.strip_prefix("#EXT-X-DISCONTINUITY-SEQUENCE:") {
                cc = v.trim().parse().unwrap_or(0);
            } else if t == "#EXT-X-DISCONTINUITY" {
                cc += 1;
            } else if t.starts_with("#EXTINF:") {
                // The URI is the next non-tag line; skip forward to it.
                let mut j = i + 1;
                while j < lines.len() && (lines[j].trim().is_empty() || lines[j].trim().starts_with('#')) {
                    j += 1;
                }
                if j < lines.len() {
                    let u = lines[j].trim();
                    let path = u.split('?').next().unwrap_or(u).to_string();
                    out.push((sn, path, cc));
                    sn += 1;
                    i = j;
                }
            }
            i += 1;
        }
        out
    }

    /// Assert that every media-sequence number present in BOTH polls resolves to the
    /// same URL path and the same cc — exactly hls.js's `mapFragmentIntersection`
    /// rule. A violation is what fires the fatal `levelParsingError`.
    fn assert_refresh_consistent(poll_n: &str, poll_n1: &str) {
        let a = parse_segments(poll_n);
        let b = parse_segments(poll_n1);
        for (sn_a, url_a, cc_a) in &a {
            if let Some((_, url_b, cc_b)) = b.iter().find(|(sn_b, _, _)| sn_b == sn_a) {
                assert_eq!(url_a, url_b, "URL path mismatch at sn {sn_a}");
                assert_eq!(cc_a, cc_b, "cc mismatch at sn {sn_a} ({cc_a} != {cc_b})");
            }
        }
        // Guard against an empty overlap silently passing.
        let overlap = a
            .iter()
            .filter(|(sn_a, _, _)| b.iter().any(|(sn_b, _, _)| sn_b == sn_a))
            .count();
        assert!(overlap >= 2, "expected a real SN overlap, got {overlap}");
    }

    #[test]
    fn promote_translates_prefetch_discontinuity() {
        let pl = "#EXTM3U\n\
#EXT-X-TARGETDURATION:2\n\
#EXT-X-MEDIA-SEQUENCE:100\n\
#EXTINF:2.000,live\n\
https://cdn/seg100.ts\n\
#EXT-X-PREFETCH-DISCONTINUITY\n\
#EXT-X-TWITCH-PREFETCH:https://cdn/seg101.ts?token=A\n";
        let out = promote_prefetch(pl).expect("should promote");
        // The proprietary marker is gone, replaced by a real discontinuity placed
        // immediately before the promoted segment.
        assert!(!out.contains("#EXT-X-PREFETCH-DISCONTINUITY"));
        assert!(out.contains("#EXT-X-DISCONTINUITY\n#EXTINF:2.000,live\nhttps://cdn/seg101.ts"));
        // Exactly one discontinuity was introduced (no spurious extras).
        assert_eq!(out.matches("#EXT-X-DISCONTINUITY").count(), 1);
    }

    #[test]
    fn refresh_stable_cc_across_finalize() {
        // Poll N: four published segments, then a prefetch-discontinuity opening the
        // first hint (seg104), then a second hint (seg105).
        let poll_n = "#EXTM3U\n\
#EXT-X-TARGETDURATION:2\n\
#EXT-X-MEDIA-SEQUENCE:100\n\
#EXTINF:2.000,live\nhttps://cdn/seg100.ts\n\
#EXTINF:2.000,live\nhttps://cdn/seg101.ts\n\
#EXTINF:2.000,live\nhttps://cdn/seg102.ts\n\
#EXTINF:2.000,live\nhttps://cdn/seg103.ts\n\
#EXT-X-PREFETCH-DISCONTINUITY\n\
#EXT-X-TWITCH-PREFETCH:https://cdn/seg104.ts?token=A\n\
#EXT-X-TWITCH-PREFETCH:https://cdn/seg105.ts?token=A\n";
        // Poll N+1: window advanced by one (seg100 rolled off). seg104 has finalized,
        // now carrying the REAL discontinuity Twitch promised via the marker. seg105
        // is still a hint; seg106 is the new hint. Queries rotated (token=B) to prove
        // they're ignored by the path comparison.
        let poll_n1 = "#EXTM3U\n\
#EXT-X-TARGETDURATION:2\n\
#EXT-X-MEDIA-SEQUENCE:101\n\
#EXTINF:2.000,live\nhttps://cdn/seg101.ts\n\
#EXTINF:2.000,live\nhttps://cdn/seg102.ts\n\
#EXTINF:2.000,live\nhttps://cdn/seg103.ts\n\
#EXT-X-DISCONTINUITY\n\
#EXTINF:2.000,live\nhttps://cdn/seg104.ts?token=B\n\
#EXT-X-TWITCH-PREFETCH:https://cdn/seg105.ts?token=B\n\
#EXT-X-TWITCH-PREFETCH:https://cdn/seg106.ts?token=B\n";
        let pn = promote_prefetch(poll_n).expect("poll N has hints");
        let pn1 = promote_prefetch(poll_n1).expect("poll N+1 has hints");
        // The promoted poll N must agree with the finalized poll N+1 on every shared
        // SN. This is the exact case the naive promotion failed (seg104 cc 0 vs 1).
        assert_refresh_consistent(&pn, &pn1);
        // Spot-check the headline segment: cc must be 1 in both (one discontinuity
        // before it), proving the marker→discontinuity translation lined them up.
        let seg104_n = parse_segments(&pn).into_iter().find(|(sn, _, _)| *sn == 104).unwrap();
        let seg104_n1 = parse_segments(&pn1).into_iter().find(|(sn, _, _)| *sn == 104).unwrap();
        assert_eq!(seg104_n.2, 1);
        assert_eq!(seg104_n1.2, 1);
    }

    #[test]
    fn refresh_stable_steady_stream_no_discontinuity() {
        // No discontinuity anywhere: cc must stay 0 across the finalize boundary, and
        // promotion must not invent one.
        let poll_n = "#EXTM3U\n\
#EXT-X-MEDIA-SEQUENCE:200\n\
#EXTINF:2.000,live\nhttps://cdn/seg200.ts\n\
#EXTINF:2.000,live\nhttps://cdn/seg201.ts\n\
#EXT-X-TWITCH-PREFETCH:https://cdn/seg202.ts?token=A\n\
#EXT-X-TWITCH-PREFETCH:https://cdn/seg203.ts?token=A\n";
        let poll_n1 = "#EXTM3U\n\
#EXT-X-MEDIA-SEQUENCE:201\n\
#EXTINF:2.000,live\nhttps://cdn/seg201.ts\n\
#EXTINF:2.000,live\nhttps://cdn/seg202.ts?token=B\n\
#EXT-X-TWITCH-PREFETCH:https://cdn/seg203.ts?token=B\n\
#EXT-X-TWITCH-PREFETCH:https://cdn/seg204.ts?token=B\n";
        let pn = promote_prefetch(poll_n).expect("hints");
        let pn1 = promote_prefetch(poll_n1).expect("hints");
        assert!(!pn.contains("#EXT-X-DISCONTINUITY"));
        assert_refresh_consistent(&pn, &pn1);
    }

    #[test]
    fn promote_preserves_published_segment_cc() {
        // A published mid-window discontinuity plus a seeded discontinuity-sequence:
        // promotion must leave the published segments' cc untouched and only add cc at
        // the tail.
        let pl = "#EXTM3U\n\
#EXT-X-MEDIA-SEQUENCE:300\n\
#EXT-X-DISCONTINUITY-SEQUENCE:7\n\
#EXTINF:2.000,live\nhttps://cdn/seg300.ts\n\
#EXT-X-DISCONTINUITY\n\
#EXTINF:2.000,live\nhttps://cdn/seg301.ts\n\
#EXT-X-PREFETCH-DISCONTINUITY\n\
#EXT-X-TWITCH-PREFETCH:https://cdn/seg302.ts?token=A\n";
        let out = promote_prefetch(pl).expect("hints");
        let segs = parse_segments(&out);
        // Published: seg300 cc=7 (seed), seg301 cc=8 (one real discontinuity).
        assert_eq!(segs.iter().find(|(sn, _, _)| *sn == 300).unwrap().2, 7);
        assert_eq!(segs.iter().find(|(sn, _, _)| *sn == 301).unwrap().2, 8);
        // Promoted tail: seg302 cc=9 (the translated prefetch-discontinuity).
        assert_eq!(segs.iter().find(|(sn, _, _)| *sn == 302).unwrap().2, 9);
    }
}
