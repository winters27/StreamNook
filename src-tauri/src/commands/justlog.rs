use crate::services::twitch_service::TwitchService;
use serde::{Deserialize, Serialize};

const JUSTLOG_BASE: &str = "https://logs.ivr.fi";
// best-logs (ZonianMidian) routes a channel/user to whichever justlog instance
// actually logs it. logs.ivr.fi covers a lot but not everything, so without this
// the Justlog source silently goes empty on channels it doesn't log.
const BESTLOGS_BASE: &str = "https://logs.zonian.dev";
const ROBOTTY_BASE: &str = "https://recent-messages.robotty.de";
const TWITCH_GQL_URL: &str = "https://gql.twitch.tv/gql";
const TWITCH_WEB_CLIENT_ID: &str = env!("TWITCH_WEB_CLIENT_ID");

// Persisted-query hash for Twitch's `MessageBufferChatHistory` operation.
// Captured from Twitch's web client traffic via NodeCapture on 2026-01-12;
// works for any logged-in user (NOT mod-gated). If Twitch ever rotates this
// hash the request returns `PERSISTED_QUERY_NOT_FOUND` and the function
// silently returns empty — fallback sources still cover us.
const MESSAGE_BUFFER_CHAT_HISTORY_HASH: &str =
    "33dba0e0c249135052e930cbd6c4a66daa32249ba00d1c8def75857fa3f3431d";

/// One historical message normalized across all sources we pull from. The
/// optional `id` is the Twitch message ID (UUID-format, comes from the IRC
/// `id=` tag) and is the canonical dedupe key when present — every source
/// can provide it since they're all reading the same underlying IRC stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JustlogMessage {
    pub timestamp: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JustlogResponse {
    messages: Vec<JustlogRawMessage>,
}

