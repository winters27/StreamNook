//! Diagnostic-aware logging configuration service.
//!
//! Controls the log level at runtime based on user's diagnostic settings.
//! When diagnostics are disabled, only WARN and ERROR logs are output.
//! When enabled, DEBUG and INFO logs are also shown.

use lazy_static::lazy_static;
use log::LevelFilter;
use std::sync::atomic::{AtomicBool, Ordering};

lazy_static! {
    /// Global diagnostics enabled state
    static ref DIAGNOSTICS_ENABLED: AtomicBool = AtomicBool::new(true);
}

/// Initialize the logging system.
/// Call this once at application startup.
pub fn init_logging() {
    // Build a custom env_logger that respects our runtime filter
    env_logger::Builder::new()
        .filter_level(LevelFilter::Debug) // Allow all levels initially
        .format_timestamp_millis()
        .format_module_path(true)
        .init();

    println!("[DiagnosticLogger] Logging system initialized");
}

/// Set whether diagnostic logging is enabled.
/// When disabled, debug/info logs are silenced.
pub fn set_diagnostics_enabled(enabled: bool) {
    DIAGNOSTICS_ENABLED.store(enabled, Ordering::SeqCst);

    // Update the log level filter
    let level = if enabled {
        LevelFilter::Debug
    } else {
        LevelFilter::Warn
    };

    log::set_max_level(level);

    if enabled {
        println!("[DiagnosticLogger] Diagnostics ENABLED - showing all logs");
    } else {
        println!("[DiagnosticLogger] Diagnostics DISABLED - only warnings/errors");
    }
}

/// Check if diagnostics are currently enabled.
pub fn is_diagnostics_enabled() -> bool {
    DIAGNOSTICS_ENABLED.load(Ordering::SeqCst)
}
