import { useRef, useEffect, useState } from 'react';
import { Check, Clock, Package, Square, Play, Heart, DollarSign } from 'lucide-react';
import type { UnifiedGame, DropProgress, MiningStatus, DropCampaign } from '../../types';

// Helper to check if a campaign is mineable (has time-based drops that require watching)
function isCampaignMineable(campaign: DropCampaign): boolean {
    // Campaign is mineable if it has any time_based_drops
    // The API only gives us time_based_drops, so if we have them, they're mineable
    // Subscription/gift-based campaigns won't have time_based_drops populated
    if (!campaign.time_based_drops || campaign.time_based_drops.length === 0) {
        return false;
    }
    
    // Check if at least one drop requires watch time (> 0 minutes)
    // Use >= 0 check since undefined/null would fail > 0 check incorrectly
    // Also fallback to true if we have drops but required_minutes_watched isn't set
    const hasWatchTimeDrops = campaign.time_based_drops.some(drop => {
        const minutes = drop.required_minutes_watched;
        // If required_minutes_watched is not set or is positive, it's mineable
        return minutes === undefined || minutes === null || minutes > 0;
    });
    
    return hasWatchTimeDrops;
}

interface GameCardProps {
    game: UnifiedGame;
    allGames: UnifiedGame[]; // All games for global drop metadata lookup
    progress: DropProgress[];
    miningStatus: MiningStatus | null;
    isSelected: boolean;
    isFavorite: boolean;
    onClick: () => void;
    onStopMining?: () => void;
    onMineAllGame?: (gameName: string, campaignIds: string[]) => void;
    onToggleFavorite?: (gameName: string) => void;
}

// Helper to format time remaining
function formatTimeRemaining(minutes: number): string {
    if (minutes <= 0) return '0m';
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    if (hours > 0) {
        return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    }
    return `${mins}m`;
}

