import { Dropdown } from '../ui/Dropdown';
import { useAppStore } from '../../stores/AppStore';
import ProxyHealthChecker from './ProxyHealthChecker';
import { SettingsSection, SettingsRow, SegmentedSelect } from './_primitives';

const Toggle = ({ enabled, onChange }: { enabled: boolean; onChange: () => void }) => (
  <button
    onClick={onChange}
    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${enabled ? 'bg-accent' : 'bg-gray-600'
      }`}
  >
    <span
      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'
        }`}
    />
  </button>
);

// The action buttons that can appear in the player's top-right overlay. Ids
// match the gating in VideoPlayer. Undefined `player_overlay_buttons` = all on.
const OVERLAY_BUTTONS: { id: string; label: string }[] = [
  { id: 'follow', label: 'Follow / Unfollow' },
  { id: 'subscribe', label: 'Subscribe / Gift' },
  { id: 'clip', label: 'Create Clip' },
  { id: 'clipsvods', label: 'Clips & VODs' },
  { id: 'multinook', label: 'Add to MultiNook' },
  { id: 'refresh', label: 'Refresh' },
  { id: 'close', label: 'Close Stream' },
];

const PlayerSettings = () => {
  const { settings, updateSettings } = useAppStore();

  // Fallback only used if settings.streamlink is somehow absent.
  const streamlinkDefaults = {
    stream_timeout: 60,
    retry_streams: 3,
    use_proxy: true,
    proxy_playlist:
      '--twitch-proxy-playlist=https://lb-na.cdn-perfprod.com,https://eu.luminous.dev --twitch-proxy-playlist-fallback',
    enhanced_codecs: true,
  };

  const streamlink = settings.streamlink || streamlinkDefaults;
  const autoSwitch = settings.auto_switch;
  const autoSwitchEnabled = autoSwitch?.enabled ?? true;
  const autoSwitchMode = autoSwitch?.mode ?? 'same_category';
  const autoSwitchNotification = autoSwitch?.show_notification ?? true;
  const autoSwitchRaid = autoSwitch?.auto_redirect_on_raid ?? true;
  const autoSwitchOfflineChat = autoSwitch?.stay_in_offline_chat ?? false;
  const videoPlayer = settings.video_player;

  const setAutoSwitch = (patch: Partial<NonNullable<typeof autoSwitch>>) => {
    updateSettings({
      ...settings,
      auto_switch: {
        enabled: autoSwitchEnabled,
        mode: autoSwitchMode,
        show_notification: autoSwitchNotification,
        auto_redirect_on_raid: autoSwitchRaid,
        stay_in_offline_chat: autoSwitchOfflineChat,
        ...patch,
      },
    });
  };

  // Undefined = all buttons shown (default). Toggling one switches to an explicit
  // set; rendering order in the overlay is fixed by VideoPlayer, so set membership
  // is all that's stored.
  const isOverlayButtonOn = (id: string) =>
    !settings.player_overlay_buttons || settings.player_overlay_buttons.includes(id);
  const toggleOverlayButton = (id: string) => {
    const current = settings.player_overlay_buttons ?? OVERLAY_BUTTONS.map((b) => b.id);
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    updateSettings({ ...settings, player_overlay_buttons: next });
  };

  return (
    <div className="space-y-8">
      <p className="text-sm text-textSecondary px-1">
        Most player controls (volume, quality, playback speed) are available directly in the video player.
        These settings control advanced streaming behavior.
      </p>

      <SettingsSection
        label="Player Overlay Buttons"
        description="Choose which action buttons appear in the top-right of the video player. Each still only shows when it applies (Clip when clippable, MultiNook and Refresh on live streams, and so on)."
      >
        {OVERLAY_BUTTONS.map((b) => (
          <SettingsRow
            key={b.id}
            title={b.label}
            control={
              <Toggle enabled={isOverlayButtonOn(b.id)} onChange={() => toggleOverlayButton(b.id)} />
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection
        id="settings-section-auto-switch"
        label="Auto-Switch"
        description="When a stream goes offline, automatically switch to another stream."
      >
        <SettingsRow
          title="Enable Auto-Switch"
          description="Automatically switch when current stream goes offline"
          control={
            <Toggle
              enabled={autoSwitchEnabled}
              onChange={() => setAutoSwitch({ enabled: !autoSwitchEnabled })}
            />
          }
        />

        <SettingsRow
          title="Switch To"
          description={
            autoSwitchMode === 'same_category'
              ? 'Switch to the highest viewer stream in the same game/category'
              : 'Switch to one of your live followed streamers'
          }
          disabled={!autoSwitchEnabled}
        >
          <SegmentedSelect
            value={autoSwitchMode}
            onChange={(mode) => setAutoSwitch({ mode })}
            options={[
              { value: 'same_category', label: 'Same Category' },
              { value: 'followed_streams', label: 'Followed Streams' },
            ]}
          />
        </SettingsRow>

        <SettingsRow
          title="Show Notification"
          description="Display a toast when auto-switching streams"
          disabled={!autoSwitchEnabled}
          control={
            <Toggle
              enabled={autoSwitchNotification}
              onChange={() => setAutoSwitch({ show_notification: !autoSwitchNotification })}
            />
          }
        />

        <SettingsRow
          title="Auto-Redirect on Raid"
          description="Automatically follow raids to the target channel (requires login)"
          control={
            <Toggle
              enabled={autoSwitchRaid}
              onChange={() => setAutoSwitch({ auto_redirect_on_raid: !autoSwitchRaid })}
            />
          }
        />

        <SettingsRow
          title="Stay in Offline Chat"
          description="Don't auto-switch when stream ends, stay in the chat room instead"
          control={
            <Toggle
              enabled={autoSwitchOfflineChat}
              onChange={() => setAutoSwitch({ stay_in_offline_chat: !autoSwitchOfflineChat })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        id="settings-section-streaming"
        label="Streaming"
      >
        <SettingsRow
          title="Allow h265 + AV1 codecs"
          description="Request AV1 and HEVC stream variants in addition to h264. Some Twitch channels ship more efficient encodings at the same resolution. Turn off if you see decode errors on older hardware."
          control={
            <Toggle
              enabled={streamlink.enhanced_codecs ?? true}
              onChange={() =>
                updateSettings({
                  ...settings,
                  streamlink: { ...streamlink, enhanced_codecs: !(streamlink.enhanced_codecs ?? true) },
                })
              }
            />
          }
        />

        <SettingsRow
          title="Use Proxy Routing"
          description="Route playlists through CDN proxies (recommended for ad-blocking)"
          control={
            <Toggle
              enabled={streamlink.use_proxy}
              onChange={() =>
                updateSettings({
                  ...settings,
                  streamlink: { ...streamlink, use_proxy: !streamlink.use_proxy },
                })
              }
            />
          }
        >
          {streamlink.use_proxy && (
            <div className="space-y-4">
              <ProxyHealthChecker />

              <details className="group">
                <summary className="cursor-pointer text-sm font-medium text-textSecondary hover:text-textPrimary transition-colors flex items-center gap-2">
                  <span className="transform transition-transform group-open:rotate-90">▶</span>
                  Advanced: Manual Proxy Configuration
                </summary>
                <div className="mt-3 p-3 bg-glass rounded-lg">
                  <label className="block text-sm font-medium text-textPrimary mb-2">
                    Proxy Arguments
                  </label>
                  <input
                    type="text"
                    value={streamlink.proxy_playlist}
                    onChange={(e) =>
                      updateSettings({
                        ...settings,
                        streamlink: { ...streamlink, proxy_playlist: e.target.value },
                      })
                    }
                    className="w-full glass-input text-textPrimary text-sm px-3 py-2 font-mono"
                    placeholder="--twitch-proxy-playlist=https://..."
                  />
                  <p className="text-xs text-textSecondary mt-1">
                    Custom proxy playlist arguments. Use the health checker above to auto-generate optimal settings,
                    or manually specify proxy URLs here.
                  </p>
                </div>
              </details>
            </div>
          )}
        </SettingsRow>

        <SettingsRow
          title={`Connection Timeout: ${streamlink.stream_timeout}s`}
          description="How long to keep retrying to resolve a stream before giving up (e.g. waiting for a channel that just went live)"
        >
          <input
            type="range"
            min="30"
            max="120"
            step="5"
            value={streamlink.stream_timeout}
            onChange={(e) =>
              updateSettings({
                ...settings,
                streamlink: { ...streamlink, stream_timeout: parseInt(e.target.value) },
              })
            }
            className="w-full accent-accent cursor-pointer"
          />
        </SettingsRow>

        <SettingsRow
          title={`Auto-Retry Delay: ${streamlink.retry_streams}s`}
          description="Seconds to wait between resolve attempts while a stream isn't available yet (0 = a single attempt)"
        >
          <input
            type="range"
            min="0"
            max="5"
            step="1"
            value={streamlink.retry_streams}
            onChange={(e) =>
              updateSettings({
                ...settings,
                streamlink: { ...streamlink, retry_streams: parseInt(e.target.value) },
              })
            }
            className="w-full accent-accent cursor-pointer"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        id="settings-section-video-player"
        label="Video Player"
      >
        <SettingsRow
          title="Autoplay"
          description="Automatically play stream when loaded"
          control={
            <Toggle
              enabled={videoPlayer?.autoplay ?? true}
              onChange={() =>
                updateSettings({
                  ...settings,
                  video_player: { ...videoPlayer, autoplay: !(videoPlayer?.autoplay ?? true) },
                })
              }
            />
          }
        />

        <SettingsRow
          title="Low Latency Mode"
          description="Reduce stream delay for live content (may affect stability)"
          control={
            <Toggle
              enabled={videoPlayer?.low_latency_mode ?? true}
              onChange={() =>
                updateSettings({
                  ...settings,
                  video_player: { ...videoPlayer, low_latency_mode: !(videoPlayer?.low_latency_mode ?? true) },
                })
              }
            />
          }
        />

        <SettingsRow
          title={`Max Buffer Length: ${videoPlayer?.max_buffer_length ?? 120}s`}
          description="Maximum amount of video to buffer ahead (higher = more stable, but more delay)"
        >
          <input
            type="range"
            min="3"
            max="300"
            step="1"
            value={videoPlayer?.max_buffer_length ?? 120}
            onChange={(e) =>
              updateSettings({
                ...settings,
                video_player: {
                  ...videoPlayer,
                  max_buffer_length: parseInt(e.target.value),
                },
              })
            }
            className="w-full accent-accent cursor-pointer"
          />
        </SettingsRow>

        <SettingsRow
          title="Default Stream Quality"
          description="Quality to use when starting streams (you can change quality anytime using the player controls)"
        >
          <Dropdown
            value={settings.quality}
            onChange={(v) => updateSettings({ ...settings, quality: v })}
            className="w-full"
            ariaLabel="Default stream quality"
            options={[
              { value: 'best', label: 'Auto (Source)' },
              { value: '1440p60', label: '1440p60' },
              { value: '1080p60', label: '1080p60' },
              { value: '720p60', label: '720p60' },
              { value: '480p30', label: '480p30' },
              { value: '360p30', label: '360p30' },
              { value: '160p30', label: '160p30' },
              { value: 'audio_only', label: 'Audio Only' },
            ]}
          />
        </SettingsRow>

        <SettingsRow
          title="Lock Aspect Ratio (16:9)"
          description="Prevent letterboxing by constraining window resize to maintain video aspect ratio"
          control={
            <Toggle
              enabled={videoPlayer?.lock_aspect_ratio ?? false}
              onChange={() =>
                updateSettings({
                  ...settings,
                  video_player: { ...videoPlayer, lock_aspect_ratio: !(videoPlayer?.lock_aspect_ratio ?? false) },
                })
              }
            />
          }
        />

        <SettingsRow
          title="Start Muted"
          description="Begin playback with audio muted"
          control={
            <Toggle
              enabled={videoPlayer?.muted ?? false}
              onChange={() =>
                updateSettings({
                  ...settings,
                  video_player: { ...videoPlayer, muted: !(videoPlayer?.muted ?? false) },
                })
              }
            />
          }
        />

        <SettingsRow
          title={`Default Volume: ${Math.round((videoPlayer?.volume ?? 1.0) * 100)}%`}
          description="Initial volume level when starting playback"
        >
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={videoPlayer?.volume ?? 1.0}
            onChange={(e) =>
              updateSettings({
                ...settings,
                video_player: { ...videoPlayer, volume: parseFloat(e.target.value) },
              })
            }
            className="w-full accent-accent cursor-pointer"
          />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
};

export default PlayerSettings;
