use log::{debug, error};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::{Mutex, RwLock};
use tokio::time::{interval, Duration};

use crate::models::drops::{ChannelPointsClaim, ChannelPointsClaimType, ReservedStreamSlot};
use crate::models::settings::Settings;
use crate::services::channel_points_service::ChannelPointsService;
use crate::services::channel_points_websocket_service::ChannelPointsWebSocketService;
use crate::services::drops_auth_service::DropsAuthService;
use crate::services::drops_service::DropsService;
use crate::services::twitch_service::TwitchService;
use chrono::{DateTime, Utc};

pub struct BackgroundService {
    is_running: Arc<RwLock<bool>>,
    channel_points_service: Arc<Mutex<ChannelPointsService>>,
    websocket_service: Arc<Mutex<ChannelPointsWebSocketService>>,
    drops_service: Arc<Mutex<DropsService>>,
    settings: Arc<RwLock<Settings>>,
    app_handle: AppHandle,
    /// Reserved watch slot for the current stream (ensures presence in chat for gifted subs)
    reserved_slot: Arc<RwLock<ReservedStreamSlot>>,
}

impl BackgroundService {
    pub fn new(
        settings: Arc<RwLock<Settings>>,
        app_handle: AppHandle,
        drops_service: Arc<Mutex<DropsService>>,
    ) -> Self {
        Self {
            is_running: Arc::new(RwLock::new(false)),
            channel_points_service: Arc::new(Mutex::new(ChannelPointsService::new())),
            websocket_service: Arc::new(Mutex::new(ChannelPointsWebSocketService::new())),
            drops_service,
            settings,
            app_handle,
            reserved_slot: Arc::new(RwLock::new(ReservedStreamSlot::default())),
        }
    }

    pub async fn start(&self) {
        let mut is_running = self.is_running.write().await;
        if *is_running {
            debug!("Background service is already running.");
            return;
        }
        *is_running = true;
        debug!("Starting background service for channel points farming with WebSocket pooling.");

        let is_running = self.is_running.clone();
        let settings = self.settings.clone();
        let channel_points_service = self.channel_points_service.clone();
        let websocket_service = self.websocket_service.clone();
        let app_handle = self.app_handle.clone();

        // Listen for channel points earned events and add them to statistics
        let drops_service_for_stats = self.drops_service.clone();
        app_handle.listen("channel-points-earned", move |event| {
            let drops_service = drops_service_for_stats.clone();
            tokio::spawn(async move {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload()) {
                    let channel_id = payload["channel_id"].as_str().map(|s| s.to_string());
                    let points = payload["points"].as_i64().unwrap_or(0) as i32;
                    let reason = payload["reason"].as_str().unwrap_or("watch");

                    if points > 0 {
                        debug!("💰 Channel points earned: +{} ({})", points, reason);

                        // Create a channel points claim record
                        let claim = ChannelPointsClaim {
                            id: uuid::Uuid::new_v4().to_string(),
                            channel_id: channel_id.unwrap_or_default(),
                            channel_name: String::new(), // Will be filled if we have it
                            points_earned: points,
                            claimed_at: Utc::now(),
                            claim_type: match reason {
                                "WATCH" | "watch" => ChannelPointsClaimType::Watch,
                                "CLAIM" | "claim" => ChannelPointsClaimType::Bonus,
                                _ => ChannelPointsClaimType::Watch,
                            },
                        };

                        // Add to drops service history
                        drops_service
                            .lock()
                            .await
                            .add_channel_points_claim(claim)
                            .await;
                    }
                }
            });
        });