#[derive(Debug, Deserialize)]
struct JustlogRawMessage {
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RobottyResponse {
    #[serde(default)]
    messages: Vec<String>,
}

/// best-logs discovery response. We only need the instance lists; each is an
/// array of justlog base URLs (e.g. "https://logs.ivr.fi") sorted with the
/// best-coverage instance first.
#[derive(Debug, Deserialize)]
struct BestLogsResponse {
    #[serde(default, rename = "userLogs")]
    user_logs: Option<BestLogsInstanceList>,
    #[serde(default, rename = "channelLogs")]
    channel_logs: Option<BestLogsInstanceList>,
}

#[derive(Debug, Deserialize)]
struct BestLogsInstanceList {
    #[serde(default)]
    instances: Vec<String>,
}

/// Fetch a user's historical chat messages in a given channel by combining
/// four upstream sources, ranked by reliability:
///
/// 1. **Twitch GQL `ViewerCardModLogsMessagesBySender`**: deep per-user
///    history straight from Twitch. Mod-gated — only works when the
///    requester is a mod in the channel. Silently empty otherwise.
/// 2. **Twitch GQL `MessageBufferChatHistory`**: Twitch's channel-wide
///    chat backlog (the same query the web client uses on channel join).
///    Works for ANY logged-in user (not mod-gated). Verified via NodeCapture
///    2026-01-12 — captured with a regular user token returning 200.
///    Returns ~30 recent channel messages from all senders; filtered
///    client-side to the target user.
/// 3. **Justlog**, routed via best-logs: deep per-user history for logged
///    channels. best-logs (`logs.zonian.dev`) resolves which justlog instance
///    logs the channel; falls back to `logs.ivr.fi` directly. 404s when no
///    instance logs the channel.
/// 4. **recent-messages.robotty.de**: third-party channel backlog mirror,
///    last ~100 messages. Available for nearly any channel.
///
/// All fire in parallel. Results merged, sorted by parsed unix-ms, deduped
/// by Twitch message ID. Any source failing is non-fatal — whichever
/// sources returned data become the answer.
#[tauri::command]
pub async fn fetch_user_chat_logs(
    channel: String,
    username: String,
    #[allow(non_snake_case)] channelId: Option<String>,
    #[allow(non_snake_case)] userId: Option<String>,
) -> Result<Vec<JustlogMessage>, String> {
    if channel.is_empty() || username.is_empty() {
        return Ok(Vec::new());
    }

    let channel_lower = channel.to_lowercase();
    let username_lower = username.to_lowercase();

    let client = reqwest::Client::builder()
        .user_agent("StreamNook")
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    // Mod-gated Twitch GQL only fires when we have both IDs.
    let twitch_modlogs_fut = async {
        match (&channelId, &userId) {
            (Some(cid), Some(uid)) if !cid.is_empty() && !uid.is_empty() => {
                fetch_from_twitch_gql(&client, cid, uid).await
            }
            _ => Ok(Vec::new()),
        }
    };

    // MessageBufferChatHistory works for any logged-in user. Needs channel_id
    // for the persisted query variables.
    let twitch_buffer_fut = async {
        match &channelId {
            Some(cid) if !cid.is_empty() => {
                fetch_from_message_buffer(&client, cid, &channel_lower, &username_lower).await
            }
            _ => Ok(Vec::new()),
        }
    };

    // Hard per-source cap. The popup renders local session history immediately
    // and only waits on this call to fill the empty state, so a single slow
    // third-party source (justlog/robotty/best-logs having a bad moment) must
    // never stall the whole card. Any source that exceeds the cap yields empty
    // and the others still answer. The reqwest client's own 8s timeout is the
    // outer bound; this is the tighter interactive one.
    let src_cap = std::time::Duration::from_secs(6);
    let (twitch_modlogs_result, twitch_buffer_result, justlog_result, robotty_result) = tokio::join!(
        async { tokio::time::timeout(src_cap, twitch_modlogs_fut).await.unwrap_or_else(|_| Ok(Vec::new())) },
        async { tokio::time::timeout(src_cap, twitch_buffer_fut).await.unwrap_or_else(|_| Ok(Vec::new())) },
        async { tokio::time::timeout(src_cap, fetch_from_justlog(&client, &channel_lower, &username_lower)).await.unwrap_or_else(|_| Ok(Vec::new())) },
        async { tokio::time::timeout(src_cap, fetch_from_robotty(&client, &channel_lower, &username_lower)).await.unwrap_or_else(|_| Ok(Vec::new())) },
    );

    let mut merged: Vec<JustlogMessage> = Vec::new();
    if let Ok(mut m) = twitch_modlogs_result {
        merged.append(&mut m);
    }
    if let Ok(mut m) = twitch_buffer_result {
        merged.append(&mut m);
    }
    if let Ok(mut m) = justlog_result {
        merged.append(&mut m);
    }
    if let Ok(mut m) = robotty_result {
        merged.append(&mut m);
    }

    // Sort by parsed unix-millis, NOT by the timestamp string. Different
    // sources format timestamps differently (`Z` vs `+00:00`, with/without
    // milliseconds), so string comparison can put the same instant in
    // different positions. Convert once and use that for the order.
    merged.sort_by_key(|m| parse_timestamp_ms(&m.timestamp).unwrap_or(0));

    // Dedupe by Twitch message ID when both messages have one. Every source
    // we pull from has access to the IRC `id=` tag (the canonical message
    // identifier), so the same message coming through Twitch GQL + Justlog
    // + Robotty all carry the same id. For older entries where any source
    // omitted the id, fall back to (content + timestamp-bucketed-to-2s) so
    // we still catch obvious cross-source duplicates while not collapsing
    // legitimate spam (Twitch's rate limit keeps even fast spammers above
    // 1 message per second in practice).
    let mut deduped: Vec<JustlogMessage> = Vec::with_capacity(merged.len());
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for msg in merged {
        if let Some(id) = &msg.id {
            if !seen_ids.insert(id.clone()) {
                continue;
            }
        } else {
            // No id available — match against any existing entry with same
            // content and a timestamp within 2 seconds.
            let msg_ms = parse_timestamp_ms(&msg.timestamp).unwrap_or(0);
            let dup = deduped.iter().any(|existing| {
                if existing.content != msg.content {
                    return false;
                }
                let ex_ms = parse_timestamp_ms(&existing.timestamp).unwrap_or(0);
                (existing.id.is_none() || existing.id.as_ref() == msg.id.as_ref())
                    && (ex_ms - msg_ms).abs() <= 2_000
            });
            if dup {
                continue;
            }
        }
        deduped.push(msg);
    }

    Ok(deduped)
}

/// Parse any of the timestamp formats our three sources can emit into unix
/// milliseconds. Accepts: `2024-01-15T18:30:00Z`, `2024-01-15T18:30:00.123Z`,
/// and `2024-01-15T18:30:00.123+00:00`. Returns None when nothing matches so
/// callers can fall back to zero for sorting (parsing failures end up at the
/// top of the list, but they shouldn't happen with our known sources).
fn parse_timestamp_ms(ts: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// Hits Twitch's `MessageBufferChatHistory` GQL operation — the same call
/// Twitch's web client makes when you load a channel page. Returns ~30
/// recent channel messages from all senders; we filter to the target user
/// client-side.
///
/// Works for any logged-in user (verified via NodeCapture 2026-01-12 with a
/// regular non-mod OAuth token returning 200). Uses Twitch's persisted-query
/// hash for efficiency; if Twitch rotates the hash the response carries
/// `PERSISTED_QUERY_NOT_FOUND` and we silently fall back to empty.
async fn fetch_from_message_buffer(
    client: &reqwest::Client,
    channel_id: &str,
    channel_login: &str,
    target_login: &str,
) -> Result<Vec<JustlogMessage>, String> {
    let token = match TwitchService::get_token().await {
        Ok(t) if !t.is_empty() => t,
        _ => return Ok(Vec::new()),
    };

    let body = serde_json::json!({
        "operationName": "MessageBufferChatHistory",
        "variables": {
            "channelID": channel_id,
            "channelLogin": channel_login,
        },
        "extensions": {
            "persistedQuery": {
                "version": 1,
                "sha256Hash": MESSAGE_BUFFER_CHAT_HISTORY_HASH,
            }
        }
    });

    let response = client
        .post(TWITCH_GQL_URL)
        .header("Client-ID", TWITCH_WEB_CLIENT_ID)
        .header("Authorization", format!("OAuth {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("MessageBufferChatHistory request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "MessageBufferChatHistory HTTP {}",
            response.status()
        ));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse MessageBufferChatHistory: {}", e))?;

    // The Twitch GQL endpoint can return either a single object or an array
    // of objects (for batched queries). Real responses we've captured are a
    // single object; handle both shapes defensively.
    let root = if json.is_array() {
        json.get(0).cloned().unwrap_or(serde_json::Value::Null)
    } else {
        json
    };

    let messages_arr = match root
        .pointer("/data/channel/recentChatMessages")
        .and_then(|v| v.as_array())
    {
        Some(arr) => arr.clone(),
        None => return Ok(Vec::new()),
    };

    let target_lower = target_login.to_lowercase();
    let messages: Vec<JustlogMessage> = messages_arr
        .iter()
        .filter_map(|msg| {
            // Filter to the target user by sender login (case-insensitive).
            let sender_login = msg
                .get("sender")
                .and_then(|s| s.get("login"))
                .and_then(|l| l.as_str())?;
            if sender_login.to_lowercase() != target_lower {
                return None;
            }
            // Skip deleted messages — they show as a placeholder in chat UI
            // but rendering them in a history view is misleading.
            if !msg.get("deletedAt").map(|v| v.is_null()).unwrap_or(true) {
                return None;
            }
            let id = msg.get("id").and_then(|v| v.as_str()).map(String::from);
            let timestamp = msg.get("sentAt").and_then(|v| v.as_str())?.to_string();
            let content = msg
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())?
                .to_string();
            if content.trim().is_empty() {
                return None;
            }
            Some(JustlogMessage {
                timestamp,
                content,
                id,
            })
        })
        .collect();

    Ok(messages)
}

async fn fetch_from_twitch_gql(
    client: &reqwest::Client,
    channel_id: &str,
    sender_id: &str,
) -> Result<Vec<JustlogMessage>, String> {
    // The viewerCardModLogs root field is mod-gated — non-mods get a
    // ViewerCardModLogsMessagesError back and we silently fall through.
    // Authenticated request requires the user's OAuth token; without one
    // the query returns nothing useful, so skip the round trip.
    let token = match TwitchService::get_token().await {
        Ok(t) if !t.is_empty() => t,
        _ => return Ok(Vec::new()),
    };

    // Minimal inline query — only the chat-message variant of the message
    // node union. We deliberately don't depend on Twitch's persisted-query
    // hashes (they rotate); shipping the full query text is a few hundred
    // bytes and is stable.
    let query = r#"
        query ViewerCardModLogsMessagesBySender($channelID: ID!, $senderID: ID!) {
          logs: viewerCardModLogs(channelID: $channelID, targetID: $senderID) {
            messages(first: 50) {
              __typename
              ... on ViewerCardModLogsMessagesConnection {
                edges {
                  node {
                    __typename
                    ... on ViewerCardModLogsChatMessage {
                      id
                      sentAt
                      content { text }
                    }
                  }
                }
              }
            }
          }
        }
    "#;

    let body = serde_json::json!({
        "operationName": "ViewerCardModLogsMessagesBySender",
        "query": query,
        "variables": {
            "channelID": channel_id,
            "senderID": sender_id,
        }
    });

    let response = client
        .post(TWITCH_GQL_URL)
        .header("Client-ID", TWITCH_WEB_CLIENT_ID)
        .header("Authorization", format!("OAuth {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Twitch GQL request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Twitch GQL HTTP {}", response.status()));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Twitch GQL response: {}", e))?;

    // The messages field is a union; on error (non-mod, unauthorized, etc.)
    // there's no `edges` and we treat it as empty.
    let edges = match json
        .pointer("/data/logs/messages/edges")
        .and_then(|v| v.as_array())
    {
        Some(e) => e,
        None => return Ok(Vec::new()),
    };

    let messages: Vec<JustlogMessage> = edges
        .iter()
        .filter_map(|edge| {
            let node = edge.get("node")?;
            // Skip non-chat-message variants (mod actions, caught messages, etc.).
            if node.get("__typename")?.as_str()? != "ViewerCardModLogsChatMessage" {
                return None;
            }
            let timestamp = node.get("sentAt")?.as_str()?.to_string();
            let content = node
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())?
                .to_string();
            if content.trim().is_empty() {
                return None;
            }
            let id = node.get("id").and_then(|v| v.as_str()).map(String::from);
            Some(JustlogMessage {
                timestamp,
                content,
                id,
            })
        })
        .collect();

