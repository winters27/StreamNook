import { useState, useEffect } from 'react';
import { AlertTriangle, AlertCircle, RefreshCw, Trash2, Shield, MessageCircle, ExternalLink } from 'lucide-react';
import { useAppStore } from '../../stores/AppStore';
import { getLogs, clearLogs, type LogEntry } from '../../services/logService';

// Lanyard API types
interface LanyardData {
    discord_user: {
        id: string;
        username: string;
        avatar: string;
        discriminator: string;
        global_name: string | null;
    };
    discord_status: 'online' | 'idle' | 'dnd' | 'offline';
    activities: Array<{
        name: string;
        type: number;
        state?: string;
        details?: string;
    }>;
}

interface LanyardResponse {
    success: boolean;
    data: LanyardData;
}

// Developer Discord User ID
const DEVELOPER_DISCORD_ID = '681989594341834765';

const SupportSettings = () => {
    const { settings, updateSettings, addToast } = useAppStore();
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [filter, setFilter] = useState<'all' | 'errors' | 'warnings'>('all');
    const [lanyardData, setLanyardData] = useState<LanyardData | null>(null);
    const [lanyardLoading, setLanyardLoading] = useState(true);

    // Default to enabled if not set
    const errorReportingEnabled = settings.error_reporting_enabled !== false;

    // Fetch Lanyard presence data
    useEffect(() => {
        const fetchLanyardData = async () => {
            try {
                const response = await fetch(`https://api.lanyard.rest/v1/users/${DEVELOPER_DISCORD_ID}`);
                const data: LanyardResponse = await response.json();
                if (data.success) {
                    setLanyardData(data.data);
                }
            } catch (error) {
                console.error('Failed to fetch Lanyard data:', error);
            } finally {
                setLanyardLoading(false);
            }
        };

        fetchLanyardData();
        // Refresh presence every 30 seconds
        const interval = setInterval(fetchLanyardData, 30000);
        return () => clearInterval(interval);
    }, []);

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

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'online':
                return 'bg-green-500';
            case 'idle':
                return 'bg-yellow-500';
            case 'dnd':
                return 'bg-red-500';
            default:
                return 'bg-gray-500';
        }
    };

    const getStatusLabel = (status: string) => {
        switch (status) {
            case 'online':
                return 'Online';
            case 'idle':
                return 'Idle';
            case 'dnd':
                return 'Do Not Disturb';
            default:
                return 'Offline';
        }
    };

    const getAvatarUrl = (userId: string, avatarHash: string) => {
        // Animated avatars have a hash starting with "a_"
        const extension = avatarHash.startsWith('a_') ? 'gif' : 'png';
        return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${extension}?size=64`;
    };

    const handleMessageOnDiscord = async () => {
        try {
            const { open } = await import('@tauri-apps/plugin-shell');
            await open(`https://discord.com/users/${DEVELOPER_DISCORD_ID}`);
        } catch (err) {
            console.error('Failed to open Discord URL:', err);
            // Fallback to window.open
            window.open(`https://discord.com/users/${DEVELOPER_DISCORD_ID}`, '_blank');
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

            {/* Contact Developer Section */}
            <div>
                <h3 className="text-sm font-semibold text-textPrimary mb-3 flex items-center gap-2">
                    <MessageCircle className="w-4 h-4" />
                    Contact Developer
                </h3>

                <div className="glass-panel p-4 rounded-lg">
                    {lanyardLoading ? (
                        <div className="flex items-center justify-center py-4">
                            <RefreshCw className="w-5 h-5 animate-spin text-textSecondary" />
                        </div>
                    ) : lanyardData ? (
                        <div className="flex items-center gap-4">
                            {/* Avatar with status indicator */}
                            <div className="relative flex-shrink-0">
                                <img
                                    src={getAvatarUrl(lanyardData.discord_user.id, lanyardData.discord_user.avatar)}
                                    alt={lanyardData.discord_user.username}
                                    className="w-12 h-12 rounded-full"
                                />
                                <div
                                    className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-[1.5px] border-background ${getStatusColor(lanyardData.discord_status)}`}
                                    title={getStatusLabel(lanyardData.discord_status)}
                                    style={lanyardData.discord_status === 'online' ? {
                                        animation: 'pulse-glow 2s ease-in-out infinite'
                                    } : undefined}
                                />
                            </div>

                            {/* User info */}
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-textPrimary truncate">
                                    {lanyardData.discord_user.global_name || lanyardData.discord_user.username}
                                </p>
                                <p className="text-xs text-textSecondary">
                                    @{lanyardData.discord_user.username}
                                </p>
                                {lanyardData.activities && lanyardData.activities.length > 0 && (
                                    <p className="text-xs text-textMuted mt-0.5 truncate">
                                        {lanyardData.activities[0].type === 0 && `Playing ${lanyardData.activities[0].name}`}
                                        {lanyardData.activities[0].type === 2 && `Listening to ${lanyardData.activities[0].state || lanyardData.activities[0].name}`}
                                        {lanyardData.activities[0].type === 3 && `Watching ${lanyardData.activities[0].name}`}
                                        {lanyardData.activities[0].type === 4 && lanyardData.activities[0].state}
                                        {lanyardData.activities[0].type === 5 && `Competing in ${lanyardData.activities[0].name}`}
                                    </p>
                                )}
                            </div>

                            {/* Message button */}
                            <button
                                onClick={handleMessageOnDiscord}
                                className="glass-button px-4 py-2 rounded-lg flex items-center gap-2 text-sm font-medium hover:bg-accent/20 transition-colors"
                            >
                                <ExternalLink className="w-4 h-4" />
                                Message on Discord
                            </button>
                        </div>
                    ) : (
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm text-textPrimary font-medium">
                                    Contact the Developer
                                </p>
                                <p className="text-xs text-textSecondary mt-1">
                                    Have questions or feedback? Reach out on Discord.
                                </p>
                            </div>
                            <button
                                onClick={handleMessageOnDiscord}
                                className="glass-button px-4 py-2 rounded-lg flex items-center gap-2 text-sm font-medium hover:bg-accent/20 transition-colors"
                            >
                                <ExternalLink className="w-4 h-4" />
                                Message on Discord
                            </button>
                        </div>
                    )}

                    <div className="mt-3 pt-3 border-t border-borderSubtle">
                        <p className="text-xs text-textSecondary opacity-70">
                            StreamNook is built by a solo developer. I made this project for myself and thought others might enjoy it too. A dedicated Discord server is coming soon! In the meantime, feel free to reach out with bug reports, feature requests, or just to say hi.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SupportSettings;
