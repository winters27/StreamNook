import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Settings, TrendingUp, X, Plus, Ban, Star, Shield, Lock, Users, ListFilter, LayoutList, Activity, Loader2 } from 'lucide-react';
import { Logger } from '../../utils/logger';
import { useAppStore } from '../../stores/AppStore';

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
    // Watch token allocation settings
    reserve_token_for_current_stream?: boolean;
    auto_reserve_on_watch?: boolean;
    priority_farm_channels?: Array<{ channel_id: string; channel_login: string; display_name: string }>;
}

interface ChannelSearchResult {
    id?: string;
    user_id?: string;
    user_login?: string;
    broadcaster_login?: string;
    user_name?: string;
    display_name?: string;
    thumbnail_url?: string;
    is_live?: boolean;
    game_name?: string;
    profile_image_url?: string;
}

interface DropsSettingsTabProps {
    settings: DropsSettings | null;
    onUpdateSettings: (newSettings: Partial<DropsSettings>) => Promise<void>;
    onStartAutoMining: () => Promise<void>;
    onStopMining: () => void;
}

function PriorityChannelRow({ 
    channel, 
    index, 
    followedStreams,
    onRemove 
}: { 
    channel: { channel_id: string; channel_login: string; display_name: string }; 
    index: number; 
    followedStreams: Array<{ user_id: string; profile_image_url?: string; thumbnail_url?: string }>;
    onRemove: () => void;
}) {
    const followedMatch = followedStreams.find(s => s.user_id === channel.channel_id);
    const syncAvatarUrl = followedMatch?.profile_image_url;
    
    const [asyncAvatarUrl, setAsyncAvatarUrl] = useState<string | null>(null);
    const isLive = !!followedMatch;

    useEffect(() => {
        // If we already have the image from the followed list, skip the IPC payload
        if (syncAvatarUrl) return;

        // Otherwise, fetch asynchronously for offline/unfollowed streams
        let isMounted = true;
        invoke<{ profile_image_url?: string }>('get_user_by_id', { userId: channel.channel_id })
            .then(info => {
                if (isMounted && info?.profile_image_url) {
                    setAsyncAvatarUrl(info.profile_image_url);
                }
            })
            .catch(err => Logger.warn(`Failed to fetch avatar for ${channel.channel_login}:`, err));

        return () => { isMounted = false; };
    }, [channel.channel_id, channel.channel_login, syncAvatarUrl]);

    const finalAvatarUrl = syncAvatarUrl || asyncAvatarUrl;

    return (
        <div className="flex items-center gap-3 bg-background p-3 rounded-lg border border-borderLight group">
            <span className="text-textSecondary font-mono text-xs w-6 h-6 flex items-center justify-center bg-blue-500/10 rounded shrink-0">
                {index + 1}
            </span>
            
            {finalAvatarUrl ? (
                <img 
                    src={finalAvatarUrl} 
                    alt={channel.display_name} 
                    className="w-8 h-8 rounded-full object-cover shrink-0"
                />
            ) : (
                <div className="w-8 h-8 rounded-full bg-borderLight/50 flex items-center justify-center shrink-0">
                    <Users size={14} className="text-textSecondary" />
                </div>
            )}
            
            <div className="flex-1 min-w-0 flex items-center gap-1.5">
                <span className="text-textPrimary font-medium truncate">{channel.display_name}</span>
                {channel.display_name.toLowerCase() !== channel.channel_login.toLowerCase() && (
                    <span className="text-xs text-textSecondary opacity-70 truncate">({channel.channel_login})</span>
                )}
                {isLive && (
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 shadow-[0_0_5px_rgba(239,68,68,0.5)] shrink-0 ml-1"></span>
                )}
            </div>
            <button
                onClick={onRemove}
                className="p-1.5 text-textSecondary hover:text-red-400 hover:bg-red-500/10 rounded transition-all opacity-0 group-hover:opacity-100 shrink-0"
            >
                <X size={16} />
            </button>
        </div>
    );
}