    Ok(messages)
}

/// Ask best-logs which justlog instance logs this channel+user and return that
/// instance's base URL. Prefers an instance that logs the target user; falls
/// back to one that logs the channel (the user may simply have no messages yet).
/// Returns None if best-logs is unreachable or reports the channel isn't logged
/// anywhere, in which case the caller uses logs.ivr.fi directly.
///
/// Uses best-logs' lightweight discovery endpoint (`/api/{channel}/{user}`), NOT
/// its `/channel/...` proxy mirror: the mirror is Cloudflare rate-limited (it
/// returns a 1015 page under even light load), the discovery endpoint is not.
async fn resolve_justlog_instance(
    client: &reqwest::Client,
    channel: &str,
    username: &str,
) -> Option<String> {
    let url = format!("{}/api/{}/{}", BESTLOGS_BASE, channel, username);
    // Short, dedicated timeout: discovery is just a routing hint. If best-logs
    // is slow or Cloudflare-challenges us, bail fast and let the caller fall
    // back to logs.ivr.fi rather than burning the justlog branch's whole budget.
    let response = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let parsed: BestLogsResponse = response.json().await.ok()?;
    parsed
        .user_logs
        .and_then(|l| l.instances.into_iter().next())
        .or_else(|| parsed.channel_logs.and_then(|l| l.instances.into_iter().next()))
        .filter(|base| base.starts_with("https://") || base.starts_with("http://"))
}