        // Initialize WebSocket connections for all followed channels
        let ws_service = websocket_service.clone();
        let app_handle_ws = app_handle.clone();
        tokio::spawn(async move {
            // Get token and user ID
            let (token, user_id) = match DropsAuthService::get_token().await {
                Ok(token) => {
                    // Get user ID from token
                    match ChannelPointsService::new().get_user_id(&token).await {
                        Ok(id) => (token, id),
                        Err(e) => {
                            error!("Failed to get user ID for WebSockets: {}", e);
                            return;
                        }
                    }
                }
                Err(e) => {
                    error!("Failed to get token for WebSockets: {}", e);
                    return;
                }
            };

            // Get all followed channels to monitor
            match TwitchService::get_followed_streams(&app_handle_ws.state()).await {
                Ok(streams) => {
                    let channel_ids: Vec<String> =
                        streams.iter().map(|s| s.user_id.clone()).collect();

                    if !channel_ids.is_empty() {
                        debug!(
                            "🔌 Connecting WebSockets to {} channels for real-time monitoring",
                            channel_ids.len()
                        );
                        let mut ws = ws_service.lock().await;

                        // Register channel ID to login/display_name mappings before connecting
                        for stream in &streams {
                            ws.register_channel_mapping(
                                &stream.user_id,
                                &stream.user_login,
                                &stream.user_name,
                            )
                            .await;
                        }

                        if let Err(e) = ws
                            .connect_to_channels(channel_ids, &user_id, &token, app_handle_ws)
                            .await
                        {
                            error!("Failed to connect WebSockets: {}", e);
                        }
                    }
                }
                Err(e) => {
                    error!("Failed to get channels for WebSocket monitoring: {}", e);
                }
            }
        });

        // Main background loop for channel points claiming
        let is_running_claim = is_running.clone();
        let settings_claim = settings.clone();
        let cps_claim = channel_points_service.clone();
        let app_handle_claim = app_handle.clone();

