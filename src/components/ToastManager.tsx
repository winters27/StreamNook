import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle, XCircle, AlertCircle, Info, X } from 'lucide-react';
import { useAppStore } from '../stores/AppStore';
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';

interface LiveNotification {
  streamer_name: string;
  streamer_login: string;
  streamer_avatar?: string;
  game_name?: string;
  game_image?: string;
  stream_title?: string;
  stream_url: string;
}

const ToastManager = () => {
  const { toasts, removeToast, addToast } = useAppStore();

  // Listen for live stream notifications from backend
  useEffect(() => {
    const unlisten = listen<LiveNotification>('streamer-went-live', (event) => {
      const notification = event.payload;
      
      // Create a rich notification message with all available data
      // The backend already respects the notification settings
      const toastContent = (
        <div className="flex items-center gap-3 w-full">
          {/* Streamer Avatar */}
          {notification.streamer_avatar && (
            <img 
              src={notification.streamer_avatar} 
              alt={notification.streamer_name} 
              className="w-10 h-10 rounded-full object-cover flex-shrink-0"
            />
          )}
          
          {/* Game Box Art */}
          {notification.game_image && (
            <img 
              src={notification.game_image} 
              alt={notification.game_name || 'Game'} 
              className="w-12 h-16 object-cover rounded flex-shrink-0"
            />
          )}
          
          {/* Text Content */}
          <div className="flex-1 min-w-0">
            <div className="font-semibold truncate">{notification.streamer_name} is now live!</div>
            {notification.game_name && (
              <div className="text-xs text-textSecondary truncate">Playing {notification.game_name}</div>
            )}
            {notification.stream_title && (
              <div className="text-xs text-textSecondary/80 truncate mt-0.5">{notification.stream_title}</div>
            )}
          </div>
        </div>
      );

      // Add toast with action to open stream natively in the app
      addToast(toastContent, 'info', {
        label: 'Watch',
        onClick: async () => {
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            // Use the app's native stream opening functionality
            await invoke('start_stream', { 
              url: notification.stream_url, 
              quality: 'best' 
            });
            
            // Start chat for the channel
            await invoke('start_chat', { channel: notification.streamer_login });
          } catch (e) {
            console.error('Failed to open stream:', e);
          }
        },
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [addToast]);

  const getToastIcon = (type: string) => {
    switch (type) {
      case 'success': return <CheckCircle size={20} />;
      case 'error': return <XCircle size={20} />;
      case 'warning': return <AlertCircle size={20} />;
      default: return <Info size={20} />;
    }
  };

  const getToastColor = (type: string) => {
    switch (type) {
      case 'success': return 'border-green-500/50 bg-green-500/10 text-green-400';
      case 'error': return 'border-red-500/50 bg-red-500/10 text-red-400';
      case 'warning': return 'border-yellow-500/50 bg-yellow-500/10 text-yellow-400';
      default: return 'border-accent/50 bg-accent/10 text-accent';
    }
  };

  return (
    <div className="fixed bottom-4 right-4 space-y-2 z-50 pointer-events-none">
      <AnimatePresence>
        {toasts.map(toast => (
          <motion.div
            key={toast.id}
            initial={{ x: 300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 300, opacity: 0 }}
            className={`glass-panel backdrop-blur-lg p-4 rounded-lg shadow-lg border ${getToastColor(toast.type)} min-w-[300px] max-w-[400px] pointer-events-auto`}
          >
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">{getToastIcon(toast.type)}</div>
              <div className="text-sm font-medium flex-1">
                {typeof toast.message === 'string' ? toast.message : toast.message}
              </div>
              <button
                onClick={() => removeToast(toast.id)}
                className="text-textSecondary hover:text-textPrimary transition-colors flex-shrink-0 mt-0.5"
                aria-label="Dismiss"
              >
                <X size={16} />
              </button>
            </div>
            {toast.action && (
              <div className="mt-3 flex justify-end">
                <button
                  onClick={() => {
                    toast.action?.onClick();
                    removeToast(toast.id);
                  }}
                  className="px-3 py-1.5 bg-accent hover:bg-accent/80 text-white text-xs font-medium rounded transition-colors"
                >
                  {toast.action.label}
                </button>
              </div>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};

export default ToastManager;
