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

// Check localStorage for cached setting immediately on module load
// This allows correct behavior before Tauri settings are loaded
try {
  const cached = localStorage.getItem('streamnook_diagnostics_enabled');
  if (cached !== null) {
    diagnosticsEnabled = cached === 'true';
  }
  // Debug output to verify logger status on startup (use warn so it always shows)
  originalConsole.warn('[Logger] Initialized - diagnosticsEnabled:', diagnosticsEnabled, '(cached:', cached, ')');
} catch {
  // localStorage not available, keep default
  originalConsole.warn('[Logger] Initialized - diagnosticsEnabled:', diagnosticsEnabled, '(no localStorage)');
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
    if (diagnosticsEnabled) {
      originalConsole.log(...args);
    }
  },

  /**
   * Info-level logging. Silenced when diagnostics are disabled.
   * Use for general operational information.
   */
  info: (...args: unknown[]): void => {
    if (diagnosticsEnabled) {
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
