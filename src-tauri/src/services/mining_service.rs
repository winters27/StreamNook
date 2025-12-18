use crate::models::drops::*;
use crate::services::channel_points_service::ChannelPointsService;
use crate::services::drops_auth_service::DropsAuthService;
use crate::services::drops_service::DropsService;
use crate::services::drops_websocket_service::DropsWebSocketService;
use anyhow::Result;
use base64::{engine::general_purpose, Engine as _};
use chrono::{Duration, Utc};
use regex::Regex;
use reqwest::Client;
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Listener};
use tokio::sync::RwLock;

// Recovery system constants
const DEFAULT_STALE_THRESHOLD_SECONDS: u64 = 420; // 7 minutes
const RELAXED_STALE_THRESHOLD_SECONDS: u64 = 900; // 15 minutes for relaxed mode

// Use Android app client ID for drops-related queries
const CLIENT_ID: &str = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";

pub struct MiningService {
    client: Client,
    drops_service: Arc<tokio::sync::Mutex<DropsService>>,
    channel_points_service: Arc<tokio::sync::Mutex<ChannelPointsService>>,
    mining_status: Arc<RwLock<MiningStatus>>,
    eligible_channels: Arc<RwLock<Vec<MiningChannel>>>,
    is_running: Arc<RwLock<bool>>,
    websocket_service: Arc<tokio::sync::Mutex<DropsWebSocketService>>,
    cached_user_id: Arc<RwLock<Option<String>>>, // Cache user ID to avoid repeated validation calls
    cached_spade_url: Arc<RwLock<Option<String>>>, // Cache spade URL to avoid repeated HTML fetches
    event_listener_id: Arc<RwLock<Option<u32>>>, // Store event listener ID for cleanup
    current_mining_game: Arc<RwLock<Option<String>>>, // Track current game to detect session changes
    // Recovery system state
    recovery_state: Arc<RwLock<RecoveryWatchdogState>>,
    // Session ID to prevent old loops from continuing when new session starts
    mining_session_id: Arc<RwLock<u64>>,
}

