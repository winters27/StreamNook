import { useEffect, useState, useMemo, useRef } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useAppStore } from '../stores/AppStore';
import { listen, emit } from '@tauri-apps/api/event';
import { Search, Gift, MonitorPlay, BarChart3, Settings as SettingsIcon, Package, ArrowDownUp } from 'lucide-react';
import { Dropdown } from './ui/Dropdown';
import {
    UnifiedGame, DropCampaign, DropProgress, DropsStatistics,
    MiningStatus, MiningChannel, CurrentDropInfo, DropsDeviceCodeInfo, InventoryResponse, InventoryItem, CompletedDrop
} from '../types';

// Shape the drops mining plugin pushes into its status slot (see HOOKS.md).
interface DropsStatusValue {
    active?: boolean;
    is_mining?: boolean;
    game_name?: string | null;
    campaign_id?: string | null;
    channel_login?: string | null;
    current_minutes?: number | null;
    required_minutes?: number | null;
}
import LoadingWidget from './LoadingWidget';
import GameCard from './drops/GameCard';
import GameDetailPanel from './drops/GameDetailPanel';
import DropsStatsTab from './drops/DropsStatsTab';
import DropsSettingsTab from './drops/DropsSettingsTab';
import DropsInventoryTab from './drops/DropsInventoryTab';
import ChannelPickerModal from './drops/ChannelPickerModal';
import { getAllUserBadgesWithEarned } from '../services/badgeService';
import { Tooltip } from './ui/Tooltip';

import { Logger } from '../utils/logger';
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
    priority_farm_channels?: Array<{ channel_id: string; channel_login: string; display_name: string }>;
}

