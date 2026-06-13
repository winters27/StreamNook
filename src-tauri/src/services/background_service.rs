use log::{debug, error};
use std::sync::Arc;
use tauri::{AppHandle, Listener};
use tokio::sync::{Mutex, RwLock};

use chrono::Utc;

use crate::models::drops::{ChannelPointsClaim, ChannelPointsClaimType};
use crate::services::channel_points_websocket_service::ChannelPointsWebSocketService;
use crate::services::drops_auth_service::DropsAuthService;
use crate::services::drops_service::DropsService;

/// Realtime support for the channel the user is actually watching. Owns the
/// single-channel PubSub socket (instant bonus-chest availability + that
/// channel's predictions) and the points-earned listener that keeps the
/// lifetime/history totals current. Background multi-channel farming lives in
/// the opt-in plugin, not here.
pub struct BackgroundService {
    is_running: Arc<RwLock<bool>>,
    pub websocket_service: Arc<Mutex<ChannelPointsWebSocketService>>,
    drops_service: Arc<Mutex<DropsService>>,
    app_handle: AppHandle,
}

impl BackgroundService {
    pub fn new(app_handle: AppHandle, drops_service: Arc<Mutex<DropsService>>) -> Self {
        Self {
            is_running: Arc::new(RwLock::new(false)),
            websocket_service: Arc::new(Mutex::new(ChannelPointsWebSocketService::new())),
            drops_service,
            app_handle,
        }
    }

    /// Sets up the points-earned listener once. The PubSub socket itself is not
    /// connected here; it follows the watched channel via `set_watched_channel`.
    pub async fn start(&self) {
        {
            let mut is_running = self.is_running.write().await;
            if *is_running {
                debug!("Background service is already running.");
                return;
            }
            *is_running = true;
        }

        // Accumulate lifetime/history from every points-earned PubSub event
        // (watch-time and claimed chests). The single source for the stats the
        // Drops center shows; the watched channel's socket is what emits these.
        let drops_service_for_stats = self.drops_service.clone();
        self.app_handle.listen("channel-points-earned", move |event| {
            let drops_service = drops_service_for_stats.clone();
            tokio::spawn(async move {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    let channel_id = payload["channel_id"].as_str().map(|s| s.to_string());
                    let points = payload["points"].as_i64().unwrap_or(0) as i32;
                    let reason = payload["reason"].as_str().unwrap_or("watch");

                    if points > 0 {
                        debug!("Channel points earned: +{} ({})", points, reason);
                        let claim = ChannelPointsClaim {
                            id: uuid::Uuid::new_v4().to_string(),
                            channel_id: channel_id.unwrap_or_default(),
                            channel_name: String::new(),
                            points_earned: points,
                            claimed_at: Utc::now(),
                            claim_type: match reason {
                                "WATCH" | "watch" => ChannelPointsClaimType::Watch,
                                "CLAIM" | "claim" => ChannelPointsClaimType::Bonus,
                                _ => ChannelPointsClaimType::Watch,
                            },
                        };
                        drops_service.lock().await.add_channel_points_claim(claim).await;
                    }
                }
            });
        });
    }

    /// Point the realtime socket at the channel now on screen: subscribes its
    /// community-points (bonus-chest availability) and predictions topics.
    /// Idempotent reconnect — calling it for a new channel drops the prior one.
    pub async fn set_watched_channel(&self, channel_id: String, login: String) {
        let token = match DropsAuthService::get_token().await {
            Ok(t) => t,
            // No drops credential: the realtime socket can't authenticate. The
            // chest still surfaces via the frontend's 60s poll; nothing breaks.
            Err(_) => return,
        };
        let Some(user_id) = Self::fetch_user_id(&token).await else {
            return;
        };

        let mut ws = self.websocket_service.lock().await;
        ws.register_channel_mapping(&channel_id, &login, &login).await;
        if let Err(e) = ws
            .connect_to_channels(
                vec![channel_id.clone()],
                &user_id,
                &token,
                self.app_handle.clone(),
            )
            .await
        {
            error!("Failed to connect watched-channel socket: {}", e);
        }
        ws.register_active_channel(&channel_id).await;
    }

    /// Tear the realtime socket down when no channel is being watched.
    pub async fn clear_watched_channel(&self) {
        self.websocket_service.lock().await.disconnect_all().await;
    }

    /// Resolve the authenticated user's id from the drops token (needed for the
    /// user-scoped PubSub topics).
    async fn fetch_user_id(token: &str) -> Option<String> {
        let resp = crate::services::http::client()
            .get("https://id.twitch.tv/oauth2/validate")
            .header("Authorization", format!("OAuth {}", token))
            .send()
            .await
            .ok()?;
        let json: serde_json::Value = resp.json().await.ok()?;
        json["user_id"].as_str().map(|s| s.to_string())
    }

    /// Multi-channel balances were populated by the removed farming loop. The
    /// leaderboard that reads this is now empty pending a non-farming source.
    pub async fn get_channel_points_balances(
        &self,
    ) -> Vec<crate::models::drops::ChannelPointsBalance> {
        Vec::new()
    }
}
