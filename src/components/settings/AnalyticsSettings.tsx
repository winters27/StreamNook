import { useState, useEffect } from 'react';
import { Activity, ExternalLink, Globe, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import {
    isSupabaseConfigured,
    getOnlineCount,
    subscribeToOnlineCount
} from '../../services/supabaseService';

export default function AnalyticsSettings() {
    const [onlineCount, setOnlineCount] = useState(0);
    const [isOpening, setIsOpening] = useState(false);
    const [isDev, setIsDev] = useState(false);
    const configured = isSupabaseConfigured();

    const handleOpenDashboard = async () => {
        setIsOpening(true);
        try {
            // Attempt to start the server (returns true if already running, false if started)
            await invoke('start_analytics_dashboard');

            // Open via system browser
            const { invoke: invokeCore } = await import('@tauri-apps/api/core');
            // Check if we have open_browser_url command available, otherwise fall back to window.open
            try {
                await invoke('open_browser_url', { url: 'http://localhost:5173' });
            } catch (e) {
                window.open('http://localhost:5173', '_blank');
            }
        } catch (error) {
            console.error('Failed to start dashboard:', error);
            window.open('http://localhost:5173', '_blank');
        } finally {
            setIsOpening(false);
        }
    };

    useEffect(() => {
        // Check if we are in a dev environment
        invoke('is_dev_environment')
            .then((res) => setIsDev(res as boolean))
            .catch(() => setIsDev(false));

        if (!configured) return;

        // Subscribe to online count just to show liveness
        const unsubOnline = subscribeToOnlineCount((count) => {
            setOnlineCount(count);
        });

        return () => {
            if (unsubOnline) unsubOnline();
        };
    }, [configured]);

    if (!configured) {
        return (
            <div className="p-6">
                <div className="text-center py-16">
                    <div className="w-20 h-20 rounded-full bg-warning/20 flex items-center justify-center mx-auto mb-6">
                        <Activity className="w-10 h-10 text-warning" />
                    </div>
                    <h3 className="text-xl font-semibold text-textPrimary mb-3">Supabase Not Configured</h3>
                    <p className="text-textSecondary mb-8 max-w-md mx-auto">
                        Analytics features are disabled.
                        {isDev && <span> Add your credentials to the .env file to enable real-time user tracking.</span>}
                    </p>
                    {isDev && (
                        <div className="text-sm text-textMuted bg-glass rounded-xl p-6 text-left font-mono max-w-md mx-auto border border-borderSubtle">
                            <p className="mb-3 text-textSecondary font-sans">Add to your .env file:</p>
                            <p className="text-accent">VITE_SUPABASE_URL=...</p>
                            <p className="text-accent">VITE_SUPABASE_ANON_KEY=...</p>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // Public / Production View for End Users
    if (!isDev) {
        return (
            <div className="p-6 max-w-2xl mx-auto text-center">
                <div className="bg-glass rounded-xl border border-borderSubtle p-8 shadow-lg">
                    <div className="w-16 h-16 rounded-full bg-accent/20 flex items-center justify-center mx-auto mb-6">
                        <Activity className="w-8 h-8 text-accent" />
                    </div>
                    <h2 className="text-2xl font-bold text-textPrimary mb-4">Analytics & Privacy</h2>
                    <p className="text-textSecondary mb-6">
                        StreamNook anonymously collects basic usage data (such as app version and uptime) to help identify issues and improve the application stability.
                    </p>
                    <div className="bg-background/40 rounded-lg p-4 border border-borderSubtle flex items-center justify-center gap-3">
                        <div className="w-2 h-2 rounded-full bg-success animate-pulse"></div>
                        <span className="text-sm text-success font-medium">Reporting Active</span>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="p-6 max-w-2xl mx-auto text-center">
            <div className="bg-glass rounded-xl border border-borderSubtle p-8 shadow-lg">
                <div className="w-16 h-16 rounded-full bg-accent/20 flex items-center justify-center mx-auto mb-6">
                    <Activity className="w-8 h-8 text-accent" />
                </div>

                <h2 className="text-2xl font-bold text-textPrimary mb-4">Analytics & User Tracking</h2>

                <p className="text-textSecondary mb-8">
                    The analytics dashboard has been moved to a dedicated web application.
                    This allows for better visualization, more detailed stats, and accessibility outside of the main application.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8 text-left">
                    <div className="bg-background/40 rounded-lg p-4 border border-borderSubtle">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="w-8 h-8 rounded-lg bg-success/20 flex items-center justify-center">
                                <Globe className="w-4 h-4 text-success" />
                            </div>
                            <div>
                                <div className="text-sm text-textMuted">Status</div>
                                <div className="font-semibold text-success flex items-center gap-2">
                                    Active & Tracking
                                    <span className="relative flex h-2 w-2">
                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="bg-background/40 rounded-lg p-4 border border-borderSubtle">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center">
                                <UsersIcon className="w-4 h-4 text-accent" />
                            </div>
                            <div>
                                <div className="text-sm text-textMuted">Online Users</div>
                                <div className="font-semibold text-textPrimary">{onlineCount}</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="flex flex-col gap-4 max-w-sm mx-auto">
                    <button
                        onClick={handleOpenDashboard}
                        disabled={isOpening}
                        className="flex items-center justify-center gap-2 px-6 py-3 bg-accent hover:bg-accent-hover text-background font-bold rounded-xl transition-all shadow-lg hover:shadow-accent/20 cursor-pointer disabled:opacity-70"
                    >
                        {isOpening ? (
                            <RefreshCw className="w-5 h-5 animate-spin" />
                        ) : (
                            <ExternalLink className="w-5 h-5" />
                        )}
                        {isOpening ? 'Starting Dashboard...' : 'Open Web Dashboard'}
                    </button>
                    <p className="text-xs text-textMuted">
                        Note: This will automatically start the dashboard server if it's not running.
                    </p>
                </div>
            </div>
        </div>
    );
}

function UsersIcon(props: any) {
    return (
        <svg
            {...props}
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
    )
}
