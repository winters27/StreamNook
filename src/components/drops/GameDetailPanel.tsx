import { X, Gift, Package, Check, Pause, Play, Clock, Zap, Star, Ban, ExternalLink } from 'lucide-react';
import type { UnifiedGame, DropProgress, MiningStatus, DropCampaign, TimeBasedDrop, InventoryItem, CompletedDrop } from '../../types';

import { Logger } from '../../utils/logger';
// Helper to check if a drop is mineable
// Uses the is_mineable field from backend, with fallback to checking required_minutes_watched
// Also checks inventory data as a secondary source since it has more accurate progress info
function isDropMineable(drop: TimeBasedDrop, inventoryItems?: InventoryItem[]): boolean {
    // If is_mineable is explicitly set, use it
    if (typeof drop.is_mineable === 'boolean') {
        return drop.is_mineable;
    }
    
    // Check if required_minutes_watched is set and > 0
    if (drop.required_minutes_watched > 0) {
        return true;
    }
    
    // Fallback: Check inventory items for this drop's data
    // Inventory data often has more accurate required_minutes_watched values
    if (inventoryItems && inventoryItems.length > 0) {
        for (const item of inventoryItems) {
            const inventoryDrop = item.campaign.time_based_drops.find(d => d.id === drop.id);
            if (inventoryDrop) {
                // Check inventory drop's is_mineable
                if (typeof inventoryDrop.is_mineable === 'boolean') {
                    return inventoryDrop.is_mineable;
                }
                // Check inventory drop's required_minutes_watched
                if (inventoryDrop.required_minutes_watched > 0) {
                    return true;
                }
                // Check inventory drop's progress.required_minutes_watched
                if (inventoryDrop.progress && inventoryDrop.progress.required_minutes_watched > 0) {
                    return true;
                }
            }
        }
    }
    
    // Check if the drop has progress data with required_minutes
    if (drop.progress && drop.progress.required_minutes_watched > 0) {
        return true;
    }
    
    // Default: not mineable if we can't determine watch time requirement
    return false;
}

// Helper to check if a campaign is mineable
// A campaign is mineable if it has at least one mineable time_based_drop
function isCampaignMineable(campaign: DropCampaign, inventoryItems?: InventoryItem[]): boolean {
    if (!campaign.time_based_drops || campaign.time_based_drops.length === 0) {
        return false;
    }
    // Campaign is mineable if ANY of its drops are mineable
    return campaign.time_based_drops.some(drop => isDropMineable(drop, inventoryItems));
}

// Get the drop type label for a campaign
function getCampaignDropType(campaign: DropCampaign, inventoryItems?: InventoryItem[]): { type: 'time' | 'instant' | 'mixed' | 'other'; label: string } {
    if (!campaign.time_based_drops || campaign.time_based_drops.length === 0) {
        return { type: 'other', label: 'Event/Special' };
    }
    
    const mineableCount = campaign.time_based_drops.filter(d => isDropMineable(d, inventoryItems)).length;
    const nonMineableCount = campaign.time_based_drops.length - mineableCount;
    
    if (mineableCount > 0 && nonMineableCount > 0) {
        return { type: 'mixed', label: 'Mixed' };
    } else if (mineableCount > 0) {
        return { type: 'time', label: 'Watch Time' };
    } else {
        return { type: 'instant', label: 'Event/Special' };
    }
}

interface GameDetailPanelProps {
    game: UnifiedGame;
    allGames: UnifiedGame[]; // All games for global drop metadata lookup
    progress: DropProgress[];
    completedDrops: CompletedDrop[]; // List of all completed drops from inventory
    miningStatus: MiningStatus | null;
    isOpen: boolean;
    onClose: () => void;
    onStartMining: (campaignId: string, campaignName: string, gameName: string) => void;
    onStopMining: () => void;
    onClaimDrop: (dropId: string, dropInstanceId?: string) => void;
}

// Helper to merge progress from inventory into campaigns
// This ensures we show the most accurate progress data even if the progress array doesn't have it
function mergeProgressFromInventory(
    campaign: DropCampaign,
    inventoryItems: InventoryItem[],
    progressArray: DropProgress[]
): DropCampaign {
    // Find matching inventory item for this campaign
    const inventoryItem = inventoryItems.find(item => 
        item.campaign.id === campaign.id ||
        item.campaign.name.toLowerCase() === campaign.name.toLowerCase()
    );
    
    if (!inventoryItem) return campaign;
    
    // Merge progress from inventory into each drop
    const mergedDrops = campaign.time_based_drops.map(drop => {
        // First check progress array (real-time updates take priority)
        const progressEntry = progressArray.find(p => p.drop_id === drop.id);
        if (progressEntry) {
            return {
                ...drop,
                progress: progressEntry,
            };
        }
        
        // Then check inventory item for this drop's progress
        const inventoryDrop = inventoryItem.campaign.time_based_drops.find(d => d.id === drop.id);
        if (inventoryDrop?.progress) {
            return {
                ...drop,
                progress: inventoryDrop.progress,
                // Also copy over required_minutes_watched from inventory if our drop has 0
                required_minutes_watched: drop.required_minutes_watched || inventoryDrop.required_minutes_watched,
                is_mineable: drop.is_mineable ?? (inventoryDrop.required_minutes_watched > 0),
            };
        }
        
        // Use existing drop progress or keep as-is
        return drop;
    });
    
    return {
        ...campaign,
        time_based_drops: mergedDrops,
    };
}

