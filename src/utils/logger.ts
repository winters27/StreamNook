/**
 * Centralized Logger utility that respects user diagnostic settings.
 * 
 * When diagnostics are disabled:
 * - debug() and info() are completely silenced (zero overhead)
 * - warn() and error() always log (critical for production debugging)
 * 
 * Usage:
 *   import { Logger } from '../utils/logger';
 *   Logger.debug('[Chat]', 'Message received:', messageId);
 *   Logger.warn('[HLS]', 'Buffer stalled');
 */

// Store original console methods before any patching
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

// Diagnostics state - defaults to enabled for safety
let diagnosticsEnabled = true;

// Console verbosity is SEPARATE from diagnostics. The file-based capture
// (llDiagnostics) does not depend on console output at all, so the per-frame
// debug firehose can be silenced in the console — which both makes the console
// readable AND removes a real source of webview main-thread jank (thousands of
// console writes/sec go through the devtools protocol and can stall the JS
// thread; a 1.6s tick gap was observed). Default OFF. Re-enable live from the
// devtools console with `__snConsole(true)`, or set the localStorage key.
let consoleVerbose = false;
try {
  consoleVerbose = localStorage.getItem('streamnook_console_verbose') === 'true';
} catch {
  /* localStorage unavailable */
}

/** Toggle the debug/info console firehose at runtime (persisted). warn/error are unaffected. */
export const setConsoleVerbose = (on: boolean): void => {
  consoleVerbose = on;
  try {
    localStorage.setItem('streamnook_console_verbose', String(on));
  } catch {
    /* ignore */
  }
  originalConsole.warn(`[Logger] console verbose = ${on}`);
};
try {
  (window as unknown as { __snConsole?: (on: boolean) => void }).__snConsole = setConsoleVerbose;
} catch {
  /* no window */
}

// Check localStorage for cached setting immediately on module load
// This allows correct behavior before Tauri settings are loaded
try {
  const cached = localStorage.getItem('streamnook_diagnostics_enabled');
  if (cached !== null) {
    diagnosticsEnabled = cached === 'true';
  }
} catch {
  // localStorage not available, keep default
}



/**
 * Set whether diagnostic logging is enabled.
 * Called by AppStore when settings are loaded or changed.
 */
export const setDiagnosticsEnabled = (enabled: boolean): void => {
  diagnosticsEnabled = enabled;
  // Cache for next startup
  try {
    localStorage.setItem('streamnook_diagnostics_enabled', String(enabled));
  } catch {
    // Ignore localStorage errors
  }
};

/**
 * Check if diagnostics are currently enabled.
 */
export const isDiagnosticsEnabled = (): boolean => diagnosticsEnabled;

/**
 * Logger singleton with diagnostic-aware logging methods.
 * 
 * Log Levels:
 * - debug: Development/troubleshooting info, silenced when diagnostics disabled
 * - info: General operational info, silenced when diagnostics disabled
 * - warn: Potential issues that don't break functionality, always logged
 * - error: Errors that affect functionality, always logged and reported
 */
export const Logger = {
  /**
   * Debug-level logging. Silenced when diagnostics are disabled.
   * Use for detailed development information.
   */
  debug: (...args: unknown[]): void => {
    // Console firehose gated behind consoleVerbose (default OFF), NOT
    // diagnosticsEnabled — the file capture is independent and stays full.
    if (consoleVerbose) {
      originalConsole.log(...args);
    }
  },

  /**
   * Info-level logging. Silenced unless console verbose is on.
   * Use for general operational information.
   */
  info: (...args: unknown[]): void => {
    if (consoleVerbose) {
      originalConsole.info(...args);
    }
  },

  /**
   * Warning-level logging. Always logs regardless of diagnostic setting.
   * Use for potential issues that don't break functionality.
   */
  warn: (...args: unknown[]): void => {
    originalConsole.warn(...args);
  },

  /**
   * Error-level logging. Always logs regardless of diagnostic setting.
   * Use for errors that affect functionality.
   */
  error: (...args: unknown[]): void => {
    originalConsole.error(...args);
  },
};

export default Logger;
