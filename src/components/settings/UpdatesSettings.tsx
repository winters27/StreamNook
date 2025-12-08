import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../../stores/AppStore';
import { Check, Loader2, Download, RefreshCw, Package, ArrowRight, AlertCircle, ChevronDown, ChevronRight, FileText, Zap, Settings, Github, Sparkles, Bug, Wrench } from 'lucide-react';
import { parseInlineMarkdown } from '../../services/markdownService';

interface VersionChange {
    from: string;
    to: string;
}

interface ComponentChanges {
    streamnook: VersionChange | null;
    streamlink: VersionChange | null;
    ttvlol: VersionChange | null;
}

interface BundleUpdateStatus {
    update_available: boolean;
    current_version: string;
    latest_version: string;
    download_url: string | null;
    bundle_name: string | null;
    download_size: string | null;
    component_changes: ComponentChanges | null;
    release_notes: string | null;
}

// Helper to format markdown text roughly
const FormatMarkdown = ({ content }: { content: string }) => {
    if (!content) return null;

    // Filter content to stop at "Bundle Components", "Installation", or separator
    const lines = content.split('\n');
    const filteredLines: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '---' || trimmed === 'Bundle Components' || trimmed === 'Installation') {
            break;
        }
        filteredLines.push(line);
    }

    return (
        <div className="space-y-1 text-xs text-textSecondary">
            {filteredLines.map((line, i) => {
                const cleanLine = line.trim();
                if (!cleanLine) return <div key={i} className="h-2" />;

                // Format version/date line: [4.7.1] - 2025-12-04
                const versionMatch = cleanLine.match(/^(?:##\s*)?\[.*?\]\s*-\s*(\d{4}-\d{2}-\d{2})/);
                if (versionMatch) {
                    try {
                        const date = new Date(versionMatch[1]);
                        // Add timezone offset to prevent off-by-one error due to UTC conversion
                        const userTimezoneOffset = date.getTimezoneOffset() * 60000;
                        const adjustedDate = new Date(date.getTime() + userTimezoneOffset);

                        const formattedDate = adjustedDate.toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric'
                        });

                        return (
                            <div key={i} className="mb-6 mt-2">
                                <span className="inline-block text-xs font-medium text-textSecondary bg-white/5 px-2.5 py-1 rounded-md border border-white/5">
                                    {formattedDate}
                                </span>
                            </div>
                        );
                    } catch (e) {
                        // If date parsing fails, just ignore this line or show as is
                    }
                }

                // Replace emoji headers with Lucide icons
                if (cleanLine.includes('✨ Features')) {
                    return (
                        <div key={i} className="flex items-center gap-2 mt-4 mb-2">
                            <Sparkles size={14} className="text-yellow-400" />
                            <span className="text-sm font-semibold text-textPrimary">Features</span>
                        </div>
                    );
                }
                if (cleanLine.includes('🐛 Bug Fixes')) {
                    return (
                        <div key={i} className="flex items-center gap-2 mt-4 mb-2">
                            <Bug size={14} className="text-red-400" />
                            <span className="text-sm font-semibold text-textPrimary">Bug Fixes</span>
                        </div>
                    );
                }
                if (cleanLine.includes('🔧 Maintenance')) {
                    return (
                        <div key={i} className="flex items-center gap-2 mt-4 mb-2">
                            <Wrench size={14} className="text-blue-400" />
                            <span className="text-sm font-semibold text-textPrimary">Maintenance</span>
                        </div>
                    );
                }

                if (cleanLine.startsWith('# '))
                    return <h3 key={i} className="text-sm font-bold text-textPrimary mt-4 mb-2">{parseInlineMarkdown(cleanLine.replace('# ', ''))}</h3>;
                if (cleanLine.startsWith('## '))
                    return <h4 key={i} className="text-xs font-bold text-textPrimary mt-3 mb-1">{parseInlineMarkdown(cleanLine.replace('## ', ''))}</h4>;
                if (cleanLine.startsWith('### '))
                    return <h5 key={i} className="text-xs font-semibold text-textPrimary mt-2">{parseInlineMarkdown(cleanLine.replace('### ', ''))}</h5>;
                if (cleanLine.startsWith('- ') || cleanLine.startsWith('* '))
                    return (
                        <div key={i} className="flex items-start gap-2 ml-2">
                            <span className="text-textMuted mt-0.5">•</span>
                            <span>{parseInlineMarkdown(cleanLine.replace(/^[-*]\s/, ''))}</span>
                        </div>
                    );

                return <p key={i}>{parseInlineMarkdown(line)}</p>;
            })}
        </div>
    );
};

