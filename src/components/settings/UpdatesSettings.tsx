import { useAppStore } from '../../stores/AppStore';
import { Check, XCircle } from 'lucide-react';
import { useState, useEffect } from 'react';

interface UpdatesSettingsProps {
    isStreamlinkInstalled: boolean | null;
    updateAvailable: boolean;
    installedVersion: string | null;
    latestVersion: string | null;
}

const UpdatesSettings = ({
    isStreamlinkInstalled,
    updateAvailable,
    installedVersion,
    latestVersion,
}: UpdatesSettingsProps) => {
    const { settings, updateSettings } = useAppStore();
    const [appCurrentVersion, setAppCurrentVersion] = useState<string | null>(null);
    const [appLatestVersion, setAppLatestVersion] = useState<string | null>(null);
    const [appUpdateAvailable, setAppUpdateAvailable] = useState<boolean>(false);
    const [isCheckingAppUpdate, setIsCheckingAppUpdate] = useState<boolean>(false);

    // Load app version and check for updates
    useEffect(() => {
        const loadAppVersionAndCheckUpdates = async () => {
            setIsCheckingAppUpdate(true);
            try {
                const { invoke } = await import('@tauri-apps/api/core');

                // Get current version
                const current = (await invoke('get_current_app_version')) as string;
                setAppCurrentVersion(current);

                // Get latest version
                const latest = (await invoke('get_latest_app_version')) as string;
                setAppLatestVersion(latest);

                // Compare versions
                const needsUpdate = current !== latest;
                setAppUpdateAvailable(needsUpdate);
            } catch (error) {
                console.error('Failed to check app version:', error);
                setAppCurrentVersion(null);
                setAppLatestVersion(null);
                setAppUpdateAvailable(false);
            } finally {
                setIsCheckingAppUpdate(false);
            }
        };

        loadAppVersionAndCheckUpdates();
    }, []);

    return (
        <div className="space-y-6">
            {/* App Update Section */}
            <div>
                <h3 className="text-lg font-semibold text-textPrimary mb-4">StreamNook Updates</h3>

                <div className="space-y-2">
                    {isCheckingAppUpdate ? (
                        <p className="text-xs text-textSecondary">Checking for updates...</p>
                    ) : appCurrentVersion && appLatestVersion ? (
                        <>
                            <p className="text-xs">
                                <span className="text-textSecondary">Current: </span>
                                <span className="text-textPrimary font-medium">v{appCurrentVersion}</span>
                                <span className="text-textSecondary"> → Latest: </span>
                                <span
                                    className={
                                        appUpdateAvailable
                                            ? 'text-yellow-300 font-medium'
                                            : 'text-green-400 font-medium'
                                    }
                                >
                                    v{appLatestVersion}
                                </span>
                            </p>
                            <button
                                onClick={async () => {
                                    if (!appUpdateAvailable) {
                                        const { addToast } = useAppStore.getState();
                                        addToast(`StreamNook is up to date (v${appCurrentVersion})`, 'success');
                                        return;
                                    }

                                    try {
                                        const { invoke } = await import('@tauri-apps/api/core');
                                        const { addToast } = useAppStore.getState();

                                        addToast('Downloading update...', 'info');

                                        try {
                                            const version = (await invoke('download_and_install_app_update')) as string;
                                            addToast(
                                                `Update downloaded! Installing v${version}... The app will restart.`,
                                                'success'
                                            );
                                        } catch (error) {
                                            console.error('Failed to download update:', error);
                                            addToast('Failed to download update: ' + error, 'error');
                                        }
                                    } catch (error) {
                                        console.error('Failed to check for updates:', error);
                                        const { addToast } = useAppStore.getState();
                                        addToast('Failed to check for updates: ' + error, 'error');
                                    }
                                }}
                                disabled={!appUpdateAvailable}
                                className={`px-4 py-2 text-white text-sm font-medium rounded transition-all ${appUpdateAvailable
                                        ? 'bg-yellow-500 hover:bg-yellow-600'
                                        : 'bg-gray-600 cursor-not-allowed opacity-50'
                                    }`}
                            >
                                {appUpdateAvailable ? (
                                    'Update & Restart'
                                ) : (
                                    <span className="flex items-center gap-2">
                                        <Check size={16} className="text-green-400" strokeWidth={3} />
                                        Up to Date
                                    </span>
                                )}
                            </button>
                        </>
                    ) : (
                        <p className="text-xs text-textSecondary">Unable to check for updates</p>
                    )}
                </div>
            </div>

            {/* Streamlink Path */}
            <div className="pt-4 border-t border-borderSubtle">
                <h3 className="text-lg font-semibold text-textPrimary mb-4">Streamlink Updates</h3>

                <label className="block text-sm font-medium text-textPrimary mb-2">
                    Streamlink Path
                </label>
                <div className="relative">
                    <input
                        type="text"
                        value={settings.streamlink_path}
                        onChange={(e) => updateSettings({ ...settings, streamlink_path: e.target.value })}
                        placeholder="Path to streamlink executable"
                        className="w-full glass-input text-textPrimary text-sm px-3 py-2 placeholder-textSecondary pr-10"
                    />
                    {isStreamlinkInstalled === true && !updateAvailable && (
                        <Check
                            size={20}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-green-400 font-bold"
                            strokeWidth={3}
                        />
                    )}
                    {isStreamlinkInstalled === true && updateAvailable && (
                        <Check
                            size={20}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-yellow-300 font-bold"
                            strokeWidth={3}
                        />
                    )}
                    {isStreamlinkInstalled === false && settings.streamlink_path && (
                        <XCircle size={20} className="absolute right-3 top-1/2 -translate-y-1/2 text-red-500" />
                    )}
                </div>
                {installedVersion && latestVersion && (
                    <p className="text-xs mt-1">
                        <span className="text-textSecondary">Current: </span>
                        <span className="text-textPrimary font-medium">{installedVersion}</span>
                        <span className="text-textSecondary"> → Latest: </span>
                        <span
                            className={
                                updateAvailable ? 'text-yellow-300 font-medium' : 'text-green-400 font-medium'
                            }
                        >
                            {latestVersion}
                        </span>
                    </p>
                )}
                {!installedVersion && (
                    <p className="text-xs text-textSecondary mt-1">
                        Location of the streamlink executable on your system
                    </p>
                )}
                <button
                    onClick={async () => {
                        // If streamlink is already installed and up to date, show message
                        if (!updateAvailable && isStreamlinkInstalled === true) {
                            const { addToast } = useAppStore.getState();
                            addToast(`Streamlink is up to date (v${installedVersion})`, 'success');
                            return;
                        }

                        try {
                            const { invoke } = await import('@tauri-apps/api/core');
                            const filePath = (await invoke('download_streamlink_installer')) as string;

                            // Extract the directory path from the file path
                            const downloadsDir = filePath.substring(0, filePath.lastIndexOf('\\'));

                            // Show success toast with action button to open downloads folder
                            const { addToast } = useAppStore.getState();
                            addToast('Streamlink installer downloaded successfully!', 'success', {
                                label: 'Open Downloads',
                                onClick: async () => {
                                    try {
                                        await invoke('open_browser_url', { url: downloadsDir });
                                    } catch (e) {
                                        console.error('Failed to open downloads folder:', e);
                                    }
                                },
                            });
                        } catch (error) {
                            console.error('Failed to download Streamlink installer:', error);
                            const { addToast } = useAppStore.getState();
                            addToast('Failed to download Streamlink installer: ' + error, 'error');
                        }
                    }}
                    className={`mt-2 px-4 py-2 text-white text-sm font-medium rounded transition-all ${updateAvailable
                            ? 'bg-yellow-500 hover:bg-yellow-600'
                            : isStreamlinkInstalled === true
                                ? 'bg-gray-600 cursor-not-allowed opacity-50'
                                : 'bg-green-600 hover:bg-green-700'
                        }`}
                >
                    {updateAvailable ? (
                        'Update Streamlink'
                    ) : isStreamlinkInstalled === true ? (
                        <span className="flex items-center gap-2">
                            <Check size={16} className="text-green-400" strokeWidth={3} />
                            Up to Date
                        </span>
                    ) : (
                        'Download Streamlink Installer'
                    )}
                </button>
            </div>
        </div>
    );
};

export default UpdatesSettings;
