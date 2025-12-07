import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, X, AlertTriangle, ExternalLink } from 'lucide-react';
import { useAppStore } from '../stores/AppStore';

const StreamlinkMissingDialog = () => {
    const {
        showStreamlinkMissing,
        pendingStreamChannel,
        pendingStreamInfo,
        settings,
        updateSettings,
        startStream,
        addToast
    } = useAppStore();

    const [isSelecting, setIsSelecting] = useState(false);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);

    const handleSelectFolder = async () => {
        try {
            setIsSelecting(true);
            const selected = await open({
                directory: true,
                multiple: false,
                title: 'Select Streamlink Folder',
            });

            if (selected && typeof selected === 'string') {
                setSelectedPath(selected);
            }
        } catch (error) {
            console.error('Failed to open folder picker:', error);
            addToast('Failed to open folder picker', 'error');
        } finally {
            setIsSelecting(false);
        }
    };

    const handleConfirm = async () => {
        if (!selectedPath) {
            addToast('Please select a Streamlink folder first', 'warning');
            return;
        }

        // Update settings with the custom path
        const streamlinkDefaults = {
            low_latency_enabled: true,
            hls_live_edge: 3,
            stream_timeout: 60,
            retry_streams: 3,
            disable_hosting: true,
            skip_ssl_verify: false,
            use_proxy: true,
            proxy_playlist: '--twitch-proxy-playlist=https://lb-na.cdn-perfprod.com,https://eu.luminous.dev --twitch-proxy-playlist-fallback',
        };

        const currentStreamlink = settings.streamlink || streamlinkDefaults;
        const newSettings = {
            ...settings,
            streamlink: {
                ...currentStreamlink,
                custom_streamlink_path: selectedPath
            }
        };

        await updateSettings(newSettings);
        addToast('Streamlink path saved!', 'success');

        // Close the dialog
        useAppStore.setState({
            showStreamlinkMissing: false,
            pendingStreamChannel: null,
            pendingStreamInfo: null
        });

        // Resume the pending stream
        if (pendingStreamChannel) {
            setTimeout(() => {
                startStream(pendingStreamChannel, pendingStreamInfo || undefined);
            }, 500);
        }
    };

    const handleCancel = () => {
        useAppStore.setState({
            showStreamlinkMissing: false,
            pendingStreamChannel: null,
            pendingStreamInfo: null
        });
    };

    const handleOpenSettings = () => {
        useAppStore.setState({
            showStreamlinkMissing: false,
            pendingStreamChannel: null,
            pendingStreamInfo: null,
            isSettingsOpen: true,
            settingsInitialTab: 'Player'
        });
    };

    if (!showStreamlinkMissing) return null;

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
                onClick={handleCancel}
            >
                <motion.div
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.9, opacity: 0 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                    className="bg-glass border border-borderColor rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between p-4 border-b border-borderColor">
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-yellow-500/20 text-yellow-400">
                                <AlertTriangle size={24} />
                            </div>
                            <div>
                                <h2 className="text-lg font-semibold text-textPrimary">Streamlink Not Found</h2>
                                <p className="text-sm text-textSecondary">Required to play streams</p>
                            </div>
                        </div>
                        <button
                            onClick={handleCancel}
                            className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-colors"
                        >
                            <X size={20} />
                        </button>
                    </div>

                    {/* Content */}
                    <div className="p-4 space-y-4">
                        <p className="text-sm text-textSecondary">
                            StreamNook couldn't find the bundled Streamlink executable. This usually happens if:
                        </p>
                        <ul className="text-sm text-textSecondary list-disc list-inside space-y-1 pl-2">
                            <li>The streamlink folder was removed or moved</li>
                            <li>Your antivirus quarantined the files</li>
                            <li>You're running a development build without bundled files</li>
                        </ul>

                        <div className="p-3 bg-glass rounded-lg border border-borderColor">
                            <p className="text-sm text-textPrimary font-medium mb-2">
                                Select your Streamlink installation folder:
                            </p>
                            <div className="flex gap-2">
                                <div className="flex-1 relative">
                                    <input
                                        type="text"
                                        value={selectedPath || ''}
                                        readOnly
                                        placeholder="No folder selected..."
                                        className="w-full glass-input text-textPrimary text-sm px-3 py-2"
                                    />
                                </div>
                                <button
                                    onClick={handleSelectFolder}
                                    disabled={isSelecting}
                                    className="px-4 py-2 glass-button text-white text-sm font-medium rounded flex items-center gap-2 disabled:opacity-50"
                                >
                                    <FolderOpen size={16} />
                                    {isSelecting ? 'Selecting...' : 'Browse'}
                                </button>
                            </div>
                            {selectedPath && (
                                <p className="text-xs text-green-400 mt-2">
                                    ✓ Looking for: {selectedPath}/bin/streamlinkw.exe
                                </p>
                            )}
                        </div>

                        <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                            <p className="text-xs text-blue-400">
                                <strong>Need Streamlink?</strong> Download the portable version from{' '}
                                <a
                                    href="https://streamlink.github.io/install.html#windows-portable"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="underline hover:text-blue-300 inline-flex items-center gap-1"
                                >
                                    streamlink.github.io <ExternalLink size={12} />
                                </a>
                            </p>
                        </div>

                        <div className="text-xs text-textSecondary">
                            <strong className="text-textPrimary">Plugin Search Order:</strong>
                            <ol className="mt-1 list-decimal list-inside space-y-0.5">
                                <li>Custom folder: <code className="text-accent">&lt;your_path&gt;/plugins</code></li>
                                <li>AppData: <code className="text-accent">%APPDATA%/streamlink/plugins</code></li>
                                <li>Bundled: <code className="text-accent">&lt;app_dir&gt;/streamlink/plugins</code></li>
                            </ol>
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between p-4 border-t border-borderColor">
                        <button
                            onClick={handleOpenSettings}
                            className="text-sm text-textSecondary hover:text-textPrimary transition-colors"
                        >
                            Open Settings →
                        </button>
                        <div className="flex gap-2">
                            <button
                                onClick={handleCancel}
                                className="px-4 py-2 text-sm text-textSecondary hover:text-textPrimary transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirm}
                                disabled={!selectedPath}
                                className="px-4 py-2 glass-button text-white text-sm font-medium rounded disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Confirm & Start Stream
                            </button>
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
};

export default StreamlinkMissingDialog;
