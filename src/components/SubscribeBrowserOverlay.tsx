import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';

interface SubscribeBrowserOverlayProps {
  channel: string;
  onClose: () => void;
}

const SubscribeBrowserOverlay = ({ channel, onClose }: SubscribeBrowserOverlayProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    // Handle escape key to close
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in group">
      {/* Hover-sensitive background overlay */}
      <div 
        className="absolute inset-0 group-hover:pointer-events-none"
        onClick={onClose}
      />
      
      {/* Browser Window */}
      <div className="w-[90%] h-[90%] max-w-6xl max-h-[900px] flex flex-col glass-panel rounded-lg shadow-2xl overflow-hidden relative z-10">
        {/* Browser Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-borderSubtle glass-panel">
          <div className="flex items-center gap-3 flex-1">
            {/* Browser Controls */}
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500/80 hover:bg-red-500 transition-colors cursor-pointer" onClick={onClose} title="Close"></div>
              <div className="w-3 h-3 rounded-full bg-yellow-500/80"></div>
              <div className="w-3 h-3 rounded-full bg-green-500/80"></div>
            </div>
            
            {/* URL Bar */}
            <div className="flex-1 mx-4 px-4 py-2 glass-input rounded-full text-sm text-textSecondary flex items-center gap-2">
              <svg className="w-4 h-4 text-textSecondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span className="truncate">https://www.twitch.tv/subs/{channel}</span>
            </div>
          </div>

          {/* Close Button */}
          <button
            onClick={onClose}
            className="p-2 text-textSecondary hover:text-red-400 hover:bg-glass rounded transition-all"
            title="Close (Esc)"
          >
            <X size={20} />
          </button>
        </div>

        {/* Browser Content */}
        <div className="flex-1 relative bg-background">
          <iframe
            ref={iframeRef}
            src={`https://www.twitch.tv/subs/${channel}`}
            className="w-full h-full border-0"
            title={`Subscribe to ${channel}`}
            sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-popups-to-escape-sandbox"
            allow="payment"
          />
          
          {/* Loading Overlay */}
          <div className="absolute inset-0 flex items-center justify-center bg-background pointer-events-none">
            <div className="text-center">
              <div className="inline-block w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin mb-3"></div>
              <p className="text-textSecondary text-sm">Loading subscription page...</p>
            </div>
          </div>
        </div>

        {/* Browser Footer */}
        <div className="px-4 py-2 border-t border-borderSubtle glass-panel">
          <div className="flex items-center justify-between text-xs text-textSecondary">
            <span>Twitch Subscription Page</span>
            <span className="flex items-center gap-2">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
              Secure Connection
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SubscribeBrowserOverlay;
