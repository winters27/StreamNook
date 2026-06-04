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
    accounts::*, announcements::*, app::*, automation::*, badge_metadata::*, badge_service::*,
    badges::*, cache::*, channel_panels::*, chat::*, chat_identity::*, components::*,
    cosmetics_cache::*, diagnostic_logging::*, discord::*, drops::*, emoji::*, emotes::*,
    eventsub::*, hype_train::*, identity::*, justlog::*, layout::*, link_preview::*, logs::*,
    mod_log_storage::*, multi_nook::*, profile_cache::*, proxy_health::*, resub::*,
    screen_capture::*, settings::*, seventv::*, seventv_cosmetics::*, seventv_cosmetics_fetch::*,
    streaming::*, subscriptions::*, twitch::*, universal_cache::*, user_profile::*,
    watch_streak::*, whisper_storage::*,
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
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Builder, Emitter, Manager, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::sync::Mutex as TokioMutex;

/// Bring the main StreamNook window forward — used by the tray icon left-click
/// and the "Show StreamNook" menu item. Restores from minimized if needed and
/// re-shows if the window was hidden to the tray on close.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

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

/// One-time cleanup for users upgrading from a Streamlink-bundled build. Older
/// releases shipped a ~200 MB `streamlink/` folder next to the exe; native
/// resolution no longer needs it, so remove it in the background to reclaim the
/// space. Best-effort and silent: any failure is logged and simply retried on
/// the next launch. Runs off the main thread so a large delete never delays
/// startup.
fn cleanup_legacy_streamlink_bundle() {
    let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    else {
        return;
    };
    let streamlink_dir = exe_dir.join("streamlink");
    if !streamlink_dir.exists() {
        return;
    }
    std::thread::spawn(move || match std::fs::remove_dir_all(&streamlink_dir) {
        Ok(_) => debug!(
            "[Cleanup] Removed legacy bundled streamlink folder: {:?}",
            streamlink_dir
        ),
        Err(e) => debug!(
            "[Cleanup] Could not remove legacy streamlink folder {:?}: {}",
            streamlink_dir, e
        ),
    });
}

#[tauri::command]
fn read_clipboard_text_native(app: tauri::AppHandle) -> Result<String, String> {
    app.clipboard().read_text().map_err(|e| e.to_string())
}

