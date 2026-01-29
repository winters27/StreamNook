#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
// Suppress clippy warnings for this release - these are style issues, not bugs!
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
    app::*, automation::*, badge_metadata::*, badge_service::*, badges::*, bandwidth_test::*,
    cache::*, chat::*, chat_identity::*, components::*, cosmetics_cache::*, diagnostic_logging::*,
    discord::*, drops::*, emoji::*, emotes::*, eventsub::*, hype_train::*, layout::*, logs::*,
    profile_cache::*, resub::*, settings::*, seventv::*, seventv_cosmetics::*,
    seventv_cosmetics_fetch::*, streaming::*, twitch::*, universal_cache::*, user_profile::*,
    whisper_storage::*,
};
use log::{debug, error};
use models::settings::{AppState, Settings};
use services::background_service::BackgroundService;
use services::badge_polling_service::BadgePollingService;
use services::cache_service;
use services::drops_service::DropsService;
use services::live_notification_service::LiveNotificationService;
use services::mining_service::MiningService;
use services::whisper_service::WhisperService;
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
                debug!("[Main] Cleaning up leftover update file: {:?}", temp_exe);
                let _ = std::fs::remove_file(&temp_exe);
            }

            // Remove leftover update batch script if it exists
            let batch_file = exe_dir.join("update_streamnook.bat");
            if batch_file.exists() {
                debug!("[Main] Cleaning up leftover batch file: {:?}", batch_file);
                let _ = std::fs::remove_file(&batch_file);
            }
        }
    }
}

