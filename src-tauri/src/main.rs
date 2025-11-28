#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
// Suppress clippy warnings for this release - these are style issues, not bugs
#![allow(dead_code)]
#![allow(unused_imports)]
#![allow(unused_variables)]
#![allow(deprecated)]
#![allow(clippy::collapsible_if)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::needless_return)]
#![allow(clippy::ptr_arg)]
#![allow(clippy::type_complexity)]
#![allow(clippy::redundant_closure)]
#![allow(clippy::manual_map)]
#![allow(clippy::let_and_return)]
#![allow(clippy::single_match)]
#![allow(clippy::derivable_impls)]
#![allow(clippy::needless_borrow)]
#![allow(clippy::manual_div_ceil)]
#![allow(clippy::unwrap_or_default)]
#![allow(unused_mut)]
#![allow(unused_assignments)]
#![allow(clippy::needless_borrows_for_generic_args)]
#![allow(clippy::manual_flatten)]
#![allow(clippy::collapsible_match)]

use commands::{
    app::*, badge_metadata::*, badges::*, cache::*, chat::*, cosmetics_cache::*, discord::*,
    drops::*, settings::*, streaming::*, twitch::*, universal_cache::*,
};
use models::settings::{AppState, Settings};
use services::background_service::BackgroundService;
use services::cache_service;
use services::drops_service::DropsService;
use services::live_notification_service::LiveNotificationService;
use services::mining_service::MiningService;
use std::sync::{Arc, Mutex};
use tauri::{Builder, Manager};
use tokio::sync::Mutex as TokioMutex;

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

/// Clean up leftover files from previous update attempts
fn cleanup_update_artifacts() {
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            // Remove leftover StreamNook_new.exe if it exists
            let temp_exe = exe_dir.join("StreamNook_new.exe");
            if temp_exe.exists() {
                println!("[Main] Cleaning up leftover update file: {:?}", temp_exe);
                let _ = std::fs::remove_file(&temp_exe);
            }

            // Remove leftover update batch script if it exists
            let batch_file = exe_dir.join("update_streamnook.bat");
            if batch_file.exists() {
                println!("[Main] Cleaning up leftover batch file: {:?}", batch_file);
                let _ = std::fs::remove_file(&batch_file);
            }
        }
    }
}

