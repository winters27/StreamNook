import { useState } from 'react';
import { Settings, TrendingUp, X, Plus, Ban, Star, Shield, AlertTriangle } from 'lucide-react';

type RecoveryMode = 'Automatic' | 'Relaxed' | 'ManualOnly';

interface RecoverySettings {
    recovery_mode?: RecoveryMode;
    stale_progress_threshold_seconds?: number;
    streamer_blacklist_duration_seconds?: number;
    campaign_deprioritize_duration_seconds?: number;
    detect_game_category_change?: boolean;
    notify_on_recovery_action?: boolean;
    max_recovery_attempts?: number;
}

interface DropsSettings {
    auto_claim_drops: boolean;
    auto_claim_channel_points: boolean;
    notify_on_drop_available: boolean;
    notify_on_drop_claimed: boolean;
    notify_on_points_claimed: boolean;
    check_interval_seconds: number;
    auto_mining_enabled: boolean;
    priority_games: string[];
    excluded_games: string[];
    priority_mode: 'PriorityOnly' | 'EndingSoonest' | 'LowAvailFirst';
    watch_interval_seconds: number;
    recovery_settings?: RecoverySettings;
}

interface DropsSettingsTabProps {
    settings: DropsSettings | null;
    onUpdateSettings: (newSettings: Partial<DropsSettings>) => Promise<void>;
    onStartAutoMining: () => Promise<void>;
    onStopMining: () => void;
}