impl MiningService {
    pub fn new(drops_service: Arc<tokio::sync::Mutex<DropsService>>) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .connect_timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_else(|_| Client::new()),
            drops_service,
            channel_points_service: Arc::new(tokio::sync::Mutex::new(ChannelPointsService::new())),
            mining_status: Arc::new(RwLock::new(MiningStatus::default())),
            eligible_channels: Arc::new(RwLock::new(Vec::new())),
            is_running: Arc::new(RwLock::new(false)),
            websocket_service: Arc::new(tokio::sync::Mutex::new(DropsWebSocketService::new())),
            cached_user_id: Arc::new(RwLock::new(None)),
            cached_spade_url: Arc::new(RwLock::new(None)),
            event_listener_id: Arc::new(RwLock::new(None)),
            current_mining_game: Arc::new(RwLock::new(None)),
            // Initialize recovery watchdog state
            recovery_state: Arc::new(RwLock::new(RecoveryWatchdogState::default())),
            // Initialize session ID counter
            mining_session_id: Arc::new(RwLock::new(0)),
        }
    }

    /// Set up the WebSocket event listener (only once)
    async fn setup_websocket_listener(&self, app_handle: &AppHandle) {
        // Check if listener is already set up
        let has_listener = {
            let listener_id = self.event_listener_id.read().await;
            listener_id.is_some()
        };

        if has_listener {
            println!("📡 WebSocket listener already set up, skipping duplicate registration");
            return;
        }

        let drops_service = self.drops_service.clone();
        let mining_status = self.mining_status.clone();
        let app_handle_clone = app_handle.clone();

        let event_id = app_handle.listen("drops-progress-update", move |event| {
            let drops_service = drops_service.clone();
            let mining_status = mining_status.clone();
            let app_handle = app_handle_clone.clone();

            tokio::spawn(async move {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload()) {
                    let drop_id = payload["drop_id"].as_str().unwrap_or("");
                    let current_minutes = payload["current_minutes"].as_i64().unwrap_or(0) as i32;
                    let required_minutes = payload["required_minutes"].as_i64().unwrap_or(0) as i32;

                    println!(
                        "✅ Updated drop progress from WebSocket: {}/{} minutes for drop {}",
                        current_minutes, required_minutes, drop_id
                    );

                    // Update mining status with new progress
                    {
                        let mut status = mining_status.write().await;
                        if let Some(ref mut current_drop) = status.current_drop {
                            println!(
                                "Comparing current_drop.drop_id: {} with payload drop_id: {}",
                                current_drop.drop_id, drop_id
                            );
                            if current_drop.drop_id == drop_id {
                                println!(
                                    "✅ Updated drop progress from WebSocket: {}/{} minutes for drop {}",
                                    current_minutes, required_minutes, drop_id
                                );
                                current_drop.current_minutes = current_minutes;
                                current_drop.required_minutes = required_minutes;
                                current_drop.progress_percentage =
                                    (current_minutes as f32 / required_minutes as f32) * 100.0;

                                // Update estimated completion
                                if current_minutes > 0 && current_minutes < required_minutes {
                                    let remaining_minutes = required_minutes - current_minutes;
                                    current_drop.estimated_completion = Some(
                                        Utc::now() + Duration::minutes(remaining_minutes as i64),
                                    );
                                } else {
                                    current_drop.estimated_completion = None;
                                }

                                status.last_update = Utc::now();

                                // Emit updated status to frontend
                                let current_status = status.clone();
                                // Drop the lock before emitting to avoid holding it during emit (though emit shouldn't block much)
                                drop(status);
                                let _ = app_handle.emit("mining-status-update", &current_status);
                            } else {
                                println!("⚠️ Drop ID mismatch in mining status update. Got {}, expected {}", drop_id, current_drop.drop_id);
                                
                                // We have a mismatch. Attempts to find the correct drop info and update status.
                                drop(status); // Release lock before calling drops_service

                                let drops_service_lock = drops_service.lock().await;
                                // Access cached campaigns via internal method or field if exposed (it is public in struct but field access might be tricky if not pub)
                                // Only cached_campaigns is needed. It is pub in DropsService struct? 
                                // Looking at view_file of drops_service.rs, cached_campaigns field is NOT pub. 
                                // But `get_all_active_campaigns_cached` returns Vec<DropCampaign>.
                                let _ = drops_service_lock;
                                // Wait, we can't access fields if they are private.
                                // But we can call `get_all_active_campaigns_cached`.
                                // However, that is async and we are in a async block.
                                // Since we already have the lock, we can't call async methods on it if we hold the lock? 
                                // `websockets_listener` has `drops_service` which is `Arc<Mutex<DropsService>>`?
                                // In `services/mining_service.rs`, `drops_service` is `Arc<Mutex<DropsService>>`.
                                // But `DropsService` methods take `&self`.
                                // If we lock it, we get `MutexGuard<DropsService>`. We can't call async methods on `&self` easily if we hold the guard?
                                // Actually `DropsService` methods are async.
                                
                                drop(drops_service_lock);
                                
                                // We need to query drops service for campaigns to find the drop name.
                                // We'll just define a helper block
                                let campaigns_result = drops_service.lock().await.get_all_active_campaigns_cached().await;
                                
                                if let Ok(campaigns) = campaigns_result {
                                    // Search for the drop
                                    let mut found_drop_info = None;
                                    for campaign in campaigns {
                                        if let Some(drop) = campaign.time_based_drops.iter().find(|d| d.id == drop_id) {
                                            // Found it!
                                            let progress_percentage = (current_minutes as f32 / required_minutes as f32) * 100.0;
                                            
                                            let estimated_completion = if current_minutes > 0 && current_minutes < required_minutes {
                                                let remaining_minutes = required_minutes - current_minutes;
                                                Some(Utc::now() + chrono::Duration::minutes(remaining_minutes as i64))
                                            } else {
                                                None
                                            };
                                            
                                            // Determine drop name
                                            let drop_name = if let Some(benefit) = drop.benefit_edges.first() {
                                                benefit.name.clone()
                                            } else {
                                                drop.name.clone()
                                            };

                                            // Get drop image from benefit_edges
                                            let drop_image = drop.benefit_edges.first().map(|b| b.image_url.clone());
                                            
                                            found_drop_info = Some(CurrentDropInfo {
                                                drop_id: drop.id.clone(),
                                                drop_name,
                                                drop_image,
                                                campaign_name: campaign.name.clone(),
                                                game_name: campaign.game_name.clone(),
                                                current_minutes,
                                                required_minutes,
                                                progress_percentage,
                                                estimated_completion
                                            });
                                            break;
                                        }
                                    }
                                    
                                    if let Some(new_drop_info) = found_drop_info {
                                        println!("✅ Found metadata for mismatched drop: {} ({})", new_drop_info.drop_name, new_drop_info.game_name);
                                        let mut status = mining_status.write().await;
                                        status.current_drop = Some(new_drop_info);
                                        status.last_update = Utc::now();
                                        
                                        // Emit
                                        let current_status = status.clone();
                                        drop(status);
                                        let _ = app_handle.emit("mining-status-update", &current_status);
                                    } else {
                                        // This is normal - the drop might be from a different campaign in the same game
                                        // The inventory polling will provide accurate data for all drops
                                        println!("ℹ️ Drop {} is being tracked by inventory polling (not in campaigns cache)", drop_id);
                                    }
                                }
                            }
                        } else {
                            println!("⚠️ No current_drop in mining status during update. Attempting to recover...");
                             drop(status); // Release lock
                             
                            // Same recovery logic as above
                            let campaigns_result = drops_service.lock().await.get_all_active_campaigns_cached().await;
                            
                             if let Ok(campaigns) = campaigns_result {
                                // Search for the drop
                                let mut found_drop_info = None;
                                for campaign in campaigns {
                                    if let Some(drop) = campaign.time_based_drops.iter().find(|d| d.id == drop_id) {
                                        // Found it!
                                        let drop_name = if let Some(benefit) = drop.benefit_edges.first() {
                                            benefit.name.clone()
                                        } else {
                                            drop.name.clone()
                                        };
                                        
                                        let estimated_completion = if current_minutes > 0 && current_minutes < required_minutes {
                                             let remaining_minutes = required_minutes - current_minutes;
                                             Some(Utc::now() + chrono::Duration::minutes(remaining_minutes as i64))
                                        } else {
                                             None
                                        };

                                        // Get drop image from benefit_edges
                                        let drop_image = drop.benefit_edges.first().map(|b| b.image_url.clone());
                                        
                                        found_drop_info = Some(CurrentDropInfo {
                                            drop_id: drop.id.clone(),
                                            drop_name,
                                            drop_image,
                                            campaign_name: campaign.name.clone(),
                                            game_name: campaign.game_name.clone(),
                                            current_minutes,
                                            required_minutes,
                                            progress_percentage: (current_minutes as f32 / required_minutes as f32) * 100.0,
                                            estimated_completion
                                        });
                                        break;
                                    }
                                }
                                
                                if let Some(new_drop_info) = found_drop_info {
                                    println!("✅ Recovered drop info from scratch: {} ({})", new_drop_info.drop_name, new_drop_info.game_name);
                                    let mut status = mining_status.write().await;
                                    status.current_drop = Some(new_drop_info);
                                    status.last_update = Utc::now();
                                    
                                     // Emit
                                    let current_status = status.clone();
                                    drop(status);
                                    let _ = app_handle.emit("mining-status-update", &current_status);
                                }
                             }
                        }
                    }

                    // Also update the drops service progress cache
                    drops_service
                        .lock()
                        .await
                        .update_drop_progress_from_websocket(
                            drop_id.to_string(),
                            current_minutes,
                            required_minutes,
                        )
                        .await;
                }
            });
        });

        // Store the event ID for cleanup
        let mut listener_id = self.event_listener_id.write().await;
        *listener_id = Some(event_id);

        println!("✅ WebSocket event listener registered");
    }

    pub async fn get_mining_status(&self) -> MiningStatus {
        self.mining_status.read().await.clone()
    }

    pub async fn is_mining(&self) -> bool {
        *self.is_running.read().await
    }

    /// Get eligible channels for a specific campaign without starting mining
    /// This allows the user to preview and select which channel they want to watch
    pub async fn get_eligible_channels_for_campaign(
        &self,
        campaign_id: String,
    ) -> Result<Vec<MiningChannel>> {
        let client = self.client.clone();
        let drops_service = self.drops_service.clone();

        // Fetch campaigns
        let campaigns_result = {
            let service = drops_service.lock().await;
            service.fetch_all_active_campaigns_from_api().await
        };

        match campaigns_result {
            Ok(all_campaigns) => {
                let (target_campaign, settings) = {
                    let service = drops_service.lock().await;
                    service.update_campaigns_and_progress(&all_campaigns).await;
                    let settings = service.get_settings().await;

                    // Apply filters and find the target campaign
                    let filtered_campaigns = all_campaigns
                        .into_iter()
                        .filter(|c| {
                            !settings.excluded_games.contains(&c.game_name)
                                && (settings.priority_mode != PriorityMode::PriorityOnly
                                    || settings.priority_games.is_empty()
                                    || settings.priority_games.contains(&c.game_name))
                        })
                        .collect::<Vec<_>>();

                    let target = filtered_campaigns
                        .into_iter()
                        .filter(|c| c.id == campaign_id)
                        .collect::<Vec<_>>();
                    (target, settings)
                };

                if target_campaign.is_empty() {
                    return Err(anyhow::anyhow!(
                        "Campaign {} not found or no longer active",
                        campaign_id
                    ));
                }

                // Discover eligible channels for this specific campaign only
                let mut channels =
                    Self::discover_eligible_channels_internal(&client, &target_campaign, &settings)
                        .await?;

                // Sort by viewer count descending so highest viewers are first
                channels.sort_by(|a, b| b.viewers.cmp(&a.viewers));

                Ok(channels)
            }
            Err(e) => Err(anyhow::anyhow!("Failed to fetch campaigns: {}", e)),
        }
    }

    /// Start mining a specific campaign with a specific channel
    /// This allows the user to choose which channel to watch
    pub async fn start_campaign_mining_with_channel(
        &self,
        campaign_id: String,
        channel_id: String,
        app_handle: AppHandle,
    ) -> Result<()> {
        // Check if already running
        {
            let mut is_running = self.is_running.write().await;
            if *is_running {
                return Ok(());
            }
            *is_running = true;
        }

        // Set up WebSocket event listener (only once)
        self.setup_websocket_listener(&app_handle).await;

        // Clone Arc references for the background task
        let client = self.client.clone();
        let drops_service = self.drops_service.clone();
        let mining_status = self.mining_status.clone();
        let eligible_channels = self.eligible_channels.clone();
        let is_running = self.is_running.clone();
        let cached_user_id = self.cached_user_id.clone();
        let cached_spade_url = self.cached_spade_url.clone();

        // Spawn the mining loop for a specific campaign with a specific channel
        tokio::spawn(async move {
            println!(
                "🎮 Starting manual campaign mining for campaign: {} with channel: {}",
                campaign_id, channel_id
            );

            // Fetch campaigns
            let campaigns_result = {
                let service = drops_service.lock().await;
                service.fetch_all_active_campaigns_from_api().await
            };

            match campaigns_result {
                Ok(all_campaigns) => {
                    // For manual mining, we bypass priority/exclusion filters
                    // The user explicitly chose this campaign, so we should respect that
                    let (target_campaign, settings) = {
                        let service = drops_service.lock().await;
                        service.update_campaigns_and_progress(&all_campaigns).await;
                        let settings = service.get_settings().await;

                        // Find the target campaign directly by ID (no exclusion filters for manual mining)
                        let target = all_campaigns
                            .into_iter()
                            .filter(|c| c.id == campaign_id)
                            .collect::<Vec<_>>();
                        (target, settings)
                    };

                    if target_campaign.is_empty() {
                        println!("⚠️ Campaign {} not found or no longer active", campaign_id);
                        return;
                    }

                    // Discover eligible channels to find the selected one
                    match Self::discover_eligible_channels_internal(
                        &client,
                        &target_campaign,
                        &settings,
                    )
                    .await
                    {
                        Ok(channels) => {
                            // Store all channels
                            let mut eligible = eligible_channels.write().await;
                            *eligible = channels.clone();
                            drop(eligible);

                            // Find the user-selected channel
                            let selected_channel = channels.iter().find(|ch| ch.id == channel_id);

                            if let Some(best_channel) = selected_channel.cloned() {
                                println!(
                                    "✅ Using user-selected channel: {} ({})",
                                    best_channel.name, best_channel.id
                                );

                                let eligible = eligible_channels.read().await;
                                let mut status = mining_status.write().await;
                                status.is_mining = true;
                                status.current_channel = Some(best_channel.clone());
                                status.eligible_channels = eligible.clone();
                                status.last_update = Utc::now();
                                drop(eligible);

                                if let Some(campaign) = Self::get_active_campaign_for_channel(
                                    &best_channel,
                                    &target_campaign,
                                ) {
                                    status.current_campaign = Some(campaign.name.clone());

                                    if let Some(drop) = campaign.time_based_drops.first() {
                                        let drop_progress =
                                            drops_service.lock().await.get_drop_progress().await;
                                        let current_minutes = drop_progress
                                            .iter()
                                            .find(|p| p.drop_id == drop.id)
                                            .map(|p| p.current_minutes_watched)
                                            .unwrap_or(0);

                                        let progress_percentage = (current_minutes as f32
                                            / drop.required_minutes_watched as f32)
                                            * 100.0;

                                        let estimated_completion = if current_minutes > 0 {
                                            let remaining_minutes =
                                                drop.required_minutes_watched - current_minutes;
                                            Some(
                                                Utc::now()
                                                    + Duration::minutes(remaining_minutes as i64),
                                            )
                                        } else {
                                            None
                                        };

                                        let drop_name =
                                            if let Some(benefit) = drop.benefit_edges.first() {
                                                benefit.name.clone()
                                            } else {
                                                drop.name.clone()
                                            };

                                        // Get drop image from benefit_edges
                                        let drop_image =
                                            drop.benefit_edges.first().map(|b| b.image_url.clone());

                                        status.current_drop = Some(CurrentDropInfo {
                                            drop_id: drop.id.clone(),
                                            drop_name,
                                            drop_image,
                                            campaign_name: campaign.name.clone(),
                                            game_name: campaign.game_name.clone(),
                                            current_minutes,
                                            required_minutes: drop.required_minutes_watched,
                                            progress_percentage,
                                            estimated_completion,
                                        });
                                    }
                                }

                                drop(status);

                                let current_status = mining_status.read().await.clone();
                                let _ = app_handle.emit("mining-status-update", &current_status);

                                println!(
                                    "⛏️ Mining drops on user-selected channel: {} ({})",
                                    best_channel.name, best_channel.game_name
                                );

                                // Get token and user ID
                                let token = match DropsAuthService::get_token().await {
                                    Ok(t) => t,
                                    Err(e) => {
                                        eprintln!("❌ Failed to get token: {}", e);
                                        return;
                                    }
                                };

                                let user_id = match Self::get_user_id(&client, &token).await {
                                    Ok(id) => id,
                                    Err(e) => {
                                        eprintln!("❌ Failed to get user ID: {}", e);
                                        return;
                                    }
                                };

                                let broadcast_id =
                                    match Self::get_broadcast_id(&client, &best_channel.id, &token)
                                        .await
                                    {
                                        Ok(Some(id)) => id,
                                        Ok(None) => best_channel.id.clone(),
                                        Err(_) => best_channel.id.clone(),
                                    };

                                // Start watch payload loop
                                let client_clone = client.clone();
                                let best_channel_clone = best_channel.clone();
                                let broadcast_id_clone = broadcast_id.clone();
                                let token_clone = token.clone();
                                let is_running_clone = is_running.clone();
                                let mining_status_clone = mining_status.clone();
                                let app_handle_clone = app_handle.clone();
                                let target_campaign_clone = target_campaign.clone();
                                let settings_clone = settings.clone();
                                let eligible_channels_clone = eligible_channels.clone();
                                let cached_user_id_clone = cached_user_id.clone();
                                let cached_spade_url_clone = cached_spade_url.clone();

                                tokio::spawn(async move {
                                    let mut current_channel = best_channel_clone;
                                    let mut current_broadcast_id = broadcast_id_clone;
                                    let mut interval =
                                        tokio::time::interval(tokio::time::Duration::from_secs(60));
                                    let mut consecutive_failures = 0;
                                    let mut channel_index = 0;

                                    loop {
                                        if !*is_running_clone.read().await {
                                            println!(
                                                "🛑 Stopping watch payload loop (with channel)"
                                            );
                                            break;
                                        }

                                        println!(
                                            "📡 Sending watch payload to {}...",
                                            current_channel.name
                                        );
                                        match Self::send_watch_payload(
                                            &client_clone,
                                            &current_channel,
                                            &current_broadcast_id,
                                            &token_clone,
                                            &cached_user_id_clone,
                                            &cached_spade_url_clone,
                                        )
                                        .await
                                        {
                                            Ok(true) => {
                                                println!(
                                                    "✅ Watch payload sent successfully to {}",
                                                    current_channel.name
                                                );
                                                consecutive_failures = 0;
                                                {
                                                    let mut status =
                                                        mining_status_clone.write().await;
                                                    status.last_update = Utc::now();
                                                }
                                            }
                                            Ok(false) | Err(_) => {
                                                consecutive_failures += 1;
                                                println!(
                                                    "⚠️ Watch payload failed for {} (failure {}/3)",
                                                    current_channel.name, consecutive_failures
                                                );

                                                if consecutive_failures >= 3 {
                                                    println!(
                                                        "❌ Channel {} failed 3 times, attempting to switch with API refresh...",
                                                        current_channel.name
                                                    );

                                                    let channels = eligible_channels_clone
                                                        .read()
                                                        .await
                                                        .clone();

                                                    // Try to switch to another channel with API refresh fallback
                                                    match Self::try_switch_channel_with_refresh(
                                                        &client_clone,
                                                        &token_clone,
                                                        &channels,
                                                        &current_channel.id,
                                                        channel_index,
                                                        &target_campaign_clone,
                                                        &settings_clone,
                                                    )
                                                    .await
                                                    {
                                                        Some((
                                                            new_channel,
                                                            new_broadcast_id,
                                                            fresh_channels,
                                                            new_index,
                                                        )) => {
                                                            let old_channel_name =
                                                                current_channel.name.clone();
                                                            current_channel = new_channel.clone();
                                                            current_broadcast_id = new_broadcast_id;
                                                            channel_index = new_index;
                                                            consecutive_failures = 0;

                                                            // Update the cached eligible channels with fresh list
                                                            {
                                                                let mut eligible =
                                                                    eligible_channels_clone
                                                                        .write()
                                                                        .await;
                                                                *eligible = fresh_channels.clone();
                                                            }

                                                            // Clear cached spade URL when switching channels (channel-specific)
                                                            {
                                                                let mut cached =
                                                                    cached_spade_url_clone
                                                                        .write()
                                                                        .await;
                                                                *cached = None;
                                                                println!(
                                                                    "🗑️ Cleared cached spade URL on channel switch"
                                                                );
                                                            }

                                                            {
                                                                let mut status =
                                                                    mining_status_clone
                                                                        .write()
                                                                        .await;
                                                                status.current_channel =
                                                                    Some(new_channel.clone());
                                                                status.eligible_channels =
                                                                    fresh_channels;
                                                                status.last_update = Utc::now();

                                                                if let Some(campaign) = Self::get_active_campaign_for_channel(&new_channel, &target_campaign_clone) {
                                                                    status.current_campaign = Some(campaign.name.clone());
                                                                }

                                                                let current_status = status.clone();
                                                                drop(status);
                                                                let _ = app_handle_clone.emit(
                                                                    "mining-status-update",
                                                                    &current_status,
                                                                );
                                                                let _ = app_handle_clone.emit("channel-switched", json!({
                                                                    "from": old_channel_name,
                                                                    "to": new_channel.name,
                                                                    "reason": "offline_or_errors"
                                                                }));
                                                            }

                                                            println!(
                                                                "✅ Successfully switched to {}",
                                                                new_channel.name
                                                            );
                                                        }
                                                        None => {
                                                            println!(
                                                                "❌ No channels available after API refresh, stopping mining"
                                                            );

                                                            // Stop mining and notify user
                                                            Self::stop_mining_no_channels(
                                                                &is_running_clone,
                                                                &mining_status_clone,
                                                                &app_handle_clone,
                                                                "All streams for this campaign are offline. Mining has been stopped.",
                                                            ).await;

                                                            break;
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        interval.tick().await;
                                    }
                                });

                                // Start periodic inventory polling (fallback since WebSocket drops progress is unreliable)
                                let drops_service_poll = drops_service.clone();
                                let mining_status_poll = mining_status.clone();
                                let app_handle_poll = app_handle.clone();
                                let is_running_poll = is_running.clone();
                                // Get the game name AND campaign name from the target campaign for filtering
                                let game_name_poll = target_campaign
                                    .first()
                                    .map(|c| c.game_name.clone())
                                    .unwrap_or_default();
                                let campaign_name_poll = target_campaign
                                    .first()
                                    .map(|c| c.name.clone())
                                    .unwrap_or_default();
                                let game_name_session = game_name_poll.clone();
                                let campaign_name_session = campaign_name_poll.clone();

                                tokio::spawn(async move {
                                    let mut poll_interval =
                                        tokio::time::interval(tokio::time::Duration::from_secs(60)); // Poll every minute
                                    poll_interval.tick().await; // Skip first immediate tick

                                    loop {
                                        if !*is_running_poll.read().await {
                                            println!("🛑 Stopping inventory polling loop for {} (mining stopped)", game_name_session);
                                            break;
                                        }

                                        // Check if we're still mining the same game
                                        {
                                            let status = mining_status_poll.read().await;
                                            if let Some(ref channel) = status.current_channel {
                                                if channel.game_name != game_name_session {
                                                    println!("🛑 Stopping inventory polling loop for {} (switched to {})", 
                                                        game_name_session, channel.game_name);
                                                    break;
                                                }
                                            }
                                        }

                                        println!(
                                            "📊 Polling inventory for drops progress (campaign: {}, game: {})...",
                                            campaign_name_poll, game_name_poll
                                        );
                                        match drops_service_poll
                                            .lock()
                                            .await
                                            .fetch_inventory()
                                            .await
                                        {
                                            Ok(inventory) => {
                                                let mut all_drops_with_progress: Vec<(
                                                    String,
                                                    String,
                                                    String,
                                                    String,
                                                    String,
                                                    i32,
                                                    i32,
                                                    f32,
                                                )> = Vec::new();

                                                for item in &inventory.items {
                                                    if item.campaign.game_name != game_name_poll {
                                                        continue;
                                                    }

                                                    if item.campaign.name != campaign_name_poll {
                                                        println!(
                                                            "📊 Skipping campaign {} (mining specific campaign: {})",
                                                            item.campaign.name, campaign_name_poll
                                                        );
                                                        continue;
                                                    }

                                                    println!(
                                                        "📊 Found target campaign for {}: {}",
                                                        item.campaign.game_name, item.campaign.name
                                                    );

                                                    for time_drop in &item.campaign.time_based_drops
                                                    {
                                                        if let Some(progress) = &time_drop.progress
                                                        {
                                                            let current_minutes =
                                                                progress.current_minutes_watched;
                                                            let required_minutes =
                                                                time_drop.required_minutes_watched;

                                                            if current_minutes >= required_minutes {
                                                                continue;
                                                            }

                                                            let (drop_name, drop_image) =
                                                                if let Some(benefit) =
                                                                    time_drop.benefit_edges.first()
                                                                {
                                                                    (
                                                                        benefit.name.clone(),
                                                                        benefit.image_url.clone(),
                                                                    )
                                                                } else {
                                                                    (
                                                                        time_drop.name.clone(),
                                                                        String::new(),
                                                                    )
                                                                };

                                                            let progress_percentage =
                                                                if required_minutes > 0 {
                                                                    (current_minutes as f32
                                                                        / required_minutes as f32)
                                                                        * 100.0
                                                                } else {
                                                                    0.0
                                                                };

                                                            println!("📊 Inventory poll: {}/{} minutes for {} ({}) [{:.1}%]", 
                                                                current_minutes, required_minutes, drop_name, time_drop.id, progress_percentage);

                                                            all_drops_with_progress.push((
                                                                time_drop.id.clone(),
                                                                drop_name,
                                                                drop_image,
                                                                item.campaign.name.clone(),
                                                                item.campaign.game_name.clone(),
                                                                current_minutes,
                                                                required_minutes,
                                                                progress_percentage,
                                                            ));
                                                        }
                                                    }
                                                }

                                                all_drops_with_progress.sort_by(|a, b| {
                                                    b.7.partial_cmp(&a.7)
                                                        .unwrap_or(std::cmp::Ordering::Equal)
                                                });

                                                if let Some((
                                                    drop_id,
                                                    drop_name,
                                                    drop_image,
                                                    campaign_name,
                                                    game_name,
                                                    current_minutes,
                                                    required_minutes,
                                                    progress_percentage,
                                                )) = all_drops_with_progress.first()
                                                {
                                                    let mut status =
                                                        mining_status_poll.write().await;

                                                    let should_update =
                                                        if let Some(ref current_drop) =
                                                            status.current_drop
                                                        {
                                                            current_drop.drop_id != *drop_id
                                                                || current_drop.current_minutes
                                                                    != *current_minutes
                                                        } else {
                                                            true
                                                        };

                                                    if should_update {
                                                        let estimated_completion =
                                                            if *current_minutes > 0
                                                                && *current_minutes
                                                                    < *required_minutes
                                                            {
                                                                let remaining = *required_minutes
                                                                    - *current_minutes;
                                                                Some(
                                                                    chrono::Utc::now()
                                                                        + chrono::Duration::minutes(
                                                                            remaining as i64,
                                                                        ),
                                                                )
                                                            } else {
                                                                None
                                                            };

                                                        let drop_image_opt =
                                                            if drop_image.is_empty() {
                                                                None
                                                            } else {
                                                                Some(drop_image.clone())
                                                            };

                                                        status.current_drop =
                                                            Some(CurrentDropInfo {
                                                                drop_id: drop_id.clone(),
                                                                drop_name: drop_name.clone(),
                                                                drop_image: drop_image_opt,
                                                                campaign_name: campaign_name
                                                                    .clone(),
                                                                game_name: game_name.clone(),
                                                                current_minutes: *current_minutes,
                                                                required_minutes: *required_minutes,
                                                                progress_percentage:
                                                                    *progress_percentage,
                                                                estimated_completion,
                                                            });
                                                        status.last_update = chrono::Utc::now();

                                                        println!("✅ [Inventory] Set current_drop to HIGHEST progress: {} ({}/{} = {:.1}%)", 
                                                            drop_name, current_minutes, required_minutes, progress_percentage);

                                                        let current_status = status.clone();
                                                        std::mem::drop(status);
                                                        let _ = app_handle_poll.emit(
                                                            "mining-status-update",
                                                            &current_status,
                                                        );
                                                    } else {
                                                        std::mem::drop(status);
                                                    }
                                                }

                                                // Emit progress update events for ALL drops
                                                for (
                                                    drop_id,
                                                    drop_name,
                                                    drop_image,
                                                    campaign_name,
                                                    game_name,
                                                    current_minutes,
                                                    required_minutes,
                                                    _,
                                                ) in &all_drops_with_progress
                                                {
                                                    let _ = app_handle_poll.emit("drops-progress-update", serde_json::json!({
                                                        "drop_id": drop_id,
                                                        "drop_name": drop_name,
                                                        "drop_image": drop_image,
                                                        "campaign_name": campaign_name,
                                                        "game_name": game_name,
                                                        "current_minutes": current_minutes,
                                                        "required_minutes": required_minutes,
                                                        "timestamp": chrono::Utc::now().to_rfc3339()
                                                    }));
                                                }

                                                // Drop completion detection
                                                if all_drops_with_progress.is_empty() {
                                                    println!("🎉 All drops for campaign '{}' ({}) are complete (100%)!", campaign_name_session, game_name_session);

                                                    {
                                                        let mut running =
                                                            is_running_poll.write().await;
                                                        *running = false;
                                                    }

                                                    {
                                                        let mut status =
                                                            mining_status_poll.write().await;
                                                        status.is_mining = false;
                                                        status.current_channel = None;
                                                        status.current_campaign = None;
                                                        status.current_drop = None;
                                                        status.eligible_channels = Vec::new();
                                                        status.last_update = chrono::Utc::now();
                                                    }

                                                    let current_status =
                                                        mining_status_poll.read().await.clone();
                                                    let _ = app_handle_poll.emit(
                                                        "mining-status-update",
                                                        &current_status,
                                                    );

                                                    let _ = app_handle_poll.emit("mining-complete", serde_json::json!({
                                                        "game_name": game_name_session,
                                                        "campaign_name": campaign_name_session,
                                                        "reason": format!("All drops for '{}' are complete (100%)", campaign_name_session),
                                                        "timestamp": chrono::Utc::now().to_rfc3339()
                                                    }));

                                                    break;
                                                }
                                            }
                                            Err(e) => {
                                                eprintln!("⚠️ Failed to poll inventory: {}", e);
                                            }
                                        }

                                        poll_interval.tick().await;
                                    }
                                });

                                // Connect WebSocket
                                let websocket_service =
                                    Arc::new(tokio::sync::Mutex::new(DropsWebSocketService::new()));
                                let mut ws_service = websocket_service.lock().await;
                                if let Err(e) = ws_service
                                    .connect(&user_id, &token, app_handle.clone())
                                    .await
                                {
                                    eprintln!("❌ Failed to connect WebSocket: {}", e);
                                }
                                drop(ws_service);
                            } else {
                                println!(
                                    "⚠️ Selected channel {} not found in eligible channels",
                                    channel_id
                                );
                                let mut status = mining_status.write().await;
                                status.is_mining = false;
                            }
                        }
                        Err(e) => {
                            eprintln!("❌ Failed to discover eligible channels: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("❌ Failed to fetch campaigns: {}", e);
                }
            }

            // Keep mining running until stopped
            loop {
                let should_continue = *is_running.read().await;
                if !should_continue {
                    break;
                }
                tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
            }

            let mut status = mining_status.write().await;
            status.is_mining = false;
            status.current_channel = None;
            status.current_campaign = None;
            status.current_drop = None;
        });

        Ok(())
    }

    /// Start mining a specific campaign (manual mode - like clicking "Start Mining" on a campaign)
    pub async fn start_campaign_mining(
        &self,
        campaign_id: String,
        app_handle: AppHandle,
    ) -> Result<()> {
        // Increment session ID to invalidate any old running loops
        let session_id = {
            let mut sid = self.mining_session_id.write().await;
            *sid += 1;
            println!("🆔 New mining session ID: {}", *sid);
            *sid
        };

        // Set running state
        {
            let mut is_running = self.is_running.write().await;
            *is_running = true;
        }

        // Set up WebSocket event listener (only once)
        self.setup_websocket_listener(&app_handle).await;

        // Clone Arc references for the background task
        let client = self.client.clone();
        let drops_service = self.drops_service.clone();
        let mining_status = self.mining_status.clone();
        let eligible_channels = self.eligible_channels.clone();
        let is_running = self.is_running.clone();
        let cached_user_id = self.cached_user_id.clone();
        let cached_spade_url = self.cached_spade_url.clone();

        // Spawn the mining loop for a specific campaign
        tokio::spawn(async move {
            println!(
                "🎮 Starting manual campaign mining for campaign: {}",
                campaign_id
            );

            // Fetch campaigns ONCE at startup
            let campaigns_result = {
                let service = drops_service.lock().await;
                service.fetch_all_active_campaigns_from_api().await
            };

            match campaigns_result {
                Ok(all_campaigns) => {
                    // For manual mining, we bypass priority/exclusion filters
                    // The user explicitly chose this campaign, so we should respect that
                    let (target_campaign, settings) = {
                        let service = drops_service.lock().await;
                        service.update_campaigns_and_progress(&all_campaigns).await;
                        let settings = service.get_settings().await;

                        // Find the target campaign directly by ID (no exclusion filters for manual mining)
                        let target = all_campaigns
                            .into_iter()
                            .filter(|c| c.id == campaign_id)
                            .collect::<Vec<_>>();
                        (target, settings)
                    };

                    if target_campaign.is_empty() {
                        println!("⚠️ Campaign {} not found or no longer active", campaign_id);
                        return; // Exit the task
                    }

                    // Discover eligible channels for this specific campaign only
                    match Self::discover_eligible_channels_internal(
                        &client,
                        &target_campaign,
                        &settings,
                    )
                    .await
                    {
                        Ok(channels) => {
                            // Store the channels first
                            let mut eligible = eligible_channels.write().await;
                            *eligible = channels.clone();
                            drop(eligible);

                            // Select the best channel from this campaign
                            if let Some(best_channel) =
                                Self::select_best_channel(&channels, &target_campaign, &settings)
                            {
                                println!(
                                    "✅ Selected channel: {} ({})",
                                    best_channel.name, best_channel.id
                                );

                                // Re-acquire the lock to get the eligible channels for status
                                let eligible = eligible_channels.read().await;
                                // Update mining status
                                let mut status = mining_status.write().await;
                                status.is_mining = true;
                                status.current_channel = Some(best_channel.clone());
                                status.eligible_channels = eligible.clone();
                                status.last_update = Utc::now();
                                drop(eligible);

                                println!("📊 Mining status updated");

                                // Find the active campaign for this channel
                                if let Some(campaign) = Self::get_active_campaign_for_channel(
                                    &best_channel,
                                    &target_campaign,
                                ) {
                                    println!("📦 Found active campaign: {}", campaign.name);
                                    status.current_campaign = Some(campaign.name.clone());

                                    // Get all unclaimed drops with their progress percentages
                                    let drop_progress =
                                        drops_service.lock().await.get_drop_progress().await;

                                    // Calculate progress for all unclaimed drops and sort by percentage (highest first)
                                    let mut drops_with_progress: Vec<_> = campaign
                                        .time_based_drops
                                        .iter()
                                        .filter(|d| {
                                            if let Some(prog) = &d.progress {
                                                !prog.is_claimed
                                            } else {
                                                true // If no progress info, assume unclaimed
                                            }
                                        })
                                        .map(|drop| {
                                            let current_minutes = drop_progress
                                                .iter()
                                                .find(|p| p.drop_id == drop.id)
                                                .map(|p| p.current_minutes_watched)
                                                .unwrap_or(0);
                                            let progress_percentage =
                                                if drop.required_minutes_watched > 0 {
                                                    (current_minutes as f32
                                                        / drop.required_minutes_watched as f32)
                                                        * 100.0
                                                } else {
                                                    0.0
                                                };
                                            (drop, current_minutes, progress_percentage)
                                        })
                                        .collect();

                                    // Sort by progress percentage descending (highest first = closest to completion)
                                    drops_with_progress.sort_by(|a, b| {
                                        b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal)
                                    });

                                    println!("📊 Sorted drops by progress (highest first):");
                                    for (drop, mins, pct) in &drops_with_progress {
                                        let name = drop
                                            .benefit_edges
                                            .first()
                                            .map(|b| b.name.as_str())
                                            .unwrap_or(&drop.name);
                                        println!(
                                            "  - {} ({}/{} mins = {:.1}%)",
                                            name, mins, drop.required_minutes_watched, pct
                                        );
                                    }

                                    // Select the drop with highest progress percentage
                                    if let Some((drop, current_minutes, progress_percentage)) =
                                        drops_with_progress.first()
                                    {
                                        let estimated_completion = if *current_minutes > 0 {
                                            let remaining_minutes =
                                                drop.required_minutes_watched - *current_minutes;
                                            Some(
                                                Utc::now()
                                                    + Duration::minutes(remaining_minutes as i64),
                                            )
                                        } else {
                                            None
                                        };

                                        // Get the actual benefit name from the drop
                                        let drop_name =
                                            if let Some(benefit) = drop.benefit_edges.first() {
                                                benefit.name.clone()
                                            } else {
                                                drop.name.clone()
                                            };

                                        // Get drop image from benefit_edges
                                        let drop_image =
                                            drop.benefit_edges.first().map(|b| b.image_url.clone());

                                        println!(
                                            "🎯 Selected HIGHEST progress drop: {} ({:.1}%)",
                                            drop_name, progress_percentage
                                        );

                                        status.current_drop = Some(CurrentDropInfo {
                                            drop_id: drop.id.clone(),
                                            drop_name,
                                            drop_image,
                                            campaign_name: campaign.name.clone(),
                                            game_name: campaign.game_name.clone(),
                                            current_minutes: *current_minutes,
                                            required_minutes: drop.required_minutes_watched,
                                            progress_percentage: *progress_percentage,
                                            estimated_completion,
                                        });
                                    }
                                } else {
                                    println!("⚠️ No active campaign found for channel");
                                }

                                drop(status);

                                println!("📡 Emitting mining status update");

                                // Emit mining status update
                                let current_status = mining_status.read().await.clone();
                                let _ = app_handle.emit("mining-status-update", &current_status);

                                println!(
                                    "⛏️ Mining drops on: {} ({})",
                                    best_channel.name, best_channel.game_name
                                );

                                // Get token and user ID for watch payloads
                                println!("🔑 Getting token for watch payloads...");
                                let token = match DropsAuthService::get_token().await {
                                    Ok(t) => {
                                        println!(
                                            "✅ Got token (first 10 chars): {}",
                                            &t[..10.min(t.len())]
                                        );
                                        t
                                    }
                                    Err(e) => {
                                        eprintln!("❌ Failed to get token: {}", e);
                                        return; // Exit the task
                                    }
                                };

                                println!("🔑 Getting user ID...");
                                let user_id = match Self::get_user_id(&client, &token).await {
                                    Ok(id) => {
                                        println!("✅ Got user ID: {}", id);
                                        id
                                    }
                                    Err(e) => {
                                        eprintln!("❌ Failed to get user ID: {}", e);
                                        return; // Exit the task
                                    }
                                };

                                // Get the actual stream/broadcast ID for this channel
                                let broadcast_id = match Self::get_broadcast_id(
                                    &client,
                                    &best_channel.id,
                                    &token,
                                )
                                .await
                                {
                                    Ok(Some(id)) => {
                                        println!("📺 Got broadcast ID: {}", id);
                                        id
                                    }
                                    Ok(None) => {
                                        println!(
                                            "⚠️ Channel {} is not live, using channel ID as fallback",
                                            best_channel.name
                                        );
                                        best_channel.id.clone()
                                    }
                                    Err(e) => {
                                        eprintln!("❌ Failed to get broadcast ID: {}", e);
                                        best_channel.id.clone()
                                    }
                                };

                                // Start watch payload loop for campaign mining
                                let client_clone = client.clone();
                                let best_channel_clone = best_channel.clone();
                                let broadcast_id_clone = broadcast_id.clone();
                                let token_clone = token.clone();
                                let is_running_clone = is_running.clone();
                                let mining_status_clone = mining_status.clone();
                                let app_handle_clone = app_handle.clone();
                                let target_campaign_clone = target_campaign.clone();
                                let settings_clone = settings.clone();
                                let eligible_channels_clone = eligible_channels.clone();
                                let cached_user_id_clone = cached_user_id.clone();
                                let cached_spade_url_clone = cached_spade_url.clone();
                                let watch_session_channel = best_channel.name.clone(); // Track this session's channel

                                tokio::spawn(async move {
                                    let mut current_channel = best_channel_clone;
                                    let mut current_broadcast_id = broadcast_id_clone;
                                    let mut interval =
                                        tokio::time::interval(tokio::time::Duration::from_secs(60));
                                    let mut consecutive_failures = 0;
                                    let mut channel_index = 0; // Track current channel index

                                    loop {
                                        // Check if still running
                                        if !*is_running_clone.read().await {
                                            println!("🛑 Stopping watch payload loop for {} (mining stopped)", watch_session_channel);
                                            break;
                                        }

                                        // Check if we're still mining this channel's game - if not, stop this loop
                                        {
                                            let status = mining_status_clone.read().await;
                                            if let Some(ref mining_channel) = status.current_channel
                                            {
                                                if mining_channel.game_name
                                                    != current_channel.game_name
                                                {
                                                    println!("🛑 Stopping watch payload loop for {} (switched to {})", 
                                                        watch_session_channel, mining_channel.game_name);
                                                    break;
                                                }
                                            }
                                        }

                                        // Send watch payload
                                        println!("📡 Sending watch payload...");
                                        match Self::send_watch_payload(
                                            &client_clone,
                                            &current_channel,
                                            &current_broadcast_id,
                                            &token_clone,
                                            &cached_user_id_clone,
                                            &cached_spade_url_clone,
                                        )
                                        .await
                                        {
                                            Ok(true) => {
                                                println!(
                                                    "✅ Watch payload sent successfully to {}",
                                                    current_channel.name
                                                );
                                                consecutive_failures = 0;

                                                // Update the last_update timestamp
                                                if let Ok(mut status) =
                                                    mining_status_clone.try_write()
                                                {
                                                    status.last_update = Utc::now();
                                                }
                                            }
                                            Ok(false) | Err(_) => {
                                                consecutive_failures += 1;
                                                println!(
                                                    "⚠️ Watch payload failed for {} (failure {}/3)",
                                                    current_channel.name, consecutive_failures
                                                );

                                                if consecutive_failures >= 3 {
                                                    println!(
                                                        "❌ Channel {} failed 3 times, attempting to switch with API refresh...",
                                                        current_channel.name
                                                    );

                                                    // Get the list of eligible channels
                                                    let channels = eligible_channels_clone
                                                        .read()
                                                        .await
                                                        .clone();

                                                    // Try to switch to another channel with API refresh fallback
                                                    match Self::try_switch_channel_with_refresh(
                                                        &client_clone,
                                                        &token_clone,
                                                        &channels,
                                                        &current_channel.id,
                                                        channel_index,
                                                        &target_campaign_clone,
                                                        &settings_clone,
                                                    )
                                                    .await
                                                    {
                                                        Some((
                                                            new_channel,
                                                            new_broadcast_id,
                                                            fresh_channels,
                                                            new_index,
                                                        )) => {
                                                            let old_channel_name =
                                                                current_channel.name.clone();
                                                            current_channel = new_channel.clone();
                                                            current_broadcast_id = new_broadcast_id;
                                                            channel_index = new_index;
                                                            consecutive_failures = 0;

                                                            // Update the cached eligible channels with fresh list
                                                            {
                                                                let mut eligible =
                                                                    eligible_channels_clone
                                                                        .write()
                                                                        .await;
                                                                *eligible = fresh_channels.clone();
                                                            }

                                                            // Clear cached spade URL when switching channels (channel-specific)
                                                            {
                                                                let mut cached =
                                                                    cached_spade_url_clone
                                                                        .write()
                                                                        .await;
                                                                *cached = None;
                                                                println!(
                                                                    "🗑️ Cleared cached spade URL on channel switch"
                                                                );
                                                            }

                                                            // Update mining status with new channel
                                                            if let Ok(mut status) =
                                                                mining_status_clone.try_write()
                                                            {
                                                                status.current_channel =
                                                                    Some(new_channel.clone());
                                                                status.eligible_channels =
                                                                    fresh_channels;
                                                                status.last_update = Utc::now();

                                                                // Update campaign if needed
                                                                if let Some(campaign) = Self::get_active_campaign_for_channel(&new_channel, &target_campaign_clone) {
                                                                        status.current_campaign = Some(campaign.name.clone());
                                                                    }

                                                                let current_status = status.clone();
                                                                drop(status);
                                                                let _ = app_handle_clone.emit(
                                                                    "mining-status-update",
                                                                    &current_status,
                                                                );
                                                                let _ = app_handle_clone.emit("channel-switched", json!({
                                                                        "from": old_channel_name,
                                                                        "to": new_channel.name,
                                                                        "reason": "offline_or_errors"
                                                                    }));
                                                            }

                                                            println!(
                                                                "✅ Successfully switched to {}",
                                                                new_channel.name
                                                            );
                                                        }
                                                        None => {
                                                            println!(
                                                                "❌ No channels available after API refresh, stopping mining"
                                                            );

                                                            // Stop mining and notify user
                                                            Self::stop_mining_no_channels(
                                                                &is_running_clone,
                                                                &mining_status_clone,
                                                                &app_handle_clone,
                                                                "All streams for this campaign are offline. Mining has been stopped.",
                                                            ).await;

                                                            break;
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        // Wait for next interval
                                        interval.tick().await;
                                    }
                                });

                                // Start periodic inventory polling (fallback since WebSocket drops progress is unreliable)
                                let drops_service_poll = drops_service.clone();
                                let mining_status_poll = mining_status.clone();
                                let app_handle_poll = app_handle.clone();
                                let is_running_poll = is_running.clone();
                                // Get the game name AND campaign name from the target campaign for filtering
                                // We need to filter by SPECIFIC campaign, not just game!
                                let game_name_poll = target_campaign
                                    .first()
                                    .map(|c| c.game_name.clone())
                                    .unwrap_or_default();
                                let campaign_name_poll = target_campaign
                                    .first()
                                    .map(|c| c.name.clone())
                                    .unwrap_or_default();
                                let game_name_session = game_name_poll.clone(); // Track this session's game
                                let campaign_name_session = campaign_name_poll.clone(); // Track this session's specific campaign

                                // Get auto_mining_enabled setting to decide if we should continue after completion
                                let auto_mining_enabled_poll = settings.auto_mining_enabled;

                                tokio::spawn(async move {
                                    let mut poll_interval =
                                        tokio::time::interval(tokio::time::Duration::from_secs(60)); // Poll every minute
                                    poll_interval.tick().await; // Skip first immediate tick

                                    loop {
                                        if !*is_running_poll.read().await {
                                            println!("🛑 Stopping inventory polling loop for {} (mining stopped)", game_name_session);
                                            break;
                                        }

                                        // Check if we're still mining the same game - if not, stop this polling loop
                                        // This handles the case where a new mining session started for a different game
                                        {
                                            let status = mining_status_poll.read().await;
                                            if let Some(ref channel) = status.current_channel {
                                                if channel.game_name != game_name_session {
                                                    println!("🛑 Stopping inventory polling loop for {} (switched to {})", 
                                                        game_name_session, channel.game_name);
                                                    break;
                                                }
                                            }
                                        }

                                        println!(
                                            "📊 Polling inventory for drops progress (campaign: {}, game: {})...",
                                            campaign_name_poll, game_name_poll
                                        );
                                        match drops_service_poll
                                            .lock()
                                            .await
                                            .fetch_inventory()
                                            .await
                                        {
                                            Ok(inventory) => {
                                                // SPECIFIC CAMPAIGN TRACKING: Only track drops from the campaign the user clicked on
                                                // This ensures we show progress for the exact campaign they selected
                                                let mut all_drops_with_progress: Vec<(
                                                    String, // drop_id
                                                    String, // drop_name
                                                    String, // drop_image
                                                    String, // campaign_name
                                                    String, // game_name
                                                    i32,    // current_minutes
                                                    i32,    // required_minutes
                                                    f32,    // progress_percentage
                                                )> = Vec::new();

                                                for item in &inventory.items {
                                                    // Filter by SPECIFIC CAMPAIGN - only show drops from the campaign user clicked on
                                                    // First check game matches, then check campaign name matches
                                                    if item.campaign.game_name != game_name_poll {
                                                        continue;
                                                    }

                                                    // IMPORTANT: Filter by specific campaign name, not just game!
                                                    if item.campaign.name != campaign_name_poll {
                                                        println!(
                                                            "📊 Skipping campaign {} (mining specific campaign: {})",
                                                            item.campaign.name, campaign_name_poll
                                                        );
                                                        continue;
                                                    }

                                                    println!(
                                                        "📊 Found target campaign for {}: {}",
                                                        item.campaign.game_name, item.campaign.name
                                                    );

                                                    for time_drop in &item.campaign.time_based_drops
                                                    {
                                                        if let Some(progress) = &time_drop.progress
                                                        {
                                                            let current_minutes =
                                                                progress.current_minutes_watched;
                                                            let required_minutes =
                                                                time_drop.required_minutes_watched;

                                                            // Skip drops that are already complete (100%+)
                                                            if current_minutes >= required_minutes {
                                                                continue;
                                                            }

                                                            // Get drop name and image from benefit_edges
                                                            let (drop_name, drop_image) =
                                                                if let Some(benefit) =
                                                                    time_drop.benefit_edges.first()
                                                                {
                                                                    println!("  🖼️ Found benefit: {} with image: {}", benefit.name, if benefit.image_url.is_empty() { "(empty)" } else { &benefit.image_url });
                                                                    (
                                                                        benefit.name.clone(),
                                                                        benefit.image_url.clone(),
                                                                    )
                                                                } else {
                                                                    println!("  ⚠️ No benefit_edges for drop {}, using drop.name: {}", time_drop.id, time_drop.name);
                                                                    (
                                                                        time_drop.name.clone(),
                                                                        String::new(),
                                                                    )
                                                                };

                                                            let progress_percentage =
                                                                if required_minutes > 0 {
                                                                    (current_minutes as f32
                                                                        / required_minutes as f32)
                                                                        * 100.0
                                                                } else {
                                                                    0.0
                                                                };

                                                            println!("📊 Inventory poll: {}/{} minutes for {} ({}) [{:.1}%]", 
                                                                current_minutes, required_minutes, drop_name, time_drop.id, progress_percentage);

                                                            all_drops_with_progress.push((
                                                                time_drop.id.clone(),
                                                                drop_name,
                                                                drop_image,
                                                                item.campaign.name.clone(),
                                                                item.campaign.game_name.clone(),
                                                                current_minutes,
                                                                required_minutes,
                                                                progress_percentage,
                                                            ));
                                                        }
                                                    }
                                                }

                                                // Sort by progress percentage (highest first) to show the drop closest to completion
                                                all_drops_with_progress.sort_by(|a, b| {
                                                    b.7.partial_cmp(&a.7)
                                                        .unwrap_or(std::cmp::Ordering::Equal)
                                                });

                                                // Update current_drop with the drop that has the highest progress
                                                if let Some((
                                                    drop_id,
                                                    drop_name,
                                                    drop_image,
                                                    campaign_name,
                                                    game_name,
                                                    current_minutes,
                                                    required_minutes,
                                                    progress_percentage,
                                                )) = all_drops_with_progress.first()
                                                {
                                                    let mut status =
                                                        mining_status_poll.write().await;

                                                    // Check if we should update (different drop or higher progress)
                                                    let should_update =
                                                        if let Some(ref current_drop) =
                                                            status.current_drop
                                                        {
                                                            // Always update if this is a different drop with higher progress
                                                            // Or if it's the same drop (progress update)
                                                            current_drop.drop_id != *drop_id
                                                                || current_drop.current_minutes
                                                                    != *current_minutes
                                                        } else {
                                                            true // No current drop set
                                                        };

                                                    if should_update {
                                                        let estimated_completion =
                                                            if *current_minutes > 0
                                                                && *current_minutes
                                                                    < *required_minutes
                                                            {
                                                                let remaining = *required_minutes
                                                                    - *current_minutes;
                                                                Some(
                                                                    chrono::Utc::now()
                                                                        + chrono::Duration::minutes(
                                                                            remaining as i64,
                                                                        ),
                                                                )
                                                            } else {
                                                                None
                                                            };

                                                        let drop_image_opt =
                                                            if drop_image.is_empty() {
                                                                None
                                                            } else {
                                                                Some(drop_image.clone())
                                                            };

                                                        status.current_drop =
                                                            Some(CurrentDropInfo {
                                                                drop_id: drop_id.clone(),
                                                                drop_name: drop_name.clone(),
                                                                drop_image: drop_image_opt,
                                                                campaign_name: campaign_name
                                                                    .clone(),
                                                                game_name: game_name.clone(),
                                                                current_minutes: *current_minutes,
                                                                required_minutes: *required_minutes,
                                                                progress_percentage:
                                                                    *progress_percentage,
                                                                estimated_completion,
                                                            });
                                                        status.last_update = chrono::Utc::now();

                                                        println!("✅ [Inventory] Set current_drop to HIGHEST progress: {} ({}/{} = {:.1}%)", 
                                                            drop_name, current_minutes, required_minutes, progress_percentage);

                                                        // Emit mining status update to frontend
                                                        let current_status = status.clone();
                                                        std::mem::drop(status);
                                                        let _ = app_handle_poll.emit(
                                                            "mining-status-update",
                                                            &current_status,
                                                        );
                                                    } else {
                                                        std::mem::drop(status);
                                                    }
                                                }

                                                // Emit progress update events for ALL drops (for frontend tracking)
                                                for (
                                                    drop_id,
                                                    drop_name,
                                                    drop_image,
                                                    campaign_name,
                                                    game_name,
                                                    current_minutes,
                                                    required_minutes,
                                                    _,
                                                ) in &all_drops_with_progress
                                                {
                                                    let _ = app_handle_poll.emit("drops-progress-update", serde_json::json!({
                                                        "drop_id": drop_id,
                                                        "drop_name": drop_name,
                                                        "drop_image": drop_image,
                                                        "campaign_name": campaign_name,
                                                        "game_name": game_name,
                                                        "current_minutes": current_minutes,
                                                        "required_minutes": required_minutes,
                                                        "timestamp": chrono::Utc::now().to_rfc3339()
                                                    }));
                                                }

                                                // ================================================
                                                // DROP COMPLETION DETECTION (Campaign Mining)
                                                // ================================================
                                                // If all_drops_with_progress is empty, it means all drops for this game are complete (100%)
                                                //
                                                // For start_campaign_mining (single campaign or Mine All Game queue):
                                                // - ALWAYS stop and emit completion event
                                                // - The FRONTEND decides whether to start the next campaign (if there's a Mine All queue)
                                                // - This handles both single campaign (stop) and Mine All Game (frontend starts next)
                                                //
                                                // For start_mining (auto-mining mode), it has its own loop that continues globally.
                                                if all_drops_with_progress.is_empty() {
                                                    println!("🎉 All drops for campaign '{}' ({}) are complete (100%)!", campaign_name_session, game_name_session);
                                                    println!("🛑 Campaign mining complete - stopping and notifying frontend");

                                                    // Set running to false to stop all loops for this campaign
                                                    {
                                                        let mut running =
                                                            is_running_poll.write().await;
                                                        *running = false;
                                                    }

                                                    // Clear mining status
                                                    {
                                                        let mut status =
                                                            mining_status_poll.write().await;
                                                        status.is_mining = false;
                                                        status.current_channel = None;
                                                        status.current_campaign = None;
                                                        status.current_drop = None;
                                                        status.eligible_channels = Vec::new();
                                                        status.last_update = chrono::Utc::now();
                                                    }

                                                    // Emit status update to clear the UI
                                                    let current_status =
                                                        mining_status_poll.read().await.clone();
                                                    let _ = app_handle_poll.emit(
                                                        "mining-status-update",
                                                        &current_status,
                                                    );

                                                    // Emit completion event - frontend decides whether to start next campaign
                                                    // (if there's a Mine All queue) or stay stopped (single campaign)
                                                    let _ = app_handle_poll.emit("mining-complete", serde_json::json!({
                                                        "game_name": game_name_session,
                                                        "campaign_name": campaign_name_session,
                                                        "reason": format!("All drops for '{}' are complete (100%)", campaign_name_session),
                                                        "timestamp": chrono::Utc::now().to_rfc3339()
                                                    }));

                                                    println!("✅ Campaign '{}' mining complete - frontend will handle next steps", campaign_name_session);
                                                    break; // Exit the polling loop
                                                }
                                            }
                                            Err(e) => {
                                                eprintln!("⚠️ Failed to poll inventory: {}", e);
                                            }
                                        }

                                        poll_interval.tick().await;
                                    }
                                });

                                // Connect WebSocket AFTER status is fully populated (may provide faster updates if working)
                                println!(
                                    "🔌 Connecting WebSocket for drops updates (AFTER status populated)..."
                                );
                                let websocket_service =
                                    Arc::new(tokio::sync::Mutex::new(DropsWebSocketService::new()));
                                let mut ws_service = websocket_service.lock().await;
                                if let Err(e) = ws_service
                                    .connect(&user_id, &token, app_handle.clone())
                                    .await
                                {
                                    eprintln!("❌ Failed to connect WebSocket: {}", e);
                                }
                                drop(ws_service);
                            } else {
                                println!("⚠️ No eligible channels found for this campaign");
                                let mut status = mining_status.write().await;
                                status.is_mining = false;
                                status.current_channel = None;
                                status.current_campaign = None;
                                status.current_drop = None;
                            }
                        }
                        Err(e) => {
                            eprintln!("❌ Failed to discover eligible channels: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("❌ Failed to fetch campaigns: {}", e);
                }
            }

            // Keep the mining running until stopped
            loop {
                let should_continue = *is_running.read().await;
                if !should_continue {
                    println!("🛑 Stopping campaign mining");
                    break;
                }
                // Just sleep and let the periodic task handle refreshes
                tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
            }

            // Clean up when stopping
            let mut status = mining_status.write().await;
            status.is_mining = false;
            status.current_channel = None;
            status.current_campaign = None;
            status.current_drop = None;
        });

        Ok(())
    }

    /// Start the automated mining process (cycles through all eligible campaigns)
    /// OPTIMIZED: Finds FIRST available live channel quickly instead of gathering all channels
    pub async fn start_mining(&self, app_handle: AppHandle) -> Result<()> {
        // Check if already running
        {
            let mut is_running = self.is_running.write().await;
            if *is_running {
                return Ok(());
            }
            *is_running = true;
        }

        // Set up WebSocket event listener (only once)
        self.setup_websocket_listener(&app_handle).await;

        // Clone Arc references for the background task
        let client = self.client.clone();
        let drops_service = self.drops_service.clone();
        let mining_status = self.mining_status.clone();
        let eligible_channels = self.eligible_channels.clone();
        let is_running = self.is_running.clone();
        let cached_user_id = self.cached_user_id.clone();
        let cached_spade_url = self.cached_spade_url.clone();

        // Spawn the mining loop
        tokio::spawn(async move {
            println!(
                "🎮 Starting automated drops mining (optimized - finds first available channel)"
            );

            loop {
                // Check if mining should continue
                let should_continue = *is_running.read().await;
                if !should_continue {
                    println!("🛑 Stopping automated mining");
                    break;
                }

                // Get current settings
                let settings = drops_service.lock().await.get_settings().await;

                if !settings.auto_mining_enabled {
                    println!("⏸️ Auto-mining is disabled in settings");
                    tokio::time::sleep(tokio::time::Duration::from_secs(30)).await;
                    continue;
                }

                // Fetch campaigns outside of the main lock
                let campaigns_result = {
                    let service = drops_service.lock().await;
                    service.fetch_all_active_campaigns_from_api().await
                };

                match campaigns_result {
                    Ok(all_campaigns) => {
                        // Now, lock the service to update progress and get filtered campaigns
                        let (campaigns, settings) = {
                            let service = drops_service.lock().await;
                            service.update_campaigns_and_progress(&all_campaigns).await;
                            let settings = service.get_settings().await;

                            // Apply filters
                            let filtered = all_campaigns
                                .into_iter()
                                .filter(|c| {
                                    !settings.excluded_games.contains(&c.game_name)
                                        && (settings.priority_mode != PriorityMode::PriorityOnly
                                            || settings.priority_games.is_empty()
                                            || settings.priority_games.contains(&c.game_name))
                                })
                                .collect::<Vec<_>>();
                            (filtered, settings)
                        };

                        // OPTIMIZED: Find FIRST available channel quickly instead of gathering all
                        match Self::find_first_eligible_channel(&client, &campaigns, &settings)
                            .await
                        {
                            Ok(Some((best_channel, campaign))) => {
                                // Store just this channel as the eligible one
                                {
                                    let mut eligible = eligible_channels.write().await;
                                    *eligible = vec![best_channel.clone()];
                                }

                                // Update mining status
                                let mut status = mining_status.write().await;
                                status.is_mining = true;
                                status.current_channel = Some(best_channel.clone());
                                status.eligible_channels = vec![best_channel.clone()];
                                status.last_update = Utc::now();
                                status.current_campaign = Some(campaign.name.clone());

                                // Find the current drop being progressed
                                if let Some(drop) = campaign.time_based_drops.first() {
                                    let drop_progress =
                                        drops_service.lock().await.get_drop_progress().await;
                                    let current_minutes = drop_progress
                                        .iter()
                                        .find(|p| p.drop_id == drop.id)
                                        .map(|p| p.current_minutes_watched)
                                        .unwrap_or(0);

                                    let progress_percentage = (current_minutes as f32
                                        / drop.required_minutes_watched as f32)
                                        * 100.0;

                                    let estimated_completion = if current_minutes > 0 {
                                        let remaining_minutes =
                                            drop.required_minutes_watched - current_minutes;
                                        Some(
                                            Utc::now()
                                                + Duration::minutes(remaining_minutes as i64),
                                        )
                                    } else {
                                        None
                                    };

                                    // Get drop image from benefit_edges
                                    let drop_image =
                                        drop.benefit_edges.first().map(|b| b.image_url.clone());

                                    status.current_drop = Some(CurrentDropInfo {
                                        drop_id: drop.id.clone(),
                                        drop_name: drop.name.clone(),
                                        drop_image,
                                        campaign_name: campaign.name.clone(),
                                        game_name: campaign.game_name.clone(),
                                        current_minutes,
                                        required_minutes: drop.required_minutes_watched,
                                        progress_percentage,
                                        estimated_completion,
                                    });
                                }

                                drop(status);

                                // Emit mining status update
                                let current_status = mining_status.read().await.clone();
                                let _ = app_handle.emit("mining-status-update", &current_status);

                                // Start monitoring this channel
                                drops_service
                                    .lock()
                                    .await
                                    .update_current_channel(
                                        best_channel.id.clone(),
                                        best_channel.name.clone(),
                                    )
                                    .await;

                                println!(
                                    "⛏️ Mining drops on: {} ({}) - Campaign: {}",
                                    best_channel.name, best_channel.game_name, campaign.name
                                );

                                // Get token and user ID
                                let token = match DropsAuthService::get_token().await {
                                    Ok(t) => t,
                                    Err(e) => {
                                        eprintln!("❌ Failed to get token: {}", e);
                                        continue;
                                    }
                                };

                                let user_id = match Self::get_user_id(&client, &token).await {
                                    Ok(id) => id,
                                    Err(e) => {
                                        eprintln!("❌ Failed to get user ID: {}", e);
                                        continue;
                                    }
                                };

                                // Connect WebSocket for real-time drops updates
                                println!("🔌 Connecting WebSocket for drops updates...");
                                let websocket_service =
                                    Arc::new(tokio::sync::Mutex::new(DropsWebSocketService::new()));
                                let mut ws_service = websocket_service.lock().await;
                                if let Err(e) = ws_service
                                    .connect(&user_id, &token, app_handle.clone())
                                    .await
                                {
                                    eprintln!("❌ Failed to connect WebSocket: {}", e);
                                }
                                drop(ws_service);

                                // Get the actual stream/broadcast ID for this channel
                                let broadcast_id = match Self::get_broadcast_id(
                                    &client,
                                    &best_channel.id,
                                    &token,
                                )
                                .await
                                {
                                    Ok(Some(id)) => {
                                        println!("📺 Got broadcast ID: {}", id);
                                        id
                                    }
                                    Ok(None) => {
                                        println!(
                                            "⚠️ Channel {} is not live, using channel ID as fallback",
                                            best_channel.name
                                        );
                                        best_channel.id.clone()
                                    }
                                    Err(e) => {
                                        eprintln!("❌ Failed to get broadcast ID: {}", e);
                                        best_channel.id.clone()
                                    }
                                };

                                // Start watch payload loop
                                let client_clone = client.clone();
                                let best_channel_clone = best_channel.clone();
                                let broadcast_id_clone = broadcast_id.clone();
                                let token_clone = token.clone();
                                let is_running_clone = is_running.clone();
                                let cached_user_id_clone = cached_user_id.clone();
                                let cached_spade_url_clone = cached_spade_url.clone();

                                tokio::spawn(async move {
                                    let mut interval =
                                        tokio::time::interval(tokio::time::Duration::from_secs(60));
                                    loop {
                                        // Check if still running
                                        if !*is_running_clone.read().await {
                                            println!("🛑 Stopping watch payload loop");
                                            break;
                                        }

                                        // Send watch payload
                                        println!("📡 Sending watch payload...");
                                        match Self::send_watch_payload(
                                            &client_clone,
                                            &best_channel_clone,
                                            &broadcast_id_clone,
                                            &token_clone,
                                            &cached_user_id_clone,
                                            &cached_spade_url_clone,
                                        )
                                        .await
                                        {
                                            Ok(true) => {
                                                println!("✅ Watch payload sent successfully")
                                            }
                                            Ok(false) => println!("⚠️ Watch payload failed"),
                                            Err(e) => {
                                                eprintln!("❌ Failed to send watch payload: {}", e)
                                            }
                                        }

                                        // Wait for next interval
                                        interval.tick().await;
                                    }
                                });

                                // Start periodic inventory polling for automated mining (fallback since WebSocket drops progress is unreliable)
                                let drops_service_poll = drops_service.clone();
                                let mining_status_poll = mining_status.clone();
                                let app_handle_poll = app_handle.clone();
                                let is_running_poll = is_running.clone();
                                let game_name_poll = campaign.game_name.clone();
                                let campaign_name_poll = campaign.name.clone();
                                let game_name_session = game_name_poll.clone();
                                let campaign_name_session = campaign_name_poll.clone();

                                tokio::spawn(async move {
                                    let mut poll_interval =
                                        tokio::time::interval(tokio::time::Duration::from_secs(60)); // Poll every minute
                                    poll_interval.tick().await; // Skip first immediate tick

                                    loop {
                                        if !*is_running_poll.read().await {
                                            println!("🛑 Stopping inventory polling loop for auto-mining {} (mining stopped)", game_name_session);
                                            break;
                                        }

                                        // Check if we're still mining the same game
                                        {
                                            let status = mining_status_poll.read().await;
                                            if let Some(ref channel) = status.current_channel {
                                                if channel.game_name != game_name_session {
                                                    println!("🛑 Stopping inventory polling loop for {} (auto-mining switched to {})", 
                                                        game_name_session, channel.game_name);
                                                    break;
                                                }
                                            }
                                        }

                                        println!(
                                            "📊 [Auto-Mining] Polling inventory for drops progress (campaign: {}, game: {})...",
                                            campaign_name_poll, game_name_poll
                                        );
                                        match drops_service_poll
                                            .lock()
                                            .await
                                            .fetch_inventory()
                                            .await
                                        {
                                            Ok(inventory) => {
                                                let mut all_drops_with_progress: Vec<(
                                                    String,
                                                    String,
                                                    String,
                                                    String,
                                                    String,
                                                    i32,
                                                    i32,
                                                    f32,
                                                )> = Vec::new();

                                                for item in &inventory.items {
                                                    // For auto-mining, filter by current game
                                                    if item.campaign.game_name != game_name_poll {
                                                        continue;
                                                    }

                                                    println!(
                                                        "📊 [Auto-Mining] Found campaign for {}: {}",
                                                        item.campaign.game_name, item.campaign.name
                                                    );

                                                    for time_drop in &item.campaign.time_based_drops
                                                    {
                                                        if let Some(progress) = &time_drop.progress
                                                        {
                                                            let current_minutes =
                                                                progress.current_minutes_watched;
                                                            let required_minutes =
                                                                time_drop.required_minutes_watched;

                                                            if current_minutes >= required_minutes {
                                                                continue;
                                                            }

                                                            let (drop_name, drop_image) =
                                                                if let Some(benefit) =
                                                                    time_drop.benefit_edges.first()
                                                                {
                                                                    (
                                                                        benefit.name.clone(),
                                                                        benefit.image_url.clone(),
                                                                    )
                                                                } else {
                                                                    (
                                                                        time_drop.name.clone(),
                                                                        String::new(),
                                                                    )
                                                                };

                                                            let progress_percentage =
                                                                if required_minutes > 0 {
                                                                    (current_minutes as f32
                                                                        / required_minutes as f32)
                                                                        * 100.0
                                                                } else {
                                                                    0.0
                                                                };

                                                            println!("📊 [Auto-Mining] Inventory poll: {}/{} minutes for {} ({}) [{:.1}%]", 
                                                                current_minutes, required_minutes, drop_name, time_drop.id, progress_percentage);

                                                            all_drops_with_progress.push((
                                                                time_drop.id.clone(),
                                                                drop_name,
                                                                drop_image,
                                                                item.campaign.name.clone(),
                                                                item.campaign.game_name.clone(),
                                                                current_minutes,
                                                                required_minutes,
                                                                progress_percentage,
                                                            ));
                                                        }
                                                    }
                                                }

                                                all_drops_with_progress.sort_by(|a, b| {
                                                    b.7.partial_cmp(&a.7)
                                                        .unwrap_or(std::cmp::Ordering::Equal)
                                                });

                                                if let Some((
                                                    drop_id,
                                                    drop_name,
                                                    drop_image,
                                                    campaign_name,
                                                    game_name,
                                                    current_minutes,
                                                    required_minutes,
                                                    progress_percentage,
                                                )) = all_drops_with_progress.first()
                                                {
                                                    let mut status =
                                                        mining_status_poll.write().await;

                                                    let should_update =
                                                        if let Some(ref current_drop) =
                                                            status.current_drop
                                                        {
                                                            current_drop.drop_id != *drop_id
                                                                || current_drop.current_minutes
                                                                    != *current_minutes
                                                        } else {
                                                            true
                                                        };

                                                    if should_update {
                                                        let estimated_completion =
                                                            if *current_minutes > 0
                                                                && *current_minutes
                                                                    < *required_minutes
                                                            {
                                                                let remaining = *required_minutes
                                                                    - *current_minutes;
                                                                Some(
                                                                    chrono::Utc::now()
                                                                        + chrono::Duration::minutes(
                                                                            remaining as i64,
                                                                        ),
                                                                )
                                                            } else {
                                                                None
                                                            };

                                                        let drop_image_opt =
                                                            if drop_image.is_empty() {
                                                                None
                                                            } else {
                                                                Some(drop_image.clone())
                                                            };

                                                        status.current_drop =
                                                            Some(CurrentDropInfo {
                                                                drop_id: drop_id.clone(),
                                                                drop_name: drop_name.clone(),
                                                                drop_image: drop_image_opt,
                                                                campaign_name: campaign_name
                                                                    .clone(),
                                                                game_name: game_name.clone(),
                                                                current_minutes: *current_minutes,
                                                                required_minutes: *required_minutes,
                                                                progress_percentage:
                                                                    *progress_percentage,
                                                                estimated_completion,
                                                            });
                                                        status.last_update = chrono::Utc::now();

                                                        println!("✅ [Auto-Mining] Set current_drop to HIGHEST progress: {} ({}/{} = {:.1}%)", 
                                                            drop_name, current_minutes, required_minutes, progress_percentage);

                                                        let current_status = status.clone();
                                                        std::mem::drop(status);
                                                        let _ = app_handle_poll.emit(
                                                            "mining-status-update",
                                                            &current_status,
                                                        );
                                                    } else {
                                                        std::mem::drop(status);
                                                    }
                                                }

                                                // Emit progress update events for ALL drops
                                                for (
                                                    drop_id,
                                                    drop_name,
                                                    drop_image,
                                                    campaign_name,
                                                    game_name,
                                                    current_minutes,
                                                    required_minutes,
                                                    _,
                                                ) in &all_drops_with_progress
                                                {
                                                    let _ = app_handle_poll.emit("drops-progress-update", serde_json::json!({
                                                        "drop_id": drop_id,
                                                        "drop_name": drop_name,
                                                        "drop_image": drop_image,
                                                        "campaign_name": campaign_name,
                                                        "game_name": game_name,
                                                        "current_minutes": current_minutes,
                                                        "required_minutes": required_minutes,
                                                        "timestamp": chrono::Utc::now().to_rfc3339()
                                                    }));
                                                }
                                            }
                                            Err(e) => {
                                                eprintln!(
                                                    "⚠️ [Auto-Mining] Failed to poll inventory: {}",
                                                    e
                                                );
                                            }
                                        }

                                        poll_interval.tick().await;
                                    }
                                });
                            }
                            Ok(None) => {
                                println!("⚠️ No eligible channels found for mining");
                                let mut status = mining_status.write().await;
                                status.is_mining = false;
                                status.current_channel = None;
                                status.current_campaign = None;
                                status.current_drop = None;
                            }
                            Err(e) => {
                                eprintln!("❌ Failed to find eligible channel: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("❌ Failed to fetch campaigns: {}", e);
                    }
                }

                // Wait before checking if we need to re-select a channel
                // This should be much longer than the watch payload interval
                // Only re-evaluate channel selection every 5 minutes or if something goes wrong
                tokio::time::sleep(tokio::time::Duration::from_secs(300)).await;
            }

            // Clean up when stopping
            let mut status = mining_status.write().await;
            status.is_mining = false;
            status.current_channel = None;
            status.current_campaign = None;
            status.current_drop = None;
        });

        Ok(())
    }

    /// Stop the automated mining process
    pub async fn stop_mining(&self, app_handle: AppHandle) {
        let mut is_running = self.is_running.write().await;
        *is_running = false;

        // Disconnect WebSocket
        self.websocket_service.lock().await.disconnect().await;

        // Clean up event listener
        {
            let mut listener_id = self.event_listener_id.write().await;
            if let Some(id) = listener_id.take() {
                app_handle.unlisten(id);
                println!("🗑️ Cleaned up WebSocket event listener");
            }
        }

        // Clear cached user ID when stopping
        {
            let mut cached_id = self.cached_user_id.write().await;
            *cached_id = None;
            println!("🗑️ Cleared cached user ID on mining stop");
        }

        let mut status = self.mining_status.write().await;
        status.is_mining = false;
        status.current_channel = None;
        status.current_campaign = None;
        status.current_drop = None;
        status.eligible_channels = Vec::new();
        status.last_update = Utc::now();

        // Emit the updated status to the UI
        let current_status = status.clone();
        drop(status); // Release the lock before emitting
        let _ = app_handle.emit("mining-status-update", &current_status);
    }

    /// OPTIMIZED: Find the FIRST live channel for auto-mining
    /// Returns as soon as a live channel is found - much more efficient than gathering all channels
    /// Returns the channel and its associated campaign
    async fn find_first_eligible_channel(
        client: &Client,
        campaigns: &[DropCampaign],
        settings: &DropsSettings,
    ) -> Result<Option<(MiningChannel, DropCampaign)>> {
        let token = DropsAuthService::get_token().await?;
        let now = Utc::now();

        println!(
            "🚀 Fast channel discovery: finding FIRST live channel from {} campaigns",
            campaigns.len()
        );

        // Sort campaigns by priority if applicable
        let mut sorted_campaigns = campaigns.to_vec();
        if !settings.priority_games.is_empty() {
            sorted_campaigns.sort_by(|a, b| {
                let a_priority = settings
                    .priority_games
                    .iter()
                    .position(|g| g == &a.game_name);
                let b_priority = settings
                    .priority_games
                    .iter()
                    .position(|g| g == &b.game_name);
                match (a_priority, b_priority) {
                    (Some(a_idx), Some(b_idx)) => a_idx.cmp(&b_idx),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                }
            });
        }

        for campaign in &sorted_campaigns {
            // Skip excluded games
            if settings.excluded_games.contains(&campaign.game_name) {
                continue;
            }

            // Skip if priority mode is PriorityOnly and game is not in priority list
            if settings.priority_mode == PriorityMode::PriorityOnly
                && !settings.priority_games.is_empty()
                && !settings.priority_games.contains(&campaign.game_name)
            {
                continue;
            }

            // Check if campaign is active
            if campaign.start_at > now || campaign.end_at < now {
                continue;
            }

            println!(
                "  🔍 Checking campaign: {} ({})",
                campaign.name, campaign.game_name
            );

            // If campaign has ACL channels, check those first (they're required for drops)
            if campaign.is_acl_based && !campaign.allowed_channels.is_empty() {
                println!(
                    "    🔒 ACL campaign - checking {} allowed channels",
                    campaign.allowed_channels.len()
                );

                for allowed_channel in &campaign.allowed_channels {
                    match Self::check_channel_status(client, &allowed_channel.id, &token).await {
                        Ok(Some(channel_info)) => {
                            println!(
                                "    ✅ Found live ACL channel: {} ({} viewers)",
                                allowed_channel.name, channel_info.viewers
                            );
                            return Ok(Some((
                                MiningChannel {
                                    id: allowed_channel.id.clone(),
                                    name: allowed_channel.name.clone(),
                                    game_id: campaign.game_id.clone(),
                                    game_name: campaign.game_name.clone(),
                                    viewers: channel_info.viewers,
                                    drops_enabled: channel_info.drops_enabled,
                                    is_online: channel_info.is_online,
                                    is_acl_based: true,
                                },
                                campaign.clone(),
                            )));
                        }
                        Ok(None) => {
                            // Offline - continue checking
                        }
                        Err(_) => {
                            // Error - continue checking
                        }
                    }
                }
            } else {
                // Non-ACL campaign - fetch ONE stream from the game with drops enabled
                println!("    🌐 Non-ACL campaign - fetching live stream");
                match Self::fetch_first_live_stream_for_game(
                    client,
                    &campaign.game_id,
                    &campaign.game_name,
                    &token,
                )
                .await
                {
                    Ok(Some(channel)) => {
                        println!(
                            "    ✅ Found live channel: {} ({} viewers)",
                            channel.name, channel.viewers
                        );
                        return Ok(Some((channel, campaign.clone())));
                    }
                    Ok(None) => {
                        println!("    ⚫ No live drops-enabled streams for this game");
                    }
                    Err(e) => {
                        eprintln!("    ❌ Error fetching streams: {}", e);
                    }
                }
            }
        }

        println!("  ❌ No live channels found in any campaign");
        Ok(None)
    }

    /// Fetch just ONE live stream for a game (optimized for quick discovery)
    async fn fetch_first_live_stream_for_game(
        client: &Client,
        game_id: &str,
        game_name: &str,
        token: &str,
    ) -> Result<Option<MiningChannel>> {
        let query = r#"
        query GameStreams($gameID: ID!, $first: Int!) {
            game(id: $gameID) {
                streams(first: $first, options: {systemFilters: [DROPS_ENABLED]}) {
                    edges {
                        node {
                            id
                            broadcaster {
                                id
                                login
                                displayName
                            }
                            viewersCount
                        }
                    }
                }
            }
        }
        "#;

        let response = client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", CLIENT_ID)
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({
                "query": query,
                "variables": {
                    "gameID": game_id,
                    "first": 1  // Only fetch 1 stream - we just need to know if any are live
                }
            }))
            .send()
            .await?;

        let result: serde_json::Value = response.json().await?;

        if let Some(edges) = result["data"]["game"]["streams"]["edges"].as_array() {
            if let Some(edge) = edges.first() {
                if let Some(node) = edge["node"].as_object() {
                    if let Some(broadcaster) = node["broadcaster"].as_object() {
                        return Ok(Some(MiningChannel {
                            id: broadcaster["id"].as_str().unwrap_or("").to_string(),
                            name: broadcaster["login"].as_str().unwrap_or("").to_string(),
                            game_id: game_id.to_string(),
                            game_name: game_name.to_string(),
                            viewers: node["viewersCount"].as_i64().unwrap_or(0) as i32,
                            drops_enabled: true,
                            is_online: true,
                            is_acl_based: false,
                        }));
                    }
                }
            }
        }

        Ok(None)
    }

    /// Discover channels eligible for drops mining (collects multiple channels for fallback)
    /// Use `find_first_eligible_channel` for auto-mining where you just need ONE channel quickly
    async fn discover_eligible_channels_internal(
        client: &Client,
        campaigns: &[DropCampaign],
        settings: &DropsSettings,
    ) -> Result<Vec<MiningChannel>> {
        let mut eligible_channels = Vec::new();
        let token = DropsAuthService::get_token().await?;

        // Maximum number of live channels we need per campaign
        const MAX_LIVE_CHANNELS_PER_CAMPAIGN: usize = 10;

        println!(
            "🔍 Discovering eligible channels from {} campaigns",
            campaigns.len()
        );
        println!("📋 Priority mode: {:?}", settings.priority_mode);
        println!("🎯 Priority games: {:?}", settings.priority_games);
        println!("🚫 Excluded games: {:?}", settings.excluded_games);

        for campaign in campaigns {
            println!(
                "\n📦 Checking campaign: {} ({})",
                campaign.name, campaign.game_name
            );

            // Skip excluded games
            if settings.excluded_games.contains(&campaign.game_name) {
                println!("  ⛔ Skipped: Game is in excluded list");
                continue;
            }

            // Skip if priority mode is PriorityOnly and game is not in priority list
            // BUT: If priority list is empty, allow all games
            if settings.priority_mode == PriorityMode::PriorityOnly
                && !settings.priority_games.is_empty()
                && !settings.priority_games.contains(&campaign.game_name)
            {
                println!("  ⛔ Skipped: Game not in priority list (PriorityOnly mode)");
                continue;
            }

            // Check if campaign is active (not upcoming or expired)
            let now = Utc::now();
            if campaign.start_at > now {
                println!("  ⏰ Skipped: Campaign hasn't started yet");
                continue;
            }
            if campaign.end_at < now {
                println!("  ⏰ Skipped: Campaign has ended");
                continue;
            }

            println!("  ✅ Campaign is active and eligible");

            // If campaign has ACL channels, use those
            if campaign.is_acl_based && !campaign.allowed_channels.is_empty() {
                println!(
                    "  🔒 Campaign has {} ACL-restricted channels (checking until we find {} live)",
                    campaign.allowed_channels.len(),
                    MAX_LIVE_CHANNELS_PER_CAMPAIGN
                );

                // Track how many live channels we've found for this campaign
                let mut live_channels_found = 0;

                for allowed_channel in &campaign.allowed_channels {
                    // Stop once we have enough live channels for this campaign
                    if live_channels_found >= MAX_LIVE_CHANNELS_PER_CAMPAIGN {
                        println!(
                            "    ✅ Found {} live channels, stopping ACL check for this campaign",
                            live_channels_found
                        );
                        break;
                    }

                    match Self::check_channel_status(client, &allowed_channel.id, &token).await {
                        Ok(Some(channel_info)) => {
                            println!(
                                "    ✅ {} is online with {} viewers",
                                allowed_channel.name, channel_info.viewers
                            );
                            eligible_channels.push(MiningChannel {
                                id: allowed_channel.id.clone(),
                                name: allowed_channel.name.clone(),
                                game_id: campaign.game_id.clone(),
                                game_name: campaign.game_name.clone(),
                                viewers: channel_info.viewers,
                                drops_enabled: channel_info.drops_enabled,
                                is_online: channel_info.is_online,
                                is_acl_based: true,
                            });
                            live_channels_found += 1;
                        }
                        Ok(None) => {
                            // Channel is offline - don't log each one to reduce noise
                        }
                        Err(e) => {
                            eprintln!(
                                "      ❌ Failed to check channel status for {}: {}",
                                allowed_channel.name, e
                            );
                        }
                    }
                }

                if live_channels_found == 0 {
                    println!("    ⚫ No live channels found among ACL channels");
                } else {
                    println!("    ✅ Found {} live ACL channels", live_channels_found);
                }
            } else {
                // Fetch live streams for this game with drops enabled
                println!("  🌐 Fetching live streams for game (no ACL restrictions)");
                match Self::fetch_live_streams_for_game(
                    client,
                    &campaign.game_id,
                    &campaign.game_name,
                    &token,
                )
                .await
                {
                    Ok(channels) => {
                        println!("    ✅ Found {} eligible channels", channels.len());
                        for ch in &channels {
                            println!("      - {} ({} viewers)", ch.name, ch.viewers);
                        }
                        eligible_channels.extend(channels);
                    }
                    Err(e) => {
                        eprintln!(
                            "    ❌ Failed to fetch live streams for {}: {}",
                            campaign.game_name, e
                        );
                    }
                }
            }
        }

        // Remove duplicates (same channel might be eligible for multiple campaigns)
        eligible_channels.sort_by(|a, b| a.id.cmp(&b.id));
        eligible_channels.dedup_by(|a, b| a.id == b.id);

        Ok(eligible_channels)
    }

    /// Check if a specific channel is online and has drops enabled
    async fn check_channel_status(
        client: &Client,
        channel_id: &str,
        token: &str,
    ) -> Result<Option<ChannelStatus>> {
        let query = r#"
        query ChannelStatus($channelID: ID!) {
            user(id: $channelID) {
                id
                login
                stream {
                    id
                    viewersCount
                    game {
                        id
                        name
                    }
                }
            }
        }
        "#;

        let response = client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", CLIENT_ID)
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({
                "query": query,
                "variables": {
                    "channelID": channel_id
                }
            }))
            .send()
            .await?;

        let result: serde_json::Value = response.json().await?;

        if let Some(user) = result["data"]["user"].as_object() {
            if let Some(stream) = user["stream"].as_object() {
                let viewers = stream["viewersCount"].as_i64().unwrap_or(0) as i32;

                return Ok(Some(ChannelStatus {
                    is_online: true,
                    drops_enabled: true, // Assume true for now, would need additional check
                    viewers,
                }));
            }
        }

        Ok(None)
    }

    /// Fetch live streams for a specific game
    async fn fetch_live_streams_for_game(
        client: &Client,
        game_id: &str,
        game_name: &str,
        token: &str,
    ) -> Result<Vec<MiningChannel>> {
        let query = r#"
        query GameStreams($gameID: ID!, $first: Int!) {
            game(id: $gameID) {
                streams(first: $first, options: {systemFilters: [DROPS_ENABLED]}) {
                    edges {
                        node {
                            id
                            broadcaster {
                                id
                                login
                                displayName
                            }
                            viewersCount
                        }
                    }
                }
            }
        }
        "#;

        let response = client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", CLIENT_ID)
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({
                "query": query,
                "variables": {
                    "gameID": game_id,
                    "first": 20
                }
            }))
            .send()
            .await?;

        let result: serde_json::Value = response.json().await?;
        let mut channels = Vec::new();

        if let Some(edges) = result["data"]["game"]["streams"]["edges"].as_array() {
            for edge in edges {
                if let Some(node) = edge["node"].as_object() {
                    if let Some(broadcaster) = node["broadcaster"].as_object() {
                        channels.push(MiningChannel {
                            id: broadcaster["id"].as_str().unwrap_or("").to_string(),
                            name: broadcaster["login"].as_str().unwrap_or("").to_string(),
                            game_id: game_id.to_string(),
                            game_name: game_name.to_string(),
                            viewers: node["viewersCount"].as_i64().unwrap_or(0) as i32,
                            drops_enabled: true,
                            is_online: true,
                            is_acl_based: false,
                        });
                    }
                }
            }
        }

        Ok(channels)
    }

    /// Select the best channel to watch based on priority and settings
    fn select_best_channel(
        channels: &[MiningChannel],
        _campaigns: &[DropCampaign],
        settings: &DropsSettings,
    ) -> Option<MiningChannel> {
        if channels.is_empty() {
            println!("⚠️ No channels available to select from");
            return None;
        }

        println!(
            "🔍 Selecting best channel from {} eligible channels",
            channels.len()
        );

        let mut scored_channels: Vec<(MiningChannel, i32)> = channels
            .iter()
            .filter(|ch| ch.is_online && ch.drops_enabled)
            .map(|ch| {
                let mut score = 0;

                // Priority game bonus (higher priority = higher score)
                if let Some(priority_index) = settings
                    .priority_games
                    .iter()
                    .position(|g| g == &ch.game_name)
                {
                    let priority_bonus = 10000 - (priority_index as i32 * 100);
                    score += priority_bonus;
                    println!("  {} gets priority bonus: +{}", ch.name, priority_bonus);
                }

                // ACL-based channels get priority
                if ch.is_acl_based {
                    score += 5000;
                    println!("  {} gets ACL bonus: +5000", ch.name);
                }

                // Viewer count scoring: prefer channels with MORE viewers (more stable streams)
                // Add a fraction of viewers to score (capped to avoid overwhelming other factors)
                let viewer_bonus = (ch.viewers / 10).min(1000); // Max 1000 bonus from viewers
                score += viewer_bonus;
                println!(
                    "  {} ({} viewers) gets viewer bonus: +{}",
                    ch.name, ch.viewers, viewer_bonus
                );

                println!("  {} final score: {}", ch.name, score);
                (ch.clone(), score)
            })
            .collect();

        if scored_channels.is_empty() {
            println!("⚠️ No online channels with drops enabled");
            return None;
        }

        // Sort by score (highest first)
        scored_channels.sort_by(|a, b| b.1.cmp(&a.1));

        let selected = scored_channels.first().map(|(ch, score)| {
            println!(
                "🎯 Selected channel: {} with {} viewers (score: {})",
                ch.name, ch.viewers, score
            );
            ch.clone()
        });

        selected
    }

    /// Get broadcast ID for a channel
    async fn get_broadcast_id(
        client: &Client,
        channel_id: &str,
        token: &str,
    ) -> Result<Option<String>> {
        let query = r#"
        query GetStreamInfo($channelID: ID!) {
            user(id: $channelID) {
                stream {
                    id
                }
            }
        }
        "#;

        let response = client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", CLIENT_ID)
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({
                "query": query,
                "variables": {
                    "channelID": channel_id
                }
            }))
            .send()
            .await?;

        let result: serde_json::Value = response.json().await?;

        if let Some(user) = result["data"]["user"].as_object() {
            if let Some(stream) = user["stream"].as_object() {
                if let Some(id) = stream["id"].as_str() {
                    return Ok(Some(id.to_string()));
                }
            }
        }

        Ok(None)
    }

    /// Send watch payload to Twitch to progress drops
    /// Uses the official spade.twitch.tv tracking endpoint (same as TwitchDropsMiner)
    async fn send_watch_payload(
        client: &Client,
        channel: &MiningChannel,
        broadcast_id: &str,
        token: &str,
        cached_user_id: &Arc<RwLock<Option<String>>>,
        _cached_spade_url: &Arc<RwLock<Option<String>>>,
    ) -> Result<bool> {
        // Use the official Twitch spade tracking endpoint
        // This is the stable URL that doesn't expire (unlike video-edge segment URLs)
        let spade_url = "https://spade.twitch.tv/track";

        // Get user ID (check cache first)
        let user_id = {
            let cached = cached_user_id.read().await;
            if let Some(id) = cached.as_ref() {
                id.clone()
            } else {
                drop(cached); // Release read lock before acquiring write lock

                // Fetch user ID with retry logic
                let id = match Self::get_user_id_with_retry(client, token, 3).await {
                    Ok(id) => id,
                    Err(e) => {
                        eprintln!("❌ Failed to get user ID after retries: {}", e);
                        return Ok(false);
                    }
                };

                // Cache it
                let mut cached_write = cached_user_id.write().await;
                *cached_write = Some(id.clone());
                id
            }
        };

        // Create the minute-watched payload (same as TwitchDropsMiner)
        let payload_data = json!([{
            "event": "minute-watched",
            "properties": {
                "broadcast_id": broadcast_id.to_string(),  // Use the actual broadcast ID
                "channel_id": channel.id.clone(),
                "channel": channel.name.clone(),
                "hidden": false,
                "live": true,
                "location": "channel",
                "logged_in": true,
                "muted": false,
                "player": "site",
                "user_id": user_id
            }
        }]);

        // Minify and base64 encode the payload
        let payload_str = serde_json::to_string(&payload_data)?;
        let encoded = general_purpose::STANDARD.encode(payload_str.as_bytes());

        // Send the watch payload with detailed error handling
        let response_result = client
            .post(spade_url)
            .form(&[("data", encoded)])
            .timeout(std::time::Duration::from_secs(15)) // Explicit 15 second timeout
            .send()
            .await;

        match response_result {
            Ok(response) => {
                let status = response.status();
                if status.as_u16() == 204 {
                    // Success - caller will print the message
                    Ok(true)
                } else {
                    // Log detailed status info
                    let status_code = status.as_u16();
                    let response_text = response
                        .text()
                        .await
                        .unwrap_or_else(|_| "Unable to read body".to_string());
                    println!(
                        "⚠️ Watch payload returned HTTP {} for {} - Response: {}",
                        status_code,
                        channel.name,
                        if response_text.len() > 200 {
                            &response_text[..200]
                        } else {
                            &response_text
                        }
                    );

                    // Log specific status codes for debugging
                    match status_code {
                        429 => println!("   ⏱️ Rate limited by Twitch!"),
                        401 | 403 => println!("   🔐 Authentication/authorization issue"),
                        404 => println!("   🔍 Spade URL not found - may need to refresh"),
                        500..=599 => println!("   🔥 Twitch server error"),
                        _ => {}
                    }

                    Ok(false)
                }
            }
            Err(e) => {
                // Detailed error classification
                if e.is_timeout() {
                    println!(
                        "⏱️ Watch payload TIMEOUT for {} - Request took too long",
                        channel.name
                    );
                } else if e.is_connect() {
                    println!(
                        "🔌 Watch payload CONNECTION ERROR for {} - {}",
                        channel.name, e
                    );
                } else if e.is_request() {
                    println!(
                        "📤 Watch payload REQUEST ERROR for {} - {}",
                        channel.name, e
                    );
                } else {
                    println!("❌ Watch payload ERROR for {} - {}", channel.name, e);
                }

                // Return error instead of Ok(false) so caller knows it was an actual error
                Err(anyhow::anyhow!("Watch payload failed: {}", e))
            }
        }
    }

    /// Extract spade URL from channel page (like TwitchDropsMiner does)
    async fn get_spade_url(client: &Client, channel_name: &str) -> Result<String> {
        let channel_url = format!("https://www.twitch.tv/{}", channel_name);

        // Fetch the channel page HTML
        let response = client
            .get(&channel_url)
            .header(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            )
            .send()
            .await?;

        let html = response.text().await?;

        // Try to find spade URL directly in the HTML (mobile view pattern)
        let spade_pattern =
            Regex::new(r#""spade_?url":\s*"(https://video-edge-[.\w\-/]+\.ts(?:\?[^"]*)?)"#)?;

        if let Some(captures) = spade_pattern.captures(&html) {
            if let Some(url) = captures.get(1) {
                return Ok(url.as_str().to_string());
            }
        }

        // If not found directly, look for settings JS file
        let settings_pattern =
            Regex::new(r#"src="(https://[\w.]+/config/settings\.[0-9a-f]{32}\.js)"#)?;

        if let Some(captures) = settings_pattern.captures(&html) {
            if let Some(settings_url) = captures.get(1) {
                // Fetch the settings JS file
                let settings_response = client.get(settings_url.as_str()).send().await?;

                let settings_js = settings_response.text().await?;

                // Look for spade URL in settings
                if let Some(captures) = spade_pattern.captures(&settings_js) {
                    if let Some(url) = captures.get(1) {
                        return Ok(url.as_str().to_string());
                    }
                }
            }
        }

        Err(anyhow::anyhow!(
            "Could not find spade URL for channel {}",
            channel_name
        ))
    }

    /// Get user ID from token validation with retry logic
    async fn get_user_id_with_retry(
        client: &Client,
        token: &str,
        max_retries: u32,
    ) -> Result<String> {
        let mut attempt = 0;

        loop {
            attempt += 1;

            match Self::get_user_id(client, token).await {
                Ok(id) => return Ok(id),
                Err(e) if attempt >= max_retries => {
                    return Err(anyhow::anyhow!(
                        "Failed to get user ID after {} attempts: {}",
                        max_retries,
                        e
                    ));
                }
                Err(e) => {
                    eprintln!(
                        "⚠️ Failed to get user ID (attempt {}/{}): {}",
                        attempt, max_retries, e
                    );
                    // Exponential backoff: 1s, 2s, 4s...
                    let delay = tokio::time::Duration::from_secs(2_u64.pow(attempt - 1));
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }

    /// Get user ID from token validation
    async fn get_user_id(client: &Client, token: &str) -> Result<String> {
        let response = client
            .get("https://id.twitch.tv/oauth2/validate")
            .header("Authorization", format!("OAuth {}", token))
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?;

        if response.status().is_success() {
            let data: serde_json::Value = response.json().await?;
            if let Some(user_id) = data["user_id"].as_str() {
                return Ok(user_id.to_string());
            }
        }

        Err(anyhow::anyhow!("Failed to get user ID from token"))
    }

    /// Get the active campaign for a specific channel
    fn get_active_campaign_for_channel(
        channel: &MiningChannel,
        campaigns: &[DropCampaign],
    ) -> Option<DropCampaign> {
        let now = Utc::now();

        campaigns
            .iter()
            .find(|c| c.game_id == channel.game_id && c.start_at <= now && c.end_at >= now)
            .cloned()
    }

    /// Try to switch to the next available online channel when current one fails
    /// This now includes refreshing the eligible channels from the API if all cached channels fail
    async fn try_switch_channel(
        client: &Client,
        token: &str,
        channels: &[MiningChannel],
        current_channel_id: &str,
        current_index: usize,
    ) -> Option<(MiningChannel, String, usize)> {
        println!(
            "🔄 Attempting to switch from channel index {} (have {} cached channels)...",
            current_index,
            channels.len()
        );

        // Try to find a different online channel from the cached list
        for i in 1..=channels.len() {
            let next_index = (current_index + i) % channels.len();
            let next_channel = &channels[next_index];

            // Skip the current failing channel
            if next_channel.id == current_channel_id {
                continue;
            }

            println!(
                "🔄 Trying cached channel: {} ({})",
                next_channel.name, next_channel.game_name
            );

            // Check if channel is still online
            match Self::check_channel_status(client, &next_channel.id, token).await {
                Ok(Some(status)) if status.is_online => {
                    // Get new broadcast ID
                    match Self::get_broadcast_id(client, &next_channel.id, token).await {
                        Ok(Some(new_broadcast_id)) => {
                            println!(
                                "✅ Successfully switched to {} (broadcast: {})",
                                next_channel.name, new_broadcast_id
                            );
                            return Some((next_channel.clone(), new_broadcast_id, next_index));
                        }
                        Ok(None) => {
                            println!("⚠️ Channel {} is not live", next_channel.name);
                        }
                        Err(e) => {
                            println!(
                                "❌ Failed to get broadcast ID for {}: {}",
                                next_channel.name, e
                            );
                        }
                    }
                }
                Ok(Some(_)) => {
                    println!(
                        "⚠️ Channel {} status check returned not online",
                        next_channel.name
                    );
                }
                Ok(None) => {
                    println!("⚠️ Channel {} is offline", next_channel.name);
                }
                Err(e) => {
                    println!("❌ Failed to check status for {}: {}", next_channel.name, e);
                }
            }
        }

        println!("❌ No alternative channels available in cached list");
        None
    }

    /// Extended channel switching that refreshes the eligible channels from API if needed
    /// Returns the new channel, broadcast ID, updated channel list, and index
    async fn try_switch_channel_with_refresh(
        client: &Client,
        token: &str,
        cached_channels: &[MiningChannel],
        current_channel_id: &str,
        current_index: usize,
        campaigns: &[DropCampaign],
        settings: &DropsSettings,
    ) -> Option<(MiningChannel, String, Vec<MiningChannel>, usize)> {
        println!("🔄 Attempting channel switch with potential refresh...");

        // First, try the cached channels
        if let Some((channel, broadcast_id, new_index)) = Self::try_switch_channel(
            client,
            token,
            cached_channels,
            current_channel_id,
            current_index,
        )
        .await
        {
            return Some((channel, broadcast_id, cached_channels.to_vec(), new_index));
        }

        // If no cached channels work, refresh the eligible channels from API
        println!("🔄 All cached channels failed, refreshing eligible channels from API...");

        match Self::discover_eligible_channels_internal(client, campaigns, settings).await {
            Ok(fresh_channels) => {
                if fresh_channels.is_empty() {
                    println!(
                        "❌ API returned no eligible channels - all streams appear to be offline"
                    );
                    return None;
                }

                println!(
                    "✅ Refreshed channel list: found {} eligible channels",
                    fresh_channels.len()
                );

                // Try to find an online channel from the fresh list
                for (index, channel) in fresh_channels.iter().enumerate() {
                    // Skip the current failing channel
                    if channel.id == current_channel_id {
                        continue;
                    }

                    println!(
                        "🔄 Trying fresh channel: {} ({})",
                        channel.name, channel.game_name
                    );

                    match Self::check_channel_status(client, &channel.id, token).await {
                        Ok(Some(status)) if status.is_online => {
                            match Self::get_broadcast_id(client, &channel.id, token).await {
                                Ok(Some(broadcast_id)) => {
                                    println!(
                                        "✅ Successfully switched to fresh channel {} (broadcast: {})",
                                        channel.name, broadcast_id
                                    );
                                    return Some((
                                        channel.clone(),
                                        broadcast_id,
                                        fresh_channels,
                                        index,
                                    ));
                                }
                                Ok(None) => {
                                    println!("⚠️ Fresh channel {} is not live", channel.name);
                                }
                                Err(e) => {
                                    println!(
                                        "❌ Failed to get broadcast ID for fresh channel {}: {}",
                                        channel.name, e
                                    );
                                }
                            }
                        }
                        Ok(Some(_)) => {
                            println!("⚠️ Fresh channel {} is not online", channel.name);
                        }
                        Ok(None) => {
                            println!("⚠️ Fresh channel {} is offline", channel.name);
                        }
                        Err(e) => {
                            println!(
                                "❌ Failed to check status for fresh channel {}: {}",
                                channel.name, e
                            );
                        }
                    }
                }

                println!("❌ No online channels found even after API refresh");
                None
            }
            Err(e) => {
                println!("❌ Failed to refresh eligible channels from API: {}", e);
                None
            }
        }
    }

    /// Cleanly stop mining and notify the user
    async fn stop_mining_no_channels(
        is_running: &Arc<RwLock<bool>>,
        mining_status: &Arc<RwLock<MiningStatus>>,
        app_handle: &AppHandle,
        reason: &str,
    ) {
        println!("🛑 Stopping mining: {}", reason);

        // Set running to false
        {
            let mut running = is_running.write().await;
            *running = false;
        }

        // Clear mining status
        {
            let mut status = mining_status.write().await;
            status.is_mining = false;
            status.current_channel = None;
            status.current_campaign = None;
            status.current_drop = None;
            status.eligible_channels = Vec::new();
            status.last_update = Utc::now();
        }

        // Emit status update
        let current_status = mining_status.read().await.clone();
        let _ = app_handle.emit("mining-status-update", &current_status);

        // Emit specific event for no channels available
        let _ = app_handle.emit(
            "mining-stopped-no-channels",
            json!({
                "reason": reason,
                "timestamp": Utc::now().to_rfc3339()
            }),
        );
    }
}

struct ChannelStatus {
    is_online: bool,
    drops_enabled: bool,
    viewers: i32,
}

/// Extended channel status with game category info
struct ExtendedChannelStatus {
    is_online: bool,
    drops_enabled: bool,
    viewers: i32,
    current_game_id: Option<String>,
    current_game_name: Option<String>,
}

// ============================================
// RECOVERY WATCHDOG HELPER FUNCTIONS
// ============================================

impl MiningService {
    /// Check stream status including current game category (for game change detection)
    async fn check_channel_status_extended(
        client: &Client,
        channel_id: &str,
        token: &str,
    ) -> Result<Option<ExtendedChannelStatus>> {
        let query = r#"
        query ChannelStatusExtended($channelID: ID!) {
            user(id: $channelID) {
                id
                login
                stream {
                    id
                    viewersCount
                    game {
                        id
                        name
                    }
                }
            }
        }
        "#;

        let response = client
            .post("https://gql.twitch.tv/gql")
            .header("Client-Id", CLIENT_ID)
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({
                "query": query,
                "variables": {
                    "channelID": channel_id
                }
            }))
            .send()
            .await?;

        let result: serde_json::Value = response.json().await?;

        if let Some(user) = result["data"]["user"].as_object() {
            if let Some(stream) = user["stream"].as_object() {
                let viewers = stream["viewersCount"].as_i64().unwrap_or(0) as i32;

                let (game_id, game_name) = if let Some(game) = stream.get("game") {
                    if let Some(game_obj) = game.as_object() {
                        (
                            game_obj
                                .get("id")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                            game_obj
                                .get("name")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                        )
                    } else {
                        (None, None)
                    }
                } else {
                    (None, None)
                };

                return Ok(Some(ExtendedChannelStatus {
                    is_online: true,
                    drops_enabled: true, // Would need additional check for actual drops status
                    viewers,
                    current_game_id: game_id,
                    current_game_name: game_name,
                }));
            }
        }

        Ok(None)
    }

    /// Emit a recovery event to the frontend
    fn emit_recovery_event(
        app_handle: &AppHandle,
        event_type: RecoveryEventType,
        details: RecoveryEventDetails,
        notify_user: bool,
    ) {
        let event = RecoveryEvent {
            event_type: event_type.clone(),
            timestamp: Utc::now(),
            details: details.clone(),
        };

        // Always emit the technical event for logging/debugging
        let _ = app_handle.emit("mining-recovery-event", &event);

        // If user notification is enabled, emit a user-friendly toast notification
        if notify_user {
            let (title, message) = match event_type {
                RecoveryEventType::StreamerSwitched => (
                    "Switched Streamer",
                    format!(
                        "Switched from {} to {} - {}",
                        details.from_channel.unwrap_or_default(),
                        details.to_channel.unwrap_or_default(),
                        details.reason
                    ),
                ),
                RecoveryEventType::StreamerBlacklisted => (
                    "Streamer Temporarily Blocked",
                    format!(
                        "{} temporarily blacklisted - {}",
                        details.from_channel.unwrap_or_default(),
                        details.reason
                    ),
                ),
                RecoveryEventType::CampaignDeprioritized => (
                    "Campaign Deprioritized",
                    format!(
                        "{} temporarily deprioritized - {}",
                        details.from_campaign.unwrap_or_default(),
                        details.reason
                    ),
                ),
                RecoveryEventType::CampaignRotated => (
                    "Campaign Changed",
                    format!(
                        "Switched from {} to {} - {}",
                        details.from_campaign.unwrap_or_default(),
                        details.to_campaign.unwrap_or_default(),
                        details.reason
                    ),
                ),
                RecoveryEventType::StaleProgressDetected => (
                    "Progress Stalled",
                    format!(
                        "No progress detected on {} - {}",
                        details.from_channel.unwrap_or_default(),
                        details.reason
                    ),
                ),
                RecoveryEventType::GameCategoryChanged => (
                    "Streamer Changed Game",
                    format!(
                        "{} is no longer playing the required game - {}",
                        details.from_channel.unwrap_or_default(),
                        details.reason
                    ),
                ),
                RecoveryEventType::StreamerWentOffline => (
                    "Streamer Went Offline",
                    format!(
                        "{} went offline - {}",
                        details.from_channel.unwrap_or_default(),
                        details.reason
                    ),
                ),
            };

            let _ = app_handle.emit(
                "mining-recovery-notification",
                json!({
                    "title": title,
                    "message": message,
                    "type": "warning",
                    "timestamp": Utc::now().to_rfc3339()
                }),
            );
        }
    }

    /// Get the effective stale threshold based on recovery mode
    fn get_stale_threshold(settings: &DropsSettings) -> u64 {
        match settings.recovery_settings.recovery_mode {
            RecoveryMode::Automatic => settings.recovery_settings.stale_progress_threshold_seconds,
            RecoveryMode::Relaxed => {
                // Use 1.5x the configured threshold for relaxed mode, minimum 15 minutes
                let relaxed = (settings.recovery_settings.stale_progress_threshold_seconds as f64
                    * 1.5) as u64;
                relaxed.max(RELAXED_STALE_THRESHOLD_SECONDS)
            }
            RecoveryMode::ManualOnly => {
                // Very long threshold for manual mode - essentially disabled
                u64::MAX
            }
        }
    }

    /// Check if progress is stale and take appropriate action based on recovery mode
    async fn handle_stale_progress_check(
        recovery_state: &Arc<RwLock<RecoveryWatchdogState>>,
        settings: &DropsSettings,
        current_channel: &MiningChannel,
        app_handle: &AppHandle,
    ) -> Option<BlacklistReason> {
        let threshold = Self::get_stale_threshold(settings);

        let is_stale = {
            let state = recovery_state.read().await;
            state.is_progress_stale(threshold)
        };

        if !is_stale {
            return None;
        }

        println!(
            "⚠️ Stale progress detected for {} (no progress in {} seconds)",
            current_channel.name, threshold
        );

        // Emit recovery event
        Self::emit_recovery_event(
            app_handle,
            RecoveryEventType::StaleProgressDetected,
            RecoveryEventDetails {
                from_channel: Some(current_channel.name.clone()),
                to_channel: None,
                from_campaign: None,
                to_campaign: None,
                reason: format!("No progress increase in {} minutes", threshold / 60),
            },
            settings.recovery_settings.notify_on_recovery_action,
        );

        // If manual mode, don't auto-blacklist, just notify
        if settings.recovery_settings.recovery_mode == RecoveryMode::ManualOnly {
            println!("📢 Manual mode - notifying user but not auto-switching");
            return None;
        }

        Some(BlacklistReason::StaleProgress)
    }

    /// Check if streamer changed game category
    async fn check_game_category_change(
        client: &Client,
        token: &str,
        current_channel: &MiningChannel,
        expected_game_id: &str,
        settings: &DropsSettings,
        app_handle: &AppHandle,
    ) -> Option<BlacklistReason> {
        if !settings.recovery_settings.detect_game_category_change {
            return None;
        }

        match Self::check_channel_status_extended(client, &current_channel.id, token).await {
            Ok(Some(status)) => {
                if let Some(ref current_game_id) = status.current_game_id {
                    if current_game_id != expected_game_id {
                        let current_game_name = status
                            .current_game_name
                            .unwrap_or_else(|| "Unknown".to_string());
                        println!(
                            "🎮 Game category changed! {} switched from {} to {}",
                            current_channel.name, current_channel.game_name, current_game_name
                        );

                        Self::emit_recovery_event(
                            app_handle,
                            RecoveryEventType::GameCategoryChanged,
                            RecoveryEventDetails {
                                from_channel: Some(current_channel.name.clone()),
                                to_channel: None,
                                from_campaign: Some(current_channel.game_name.clone()),
                                to_campaign: Some(current_game_name.clone()),
                                reason: format!(
                                    "Streamer switched from {} to {}",
                                    current_channel.game_name, current_game_name
                                ),
                            },
                            settings.recovery_settings.notify_on_recovery_action,
                        );

                        if settings.recovery_settings.recovery_mode != RecoveryMode::ManualOnly {
                            return Some(BlacklistReason::GameCategoryChanged);
                        }
                    }
                }
            }
            Ok(None) => {
                // Stream went offline
                println!(
                    "📴 {} went offline during game category check",
                    current_channel.name
                );

                Self::emit_recovery_event(
                    app_handle,
                    RecoveryEventType::StreamerWentOffline,
                    RecoveryEventDetails {
                        from_channel: Some(current_channel.name.clone()),
                        to_channel: None,
                        from_campaign: None,
                        to_campaign: None,
                        reason: "Stream went offline".to_string(),
                    },
                    settings.recovery_settings.notify_on_recovery_action,
                );

                if settings.recovery_settings.recovery_mode != RecoveryMode::ManualOnly {
                    return Some(BlacklistReason::WentOffline);
                }
            }
            Err(e) => {
                eprintln!("❌ Failed to check game category: {}", e);
            }
        }

        None
    }

    /// Update recovery state when progress is received
    pub async fn on_progress_received(&self, current_minutes: i32) {
        let mut state = self.recovery_state.write().await;
        let increased = state.update_progress(current_minutes);
        if increased {
            println!(
                "📈 Progress increased to {} minutes, resetting stale timer",
                current_minutes
            );
        }
    }

    /// Get the current recovery state (for debugging/UI)
    pub async fn get_recovery_state(&self) -> RecoveryWatchdogState {
        self.recovery_state.read().await.clone()
    }

    /// Reset recovery state when starting a new mining session
    async fn reset_recovery_state(&self, expected_game: Option<String>) {
        let mut state = self.recovery_state.write().await;
        state.last_progress_increase_at = Some(Utc::now());
        state.last_known_progress_minutes = 0;
        state.expected_game_category = expected_game;
        state.last_stream_status_check = Some(Utc::now());
        // Clean up expired entries
        state.cleanup_expired();
        println!("🔄 Recovery state reset for new mining session");
    }

    /// Select best channel while respecting blacklist
    fn select_best_channel_with_blacklist(
        channels: &[MiningChannel],
        _campaigns: &[DropCampaign],
        settings: &DropsSettings,
        recovery_state: &RecoveryWatchdogState,
    ) -> Option<MiningChannel> {
        if channels.is_empty() {
            println!("⚠️ No channels available to select from");
            return None;
        }

        println!(
            "🔍 Selecting best channel from {} eligible channels (with blacklist check)",
            channels.len()
        );

        let mut scored_channels: Vec<(MiningChannel, i32)> = channels
            .iter()
            .filter(|ch| {
                // Filter out blacklisted channels
                if recovery_state.is_streamer_blacklisted(&ch.id) {
                    println!("  ⛔ {} is blacklisted, skipping", ch.name);
                    return false;
                }
                ch.is_online && ch.drops_enabled
            })
            .map(|ch| {
                let mut score = 0;

                // Priority game bonus
                if let Some(priority_index) = settings
                    .priority_games
                    .iter()
                    .position(|g| g == &ch.game_name)
                {
                    let priority_bonus = 10000 - (priority_index as i32 * 100);
                    score += priority_bonus;
                }

                // ACL-based channels get priority
                if ch.is_acl_based {
                    score += 5000;
                }

                // Viewer count scoring
                let viewer_bonus = (ch.viewers / 10).min(1000);
                score += viewer_bonus;

                (ch.clone(), score)
            })
            .collect();

        if scored_channels.is_empty() {
            println!("⚠️ No online, non-blacklisted channels with drops enabled");
            return None;
        }

        scored_channels.sort_by(|a, b| b.1.cmp(&a.1));

        scored_channels.first().map(|(ch, score)| {
            println!(
                "🎯 Selected channel: {} with {} viewers (score: {})",
                ch.name, ch.viewers, score
            );
            ch.clone()
        })
    }
}