export default function GameCard({
    game,
    allGames,
    progress,
    miningStatus,
    isSelected,
    isFavorite,
    onClick,
    onStopMining,
    onMineAllGame,
    onToggleFavorite
}: GameCardProps) {
    const titleRef = useRef<HTMLHeadingElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [fontSize, setFontSize] = useState(14); // Start with default size in px

    // Check if this game is currently being mined
    // Use case-insensitive comparison and also check the game's is_mining flag
    const isMining = miningStatus?.is_mining && (
        game.is_mining ||
        miningStatus.current_drop?.game_name?.toLowerCase() === game.name?.toLowerCase() ||
        miningStatus.current_channel?.game_name?.toLowerCase() === game.name?.toLowerCase()
    );

    // Build a global drop map from ALL games for metadata lookup
    const globalDropMap = new Map<string, { benefitImage: string; benefitName: string; gameName: string }>();
    allGames.forEach(g => {
        g.active_campaigns.forEach(campaign => {
            campaign.time_based_drops.forEach(drop => {
                globalDropMap.set(drop.id, {
                    benefitImage: drop.benefit_edges?.[0]?.image_url || '',
                    benefitName: drop.benefit_edges?.[0]?.name || drop.name,
                    gameName: g.name
                });
            });
        });
        g.inventory_items.forEach(item => {
            item.campaign.time_based_drops.forEach(drop => {
                globalDropMap.set(drop.id, {
                    benefitImage: drop.benefit_edges?.[0]?.image_url || '',
                    benefitName: drop.benefit_edges?.[0]?.name || drop.name,
                    gameName: g.name
                });
            });
        });
    });

    // Find the best drop to display when mining - the one with highest progress % that's not complete
    // This shows the most relevant progress on the card
    const findBestProgressDrop = () => {
        if (!isMining) return null;

        // PRIMARY: Use miningStatus.current_drop if available (has freshest data from backend)
        if (miningStatus?.current_drop) {
            const { drop_id, current_minutes, required_minutes, drop_name, drop_image } = miningStatus.current_drop;
            // Use drop_image directly from miningStatus if available, fallback to globalDropMap
            const metadata = globalDropMap.get(drop_id);
            const benefitImage = drop_image || metadata?.benefitImage || '';
            const benefitName = drop_name || metadata?.benefitName || 'Drop';

            return {
                dropId: drop_id,
                current: current_minutes ?? 0,
                required: required_minutes ?? 1,
                benefitImage,
                benefitName
            };
        }

        // FALLBACK: Get all active (not claimed, not complete) progress entries
        const activeProgressEntries = progress.filter(p =>
            !p.is_claimed &&
            p.current_minutes_watched > 0 &&
            p.current_minutes_watched < p.required_minutes_watched
        );

        if (activeProgressEntries.length === 0) {
            return null;
        }

        // Find the drop with highest progress percentage
        let bestDrop = activeProgressEntries[0];
        let bestPercent = (bestDrop.current_minutes_watched / bestDrop.required_minutes_watched) * 100;

        for (const entry of activeProgressEntries) {
            const percent = (entry.current_minutes_watched / entry.required_minutes_watched) * 100;
            if (percent > bestPercent) {
                bestDrop = entry;
                bestPercent = percent;
            }
        }

        // Use cached drop_image/drop_name from progress if available, fallback to globalDropMap
        const metadata = globalDropMap.get(bestDrop.drop_id);
        return {
            dropId: bestDrop.drop_id,
            current: bestDrop.current_minutes_watched,
            required: bestDrop.required_minutes_watched,
            benefitImage: bestDrop.drop_image || metadata?.benefitImage || '',
            benefitName: bestDrop.drop_name || metadata?.benefitName || 'Drop in progress'
        };
    };

    const bestDrop = findBestProgressDrop();

    // Mining progress from best drop
    const miningProgress = isMining && bestDrop
        ? {
            current: bestDrop.current,
            required: bestDrop.required,
        }
        : null;

    // Get the benefit image/name from best drop
    const miningDropBenefitImage = bestDrop?.benefitImage;
    const miningDropBenefitName = bestDrop?.benefitName || miningStatus?.current_drop?.drop_name || 'Drop';

    // Transform box art URL to high resolution (1200x1600)
    // GQL API returns URLs with fixed dimensions (e.g., "52x72"), not placeholders
    // Helix API returns URLs with {width}x{height} placeholders
    // We need to handle both cases
    const getHighResBoxArt = (url: string | undefined): string => {
        if (!url) return 'https://static-cdn.jtvnw.net/ttv-static/404_boxart-1200x1600.jpg';

        // If URL has placeholders (Helix style), replace them
        if (url.includes('{width}') && url.includes('{height}')) {
            return url.replace('{width}', '1200').replace('{height}', '1600');
        }

        // If URL has fixed dimensions (GQL style), replace them with high res
        // Pattern: -WIDTHxHEIGHT.jpg or -WIDTHxHEIGHT.png
        const fixedDimensionPattern = /-\d+x\d+\.(jpg|png|jpeg|webp)/i;
        if (fixedDimensionPattern.test(url)) {
            return url.replace(fixedDimensionPattern, '-1200x1600.$1');
        }

        // Fallback: return as-is
        return url;
    };

    const boxArtUrl = getHighResBoxArt(game.box_art_url);

    // Calculate claimable drops count and overall progress
    // IMPORTANT: Prefer per-drop embedded progress (drop.progress) because it comes directly
    // from the CampaignDetails GQL `timeBasedDrops.self` and is accurate even when the
    // separate `progress[]` array hasn't been populated yet.
    let claimableCount = 0;
    let inProgressCount = 0;
    let totalMinutesWatched = 0;
    let totalMinutesRequired = 0;

    const getProgressForDrop = (dropId: string, embedded?: DropProgress) => {
        return progress.find(p => p.drop_id === dropId) || embedded || null;
    };

    game.active_campaigns.forEach(campaign => {
        campaign.time_based_drops.forEach(drop => {
            const prog = getProgressForDrop(drop.id, drop.progress);
            if (!prog) return;

            const required = prog.required_minutes_watched || drop.required_minutes_watched || 0;
            // If claimed, treat it as fully completed for summary purposes
            const current = prog.is_claimed ? required : (prog.current_minutes_watched || 0);

            if (required > 0) {
                totalMinutesRequired += required;
                totalMinutesWatched += Math.min(current, required);
            }

            // Claimable = 100% watched but not claimed
            if (!prog.is_claimed && required > 0 && current >= required) {
                claimableCount++;
            } else if (!prog.is_claimed && current > 0 && required > 0 && current < required) {
                inProgressCount++;
            }
        });
    });

    // Use mining progress if available, otherwise use calculated progress
    const progressPercent = miningProgress
        ? Math.min(100, Math.round((miningProgress.current / miningProgress.required) * 100))
        : totalMinutesRequired > 0
            ? Math.min(100, Math.round((totalMinutesWatched / totalMinutesRequired) * 100))
            : 0;

    // Calculate time remaining for current mining drop
    const timeRemaining = miningProgress
        ? Math.max(0, miningProgress.required - miningProgress.current)
        : 0;

    // Count total active drops and categorize by type
    let timeBasedDropCount = 0;
    let paidDropCount = 0;
    game.active_campaigns.forEach(campaign => {
        campaign.time_based_drops.forEach(drop => {
            const required = drop.required_minutes_watched || 0;
            if (required > 0) {
                timeBasedDropCount++;
            } else {
                // Drops with 0 required minutes are subscription/paid drops
                paidDropCount++;
            }
        });
    });
    const totalActiveDrops = timeBasedDropCount + paidDropCount;

    // Count campaigns
    const campaignCount = game.active_campaigns.length;

    // Dynamic font sizing effect - shrinks font to fit without wrapping
    useEffect(() => {
        const titleEl = titleRef.current;
        const containerEl = containerRef.current;
        if (!titleEl || !containerEl) return;

        // Reset to max size to measure
        let currentSize = 14;
        titleEl.style.fontSize = `${currentSize}px`;

        // Get container width (with padding accounted for)
        const containerWidth = containerEl.clientWidth;

        // Shrink font until text fits or we hit minimum
        const minSize = 9;
        while (titleEl.scrollWidth > containerWidth && currentSize > minSize) {
            currentSize -= 0.5;
            titleEl.style.fontSize = `${currentSize}px`;
        }

        setFontSize(currentSize);
    }, [game.name]);

    return (
        <div
            onClick={onClick}
            className={`glass-panel cursor-pointer hover:bg-glass-hover transition-all duration-200 group overflow-hidden relative
                ${isSelected ? 'ring-2 ring-accent' : 'hover:ring-1 hover:ring-accent/40'}
                ${isMining ? 'ring-2 ring-accent-neon mining-shimmer-overlay' : ''}
            `}
        >
            {/* Image Container */}
            <div className="relative overflow-hidden">
                <img
                    src={boxArtUrl}
                    alt={game.name}
                    className="w-full aspect-[3/4] object-cover group-hover:scale-105 transition-transform duration-200"
                    loading="lazy"
                />

                {/* Top-Left: Status Badges - only READY (removed MINING badge) */}
                <div className="absolute top-2 left-2 z-10 flex flex-col gap-1.5">
                    {/* Claimable badge */}
                    {claimableCount > 0 && (
                        <div className="drops-badge-glass-lg !bg-green-600/50 !border-green-500/70">
                            <Check size={14} className="text-green-200" />
                            <span className="text-green-200">{claimableCount} READY</span>
                        </div>
                    )}
                </div>

                {/* Top-Right: Favorite heart + Inventory badge */}
                <div className="absolute top-2 right-2 z-10 flex flex-col gap-1.5">
                    {/* Favorite heart button */}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            if (onToggleFavorite) onToggleFavorite(game.name);
                        }}
                        className={`w-7 h-7 rounded-full glass-panel flex items-center justify-center border transition-all ${
                            isFavorite 
                                ? 'border-red-500/70 bg-red-500/30 hover:bg-red-500/50' 
                                : 'border-borderLight/40 bg-glass hover:bg-glass-hover hover:border-red-500/40'
                        }`}
                        title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                    >
                        <Heart 
                            size={14} 
                            className={isFavorite ? 'text-red-400' : 'text-textSecondary'} 
                            fill={isFavorite ? 'currentColor' : 'none'}
                        />
                    </button>
                    {/* Inventory badge */}
                    {game.inventory_items.length > 0 && (
                        <div className="w-7 h-7 rounded-full glass-panel flex items-center justify-center border border-purple-500/40 bg-purple-500/30">
                            <Package size={14} className="text-purple-200" />
                        </div>
                    )}
                </div>
            </div>

            {/* Chin Section */}
            <div className="p-2" ref={containerRef}>
                {/* Game Name - dynamic font sizing, no wrapping */}
                <h3
                    ref={titleRef}
                    className="text-textPrimary font-medium whitespace-nowrap overflow-hidden group-hover:text-accent transition-colors"
                    style={{ fontSize: `${fontSize}px` }}
                    title={game.name}
                >
                    {game.name}
                </h3>

                {/* Mining State: Show progress info with drop reward */}
                {isMining ? (
                    <div className="mt-1.5 space-y-1.5">
                        {/* Drop reward info row */}
                        <div className="flex items-center gap-2">
                            {/* Drop reward image */}
                            {miningDropBenefitImage && (
                                <img
                                    src={miningDropBenefitImage}
                                    alt={miningDropBenefitName}
                                    className="w-8 h-8 rounded object-cover border border-accent-neon/60 shrink-0"
                                />
                            )}
                            <div className="flex-1 min-w-0 space-y-1">
                                {/* Drop name */}
                                <p className="text-[10px] text-accent-neon truncate" title={miningDropBenefitName}>
                                    {miningDropBenefitName}
                                </p>
                                {/* Progress bar with stop button */}
                                <div className="flex items-center gap-1.5">
                                    <div className="flex-1 h-1.5 bg-black/30 rounded-full overflow-hidden">
                                        <div
                                            className="h-full mining-progress-bar rounded-full transition-all duration-500"
                                            style={{ width: `${progressPercent}%` }}
                                        />
                                    </div>
                                    {/* Stop button */}
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (onStopMining) onStopMining();
                                        }}
                                        className="w-5 h-5 flex items-center justify-center rounded bg-red-500/20 hover:bg-red-500/40 border border-red-500/40 hover:border-red-500/60 transition-all shrink-0"
                                        title="Stop mining"
                                    >
                                        <Square size={10} className="text-red-400" fill="currentColor" />
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Progress info row */}
                        <div className="flex items-center justify-between text-[10px]">
                            <span className="text-accent-neon font-semibold">
                                {progressPercent}%
                            </span>
                            <span className="flex items-center gap-0.5 text-accent-neon">
                                <Clock size={9} />
                                {formatTimeRemaining(timeRemaining)} left
                            </span>
                        </div>
                    </div>
                ) : (
                    /* Normal State: Show campaign/drop info with Mine All button */
                    <div className="flex items-center justify-between mt-0.5">
                        <div className="flex items-center gap-2 text-textSecondary text-xs min-w-0">
                            {/* Campaign count */}
                            {campaignCount > 0 && (
                                <span className="text-accent">
                                    {campaignCount} campaign{campaignCount !== 1 ? 's' : ''}
                                </span>
                            )}

                            {/* Active drops count */}
                            {totalActiveDrops > 0 && campaignCount > 0 && (
                                <span className="text-textMuted">•</span>
                            )}
                            {totalActiveDrops > 0 && (
                                <span>{totalActiveDrops} drop{totalActiveDrops !== 1 ? 's' : ''}</span>
                            )}

                            {/* In Progress indicator (time-based drops with progress) */}
                            {inProgressCount > 0 && (
                                <span className="flex items-center gap-0.5 text-yellow-400" title="Drops in progress">
                                    <Clock size={10} />
                                    {inProgressCount}
                                </span>
                            )}

                            {/* Time-based drops indicator (only show if not showing in-progress) */}
                            {inProgressCount === 0 && timeBasedDropCount > 0 && (
                                <span className="flex items-center gap-0.5 text-blue-400" title={`${timeBasedDropCount} time-based drop${timeBasedDropCount !== 1 ? 's' : ''}`}>
                                    <Clock size={10} />
                                    {timeBasedDropCount}
                                </span>
                            )}

                            {/* Paid/subscription drops indicator */}
                            {paidDropCount > 0 && (
                                <span className="flex items-center gap-0.5 text-green-400" title={`${paidDropCount} subscription/paid drop${paidDropCount !== 1 ? 's' : ''}`}>
                                    <DollarSign size={10} />
                                    {paidDropCount}
                                </span>
                            )}

                            {/* Claimed count (only show if no active drops) */}
                            {game.total_claimed > 0 && !totalActiveDrops && (
                                <span className="text-purple-400">
                                    {game.total_claimed} collected
                                </span>
                            )}
                        </div>

                        {/* Mine All button removed - users can click into game details to start mining specific campaigns */}
                    </div>
                )}
            </div>
        </div>
    );
}
