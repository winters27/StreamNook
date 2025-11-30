import { useAppStore } from '../stores/AppStore';
import { X } from 'lucide-react';
import { useState } from 'react';
import PlayerSettings from './settings/PlayerSettings';
import ChatSettings from './settings/ChatSettings';
import IntegrationsSettings from './settings/IntegrationsSettings';
import CacheSettings from './settings/CacheSettings';
import NotificationsSettings from './settings/NotificationsSettings';
import SupportSettings from './settings/SupportSettings';
import UpdatesSettings from './settings/UpdatesSettings';

type Tab = 'Player' | 'Chat' | 'Integrations' | 'Notifications' | 'Updates' | 'Cache' | 'Support';

const SettingsDialog = () => {
  const { isSettingsOpen, closeSettings } = useAppStore();
  const [activeTab, setActiveTab] = useState<Tab>('Player');

  if (!isSettingsOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="glass-panel backdrop-blur-lg p-6 rounded-lg w-full max-w-2xl mx-4 shadow-2xl max-h-[90vh] flex flex-col">
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
              {(['Player', 'Chat', 'Integrations', 'Notifications', 'Updates', 'Cache', 'Support'] as Tab[]).map((tab) => (
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
            {activeTab === 'Player' && <PlayerSettings />}
            {activeTab === 'Chat' && <ChatSettings />}
            {activeTab === 'Integrations' && <IntegrationsSettings />}
            {activeTab === 'Notifications' && <NotificationsSettings />}
            {activeTab === 'Updates' && <UpdatesSettings />}
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