// Component for individual change row with expandable changelog
const ComponentChangeRow = ({
    name,
    change,
    icon,
    type,
    existingNotes
}: {
    name: string;
    change: VersionChange | null;
    icon: React.ReactNode;
    type: 'streamnook' | 'streamlink' | 'ttvlol';
    existingNotes?: string | null;
}) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [notes, setNotes] = useState<string | null>(existingNotes || null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchChangelog = async () => {
        if (notes || loading) return;

        setLoading(true);
        setError(null);

        try {
            if (type === 'streamlink') {
                const response = await fetch('https://raw.githubusercontent.com/streamlink/streamlink/master/CHANGELOG.md');
                if (!response.ok) throw new Error('Failed to fetch changelog');
                const text = await response.text();
                // Try to extract the top most entry (Assuming latest)
                // Looks for "## [version]" ... until next "## ["
                const match = text.match(/## \[.*?\][\s\S]*?(?=## \[|$)/);
                if (match) {
                    setNotes(match[0]);
                } else {
                    setNotes(text.substring(0, 1000) + '...');
                }
            } else if (type === 'ttvlol') {
                // Fetch release tags to find the matching one or latest
                // The user mentioned checking a specific tag but general link is releases/latest
                const response = await fetch('https://api.github.com/repos/2bc4/streamlink-ttvlol/releases/latest');
                if (!response.ok) throw new Error('Failed to fetch release notes');
                const data = await response.json();
                setNotes(data.body || 'No release notes found.');
            }
        } catch (e) {
            console.error(`Failed to fetch ${name} changelog:`, e);
            setError('Could not load changelog.');
        } finally {
            setLoading(false);
        }
    };

    const handleToggle = () => {
        const nextState = !isExpanded;
        setIsExpanded(nextState);

        if (nextState && !notes && (type === 'streamlink' || type === 'ttvlol')) {
            fetchChangelog();
        }
    };

    if (!change) return null;

    return (
        <div className="bg-glass rounded-lg overflow-hidden border border-white/5">
            <button
                onClick={handleToggle}
                className="w-full flex items-center justify-between p-3 hover:bg-white/5 transition-colors"
            >
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                        {icon}
                    </div>
                    <div className="text-left">
                        <span className="text-sm font-medium text-textPrimary block">{name}</span>
                        <div className="flex items-center gap-2 text-xs">
                            <span className="text-textSecondary">{change.from}</span>
                            <ArrowRight size={12} className="text-textMuted" />
                            <span className="text-green-400 font-medium">{change.to}</span>
                        </div>
                    </div>
                </div>
                {isExpanded ? (
                    <ChevronDown size={16} className="text-textSecondary" />
                ) : (
                    <ChevronRight size={16} className="text-textSecondary" />
                )}
            </button>

            {isExpanded && (
                <div className="p-4 bg-black/20 border-t border-white/5 animate-in slide-in-from-top-2 duration-200">
                    {loading ? (
                        <div className="flex items-center justify-center py-4 text-textSecondary">
                            <Loader2 size={16} className="animate-spin mr-2" />
                            <span className="text-xs">Fetching changelog...</span>
                        </div>
                    ) : error ? (
                        <div className="text-xs text-red-400 py-2">{error}</div>
                    ) : notes ? (
                        <div className="max-h-60 overflow-y-auto scrollbar-thin pr-2">
                            <FormatMarkdown content={notes} />
                            {(type === 'streamlink' || type === 'ttvlol') && (
                                <div className="mt-4 pt-4 border-t border-white/5 xl:flex justify-end">
                                    <a
                                        href={type === 'streamlink'
                                            ? 'https://github.com/streamlink/streamlink/blob/master/CHANGELOG.md'
                                            : 'https://github.com/2bc4/streamlink-ttvlol/releases/latest'}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                                        onClick={(e) => {
                                            e.preventDefault();
                                            invoke('open_browser_url', {
                                                url: type === 'streamlink'
                                                    ? 'https://github.com/streamlink/streamlink/blob/master/CHANGELOG.md'
                                                    : 'https://github.com/2bc4/streamlink-ttvlol/releases/latest'
                                            });
                                        }}
                                    >
                                        <Github size={12} />
                                        View full changelog on GitHub
                                    </a>
                                </div>
                            )}
                        </div>
                    ) : (
                        <p className="text-xs text-textMuted italic">No details available.</p>
                    )}
                </div>
            )}
        </div>
    );
};

const UpdatesSettings = () => {
    const { addToast, settings, updateSettings, openSettings } = useAppStore();
    const [isChecking, setIsChecking] = useState(true);
    const [isUpdating, setIsUpdating] = useState(false);
    const [updateProgress, setUpdateProgress] = useState<string | null>(null);
    const [updateStatus, setUpdateStatus] = useState<BundleUpdateStatus | null>(null);
    const [error, setError] = useState<string | null>(null);

    const autoUpdateOnStart = settings.auto_update_on_start ?? false;

    // Check for bundle updates
    const checkForUpdates = useCallback(async () => {
        setIsChecking(true);
        setError(null);
        try {
            const status = await invoke('check_for_bundle_update') as BundleUpdateStatus;
            setUpdateStatus(status);
        } catch (e) {
            console.error('Failed to check for updates:', e);
            setError(String(e));
        } finally {
            setIsChecking(false);
        }
    }, []);

    // Initial check on mount
    useEffect(() => {
        checkForUpdates();
    }, [checkForUpdates]);

    // Listen for update progress events
    useEffect(() => {
        let unlisten: (() => void) | null = null;

        const setupListener = async () => {
            unlisten = await listen<string>('bundle-update-progress', (event) => {
                setUpdateProgress(event.payload);
            });
        };

        setupListener();

        return () => {
            if (unlisten) {
                unlisten();
            }
        };
    }, []);

    // Handle update and restart
    const handleUpdate = useCallback(async () => {
        if (!updateStatus?.update_available) {
            addToast('StreamNook is up to date!', 'success');
            return;
        }

        setIsUpdating(true);
        setUpdateProgress('Starting update...');
        setError(null);

        try {
            await invoke('download_and_install_bundle');
            // If we get here, the app didn't restart (no exe update)
            addToast('Update installed successfully!', 'success');
            setIsUpdating(false);
            setUpdateProgress(null);
            // Refresh status
            await checkForUpdates();
        } catch (e) {
            console.error('Failed to update:', e);
            setError(String(e));
            addToast('Update failed: ' + String(e), 'error');
            setIsUpdating(false);
            setUpdateProgress(null);
        }
    }, [updateStatus, addToast, checkForUpdates]);

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-textPrimary">Updates</h3>
                <button
                    onClick={checkForUpdates}
                    disabled={isChecking || isUpdating}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-colors disabled:opacity-50"
                >
                    <RefreshCw size={14} className={isChecking ? 'animate-spin' : ''} />
                    Check
                </button>
            </div>

            {/* Error state */}
            {error && (
                <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                    <AlertCircle size={20} className="text-red-400 flex-shrink-0" />
                    <div className="flex-1">
                        <p className="text-sm text-red-400">{error}</p>
                    </div>
                </div>
            )}

            {/* Loading state */}
            {isChecking && !updateStatus && (
                <div className="flex items-center justify-center py-8">
                    <div className="flex items-center gap-3 text-textSecondary">
                        <Loader2 size={20} className="animate-spin" />
                        <span className="text-sm">Checking for updates...</span>
                    </div>
                </div>
            )}

            {/* Update status */}
            {updateStatus && (
                <div className="space-y-4">
                    {/* Current version info with update button integrated */}
                    <div className={`p-4 rounded-xl border ${updateStatus.update_available
                        ? 'bg-yellow-500/5 border-yellow-500/20'
                        : 'bg-green-500/5 border-green-500/20'
                        }`}>
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${updateStatus.update_available
                                    ? 'bg-yellow-500/20'
                                    : 'bg-green-500/20'
                                    }`}>
                                    {updateStatus.update_available ? (
                                        <Download size={20} className="text-yellow-400" />
                                    ) : (
                                        <Check size={20} className="text-green-400" />
                                    )}
                                </div>
                                <div>
                                    <p className="text-sm font-medium text-textPrimary">
                                        {updateStatus.update_available ? 'Update Available' : 'Up to Date'}
                                    </p>
                                    <p className="text-xs text-textSecondary mt-0.5">
                                        {updateStatus.update_available ? (
                                            <>
                                                v{updateStatus.current_version} → <span className="text-yellow-400">v{updateStatus.latest_version}</span>
                                            </>
                                        ) : (
                                            <>Current version: v{updateStatus.current_version}</>
                                        )}
                                    </p>
                                </div>
                            </div>
                            {/* Update button replaces download size container */}
                            {updateStatus.update_available ? (
                                <button
                                    onClick={handleUpdate}
                                    disabled={isUpdating}
                                    className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all glass-button hover:bg-glass-hover text-textPrimary disabled:opacity-50"
                                >
                                    {isUpdating ? (
                                        <>
                                            <Loader2 size={16} className="animate-spin" />
                                            <span className="max-w-[120px] truncate">{updateProgress || 'Updating...'}</span>
                                        </>
                                    ) : (
                                        <>
                                            <Download size={16} />
                                            Update {updateStatus.download_size && `(${updateStatus.download_size})`}
                                        </>
                                    )}
                                </button>
                            ) : (
                                <span className="text-xs text-textMuted bg-glass px-3 py-1.5 rounded-lg">
                                    <Check size={14} className="inline mr-1" />
                                    Latest
                                </span>
                            )}
                        </div>
                    </div>

                    {/* What's in this update section - only show when update is available */}
                    {updateStatus.update_available && updateStatus.component_changes && (
                        <div className="space-y-3">
                            <div className="flex items-center gap-2 px-1">
                                <FileText size={16} className="text-accent" />
                                <span className="text-sm font-medium text-textPrimary">What's in this update</span>
                            </div>

                            <div className="space-y-2">
                                <ComponentChangeRow
                                    name="StreamNook"
                                    change={updateStatus.component_changes.streamnook}
                                    icon={<Package size={16} className="text-purple-400" />}
                                    type="streamnook"
                                    existingNotes={updateStatus.release_notes}
                                />
                                <ComponentChangeRow
                                    name="Streamlink"
                                    change={updateStatus.component_changes.streamlink}
                                    icon={<Package size={16} className="text-orange-400" />}
                                    type="streamlink"
                                />
                                <ComponentChangeRow
                                    name="TTV LOL PRO"
                                    change={updateStatus.component_changes.ttvlol}
                                    icon={<Package size={16} className="text-blue-400" />}
                                    type="ttvlol"
                                />
                            </div>
                        </div>
                    )}

                    {/* Info note */}
                    {updateStatus.update_available && (
                        <p className="text-xs text-textMuted text-center">
                            The app will restart automatically after the update is installed
                        </p>
                    )}
                </div>
            )}

            {/* Update Preferences Section */}
            <div className="pt-4 border-t border-borderSubtle space-y-4">
                <p className="text-xs font-medium text-textMuted uppercase tracking-wide">
                    Update Preferences
                </p>

                {/* Auto-update on start toggle */}
                <div className="flex items-center justify-between gap-4 p-3 bg-glass/30 rounded-lg">
                    <div className="flex items-center gap-3 flex-1">
                        <div className="w-8 h-8 rounded-lg bg-green-500/20 flex items-center justify-center flex-shrink-0">
                            <Zap size={16} className="text-green-400" />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-textPrimary">
                                Auto-Update on Start
                            </label>
                            <p className="text-xs text-textSecondary mt-0.5">
                                Automatically install updates when the app starts
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={() => updateSettings({
                            ...settings,
                            auto_update_on_start: !autoUpdateOnStart,
                        })}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${autoUpdateOnStart ? 'bg-accent' : 'bg-gray-600'
                            }`}
                    >
                        <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${autoUpdateOnStart ? 'translate-x-6' : 'translate-x-1'
                                }`}
                        />
                    </button>
                </div>

                {/* Quick update tip */}
                <div className="flex items-start gap-3 p-3 bg-accent/5 border border-accent/20 rounded-lg">
                    <Settings size={16} className="text-accent flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                        <p className="text-xs text-textSecondary">
                            <span className="font-medium text-textPrimary">Tip:</span> You can enable "Quick Update on Toast Click" in{' '}
                            <button
                                onClick={() => openSettings('Notifications')}
                                className="text-accent hover:underline font-medium"
                            >
                                Notification Settings
                            </button>{' '}
                            to instantly update when clicking an update notification.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default UpdatesSettings;