export default function GameDetailPanel({
    game,
    allGames,
    progress,
    completedDrops,
    miningStatus,
    isOpen,
    onClose,
    onStartMining,
    onStopMining,
    onClaimDrop
}: GameDetailPanelProps) {
    // Merge inventory progress into active campaigns for accurate display
    const campaignsWithMergedProgress = game.active_campaigns.map(campaign => 
        mergeProgressFromInventory(campaign, game.inventory_items, progress)
    );
    // Check if mining this game
    // Use current_drop.game_name OR current_channel.game_name as fallback (current_drop may not be set immediately)
    const isMiningThisGame = miningStatus?.is_mining && (
        miningStatus.current_drop?.game_name?.toLowerCase() === game.name?.toLowerCase() ||
        miningStatus.current_channel?.game_name?.toLowerCase() === game.name?.toLowerCase()
    );

    // Transform box art URL to higher resolution
    // GQL API returns URLs with fixed dimensions (e.g., "52x72"), not placeholders
    // Helix API returns URLs with {width}x{height} placeholders
    // We need to handle both cases
    const getHighResBoxArt = (url: string | undefined): string => {
        if (!url) return 'https://static-cdn.jtvnw.net/ttv-static/404_boxart-288x384.jpg';

        // If URL has placeholders (Helix style), replace them
        if (url.includes('{width}') && url.includes('{height}')) {
            return url.replace('{width}', '288').replace('{height}', '384');
        }

        // If URL has fixed dimensions (GQL style), replace them with high res
        // Pattern: -WIDTHxHEIGHT.jpg or -WIDTHxHEIGHT.png
        const fixedDimensionPattern = /-\d+x\d+\.(jpg|png|jpeg|webp)/i;
        if (fixedDimensionPattern.test(url)) {
            return url.replace(fixedDimensionPattern, '-288x384.$1');
        }

        // Fallback: return as-is
        return url;
    };

    const boxArtUrl = getHighResBoxArt(game.box_art_url);

    // Calculate mining progress for this game
    let miningProgress = 0;
    let miningDropName = '';
    let miningTimeRemaining = '';
    let miningDropImage = '';
    let miningBenefitName = '';
    let miningCurrentMins = 0;
    let miningRequiredMins = 0;

    if (isMiningThisGame && miningStatus?.current_drop) {
        const { drop_id, drop_name } = miningStatus.current_drop;
        const liveProgress = progress.find(p => p.drop_id === drop_id);

        miningCurrentMins = liveProgress ? liveProgress.current_minutes_watched : (miningStatus.current_drop.current_minutes ?? 0);
        miningRequiredMins = liveProgress ? liveProgress.required_minutes_watched : (miningStatus.current_drop.required_minutes ?? 1);

        miningProgress = miningRequiredMins > 0 ? (miningCurrentMins / miningRequiredMins) * 100 : 0;
        miningDropName = drop_name || '';
        const remainingMinutes = Math.max(0, miningRequiredMins - miningCurrentMins);
        miningTimeRemaining = `${Math.floor(remainingMinutes)}m remaining`;

        // Find the actual drop object to get its benefit image
        const miningDrop = game.active_campaigns
            .flatMap(c => c.time_based_drops)
            .find(d => d.id === drop_id);

        if (miningDrop?.benefit_edges?.[0]) {
            miningDropImage = miningDrop.benefit_edges[0].image_url || '';
            miningBenefitName = miningDrop.benefit_edges[0].name || miningDropName;
        }
    }

    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/40 backdrop-blur-sm z-20"
                onClick={onClose}
            />

            {/* Panel - Using glass-panel for theme-aware styling */}
            <div className="absolute top-0 right-0 bottom-0 w-[85vw] sm:w-[70vw] md:w-[50vw] lg:w-[40vw] xl:w-[30vw] 2xl:w-96 max-w-md glass-panel z-30 flex flex-col animate-slide-in-right border-l border-borderLight shadow-2xl">
                {/* Header */}
                <div className="flex items-center gap-3 p-4 border-b border-borderLight bg-background/80">
                    <img
                        src={boxArtUrl}
                        alt={game.name}
                        className="w-14 h-[74px] rounded-lg object-cover border border-borderLight shadow-md"
                    />
                    <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-textPrimary text-base truncate">
                            {game.name}
                        </h3>
                        <p className="text-xs text-textSecondary mt-0.5">
                            {game.active_campaigns.length} campaign{game.active_campaigns.length !== 1 ? 's' : ''} active
                        </p>
                        {(() => {
                            // Find account link from any active campaign for this game
                            const accountLink = game.active_campaigns.find(c => c.account_link)?.account_link;
                            
                            if (accountLink) {
                                return (
                                    <a
                                        href={accountLink}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs text-accent hover:text-accent/80 mt-0.5 flex items-center gap-1 hover:underline transition-colors"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <ExternalLink size={10} />
                                        Connect game account
                                    </a>
                                );
                            }
                            return null;
                        })()}
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 text-textSecondary hover:text-textPrimary hover:bg-surface rounded-lg transition-all"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Content - Scrollable */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-6">
                    {/* Currently Mining Section - Shows ONLY drops from the specific campaign being mined */}
                    {(() => {
                        // Get the current campaign being mined (from miningStatus)
                        const currentCampaignName = miningStatus?.current_campaign;
                        
                        // Get ALL drops from this game's campaigns
                        const dropsFromCampaigns = game.active_campaigns.flatMap(c => c.time_based_drops);

                        // ALSO get drops from inventory_items (which updates immediately with progress)
                        const dropsFromInventory = game.inventory_items.flatMap(item =>
                            item.campaign.time_based_drops
                        );

                        // Combine drops from both sources for lookup
                        const allDropsForGame = [...dropsFromCampaigns, ...dropsFromInventory];

                        // Build a LOCAL map: drop_id -> { drop, campaignName }
                        // Include campaign name so we can filter by specific campaign
                        const localDropMap = new Map<string, { drop: typeof allDropsForGame[0]; campaignName: string }>();
                        game.active_campaigns.forEach(campaign => {
                            campaign.time_based_drops.forEach(drop => {
                                localDropMap.set(drop.id, { drop, campaignName: campaign.name });
                            });
                        });
                        game.inventory_items.forEach(item => {
                            item.campaign.time_based_drops.forEach(drop => {
                                localDropMap.set(drop.id, { drop, campaignName: item.campaign.name });
                            });
                        });

                        // Build a GLOBAL drop map from ALL games' campaigns and inventory
                        // This allows us to find metadata for drops we're mining that aren't in the current game's data
                        const globalDropMap = new Map<string, { drop: typeof allDropsForGame[0]; gameName: string; campaignName: string }>();
                        allGames.forEach(g => {
                            // From active campaigns
                            g.active_campaigns.forEach(campaign => {
                                campaign.time_based_drops.forEach(drop => {
                                    globalDropMap.set(drop.id, { drop, gameName: g.name, campaignName: campaign.name });
                                });
                            });
                            // From inventory items
                            g.inventory_items.forEach(item => {
                                item.campaign.time_based_drops.forEach(drop => {
                                    globalDropMap.set(drop.id, { drop, gameName: g.name, campaignName: item.campaign.name });
                                });
                            });
                        });

                        // Build a set of drop IDs that belong to this game (for reference)
                        const gameDropIds = new Set(allDropsForGame.map(d => d.id));

                        // DEBUG: Log all IDs for comparison
                        Logger.debug('[GameDetailPanel] Game:', game.name);
                        Logger.debug('[GameDetailPanel] Current campaign being mined:', currentCampaignName);
                        Logger.debug('[GameDetailPanel] Drops from this game:', localDropMap.size);
                        Logger.debug('[GameDetailPanel] Global drops available:', globalDropMap.size);
                        Logger.debug('[GameDetailPanel] All progress entries:', progress.length);
                        Logger.debug('[GameDetailPanel] Progress drop_ids:', progress.map(p => p.drop_id));

                        // Filter progress entries that are actively being mined:
                        // - Has some progress (current_minutes > 0)
                        // - NOT yet 100% complete (still mining)
                        // - NOT claimed
                        // Drops at 100% go to "Your Collection" section instead
                        const activeProgress = progress.filter(p =>
                            p.current_minutes_watched > 0 &&
                            !p.is_claimed &&
                            p.current_minutes_watched < p.required_minutes_watched // Not yet 100%
                        );

                        // ONLY show progress for drops that belong to the SPECIFIC CAMPAIGN being mined
                        // This prevents showing drops from other campaigns in the same game
                        const progressForThisGame = activeProgress.filter(p => {
                            // First check if this drop belongs to this game
                            const localLookup = localDropMap.get(p.drop_id);
                            const globalLookup = globalDropMap.get(p.drop_id);
                            
                            const belongsToThisGame = localLookup || (globalLookup && globalLookup.gameName === game.name);
                            if (!belongsToThisGame) return false;
                            
                            // If we know what campaign is being mined, filter to ONLY that campaign's drops
                            if (currentCampaignName) {
                                const dropCampaignName = localLookup?.campaignName || globalLookup?.campaignName;
                                if (dropCampaignName && dropCampaignName !== currentCampaignName) {
                                    Logger.debug(`[GameDetailPanel] Filtering out drop ${p.drop_id} - belongs to "${dropCampaignName}", mining "${currentCampaignName}"`);
                                    return false;
                                }
                            }
                            
                            return true;
                        });

                        Logger.debug('[GameDetailPanel] Active progress entries for current campaign:', progressForThisGame.length);

                        // Map each progress entry to its drop object (for benefit image/name)
                        const dropsWithProgress = progressForThisGame.map(dropProg => {
                            // First try local map (current game), then fall back to global map
                            const localLookup = localDropMap.get(dropProg.drop_id);
                            const globalLookup = globalDropMap.get(dropProg.drop_id);

                            if (localLookup) {
                                // Found in current game's data
                                const { drop: localDrop } = localLookup;
                                const benefitImage = localDrop.benefit_edges?.[0]?.image_url || '';
                                const benefitName = localDrop.benefit_edges?.[0]?.name || localDrop.name;
                                Logger.debug('[GameDetailPanel] ✓ Local match:', dropProg.drop_id, '→', benefitName, benefitImage ? '(has image)' : '(no image)');
                                return {
                                    dropId: localDrop.id,
                                    progress: dropProg,
                                    benefitImage,
                                    benefitName,
                                    gameName: game.name,
                                    hasDropObject: true,
                                };
                            } else if (globalLookup) {
                                // Found in another game's data
                                const { drop: globalDrop, gameName: dropGameName } = globalLookup;
                                const benefitImage = globalDrop.benefit_edges?.[0]?.image_url || '';
                                const benefitName = globalDrop.benefit_edges?.[0]?.name || globalDrop.name;
                                Logger.debug('[GameDetailPanel] ✓ Global match:', dropProg.drop_id, '→', benefitName, `(from ${dropGameName})`, benefitImage ? '(has image)' : '(no image)');
                                return {
                                    dropId: globalDrop.id,
                                    progress: dropProg,
                                    benefitImage,
                                    benefitName,
                                    gameName: dropGameName,
                                    hasDropObject: true,
                                };
                            } else {
                                // Progress exists but no matching drop object found anywhere
                                // Show fallback UI with just the progress data
                                Logger.debug('[GameDetailPanel] ✗ No drop match for:', dropProg.drop_id);
                                return {
                                    dropId: dropProg.drop_id,
                                    progress: dropProg,
                                    benefitImage: '',
                                    benefitName: `Drop in progress`,
                                    gameName: undefined,
                                    hasDropObject: false,
                                };
                            }
                        });

                        Logger.debug('[GameDetailPanel] Final drops with progress:', dropsWithProgress.length, 'matched:', dropsWithProgress.filter(d => d.hasDropObject).length);

                        // Only show "Currently Mining" section if we are actually mining THIS specific game
                        // This prevents showing the mining UI when viewing a different game's panel
                        if (!isMiningThisGame) return null;

                        // Don't show section if no drops with progress for this game
                        if (dropsWithProgress.length === 0) return null;

                        return (
                            <div className="glass-panel p-4 space-y-3 border border-green-500/30 bg-green-500/5">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2 text-green-400 font-semibold text-sm">
                                        <span className="relative flex h-2.5 w-2.5">
                                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
                                        </span>
                                        Currently Mining
                                        {dropsWithProgress.length > 0 && (
                                            <span className="text-[10px] font-mono text-green-300 bg-green-500/20 px-1.5 py-0.5 rounded">
                                                {dropsWithProgress.length} drop{dropsWithProgress.length !== 1 ? 's' : ''}
                                            </span>
                                        )}
                                    </div>
                                    {isMiningThisGame && (
                                        <button
                                            onClick={onStopMining}
                                            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-xs font-medium transition-colors border border-red-500/30"
                                        >
                                            <Pause size={12} />
                                            Stop
                                        </button>
                                    )}
                                </div>

                                {/* Show ALL drops with active progress */}
                                {dropsWithProgress.length > 0 ? (
                                    <div className="space-y-2">
                                        {dropsWithProgress.map(({ dropId, progress: dropProg, benefitImage, benefitName }) => {
                                            const currentMins = dropProg.current_minutes_watched;
                                            const requiredMins = dropProg.required_minutes_watched;
                                            const percent = requiredMins > 0 ? (currentMins / requiredMins) * 100 : 0;

                                            return (
                                                <div
                                                    key={dropId}
                                                    className="flex items-center gap-3 p-2 rounded-lg bg-background/50 border border-green-500/20"
                                                >
                                                    {/* Benefit Image */}
                                                    <div className="relative shrink-0">
                                                        {benefitImage ? (
                                                            <img
                                                                src={benefitImage}
                                                                alt={benefitName}
                                                                className="w-12 h-12 rounded-lg object-contain border border-green-500/30 bg-background"
                                                            />
                                                        ) : (
                                                            <div className="w-12 h-12 rounded-lg bg-background border border-green-500/30 flex items-center justify-center">
                                                                <Gift size={18} className="text-green-400" />
                                                            </div>
                                                        )}
                                                    </div>

                                                    {/* Drop Info */}
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-xs font-medium text-textPrimary truncate" title={benefitName}>
                                                            {benefitName}
                                                        </p>
                                                        <div className="h-2 w-full bg-background rounded-full mt-1.5 overflow-hidden border border-borderSubtle">
                                                            <div
                                                                className="h-full rounded-full animate-progress-shimmer"
                                                                style={{ width: `${Math.min(percent, 100)}%` }}
                                                            />
                                                        </div>
                                                        <div className="flex items-center justify-between mt-1">
                                                            <span className="text-[10px] text-green-400 font-mono">
                                                                {Math.round(currentMins)}/{requiredMins}m
                                                            </span>
                                                            <span className="text-[10px] text-textMuted font-semibold">
                                                                {Math.round(percent)}%
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    // Fallback when mining but no WebSocket progress yet
                                    <div className="flex items-center gap-3 p-2 bg-background/50 rounded-lg border border-green-500/20">
                                        {miningDropImage && (
                                            <img
                                                src={miningDropImage}
                                                alt={miningBenefitName}
                                                className="w-12 h-12 rounded-lg object-contain border border-green-500/40 bg-background shrink-0"
                                            />
                                        )}
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-textPrimary truncate" title={miningBenefitName || miningDropName}>
                                                {miningBenefitName || miningDropName || 'Starting...'}
                                            </p>
                                            <div className="h-2 w-full bg-background rounded-full mt-1.5 overflow-hidden">
                                                <div
                                                    className="h-full rounded-full animate-progress-shimmer"
                                                    style={{ width: `${Math.min(miningProgress, 100)}%` }}
                                                />
                                            </div>
                                            <p className="text-xs text-green-400 font-mono mt-1">
                                                Waiting for progress update...
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })()}

                    {/* Active Campaigns Section */}
                    {(()=> {
                        // Merge progress from inventory into campaigns for accurate status checking
                        const mergedCampaigns = campaignsWithMergedProgress;
                        
                        // Build a comprehensive Set of ALL completed BENEFIT IDs (not drop IDs!)
                        // The completedDrops from backend contains benefit IDs from gameEventDrops
                        // These are the reward IDs, not the TimeBasedDrop IDs
                        const completedBenefitIds = new Set(completedDrops.map(d => d.id));
                        
                        // Also build a set of drop IDs that are complete based on inventory progress data
                        // This catches drops that are 100% watched or claimed in the current session
                        const completedDropIds = new Set<string>();
                        
                        // IMPORTANT: Check ALL inventory items across ALL games for claimed drops
                        // This catches drops from expired campaigns that aren't in the backend's completedDrops list
                        allGames.forEach(g => {
                            g.inventory_items.forEach(item => {
                                item.campaign.time_based_drops.forEach((drop, dropIndex) => {
                                    const dropProgress = drop.progress;
                                    
                                    // Check if this drop is claimed
                                    const isClaimed = dropProgress?.is_claimed || false;
                                    const isClaimedByIndex = dropIndex < item.claimed_drops;
                                    
                                    // Check if 100% complete
                                    const isCompleteByProgress = dropProgress &&
                                        dropProgress.current_minutes_watched >= dropProgress.required_minutes_watched &&
                                        dropProgress.required_minutes_watched > 0;
                                    const isCompleteByDropMinutes = dropProgress &&
                                        dropProgress.current_minutes_watched >= drop.required_minutes_watched &&
                                        drop.required_minutes_watched > 0;
                                    const isComplete = isCompleteByProgress || isCompleteByDropMinutes;
                                    
                                    // Add to completed drop IDs set if claimed or 100% complete
                                    if (isClaimed || isClaimedByIndex || isComplete) {
                                        completedDropIds.add(drop.id);
                                    }
                                });
                            });
                        });
                        
                        // Helper function to check if a drop is completed by comparing its benefit IDs
                        // against the completedBenefitIds set (from gameEventDrops)
                        const isDropCompletedByBenefit = (drop: TimeBasedDrop): boolean => {
                            if (!drop.benefit_edges || drop.benefit_edges.length === 0) return false;
                            // A drop is completed if ANY of its benefits are in the completed set
                            return drop.benefit_edges.some(benefit => completedBenefitIds.has(benefit.id));
                        };
                        
                        Logger.debug('[Active Campaigns] Completed benefit IDs (from gameEventDrops):', completedBenefitIds.size);
                        Logger.debug('[Active Campaigns] Completed drop IDs (from inventory progress):', completedDropIds.size);
                        Logger.debug('[Active Campaigns] Backend completedDrops:', completedDrops.length);
                        
                        // Filter campaigns: show only incomplete campaigns in this section
                        // A campaign is shown here if it has ANY drop that:
                        // - Is NOT completed (benefit not in completedBenefitIds)
                        // - Is NOT claimed
                        // - Is NOT 100% complete (or has no progress data yet)
                        // - Has required_minutes > 0 (is a time-based mineable drop)
                        const incompleteCampaigns = mergedCampaigns.filter(campaign => {
                            // A campaign is incomplete if ANY drop is still earnable
                            return campaign.time_based_drops.some(drop => {
                                // FIRST: Check if this drop's BENEFIT is in the completedBenefitIds set
                                if (isDropCompletedByBenefit(drop)) {
                                    Logger.debug('[Active Campaigns] Drop', drop.name, 'has completed benefit, skipping');
                                    return false; // This drop's reward was already claimed
                                }
                                
                                // SECOND: Check if this drop's ID is in the completedDropIds set (from inventory)
                                if (completedDropIds.has(drop.id)) {
                                    Logger.debug('[Active Campaigns] Drop', drop.name, 'is in completed drops (inventory), skipping');
                                    return false;
                                }
                                
                                // Then check embedded progress (from inventory API - most reliable)
                                const dropProgress = drop.progress || progress.find(p => p.drop_id === drop.id);
                                
                                // Check if drop is claimed
                                const isClaimed = dropProgress?.is_claimed || false;
                                if (isClaimed) return false; // This drop is done, check others
                                
                                // Check if drop has required minutes (is mineable)
                                const requiredMins = dropProgress?.required_minutes_watched || drop.required_minutes_watched || 0;
                                if (requiredMins <= 0) return false; // Not a time-based drop, check others
                                
                                // Check if drop is 100% complete
                                const currentMins = dropProgress?.current_minutes_watched || 0;
                                const isComplete = currentMins >= requiredMins;
                                
                                // Drop is incomplete (still earnable) if not complete
                                return !isComplete;
                            });
                        });

                        if (incompleteCampaigns.length === 0) return null;

                        return (
                            <div>
                                <h4 className="flex items-center gap-2 text-sm font-bold text-textPrimary mb-3">
                                    <Gift size={16} className="text-accent" />
                                    Active Campaigns
                                    <span className="text-[10px] font-mono text-textMuted bg-background/50 px-2 py-0.5 rounded ml-auto">
                                        {incompleteCampaigns.length} remaining
                                    </span>
                                </h4>

                                <div className="space-y-4">
                                    {incompleteCampaigns.map(campaign => (
                                        <CampaignCard
                                            key={campaign.id}
                                            campaign={campaign}
                                            inventoryItems={game.inventory_items}
                                            progress={progress}
                                            completedDropIds={completedDropIds}
                                            completedBenefitIds={completedBenefitIds}
                                            miningStatus={miningStatus}
                                            onStartMining={() => onStartMining(campaign.id, campaign.name, game.name)}
                                            onClaimDrop={onClaimDrop}
                                        />
                                    ))}
                                </div>
                            </div>
                        );
                    })()}

                    {/* Completed Campaigns Section */}
                    {(() => {
                        // Use merged campaigns for accurate status
                        const mergedCampaigns = campaignsWithMergedProgress;
                        
                        // Create a Set of completed BENEFIT IDs for fast lookup (not drop IDs!)
                        const completedBenefitIds = new Set(completedDrops.map(d => d.id));
                        
                        // Helper function to check if a drop is completed by its benefit ID
                        const isDropCompletedByBenefit = (drop: TimeBasedDrop): boolean => {
                            if (!drop.benefit_edges || drop.benefit_edges.length === 0) return false;
                            return drop.benefit_edges.some(benefit => completedBenefitIds.has(benefit.id));
                        };
                        
                        // Filter campaigns: show only 100% complete campaigns here
                        const completedCampaigns = mergedCampaigns.filter(campaign => {
                            // A campaign is complete if ALL drops are 100% complete or claimed
                            if (campaign.time_based_drops.length === 0) return false;
                            
                            return campaign.time_based_drops.every(drop => {
                                // First check if benefit is in the completed set
                                if (isDropCompletedByBenefit(drop)) return true;
                                
                                const dropProgress = drop.progress || progress.find(p => p.drop_id === drop.id);
                                if (!dropProgress) return false; // No progress = not complete
                                
                                // Check if drop is complete (100% watched or claimed)
                                const isComplete = dropProgress.current_minutes_watched >= dropProgress.required_minutes_watched &&
                                    dropProgress.required_minutes_watched > 0;
                                const isClaimed = dropProgress.is_claimed;
                                
                                return isComplete || isClaimed;
                            });
                        });

                        if (completedCampaigns.length === 0) return null;

                        return (
                            <div>
                                <h4 className="flex items-center gap-2 text-sm font-bold text-textPrimary mb-3">
                                    <Check size={16} className="text-green-400" />
                                    Completed Campaigns
                                    <span className="text-[10px] font-mono text-green-400 bg-green-500/10 px-2 py-0.5 rounded ml-auto">
                                        {completedCampaigns.length} done
                                    </span>
                                </h4>

                                <div className="space-y-4">
                                    {completedCampaigns.map(campaign => (
                                        <CampaignCard
                                            key={campaign.id}
                                            campaign={campaign}
                                            inventoryItems={game.inventory_items}
                                            progress={progress}
                                            completedBenefitIds={completedBenefitIds}
                                            miningStatus={miningStatus}
                                            onStartMining={() => onStartMining(campaign.id, campaign.name, game.name)}
                                            onClaimDrop={onClaimDrop}
                                        />
                                    ))}
                                </div>
                            </div>
                        );
                    })()}

                    {/* No Active Campaigns */}
                    {game.active_campaigns.length === 0 && (
                        <div className="glass-panel p-6 text-center border border-dashed border-borderLight">
                            <Gift size={32} className="mx-auto text-textSecondary opacity-40 mb-2" />
                            <p className="text-sm text-textSecondary">
                                No active campaigns for this game right now.
                            </p>
                        </div>
                    )}

                    {/* Your Collection - Shows ONLY completed drops (100% watched) from inventory */}
                    {(() => {
                        // Find completed drops (100% watched) - NOT in-progress
                        const localCompletedDrops: Array<{
                            dropId: string;
                            dropInstanceId?: string;
                            benefitImage: string;
                            benefitName: string;
                            isClaimed: boolean;
                            isMineable: boolean; // Track if this drop can be mined (time-based)
                        }> = [];

                        // Track which drops we've added to avoid duplicates
                        const addedDropIds = new Set<string>();

                        // DEBUG: Log what we're receiving
                        Logger.debug('[Your Collection] Game:', game.name);
                        Logger.debug('[Your Collection] inventory_items count:', game.inventory_items.length);
                        Logger.debug('[Your Collection] progress array count:', progress.length);

                        // 1. Check inventory_items for completed/claimed drops
                        // Each inventory item has its own progress data
                        game.inventory_items.forEach(item => {
                            Logger.debug('[Your Collection] Inventory item:', item.campaign.name, 'claimed_drops:', item.claimed_drops, 'total_drops:', item.total_drops);

                            item.campaign.time_based_drops.forEach((drop, dropIndex) => {
                                // Check if this drop has internal progress data showing it's complete
                                const dropProgress = drop.progress;

                                // DEBUG: Log each drop's progress
                                Logger.debug(`[Your Collection] Drop ${dropIndex}:`, drop.id, drop.name);
                                Logger.debug('  - progress:', dropProgress);
                                Logger.debug('  - drop.required_minutes_watched:', drop.required_minutes_watched);

                                // Check completion using multiple methods:
                                // 1. Progress field shows 100%
                                const isCompleteByProgress = dropProgress &&
                                    dropProgress.current_minutes_watched >= dropProgress.required_minutes_watched &&
                                    dropProgress.required_minutes_watched > 0;

                                // 2. Progress field shows 100% using drop's required minutes (fallback)
                                const isCompleteByDropMinutes = dropProgress &&
                                    dropProgress.current_minutes_watched >= drop.required_minutes_watched &&
                                    drop.required_minutes_watched > 0;

                                const isComplete = isCompleteByProgress || isCompleteByDropMinutes;
                                const isClaimed = dropProgress?.is_claimed || false;

                                // Also check if claimed based on claimed_drops count
                                const isClaimedByIndex = dropIndex < item.claimed_drops;

                                Logger.debug('  - isComplete:', isComplete, 'isClaimed:', isClaimed, 'isClaimedByIndex:', isClaimedByIndex);

                                // Include if: (a) complete based on progress, or (b) claimed based on index
                                if (isComplete || isClaimedByIndex) {
                                    if (!addedDropIds.has(drop.id)) {
                                        addedDropIds.add(drop.id);
                                        localCompletedDrops.push({
                                            dropId: drop.id,
                                            dropInstanceId: dropProgress?.drop_instance_id,
                                            benefitImage: drop.benefit_edges?.[0]?.image_url || '',
                                            benefitName: drop.benefit_edges?.[0]?.name || drop.name,
                                            isClaimed: isClaimed || isClaimedByIndex,
                                            isMineable: isDropMineable(drop, game.inventory_items),
                                        });
                                        Logger.debug('  ✓ Added to collection, drop_instance_id:', dropProgress?.drop_instance_id);
                                    }
                                }
                            });
                        });

                        // 2. Check progress array for any additional completed drops
                        // (in case progress data is more up-to-date than inventory)
                        // Build a set of valid drop IDs for this game
                        const gameDropIds = new Set<string>();
                        const dropInfoMap = new Map<string, { benefitImage: string; benefitName: string }>();

                        game.inventory_items.forEach(item => {
                            item.campaign.time_based_drops.forEach(drop => {
                                gameDropIds.add(drop.id);
                                dropInfoMap.set(drop.id, {
                                    benefitImage: drop.benefit_edges?.[0]?.image_url || '',
                                    benefitName: drop.benefit_edges?.[0]?.name || drop.name,
                                });
                            });
                        });

                        // 3. ALSO check active campaigns for completed drops (100% or claimed in current session)
                        game.active_campaigns.forEach(campaign => {
                            campaign.time_based_drops.forEach(drop => {
                                gameDropIds.add(drop.id);
                                if (!dropInfoMap.has(drop.id)) {
                                    dropInfoMap.set(drop.id, {
                                        benefitImage: drop.benefit_edges?.[0]?.image_url || '',
                                        benefitName: drop.benefit_edges?.[0]?.name || drop.name,
                                    });
                                }
                                
                                // If this drop is complete or claimed, add it to the collection
                                if (!addedDropIds.has(drop.id)) {
                                    const dropProgress = drop.progress || progress.find(p => p.drop_id === drop.id);
                                    if (dropProgress) {
                                        const isComplete = dropProgress.current_minutes_watched >= dropProgress.required_minutes_watched &&
                                            dropProgress.required_minutes_watched > 0;
                                        const isClaimed = dropProgress.is_claimed;
                                        
                                        if (isComplete || isClaimed) {
                                            addedDropIds.add(drop.id);
                                            localCompletedDrops.push({
                                                dropId: drop.id,
                                                dropInstanceId: dropProgress.drop_instance_id,
                                                benefitImage: drop.benefit_edges?.[0]?.image_url || '',
                                                benefitName: drop.benefit_edges?.[0]?.name || drop.name,
                                                isClaimed,
                                                isMineable: isDropMineable(drop, game.inventory_items),
                                            });
                                            Logger.debug('[Your Collection] Added from active campaign:', drop.name, 'claimed:', isClaimed);
                                        }
                                    }
                                }
                            });
                        });

                        progress.forEach(p => {
                            if (!gameDropIds.has(p.drop_id)) return;
                            if (addedDropIds.has(p.drop_id)) return; // Skip if already added

                            // Include if:
                            // - 100% complete (ready-to-claim)
                            // - OR already claimed
                            // Some claimed drops don't always keep an intuitive minutes state, so
                            // we treat `is_claimed` as authoritative for "completed".
                            const isComplete = p.current_minutes_watched >= p.required_minutes_watched &&
                                p.required_minutes_watched > 0; // Only if mineable (has required watch time)
                            if (isComplete || p.is_claimed) {
                                const dropInfo = dropInfoMap.get(p.drop_id);
                                if (dropInfo) {
                                    addedDropIds.add(p.drop_id);
                                    localCompletedDrops.push({
                                        dropId: p.drop_id,
                                        benefitImage: dropInfo.benefitImage,
                                        benefitName: dropInfo.benefitName,
                                        isClaimed: p.is_claimed,
                                        isMineable: p.required_minutes_watched > 0, // Mineable if has required watch time
                                    });
                                }
                            }
                        });

                        // Sort: unclaimed first, then claimed
                        const sortedDrops = localCompletedDrops.sort((a, b) => {
                            if (a.isClaimed === b.isClaimed) return 0;
                            return a.isClaimed ? 1 : -1; // Unclaimed first
                        });

                        // Separate into unclaimed (ready to claim) and claimed
                        const unclaimedDrops = sortedDrops.filter(d => !d.isClaimed);
                        const claimedDrops = sortedDrops.filter(d => d.isClaimed);

                        const totalItems = sortedDrops.length;
                        if (totalItems === 0) return null;

                        return (
                            <div>
                                <h4 className="flex items-center gap-2 text-sm font-bold text-textPrimary mb-3">
                                    <Package size={16} className="text-purple-400" />
                                    Your Collection
                                    <span className="text-[10px] font-mono text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded ml-auto">
                                        {totalItems} item{totalItems !== 1 ? 's' : ''}
                                    </span>
                                </h4>

                                {/* Unclaimed completed drops - shown first with Claim button */}
                                {unclaimedDrops.length > 0 && (
                                    <div className="space-y-2 mb-4">
                                        {unclaimedDrops.map(({ dropId, dropInstanceId, benefitImage, benefitName }) => (
                                            <div
                                                key={dropId}
                                                className="flex items-center gap-3 p-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30"
                                            >
                                                {/* Benefit Image */}
                                                <div className="relative shrink-0">
                                                    {benefitImage ? (
                                                        <img
                                                            src={benefitImage}
                                                            alt={benefitName}
                                                            className="w-12 h-12 rounded-lg object-contain border border-yellow-500/30 bg-background"
                                                        />
                                                    ) : (
                                                        <div className="w-12 h-12 rounded-lg bg-background border border-yellow-500/30 flex items-center justify-center">
                                                            <Gift size={18} className="text-yellow-400" />
                                                        </div>
                                                    )}
                                                    {/* Ready badge */}
                                                    <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-yellow-500 flex items-center justify-center shadow-lg animate-pulse">
                                                        <span className="text-[8px] font-bold text-black">!</span>
                                                    </div>
                                                </div>

                                                {/* Drop Info */}
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-xs font-medium text-textPrimary truncate" title={benefitName}>
                                                        {benefitName}
                                                    </p>
                                                    <p className="text-[10px] text-yellow-400 font-semibold mt-0.5">
                                                        Ready to claim!
                                                    </p>
                                                </div>

                                                {/* Claim Button */}
                                                <button
                                                    onClick={() => onClaimDrop(dropId, dropInstanceId)}
                                                    className="px-3 py-1.5 bg-green-500 hover:bg-green-400 text-white text-xs font-bold rounded-lg transition-all shadow-lg animate-pulse shrink-0"
                                                >
                                                    Claim
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Grid of claimed drops */}
                                {claimedDrops.length > 0 && (
                                    <div className="grid grid-cols-4 gap-4">
                                        {claimedDrops.map(({ dropId, benefitImage, benefitName }) => (
                                            <div
                                                key={dropId}
                                                className="group relative pt-1 pr-1"
                                                title={benefitName}
                                            >
                                                {/* Drop Reward Image Container */}
                                                <div className="w-full aspect-square rounded-lg border border-purple-500/40 bg-purple-500/10 p-1">
                                                    {benefitImage ? (
                                                        <img
                                                            src={benefitImage}
                                                            alt={benefitName}
                                                            className="w-full h-full object-contain rounded-md"
                                                            loading="lazy"
                                                        />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center rounded-md bg-background/50">
                                                            <Gift size={20} className="text-purple-400" />
                                                        </div>
                                                    )}
                                                </div>

                                                {/* Checkmark badge - positioned outside the container */}
                                                <div className="absolute top-0 right-0 w-5 h-5 rounded-full bg-green-500 flex items-center justify-center shadow-lg border-2 border-background">
                                                    <Check size={10} className="text-white" />
                                                </div>

                                                {/* Name on hover */}
                                                <div className="absolute -bottom-5 left-0 right-0 text-center opacity-0 group-hover:opacity-100 transition-opacity z-10">
                                                    <span className="text-[9px] text-textMuted bg-background/90 px-1.5 py-0.5 rounded truncate max-w-full inline-block">
                                                        {benefitName}
                                                    </span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })()}
                </div>
            </div>
        </>
    );
}

// Sub-component for campaign cards
interface CampaignCardProps {
    campaign: DropCampaign;
    inventoryItems: InventoryItem[];
    progress: DropProgress[];
    completedDropIds?: Set<string>; // IDs of completed drops (from inventory progress)
    completedBenefitIds?: Set<string>; // IDs of completed benefits (from gameEventDrops)
    miningStatus: MiningStatus | null;
    onStartMining: () => void;
    onClaimDrop: (dropId: string, dropInstanceId?: string) => void;
}

function CampaignCard({
    campaign,
    inventoryItems,
    progress,
    completedDropIds,
    completedBenefitIds,
    miningStatus,
    onStartMining,
    onClaimDrop
}: CampaignCardProps) {
    // Prefer embedded progress (drop.progress) and fall back to the global progress[] state.
    const resolveDropProgress = (dropId: string, embedded?: DropProgress) => {
        return progress.find(p => p.drop_id === dropId) || embedded || null;
    };
    
    // Check if we're mining this campaign AND there are still drops being actively mined (< 100%)
    // Don't show "Mining" badge once all drops are 100% complete (ready to claim)
    const hasActivelyMiningDrops = campaign.time_based_drops.some(drop => {
        const dropProgress = resolveDropProgress(drop.id, drop.progress);
        if (!dropProgress) return false;
        
        // A drop is "actively mining" if it has progress but is not yet 100%
        const required = dropProgress.required_minutes_watched || drop.required_minutes_watched || 0;
        const current = dropProgress.current_minutes_watched || 0;
        
        return required > 0 && current > 0 && current < required && !dropProgress.is_claimed;
    });
    
    const isMiningThisCampaign = miningStatus?.current_campaign === campaign.name && 
        miningStatus?.is_mining && 
        hasActivelyMiningDrops; // Only show "Mining" if there are drops still being mined
    
    // Check if this campaign is mineable (has time-based drops with watch time requirements)
    // Pass inventory items to check them as a fallback source for required_minutes_watched
    const isMineable = isCampaignMineable(campaign, inventoryItems);
    const dropType = getCampaignDropType(campaign, inventoryItems);

    // Calculate total watch time required
    const totalMinutesRequired = campaign.time_based_drops.reduce(
        (sum, drop) => sum + (drop.required_minutes_watched || 0),
        0
    );

    // Calculate total progress (minutes watched)
    const totalMinutesWatched = campaign.time_based_drops.reduce((sum, drop) => {
        const dropProgress = resolveDropProgress(drop.id, drop.progress);
        if (!dropProgress) return sum;

        const required = dropProgress.required_minutes_watched || drop.required_minutes_watched || 0;
        const current = dropProgress.is_claimed ? required : (dropProgress.current_minutes_watched || 0);

        return sum + (required > 0 ? Math.min(current, required) : 0);
    }, 0);

    // Count claimed drops
    const claimedCount = campaign.time_based_drops.filter(drop => {
        const dropProgress = resolveDropProgress(drop.id, drop.progress);
        return !!dropProgress?.is_claimed;
    }).length;

    // Get all drop rewards with their images - directly from drops
    const dropRewards = campaign.time_based_drops.map(drop => {
        const benefit = drop.benefit_edges?.[0];
        const dropProgress = resolveDropProgress(drop.id, drop.progress);

        // Check if this drop is in the global completed drops list (either by drop ID or benefit ID)
        const isCompletedByDropId = completedDropIds?.has(drop.id) || false;
        const isCompletedByBenefitId = completedBenefitIds && benefit ? completedBenefitIds.has(benefit.id) : false;
        const isGloballyCompleted = isCompletedByDropId || isCompletedByBenefitId;

        const required = dropProgress?.required_minutes_watched || drop.required_minutes_watched || 0;
        const current = dropProgress
            ? (dropProgress.is_claimed ? required : (dropProgress.current_minutes_watched || 0))
            : 0;

        const progressPercent = required > 0 ? (current / required) * 100 : 0;

        return {
            dropId: drop.id,
            dropName: drop.name,
            requiredMinutes: drop.required_minutes_watched,
            imageUrl: benefit?.image_url || '',
            benefitName: benefit?.name || drop.name,
            isClaimed: dropProgress?.is_claimed || isGloballyCompleted, // Mark as claimed if in global completed list
            progressPercent: isGloballyCompleted ? 100 : progressPercent, // Show 100% if globally completed
            isInProgress: !isGloballyCompleted && progressPercent > 0 && progressPercent < 100,
            isMineable: isDropMineable(drop, inventoryItems), // Track if drop is mineable - check inventory as fallback
            isGloballyCompleted, // Track if this drop was earned from a previous/expired campaign
        };
    });

    return (
        <div className="glass-panel p-4 border border-borderLight">
            {/* Campaign Header */}
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 flex-1 min-w-0 pr-2">
                    <span className="text-xs text-textSecondary font-medium truncate">
                        {campaign.name}
                    </span>
                    {/* Drop Type Badge */}
                    {dropType.type === 'time' && (
                        <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-accent/20 text-accent border border-accent/30 shrink-0 flex items-center gap-1">
                            <Clock size={9} />
                            Watch
                        </span>
                    )}
                    {dropType.type === 'mixed' && (
                        <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-orange-500/20 text-orange-400 border border-orange-500/30 shrink-0 flex items-center gap-1">
                            <Clock size={9} />
                            Mixed
                        </span>
                    )}
                    {dropType.type === 'instant' && (
                        <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 shrink-0 flex items-center gap-1">
                            <Ban size={9} />
                            Event Only
                        </span>
                    )}
                    {dropType.type === 'other' && (
                        <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-purple-500/20 text-purple-400 border border-purple-500/30 shrink-0 flex items-center gap-1">
                            <Star size={9} />
                            Special
                        </span>
                    )}
                </div>
                {/* Only show Mine button if campaign is mineable (has time-based drops) */}
                {!isMiningThisCampaign && isMineable && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onStartMining();
                        }}
                        className="text-xs bg-accent/20 hover:bg-accent text-accent hover:text-white px-3 py-1.5 rounded-lg border border-accent/30 transition-all font-semibold flex items-center gap-1.5"
                    >
                        <Play size={12} fill="currentColor" />
                        Mine
                    </button>
                )}
                {/* Show "Not Mineable" label for non-time-based campaigns */}
                {!isMiningThisCampaign && !isMineable && (
                    <span className="text-[10px] text-textMuted italic shrink-0">
                        Not mineable
                    </span>
                )}
                {isMiningThisCampaign && (
                    <span className="text-xs text-green-400 font-semibold flex items-center gap-1.5 bg-green-500/10 px-2 py-1 rounded">
                        <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                        </span>
                        Mining
                    </span>
                )}
            </div>

            {/* Gift Rewards Preview - Show available rewards */}
            {campaign.time_based_drops.length > 0 && (
                <div className="mb-3 p-2.5 rounded-lg bg-gradient-to-r from-purple-500/10 to-accent/10 border border-purple-500/20">
                    <div className="flex items-center gap-2 mb-2">
                        <Gift size={12} className="text-purple-400" />
                        <span className="text-[10px] font-semibold text-purple-400 uppercase tracking-wide">
                            {campaign.time_based_drops.length} Reward{campaign.time_based_drops.length !== 1 ? 's' : ''} Available
                        </span>
                        <span className="text-[10px] text-textMuted ml-auto">
                            <Clock size={10} className="inline mr-1" />
                            {Math.floor(totalMinutesRequired / 60)}h {totalMinutesRequired % 60}m total
                        </span>
                    </div>
                    <div className="space-y-2">
                        {dropRewards.map((reward) => {
                            // Calculate current minutes watched for display
                            const dropProgress = resolveDropProgress(reward.dropId);
                            const currentMins = dropProgress
                                ? (dropProgress.is_claimed ? reward.requiredMinutes : Math.round(dropProgress.current_minutes_watched))
                                : 0;
                            
                            return (
                                <div
                                    key={reward.dropId}
                                    className={`group relative flex items-center gap-3 p-2.5 rounded-lg transition-all ${reward.isClaimed
                                        ? 'bg-green-500/20 border border-green-500/30'
                                        : reward.isInProgress
                                            ? 'bg-accent/20 border border-accent/30'
                                            : 'bg-background/50 border border-borderLight hover:border-purple-500/30'
                                        }`}
                                >
                                    {/* Larger Drop Image */}
                                    <div className="relative w-14 h-14 rounded-lg overflow-hidden bg-background shrink-0 border border-borderLight">
                                        {reward.imageUrl ? (
                                            <img
                                                src={reward.imageUrl}
                                                alt={reward.benefitName}
                                                className={`w-full h-full object-contain p-1 ${reward.isClaimed ? 'opacity-60' : ''}`}
                                                loading="lazy"
                                            />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center">
                                                <Gift size={24} className="text-purple-400" />
                                            </div>
                                        )}
                                        {reward.isClaimed && (
                                            <div className="absolute inset-0 bg-green-500/40 flex items-center justify-center">
                                                <Check size={20} className="text-white" />
                                            </div>
                                        )}
                                    </div>

                                    {/* Drop Info with Progress */}
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1.5 mb-1">
                                            <p className="text-xs font-medium text-textPrimary truncate">
                                                {reward.benefitName}
                                            </p>
                                            {reward.isGloballyCompleted && (
                                                <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-purple-500/20 text-purple-400 border border-purple-500/30 shrink-0">
                                                    Already Owned
                                                </span>
                                            )}
                                        </div>
                                        
                                        {reward.isMineable ? (
                                            <>
                                                {/* Progress Bar */}
                                                <div className="h-1.5 w-full bg-background rounded-full overflow-hidden border border-borderLight mb-1">
                                                    <div
                                                        className={`h-full rounded-full transition-all ${reward.isClaimed
                                                            ? 'bg-green-500'
                                                            : reward.isInProgress
                                                                ? 'bg-accent animate-progress-shimmer'
                                                                : 'bg-accent/40'
                                                            }`}
                                                        style={{ width: `${Math.min(reward.progressPercent, 100)}%` }}
                                                    />
                                                </div>
                                        {/* Minutes Progress */}
                                                <div className="flex items-center justify-between">
                                                    <span className={`text-[10px] font-mono ${reward.isClaimed ? 'text-green-400' : reward.isInProgress ? 'text-accent' : 'text-textMuted'}`}>
                                                        {reward.isGloballyCompleted ? `${reward.requiredMinutes}/${reward.requiredMinutes}m` : `${currentMins}/${reward.requiredMinutes}m`}
                                                    </span>
                                                    {/* Show Claim button for 100% complete drops that haven't been claimed */}
                                                    {!reward.isClaimed && reward.progressPercent >= 100 ? (
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                const dropProg = resolveDropProgress(reward.dropId);
                                                                onClaimDrop(reward.dropId, dropProg?.drop_instance_id);
                                                            }}
                                                            className="px-2 py-0.5 bg-green-500 hover:bg-green-400 text-white text-[10px] font-bold rounded transition-all animate-pulse"
                                                        >
                                                            Claim
                                                        </button>
                                                    ) : (
                                                        <span className={`text-[10px] font-semibold ${reward.isClaimed ? 'text-green-400' : 'text-textMuted'}`}>
                                                            {reward.isClaimed ? (reward.isGloballyCompleted ? 'Previously Earned' : 'Claimed') : `${Math.round(reward.progressPercent)}%`}
                                                        </span>
                                                    )}
                                                </div>
                                            </>
                                        ) : (
                                            <p className="text-[10px] text-yellow-500 flex items-center gap-1 mt-1">
                                                <Ban size={10} />
                                                Event only - cannot auto-mine
                                            </p>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
