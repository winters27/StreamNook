// Log levels in order of severity
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    category: string;
    message: string;
    data?: unknown;
}

// Maximum number of logs to keep in memory
const MAX_LOGS = 500;

// Discord webhook URL for error reporting (your webhook)
const DISCORD_ERROR_WEBHOOK = 'https://ptb.discord.com/api/webhooks/1444242659739697204/GpZDi70IWHCIObS-LOtFr89uU-J8tbnQLG7DRhHACR1Wn-26YchRTPCdWKUYf47zHyv7';

// Rate limiting to prevent spam
let lastWebhookSend = 0;
const WEBHOOK_COOLDOWN_MS = 30000; // 30 seconds between sends
let errorBuffer: LogEntry[] = [];
let webhookTimeout: ReturnType<typeof setTimeout> | null = null;

// Errors to ignore (benign/noise errors that don't need reporting)
const IGNORED_ERROR_PATTERNS = [
    /Couldn't find callback id/i,           // Tauri hot-reload callback errors
    /This might happen when the app is reloaded/i,
    /ResizeObserver loop/i,                 // Browser layout warnings
    /Non-Error promise rejection/i,         // Generic unhandled rejections
    /Failed to load resource.*favicon/i,    // Missing favicon
    /ERR_FILE_NOT_FOUND.*blob:/i,           // Blob file not found (not external APIs)
    /Tracking Prevention blocked/i,         // Browser tracking prevention
    /cdn\.jsdelivr\.net/i,                  // CDN resource errors
    /emoji-datasource/i,                    // Emoji loading issues
];
// NOTE: BTTV, FFZ, 7TV 404 errors ARE sent to Discord for monitoring

// Check if an error should be ignored
const shouldIgnoreError = (entry: LogEntry): boolean => {
    const fullMessage = `${entry.category} ${entry.message}`;
    return IGNORED_ERROR_PATTERNS.some(pattern => pattern.test(fullMessage));
};

// In-memory log storage
let logs: LogEntry[] = [];

// Original console methods
const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
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

// Helper to extract category from message
const extractCategory = (message: string): { category: string; cleanMessage: string } => {
    const match = message.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (match) {
        return { category: match[1], cleanMessage: match[2] };
    }
    return { category: 'App', cleanMessage: message };
};

// Check if error reporting is enabled in settings
const isErrorReportingEnabled = (): boolean => {
    try {
        const settingsJson = localStorage.getItem('streamnook-settings');
        if (settingsJson) {
            const settings = JSON.parse(settingsJson);
            // Default to true if not explicitly set to false
            return settings.error_reporting_enabled !== false;
        }
    } catch {
        // If we can't read settings, default to enabled
    }
    return true; // Default enabled
};

// Send errors to Discord webhook (batched to prevent spam)
const sendToDiscordWebhook = async (errors: LogEntry[]): Promise<void> => {
    // Don't send if no webhook configured or error reporting is disabled
    if (!DISCORD_ERROR_WEBHOOK || !isErrorReportingEnabled()) {
        return;
    }

    try {
        const { getVersion } = await import('@tauri-apps/api/app');
        const { invoke } = await import('@tauri-apps/api/core');

        let appVersion = 'Unknown';
        let osInfo = 'Unknown';

        try {
            appVersion = await getVersion();
        } catch { /* ignore */ }

        try {
            osInfo = await invoke('get_system_info') as string;
        } catch {
            osInfo = 'Unknown';
        }

        // Format errors for Discord embed (using code block for easy copying)
        const errorMessages = errors.slice(-10).map(e => {
            const data = e.data ? ` | ${JSON.stringify(e.data).slice(0, 80)}` : '';
            return `[${e.category}] ${e.message.slice(0, 150)}${data}`;
        }).join('\n');

        // Create a copyable code block version
        const codeBlockErrors = '```\n' + errorMessages.slice(0, 900) + '\n```';

        const embed = {
            title: '🚨 StreamNook Error Report',
            color: 0xFF0000, // Red
            fields: [
                {
                    name: 'App Version',
                    value: `\`${appVersion}\``,
                    inline: true,
                },
                {
                    name: 'Platform',
                    value: `\`${osInfo}\``,
                    inline: true,
                },
                {
                    name: 'Error Count',
                    value: `\`${errors.length}\``,
                    inline: true,
                },
                {
                    name: 'Errors (click to copy)',
                    value: codeBlockErrors || '```No details```',
                    inline: false,
                },
            ],
            timestamp: new Date().toISOString(),
            footer: {
                text: 'StreamNook Auto Error Report • Triple-click code block to select all',
            },
        };

        await fetch(DISCORD_ERROR_WEBHOOK, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                embeds: [embed],
            }),
        });

        originalConsole.log('[LogService] Error report sent to Discord');
    } catch (err) {
        // Don't log this error to avoid infinite loop
        originalConsole.warn('[LogService] Failed to send to Discord webhook:', err);
    }
};

