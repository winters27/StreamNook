import { useState } from 'react';
import { Dropdown } from '../ui/Dropdown';
import { useAppStore } from '../../stores/AppStore';
import { invoke } from '@tauri-apps/api/core';
import { Bell } from 'lucide-react';
import { SettingsSection, SettingsRow } from './_primitives';
import { grantAccolade } from '../../services/supabaseService';
import {
  RESTLESS_ACCOLADE_ID,
  NOTIF_CLICK_THRESHOLD,
  bumpTestNotificationClicks,
} from '../../utils/notifAchievement';

import { Logger } from '../../utils/logger';
const NotificationsSettings = () => {
  const { settings, updateSettings, currentUser, addToast } = useAppStore();
  // Brief green flash on press, used as the Test button's feedback instead of a
  // text/width swap. See handleTestNotification + the button's className.
  const [testFlash, setTestFlash] = useState(false);

  const liveNotifications = settings.live_notifications || {
    enabled: true,
    play_sound: true,
    show_live_notifications: true,
    show_whisper_notifications: true,
    show_update_notifications: true,
    show_drops_notifications: true,
    show_favorite_drops_notifications: true,
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
    // Snap to green, then let it fade back to the glass surface (the fade-back
    // lives on the glass-button class transition). Brief hold so it reads as a flash.
    setTestFlash(true);
    setTimeout(() => setTestFlash(false), 150);
    try {
      await invoke('send_test_notification');
      // "Insomniac" easter egg: reward the stubborn Test-clicker. The running
      // count is local; on the 50th click persist the accolade (which also
      // unlocks the Midnight Atmosphere for any member, no sub required) and
      // celebrate exactly once.
      const clicks = bumpTestNotificationClicks();
      if (clicks === NOTIF_CLICK_THRESHOLD && currentUser?.user_id) {
        void grantAccolade(currentUser.user_id, RESTLESS_ACCOLADE_ID);
        addToast('Achievement unlocked: Restless. The Midnight Atmosphere is yours.', 'success', undefined, { alwaysShow: true });
      }
    } catch (error) {
      Logger.error('Failed to send test notification:', error);
    }
  };

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
    <div className="space-y-8">
      <SettingsSection label="Notifications">
        <SettingsRow
          title="Enable Notifications"
          description="Master toggle for all notification types"
          control={
            <Toggle
              enabled={liveNotifications.enabled}
              onChange={() => updateLiveNotifications({ enabled: !liveNotifications.enabled })}
            />
          }
        />
      </SettingsSection>

      {liveNotifications.enabled && (
        <>
          <SettingsSection label="Notification Methods">
            <SettingsRow
              title="Dynamic Island"
              description="Show notifications in the notification center at the top"
              control={
                <Toggle
                  enabled={liveNotifications.use_dynamic_island ?? true}
                  onChange={() => updateLiveNotifications({
                    use_dynamic_island: !(liveNotifications.use_dynamic_island ?? true)
                  })}
                />
              }
            />

            <SettingsRow
              title="Toast Notifications"
              description="Show popup toasts at the bottom of the screen"
              control={
                <Toggle
                  enabled={liveNotifications.use_toast ?? true}
                  onChange={() => updateLiveNotifications({
                    use_toast: !(liveNotifications.use_toast ?? true)
                  })}
                />
              }
            />
          </SettingsSection>

          <SettingsSection label="Notification Types">
            <SettingsRow
              title="Live Stream Notifications"
              description="Get notified when followed streamers go live"
              control={
                <Toggle
                  enabled={liveNotifications.show_live_notifications ?? true}
                  onChange={() => updateLiveNotifications({
                    show_live_notifications: !(liveNotifications.show_live_notifications ?? true)
                  })}
                />
              }
            />

            <SettingsRow
              title="Whisper Notifications"
              description="Get notified when you receive whispers"
              control={
                <Toggle
                  enabled={liveNotifications.show_whisper_notifications ?? true}
                  onChange={() => updateLiveNotifications({
                    show_whisper_notifications: !(liveNotifications.show_whisper_notifications ?? true)
                  })}
                />
              }
            />

            <SettingsRow
              title="Update Notifications"
              description="Get notified when a new app update is available"
              control={
                <Toggle
                  enabled={liveNotifications.show_update_notifications ?? true}
                  onChange={() => updateLiveNotifications({
                    show_update_notifications: !(liveNotifications.show_update_notifications ?? true)
                  })}
                />
              }
            />

            {(liveNotifications.show_update_notifications ?? true) && (liveNotifications.use_toast ?? true) && (
              <SettingsRow
                title="Quick Update on Toast Click"
                description="Clicking the update toast immediately starts the update"
                control={
                  <Toggle
                    enabled={liveNotifications.quick_update_on_toast ?? false}
                    onChange={() => updateLiveNotifications({
                      quick_update_on_toast: !(liveNotifications.quick_update_on_toast ?? false)
                    })}
                  />
                }
              />
            )}

            <SettingsRow
              title="Drops Notifications"
              description="Get notified when a drop is claimed"
              control={
                <Toggle
                  enabled={liveNotifications.show_drops_notifications ?? true}
                  onChange={() => updateLiveNotifications({
                    show_drops_notifications: !(liveNotifications.show_drops_notifications ?? true)
                  })}
                />
              }
            />

            {(liveNotifications.show_drops_notifications ?? true) && (
              <SettingsRow
                title="Favorite Category Drops"
                description="Notify when favorited categories have new drops on startup"
                control={
                  <Toggle
                    enabled={liveNotifications.show_favorite_drops_notifications ?? true}
                    onChange={() => updateLiveNotifications({
                      show_favorite_drops_notifications: !(liveNotifications.show_favorite_drops_notifications ?? true)
                    })}
                  />
                }
              />
            )}

            <SettingsRow
              title="Channel Points Notifications"
              description="Get notified when channel points are claimed"
              control={
                <Toggle
                  enabled={liveNotifications.show_channel_points_notifications ?? true}
                  onChange={() => updateLiveNotifications({
                    show_channel_points_notifications: !(liveNotifications.show_channel_points_notifications ?? true)
                  })}
                />
              }
            />

            <SettingsRow
              title="Badge Notifications"
              description="Get notified when new badges become available"
              control={
                <Toggle
                  enabled={liveNotifications.show_badge_notifications ?? true}
                  onChange={() => updateLiveNotifications({
                    show_badge_notifications: !(liveNotifications.show_badge_notifications ?? true)
                  })}
                />
              }
            />
          </SettingsSection>

          <SettingsSection label="Sound">
            <SettingsRow
              title="Notification Sound"
              description="Play a subtle sound for notifications"
              control={
                <Toggle
                  enabled={liveNotifications.play_sound}
                  onChange={() => updateLiveNotifications({ play_sound: !liveNotifications.play_sound })}
                />
              }
            />

            {liveNotifications.play_sound && (
              <SettingsRow
                title="Sound Style"
                description="All sounds are designed to be pleasant and non-intrusive"
              >
                <Dropdown
                  value={liveNotifications.sound_type || 'boop'}
                  onChange={(v) => updateLiveNotifications({ sound_type: v })}
                  className="w-full"
                  ariaLabel="Notification sound"
                  options={[
                    { value: 'boop', label: 'Subtle Boop (Default)' },
                    { value: 'tick', label: 'Cozy Knock' },
                    { value: 'soft', label: 'Fireplace Crackle' },
                    { value: 'whisper', label: 'Raindrop' },
                    { value: 'gentle', label: 'Wind Chime' },
                  ]}
                />
              </SettingsRow>
            )}

            <SettingsRow
              title="Test Notification"
              description="Send a test notification to preview your settings"
              control={
                <button
                  onClick={handleTestNotification}
                  // Frosted glass-button (bevel + accent-tinted surface) to match
                  // the rest of the app, not the old flat accent fill. Press
                  // feedback is a subtle green flash: an inline green snaps on
                  // (transition: none), then the glass-button's own transition
                  // fades it back to the surface color.
                  className="glass-button flex items-center gap-2 px-4 py-2 rounded-lg text-textPrimary text-sm font-medium"
                  style={testFlash ? { backgroundColor: 'color-mix(in srgb, var(--color-success) 50%, transparent)', transition: 'none' } : undefined}
                >
                  <Bell size={16} />
                  Test
                </button>
              }
            />
          </SettingsSection>
        </>
      )}

      <SettingsSection label="About" bare>
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
                Choose how you receive notifications: the Dynamic Island (notification center at the top), Toast popups (bottom of screen), or both. Click on notifications to take action. Live notifications start the stream, whisper notifications open the conversation, and update notifications take you to the Updates page.
              </p>
            </div>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
};

export default NotificationsSettings;