export default function DropsCenter() {
    // Data State
    const [unifiedGames, setUnifiedGames] = useState<UnifiedGame[]>([]);
    const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
    const [completedDrops, setCompletedDrops] = useState<CompletedDrop[]>([]);
    const [statistics, setStatistics] = useState<DropsStatistics | null>(null);
    const [progress, setProgress] = useState<DropProgress[]>([]);
    const [, setEarnedBadgeIds] = useState<Set<string>>(new Set());
    const [earnedBadgeTitles, setEarnedBadgeTitles] = useState<Set<string>>(new Set());
    const [isLoading, setIsLoading] = useState(true);
    const [, setError] = useState<string | null>(null);

    // Auth State
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [isAuthenticating, setIsAuthenticating] = useState(false);
    const [deviceCodeInfo, setDeviceCodeInfo] = useState<DropsDeviceCodeInfo | null>(null);

    // Mining State
    const [miningStatus, setMiningStatus] = useState<MiningStatus | null>(null);
    // Id of a plugin that provides drops mining, or null. When set, the
    // cockpit's mine controls drive the plugin through the general hooks
    // instead of the built-in miner. Core never names the plugin.
    const [pluginMiningId, setPluginMiningId] = useState<string | null>(null);
    const pluginMiningRef = useRef<string | null>(null);

    // UI State
    const [activeTab, setActiveTab] = useState<Tab>('games');
    const [searchTerm, setSearchTerm] = useState('');
    // Game grid sort: 'recommended' = relevance order, 'newest'/'oldest' = by most-recent campaign release.
    const [sortMode, setSortMode] = useState<'recommended' | 'newest' | 'oldest'>('recommended');
    const [selectedGame, setSelectedGame] = useState<UnifiedGame | null>(null);
    const [, setIsLoadingGameDetail] = useState(false);
    const { addToast, setShowDropsOverlay, currentUser, dropsSearchTerm, setDropsSearchTerm } = useAppStore();
    


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
        
        // A game's "release recency" = the most recent campaign start among its
        // active campaigns (newest campaign to come out for that game).
        const releaseTime = (g: UnifiedGame) => {
            let t = 0;
            for (const c of g.active_campaigns) {
                const ms = Date.parse(c.start_at);
                if (!Number.isNaN(ms) && ms > t) t = ms;
            }
            return t;
        };

        // Sort: still-mineable favorites pinned first, then by the selected sort mode.
        return [...games].sort((a, b) => {
            // A favorite that's fully claimed is "done", so it drops out of the top
            // pin and sinks to the bottom with the other completed games.
            const aIsFavorite = favoriteGames.some(pg => pg.toLowerCase() === a.name.toLowerCase()) && !a.all_drops_claimed;
            const bIsFavorite = favoriteGames.some(pg => pg.toLowerCase() === b.name.toLowerCase()) && !b.all_drops_claimed;

            // Active favorites first
            if (aIsFavorite !== bIsFavorite) return aIsFavorite ? -1 : 1;

            // Explicit date sort: newest or oldest by most-recent campaign release.
            if (sortMode === 'newest' || sortMode === 'oldest') {
                const diff = releaseTime(b) - releaseTime(a); // newest-first baseline
                if (diff !== 0) return sortMode === 'newest' ? diff : -diff;
                return a.name.localeCompare(b.name);
            }

            // Recommended (default) relevance order:
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
    }, [unifiedGames, searchTerm, dropsSettings?.favorite_games, sortMode]);

    // Fetch earned badges on mount for badge drop ownership verification
    useEffect(() => {
        const fetchEarnedBadges = async () => {
            if (!currentUser?.user_id || !currentUser?.login) return;
            
            try {
                Logger.debug('[DropsCenter] Fetching earned badges for user:', currentUser.login);
                const badges = await getAllUserBadgesWithEarned(
                    currentUser.user_id,
                    currentUser.login,
                    currentUser.user_id, // Use user's own channel ID
                    currentUser.login // Use user's own channel name
                );
                
                // Extract earned badge IDs from the flat badge structure
                const earnedIds = new Set<string>();
                const badgeTitles = new Set<string>();
                badges.earnedBadges?.forEach((badge) => {
                    if (badge.id) earnedIds.add(badge.id);
                    if (badge.title) badgeTitles.add(badge.title.toLowerCase());
                });
                // Also include third-party badges
                badges.thirdPartyBadges?.forEach((badge) => {
                    if (badge.id) earnedIds.add(badge.id);
                    if (badge.title) badgeTitles.add(badge.title.toLowerCase());
                });
                
                setEarnedBadgeIds(earnedIds);
                setEarnedBadgeTitles(badgeTitles);
                Logger.debug('[DropsCenter] Loaded earned badge IDs:', earnedIds.size);
                Logger.debug('[DropsCenter] Loaded earned badge titles:', badgeTitles.size);
                Logger.debug('[DropsCenter] Sample badge titles:', Array.from(badgeTitles).slice(0, 5));
            } catch (err) {
                Logger.error('[DropsCenter] Failed to fetch earned badges:', err);
            }
        };
        
        fetchEarnedBadges();
    }, [currentUser?.user_id, currentUser?.login]);

    // ---- Authentication Logic ----
    const checkAuthentication = async () => {
        try {
            const authenticated = await invoke<boolean>('is_drops_authenticated');
            setIsAuthenticated(authenticated);
            return authenticated;
        } catch (err) {
            Logger.error('Failed to check drops authentication:', err);
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
            Logger.error('Failed to start drops login:', err);
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
                    Logger.debug('[DropsCenter] Closing drops-login webview window');
                    await loginWindow.close();
                    Logger.debug('[DropsCenter] Successfully closed drops-login window');
                } else {
                    Logger.debug('[DropsCenter] No drops-login window found to close');
                }
            } catch (closeErr) {
                Logger.warn('[DropsCenter] Failed to close drops-login window:', closeErr);
            }

            setIsAuthenticated(true);
            setIsAuthenticating(false);
            setDeviceCodeInfo(null);
            addToast('Drops login successful!', 'success');
            await loadDropsData();
        } catch (err) {
            Logger.error('Failed to complete drops login:', err);
            setError(err instanceof Error ? err.message : String(err));
            setIsAuthenticating(false);
            
            // Also try to close the login window on error
            try {
                const loginWindow = await WebviewWindow.getByLabel('drops-login');
                if (loginWindow) await loginWindow.close();
            } catch { /* Window may not exist */ }
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
            Logger.error('Failed to logout from drops:', err);
        }
    };

    // ---- Action Handlers ----
    const handleClaimDrop = async (dropId: string, dropInstanceId?: string) => {
        try {
            Logger.debug('[DropsCenter] Claiming drop:', dropId, 'with dropInstanceId:', dropInstanceId);
            await invoke('claim_drop', { dropId, dropInstanceId });
            addToast('Drop claimed successfully!', 'success');

            // Mark the drop claimed locally for instant feedback.
            const nextProgress = progress.map(p =>
                p.drop_id === dropId ? { ...p, is_claimed: true } : p
            );
            setProgress(nextProgress);

            // A claim only moves a reward into your inventory. It does NOT change the
            // active campaigns or the live mining-progress cache, so we deliberately
            // skip the full loadDropsData() reload here. That reload would blank the
            // panel behind a spinner AND re-fetch campaigns, which clears the backend's
            // live progress map and makes the title-bar mining progress snap backwards
            // until it slowly re-accumulates. Instead: refresh only the inventory
            // (silently) and patch the claimed game's flags in place.
            const inventoryData = await invoke<InventoryResponse>('get_drops_inventory').catch(() => null);
            if (inventoryData?.items) setInventoryItems(inventoryData.items);
            if (inventoryData?.completed_drops) setCompletedDrops(inventoryData.completed_drops);

            // Owned-reward sets from the freshly fetched inventory, matching how the
            // full rebuild decides ownership: a reward counts as earned by its claim
            // flag, by drop id, or by benefit id/name.
            const ownedBenefitIds = new Set<string>((inventoryData?.completed_drops || []).map(d => d.id));
            const ownedBenefitNames = new Set<string>(
                (inventoryData?.completed_drops || []).map(d => (d.name || '').toLowerCase().trim()).filter(Boolean)
            );
            const ownedDropIds = new Set<string>();
            inventoryData?.items?.forEach(item => {
                item.campaign.time_based_drops.forEach(drop => {
                    if (drop.progress?.is_claimed === true) ownedDropIds.add(drop.id);
                });
            });

            const gameOwnsDrop = (game: UnifiedGame) =>
                game.active_campaigns.some(c => c.time_based_drops.some(d => d.id === dropId));

            const recomputeGame = (game: UnifiedGame): UnifiedGame => {
                let hasClaimable = false;
                let totalDrops = 0;
                let claimedCount = 0;
                game.active_campaigns.forEach(campaign => {
                    campaign.time_based_drops.forEach(drop => {
                        totalDrops++;
                        const dp = nextProgress.find(p => p.drop_id === drop.id) || drop.progress;
                        const hasCurrentProgress = !!dp && ((dp.current_minutes_watched || 0) > 0 || dp.is_claimed === true);
                        const owned = dp?.is_claimed === true
                            || (!hasCurrentProgress && (
                                ownedDropIds.has(drop.id)
                                || (drop.benefit_edges?.some(b =>
                                    ownedBenefitIds.has(b.id) ||
                                    (!!b.name && ownedBenefitNames.has(b.name.toLowerCase().trim()))
                                ) ?? false)
                            ));
                        if (owned) {
                            claimedCount++;
                        } else if (dp && dp.required_minutes_watched > 0 && dp.current_minutes_watched >= dp.required_minutes_watched) {
                            hasClaimable = true;
                        }
                    });
                });
                const freshClaimed = inventoryData?.items
                    ? inventoryData.items
                        .filter(it => it.campaign.game_id === game.id)
                        .reduce((sum, it) => sum + it.claimed_drops, 0)
                    : game.total_claimed;
                return {
                    ...game,
                    has_claimable: hasClaimable,
                    all_drops_claimed: totalDrops > 0 && claimedCount === totalDrops,
                    total_claimed: freshClaimed,
                };
            };

            // Re-sort with the same ordering loadDropsData uses, so a now fully-claimed
            // game sinks to the bottom without a reload.
            const sortGames = (a: UnifiedGame, b: UnifiedGame) => {
                if (a.is_mining !== b.is_mining) return a.is_mining ? -1 : 1;
                if (a.all_drops_claimed !== b.all_drops_claimed) return a.all_drops_claimed ? 1 : -1;
                if (a.has_claimable !== b.has_claimable) return a.has_claimable ? -1 : 1;
                if (a.active_campaigns.length !== b.active_campaigns.length) {
                    return b.active_campaigns.length - a.active_campaigns.length;
                }
                return a.name.localeCompare(b.name);
            };

            setUnifiedGames(prev =>
                prev.map(g => (gameOwnsDrop(g) ? recomputeGame(g) : g)).sort(sortGames)
            );
            setSelectedGame(prev => (prev && gameOwnsDrop(prev) ? recomputeGame(prev) : prev));
        } catch (err) {
            Logger.error('Failed to claim drop:', err);
            addToast('Failed to claim drop', 'error');
        }
    };

    // ---- Plugin-backed mining routing ----
    // Keep the ref in step with the state so the once-set status listener
    // reads the current provider.
    useEffect(() => {
        pluginMiningRef.current = pluginMiningId;
    }, [pluginMiningId]);

    // Track which plugin (if any) provides drops mining, and translate its
    // status pushes into the mining-status shape the cockpit already renders.
    useEffect(() => {
        let disposed = false;
        const refreshProvider = async () => {
            try {
                const id = await invoke<string | null>('plugins_provides', { feature: 'drops.mining' });
                if (!disposed) setPluginMiningId(id ?? null);
            } catch { /* plugin host unavailable */ }
        };
        refreshProvider();

        const unlisteners: (() => void)[] = [];
        const setup = async () => {
            const unState = await listen('plugin://state-changed', () => refreshProvider());
            const unStatus = await listen<{ slot: string; value: DropsStatusValue }>(
                'plugin://status',
                (event) => {
                    if (!pluginMiningRef.current || event.payload.slot !== 'drops.status') return;
                    const v = event.payload.value || {};
                    const channel: MiningChannel | null = v.channel_login
                        ? {
                              id: '',
                              name: v.channel_login,
                              display_name: v.channel_login,
                              game_name: v.game_name ?? '',
                              viewer_count: 0,
                              is_live: true,
                              drops_enabled: true,
                          }
                        : null;
                    const drop: CurrentDropInfo | null = v.game_name
                        ? {
                              campaign_id: v.campaign_id ?? '',
                              campaign_name: '',
                              drop_id: '',
                              drop_name: '',
                              required_minutes: v.required_minutes ?? 0,
                              current_minutes: v.current_minutes ?? 0,
                              game_name: v.game_name,
                          }
                        : null;
                    setMiningStatus({
                        is_mining: !!v.is_mining,
                        current_channel: channel,
                        current_campaign: v.campaign_id ?? null,
                        current_drop: drop,
                        eligible_channels: [],
                        last_update: new Date().toISOString(),
                    });
                    useAppStore.getState().setMiningActive(!!v.is_mining || !!v.active);
                }
            );
            if (disposed) {
                unState();
                unStatus();
            } else {
                unlisteners.push(unState, unStatus);
            }
        };
        setup();
        return () => {
            disposed = true;
            unlisteners.forEach((u) => u());
        };
    }, []);

    // These route to the plugin when one provides mining, else the built-in
    // miner. Every mine control goes through them, so the cockpit feels native
    // either way.
    const mineAuto = async () => {
        if (pluginMiningId) {
            await invoke('plugins_invoke_action', { action: 'drops.mine-auto', args: {} });
            return;
        }
        await invoke('start_auto_mining');
    };
    const mineCampaign = async (campaignId: string, channelId?: string | null) => {
        if (pluginMiningId) {
            await invoke('plugins_invoke_action', { action: 'drops.mine', args: { campaign_id: campaignId } });
            return;
        }
        if (channelId) {
            await invoke('start_campaign_mining_with_channel', { campaignId, channelId });
            return;
        }
        await invoke('start_campaign_mining', { campaignId });
    };
    const stopMining = async () => {
        if (pluginMiningId) {
            await invoke('plugins_invoke_action', { action: 'drops.stop', args: {} });
            return;
        }
        await invoke('stop_auto_mining');
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

            await mineCampaign(pendingCampaign.id, channelId);
            addToast('Started mining campaign', 'success');
        } catch (err) {
            Logger.error('Failed to start mining:', err);
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
            await stopMining();
            addToast('Mining stopped', 'info');
        } catch (err) {
            Logger.error('Failed to stop mining:', err);
            // If there was an error, refresh the status from backend
            try {
                const status = await invoke<MiningStatus>('get_mining_status');
                setMiningStatus(status);
            } catch { /* Mining status not available */ }
        }
    };

    const handleStartAutoMining = async () => {
        try {
            await mineAuto();
            addToast('Auto-mining started', 'success');
        } catch (err) {
            Logger.error('Failed to start auto mining:', err);
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
                priority_farm_channels: [],
            };
            const updatedSettings = { ...current, ...newSettings };

            await invoke('update_drops_settings', { settings: updatedSettings });
            setDropsSettings(updatedSettings);

            useAppStore.getState().updateSettings({
                ...useAppStore.getState().settings,
                drops: updatedSettings
            });
        } catch (err) {
            Logger.error('Failed to update drops settings:', err);
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
            addToast(`Added ${gameName} to favorites`, 'success');
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
            Logger.debug('[DropsCenter] Fetching fresh inventory for game:', game.name);
            
            // Poll inventory to get the latest progress data
            const inventoryData = await invoke<InventoryResponse>('get_drops_inventory');
            
            if (inventoryData?.items) {
                Logger.debug('[DropsCenter] Got fresh inventory with', inventoryData.items.length, 'items');
                
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
                
                Logger.debug('[DropsCenter] Extracted', progressFromInventory.length, 'progress entries from inventory');
                
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
                    
                    Logger.debug('[DropsCenter] Merged progress now has', mergedProgress.length, 'entries');
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
                    Logger.debug('[DropsCenter] Found', freshInventoryForGame.length, 'inventory items for game:', game.name);
                    
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
            Logger.error('[DropsCenter] Failed to fetch inventory for game:', err);
            // Don't show error toast - we still show the panel with cached data
        } finally {
            setIsLoadingGameDetail(false);
        }
    };

    // Auto-apply dropsSearchTerm when navigated to from a specific deep-link
    useEffect(() => {
        if (dropsSearchTerm && unifiedGames.length > 0) {
            setSearchTerm(dropsSearchTerm);
            
            const lowerSearch = dropsSearchTerm.toLowerCase();
            const exactMatch = unifiedGames.find(g => g.name.toLowerCase() === lowerSearch);
            
            if (exactMatch) {
                setTimeout(() => handleGameSelect(exactMatch), 50);
            } else {
                const partialMatches = unifiedGames.filter(g => g.name.toLowerCase().includes(lowerSearch));
                if (partialMatches.length === 1) {
                    setTimeout(() => handleGameSelect(partialMatches[0]), 50);
                }
            }
            
            // Clear the search term from store so it doesn't re-trigger when returning
            setDropsSearchTerm('');
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dropsSearchTerm, unifiedGames]);

    // Mine All Game - starts mining all campaigns for a game sequentially
    // Smart start: Skip campaigns that are already fully complete and start from the first incomplete one
    const handleMineAllGame = async (gameName: string, campaignIds: string[]) => {
        if (campaignIds.length === 0) {
            addToast('No campaigns to mine for this game', 'info');
            return;
        }

        Logger.debug(`[DropsCenter] Starting Mine All for ${gameName} with ${campaignIds.length} campaigns`);

        // Find the game to check campaign completion status
        const game = unifiedGames.find(g => g.name.toLowerCase() === gameName.toLowerCase());
        
        // IMPORTANT: Save current progress before any async operations that might clear it
        const currentProgress = [...progress];
        Logger.debug(`[DropsCenter] Saved progress state with ${currentProgress.length} entries`);
        
        // Filter out campaigns that are already fully complete (all drops claimed or 100% watched)
        // and find the first incomplete campaign to start from
        const incompleteCampaignIds: string[] = [];
        
        for (let i = 0; i < campaignIds.length; i++) {
            const campaignId = campaignIds[i];
            const campaign = game?.active_campaigns.find(c => c.id === campaignId);
            
            if (!campaign) {
                // Campaign not found, include it just in case
                Logger.debug(`[DropsCenter] Campaign ID ${campaignId} not found in active_campaigns, including anyway`);
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
            
            Logger.debug(`[DropsCenter] Campaign "${campaign.name}": ${dropsToCheck.length} drops to check (from ${inventoryItem ? 'inventory' : 'campaign'})`);
            
            // If no drops, consider it incomplete (we can't determine completion status)
            if (!dropsToCheck || dropsToCheck.length === 0) {
                Logger.debug(`[DropsCenter] Campaign "${campaign.name}" has no drops, assuming incomplete`);
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
                    Logger.debug(`[DropsCenter] Drop "${drop.name}" is claimed`);
                    continue; // This drop is complete
                }
                
                // Check if 100% complete from drop's own progress
                if (dropOwnProgress) {
                    const isCompleteFromOwn = dropOwnProgress.current_minutes_watched >= dropOwnProgress.required_minutes_watched;
                    if (isCompleteFromOwn) {
                        Logger.debug(`[DropsCenter] Drop "${drop.name}" is 100% complete (${dropOwnProgress.current_minutes_watched}/${dropOwnProgress.required_minutes_watched})`);
                        continue; // This drop is complete
                    }
                    // Has progress but not complete - this drop is incomplete
                    Logger.debug(`[DropsCenter] Drop "${drop.name}" is in progress (${dropOwnProgress.current_minutes_watched}/${dropOwnProgress.required_minutes_watched})`);
                    allDropsComplete = false;
                    break; // Found an incomplete drop, no need to check more
                }
                
                // Second check: The saved progress state array (NOT the current state which may be cleared)
                const progressEntry = currentProgress.find(p => p.drop_id === drop.id);
                if (progressEntry) {
                    const isComplete = progressEntry.current_minutes_watched >= progressEntry.required_minutes_watched;
                    const isClaimed = progressEntry.is_claimed;
                    if (isComplete || isClaimed) {
                        Logger.debug(`[DropsCenter] Drop "${drop.name}" complete from progress array`);
                        continue; // This drop is complete
                    }
                    // Has progress but not complete
                    Logger.debug(`[DropsCenter] Drop "${drop.name}" in progress from array (${progressEntry.current_minutes_watched}/${progressEntry.required_minutes_watched})`);
                    allDropsComplete = false;
                    break; // Found an incomplete drop
                }
                
                // No progress data found at all - assume NOT complete (need to start mining)
                Logger.debug(`[DropsCenter] Drop "${drop.name}" (ID: ${drop.id}) has no progress data, assuming incomplete`);
                allDropsComplete = false;
                break; // Found an incomplete drop
            }
            
            // A campaign is incomplete if any drop is not complete
            if (!allDropsComplete) {
                incompleteCampaignIds.push(campaignId);
                Logger.debug(`[DropsCenter] Campaign "${campaign.name}" is incomplete, including in queue`);
            } else {
                Logger.debug(`[DropsCenter] Campaign "${campaign.name}" is fully complete, skipping`);
            }
        }
        
        // If all campaigns are complete, notify the user
        if (incompleteCampaignIds.length === 0) {
            addToast(`All campaigns for ${gameName} are already complete!`, 'success');
            return;
        }
        
        const skippedCount = campaignIds.length - incompleteCampaignIds.length;
        if (skippedCount > 0) {
            Logger.debug(`[DropsCenter] Skipping ${skippedCount} completed campaigns, starting with ${incompleteCampaignIds.length} remaining`);
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
        
        Logger.debug(`[DropsCenter] Sorted campaign order (by progress):`, sortedIncompleteCampaignIds.map(id => {
            const campaign = game?.active_campaigns.find(c => c.id === id);
            return campaign?.name || id;
        }));

        // When a plugin powers mining, it auto-progresses through eligible
        // campaigns by priority, so Mine All maps to auto-mine and the built-in
        // per-campaign queue below is skipped.
        if (pluginMiningId) {
            try {
                await stopMining();
                await mineAuto();
                addToast(`Mining available campaigns for ${gameName}`, 'success');
            } catch (err) {
                Logger.error('Failed to start mining:', err);
                addToast('Failed to start mining', 'error');
            }
            return;
        }

        // Stop any current mining first (AFTER checking completion status)
        if (miningStatus?.is_mining) {
            // Use a simpler stop that doesn't clear progress
            try {
                await invoke('stop_auto_mining');
            } catch (err) {
                Logger.error('Failed to stop mining:', err);
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
            Logger.error('Failed to start mine all:', err);
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
            Logger.debug(`[DropsCenter] Mine All complete for ${mineAllQueue.gameName}`);
            addToast(`Finished mining all campaigns for ${mineAllQueue.gameName}!`, 'success');
            setMineAllQueue(null);
            return;
        }

        Logger.debug(`[DropsCenter] Moving to next campaign ${nextIndex + 1}/${mineAllQueue.campaignIds.length}`);

        // Update the queue index
        setMineAllQueue(prev => prev ? { ...prev, currentIndex: nextIndex } : null);

        // Start the next campaign
        try {
            await invoke('start_campaign_mining', { campaignId: mineAllQueue.campaignIds[nextIndex] });
            addToast(`Mining campaign ${nextIndex + 1} of ${mineAllQueue.campaignIds.length}`, 'info');
        } catch (err) {
            Logger.error('Failed to start next campaign:', err);
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
                Logger.debug(`[DropsCenter] Found ${inventoryData.completed_drops.length} completed drops`);
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

            // A campaign only belongs in the games grid if it has something you can
            // still mine: at least one watch-time (mineable) drop. Event/special
            // campaigns with no watch-time drops have "nothing to mine", so we skip
            // them instead of surfacing dead entries that read "nothing to mine".
            const campaignIsMineable = (c: DropCampaign): boolean =>
                (c.time_based_drops || []).some(d =>
                    typeof d.is_mineable === 'boolean'
                        ? d.is_mineable
                        : (d.required_minutes_watched || 0) > 0 ||
                          (d.progress?.required_minutes_watched || 0) > 0
                );

            // Process Active Campaigns and merge progress data from inventory
            if (campaignsData) {
                campaignsData.forEach(campaign => {
                    // IMPORTANT: Merge progress data into each drop BEFORE the mineable
                    // check + adding to game, so embedded/inventory progress is counted.
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
                    
                    // Skip campaigns with nothing to mine (all event/special drops).
                    if (!campaignIsMineable(campaignWithProgress)) {
                        return;
                    }

                    const game = getOrCreateGame(campaign.game_id, campaign.game_name, campaign.image_url);
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

            // Drops the user has genuinely EARNED, from unambiguous sources only: the
            // permanent gameEventDrops list + any inventory drop explicitly is_claimed.
            // Match by benefit id AND benefit NAME (the same reward is reissued under new
            // instances with new ids). NOTE: NOT claimed-by-index or "100% watched" here;
            // those over-matched in-progress drops as earned.
            const ownedBenefitIds = new Set<string>((inventoryData?.completed_drops || []).map(d => d.id));
            const ownedBenefitNames = new Set<string>(
                (inventoryData?.completed_drops || []).map(d => (d.name || '').toLowerCase().trim()).filter(Boolean)
            );
            const ownedDropIds = new Set<string>();
            inventoryData?.items?.forEach(item => {
                item.campaign.time_based_drops.forEach(drop => {
                    if (drop.progress?.is_claimed === true) {
                        ownedDropIds.add(drop.id);
                        drop.benefit_edges?.forEach(b => {
                            ownedBenefitIds.add(b.id);
                            if (b.name) ownedBenefitNames.add(b.name.toLowerCase().trim());
                        });
                    }
                });
            });

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
                            const dp = progressData?.find(p => p.drop_id === drop.id) || drop.progress;
                            // Claimed here, OR already earned elsewhere (by benefit id/name) but
                            // ONLY when this drop isn't itself in progress. A drop with watch-time
                            // is being actively mined and must not be counted as already-earned.
                            const hasCurrentProgress = !!dp && ((dp.current_minutes_watched || 0) > 0 || dp.is_claimed === true);
                            const owned = dp?.is_claimed === true
                                || (!hasCurrentProgress && (
                                    ownedDropIds.has(drop.id)
                                    || (drop.benefit_edges?.some(b =>
                                        ownedBenefitIds.has(b.id) ||
                                        (!!b.name && ownedBenefitNames.has(b.name.toLowerCase().trim()))
                                    ) ?? false)
                                ));
                            if (owned) {
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

            // Only surface games that have at least one campaign with something left to
            // mine. Games whose campaigns are all event-only, or that only appear via
            // earned inventory, have nothing actionable here and live in the Inventory tab.
            setUnifiedGames(Array.from(gamesMap.values()).filter(g => g.active_campaigns.length > 0).sort((a, b) => {
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
            Logger.error('Failed to load unified drops data:', err);
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
            Logger.debug('[DropsCenter] Favorite drops notifications disabled');
            return;
        }
        
        // Get current favorite games
        const favoriteGames = dropsSettings?.favorite_games || [];
        if (favoriteGames.length === 0) {
            Logger.debug('[DropsCenter] No favorited games, skipping new drops check');
            return;
        }
        
        Logger.debug('[DropsCenter] Checking for new drops in favorited games:', favoriteGames);
        
        // Get previously cached campaign data
        let cachedData: Record<string, string[]> = {};
        try {
            const cached = localStorage.getItem(FAVORITE_CAMPAIGNS_CACHE_KEY);
            if (cached) {
                cachedData = JSON.parse(cached);
            }
        } catch (e) {
            Logger.warn('[DropsCenter] Failed to parse cached campaign data:', e);
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
            Logger.debug(`[DropsCenter] New drops available for ${gameName}:`, campaignNames);
            
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
            Logger.warn('[DropsCenter] Failed to save campaign cache:', e);
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
                    Logger.error(e);
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
        let isMounted = true;
        let unlistenStatus: (() => void) | undefined;
        let unlistenProgress: (() => void) | undefined;
        let unlistenComplete: (() => void) | undefined;
        let unlistenNoChannels: (() => void) | undefined;
        let unlistenRecovery: (() => void) | undefined;

        const setupListeners = async () => {
            const uStatus = await listen<MiningStatus>('mining-status-update', (event) => {
                // When a plugin powers mining, its pushes (via plugin://status)
                // are the source of truth; ignore the built-in miner's events.
                if (pluginMiningRef.current) return;
                Logger.debug('[DropsCenter] Mining status update:', event.payload);
                setMiningStatus(event.payload);
                
                // Update AppStore's isMiningActive based on the status
                useAppStore.getState().setMiningActive(event.payload.is_mining);
            });
            if (isMounted) unlistenStatus = uStatus; else uStatus();
            
            // Listen for mining complete events (drop reached 100%)
            // This handles all 3 mining modes:
            // 1. Single Campaign Mining - stop completely
            // 2. Mine All Game - check if there are more campaigns in queue, start next if so
            // 3. Auto-Mining - handled by backend's start_mining (doesn't use this event)
            const uComplete = await listen<{ game_name: string; reason: string }>('mining-complete', async (event) => {
                Logger.debug('[DropsCenter] Mining complete:', event.payload);
                
                // Check if we're in a Mine All queue (use ref to get current value, not stale closure)
                const currentQueue = mineAllQueueRef.current;
                
                if (currentQueue) {
                    // Mine All Game mode - check if there are more campaigns
                    const nextIndex = currentQueue.currentIndex + 1;
                    
                    if (nextIndex < currentQueue.campaignIds.length) {
                        // More campaigns to mine - start the next one
                        Logger.debug(`[DropsCenter] Mine All: Starting campaign ${nextIndex + 1}/${currentQueue.campaignIds.length}`);
                        
                        // Update queue index
                        setMineAllQueue(prev => prev ? { ...prev, currentIndex: nextIndex } : null);
                        
                        try {
                            await invoke('start_campaign_mining', { campaignId: currentQueue.campaignIds[nextIndex] });
                            addToast(`Campaign complete! Mining ${nextIndex + 1} of ${currentQueue.campaignIds.length}...`, 'info');
                        } catch (err) {
                            Logger.error('[DropsCenter] Failed to start next campaign:', err);
                            addToast('Failed to start next campaign', 'error');
                            setMineAllQueue(null);
                            useAppStore.getState().setMiningActive(false);
                        }
                    } else {
                        // All campaigns in queue complete - Mine All Game is done
                        Logger.debug(`[DropsCenter] Mine All complete for ${currentQueue.gameName}`);
                        addToast(`All campaigns for ${event.payload.game_name} complete!`, 'success');
                        setMineAllQueue(null);
                        // Queue exhausted: tear down like a manual stop (disconnect the drops
                        // WebSocket + drop the progress listener) rather than leaving them idle.
                        try {
                            await invoke('stop_auto_mining');
                        } catch (err) {
                            Logger.error('[DropsCenter] stop_auto_mining after Mine All failed:', err);
                        }
                        useAppStore.getState().setMiningActive(false);
                    }
                } else {
                    // Single Campaign Mining mode - stop completely
                    Logger.debug('[DropsCenter] Single campaign complete - stopping');
                    addToast(`Drops complete for ${event.payload.game_name}!`, 'success');
                    // Backend completion soft-stops (halts the loops + clears status) but leaves the
                    // drops WebSocket connected and the progress listener registered. Fire the real
                    // stop so completion tears down exactly like a manual stop.
                    try {
                        await invoke('stop_auto_mining');
                    } catch (err) {
                        Logger.error('[DropsCenter] stop_auto_mining after completion failed:', err);
                    }
                    useAppStore.getState().setMiningActive(false);
                }
                
                // Refresh data to show updated progress
                loadDropsData();
            });
            if (isMounted) unlistenComplete = uComplete; else uComplete();

            // Listen for mining stopped due to no channels available (all streams offline)
            const uNoChannels = await listen<{ reason: string }>('mining-stopped-no-channels', async (event) => {
                Logger.debug('[DropsCenter] Mining stopped - no channels:', event.payload);
                
                // Check if we're in a Mine All queue
                const currentQueue = mineAllQueueRef.current;
                
                if (currentQueue) {
                    // Try to advance to next campaign in queue
                    const nextIndex = currentQueue.currentIndex + 1;
                    
                    if (nextIndex < currentQueue.campaignIds.length) {
                        Logger.debug(`[DropsCenter] Channels offline - trying next campaign ${nextIndex + 1}/${currentQueue.campaignIds.length}`);
                        addToast(`All streams offline - trying next campaign...`, 'warning');
                        
                        setMineAllQueue(prev => prev ? { ...prev, currentIndex: nextIndex } : null);
                        
                        // Start the next campaign after a brief delay
                        setTimeout(async () => {
                            try {
                                await invoke('start_campaign_mining', { campaignId: currentQueue.campaignIds[nextIndex] });
                            } catch (err) {
                                Logger.error('[DropsCenter] Failed to start next campaign:', err);
                                addToast('Failed to start next campaign', 'error');
                                setMineAllQueue(null);
                                useAppStore.getState().setMiningActive(false);
                            }
                        }, 2000);
                    } else {
                        // All campaigns tried - queue exhausted
                        addToast('All campaigns have no available streams', 'warning');
                        setMineAllQueue(null);
                        // Tear down like a manual stop (the backend no-channels stop only halts
                        // the loops + clears status, leaving the WebSocket/listener idle).
                        try {
                            await invoke('stop_auto_mining');
                        } catch (err) {
                            Logger.error('[DropsCenter] stop_auto_mining after no-channels failed:', err);
                        }
                        useAppStore.getState().setMiningActive(false);
                    }
                } else {
                    // Single campaign mode - just notify and stop
                    addToast(`${event.payload.reason || 'All streams offline - mining stopped'}`, 'warning');
                    // Tear down like a manual stop (the backend no-channels stop only halts the
                    // loops + clears status, leaving the WebSocket/listener idle).
                    try {
                        await invoke('stop_auto_mining');
                    } catch (err) {
                        Logger.error('[DropsCenter] stop_auto_mining after no-channels failed:', err);
                    }
                    useAppStore.getState().setMiningActive(false);
                }
                
                // Refresh data
                loadDropsData();
            });
            if (isMounted) unlistenNoChannels = uNoChannels; else uNoChannels();

            // Listen for recovery-watchdog actions (auto-switch on offline / game-swap /
            // stalled progress). Surfaced as a toast when "Notify on Recovery Actions" is on.
            const uRecovery = await listen<{ title: string; message: string; type: string }>('mining-recovery-notification', (event) => {
                Logger.debug('[DropsCenter] Mining recovery action:', event.payload);
                const toastType = event.payload.type === 'error' ? 'error' : 'warning';
                addToast(event.payload.message || event.payload.title || 'Mining recovery action', toastType);
            });
            if (isMounted) unlistenRecovery = uRecovery; else uRecovery();

            const uProgress = await listen<{ drop_id: string; current_minutes: number; required_minutes: number; timestamp: number; campaign_id?: string; }>('drops-progress-update', (event) => {
                Logger.debug('[DropsCenter] Received drops-progress-update:', event.payload);

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
                            last_updated: event.payload.timestamp.toString()
                        };
                        Logger.debug('[DropsCenter] Updated existing progress:', newProg[idx]);
                        return newProg;
                    } else {
                        // Add new progress entry
                        const newEntry: DropProgress = {
                            campaign_id: event.payload.campaign_id || '',
                            drop_id: event.payload.drop_id,
                            current_minutes_watched: event.payload.current_minutes,
                            required_minutes_watched: event.payload.required_minutes,
                            is_claimed: false,
                            last_updated: event.payload.timestamp.toString()
                        };
                        Logger.debug('[DropsCenter] Added new progress entry:', newEntry);
                        return [...prev, newEntry];
                    }
                });

                // Update the displayed drop's minutes IN PLACE when this event is
                // for it. WHICH drop is shown (the one finishing first) is decided
                // by the backend and pushed via 'mining-status-update', so we never
                // re-select here. That single source of truth is what stops the
                // percentage from flipping between rewards as their progress events
                // arrive out of order, and it advances to the next reward the instant
                // the current one completes.
                setMiningStatus((prev) => {
                    if (!prev || !prev.is_mining || !prev.current_drop) return prev;
                    if (prev.current_drop.drop_id !== event.payload.drop_id) return prev;
                    return {
                        ...prev,
                        current_drop: {
                            ...prev.current_drop,
                            current_minutes: event.payload.current_minutes,
                            required_minutes: event.payload.required_minutes
                        },
                        last_update: event.payload.timestamp.toString()
                    };
                });
            });
            if (isMounted) unlistenProgress = uProgress; else uProgress();
        };
        setupListeners();

        return () => {
            isMounted = false;
            if (unlistenStatus) unlistenStatus();
            if (unlistenProgress) unlistenProgress();
            if (unlistenComplete) unlistenComplete();
            if (unlistenNoChannels) unlistenNoChannels();
            if (unlistenRecovery) unlistenRecovery();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [addToast]);

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
            Logger.debug(`[MineAll] Campaign ${currentCampaignId} not found, moving to next`);
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
            Logger.debug(`[MineAll] All drops complete for campaign "${currentCampaign.name}", moving to next campaign`);

            // Small delay before starting next campaign
            const timer = setTimeout(() => {
                startNextCampaignInQueue();
            }, 2000);

            return () => clearTimeout(timer);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mineAllQueue, progress, unifiedGames, miningStatus]);

    // Update games' is_mining flag when miningStatus changes
    useEffect(() => {
        if (!miningStatus || unifiedGames.length === 0) return;

        const miningGameName = miningStatus?.current_drop?.game_name?.toLowerCase() ||
            miningStatus?.current_channel?.game_name?.toLowerCase();

        Logger.debug('[DropsCenter] Updating is_mining flag. Mining:', miningStatus.is_mining, 'Game:', miningGameName);

        // Detect if mining just started for a new game (to trigger scroll)
        const currentMiningGame = miningStatus.is_mining && miningGameName ? miningGameName : null;
        const prevMiningGame = prevMiningGameRef.current;

        // If a new game started mining (different from previous), scroll to top
        if (currentMiningGame && currentMiningGame !== prevMiningGame) {
            Logger.debug('[DropsCenter] New mining game detected, scrolling to top:', currentMiningGame);
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
    }, [miningStatus, unifiedGames.length]);

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
                addToast(`New drop for ${gameName}: ${campaignName}`, 'success');
                Logger.debug(`[DropsCenter] New favorite campaign notification: ${gameName} - ${campaignName}`);
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

            {/* Liquid-glass heart gradients for the favorite hearts on game cards. */}
            <svg width="0" height="0" className="absolute pointer-events-none">
                <defs>
                    <linearGradient id="drops-glass-heart-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(255, 255, 255, 0.4)" />
                        <stop offset="30%" stopColor="rgba(236, 72, 153, 0.2)" />
                        <stop offset="100%" stopColor="rgba(236, 72, 153, 0.6)" />
                    </linearGradient>
                    <linearGradient id="drops-glass-heart-stroke" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(255, 255, 255, 0.8)" />
                        <stop offset="100%" stopColor="rgba(255, 255, 255, 0.1)" />
                    </linearGradient>
                </defs>
            </svg>

            {/* Header with Tabs */}
            <div className="flex items-center justify-center gap-2 px-4 py-3 bg-backgroundSecondary border-b border-borderLight shrink-0 relative z-20">
                {/* Tab Navigation - Framer Motion Sliding Highlight Style (Centered) */}
                <LayoutGroup>
                <div className="flex items-center glass-panel px-1.5 py-1 rounded-xl">
                    <button
                        onClick={() => setActiveTab('games')}
                        className={`group relative flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-300 whitespace-nowrap ${activeTab === 'games'
                            ? 'text-white'
                            : 'text-textSecondary hover:text-textPrimary'
                            }`}
                    >
                        {activeTab === 'games' && (
                            <motion.div
                                layoutId="dropsTabHighlight"
                                className="absolute inset-0 glass-button-static rounded-lg"
                                transition={{ type: "spring", stiffness: 350, damping: 30 }}
                            />
                        )}
                        <span className={`relative z-10 flex items-center gap-2 transition-all duration-300 ${activeTab !== 'games' ? 'group-hover:drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]' : ''}`}>
                            <MonitorPlay size={16} />
                            <span>Campaigns</span>
                        </span>
                    </button>
                    <button
                        onClick={() => setActiveTab('inventory')}
                        className={`group relative flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-300 whitespace-nowrap ${activeTab === 'inventory'
                            ? 'text-white'
                            : 'text-textSecondary hover:text-textPrimary'
                            }`}
                    >
                        {activeTab === 'inventory' && (
                            <motion.div
                                layoutId="dropsTabHighlight"
                                className="absolute inset-0 glass-button-static rounded-lg"
                                transition={{ type: "spring", stiffness: 350, damping: 30 }}
                            />
                        )}
                        <span className={`relative z-10 flex items-center gap-2 transition-all duration-300 ${activeTab !== 'inventory' ? 'group-hover:drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]' : ''}`}>
                            <Package size={16} />
                            <span>Inventory</span>
                        </span>
                    </button>
                    <button
                        onClick={() => setActiveTab('stats')}
                        className={`group relative flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-300 whitespace-nowrap ${activeTab === 'stats'
                            ? 'text-white'
                            : 'text-textSecondary hover:text-textPrimary'
                            }`}
                    >
                        {activeTab === 'stats' && (
                            <motion.div
                                layoutId="dropsTabHighlight"
                                className="absolute inset-0 glass-button-static rounded-lg"
                                transition={{ type: "spring", stiffness: 350, damping: 30 }}
                            />
                        )}
                        <span className={`relative z-10 flex items-center gap-2 transition-all duration-300 ${activeTab !== 'stats' ? 'group-hover:drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]' : ''}`}>
                            <BarChart3 size={16} />
                            <span>Stats</span>
                        </span>
                    </button>
                    <button
                        onClick={() => setActiveTab('settings')}
                        className={`group relative flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-300 whitespace-nowrap ${activeTab === 'settings'
                            ? 'text-white'
                            : 'text-textSecondary hover:text-textPrimary'
                            }`}
                    >
                        {activeTab === 'settings' && (
                            <motion.div
                                layoutId="dropsTabHighlight"
                                className="absolute inset-0 glass-button-static rounded-lg"
                                transition={{ type: "spring", stiffness: 350, damping: 30 }}
                            />
                        )}
                        <span className={`relative z-10 flex items-center gap-2 transition-all duration-300 ${activeTab !== 'settings' ? 'group-hover:drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]' : ''}`}>
                            <SettingsIcon size={16} />
                            <span>Settings</span>
                        </span>
                    </button>
                </div>
                </LayoutGroup>

                {/* Right side: Search + Logout (Absolutely positioned) */}
                <div className="absolute right-4 flex items-center gap-3">
                    {activeTab === 'games' && (
                        <Dropdown
                            value={sortMode}
                            onChange={setSortMode}
                            triggerPrefix="Sort"
                            align="right"
                            ariaLabel="Sort games"
                            leadingIcon={<ArrowDownUp size={13} />}
                            options={[
                                { value: 'recommended', label: 'Recommended' },
                                { value: 'newest', label: 'Newest' },
                                { value: 'oldest', label: 'Oldest' },
                            ]}
                        />
                    )}
                    {activeTab === 'games' && (
                        <div className="relative">
                            <input
                                type="text"
                                placeholder="Search games..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="glass-input pl-8 pr-4 py-1.5 text-sm w-48 focus:w-64 transition-all focus:outline-none"
                            />
                            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-textSecondary" />
                        </div>
                    )}
                    <Tooltip content="Logout from Drops (Android Client)" side="bottom">
                        <button
                            className="px-3 py-1.5 text-xs font-medium rounded-lg glass-panel text-textSecondary hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/30 border border-transparent transition-all"
                            onClick={handleDropsLogout}
                        >
                            Logout
                        </button>
                    </Tooltip>
                </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-hidden relative">
                {/* Loading State */}
                {isLoading && (
                    <div className="h-full flex items-center justify-center">
                        <LoadingWidget useFunnyMessages={false} message="Loading drops & inventory..." />
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
                                completedDrops={completedDrops}
                                progress={progress}
                                earnedBadgeTitles={earnedBadgeTitles}
                                miningStatus={miningStatus}
                                onClaimDrop={handleClaimDrop}

                                isOpen={!!selectedGame}
                                onClose={() => setSelectedGame(null)}
                                onStartMining={handleStartMining}
                                onStopMining={handleStopMining}
                            />
                        )}
                    </div>
                )}

                {/* Stats Tab */}
                {!isLoading && activeTab === 'stats' && (
                    <DropsStatsTab
                        statistics={statistics ? {
                            ...statistics,
                            // Drops Claimed = the account's permanent earned-drops inventory
                            // (completed_drops). Fall back to drops claimed in currently-listed
                            // campaigns only when the permanent inventory is empty.
                            total_drops_claimed: completedDrops.length > 0
                                ? completedDrops.reduce((sum, d) => sum + (d.total_count || 1), 0)
                                : unifiedGames.reduce((sum, game) => sum + game.total_claimed, 0),
                            // In Progress = drops the account is actively working on, from the
                            // freshest inventory snapshot; fall back to the live mining count.
                            drops_in_progress: Math.max(
                                inventoryItems.reduce((sum, item) => sum + item.drops_in_progress, 0),
                                statistics.drops_in_progress
                            ),
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
