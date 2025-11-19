use anyhow::Result;
use discord_rich_presence::{activity::*, DiscordIpc, DiscordIpcClient};
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::models::settings::AppState;
use lazy_static::lazy_static;
use rand::prelude::IndexedRandom;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

// --- New Imports for matching logic ---
use regex::Regex;
use strsim::normalized_levenshtein;
use std::collections::HashSet;
// --- End New Imports ---

// Discord asset keys - these must match the asset names uploaded to Discord Developer Portal
const DISCORD_LARGE_IMAGE: &str = "streamnook_logo";
const DISCORD_SMALL_IMAGE_TWITCH: &str = "twitch";

pub struct DiscordService;

struct DiscordState {
    client: Option<DiscordIpcClient>,
    start_time: i64,
}

lazy_static! {
    static ref DISCORD_STATE: Arc<Mutex<DiscordState>> = Arc::new(Mutex::new(DiscordState {
        client: None,
        start_time: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64,
    }));
}

// ---
// START: MOVED lazy_static! BLOCK
// ---
// This block is now at the top-level, outside of the `impl` block.
lazy_static! {
    // Compile the regex patterns from your Python script
    static ref CLEAN_PATTERNS: Vec<Regex> = vec![
        Regex::new(r"[®™©]").unwrap(), // Remove trademark symbols
        Regex::new(r"\s*\(.*?\)").unwrap(), // (demo), (beta), etc.
        Regex::new(r"\s*\[.*?\]").unwrap(), // [Open Beta], etc.
        Regex::new(r":\s*[Tt]he\s+").unwrap(), // : The Game
        Regex::new(r"\s*-\s*[Ss]eason\s+\d+").unwrap(), // - Season 1
        Regex::new(r"\s*[Ee]dition$").unwrap(), // Edition
        Regex::new(r"\s*[Rr]emastered$").unwrap(), // Remastered
        Regex::new(r"\s*[Dd]efinitive\s+[Ee]dition$").unwrap(), // Definitive Edition
    ];

    static ref STOP_WORDS: HashSet<&'static str> =
        ["the", "a", "an", "of", "in", "on", "at", "to", "for"]
        .iter().cloned().collect();
}
// ---
// END: MOVED lazy_static! BLOCK
// ---

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DiscordApp {
    id: String,
    name: String,
    #[serde(default)]
    icon_hash: Option<String>, // <--- CORRECTED
    #[serde(default)]
    cover_image: Option<String>,
    #[serde(default)]
    aliases: Vec<String>,
}

const BROWSING_PHRASES: &[&str] = &[
    "Channel Surfing for Poggers",
    "Lost in the Twitch Jungle",
    "Hunting for the next Hype Train",
    "Just Chatting... with myself",
    "AFK, but my eyes are still watching",
    "Searching for the legendary Kappa",
    "Dodging spoilers like a pro gamer",
    "Vibing in the VODs",
    "Exploring the emote-verse",
    "Where's the 'unfollow' button for reality?",
];

const IDLE_PHRASES: &[&str] = &[
    "AFK (Away From Keyboard, but not from Twitch)",
    "Just chilling, waiting for the next stream",
    "Buffering... please wait",
    "In a staring contest with my screen",
    "My brain is in emote-only mode",
    "Currently respawning...",
    "Thinking about what to raid next",
    "Lost in thought, probably about subs",
    "Powered by caffeine and good vibes",
    "Waiting for the next 'clip that!' moment",
];

impl DiscordService {
    /// Connect to Discord and set idle presence
    pub async fn connect(app_state: &AppState) -> Result<()> {
        let discord_enabled = {
            let settings = app_state.settings.lock().unwrap();
            settings.discord_rpc_enabled
        };
        
        if !discord_enabled {
            return Ok(());
        }

        let mut guard = DISCORD_STATE.lock().await;
        
        // If already connected, just update to idle
        if guard.client.is_some() {
            return Self::set_idle_presence_internal(&mut guard).await;
        }

        // Create new connection
        let mut client = DiscordIpcClient::new("1436402207485464596");
        client.connect()
            .map_err(|e| anyhow::anyhow!("Failed to connect to Discord: {}", e))?;
        
        guard.client = Some(client);
        guard.start_time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
        
        // Set initial idle presence
        Self::set_idle_presence_internal(&mut guard).await
    }

    /// Disconnect from Discord
    pub async fn disconnect() -> Result<()> {
        let mut guard = DISCORD_STATE.lock().await;
        if let Some(mut client) = guard.client.take() {
            let _ = client.clear_activity();
            let _ = client.close();
        }
        Ok(())
    }

    /// Set idle/browsing presence
    pub async fn set_idle_presence(app_state: &AppState) -> Result<()> {
        let discord_enabled = {
            let settings = app_state.settings.lock().unwrap();
            settings.discord_rpc_enabled
        };
        
        if !discord_enabled {
            return Ok(());
        }

        let mut guard = DISCORD_STATE.lock().await;
        Self::set_idle_presence_internal(&mut guard).await
    }

