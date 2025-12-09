import { useRef, useEffect, useState } from 'react';
import { Check, Clock, Package, Square, Play } from 'lucide-react';
import type { UnifiedGame, DropProgress, MiningStatus } from '../../types';

interface GameCardProps {
    game: UnifiedGame;
    allGames: UnifiedGame[]; // All games for global drop metadata lookup
    progress: DropProgress[];
    miningStatus: MiningStatus | null;
    isSelected: boolean;
    onClick: () => void;
    onStopMining?: () => void;
    onMineAllGame?: (gameName: string, campaignIds: string[]) => void;
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
    onClick,
    onStopMining,
    onMineAllGame
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

        // Get all active (not claimed, not complete) progress entries
        const activeProgressEntries = progress.filter(p =>
            !p.is_claimed &&
            p.current_minutes_watched > 0 &&
            p.current_minutes_watched < p.required_minutes_watched
        );

        if (activeProgressEntries.length === 0) {
            // Fall back to miningStatus.current_drop
            if (miningStatus?.current_drop) {
                const { drop_id, current_minutes, required_minutes } = miningStatus.current_drop;
                const metadata = globalDropMap.get(drop_id);
                return {
                    dropId: drop_id,
                    current: current_minutes ?? 0,
                    required: required_minutes ?? 1,
                    benefitImage: metadata?.benefitImage || '',
                    benefitName: metadata?.benefitName || miningStatus.current_drop.drop_name || 'Drop'
                };
            }
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

        const metadata = globalDropMap.get(bestDrop.drop_id);
        return {
            dropId: bestDrop.drop_id,
            current: bestDrop.current_minutes_watched,
            required: bestDrop.required_minutes_watched,
            benefitImage: metadata?.benefitImage || '',
            benefitName: metadata?.benefitName || 'Drop in progress'
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
    let claimableCount = 0;
    let inProgressCount = 0;
    let totalMinutesWatched = 0;
    let totalMinutesRequired = 0;

    game.active_campaigns.forEach(campaign => {
        campaign.time_based_drops.forEach(drop => {
            const prog = progress.find(p => p.drop_id === drop.id);
            if (prog && !prog.is_claimed) {
                totalMinutesWatched += prog.current_minutes_watched;
                totalMinutesRequired += prog.required_minutes_watched;
                if (prog.current_minutes_watched >= prog.required_minutes_watched) {
                    claimableCount++;
                } else if (prog.current_minutes_watched > 0) {
                    inProgressCount++;
                }
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

    // Count total active drops
    const totalActiveDrops = game.active_campaigns.reduce(
        (sum, c) => sum + c.time_based_drops.length, 0
    );

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

                {/* Top-Right: Inventory badge */}
                {game.inventory_items.length > 0 && (
                    <div className="absolute top-2 right-2 z-10">
                        <div className="w-7 h-7 rounded-full glass-panel flex items-center justify-center border border-purple-500/40 bg-purple-500/30">
                            <Package size={14} className="text-purple-200" />
                        </div>
                    </div>
                )}
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

                            {/* In Progress indicator */}
                            {inProgressCount > 0 && (
                                <span className="flex items-center gap-0.5 text-yellow-400">
                                    <Clock size={10} />
                                    {inProgressCount}
                                </span>
                            )}

                            {/* Claimed count (only show if no active drops) */}
                            {game.total_claimed > 0 && !totalActiveDrops && (
                                <span className="text-purple-400">
                                    {game.total_claimed} collected
                                </span>
                            )}
                        </div>

                        {/* Mine All Button - only shows when no mining is happening */}
                        {campaignCount > 0 && onMineAllGame && !miningStatus?.is_mining && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    const campaignIds = game.active_campaigns.map(c => c.id);
                                    onMineAllGame(game.name, campaignIds);
                                }}
                                className="flex items-center gap-1 px-2 py-1 rounded-md bg-accent/20 hover:bg-accent/40 active:bg-accent/50 text-accent border border-accent/40 hover:border-accent/70 shadow-sm hover:shadow-md hover:shadow-accent/20 transform hover:scale-105 active:scale-95 transition-all duration-150 shrink-0"
                                title={`Mine all ${campaignCount} campaign${campaignCount !== 1 ? 's' : ''} for ${game.name}`}
                            >
                                <Play size={10} fill="currentColor" />
                                <span className="text-[10px] font-semibold">Mine</span>
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
