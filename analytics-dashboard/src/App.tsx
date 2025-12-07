import { useState, useEffect } from 'react';
import {
  Users, Globe, Activity, RefreshCw, Clock, Search,
  ExternalLink, TrendingUp, MessageSquare,
  ChevronDown, ChevronUp, ArrowUpRight, Signal
} from 'lucide-react';
import {
  isSupabaseConfigured,
  getOnlineCount,
  subscribeToOnlineCount,
  getAllUsersWithStats,
  subscribeToStatsChanges,
  getGlobalStats,
  getOnlineUserIds,
  getOnlineUsersInfo,
  type UserWithStats,
  type GlobalStats
} from './services/supabaseService';

// --- Utility Functions ---

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

const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toLocaleString();
};

const formatHours = (hours: number): string => {
  if (hours >= 1000) return (hours / 1000).toFixed(1) + 'k';
  return hours.toFixed(1);
};

// --- Components ---

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ComponentType<{ size?: number }>;
  trend?: string;
  colorClass: { bg: string; text: string };
}

const StatCard = ({ title, value, subtitle, icon: Icon, trend, colorClass }: StatCardProps) => (
  <div className="glass-card rounded-2xl p-6 relative overflow-hidden group">
    <div className={`absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity duration-500 scale-150 transform translate-x-2 -translate-y-2`}>
      <Icon size={120} />
    </div>

    <div className="flex items-center justify-between mb-4 relative z-10">
      <div className={`p-3 rounded-xl ${colorClass.bg} ${colorClass.text} bg-opacity-10`}>
        <Icon size={20} />
      </div>
      {trend && (
        <div className="flex items-center gap-1 text-xs font-medium text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded-full border border-emerald-400/20">
          <ArrowUpRight size={12} />
          {trend}
        </div>
      )}
    </div>

    <div className="relative z-10">
      <h3 className="text-3xl font-bold text-white tracking-tight mb-1">{value}</h3>
      <p className="text-sm font-medium text-gray-400">{title}</p>
      {subtitle && <p className="text-xs text-gray-500 mt-2">{subtitle}</p>}
    </div>
  </div>
);

