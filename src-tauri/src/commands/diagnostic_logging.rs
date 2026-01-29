//! Tauri commands for diagnostic logging control.

use crate::services::diagnostic_logger;
use tauri::command;

/// Set whether diagnostic logging is enabled.
/// Called from frontend when user changes the error_reporting_enabled setting.
#[command]
pub fn set_diagnostics_enabled(enabled: bool) {
    diagnostic_logger::set_diagnostics_enabled(enabled);
}

/// Check if diagnostics are currently enabled.
#[command]
pub fn is_diagnostics_enabled() -> bool {
    diagnostic_logger::is_diagnostics_enabled()
}
