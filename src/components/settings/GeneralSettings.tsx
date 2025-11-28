import { useAppStore } from '../../stores/AppStore';
import { Check, XCircle } from 'lucide-react';
import { useState, useEffect } from 'react';

interface GeneralSettingsProps {
  isStreamlinkInstalled: boolean | null;
  updateAvailable: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
}

const GeneralSettings = ({
  isStreamlinkInstalled,
  updateAvailable,
  installedVersion,
  latestVersion,
}: GeneralSettingsProps) => {
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
      {/* Stream Quality */}
      <div>
        <label className="block text-sm font-medium text-textPrimary mb-2">
          Stream Quality
        </label>
        <select
          value={settings.quality}
          onChange={(e) => updateSettings({ ...settings, quality: e.target.value })}
          className="w-full glass-input text-textPrimary text-sm px-3 py-2"
        >
          <option value="best">Best</option>
          <option value="1080p60">1080p60</option>
          <option value="1080p">1080p</option>
          <option value="720p60">720p60</option>
          <option value="720p">720p</option>
          <option value="480p">480p</option>
          <option value="360p">360p</option>
          <option value="worst">Worst</option>
        </select>
      </div>

      {/* Chat Placement */}
      <div>
        <label className="block text-sm font-medium text-textPrimary mb-2">
          Chat Placement
        </label>
        <div className="flex gap-2">
          {['right', 'bottom', 'hidden'].map((placement) => (
            <button
              key={placement}
              onClick={() => updateSettings({ ...settings, chat_placement: placement as any })}
              className={`flex-1 px-4 py-2 text-sm font-medium rounded transition-all ${
                settings.chat_placement === placement
                  ? 'glass-button text-white'
                  : 'bg-glass text-textSecondary hover:bg-glass-hover'
              }`}
            >
              {placement.charAt(0).toUpperCase() + placement.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Auto-Switch Settings */}
      <div className="pt-4 border-t border-borderSubtle">
        <h3 className="text-lg font-semibold text-textPrimary mb-4">Auto-Switch</h3>
        <p className="text-xs text-textSecondary mb-4">
          When a stream goes offline, automatically switch to another stream.
        </p>
        
        <div className="space-y-4">
          {/* Enable Auto-Switch */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-textPrimary">
                Enable Auto-Switch
              </label>
              <p className="text-xs text-textSecondary">
                Automatically switch when current stream goes offline
              </p>
            </div>
            <button
              onClick={() =>
                updateSettings({
                  ...settings,
                  auto_switch: {
                    enabled: !(settings.auto_switch?.enabled ?? true),
                    mode: settings.auto_switch?.mode ?? 'same_category',
                    show_notification: settings.auto_switch?.show_notification ?? true,
                  },
                })
              }
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                settings.auto_switch?.enabled ?? true ? 'bg-purple-500' : 'bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.auto_switch?.enabled ?? true ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Switch Mode */}
          <div className={`${!(settings.auto_switch?.enabled ?? true) ? 'opacity-50 pointer-events-none' : ''}`}>
            <label className="text-sm font-medium text-textPrimary mb-2 block">
              Switch To
            </label>
            <p className="text-xs text-textSecondary mb-2">
              Choose where to auto-switch when stream goes offline
            </p>
            <div className="flex gap-2">
              <button
                onClick={() =>
                  updateSettings({
                    ...settings,
                    auto_switch: {
                      enabled: settings.auto_switch?.enabled ?? true,
                      mode: 'same_category',
                      show_notification: settings.auto_switch?.show_notification ?? true,
                    },
                  })
                }
                className={`flex-1 px-4 py-2 text-sm font-medium rounded transition-all ${
                  (settings.auto_switch?.mode ?? 'same_category') === 'same_category'
                    ? 'glass-button text-white'
                    : 'bg-glass text-textSecondary hover:bg-glass-hover'
                }`}
              >
                Same Category
              </button>
              <button
                onClick={() =>
                  updateSettings({
                    ...settings,
                    auto_switch: {
                      enabled: settings.auto_switch?.enabled ?? true,
                      mode: 'followed_streams',
                      show_notification: settings.auto_switch?.show_notification ?? true,
                    },
                  })
                }
                className={`flex-1 px-4 py-2 text-sm font-medium rounded transition-all ${
                  settings.auto_switch?.mode === 'followed_streams'
                    ? 'glass-button text-white'
                    : 'bg-glass text-textSecondary hover:bg-glass-hover'
                }`}
              >
                Followed Streams
              </button>
            </div>
            <p className="text-xs text-textSecondary mt-2">
              {(settings.auto_switch?.mode ?? 'same_category') === 'same_category' 
                ? 'Switch to the highest viewer stream in the same game/category'
                : 'Switch to one of your live followed streamers'}
            </p>
          </div>

          {/* Show Notification */}
          <div className={`flex items-center justify-between ${!(settings.auto_switch?.enabled ?? true) ? 'opacity-50 pointer-events-none' : ''}`}>
            <div>
              <label className="text-sm font-medium text-textPrimary">
                Show Notification
              </label>
              <p className="text-xs text-textSecondary">
                Display a toast when auto-switching streams
              </p>
            </div>
            <button
              onClick={() =>
                updateSettings({
                  ...settings,
                  auto_switch: {
                    enabled: settings.auto_switch?.enabled ?? true,
                    mode: settings.auto_switch?.mode ?? 'same_category',
                    show_notification: !(settings.auto_switch?.show_notification ?? true),
                  },
                })
              }
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                settings.auto_switch?.show_notification ?? true ? 'bg-purple-500' : 'bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.auto_switch?.show_notification ?? true ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* App Update Section */}
      <div className="pt-4 border-t border-borderSubtle">
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
                className={`px-4 py-2 text-white text-sm font-medium rounded transition-all ${
                  appUpdateAvailable
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
          className={`mt-2 px-4 py-2 text-white text-sm font-medium rounded transition-all ${
            updateAvailable
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

export default GeneralSettings;