export default function DropsSettingsTab({
    settings,
    onUpdateSettings,
    onStartAutoMining,
    onStopMining
}: DropsSettingsTabProps) {
    const [priorityInput, setPriorityInput] = useState('');
    const [excludedInput, setExcludedInput] = useState('');

    if (!settings) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center glass-panel p-8">
                    <Settings size={48} className="mx-auto text-textSecondary opacity-40 mb-4" />
                    <h3 className="text-lg font-bold text-textPrimary mb-2">Loading Settings</h3>
                    <p className="text-sm text-textSecondary">
                        Please wait while settings are loaded...
                    </p>
                </div>
            </div>
        );
    }

    const addPriorityGame = () => {
        const game = priorityInput.trim();
        if (game && !settings.priority_games.includes(game)) {
            onUpdateSettings({
                priority_games: [...settings.priority_games, game]
            });
            setPriorityInput('');
        }
    };

    const removePriorityGame = (index: number) => {
        const newPriority = [...settings.priority_games];
        newPriority.splice(index, 1);
        onUpdateSettings({ priority_games: newPriority });
    };

    const addExcludedGame = () => {
        const game = excludedInput.trim();
        if (game && !settings.excluded_games.includes(game)) {
            onUpdateSettings({
                excluded_games: [...settings.excluded_games, game]
            });
            setExcludedInput('');
        }
    };

    const removeExcludedGame = (index: number) => {
        const newExcluded = [...settings.excluded_games];
        newExcluded.splice(index, 1);
        onUpdateSettings({ excluded_games: newExcluded });
    };

    const handleAutoMiningToggle = async (enabled: boolean) => {
        await onUpdateSettings({ auto_mining_enabled: enabled });
        if (enabled) {
            await onStartAutoMining();
        } else {
            onStopMining();
        }
    };

    return (
        <div className="h-full overflow-y-auto p-6 custom-scrollbar animate-in fade-in">
            <div className="max-w-3xl mx-auto space-y-6">
                {/* Automation Settings Card */}
                <div className="glass-panel p-6">
                    <h3 className="text-lg font-bold text-textPrimary mb-4 flex items-center gap-2">
                        <Settings size={20} className="text-accent" />
                        Automation Settings
                    </h3>

                    <div className="space-y-1">
                        {/* Auto-Claim Drops */}
                        <ToggleSetting
                            label="Auto-Claim Drops"
                            description="Automatically claim drops when they are 100% complete"
                            checked={settings.auto_claim_drops}
                            onChange={(checked) => onUpdateSettings({ auto_claim_drops: checked })}
                        />

                        <div className="h-px bg-borderLight mx-2" />

                        {/* Auto-Claim Channel Points */}
                        <ToggleSetting
                            label="Auto-Claim Channel Points"
                            description="Bonus points chests will be collected automatically"
                            checked={settings.auto_claim_channel_points}
                            onChange={(checked) => onUpdateSettings({ auto_claim_channel_points: checked })}
                        />

                        <div className="h-px bg-borderLight mx-2" />

                        {/* Auto-Mining */}
                        <ToggleSetting
                            label="Enable Auto-Mining"
                            description="Automatically watch streams to earn drops when app is open"
                            checked={settings.auto_mining_enabled}
                            onChange={handleAutoMiningToggle}
                            highlight
                        />
                    </div>
                </div>

                {/* Priority Strategy Card */}
                <div className="glass-panel p-6">
                    <h4 className="text-base font-semibold text-textPrimary mb-3 flex items-center gap-2">
                        <TrendingUp size={18} className="text-accent" />
                        Priority Strategy
                    </h4>

                    <select
                        value={settings.priority_mode}
                        onChange={(e) => onUpdateSettings({ priority_mode: e.target.value as DropsSettings['priority_mode'] })}
                        className="w-full px-4 py-2.5 bg-background border border-borderLight rounded-lg text-textPrimary focus:border-accent focus:outline-none cursor-pointer"
                    >
                        <option value="PriorityOnly">Priority Games Only</option>
                        <option value="EndingSoonest">Campaigns Ending Soonest</option>
                        <option value="LowAvailFirst">Low Availability First</option>
                    </select>

                    <p className="text-xs text-textSecondary mt-2 px-1">
                        Determines which drop campaigns are mined first when multiple are available.
                    </p>
                </div>

                {/* Priority Games Card */}
                <div className="glass-panel p-6">
                    <div className="flex justify-between items-center mb-4">
                        <h4 className="text-base font-semibold text-textPrimary flex items-center gap-2">
                            <Star size={18} className="text-yellow-400" />
                            Priority Games
                        </h4>
                        <span className="text-xs text-textSecondary bg-glass px-2 py-1 rounded">
                            Mined first in order
                        </span>
                    </div>

                    {/* Priority Games List */}
                    <div className="space-y-2 mb-4">
                        {settings.priority_games.length > 0 ? (
                            settings.priority_games.map((game, index) => (
                                <div
                                    key={index}
                                    className="flex items-center gap-3 bg-background p-3 rounded-lg border border-borderLight group"
                                >
                                    <span className="text-textSecondary font-mono text-xs w-6 h-6 flex items-center justify-center bg-accent/10 rounded">
                                        {index + 1}
                                    </span>
                                    <span className="text-textPrimary flex-1 font-medium truncate">
                                        {game}
                                    </span>
                                    <button
                                        onClick={() => removePriorityGame(index)}
                                        className="p-1.5 text-textSecondary hover:text-red-400 hover:bg-red-500/10 rounded transition-all opacity-0 group-hover:opacity-100"
                                    >
                                        <X size={16} />
                                    </button>
                                </div>
                            ))
                        ) : (
                            <div className="text-xs text-textSecondary italic text-center p-4 bg-background/50 rounded-lg border border-dashed border-borderLight">
                                No priority games configured. Add games below.
                            </div>
                        )}
                    </div>

                    {/* Add Priority Game */}
                    <div className="flex gap-2">
                        <input
                            type="text"
                            placeholder="Add game name..."
                            value={priorityInput}
                            onChange={(e) => setPriorityInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    addPriorityGame();
                                }
                            }}
                            className="flex-1 px-4 py-2.5 bg-background border border-borderLight rounded-lg text-textPrimary text-sm placeholder:text-textSecondary focus:border-accent focus:outline-none"
                        />
                        <button
                            onClick={addPriorityGame}
                            disabled={!priorityInput.trim()}
                            className="px-4 py-2.5 bg-accent hover:bg-accentHover disabled:bg-glass disabled:text-textSecondary text-white rounded-lg transition-colors text-sm font-medium flex items-center gap-1.5"
                        >
                            <Plus size={16} />
                            Add
                        </button>
                    </div>
                </div>

                {/* Excluded Games Card */}
                <div className="glass-panel p-6">
                    <div className="flex justify-between items-center mb-4">
                        <h4 className="text-base font-semibold text-textPrimary flex items-center gap-2">
                            <Ban size={18} className="text-red-400" />
                            Excluded Games
                        </h4>
                        <span className="text-xs text-textSecondary bg-glass px-2 py-1 rounded">
                            Never mined
                        </span>
                    </div>

                    {/* Excluded Games List */}
                    <div className="space-y-2 mb-4">
                        {settings.excluded_games.length > 0 ? (
                            settings.excluded_games.map((game, index) => (
                                <div
                                    key={index}
                                    className="flex items-center gap-3 bg-background p-3 rounded-lg border border-borderLight group"
                                >
                                    <Ban size={14} className="text-red-400/60" />
                                    <span className="text-textPrimary flex-1 font-medium truncate">
                                        {game}
                                    </span>
                                    <button
                                        onClick={() => removeExcludedGame(index)}
                                        className="p-1.5 text-textSecondary hover:text-red-400 hover:bg-red-500/10 rounded transition-all opacity-0 group-hover:opacity-100"
                                    >
                                        <X size={16} />
                                    </button>
                                </div>
                            ))
                        ) : (
                            <div className="text-xs text-textSecondary italic text-center p-4 bg-background/50 rounded-lg border border-dashed border-borderLight">
                                No excluded games. Add games to never mine them.
                            </div>
                        )}
                    </div>

                    {/* Add Excluded Game */}
                    <div className="flex gap-2">
                        <input
                            type="text"
                            placeholder="Block game name..."
                            value={excludedInput}
                            onChange={(e) => setExcludedInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    addExcludedGame();
                                }
                            }}
                            className="flex-1 px-4 py-2.5 bg-background border border-borderLight rounded-lg text-textPrimary text-sm placeholder:text-textSecondary focus:border-accent focus:outline-none"
                        />
                        <button
                            onClick={addExcludedGame}
                            disabled={!excludedInput.trim()}
                            className="px-4 py-2.5 bg-gray-700 hover:bg-gray-600 disabled:bg-glass disabled:text-textSecondary text-white rounded-lg transition-colors text-sm font-medium flex items-center gap-1.5"
                        >
                            <Ban size={16} />
                            Block
                        </button>
                    </div>
                </div>

                {/* Recovery Settings Card */}
                <div className="glass-panel p-6">
                    <div className="flex justify-between items-center mb-4">
                        <h4 className="text-base font-semibold text-textPrimary flex items-center gap-2">
                            <Shield size={18} className="text-emerald-400" />
                            Mining Recovery
                        </h4>
                        <span className="text-xs text-textSecondary bg-glass px-2 py-1 rounded">
                            Auto-recovery
                        </span>
                    </div>

                    <p className="text-xs text-textSecondary mb-4">
                        Configure how StreamNook handles stuck mining sessions, offline streamers, and stale progress.
                    </p>

                    {/* Recovery Mode */}
                    <div className="mb-4">
                        <label className="block text-sm font-medium text-textPrimary mb-2">
                            Recovery Mode
                        </label>
                        <select
                            value={settings.recovery_settings?.recovery_mode ?? 'Automatic'}
                            onChange={(e) => onUpdateSettings({
                                recovery_settings: {
                                    ...settings.recovery_settings,
                                    recovery_mode: e.target.value as RecoveryMode
                                }
                            })}
                            className="w-full px-4 py-2.5 bg-background border border-borderLight rounded-lg text-textPrimary focus:border-accent focus:outline-none cursor-pointer"
                        >
                            <option value="Automatic">Automatic (7 min threshold)</option>
                            <option value="Relaxed">Relaxed (15 min threshold)</option>
                            <option value="ManualOnly">Manual Only (notify but don't switch)</option>
                        </select>
                        <p className="text-xs text-textSecondary mt-1">
                            How aggressively to handle stuck mining sessions
                        </p>
                    </div>

                    {/* Stale Progress Threshold */}
                    <div className="mb-4">
                        <label className="block text-sm font-medium text-textPrimary mb-2">
                            Stale Progress Threshold: {Math.round((settings.recovery_settings?.stale_progress_threshold_seconds ?? 420) / 60)} minutes
                        </label>
                        <input
                            type="range"
                            min="180"
                            max="900"
                            step="60"
                            value={settings.recovery_settings?.stale_progress_threshold_seconds ?? 420}
                            onChange={(e) => onUpdateSettings({
                                recovery_settings: {
                                    ...settings.recovery_settings,
                                    stale_progress_threshold_seconds: parseInt(e.target.value)
                                }
                            })}
                            className="w-full accent-accent cursor-pointer"
                        />
                        <p className="text-xs text-textSecondary mt-1">
                            Switch streamers if no progress increase for this long (3-15 min)
                        </p>
                    </div>

                    {/* Streamer Blacklist Duration */}
                    <div className="mb-4">
                        <label className="block text-sm font-medium text-textPrimary mb-2">
                            Streamer Blacklist Duration: {Math.round((settings.recovery_settings?.streamer_blacklist_duration_seconds ?? 600) / 60)} minutes
                        </label>
                        <input
                            type="range"
                            min="300"
                            max="1800"
                            step="60"
                            value={settings.recovery_settings?.streamer_blacklist_duration_seconds ?? 600}
                            onChange={(e) => onUpdateSettings({
                                recovery_settings: {
                                    ...settings.recovery_settings,
                                    streamer_blacklist_duration_seconds: parseInt(e.target.value)
                                }
                            })}
                            className="w-full accent-accent cursor-pointer"
                        />
                        <p className="text-xs text-textSecondary mt-1">
                            How long to avoid a streamer after they fail (5-30 min)
                        </p>
                    </div>

                    <div className="h-px bg-borderLight my-4" />

                    {/* Detect Game Category Change */}
                    <ToggleSetting
                        label="Detect Game Category Changes"
                        description="Switch if streamer changes to a different game"
                        checked={settings.recovery_settings?.detect_game_category_change ?? true}
                        onChange={(checked) => onUpdateSettings({
                            recovery_settings: {
                                ...settings.recovery_settings,
                                detect_game_category_change: checked
                            }
                        })}
                    />

                    <div className="h-px bg-borderLight mx-2" />

                    {/* Notify on Recovery Actions */}
                    <ToggleSetting
                        label="Notify on Recovery Actions"
                        description="Show notifications when streamers are switched"
                        checked={settings.recovery_settings?.notify_on_recovery_action ?? true}
                        onChange={(checked) => onUpdateSettings({
                            recovery_settings: {
                                ...settings.recovery_settings,
                                notify_on_recovery_action: checked
                            }
                        })}
                    />
                </div>
            </div>
        </div>
    );
}

// Sub-component for toggle settings
interface ToggleSettingProps {
    label: string;
    description: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    highlight?: boolean;
}

function ToggleSetting({ label, description, checked, onChange, highlight }: ToggleSettingProps) {
    return (
        <label className={`flex items-center justify-between cursor-pointer group p-3 rounded-lg transition-colors ${highlight ? 'hover:bg-accent/5' : 'hover:bg-glass'}`}>
            <div className="space-y-0.5 pr-4">
                <div className={`font-medium ${highlight ? 'text-accent' : 'text-textPrimary'}`}>
                    {label}
                </div>
                <div className="text-xs text-textSecondary">
                    {description}
                </div>
            </div>
            <div className="relative shrink-0">
                <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => onChange(e.target.checked)}
                    className="sr-only peer"
                />
                <div className={`w-11 h-6 rounded-full transition-all peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-accent/50 
                    ${checked
                        ? highlight ? 'bg-accent border-accent' : 'bg-accent border-accent'
                        : 'bg-gray-700/50 border-borderLight'
                    } border-2
                    after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all
                    peer-checked:after:translate-x-full
                `} />
            </div>
        </label>
    );
}
