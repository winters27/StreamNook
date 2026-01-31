import { useAppStore, SettingsTab } from '../stores/AppStore';
import { X } from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';
import InterfaceSettings from './settings/InterfaceSettings';
import PlayerSettings from './settings/PlayerSettings';
import ChatSettings from './settings/ChatSettings';
import ThemeSettings from './settings/ThemeSettings';
import NetworkSettings from './settings/NetworkSettings';
import IntegrationsSettings from './settings/IntegrationsSettings';
import CacheSettings from './settings/CacheSettings';
import NotificationsSettings from './settings/NotificationsSettings';
import SupportSettings from './settings/SupportSettings';
import UpdatesSettings from './settings/UpdatesSettings';
import AnalyticsSettings from './settings/AnalyticsSettings';
import { useIsAdmin } from './DashboardWidget';

// Define sections for each settings tab
const TAB_SECTIONS: Record<string, { id: string; label: string }[]> = {
  Interface: [
    { id: 'sidebar', label: 'Sidebar' },
    { id: 'compact', label: 'Compact Mode' },
  ],
  Player: [
    { id: 'auto-switch', label: 'Auto-Switch' },
    { id: 'streamlink-location', label: 'Streamlink Location' },
    { id: 'streamlink-optimization', label: 'Optimization' },
    { id: 'video-player', label: 'Video Player' },
  ],
  Chat: [],
  Theme: [],
  Network: [],
  Integrations: [],
  Notifications: [],
  Cache: [],
  Support: [],
  Updates: [],
  Analytics: [],
};

const SettingsDialog = () => {
  const { isSettingsOpen, settingsInitialTab, closeSettings } = useAppStore();
  const [activeTab, setActiveTab] = useState<SettingsTab>('Player');
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isAdmin = useIsAdmin();

  // Standard tabs available to everyone
  const standardTabs: SettingsTab[] = ['Interface', 'Player', 'Chat', 'Theme', 'Network', 'Integrations', 'Notifications', 'Cache', 'Support', 'Updates'];

  // Add Analytics tab only for admin users
  const availableTabs = isAdmin ? [...standardTabs, 'Analytics' as SettingsTab] : standardTabs;

  // Update active tab when initial tab changes
  useEffect(() => {
    if (settingsInitialTab) {
      queueMicrotask(() => setActiveTab(settingsInitialTab));
    }
  }, [settingsInitialTab]);

  // Reset when dialog closes
  useEffect(() => {
    if (!isSettingsOpen) {
      queueMicrotask(() => {
        setActiveTab('Player');
        setActiveSection(null);
      });
    }
  }, [isSettingsOpen]);

  // Scroll to section
  const scrollToSection = useCallback((sectionId: string) => {
    setActiveSection(sectionId);
    // Use setTimeout to ensure the DOM has rendered
    setTimeout(() => {
      const element = document.getElementById(`settings-section-${sectionId}`);
      if (element && contentRef.current) {
        const containerTop = contentRef.current.getBoundingClientRect().top;
        const elementTop = element.getBoundingClientRect().top;
        const offset = elementTop - containerTop + contentRef.current.scrollTop;
        contentRef.current.scrollTo({ top: offset, behavior: 'smooth' });
      }
    }, 50);
  }, []);



  if (!isSettingsOpen) return null;

  // Get sections for current tab
  const currentSections = activeTab ? TAB_SECTIONS[activeTab] || [] : [];

  // Determine dialog size based on active tab
  const isWideTab = activeTab === 'Analytics' || activeTab === 'Theme';

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
      <div className={`glass-panel backdrop-blur-lg p-6 rounded-lg mx-4 shadow-2xl flex flex-col transition-all duration-300 ${isWideTab ? 'w-[95vw] md:w-[90vw] lg:w-[85vw] max-w-7xl h-[90vh]' : 'w-[90vw] md:w-[80vw] lg:w-[70vw] xl:w-[60vw] max-w-6xl max-h-[85vh] min-h-[300px]'}`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-borderSubtle">
          <div className="flex items-center gap-3">
            {/* Back button for pages without sidebar */}
            {currentSections.length === 0 && (
              <button
                onClick={() => setActiveTab('Player')}
                className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all"
                title="Back to settings"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7"/>
                </svg>
              </button>
            )}
            <h2 className="text-xl font-bold text-textPrimary">
              {activeTab}
            </h2>
          </div>
          <button
            onClick={closeSettings}
            className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all"
            title="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar Navigation - only show when tab has sections */}
          {currentSections.length > 0 && (
            <div className="w-1/4 pr-6 border-r border-borderSubtle overflow-y-auto scrollbar-thin">
              <nav className="flex flex-col space-y-1">
                {availableTabs.map((tab) => (
                  <div key={tab}>
                    <button
                      onClick={() => {
                        setActiveTab(tab);
                        setActiveSection(null);
                        if (contentRef.current) {
                          contentRef.current.scrollTo({ top: 0, behavior: 'smooth' });
                        }
                      }}
                      className={`w-full px-4 py-2.5 text-left text-sm font-medium rounded-lg transition-all ${
                        activeTab === tab
                          ? 'text-textPrimary bg-glass'
                          : 'text-textSecondary hover:bg-glass-hover hover:text-textPrimary'
                      } ${tab === 'Analytics' ? 'border-l-2 border-accent' : ''}`}
                    >
                      {tab}
                    </button>
                    {/* Show sections for active tab */}
                    {activeTab === tab && TAB_SECTIONS[tab]?.length > 0 && (
                      <div className="ml-4 mt-1 space-y-1">
                        {TAB_SECTIONS[tab].map((section) => (
                          <button
                            key={section.id}
                            onClick={() => scrollToSection(section.id)}
                            className={`w-full px-3 py-1.5 text-left text-xs font-medium rounded transition-all ${
                              activeSection === section.id
                                ? 'text-accent bg-accent/10'
                                : 'text-textMuted hover:text-textSecondary'
                            }`}
                          >
                            {section.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </nav>
            </div>
          )}

          {/* Content Area */}
          <div ref={contentRef} className={`flex-1 overflow-y-auto scrollbar-thin ${currentSections.length > 0 ? 'pl-6' : ''}`}>
            {activeTab === 'Interface' && <InterfaceSettings />}
            {activeTab === 'Player' && <PlayerSettings />}
            {activeTab === 'Chat' && <ChatSettings />}
            {activeTab === 'Theme' && <ThemeSettings />}
            {activeTab === 'Network' && <NetworkSettings />}
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