        tokio::spawn(async move {
            let mut check_interval = interval(Duration::from_secs(300)); // Check every 5 minutes for bonus claims
            while *is_running_claim.read().await {
                check_interval.tick().await;

                let auto_claim_enabled = {
                    let s = settings_claim.read().await;
                    s.drops.auto_claim_channel_points
                };

                if auto_claim_enabled {
                    debug!("Checking for channel points bonuses to claim...");
                    // Use the drops token (same user, different client ID)
                    let token = match DropsAuthService::get_token().await {
                        Ok(token) => token,
                        Err(e) => {
                            error!(
                                "Could not get drops auth token for channel points farming: {}",
                                e
                            );
                            continue;
                        }
                    };

                    match TwitchService::get_followed_streams(&app_handle_claim.state()).await {
                        Ok(live_streams) => {
                            if live_streams.is_empty() {
                                debug!("No followed streams are currently live.");
                                continue;
                            }
                            debug!(
                                "Found {} live streams to check for channel points bonuses.",
                                live_streams.len()
                            );
                            let cps = cps_claim.lock().await;

                            // Check and claim bonuses for all live streams
                            for stream in &live_streams {
                                debug!("Checking channel points for: {}", stream.user_name);
                                match cps
                                    .check_and_claim_points(
                                        &stream.user_login,
                                        &token,
                                        auto_claim_enabled,
                                    )
                                    .await
                                {
                                    Ok(Some(points)) => {
                                        debug!(
                                            "Successfully claimed {} bonus points for {}.",
                                            points, stream.user_name
                                        );
                                    }
                                    Ok(None) => {
                                        // No bonus available, this is normal
                                    }
                                    Err(e) => {
                                        error!(
                                            "Error checking/claiming points for {}: {}",
                                            stream.user_name, e
                                        );
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            error!("Error fetching followed streams: {}", e);
                        }
                    }
                } else {
                    debug!("Auto-claiming channel points is disabled.");
                }
            }
            debug!("Channel points bonus claiming loop stopped.");
        });

        // Stream watching loop for earning channel points (separate from bonus claiming)
        // This implements proper rotation through all followed live streams
        let is_running_watch = is_running.clone();
        let settings_watch = settings.clone();
        let cps_watch = channel_points_service.clone();
        let app_handle_watch = app_handle.clone();
        let reserved_slot_watch = self.reserved_slot.clone();

        tokio::spawn(async move {
            let mut watch_interval = interval(Duration::from_secs(60)); // Send watch payload every minute
            let mut minutes_since_rotation = 0u32; // Track minutes since last rotation
            const ROTATION_INTERVAL_MINUTES: u32 = 15; // Rotate every 15 minutes
            const MAX_CONCURRENT_STREAMS: usize = 2; // Twitch allows earning points on 2 streams concurrently

            // Track when each stream was last watched (channel_id -> last_watched_time)
            // This persists across rotations to ensure fair distribution
            let mut stream_watch_history: HashMap<String, DateTime<Utc>> = HashMap::new();
            let mut current_rotation_index: usize = 0; // Track where we are in the rotation

            // Track configuration state to force immediate rotation when settings change
            let mut last_priority_list: Vec<String> = {
                let s = settings_watch.read().await;
                s.drops
                    .priority_farm_channels
                    .iter()
                    .map(|c| c.channel_id.clone())
                    .collect()
            };

            debug!("🔄 [CP-WATCH] Channel points watch loop started");

            while *is_running_watch.read().await {
                watch_interval.tick().await;
                minutes_since_rotation += 1;

                let (auto_claim_enabled, reserve_token_enabled, priority_farm_channels) = {
                    let s = settings_watch.read().await;
                    (
                        s.drops.auto_claim_channel_points,
                        s.drops.reserve_token_for_current_stream,
                        s.drops.priority_farm_channels.clone(),
                    )
                };

                debug!(
                    "🔍 [CP-WATCH] Tick - auto_claim_channel_points={}",
                    auto_claim_enabled
                );

                if !auto_claim_enabled {
                    debug!("⏸️ [CP-WATCH] Channel points farming disabled in settings");
                    // If disabled, stop watching all streams
                    let cps = cps_watch.lock().await;
                    let watching = cps.get_watching_streams().await;
                    for stream in watching {
                        let _ = cps.stop_watching_stream(&stream.channel_id).await;
                    }
                    continue;
                }

                // Check if priority configuration has changed, force rotation if so
                let current_priority_ids: Vec<String> = priority_farm_channels
                    .iter()
                    .map(|c| c.channel_id.clone())
                    .collect();
                if current_priority_ids != last_priority_list {
                    debug!("⚙️ [CP-WATCH] Priority farm channels configuration changed — forcing immediate rotation");
                    minutes_since_rotation = ROTATION_INTERVAL_MINUTES; // Force rotation
                    last_priority_list = current_priority_ids;
                }

                // Get token for watch payloads
                let token = match DropsAuthService::get_token().await {
                    Ok(token) => token,
                    Err(e) => {
                        error!("Could not get auth token for watching streams: {}", e);
                        continue;
                    }
                };

                // Read the current reservation (used throughout this tick)
                let reserved = reserved_slot_watch.read().await;
                let reserved_id = if reserve_token_enabled {
                    reserved.channel_id.clone()
                } else {
                    None
                };
                let reserved_login = if reserve_token_enabled {
                    reserved.channel_login.clone()
                } else {
                    None
                };
                drop(reserved); // Release read lock early

                // Diagnostic: log reservation state every tick
                if let (Some(ref rid), Some(ref rlogin)) = (&reserved_id, &reserved_login) {
                    debug!("🔒 [CP-WATCH] Reservation active: {} (ID: {})", rlogin, rid);
                } else if reserve_token_enabled {
                    debug!("🔓 [CP-WATCH] No reservation set (reserve_token_enabled=true)");
                }

                // Get current live streams
                let live_streams =
                    match TwitchService::get_followed_streams(&app_handle_watch.state()).await {
                        Ok(streams) => streams,
                        Err(e) => {
                            error!("Error fetching followed streams: {}", e);
                            continue;
                        }
                    };

                if live_streams.is_empty() && reserved_id.is_none() {
                    // No streams live and no reservation, clear watching
                    let cps = cps_watch.lock().await;
                    let watching = cps.get_watching_streams().await;
                    for stream in watching {
                        let _ = cps.stop_watching_stream(&stream.channel_id).await;
                    }
                    continue;
                }

                // Check if it's time to rotate streams
                let cps = cps_watch.lock().await;
                let currently_watching = cps.get_watching_streams().await;

                if minutes_since_rotation >= ROTATION_INTERVAL_MINUTES
                    || currently_watching.is_empty()
                {
                    // Rotation needed OR cold-start (no streams watching yet) — act immediately
                    if currently_watching.is_empty()
                        && minutes_since_rotation < ROTATION_INTERVAL_MINUTES
                    {
                        debug!(
                            "⚡ [CP-WATCH] Cold-start: no streams watching, starting immediately"
                        );
                    }
                    minutes_since_rotation = 0; // Reset counter

                    let total_streams = live_streams.len();
                    debug!(
                        "🔄 Rotating streams for channel points farming ({} live streams)...",
                        total_streams
                    );

                    // Stop watching NON-RESERVED streams only (protect the reserved stream)
                    for stream in &currently_watching {
                        let is_reserved = reserved_id
                            .as_ref()
                            .is_some_and(|rid| stream.channel_id == *rid);
                        if !is_reserved {
                            // Record when we last watched this stream
                            stream_watch_history.insert(stream.channel_id.clone(), Utc::now());
                            let _ = cps.stop_watching_stream(&stream.channel_id).await;
                        }
                    }

                    // Select next streams using round-robin rotation
                    let mut streams_to_watch: Vec<_> = Vec::new();
                    let mut reserved_stream_id: Option<String> = None;

                    // 1. Reserved stream always gets a slot
                    if let Some(ref res_id) = reserved_id {
                        // Check if reserved stream is in the followed live list
                        if let Some(reserved_stream) =
                            live_streams.iter().find(|s| s.user_id == *res_id)
                        {
                            streams_to_watch.push(reserved_stream.clone());
                            reserved_stream_id = Some(res_id.clone());
                            debug!(
                                "  🔒 Reserved slot: {} (for gifted sub eligibility)",
                                reserved_stream.user_name
                            );
                        } else if let Some(ref res_login) = reserved_login {
                            // Stream not in followed list — try to start watching directly
                            // (handles non-followed channels the user navigated to)
                            debug!(
                                "  🔒 Reserved stream {} not in followed list — starting directly",
                                res_login
                            );
                            if let Err(e) =
                                cps.start_watching_stream(res_id, res_login, &token).await
                            {
                                debug!(
                                    "  ⚠️ Could not start reserved stream {}: {} (may be offline)",
                                    res_login, e
                                );
                            } else {
                                reserved_stream_id = Some(res_id.clone());
                            }
                        }
                    }

                    // Calculate how many slots are available for rotation
                    let rotation_slots = MAX_CONCURRENT_STREAMS
                        - streams_to_watch.len()
                        - if reserved_stream_id.is_some() && streams_to_watch.is_empty() {
                            1
                        } else {
                            0
                        };

                    // Determine the rotation pool:
                    // If user has a priority farm list, only rotate through those channels
                    // Otherwise, rotate through all followed live streams
                    let priority_ids: Vec<String> = priority_farm_channels
                        .iter()
                        .map(|c| c.channel_id.clone())
                        .collect();
                    let has_priority_list = !priority_ids.is_empty();

                    let rotation_pool: Vec<_> = if has_priority_list {
                        // Filter to only priority channels that are currently live
                        let filtered: Vec<_> = live_streams
                            .iter()
                            .filter(|s| priority_ids.contains(&s.user_id))
                            .filter(|s| {
                                reserved_stream_id
                                    .as_ref()
                                    .is_none_or(|rid| s.user_id != *rid)
                            })
                            .cloned()
                            .collect();

                        if filtered.is_empty() {
                            // None of the priority channels are live — fall back to all
                            debug!(
                                "  ⚠️ No priority farm channels live, falling back to all followed"
                            );
                            live_streams
                                .iter()
                                .filter(|s| {
                                    reserved_stream_id
                                        .as_ref()
                                        .is_none_or(|rid| s.user_id != *rid)
                                })
                                .cloned()
                                .collect()
                        } else {
                            debug!(
                                "  🎯 Priority farm list active: {} of {} channels live",
                                filtered.len(),
                                priority_ids.len()
                            );
                            filtered
                        }
                    } else {
                        // No priority list — use all followed streams
                        live_streams
                            .iter()
                            .filter(|s| {
                                reserved_stream_id
                                    .as_ref()
                                    .is_none_or(|rid| s.user_id != *rid)
                            })
                            .cloned()
                            .collect()
                    };

                    // Sort rotation pool by when they were last watched (oldest first)
                    let mut stream_priority: Vec<_> = rotation_pool
                        .iter()
                        .map(|s| {
                            let last_watched = stream_watch_history
                                .get(&s.user_id)
                                .copied()
                                .unwrap_or(DateTime::<Utc>::MIN_UTC);
                            (s, last_watched)
                        })
                        .collect();

                    // Sort by last watched time (oldest/never watched first)
                    stream_priority.sort_by(|a, b| a.1.cmp(&b.1));

                    // Take the streams that were watched longest ago (or never)
                    for (stream, last_watched) in stream_priority.iter().take(rotation_slots) {
                        streams_to_watch.push((*stream).clone());
                        let time_since = if *last_watched == DateTime::<Utc>::MIN_UTC {
                            "never watched".to_string()
                        } else {
                            let duration = Utc::now().signed_duration_since(*last_watched);
                            format!("{} min ago", duration.num_minutes())
                        };
                        debug!(
                            "  📌 Rotation slot: {} (last watched: {})",
                            stream.user_name, time_since
                        );
                    }

                    // Update rotation index for logging
                    current_rotation_index =
                        (current_rotation_index + MAX_CONCURRENT_STREAMS) % total_streams.max(1);

                    // Start watching the selected streams (is_watching guard prevents counter-reset)
                    for stream in &streams_to_watch {
                        let channel_id = &stream.user_id;
                        let channel_login = &stream.user_login;

                        debug!(
                            "🎬 Starting to watch {} for channel points (rotation {}/{})",
                            stream.user_name,
                            streams_to_watch
                                .iter()
                                .position(|s| s.user_id == stream.user_id)
                                .unwrap_or(0)
                                + 1,
                            total_streams
                        );
                        if let Err(e) = cps
                            .start_watching_stream(channel_id, channel_login, &token)
                            .await
                        {
                            error!("Failed to start watching {}: {}", stream.user_name, e);
                        }
                    }

                    // Log rotation status
                    if total_streams > MAX_CONCURRENT_STREAMS {
                        let rotation_cycle =
                            (total_streams + MAX_CONCURRENT_STREAMS - 1) / MAX_CONCURRENT_STREAMS;
                        debug!(
                            "🔄 Full rotation cycle: {} streams / {} per rotation = ~{} rotations needed",
                            total_streams, MAX_CONCURRENT_STREAMS, rotation_cycle
                        );
                    }
                } else {
                    // Not a rotation tick — but ensure reserved stream is always in watching set
                    if let (Some(ref res_id), Some(ref res_login)) = (&reserved_id, &reserved_login)
                    {
                        if !cps.is_watching(res_id).await {
                            debug!("🔒 [CP-WATCH] Reserved stream {} not in watching set, adding immediately", res_login);
                            if let Err(e) =
                                cps.start_watching_stream(res_id, res_login, &token).await
                            {
                                debug!("  ⚠️ Could not add reserved stream {}: {}", res_login, e);
                            }
                        }
                    }
                }

                // Send minute-watched payloads for current streams (with reserved priority)
                let watching = cps.get_watching_streams().await;
                if !watching.is_empty() {
                    debug!(
                        "📡 Sending minute-watched payloads for {} streams (farming {} total live)",
                        watching.len(),
                        live_streams.len()
                    );
                    if let Err(e) = cps
                        .send_minute_watched_for_streams(&token, reserved_id.as_deref())
                        .await
                    {
                        error!("Error sending minute-watched payloads: {}", e);
                    }
                }
            }
            debug!("Stream watching loop stopped.");
        });
    }

    #[allow(dead_code)]
    pub async fn stop(&self) {
        let mut is_running = self.is_running.write().await;
        *is_running = false;

        // Stop watching all streams
        let cps = self.channel_points_service.lock().await;
        let watching = cps.get_watching_streams().await;
        for stream in watching {
            let _ = cps.stop_watching_stream(&stream.channel_id).await;
        }

        debug!("Background service stopped.");
    }

    /// Get all channel points balances from the channel points service
    pub async fn get_channel_points_balances(
        &self,
    ) -> Vec<crate::models::drops::ChannelPointsBalance> {
        let cps = self.channel_points_service.lock().await;
        cps.get_all_balances().await
    }

    /// Reserve a watch slot for a specific channel
    /// This ensures the channel always gets one of the 2 concurrent watch slots
    pub async fn reserve_channel(&self, channel_id: String, channel_login: String) {
        let mut reserved = self.reserved_slot.write().await;
        reserved.channel_id = Some(channel_id);
        reserved.channel_login = Some(channel_login.clone());
        reserved.reserved_at = Some(Utc::now());
        debug!("🔒 Reserved watch slot for: {}", channel_login);
    }

    /// Clear the reserved slot, returning it to the rotation pool
    pub async fn clear_reservation(&self) {
        let mut reserved = self.reserved_slot.write().await;
        if let Some(login) = &reserved.channel_login {
            debug!("🔓 Cleared reservation for: {}", login);
        }
        *reserved = ReservedStreamSlot::default();
    }

    /// Get current reservation status
    pub async fn get_reservation(&self) -> ReservedStreamSlot {
        self.reserved_slot.read().await.clone()
    }
}
