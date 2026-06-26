//! Composite source-key codec shared by the chat bus and the provider adapters.
//!
//! A source is identified by `"<provider>:<channel>"` (e.g. `"kick:xqc"`). This
//! mirrors `src/utils/providerKey.ts` on the frontend. A bare key with no
//! recognised provider prefix is treated as a legacy Twitch login, so older
//! persisted state and the existing Twitch code paths keep working unchanged.

pub const PROVIDER_IDS: [&str; 6] = ["twitch", "kick", "youtube", "rumble", "tiktok", "x"];
pub const DEFAULT_PROVIDER: &str = "twitch";

pub fn is_provider_id(s: &str) -> bool {
    PROVIDER_IDS.contains(&s)
}

/// Build a composite key. The channel is lowercased to match the chat store.
pub fn make_key(provider: &str, channel: &str) -> String {
    format!("{}:{}", provider, channel.to_lowercase())
}

pub struct ParsedKey {
    pub provider: String,
    pub channel: String,
}

/// Split a composite key. Only splits on a recognised provider prefix; anything
/// else (a bare login, or text that merely contains a colon) is read as Twitch.
pub fn parse_key(key: &str) -> ParsedKey {
    if let Some(idx) = key.find(':') {
        let maybe = &key[..idx];
        if is_provider_id(maybe) {
            return ParsedKey {
                provider: maybe.to_string(),
                channel: key[idx + 1..].to_string(),
            };
        }
    }
    ParsedKey {
        provider: DEFAULT_PROVIDER.to_string(),
        channel: key.to_lowercase(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_provider_keys() {
        let k = make_key("kick", "XQC");
        assert_eq!(k, "kick:xqc");
        let p = parse_key(&k);
        assert_eq!(p.provider, "kick");
        assert_eq!(p.channel, "xqc");
    }

    #[test]
    fn bare_login_reads_as_twitch() {
        let p = parse_key("xqc");
        assert_eq!(p.provider, "twitch");
        assert_eq!(p.channel, "xqc");
    }

    #[test]
    fn unknown_prefix_reads_as_twitch() {
        // A channel literally named like a provider, or stray text with a colon.
        let p = parse_key("notaprovider:thing");
        assert_eq!(p.provider, "twitch");
        assert_eq!(p.channel, "notaprovider:thing");
    }
}
