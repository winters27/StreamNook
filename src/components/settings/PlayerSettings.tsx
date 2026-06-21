import { Dropdown } from '../ui/Dropdown';
import { useAppStore } from '../../stores/AppStore';
import { SettingsSection, SettingsRow, SegmentedSelect } from './_primitives';
import { DEFAULT_AUDIO_BOOST, DEFAULT_SONG_ID } from '../../types';
import { Fader } from '../AudioBoostFaders';
import { audioBoostFaderDefs, audioBoostResetPatch } from '../../utils/audioBoost';
import { reportCodecPreference } from '../../utils/codecPreference';
import { invoke } from '@tauri-apps/api/core';
import { LL_TARGET_DEFAULT } from '../../utils/latency';

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
  { id: 'song', label: 'Identify Song' },
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

  // Audio boost: a compressor + makeup-gain stage on the player audio. Merge the
  // persisted values over the shared defaults so a missing/partial object still
  // renders, and write the whole object back (it persists as one nested field).
  const audioBoost = { ...DEFAULT_AUDIO_BOOST, ...(videoPlayer?.audio_boost ?? {}) };
  const setAudioBoost = (patch: Partial<typeof audioBoost>) => {
    updateSettings({
      ...settings,
      video_player: { ...videoPlayer, audio_boost: { ...audioBoost, ...patch } },
    });
  };
  // Shared fader descriptors (Boost first, then the five compressor params).
  const boostFaders = audioBoostFaderDefs(audioBoost);

  // Song identification: capture length + retry count. Merge persisted over
  // defaults and write the whole nested object back, mirroring audio boost.
  const songId = { ...DEFAULT_SONG_ID, ...(videoPlayer?.song_id ?? {}) };
  const setSongId = (patch: Partial<typeof songId>) => {
    updateSettings({
      ...settings,
      video_player: { ...videoPlayer, song_id: { ...songId, ...patch } },
    });
  };

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
              onChange={() => {
                const next = !(streamlink.enhanced_codecs ?? true);
                updateSettings({
                  ...settings,
                  streamlink: { ...streamlink, enhanced_codecs: next },
                });
                // Re-probe + report so the change takes effect on the next resolve
                // without waiting for an app restart.
                reportCodecPreference(next);
              }}
            />
          }
        />

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
          title="Live Edge Gap"
          description="How far behind the live edge to ride. Lower is closer to live; the lowest gaps need Low Latency on (and a capable connection) to stay smooth. Reopen the stream to apply."
        >
          <div className="flex items-center gap-3">
            <input
              type="range"
              min="2"
              max="10"
              step="0.1"
              value={videoPlayer?.ll_target_latency ?? LL_TARGET_DEFAULT}
              onChange={(e) =>
                updateSettings({
                  ...settings,
                  video_player: { ...videoPlayer, ll_target_latency: parseFloat(e.target.value) },
                })
              }
              className="w-full accent-accent cursor-pointer"
            />
            <span className="text-[12px] font-medium text-textPrimary tabular-nums flex-shrink-0">
              {(videoPlayer?.ll_target_latency ?? LL_TARGET_DEFAULT).toFixed(1)}s
            </span>
          </div>
        </SettingsRow>

        <SettingsRow
          title="Low Latency"
          description="Use the low-latency engine to hold a tight Live Edge Gap smoothly on channels that support it. Off keeps the stable path; if a stream stutters or won't play, turn this off."
          control={
            <Toggle
              enabled={videoPlayer?.experimental_low_latency ?? false}
              onChange={() => {
                const next = !(videoPlayer?.experimental_low_latency ?? false);
                updateSettings({
                  ...settings,
                  video_player: { ...videoPlayer, experimental_low_latency: next },
                });
                invoke('set_experimental_low_latency', { enabled: next }).catch(() => {});
              }}
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
              enabled={videoPlayer?.lock_aspect_ratio ?? true}
              onChange={() =>
                updateSettings({
                  ...settings,
                  video_player: { ...videoPlayer, lock_aspect_ratio: !(videoPlayer?.lock_aspect_ratio ?? true) },
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

      <SettingsSection
        id="settings-section-audio-boost"
        label="Audio Boost"
        description="Even out loud and quiet moments and push the stream a little louder than the source, without the harsh clipping you get from raising volume past 100%. Turn it on for a clean, balanced lift, then fine-tune to taste."
      >
        <SettingsRow
          title="Enable Audio Boost"
          description="Run the stream's audio through a compressor and a makeup-gain stage. Stacks on top of the normal volume slider."
          control={
            <Toggle
              enabled={audioBoost.enabled}
              onChange={() => setAudioBoost({ enabled: !audioBoost.enabled })}
            />
          }
        />

        <SettingsRow
          title="Boost"
          description="How much louder to make the stream after compression. 100% is no extra boost; higher is louder."
          disabled={!audioBoost.enabled}
        >
          <div className="flex justify-center pt-1">
            <Fader
              label={boostFaders[0].label}
              display={boostFaders[0].display}
              value={boostFaders[0].value}
              min={boostFaders[0].min}
              max={boostFaders[0].max}
              step={boostFaders[0].step}
              onChange={(v) => setAudioBoost(boostFaders[0].apply(v))}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title="Advanced Compressor Controls"
          description="Shape exactly how the compressor responds. Hover a label for what it does; the defaults are a gentle, natural starting point."
          disabled={!audioBoost.enabled}
        >
          <details className="group">
            <summary className="cursor-pointer text-sm font-medium text-textSecondary hover:text-textPrimary transition-colors flex items-center gap-2">
              <span className="transform transition-transform group-open:rotate-90">▶</span>
              Show advanced controls
            </summary>
            <div className="mt-5 flex flex-wrap items-end justify-center gap-x-6 gap-y-6">
              {boostFaders.slice(1).map((d) => (
                <Fader
                  key={d.key}
                  label={d.label}
                  display={d.display}
                  value={d.value}
                  min={d.min}
                  max={d.max}
                  step={d.step}
                  hint={d.hint}
                  onChange={(v) => setAudioBoost(d.apply(v))}
                />
              ))}
            </div>

            <div className="mt-5 flex justify-center">
              <button
                onClick={() => setAudioBoost(audioBoostResetPatch())}
                style={{ borderRadius: 8 }}
                className="glass-button text-textSecondary hover:text-textPrimary text-sm px-3 py-2"
              >
                Reset to defaults
              </button>
            </div>
          </details>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        id="settings-section-song-id"
        label="Song Identification"
        description="The /song command and the player's music button listen to a few seconds of the stream and name the track. Longer captures match more reliably, especially over talking or noise."
      >
        <SettingsRow
          title={`Listen Time: ${songId.capture_seconds}s`}
          description="How many seconds of audio to fingerprint. Longer is more accurate but takes a bit longer before the result appears."
        >
          <input
            type="range"
            min="3"
            max="20"
            step="1"
            value={songId.capture_seconds}
            onChange={(e) => setSongId({ capture_seconds: parseInt(e.target.value, 10) })}
            className="w-full accent-accent cursor-pointer"
          />
        </SettingsRow>

        <SettingsRow
          title={`Retries on No Match: ${songId.retries}`}
          description="If the first listen finds nothing, try again this many times. Each retry listens to a fresh window, so an ad break or quiet moment gets another shot."
        >
          <input
            type="range"
            min="0"
            max="3"
            step="1"
            value={songId.retries}
            onChange={(e) => setSongId({ retries: parseInt(e.target.value, 10) })}
            className="w-full accent-accent cursor-pointer"
          />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
};

export default PlayerSettings;
