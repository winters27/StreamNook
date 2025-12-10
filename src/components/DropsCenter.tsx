import { useEffect, useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useAppStore } from '../stores/AppStore';
import { listen } from '@tauri-apps/api/event';
import { Search, Gift, MonitorPlay, BarChart3, Settings as SettingsIcon, Package } from 'lucide-react';
import {
    UnifiedGame, DropCampaign, DropProgress, DropsStatistics,
    MiningStatus, DropsDeviceCodeInfo, InventoryResponse, InventoryItem
} from '../types';
import LoadingWidget from './LoadingWidget';
import GameCard from './drops/GameCard';
import GameDetailPanel from './drops/GameDetailPanel';
import DropsStatsTab from './drops/DropsStatsTab';
import DropsSettingsTab from './drops/DropsSettingsTab';
import DropsInventoryTab from './drops/DropsInventoryTab';
import ChannelPickerModal from './drops/ChannelPickerModal';

// Twitch SVG Icon Component
const TwitchIcon = ({ size = 20 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
    </svg>
);

type Tab = 'games' | 'inventory' | 'stats' | 'settings';

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
}

export default function DropsCenter() {
    // Data State
    const [unifiedGames, setUnifiedGames] = useState<UnifiedGame[]>([]);
    const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
    const [statistics, setStatistics] = useState<DropsStatistics | null>(null);
    const [progress, setProgress] = useState<DropProgress[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Auth State
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [isAuthenticating, setIsAuthenticating] = useState(false);
    const [deviceCodeInfo, setDeviceCodeInfo] = useState<DropsDeviceCodeInfo | null>(null);

    // Mining State
    const [miningStatus, setMiningStatus] = useState<MiningStatus | null>(null);

    // UI State
    const [activeTab, setActiveTab] = useState<Tab>('games');
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedGame, setSelectedGame] = useState<UnifiedGame | null>(null);
    const { addToast, setShowDropsOverlay } = useAppStore();

    // Channel Picker State
    const [channelPickerOpen, setChannelPickerOpen] = useState(false);
    const [pendingCampaign, setPendingCampaign] = useState<{ id: string; name: string; gameName: string } | null>(null);

    // Mine All Queue State - tracks sequential campaign mining for a game
    const [mineAllQueue, setMineAllQueue] = useState<{
        gameName: string;
        campaignIds: string[];
        currentIndex: number;
    } | null>(null);

    // Settings State
    const [dropsSettings, setDropsSettings] = useState<DropsSettings | null>(null);

    // Derived state for filtering
    const filteredGames = useMemo(() => {
        if (!searchTerm) return unifiedGames;
        const lowerSearch = searchTerm.toLowerCase();
        return unifiedGames.filter(game =>
            game.name.toLowerCase().includes(lowerSearch) ||
            game.active_campaigns.some(c => c.name.toLowerCase().includes(lowerSearch))
        );
    }, [unifiedGames, searchTerm]);

    // ---- Authentication Logic ----
    const checkAuthentication = async () => {
        try {
            const authenticated = await invoke<boolean>('is_drops_authenticated');
            setIsAuthenticated(authenticated);
            return authenticated;
        } catch (err) {
            console.error('Failed to check drops authentication:', err);
            setIsAuthenticated(false);
            return false;
        }
    };

    const startDropsLogin = async () => {
        try {
            setIsAuthenticating(true);
            setError(null);
            const deviceInfo = await invoke<DropsDeviceCodeInfo>('start_drops_device_flow');
            setDeviceCodeInfo(deviceInfo);

            new WebviewWindow('drops-login', {
                url: deviceInfo.verification_uri,
                title: 'Drops Login - Twitch',
                width: 500,
                height: 700,
                center: true,
            });

            pollForToken(deviceInfo);
        } catch (err) {
            console.error('Failed to start drops login:', err);
            setError(err instanceof Error ? err.message : String(err));
            setIsAuthenticating(false);
        }
    };

    const pollForToken = async (deviceInfo: DropsDeviceCodeInfo) => {
        try {
            await invoke('poll_drops_token', {
                deviceCode: deviceInfo.device_code,
                interval: deviceInfo.interval,
                expiresIn: deviceInfo.expires_in,
            });

            try {
                const w = await WebviewWindow.getByLabel('drops-login');
                if (w) await w.close();
            } catch { }

            setIsAuthenticated(true);
            setIsAuthenticating(false);
            setDeviceCodeInfo(null);
            addToast('Drops login successful!', 'success');
            await loadDropsData();
        } catch (err) {
            console.error('Failed to complete drops login:', err);
            setError(err instanceof Error ? err.message : String(err));
            setIsAuthenticating(false);
        }
    };

    const handleDropsLogout = async () => {
        try {
            await invoke('drops_logout');
            setIsAuthenticated(false);
            setUnifiedGames([]);
            setProgress([]);
            setStatistics(null);
            setSelectedGame(null);
        } catch (err) {
            console.error('Failed to logout from drops:', err);
        }
    };

    // ---- Action Handlers ----
    const handleClaimDrop = async (dropId: string, dropInstanceId?: string) => {
        try {
            console.log('[DropsCenter] Claiming drop:', dropId, 'with dropInstanceId:', dropInstanceId);
            await invoke('claim_drop', { dropId, dropInstanceId });
            addToast('Drop claimed successfully!', 'success');

            // Also update the local progress state immediately to mark as claimed
            setProgress(prev => prev.map(p =>
                p.drop_id === dropId ? { ...p, is_claimed: true } : p
            ));

            // Refresh the data to get updated inventory
            await loadDropsData();

            // If a game is selected, refresh its reference from the updated data
            if (selectedGame) {
                // Use a slight delay to ensure state is updated
                setTimeout(() => {
                    setUnifiedGames(prevGames => {
                        const updatedGame = prevGames.find(g => g.id === selectedGame.id);
                        if (updatedGame) {
                            setSelectedGame(updatedGame);
                        }
                        return prevGames;
                    });
                }, 100);
            }
        } catch (err) {
            console.error('Failed to claim drop:', err);
            addToast('Failed to claim drop', 'error');
        }
    };

    const handleStartMining = (campaignId: string, campaignName: string, gameName: string) => {
        setPendingCampaign({ id: campaignId, name: campaignName, gameName });
        setChannelPickerOpen(true);
    };

    const handleMiningFromModal = async (channelId: string | null) => {
        setChannelPickerOpen(false);
        if (!pendingCampaign) return;

        try {
            if (dropsSettings?.auto_mining_enabled) {
                await updateDropsSettings({ auto_mining_enabled: false });
            }

            if (channelId) {
                await invoke('start_campaign_mining_with_channel', {
                    campaignId: pendingCampaign.id,
                    channelId,
                });
            } else {
                await invoke('start_campaign_mining', { campaignId: pendingCampaign.id });
            }
            addToast('Started mining campaign', 'success');
        } catch (err) {
            console.error('Failed to start mining:', err);
            addToast('Failed to start mining', 'error');
        } finally {
            setPendingCampaign(null);
        }
    };

    const handleStopMining = async () => {
        try {
            // Immediately update local state to reflect stopped mining
            setMiningStatus(prev => prev ? {
                ...prev,
                is_mining: false,
                current_drop: null,
                current_channel: null,
                current_campaign: null
            } : null);

            // Clear the mine all queue
            setMineAllQueue(null);

            // Clear ALL in-progress entries to prevent stale data when switching games
            // We completely reset and let the new mining session repopulate fresh data
            setProgress([]);

            // Then call the backend to actually stop
            await invoke('stop_auto_mining');
            addToast('Mining stopped', 'info');
        } catch (err) {
            console.error('Failed to stop mining:', err);
            // If there was an error, refresh the status from backend
            try {
                const status = await invoke<MiningStatus>('get_mining_status');
                setMiningStatus(status);
            } catch { }
        }
    };

    const handleStartAutoMining = async () => {
        try {
            await invoke('start_auto_mining');
            addToast('Auto-mining started', 'success');
        } catch (err) {
            console.error('Failed to start auto mining:', err);
            addToast('Failed to start auto-mining', 'error');
        }
    };

    const updateDropsSettings = async (newSettings: Partial<DropsSettings>) => {
        try {
            const current = dropsSettings || {
                auto_claim_drops: true,
                auto_claim_channel_points: true,
                notify_on_drop_available: true,
                notify_on_drop_claimed: true,
                notify_on_points_claimed: false,
                check_interval_seconds: 60,
                auto_mining_enabled: false,
                priority_games: [],
                excluded_games: [],
                priority_mode: 'PriorityOnly',
                watch_interval_seconds: 20,
            };
            const updatedSettings = { ...current, ...newSettings };

            await invoke('update_drops_settings', { settings: updatedSettings });
            setDropsSettings(updatedSettings);

            useAppStore.getState().updateSettings({
                ...useAppStore.getState().settings,
                drops: updatedSettings
            });
        } catch (err) {
            console.error('Failed to update drops settings:', err);
            addToast('Failed to save settings', 'error');
        }
    };

    const handleStreamClick = (channelName: string) => {
        setShowDropsOverlay(false);
        window.dispatchEvent(new CustomEvent('start-stream', { detail: { channel: channelName } }));
    };

    // Mine All Game - starts mining all campaigns for a game sequentially
    const handleMineAllGame = async (gameName: string, campaignIds: string[]) => {
        if (campaignIds.length === 0) {
            addToast('No campaigns to mine for this game', 'info');
            return;
        }

        console.log(`[DropsCenter] Starting Mine All for ${gameName} with ${campaignIds.length} campaigns`);

        // Stop any current mining first
        if (miningStatus?.is_mining) {
            await handleStopMining();
            // Wait a moment for the stop to take effect
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Set up the mine all queue
        setMineAllQueue({
            gameName,
            campaignIds,
            currentIndex: 0
        });

        // Start mining the first campaign
        try {
            if (dropsSettings?.auto_mining_enabled) {
                await updateDropsSettings({ auto_mining_enabled: false });
            }

            await invoke('start_campaign_mining', { campaignId: campaignIds[0] });
            addToast(`Mining all ${campaignIds.length} campaigns for ${gameName}`, 'success');
        } catch (err) {
            console.error('Failed to start mine all:', err);
            addToast('Failed to start mining', 'error');
            setMineAllQueue(null);
        }
    };

    // Start the next campaign in the mine all queue
    const startNextCampaignInQueue = async () => {
        if (!mineAllQueue) return;

        const nextIndex = mineAllQueue.currentIndex + 1;

        if (nextIndex >= mineAllQueue.campaignIds.length) {
            // All campaigns done
            console.log(`[DropsCenter] Mine All complete for ${mineAllQueue.gameName}`);
            addToast(`Finished mining all campaigns for ${mineAllQueue.gameName}!`, 'success');
            setMineAllQueue(null);
            return;
        }

        console.log(`[DropsCenter] Moving to next campaign ${nextIndex + 1}/${mineAllQueue.campaignIds.length}`);

        // Update the queue index
        setMineAllQueue(prev => prev ? { ...prev, currentIndex: nextIndex } : null);

        // Start the next campaign
        try {
            await invoke('start_campaign_mining', { campaignId: mineAllQueue.campaignIds[nextIndex] });
            addToast(`Mining campaign ${nextIndex + 1} of ${mineAllQueue.campaignIds.length}`, 'info');
        } catch (err) {
            console.error('Failed to start next campaign:', err);
            addToast('Failed to start next campaign', 'error');
            setMineAllQueue(null);
        }
    };

    // ---- Data Loading & Merging Logic ----
    const loadDropsData = async () => {
        try {
            setIsLoading(true);
            setError(null);

            const [campaignsData, progressData, statsData, inventoryData] = await Promise.all([
                invoke<DropCampaign[]>('get_active_drop_campaigns').catch(() => [] as DropCampaign[]),
                invoke<DropProgress[]>('get_drop_progress').catch(() => [] as DropProgress[]),
                invoke<DropsStatistics>('get_drops_statistics').catch(() => null),
                invoke<InventoryResponse>('get_drops_inventory').catch(() => null),
            ]);

            if (progressData) setProgress(progressData);
            if (statsData) setStatistics(statsData);
            if (inventoryData?.items) setInventoryItems(inventoryData.items);

            // Merge data into unified games
            const gamesMap = new Map<string, UnifiedGame>();

            const getOrCreateGame = (id: string, name: string, boxArt: string): UnifiedGame => {
                let game = gamesMap.get(id);
                if (!game) {
                    game = {
                        id,
                        name,
                        box_art_url: boxArt,
                        active_campaigns: [],
                        total_active_drops: 0,
                        drops_in_progress: 0,
                        inventory_items: [],
                        total_claimed: 0,
                        is_mining: false,
                        has_claimable: false
                    };
                    gamesMap.set(id, game);
                }
                return game;
            };

            // Process Active Campaigns
            if (campaignsData) {
                campaignsData.forEach(campaign => {
                    const game = getOrCreateGame(campaign.game_id, campaign.game_name, campaign.image_url);
                    game.active_campaigns.push(campaign);
                    game.total_active_drops += campaign.time_based_drops.length;

                    campaign.time_based_drops.forEach(drop => {
                        const prog = progressData?.find(p => p.drop_id === drop.id);
                        if (prog && !prog.is_claimed && prog.current_minutes_watched >= prog.required_minutes_watched) {
                            game.has_claimable = true;
                        }
                        if (prog && !prog.is_claimed && prog.current_minutes_watched > 0) {
                            game.drops_in_progress++;
                        }
                    });
                });
            }

            // Process Inventory Items
            if (inventoryData?.items) {
                inventoryData.items.forEach(item => {
                    let gameId = item.campaign.game_id;
                    const gameName = item.campaign.game_name || "Unknown Game";
                    if (!gameId) gameId = `generated-${gameName.toLowerCase().replace(/\s+/g, '-')}`;

                    const game = getOrCreateGame(gameId, gameName, item.campaign.image_url);
                    game.inventory_items.push(item);
                    game.total_claimed += item.claimed_drops;
                });
            }

            // Get the current mining game name (case-insensitive)
            const miningGameName = miningStatus?.current_drop?.game_name?.toLowerCase() ||
                miningStatus?.current_channel?.game_name?.toLowerCase();

            // Update is_mining flag for each game
            gamesMap.forEach(game => {
                if (miningStatus?.is_mining && miningGameName) {
                    game.is_mining = game.name.toLowerCase() === miningGameName;
                }
            });

            setUnifiedGames(Array.from(gamesMap.values()).sort((a, b) => {
                if (a.is_mining !== b.is_mining) return a.is_mining ? -1 : 1;
                if (a.has_claimable !== b.has_claimable) return a.has_claimable ? -1 : 1;
                if (a.active_campaigns.length !== b.active_campaigns.length) {
                    return b.active_campaigns.length - a.active_campaigns.length;
                }
                return a.name.localeCompare(b.name);
            }));

        } catch (err) {
            console.error('Failed to load unified drops data:', err);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsLoading(false);
        }
    };

    // ---- Effects ----
    useEffect(() => {
        const init = async () => {
            const auth = await checkAuthentication();
            if (auth) {
                try {
                    const status = await invoke<MiningStatus>('get_mining_status');
                    setMiningStatus(status);
                    const settings = await invoke<DropsSettings>('get_drops_settings');
                    setDropsSettings(settings);
                } catch (e) {
                    console.error(e);
                }
                await loadDropsData();
            } else {
                setIsLoading(false);
            }
        };
        init();

        // Listeners
        let unlistenStatus: (() => void) | undefined;
        let unlistenProgress: (() => void) | undefined;

        const setupListeners = async () => {
            unlistenStatus = await listen<MiningStatus>('mining-status-update', (event) => {
                console.log('[DropsCenter] Mining status update:', event.payload);
                setMiningStatus(event.payload);
            });

            unlistenProgress = await listen<any>('drops-progress-update', (event) => {
                console.log('[DropsCenter] Received drops-progress-update:', event.payload);

                // Update progress state
                setProgress((prev) => {
                    const idx = prev.findIndex(p => p.drop_id === event.payload.drop_id);
                    if (idx >= 0) {
                        // Update existing progress
                        const newProg = [...prev];
                        newProg[idx] = {
                            ...newProg[idx],
                            current_minutes_watched: event.payload.current_minutes,
                            required_minutes_watched: event.payload.required_minutes,
                            last_updated: event.payload.timestamp
                        };
                        console.log('[DropsCenter] Updated existing progress:', newProg[idx]);
                        return newProg;
                    } else {
                        // Add new progress entry
                        const newEntry: DropProgress = {
                            campaign_id: event.payload.campaign_id || '',
                            drop_id: event.payload.drop_id,
                            current_minutes_watched: event.payload.current_minutes,
                            required_minutes_watched: event.payload.required_minutes,
                            is_claimed: false,
                            last_updated: event.payload.timestamp
                        };
                        console.log('[DropsCenter] Added new progress entry:', newEntry);
                        return [...prev, newEntry];
                    }
                });

                // Also update miningStatus.current_drop - prioritize showing the drop closest to completion
                // This ensures we show the most relevant progress (nearest to being claimable)
                setMiningStatus((prev) => {
                    if (!prev || !prev.is_mining) return prev;

                    const dropId = event.payload.drop_id;
                    const currentMinutes = event.payload.current_minutes;
                    const requiredMinutes = event.payload.required_minutes;
                    const newDropPercent = requiredMinutes > 0 ? (currentMinutes / requiredMinutes) * 100 : 0;
                    const isNewDropComplete = currentMinutes >= requiredMinutes;

                    // Calculate current drop's completion percentage
                    const currentDropPercent = prev.current_drop && prev.current_drop.required_minutes > 0
                        ? (prev.current_drop.current_minutes / prev.current_drop.required_minutes) * 100
                        : 0;
                    const isCurrentDropComplete = prev.current_drop
                        ? prev.current_drop.current_minutes >= prev.current_drop.required_minutes
                        : false;

                    // If current_drop exists and matches this update, just update its progress
                    if (prev.current_drop && prev.current_drop.drop_id === dropId) {
                        console.log('[DropsCenter] Updating existing current_drop progress:', currentMinutes, '/', requiredMinutes);
                        return {
                            ...prev,
                            current_drop: {
                                ...prev.current_drop,
                                current_minutes: currentMinutes,
                                required_minutes: requiredMinutes
                            },
                            last_update: event.payload.timestamp
                        };
                    }

                    // Decide whether to switch to the new drop
                    // Priority: Show the drop that is closest to completion but NOT yet complete
                    // If both are incomplete, show the one with higher progress %
                    // If current is complete and new is incomplete, switch to the new one
                    // If both are complete, keep showing the current one (user can claim it)
                    let shouldSwitch = false;

                    if (!prev.current_drop) {
                        // No current drop - use the new one
                        shouldSwitch = true;
                        console.log('[DropsCenter] No current drop, using new drop');
                    } else if (isCurrentDropComplete && !isNewDropComplete) {
                        // Current is complete (ready to claim), new is not - switch to show the in-progress one
                        shouldSwitch = true;
                        console.log('[DropsCenter] Current drop complete, switching to incomplete drop');
                    } else if (!isCurrentDropComplete && !isNewDropComplete) {
                        // Both incomplete - show the one closer to completion (higher %)
                        if (newDropPercent > currentDropPercent) {
                            shouldSwitch = true;
                            console.log('[DropsCenter] New drop has higher progress:', newDropPercent.toFixed(1), '% vs', currentDropPercent.toFixed(1), '%');
                        }
                    }
                    // If both are complete, keep the current one (don't switch)

                    if (shouldSwitch) {
                        console.log('[DropsCenter] Switching to drop:', dropId, '(', currentMinutes, '/', requiredMinutes, 'minutes)');
                        return {
                            ...prev,
                            current_drop: {
                                campaign_id: event.payload.campaign_id || prev.current_drop?.campaign_id || '',
                                campaign_name: prev.current_drop?.campaign_name || prev.current_campaign || 'Unknown Campaign',
                                drop_id: dropId,
                                drop_name: prev.current_drop?.drop_name || 'Drop in Progress',
                                required_minutes: requiredMinutes,
                                current_minutes: currentMinutes,
                                game_name: prev.current_channel?.game_name || prev.current_drop?.game_name || 'Unknown Game'
                            },
                            last_update: event.payload.timestamp
                        };
                    }

                    return prev;
                });
            });
        };
        setupListeners();

        return () => {
            if (unlistenStatus) unlistenStatus();
            if (unlistenProgress) unlistenProgress();
        };
    }, []);

    // Mine All Queue - detect campaign completion and start next campaign
    useEffect(() => {
        if (!mineAllQueue || !miningStatus?.is_mining) return;

        // Find the current campaign being mined
        const currentCampaignId = mineAllQueue.campaignIds[mineAllQueue.currentIndex];

        // Find the game that has this campaign
        const gameWithCampaign = unifiedGames.find(g =>
            g.name.toLowerCase() === mineAllQueue.gameName.toLowerCase()
        );

        if (!gameWithCampaign) return;

        // Find the campaign
        const currentCampaign = gameWithCampaign.active_campaigns.find(c => c.id === currentCampaignId);
        if (!currentCampaign) {
            console.log(`[MineAll] Campaign ${currentCampaignId} not found, moving to next`);
            startNextCampaignInQueue();
            return;
        }

        // Check if all drops in the current campaign are complete (100%+ progress or claimed)
        const allDropsComplete = currentCampaign.time_based_drops.every(drop => {
            const dropProgress = progress.find(p => p.drop_id === drop.id);
            if (!dropProgress) return false;

            const isComplete = dropProgress.current_minutes_watched >= dropProgress.required_minutes_watched;
            const isClaimed = dropProgress.is_claimed;

            return isComplete || isClaimed;
        });

        if (allDropsComplete && currentCampaign.time_based_drops.length > 0) {
            console.log(`[MineAll] All drops complete for campaign "${currentCampaign.name}", moving to next campaign`);

            // Small delay before starting next campaign
            const timer = setTimeout(() => {
                startNextCampaignInQueue();
            }, 2000);

            return () => clearTimeout(timer);
        }
    }, [mineAllQueue, progress, unifiedGames, miningStatus]);

    // Update games' is_mining flag when miningStatus changes
    useEffect(() => {
        if (!miningStatus || unifiedGames.length === 0) return;

        const miningGameName = miningStatus?.current_drop?.game_name?.toLowerCase() ||
            miningStatus?.current_channel?.game_name?.toLowerCase();

        console.log('[DropsCenter] Updating is_mining flag. Mining:', miningStatus.is_mining, 'Game:', miningGameName);

        setUnifiedGames(prevGames => {
            const updated = prevGames.map(game => ({
                ...game,
                is_mining: miningStatus.is_mining && miningGameName
                    ? game.name.toLowerCase() === miningGameName
                    : false
            }));

            // Re-sort to put mining game first
            return updated.sort((a, b) => {
                if (a.is_mining !== b.is_mining) return a.is_mining ? -1 : 1;
                if (a.has_claimable !== b.has_claimable) return a.has_claimable ? -1 : 1;
                if (a.active_campaigns.length !== b.active_campaigns.length) {
                    return b.active_campaigns.length - a.active_campaigns.length;
                }
                return a.name.localeCompare(b.name);
            });
        });
    }, [miningStatus]);

    // ---- Render: Authentication Screen ----
    if (!isAuthenticated) {
        return (
            <div className="flex flex-col items-center justify-center h-full p-8 text-center animate-in fade-in duration-500">
                <div className="max-w-md space-y-6">
                    <div className="flex justify-center">
                        <div className="p-6 bg-accent/10 rounded-full border-2 border-accent/20">
                            <Gift className="w-16 h-16 text-accent" />
                        </div>
                    </div>
                    <div className="space-y-2">
                        <h2 className="text-2xl font-bold text-textPrimary">Drops Center</h2>
                        <p className="text-textSecondary">
                            Connect your Twitch account to start mining drops and earning rewards automatically.
                        </p>
                    </div>

                    {isAuthenticating && deviceCodeInfo && (
                        <div className="glass-panel p-6 space-y-4 border border-accent/30">
                            <div className="text-5xl font-mono font-bold text-accent tracking-widest py-4">
                                {deviceCodeInfo.user_code}
                            </div>
                            <p className="text-sm text-textSecondary">Enter this code on the login window</p>
                        </div>
                    )}

                    {!isAuthenticating && (
                        <button
                            onClick={startDropsLogin}
                            className="w-full px-6 py-3 glass-button hover:bg-glass-hover text-textPrimary rounded-lg transition-all font-semibold flex items-center justify-center gap-2"
                        >
                            <TwitchIcon size={20} />
                            <span>Connect Twitch Account</span>
                        </button>
                    )}
                </div>
            </div>
        );
    }

    // ---- Render: Main UI ----
    return (
        <div className="flex flex-col h-full bg-background animate-in fade-in">
            {/* Channel Picker Modal */}
            {pendingCampaign && (
                <ChannelPickerModal
                    isOpen={channelPickerOpen}
                    onClose={() => {
                        setChannelPickerOpen(false);
                        setPendingCampaign(null);
                    }}
                    campaignId={pendingCampaign.id}
                    campaignName={pendingCampaign.name}
                    gameName={pendingCampaign.gameName}
                    onStartMining={handleMiningFromModal}
                />
            )}

            {/* Header with Tabs */}
            <div className="flex items-center justify-center gap-2 px-4 py-3 bg-backgroundSecondary border-b border-borderLight shrink-0 relative">
                {/* Tab Navigation - Glass Panel Style (Centered) */}
                <div className="flex items-center glass-panel px-1.5 py-1 rounded-xl">
                    <button
                        onClick={() => setActiveTab('games')}
                        className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-all ${activeTab === 'games'
                            ? 'glass-button text-white'
                            : 'text-textSecondary hover:text-textPrimary hover:bg-glass-hover'
                            }`}
                    >
                        <MonitorPlay size={16} />
                        <span>Campaigns</span>
                    </button>
                    <button
                        onClick={() => setActiveTab('inventory')}
                        className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-all ${activeTab === 'inventory'
                            ? 'glass-button text-white'
                            : 'text-textSecondary hover:text-textPrimary hover:bg-glass-hover'
                            }`}
                    >
                        <Package size={16} />
                        <span>Inventory</span>
                    </button>
                    <button
                        onClick={() => setActiveTab('stats')}
                        className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-all ${activeTab === 'stats'
                            ? 'glass-button text-white'
                            : 'text-textSecondary hover:text-textPrimary hover:bg-glass-hover'
                            }`}
                    >
                        <BarChart3 size={16} />
                        <span>Stats</span>
                    </button>
                    <button
                        onClick={() => setActiveTab('settings')}
                        className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-all ${activeTab === 'settings'
                            ? 'glass-button text-white'
                            : 'text-textSecondary hover:text-textPrimary hover:bg-glass-hover'
                            }`}
                    >
                        <SettingsIcon size={16} />
                        <span>Settings</span>
                    </button>
                </div>

                {/* Right side: Search + Logout (Absolutely positioned) */}
                <div className="absolute right-4 flex items-center gap-3">
                    {activeTab === 'games' && (
                        <div className="relative">
                            <input
                                type="text"
                                placeholder="Search games..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="bg-background border border-borderLight rounded-lg pl-8 pr-4 py-1.5 text-sm w-48 focus:w-64 transition-all focus:border-accent focus:outline-none"
                            />
                            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-textSecondary" />
                        </div>
                    )}
                    <button
                        className="px-3 py-1.5 text-xs font-medium rounded-lg glass-panel text-textSecondary hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/30 border border-transparent transition-all"
                        onClick={handleDropsLogout}
                        title="Logout from Drops (Android Client)"
                    >
                        Logout
                    </button>
                </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-hidden relative">
                {/* Loading State */}
                {isLoading && (
                    <div className="h-full flex items-center justify-center">
                        <LoadingWidget useFunnyMessages={false} />
                    </div>
                )}

                {/* Games Tab */}
                {!isLoading && activeTab === 'games' && (
                    <div className="h-full overflow-y-auto p-4 custom-scrollbar">
                        {/* Empty State */}
                        {filteredGames.length === 0 && (
                            <div className="flex items-center justify-center h-full">
                                <div className="text-center glass-panel p-8 max-w-sm">
                                    <Gift size={48} className="mx-auto text-textSecondary opacity-40 mb-4" />
                                    <h3 className="text-lg font-bold text-textPrimary mb-2">
                                        {searchTerm ? 'No Games Found' : 'No Drops Available'}
                                    </h3>
                                    <p className="text-sm text-textSecondary">
                                        {searchTerm
                                            ? `No games match "${searchTerm}"`
                                            : 'There are no active drop campaigns right now. Check back later!'
                                        }
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Game Cards Grid - responsive layout that scales with window size */}
                        {filteredGames.length > 0 && (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 3xl:grid-cols-8 gap-3 sm:gap-4">
                                {filteredGames.map(game => (
                                    <GameCard
                                        key={game.id}
                                        game={game}
                                        allGames={unifiedGames}
                                        progress={progress}
                                        miningStatus={miningStatus}
                                        isSelected={selectedGame?.id === game.id}
                                        onClick={() => setSelectedGame(selectedGame?.id === game.id ? null : game)}
                                        onStopMining={handleStopMining}
                                        onMineAllGame={handleMineAllGame}
                                    />
                                ))}
                            </div>
                        )}

                        {/* Detail Panel */}
                        {selectedGame && (
                            <GameDetailPanel
                                game={selectedGame}
                                allGames={unifiedGames}
                                progress={progress}
                                miningStatus={miningStatus}
                                isOpen={!!selectedGame}
                                onClose={() => setSelectedGame(null)}
                                onStartMining={handleStartMining}
                                onStopMining={handleStopMining}
                                onClaimDrop={handleClaimDrop}
                            />
                        )}
                    </div>
                )}

                {/* Stats Tab */}
                {!isLoading && activeTab === 'stats' && (
                    <DropsStatsTab
                        statistics={statistics ? {
                            ...statistics,
                            // Override with accurate count from inventory data
                            total_drops_claimed: unifiedGames.reduce((sum, game) => sum + game.total_claimed, 0)
                        } : null}
                        miningStatus={miningStatus}
                        onStopMining={handleStopMining}
                        onStreamClick={handleStreamClick}
                    />
                )}

                {/* Inventory Tab */}
                {!isLoading && activeTab === 'inventory' && (
                    <DropsInventoryTab
                        inventoryItems={inventoryItems}
                        progress={progress}
                        onClaimDrop={handleClaimDrop}
                    />
                )}

                {/* Settings Tab */}
                {!isLoading && activeTab === 'settings' && (
                    <DropsSettingsTab
                        settings={dropsSettings}
                        onUpdateSettings={updateDropsSettings}
                        onStartAutoMining={handleStartAutoMining}
                        onStopMining={handleStopMining}
                    />
                )}
            </div>
        </div>
    );
}
