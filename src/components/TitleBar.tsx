import { Window } from '@tauri-apps/api/window';
import { Minus, Square, X, Radio, Droplet, Award, User, Settings } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../stores/AppStore';
import PenroseLogo from './PenroseLogo';
import AboutWidget from './AboutWidget';

const TitleBar = () => {
  const { openSettings, setShowLiveStreamsOverlay, setShowProfileOverlay, setShowDropsOverlay, setShowBadgesOverlay, showProfileOverlay, isAuthenticated, currentUser, isMiningActive } = useAppStore();
  const [showAbout, setShowAbout] = useState(false);
  const [showSplash, setShowSplash] = useState(false);
  const prevMiningActive = useRef(isMiningActive);

  useEffect(() => {
    // Detect when mining stops
    if (prevMiningActive.current && !isMiningActive) {
      setShowSplash(true);
      setTimeout(() => setShowSplash(false), 600);
    }
    prevMiningActive.current = isMiningActive;
  }, [isMiningActive]);

  const handleMinimize = async () => {
    const window = Window.getCurrent();
    await window.minimize();
  };
  
  const handleMaximize = async () => {
    const window = Window.getCurrent();
    await window.toggleMaximize();
  };
  
  const handleClose = async () => {
    const window = Window.getCurrent();
    await window.close();
  };

  return (
    <>
      <div 
        data-tauri-drag-region 
        className="flex items-center justify-between h-8 px-3 select-none bg-secondary backdrop-blur-md border-b border-borderSubtle"
      >
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {/* Penrose Logo */}
          <PenroseLogo onClick={() => setShowAbout(true)} />

          {/* Live Streams Button */}
          <button
            onClick={() => setShowLiveStreamsOverlay(true)}
            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
            title="Live Streams"
          >
            <Radio size={16} />
          </button>

          {/* Drops Button */}
          <div className="relative">
            <button
              onClick={() => setShowDropsOverlay(true)}
              className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
              title={isMiningActive ? "Drops & Points (Mining Active)" : "Drops & Points"}
            >
              {isMiningActive ? (
                <>
                  <Droplet size={14} className="text-green-500 animate-droplet relative z-10" fill="currentColor" />
                  {/* Rippling puddle at bottom */}
                  <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-3 h-1 pointer-events-none">
                    <div className="absolute inset-0 bg-green-500/30 rounded-full blur-[1px] animate-ripple" />
                  </div>
                </>
              ) : (
                <Droplet size={14} fill="currentColor" />
              )}
            </button>
            {showSplash && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-2 h-2 bg-green-500/60 rounded-full animate-splash" />
              </div>
            )}
          </div>

          {/* Badges Button */}
          <button
            onClick={() => setShowBadgesOverlay(true)}
            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
            title="Global Badges"
          >
            <Award size={16} />
          </button>

          {/* Profile Button */}
          <button
            onClick={() => setShowProfileOverlay(!showProfileOverlay)}
            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
            title={isAuthenticated ? 'Profile' : 'Login'}
          >
            {isAuthenticated && currentUser?.profile_image_url ? (
              <img 
                src={currentUser.profile_image_url} 
                alt="Profile"
                className="w-4 h-4 rounded-full object-cover"
              />
            ) : (
              <User size={16} />
            )}
          </button>

          {/* Settings Button */}
          <button
            onClick={openSettings}
            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
            title="Settings"
          >
            <Settings size={16} />
          </button>
        </div>

        <div className="flex space-x-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button 
            onClick={handleMinimize}
            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
            title="Minimize"
          >
            <Minus size={14} />
          </button>
          <button 
            onClick={handleMaximize}
            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
            title="Maximize"
          >
            <Square size={14} />
          </button>
          <button 
            onClick={handleClose}
            className="p-1.5 text-textSecondary hover:text-red-400 hover:bg-glass rounded transition-all duration-200"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* About Widget */}
      {showAbout && <AboutWidget onClose={() => setShowAbout(false)} />}
    </>
  );
};

export default TitleBar;
