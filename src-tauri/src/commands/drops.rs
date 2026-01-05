use crate::models::drops::*;
use crate::models::settings::AppState;
use crate::services::drops_auth_service::{DropsAuthService, DropsDeviceCodeInfo};
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn get_drops_settings(state: State<'_, AppState>) -> Result<DropsSettings, String> {
    let drops_service = state.drops_service.lock().await;
    Ok(drops_service.get_settings().await)
}

#[tauri::command]
pub async fn update_drops_settings(
    settings: DropsSettings,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Update the in-memory drops service settings
    let drops_service = state.drops_service.lock().await;
    drops_service.update_settings(settings.clone()).await;
    drop(drops_service); // Release the lock before accessing main settings

    // Also persist to the main settings file so changes survive app restart
    {
        let mut app_settings = state.settings.lock().map_err(|e| e.to_string())?;
        app_settings.drops = settings;
    }

    // Save to disk
    let settings_to_save = {
        let app_settings = state.settings.lock().map_err(|e| e.to_string())?;
        app_settings.clone()
    };

    // Use the save_settings logic to persist to file
    let app_dir = crate::services::cache_service::get_app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    let settings_path = app_dir.join("settings.json");
    let json = serde_json::to_string_pretty(&settings_to_save)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    std::fs::write(&settings_path, json)
        .map_err(|e| format!("Failed to write settings file: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn get_active_drop_campaigns(
    state: State<'_, AppState>,
) -> Result<Vec<DropCampaign>, String> {
    let drops_service = state.drops_service.lock().await;
    // Use cached version to avoid excessive API calls when UI opens
    drops_service
        .get_all_active_campaigns_cached()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_drops_inventory(state: State<'_, AppState>) -> Result<InventoryResponse, String> {
    let drops_service = state.drops_service.lock().await;
    drops_service
        .fetch_inventory()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_drop_progress(state: State<'_, AppState>) -> Result<Vec<DropProgress>, String> {
    let drops_service = state.drops_service.lock().await;
    Ok(drops_service.get_drop_progress().await)
}

#[tauri::command]
pub async fn claim_drop(
    drop_id: String,
    drop_instance_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let drops_service = state.drops_service.lock().await;
    drops_service
        .claim_drop(&drop_id, drop_instance_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_channel_points(
    channel_id: String,
    channel_name: String,
    state: State<'_, AppState>,
) -> Result<Option<ChannelPointsClaim>, String> {
    let drops_service = state.drops_service.lock().await;
    drops_service
        .check_channel_points(&channel_id, &channel_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn claim_channel_points(
    channel_id: String,
    channel_name: String,
    claim_id: String,
    state: State<'_, AppState>,
) -> Result<i32, String> {
    let drops_service = state.drops_service.lock().await;
    drops_service
        .claim_channel_points(&channel_id, &channel_name, &claim_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_drops_statistics(state: State<'_, AppState>) -> Result<DropsStatistics, String> {
    let drops_service = state.drops_service.lock().await;
    Ok(drops_service.get_statistics().await)
}

#[tauri::command]
pub async fn get_claimed_drops(state: State<'_, AppState>) -> Result<Vec<ClaimedDrop>, String> {
    let drops_service = state.drops_service.lock().await;
    Ok(drops_service.get_claimed_drops().await)
}

#[tauri::command]
pub async fn get_channel_points_history(
    state: State<'_, AppState>,
) -> Result<Vec<ChannelPointsClaim>, String> {
    let drops_service = state.drops_service.lock().await;
    Ok(drops_service.get_channel_points_history().await)
}

#[tauri::command]
pub async fn get_channel_points_balance(
    channel_id: String,
    state: State<'_, AppState>,
) -> Result<Option<ChannelPointsBalance>, String> {
    let drops_service = state.drops_service.lock().await;
    Ok(drops_service.get_channel_points_balance(&channel_id).await)
}

#[tauri::command]
pub async fn get_all_channel_points_balances(
    state: State<'_, AppState>,
) -> Result<Vec<ChannelPointsBalance>, String> {
    let background_service = state.background_service.lock().await;
    Ok(background_service.get_channel_points_balances().await)
}

#[tauri::command]
pub async fn start_drops_monitoring(
    channel_id: String,
    channel_name: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let drops_service = state.drops_service.lock().await;
    drops_service
        .start_monitoring(channel_id, channel_name, app_handle)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn stop_drops_monitoring(state: State<'_, AppState>) -> Result<(), String> {
    let drops_service = state.drops_service.lock().await;
    drops_service.stop_monitoring().await;
    Ok(())
}

#[tauri::command]
pub async fn update_monitoring_channel(
    channel_id: String,
    channel_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let drops_service = state.drops_service.lock().await;
    drops_service
        .update_current_channel(channel_id, channel_name)
        .await;
    Ok(())
}

// Mining commands
#[tauri::command]
pub async fn start_auto_mining(
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let mining_service = state.mining_service.lock().await;
    mining_service
        .start_mining(app_handle)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_campaign_mining(
    campaign_id: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let mining_service = state.mining_service.lock().await;
    mining_service
        .start_campaign_mining(campaign_id, app_handle)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_eligible_channels_for_campaign(
    campaign_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::drops::MiningChannel>, String> {
    let mining_service = state.mining_service.lock().await;
    mining_service
        .get_eligible_channels_for_campaign(campaign_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_campaign_mining_with_channel(
    campaign_id: String,
    channel_id: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let mining_service = state.mining_service.lock().await;
    mining_service
        .start_campaign_mining_with_channel(campaign_id, channel_id, app_handle)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_auto_mining(
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let mining_service = state.mining_service.lock().await;
    mining_service.stop_mining(app_handle).await;
    Ok(())
}

#[tauri::command]
pub async fn get_mining_status(state: State<'_, AppState>) -> Result<MiningStatus, String> {
    let mining_service = state.mining_service.lock().await;
    Ok(mining_service.get_mining_status().await)
}

#[tauri::command]
pub async fn is_auto_mining(state: State<'_, AppState>) -> Result<bool, String> {
    let mining_service = state.mining_service.lock().await;
    Ok(mining_service.is_mining().await)
}

// Drops Authentication commands
#[tauri::command]
pub async fn start_drops_device_flow() -> Result<DropsDeviceCodeInfo, String> {
    DropsAuthService::start_device_flow()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn poll_drops_token(
    device_code: String,
    interval: u64,
    expires_in: u64,
) -> Result<String, String> {
    DropsAuthService::poll_for_token(&device_code, interval, expires_in)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn drops_logout() -> Result<(), String> {
    DropsAuthService::logout().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn is_drops_authenticated() -> Result<bool, String> {
    Ok(DropsAuthService::is_authenticated().await)
}

#[tauri::command]
pub async fn validate_drops_token() -> Result<bool, String> {
    DropsAuthService::validate_token()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_drop_details(app_handle: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    app_handle
        .opener()
        .open_url(url, None::<String>)
        .map_err(|e| format!("Failed to open drops details: {}", e))
}

// Prediction commands
#[tauri::command]
pub async fn place_prediction(
    event_id: String,
    outcome_id: String,
    points: i32,
    channel_id: String,
) -> Result<serde_json::Value, String> {
    use crate::services::drops_auth_service::DropsAuthService;
    use reqwest::Client;
    use serde_json::json;

    // Use the mobile/Android client ID for GQL queries
    const CLIENT_ID: &str = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";

    let token = DropsAuthService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;

    let client = Client::new();

    // Use the MakePrediction GQL mutation
    let mutation = r#"
    mutation MakePrediction($input: MakePredictionInput!) {
        makePrediction(input: $input) {
            prediction {
                id
                points
            }
            error {
                code
            }
        }
    }
    "#;

    let response = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", CLIENT_ID)
        .header("Authorization", format!("OAuth {}", token))
        .json(&json!({
            "operationName": "MakePrediction",
            "query": mutation,
            "variables": {
                "input": {
                    "eventID": event_id,
                    "outcomeID": outcome_id,
                    "points": points,
                    "transactionID": uuid::Uuid::new_v4().to_string()
                }
            }
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to send prediction request: {}", e))?;

    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse prediction response: {}", e))?;

    // Check for errors in the response
    if let Some(error) = result["data"]["makePrediction"]["error"].as_object() {
        let error_code = error
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("UNKNOWN");
        return Err(format!("Prediction failed: {}", error_code));
    }

    // Log successful prediction
    if let Some(prediction) = result["data"]["makePrediction"]["prediction"].as_object() {
        let pred_id = prediction.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let pred_points = prediction
            .get("points")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        println!(
            "🔮 Prediction placed successfully! ID: {}, Points: {}",
            pred_id, pred_points
        );
    }

    Ok(result)
}

#[tauri::command]
pub async fn get_active_prediction(
    channel_login: String,
) -> Result<Option<serde_json::Value>, String> {
    use crate::services::drops_auth_service::DropsAuthService;
    use reqwest::Client;
    use serde_json::json;

    const CLIENT_ID: &str = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";

    let token = DropsAuthService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;

    let client = Client::new();

    // GQL query to fetch active prediction for a channel
    let query = r#"
    query GetChannelPrediction($login: String!) {
        channel(name: $login) {
            id
            activePredictionEvent {
                id
                status
                title
                predictionWindowSeconds
                createdAt
                lockedAt
                endedAt
                winningOutcome {
                    id
                }
                outcomes {
                    id
                    title
                    color
                    totalPoints
                    totalUsers
                }
            }
        }
    }
    "#;

    let response = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", CLIENT_ID)
        .header("Authorization", format!("OAuth {}", token))
        .json(&json!({
            "operationName": "GetChannelPrediction",
            "query": query,
            "variables": {
                "login": channel_login.to_lowercase()
            }
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch prediction: {}", e))?;

    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse prediction response: {}", e))?;

    // Check if there's an active prediction
    if let Some(prediction) = result["data"]["channel"]["activePredictionEvent"].as_object() {
        let channel_id = result["data"]["channel"]["id"].as_str().unwrap_or("");

        // Transform to match the format we use in PredictionOverlay
        let status = prediction
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("ACTIVE");
        let prediction_id = prediction.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let title = prediction
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let prediction_window = prediction
            .get("predictionWindowSeconds")
            .and_then(|v| v.as_i64())
            .unwrap_or(60);
        let created_at = prediction
            .get("createdAt")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let winning_outcome_id = prediction
            .get("winningOutcome")
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_str());

        // Transform outcomes
        let mut outcomes = Vec::new();
        if let Some(outcomes_array) = prediction.get("outcomes").and_then(|v| v.as_array()) {
            for outcome in outcomes_array {
                outcomes.push(json!({
                    "id": outcome.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    "title": outcome.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                    "color": outcome.get("color").and_then(|v| v.as_str()).unwrap_or("BLUE"),
                    "total_points": outcome.get("totalPoints").and_then(|v| v.as_i64()).unwrap_or(0),
                    "total_users": outcome.get("totalUsers").and_then(|v| v.as_i64()).unwrap_or(0)
                }));
            }
        }

        println!(
            "🔮 Found active prediction on {}: {} (status: {})",
            channel_login, title, status
        );

        return Ok(Some(json!({
            "channel_id": channel_id,
            "prediction_id": prediction_id,
            "title": title,
            "status": status,
            "outcomes": outcomes,
            "prediction_window_seconds": prediction_window,
            "created_at": created_at,
            "winning_outcome_id": winning_outcome_id
        })));
    }

    Ok(None)
}

#[tauri::command]
pub async fn get_channel_points_for_channel(
    channel_login: String,
) -> Result<serde_json::Value, String> {
    use crate::services::drops_auth_service::DropsAuthService;
    use reqwest::Client;
    use serde_json::json;

    // Use web client ID for this query (matches the working channel_points_service)
    const CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";

    let token = DropsAuthService::get_token()
        .await
        .map_err(|e| format!("Failed to get token: {}", e))?;

    let client = Client::new();

    // Use the same query structure as channel_points_service which works correctly
    let query = r#"
    query ChannelPointsContext($channelLogin: String!) {
        user(login: $channelLogin) {
            id
            login
            displayName
            channel {
                id
                self {
                    communityPoints {
                        balance
                        availableClaim {
                            id
                        }
                    }
                }
            }
        }
    }
    "#;

    let response = client
        .post("https://gql.twitch.tv/gql")
        .header("Client-Id", CLIENT_ID)
        .header("Authorization", format!("OAuth {}", token))
        .json(&json!({
            "operationName": "ChannelPointsContext",
            "query": query,
            "variables": {
                "channelLogin": channel_login.to_lowercase()
            }
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch channel points: {}", e))?;

    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse channel points response: {}", e))?;

    Ok(result)
}
