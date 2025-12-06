use crate::models::settings::AppState;
use tauri::State;

#[tauri::command]
pub async fn update_layout_config(
    width: f32,
    font_size: f32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.layout_service.update_config(width, font_size);
    Ok(())
}
