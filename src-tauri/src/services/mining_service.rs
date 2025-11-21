use anyhow::Result;
use reqwest::Client;
use std::sync::Arc;
use tokio::sync::RwLock;
use chrono::{Utc, Duration};
use tauri::{AppHandle, Emitter, Listener};
use crate::models::drops::*;
use crate::services::drops_service::DropsService;
use crate::services::drops_auth_service::DropsAuthService;
use crate::services::drops_websocket_service::DropsWebSocketService;
use base64::{Engine as _, engine::general_purpose};
use regex::Regex;
use serde_json::json;

// Use Android app client ID for drops-related queries
const CLIENT_ID: &str = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";

pub struct MiningService {
    client: Client,
    drops_service: Arc<tokio::sync::Mutex<DropsService>>,
    mining_status: Arc<RwLock<MiningStatus>>,
    eligible_channels: Arc<RwLock<Vec<MiningChannel>>>,
    is_running: Arc<RwLock<bool>>,
    websocket_service: Arc<tokio::sync::Mutex<DropsWebSocketService>>,
}

impl MiningService {
    pub fn new(drops_service: Arc<tokio::sync::Mutex<DropsService>>) -> Self {
        Self {
            client: Client::new(),
            drops_service,
            mining_status: Arc::new(RwLock::new(MiningStatus::default())),
            eligible_channels: Arc::new(RwLock::new(Vec::new())),
            is_running: Arc::new(RwLock::new(false)),
            websocket_service: Arc::new(tokio::sync::Mutex::new(DropsWebSocketService::new())),
        }
    }

    pub async fn get_mining_status(&self) -> MiningStatus {
        self.mining_status.read().await.clone()
    }

    pub async fn is_mining(&self) -> bool {
        *self.is_running.read().await
    }

    /// Start mining a specific campaign (manual mode - like clicking "Start Mining" on a campaign)
    pub async fn start_campaign_mining(&self, campaign_id: String, app_handle: AppHandle) -> Result<()> {
        // Check if already running
        {
            let mut is_running = self.is_running.write().await;
            if *is_running {
                return Ok(());
            }
            *is_running = true;
        }

        // Clone Arc references for the background task
        let client = self.client.clone();
        let drops_service = self.drops_service.clone();
        let mining_status = self.mining_status.clone();
        let eligible_channels = self.eligible_channels.clone();
        let is_running = self.is_running.clone();
        
        // Set up listener for WebSocket progress updates ONCE, outside the loop
        // The WebSocket updates the drops_service cache, and the regular polling will pick it up
        let drops_service_for_ws = drops_service.clone();
        
        let _unlisten = app_handle.listen("drops-progress-update", move |event| {
            let drops_service = drops_service_for_ws.clone();
            
            tokio::spawn(async move {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload()) {
                    let drop_id = payload["drop_id"].as_str().unwrap_or("");
                    let current_minutes = payload["current_minutes"].as_i64().unwrap_or(0) as i32;
                    let required_minutes = payload["required_minutes"].as_i64().unwrap_or(0) as i32;
                    
                    println!("📊 WebSocket progress update received: {}/{} minutes for drop {}", 
                        current_minutes, required_minutes, drop_id);
                    
                    // Update the drops service progress cache
                    // The regular polling will pick this up and update the UI
                    drops_service.lock().await.update_drop_progress_from_websocket(
                        drop_id.to_string(),
                        current_minutes,
                        required_minutes,
                    ).await;
                }
            });
        });

