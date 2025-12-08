import { useAppStore, SettingsTab } from '../stores/AppStore';
import { X } from 'lucide-react';
import { useState, useEffect } from 'react';
import InterfaceSettings from './settings/InterfaceSettings';
import PlayerSettings from './settings/PlayerSettings';
import ChatSettings from './settings/ChatSettings';
import IntegrationsSettings from './settings/IntegrationsSettings';
import CacheSettings from './settings/CacheSettings';
import NotificationsSettings from './settings/NotificationsSettings';
import SupportSettings from './settings/SupportSettings';
import UpdatesSettings from './settings/UpdatesSettings';
import AnalyticsSettings from './settings/AnalyticsSettings';
import { useIsAdmin } from './DashboardWidget';

const SettingsDialog = () => {
  const { isSettingsOpen, settingsInitialTab, closeSettings } = useAppStore();
  const [activeTab, setActiveTab] = useState<SettingsTab>('Player');
  const isAdmin = useIsAdmin();

  // Standard tabs available to everyone
  const standardTabs: SettingsTab[] = ['Interface', 'Player', 'Chat', 'Integrations', 'Notifications', 'Cache', 'Support', 'Updates'];

  // Add Analytics tab only for admin users
  const availableTabs = isAdmin ? [...standardTabs, 'Analytics' as SettingsTab] : standardTabs;

  // Update active tab when initial tab changes
  useEffect(() => {
    if (settingsInitialTab) {
      setActiveTab(settingsInitialTab);
    }
  }, [settingsInitialTab]);

  // Reset to default tab when dialog closes
  useEffect(() => {
    if (!isSettingsOpen) {
      setActiveTab('Player');
    }
  }, [isSettingsOpen]);

  if (!isSettingsOpen) return null;

  // Determine dialog size based on active tab
  const isWideTab = activeTab === 'Analytics';

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
      <div className={`glass-panel backdrop-blur-lg p-6 rounded-lg mx-4 shadow-2xl flex flex-col transition-all duration-300 ${isWideTab ? 'w-[95vw] md:w-[90vw] lg:w-[85vw] max-w-7xl h-[90vh]' : 'w-[90vw] md:w-[80vw] lg:w-[70vw] xl:w-[60vw] max-w-6xl max-h-[90vh]'}`}>
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
              {availableTabs.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 text-left text-sm font-medium rounded transition-all ${activeTab === tab
                    ? 'glass-button text-white'
                    : 'text-textSecondary hover:bg-glass-hover'
                    } ${tab === 'Analytics' ? 'border-l-2 border-accent' : ''}`}
                >
                  {tab}
                </button>
              ))}
            </nav>
          </div>

          {/* Settings Form */}
          <div className="flex-1 pl-6 overflow-y-auto scrollbar-thin">
            {activeTab === 'Interface' && <InterfaceSettings />}
            {activeTab === 'Player' && <PlayerSettings />}
            {activeTab === 'Chat' && <ChatSettings />}
            {activeTab === 'Integrations' && <IntegrationsSettings />}
            {activeTab === 'Notifications' && <NotificationsSettings />}
            {activeTab === 'Cache' && <CacheSettings />}
            {activeTab === 'Support' && <SupportSettings />}
            {activeTab === 'Updates' && <UpdatesSettings />}
            {activeTab === 'Analytics' && isAdmin && <AnalyticsSettings />}
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
