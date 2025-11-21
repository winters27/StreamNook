import { useEffect, useState, useRef } from 'react';
import { useAppStore } from './stores/AppStore';
import TitleBar from './components/TitleBar';
import VideoPlayer from './components/VideoPlayer';
import ChatWidget from './components/ChatWidget';
import LiveOverlay from './components/LiveOverlay';
import SettingsDialog from './components/SettingsDialog';
import LoadingWidget from './components/LoadingWidget';
import ToastManager from './components/ToastManager';
import LiveStreamsOverlay from './components/LiveStreamsOverlay';
import ProfileOverlay from './components/ProfileOverlay';
import DropsOverlay from './components/DropsOverlay';
import BadgesOverlay from './components/BadgesOverlay';
import BadgeDetailOverlay from './components/BadgeDetailOverlay';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';

interface BadgeVersion {
  id: string;
  image_url_1x: string;
  image_url_2x: string;
  image_url_4x: string;
  title: string;
  description: string;
  click_action: string | null;
  click_url: string | null;
  set_id?: string;
}

function App() {
  const { loadSettings, chatPlacement, isLoading, currentStream, streamUrl, checkAuthStatus, showProfileOverlay, setShowProfileOverlay, addToast, setShowDropsOverlay, showBadgesOverlay, setShowBadgesOverlay, settings } = useAppStore();
  const [chatSize, setChatSize] = useState(384); // Default 384px (w-96)
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedBadge, setSelectedBadge] = useState<{ badge: BadgeVersion; setId: string } | null>(null);

  // Listen for badge detail events from chat
  useEffect(() => {
    const handleBadgeDetail = (event: CustomEvent) => {
      const { badge, setId } = event.detail;
      setSelectedBadge({ badge, setId });
    };

    window.addEventListener('show-badge-detail', handleBadgeDetail as EventListener);

    return () => {
      window.removeEventListener('show-badge-detail', handleBadgeDetail as EventListener);
    };
  }, []);

  useEffect(() => {
    const initializeApp = async () => {
      await loadSettings();
      await checkAuthStatus();
      
      // Pre-fetch cosmetics for current user
      const { currentUser, isAuthenticated } = useAppStore.getState();
      if (isAuthenticated && currentUser?.user_id) {
        console.log('[App] Pre-fetching cosmetics for current user...');
        const { prefetchAllUserData } = await import('./services/cosmeticsCache');
        prefetchAllUserData(currentUser.user_id).catch(err => 
          console.error('[App] Failed to pre-fetch user cosmetics:', err)
        );
      }
      
      // Set up event listeners for drops and channel points
      const unlistenChannelPoints = await listen('channel-points-claimed', (event: any) => {
        const claim = event.payload;
        addToast(`Claimed ${claim.points_earned} channel points!`, 'success');
      });
      
      // Cleanup listeners on unmount
      return () => {
        unlistenChannelPoints();
      };
    };
    
    initializeApp();
  }, [loadSettings, checkAuthStatus]);

  // Handle aspect ratio locking when setting changes or chat is resized
  useEffect(() => {
    const adjustWindowForAspectRatio = async () => {
      if (!settings.video_player?.lock_aspect_ratio || !streamUrl) return;

      try {
        const window = getCurrentWindow();
        
        // Get current window size using Tauri's API
        const size = await window.innerSize();
        const width = size.width;
        const height = size.height;
        
        console.log('Current window size:', width, height);
        console.log('Chat size:', chatSize);
        console.log('Chat placement:', chatPlacement);
        
        // Title bar height is approximately 32px
        const titleBarHeight = 32;
        
        const [newWidth, newHeight] = await invoke<[number, number]>('calculate_aspect_ratio_size', {
          currentWidth: width,
          currentHeight: height,
          chatSize: chatSize,
          chatPlacement: chatPlacement,
          titleBarHeight: titleBarHeight,
        });

        console.log('Calculated new size:', newWidth, newHeight);

        // Only resize if dimensions changed significantly (more than 5px difference)
        if (Math.abs(width - newWidth) > 5 || Math.abs(height - newHeight) > 5) {
          console.log('Resizing window to:', newWidth, newHeight);
          await window.setSize(new LogicalSize(newWidth, newHeight));
        } else {
          console.log('Size difference too small, not resizing');
        }
      } catch (error) {
        console.error('Failed to adjust window for aspect ratio:', error);
      }
    };

    adjustWindowForAspectRatio();
  }, [settings.video_player?.lock_aspect_ratio, chatSize, chatPlacement, streamUrl]);

  useEffect(() => {
    const checkUpdates = async () => {
      
      // Check for updates on startup (only once per component type)
      let streamlinkUpdateShown = false;
      let ttvlolUpdateShown = false;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const settings = useAppStore.getState().settings;
        
        // Check Streamlink updates
        if (settings.streamlink_path && !streamlinkUpdateShown) {
          const isInstalled = await invoke('verify_streamlink_installation', { 
            path: settings.streamlink_path 
          }) as boolean;
          
          if (isInstalled) {
            const installedVersion = await invoke('get_installed_streamlink_version', { 
              path: settings.streamlink_path 
            }) as string | null;
            
            if (installedVersion) {
              const latestVersion = await invoke('get_latest_streamlink_version') as string;
              
              if (installedVersion !== latestVersion) {
                streamlinkUpdateShown = true;
                const { addToast, openSettings } = useAppStore.getState();
                addToast(
                  `Streamlink update available! Current: ${installedVersion} → Latest: ${latestVersion}`,
                  'info',
                  {
                    label: 'Open Settings',
                    onClick: () => openSettings()
                  }
                );
              }
            }
          }
        }
        
        // Check TTV LOL plugin updates (if enabled)
        if (settings.ttvlol_plugin?.enabled && !ttvlolUpdateShown) {
          const installedVersion = await invoke('get_installed_ttvlol_version') as string | null;
          
          if (installedVersion) {
            const latestVersion = await invoke('get_latest_ttvlol_version') as string;
            
            if (installedVersion !== latestVersion) {
              ttvlolUpdateShown = true;
              const { addToast, openSettings } = useAppStore.getState();
              addToast(
                `TTV LOL plugin update available! Current: ${installedVersion} → Latest: ${latestVersion}`,
                'info',
                {
                  label: 'Open Settings',
                  onClick: () => openSettings()
                }
              );
            }
          }
        }
      } catch (error) {
        console.error('Failed to check for updates:', error);
      }
    };
    checkUpdates();
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing || !containerRef.current) return;

      const container = containerRef.current;
      const containerRect = container.getBoundingClientRect();

      if (chatPlacement === 'right') {
        // Calculate new width from the right edge
        const newWidth = containerRect.right - e.clientX;
        // Clamp between 250px and container width minus 200px (to leave space for video)
        const maxWidth = containerRect.width - 200;
        const clampedWidth = Math.max(250, Math.min(maxWidth, newWidth));
        setChatSize(clampedWidth);
      } else if (chatPlacement === 'bottom') {
        // Calculate new height from the bottom edge
        const newHeight = containerRect.bottom - e.clientY;
        // Clamp between 150px and container height minus 150px (to leave space for video)
        const maxHeight = containerRect.height - 150;
        const clampedHeight = Math.max(150, Math.min(maxHeight, newHeight));
        setChatSize(clampedHeight);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      // Prevent text selection while dragging
      document.body.style.userSelect = 'none';
      document.body.style.cursor = chatPlacement === 'right' ? 'ew-resize' : 'ns-resize';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, chatPlacement]);

  return (
    <div className="flex flex-col h-screen bg-background backdrop-blur-md">
      <TitleBar />
      {!streamUrl && !isLoading ? (
        // Show live overlay when no stream is playing
        <LiveOverlay />
      ) : isLoading && !streamUrl ? (
        // Show loading widget when starting a stream from no stream state
        <div className="flex-1 relative overflow-hidden bg-black">
          <LoadingWidget useFunnyMessages={true} />
        </div>
      ) : (
        // Show video player and chat when stream is playing
        <div 
          ref={containerRef}
          className={`flex flex-1 overflow-hidden ${chatPlacement === 'bottom' ? 'flex-col' : 'flex-row'}`}
        >
          <div className="flex-1 relative overflow-hidden">
            <VideoPlayer />
            {isLoading && <LoadingWidget useFunnyMessages={true} />}
          </div>
          {chatPlacement !== 'hidden' && (
            <>
              {/* Resizable Separator */}
              <div
                onMouseDown={handleMouseDown}
                className={`
                  ${chatPlacement === 'right' ? 'w-1 cursor-ew-resize hover:w-1.5' : 'h-1 cursor-ns-resize hover:h-1.5'}
                  bg-borderLight hover:bg-accent transition-all flex-shrink-0 z-10
                  ${isResizing ? (chatPlacement === 'right' ? 'w-1.5 bg-accent' : 'h-1.5 bg-accent') : ''}
                `}
                title={chatPlacement === 'right' ? 'Drag to resize chat width' : 'Drag to resize chat height'}
              />
              {/* Chat Widget */}
              <div 
                className="flex-shrink-0 overflow-hidden"
                style={{
                  [chatPlacement === 'right' ? 'width' : 'height']: `${chatSize}px`
                }}
              >
                <ChatWidget />
              </div>
            </>
          )}
        </div>
      )}
      <SettingsDialog />
      <LiveStreamsOverlay />
      <DropsOverlay />
      <ProfileOverlay 
        isOpen={showProfileOverlay}
        onClose={() => setShowProfileOverlay(false)}
        anchorPosition={{ x: window.innerWidth, y: 32 }}
      />
      {showBadgesOverlay && !selectedBadge && (
        <BadgesOverlay
          onClose={() => setShowBadgesOverlay(false)}
          onBadgeClick={(badge, setId) => setSelectedBadge({ badge, setId })}
        />
      )}
      {selectedBadge && (
        <BadgeDetailOverlay
          badge={selectedBadge.badge}
          setId={selectedBadge.setId}
          onClose={() => {
            setSelectedBadge(null);
            setShowBadgesOverlay(false);
          }}
          onBack={() => setSelectedBadge(null)}
        />
      )}
      <ToastManager />
    </div>
  );
}

export default App;
