import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../../stores/AppStore';
import { Check, Loader2, Download, RefreshCw, Package, ArrowRight, AlertCircle, ChevronDown, ChevronUp, FileText, Zap, Settings } from 'lucide-react';

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

const UpdatesSettings = () => {
    const { addToast, settings, updateSettings, openSettings } = useAppStore();
    const [isChecking, setIsChecking] = useState(true);
    const [isUpdating, setIsUpdating] = useState(false);
    const [updateProgress, setUpdateProgress] = useState<string | null>(null);
    const [updateStatus, setUpdateStatus] = useState<BundleUpdateStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [showReleaseNotes, setShowReleaseNotes] = useState(false);

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

    // Render component change row
    const renderComponentChange = (name: string, change: VersionChange | null | undefined, icon: React.ReactNode) => {
        if (!change) return null;

        return (
            <div className="flex items-center justify-between p-3 bg-glass rounded-lg">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                        {icon}
                    </div>
                    <span className="text-sm font-medium text-textPrimary">{name}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                    <span className="text-textSecondary">{change.from}</span>
                    <ArrowRight size={14} className="text-textMuted" />
                    <span className="text-green-400 font-medium">{change.to}</span>
                </div>
            </div>
        );
    };

    // Parse release notes for display
    const formatReleaseNotes = (notes: string) => {
        // Split by lines and format
        const lines = notes.split('\n');
        return lines.map((line, index) => {
            // Headers
            if (line.startsWith('## ')) {
                return (
                    <h3 key={index} className="text-sm font-semibold text-textPrimary mt-4 mb-2 first:mt-0">
                        {line.replace('## ', '')}
                    </h3>
                );
            }
            if (line.startsWith('### ')) {
                return (
                    <h4 key={index} className="text-xs font-semibold text-textSecondary mt-3 mb-1.5">
                        {line.replace('### ', '')}
                    </h4>
                );
            }
            // List items
            if (line.startsWith('- ') || line.startsWith('* ')) {
                return (
                    <li key={index} className="text-xs text-textSecondary ml-4 list-disc">
                        {line.replace(/^[-*]\s/, '')}
                    </li>
                );
            }
            // Empty lines
            if (line.trim() === '') {
                return <div key={index} className="h-2" />;
            }
            // Regular text
            return (
                <p key={index} className="text-xs text-textSecondary">
                    {line}
                </p>
            );
        });
    };

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
                    {updateStatus.update_available && (updateStatus.release_notes || updateStatus.component_changes) && (
                        <div className="space-y-3">
                            {/* Collapsible release notes header */}
                            <button
                                onClick={() => setShowReleaseNotes(!showReleaseNotes)}
                                className="w-full flex items-center justify-between p-3 bg-glass/50 hover:bg-glass rounded-xl transition-colors"
                            >
                                <div className="flex items-center gap-2">
                                    <FileText size={16} className="text-accent" />
                                    <span className="text-sm font-medium text-textPrimary">What's in this update</span>
                                </div>
                                {showReleaseNotes ? (
                                    <ChevronUp size={16} className="text-textSecondary" />
                                ) : (
                                    <ChevronDown size={16} className="text-textSecondary" />
                                )}
                            </button>

                            {/* Expanded content */}
                            {showReleaseNotes && (
                                <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                                    {/* Component changes */}
                                    {updateStatus.component_changes && (
                                        <div className="space-y-2">
                                            <p className="text-xs text-textSecondary font-medium uppercase tracking-wide px-1">
                                                Components Updating
                                            </p>
                                            <div className="space-y-2">
                                                {renderComponentChange(
                                                    'StreamNook',
                                                    updateStatus.component_changes.streamnook,
                                                    <Package size={16} className="text-purple-400" />
                                                )}
                                                {renderComponentChange(
                                                    'Streamlink',
                                                    updateStatus.component_changes.streamlink,
                                                    <Package size={16} className="text-purple-400" />
                                                )}
                                                {renderComponentChange(
                                                    'TTV LOL',
                                                    updateStatus.component_changes.ttvlol,
                                                    <Package size={16} className="text-purple-400" />
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Release notes */}
                                    {updateStatus.release_notes && (
                                        <div className="space-y-2">
                                            <p className="text-xs text-textSecondary font-medium uppercase tracking-wide px-1">
                                                Release Notes
                                            </p>
                                            <div className="p-4 bg-glass/30 rounded-xl max-h-64 overflow-y-auto scrollbar-thin">
                                                <ul className="space-y-1">
                                                    {formatReleaseNotes(updateStatus.release_notes)}
                                                </ul>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
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
