import { useState, useEffect } from 'react';
import { AlertTriangle, AlertCircle, RefreshCw, Trash2, ExternalLink } from 'lucide-react';
import { useAppStore } from '../../stores/AppStore';
import { getLogs, clearLogs, type LogEntry } from '../../services/logService';
import { Tooltip } from '../ui/Tooltip';
import { SettingsSection } from './_primitives';
import streamnookLogo from '../../assets/streamnook-logo.png';

import { Logger } from '../../utils/logger';

const COMMUNITY_DISCORD_INVITE_CODE = '2xvuF9TES7';
const COMMUNITY_DISCORD_INVITE = `https://discord.gg/${COMMUNITY_DISCORD_INVITE_CODE}`;

interface DiscordInviteData {
    guild?: {
        id: string;
        name: string;
        icon: string | null;
    };
    approximate_member_count?: number;
    approximate_presence_count?: number;
}

const Toggle = ({ enabled, onChange }: { enabled: boolean; onChange: () => void }) => (
    <button
        onClick={onChange}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${enabled ? 'bg-accent' : 'bg-gray-600'
            }`}
    >
        <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
        />
    </button>
);

const SupportSettings = () => {
    const { settings, updateSettings, addToast } = useAppStore();
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [filter, setFilter] = useState<'all' | 'errors' | 'warnings'>('all');
    const [serverData, setServerData] = useState<DiscordInviteData | null>(null);

    const errorReportingEnabled = settings.error_reporting_enabled !== false;

    useEffect(() => {
        const updateLogs = async () => {
            setLogs(await getLogs());
        };

        updateLogs();
        const interval = setInterval(updateLogs, 2000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        const fetchServerData = async () => {
            try {
                const response = await fetch(
                    `https://discord.com/api/v10/invites/${COMMUNITY_DISCORD_INVITE_CODE}?with_counts=true`
                );
                if (response.ok) {
                    setServerData(await response.json());
                }
            } catch (error) {
                Logger.error('Failed to fetch Discord server preview:', error);
            }
        };

        fetchServerData();
        const interval = setInterval(fetchServerData, 60000);
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
                ? 'Error reporting enabled. Thank you for helping improve StreamNook.'
                : 'Error reporting disabled',
            newValue ? 'success' : 'info'
        );
    };

    const handleClearLogs = () => {
        clearLogs();
        setLogs([]);
        addToast('Logs cleared', 'info');
    };

    const handleRefresh = async () => {
        setLogs(await getLogs());
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

    const getServerIconUrl = (guildId: string, iconHash: string) => {
        const extension = iconHash.startsWith('a_') ? 'gif' : 'png';
        return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.${extension}?size=128`;
    };

    const handleJoinCommunity = async () => {
        try {
            const { open } = await import('@tauri-apps/plugin-shell');
            await open(COMMUNITY_DISCORD_INVITE);
        } catch (err) {
            Logger.error('Failed to open Discord invite:', err);
            window.open(COMMUNITY_DISCORD_INVITE, '_blank');
        }
    };

    return (
        <div className="space-y-8">
            <SettingsSection
                label="Anonymous Error Reporting"
                description="Automatically send anonymous error reports when something goes wrong. No personal data is collected."
                bare
            >
                <div className="glass-panel p-4 rounded-lg">
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-textPrimary">Help improve StreamNook</p>
                            <p className="text-xs text-textSecondary mt-0.5">
                                {errorReportingEnabled
                                    ? 'Error reports are being sent to help diagnose issues'
                                    : 'Error reporting is disabled'}
                            </p>
                        </div>
                        <Toggle enabled={errorReportingEnabled} onChange={handleToggleErrorReporting} />
                    </div>
                </div>
            </SettingsSection>

            <SettingsSection label="Session Statistics" bare>
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
            </SettingsSection>

            <SettingsSection label="Recent Errors and Warnings" bare>
                <div className="flex items-center justify-end gap-2">
                    <select
                        value={filter}
                        onChange={(e) => setFilter(e.target.value as 'all' | 'errors' | 'warnings')}
                        className="glass-input px-2 py-1 text-xs"
                    >
                        <option value="all">All</option>
                        <option value="errors">Errors Only</option>
                        <option value="warnings">Warnings Only</option>
                    </select>
                    <Tooltip content="Refresh logs" side="top">
                        <button
                            onClick={handleRefresh}
                            className="p-1.5 glass-button rounded"
                        >
                            <RefreshCw className="w-3 h-3" />
                        </button>
                    </Tooltip>
                    <Tooltip content="Clear all logs" side="top">
                        <button
                            onClick={handleClearLogs}
                            className="p-1.5 glass-button rounded text-red-400 hover:text-red-300"
                        >
                            <Trash2 className="w-3 h-3" />
                        </button>
                    </Tooltip>
                </div>

                <div className="glass-panel rounded-lg p-2 max-h-48 overflow-y-auto scrollbar-thin">
                    {filteredLogs.length === 0 ? (
                        <div className="text-center text-textSecondary text-xs py-6">
                            No errors or warnings recorded
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
            </SettingsSection>

            <SettingsSection
                label="Community Discord"
                description="Join the StreamNook community for help, feature requests, updates, and chat with other users."
                bare
            >
                <div className="glass-panel p-4 rounded-lg">
                    <div className="flex items-center gap-4">
                        <div className="relative flex-shrink-0">
                            {serverData?.guild?.icon ? (
                                <img
                                    src={getServerIconUrl(serverData.guild.id, serverData.guild.icon)}
                                    alt={serverData.guild.name}
                                    className="w-12 h-12 rounded-full"
                                />
                            ) : (
                                <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center p-1.5">
                                    <img
                                        src={streamnookLogo}
                                        alt="StreamNook"
                                        className="w-full h-full object-contain"
                                    />
                                </div>
                            )}
                            {typeof serverData?.approximate_presence_count === 'number' && (
                                <Tooltip content={`${serverData.approximate_presence_count} online`} side="top">
                                    <div
                                        className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-[1.5px] border-background bg-green-500"
                                        style={{ animation: 'pulse-glow 2s ease-in-out infinite' }}
                                    />
                                </Tooltip>
                            )}
                        </div>

                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-textPrimary truncate">
                                {serverData?.guild?.name ?? 'StreamNook'}
                            </p>
                            {typeof serverData?.approximate_presence_count === 'number' &&
                             typeof serverData?.approximate_member_count === 'number' ? (
                                <p className="text-xs text-textSecondary">
                                    <span className="text-green-400">{serverData.approximate_presence_count} online</span>
                                    <span className="text-textMuted"> · {serverData.approximate_member_count} members</span>
                                </p>
                            ) : (
                                <p className="text-xs text-textSecondary truncate">
                                    discord.gg/{COMMUNITY_DISCORD_INVITE_CODE}
                                </p>
                            )}
                        </div>

                        <button
                            onClick={handleJoinCommunity}
                            className="glass-button px-4 py-2 rounded-lg flex items-center gap-2 text-sm font-medium hover:bg-accent/20 transition-colors"
                        >
                            <ExternalLink className="w-4 h-4" />
                            Join the Discord
                        </button>
                    </div>
                </div>
            </SettingsSection>
        </div>
    );
};

export default SupportSettings;