fn main() {
    // Initialize the logging system FIRST so all debug!/error! macros work
    services::diagnostic_logger::init_logging();

    // Clean up any leftover files from previous update attempts
    cleanup_update_artifacts();

    // Migrate emote cache if app version changed (handles format changes like webp → avif)
    // This clears stale emote files that may have the old format
    let current_version = env!("CARGO_PKG_VERSION");
    match services::universal_cache_service::migrate_emote_cache_on_version_change(current_version)
    {
        Ok(migrated) => {
            if migrated {
                debug!("[Main] ✅ Emote cache migrated for new version");
            }
        }
        Err(e) => {
            error!("[Main] Failed to migrate emote cache: {}", e);
        }
    }

    // Load settings from our custom location in the same directory as cache
    let settings = load_settings_from_file().unwrap_or_else(|_| Settings::default());

    // Apply persisted diagnostic logging setting immediately after loading settings
    services::diagnostic_logger::set_diagnostics_enabled(settings.error_reporting_enabled);

    // Initialize drops service with persisted settings (including priority_games for favorites)
    let drops_service = Arc::new(TokioMutex::new(DropsService::new_with_settings(
        settings.drops.clone(),
    )));

    // Initialize mining service with drops service reference
    let mining_service = Arc::new(TokioMutex::new(MiningService::new(drops_service.clone())));

    let settings_arc = Arc::new(Mutex::new(settings));

    // Initialize live notification service
    let live_notification_service = Arc::new(LiveNotificationService::new());

    // Initialize whisper service
    let whisper_service = Arc::new(TokioMutex::new(WhisperService::new()));

    // Initialize layout service
    let layout_service = Arc::new(services::layout_service::LayoutService::new());

    // Initialize emote service
    let emote_service = Arc::new(tokio::sync::RwLock::new(
        services::emote_service::EmoteService::new(),
    ));
    let emote_service_state = commands::emotes::EmoteServiceState(emote_service.clone());

    // Initialize EventSub service
    let eventsub_service = Arc::new(tokio::sync::RwLock::new(
        services::eventsub_service::EventSubService::new(),
    ));
    let eventsub_service_state = commands::eventsub::EventSubServiceState(eventsub_service.clone());

    Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(live_notification_service.clone())
        .manage(whisper_service.clone())
        .manage(layout_service.clone())
        .manage(emote_service_state)
        .manage(eventsub_service_state)
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
                layout_service: layout_service.clone(),
                emote_service: emote_service.clone(),
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
            let app_state_for_live_notif_clone = app_state_for_live_notif.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = live_notif_service.start(live_app_handle, app_state_for_live_notif_clone).await {
                    error!("Failed to start live notification service: {}", e);
                }
            });

            // Start badge polling service
            let badge_polling_service = Arc::new(BadgePollingService::new());
            let badge_app_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                badge_polling_service.start(badge_app_handle, app_state_for_live_notif).await;
            });

            // Verify token health on startup and auto-start dashboard for admins
            let admin_app_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                use services::twitch_service::TwitchService;

                debug!("[Main] Starting token health verification...");

                // Wait a moment to let the app fully initialize
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

                match TwitchService::verify_token_health().await {
                    Ok(status) => {
                        if status.is_valid {
                            debug!(
                                "[Main] ✅ Token health check passed: {}h {}m remaining",
                                status.hours_remaining, status.minutes_remaining
                            );
                            if status.needs_refresh {
                                debug!("[Main] ⚠️ Token expires soon, but will auto-refresh on next API call");
                            }

                            // Auto-start analytics dashboard for admin users
                            debug!("[Main] Checking if user is admin for dashboard auto-start...");
                            match auto_start_dashboard_for_admin(admin_app_handle).await {
                                Ok(started) => {
                                    if started {
                                        debug!("[Main] ✅ Analytics dashboard auto-started for admin user");
                                    } else {
                                        debug!("[Main] Dashboard not auto-started (not admin or not available)");
                                    }
                                }
                                Err(e) => {
                                    debug!("[Main] Failed to auto-start dashboard: {}", e);
                                }
                            }
                        } else {
                            debug!(
                                "[Main] ❌ Token health check failed: {:?}",
                                status.error.unwrap_or_else(|| "Unknown error".to_string())
                            );
                        }
                    }
                    Err(e) => {
                        debug!("[Main] ❌ Token health verification error: {}", e);
                    }
                }
            });

            // Pre-fetch badges in the background
            tauri::async_runtime::spawn(async move {
                use services::twitch_service::TwitchService;
                use commands::badges::fetch_global_badges;

                debug!("[Main] Starting background badge pre-fetch...");

                // Wait a few seconds to let the app fully initialize (after token health check)
                tokio::time::sleep(tokio::time::Duration::from_secs(4)).await;

                match TwitchService::get_token().await {
                    Ok(token) => {
                        let client_id = "1qgws7yzcp21g5ledlzffw3lmqdvie".to_string();
                        match fetch_global_badges(client_id, token).await {
                            Ok(badges) => {
                                debug!("[Main] Background badge pre-fetch complete: {} badge sets cached", badges.data.len());
                            }
                            Err(e) => {
                                debug!("[Main] Background badge pre-fetch failed: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        debug!("[Main] Failed to get token for background badge pre-fetch: {}", e);
                    }
                }
            });

            // Initialize unified badge service
            tauri::async_runtime::spawn(async move {
                use commands::badge_service::initialize_badge_service;

                debug!("[Main] Initializing unified badge service...");

                // Wait a moment for token to be available
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

                initialize_badge_service().await;
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
            calculate_aspect_ratio_size_preserve_video,
            get_system_info,
            start_analytics_dashboard,
            is_dev_environment,
            is_admin_user,
            check_dashboard_available,
            is_dashboard_running,
            auto_start_dashboard_for_admin,
            get_emoji_image,
            // Twitch commands
            twitch_login,
            twitch_start_device_login,
            twitch_complete_device_login,
            twitch_logout,
            clear_webview_data,
            has_stored_credentials,
            get_followed_streams,
            get_channel_info,
            get_user_info,
            get_recommended_streams,
            get_recommended_streams_paginated,
            open_browser_url,
            focus_window,
            get_top_games,
            get_top_games_paginated,
            get_streams_by_game,
            search_channels,
            search_categories,
            get_user_by_id,
            get_user_by_login,
            follow_channel,
            unfollow_channel,
            check_following_status,
            verify_token_health,
            force_refresh_token,
            get_twitch_token,
            check_stream_online,
            get_streams_by_game_name,
            send_whisper,
            start_whisper_listener,
            get_whisper_history,
            search_whisper_user,
            import_all_whisper_history,
            // Streaming commands
            start_stream,
            stop_stream,
            get_stream_qualities,
            change_stream_quality,
            get_streamlink_diagnostics,
            is_streamlink_available,
            // Chat commands
            start_chat,
            stop_chat,
            send_chat_message,
            parse_historical_messages,
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
            send_test_notification,
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
            // Unified Badge Service commands
            get_user_badges_unified,
            get_user_badges_with_earned_unified,
            parse_badge_string,
            prefetch_global_badges_unified,
            prefetch_channel_badges_unified,
            prefetch_third_party_badges,
            clear_badge_cache_unified,
            clear_channel_badge_cache_unified,
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
            download_and_cache_file,
            get_cached_file,
            get_cached_files,
            get_all_universal_cached_items,
            get_universal_cached_items_batch,
            auto_sync_universal_cache_if_stale,

            // Cosmetics Cache commands
            cache_user_cosmetics,
            get_cached_user_cosmetics,
            cache_third_party_badges,
            get_cached_third_party_badges,
            prefetch_user_cosmetics,
            // Profile Cache commands
            get_user_profile,
            refresh_user_profile,
            clear_profile_cache,
            preload_badge_databases,
            // User Profile commands (unified aggregation)
            get_user_profile_complete,
            clear_user_profile_cache,
            clear_user_profile_cache_for_user,
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
            open_drop_details,
            // Prediction commands
            place_prediction,
            get_active_prediction,
            get_channel_points_for_channel,
            // Watch token allocation commands
            set_reserved_channel,
            get_reserved_channel,
            // Channel Points Rewards commands
            get_channel_rewards,
            redeem_channel_reward,
            send_highlighted_message,
            unlock_random_emote,
            get_modifiable_emotes,
            unlock_modified_emote,
            unlock_chosen_emote,
            // Component commands
            check_components_installed,
            get_bundled_streamlink_path,
            get_local_component_versions,
            get_remote_component_versions,
            check_for_bundle_update,
            extract_bundled_components,
            extract_bundled_components,
            download_and_install_bundle,
            // Layout commands (message history only - height calculation removed)
            get_user_message_history,
            get_user_message_history_limited,
            clear_user_message_history,
            get_user_history_count,
            // Emoji commands
            convert_emoji_shortcodes,
            // Emote commands
            fetch_channel_emotes,
            get_emote_by_name,
            clear_emote_cache,
            // 7TV commands
            seventv_graphql,
            // 7TV Cosmetics commands
            get_seventv_auth_status,
            get_seventv_login_url,
            store_seventv_token,
            validate_seventv_token,
            logout_seventv,
            set_seventv_paint,
            set_seventv_badge,
            open_seventv_login_window,
            receive_seventv_token,
            // 7TV Global Cosmetics commands
            get_all_seventv_badges,
            get_all_seventv_paints,
            // Automation commands
            automate_connection,
            scrape_whispers,
            receive_whisper_export,
            emit_whisper_progress,
            // Whisper Storage commands
            load_whisper_storage,
            save_whisper_storage,
            save_whisper_conversation,
            append_whisper_message,
            delete_whisper_conversation,
            get_whisper_storage_path,
            migrate_whispers_from_localstorage,
            // Log commands
            log_message,
            track_activity,
            get_recent_logs,
            get_logs_by_level,
            get_recent_activity,
            clear_logs,
            // EventSub commands
            connect_eventsub,
            disconnect_eventsub,
            is_eventsub_connected,
            get_eventsub_session_id,
            // Chat Identity commands
            fetch_chat_identity_badges,
            update_chat_identity,
            receive_badge_data,
            receive_update_result,
            // Hype Train commands
            get_hype_train_status,
            get_bulk_hype_train_status,
            // Bandwidth Test commands
            run_baseline_speed_test,
            // Resub notification commands
            get_resub_notification,
            use_resub_token,
            // Diagnostic Logging commands
            set_diagnostics_enabled,
            is_diagnostics_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
