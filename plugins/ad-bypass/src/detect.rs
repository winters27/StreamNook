//! Ad-marker detection, run in this plugin's own process. The core StreamNook
//! relay never scans playlists for ads; this plugin polls the media playlist it
//! resolved and recognizes Twitch's SSAI ad signatures itself, so all ad logic
//! (detection and the region pivot) lives entirely in this separate program.

/// High-confidence Twitch SSAI ad signatures: the stitched-ad DATERANGE class
/// and id form (`stitched-ad`), the ad metadata attributes (`X-TV-TWITCH-AD`),
/// and the `Amazon` EXTINF ad title. CUE-OUT / SCTE35 are intentionally absent;
/// Twitch SSAI does not use them.
const MARKERS: &[&str] = &["stitched-ad", "X-TV-TWITCH-AD", "Amazon"];

/// True when the media playlist carries ad-stitch markers.
pub fn has_ads(playlist: &str) -> bool {
    MARKERS.iter().any(|m| playlist.contains(m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_ad_markers() {
        assert!(has_ads(
            "#EXTM3U\n#EXT-X-DATERANGE:ID=\"stitched-ad-1\",CLASS=\"twitch-stitched-ad\"\n#EXTINF:2.0,Amazon\nad.ts\n"
        ));
        assert!(has_ads("#EXTINF:2.0,Amazon\nad.ts\n"));
    }

    #[test]
    fn ignores_clean_playlist() {
        assert!(!has_ads("#EXTM3U\n#EXTINF:2.000,live\na.ts\n#EXTINF:2.000,live\nb.ts\n"));
    }
}
