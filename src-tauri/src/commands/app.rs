use tauri::command;

#[command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[command]
pub fn get_app_name() -> String {
    env!("CARGO_PKG_NAME").to_string()
}

#[command]
pub fn get_app_description() -> String {
    env!("CARGO_PKG_DESCRIPTION").to_string()
}

#[command]
pub fn get_app_authors() -> String {
    env!("CARGO_PKG_AUTHORS").to_string()
}