export default function App() {
  const configured = isSupabaseConfigured();
  const [onlineCount, setOnlineCount] = useState(0);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [onlineUsersInfo, setOnlineUsersInfo] = useState<Map<string, { display_name?: string; app_version?: string; online_at: string }>>(new Map());
  const [users, setUsers] = useState<UserWithStats[]>([]);
  const [globalStats, setGlobalStats] = useState<GlobalStats>({
    total_channel_points: 0,
    total_hours_watched: 0,
    total_messages_sent: 0,
    total_streams_watched: 0
  });
  const [isLoading, setIsLoading] = useState(configured);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'online'>('all');
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [activeLastHour, setActiveLastHour] = useState(0);
  const [newToday, setNewToday] = useState(0);

  // Helper function to compute time-based stats
  const computeTimeStats = (usersList: UserWithStats[]) => {
    const now = Date.now();
    setActiveLastHour(usersList.filter(u => new Date(u.last_seen).getTime() > now - 3600000).length);
    setNewToday(usersList.filter(u => new Date(u.created_at).getTime() > now - 86400000).length);
  };

  // Initial Data Fetch
  useEffect(() => {
    if (!configured) return;

    const fetchData = async () => {
      setIsLoading(true);
      const usersList = await getAllUsersWithStats();
      const stats = await getGlobalStats();
      setUsers(usersList);
      setGlobalStats(stats);
      setOnlineCount(getOnlineCount());
      setOnlineUserIds(new Set(getOnlineUserIds()));
      computeTimeStats(usersList);
      setIsLoading(false);
    };
    fetchData();

    // Real-time Subscriptions
    const unsubOnline = subscribeToOnlineCount((count) => {
      setOnlineCount(count);
      setOnlineUserIds(new Set(getOnlineUserIds()));
      setOnlineUsersInfo(getOnlineUsersInfo());
    });

    const unsubStats = subscribeToStatsChanges((usersList, stats) => {
      setUsers(usersList);
      setGlobalStats(stats);
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
    computeTimeStats(usersList);
    setIsLoading(false);
  };

  // Filter Logic
  const filteredUsers = users.filter(user => {
    const matchesSearch = user.display_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.username.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesTab = activeTab === 'all' || (activeTab === 'online' && onlineUserIds.has(user.id));
    return matchesSearch && matchesTab;
  });

  // Computed Stats
  const totalUsers = users.length;

  if (!configured) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="glass-panel p-12 rounded-2xl max-w-lg w-full text-center border-t border-white/10">
          <div className="w-20 h-20 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-6">
            <Activity className="text-red-500 w-10 h-10" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Configuration Required</h1>
          <p className="text-gray-400 mb-8">Please check your .env file and ensure Supabase credentials are correctly set.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen font-sans text-gray-200 pb-20">
      {/* Top Navigation Bar */}
      <nav className="sticky top-0 z-50 glass-panel border-b border-white/5 bg-opacity-80 backdrop-blur-xl">
        <div className="max-w-[1920px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center shadow-lg shadow-violet-500/20">
              <Activity className="text-white w-5 h-5" />
            </div>
            <span className="font-bold text-lg tracking-tight text-white">StreamNook<span className="text-gray-500 font-normal">Analytics</span></span>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span className="text-xs font-semibold text-emerald-400">System Operational</span>
            </div>
            <button
              onClick={handleRefresh}
              className={`p-2 rounded-lg hover:bg-white/5 transition-colors ${isLoading ? 'animate-spin' : ''}`}
            >
              <RefreshCw size={18} className="text-gray-400 hover:text-white" />
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-[1920px] mx-auto px-6 py-8">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
          <StatCard
            title="Online Users"
            value={onlineCount}
            icon={Globe}
            colorClass={{ bg: 'bg-emerald-500', text: 'text-emerald-400' }}
            subtitle="Real-time count"
          />
          <StatCard
            title="Total Users"
            value={formatNumber(totalUsers)}
            icon={Users}
            trend={`+${newToday} today`}
            colorClass={{ bg: 'bg-violet-500', text: 'text-violet-400' }}
          />
          <StatCard
            title="Active (1h)"
            value={activeLastHour}
            icon={Clock}
            colorClass={{ bg: 'bg-amber-500', text: 'text-amber-400' }}
          />
          <StatCard
            title="Total Messages"
            value={formatNumber(globalStats.total_messages_sent)}
            icon={MessageSquare}
            colorClass={{ bg: 'bg-cyan-500', text: 'text-cyan-400' }}
          />
        </div>

        {/* Main Content Area */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column: User Directory */}
          <div className="lg:col-span-2 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Users size={20} className="text-violet-400" />
                User Directory
              </h2>

              <div className="flex gap-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input
                    type="text"
                    placeholder="Search users..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="bg-zinc-900/50 border border-white/10 rounded-xl pl-9 pr-4 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/50 transition-all w-64"
                  />
                </div>
                <div className="flex bg-zinc-900/50 rounded-xl p-1 border border-white/10">
                  <button
                    onClick={() => setActiveTab('all')}
                    className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${activeTab === 'all' ? 'bg-zinc-800 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    All
                  </button>
                  <button
                    onClick={() => setActiveTab('online')}
                    className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${activeTab === 'online' ? 'bg-zinc-800 text-emerald-400 shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    Online
                  </button>
                </div>
              </div>
            </div>

            <div className="glass-panel rounded-2xl overflow-hidden border border-white/5">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/5 bg-white/[0.02]">
                      <th className="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider w-16">Status</th>
                      <th className="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">User</th>
                      <th className="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Version</th>
                      <th className="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Points</th>
                      <th className="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Hours</th>
                      <th className="px-6 py-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Last Seen</th>
                      <th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {filteredUsers.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                          No users found matching your criteria.
                        </td>
                      </tr>
                    ) : filteredUsers.slice(0, 50).map((user) => { // Limit to 50 for performance
                      const isOnline = onlineUserIds.has(user.id);
                      const isExpanded = expandedUserId === user.id;
                      // For online users, prefer the live version from presence over database
                      const liveInfo = onlineUsersInfo.get(user.id);
                      const displayVersion = (isOnline && liveInfo?.app_version) ? liveInfo.app_version : user.app_version;

                      return (
                        <>
                          <tr
                            key={user.id}
                            onClick={() => setExpandedUserId(isExpanded ? null : user.id)}
                            className={`group cursor-pointer transition-colors ${isExpanded ? 'bg-white/[0.04]' : 'hover:bg-white/[0.02]'}`}
                          >
                            <td className="px-6 py-4">
                              <div className="flex justify-center">
                                {isOnline ? (
                                  <div className="relative">
                                    <div className="absolute -inset-1 rounded-full bg-emerald-500/20 blur-sm animate-pulse"></div>
                                    <div className="h-2.5 w-2.5 rounded-full bg-emerald-500 relative"></div>
                                  </div>
                                ) : (
                                  <div className="h-2.5 w-2.5 rounded-full bg-zinc-700 border border-zinc-600"></div>
                                )}
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3">
                                {user.avatar_url ? (
                                  <img src={user.avatar_url} alt="" className="w-8 h-8 rounded-full ring-2 ring-white/5" />
                                ) : (
                                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-zinc-700 to-zinc-800 flex items-center justify-center text-xs font-bold text-gray-400 ring-2 ring-white/5">
                                    {user.display_name.charAt(0)}
                                  </div>
                                )}
                                <div>
                                  <div className="font-medium text-gray-200 group-hover:text-white transition-colors">{user.display_name}</div>
                                  <div className="text-xs text-gray-500">@{user.username}</div>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium border border-white/5 ${isOnline && liveInfo?.app_version ? 'bg-emerald-900/30 text-emerald-400' : 'bg-zinc-800 text-zinc-400'}`}>
                                {displayVersion || 'N/A'}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-right">
                              <span className="text-sm font-mono text-gray-400">{user.stats ? formatNumber(user.stats.channel_points_farmed) : '-'}</span>
                            </td>
                            <td className="px-6 py-4 text-right">
                              <span className="text-sm font-mono text-gray-400">{user.stats ? formatHours(user.stats.hours_watched) : '-'}</span>
                            </td>
                            <td className="px-6 py-4 text-sm text-gray-500">
                              {formatRelativeTime(user.last_seen)}
                            </td>
                            <td className="px-6 py-4 text-right">
                              {isExpanded ? <ChevronUp size={16} className="text-gray-500" /> : <ChevronDown size={16} className="text-gray-600 group-hover:text-gray-400" />}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-zinc-900/30">
                              <td colSpan={7} className="px-6 py-0">
                                <div className="py-6 pl-16 grid grid-cols-1 md:grid-cols-3 gap-8 animate-in fade-in slide-in-from-top-2 duration-200">
                                  <div className="space-y-3">
                                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Identity</h4>
                                    <div className="space-y-1.5 text-sm">
                                      <div className="flex justify-between text-gray-400"><span>ID</span> <span className="font-mono text-gray-500">{user.id}</span></div>
                                      <div className="flex justify-between text-gray-400"><span>Joined</span> <span>{new Date(user.created_at).toLocaleDateString()}</span></div>
                                    </div>
                                  </div>
                                  <div className="space-y-3">
                                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Engagement</h4>
                                    <div className="space-y-1.5 text-sm">
                                      <div className="flex justify-between text-gray-400"><span>Streams</span> <span className="text-gray-200">{user.stats?.streams_watched || 0}</span></div>
                                      <div className="flex justify-between text-gray-400"><span>Messages</span> <span className="text-gray-200">{user.stats?.messages_sent || 0}</span></div>
                                    </div>
                                  </div>
                                  <div className="flex items-end justify-end">
                                    <a
                                      href={`https://twitch.tv/${user.username}`}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="flex items-center gap-2 px-4 py-2 bg-violet-500/10 hover:bg-violet-500/20 text-violet-400 rounded-lg text-sm font-medium transition-colors border border-violet-500/20"
                                    >
                                      <ExternalLink size={14} />
                                      Open Twitch Channel
                                    </a>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Right Column: Global Insights */}
          <div className="space-y-6">
            <div className="flex items-center gap-2 mb-2">
              <Signal size={20} className="text-cyan-400" />
              <h2 className="text-xl font-bold text-white">Live Insights</h2>
            </div>

            {/* Global Progress */}
            <div className="glass-panel p-6 rounded-2xl relative overflow-hidden">
              <h3 className="text-sm font-semibold text-gray-400 mb-6">Aggregate Metrics</h3>

              <div className="space-y-6">
                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-gray-400">Total Hours Watched</span>
                    <span className="text-white font-mono">{formatNumber(globalStats.total_hours_watched)}</span>
                  </div>
                  <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 w-3/4 rounded-full"></div>
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-gray-400">Total Points Farmed</span>
                    <span className="text-white font-mono">{formatNumber(globalStats.total_channel_points)}</span>
                  </div>
                  <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-amber-500 to-orange-500 w-2/3 rounded-full"></div>
                  </div>
                </div>
              </div>
            </div>

            {/* Recent Activity / Retention */}
            <div className="glass-panel p-6 rounded-2xl">
              <h3 className="text-sm font-semibold text-gray-400 mb-4 flex items-center gap-2">
                <TrendingUp size={16} /> Retention
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-zinc-900/50 p-4 rounded-xl border border-white/5">
                  <div className="text-2xl font-bold text-white mb-1">{newToday}</div>
                  <div className="text-xs text-gray-500">New Today</div>
                </div>
                <div className="bg-zinc-900/50 p-4 rounded-xl border border-white/5">
                  <div className="text-2xl font-bold text-white mb-1">
                    {users.length > 0 ? Math.round((users.filter(u => u.stats && u.stats.messages_sent > 0).length / users.length) * 100) : 0}%
                  </div>
                  <div className="text-xs text-gray-500">Engagement Rate</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
