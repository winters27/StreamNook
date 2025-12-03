import { useState } from 'react';
import { useAppStore } from '../../stores/AppStore';
import { invoke } from '@tauri-apps/api/core';
import { Bell, Radio, MessageCircle, Download, Smartphone, MessageSquare, Gift, Award, Monitor } from 'lucide-react';

const NotificationsSettings = () => {
  const { settings, updateSettings } = useAppStore();
  const [isSending, setIsSending] = useState(false);

  const liveNotifications = settings.live_notifications || {
    enabled: true,
    play_sound: true,
    show_live_notifications: true,
    show_whisper_notifications: true,
    show_update_notifications: true,
    show_drops_notifications: true,
    show_channel_points_notifications: true,
    show_badge_notifications: true,
    use_dynamic_island: true,
    use_toast: true,
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

  // Toggle component for reuse
  const Toggle = ({ enabled, onChange, disabled = false }: { enabled: boolean; onChange: () => void; disabled?: boolean }) => (
    <button
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${disabled ? 'opacity-50 cursor-not-allowed' : ''
        } ${enabled && !disabled ? 'bg-accent' : 'bg-gray-600'}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'
          }`}
      />
    </button>
  );

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        {/* Enable Notifications (Master Toggle) */}
        <div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-textPrimary">
                Enable Notifications
              </label>
              <p className="text-xs text-textSecondary mt-1">
                Master toggle for all notification types
              </p>
            </div>
            <Toggle
              enabled={liveNotifications.enabled}
              onChange={() => updateLiveNotifications({ enabled: !liveNotifications.enabled })}
            />
          </div>
        </div>

        {/* Notification Method Section */}
        {liveNotifications.enabled && (
          <>
            <div className="pt-2 border-t border-borderSubtle">
              <p className="text-xs font-medium text-textMuted uppercase tracking-wide mb-3">
                Notification Methods
              </p>
              <div className="space-y-3">
                {/* Dynamic Island Toggle */}
                <div className="flex items-center justify-between gap-4 p-3 bg-glass/30 rounded-lg">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="w-8 h-8 rounded-lg bg-gray-500/20 flex items-center justify-center flex-shrink-0">
                      <Smartphone size={16} className="text-gray-400" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-textPrimary">
                        Dynamic Island
                      </label>
                      <p className="text-xs text-textSecondary mt-0.5">
                        Show notifications in the notification center at the top
                      </p>
                    </div>
                  </div>
                  <Toggle
                    enabled={liveNotifications.use_dynamic_island ?? true}
                    onChange={() => updateLiveNotifications({
                      use_dynamic_island: !(liveNotifications.use_dynamic_island ?? true)
                    })}
                  />
                </div>

                {/* Toast Toggle */}
                <div className="flex items-center justify-between gap-4 p-3 bg-glass/30 rounded-lg">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                      <MessageSquare size={16} className="text-blue-400" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-textPrimary">
                        Toast Notifications
                      </label>
                      <p className="text-xs text-textSecondary mt-0.5">
                        Show popup toasts at the bottom of the screen
                      </p>
                    </div>
                  </div>
                  <Toggle
                    enabled={liveNotifications.use_toast ?? true}
                    onChange={() => updateLiveNotifications({
                      use_toast: !(liveNotifications.use_toast ?? true)
                    })}
                  />
                </div>

                {/* Native Desktop Notifications Toggle */}
                <div className="flex items-center justify-between gap-4 p-3 bg-glass/30 rounded-lg border border-amber-500/20">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                      <Monitor size={16} className="text-amber-400" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-textPrimary">
                        Windows Desktop Notifications
                      </label>
                      <p className="text-xs text-textSecondary mt-0.5">
                        Show native Windows notifications in the system tray
                      </p>
                    </div>
                  </div>
                  <Toggle
                    enabled={liveNotifications.use_native_notifications ?? false}
                    onChange={() => updateLiveNotifications({
                      use_native_notifications: !(liveNotifications.use_native_notifications ?? false)
                    })}
                  />
                </div>

                {/* Native Only When Unfocused Toggle (shown when native is enabled) */}
                {liveNotifications.use_native_notifications && (
                  <div className="flex items-center justify-between gap-4 p-3 bg-glass/30 rounded-lg ml-4 border-l-2 border-amber-500/30">
                    <div className="flex-1">
                      <label className="block text-sm font-medium text-textPrimary">
                        Only When App is Unfocused
                      </label>
                      <p className="text-xs text-textSecondary mt-0.5">
                        Only show desktop notifications when the app is minimized or not in focus
                      </p>
                    </div>
                    <Toggle
                      enabled={liveNotifications.native_only_when_unfocused ?? true}
                      onChange={() => updateLiveNotifications({
                        native_only_when_unfocused: !(liveNotifications.native_only_when_unfocused ?? true)
                      })}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Notification Types Section */}
            <div className="pt-2 border-t border-borderSubtle">
              <p className="text-xs font-medium text-textMuted uppercase tracking-wide mb-3">
                Notification Types
              </p>
              <div className="space-y-3">
                {/* Live Stream Notifications */}
                <div className="flex items-center justify-between gap-4 p-3 bg-glass/30 rounded-lg">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center flex-shrink-0">
                      <Radio size={16} className="text-red-400" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-textPrimary">
                        Live Stream Notifications
                      </label>
                      <p className="text-xs text-textSecondary mt-0.5">
                        Get notified when followed streamers go live
                      </p>
                    </div>
                  </div>
                  <Toggle
                    enabled={liveNotifications.show_live_notifications ?? true}
                    onChange={() => updateLiveNotifications({
                      show_live_notifications: !(liveNotifications.show_live_notifications ?? true)
                    })}
                  />
                </div>

                {/* Whisper Notifications */}
                <div className="flex items-center justify-between gap-4 p-3 bg-glass/30 rounded-lg">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center flex-shrink-0">
                      <MessageCircle size={16} className="text-purple-400" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-textPrimary">
                        Whisper Notifications
                      </label>
                      <p className="text-xs text-textSecondary mt-0.5">
                        Get notified when you receive whispers
                      </p>
                    </div>
                  </div>
                  <Toggle
                    enabled={liveNotifications.show_whisper_notifications ?? true}
                    onChange={() => updateLiveNotifications({
                      show_whisper_notifications: !(liveNotifications.show_whisper_notifications ?? true)
                    })}
                  />
                </div>

                {/* Update Notifications */}
                <div className="flex items-center justify-between gap-4 p-3 bg-glass/30 rounded-lg">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="w-8 h-8 rounded-lg bg-yellow-500/20 flex items-center justify-center flex-shrink-0">
                      <Download size={16} className="text-yellow-400" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-textPrimary">
                        Update Notifications
                      </label>
                      <p className="text-xs text-textSecondary mt-0.5">
                        Get notified when a new app update is available
                      </p>
                    </div>
                  </div>
                  <Toggle
                    enabled={liveNotifications.show_update_notifications ?? true}
                    onChange={() => updateLiveNotifications({
                      show_update_notifications: !(liveNotifications.show_update_notifications ?? true)
                    })}
                  />
                </div>

                {/* Drops Notifications */}
                <div className="flex items-center justify-between gap-4 p-3 bg-glass/30 rounded-lg">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="w-8 h-8 rounded-lg bg-green-500/20 flex items-center justify-center flex-shrink-0">
                      <Gift size={16} className="text-green-400" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-textPrimary">
                        Drops Notifications
                      </label>
                      <p className="text-xs text-textSecondary mt-0.5">
                        Get notified when a drop is claimed
                      </p>
                    </div>
                  </div>
                  <Toggle
                    enabled={liveNotifications.show_drops_notifications ?? true}
                    onChange={() => updateLiveNotifications({
                      show_drops_notifications: !(liveNotifications.show_drops_notifications ?? true)
                    })}
                  />
                </div>

                {/* Channel Points Notifications */}
                <div className="flex items-center justify-between gap-4 p-3 bg-glass/30 rounded-lg">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="w-8 h-8 rounded-lg bg-orange-500/20 flex items-center justify-center flex-shrink-0">
                      <svg width="16" height="16" viewBox="0 0 24 24" className="text-orange-400" fill="currentColor">
                        <path d="M12 5v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7Z"></path>
                        <path fillRule="evenodd" d="M1 12C1 5.925 5.925 1 12 1s11 4.925 11 11-4.925 11-11 11S1 18.075 1 12Zm11 9a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z" clipRule="evenodd"></path>
                      </svg>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-textPrimary">
                        Channel Points Notifications
                      </label>
                      <p className="text-xs text-textSecondary mt-0.5">
                        Get notified when channel points are claimed
                      </p>
                    </div>
                  </div>
                  <Toggle
                    enabled={liveNotifications.show_channel_points_notifications ?? true}
                    onChange={() => updateLiveNotifications({
                      show_channel_points_notifications: !(liveNotifications.show_channel_points_notifications ?? true)
                    })}
                  />
                </div>

                {/* Badge Notifications */}
                <div className="flex items-center justify-between gap-4 p-3 bg-glass/30 rounded-lg">
                  <div className="flex items-center gap-3 flex-1">
                    <div className="w-8 h-8 rounded-lg bg-cyan-500/20 flex items-center justify-center flex-shrink-0">
                      <Award size={16} className="text-cyan-400" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-textPrimary">
                        Badge Notifications
                      </label>
                      <p className="text-xs text-textSecondary mt-0.5">
                        Get notified when new badges become available
                      </p>
                    </div>
                  </div>
                  <Toggle
                    enabled={liveNotifications.show_badge_notifications ?? true}
                    onChange={() => updateLiveNotifications({
                      show_badge_notifications: !(liveNotifications.show_badge_notifications ?? true)
                    })}
                  />
                </div>
              </div>
            </div>
          </>
        )}

        {/* Sound Settings */}
        {liveNotifications.enabled && (
          <>
            <div className="pt-2 border-t border-borderSubtle">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-textPrimary">
                    Notification Sound
                  </label>
                  <p className="text-xs text-textSecondary mt-1">
                    Play a subtle sound for notifications
                  </p>
                </div>
                <Toggle
                  enabled={liveNotifications.play_sound}
                  onChange={() => updateLiveNotifications({ play_sound: !liveNotifications.play_sound })}
                />
              </div>
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
              Choose how you receive notifications: the Dynamic Island (notification center at the top), Toast popups (bottom of screen), Windows desktop notifications, or any combination. Windows desktop notifications appear in your system tray and can be configured to only show when the app is minimized or unfocused - perfect for when you're multitasking! Click on in-app notifications to take action - live notifications start the stream, whisper notifications open the conversation, and update notifications take you to the Updates page.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NotificationsSettings;