async fn fetch_from_justlog(
    client: &reqwest::Client,
    channel: &str,
    username: &str,
) -> Result<Vec<JustlogMessage>, String> {
    // Route to whichever instance actually logs this channel; fall back to
    // logs.ivr.fi directly when best-logs can't resolve one (unreachable, or the
    // channel genuinely isn't logged anywhere — ivr.fi will then 404 cleanly).
    let base = resolve_justlog_instance(client, channel, username)
        .await
        .unwrap_or_else(|| JUSTLOG_BASE.to_string());

    let url = format!("{}/channel/{}/user/{}?json=1", base, channel, username);

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Justlog request failed: {}", e))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Vec::new());
    }
    if !response.status().is_success() {
        return Err(format!("Justlog API error: {}", response.status()));
    }

    let parsed: JustlogResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Justlog response: {}", e))?;

    Ok(parsed
        .messages
        .into_iter()
        .filter_map(|m| {
            let content = m.text?;
            if content.trim().is_empty() {
                return None;
            }
            Some(JustlogMessage {
                timestamp: m.timestamp.unwrap_or_default(),
                content,
                id: m.id,
            })
        })
        .collect())
}

async fn fetch_from_robotty(
    client: &reqwest::Client,
    channel: &str,
    username: &str,
) -> Result<Vec<JustlogMessage>, String> {
    let url = format!(
        "{}/api/v2/recent-messages/{}?limit=100",
        ROBOTTY_BASE, channel
    );

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Robotty request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Robotty API error: {}", response.status()));
    }

    let parsed: RobottyResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Robotty response: {}", e))?;

    Ok(parsed
        .messages
        .iter()
        .filter_map(|raw| parse_robotty_message(raw, username))
        .collect())
}

