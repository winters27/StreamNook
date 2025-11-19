use crate::models::drops::*;
use crate::models::settings::AppState;
use tauri::{State, AppHandle};

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
    drops_service
        .get_active_campaigns()
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
pub async fn get_drops_statistics(
    state: State<'_, AppState>,
) -> Result<DropsStatistics, String> {
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
pub async fn start_drops_monitoring(
    channel_id: String,
    channel_name: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let drops_service = state.drops_service.lock().await;
    drops_service.start_monitoring(channel_id, channel_name, app_handle).await;
    Ok(())
}

#[tauri::command]
pub async fn stop_drops_monitoring(
    state: State<'_, AppState>,
) -> Result<(), String> {
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
    drops_service.update_current_channel(channel_id, channel_name).await;
    Ok(())
}
