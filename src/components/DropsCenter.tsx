import { useEffect, useState, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useAppStore } from '../stores/AppStore';
import { listen, emit } from '@tauri-apps/api/event';
import { Search, Gift, MonitorPlay, BarChart3, Settings as SettingsIcon, Package } from 'lucide-react';
import {
    UnifiedGame, DropCampaign, DropProgress, DropsStatistics,
    MiningStatus, DropsDeviceCodeInfo, InventoryResponse, InventoryItem, CompletedDrop
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
    favorite_games: string[];  // UI-only, for sorting/tracking - doesn't affect mining
    // Watch token allocation settings
    reserve_token_for_current_stream?: boolean;
    auto_reserve_on_watch?: boolean;
}

export default function DropsCenter() {
    // Data State
    const [unifiedGames, setUnifiedGames] = useState<UnifiedGame[]>([]);
    const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
    const [completedDrops, setCompletedDrops] = useState<CompletedDrop[]>([]);
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
    const [isLoadingGameDetail, setIsLoadingGameDetail] = useState(false);
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

    // Ref for the games container to scroll to top when mining starts
    const gamesContainerRef = useRef<HTMLDivElement>(null);

    // Track the previously mining game to detect when mining starts
    const prevMiningGameRef = useRef<string | null>(null);
    
    // Ref for Mine All queue to access current value in event listeners (avoids stale closure)
    const mineAllQueueRef = useRef(mineAllQueue);
    useEffect(() => {
        mineAllQueueRef.current = mineAllQueue;
    }, [mineAllQueue]);

    // Track previous campaign IDs for notification detection
    const prevCampaignIdsRef = useRef<Set<string>>(new Set());

    // Derived state for filtering AND sorting (favorites first)
    const filteredGames = useMemo(() => {
        const favoriteGames = dropsSettings?.favorite_games || [];
        let games = unifiedGames;
        
        // Apply search filter
        if (searchTerm) {
            const lowerSearch = searchTerm.toLowerCase();
            games = games.filter(game =>
                game.name.toLowerCase().includes(lowerSearch) ||
                game.active_campaigns.some(c => c.name.toLowerCase().includes(lowerSearch))
            );
        }
        
        // Sort: favorites first, then by existing sort order
        return [...games].sort((a, b) => {
            const aIsFavorite = favoriteGames.some(pg => pg.toLowerCase() === a.name.toLowerCase());
            const bIsFavorite = favoriteGames.some(pg => pg.toLowerCase() === b.name.toLowerCase());
            
            // Favorites first
            if (aIsFavorite !== bIsFavorite) return aIsFavorite ? -1 : 1;
            // Mining games next
            if (a.is_mining !== b.is_mining) return a.is_mining ? -1 : 1;
            // Completed games (all drops claimed) go to bottom
            if (a.all_drops_claimed !== b.all_drops_claimed) return a.all_drops_claimed ? 1 : -1;
            // Games with claimable drops next
            if (a.has_claimable !== b.has_claimable) return a.has_claimable ? -1 : 1;
            // Then by number of active campaigns
            if (a.active_campaigns.length !== b.active_campaigns.length) {
                return b.active_campaigns.length - a.active_campaigns.length;
            }
            return a.name.localeCompare(b.name);
        });
    }, [unifiedGames, searchTerm, dropsSettings?.favorite_games]);

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

            // Close the login webview window
            try {
                const loginWindow = await WebviewWindow.getByLabel('drops-login');
                if (loginWindow) {
                    console.log('[DropsCenter] Closing drops-login webview window');
                    await loginWindow.close();
                    console.log('[DropsCenter] Successfully closed drops-login window');
                } else {
                    console.log('[DropsCenter] No drops-login window found to close');
                }
            } catch (closeErr) {
                console.warn('[DropsCenter] Failed to close drops-login window:', closeErr);
            }

            setIsAuthenticated(true);
            setIsAuthenticating(false);
            setDeviceCodeInfo(null);
            addToast('Drops login successful!', 'success');
            await loadDropsData();
        } catch (err) {
            console.error('Failed to complete drops login:', err);
            setError(err instanceof Error ? err.message : String(err));
            setIsAuthenticating(false);
            
            // Also try to close the login window on error
            try {
                const loginWindow = await WebviewWindow.getByLabel('drops-login');
                if (loginWindow) await loginWindow.close();
            } catch { }
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
                priority_mode: 'PriorityOnly' as const,
                watch_interval_seconds: 20,
                favorite_games: [],
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

    // Toggle favorite (add/remove from favorite_games - visual only, doesn't affect mining)
    const handleToggleFavorite = async (gameName: string) => {
        if (!dropsSettings) return;
        
        const currentFavorites = dropsSettings.favorite_games || [];
        const isCurrentlyFavorite = currentFavorites.some(
            pg => pg.toLowerCase() === gameName.toLowerCase()
        );
        
        let newFavoriteGames: string[];
        if (isCurrentlyFavorite) {
            // Remove from favorites
            newFavoriteGames = currentFavorites.filter(
                pg => pg.toLowerCase() !== gameName.toLowerCase()
            );
            addToast(`Removed ${gameName} from favorites`, 'info');
        } else {
            // Add to favorites
            newFavoriteGames = [...currentFavorites, gameName];
            addToast(`Added ${gameName} to favorites ❤️`, 'success');
        }
        
        await updateDropsSettings({ favorite_games: newFavoriteGames });
    };

    // Handle game selection - polls inventory for fresh progress data
    const handleGameSelect = async (game: UnifiedGame | null) => {
        // If deselecting (clicking same game), just close
        if (game === null || (selectedGame && selectedGame.id === game.id)) {
            setSelectedGame(null);
            return;
        }

        // Set loading state and selected game
        setIsLoadingGameDetail(true);
        setSelectedGame(game);

        try {
            console.log('[DropsCenter] Fetching fresh inventory for game:', game.name);
            
            // Poll inventory to get the latest progress data
            const inventoryData = await invoke<InventoryResponse>('get_drops_inventory');
            
            if (inventoryData?.items) {
                console.log('[DropsCenter] Got fresh inventory with', inventoryData.items.length, 'items');
                
                // Update global inventory items state
                setInventoryItems(inventoryData.items);
                
                // Extract progress data from inventory and merge into progress state
                const progressFromInventory: DropProgress[] = [];
                
                inventoryData.items.forEach(item => {
                    item.campaign.time_based_drops.forEach(drop => {
                        if (drop.progress) {
                            progressFromInventory.push({
                                campaign_id: item.campaign.id,
                                drop_id: drop.id,
                                current_minutes_watched: drop.progress.current_minutes_watched,
                                required_minutes_watched: drop.progress.required_minutes_watched,
                                is_claimed: drop.progress.is_claimed,
                                last_updated: drop.progress.last_updated,
                                drop_instance_id: drop.progress.drop_instance_id,
                            });
                        }
                    });
                });
                
                console.log('[DropsCenter] Extracted', progressFromInventory.length, 'progress entries from inventory');
                
                // Merge inventory progress with existing progress (inventory takes priority for matching drops)
                setProgress(prevProgress => {
                    const mergedProgress = [...prevProgress];
                    
                    progressFromInventory.forEach(inventoryProg => {
                        const existingIndex = mergedProgress.findIndex(p => p.drop_id === inventoryProg.drop_id);
                        
                        if (existingIndex >= 0) {
                            // Update existing entry with inventory data (inventory is authoritative)
                            mergedProgress[existingIndex] = {
                                ...mergedProgress[existingIndex],
                                ...inventoryProg,
                            };
                        } else {
                            // Add new entry from inventory
                            mergedProgress.push(inventoryProg);
                        }
                    });
                    
                    console.log('[DropsCenter] Merged progress now has', mergedProgress.length, 'entries');
                    return mergedProgress;
                });
                
                // Update the selected game with fresh inventory items
                const freshInventoryForGame = inventoryData.items.filter(item => {
                    // Match by game name (case-insensitive) or game_id
                    const itemGameName = item.campaign.game_name?.toLowerCase() || '';
                    const gameNameLower = game.name.toLowerCase();
                    return itemGameName === gameNameLower || item.campaign.game_id === game.id;
                });
                
                if (freshInventoryForGame.length > 0) {
                    console.log('[DropsCenter] Found', freshInventoryForGame.length, 'inventory items for game:', game.name);
                    
                    // Update the selected game with fresh inventory
                    setSelectedGame(prevGame => {
                        if (!prevGame) return null;
                        return {
                            ...prevGame,
                            inventory_items: freshInventoryForGame,
                            total_claimed: freshInventoryForGame.reduce((sum, item) => sum + item.claimed_drops, 0),
                        };
                    });
                    
                    // Also update this game in the unifiedGames array
                    setUnifiedGames(prevGames => {
                        return prevGames.map(g => {
                            if (g.id === game.id) {
                                return {
                                    ...g,
                                    inventory_items: freshInventoryForGame,
                                    total_claimed: freshInventoryForGame.reduce((sum, item) => sum + item.claimed_drops, 0),
                                };
                            }
                            return g;
                        });
                    });
                }
            }
        } catch (err) {
            console.error('[DropsCenter] Failed to fetch inventory for game:', err);
            // Don't show error toast - we still show the panel with cached data
        } finally {
            setIsLoadingGameDetail(false);
        }
    };

    // Mine All Game - starts mining all campaigns for a game sequentially
    // Smart start: Skip campaigns that are already fully complete and start from the first incomplete one
    const handleMineAllGame = async (gameName: string, campaignIds: string[]) => {
        if (campaignIds.length === 0) {
            addToast('No campaigns to mine for this game', 'info');
            return;
        }

        console.log(`[DropsCenter] Starting Mine All for ${gameName} with ${campaignIds.length} campaigns`);

        // Find the game to check campaign completion status
        const game = unifiedGames.find(g => g.name.toLowerCase() === gameName.toLowerCase());
        
        // IMPORTANT: Save current progress before any async operations that might clear it
        const currentProgress = [...progress];
        console.log(`[DropsCenter] Saved progress state with ${currentProgress.length} entries`);
        
        // Filter out campaigns that are already fully complete (all drops claimed or 100% watched)
        // and find the first incomplete campaign to start from
        const incompleteCampaignIds: string[] = [];
        
        for (let i = 0; i < campaignIds.length; i++) {
            const campaignId = campaignIds[i];
            const campaign = game?.active_campaigns.find(c => c.id === campaignId);
            
            if (!campaign) {
                // Campaign not found, include it just in case
                console.log(`[DropsCenter] Campaign ID ${campaignId} not found in active_campaigns, including anyway`);
                incompleteCampaignIds.push(campaignId);
                continue;
            }
            
            // Also find the matching inventory item for this campaign (has better progress data)
            const inventoryItem = game?.inventory_items.find(item => 
                item.campaign.id === campaignId || 
                item.campaign.name.toLowerCase() === campaign.name.toLowerCase()
            );
            
            // Get drops from inventory if available (more accurate), otherwise from campaign
            const dropsToCheck = inventoryItem?.campaign.time_based_drops || campaign.time_based_drops;
            
            console.log(`[DropsCenter] Campaign "${campaign.name}": ${dropsToCheck.length} drops to check (from ${inventoryItem ? 'inventory' : 'campaign'})`);
            
            // If no drops, consider it incomplete (we can't determine completion status)
            if (!dropsToCheck || dropsToCheck.length === 0) {
                console.log(`[DropsCenter] Campaign "${campaign.name}" has no drops, assuming incomplete`);
                incompleteCampaignIds.push(campaignId);
                continue;
            }
            
            // Check if all drops in this campaign are complete (100% watched or claimed)
            // We need to check multiple sources for completion:
            // 1. The inventory item's drop progress (most reliable)
            // 2. The campaign's drop progress field
            // 3. The saved progress state array (from real-time updates)
            let allDropsComplete = true;
            
            for (const drop of dropsToCheck) {
                // First check: The drop's own progress field from the API (inventory or campaign)
                const dropOwnProgress = drop.progress;
                
                if (dropOwnProgress?.is_claimed) {
                    console.log(`[DropsCenter] Drop "${drop.name}" is claimed`);
                    continue; // This drop is complete
                }
                
                // Check if 100% complete from drop's own progress
                if (dropOwnProgress) {
                    const isCompleteFromOwn = dropOwnProgress.current_minutes_watched >= dropOwnProgress.required_minutes_watched;
                    if (isCompleteFromOwn) {
                        console.log(`[DropsCenter] Drop "${drop.name}" is 100% complete (${dropOwnProgress.current_minutes_watched}/${dropOwnProgress.required_minutes_watched})`);
                        continue; // This drop is complete
                    }
                    // Has progress but not complete - this drop is incomplete
                    console.log(`[DropsCenter] Drop "${drop.name}" is in progress (${dropOwnProgress.current_minutes_watched}/${dropOwnProgress.required_minutes_watched})`);
                    allDropsComplete = false;
                    break; // Found an incomplete drop, no need to check more
                }
                
                // Second check: The saved progress state array (NOT the current state which may be cleared)
                const progressEntry = currentProgress.find(p => p.drop_id === drop.id);
                if (progressEntry) {
                    const isComplete = progressEntry.current_minutes_watched >= progressEntry.required_minutes_watched;
                    const isClaimed = progressEntry.is_claimed;
                    if (isComplete || isClaimed) {
                        console.log(`[DropsCenter] Drop "${drop.name}" complete from progress array`);
                        continue; // This drop is complete
                    }
                    // Has progress but not complete
                    console.log(`[DropsCenter] Drop "${drop.name}" in progress from array (${progressEntry.current_minutes_watched}/${progressEntry.required_minutes_watched})`);
                    allDropsComplete = false;
                    break; // Found an incomplete drop
                }
                
                // No progress data found at all - assume NOT complete (need to start mining)
                console.log(`[DropsCenter] Drop "${drop.name}" (ID: ${drop.id}) has no progress data, assuming incomplete`);
                allDropsComplete = false;
                break; // Found an incomplete drop
            }
            
            // A campaign is incomplete if any drop is not complete
            if (!allDropsComplete) {
                incompleteCampaignIds.push(campaignId);
                console.log(`[DropsCenter] Campaign "${campaign.name}" is incomplete, including in queue`);
            } else {
                console.log(`[DropsCenter] Campaign "${campaign.name}" is fully complete, skipping`);
            }
        }
        
        // If all campaigns are complete, notify the user
        if (incompleteCampaignIds.length === 0) {
            addToast(`All campaigns for ${gameName} are already complete!`, 'success');
            return;
        }
        
        const skippedCount = campaignIds.length - incompleteCampaignIds.length;
        if (skippedCount > 0) {
            console.log(`[DropsCenter] Skipping ${skippedCount} completed campaigns, starting with ${incompleteCampaignIds.length} remaining`);
        }

        // SMART PRIORITIZATION: Sort incomplete campaigns to prioritize ones with existing progress
        // This ensures we finish drops we've already started before moving to new ones
        const sortedIncompleteCampaignIds = [...incompleteCampaignIds].sort((a, b) => {
            const campaignA = game?.active_campaigns.find(c => c.id === a);
            const campaignB = game?.active_campaigns.find(c => c.id === b);
            
            // Get inventory items for each campaign
            const inventoryA = game?.inventory_items.find(item => 
                item.campaign.id === a || 
                (campaignA && item.campaign.name.toLowerCase() === campaignA.name.toLowerCase())
            );
            const inventoryB = game?.inventory_items.find(item => 
                item.campaign.id === b || 
                (campaignB && item.campaign.name.toLowerCase() === campaignB.name.toLowerCase())
            );
            
            // Calculate progress percentage for each campaign
            const getProgressPercent = (inventoryItem: typeof inventoryA, campaign: typeof campaignA) => {
                const drops = inventoryItem?.campaign.time_based_drops || campaign?.time_based_drops || [];
                if (drops.length === 0) return -1; // No drops = unknown, put last
                
                let totalProgress = 0;
                for (const drop of drops) {
                    const dropProgress = drop.progress;
                    if (dropProgress) {
                        const percent = dropProgress.required_minutes_watched > 0 
                            ? (dropProgress.current_minutes_watched / dropProgress.required_minutes_watched) * 100 
                            : 0;
                        totalProgress += percent;
                    }
                    // Also check the saved progress array
                    const progressEntry = currentProgress.find(p => p.drop_id === drop.id);
                    if (progressEntry) {
                        const percent = progressEntry.required_minutes_watched > 0 
                            ? (progressEntry.current_minutes_watched / progressEntry.required_minutes_watched) * 100 
                            : 0;
                        totalProgress = Math.max(totalProgress, percent);
                    }
                }
                return totalProgress;
            };
            
            const progressA = getProgressPercent(inventoryA, campaignA);
            const progressB = getProgressPercent(inventoryB, campaignB);
            
            // Sort by progress descending (highest progress first)
            // Campaigns with -1 (no drops/unknown) go to the end
            if (progressA === -1 && progressB === -1) return 0;
            if (progressA === -1) return 1; // A goes to end
            if (progressB === -1) return -1; // B goes to end
            return progressB - progressA; // Higher progress first
        });
        
        console.log(`[DropsCenter] Sorted campaign order (by progress):`, sortedIncompleteCampaignIds.map(id => {
            const campaign = game?.active_campaigns.find(c => c.id === id);
            return campaign?.name || id;
        }));

        // Stop any current mining first (AFTER checking completion status)
        if (miningStatus?.is_mining) {
            // Use a simpler stop that doesn't clear progress
            try {
                await invoke('stop_auto_mining');
            } catch (err) {
                console.error('Failed to stop mining:', err);
            }
            // Wait a moment for the stop to take effect
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Set up the mine all queue with sorted campaigns (highest progress first)
        setMineAllQueue({
            gameName,
            campaignIds: sortedIncompleteCampaignIds,
            currentIndex: 0
        });

        // Start mining the first campaign (the one with highest progress)
        try {
            if (dropsSettings?.auto_mining_enabled) {
                await updateDropsSettings({ auto_mining_enabled: false });
            }

            await invoke('start_campaign_mining', { campaignId: sortedIncompleteCampaignIds[0] });
            
            // Show appropriate message
            if (skippedCount > 0) {
                addToast(`Mining ${incompleteCampaignIds.length} remaining campaigns for ${gameName} (${skippedCount} already complete)`, 'success');
            } else {
                addToast(`Mining all ${incompleteCampaignIds.length} campaigns for ${gameName}`, 'success');
            }
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

            // IMPORTANT:
            // `get_active_drop_campaigns` is responsible for refreshing the backend's internal
            // drop progress map (via `DropsService::update_campaigns_and_progress`).
            // If we fetch `get_drop_progress` in parallel, it can race and return an empty
            // list, which makes the UI show 0 minutes for everything.
            //
            // So: fetch campaigns first, then fetch progress.
            const [campaignsData, statsData, inventoryData, currentMiningStatus] = await Promise.all([
                invoke<DropCampaign[]>('get_active_drop_campaigns').catch(() => [] as DropCampaign[]),
                invoke<DropsStatistics>('get_drops_statistics').catch(() => null),
                invoke<InventoryResponse>('get_drops_inventory').catch(() => null),
                invoke<MiningStatus>('get_mining_status').catch(() => null),
            ]);

            const progressData = await invoke<DropProgress[]>('get_drop_progress').catch(() => [] as DropProgress[]);

            // Update mining status state if we got a fresh one
            if (currentMiningStatus) {
                setMiningStatus(currentMiningStatus);
            }

            if (progressData) setProgress(progressData);
            if (statsData) setStatistics(statsData);
            if (inventoryData?.items) setInventoryItems(inventoryData.items);
            if (inventoryData?.completed_drops) {
                console.log(`[DropsCenter] Found ${inventoryData.completed_drops.length} completed drops`);
                setCompletedDrops(inventoryData.completed_drops);
            }

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
                        has_claimable: false,
                        all_drops_claimed: false
                    };
                    gamesMap.set(id, game);
                }
                return game;
            };

            // Process Active Campaigns and merge progress data from inventory
            if (campaignsData) {
                campaignsData.forEach(campaign => {
                    const game = getOrCreateGame(campaign.game_id, campaign.game_name, campaign.image_url);
                    
                    // IMPORTANT: Merge progress data into each drop BEFORE adding to game
                    // This ensures the campaign's time_based_drops have accurate progress
                    const campaignWithProgress = {
                        ...campaign,
                        time_based_drops: campaign.time_based_drops.map(drop => {
                            // Find progress from progressData (real-time updates)
                            const prog = progressData?.find(p => p.drop_id === drop.id);
                            
                            // If no progress in progressData, check inventory items
                            let inventoryProgress = null;
                            if (!prog && inventoryData?.items) {
                                // Find matching inventory item for this campaign
                                const inventoryItem = inventoryData.items.find(item => 
                                    item.campaign.id === campaign.id ||
                                    item.campaign.name === campaign.name
                                );
                                if (inventoryItem) {
                                    const inventoryDrop = inventoryItem.campaign.time_based_drops.find(d => d.id === drop.id);
                                    inventoryProgress = inventoryDrop?.progress;
                                }
                            }
                            
                            // Use whichever progress source is available
                            const progressToUse = prog || inventoryProgress;
                            
                            return {
                                ...drop,
                                progress: progressToUse || drop.progress // Keep existing or use merged
                            };
                        })
                    };
                    
                    game.active_campaigns.push(campaignWithProgress);
                    game.total_active_drops += campaign.time_based_drops.length;

                    // Update game stats based on merged progress
                    campaignWithProgress.time_based_drops.forEach(drop => {
                        const prog = progressData?.find(p => p.drop_id === drop.id) || drop.progress;
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

            // Get the current mining game name (case-insensitive) - use freshly fetched status
            const activeMiningStatus = currentMiningStatus || miningStatus;
            const miningGameName = activeMiningStatus?.current_drop?.game_name?.toLowerCase() ||
                activeMiningStatus?.current_channel?.game_name?.toLowerCase();

            // Update is_mining flag and calculate all_drops_claimed for each game
            gamesMap.forEach(game => {
                if (activeMiningStatus?.is_mining && miningGameName) {
                    game.is_mining = game.name.toLowerCase() === miningGameName;
                }

                // Check if all drops in all active campaigns have been claimed
                if (game.active_campaigns.length > 0 && game.total_active_drops > 0) {
                    let totalDropsInCampaigns = 0;
                    let claimedDropsCount = 0;

                    game.active_campaigns.forEach(campaign => {
                        campaign.time_based_drops.forEach(drop => {
                            totalDropsInCampaigns++;
                            const prog = progressData?.find(p => p.drop_id === drop.id);
                            if (prog?.is_claimed) {
                                claimedDropsCount++;
                            }
                        });
                    });

                    // All drops claimed if we have drops and all are claimed.
                    // Prefer embedded per-drop progress (campaign.time_based_drops[].progress) as a fallback,
                    // because `progressData` can be empty before the backend progress map is populated.
                    // Prefer progressData, but also fall back to embedded drop.progress (from CampaignDetails)
                    // to avoid false negatives when progressData isn't populated yet.
                    game.all_drops_claimed = totalDropsInCampaigns > 0 && claimedDropsCount === totalDropsInCampaigns;
                }
            });

            setUnifiedGames(Array.from(gamesMap.values()).sort((a, b) => {
                // Mining games first
                if (a.is_mining !== b.is_mining) return a.is_mining ? -1 : 1;
                // Completed games (all drops claimed) go to bottom
                if (a.all_drops_claimed !== b.all_drops_claimed) return a.all_drops_claimed ? 1 : -1;
                // Games with claimable drops next
                if (a.has_claimable !== b.has_claimable) return a.has_claimable ? -1 : 1;
                // Then by number of active campaigns
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

    // ---- Favorite Drops Notification Logic ----
    // Check if any favorited categories have new drops since last session
    const FAVORITE_CAMPAIGNS_CACHE_KEY = 'streamnook_favorite_campaigns_cache';
    
    const checkForNewFavoriteDrops = () => {
        // Get app settings to check if notification is enabled
        const appSettings = useAppStore.getState().settings;
        if (!appSettings.live_notifications?.show_favorite_drops_notifications) {
            console.log('[DropsCenter] Favorite drops notifications disabled');
            return;
        }
        
        // Get current favorite games
        const favoriteGames = dropsSettings?.favorite_games || [];
        if (favoriteGames.length === 0) {
            console.log('[DropsCenter] No favorited games, skipping new drops check');
            return;
        }
        
        console.log('[DropsCenter] Checking for new drops in favorited games:', favoriteGames);
        
        // Get previously cached campaign data
        let cachedData: Record<string, string[]> = {};
        try {
            const cached = localStorage.getItem(FAVORITE_CAMPAIGNS_CACHE_KEY);
            if (cached) {
                cachedData = JSON.parse(cached);
            }
        } catch (e) {
            console.warn('[DropsCenter] Failed to parse cached campaign data:', e);
        }
        
        // Build current campaign map for favorited games
        const currentCampaignMap: Record<string, { campaignIds: string[]; gameName: string; boxArt: string }> = {};
        
        unifiedGames.forEach(game => {
            const isFavorite = favoriteGames.some(
                pg => pg.toLowerCase() === game.name.toLowerCase()
            );
            if (!isFavorite) return;
            
            currentCampaignMap[game.name.toLowerCase()] = {
                campaignIds: game.active_campaigns.map(c => c.id),
                gameName: game.name,
                boxArt: game.box_art_url
            };
        });
        
        // Find new campaigns in favorited games
        const newDropNotifications: { gameName: string; boxArt: string; newCount: number; campaignNames: string[] }[] = [];
        
        Object.entries(currentCampaignMap).forEach(([gameKey, data]) => {
            const previousCampaignIds = cachedData[gameKey] || [];
            const newCampaignIds = data.campaignIds.filter(id => !previousCampaignIds.includes(id));
            
            if (newCampaignIds.length > 0) {
                // Find campaign names for the new campaigns
                const game = unifiedGames.find(g => g.name.toLowerCase() === gameKey);
                const campaignNames = game?.active_campaigns
                    .filter(c => newCampaignIds.includes(c.id))
                    .map(c => c.name) || [];
                
                newDropNotifications.push({
                    gameName: data.gameName,
                    boxArt: data.boxArt,
                    newCount: newCampaignIds.length,
                    campaignNames
                });
            }
        });
        
        // Emit notifications for each game with new drops
        newDropNotifications.forEach(({ gameName, boxArt, newCount, campaignNames }) => {
            console.log(`[DropsCenter] New drops available for ${gameName}:`, campaignNames);
            
            emit('new-favorite-drops', {
                game_name: gameName,
                game_image: boxArt,
                new_count: newCount,
                campaign_names: campaignNames
            });
        });
        
        // Update cache with current campaign IDs
        const newCacheData: Record<string, string[]> = {};
        Object.entries(currentCampaignMap).forEach(([gameKey, data]) => {
            newCacheData[gameKey] = data.campaignIds;
        });
        
        try {
            localStorage.setItem(FAVORITE_CAMPAIGNS_CACHE_KEY, JSON.stringify(newCacheData));
        } catch (e) {
            console.warn('[DropsCenter] Failed to save campaign cache:', e);
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
                
                // Check for new drops in favorited categories on startup
                checkForNewFavoriteDrops();
            } else {
                setIsLoading(false);
            }
        };
        init();

        // Listeners
        let unlistenStatus: (() => void) | undefined;
        let unlistenProgress: (() => void) | undefined;
        let unlistenComplete: (() => void) | undefined;
        let unlistenNoChannels: (() => void) | undefined;

        const setupListeners = async () => {
            unlistenStatus = await listen<MiningStatus>('mining-status-update', (event) => {
                console.log('[DropsCenter] Mining status update:', event.payload);
                setMiningStatus(event.payload);
                
                // Update AppStore's isMiningActive based on the status
                useAppStore.getState().setMiningActive(event.payload.is_mining);
            });
            
            // Listen for mining complete events (drop reached 100%)
            // This handles all 3 mining modes:
            // 1. Single Campaign Mining - stop completely
            // 2. Mine All Game - check if there are more campaigns in queue, start next if so
            // 3. Auto-Mining - handled by backend's start_mining (doesn't use this event)
            unlistenComplete = await listen<{ game_name: string; reason: string }>('mining-complete', async (event) => {
                console.log('[DropsCenter] Mining complete:', event.payload);
                
                // Check if we're in a Mine All queue (use ref to get current value, not stale closure)
                const currentQueue = mineAllQueueRef.current;
                
                if (currentQueue) {
                    // Mine All Game mode - check if there are more campaigns
                    const nextIndex = currentQueue.currentIndex + 1;
                    
                    if (nextIndex < currentQueue.campaignIds.length) {
                        // More campaigns to mine - start the next one
                        console.log(`[DropsCenter] Mine All: Starting campaign ${nextIndex + 1}/${currentQueue.campaignIds.length}`);
                        
                        // Update queue index
                        setMineAllQueue(prev => prev ? { ...prev, currentIndex: nextIndex } : null);
                        
                        try {
                            await invoke('start_campaign_mining', { campaignId: currentQueue.campaignIds[nextIndex] });
                            addToast(`✅ Campaign complete! Mining ${nextIndex + 1} of ${currentQueue.campaignIds.length}...`, 'info');
                        } catch (err) {
                            console.error('[DropsCenter] Failed to start next campaign:', err);
                            addToast('Failed to start next campaign', 'error');
                            setMineAllQueue(null);
                            useAppStore.getState().setMiningActive(false);
                        }
                    } else {
                        // All campaigns in queue complete - Mine All Game is done
                        console.log(`[DropsCenter] Mine All complete for ${currentQueue.gameName}`);
                        addToast(`🎉 All campaigns for ${event.payload.game_name} complete!`, 'success');
                        setMineAllQueue(null);
                        useAppStore.getState().setMiningActive(false);
                    }
                } else {
                    // Single Campaign Mining mode - stop completely
                    console.log('[DropsCenter] Single campaign complete - stopping');
                    addToast(`✅ Drops complete for ${event.payload.game_name}!`, 'success');
                    useAppStore.getState().setMiningActive(false);
                }
                
                // Refresh data to show updated progress
                loadDropsData();
            });

            // Listen for mining stopped due to no channels available (all streams offline)
            unlistenNoChannels = await listen<{ reason: string }>('mining-stopped-no-channels', async (event) => {
                console.log('[DropsCenter] Mining stopped - no channels:', event.payload);
                
                // Check if we're in a Mine All queue
                const currentQueue = mineAllQueueRef.current;
                
                if (currentQueue) {
                    // Try to advance to next campaign in queue
                    const nextIndex = currentQueue.currentIndex + 1;
                    
                    if (nextIndex < currentQueue.campaignIds.length) {
                        console.log(`[DropsCenter] Channels offline - trying next campaign ${nextIndex + 1}/${currentQueue.campaignIds.length}`);
                        addToast(`⚠️ All streams offline - trying next campaign...`, 'warning');
                        
                        setMineAllQueue(prev => prev ? { ...prev, currentIndex: nextIndex } : null);
                        
                        // Start the next campaign after a brief delay
                        setTimeout(async () => {
                            try {
                                await invoke('start_campaign_mining', { campaignId: currentQueue.campaignIds[nextIndex] });
                            } catch (err) {
                                console.error('[DropsCenter] Failed to start next campaign:', err);
                                addToast('Failed to start next campaign', 'error');
                                setMineAllQueue(null);
                                useAppStore.getState().setMiningActive(false);
                            }
                        }, 2000);
                    } else {
                        // All campaigns tried - queue exhausted
                        addToast('⚠️ All campaigns have no available streams', 'warning');
                        setMineAllQueue(null);
                        useAppStore.getState().setMiningActive(false);
                    }
                } else {
                    // Single campaign mode - just notify and stop
                    addToast(`⚠️ ${event.payload.reason || 'All streams offline - mining stopped'}`, 'warning');
                    useAppStore.getState().setMiningActive(false);
                }
                
                // Refresh data
                loadDropsData();
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
            if (unlistenComplete) unlistenComplete();
            if (unlistenNoChannels) unlistenNoChannels();
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

        // Detect if mining just started for a new game (to trigger scroll)
        const currentMiningGame = miningStatus.is_mining && miningGameName ? miningGameName : null;
        const prevMiningGame = prevMiningGameRef.current;

        // If a new game started mining (different from previous), scroll to top
        if (currentMiningGame && currentMiningGame !== prevMiningGame) {
            console.log('[DropsCenter] New mining game detected, scrolling to top:', currentMiningGame);
            // Small delay to allow the list to re-sort first
            setTimeout(() => {
                if (gamesContainerRef.current) {
                    gamesContainerRef.current.scrollTo({
                        top: 0,
                        behavior: 'smooth'
                    });
                }
            }, 100);
        }

        // Update the ref for next comparison
        prevMiningGameRef.current = currentMiningGame;

        setUnifiedGames(prevGames => {
            const updated = prevGames.map(game => ({
                ...game,
                is_mining: miningStatus.is_mining && miningGameName
                    ? game.name.toLowerCase() === miningGameName
                    : false
            }));

            // Re-sort with full sorting logic
            return updated.sort((a, b) => {
                // Mining games first
                if (a.is_mining !== b.is_mining) return a.is_mining ? -1 : 1;
                // Completed games (all drops claimed) go to bottom
                if (a.all_drops_claimed !== b.all_drops_claimed) return a.all_drops_claimed ? 1 : -1;
                // Games with claimable drops next
                if (a.has_claimable !== b.has_claimable) return a.has_claimable ? -1 : 1;
                // Then by number of active campaigns
                if (a.active_campaigns.length !== b.active_campaigns.length) {
                    return b.active_campaigns.length - a.active_campaigns.length;
                }
                return a.name.localeCompare(b.name);
            });
        });
    }, [miningStatus]);

    // Notification effect: Detect new campaigns from favorite games
    useEffect(() => {
        if (!dropsSettings || unifiedGames.length === 0) return;
        
        const favoriteGames = dropsSettings.favorite_games || [];
        if (favoriteGames.length === 0) return; // No favorites, skip
        
        // Build current campaign IDs set
        const currentCampaignIds = new Set<string>();
        const newFavoriteCampaigns: { gameName: string; campaignName: string }[] = [];
        
        unifiedGames.forEach(game => {
            const isFavorite = favoriteGames.some(
                pg => pg.toLowerCase() === game.name.toLowerCase()
            );
            
            game.active_campaigns.forEach(campaign => {
                currentCampaignIds.add(campaign.id);
                
                // Check if this is a NEW campaign from a favorite game
                if (isFavorite && !prevCampaignIdsRef.current.has(campaign.id)) {
                    // Only notify if we have previous data (not first load)
                    if (prevCampaignIdsRef.current.size > 0) {
                        newFavoriteCampaigns.push({
                            gameName: game.name,
                            campaignName: campaign.name
                        });
                    }
                }
            });
        });
        
        // Send notifications for new favorite campaigns
        if (newFavoriteCampaigns.length > 0 && dropsSettings.notify_on_drop_available) {
            newFavoriteCampaigns.forEach(({ gameName, campaignName }) => {
                addToast(`🎁 New drop for ${gameName}: ${campaignName}`, 'success');
                console.log(`[DropsCenter] New favorite campaign notification: ${gameName} - ${campaignName}`);
            });
        }
        
        // Update the ref for next comparison
        prevCampaignIdsRef.current = currentCampaignIds;
    }, [unifiedGames, dropsSettings, addToast]);

    // ---- Render: Authentication Screen ----
    if (!isAuthenticated) {
        return (
            <div className="relative flex flex-col items-center justify-center h-full overflow-hidden">
                {/* Background blur effect with subtle pattern */}
                <div className="absolute inset-0 bg-gradient-to-br from-background via-backgroundSecondary to-background opacity-90" />
                
                {/* Decorative elements - faded gift icons scattered */}
                <div className="absolute inset-0 overflow-hidden pointer-events-none">
                    <Gift className="absolute top-[10%] left-[15%] w-12 h-12 text-accent/5 rotate-12" />
                    <Gift className="absolute top-[25%] right-[20%] w-8 h-8 text-accent/5 -rotate-6" />
                    <Gift className="absolute bottom-[30%] left-[25%] w-10 h-10 text-accent/5 rotate-[-15deg]" />
                    <Gift className="absolute bottom-[15%] right-[15%] w-14 h-14 text-accent/5 rotate-6" />
                    <Gift className="absolute top-[60%] left-[10%] w-6 h-6 text-accent/5 rotate-45" />
                    <Gift className="absolute top-[40%] right-[10%] w-16 h-16 text-accent/5 -rotate-12" />
                </div>

                {/* Main content card */}
                <div className="relative z-10 animate-in fade-in zoom-in-95 duration-500">
                    <div className="glass-panel border border-accent/20 rounded-2xl p-10 max-w-lg mx-4 text-center shadow-2xl shadow-accent/10">
                        {/* Icon with glow effect */}
                        <div className="flex justify-center mb-6">
                            <div className="relative">
                                <div className="absolute inset-0 bg-accent/30 rounded-full blur-xl animate-pulse" />
                                <div className="relative p-5 bg-gradient-to-br from-accent/20 to-accent/5 rounded-full border border-accent/30">
                                    <Gift className="w-14 h-14 text-accent" />
                                </div>
                            </div>
                        </div>

                        {/* Title & Description */}
                        <div className="space-y-3 mb-8">
                            <h2 className="text-3xl font-bold text-textPrimary">Drops Center</h2>
                            <p className="text-textSecondary text-base leading-relaxed">
                                Connect your Twitch account to unlock automatic drop mining, campaign tracking, and reward collection.
                            </p>
                        </div>

                        {/* Features preview - what users get */}
                        <div className="grid grid-cols-3 gap-4 mb-8 py-4 border-y border-borderLight/50">
                            <div className="text-center">
                                <div className="text-accent font-semibold text-lg">Auto</div>
                                <div className="text-textSecondary text-xs">Mining</div>
                            </div>
                            <div className="text-center border-x border-borderLight/50">
                                <div className="text-accent font-semibold text-lg">Track</div>
                                <div className="text-textSecondary text-xs">Progress</div>
                            </div>
                            <div className="text-center">
                                <div className="text-accent font-semibold text-lg">Claim</div>
                                <div className="text-textSecondary text-xs">Rewards</div>
                            </div>
                        </div>

                        {/* Device Code Display (when authenticating) */}
                        {isAuthenticating && deviceCodeInfo && (
                            <div className="mb-6 p-6 bg-accent/5 rounded-xl border border-accent/30 animate-in fade-in slide-in-from-bottom-2 duration-300">
                                <p className="text-xs text-textSecondary uppercase tracking-wider mb-3">Enter this code on Twitch</p>
                                <div className="text-4xl font-mono font-bold text-accent tracking-[0.3em] py-2 select-all">
                                    {deviceCodeInfo.user_code}
                                </div>
                                <div className="flex items-center justify-center gap-2 mt-4 text-textSecondary text-sm">
                                    <div className="w-2 h-2 bg-accent rounded-full animate-pulse" />
                                    <span>Waiting for authorization...</span>
                                </div>
                            </div>
                        )}

                        {/* Login Button */}
                        {!isAuthenticating && (
                            <button
                                onClick={startDropsLogin}
                                className="w-full px-8 py-4 bg-[#9146FF] hover:bg-[#7c3aed] text-white rounded-xl transition-all duration-200 font-semibold flex items-center justify-center gap-3 shadow-lg shadow-[#9146FF]/25 hover:shadow-[#9146FF]/40 hover:scale-[1.02] active:scale-[0.98]"
                            >
                                <TwitchIcon size={22} />
                                <span className="text-base">Connect with Twitch</span>
                            </button>
                        )}

                        {/* Info note */}
                        <p className="mt-6 text-xs text-textSecondary/70">
                            Uses Twitch's Android app authentication for drop compatibility
                        </p>
                    </div>
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
                    <div ref={gamesContainerRef} className="h-full overflow-y-auto p-4 custom-scrollbar">
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
                                        isFavorite={(dropsSettings?.favorite_games || []).some(
                                            pg => pg.toLowerCase() === game.name.toLowerCase()
                                        )}
                                        onClick={() => handleGameSelect(selectedGame?.id === game.id ? null : game)}
                                        onStopMining={handleStopMining}
                                        onMineAllGame={handleMineAllGame}
                                        onToggleFavorite={handleToggleFavorite}
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
                                completedDrops={completedDrops}
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
                        completedDrops={completedDrops}
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
