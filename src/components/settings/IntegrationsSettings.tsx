import { useAppStore } from '../../stores/AppStore';
import { useState, useEffect } from 'react';

const IntegrationsSettings = () => {
  const { settings, updateSettings } = useAppStore();
  const [ttvlolInstalledVersion, setTtvlolInstalledVersion] = useState<string | null>(null);

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
        console.error('Failed to get TTV LOL plugin version:', error);
        setTtvlolInstalledVersion(null);
      }
    };

    loadTtvlolVersion();
  }, [settings.ttvlol_plugin?.enabled]);

  return (
    <div className="space-y-6">
      {/* Discord Rich Presence */}
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.discord_rpc_enabled}
            onChange={(e) => updateSettings({ ...settings, discord_rpc_enabled: e.target.checked })}
            className="w-5 h-5 accent-accent cursor-pointer"
          />
          <div>
            <span className="text-sm font-medium text-textPrimary">
              Enable Discord Rich Presence
            </span>
            <p className="text-xs text-textSecondary">Show what you're watching on Discord</p>
          </div>
        </label>
      </div>

      {/* TTV LOL Plugin Section */}
      <div className="pt-4 border-t border-borderSubtle">
        <h3 className="text-lg font-semibold text-textPrimary mb-4">TTV LOL Ad Blocker Plugin</h3>

        <div className="space-y-4">
          {/* Enable Plugin */}
          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.ttvlol_plugin?.enabled ?? false}
                onChange={async (e) => {
                  const enabled = e.target.checked;

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
                          console.error('Failed to download plugin:', error);
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
                      console.error('Failed to check plugin:', error);
                    }
                  } else {
                    updateSettings({
                      ...settings,
                      ttvlol_plugin: { ...settings.ttvlol_plugin, enabled: false },
                    });
                  }
                }}
                className="w-5 h-5 accent-accent cursor-pointer"
              />
              <div>
                <span className="text-sm font-medium text-textPrimary">Enable TTV LOL Plugin</span>
                <p className="text-xs text-textSecondary">
                  Block ads on Twitch streams using the TTV LOL plugin
                </p>
              </div>
            </label>
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
