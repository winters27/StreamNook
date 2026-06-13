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
    // Terminal default is INFO, not DEBUG: debug-level logs are the per-frame /
    // per-request firehose that makes the dev terminal unreadable (and the
    // sheer write volume is itself overhead). INFO keeps lifecycle + meaningful
    // lines. RUST_LOG overrides if a developer wants the firehose back, and the
    // runtime toggle below can still raise to Debug. The structured file
    // capture (ll_diagnostics) is independent of this and stays full-fidelity.
    let mut builder = env_logger::Builder::new();
    if std::env::var("RUST_LOG").is_ok() {
        builder.parse_default_env();
    } else {
        builder.filter_level(LevelFilter::Info);
    }
    builder
        .format_timestamp_millis()
        .format_module_path(true)
        .init();

    println!("[DiagnosticLogger] Logging system initialized (terminal: info; file capture: full)");
}

/// Set whether diagnostic logging is enabled.
/// When disabled, debug/info logs are silenced.
pub fn set_diagnostics_enabled(enabled: bool) {
    DIAGNOSTICS_ENABLED.store(enabled, Ordering::SeqCst);

    // Update the log level filter. "Enabled" raises to Info (not Debug — debug
    // is the firehose that floods the terminal); disabled drops to Warn.
    let level = if enabled {
        LevelFilter::Info
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
