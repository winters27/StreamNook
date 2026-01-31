import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, X } from 'lucide-react';
import { useAppStore } from '../../stores/AppStore';
import ProxyHealthChecker from './ProxyHealthChecker';

import { Logger } from '../../utils/logger';


// Toggle component for reuse
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

const PlayerSettings = () => {
  const { settings, updateSettings } = useAppStore();

  // Default values for streamlink settings
  const streamlinkDefaults = {
    low_latency_enabled: true,
    hls_live_edge: 3,
    stream_timeout: 60,
    retry_streams: 3,
    disable_hosting: true,
    skip_ssl_verify: false,
    use_proxy: true,
    proxy_playlist: '--twitch-proxy-playlist=https://lb-na.cdn-perfprod.com,https://eu.luminous.dev --twitch-proxy-playlist-fallback',
    custom_streamlink_path: undefined,
  };

  const streamlink = settings.streamlink || streamlinkDefaults;

  const handleSelectStreamlinkFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Streamlink Folder',
      });

      if (selected && typeof selected === 'string') {
        updateSettings({
          ...settings,
          streamlink: { ...streamlink, custom_streamlink_path: selected },
        });
      }
    } catch (error) {
      Logger.error('Failed to open folder picker:', error);
    }
  };

  const handleClearStreamlinkPath = () => {
    updateSettings({
      ...settings,
      streamlink: { ...streamlink, custom_streamlink_path: undefined },
    });
  };

  return (
    <div className="space-y-6">
      <div className="mb-4">
        <p className="text-sm text-textSecondary">
          Most player controls (volume, quality, playback speed) are now available directly in the video player.
          These settings control advanced streaming behavior.
        </p>
      </div>

      {/* Auto-Switch Settings */}
      <div id="settings-section-auto-switch">
        <h3 className="text-lg font-semibold text-textPrimary border-b border-borderColor pb-2 mb-4">
          Auto-Switch
        </h3>
        <p className="text-xs text-textSecondary mb-4">
          When a stream goes offline, automatically switch to another stream.
        </p>

        <div className="space-y-4">
          {/* Enable Auto-Switch */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-textPrimary">
                Enable Auto-Switch
              </label>
              <p className="text-xs text-textSecondary">
                Automatically switch when current stream goes offline
              </p>
            </div>
            <Toggle
              enabled={settings.auto_switch?.enabled ?? true}
              onChange={() =>
                updateSettings({
                  ...settings,
                  auto_switch: {
                    enabled: !(settings.auto_switch?.enabled ?? true),
                    mode: settings.auto_switch?.mode ?? 'same_category',
                    show_notification: settings.auto_switch?.show_notification ?? true,
                    auto_redirect_on_raid: settings.auto_switch?.auto_redirect_on_raid ?? true,
                  },
                })
              }
            />
          </div>

          {/* Switch Mode */}
          <div className={`${!(settings.auto_switch?.enabled ?? true) ? 'opacity-50 pointer-events-none' : ''}`}>
            <label className="text-sm font-medium text-textPrimary mb-2 block">
              Switch To
            </label>
            <p className="text-xs text-textSecondary mb-2">
              Choose where to auto-switch when stream goes offline
            </p>
            <div className="flex gap-2">
              <button
                onClick={() =>
                  updateSettings({
                    ...settings,
                    auto_switch: {
                      enabled: settings.auto_switch?.enabled ?? true,
                      mode: 'same_category',
                      show_notification: settings.auto_switch?.show_notification ?? true,
                      auto_redirect_on_raid: settings.auto_switch?.auto_redirect_on_raid ?? true,
                    },
                  })
                }
                className={`flex-1 px-4 py-2 text-sm font-medium rounded transition-all ${(settings.auto_switch?.mode ?? 'same_category') === 'same_category'
                  ? 'glass-button text-white'
                  : 'bg-glass text-textSecondary hover:bg-glass-hover'
                  }`}
              >
                Same Category
              </button>
              <button
                onClick={() =>
                  updateSettings({
                    ...settings,
                    auto_switch: {
                      enabled: settings.auto_switch?.enabled ?? true,
                      mode: 'followed_streams',
                      show_notification: settings.auto_switch?.show_notification ?? true,
                      auto_redirect_on_raid: settings.auto_switch?.auto_redirect_on_raid ?? true,
                    },
                  })
                }
                className={`flex-1 px-4 py-2 text-sm font-medium rounded transition-all ${settings.auto_switch?.mode === 'followed_streams'
                  ? 'glass-button text-white'
                  : 'bg-glass text-textSecondary hover:bg-glass-hover'
                  }`}
              >
                Followed Streams
              </button>
            </div>
            <p className="text-xs text-textSecondary mt-2">
              {(settings.auto_switch?.mode ?? 'same_category') === 'same_category'
                ? 'Switch to the highest viewer stream in the same game/category'
                : 'Switch to one of your live followed streamers'}
            </p>
          </div>

          {/* Show Notification */}
          <div className={`flex items-center justify-between ${!(settings.auto_switch?.enabled ?? true) ? 'opacity-50 pointer-events-none' : ''}`}>
            <div>
              <label className="text-sm font-medium text-textPrimary">
                Show Notification
              </label>
              <p className="text-xs text-textSecondary">
                Display a toast when auto-switching streams
              </p>
            </div>
            <Toggle
              enabled={settings.auto_switch?.show_notification ?? true}
              onChange={() =>
                updateSettings({
                  ...settings,
                  auto_switch: {
                    enabled: settings.auto_switch?.enabled ?? true,
                    mode: settings.auto_switch?.mode ?? 'same_category',
                    show_notification: !(settings.auto_switch?.show_notification ?? true),
                    auto_redirect_on_raid: settings.auto_switch?.auto_redirect_on_raid ?? true,
                  },
                })
              }
            />
          </div>

          {/* Auto-Redirect on Raid */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-textPrimary">
                Auto-Redirect on Raid
              </label>
              <p className="text-xs text-textSecondary">
                Automatically follow raids to the target channel (requires login)
              </p>
            </div>
            <Toggle
              enabled={settings.auto_switch?.auto_redirect_on_raid ?? true}
              onChange={() =>
                updateSettings({
                  ...settings,
                  auto_switch: {
                    enabled: settings.auto_switch?.enabled ?? true,
                    mode: settings.auto_switch?.mode ?? 'same_category',
                    show_notification: settings.auto_switch?.show_notification ?? true,
                    auto_redirect_on_raid: !(settings.auto_switch?.auto_redirect_on_raid ?? true),
                  },
                })
              }
            />
          </div>
        </div>
      </div>

      {/* Custom Streamlink Location */}
      <div id="settings-section-streamlink-location" className="space-y-4">
        <h3 className="text-lg font-semibold text-textPrimary border-b border-borderColor pb-2">
          Custom Streamlink Location
        </h3>
        <p className="text-xs text-textSecondary">
          If the bundled Streamlink is missing or you prefer to use your own installation,
          select your Streamlink folder here. We'll automatically find plugins in this folder
          or in your AppData (for installed versions).
        </p>

        <div>
          <label className="block text-sm font-medium text-textPrimary mb-2">
            Streamlink Folder Path
          </label>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                type="text"
                value={streamlink.custom_streamlink_path || ''}
                readOnly
                placeholder="Using bundled Streamlink (default)"
                className="w-full glass-input text-textPrimary text-sm px-3 py-2 pr-10"
              />
              {streamlink.custom_streamlink_path && (
                <button
                  onClick={handleClearStreamlinkPath}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-textSecondary hover:text-red-400 transition-colors"
                  title="Clear custom path"
                >
                  <X size={16} />
                </button>
              )}
            </div>
            <button
              onClick={handleSelectStreamlinkFolder}
              className="px-4 py-2 glass-button text-white text-sm font-medium rounded flex items-center gap-2"
            >
              <FolderOpen size={16} />
              Browse
            </button>
          </div>
          <p className="text-xs text-textSecondary mt-2">
            {streamlink.custom_streamlink_path
              ? `Looking for executable at: ${streamlink.custom_streamlink_path}/bin/streamlinkw.exe`
              : 'Leave empty to use the bundled Streamlink that comes with StreamNook.'}
          </p>
          <div className="mt-2 p-3 bg-glass rounded-lg">
            <p className="text-xs text-textSecondary">
              <strong className="text-textPrimary">Plugin Search Order:</strong>
            </p>
            <ol className="text-xs text-textSecondary mt-1 list-decimal list-inside space-y-1">
              <li>Custom folder plugins (for Portable versions): <code className="text-accent">&lt;custom_path&gt;/plugins</code></li>
              <li>AppData plugins (for Installed versions): <code className="text-accent">%APPDATA%/streamlink/plugins</code></li>
              <li>Bundled plugins: <code className="text-accent">&lt;app_dir&gt;/streamlink/plugins</code></li>
            </ol>
          </div>
        </div>
      </div>

      {/* Streamlink Optimization Settings */}
      <div id="settings-section-streamlink-optimization" className="space-y-4">
        <h3 className="text-lg font-semibold text-textPrimary border-b border-borderColor pb-2">
          Streamlink Optimization
        </h3>

        {/* Twitch Low Latency */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-textPrimary">Twitch Low Latency Mode</span>
            <p className="text-xs text-textSecondary">Uses Twitch's low latency streaming (forces --twitch-low-latency)</p>
          </div>
          <Toggle
            enabled={streamlink.low_latency_enabled}
            onChange={() =>
              updateSettings({
                ...settings,
                streamlink: { ...streamlink, low_latency_enabled: !streamlink.low_latency_enabled },
              })
            }
          />
        </div>

        {/* HLS Live Edge */}
        <div>
          <label className="block text-sm font-medium text-textPrimary mb-2">
            HLS Live Edge: {streamlink.hls_live_edge} segments
          </label>
          <input
            type="range"
            min="1"
            max="10"
            step="1"
            value={streamlink.hls_live_edge}
            onChange={(e) =>
              updateSettings({
                ...settings,
                streamlink: { ...streamlink, hls_live_edge: parseInt(e.target.value) },
              })
            }
            className="w-full accent-accent cursor-pointer"
          />
          <p className="text-xs text-textSecondary mt-1">
            How many segments from the live edge to stay (lower = less latency, less stability)
          </p>
        </div>

        {/* Stream Timeout */}
        <div>
          <label className="block text-sm font-medium text-textPrimary mb-2">
            Stream Timeout: {streamlink.stream_timeout}s
          </label>
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
          <p className="text-xs text-textSecondary mt-1">
            How long to wait for stream response before timing out
          </p>
        </div>

        {/* Retry Streams */}
        <div>
          <label className="block text-sm font-medium text-textPrimary mb-2">
            Auto-Retry Count: {streamlink.retry_streams}
          </label>
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
          <p className="text-xs text-textSecondary mt-1">
            Number of times to automatically retry on stream errors (0 = no retry)
          </p>
        </div>

        {/* Disable Hosting */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-textPrimary">Disable Hosting</span>
            <p className="text-xs text-textSecondary">Skip streams that are hosting other channels</p>
          </div>
          <Toggle
            enabled={streamlink.disable_hosting}
            onChange={() =>
              updateSettings({
                ...settings,
                streamlink: { ...streamlink, disable_hosting: !streamlink.disable_hosting },
              })
            }
          />
        </div>

        {/* Use Proxy */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-textPrimary">Use Proxy Routing</span>
            <p className="text-xs text-textSecondary">Route playlists through CDN proxies (recommended for ad-blocking)</p>
          </div>
          <Toggle
            enabled={streamlink.use_proxy}
            onChange={() =>
              updateSettings({
                ...settings,
                streamlink: { ...streamlink, use_proxy: !streamlink.use_proxy },
              })
            }
          />
        </div>

        {/* Proxy Health Checker & Settings */}
        {streamlink.use_proxy && (
          <div className="space-y-4">
            {/* Proxy Health Checker */}
            <ProxyHealthChecker />
            
            {/* Advanced: Manual Proxy Args */}
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

        {/* Skip SSL Verify */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-textPrimary">Skip SSL Verification</span>
            <p className="text-xs text-textSecondary">⚠️ Only enable if you have connection issues (not recommended)</p>
          </div>
          <Toggle
            enabled={streamlink.skip_ssl_verify}
            onChange={() =>
              updateSettings({
                ...settings,
                streamlink: { ...streamlink, skip_ssl_verify: !streamlink.skip_ssl_verify },
              })
            }
          />
        </div>
      </div>

      {/* Video Player Settings */}
      <div id="settings-section-video-player" className="space-y-4">
        <h3 className="text-lg font-semibold text-textPrimary border-b border-borderColor pb-2 mt-6">
          Video Player
        </h3>
        {/* Autoplay */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-textPrimary">Autoplay</span>
            <p className="text-xs text-textSecondary">Automatically play stream when loaded</p>
          </div>
          <Toggle
            enabled={settings.video_player?.autoplay ?? true}
            onChange={() =>
              updateSettings({
                ...settings,
                video_player: { ...settings.video_player, autoplay: !(settings.video_player?.autoplay ?? true) },
              })
            }
          />
        </div>

        {/* Low Latency Mode */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-textPrimary">Low Latency Mode</span>
            <p className="text-xs text-textSecondary">Reduce stream delay for live content (may affect stability)</p>
          </div>
          <Toggle
            enabled={settings.video_player?.low_latency_mode ?? true}
            onChange={() =>
              updateSettings({
                ...settings,
                video_player: { ...settings.video_player, low_latency_mode: !(settings.video_player?.low_latency_mode ?? true) },
              })
            }
          />
        </div>

        {/* Jump to Live on Load */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-textPrimary">Jump to Live on Load</span>
            <p className="text-xs text-textSecondary">Automatically jump to the live edge when stream starts (fixes 15s delay)</p>
          </div>
          <Toggle
            enabled={settings.video_player?.jump_to_live ?? false}
            onChange={() =>
              updateSettings({
                ...settings,
                video_player: { ...settings.video_player, jump_to_live: !(settings.video_player?.jump_to_live ?? false) },
              })
            }
          />
        </div>

        {/* Max Buffer Length */}
        <div>
          <label className="block text-sm font-medium text-textPrimary mb-2">
            Max Buffer Length: {settings.video_player?.max_buffer_length ?? 120}s
          </label>
          <input
            type="range"
            min="3"
            max="300"
            step="1"
            value={settings.video_player?.max_buffer_length ?? 120}
            onChange={(e) =>
              updateSettings({
                ...settings,
                video_player: {
                  ...settings.video_player,
                  max_buffer_length: parseInt(e.target.value),
                },
              })
            }
            className="w-full accent-accent cursor-pointer"
          />
          <p className="text-xs text-textSecondary mt-1">
            Maximum amount of video to buffer ahead (higher = more stable, but more delay)
          </p>
        </div>

        {/* Stream Quality */}
        <div>
          <label className="block text-sm font-medium text-textPrimary mb-2">
            Default Stream Quality
          </label>
          <select
            value={settings.quality}
            onChange={(e) =>
              updateSettings({
                ...settings,
                quality: e.target.value,
              })
            }
            className="w-full glass-input text-textPrimary text-sm px-3 py-2"
          >
            <option value="best">Best (Highest Available)</option>
            <option value="1080p60">1080p 60fps</option>
            <option value="1080p">1080p</option>
            <option value="720p60">720p 60fps</option>
            <option value="720p">720p</option>
            <option value="480p">480p</option>
            <option value="360p">360p</option>
            <option value="160p">160p (Lowest)</option>
            <option value="audio_only">Audio Only</option>
            <option value="worst">Worst (Fallback)</option>
          </select>
          <p className="text-xs text-textSecondary mt-1">
            Quality to use when starting streams (you can change quality anytime using the player controls)
          </p>
        </div>

        {/* Lock Aspect Ratio */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-textPrimary">Lock Aspect Ratio (16:9)</span>
            <p className="text-xs text-textSecondary">Prevent letterboxing by constraining window resize to maintain video aspect ratio</p>
          </div>
          <Toggle
            enabled={settings.video_player?.lock_aspect_ratio ?? false}
            onChange={() =>
              updateSettings({
                ...settings,
                video_player: { ...settings.video_player, lock_aspect_ratio: !(settings.video_player?.lock_aspect_ratio ?? false) },
              })
            }
          />
        </div>

        {/* Default Volume and Muted - Kept for initial state */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-textPrimary">Start Muted</span>
            <p className="text-xs text-textSecondary">Begin playback with audio muted</p>
          </div>
          <Toggle
            enabled={settings.video_player?.muted ?? false}
            onChange={() =>
              updateSettings({
                ...settings,
                video_player: { ...settings.video_player, muted: !(settings.video_player?.muted ?? false) },
              })
            }
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-textPrimary mb-2">
            Default Volume: {Math.round((settings.video_player?.volume ?? 1.0) * 100)}%
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={settings.video_player?.volume ?? 1.0}
            onChange={(e) =>
              updateSettings({
                ...settings,
                video_player: { ...settings.video_player, volume: parseFloat(e.target.value) },
              })
            }
            className="w-full accent-accent cursor-pointer"
          />
          <p className="text-xs text-textSecondary mt-1">
            Initial volume level when starting playback
          </p>
        </div>
      </div>
    </div>
  );
};

export default PlayerSettings;