/// Minimal IRCv3 line parser scoped to what recent-messages.robotty.de hands
/// us: each entry is a raw IRC line of the form
/// `@tag1=val1;tag2=val2;... :nick!nick@nick.tmi.twitch.tv PRIVMSG #channel :body`.
///
/// We only need three things out of it: confirm the sender's login matches our
/// target, extract `tmi-sent-ts` for the timestamp, and pull the body. We
/// deliberately don't bring in a full IRC parser dependency for this — the
/// format is rigid enough that careful string splitting suffices.
fn parse_robotty_message(raw: &str, target_login: &str) -> Option<JustlogMessage> {
    // Robotty includes non-PRIVMSG events too (USERNOTICE, CLEARCHAT, etc.).
    // Skip anything that isn't a regular chat message — those aren't what the
    // user is asking to see when they click "show messages."
    if !raw.contains(" PRIVMSG ") {
        return None;
    }

    let line = raw.strip_prefix('@')?;
    let (tags, rest) = line.split_once(' ')?;

    // ":nick!nick@nick.tmi.twitch.tv ..." — login is everything before the !.
    let nick_section = rest.strip_prefix(':')?;
    let nick = nick_section.split_once('!')?.0;
    if !nick.eq_ignore_ascii_case(target_login) {
        return None;
    }

    // Body lives after the second " :" (first is between IRC params and trailing).
    let body_start = rest.find(" PRIVMSG ")? + " PRIVMSG ".len();
    let after_privmsg = &rest[body_start..];
    let body = after_privmsg.split_once(" :")?.1.to_string();
    if body.trim().is_empty() {
        return None;
    }

    // Pull tmi-sent-ts (unix milliseconds as a decimal string) out of the tags.
    let ts_ms: i64 = tags
        .split(';')
        .find_map(|t| t.strip_prefix("tmi-sent-ts="))
        .and_then(|s| s.parse().ok())?;

    let timestamp = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ts_ms)?.to_rfc3339();

    // The IRC `id=<uuid>` tag is the canonical Twitch message ID — same id
    // Twitch GQL and Justlog will report for this message. Critical for
    // cross-source dedupe; without it we fall back to content+time matching.
    let id = tags
        .split(';')
        .find_map(|t| t.strip_prefix("id="))
        .map(String::from);

    Some(JustlogMessage {
        timestamp,
        content: body,
        id,
    })
}