fn main() {
    // Clean up any leftover files from previous update attempts
    cleanup_update_artifacts();

    // Load settings from our custom location in the same directory as cache
    let settings = load_settings_from_file().unwrap_or_else(|_| Settings::default());

    // Initialize drops service
    let drops_service = Arc::new(TokioMutex::new(DropsService::new()));

    // Initialize mining service with drops service reference
    let mining_service = Arc::new(TokioMutex::new(MiningService::new(drops_service.clone())));

    let settings_arc = Arc::new(Mutex::new(settings));

    // Initialize live notification service
    let live_notification_service = Arc::new(LiveNotificationService::new());

    Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(live_notification_service.clone())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let live_notif_service = live_notification_service.clone();

            // Create and manage the background service correctly within the setup hook
            let background_service = Arc::new(TokioMutex::new(BackgroundService::new(
                Arc::new(tokio::sync::RwLock::new(settings_arc.lock().unwrap().clone())),
                app_handle.clone(),
                drops_service.clone(),
            )));

            let app_state = AppState {
                settings: settings_arc,
                drops_service,
                mining_service,
                background_service: background_service.clone(),
            };

            // Clone the app_state before managing it
            let app_state_for_live_notif = app_state.clone();

            // Manage AppState directly, not wrapped in Arc
            app.manage(app_state);

            // Start background service
            tauri::async_runtime::spawn(async move {
                background_service.lock().await.start().await;
            });

            // Start live notification service
            let live_app_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = live_notif_service.start(live_app_handle, app_state_for_live_notif).await {
                    eprintln!("Failed to start live notification service: {}", e);
                }
            });

            // Verify token health on startup (proactively refresh if needed)
            tauri::async_runtime::spawn(async {
                use services::twitch_service::TwitchService;

                println!("[Main] Starting token health verification...");

                // Wait a moment to let the app fully initialize
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

                match TwitchService::verify_token_health().await {
                    Ok(status) => {
                        if status.is_valid {
                            println!(
                                "[Main] ✅ Token health check passed: {}h {}m remaining",
                                status.hours_remaining, status.minutes_remaining
                            );
                            if status.needs_refresh {
                                println!("[Main] ⚠️ Token expires soon, but will auto-refresh on next API call");
                            }
                        } else {
                            println!(
                                "[Main] ❌ Token health check failed: {:?}",
                                status.error.unwrap_or_else(|| "Unknown error".to_string())
                            );
                        }
                    }
                    Err(e) => {
                        println!("[Main] ❌ Token health verification error: {}", e);
                    }
                }
            });

            // Pre-fetch badges in the background
            tauri::async_runtime::spawn(async move {
                use services::twitch_service::TwitchService;
                use commands::badges::fetch_global_badges;

                println!("[Main] Starting background badge pre-fetch...");

                // Wait a few seconds to let the app fully initialize (after token health check)
                tokio::time::sleep(tokio::time::Duration::from_secs(4)).await;

                match TwitchService::get_token().await {
                    Ok(token) => {
                        let client_id = "1qgws7yzcp21g5ledlzffw3lmqdvie".to_string();
                        match fetch_global_badges(client_id, token).await {
                            Ok(badges) => {
                                println!("[Main] Background badge pre-fetch complete: {} badge sets cached", badges.data.len());
                            }
                            Err(e) => {
                                println!("[Main] Background badge pre-fetch failed: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        println!("[Main] Failed to get token for background badge pre-fetch: {}", e);
                    }
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
            get_window_size,
            calculate_aspect_ratio_size,
            // Twitch commands
            twitch_login,
            twitch_start_device_login,
            twitch_complete_device_login,
            twitch_logout,
            has_stored_credentials,
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
        verify_token_health,
        force_refresh_token,
        check_stream_online,
        get_streams_by_game_name,
            // Streaming commands
            start_stream,
            stop_stream,
            get_stream_qualities,
            change_stream_quality,
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
            get_current_app_version,
            get_latest_app_version,
            download_and_install_app_update,
            get_latest_ttvlol_version,
            download_and_install_ttvlol_plugin,
            get_release_notes,
            // Badge commands
            fetch_global_badges,
            get_cached_global_badges,
            prefetch_global_badges,
            force_refresh_global_badges,
            get_badge_cache_age,
            get_badges_missing_metadata,
            debug_list_twitch_badges,
            debug_compare_badge_sources,
            fetch_channel_badges,
            get_twitch_credentials,
            get_user_badges,
            // Badge Metadata commands
            fetch_badge_metadata,
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
            assign_badge_positions,
            export_manifest,
            // Cosmetics Cache commands
            cache_user_cosmetics,
            get_cached_user_cosmetics,
            cache_third_party_badges,
            get_cached_third_party_badges,
            prefetch_user_cosmetics,
            // Drops commands
            get_drops_settings,
            update_drops_settings,
            get_active_drop_campaigns,
            get_drops_inventory,
            get_drop_progress,
            claim_drop,
            check_channel_points,
            claim_channel_points,
            get_drops_statistics,
            get_claimed_drops,
            get_channel_points_history,
            get_channel_points_balance,
            get_all_channel_points_balances,
            start_drops_monitoring,
            stop_drops_monitoring,
            update_monitoring_channel,
            // Mining commands
            start_auto_mining,
            start_campaign_mining,
            get_eligible_channels_for_campaign,
            start_campaign_mining_with_channel,
            stop_auto_mining,
            get_mining_status,
            is_auto_mining,
            // Drops Authentication commands
            start_drops_device_flow,
            poll_drops_token,
            drops_logout,
            is_drops_authenticated,
            validate_drops_token,
            open_drop_details
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
