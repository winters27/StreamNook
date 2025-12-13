import { useState, useMemo, useCallback } from 'react';
import { Package, Gift, Check, Clock, AlertCircle, ChevronDown, ChevronRight, Search, Filter, Sparkles, Ban, Star } from 'lucide-react';
import type { InventoryItem, DropProgress, CampaignStatus, CompletedDrop, TimeBasedDrop } from '../../types';

// Helper to check if a drop is mineable (time-based with watch requirement)
// Drops with required_minutes_watched = 0 are event-based, gift-based, or sub-based
function isDropMineable(drop: TimeBasedDrop): boolean {
    // If is_mineable is explicitly set, use it
    if (typeof drop.is_mineable === 'boolean') {
        return drop.is_mineable;
    }
    
    // Check if required_minutes_watched is set and > 0
    if (drop.required_minutes_watched > 0) {
        return true;
    }
    
    // Check if the drop has progress data with required_minutes
    if (drop.progress && drop.progress.required_minutes_watched > 0) {
        return true;
    }
    
    // Default: not mineable if we can't determine watch time requirement
    return false;
}

interface DropsInventoryTabProps {
    inventoryItems: InventoryItem[];
    completedDrops: CompletedDrop[];
    progress: DropProgress[];
    onClaimDrop: (dropId: string, dropInstanceId?: string) => void;
}

type FilterStatus = 'all' | 'claimable' | 'in_progress' | 'claimed' | 'expired';