fn main() {
    // Initialize the logging system FIRST so all debug!/error! macros work
    services::diagnostic_logger::init_logging();

    // Clean up any leftover files from previous update attempts
    cleanup_update_artifacts();

    // Reclaim the ~200 MB legacy streamlink bundle for users upgrading from a
    // Streamlink-bundled build (native resolution no longer needs it).
    cleanup_legacy_streamlink_bundle();

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
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(live_notification_service.clone())
        .manage(whisper_service.clone())
        .manage(layout_service.clone())
        .manage(emote_service_state)
        .manage(eventsub_service_state)
        .setup(move |app| {
            let app_handle = app.handle().clone();
            // Hand the stream server an app handle so the ad auto-pivot can emit
            // its `ad-pivot` reload event to the player.
            services::stream_server::set_app_handle(app_handle.clone());
            let live_notif_service = live_notification_service.clone();

            // Start the shared 7TV EventAPI WebSocket client (live emote set
            // updates, and later cosmetics). It idle-connects and subscribes
            // per channel as the IRC service JOINs/PARTs them.
            services::seventv_eventapi::init(app_handle.clone(), emote_service.clone());

            // Dedicated EventSub socket for the moderator view (channel.moderate).
            // Tied to chat, not the watched stream: it subscribes per channel the
            // IRC service JOINs and the user moderates, so the mod log enriches
            // with the acting moderator in single / offline / MultiNook / popout.
            services::eventsub_moderation::init(app_handle.clone());

            // Register deep link scheme on Windows
            #[cfg(windows)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            // Create and manage the background service correctly within the setup hook
            let background_service = Arc::new(TokioMutex::new(BackgroundService::new(
                Arc::new(tokio::sync::RwLock::new(settings_arc.lock().unwrap().clone())),
                app_handle.clone(),
                drops_service.clone(),
            )));

            let twitch_auth =
                services::twitch_auth_service::TwitchAuthService::new(app_handle.clone());

            let app_state = AppState {
                settings: settings_arc,
                drops_service,
                mining_service,
                background_service: background_service.clone(),
                layout_service: layout_service.clone(),
                emote_service: emote_service.clone(),
                twitch_auth,
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

            // Verify token health on startup
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

                            // Record the current login as the primary account in the
                            // multi-account registry. Cheap once recorded; self-heals if
                            // the user later signs in as a different account. Best-effort.
                            if let Some(uid) = status.user_id.as_deref() {
                                services::account_store::AccountStore::reconcile_primary(uid).await;
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
                        let client_id = env!("TWITCH_APP_CLIENT_ID").to_string();
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

            // System tray. Keeps the app running when the user closes the main
            // window while StreamNook MultiChat popouts are still open. Left
            // click brings the main window forward; right click opens a menu
            // with Show / Open MultiChat / Quit.
            let show_item = MenuItem::with_id(app, "show", "Show StreamNook", true, None::<&str>)?;
            let open_multichat_item = MenuItem::with_id(
                app,
                "open_multichat",
                "Open MultiChat",
                true,
                None::<&str>,
            )?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit StreamNook", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[&show_item, &open_multichat_item, &sep, &quit_item],
            )?;

            let _tray = TrayIconBuilder::new()
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .tooltip("StreamNook")
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app_handle, event| match event.id.as_ref() {
                    "show" => show_main_window(app_handle),
                    "open_multichat" => {
                        // Defer to the main window's JS — it already owns the
                        // openMultiChatWindow helper (URL params, label
                        // generation, persistence id). The main window is
                        // always loaded even when hidden, so the event fires
                        // reliably.
                        if let Some(main_win) = app_handle.get_webview_window("main") {
                            let _ = main_win.show();
                            let _ = main_win.set_focus();
                            let _ = main_win.emit("tray-open-multichat", ());
                        }
                    }
                    "quit" => {
                        app_handle.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

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
            get_emoji_image,
            read_clipboard_text_native,
            // Twitch commands
            twitch_login,
            create_clip,
            get_live_broadcast,
            create_vod_clip,
            begin_clip_edit,
            finalize_clip,
            get_clip_render_status,
            delete_clip,
            twitch_start_device_login,
            twitch_complete_device_login,
            twitch_logout,
            clear_webview_data,
            open_twitch_login_window,
            open_subscribe_window,
            has_stored_credentials,
            list_twitch_accounts,
            get_twitch_account_count,
            add_twitch_account,
            remove_twitch_account,
            set_active_twitch_account,
            sign_out_active_twitch_account,
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
            get_category_info,
            get_user_by_id,
            get_user_by_login,
            get_channel_moderators,
            get_channel_vips,
            follow_channel,
            unfollow_channel,
            check_following_status,
            get_all_followed_channels,
            get_offline_last_broadcasts,
            verify_token_health,
            force_refresh_token,
            get_twitch_token,
            check_stream_online,
            get_streams_by_game_name,
            get_clips_by_game,
            get_clips_by_broadcaster,
            get_clip_reactions,
            get_games_by_ids,
            get_videos_by_game,
            get_user_videos,
            send_whisper,
            start_whisper_listener,
            get_whisper_history,
            search_whisper_user,
            import_all_whisper_history,
            // Streaming commands
            start_stream,
            resolve_clip_media,
            stop_stream,
            get_ad_detection,
            get_stream_qualities,
            change_stream_quality,
            // Multi-stream commands
            start_multi_nook,
            stop_multi_nook,
            stop_all_multi_nooks,
            get_active_multi_nooks,
            register_active_channel,
            unregister_active_channel,
            // Chat commands
            start_chat,
            stop_chat,
            send_chat_message,
            join_chat_channel,
            leave_chat_channel,
            start_multi_chat,
            load_mod_logs,
            append_mod_log,
            clear_mod_logs,
            parse_historical_messages,
            update_chat_settings,
            clear_chat,
            delete_chat_message,
            ban_user,
            unban_user,
            add_channel_moderator,
            remove_channel_moderator,
            add_channel_vip,
            remove_channel_vip,
            update_suspicious_user_status,
            update_user_chat_color,
            block_user,
            unblock_user,
            get_channel_moderators,
            get_channel_vips,
            get_chatters_by_role,
            get_channel_chatters,
            send_chat_announcement,
            send_shoutout,
            start_commercial,
            start_raid,
            cancel_raid,
            create_stream_marker,
            warn_chat_user,
            update_shield_mode,
            // Discord commands
            connect_discord,
            disconnect_discord,
            set_idle_discord_presence,
            update_discord_presence,
            clear_discord_presence,
            // Settings commands
            load_settings,
            save_settings,
            get_current_app_version,
            get_latest_app_version,
            download_and_install_app_update,
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
            get_global_badge_collection,
            get_all_third_party_badges,
            get_bttv_pro_badge,
            get_discovered_bttv_pro_badges,
            // Badge Metadata commands
            fetch_badge_metadata,
            // Link preview commands
            fetch_link_preview,
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
            get_local_component_versions,
            get_remote_component_versions,
            check_for_bundle_update,
            extract_bundled_components,
            download_and_install_bundle,
            // Announcements
            fetch_announcements,
            fetch_user_chat_logs,
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
            // 7TV per-account (linked secondaries)
            get_seventv_auth_status_for,
            validate_seventv_token_for,
            logout_seventv_for,
            set_seventv_paint_for,
            set_seventv_badge_for,
            open_seventv_login_window_for_account,
            refresh_seventv_token_for_account,
            // 7TV Global Cosmetics commands
            get_all_seventv_badges,
            get_all_seventv_paints,
            // Automation commands (whisper scraper only — follow/unfollow migrated to GQL)
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
            add_eventsub_moderation,
            remove_eventsub_moderation,
            // Chat Identity commands
            fetch_chat_identity_badges,
            update_chat_identity,
            receive_badge_data,
            receive_update_result,
            // StreamNook Identity (badge loadout) commands
            get_streamnook_identity,
            get_streamnook_identities,
            get_streamnook_identity_resolved,
            set_streamnook_identity,
            // Hype Train commands
            get_hype_train_status,
            get_bulk_hype_train_status,

            // Resub notification commands
            get_resub_notification,
            use_resub_token,
            get_my_subscriptions,
            get_my_past_subscriptions,
            // Channel Panels commands
            get_channel_about_data,
            // Pinned Chat commands
            get_pinned_chat_messages,
            // Diagnostic Logging commands
            set_diagnostics_enabled,
            is_diagnostics_enabled,
            // Watch Streak commands
            get_watch_streak,
            get_watch_streaks_batch,
            share_watch_streak,
            // Proxy Health commands
            get_proxy_list,
            check_proxy_health,
            generate_optimal_proxy_args,
            // Screen capture (Profile share)
            capture_screen_region,
            capture_animated_webp,
        ])
        // Window-event handler. Two behaviors:
        //
        // 1. Main window close: if any StreamNook MultiChat popouts are open,
        //    intercept the close and hide the window to the tray instead.
        //    Process keeps running, popouts stay alive. If no popouts exist,
        //    the close proceeds normally (full exit).
        //
        // 2. Popout destroyed: when a popout closes, if it was the last
        //    popout AND the main window is currently hidden (i.e. the user
        //    previously closed main to the tray expecting the popouts to keep
        //    the app alive), exit the process. Otherwise the app keeps
        //    running until the user picks "Quit" from the tray.
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            let app_handle = window.app_handle().clone();

            if label == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let popouts_open = app_handle
                        .webview_windows()
                        .iter()
                        .any(|(l, _)| l.starts_with("multichat-"));
                    if popouts_open {
                        debug!(
                            "[Main] Close requested with popouts open — hiding main to tray"
                        );
                        api.prevent_close();
                        if let Some(main_win) = app_handle.get_webview_window("main") {
                            // Tell the JS side it's about to go background so
                            // it can stop the active stream (Streamlink + video
                            // + drops monitoring) before we hide. Chat stays
                            // alive because the popouts still need it — the JS
                            // handler is intentionally NOT a full stopStream
                            // (which would tear down the IRC connection too).
                            let _ = main_win.emit("main-hiding-to-tray", ());
                            let _ = main_win.hide();
                        }
                    }
                }
            } else if label.starts_with("multichat-") {
                if let WindowEvent::Destroyed = event {
                    // Tell the main window this popout is gone so it can
                    // drop the popout's channel set from its tracking and
                    // re-show its own ChatWidget if it was hiding because of
                    // those channels.
                    if let Some(main_win) = app_handle.get_webview_window("main") {
                        let _ = main_win.emit("multichat-popout-closed", &label);
                    }

                    let still_open = app_handle
                        .webview_windows()
                        .iter()
                        .filter(|(l, _)| l.starts_with("multichat-") && **l != label)
                        .count();
                    if still_open == 0 {
                        if let Some(main_win) = app_handle.get_webview_window("main") {
                            if !main_win.is_visible().unwrap_or(true) {
                                debug!(
                                    "[Main] Last MultiChat closed while main hidden — exiting"
                                );
                                app_handle.exit(0);
                            }
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
