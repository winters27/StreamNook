import { invoke } from '@tauri-apps/api/core';

// Log levels in order of severity
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    category: string;
    message: string;
    data?: unknown;
}

// Original console methods
const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

// Helper to extract category from message
const extractCategory = (message: string): { category: string; cleanMessage: string } => {
    const match = message.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (match) {
        return { category: match[1], cleanMessage: match[2] };
    }
    return { category: 'App', cleanMessage: message };
};

// Forward log to Rust backend
const forwardToRust = async (level: LogLevel, args: unknown[]): Promise<void> => {
    try {
        const firstArg = String(args[0] || '');
        const { category, cleanMessage } = extractCategory(firstArg);
        const data = args.length > 1 ? args.slice(1) : undefined;

        await invoke('log_message', {
            level,
            category,
            message: cleanMessage || firstArg,
            data: data ? JSON.stringify(data) : null,
        });
    } catch (err) {
        // Silent fail - don't log errors about logging
        originalConsole.warn('[LogService] Failed to forward log to Rust:', err);
    }
};

// Initialize the log capture by wrapping console methods
// Forwards logs to Rust backend for storage and Discord webhook handling
export const initLogCapture = (): void => {
    console.log = (...args: unknown[]) => {
        // Store specific info logs that are useful for debugging
        const firstArg = String(args[0] || '');
        if (firstArg.startsWith('[EmoteService]') || firstArg.startsWith('[UniversalCache]')) {
            forwardToRust('info', args);
        }
        originalConsole.log(...args);
    };

    console.info = (...args: unknown[]) => {
        // Don't store info logs, just pass through
        originalConsole.info(...args);
    };

    console.warn = (...args: unknown[]) => {
        forwardToRust('warn', args);
        originalConsole.warn(...args);
    };

    console.error = (...args: unknown[]) => {
        forwardToRust('error', args);
        originalConsole.error(...args);
    };
};

// Track user activity for error context
export const trackActivity = async (action: string): Promise<void> => {
    try {
        await invoke('track_activity', { action });
    } catch (err) {
        originalConsole.warn('[LogService] Failed to track activity:', err);
    }
};

// Get all logs from Rust backend
export const getLogs = async (): Promise<LogEntry[]> => {
    try {
        return await invoke<LogEntry[]>('get_recent_logs', { limit: 500 });
    } catch (err) {
        originalConsole.error('[LogService] Failed to get logs:', err);
        return [];
    }
};

// Get logs filtered by level from Rust backend
export const getLogsByLevel = async (level: LogLevel): Promise<LogEntry[]> => {
    try {
        return await invoke<LogEntry[]>('get_logs_by_level', { level });
    } catch (err) {
        originalConsole.error('[LogService] Failed to get logs by level:', err);
        return [];
    }
};

// Get logs filtered by category (client-side filtering of fetched logs)
export const getLogsByCategory = async (category: string): Promise<LogEntry[]> => {
    try {
        const logs = await getLogs();
        return logs.filter(log => log.category.toLowerCase().includes(category.toLowerCase()));
    } catch (err) {
        originalConsole.error('[LogService] Failed to get logs by category:', err);
        return [];
    }
};

// Clear all logs in Rust backend
export const clearLogs = async (): Promise<void> => {
    try {
        await invoke('clear_logs');
    } catch (err) {
        originalConsole.error('[LogService] Failed to clear logs:', err);
    }
};

// Get unique categories from logs
export const getCategories = async (): Promise<string[]> => {
    try {
        const logs = await getLogs();
        return [...new Set(logs.map(log => log.category))];
    } catch (err) {
        originalConsole.error('[LogService] Failed to get categories:', err);
        return [];
    }
};

// Helper to format log data
const formatData = (data: unknown): string => {
    if (data === undefined) return '';
    try {
        return JSON.stringify(data, null, 2);
    } catch {
        return String(data);
    }
};

// Format logs for export
export const formatLogsForExport = (logsToExport: LogEntry[]): string => {
    return logsToExport.map(log => {
        const dataStr = log.data ? `\n  Data: ${formatData(log.data)}` : '';
        return `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.category}] ${log.message}${dataStr}`;
    }).join('\n');
};

