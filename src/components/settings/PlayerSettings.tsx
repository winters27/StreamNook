import { useAppStore } from '../../stores/AppStore';

const PlayerSettings = () => {
  const { settings, updateSettings } = useAppStore();

  return (
    <div className="space-y-6">
      <div className="mb-4">
        <p className="text-sm text-textSecondary">
          Most player controls (volume, quality, playback speed) are now available directly in the video player. 
          These settings control advanced streaming behavior.
        </p>
      </div>

      {/* Video Player Settings */}
      <div className="space-y-4">
        {/* Autoplay */}
        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.video_player?.autoplay ?? true}
              onChange={(e) =>
                updateSettings({
                  ...settings,
                  video_player: { ...settings.video_player, autoplay: e.target.checked },
                })
              }
              className="w-5 h-5 accent-accent cursor-pointer"
            />
            <div>
              <span className="text-sm font-medium text-textPrimary">Autoplay</span>
              <p className="text-xs text-textSecondary">Automatically play stream when loaded</p>
            </div>
          </label>
        </div>

        {/* Low Latency Mode */}
        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.video_player?.low_latency_mode ?? true}
              onChange={(e) =>
                updateSettings({
                  ...settings,
                  video_player: { ...settings.video_player, low_latency_mode: e.target.checked },
                })
              }
              className="w-5 h-5 accent-accent cursor-pointer"
            />
            <div>
              <span className="text-sm font-medium text-textPrimary">Low Latency Mode</span>
              <p className="text-xs text-textSecondary">Reduce stream delay for live content (may affect stability)</p>
            </div>
          </label>
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

        {/* Start Quality */}
        <div>
          <label className="block text-sm font-medium text-textPrimary mb-2">
            Initial Quality
          </label>
          <select
            value={settings.video_player?.start_quality ?? -1}
            onChange={(e) =>
              updateSettings({
                ...settings,
                video_player: {
                  ...settings.video_player,
                  start_quality: parseInt(e.target.value),
                },
              })
            }
            className="w-full glass-input text-textPrimary text-sm px-3 py-2"
          >
            <option value="-1">Auto (Recommended)</option>
            <option value="0">Lowest Quality</option>
            <option value="1">Low Quality</option>
            <option value="2">Medium Quality</option>
            <option value="3">High Quality</option>
            <option value="4">Highest Quality</option>
          </select>
          <p className="text-xs text-textSecondary mt-1">
            Starting quality level (you can change quality anytime using the player controls)
          </p>
        </div>

        {/* Lock Aspect Ratio */}
        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.video_player?.lock_aspect_ratio ?? false}
              onChange={(e) =>
                updateSettings({
                  ...settings,
                  video_player: { ...settings.video_player, lock_aspect_ratio: e.target.checked },
                })
              }
              className="w-5 h-5 accent-accent cursor-pointer"
            />
            <div>
              <span className="text-sm font-medium text-textPrimary">Lock Aspect Ratio (16:9)</span>
              <p className="text-xs text-textSecondary">Prevent letterboxing by constraining window resize to maintain video aspect ratio</p>
            </div>
          </label>
        </div>

        {/* Default Volume and Muted - Kept for initial state */}
        <div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.video_player?.muted ?? false}
              onChange={(e) =>
                updateSettings({
                  ...settings,
                  video_player: { ...settings.video_player, muted: e.target.checked },
                })
              }
              className="w-5 h-5 accent-accent cursor-pointer"
            />
            <div>
              <span className="text-sm font-medium text-textPrimary">Start Muted</span>
              <p className="text-xs text-textSecondary">Begin playback with audio muted</p>
            </div>
          </label>
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
