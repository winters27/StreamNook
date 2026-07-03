import { useState } from 'react';
import { Pause, Pickaxe, Gift, TrendingUp, Clock, Award } from 'lucide-react';
import type { DropsStatistics, DropProgressStatus } from '../../types';
import ChannelPointsLeaderboard from '../ChannelPointsLeaderboard';
import { useAppStore } from '../../stores/AppStore';

interface DropsStatsTabProps {
    statistics: DropsStatistics | null;
    dropProgress: DropProgressStatus | null;
    onStopAutomation: () => void;
    onStreamClick: (channelName: string) => void;
}

export default function DropsStatsTab({
    statistics,
    dropProgress,
    onStopAutomation,
    onStreamClick
}: DropsStatsTabProps) {
    // Stop only applies when a provider is driving; native watch-to-earn stops
    // by not watching.
    const externalDropsProvider = useAppStore((s) => s.externalDropsProvider);
    // Account-wide channel points (sum across every followed channel), reported
    // by the leaderboard below once it pulls the full balance set. Falls back to
    // the session/collected figure until that first load lands.
    const [channelPointsTotal, setChannelPointsTotal] = useState<number | null>(null);
    if (!statistics) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center glass-panel p-8">
                    <Gift size={48} className="mx-auto text-textSecondary opacity-40 mb-4" />
                    <h3 className="text-lg font-bold text-textPrimary mb-2">No Statistics Yet</h3>
                    <p className="text-sm text-textSecondary">
                        Start collecting drops to see your statistics here.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full overflow-y-auto p-6 custom-scrollbar animate-in fade-in">
            <div className="max-w-4xl mx-auto space-y-6">
                {/* Stats Grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <StatCard
                        icon={<Gift size={20} />}
                        value={statistics.total_drops_claimed}
                        label="Drops Claimed"
                        color="accent"
                    />
                    <StatCard
                        icon={<Award size={20} />}
                        value={(channelPointsTotal ?? statistics.total_channel_points_earned).toLocaleString()}
                        label="Channel Points"
                        color="purple"
                    />
                    <StatCard
                        icon={<TrendingUp size={20} />}
                        value={statistics.active_campaigns}
                        label="Available Campaigns"
                        color="green"
                    />
                    <StatCard
                        icon={<Clock size={20} />}
                        value={statistics.drops_in_progress}
                        label="In Progress"
                        color="blue"
                    />
                </div>

                {/* Active Automation Status Card */}
                {dropProgress?.active && dropProgress.current_channel && (
                    <div className="glass-panel p-6 border border-green-500/30 bg-green-500/5 relative overflow-hidden group">
                        {/* Background decoration */}
                        <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                            <Pickaxe size={80} />
                        </div>

                        <h4 className="text-lg font-bold text-green-400 mb-4 flex items-center gap-2">
                            <span className="relative flex h-3 w-3">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
                            </span>
                            Currently Collecting
                        </h4>

                        <div className="space-y-3 text-sm relative z-10">
                            {/* Channel */}
                            <div className="flex justify-between items-center border-b border-green-500/10 pb-3">
                                <span className="text-textSecondary">Channel</span>
                                <span className="text-textPrimary font-medium font-mono">
                                    {dropProgress.current_channel.display_name || dropProgress.current_channel.name}
                                </span>
                            </div>

                            {/* Campaign */}
                            {dropProgress.current_campaign && (
                                <div className="flex justify-between items-center border-b border-green-500/10 pb-3">
                                    <span className="text-textSecondary">Campaign</span>
                                    <span className="text-textPrimary font-medium font-mono truncate max-w-[200px]">
                                        {dropProgress.current_campaign}
                                    </span>
                                </div>
                            )}

                            {/* Current Drop */}
                            {dropProgress.current_drop && (
                                <>
                                    <div className="flex justify-between items-center border-b border-green-500/10 pb-3">
                                        <span className="text-textSecondary">Current Drop</span>
                                        <span className="text-textPrimary font-medium font-mono truncate max-w-[200px]">
                                            {dropProgress.current_drop.drop_name}
                                        </span>
                                    </div>

                                    {/* Progress */}
                                    <div className="pt-2">
                                        <div className="flex justify-between text-xs text-textSecondary mb-2">
                                            <span>Progress</span>
                                            <span className="font-mono text-green-400">
                                                {dropProgress.current_drop.current_minutes}/{dropProgress.current_drop.required_minutes}m
                                            </span>
                                        </div>
                                        <div className="h-2.5 w-full bg-black/30 rounded-full overflow-hidden">
                                            <div
                                                className="h-full rounded-full animate-progress-shimmer"
                                                style={{
                                                    width: `${Math.min(
                                                        (dropProgress.current_drop.current_minutes / dropProgress.current_drop.required_minutes) * 100,
                                                        100
                                                    )}%`
                                                }}
                                            />
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>

                        {/* Stop Button — only when a provider is driving. */}
                        {externalDropsProvider && (
                        <div className="mt-4 flex justify-end">
                            <button
                                onClick={onStopAutomation}
                                className="glass-button px-4 py-2 text-xs font-semibold text-red-300 flex items-center gap-2"
                            >
                                <Pause size={14} />
                                Stop
                            </button>
                        </div>
                        )}
                    </div>
                )}

                {/* Idle State */}
                {!dropProgress?.active && (
                    <div className="glass-panel p-6 border border-dashed border-borderLight text-center">
                        <Pickaxe size={32} className="mx-auto text-textSecondary opacity-40 mb-3" />
                        <p className="text-sm text-textSecondary">
                            Not currently earning any drops. Pick a game and watch to earn.
                        </p>
                    </div>
                )}

                {/* Channel Points Leaderboard */}
                <div className="glass-panel p-6">
                    <ChannelPointsLeaderboard
                        onStreamClick={onStreamClick}
                        onTotalsChange={(total) => setChannelPointsTotal(total)}
                    />
                </div>
            </div>
        </div>
    );
}

// Sub-component for stat cards
interface StatCardProps {
    icon: React.ReactNode;
    value: string | number;
    label: string;
    color: 'accent' | 'purple' | 'green' | 'blue';
}

function StatCard({ icon, value, label, color }: StatCardProps) {
    const colorClasses = {
        accent: 'text-accent border-accent/20 hover:border-accent/40',
        purple: 'text-purple-400 border-purple-400/20 hover:border-purple-400/40',
        green: 'text-green-400 border-green-400/20 hover:border-green-400/40',
        blue: 'text-blue-400 border-blue-400/20 hover:border-blue-400/40',
    };

    return (
        <div className={`glass-panel p-5 text-center border transition-all ${colorClasses[color]}`}>
            <div className={`mx-auto mb-2 ${colorClasses[color].split(' ')[0]}`}>
                {icon}
            </div>
            <div className="text-3xl font-bold text-textPrimary mb-1">{value}</div>
            <div className="text-xs text-textSecondary uppercase tracking-wider font-semibold">
                {label}
            </div>
        </div>
    );
}