// Generate a full bug report
export const generateBugReport = async (): Promise<string> => {
    let appVersion = 'Unknown';
    let osInfo = 'Unknown';
    let streamlinkVersion = 'Unknown';

    try {
        appVersion = await invoke('get_app_version') as string;
    } catch {
        // Ignore
    }

    try {
        osInfo = await invoke('get_system_info') as string;
    } catch {
        osInfo = navigator.userAgent;
    }

    try {
        // Try to get streamlink version from settings
        const settings = JSON.parse(localStorage.getItem('settings') || '{}');
        if (settings.streamlink_path) {
            streamlinkVersion = await invoke('get_installed_streamlink_version', {
                path: settings.streamlink_path
            }) as string || 'Not found';
        }
    } catch {
        streamlinkVersion = 'Unable to detect';
    }

    const logs = await getLogs();
    const errorLogs = logs.filter(l => l.level === 'error' || l.level === 'warn');
    const recentLogs = logs.slice(-100); // Last 100 logs

    const report = `
================================================================================
                         STREAMNOOK BUG REPORT
================================================================================

Generated: ${new Date().toISOString()}

--------------------------------------------------------------------------------
SYSTEM INFORMATION
--------------------------------------------------------------------------------
App Version: ${appVersion}
OS/Platform: ${osInfo}
Streamlink: ${streamlinkVersion}
User Agent: ${navigator.userAgent}

--------------------------------------------------------------------------------
ERROR/WARNING LOGS (${errorLogs.length} entries)
--------------------------------------------------------------------------------
${errorLogs.length > 0 ? formatLogsForExport(errorLogs) : 'No errors or warnings recorded.'}

--------------------------------------------------------------------------------
RECENT ACTIVITY (Last 100 logs)
--------------------------------------------------------------------------------
${formatLogsForExport(recentLogs)}

================================================================================
                           END OF BUG REPORT
================================================================================
`;

    return report;
};

// Copy bug report to clipboard
export const copyBugReportToClipboard = async (): Promise<boolean> => {
    try {
        const report = await generateBugReport();
        await navigator.clipboard.writeText(report);
        return true;
    } catch (error) {
        originalConsole.error('Failed to copy bug report:', error);
        return false;
    }
};

// Save bug report to file (using browser download)
export const saveBugReportToFile = async (): Promise<boolean> => {
    try {
        const report = await generateBugReport();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `streamnook-bug-report-${timestamp}.txt`;

        // Create a blob and download link
        const blob = new Blob([report], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // Clean up the URL
        URL.revokeObjectURL(url);

        return true;
    } catch (error) {
        originalConsole.error('Failed to save bug report:', error);
        return false;
    }
};

// Streamlink error detection (kept for compatibility)
const STREAMLINK_ERROR_PATTERNS = [
    /streamlink/i,
    /stream.*not.*found/i,
    /failed.*start.*stream/i,
    /no.*streams.*found/i,
    /executable.*not.*found/i,
];

export const isStreamlinkError = (errorMessage: string): boolean => {
    return STREAMLINK_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage));
};

// Streamlink diagnostics - now just logs an error since diagnostics are handled by Rust backend
export const sendStreamlinkDiagnostics = async (errorMessage: string): Promise<void> => {
    // This function is kept for compatibility but the actual diagnostics
    // are now handled automatically by the Rust backend when errors are logged
    originalConsole.log('[LogService] Streamlink error detected:', errorMessage);
    originalConsole.log('[LogService] Error will be automatically reported to Discord by Rust backend');
};

// NOTE: Discord webhook functionality is now handled entirely in the Rust backend.
// Errors are automatically sent to Discord via background tasks with proper
// rate limiting and batching.

export default {
    initLogCapture,
    trackActivity,
    getLogs,
    getLogsByLevel,
    getLogsByCategory,
    clearLogs,
    getCategories,
    formatLogsForExport,
    generateBugReport,
    copyBugReportToClipboard,
    saveBugReportToFile,
    isStreamlinkError,
    sendStreamlinkDiagnostics,
};
