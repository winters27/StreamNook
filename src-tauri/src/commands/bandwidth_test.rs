use crate::services::baseline_speed_service::BaselineSpeedResult;

/// Run a quick baseline speed test only
#[tauri::command]
pub async fn run_baseline_speed_test(
    app_handle: tauri::AppHandle,
) -> Result<BaselineSpeedResult, String> {
    crate::services::baseline_speed_service::BaselineSpeedService::run_quick_test(app_handle)
        .await
        .map_err(|e| e.to_string())
}