    async fn set_idle_presence_internal(guard: &mut tokio::sync::MutexGuard<'_, DiscordState>) -> Result<()> {
        // Get timestamp before any borrows
        let timestamp = guard.start_time;
        
        if let Some(client) = &mut guard.client {
            let mut rng = rand::rng();
            let browsing = BROWSING_PHRASES.choose(&mut rng).unwrap_or(&"Browsing Twitch");
            let idle = IDLE_PHRASES.choose(&mut rng).unwrap_or(&"Just chilling");

            let activity = Activity::new()
                .details(browsing)
                .state(idle)
                .assets(
                    Assets::new()
                        .large_image(DISCORD_LARGE_IMAGE)
                        .large_text("Stream Nook")
                )
                .timestamps(Timestamps::new().start(timestamp))
                .buttons(vec![Button::new("Download Stream Nook", "https://github.com/winters27/StreamNook/")]);

            client.set_activity(activity)
                .map_err(|e| anyhow::anyhow!("Failed to set idle presence: {}", e))?;
        }
        Ok(())
    }

    /// Update presence when watching a stream
    pub async fn update_presence(
        details: &str, 
        state: &str, 
        _large_image: &str,
        _small_image: &str,
        _start_time: u64, 
        game_name: &str,
        stream_url: &str,
        app_state: &AppState
    ) -> Result<()> {
        let discord_enabled = {
            let settings = app_state.settings.lock().unwrap();
            settings.discord_rpc_enabled
        };
        
        if !discord_enabled {
            return Ok(());
        }

        let mut guard = DISCORD_STATE.lock().await;
        
        // Ensure we're connected
        if guard.client.is_none() {
            let mut client = DiscordIpcClient::new("1436402207485464596");
            client.connect()
                .map_err(|e| anyhow::anyhow!("Failed to connect to Discord: {}", e))?;
            guard.client = Some(client);
        }

        // Get start time and drop the mutable borrow temporarily
        let timestamp = guard.start_time;
        let has_client = guard.client.is_some();
        
        if !has_client {
            return Ok(());
        }
        
        // Try to get game image from Discord's detectable games (outside the borrow)
        let game_image_url = if !game_name.is_empty() {
            Self::resolve_game_image(game_name).await.ok()
        } else {
            None
        };
        
        // Now get mutable reference to client
        if let Some(client) = &mut guard.client {
            
            let mut assets = Assets::new();
            
            if let Some(ref url) = game_image_url {
                assets = assets.large_image(url);
                assets = assets.large_text(game_name);
            } else {
                // Fallback to StreamNook icon if game not found
                assets = assets.large_image(DISCORD_LARGE_IMAGE);
                assets = assets.large_text("Stream Nook");
            }
            
            // Add Twitch logo as small image
            assets = assets.small_image("https://raw.githubusercontent.com/winters27/StreamNook/refs/heads/main/assets/logo_1704751143960.JPG");
            assets = assets.small_text("Twitch");

            let mut activity = Activity::new()
                .details(details)
                .state(state)
                .assets(assets)
                .timestamps(Timestamps::new().start(timestamp))
                .activity_type(ActivityType::Watching); // Set activity type to "Watching"

            // Add buttons - always include both if stream_url is available
            if !stream_url.is_empty() {
                activity = activity.buttons(vec![
                    Button::new("Watch Stream", stream_url),
                    Button::new("Download Stream Nook", "https://github.com/winters27/StreamNook/")
                ]);
            }

            client.set_activity(activity)
                .map_err(|e| anyhow::anyhow!("Failed to set Discord activity: {}", e))?;
        }

        Ok(())
    }

    /// Clear presence
    pub async fn clear_presence(app_state: &AppState) -> Result<()> {
        let discord_enabled = {
            let settings = app_state.settings.lock().unwrap();
            settings.discord_rpc_enabled
        };
        
        if !discord_enabled {
            return Ok(());
        }

        let mut guard = DISCORD_STATE.lock().await;
        if let Some(client) = &mut guard.client {
            client.clear_activity()
                .map_err(|e| anyhow::anyhow!("Failed to clear Discord activity: {}", e))?;
        }
        Ok(())
    }

    // ---
    // Start: CORRECTED resolve_game_image and NEW matching logic
    // ---

    /// Resolve game name to Discord game image URL
    async fn resolve_game_image(game_name: &str) -> Result<String> {
        // Fetch Discord's detectable games list
        let apps = Self::fetch_discord_detectables().await?;
        
        // Try to match the game
        // We pass a threshold, just like the Python version
        if let Some(matched_app) = Self::match_game(&apps, game_name, 0.6) {
            // Prefer cover_image, fallback to icon_hash
            if let Some(cover) = &matched_app.cover_image {
                return Ok(format!("https://cdn.discordapp.com/app-assets/{}/{}.png?size=512", matched_app.id, cover));
            }
            if let Some(icon_hash) = &matched_app.icon_hash { // <--- CORRECTED
                return Ok(format!("https://cdn.discordapp.com/app-icons/{}/{}.png?size=512", matched_app.id, icon_hash)); // <--- CORRECTED
            }
        }
        
        Err(anyhow::anyhow!("Game image not found"))
    }