// Schedule sending buffered errors to Discord
const scheduleWebhookSend = (): void => {
    if (webhookTimeout) return; // Already scheduled

    webhookTimeout = setTimeout(async () => {
        webhookTimeout = null;
        const now = Date.now();

        // Check cooldown
        if (now - lastWebhookSend < WEBHOOK_COOLDOWN_MS) {
            // Reschedule for after cooldown
            const remaining = WEBHOOK_COOLDOWN_MS - (now - lastWebhookSend);
            webhookTimeout = setTimeout(() => {
                webhookTimeout = null;
                scheduleWebhookSend();
            }, remaining);
            return;
        }

        if (errorBuffer.length > 0) {
            const errorsToSend = [...errorBuffer];
            errorBuffer = [];
            lastWebhookSend = now;
            await sendToDiscordWebhook(errorsToSend);
        }
    }, 5000); // Wait 5 seconds to batch errors
};

// Add a log entry
const addLog = (level: LogLevel, args: unknown[]): void => {
    const firstArg = String(args[0] || '');
    const { category, cleanMessage } = extractCategory(firstArg);

    const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        category,
        message: cleanMessage || firstArg,
        data: args.length > 1 ? args.slice(1) : undefined,
    };

    logs.push(entry);

    // Keep only the last MAX_LOGS entries
    if (logs.length > MAX_LOGS) {
        logs = logs.slice(-MAX_LOGS);
    }

    // Queue errors for Discord webhook (filter out noise)
    if (level === 'error' && !shouldIgnoreError(entry)) {
        errorBuffer.push(entry);
        scheduleWebhookSend();
    }
};

// Initialize the log capture by wrapping console methods
// Only captures errors and warnings - info/debug logs are passed through but not stored
export const initLogCapture = (): void => {
    console.log = (...args: unknown[]) => {
        // Don't store info logs, just pass through
        originalConsole.log(...args);
    };

    console.info = (...args: unknown[]) => {
        // Don't store info logs, just pass through
        originalConsole.info(...args);
    };

    console.warn = (...args: unknown[]) => {
        addLog('warn', args);
        originalConsole.warn(...args);
    };

    console.error = (...args: unknown[]) => {
        addLog('error', args);
        originalConsole.error(...args);
    };
};

// Get all logs
export const getLogs = (): LogEntry[] => {
    return [...logs];
};

// Get logs filtered by level
export const getLogsByLevel = (level: LogLevel): LogEntry[] => {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const minIndex = levels.indexOf(level);
    return logs.filter(log => levels.indexOf(log.level) >= minIndex);
};

// Get logs filtered by category
export const getLogsByCategory = (category: string): LogEntry[] => {
    return logs.filter(log => log.category.toLowerCase().includes(category.toLowerCase()));
};

// Clear all logs
export const clearLogs = (): void => {
    logs = [];
};

// Get unique categories
export const getCategories = (): string[] => {
    return [...new Set(logs.map(log => log.category))];
};

// Format logs for export
export const formatLogsForExport = (logsToExport?: LogEntry[]): string => {
    const entries = logsToExport || logs;

    return entries.map(log => {
        const dataStr = log.data ? `\n  Data: ${formatData(log.data)}` : '';
        return `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.category}] ${log.message}${dataStr}`;
    }).join('\n');
};

// Generate a full bug report
export const generateBugReport = async (): Promise<string> => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { getVersion } = await import('@tauri-apps/api/app');

    let appVersion = 'Unknown';
    let osInfo = 'Unknown';
    let streamlinkVersion = 'Unknown';

    try {
        appVersion = await getVersion();
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

export default {
    initLogCapture,
    getLogs,
    getLogsByLevel,
    getLogsByCategory,
    clearLogs,
    getCategories,
    formatLogsForExport,
    generateBugReport,
    copyBugReportToClipboard,
    saveBugReportToFile,
};
