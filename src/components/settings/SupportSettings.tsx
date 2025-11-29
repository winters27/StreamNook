import { useState, useEffect } from 'react';
import { Bug, Copy, Download, Trash2, AlertTriangle, Info, AlertCircle, RefreshCw } from 'lucide-react';
import { useAppStore } from '../../stores/AppStore';
import {
    getLogs,
    clearLogs,
    copyBugReportToClipboard,
    saveBugReportToFile,
    type LogEntry
} from '../../services/logService';

const SupportSettings = () => {
    const { addToast } = useAppStore();
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isExporting, setIsExporting] = useState(false);
    const [filter, setFilter] = useState<'all' | 'errors' | 'warnings'>('all');

    // Refresh logs periodically
    useEffect(() => {
        const updateLogs = () => {
            setLogs(getLogs());
        };

        updateLogs();
        const interval = setInterval(updateLogs, 2000);
        return () => clearInterval(interval);
    }, []);

    const filteredLogs = logs.filter(log => {
        if (filter === 'errors') return log.level === 'error';
        if (filter === 'warnings') return log.level === 'warn';
        return true;
    });

    const errorCount = logs.filter(l => l.level === 'error').length;
    const warningCount = logs.filter(l => l.level === 'warn').length;

    const handleCopyToClipboard = async () => {
        setIsExporting(true);
        try {
            const success = await copyBugReportToClipboard();
            if (success) {
                addToast('Bug report copied to clipboard! You can now paste it to share.', 'success');
            } else {
                addToast('Failed to copy bug report', 'error');
            }
        } catch {
            addToast('Failed to copy bug report', 'error');
        }
        setIsExporting(false);
    };

    const handleSaveToFile = async () => {
        setIsExporting(true);
        try {
            const success = await saveBugReportToFile();
            if (success) {
                addToast('Bug report saved! You can share this file.', 'success');
            }
        } catch {
            addToast('Failed to save bug report', 'error');
        }
        setIsExporting(false);
    };

    const handleClearLogs = () => {
        clearLogs();
        setLogs([]);
        addToast('Logs cleared', 'info');
    };

    const handleRefresh = () => {
        setLogs(getLogs());
    };

    const getLevelIcon = (level: string) => {
        switch (level) {
            case 'error':
                return <AlertCircle className="w-3 h-3 text-red-400" />;
            case 'warn':
                return <AlertTriangle className="w-3 h-3 text-yellow-400" />;
            default:
                return <Info className="w-3 h-3 text-blue-400" />;
        }
    };

    const getLevelColor = (level: string) => {
        switch (level) {
            case 'error':
                return 'text-red-400';
            case 'warn':
                return 'text-yellow-400';
            default:
                return 'text-textSecondary';
        }
    };

    return (
        <div className="space-y-6">
            {/* Bug Report Section */}
            <div>
                <h3 className="text-sm font-semibold text-textPrimary mb-3 flex items-center gap-2">
                    <Bug className="w-4 h-4" />
                    Bug Report
                </h3>
                <p className="text-xs text-textSecondary mb-4">
                    Having issues? Export a bug report to share with the developer. The report includes
                    system info and recent logs to help diagnose problems.
                </p>

                <div className="flex gap-3">
                    <button
                        onClick={handleCopyToClipboard}
                        disabled={isExporting}
                        className="flex items-center gap-2 px-4 py-2 glass-button text-textPrimary text-sm font-medium disabled:opacity-50"
                    >
                        <Copy className="w-4 h-4" />
                        Copy to Clipboard
                    </button>
                    <button
                        onClick={handleSaveToFile}
                        disabled={isExporting}
                        className="flex items-center gap-2 px-4 py-2 glass-button text-textPrimary text-sm font-medium disabled:opacity-50"
                    >
                        <Download className="w-4 h-4" />
                        Save to File
                    </button>
                </div>

                <div className="mt-3 p-3 glass-panel rounded-lg">
                    <p className="text-xs text-textSecondary">
                        <strong>How to report a bug:</strong>
                    </p>
                    <ol className="text-xs text-textSecondary mt-2 space-y-1 list-decimal list-inside">
                        <li>Reproduce the issue if possible</li>
                        <li>Click "Copy to Clipboard" or "Save to File"</li>
                        <li>Share the report in the StreamNook Discord or GitHub issues</li>
                    </ol>
                </div>
            </div>

            {/* Log Statistics */}
            <div>
                <h3 className="text-sm font-semibold text-textPrimary mb-3">Log Statistics</h3>
                <div className="grid grid-cols-3 gap-3">
                    <div className="p-3 glass-panel rounded-lg text-center">
                        <div className="text-2xl font-bold text-textPrimary">{logs.length}</div>
                        <div className="text-xs text-textSecondary">Total Logs</div>
                    </div>
                    <div className="p-3 glass-panel rounded-lg text-center">
                        <div className="text-2xl font-bold text-red-400">{errorCount}</div>
                        <div className="text-xs text-textSecondary">Errors</div>
                    </div>
                    <div className="p-3 glass-panel rounded-lg text-center">
                        <div className="text-2xl font-bold text-yellow-400">{warningCount}</div>
                        <div className="text-xs text-textSecondary">Warnings</div>
                    </div>
                </div>
            </div>

            {/* Recent Logs */}
            <div>
                <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-textPrimary">Recent Logs</h3>
                    <div className="flex items-center gap-2">
                        <select
                            value={filter}
                            onChange={(e) => setFilter(e.target.value as 'all' | 'errors' | 'warnings')}
                            className="glass-input px-2 py-1 text-xs"
                        >
                            <option value="all">All</option>
                            <option value="errors">Errors Only</option>
                            <option value="warnings">Warnings Only</option>
                        </select>
                        <button
                            onClick={handleRefresh}
                            className="p-1.5 glass-button rounded"
                            title="Refresh logs"
                        >
                            <RefreshCw className="w-3 h-3" />
                        </button>
                        <button
                            onClick={handleClearLogs}
                            className="p-1.5 glass-button rounded text-red-400 hover:text-red-300"
                            title="Clear all logs"
                        >
                            <Trash2 className="w-3 h-3" />
                        </button>
                    </div>
                </div>

                <div className="glass-panel rounded-lg p-2 max-h-64 overflow-y-auto scrollbar-thin">
                    {filteredLogs.length === 0 ? (
                        <div className="text-center text-textSecondary text-xs py-8">
                            No logs to display
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {filteredLogs.slice(-50).reverse().map((log, index) => (
                                <div
                                    key={index}
                                    className={`text-xs font-mono p-1.5 rounded ${log.level === 'error' ? 'bg-red-500/10' :
                                        log.level === 'warn' ? 'bg-yellow-500/10' :
                                            'bg-transparent hover:bg-glass'
                                        }`}
                                >
                                    <div className="flex items-start gap-2">
                                        {getLevelIcon(log.level)}
                                        <span className="text-textSecondary/60 flex-shrink-0">
                                            {new Date(log.timestamp).toLocaleTimeString()}
                                        </span>
                                        <span className="text-primary/70 flex-shrink-0">
                                            [{log.category}]
                                        </span>
                                        <span className={getLevelColor(log.level)}>
                                            {log.message}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default SupportSettings;
