import { X, Gift, Package, Check, Pause, Play, Clock } from 'lucide-react';
import type { UnifiedGame, DropProgress, MiningStatus, DropCampaign } from '../../types';

interface GameDetailPanelProps {
    game: UnifiedGame;
    allGames: UnifiedGame[]; // All games for global drop metadata lookup
    progress: DropProgress[];
    miningStatus: MiningStatus | null;
    isOpen: boolean;
    onClose: () => void;
    onStartMining: (campaignId: string, campaignName: string, gameName: string) => void;
    onStopMining: () => void;
    onClaimDrop: (dropId: string, dropInstanceId?: string) => void;
}

export default function GameDetailPanel({
    game,
    allGames,
    progress,
    miningStatus,
    isOpen,
    onClose,
    onStartMining,
    onStopMining,
    onClaimDrop
}: GameDetailPanelProps) {
    // Check if mining this game
    const isMiningThisGame = miningStatus?.is_mining &&
        miningStatus.current_drop?.game_name === game.name;

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
                        {game.inventory_items.length > 0 && (
                            <p className="text-xs text-purple-400 mt-0.5">
                                {game.total_claimed} items collected
                            </p>
                        )}
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
                    {/* Currently Mining Section - Shows ALL drops with active progress */}
                    {(() => {
                        // Get ALL drops from this game's campaigns
                        const dropsFromCampaigns = game.active_campaigns.flatMap(c => c.time_based_drops);

                        // ALSO get drops from inventory_items (which updates immediately with progress)
                        const dropsFromInventory = game.inventory_items.flatMap(item =>
                            item.campaign.time_based_drops
                        );

                        // Combine drops from both sources for lookup
                        const allDropsForGame = [...dropsFromCampaigns, ...dropsFromInventory];

                        // Build a LOCAL map first (drop_id -> drop object) - these are from current game
                        const localDropMap = new Map<string, typeof allDropsForGame[0]>();
                        dropsFromCampaigns.forEach(drop => localDropMap.set(drop.id, drop));
                        dropsFromInventory.forEach(drop => localDropMap.set(drop.id, drop));

                        // Build a GLOBAL drop map from ALL games' campaigns and inventory
                        // This allows us to find metadata for drops we're mining that aren't in the current game's data
                        const globalDropMap = new Map<string, { drop: typeof allDropsForGame[0]; gameName: string }>();
                        allGames.forEach(g => {
                            // From active campaigns
                            g.active_campaigns.forEach(campaign => {
                                campaign.time_based_drops.forEach(drop => {
                                    globalDropMap.set(drop.id, { drop, gameName: g.name });
                                });
                            });
                            // From inventory items
                            g.inventory_items.forEach(item => {
                                item.campaign.time_based_drops.forEach(drop => {
                                    globalDropMap.set(drop.id, { drop, gameName: g.name });
                                });
                            });
                        });

                        // Build a set of drop IDs that belong to this game (for reference)
                        const gameDropIds = new Set(allDropsForGame.map(d => d.id));

                        // DEBUG: Log all IDs for comparison
                        console.log('[GameDetailPanel] Game:', game.name);
                        console.log('[GameDetailPanel] Drops from this game:', localDropMap.size);
                        console.log('[GameDetailPanel] Global drops available:', globalDropMap.size);
                        console.log('[GameDetailPanel] All progress entries:', progress.length);
                        console.log('[GameDetailPanel] Progress drop_ids:', progress.map(p => p.drop_id));

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

                        // Show ALL active progress - when watching a game category, Twitch sends
                        // progress for ALL eligible drops, not just the ones we have metadata for
                        // This ensures we display all drops being mined
                        const progressForThisGame = activeProgress;

                        console.log('[GameDetailPanel] Active progress entries (showing all):', progressForThisGame.length);

                        // Map each progress entry to its drop object (for benefit image/name)
                        const dropsWithProgress = progressForThisGame.map(dropProg => {
                            // First try local map (current game), then fall back to global map
                            const localDrop = localDropMap.get(dropProg.drop_id);
                            const globalLookup = globalDropMap.get(dropProg.drop_id);

                            if (localDrop) {
                                // Found in current game's data
                                const benefitImage = localDrop.benefit_edges?.[0]?.image_url || '';
                                const benefitName = localDrop.benefit_edges?.[0]?.name || localDrop.name;
                                console.log('[GameDetailPanel] ✓ Local match:', dropProg.drop_id, '→', benefitName, benefitImage ? '(has image)' : '(no image)');
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
                                console.log('[GameDetailPanel] ✓ Global match:', dropProg.drop_id, '→', benefitName, `(from ${dropGameName})`, benefitImage ? '(has image)' : '(no image)');
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
                                console.log('[GameDetailPanel] ✗ No drop match for:', dropProg.drop_id);
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

                        console.log('[GameDetailPanel] Final drops with progress:', dropsWithProgress.length, 'matched:', dropsWithProgress.filter(d => d.hasDropObject).length);

                        // Only show "Currently Mining" section if we are actually mining this game
                        // Progress data can persist after mining stops, so check miningStatus first
                        if (!miningStatus?.is_mining) return null;

                        // Don't show section if no drops with progress and not mining this game
                        if (dropsWithProgress.length === 0 && !isMiningThisGame) return null;

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
                    {game.active_campaigns.length > 0 && (
                        <div>
                            <h4 className="flex items-center gap-2 text-sm font-bold text-textPrimary mb-3">
                                <Gift size={16} className="text-accent" />
                                Active Campaigns
                            </h4>

                            <div className="space-y-4">
                                {game.active_campaigns.map(campaign => (
                                    <CampaignCard
                                        key={campaign.id}
                                        campaign={campaign}
                                        progress={progress}
                                        miningStatus={miningStatus}
                                        onStartMining={() => onStartMining(campaign.id, campaign.name, game.name)}
                                        onClaimDrop={onClaimDrop}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

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
                        const completedDrops: Array<{
                            dropId: string;
                            dropInstanceId?: string;
                            benefitImage: string;
                            benefitName: string;
                            isClaimed: boolean;
                        }> = [];

                        // Track which drops we've added to avoid duplicates
                        const addedDropIds = new Set<string>();

                        // DEBUG: Log what we're receiving
                        console.log('[Your Collection] Game:', game.name);
                        console.log('[Your Collection] inventory_items count:', game.inventory_items.length);
                        console.log('[Your Collection] progress array count:', progress.length);

                        // 1. Check inventory_items for completed/claimed drops
                        // Each inventory item has its own progress data
                        game.inventory_items.forEach(item => {
                            console.log('[Your Collection] Inventory item:', item.campaign.name, 'claimed_drops:', item.claimed_drops, 'total_drops:', item.total_drops);

                            item.campaign.time_based_drops.forEach((drop, dropIndex) => {
                                // Check if this drop has internal progress data showing it's complete
                                const dropProgress = drop.progress;

                                // DEBUG: Log each drop's progress
                                console.log(`[Your Collection] Drop ${dropIndex}:`, drop.id, drop.name);
                                console.log('  - progress:', dropProgress);
                                console.log('  - drop.required_minutes_watched:', drop.required_minutes_watched);

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

                                console.log('  - isComplete:', isComplete, 'isClaimed:', isClaimed, 'isClaimedByIndex:', isClaimedByIndex);

                                // Include if: (a) complete based on progress, or (b) claimed based on index
                                if (isComplete || isClaimedByIndex) {
                                    if (!addedDropIds.has(drop.id)) {
                                        addedDropIds.add(drop.id);
                                        completedDrops.push({
                                            dropId: drop.id,
                                            dropInstanceId: dropProgress?.drop_instance_id,
                                            benefitImage: drop.benefit_edges?.[0]?.image_url || '',
                                            benefitName: drop.benefit_edges?.[0]?.name || drop.name,
                                            isClaimed: isClaimed || isClaimedByIndex,
                                        });
                                        console.log('  ✓ Added to collection, drop_instance_id:', dropProgress?.drop_instance_id);
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

                        game.active_campaigns.forEach(campaign => {
                            campaign.time_based_drops.forEach(drop => {
                                gameDropIds.add(drop.id);
                                if (!dropInfoMap.has(drop.id)) {
                                    dropInfoMap.set(drop.id, {
                                        benefitImage: drop.benefit_edges?.[0]?.image_url || '',
                                        benefitName: drop.benefit_edges?.[0]?.name || drop.name,
                                    });
                                }
                            });
                        });

                        progress.forEach(p => {
                            if (!gameDropIds.has(p.drop_id)) return;
                            if (addedDropIds.has(p.drop_id)) return; // Skip if already added

                            // Only include if 100% complete (not in-progress)
                            if (p.current_minutes_watched >= p.required_minutes_watched) {
                                const dropInfo = dropInfoMap.get(p.drop_id);
                                if (dropInfo) {
                                    addedDropIds.add(p.drop_id);
                                    completedDrops.push({
                                        dropId: p.drop_id,
                                        benefitImage: dropInfo.benefitImage,
                                        benefitName: dropInfo.benefitName,
                                        isClaimed: p.is_claimed,
                                    });
                                }
                            }
                        });

                        // Sort: unclaimed first, then claimed
                        const sortedDrops = completedDrops.sort((a, b) => {
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
    progress: DropProgress[];
    miningStatus: MiningStatus | null;
    onStartMining: () => void;
    onClaimDrop: (dropId: string, dropInstanceId?: string) => void;
}

function CampaignCard({
    campaign,
    progress,
    miningStatus,
    onStartMining,
    onClaimDrop
}: CampaignCardProps) {
    const isMiningThisCampaign = miningStatus?.current_campaign === campaign.name && miningStatus?.is_mining;

    // Calculate total watch time required
    const totalMinutesRequired = campaign.time_based_drops.reduce(
        (sum, drop) => sum + drop.required_minutes_watched, 0
    );

    // Calculate total progress
    const totalMinutesWatched = campaign.time_based_drops.reduce((sum, drop) => {
        const dropProgress = progress.find(p => p.drop_id === drop.id);
        return sum + (dropProgress?.current_minutes_watched || 0);
    }, 0);

    // Count claimed drops
    const claimedCount = campaign.time_based_drops.filter(drop => {
        const dropProgress = progress.find(p => p.drop_id === drop.id);
        return dropProgress?.is_claimed;
    }).length;

    // Get all drop rewards with their images - directly from drops
    const dropRewards = campaign.time_based_drops.map(drop => {
        const benefit = drop.benefit_edges?.[0];
        const dropProgress = progress.find(p => p.drop_id === drop.id);
        const progressPercent = dropProgress
            ? (dropProgress.current_minutes_watched / dropProgress.required_minutes_watched) * 100
            : 0;
        return {
            dropId: drop.id,
            dropName: drop.name,
            requiredMinutes: drop.required_minutes_watched,
            imageUrl: benefit?.image_url || '',
            benefitName: benefit?.name || drop.name,
            isClaimed: dropProgress?.is_claimed || false,
            progressPercent,
            isInProgress: progressPercent > 0 && progressPercent < 100,
        };
    });

    return (
        <div className="glass-panel p-4 border border-borderLight">
            {/* Campaign Header */}
            <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-textSecondary font-medium truncate flex-1 pr-2">
                    {campaign.name}
                </span>
                {!isMiningThisCampaign && (
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
                    <div className="flex flex-wrap gap-2">
                        {dropRewards.map((reward) => (
                            <div
                                key={reward.dropId}
                                className={`group relative flex items-center gap-2 p-1.5 rounded-lg transition-all ${reward.isClaimed
                                    ? 'bg-green-500/20 border border-green-500/30'
                                    : reward.isInProgress
                                        ? 'bg-accent/20 border border-accent/30'
                                        : 'bg-background/50 border border-borderLight hover:border-purple-500/30'
                                    }`}
                                title={`${reward.benefitName} (${reward.requiredMinutes}m)`}
                            >
                                <div className="relative w-8 h-8 rounded-md overflow-hidden bg-background/50 shrink-0">
                                    {reward.imageUrl ? (
                                        <img
                                            src={reward.imageUrl}
                                            alt={reward.benefitName}
                                            className={`w-full h-full object-contain ${reward.isClaimed ? 'opacity-60' : ''}`}
                                            loading="lazy"
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center">
                                            <Gift size={14} className="text-purple-400" />
                                        </div>
                                    )}
                                    {reward.isClaimed && (
                                        <div className="absolute inset-0 bg-green-500/40 flex items-center justify-center">
                                            <Check size={12} className="text-white" />
                                        </div>
                                    )}
                                    {reward.isInProgress && !reward.isClaimed && (
                                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-background/50">
                                            <div
                                                className="h-full bg-accent animate-progress-shimmer"
                                                style={{ width: `${reward.progressPercent}%` }}
                                            />
                                        </div>
                                    )}
                                </div>
                                <div className="min-w-0 flex-1 max-w-[100px]">
                                    <p className="text-[10px] font-medium text-textPrimary truncate">
                                        {reward.benefitName}
                                    </p>
                                    <p className="text-[9px] text-textMuted">
                                        {reward.requiredMinutes}m watch
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                    {/* Campaign Progress Summary */}
                    {totalMinutesWatched > 0 && (
                        <div className="mt-2 pt-2 border-t border-purple-500/10">
                            <div className="flex items-center justify-between text-[10px] mb-1">
                                <span className="text-textMuted">Campaign Progress</span>
                                <span className="text-purple-400 font-mono">
                                    {claimedCount}/{campaign.time_based_drops.length} claimed
                                </span>
                            </div>
                            <div className="h-1 w-full bg-background rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-purple-500/60 rounded-full transition-all"
                                    style={{ width: `${Math.min((totalMinutesWatched / totalMinutesRequired) * 100, 100)}%` }}
                                />
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Drops List */}
            <div className="space-y-2">
                {campaign.time_based_drops.map(drop => {
                    const dropProgress = progress.find(p => p.drop_id === drop.id);
                    const progressPercent = dropProgress
                        ? (dropProgress.current_minutes_watched / dropProgress.required_minutes_watched) * 100
                        : 0;
                    const isClaimed = dropProgress?.is_claimed || false;
                    const isClaimable = progressPercent >= 100 && !isClaimed;
                    const isMiningThisDrop = miningStatus?.current_drop?.drop_id === drop.id && miningStatus?.is_mining;

                    return (
                        <div
                            key={drop.id}
                            className={`flex items-center gap-3 p-2.5 rounded-lg transition-all ${isClaimed
                                ? 'bg-green-500/10 border border-green-500/20'
                                : isMiningThisDrop
                                    ? 'bg-accent/10 border border-accent/20'
                                    : 'bg-background border border-borderLight'
                                }`}
                        >
                            {/* Drop Image */}
                            <div className="w-11 h-11 rounded-lg bg-backgroundSecondary shrink-0 p-0.5 border border-borderLight relative overflow-hidden">
                                <img
                                    src={drop.benefit_edges[0]?.image_url}
                                    alt=""
                                    className="w-full h-full object-contain"
                                    loading="lazy"
                                />
                                {isClaimed && (
                                    <div className="absolute inset-0 bg-green-500/40 flex items-center justify-center">
                                        <Check size={18} className="text-green-300" />
                                    </div>
                                )}
                            </div>

                            {/* Drop Info */}
                            <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-textPrimary truncate" title={drop.name}>
                                    {drop.name}
                                </p>
                                <div className="flex items-center justify-between mt-1">
                                    <span className="text-[10px] text-textSecondary font-mono">
                                        {dropProgress ? Math.round(dropProgress.current_minutes_watched) : 0}/{drop.required_minutes_watched}m
                                    </span>
                                    {isMiningThisDrop && (
                                        <span className="text-[10px] text-accent font-medium animate-pulse">Mining...</span>
                                    )}
                                </div>

                                {/* Progress Bar */}
                                <div className="h-1.5 w-full bg-background rounded-full mt-1.5 overflow-hidden border border-borderLight">
                                    <div
                                        className={`h-full rounded-full transition-all duration-500 ${isClaimed
                                            ? 'bg-green-500'
                                            : isMiningThisDrop
                                                ? 'animate-progress-shimmer'
                                                : 'bg-accent/60'
                                            }`}
                                        style={{ width: `${Math.min(progressPercent, 100)}%` }}
                                    />
                                </div>
                            </div>

                            {/* Claim Button */}
                            {isClaimable && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onClaimDrop(drop.id, dropProgress?.drop_instance_id);
                                    }}
                                    className="px-3 py-1.5 bg-green-500 hover:bg-green-400 text-white text-xs font-bold rounded-lg transition-all shadow-lg animate-pulse shrink-0"
                                >
                                    Claim
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
