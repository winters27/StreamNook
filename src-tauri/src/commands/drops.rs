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
    let drops_service = state.drops_service.lock().await;
    drops_service.update_settings(settings).await;
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
pub async fn claim_drop(drop_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let drops_service = state.drops_service.lock().await;
    drops_service
        .claim_drop(&drop_id)
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
    
    app_handle.opener()
        .open_url(url, None::<String>)
        .map_err(|e| format!("Failed to open drops details: {}", e))
}
