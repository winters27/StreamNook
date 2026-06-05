use crate::services::background_service::BackgroundService;
use crate::services::drops_service::DropsService;
use crate::services::emote_service::EmoteService;
use crate::services::layout_service::LayoutService;
use crate::services::mining_service::MiningService;
use crate::services::twitch_auth_service::TwitchAuthService;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{Mutex as TokioMutex, RwLock};

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
pub struct StreamlinkSettings {
    /// Total budget (seconds) for the native resolver's retry-until-live loop.
    pub stream_timeout: u32,
    /// Delay (seconds) between native resolve attempts (0 = single attempt).
    pub retry_streams: u32,
    #[serde(default = "default_true")]
    pub use_proxy: bool, // Route playlists through the ad-block proxy pool
    pub proxy_playlist: String, // Proxy base URLs (parsed into the resolver's pool)
    /// ID of the last proxy applied (persists through restarts/updates)
    #[serde(default)]
    pub last_applied_proxy_id: Option<String>,
    /// Whether the current proxy was auto-selected (optimizer can override on next launch)
    /// When false, a user manually chose a proxy and the optimizer will respect that choice
    #[serde(default = "default_true")]
    pub proxy_auto_optimized: bool,
    /// Whether proxy optimization has been run at least once (replaces volatile localStorage flag)
    #[serde(default)]
    pub proxy_optimized_once: bool,
    /// Request Twitch's Enhanced Broadcasting variants (h265 + AV1 in addition
    /// to h264) when resolving.
    #[serde(default = "default_true")]
    pub enhanced_codecs: bool,
}