export default function DropsSettingsTab({
    settings,
    onUpdateSettings,
    onStartAutoMining,
    onStopMining
}: DropsSettingsTabProps) {
    const { followedStreams, loadFollowedStreams } = useAppStore();
    
    // Auto-load followed streams if not populated so the sorter works
    useEffect(() => {
        if (followedStreams.length === 0) {
            loadFollowedStreams();
        }
    }, [followedStreams.length, loadFollowedStreams]);
    
    const [activeTab, setActiveTab] = useState<'drops' | 'channel_points'>('drops');
    const [priorityInput, setPriorityInput] = useState('');
    const [excludedInput, setExcludedInput] = useState('');
    const [farmChannelInput, setFarmChannelInput] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    const [searchResults, setSearchResults] = useState<ChannelSearchResult[]>([]);
    const [showDropdown, setShowDropdown] = useState(false);
    
    // Create a ref specifically for the timeout ID that doesn't trigger re-renders
    const searchTimeoutRefContainer = useRef<NodeJS.Timeout | null>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Handle clicks outside the dropdown
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setShowDropdown(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    // Debounced Search Effect
    useEffect(() => {
        if (!farmChannelInput.trim()) {
            setSearchResults([]);
            setIsSearching(false);
            return;
        }

        if (searchTimeoutRefContainer.current) {
            clearTimeout(searchTimeoutRefContainer.current);
        }

        setIsSearching(true);
        searchTimeoutRefContainer.current = setTimeout(async () => {
            try {
                // Returns an array of TwitchStreams
                const results = await invoke('search_channels', { query: farmChannelInput }) as ChannelSearchResult[];
                
                // Filter out channels already in the priority list
                const existingLogins = (settings?.priority_farm_channels ?? []).map(c => c.channel_login);
                const filtered = results.filter(r => !existingLogins.includes(r.user_login || r.broadcaster_login || ''));
                
                // Sort: Live followed > Offline followed > Live unfollowed > Offline unfollowed
                const followedIds = new Set(followedStreams.map(s => s.user_id));
                
                const sorted = filtered.sort((a, b) => {
                    const idA = a.user_id || a.id || '';
                    const idB = b.user_id || b.id || '';
                    
                    const aFollowed = followedIds.has(idA);
                    const bFollowed = followedIds.has(idB);
                    const aLive = !!a.is_live;
                    const bLive = !!b.is_live;

                    if (aFollowed && aLive && (!bFollowed || !bLive)) return -1;
                    if (bFollowed && bLive && (!aFollowed || !aLive)) return 1;
                    
                    if (aFollowed && !bFollowed) return -1;
                    if (bFollowed && !aFollowed) return 1;
                    
                    if (aLive && !bLive) return -1;
                    if (bLive && !aLive) return 1;

                    return 0;
                });
                
                setSearchResults(sorted.slice(0, 5)); // Show top 5
            } catch (err) {
                Logger.error('Failed to search channels:', err);
                setSearchResults([]);
            } finally {
                setIsSearching(false);
            }
        }, 500); // 500ms debounce

        return () => {
            if (searchTimeoutRefContainer.current) clearTimeout(searchTimeoutRefContainer.current);
        };
    }, [farmChannelInput, settings?.priority_farm_channels, followedStreams]);

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

                {/* Segmented Control */}
                <div className="flex p-1.5 bg-background/80 backdrop-blur-xl rounded-xl border border-borderLight shadow-inner mb-6 relative z-10 w-full max-w-md mx-auto">
                    <button
                        onClick={() => setActiveTab('drops')}
                        className={`flex-1 py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold transition-all duration-300 ${
                            activeTab === 'drops'
                                ? 'bg-accent text-white shadow-[0_4px_20px_rgba(139,92,246,0.4)] ring-1 ring-white/10'
                                : 'text-textSecondary hover:text-textPrimary hover:bg-white/5'
                        }`}
                    >
                        <TrendingUp size={18} />
                        Drops Config
                    </button>
                    <button
                        onClick={() => setActiveTab('channel_points')}
                        className={`flex-1 py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 text-sm font-semibold transition-all duration-300 ${
                            activeTab === 'channel_points'
                                ? 'bg-blue-600 text-white shadow-[0_4px_20px_rgba(37,99,235,0.4)] ring-1 ring-white/10'
                                : 'text-textSecondary hover:text-textPrimary hover:bg-white/5'
                        }`}
                    >
                        <Lock size={18} />
                        Channel Points
                    </button>
                </div>

                {/* Tab Content Viewport */}
                <div className="relative">
                    {/* DROPS TAB */}
                    {activeTab === 'drops' && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
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
                                        className="flex-1 px-4 py-2.5 glass-input text-textPrimary text-sm placeholder:text-textSecondary focus:outline-none"
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
                                        className="flex-1 px-4 py-2.5 glass-input text-textPrimary text-sm placeholder:text-textSecondary focus:outline-none"
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
                    )}

                    {/* CHANNEL POINTS TAB */}
                    {activeTab === 'channel_points' && (
                        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                            {/* Channel Points Farming Card */}
                            <div className="glass-panel p-6 relative z-50">
                                <h3 className="text-lg font-bold text-textPrimary mb-2 flex items-center gap-2">
                                    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent">
                                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                                    </svg>
                                    Channel Points Farming
                                </h3>

                                {/* Slot Visualization */}
                                <div className="mb-6 p-5 bg-background/50 rounded-xl border border-borderLight shadow-sm">
                                    <div className="flex items-center justify-between mb-4">
                                        <span className="text-xs font-bold text-textSecondary uppercase tracking-wider">Token Allocation Map</span>
                                        <Activity size={14} className="text-accent/70" />
                                    </div>

                                    {/* Node Tree Infographic */}
                                    <div className="relative pl-7 space-y-6">
                                        {/* Connecting Line */}
                                        <div className="absolute left-[11px] top-6 bottom-6 w-0.5 bg-borderLight shadow-inner rounded-full" />

                                        {/* Token 1 */}
                                        <div className="relative">
                                            {/* Node Dot */}
                                            <div className={`absolute -left-7 top-1 w-6 h-6 rounded-full flex items-center justify-center border-4 border-[#121415] z-10 ${(settings.reserve_token_for_current_stream ?? true) ? 'bg-accent shadow-[0_0_10px_rgba(139,92,246,0.3)]' : 'bg-textSecondary/50'}`}>
                                                {(settings.reserve_token_for_current_stream ?? true) ? <Lock size={10} className="text-white" /> : <Users size={10} className="text-white" />}
                                            </div>
                                            <div className="ml-1 leading-snug">
                                                <span className={`text-sm font-semibold ${(settings.reserve_token_for_current_stream ?? true) ? 'text-accent' : 'text-textPrimary'}`}>Token 1: The Anchor</span>
                                                <p className="text-xs text-textSecondary mt-1">
                                                    {(settings.reserve_token_for_current_stream ?? true)
                                                        ? 'Reserved exclusively for your active window. Guarantees priority for the channel you are physically watching.'
                                                        : 'Unlocked. The background miner will hijack this token to speed up rotation through background channels.'
                                                    }
                                                </p>
                                            </div>
                                        </div>

                                        {/* Token 2 */}
                                        <div className="relative">
                                            {/* Node Dot */}
                                            <div className={`absolute -left-7 top-1 w-6 h-6 rounded-full flex items-center justify-center border-4 border-[#121415] z-10 ${(settings.priority_farm_channels ?? []).length > 0 ? 'bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.3)]' : 'bg-textSecondary/50'}`}>
                                                {(settings.priority_farm_channels ?? []).length > 0 ? <ListFilter size={10} className="text-white" /> : <LayoutList size={10} className="text-white" />}
                                            </div>
                                            <div className="ml-1 leading-snug">
                                                <span className={`text-sm font-semibold ${(settings.priority_farm_channels ?? []).length > 0 ? 'text-blue-400' : 'text-textPrimary'}`}>Token 2: The Miner</span>
                                                <p className="text-xs text-textSecondary mt-1">
                                                    {(settings.priority_farm_channels ?? []).length > 0
                                                        ? `Restricted. Actively targets and rotates between your ${settings.priority_farm_channels?.length} priority channels. Ignores all other followed streams.`
                                                        : 'Unrestricted. Automatically cycles through your entire live followed list every 15 minutes.'
                                                    }
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Explicit Behavior Readout */}
                                    <div className="bg-textSecondary/5 mt-5 p-3 rounded border border-borderLight flex items-start gap-2.5">
                                        <Activity size={14} className="text-textSecondary mt-0.5 shrink-0" />
                                        <p className="text-xs text-textSecondary leading-relaxed italic">
                                            {(settings.reserve_token_for_current_stream ?? true)
                                                ? ((settings.priority_farm_channels ?? []).length > 0
                                                    ? `Currently: 1 token is locked. The remaining 1 token rotates through your ${settings.priority_farm_channels?.length} priority channels (mining 1 channel every 15 mins).`
                                                    : `Currently: 1 token is locked. The remaining 1 token sweeps through your entire live followed list (mining 1 channel every 15 mins).`)
                                                : ((settings.priority_farm_channels ?? []).length > 0
                                                    ? `Currently: 0 tokens locked. Both 2 tokens rotate through your ${settings.priority_farm_channels?.length} priority channels (mining 2 channels every 15 mins).`
                                                    : `Currently: 0 tokens locked. Both 2 tokens sweep through your entire live followed list (mining 2 channels every 15 mins).`)}
                                        </p>
                                    </div>
                                </div>

                                {/* Toggles */}
                                <div className="space-y-1 mb-6">
                                    <ToggleSetting
                                        label="Reserve Token for Current Stream"
                                        description="Keep one token on the stream you're watching (Slot 1)"
                                        checked={settings.reserve_token_for_current_stream ?? true}
                                        onChange={(checked) => onUpdateSettings({ reserve_token_for_current_stream: checked })}
                                    />

                                    <div className="h-px bg-borderLight mx-2" />

                                    <div className={`${!(settings.reserve_token_for_current_stream ?? true) ? 'opacity-50 pointer-events-none' : ''}`}>
                                        <ToggleSetting
                                            label="Auto-reserve When Starting Stream"
                                            description="Automatically reserve Slot 1 when you start watching"
                                            checked={settings.auto_reserve_on_watch ?? true}
                                            onChange={(checked) => onUpdateSettings({ auto_reserve_on_watch: checked })}
                                        />
                                    </div>
                                </div>

                                {/* Priority Farm Channels — Always visible */}
                                <div className="border-t border-borderLight pt-5 relative z-50">
                                    <div className="flex items-center justify-between mb-2">
                                        <h4 className="text-sm font-semibold text-textPrimary flex items-center gap-2">
                                            <ListFilter size={14} className="text-blue-400" />
                                            Priority Target List
                                        </h4>
                                    </div>
                                    <p className="text-xs text-textSecondary mb-4 leading-relaxed">
                                        If you add any channels below, the background miner will <strong className="text-textPrimary">exclusively</strong> target them for farming and ignore the rest of your followed list. If this list is empty, the miner defaults to sweeping through all your followed channels sequentially.
                                    </p>

                                    {/* Channel List */}
                                    <div className="space-y-2 mb-4">
                                        {(settings.priority_farm_channels ?? []).length > 0 ? (
                                            (settings.priority_farm_channels ?? []).map((channel, index) => (
                                                <PriorityChannelRow
                                                    key={channel.channel_id}
                                                    channel={channel}
                                                    index={index}
                                                    followedStreams={followedStreams}
                                                    onRemove={() => {
                                                        const newChannels = [...(settings.priority_farm_channels ?? [])];
                                                        newChannels.splice(index, 1);
                                                        onUpdateSettings({ priority_farm_channels: newChannels });
                                                    }}
                                                />
                                            ))
                                        ) : (
                                            <div className="text-xs text-textSecondary italic text-center p-4 bg-background/50 rounded-lg border border-dashed border-borderLight">
                                                No priority channels — Slot 2 rotates through all followed streams
                                            </div>
                                        )}
                                    </div>

                                    {/* Add Channel Autocomplete Input */}
                                    <div className="relative" ref={dropdownRef}>
                                        <div className="flex gap-2">
                                            <div className="relative flex-1">
                                                <input
                                                    type="text"
                                                    placeholder="Search for a channel..."
                                                    value={farmChannelInput}
                                                    onChange={(e) => {
                                                        setFarmChannelInput(e.target.value);
                                                        setShowDropdown(true);
                                                    }}
                                                    onFocus={() => {
                                                        if (farmChannelInput.trim()) setShowDropdown(true);
                                                    }}
                                                    onKeyDown={async (e) => {
                                                        if (e.key === 'Enter' && farmChannelInput.trim() && !showDropdown) {
                                                            // Fallback to strict exact-match lookup if dropdown is bypassed
                                                            const channelName = farmChannelInput.trim().toLowerCase();
                                                            const existing = settings.priority_farm_channels ?? [];
                                                            if (existing.some(c => c.channel_login === channelName)) return;
                                                            try {
                                                                const info = await invoke('get_user_by_login', { login: channelName }) as { id: string; login: string; display_name: string };
                                                                await onUpdateSettings({
                                                                    priority_farm_channels: [...existing, {
                                                                        channel_id: info.id,
                                                                        channel_login: info.login,
                                                                        display_name: info.display_name,
                                                                    }]
                                                                });
                                                                setFarmChannelInput('');
                                                                setShowDropdown(false);
                                                            } catch (err) {
                                                                Logger.error('Could not find exact channel:', err);
                                                            }
                                                        }
                                                    }}
                                                    className="w-full px-4 py-2.5 glass-input text-textPrimary text-sm placeholder:text-textSecondary focus:outline-none"
                                                />
                                                {isSearching && (
                                                    <div className="absolute right-3 top-0 bottom-0 flex items-center">
                                                        <Loader2 size={16} className="text-accent animate-spin" />
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* Dropdown Results */}
                                        {showDropdown && farmChannelInput.trim() && (
                                            <div className="absolute z-50 left-0 right-0 mt-2 glass-panel overflow-hidden drop-shadow-2xl">
                                                {isSearching && searchResults.length === 0 ? (
                                                    <div className="p-4 text-center text-xs text-textSecondary italic">Searching Twitch...</div>
                                                ) : searchResults.length > 0 ? (
                                                    <div className="max-h-60 overflow-y-auto">
                                                        {searchResults.map((result) => {
                                                            // Handle varying response structures between Helix endpoints
                                                            const login = result.user_login || result.broadcaster_login || '';
                                                            const displayName = result.user_name || result.display_name || login;
                                                            const id = result.user_id || result.id || '';
                                                            
                                                            return (
                                                                <button
                                                                    key={id}
                                                                    onClick={async () => {
                                                                        const existing = settings.priority_farm_channels ?? [];
                                                                        if (existing.some(c => c.channel_id === id)) return;
                                                                        
                                                                        await onUpdateSettings({
                                                                            priority_farm_channels: [...existing, {
                                                                                channel_id: id,
                                                                                channel_login: login,
                                                                                display_name: displayName,
                                                                            }]
                                                                        });
                                                                        setFarmChannelInput('');
                                                                        setShowDropdown(false);
                                                                    }}
                                                                    className="w-full px-4 py-3 text-left hover:bg-glass-hover focus:bg-glass-hover transition-colors flex items-center gap-3 group"
                                                                >
                                                                    {result.profile_image_url || result.thumbnail_url ? (
                                                                        <img 
                                                                            src={result.profile_image_url || result.thumbnail_url} 
                                                                            alt={displayName} 
                                                                            className="w-8 h-8 rounded-full object-cover"
                                                                        />
                                                                    ) : (
                                                                        <div className="w-8 h-8 rounded-full bg-borderLight/50 flex items-center justify-center">
                                                                            <Users size={14} className="text-textSecondary" />
                                                                        </div>
                                                                    )}
                                                                    <div className="flex-1 min-w-0">
                                                                        <div className="flex items-center gap-1.5">
                                                                            <span className="text-sm font-medium text-textPrimary group-hover:text-accent transition-colors truncate">
                                                                                {displayName}
                                                                            </span>
                                                                            {result.is_live && (
                                                                                <span className="w-1.5 h-1.5 rounded-full bg-red-500 shadow-[0_0_5px_rgba(239,68,68,0.5)]"></span>
                                                                            )}
                                                                        </div>
                                                                        <div className="text-xs text-textSecondary truncate">
                                                                            {result.game_name || login}
                                                                        </div>
                                                                    </div>
                                                                    <Plus size={16} className="text-textSecondary group-hover:text-accent opacity-0 group-hover:opacity-100 transition-all shrink-0" />
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                ) : (
                                                    <div className="p-4 text-center text-xs text-textSecondary italic">No channels found for "{farmChannelInput}"</div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
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
