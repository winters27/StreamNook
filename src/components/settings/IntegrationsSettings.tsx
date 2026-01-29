import { useAppStore } from '../../stores/AppStore';
import { useState, useEffect } from 'react';

import { Logger } from '../../utils/logger';
const IntegrationsSettings = () => {
  const { settings, updateSettings } = useAppStore();
  const [ttvlolInstalledVersion, setTtvlolInstalledVersion] = useState<string | null>(null);

  // Toggle component for reuse
  const Toggle = ({ enabled, onChange }: { enabled: boolean; onChange: () => void }) => (
    <button
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${enabled ? 'bg-accent' : 'bg-gray-600'
        }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'
          }`}
      />
    </button>
  );

  // Load TTV LOL plugin version
  useEffect(() => {
    const loadTtvlolVersion = async () => {
      if (!settings.ttvlol_plugin?.enabled) {
        setTtvlolInstalledVersion(null);
        return;
      }

      try {
        const { invoke } = await import('@tauri-apps/api/core');

        // Get installed version
        const installed = (await invoke('get_installed_ttvlol_version')) as string | null;
        setTtvlolInstalledVersion(installed);

        // Update settings with the version if not already set
        if (installed && installed !== settings.ttvlol_plugin.installed_version) {
          updateSettings({
            ...settings,
            ttvlol_plugin: { ...settings.ttvlol_plugin, installed_version: installed },
          });
        }
      } catch (error) {
        Logger.error('Failed to get TTV LOL plugin version:', error);
        setTtvlolInstalledVersion(null);
      }
    };

    loadTtvlolVersion();
  }, [settings.ttvlol_plugin?.enabled]);

  const handleTtvlolToggle = async () => {
    const enabled = !(settings.ttvlol_plugin?.enabled ?? false);

    // If enabling, check if plugin is installed
    if (enabled) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const installedVersion = (await invoke(
          'get_installed_ttvlol_version'
        )) as string | null;

        if (!installedVersion) {
          // Plugin not installed, download it
          const { addToast } = useAppStore.getState();
          addToast('Downloading TTV LOL plugin...', 'info');

          try {
            const version = (await invoke(
              'download_and_install_ttvlol_plugin'
            )) as string;
            addToast(`TTV LOL plugin v${version} installed successfully!`, 'success');
            updateSettings({
              ...settings,
              ttvlol_plugin: { enabled: true, installed_version: version },
            });
          } catch (error) {
            Logger.error('Failed to download plugin:', error);
            addToast('Failed to download TTV LOL plugin: ' + error, 'error');
            return;
          }
        } else {
          updateSettings({
            ...settings,
            ttvlol_plugin: { ...settings.ttvlol_plugin, enabled: true },
          });
        }
      } catch (error) {
        Logger.error('Failed to check plugin:', error);
      }
    } else {
      updateSettings({
        ...settings,
        ttvlol_plugin: { ...settings.ttvlol_plugin, enabled: false },
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Discord Rich Presence */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <span className="text-sm font-medium text-textPrimary">
            Enable Discord Rich Presence
          </span>
          <p className="text-xs text-textSecondary">Show what you're watching on Discord</p>
        </div>
        <Toggle
          enabled={settings.discord_rpc_enabled}
          onChange={() => updateSettings({ ...settings, discord_rpc_enabled: !settings.discord_rpc_enabled })}
        />
      </div>

      {/* TTV LOL Plugin Section */}
      <div className="pt-4 border-t border-borderSubtle">
        <h3 className="text-lg font-semibold text-textPrimary mb-4">TTV LOL Ad Blocker Plugin</h3>

        <div className="space-y-4">
          {/* Enable Plugin */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-sm font-medium text-textPrimary">Enable TTV LOL Plugin</span>
              <p className="text-xs text-textSecondary">
                Block ads on Twitch streams using the TTV LOL plugin
              </p>
            </div>
            <Toggle
              enabled={settings.ttvlol_plugin?.enabled ?? false}
              onChange={handleTtvlolToggle}
            />
          </div>

          {/* Plugin Version Info */}
          {settings.ttvlol_plugin?.enabled && ttvlolInstalledVersion && (
            <p className="text-xs text-textSecondary">
              Installed version: <span className="text-textPrimary font-medium">{ttvlolInstalledVersion}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default IntegrationsSettings;
