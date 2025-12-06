import { useState, useEffect } from 'react';
import { Users, Globe, Activity, RefreshCw, Clock, Calendar, Search, ExternalLink, TrendingUp, UserPlus, Repeat, Zap, MessageSquare, Eye, Tv, Coins, BarChart3, ChevronDown, ChevronUp } from 'lucide-react';
import {
    isSupabaseConfigured,
    getOnlineCount,
    subscribeToOnlineCount,
    getAllUsersWithStats,
    subscribeToStatsChanges,
    getGlobalStats,
    type UserWithStats,
    type GlobalStats
} from '../../services/supabaseService';

// Format relative time
const formatRelativeTime = (dateString: string): string => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
};

// Format date nicely
const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
};

// Format large numbers with K, M suffixes
const formatNumber = (num: number): string => {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toLocaleString();
};

// Format hours nicely
const formatHours = (hours: number): string => {
    if (hours >= 1000) return (hours / 1000).toFixed(1) + 'K hrs';
    if (hours >= 1) return hours.toFixed(1) + ' hrs';
    const minutes = Math.round(hours * 60);
    return minutes + ' min';
};

export default function AnalyticsSettings() {
    const [onlineCount, setOnlineCount] = useState(0);
    const [users, setUsers] = useState<UserWithStats[]>([]);
    const [globalStats, setGlobalStats] = useState<GlobalStats>({
        total_channel_points: 0,
        total_hours_watched: 0,
        total_messages_sent: 0,
        total_streams_watched: 0
    });
    const [isLoading, setIsLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
    const configured = isSupabaseConfigured();

    useEffect(() => {
        if (!configured) {
            setIsLoading(false);
            return;
        }

        setIsLoading(true);

        // Subscribe to real-time updates
        const unsubOnline = subscribeToOnlineCount((count) => {
            setOnlineCount(count);
            setLastUpdated(new Date());
        });

        const unsubStats = subscribeToStatsChanges((usersList, stats) => {
            setUsers(usersList);
            setGlobalStats(stats);
            setLastUpdated(new Date());
            setIsLoading(false);
        });

        return () => {
            if (unsubOnline) unsubOnline();
            if (unsubStats) unsubStats();
        };
    }, [configured]);

    const handleRefresh = async () => {
        if (!configured) return;
        setIsLoading(true);
        const usersList = await getAllUsersWithStats();
        const stats = await getGlobalStats();
        setUsers(usersList);
        setGlobalStats(stats);
        setOnlineCount(getOnlineCount());
        setLastUpdated(new Date());
        setIsLoading(false);
    };

    // Filter users based on search
    const filteredUsers = users.filter(user =>
        user.display_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        user.username.toLowerCase().includes(searchQuery.toLowerCase())
    );

    // Calculate stats
    const totalUsers = users.length;
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3600000);
    const dayAgo = new Date(now.getTime() - 86400000);
    const weekAgo = new Date(now.getTime() - 7 * 86400000);

    const recentUsers = users.filter(u => new Date(u.last_seen) > hourAgo).length;
    const newUsersToday = users.filter(u => new Date(u.created_at) > dayAgo).length;
    const newUsersThisWeek = users.filter(u => new Date(u.created_at) > weekAgo).length;

    // Returning users (users whose created_at is different from last_seen by more than 1 hour)
    const returningUsers = users.filter(u => {
        const created = new Date(u.created_at);
        const lastSeen = new Date(u.last_seen);
        return lastSeen.getTime() - created.getTime() > 3600000; // More than 1 hour difference
    }).length;

    // Most recent signup
    const newestUser = users.length > 0
        ? users.reduce((newest, u) => new Date(u.created_at) > new Date(newest.created_at) ? u : newest)
        : null;

    // User retention rate
    const retentionRate = totalUsers > 0 ? Math.round((returningUsers / totalUsers) * 100) : 0;

    if (!configured) {
        return (
            <div className="p-6">
                <div className="text-center py-16">
                    <div className="w-20 h-20 rounded-full bg-warning/20 flex items-center justify-center mx-auto mb-6">
                        <Activity className="w-10 h-10 text-warning" />
                    </div>
                    <h3 className="text-xl font-semibold text-textPrimary mb-3">Supabase Not Configured</h3>
                    <p className="text-textSecondary mb-8 max-w-md mx-auto">
                        Analytics features require Supabase configuration. Add your credentials to the .env file to enable real-time user tracking.
                    </p>
                    <div className="text-sm text-textMuted bg-glass rounded-xl p-6 text-left font-mono max-w-md mx-auto border border-borderSubtle">
                        <p className="mb-3 text-textSecondary font-sans">Add to your .env file:</p>
                        <p className="text-accent">VITE_SUPABASE_URL=...</p>
                        <p className="text-accent">VITE_SUPABASE_ANON_KEY=...</p>
                        <p className="text-accent">VITE_ADMIN_USER_ID=...</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="p-2">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h3 className="text-xl font-bold text-textPrimary">Analytics Dashboard</h3>
                    <p className="text-sm text-textSecondary">Real-time user analytics and community metrics</p>
                </div>
                <button
                    onClick={handleRefresh}
                    disabled={isLoading}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl glass-button text-textPrimary transition-all disabled:opacity-50"
                >
                    <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
                    <span className="text-sm font-medium">Refresh</span>
                </button>
            </div>

            {/* Global Stats Ticker */}
            <div className="mb-6 bg-gradient-to-r from-accent/10 via-purple-500/10 to-pink-500/10 rounded-xl p-4 border border-accent/20">
                <div className="flex items-center gap-2 mb-3">
                    <BarChart3 className="w-5 h-5 text-accent" />
                    <span className="text-sm font-semibold text-textPrimary">Community Stats (All Users Combined)</span>
                </div>
                <div className="grid grid-cols-4 gap-4">
                    {/* Channel Points Farmed */}
                    <div className="bg-glass/50 rounded-lg p-3 border border-borderSubtle/50">
                        <div className="flex items-center gap-2 mb-1">
                            <Coins className="w-4 h-4 text-yellow-500" />
                            <span className="text-xs text-textMuted">Channel Points</span>
                        </div>
                        {isLoading ? (
                            <div className="w-16 h-6 bg-borderSubtle rounded animate-pulse" />
                        ) : (
                            <span className="text-lg font-bold text-textPrimary">{formatNumber(globalStats.total_channel_points)}</span>
                        )}
                    </div>

                    {/* Hours Watched */}
                    <div className="bg-glass/50 rounded-lg p-3 border border-borderSubtle/50">
                        <div className="flex items-center gap-2 mb-1">
                            <Eye className="w-4 h-4 text-blue-500" />
                            <span className="text-xs text-textMuted">Hours Watched</span>
                        </div>
                        {isLoading ? (
                            <div className="w-16 h-6 bg-borderSubtle rounded animate-pulse" />
                        ) : (
                            <span className="text-lg font-bold text-textPrimary">{formatHours(globalStats.total_hours_watched)}</span>
                        )}
                    </div>

                    {/* Messages Sent */}
                    <div className="bg-glass/50 rounded-lg p-3 border border-borderSubtle/50">
                        <div className="flex items-center gap-2 mb-1">
                            <MessageSquare className="w-4 h-4 text-green-500" />
                            <span className="text-xs text-textMuted">Messages Sent</span>
                        </div>
                        {isLoading ? (
                            <div className="w-16 h-6 bg-borderSubtle rounded animate-pulse" />
                        ) : (
                            <span className="text-lg font-bold text-textPrimary">{formatNumber(globalStats.total_messages_sent)}</span>
                        )}
                    </div>

                    {/* Streams Watched */}
                    <div className="bg-glass/50 rounded-lg p-3 border border-borderSubtle/50">
                        <div className="flex items-center gap-2 mb-1">
                            <Tv className="w-4 h-4 text-purple-500" />
                            <span className="text-xs text-textMuted">Streams Watched</span>
                        </div>
                        {isLoading ? (
                            <div className="w-16 h-6 bg-borderSubtle rounded animate-pulse" />
                        ) : (
                            <span className="text-lg font-bold text-textPrimary">{formatNumber(globalStats.total_streams_watched)}</span>
                        )}
                    </div>
                </div>
            </div>

            {/* Main Stats Grid */}
            <div className="grid grid-cols-3 gap-4 mb-6">
                {/* Online Now */}
                <div className="bg-glass rounded-xl p-5 border border-borderSubtle">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="w-10 h-10 rounded-xl bg-success/20 flex items-center justify-center">
                            <Globe className="w-5 h-5 text-success" />
                        </div>
                        <span className="text-sm text-textSecondary font-medium">Online Now</span>
                    </div>
                    <div className="flex items-baseline gap-2">
                        {isLoading ? (
                            <div className="w-12 h-9 bg-borderSubtle rounded animate-pulse" />
                        ) : (
                            <span className="text-3xl font-bold text-textPrimary">{onlineCount}</span>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-2">
                        <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
                        <span className="text-xs text-textMuted">Real-time tracking</span>
                    </div>
                </div>

                {/* Total Users */}
                <div className="bg-glass rounded-xl p-5 border border-borderSubtle">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="w-10 h-10 rounded-xl bg-accent/20 flex items-center justify-center">
                            <Users className="w-5 h-5 text-accent" />
                        </div>
                        <span className="text-sm text-textSecondary font-medium">Total Users</span>
                    </div>
                    <div className="flex items-baseline gap-2">
                        {isLoading ? (
                            <div className="w-16 h-9 bg-borderSubtle rounded animate-pulse" />
                        ) : (
                            <span className="text-3xl font-bold text-textPrimary">{totalUsers.toLocaleString()}</span>
                        )}
                    </div>
                    <span className="text-xs text-textMuted mt-2 block">Via Twitch OAuth</span>
                </div>

                {/* Active (1hr) */}
                <div className="bg-glass rounded-xl p-5 border border-borderSubtle">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="w-10 h-10 rounded-xl bg-warning/20 flex items-center justify-center">
                            <Clock className="w-5 h-5 text-warning" />
                        </div>
                        <span className="text-sm text-textSecondary font-medium">Active (1hr)</span>
                    </div>
                    <div className="flex items-baseline gap-2">
                        {isLoading ? (
                            <div className="w-12 h-9 bg-borderSubtle rounded animate-pulse" />
                        ) : (
                            <span className="text-3xl font-bold text-textPrimary">{recentUsers}</span>
                        )}
                    </div>
                    <span className="text-xs text-textMuted mt-2 block">Recently active</span>
                </div>
            </div>

            {/* Secondary Stats Row */}
            <div className="grid grid-cols-4 gap-3 mb-6">
                {/* New Today */}
                <div className="bg-glass rounded-xl p-4 border border-borderSubtle">
                    <div className="flex items-center gap-2 mb-2">
                        <UserPlus className="w-4 h-4 text-pink-500" />
                        <span className="text-xs text-textMuted font-medium">New Today</span>
                    </div>
                    {isLoading ? (
                        <div className="w-10 h-7 bg-borderSubtle rounded animate-pulse" />
                    ) : (
                        <span className="text-2xl font-bold text-textPrimary">{newUsersToday}</span>
                    )}
                </div>

                {/* New This Week */}
                <div className="bg-glass rounded-xl p-4 border border-borderSubtle">
                    <div className="flex items-center gap-2 mb-2">
                        <Calendar className="w-4 h-4 text-blue-500" />
                        <span className="text-xs text-textMuted font-medium">New This Week</span>
                    </div>
                    {isLoading ? (
                        <div className="w-10 h-7 bg-borderSubtle rounded animate-pulse" />
                    ) : (
                        <span className="text-2xl font-bold text-textPrimary">{newUsersThisWeek}</span>
                    )}
                </div>

                {/* Returning Users */}
                <div className="bg-glass rounded-xl p-4 border border-borderSubtle">
                    <div className="flex items-center gap-2 mb-2">
                        <Repeat className="w-4 h-4 text-green-500" />
                        <span className="text-xs text-textMuted font-medium">Returning</span>
                    </div>
                    {isLoading ? (
                        <div className="w-10 h-7 bg-borderSubtle rounded animate-pulse" />
                    ) : (
                        <span className="text-2xl font-bold text-textPrimary">{returningUsers}</span>
                    )}
                </div>

                {/* Retention Rate */}
                <div className="bg-glass rounded-xl p-4 border border-borderSubtle">
                    <div className="flex items-center gap-2 mb-2">
                        <TrendingUp className="w-4 h-4 text-purple-500" />
                        <span className="text-xs text-textMuted font-medium">Retention</span>
                    </div>
                    {isLoading ? (
                        <div className="w-10 h-7 bg-borderSubtle rounded animate-pulse" />
                    ) : (
                        <span className="text-2xl font-bold text-textPrimary">{retentionRate}%</span>
                    )}
                </div>
            </div>

            {/* Newest User Highlight */}
            {newestUser && !isLoading && (
                <div className="bg-gradient-to-r from-accent/10 to-pink-500/10 rounded-xl p-4 border border-accent/20 mb-6">
                    <div className="flex items-center gap-3">
                        <Zap className="w-5 h-5 text-accent" />
                        <span className="text-sm font-medium text-textPrimary">Newest User:</span>
                        <div className="flex items-center gap-2">
                            {newestUser.avatar_url ? (
                                <img
                                    src={newestUser.avatar_url}
                                    alt=""
                                    className="w-6 h-6 rounded-full"
                                />
                            ) : (
                                <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center">
                                    <span className="text-xs text-accent font-bold">
                                        {newestUser.display_name.charAt(0).toUpperCase()}
                                    </span>
                                </div>
                            )}
                            <span className="font-semibold text-accent">{newestUser.display_name}</span>
                            <span className="text-textMuted text-sm">joined {formatRelativeTime(newestUser.created_at)}</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Search Bar */}
            <div className="relative mb-4">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
                <input
                    type="text"
                    placeholder="Search users by name..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-11 pr-4 py-3 bg-glass border border-borderSubtle rounded-xl text-sm text-textPrimary placeholder-textMuted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50 transition-all"
                />
            </div>

            {/* Users List */}
            <div className="bg-glass rounded-xl border border-borderSubtle overflow-hidden">
                <div className="px-4 py-3 border-b border-borderSubtle bg-background/30">
                    <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-textPrimary">
                            All Users ({filteredUsers.length})
                        </span>
                        {lastUpdated && (
                            <span className="text-xs text-textMuted">
                                Updated: {lastUpdated.toLocaleTimeString()}
                            </span>
                        )}
                    </div>
                </div>

                {/* Table Header */}
                <div className="grid grid-cols-[48px_minmax(180px,1fr)_70px_70px_70px_70px_90px] gap-3 px-4 py-2.5 bg-background/20 border-b border-borderSubtle text-xs font-semibold text-textMuted uppercase tracking-wider">
                    <div></div>
                    <div>User</div>
                    <div className="text-center" title="Channel Points">
                        <Coins className="w-3.5 h-3.5 mx-auto text-yellow-500" />
                    </div>
                    <div className="text-center" title="Hours Watched">
                        <Eye className="w-3.5 h-3.5 mx-auto text-blue-500" />
                    </div>
                    <div className="text-center" title="Messages Sent">
                        <MessageSquare className="w-3.5 h-3.5 mx-auto text-green-500" />
                    </div>
                    <div className="text-center" title="Streams Watched">
                        <Tv className="w-3.5 h-3.5 mx-auto text-purple-500" />
                    </div>
                    <div>Last Seen</div>
                </div>

                {/* Users Table */}
                <div className="max-h-[280px] overflow-y-auto scrollbar-thin">
                    {isLoading ? (
                        <div className="p-4 space-y-3">
                            {[1, 2, 3, 4, 5].map(i => (
                                <div key={i} className="flex items-center gap-4">
                                    <div className="w-10 h-10 rounded-full bg-borderSubtle animate-pulse" />
                                    <div className="flex-1 space-y-2">
                                        <div className="h-4 w-32 bg-borderSubtle rounded animate-pulse" />
                                        <div className="h-3 w-24 bg-borderSubtle rounded animate-pulse" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : filteredUsers.length === 0 ? (
                        <div className="p-12 text-center text-textMuted">
                            {searchQuery ? 'No users match your search' : 'No users yet'}
                        </div>
                    ) : (
                        filteredUsers.map(user => (
                            <div key={user.id}>
                                <div
                                    className="grid grid-cols-[48px_minmax(180px,1fr)_70px_70px_70px_70px_90px] gap-3 px-4 py-3 border-b border-borderSubtle/50 hover:bg-glass transition-colors items-center cursor-pointer"
                                    onClick={() => setExpandedUserId(expandedUserId === user.id ? null : user.id)}
                                >
                                    {/* Avatar */}
                                    <div>
                                        {user.avatar_url ? (
                                            <img
                                                src={user.avatar_url}
                                                alt={user.display_name}
                                                className="w-10 h-10 rounded-full object-cover"
                                                onError={(e) => {
                                                    (e.target as HTMLImageElement).src = 'https://static-cdn.jtvnw.net/user-default-pictures-uv/75305d54-c7cc-40d1-bb9c-91c46bf27829-profile_image-70x70.png';
                                                }}
                                            />
                                        ) : (
                                            <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center">
                                                <span className="text-accent font-bold">
                                                    {user.display_name.charAt(0).toUpperCase()}
                                                </span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Username */}
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-semibold text-textPrimary truncate">
                                                {user.display_name}
                                            </span>
                                            <a
                                                href={`https://twitch.tv/${user.username}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-textMuted hover:text-accent transition-colors"
                                                title="View on Twitch"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <ExternalLink className="w-3.5 h-3.5" />
                                            </a>
                                            {expandedUserId === user.id ? (
                                                <ChevronUp className="w-3.5 h-3.5 text-textMuted" />
                                            ) : (
                                                <ChevronDown className="w-3.5 h-3.5 text-textMuted" />
                                            )}
                                        </div>
                                        <span className="text-xs text-textMuted">@{user.username}</span>
                                    </div>

                                    {/* Channel Points */}
                                    <div className="text-center">
                                        <span className="text-sm text-textSecondary">
                                            {user.stats ? formatNumber(user.stats.channel_points_farmed) : '-'}
                                        </span>
                                    </div>

                                    {/* Hours Watched */}
                                    <div className="text-center">
                                        <span className="text-sm text-textSecondary">
                                            {user.stats ? formatHours(user.stats.hours_watched) : '-'}
                                        </span>
                                    </div>

                                    {/* Messages Sent */}
                                    <div className="text-center">
                                        <span className="text-sm text-textSecondary">
                                            {user.stats ? formatNumber(user.stats.messages_sent) : '-'}
                                        </span>
                                    </div>

                                    {/* Streams Watched */}
                                    <div className="text-center">
                                        <span className="text-sm text-textSecondary">
                                            {user.stats ? formatNumber(user.stats.streams_watched) : '-'}
                                        </span>
                                    </div>

                                    {/* Last Seen */}
                                    <div>
                                        <span className="text-sm text-textMuted">
                                            {formatRelativeTime(user.last_seen)}
                                        </span>
                                    </div>
                                </div>

                                {/* Expanded User Stats */}
                                {expandedUserId === user.id && (
                                    <div className="px-4 py-4 bg-background/40 border-b border-borderSubtle/50">
                                        <div className="grid grid-cols-2 gap-4 ml-14">
                                            <div>
                                                <p className="text-xs text-textMuted mb-1">Joined</p>
                                                <p className="text-sm text-textPrimary">{formatDate(user.created_at)}</p>
                                            </div>
                                            <div>
                                                <p className="text-xs text-textMuted mb-1">Last Active</p>
                                                <p className="text-sm text-textPrimary">{formatDate(user.last_seen)}</p>
                                            </div>
                                            {user.stats && (
                                                <>
                                                    <div>
                                                        <p className="text-xs text-textMuted mb-1">Average Watch Time</p>
                                                        <p className="text-sm text-textPrimary">
                                                            {user.stats.streams_watched > 0
                                                                ? formatHours(user.stats.hours_watched / user.stats.streams_watched)
                                                                : '-'}
                                                        </p>
                                                    </div>
                                                    <div>
                                                        <p className="text-xs text-textMuted mb-1">Points per Hour</p>
                                                        <p className="text-sm text-textPrimary">
                                                            {user.stats.hours_watched > 0
                                                                ? formatNumber(Math.round(user.stats.channel_points_farmed / user.stats.hours_watched))
                                                                : '-'}
                                                        </p>
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
