import { useState, useEffect } from 'react';
import { Users, Globe, X, Activity, RefreshCw } from 'lucide-react';
import {
    isSupabaseConfigured,
    getOnlineCount,
    subscribeToOnlineCount,
    getTotalUsersCount,
    subscribeToTotalUsers
} from '../services/supabaseService';
import { useAppStore } from '../stores/AppStore';

// Admin user ID - Only this Twitch channel ID can access the analytics dashboard
// Set via VITE_ADMIN_USER_ID environment variable (baked in at build time from GitHub secrets)
const ADMIN_USER_ID = import.meta.env.VITE_ADMIN_USER_ID;

// Export helper to check if current user is admin (useful for conditionally showing UI elements)
export function useIsAdmin(): boolean {
    const { currentUser, isAuthenticated } = useAppStore();
    return isAuthenticated && currentUser?.user_id === ADMIN_USER_ID;
}

interface DashboardWidgetProps {
    isOpen: boolean;
    onClose: () => void;
}

export default function DashboardWidget({ isOpen, onClose }: DashboardWidgetProps) {
    const { currentUser, isAuthenticated } = useAppStore();
    const [onlineCount, setOnlineCount] = useState(0);
    const [totalUsers, setTotalUsers] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const configured = isSupabaseConfigured();

    // Check if current user is the admin
    const isAdmin = isAuthenticated && currentUser?.user_id === ADMIN_USER_ID;

    useEffect(() => {
        if (!isOpen || !configured) return;

        setIsLoading(true);

        // Get initial counts
        const fetchInitialData = async () => {
            const total = await getTotalUsersCount();
            setTotalUsers(total);
            setOnlineCount(getOnlineCount());
            setLastUpdated(new Date());
            setIsLoading(false);
        };

        fetchInitialData();

        // Subscribe to real-time updates
        const unsubOnline = subscribeToOnlineCount((count) => {
            setOnlineCount(count);
            setLastUpdated(new Date());
        });

        const unsubTotal = subscribeToTotalUsers((count) => {
            setTotalUsers(count);
            setLastUpdated(new Date());
        });

        return () => {
            if (unsubOnline) unsubOnline();
            if (unsubTotal) unsubTotal();
        };
    }, [isOpen, configured]);

    const handleRefresh = async () => {
        if (!configured) return;
        setIsLoading(true);
        const total = await getTotalUsersCount();
        setTotalUsers(total);
        setOnlineCount(getOnlineCount());
        setLastUpdated(new Date());
        setIsLoading(false);
    };

    // Only render if admin is logged in - completely hide for non-admins
    if (!isOpen || !isAdmin) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-secondary/95 backdrop-blur-md rounded-xl border border-borderSubtle shadow-2xl w-full max-w-md mx-4 overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-borderSubtle">
                    <div className="flex items-center gap-2">
                        <Activity className="w-5 h-5 text-accent" />
                        <h2 className="text-lg font-semibold text-textPrimary">Analytics Dashboard</h2>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleRefresh}
                            disabled={isLoading || !configured}
                            className="p-1.5 rounded-lg hover:bg-borderSubtle transition-colors disabled:opacity-50"
                            title="Refresh data"
                        >
                            <RefreshCw className={`w-4 h-4 text-textSecondary ${isLoading ? 'animate-spin' : ''}`} />
                        </button>
                        <button
                            onClick={onClose}
                            className="p-1.5 rounded-lg hover:bg-borderSubtle transition-colors"
                        >
                            <X className="w-5 h-5 text-textSecondary" />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="p-4">
                    {!configured ? (
                        <div className="text-center py-8">
                            <div className="w-12 h-12 rounded-full bg-warning/20 flex items-center justify-center mx-auto mb-4">
                                <Activity className="w-6 h-6 text-warning" />
                            </div>
                            <h3 className="text-textPrimary font-medium mb-2">Supabase Not Configured</h3>
                            <p className="text-textSecondary text-sm mb-4">
                                Analytics features require Supabase configuration.
                            </p>
                            <div className="text-xs text-textMuted bg-background/50 rounded-lg p-3 text-left font-mono">
                                <p className="mb-1">Add to your .env file:</p>
                                <p>VITE_SUPABASE_URL=...</p>
                                <p>VITE_SUPABASE_ANON_KEY=...</p>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {/* Stats Grid */}
                            <div className="grid grid-cols-2 gap-4">
                                {/* Online Users Card */}
                                <div className="bg-background/50 rounded-xl p-4 border border-borderSubtle">
                                    <div className="flex items-center gap-2 mb-2">
                                        <div className="w-8 h-8 rounded-lg bg-success/20 flex items-center justify-center">
                                            <Globe className="w-4 h-4 text-success" />
                                        </div>
                                        <span className="text-textSecondary text-sm">Online Now</span>
                                    </div>
                                    <div className="flex items-baseline gap-1">
                                        {isLoading ? (
                                            <div className="w-12 h-8 bg-borderSubtle rounded animate-pulse" />
                                        ) : (
                                            <>
                                                <span className="text-3xl font-bold text-textPrimary">
                                                    {onlineCount}
                                                </span>
                                                <span className="text-textMuted text-sm">users</span>
                                            </>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-1 mt-2">
                                        <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
                                        <span className="text-xs text-textMuted">Real-time</span>
                                    </div>
                                </div>

                                {/* Total Users Card */}
                                <div className="bg-background/50 rounded-xl p-4 border border-borderSubtle">
                                    <div className="flex items-center gap-2 mb-2">
                                        <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center">
                                            <Users className="w-4 h-4 text-accent" />
                                        </div>
                                        <span className="text-textSecondary text-sm">Total Users</span>
                                    </div>
                                    <div className="flex items-baseline gap-1">
                                        {isLoading ? (
                                            <div className="w-16 h-8 bg-borderSubtle rounded animate-pulse" />
                                        ) : (
                                            <>
                                                <span className="text-3xl font-bold text-textPrimary">
                                                    {totalUsers.toLocaleString()}
                                                </span>
                                                <span className="text-textMuted text-sm">signed in</span>
                                            </>
                                        )}
                                    </div>
                                    <div className="text-xs text-textMuted mt-2">
                                        Via Twitch OAuth
                                    </div>
                                </div>
                            </div>

                            {/* Info Section */}
                            <div className="bg-accent/10 rounded-lg p-3 border border-accent/20">
                                <p className="text-xs text-textSecondary">
                                    <span className="font-medium text-accent">ℹ️ Note:</span>{' '}
                                    Online count tracks active app users. Total users are unique Twitch accounts that have signed in.
                                </p>
                            </div>

                            {/* Last Updated */}
                            {lastUpdated && (
                                <div className="text-center text-xs text-textMuted">
                                    Last updated: {lastUpdated.toLocaleTimeString()}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
