import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle, XCircle, AlertCircle, Info, X, Download, Loader2 } from 'lucide-react';
import { useAppStore, Toast } from '../stores/AppStore';
import { useEffect, useState, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { parseEmojisProxied, EmojiSegment } from '../services/emojiService';

import { Logger } from '../utils/logger';
interface LiveNotification {
  streamer_name: string;
  streamer_login: string;
  streamer_avatar?: string;
  game_name?: string;
  game_image?: string;
  stream_title?: string;
  stream_url: string;
  is_test?: boolean;
}

// Component to render stream title with Apple-style emojis (inline)
const StreamTitleWithEmojis = ({ title }: { title: string }) => {
  const [segments, setSegments] = useState<EmojiSegment[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    parseEmojisProxied(title)
      .then((result) => {
        if (mounted) {
          setSegments(result);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (mounted) {
          setSegments([{ type: 'text', content: title }]);
          setIsLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [title]);

  if (isLoading) {
    return <>{title}</>;
  }

  return (
    <>
      {segments.map((segment, idx) =>
        segment.type === 'emoji' && segment.emojiUrl && segment.emojiUrl.startsWith('data:') ? (
          <img
            key={idx}
            src={segment.emojiUrl}
            alt={segment.content}
            className="inline-block w-3.5 h-3.5 object-contain mx-px"
            style={{ verticalAlign: '-2px' }}
            loading="lazy"
          />
        ) : (
          <span key={idx}>{segment.content}</span>
        )
      )}
    </>
  );
};

// Funny joke messages for when users click on test notifications
const TEST_NOTIFICATION_JOKES = [
  "Gotcha! Did you really think xQc was streaming right now?",
  "This is just a test, silly! But nice reflexes.",
  "Almost freed the notification... but not quite!",
  "Congratulations! You clicked on nothing!",
  "Plot twist: There is no stream. There never was.",
  "xQc isn't live, but your disappointment is!",
  "Your click accuracy is immaculate. Shame it was wasted here.",
  "*poof* The stream disappears into thin air...",
  "What did you expect? A real stream? In THIS economy?",
  "RIP your hopes and dreams of catching a live stream",
  "You've been bamboozled! +100 XP in gullibility",
  "The real stream was the friends we made along the way",
  "Welcome to the circus! Population: you",
  "My evil plan worked perfectly! MUAHAHAHA!",
  "This message brought to you by: False Hope™",
  "Error 418: I'm a teapot, not a real notification",
  "Ta-da! Magic trick: making your excitement disappear!",
  "Cool people don't click test notifications... just saying",
  "This notification is as real as unicorns",
  "Achievement Unlocked: Clicked a Fake Stream",
  "Surprise! The surprise is there's no surprise!",
  "The notification played you like a fiddle",
  "Experiment complete: Human clicks shiny button",
  "And the Oscar for Best Click goes to... YOU!",
  "Trust issues? You should have some after this.",
  "The stream was in your heart all along",
  "Awkward... this is just a test...",
  "Of course we weren't going to a real stream, silly!",
  "Nice try, but this notification leads nowhere",
  "You really fell for that? Classic.",
  // Harsh roast additions
  "Bro read TEST notification and still clicked. L.",
  "Imagine clicking a test notification. Couldn't be me.",
  "Your reading comprehension needs work.",
  "Tell me you don't read without telling me you don't read.",
  "The word TEST is right there. In the settings. Where you clicked.",
  "Did you skip the part where it said TEST?",
  "Smartest StreamNook user right here.",
  "This is why we can't have nice things.",
  "I've seen better judgment from a Magic 8-Ball.",
  "Your clicks have negative value. Impressive.",
  "Speedrunning embarrassment any%",
  "You click TEST buttons at job interviews too?",
  "Brain.exe has stopped working",
  "Congratulations, you played yourself.",
  "Even the notification feels second-hand embarrassment.",
  "Peak performance. This is it. This is the top.",
  "Did the word TEST stutter?",
  "Reading is free, you know.",
  "Not your proudest click, is it?",
  "You really woke up and chose gullibility today.",
];

const ToastManager = () => {
  const { toasts, removeToast, addToast, settings } = useAppStore();

  // Function to play a subtle notification sound based on selected type
  const playNotificationSound = useCallback((soundType?: string) => {
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      const type = soundType || 'boop';

      // Configure sound based on type
      switch (type) {
        case 'tick':
          // Cozy Knock - Warm, wooden knock-like sound
          oscillator.type = 'triangle';
          oscillator.frequency.setValueAtTime(280, audioContext.currentTime);
          oscillator.frequency.exponentialRampToValueAtTime(180, audioContext.currentTime + 0.08);
          gainNode.gain.setValueAtTime(0, audioContext.currentTime);
          gainNode.gain.linearRampToValueAtTime(0.08, audioContext.currentTime + 0.01);
          gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.15);
          oscillator.start(audioContext.currentTime);
          oscillator.stop(audioContext.currentTime + 0.15);
          break;

        case 'soft':
          // Fireplace Crackle - Warm, layered gentle tone
          oscillator.type = 'triangle';
          oscillator.frequency.setValueAtTime(420, audioContext.currentTime);
          oscillator.frequency.exponentialRampToValueAtTime(320, audioContext.currentTime + 0.3);
          gainNode.gain.setValueAtTime(0, audioContext.currentTime);
          gainNode.gain.linearRampToValueAtTime(0.06, audioContext.currentTime + 0.04);
          gainNode.gain.setValueAtTime(0.05, audioContext.currentTime + 0.15);
          gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.5);
          oscillator.start(audioContext.currentTime);
          oscillator.stop(audioContext.currentTime + 0.5);
          break;

        case 'whisper':
          // Raindrop - Soft, gentle water droplet sound
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(520, audioContext.currentTime);
          oscillator.frequency.exponentialRampToValueAtTime(380, audioContext.currentTime + 0.12);
          gainNode.gain.setValueAtTime(0, audioContext.currentTime);
          gainNode.gain.linearRampToValueAtTime(0.07, audioContext.currentTime + 0.02);
          gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.25);
          oscillator.start(audioContext.currentTime);
          oscillator.stop(audioContext.currentTime + 0.25);
          break;

        case 'gentle':
          // Wind Chime - Ethereal, distant bell-like tone
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(550, audioContext.currentTime);
          oscillator.frequency.setValueAtTime(580, audioContext.currentTime + 0.1);
          oscillator.frequency.exponentialRampToValueAtTime(480, audioContext.currentTime + 0.6);
          gainNode.gain.setValueAtTime(0, audioContext.currentTime);
          gainNode.gain.linearRampToValueAtTime(0.05, audioContext.currentTime + 0.08);
          gainNode.gain.setValueAtTime(0.04, audioContext.currentTime + 0.25);
          gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.7);
          oscillator.start(audioContext.currentTime);
          oscillator.stop(audioContext.currentTime + 0.7);
          break;

        case 'boop':
        default:
          // Subtle Boop (Default) - The original sound
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
          oscillator.frequency.exponentialRampToValueAtTime(400, audioContext.currentTime + 0.1);
          gainNode.gain.setValueAtTime(0, audioContext.currentTime);
          gainNode.gain.linearRampToValueAtTime(0.15, audioContext.currentTime + 0.05);
          gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
          oscillator.start(audioContext.currentTime);
          oscillator.stop(audioContext.currentTime + 0.3);
          break;
      }
    } catch (error) {
      Logger.warn('Could not play notification sound:', error);
    }
  }, []);

  // Listen for live stream notifications from backend
  // This creates the decorated toast with avatar, game image, title
  // Only shows if use_toast setting is enabled (checked by DynamicIsland which emits custom event)
  useEffect(() => {
    const unlisten = listen<LiveNotification>('show-live-toast', (event) => {
      const notification = event.payload;

      // Play sound if enabled
      if (settings.live_notifications?.play_sound) {
        playNotificationSound(settings.live_notifications?.sound_type);
      }

      // Create a rich notification message with all available data
      const toastContent = (
        <div className="flex flex-col gap-2 w-full max-w-full">
          <div className="flex items-start gap-3 w-full max-w-full">
            {/* Streamer Avatar */}
            {notification.streamer_avatar && (
              <img
                src={notification.streamer_avatar}
                alt={notification.streamer_name}
                className="w-10 h-10 rounded-full object-cover flex-shrink-0"
              />
            )}

            {/* Text Content */}
            <div className="flex-1 min-w-0 overflow-hidden max-w-full space-y-1">
              <div className="text-base font-semibold truncate max-w-full text-textPrimary">{notification.streamer_name} is now live!</div>
              {notification.game_name && (
                <div className="text-xs font-normal text-textSecondary truncate max-w-full">Playing {notification.game_name}</div>
              )}
              {notification.stream_title && (
                <div className="text-[11px] text-textSecondary/60 truncate max-w-full">
                  <StreamTitleWithEmojis title={notification.stream_title} />
                </div>
              )}
            </div>

            {/* Game Box Art */}
            {notification.game_image && (
              <img
                src={notification.game_image}
                alt={notification.game_name || 'Game'}
                className="w-12 h-16 object-cover rounded flex-shrink-0"
              />
            )}
          </div>

          {/* Subtle click hint with shimmer effect */}
          <div className="text-[10px] text-center select-none font-normal shimmer-text">
            Click to watch
          </div>
        </div>
      );

      // Add toast with click action to open stream (or show joke for test notifications)
      addToast(toastContent, 'live', {
        label: notification.is_test ? 'Test' : 'Watch',
        onClick: async () => {
          // If this is a test notification, show a funny joke popup instead of navigating
          if (notification.is_test) {
            const randomJoke = TEST_NOTIFICATION_JOKES[Math.floor(Math.random() * TEST_NOTIFICATION_JOKES.length)];
            const { addToast: showJoke } = useAppStore.getState();
            showJoke(randomJoke, 'info');
            return;
          }

          try {
            // Use the AppStore's startStream method which properly handles all state updates
            const { startStream } = useAppStore.getState();
            await startStream(notification.streamer_login);
          } catch (e) {
            Logger.error('Failed to open stream:', e);
            const { addToast: showError } = useAppStore.getState();
            showError('Failed to open stream. Please try again.', 'error');
          }
        },
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [addToast, settings.live_notifications?.play_sound, settings.live_notifications?.sound_type, playNotificationSound]);

  const getToastIcon = (type: string) => {
    switch (type) {
      case 'success': return <CheckCircle size={20} />;
      case 'error': return <XCircle size={20} />;
      case 'warning': return <AlertCircle size={20} />;
      case 'live': return null;
      default: return <Info size={20} />;
    }
  };

  const getToastColor = (type: string) => {
    switch (type) {
      case 'success': return 'border-green-500/30 bg-green-500/5';
      case 'error': return 'border-red-500/30 bg-red-500/5';
      case 'warning': return 'border-yellow-500/30 bg-yellow-500/5';
      case 'live': return 'border-accent/40 bg-accent/5';
      default: return 'border-accent/30 bg-accent/5';
    }
  };

  return (
    <div className="fixed bottom-4 right-4 space-y-2 z-50 pointer-events-none">
      <AnimatePresence>
        {toasts.map(toast => (
          <ToastItem
            key={toast.id}
            toast={toast}
            removeToast={removeToast}
            getToastIcon={getToastIcon}
            getToastColor={getToastColor}
          />
        ))}
      </AnimatePresence>
    </div>
  );
};

// Separate component for each toast to handle individual hover state
interface ToastItemProps {
  toast: Toast;
  removeToast: (id: number) => void;
  getToastIcon: (type: string) => React.ReactNode;
  getToastColor: (type: string) => string;
}

const ToastItem = ({ toast, removeToast, getToastIcon, getToastColor }: ToastItemProps) => {
  const [isPaused, setIsPaused] = useState(false);
  const remainingTimeRef = useRef(toast.duration);
  const startTimeRef = useRef(Date.now());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isClickable = toast.type === 'live' && toast.action;
  const canPause = toast.type === 'live';

  // Set up the initial auto-dismiss timer (only runs once on mount)
  useEffect(() => {
    // Calculate initial remaining time
    const elapsed = Date.now() - toast.createdAt;
    remainingTimeRef.current = Math.max(0, toast.duration - elapsed);
    startTimeRef.current = Date.now();

    if (remainingTimeRef.current > 0) {
      timeoutRef.current = setTimeout(() => {
        removeToast(toast.id);
      }, remainingTimeRef.current);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
    // Only run on mount - don't re-run when isPaused changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id]);

  const handleMouseEnter = useCallback(() => {
    if (!canPause) return;

    setIsPaused(true);

    // Clear the existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    // Calculate how much time has passed since timer started
    const elapsed = Date.now() - startTimeRef.current;
    remainingTimeRef.current = Math.max(0, remainingTimeRef.current - elapsed);
  }, [canPause]);

  const handleMouseLeave = useCallback(() => {
    if (!canPause) return;

    setIsPaused(false);
    startTimeRef.current = Date.now();

    // Start a new timeout with the remaining time
    if (remainingTimeRef.current > 0) {
      timeoutRef.current = setTimeout(() => {
        removeToast(toast.id);
      }, remainingTimeRef.current);
    } else {
      // Time already expired, dismiss immediately
      removeToast(toast.id);
    }
  }, [canPause, toast.id, removeToast]);

  return (
    <motion.div
      initial={{ x: 300, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 300, opacity: 0 }}
      onClick={isClickable ? () => {
        toast.action?.onClick();
        removeToast(toast.id);
      } : undefined}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`glass-panel backdrop-blur-lg p-4 rounded-lg shadow-lg border ${getToastColor(toast.type)} w-[380px] pointer-events-auto ${isClickable ? 'cursor-pointer hover:bg-accent/20 transition-colors' : ''} ${isPaused && isClickable ? 'shimmer-border' : ''}`}
    >
      <div className="flex items-start gap-3">
        {getToastIcon(toast.type) && (
          <div className="flex-shrink-0 mt-0.5">{getToastIcon(toast.type)}</div>
        )}
        <div className="text-sm font-medium flex-1 min-w-0 overflow-hidden">
          {typeof toast.message === 'string' ? toast.message : toast.message}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            removeToast(toast.id);
          }}
          className="text-textSecondary hover:text-textPrimary transition-colors flex-shrink-0 mt-0.5"
          aria-label="Dismiss"
        >
          <X size={16} />
        </button>
      </div>
      {/* Show action button only for non-live toasts */}
      {toast.action && toast.type !== 'live' && (
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
  );
};

export default ToastManager;