    /// Fetch Discord's detectable games list
    async fn fetch_discord_detectables() -> Result<Vec<DiscordApp>> {
        let client = reqwest::Client::builder()
            .user_agent("StreamNook/1.0")
            .timeout(std::time::Duration::from_secs(6))
            .build()?;
        
        let response = client
            .get("https://discord.com/api/v9/applications/detectable")
            .send()
            .await?;
        
        let apps: Vec<DiscordApp> = response.json().await?;
        Ok(apps)
    }

    // --- Start: New Matching Logic Ported from Python ---
    // (These functions are inside the `impl` block,
    //  but they correctly reference the `lazy_static!`
    //  vars defined at the module level)
    
    /// Normalize string for comparison (Python's _norm)
    fn norm(s: &str) -> String {
        s.trim().to_lowercase()
    }

    /// Clean game name by removing common suffixes/prefixes
    fn clean_game_name(name: &str) -> String {
        if name.is_empty() {
            return String::new();
        }
        
        let mut cleaned = name.to_string();
        
        // Remove trademark symbols first (they aren't in the patterns)
        cleaned = CLEAN_PATTERNS[0].replace_all(&cleaned, "").to_string();
        
        // Remove other patterns
        for pattern in CLEAN_PATTERNS.iter().skip(1) {
            cleaned = pattern.replace_all(&cleaned, " ").to_string();
        }
        
        // Re-join whitespace and normalize
        Self::norm(&cleaned.split_whitespace().collect::<Vec<_>>().join(" "))
    }

    /// Calculate similarity score (Python's _similarity_score)
    fn similarity_score(s1: &str, s2: &str) -> f64 {
        let _score = normalized_levenshtein(s1, s2);
        _score
    }

    /// Extract the core game name (first part before colon or dash)
    fn extract_core_name(name: &str) -> String {
        for sep in [':', '–', '—', '-'] { // Added missing '-' from python ' - '
            if let Some((before, _)) = name.split_once(sep) {
                return before.trim().to_string();
            }
        }
        name.trim().to_string()
    }

    /// Create a set of tokens from a game name
    fn tokenize(name: &str) -> HashSet<String> {
        Self::norm(name)
            .split_whitespace()
            .map(String::from)
            .filter(|token| !STOP_WORDS.contains(token.as_str()))
            .collect()
    }

    /// The new match_game, which implements the Python logic
    fn match_game(apps: &[DiscordApp], game_name: &str, threshold: f64) -> Option<DiscordApp> {
        if game_name.is_empty() {
            return None;
        }

        // Pre-calculate for the input game_name
        let g_norm = Self::norm(game_name);
        let g_clean = Self::clean_game_name(game_name);
        let g_core = Self::norm(&Self::extract_core_name(game_name));
        let g_tokens = Self::tokenize(game_name);
        
        let mut best_match: Option<DiscordApp> = None;
        let mut best_score = 0.0;

        for app in apps {
            let app_name = &app.name;
            if app_name.is_empty() {
                continue;
            }

            let mut names_to_check = vec![app_name.clone()];
            names_to_check.extend(app.aliases.clone());
            
            for check_name in names_to_check {
                let mut score = 0.0;
                
                let cn_norm = Self::norm(&check_name);
                let cn_clean = Self::clean_game_name(&check_name);
                let cn_core = Self::norm(&Self::extract_core_name(&check_name));
                let cn_tokens = Self::tokenize(&check_name);

                // Start scoring cascade, just like the Python script
                if g_norm == cn_norm {
                    score = 1.0;
                } else if g_clean == cn_clean {
                    score = 0.95;
                } else if !g_core.is_empty() && !cn_core.is_empty() && g_core == cn_core {
                    score = 0.9;
                } else if g_norm.contains(&cn_norm) || cn_norm.contains(&g_norm) {
                    let overlap_len = g_norm.len().min(cn_norm.len()) as f64;
                    let max_len = g_norm.len().max(cn_norm.len()) as f64;
                    score = 0.8 + (0.1 * overlap_len / max_len);
                } else {
                    let sim_norm = Self::similarity_score(&g_norm, &cn_norm);
                    let sim_clean = Self::similarity_score(&g_clean, &cn_clean);
                    let sim_core = if !g_core.is_empty() && !cn_core.is_empty() {
                        Self::similarity_score(&g_core, &cn_core)
                    } else { 0.0 };
                    
                    score = sim_norm.max(sim_clean).max(sim_core);
                }
                
                // Token-based score boost
                if !g_tokens.is_empty() && !cn_tokens.is_empty() {
                    let common_tokens = g_tokens.intersection(&cn_tokens).count() as f64;
                    if common_tokens > 0.0 {
                        let token_score = common_tokens / (g_tokens.len().max(cn_tokens.len()) as f64);
                        score = score.max(token_score * 0.85);
                    }
                }
                
                if score > best_score && score >= threshold {
                    best_score = score;
                    best_match = Some(app.clone());
                }
                
                // Perfect match, stop early
                if best_score == 1.0 {
                    return best_match;
                }
            }
        }
        
        best_match
    }
    
    // --- End: New Matching Logic ---
    
} // End impl DiscordService
