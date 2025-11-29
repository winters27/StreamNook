import { useState, useEffect } from 'react';
import { AlertTriangle, AlertCircle, RefreshCw, Trash2, Shield } from 'lucide-react';
import { useAppStore } from '../../stores/AppStore';
import { getLogs, clearLogs, type LogEntry } from '../../services/logService';

const SupportSettings = () => {
    const { settings, updateSettings, addToast } = useAppStore();
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [filter, setFilter] = useState<'all' | 'errors' | 'warnings'>('all');

    // Default to enabled if not set
    const errorReportingEnabled = settings.error_reporting_enabled !== false;

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

    const handleToggleErrorReporting = () => {
        const newValue = !errorReportingEnabled;
        updateSettings({ ...settings, error_reporting_enabled: newValue });
        addToast(
            newValue
                ? 'Error reporting enabled - thank you for helping improve StreamNook!'
                : 'Error reporting disabled',
            newValue ? 'success' : 'info'
        );
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
                return <AlertCircle className="w-3 h-3 text-blue-400" />;
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
            {/* Error Reporting Toggle */}
            <div>
                <h3 className="text-sm font-semibold text-textPrimary mb-3 flex items-center gap-2">
                    <Shield className="w-4 h-4" />
                    Anonymous Error Reporting
                </h3>

                <div className="glass-panel p-4 rounded-lg">
                    <div className="flex items-center justify-between">
                        <div className="flex-1 pr-4">
                            <p className="text-sm text-textPrimary font-medium">
                                Help improve StreamNook
                            </p>
                            <p className="text-xs text-textSecondary mt-1">
                                Automatically send anonymous error reports when something goes wrong.
                                No personal data is collected.
                            </p>
                        </div>
                        <button
                            onClick={handleToggleErrorReporting}
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${errorReportingEnabled ? 'bg-accent' : 'bg-gray-600'
                                }`}
                        >
                            <span
                                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${errorReportingEnabled ? 'translate-x-6' : 'translate-x-1'
                                    }`}
                            />
                        </button>
                    </div>

                    <div className="mt-3 pt-3 border-t border-borderSubtle">
                        <p className="text-xs text-textSecondary opacity-70">
                            {errorReportingEnabled
                                ? '✓ Error reports are being sent to help diagnose issues'
                                : '✗ Error reporting is disabled'}
                        </p>
                    </div>
                </div>
            </div>

            {/* Error & Warning Stats */}
            <div>
                <h3 className="text-sm font-semibold text-textPrimary mb-3">Session Statistics</h3>
                <div className="grid grid-cols-2 gap-3">
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

            {/* Recent Errors & Warnings */}
            <div>
                <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-textPrimary">Recent Errors & Warnings</h3>
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

                <div className="glass-panel rounded-lg p-2 max-h-48 overflow-y-auto scrollbar-thin">
                    {filteredLogs.length === 0 ? (
                        <div className="text-center text-textSecondary text-xs py-6">
                            No errors or warnings recorded 🎉
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {filteredLogs.slice(-30).reverse().map((log, index) => (
                                <div
                                    key={index}
                                    className={`text-xs font-mono p-1.5 rounded ${log.level === 'error' ? 'bg-red-500/10' :
                                        log.level === 'warn' ? 'bg-yellow-500/10' :
                                            'bg-transparent'
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
                                            {log.message.slice(0, 80)}{log.message.length > 80 ? '...' : ''}
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