        // Spawn the mining loop for a specific campaign
        tokio::spawn(async move {
            println!("🎮 Starting manual campaign mining for campaign: {}", campaign_id);
            
            loop {
                // Check if mining should continue
                let should_continue = *is_running.read().await;
                if !should_continue {
                    println!("🛑 Stopping campaign mining");
                    break;
                }

                // Get current settings
                let settings = drops_service.lock().await.get_settings().await;

                // Fetch campaigns outside of the main lock
                let campaigns_result = {
                    let service = drops_service.lock().await;
                    service.fetch_all_active_campaigns_from_api().await
                };

                match campaigns_result {
                    Ok(all_campaigns) => {
                        // Now, lock the service to update progress and get filtered campaigns
                        let (target_campaign, settings) = {
                            let service = drops_service.lock().await;
                            service.update_campaigns_and_progress(&all_campaigns).await;
                            let settings = service.get_settings().await;
                            
                            // Apply filters and find the target campaign
                            let filtered_campaigns = all_campaigns.into_iter()
                                .filter(|c| {
                                    !settings.excluded_games.contains(&c.game_name) &&
                                    (settings.priority_mode != PriorityMode::PriorityOnly || settings.priority_games.is_empty() || settings.priority_games.contains(&c.game_name))
                                })
                                .collect::<Vec<_>>();

                            let target = filtered_campaigns.into_iter()
                                .filter(|c| c.id == campaign_id)
                                .collect::<Vec<_>>();
                            (target, settings)
                        };

                        if target_campaign.is_empty() {
                            println!("⚠️ Campaign {} not found or no longer active", campaign_id);
                            break;
                        }

                        // Discover eligible channels for this specific campaign only
                        match Self::discover_eligible_channels_internal(
                            &client,
                            &target_campaign,
                            &settings,
                        ).await {
                            Ok(channels) => {
                                // Store the channels first
                                let mut eligible = eligible_channels.write().await;
                                *eligible = channels.clone();
                                drop(eligible);
                                
                                // Select the best channel from this campaign
                                if let Some(best_channel) = Self::select_best_channel(
                                    &channels,
                                    &target_campaign,
                                    &settings,
                                ) {
                                    println!("✅ Selected channel: {} ({})", best_channel.name, best_channel.id);
                                    
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
                                        
                                        // Find the current drop being progressed
                                        if let Some(drop) = campaign.time_based_drops.first() {
                                            let drop_progress = drops_service.lock().await.get_drop_progress().await;
                                            let current_minutes = drop_progress
                                                .iter()
                                                .find(|p| p.drop_id == drop.id)
                                                .map(|p| p.current_minutes_watched)
                                                .unwrap_or(0);
                                            
                                            let progress_percentage = 
                                                (current_minutes as f32 / drop.required_minutes_watched as f32) * 100.0;
                                            
                                            let estimated_completion = if current_minutes > 0 {
                                                let remaining_minutes = drop.required_minutes_watched - current_minutes;
                                                Some(Utc::now() + Duration::minutes(remaining_minutes as i64))
                                            } else {
                                                None
                                            };
                                            
                                            // Get the actual benefit name from the drop
                                            let drop_name = if let Some(benefit) = drop.benefit_edges.first() {
                                                benefit.name.clone()
                                            } else {
                                                drop.name.clone()
                                            };
                                            
                                            status.current_drop = Some(CurrentDropInfo {
                                                drop_id: drop.id.clone(),
                                                drop_name,
                                                campaign_name: campaign.name.clone(),
                                                game_name: campaign.game_name.clone(),
                                                current_minutes,
                                                required_minutes: drop.required_minutes_watched,
                                                progress_percentage,
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
                                    
                                    println!("⛏️ Mining drops on: {} ({})", 
                                        best_channel.name, best_channel.game_name);
                                    
                                    // Get token and user ID for watch payloads
                                    println!("🔑 Getting token for watch payloads...");
                                    let token = match DropsAuthService::get_token().await {
                                        Ok(t) => {
                                            println!("✅ Got token (first 10 chars): {}", &t[..10.min(t.len())]);
                                            t
                                        },
                                        Err(e) => {
                                            eprintln!("❌ Failed to get token: {}", e);
                                            continue;
                                        }
                                    };
                                    
                                    println!("🔑 Getting user ID...");
                                    let user_id = match Self::get_user_id(&client, &token).await {
                                        Ok(id) => {
                                            println!("✅ Got user ID: {}", id);
                                            id
                                        },
                                        Err(e) => {
                                            eprintln!("❌ Failed to get user ID: {}", e);
                                            continue;
                                        }
                                    };
                                    
                                    // Get the actual stream/broadcast ID for this channel
                                    let broadcast_id = match Self::get_broadcast_id(&client, &best_channel.id, &token).await {
                                        Ok(Some(id)) => {
                                            println!("📺 Got broadcast ID: {}", id);
                                            id
                                        }
                                        Ok(None) => {
                                            println!("⚠️ Channel {} is not live, using channel ID as fallback", best_channel.name);
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
                                    let drops_service_clone = drops_service.clone();
                                    let mining_status_clone = mining_status.clone();
                                    let app_handle_clone = app_handle.clone();
                                    let target_campaign_clone = target_campaign.clone();
                                    
                                    tokio::spawn(async move {
                                        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(60));
                                        let mut consecutive_failures = 0;
                                        
                                        loop {
                                            // Check if still running
                                            if !*is_running_clone.read().await {
                                                println!("🛑 Stopping watch payload loop");
                                                break;
                                            }
                                            
                                            // Send watch payload
                                            println!("📡 Sending watch payload...");
                                            match Self::send_watch_payload(&client_clone, &best_channel_clone, &broadcast_id_clone, &token_clone).await {
                                                Ok(true) => {
                                                    println!("✅ Watch payload sent successfully");
                                                    consecutive_failures = 0;
                                                    
                                                    // Spawn a separate task for progress update to avoid blocking
                                                    let drops_service_for_update = drops_service_clone.clone();
                                                    let mining_status_for_update = mining_status_clone.clone();
                                                    let best_channel_for_update = best_channel_clone.clone();
                                                    let target_campaign_for_update = target_campaign_clone.clone();
                                                    let app_handle_for_update = app_handle_clone.clone();
                                                    
                                                    tokio::spawn(async move {
                                                        println!("🔄 Updating drop progress in background...");
                                                        
                                                        // Try to fetch drop progress with a shorter timeout
                                                        match tokio::time::timeout(
                                                            tokio::time::Duration::from_secs(5),
                                                            async {
                                                                drops_service_for_update.lock().await.get_drop_progress().await
                                                            }
                                                        ).await {
                                                            Ok(drop_progress) => {
                                                                if let Ok(mut status) = mining_status_for_update.try_write() {
                                                                    if let Some(campaign) = Self::get_active_campaign_for_channel(&best_channel_for_update, &target_campaign_for_update) {
                                                                        if let Some(drop) = campaign.time_based_drops.first() {
                                                                            let current_minutes = drop_progress
                                                                                .iter()
                                                                                .find(|p| p.drop_id == drop.id)
                                                                                .map(|p| p.current_minutes_watched)
                                                                                .unwrap_or(0);
                                                                            
                                                                            let progress_percentage = 
                                                                                (current_minutes as f32 / drop.required_minutes_watched as f32) * 100.0;
                                                                            
                                                                            let estimated_completion = if current_minutes > 0 && current_minutes < drop.required_minutes_watched {
                                                                                let remaining_minutes = drop.required_minutes_watched - current_minutes;
                                                                                Some(Utc::now() + Duration::minutes(remaining_minutes as i64))
                                                                            } else {
                                                                                None
                                                                            };
                                                                            
                                                                            // Get the actual benefit name from the drop
                                                                            let drop_name = if let Some(benefit) = drop.benefit_edges.first() {
                                                                                benefit.name.clone()
                                                                            } else {
                                                                                drop.name.clone()
                                                                            };
                                                                            
                                                                            status.current_drop = Some(CurrentDropInfo {
                                                                                drop_id: drop.id.clone(),
                                                                                drop_name,
                                                                                campaign_name: campaign.name.clone(),
                                                                                game_name: campaign.game_name.clone(),
                                                                                current_minutes,
                                                                                required_minutes: drop.required_minutes_watched,
                                                                                progress_percentage,
                                                                                estimated_completion,
                                                                            });
                                                                            
                                                                            println!("📊 Drop progress: {}/{} minutes ({}%)", 
                                                                                current_minutes, drop.required_minutes_watched, progress_percentage.round());
                                                                        }
                                                                    }
                                                                    
                                                                    status.last_update = Utc::now();
                                                                    drop(status);
                                                                    
                                                                    if let Ok(current_status) = mining_status_for_update.try_read() {
                                                                        let _ = app_handle_for_update.emit("mining-status-update", &current_status.clone());
                                                                    }
                                                                    
                                                                    println!("✅ Drop progress updated");
                                                                } else {
                                                                    println!("⚠️ Could not acquire lock for status update");
                                                                }
                                                            }
                                                            Err(_) => {
                                                                println!("⚠️ Timeout fetching drop progress (5s)");
                                                            }
                                                        }
                                                    });
                                                },
                                                Ok(false) => {
                                                    println!("⚠️ Watch payload failed");
                                                    consecutive_failures += 1;
                                                    if consecutive_failures >= 3 {
                                                        println!("❌ Too many consecutive failures, stopping mining");
                                                        break;
                                                    }
                                                },
                                                Err(e) => {
                                                    eprintln!("❌ Failed to send watch payload: {}", e);
                                                    consecutive_failures += 1;
                                                    if consecutive_failures >= 3 {
                                                        println!("❌ Too many consecutive failures, stopping mining");
                                                        break;
                                                    }
                                                }
                                            }
                                            
                                            // Wait for next interval
                                            interval.tick().await;
                                        }
                                    });
                                    
                                    println!("🔍 DEBUG: About to fetch progress for manual campaign mining");
                                    
                                     // Refresh drop progress
                                     println!("🔄 Fetching latest drop progress from Twitch API...");
                                     
                                     // Fetch campaigns outside the lock
                                     let campaigns_result = {
                                         let service = drops_service.lock().await;
                                         service.fetch_all_active_campaigns_from_api().await
                                     };

                                     match campaigns_result {
                                         Ok(campaigns) => {
                                            // Lock to update progress and get the latest state
                                            let drop_progress = {
                                                let service = drops_service.lock().await;
                                                service.update_campaigns_and_progress(&campaigns).await;
                                                service.get_drop_progress().await
                                            };

                                             let mut status = mining_status.write().await;
                                            
                                            println!("📋 Retrieved {} drop progress entries", drop_progress.len());
                                            
                                            if let Some(campaign) = Self::get_active_campaign_for_channel(&best_channel, &target_campaign) {
                                                if let Some(drop) = campaign.time_based_drops.first() {
                                                    let current_minutes = drop_progress
                                                        .iter()
                                                        .find(|p| p.drop_id == drop.id)
                                                        .map(|p| p.current_minutes_watched)
                                                        .unwrap_or(0);
                                                    
                                                    let progress_percentage = 
                                                        (current_minutes as f32 / drop.required_minutes_watched as f32) * 100.0;
                                                    
                                                    let estimated_completion = if current_minutes > 0 {
                                                        let remaining_minutes = drop.required_minutes_watched - current_minutes;
                                                        Some(Utc::now() + Duration::minutes(remaining_minutes as i64))
                                                    } else {
                                                        None
                                                    };
                                                    
                                                    // Get the actual benefit name from the drop
                                                    let drop_name = if let Some(benefit) = drop.benefit_edges.first() {
                                                        benefit.name.clone()
                                                    } else {
                                                        drop.name.clone()
                                                    };
                                                    
                                                    status.current_drop = Some(CurrentDropInfo {
                                                        drop_id: drop.id.clone(),
                                                        drop_name,
                                                        campaign_name: campaign.name.clone(),
                                                        game_name: campaign.game_name.clone(),
                                                        current_minutes,
                                                        required_minutes: drop.required_minutes_watched,
                                                        progress_percentage,
                                                        estimated_completion,
                                                    });
                                                    
                                                    println!("📊 Updated drop progress: {}/{} minutes ({}%)", 
                                                        current_minutes, drop.required_minutes_watched, progress_percentage.round());
                                                }
                                            }
                                            
                                            status.last_update = Utc::now();
                                            drop(status);
                                            
                                            let current_status = mining_status.read().await.clone();
                                            let _ = app_handle.emit("mining-status-update", &current_status);
                                            
                                            // NOW connect WebSocket AFTER status is fully populated
                                            println!("🔌 Connecting WebSocket for drops updates (AFTER status populated)...");
                                            let websocket_service = Arc::new(tokio::sync::Mutex::new(DropsWebSocketService::new()));
                                            let mut ws_service = websocket_service.lock().await;
                                            if let Err(e) = ws_service.connect(&user_id, &token, app_handle.clone()).await {
                                                eprintln!("❌ Failed to connect WebSocket: {}", e);
                                            }
                                            drop(ws_service);
                                        }
                                         Err(e) => {
                                             eprintln!("❌ Failed to refresh drop progress: {}", e);
                                         }
                                     }
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

            // Disconnect the WebSocket for manual mining
            let ds_clone = drops_service.clone();
            if let Ok(service) = ds_clone.try_lock() {
                // This is a bit of a hack to get access to the websocket service.
                // In a real-world scenario, you might pass the websocket service directly.
            }
        });

        Ok(())
    }

    /// Start the automated mining process (cycles through all eligible campaigns)
    pub async fn start_mining(&self, app_handle: AppHandle) -> Result<()> {
        // Check if already running
        {
            let mut is_running = self.is_running.write().await;
            if *is_running {
                return Ok(());
            }
            *is_running = true;
        }

        // Clone Arc references for the background task
        let client = self.client.clone();
        let drops_service = self.drops_service.clone();
        let mining_status = self.mining_status.clone();
        let eligible_channels = self.eligible_channels.clone();
        let is_running = self.is_running.clone();
        
        // Set up listener for WebSocket progress updates (same as manual mining)
        let mining_status_for_ws = mining_status.clone();
        let app_handle_for_ws = app_handle.clone();
        let drops_service_for_ws = drops_service.clone();
        
        let _unlisten = app_handle.listen("drops-progress-update", move |event| {
            let mining_status = mining_status_for_ws.clone();
            let app_handle = app_handle_for_ws.clone();
            let drops_service = drops_service_for_ws.clone();
            
            tokio::spawn(async move {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload()) {
                    let drop_id = payload["drop_id"].as_str().unwrap_or("");
                    let current_minutes = payload["current_minutes"].as_i64().unwrap_or(0) as i32;
                    let required_minutes = payload["required_minutes"].as_i64().unwrap_or(0) as i32;
                    
                    println!("📊 WebSocket progress update received: {}/{} minutes for drop {}", 
                        current_minutes, required_minutes, drop_id);
                    
                    // Update mining status with new progress
                    if let Ok(mut status) = mining_status.try_write() {
                        println!("🔍 Current drop in status: {:?}", status.current_drop.as_ref().map(|d| &d.drop_id));
                        println!("🔍 WebSocket drop ID: {}", drop_id);
                        
                        let should_emit = if let Some(ref mut current_drop) = status.current_drop {
                            println!("🔍 Comparing: '{}' == '{}'", current_drop.drop_id, drop_id);
                            if current_drop.drop_id == drop_id {
                                current_drop.current_minutes = current_minutes;
                                current_drop.required_minutes = required_minutes;
                                current_drop.progress_percentage = 
                                    (current_minutes as f32 / required_minutes as f32) * 100.0;
                                
                                // Update estimated completion
                                if current_minutes > 0 && current_minutes < required_minutes {
                                    let remaining_minutes = required_minutes - current_minutes;
                                    current_drop.estimated_completion = 
                                        Some(Utc::now() + Duration::minutes(remaining_minutes as i64));
                                } else {
                                    current_drop.estimated_completion = None;
                                }
                                
                                println!("✅ Updated mining status with WebSocket progress: {}%", 
                                    current_drop.progress_percentage.round());
                                
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        };
                        
                        if should_emit {
                            status.last_update = Utc::now();
                            
                            // Emit updated status to frontend
                            let current_status = status.clone();
                            drop(status);
                            let _ = app_handle.emit("mining-status-update", &current_status);
                        }
                    }
                    
                    // Also update the drops service progress cache
                    drops_service.lock().await.update_drop_progress_from_websocket(
                        drop_id.to_string(),
                        current_minutes,
                        required_minutes,
                    ).await;
                }
            });
        });

        // Spawn the mining loop
        tokio::spawn(async move {
            println!("🎮 Starting automated drops mining (all eligible campaigns)");
            
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
                            let filtered = all_campaigns.into_iter()
                                .filter(|c| {
                                    !settings.excluded_games.contains(&c.game_name) &&
                                    (settings.priority_mode != PriorityMode::PriorityOnly || settings.priority_games.is_empty() || settings.priority_games.contains(&c.game_name))
                                })
                                .collect::<Vec<_>>();
                            (filtered, settings)
                        };
                        
                        // Discover eligible channels for mining
                        match Self::discover_eligible_channels_internal(
                            &client,
                            &campaigns,
                            &settings,
                        ).await {
                            Ok(channels) => {
                                // Store the channels first
                                let mut eligible = eligible_channels.write().await;
                                *eligible = channels.clone();
                                drop(eligible); // Release the lock
                                
                                // Select the best channel to watch from the discovered channels
                                if let Some(best_channel) = Self::select_best_channel(
                                    &channels,  // Use the channels we just discovered, not the reference
                                    &campaigns,
                                    &settings,
                                ) {
                                    // Re-acquire the lock to get the eligible channels for status
                                    let eligible = eligible_channels.read().await;
                                    // Update mining status
                                    let mut status = mining_status.write().await;
                                    status.is_mining = true;
                                    status.current_channel = Some(best_channel.clone());
                                    status.eligible_channels = eligible.clone();
                                    status.last_update = Utc::now();
                                    drop(eligible); // Release the read lock
                                    
                                    // Find the active campaign for this channel
                                    if let Some(campaign) = Self::get_active_campaign_for_channel(
                                        &best_channel,
                                        &campaigns,
                                    ) {
                                        status.current_campaign = Some(campaign.name.clone());
                                        
                                        // Find the current drop being progressed
                                        if let Some(drop) = campaign.time_based_drops.first() {
                                            let drop_progress = drops_service.lock().await.get_drop_progress().await;
                                            let current_minutes = drop_progress
                                                .iter()
                                                .find(|p| p.drop_id == drop.id)
                                                .map(|p| p.current_minutes_watched)
                                                .unwrap_or(0);
                                            
                                            let progress_percentage = 
                                                (current_minutes as f32 / drop.required_minutes_watched as f32) * 100.0;
                                            
                                            let estimated_completion = if current_minutes > 0 {
                                                let remaining_minutes = drop.required_minutes_watched - current_minutes;
                                                Some(Utc::now() + Duration::minutes(remaining_minutes as i64))
                                            } else {
                                                None
                                            };
                                            
                                            status.current_drop = Some(CurrentDropInfo {
                                                drop_id: drop.id.clone(),
                                                drop_name: drop.name.clone(),
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
                                    
                                    // Emit mining status update
                                    let current_status = mining_status.read().await.clone();
                                    let _ = app_handle.emit("mining-status-update", &current_status);
                                    
                                    // Start monitoring this channel
                                    drops_service.lock().await.update_current_channel(
                                        best_channel.id.clone(),
                                        best_channel.name.clone(),
                                    ).await;
                                    
                                    println!("⛏️ Mining drops on: {} ({})", 
                                        best_channel.name, best_channel.game_name);
                                    
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
                                    let websocket_service = Arc::new(tokio::sync::Mutex::new(DropsWebSocketService::new()));
                                    let mut ws_service = websocket_service.lock().await;
                                    if let Err(e) = ws_service.connect(&user_id, &token, app_handle.clone()).await {
                                        eprintln!("❌ Failed to connect WebSocket: {}", e);
                                    }
                                    drop(ws_service);
                                    
                                    // Get the actual stream/broadcast ID for this channel
                                    let broadcast_id = match Self::get_broadcast_id(&client, &best_channel.id, &token).await {
                                        Ok(Some(id)) => {
                                            println!("📺 Got broadcast ID: {}", id);
                                            id
                                        }
                                        Ok(None) => {
                                            println!("⚠️ Channel {} is not live, using channel ID as fallback", best_channel.name);
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
                                    
                                    tokio::spawn(async move {
                                        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(60));
                                        loop {
                                            // Check if still running
                                            if !*is_running_clone.read().await {
                                                println!("🛑 Stopping watch payload loop");
                                                break;
                                            }
                                            
                                            // Send watch payload
                                            println!("📡 Sending watch payload...");
                                            match Self::send_watch_payload(&client_clone, &best_channel_clone, &broadcast_id_clone, &token_clone).await {
                                                Ok(true) => println!("✅ Watch payload sent successfully"),
                                                Ok(false) => println!("⚠️ Watch payload failed"),
                                                Err(e) => eprintln!("❌ Failed to send watch payload: {}", e),
                                            }
                                            
                                            // Wait for next interval
                                            interval.tick().await;
                                        }
                                    });
                                    
                                    println!("🔄 About to fetch drop progress...");
                                    
                                     // Refresh drop progress from Twitch API to get latest progress
                                     println!("🔄 Fetching latest drop progress from Twitch API...");
                                     
                                     // Fetch campaigns outside the lock
                                     let campaigns_result = {
                                         let service = drops_service.lock().await;
                                         service.fetch_all_active_campaigns_from_api().await
                                     };

                                     match campaigns_result {
                                         Ok(campaigns_from_api) => {
                                            // Lock to update progress and get the latest state
                                            let drop_progress = {
                                                let service = drops_service.lock().await;
                                                service.update_campaigns_and_progress(&campaigns_from_api).await;
                                                service.get_drop_progress().await
                                            };
                                             let mut status = mining_status.write().await;
                                            
                                            println!("📋 Retrieved {} drop progress entries", drop_progress.len());
                                            
                                            if let Some(campaign) = Self::get_active_campaign_for_channel(&best_channel, &campaigns) {
                                                if let Some(drop) = campaign.time_based_drops.first() {
                                                    let current_minutes = drop_progress
                                                        .iter()
                                                        .find(|p| p.drop_id == drop.id)
                                                        .map(|p| p.current_minutes_watched)
                                                        .unwrap_or(0);
                                                    
                                                    let progress_percentage = 
                                                        (current_minutes as f32 / drop.required_minutes_watched as f32) * 100.0;
                                                    
                                                    let estimated_completion = if current_minutes > 0 {
                                                        let remaining_minutes = drop.required_minutes_watched - current_minutes;
                                                        Some(Utc::now() + Duration::minutes(remaining_minutes as i64))
                                                    } else {
                                                        None
                                                    };
                                                    
                                                    println!("📊 Drop: {} - Progress: {}/{} minutes ({}%)", 
                                                        drop.name, current_minutes, drop.required_minutes_watched, progress_percentage.round());
                                                    
                                                    status.current_drop = Some(CurrentDropInfo {
                                                        drop_id: drop.id.clone(),
                                                        drop_name: drop.name.clone(),
                                                        campaign_name: campaign.name.clone(),
                                                        game_name: campaign.game_name.clone(),
                                                        current_minutes,
                                                        required_minutes: drop.required_minutes_watched,
                                                        progress_percentage,
                                                        estimated_completion,
                                                    });
                                                } else {
                                                    println!("⚠️ No drops found in campaign");
                                                }
                                            } else {
                                                println!("⚠️ No active campaign found for channel");
                                            }
                                            
                                            status.last_update = Utc::now();
                                            drop(status);
                                            
                                            // Emit updated status
                                            let current_status = mining_status.read().await.clone();
                                            let _ = app_handle.emit("mining-status-update", &current_status);
                                        }
                                         Err(e) => {
                                             eprintln!("❌ Failed to refresh drop progress: {}", e);
                                         }
                                     }
                                 } else {
                                    println!("⚠️ No eligible channels found for mining");
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

    /// Discover channels eligible for drops mining
    async fn discover_eligible_channels_internal(
        client: &Client,
        campaigns: &[DropCampaign],
        settings: &DropsSettings,
    ) -> Result<Vec<MiningChannel>> {
        let mut eligible_channels = Vec::new();
        let token = DropsAuthService::get_token().await?;

        println!("🔍 Discovering eligible channels from {} campaigns", campaigns.len());
        println!("📋 Priority mode: {:?}", settings.priority_mode);
        println!("🎯 Priority games: {:?}", settings.priority_games);
        println!("🚫 Excluded games: {:?}", settings.excluded_games);

        for campaign in campaigns {
            println!("\n📦 Checking campaign: {} ({})", campaign.name, campaign.game_name);
            
            // Skip excluded games
            if settings.excluded_games.contains(&campaign.game_name) {
                println!("  ⛔ Skipped: Game is in excluded list");
                continue;
            }

            // Skip if priority mode is PriorityOnly and game is not in priority list
            // BUT: If priority list is empty, allow all games
            if settings.priority_mode == PriorityMode::PriorityOnly 
                && !settings.priority_games.is_empty()
                && !settings.priority_games.contains(&campaign.game_name) {
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
                println!("  🔒 Campaign has {} ACL-restricted channels", campaign.allowed_channels.len());
                for allowed_channel in &campaign.allowed_channels {
                    println!("    Checking ACL channel: {}", allowed_channel.name);
                    match Self::check_channel_status(client, &allowed_channel.id, &token).await {
                        Ok(Some(channel_info)) => {
                            println!("      ✅ Channel is online with {} viewers", channel_info.viewers);
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
                        }
                        Ok(None) => {
                            println!("      ⚫ Channel is offline");
                        }
                        Err(e) => {
                            eprintln!("      ❌ Failed to check channel status for {}: {}", allowed_channel.name, e);
                        }
                    }
                }
            } else {
                // Fetch live streams for this game with drops enabled
                println!("  🌐 Fetching live streams for game (no ACL restrictions)");
                match Self::fetch_live_streams_for_game(
                    client,
                    &campaign.game_id,
                    &campaign.game_name,
                    &token,
                ).await {
                    Ok(channels) => {
                        println!("    ✅ Found {} eligible channels", channels.len());
                        for ch in &channels {
                            println!("      - {} ({} viewers)", ch.name, ch.viewers);
                        }
                        eligible_channels.extend(channels);
                    }
                    Err(e) => {
                        eprintln!("    ❌ Failed to fetch live streams for {}: {}", campaign.game_name, e);
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

        println!("🔍 Selecting best channel from {} eligible channels", channels.len());

        let mut scored_channels: Vec<(MiningChannel, i32)> = channels
            .iter()
            .filter(|ch| ch.is_online && ch.drops_enabled)
            .map(|ch| {
                let mut score = 0;

                // Priority game bonus (higher priority = higher score)
                if let Some(priority_index) = settings.priority_games.iter().position(|g| g == &ch.game_name) {
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
                println!("  {} ({} viewers) gets viewer bonus: +{}", ch.name, ch.viewers, viewer_bonus);

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
            println!("🎯 Selected channel: {} with {} viewers (score: {})", ch.name, ch.viewers, score);
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
    async fn send_watch_payload(
        client: &Client,
        channel: &MiningChannel,
        broadcast_id: &str,
        token: &str,
    ) -> Result<bool> {
        // First, we need to get the spade URL from the channel page
        let spade_url = match Self::get_spade_url(client, &channel.name).await {
            Ok(url) => url,
            Err(e) => {
                eprintln!("❌ Failed to get spade URL for {}: {}", channel.name, e);
                return Ok(false);
            }
        };
        
        println!("📡 Got spade URL for {}: {}", channel.name, spade_url);
        
        // Get user ID from token validation
        let user_id = match Self::get_user_id(client, token).await {
            Ok(id) => id,
            Err(e) => {
                eprintln!("❌ Failed to get user ID: {}", e);
                return Ok(false);
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
        
        // Send the watch payload
        let response = client
            .post(&spade_url)
            .form(&[("data", encoded)])
            .send()
            .await?;
        
        let status = response.status();
        if status.as_u16() == 204 {
            println!("✅ Watch payload sent successfully to {}", channel.name);
            Ok(true)
        } else {
            println!("⚠️ Watch payload returned status {} for {}", status, channel.name);
            Ok(false)
        }
    }
    
    /// Extract spade URL from channel page (like TwitchDropsMiner does)
    async fn get_spade_url(client: &Client, channel_name: &str) -> Result<String> {
        let channel_url = format!("https://www.twitch.tv/{}", channel_name);
        
        // Fetch the channel page HTML
        let response = client
            .get(&channel_url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .send()
            .await?;
        
        let html = response.text().await?;
        
        // Try to find spade URL directly in the HTML (mobile view pattern)
        let spade_pattern = Regex::new(r#""spade_?url":\s*"(https://video-edge-[.\w\-/]+\.ts(?:\?[^"]*)?)"#)?;
        
        if let Some(captures) = spade_pattern.captures(&html) {
            if let Some(url) = captures.get(1) {
                return Ok(url.as_str().to_string());
            }
        }
        
        // If not found directly, look for settings JS file
        let settings_pattern = Regex::new(r#"src="(https://[\w.]+/config/settings\.[0-9a-f]{32}\.js)"#)?;
        
        if let Some(captures) = settings_pattern.captures(&html) {
            if let Some(settings_url) = captures.get(1) {
                // Fetch the settings JS file
                let settings_response = client
                    .get(settings_url.as_str())
                    .send()
                    .await?;
                
                let settings_js = settings_response.text().await?;
                
                // Look for spade URL in settings
                if let Some(captures) = spade_pattern.captures(&settings_js) {
                    if let Some(url) = captures.get(1) {
                        return Ok(url.as_str().to_string());
                    }
                }
            }
        }
        
        Err(anyhow::anyhow!("Could not find spade URL for channel {}", channel_name))
    }
    
    /// Get user ID from token validation
    async fn get_user_id(client: &Client, token: &str) -> Result<String> {
        let response = client
            .get("https://id.twitch.tv/oauth2/validate")
            .header("Authorization", format!("OAuth {}", token))
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
            .find(|c| {
                c.game_id == channel.game_id
                    && c.start_at <= now
                    && c.end_at >= now
            })
            .cloned()
    }
}

struct ChannelStatus {
    is_online: bool,
    drops_enabled: bool,
    viewers: i32,
}