impl Default for StreamlinkSettings {
    fn default() -> Self {
        Self {
            stream_timeout: 60,
            retry_streams: 3,
            use_proxy: true,
            proxy_playlist: "--twitch-proxy-playlist=https://lb-na.cdn-perfprod.com,https://eu.luminous.dev --twitch-proxy-playlist-fallback".to_string(),
            last_applied_proxy_id: None,
            proxy_auto_optimized: true,
            proxy_optimized_once: false,
            enhanced_codecs: true,
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
    // The fields below were added to the TS type over time but were missing here,
    // so they silently failed to persist (serde drops unknown fields on save).
    // Each carries a serde default matching the frontend default so old
    // settings.json files (which lack the field) still load.
    #[serde(default = "default_emote_scale")]
    pub emote_scale: f64, // Inline emote size multiplier (0.5-3)
    #[serde(default = "default_emote_margin")]
    pub emote_margin: f64, // Horizontal margin around emotes, rem
    #[serde(default = "default_emote_hover_size")]
    pub emote_hover_size: u32, // Enlarged emote height in hover preview, px
    #[serde(default = "default_deleted_message_style")]
    pub deleted_message_style: String, // strikethrough | hidden | dimmed | keep
    #[serde(default)]
    pub hide_shared_chat: bool,
    #[serde(default = "default_true")]
    pub paint_mentions_in_body: bool,
    #[serde(default)]
    pub compact_emote_tooltips: bool,
    #[serde(default = "default_true")]
    pub seventv_emote_notices: bool,
    #[serde(default = "default_true")]
    pub link_previews: bool,
    #[serde(default)]
    pub link_preview_keep_link: bool,
    #[serde(default = "default_true")]
    pub shorten_links: bool,
    #[serde(default)]
    pub link_preview_trusted_domains: Vec<String>,
    // Username prefix styling: separator glyph + name emphasis + color source.
    #[serde(default = "default_username_separator")]
    pub username_separator: String, // none | colon | dot | arrow | pipe | dash
    #[serde(default = "default_username_style")]
    pub username_style: String, // plain | bar | chip | brackets | dot
    #[serde(default = "default_username_accent_source")]
    pub username_accent_source: String, // user | theme
    #[serde(default = "default_true")]
    pub drag_moderation_enabled: bool, // deprecated: superseded by mod_action_style
    #[serde(default = "default_mod_action_style")]
    pub mod_action_style: String, // buttons | drag | both
    #[serde(default = "default_mod_drag_layout")]
    pub mod_drag_layout: String, // column | bar
    #[serde(default = "default_pinned_collapsed_style")]
    pub pinned_collapsed_style: String, // bar | hidden
    #[serde(default = "default_mod_pin_style")]
    pub mod_pin_style: String, // inline | drag | both
}

fn default_emote_scale() -> f64 {
    1.0
}
fn default_emote_margin() -> f64 {
    0.125
}
fn default_emote_hover_size() -> u32 {
    96
}
fn default_deleted_message_style() -> String {
    "strikethrough".to_string()
}
fn default_username_separator() -> String {
    "none".to_string()
}
fn default_username_style() -> String {
    "plain".to_string()
}
fn default_username_accent_source() -> String {
    "user".to_string()
}
fn default_mod_action_style() -> String {
    "both".to_string()
}
fn default_mod_drag_layout() -> String {
    "column".to_string()
}
fn default_pinned_collapsed_style() -> String {
    "bar".to_string()
}
fn default_mod_pin_style() -> String {
    "both".to_string()
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
            emote_scale: 1.0,
            emote_margin: 0.125,
            emote_hover_size: 96,
            deleted_message_style: "strikethrough".to_string(),
            hide_shared_chat: false,
            paint_mentions_in_body: true,
            compact_emote_tooltips: false,
            seventv_emote_notices: true,
            link_previews: true,
            link_preview_keep_link: false,
            shorten_links: true,
            link_preview_trusted_domains: Vec::new(),
            username_separator: "none".to_string(),
            username_style: "plain".to_string(),
            username_accent_source: "user".to_string(),
            drag_moderation_enabled: true,
            mod_action_style: "both".to_string(),
            mod_drag_layout: "column".to_string(),
            pinned_collapsed_style: "bar".to_string(),
            mod_pin_style: "both".to_string(),
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
    pub show_favorite_drops_notifications: bool,
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
            show_favorite_drops_notifications: true,
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

// Re-export DropsSettings from the drops module to avoid duplication
// The drops module has the complete struct with mining fields (priority_games, etc.)
pub use crate::models::drops::DropsSettings;

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
    #[serde(default = "default_true")]
    pub auto_redirect_on_raid: bool, // Automatically follow raids to the target channel
}

impl Default for AutoSwitchSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: AutoSwitchMode::SameCategory,
            show_notification: true,
            auto_redirect_on_raid: true, // Enabled by default
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CompactViewPreset {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    #[serde(rename = "isBuiltIn")]
    pub is_built_in: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct CompactViewSettings {
    #[serde(rename = "selectedPresetId")]
    pub selected_preset_id: String,
    #[serde(rename = "customPresets", default)]
    pub custom_presets: Vec<CompactViewPreset>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MultiNookSlot {
    pub id: String,
    pub channel_login: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    pub volume: f32,
    pub muted: bool,
    pub is_focused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_minimized: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    pub quality: String,
    pub chat_placement: String,
    pub accounts: Vec<String>,
    pub current_account: String,
    pub hide_search_bar_on_startup: bool,
    pub discord_rpc_enabled: bool,
    pub video_player: VideoPlayerSettings,
    pub cache: CacheSettings,
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
    /// Interface font id (see FONT_OPTIONS on the frontend). Persisted so the
    /// chosen font survives restarts; None falls back to the default font.
    #[serde(default)]
    pub font: Option<String>,
    /// Global glassiness, 0-100. Persisted so the slider survives restarts;
    /// None falls back to the default (100) on the frontend.
    #[serde(default)]
    pub glass_transparency: Option<u32>,
    #[serde(default)]
    pub setup_complete: bool,
    #[serde(default)]
    pub compact_view: Option<CompactViewSettings>,
    /// Whether diagnostic logging is enabled (defaults to true)
    #[serde(default = "default_true")]
    pub error_reporting_enabled: bool,
    /// Persisted multi-stream grid configurations
    #[serde(default)]
    pub multi_nook_slots: Vec<MultiNookSlot>,
    #[serde(default)]
    pub multi_nook_chat_hidden: bool,
    /// Whether the Moderator Logs pane is shown. Persisted so it survives app
    /// restarts and settings reloads instead of resetting to off each session.
    #[serde(default)]
    pub show_mod_logs: bool,
    /// Customizable keyboard shortcut overrides. Maps a bindable-command id to
    /// its user-assigned chord strings. Absent ids fall back to code defaults.
    #[serde(default)]
    pub keybindings: HashMap<String, Vec<String>>,
    /// Catch-all for preference groups the frontend manages but this struct does
    /// not model field-by-field: highlight phrases, custom chat commands,
    /// moderation prefs, custom themes, the OLED accent, and any future ones.
    /// Without this, serde silently drops every key it doesn't recognize on save,
    /// so those settings never reached settings.json and reset on each restart.
    /// Flattening round-trips them verbatim, so the full frontend Settings shape
    /// persists across restarts and travels intact in exported backups.
    #[serde(flatten, default)]
    pub extra: HashMap<String, serde_json::Value>,
}

fn default_theme() -> String {
    "winters-glass".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            quality: "best".to_string(),
            chat_placement: "right".to_string(),
            accounts: vec![],
            current_account: "".to_string(),
            hide_search_bar_on_startup: true,
            discord_rpc_enabled: true,
            video_player: VideoPlayerSettings::default(),
            cache: CacheSettings::default(),
            streamlink: StreamlinkSettings::default(),
            drops: DropsSettings::default(),
            favorite_streamers: vec![],
            chat_design: ChatDesignSettings::default(),
            live_notifications: LiveNotificationSettings::default(),
            last_seen_version: None,
            auto_switch: AutoSwitchSettings::default(),
            theme: default_theme(),
            font: None,
            glass_transparency: None,
            setup_complete: false, // New users need to complete setup
            compact_view: None,
            error_reporting_enabled: true, // Diagnostics enabled by default
            multi_nook_slots: Vec::new(),
            multi_nook_chat_hidden: false,
            show_mod_logs: false,
            keybindings: HashMap::new(),
            extra: HashMap::new(),
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
    pub emote_service: Arc<RwLock<EmoteService>>,
    /// Single owner of the Twitch web auth cookie. All code that previously
    /// scraped the cookie via `webview_cookie::read_twitch_web_auth_token`
    /// goes through this service instead.
    pub twitch_auth: TwitchAuthService,
}

#[cfg(test)]
mod backup_persistence_tests {
    use super::*;

    /// Frontend-managed preference groups the struct doesn't model (highlight
    /// phrases, custom themes, the OLED accent, ...) must survive a save/load
    /// round-trip through the flattened `extra` map instead of being dropped,
    /// and must serialize back at the top level (not nested under "extra").
    #[test]
    fn unknown_keys_round_trip_through_extra() {
        let mut value = serde_json::to_value(Settings::default()).expect("serialize defaults");
        let obj = value.as_object_mut().expect("settings is an object");
        obj.insert(
            "chat_highlights".into(),
            serde_json::json!({ "phrases": ["raid", "gifted"] }),
        );
        obj.insert("oled_accent".into(), serde_json::json!("#ff9933"));

        let parsed: Settings = serde_json::from_value(value).expect("deserialize with extras");
        assert!(parsed.extra.contains_key("chat_highlights"));
        assert_eq!(
            parsed.extra.get("oled_accent").and_then(|v| v.as_str()),
            Some("#ff9933")
        );

        let reserialized = serde_json::to_value(&parsed).expect("serialize back");
        let out = reserialized.as_object().expect("object");
        assert!(out.contains_key("chat_highlights"));
        assert!(out.contains_key("oled_accent"));
        assert!(!out.contains_key("extra"));
    }

    /// A full settings dump with no unrecognized keys round-trips with an empty
    /// catch-all and emits no stray "extra" wrapper key (backward compatible).
    #[test]
    fn default_settings_round_trip_with_empty_extra() {
        let original = Settings::default();
        let json = serde_json::to_string(&original).expect("serialize");
        assert!(!json.contains("\"extra\""));

        let parsed: Settings = serde_json::from_str(&json).expect("deserialize");
        assert!(parsed.extra.is_empty());
        assert_eq!(parsed.theme, original.theme);
    }
}
