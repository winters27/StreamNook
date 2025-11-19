#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as TokioMutex;
use tauri::{Builder, Manager};
use commands::{app::*, badges::*, badgebase::*, twitch::*, streaming::*, chat::*, discord::*, settings::*, cache::*, drops::*, universal_cache::*};
use models::settings::{Settings, AppState};
use services::drops_service::DropsService;
use services::cache_service;
use services::live_notification_service::LiveNotificationService;

mod commands;
mod models;
mod services;
mod utils;

/// Load settings from the custom location in the same directory as cache
fn load_settings_from_file() -> Result<Settings, Box<dyn std::error::Error>> {
    let app_dir = cache_service::get_app_data_dir()?;
    let settings_path = app_dir.join("settings.json");
    
    if !settings_path.exists() {
        return Ok(Settings::default());
    }
    
    let json = std::fs::read_to_string(&settings_path)?;
    let settings: Settings = serde_json::from_str(&json)?;
    Ok(settings)
}

fn main() {
    // Load settings from our custom location in the same directory as cache
    let settings = load_settings_from_file().unwrap_or_else(|_| Settings::default());
    
    // Initialize application state (not wrapped in Arc yet)
    let app_state = AppState {
        settings: Arc::new(Mutex::new(settings)),
        drops_service: Arc::new(TokioMutex::new(DropsService::new())),
    };

    // Initialize live notification service
    let live_notification_service = Arc::new(LiveNotificationService::new());

    Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .manage(live_notification_service.clone())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let app_state_handle = app.state::<AppState>();
            let live_notif_service = live_notification_service.clone();
            
            // Create Arc wrapper for the service
            let app_state_arc = Arc::new(AppState {
                settings: app_state_handle.settings.clone(),
                drops_service: app_state_handle.drops_service.clone(),
            });
            
            // Start live notification service
            tauri::async_runtime::spawn(async move {
                if let Err(e) = live_notif_service.start(app_handle, app_state_arc).await {
                    eprintln!("Failed to start live notification service: {}", e);
                }
            });
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // App commands
            get_app_version,
            get_app_name,
            get_app_description,
            get_app_authors,
            // Twitch commands
            twitch_login,
            twitch_start_device_login,
            twitch_complete_device_login,
            twitch_logout,
        get_followed_streams,
        get_channel_info,
        get_user_info,
        get_recommended_streams,
        get_recommended_streams_paginated,
        open_browser_url,
        focus_window,
        get_top_games,
        get_streams_by_game,
        search_channels,
        get_user_by_id,
        follow_channel,
        unfollow_channel,
        check_following_status,
            // Streaming commands
            start_stream,
            stop_stream,
            get_stream_qualities,
            // Chat commands
            start_chat,
            stop_chat,
            send_chat_message,
            // Discord commands
            connect_discord,
            disconnect_discord,
            set_idle_discord_presence,
            update_discord_presence,
            clear_discord_presence,
            // Settings commands
            load_settings,
            save_settings,
            download_streamlink_installer,
            verify_streamlink_installation,
            get_installed_streamlink_version,
            get_latest_streamlink_version,
            get_installed_ttvlol_version,
            get_latest_ttvlol_version,
            download_and_install_ttvlol_plugin,
            // Badge commands
            fetch_global_badges,
            fetch_channel_badges,
            get_twitch_credentials,
            get_user_badges,
            // BadgeBase commands
            fetch_badgebase_info,
            // Cache commands
            save_emote_by_id,
            load_emote_by_id,
            save_emotes_to_cache,
            load_emotes_from_cache,
            save_badges_to_cache,
            load_badges_from_cache,
            clear_cache,
            get_cache_statistics,
            save_favorite_emotes_cache,
            load_favorite_emotes_cache,
            add_favorite_emote_cache,
            remove_favorite_emote_cache,
            // Universal Cache commands
            get_universal_cached_item,
            save_universal_cached_item,
            sync_universal_cache_data,
            cleanup_universal_cache,
            clear_all_universal_cache,
            get_universal_cache_statistics,
            // Drops commands
            get_drops_settings,
            update_drops_settings,
            get_active_drop_campaigns,
            get_drop_progress,
            claim_drop,
            check_channel_points,
            claim_channel_points,
            get_drops_statistics,
            get_claimed_drops,
            get_channel_points_history,
            get_channel_points_balance,
            start_drops_monitoring,
            stop_drops_monitoring,
            update_monitoring_channel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