export default function DropsInventoryTab({
    inventoryItems,
    completedDrops,
    progress,
    onClaimDrop
}: DropsInventoryTabProps) {
    const [expandedGames, setExpandedGames] = useState<Set<string>>(new Set());
    const [showCompletedDrops, setShowCompletedDrops] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');

    // Group inventory items by game
    const gameGroups = useMemo(() => {
        const groups = new Map<string, {
            gameName: string;
            gameId: string;
            boxArtUrl: string;
            items: InventoryItem[];
            totalDrops: number;
            claimedDrops: number;
            claimableDrops: number;
            inProgressDrops: number;
            hasExpired: boolean;
        }>();

        inventoryItems.forEach(item => {
            const gameId = item.campaign.game_id || `game-${item.campaign.game_name}`;
            const gameName = item.campaign.game_name;

            if (!groups.has(gameId)) {
                groups.set(gameId, {
                    gameName,
                    gameId,
                    boxArtUrl: item.campaign.image_url,
                    items: [],
                    totalDrops: 0,
                    claimedDrops: 0,
                    claimableDrops: 0,
                    inProgressDrops: 0,
                    hasExpired: false
                });
            }

            const group = groups.get(gameId)!;
            group.items.push(item);
            group.totalDrops += item.total_drops;
            group.claimedDrops += item.claimed_drops;

            if (item.status === 'Expired') {
                group.hasExpired = true;
            }

            // Count claimable and in-progress drops
            item.campaign.time_based_drops.forEach(drop => {
                const dropProgress = drop.progress || progress.find(p => p.drop_id === drop.id);
                
                // Only count mineable (time-based) drops for claimable/in-progress stats
                const mineable = isDropMineable(drop);
                
                if (dropProgress && mineable) {
                    const requiredMins = dropProgress.required_minutes_watched || drop.required_minutes_watched;
                    const isComplete = requiredMins > 0 && dropProgress.current_minutes_watched >= requiredMins;
                    if (isComplete && !dropProgress.is_claimed) {
                        group.claimableDrops++;
                    } else if (!isComplete && dropProgress.current_minutes_watched > 0) {
                        group.inProgressDrops++;
                    }
                }
            });
        });

        return Array.from(groups.values()).sort((a, b) => {
            // Sort by claimable first, then by name
            if (a.claimableDrops !== b.claimableDrops) return b.claimableDrops - a.claimableDrops;
            return a.gameName.localeCompare(b.gameName);
        });
    }, [inventoryItems, progress]);

    // Filter games based on search and status filter
    const filteredGroups = useMemo(() => {
        return gameGroups.filter(group => {
            // Search filter
            if (searchTerm) {
                const lowerSearch = searchTerm.toLowerCase();
                const matchesGame = group.gameName.toLowerCase().includes(lowerSearch);
                const matchesCampaign = group.items.some(item =>
                    item.campaign.name.toLowerCase().includes(lowerSearch)
                );
                if (!matchesGame && !matchesCampaign) return false;
            }

            // Status filter
            switch (filterStatus) {
                case 'claimable':
                    return group.claimableDrops > 0;
                case 'in_progress':
                    return group.inProgressDrops > 0;
                case 'claimed':
                    return group.claimedDrops > 0;
                case 'expired':
                    return group.hasExpired;
                default:
                    return true;
            }
        });
    }, [gameGroups, searchTerm, filterStatus]);

    const toggleGameExpanded = (gameId: string) => {
        setExpandedGames(prev => {
            const next = new Set(prev);
            if (next.has(gameId)) {
                next.delete(gameId);
            } else {
                next.add(gameId);
            }
            return next;
        });
    };

    // Get all claimable drops for a game group (only mineable drops)
    const getClaimableDropsForGame = useCallback((group: typeof gameGroups[0]) => {
        const claimableDrops: { dropId: string; dropInstanceId?: string }[] = [];

        group.items.forEach(item => {
            item.campaign.time_based_drops.forEach(drop => {
                // Only include mineable (time-based) drops
                const mineable = isDropMineable(drop);
                if (!mineable) return;
                
                const dropProgress = drop.progress || progress.find(p => p.drop_id === drop.id);
                if (dropProgress) {
                    const requiredMins = dropProgress.required_minutes_watched || drop.required_minutes_watched;
                    const isComplete = requiredMins > 0 && dropProgress.current_minutes_watched >= requiredMins;
                    if (isComplete && !dropProgress.is_claimed) {
                        claimableDrops.push({
                            dropId: drop.id,
                            dropInstanceId: dropProgress.drop_instance_id
                        });
                    }
                }
            });
        });

        return claimableDrops;
    }, [progress]);

    // Claim all drops for a game (with delay between claims)
    const [claimingGameId, setClaimingGameId] = useState<string | null>(null);

    const handleClaimAllForGame = useCallback(async (gameId: string, _gameName: string) => {
        const group = gameGroups.find(g => g.gameId === gameId);
        if (!group) return;

        const claimableDrops = getClaimableDropsForGame(group);
        if (claimableDrops.length === 0) return;

        setClaimingGameId(gameId);

        // Claim each drop with a small delay to avoid rate limiting
        for (let i = 0; i < claimableDrops.length; i++) {
            const { dropId, dropInstanceId } = claimableDrops[i];
            onClaimDrop(dropId, dropInstanceId);

            // Add 500ms delay between claims (except for last one)
            if (i < claimableDrops.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        setClaimingGameId(null);
    }, [gameGroups, getClaimableDropsForGame, onClaimDrop]);

    // Calculate totals
    const totals = useMemo(() => {
        let total = 0;
        let claimed = 0;
        let claimable = 0;
        let inProgress = 0;

        gameGroups.forEach(group => {
            total += group.totalDrops;
            claimed += group.claimedDrops;
            claimable += group.claimableDrops;
            inProgress += group.inProgressDrops;
        });

        return { total, claimed, claimable, inProgress };
    }, [gameGroups]);

    // Transform box art URL to higher resolution
    const getHighResBoxArt = (url: string | undefined): string => {
        if (!url) return 'https://static-cdn.jtvnw.net/ttv-static/404_boxart-144x192.jpg';

        if (url.includes('{width}') && url.includes('{height}')) {
            return url.replace('{width}', '144').replace('{height}', '192');
        }

        const fixedDimensionPattern = /-\d+x\d+\.(jpg|png|jpeg|webp)/i;
        if (fixedDimensionPattern.test(url)) {
            return url.replace(fixedDimensionPattern, '-144x192.$1');
        }

        return url;
    };

    const getStatusBadge = (status: CampaignStatus) => {
        switch (status) {
            case 'Active':
                return (
                    <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-green-500/20 text-green-400 border border-green-500/30">
                        Active
                    </span>
                );
            case 'Upcoming':
                return (
                    <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">
                        Upcoming
                    </span>
                );
            case 'Expired':
                return (
                    <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-gray-500/20 text-gray-400 border border-gray-500/30">
                        Expired
                    </span>
                );
        }
    };

    if (inventoryItems.length === 0) {
        return (
            <div className="h-full flex items-center justify-center p-8">
                <div className="text-center glass-panel p-8 max-w-sm">
                    <Package size={48} className="mx-auto text-textSecondary opacity-40 mb-4" />
                    <h3 className="text-lg font-bold text-textPrimary mb-2">No Inventory Items</h3>
                    <p className="text-sm text-textSecondary">
                        Your drops inventory is empty. Start watching streams with drops enabled to earn rewards!
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col">
            {/* Header Stats */}
            <div className="px-4 pt-4 pb-3 border-b border-borderLight bg-backgroundSecondary/50">
                <div className="grid grid-cols-4 gap-3 mb-4">
                    <div className="glass-panel p-3 text-center">
                        <div className="text-2xl font-bold text-textPrimary">{totals.total}</div>
                        <div className="text-xs text-textSecondary">Total Drops</div>
                    </div>
                    <div className="glass-panel p-3 text-center border-green-500/20">
                        <div className="text-2xl font-bold text-green-400">{totals.claimed}</div>
                        <div className="text-xs text-textSecondary">Claimed</div>
                    </div>
                    <div className="glass-panel p-3 text-center border-yellow-500/20">
                        <div className="text-2xl font-bold text-yellow-400">{totals.claimable}</div>
                        <div className="text-xs text-textSecondary">Ready to Claim</div>
                    </div>
                    <div className="glass-panel p-3 text-center border-accent/20">
                        <div className="text-2xl font-bold text-accent">{totals.inProgress}</div>
                        <div className="text-xs text-textSecondary">In Progress</div>
                    </div>
                </div>

                {/* Search and Filter */}
                <div className="flex items-center gap-3">
                    <div className="relative flex-1">
                        <input
                            type="text"
                            placeholder="Search games or campaigns..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full bg-background border border-borderLight rounded-lg pl-9 pr-4 py-2 text-sm focus:border-accent focus:outline-none"
                        />
                        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-textSecondary" />
                    </div>
                    <div className="relative">
                        <select
                            value={filterStatus}
                            onChange={(e) => setFilterStatus(e.target.value as FilterStatus)}
                            className="appearance-none bg-background border border-borderLight rounded-lg pl-9 pr-8 py-2 text-sm focus:border-accent focus:outline-none cursor-pointer"
                        >
                            <option value="all">All Drops</option>
                            <option value="claimable">Ready to Claim</option>
                            <option value="in_progress">In Progress</option>
                            <option value="claimed">Claimed</option>
                            <option value="expired">Expired Campaigns</option>
                        </select>
                        <Filter size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-textSecondary pointer-events-none" />
                        <ChevronDown size={16} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-textSecondary pointer-events-none" />
                    </div>
                </div>
            </div>

            {/* Games List */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3">
                {/* Completed Drops Section */}
                {completedDrops.length > 0 && (
                    <div className="glass-panel border border-green-500/30 overflow-hidden">
                        <button
                            onClick={() => setShowCompletedDrops(!showCompletedDrops)}
                            className="w-full flex items-center justify-between gap-3 p-3 hover:bg-surface/50 transition-colors"
                        >
                            <div className="flex items-center gap-3">
                                <div className="p-2 rounded-lg bg-green-500/20 border border-green-500/30">
                                    <Check size={20} className="text-green-400" />
                                </div>
                                <div className="text-left">
                                    <h3 className="font-bold text-textPrimary">Completed Drops</h3>
                                    <p className="text-xs text-textSecondary">
                                        {completedDrops.length} drop{completedDrops.length !== 1 ? 's' : ''} you've earned across all campaigns
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="px-2 py-1 text-xs font-bold rounded-lg bg-green-500/20 text-green-400 border border-green-500/30">
                                    {completedDrops.length} total
                                </span>
                                {showCompletedDrops ? (
                                    <ChevronDown size={18} className="text-textSecondary" />
                                ) : (
                                    <ChevronRight size={18} className="text-textSecondary" />
                                )}
                            </div>
                        </button>
                        
                        {showCompletedDrops && (
                            <div className="border-t border-green-500/20 bg-background/50 p-3">
                                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                                    {completedDrops.map(drop => (
                                        <div
                                            key={drop.id}
                                            className="group glass-panel border border-green-500/20 hover:border-green-500/40 rounded-lg overflow-hidden transition-all hover:scale-105"
                                            title={`${drop.name}${drop.game_name ? ` - ${drop.game_name}` : ''}${drop.total_count > 1 ? ` (x${drop.total_count})` : ''}`}
                                        >
                                            {/* Drop Image */}
                                            <div className="relative aspect-square bg-backgroundSecondary">
                                                <img
                                                    src={drop.image_url}
                                                    alt={drop.name}
                                                    className="w-full h-full object-contain"
                                                    loading="lazy"
                                                />
                                                {/* Completed Overlay */}
                                                <div className="absolute inset-0 bg-green-500/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <div className="w-10 h-10 rounded-full bg-green-500 flex items-center justify-center">
                                                        <Check size={20} className="text-white" />
                                                    </div>
                                                </div>
                                                {/* Count Badge */}
                                                {drop.total_count > 1 && (
                                                    <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded-full bg-green-500 text-white text-[10px] font-bold shadow-lg">
                                                        x{drop.total_count}
                                                    </div>
                                                )}
                                            </div>
                                            {/* Drop Info */}
                                            <div className="p-2">
                                                <p className="text-xs font-medium text-textPrimary truncate" title={drop.name}>
                                                    {drop.name}
                                                </p>
                                                {drop.game_name && (
                                                    <p className="text-[10px] text-textSecondary truncate mt-0.5">
                                                        {drop.game_name}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {filteredGroups.length === 0 ? (
                    <div className="text-center py-12">
                        <Package size={32} className="mx-auto text-textSecondary opacity-40 mb-3" />
                        <p className="text-textSecondary text-sm">No items match your filters</p>
                    </div>
                ) : (
                    filteredGroups.map(group => {
                        const isExpanded = expandedGames.has(group.gameId);

                        return (
                            <div key={group.gameId} className="glass-panel border border-borderLight overflow-hidden">
                                {/* Game Header - Clickable */}
                                <button
                                    onClick={() => toggleGameExpanded(group.gameId)}
                                    className="w-full flex items-center gap-3 p-3 hover:bg-surface/50 transition-colors"
                                >
                                    {/* Box Art */}
                                    <img
                                        src={getHighResBoxArt(group.boxArtUrl)}
                                        alt={group.gameName}
                                        className="w-12 h-16 rounded-lg object-cover border border-borderLight shadow-md shrink-0"
                                    />

                                    {/* Game Info */}
                                    <div className="flex-1 text-left min-w-0">
                                        <h3 className="font-bold text-textPrimary truncate">
                                            {group.gameName}
                                        </h3>
                                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                                            <span className="text-xs text-textSecondary">
                                                {group.items.length} campaign{group.items.length !== 1 ? 's' : ''}
                                            </span>
                                            <span className="text-xs text-textMuted">•</span>
                                            <span className="text-xs text-textSecondary">
                                                {group.claimedDrops}/{group.totalDrops} drops claimed
                                            </span>
                                        </div>
                                    </div>

                                    {/* Status Indicators */}
                                    <div className="flex items-center gap-2 shrink-0">
                                        {group.claimableDrops > 0 && (
                                            <>
                                                <span className="px-2 py-1 text-xs font-bold rounded-lg bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 animate-pulse">
                                                    {group.claimableDrops} to claim
                                                </span>
                                                {/* Claim All Button */}
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleClaimAllForGame(group.gameId, group.gameName);
                                                    }}
                                                    disabled={claimingGameId === group.gameId}
                                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-md shrink-0
                                                        ${claimingGameId === group.gameId
                                                            ? 'bg-green-600/50 text-green-200 cursor-wait'
                                                            : 'bg-green-500 hover:bg-green-400 active:bg-green-600 text-white hover:shadow-lg hover:shadow-green-500/20 transform hover:scale-105 active:scale-95'
                                                        }`}
                                                    title={`Claim all ${group.claimableDrops} drops for ${group.gameName}`}
                                                >
                                                    {claimingGameId === group.gameId ? (
                                                        <>
                                                            <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                                            <span>Claiming...</span>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Sparkles size={12} />
                                                            <span>Claim All</span>
                                                        </>
                                                    )}
                                                </button>
                                            </>
                                        )}
                                        {group.inProgressDrops > 0 && (
                                            <span className="px-2 py-1 text-xs font-medium rounded-lg bg-accent/20 text-accent border border-accent/30">
                                                {group.inProgressDrops} in progress
                                            </span>
                                        )}
                                        {isExpanded ? (
                                            <ChevronDown size={18} className="text-textSecondary" />
                                        ) : (
                                            <ChevronRight size={18} className="text-textSecondary" />
                                        )}
                                    </div>
                                </button>

                                {/* Expanded Content */}
                                {isExpanded && (
                                    <div className="border-t border-borderLight bg-background/50 p-3 space-y-4">
                                        {group.items.map(item => (
                                            <CampaignSection
                                                key={item.campaign.id}
                                                item={item}
                                                progress={progress}
                                                onClaimDrop={onClaimDrop}
                                                getStatusBadge={getStatusBadge}
                                            />
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}

interface CampaignSectionProps {
    item: InventoryItem;
    progress: DropProgress[];
    onClaimDrop: (dropId: string, dropInstanceId?: string) => void;
    getStatusBadge: (status: CampaignStatus) => JSX.Element;
}

function CampaignSection({ item, progress, onClaimDrop, getStatusBadge }: CampaignSectionProps) {
    const campaign = item.campaign;
    const isExpired = item.status === 'Expired';

    // Format dates
    const formatDate = (dateString: string | Date) => {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    };

    return (
        <div className={`rounded-lg border ${isExpired ? 'border-gray-500/20 bg-gray-500/5' : 'border-borderLight bg-surface/30'} p-3`}>
            {/* Campaign Header */}
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 min-w-0">
                    <h4 className="font-semibold text-sm text-textPrimary truncate">
                        {campaign.name}
                    </h4>
                    {getStatusBadge(item.status)}
                </div>
                <div className="flex items-center gap-2 text-xs text-textMuted shrink-0">
                    <Clock size={12} />
                    <span>{formatDate(campaign.start_at)} - {formatDate(campaign.end_at)}</span>
                </div>
            </div>

            {/* Campaign Progress */}
            <div className="mb-3">
                <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-textSecondary">Campaign Progress</span>
                    <span className="text-textMuted font-mono">
                        {item.claimed_drops}/{item.total_drops} drops
                    </span>
                </div>
                <div className="h-1.5 w-full bg-background rounded-full overflow-hidden border border-borderLight">
                    <div
                        className={`h-full rounded-full transition-all ${isExpired ? 'bg-gray-500' : 'bg-green-500'}`}
                        style={{ width: `${item.progress_percentage}%` }}
                    />
                </div>
            </div>

            {/* Drops Grid */}
            <div className="space-y-2">
                {campaign.time_based_drops.map(drop => {
                    const dropProgress = drop.progress || progress.find(p => p.drop_id === drop.id);
                    const currentMinutes = dropProgress?.current_minutes_watched || 0;
                    const requiredMinutes = dropProgress?.required_minutes_watched || drop.required_minutes_watched;
                    
                    // Check if this drop is mineable (time-based with watch requirement)
                    const mineable = isDropMineable(drop);
                    
                    // For time-based drops: complete when watched >= required
                    // For non-time-based drops: never consider them "complete" via watching
                    const isComplete = mineable && requiredMinutes > 0 && currentMinutes >= requiredMinutes;
                    const isClaimed = dropProgress?.is_claimed || false;
                    
                    // Only claimable if: mineable, complete, and not already claimed
                    const isClaimable = isComplete && !isClaimed && mineable;
                    const progressPercent = requiredMinutes > 0 ? (currentMinutes / requiredMinutes) * 100 : 0;

                    const benefit = drop.benefit_edges[0];

                    return (
                        <div
                            key={drop.id}
                            className={`flex items-center gap-3 p-2 rounded-lg transition-all ${isClaimed
                                ? 'bg-green-500/10 border border-green-500/20'
                                : isClaimable
                                    ? 'bg-yellow-500/10 border border-yellow-500/30'
                                    : !mineable
                                        ? 'bg-purple-500/5 border border-purple-500/20'
                                        : 'bg-background/50 border border-borderLight'
                                }`}
                        >
                            {/* Benefit Image */}
                            <div className="relative w-10 h-10 rounded-lg shrink-0 overflow-hidden bg-backgroundSecondary border border-borderLight">
                                {benefit?.image_url ? (
                                    <img
                                        src={benefit.image_url}
                                        alt={benefit.name}
                                        className={`w-full h-full object-contain ${isClaimed ? 'opacity-60' : ''}`}
                                        loading="lazy"
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <Gift size={16} className="text-textSecondary" />
                                    </div>
                                )}
                                {isClaimed && (
                                    <div className="absolute inset-0 bg-green-500/40 flex items-center justify-center">
                                        <Check size={14} className="text-white" />
                                    </div>
                                )}
                                {isClaimable && (
                                    <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-yellow-500 flex items-center justify-center shadow-lg animate-pulse">
                                        <span className="text-[8px] font-bold text-black">!</span>
                                    </div>
                                )}
                                {/* Special indicator for non-mineable drops */}
                                {!mineable && !isClaimed && (
                                    <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-purple-500 flex items-center justify-center shadow-lg">
                                        <Star size={8} className="text-white" />
                                    </div>
                                )}
                            </div>

                            {/* Drop Info */}
                            <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-textPrimary truncate" title={benefit?.name || drop.name}>
                                    {benefit?.name || drop.name}
                                </p>
                                <div className="flex items-center gap-2 mt-0.5">
                                    {isClaimed ? (
                                        <span className="text-[10px] text-green-400 font-medium">Claimed</span>
                                    ) : isClaimable ? (
                                        <span className="text-[10px] text-yellow-400 font-semibold animate-pulse">Ready to claim!</span>
                                    ) : !mineable ? (
                                        // Non-mineable drop: show what's required
                                        <span className="text-[10px] text-purple-400 font-medium flex items-center gap-1">
                                            <Ban size={10} />
                                            Requires gift/sub or special action
                                        </span>
                                    ) : (
                                        // Normal time-based drop progress
                                        <>
                                            <div className="flex-1 h-1 bg-background rounded-full overflow-hidden border border-borderLight max-w-[100px]">
                                                <div
                                                    className="h-full bg-accent/60 rounded-full"
                                                    style={{ width: `${Math.min(progressPercent, 100)}%` }}
                                                />
                                            </div>
                                            <span className="text-[10px] text-textMuted font-mono">
                                                {Math.round(currentMinutes)}/{requiredMinutes}m
                                            </span>
                                        </>
                                    )}
                                </div>
                            </div>

                            {/* Claim Button - only for mineable drops that are complete */}
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

                            {/* Event/Special Badge for non-mineable drops */}
                            {!mineable && !isClaimed && (
                                <span className="px-2 py-1 text-[9px] font-semibold rounded bg-purple-500/20 text-purple-400 border border-purple-500/30 shrink-0 whitespace-nowrap">
                                    Event Only
                                </span>
                            )}

                            {/* Expired Warning for Claimable */}
                            {isExpired && isClaimable && (
                                <div className="flex items-center gap-1 text-orange-400" title="Campaign expired - claim before it's gone!">
                                    <AlertCircle size={14} />
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
