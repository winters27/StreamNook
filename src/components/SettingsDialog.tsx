import { useAppStore } from '../stores/AppStore';
import { X } from 'lucide-react';
import { useState, useEffect } from 'react';
import GeneralSettings from './settings/GeneralSettings';
import PlayerSettings from './settings/PlayerSettings';
import ChatSettings from './settings/ChatSettings';
import IntegrationsSettings from './settings/IntegrationsSettings';
import CacheSettings from './settings/CacheSettings';
import NotificationsSettings from './settings/NotificationsSettings';
import SupportSettings from './settings/SupportSettings';

type Tab = 'General' | 'Player' | 'Chat' | 'Integrations' | 'Notifications' | 'Cache' | 'Support';

const SettingsDialog = () => {
  const { settings, updateSettings, isSettingsOpen, closeSettings } = useAppStore();
  const [activeTab, setActiveTab] = useState<Tab>('General');
  const [isStreamlinkInstalled, setIsStreamlinkInstalled] = useState<boolean | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState<boolean>(false);
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [ttvlolInstalledVersion, setTtvlolInstalledVersion] = useState<string | null>(null);
  const [ttvlolLatestVersion, setTtvlolLatestVersion] = useState<string | null>(null);
  const [ttvlolUpdateAvailable, setTtvlolUpdateAvailable] = useState<boolean>(false);

  // Verify streamlink installation and check for updates whenever the path changes
  useEffect(() => {
    const verifyAndCheckUpdates = async () => {
      if (!settings.streamlink_path) {
        setIsStreamlinkInstalled(false);
        setUpdateAvailable(false);
        return;
      }

      try {
        const { invoke } = await import('@tauri-apps/api/core');

        // Check if installed
        const isInstalled = await invoke('verify_streamlink_installation', {
          path: settings.streamlink_path
        }) as boolean;
        setIsStreamlinkInstalled(isInstalled);

        if (isInstalled) {
          // Get installed version
          const installed = await invoke('get_installed_streamlink_version', {
            path: settings.streamlink_path
          }) as string | null;
          setInstalledVersion(installed);

          if (installed) {
            // Get latest version
            const latest = await invoke('get_latest_streamlink_version') as string;
            setLatestVersion(latest);

            // Compare versions (simple string comparison works for semantic versioning)
            const needsUpdate = installed !== latest;
            setUpdateAvailable(needsUpdate);
          } else {
            setLatestVersion(null);
            setUpdateAvailable(false);
          }
        } else {
          setInstalledVersion(null);
          setLatestVersion(null);
          setUpdateAvailable(false);
        }
      } catch (error) {
        console.error('Failed to verify streamlink installation:', error);
        setIsStreamlinkInstalled(false);
        setUpdateAvailable(false);
      }
    };

    verifyAndCheckUpdates();
  }, [settings.streamlink_path]);

  // Load TTV LOL plugin version and check for updates when settings dialog opens
  useEffect(() => {
    const loadTtvlolVersionAndCheckUpdates = async () => {
      if (!isSettingsOpen || !settings.ttvlol_plugin?.enabled) {
        setTtvlolInstalledVersion(null);
        setTtvlolLatestVersion(null);
        setTtvlolUpdateAvailable(false);
        return;
      }

      try {
        const { invoke } = await import('@tauri-apps/api/core');

        // Get installed version
        const installed = await invoke('get_installed_ttvlol_version') as string | null;
        setTtvlolInstalledVersion(installed);

        // Update settings with the version if not already set
        if (installed && installed !== settings.ttvlol_plugin.installed_version) {
          updateSettings({
            ...settings,
            ttvlol_plugin: { ...settings.ttvlol_plugin, installed_version: installed }
          });
        }

        if (installed) {
          // Get latest version
          const latest = await invoke('get_latest_ttvlol_version') as string;
          setTtvlolLatestVersion(latest);

          // Compare versions
          const needsUpdate = installed !== latest;
          setTtvlolUpdateAvailable(needsUpdate);
        } else {
          setTtvlolLatestVersion(null);
          setTtvlolUpdateAvailable(false);
        }
      } catch (error) {
        console.error('Failed to get TTV LOL plugin version:', error);
        setTtvlolInstalledVersion(null);
        setTtvlolLatestVersion(null);
        setTtvlolUpdateAvailable(false);
      }
    };

    loadTtvlolVersionAndCheckUpdates();
  }, [isSettingsOpen, settings.ttvlol_plugin?.enabled]);

  if (!isSettingsOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
      <div className={`glass-panel backdrop-blur-lg p-6 rounded-lg w-full mx-4 shadow-2xl max-h-[90vh] flex flex-col ${activeTab === 'Notifications' ? 'max-w-fit' : 'max-w-2xl'
        }`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-borderSubtle">
          <h2 className="text-xl font-bold text-textPrimary">Settings</h2>
          <button
            onClick={closeSettings}
            className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all"
            title="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Tabs Navigation */}
          <div className="w-1/4 pr-6 border-r border-borderSubtle">
            <nav className="flex flex-col space-y-2">
              {(['General', 'Player', 'Chat', 'Integrations', 'Notifications', 'Cache', 'Support'] as Tab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 text-left text-sm font-medium rounded transition-all ${activeTab === tab
                    ? 'glass-button text-white'
                    : 'text-textSecondary hover:bg-glass-hover'
                    }`}
                >
                  {tab}
                </button>
              ))}
            </nav>
          </div>

          {/* Settings Form */}
          <div className="flex-1 pl-6 overflow-y-auto scrollbar-thin">
            {activeTab === 'General' && (
              <GeneralSettings
                isStreamlinkInstalled={isStreamlinkInstalled}
                updateAvailable={updateAvailable}
                installedVersion={installedVersion}
                latestVersion={latestVersion}
              />
            )}
            {activeTab === 'Player' && <PlayerSettings />}
            {activeTab === 'Chat' && <ChatSettings />}
            {activeTab === 'Integrations' && <IntegrationsSettings />}
            {activeTab === 'Notifications' && <NotificationsSettings />}
            {activeTab === 'Cache' && <CacheSettings />}
            {activeTab === 'Support' && <SupportSettings />}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-borderSubtle">
          <button
            onClick={closeSettings}
            className="px-4 py-2 glass-button text-textPrimary text-sm font-medium"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsDialog;
