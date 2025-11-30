import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../../stores/AppStore';
import { Check, Loader2, Download, RefreshCw, Package, ArrowRight, AlertCircle } from 'lucide-react';

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
}

const UpdatesSettings = () => {
    const { addToast } = useAppStore();
    const [isChecking, setIsChecking] = useState(true);
    const [isUpdating, setIsUpdating] = useState(false);
    const [updateProgress, setUpdateProgress] = useState<string | null>(null);
    const [updateStatus, setUpdateStatus] = useState<BundleUpdateStatus | null>(null);
    const [error, setError] = useState<string | null>(null);

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

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-lg font-semibold text-textPrimary">Updates</h3>
                    <p className="text-xs text-textSecondary mt-1">
                        StreamNook bundles all components for easy updates
                    </p>
                </div>
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
                    {/* Current version info */}
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
                            {updateStatus.download_size && updateStatus.update_available && (
                                <span className="text-xs text-textMuted bg-glass px-2 py-1 rounded">
                                    {updateStatus.download_size}
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Component changes */}
                    {updateStatus.update_available && updateStatus.component_changes && (
                        <div className="space-y-2">
                            <p className="text-xs text-textSecondary font-medium uppercase tracking-wide">
                                What's Updating
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

                    {/* Update button */}
                    <button
                        onClick={handleUpdate}
                        disabled={isUpdating || !updateStatus.update_available}
                        className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium transition-all ${updateStatus.update_available
                            ? 'bg-yellow-500 hover:bg-yellow-600 text-white'
                            : 'bg-gray-600/50 text-textMuted cursor-not-allowed'
                            }`}
                    >
                        {isUpdating ? (
                            <>
                                <Loader2 size={18} className="animate-spin" />
                                {updateProgress || 'Updating...'}
                            </>
                        ) : updateStatus.update_available ? (
                            <>
                                <Download size={18} />
                                Update & Restart
                            </>
                        ) : (
                            <>
                                <Check size={18} />
                                Up to Date
                            </>
                        )}
                    </button>

                    {/* Info note */}
                    {updateStatus.update_available && (
                        <p className="text-xs text-textMuted text-center">
                            The app will restart automatically after the update is installed
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};

export default UpdatesSettings;
