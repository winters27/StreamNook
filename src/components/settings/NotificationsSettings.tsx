import { useState } from 'react';
import { useAppStore } from '../../stores/AppStore';
import { invoke } from '@tauri-apps/api/core';
import { Bell } from 'lucide-react';

const NotificationsSettings = () => {
  const { settings, updateSettings } = useAppStore();
  const [isSending, setIsSending] = useState(false);

  const liveNotifications = settings.live_notifications || {
    enabled: true,
    play_sound: true,
  };

  const updateLiveNotifications = (updates: Partial<typeof liveNotifications>) => {
    updateSettings({
      ...settings,
      live_notifications: {
        ...liveNotifications,
        ...updates,
      },
    });
  };

  const handleTestNotification = async () => {
    setIsSending(true);
    try {
      await invoke('send_test_notification');
    } catch (error) {
      console.error('Failed to send test notification:', error);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        {/* Enable Live Notifications */}
        <div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-textPrimary">
                Enable Notifications
              </label>
              <p className="text-xs text-textSecondary mt-1">
                Get notified when followed streamers go live
              </p>
            </div>
            <button
              onClick={() => updateLiveNotifications({ enabled: !liveNotifications.enabled })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${liveNotifications.enabled ? 'bg-accent' : 'bg-gray-600'
                }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${liveNotifications.enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
              />
            </button>
          </div>
        </div>

        {/* Notification Sound */}
        {liveNotifications.enabled && (
          <>
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-textPrimary">
                  Notification Sound
                </label>
                <p className="text-xs text-textSecondary mt-1">
                  Play a subtle sound when streamers go live
                </p>
              </div>
              <button
                onClick={() => updateLiveNotifications({ play_sound: !liveNotifications.play_sound })}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${liveNotifications.play_sound ? 'bg-accent' : 'bg-gray-600'
                  }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${liveNotifications.play_sound ? 'translate-x-6' : 'translate-x-1'
                    }`}
                />
              </button>
            </div>

            {/* Sound Type Selector */}
            {liveNotifications.play_sound && (
              <div>
                <label className="block text-sm font-medium text-textPrimary mb-2">
                  Sound Style
                </label>
                <select
                  value={liveNotifications.sound_type || 'boop'}
                  onChange={(e) => updateLiveNotifications({ sound_type: e.target.value })}
                  className="w-full glass-input text-textPrimary text-sm px-3 py-2"
                >
                  <option value="boop">Subtle Boop (Default)</option>
                  <option value="tick">Cozy Knock</option>
                  <option value="soft">Fireplace Crackle</option>
                  <option value="whisper">Raindrop</option>
                  <option value="gentle">Wind Chime</option>
                </select>
                <p className="text-xs text-textSecondary mt-1.5">
                  All sounds are designed to be pleasant and non-intrusive
                </p>
              </div>
            )}

            {/* Test Notification Button */}
            <div className="pt-2">
              <button
                onClick={handleTestNotification}
                disabled={isSending}
                className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent/80 disabled:bg-accent/50 text-white text-sm font-medium rounded transition-colors"
              >
                <Bell size={16} />
                {isSending ? 'Sending...' : 'Test Notification'}
              </button>
              <p className="text-xs text-textSecondary mt-2">
                Send a test notification to preview your settings
              </p>
            </div>
          </>
        )}
      </div>

      {/* Info Box */}
      <div className="glass-panel p-3 rounded-lg border border-accent/20">
        <div className="flex items-start gap-3">
          <div className="text-accent mt-0.5">
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-xs text-textPrimary font-medium mb-1">
              About Notifications
            </p>
            <p className="text-xs text-textSecondary">
              Stream Nook checks for live streams every minute. Notifications show the streamer's name, avatar, game details, and stream title. Use the test button above to preview.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NotificationsSettings;
