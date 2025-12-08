use crate::services::background_service::BackgroundService;
use crate::services::drops_service::DropsService;
use crate::services::layout_service::LayoutService;
use crate::services::mining_service::MiningService;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as TokioMutex;

#[derive(Serialize, Deserialize, Clone)]
pub struct VideoPlayerSettings {
    pub low_latency_mode: bool,
    pub max_buffer_length: u32,
    pub autoplay: bool,
    pub muted: bool,
    pub volume: f32,
    pub start_quality: i32,
    pub lock_aspect_ratio: bool,
}

impl Default for VideoPlayerSettings {
    fn default() -> Self {
        Self {
            low_latency_mode: false,
            max_buffer_length: 120,
            autoplay: true,
            muted: false,
            volume: 1.0,
            start_quality: -1,
            lock_aspect_ratio: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CacheSettings {
    pub enabled: bool,
    pub expiry_days: u32,
}

impl Default for CacheSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            expiry_days: 7,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TtvlolPluginSettings {
    pub enabled: bool,
    pub installed_version: Option<String>,
}

impl Default for TtvlolPluginSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            installed_version: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct StreamlinkSettings {
    pub low_latency_enabled: bool,
    pub hls_live_edge: u32,     // Segments from live edge (1-10)
    pub stream_timeout: u32,    // Timeout in seconds (30-120)
    pub retry_streams: u32,     // Auto-retry on errors (0-5)
    pub disable_hosting: bool,  // Avoid hosted streams
    pub skip_ssl_verify: bool,  // Skip SSL verification
    pub use_proxy: bool,        // Use proxy servers
    pub proxy_playlist: String, // Proxy playlist URLs
    #[serde(default)]
    pub custom_streamlink_path: Option<String>, // Custom folder path for portable/installed Streamlink
}

impl Default for StreamlinkSettings {
    fn default() -> Self {
        Self {
            low_latency_enabled: true,
            hls_live_edge: 3,
            stream_timeout: 60,
            retry_streams: 3,
            disable_hosting: true,
            skip_ssl_verify: false,
            use_proxy: true,
            proxy_playlist: "--twitch-proxy-playlist=https://lb-na.cdn-perfprod.com,https://eu.luminous.dev --twitch-proxy-playlist-fallback".to_string(),
            custom_streamlink_path: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatDesignSettings {
    pub show_dividers: bool,
    pub alternating_backgrounds: bool,
    pub message_spacing: u32,    // 0-20 pixels
    pub font_size: u32,          // 10-20 pixels
    pub font_weight: u32,        // 300-700
    pub mention_color: String,   // Hex color for @ mentions
    pub reply_color: String,     // Hex color for reply threads
    pub mention_animation: bool, // Enable red-shift animation for mentions
    #[serde(default)]
    pub show_timestamps: bool, // Show timestamp next to each message
    #[serde(default)]
    pub show_timestamp_seconds: bool, // Include seconds in timestamps
}

impl Default for ChatDesignSettings {
    fn default() -> Self {
        Self {
            show_dividers: false,
            alternating_backgrounds: false,
            message_spacing: 16,
            font_size: 18,
            font_weight: 400,
            mention_color: "#ff4444".to_string(),
            reply_color: "#ff6b6b".to_string(),
            mention_animation: true,
            show_timestamps: false,
            show_timestamp_seconds: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LiveNotificationSettings {
    pub enabled: bool,
    pub play_sound: bool,
    #[serde(default)]
    pub sound_type: Option<String>,
    // Notification type toggles
    #[serde(default = "default_true")]
    pub show_live_notifications: bool,
    #[serde(default = "default_true")]
    pub show_whisper_notifications: bool,
    #[serde(default = "default_true")]
    pub show_update_notifications: bool,
    #[serde(default = "default_true")]
    pub show_drops_notifications: bool,
    #[serde(default = "default_true")]
    pub show_channel_points_notifications: bool,
    #[serde(default = "default_true")]
    pub show_badge_notifications: bool,
    // Notification method toggles (Dynamic Island vs Toast)
    #[serde(default = "default_true")]
    pub use_dynamic_island: bool,
    #[serde(default = "default_true")]
    pub use_toast: bool,
    // Native OS notifications (Windows/macOS)
    #[serde(default)]
    pub use_native_notifications: bool,
    #[serde(default = "default_true")]
    pub native_only_when_unfocused: bool,
    // Quick update: clicking update toast immediately starts update
    #[serde(default)]
    pub quick_update_on_toast: bool,
}

fn default_true() -> bool {
    true
}

impl Default for LiveNotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            play_sound: true,
            sound_type: None,
            show_live_notifications: true,
            show_whisper_notifications: true,
            show_update_notifications: true,
            show_drops_notifications: true,
            show_channel_points_notifications: true,
            show_badge_notifications: true,
            use_dynamic_island: true,
            use_toast: true,
            use_native_notifications: false,
            native_only_when_unfocused: true,
            quick_update_on_toast: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DropsSettings {
    pub auto_claim_drops: bool,
    pub auto_claim_channel_points: bool,
    pub notify_on_drop_available: bool,
    pub notify_on_drop_claimed: bool,
    pub notify_on_points_claimed: bool,
    pub check_interval_seconds: u32,
}

impl Default for DropsSettings {
    fn default() -> Self {
        Self {
            auto_claim_drops: true,
            auto_claim_channel_points: false,
            notify_on_drop_available: true,
            notify_on_drop_claimed: true,
            notify_on_points_claimed: false,
            check_interval_seconds: 60,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "snake_case")]
pub enum AutoSwitchMode {
    #[default]
    SameCategory, // Switch to a stream in the same game/category
    FollowedStreams, // Switch to one of your live followed streamers
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AutoSwitchSettings {
    pub enabled: bool,
    #[serde(default)]
    pub mode: AutoSwitchMode, // What to switch to when stream goes offline
    pub show_notification: bool, // Show toast when auto-switching
}

impl Default for AutoSwitchSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: AutoSwitchMode::SameCategory,
            show_notification: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    pub streamlink_path: String,
    pub streamlink_args: String,
    pub quality: String,
    pub chat_placement: String,
    pub accounts: Vec<String>,
    pub current_account: String,
    pub hide_search_bar_on_startup: bool,
    pub discord_rpc_enabled: bool,
    pub video_player: VideoPlayerSettings,
    pub cache: CacheSettings,
    pub ttvlol_plugin: TtvlolPluginSettings,
    #[serde(default)]
    pub streamlink: StreamlinkSettings,
    #[serde(default)]
    pub drops: DropsSettings,
    #[serde(default)]
    pub favorite_streamers: Vec<String>,
    #[serde(default)]
    pub chat_design: ChatDesignSettings,
    #[serde(default)]
    pub live_notifications: LiveNotificationSettings,
    #[serde(default)]
    pub last_seen_version: Option<String>,
    #[serde(default)]
    pub auto_switch: AutoSwitchSettings,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub setup_complete: bool,
}

fn default_theme() -> String {
    "winters-glass".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            streamlink_path: "C:\\Program Files\\Streamlink\\bin\\streamlinkw.exe".to_string(),
            streamlink_args: "--twitch-proxy-playlist=https://lb-na.cdn-perfprod.com,https://eu.luminous.dev --twitch-proxy-playlist-fallback".to_string(),
            quality: "best".to_string(),
            chat_placement: "right".to_string(),
            accounts: vec![],
            current_account: "".to_string(),
            hide_search_bar_on_startup: true,
            discord_rpc_enabled: true,
            video_player: VideoPlayerSettings::default(),
            cache: CacheSettings::default(),
            ttvlol_plugin: TtvlolPluginSettings {
                enabled: true, // Enable by default since the plugin is already installed
                installed_version: None,
            },
            streamlink: StreamlinkSettings::default(),
            drops: DropsSettings::default(),
            favorite_streamers: vec![],
            chat_design: ChatDesignSettings::default(),
            live_notifications: LiveNotificationSettings::default(),
            last_seen_version: None,
            auto_switch: AutoSwitchSettings::default(),
            theme: default_theme(),
            setup_complete: false, // New users need to complete setup
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<Mutex<Settings>>,
    pub drops_service: Arc<TokioMutex<DropsService>>,
    pub mining_service: Arc<TokioMutex<MiningService>>,
    pub background_service: Arc<TokioMutex<BackgroundService>>,
    pub layout_service: Arc<LayoutService>,
}
