import { useAppStore } from '../../stores/AppStore';
import { Check, XCircle } from 'lucide-react';

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

      {/* Streamlink Path */}
      <div>
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
