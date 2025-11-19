import { useAppStore } from '../../stores/AppStore';

const DropsSettings = () => {
  const { settings, updateSettings } = useAppStore();

  return (
    <div className="space-y-6">
      {/* Auto-claim Drops */}
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.drops?.auto_claim_drops ?? true}
            onChange={async (e) => {
              const enabled = e.target.checked;
              try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('update_drops_settings', {
                  settings: {
                    auto_claim_drops: enabled,
                    auto_claim_channel_points: settings.drops?.auto_claim_channel_points ?? true,
                    notify_on_drop_available: settings.drops?.notify_on_drop_available ?? true,
                    notify_on_drop_claimed: settings.drops?.notify_on_drop_claimed ?? true,
                    notify_on_points_claimed: settings.drops?.notify_on_points_claimed ?? false,
                    check_interval_seconds: settings.drops?.check_interval_seconds ?? 60,
                  },
                });
                updateSettings({
                  ...settings,
                  drops: { ...settings.drops, auto_claim_drops: enabled },
                });
              } catch (error) {
                console.error('Failed to update drops settings:', error);
              }
            }}
            className="w-5 h-5 accent-accent cursor-pointer"
          />
          <div>
            <span className="text-sm font-medium text-textPrimary">Auto-claim Drops</span>
            <p className="text-xs text-textSecondary">
              Automatically claim drops when they're ready
            </p>
          </div>
        </label>
      </div>

      {/* Auto-claim Channel Points */}
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.drops?.auto_claim_channel_points ?? true}
            onChange={async (e) => {
              const enabled = e.target.checked;
              try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('update_drops_settings', {
                  settings: {
                    auto_claim_drops: settings.drops?.auto_claim_drops ?? true,
                    auto_claim_channel_points: enabled,
                    notify_on_drop_available: settings.drops?.notify_on_drop_available ?? true,
                    notify_on_drop_claimed: settings.drops?.notify_on_drop_claimed ?? true,
                    notify_on_points_claimed: settings.drops?.notify_on_points_claimed ?? false,
                    check_interval_seconds: settings.drops?.check_interval_seconds ?? 60,
                  },
                });
                updateSettings({
                  ...settings,
                  drops: { ...settings.drops, auto_claim_channel_points: enabled },
                });
              } catch (error) {
                console.error('Failed to update drops settings:', error);
              }
            }}
            className="w-5 h-5 accent-accent cursor-pointer"
          />
          <div>
            <span className="text-sm font-medium text-textPrimary">Auto-claim Channel Points</span>
            <p className="text-xs text-textSecondary">
              Automatically claim channel point bonuses
            </p>
          </div>
        </label>
      </div>

      {/* Notify on Drop Available */}
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.drops?.notify_on_drop_available ?? true}
            onChange={async (e) => {
              const enabled = e.target.checked;
              try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('update_drops_settings', {
                  settings: {
                    auto_claim_drops: settings.drops?.auto_claim_drops ?? true,
                    auto_claim_channel_points: settings.drops?.auto_claim_channel_points ?? true,
                    notify_on_drop_available: enabled,
                    notify_on_drop_claimed: settings.drops?.notify_on_drop_claimed ?? true,
                    notify_on_points_claimed: settings.drops?.notify_on_points_claimed ?? false,
                    check_interval_seconds: settings.drops?.check_interval_seconds ?? 60,
                  },
                });
                updateSettings({
                  ...settings,
                  drops: { ...settings.drops, notify_on_drop_available: enabled },
                });
              } catch (error) {
                console.error('Failed to update drops settings:', error);
              }
            }}
            className="w-5 h-5 accent-accent cursor-pointer"
          />
          <div>
            <span className="text-sm font-medium text-textPrimary">Notify When Drop Ready</span>
            <p className="text-xs text-textSecondary">
              Show notification when a drop is ready to claim
            </p>
          </div>
        </label>
      </div>

      {/* Notify on Drop Claimed */}
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.drops?.notify_on_drop_claimed ?? true}
            onChange={async (e) => {
              const enabled = e.target.checked;
              try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('update_drops_settings', {
                  settings: {
                    auto_claim_drops: settings.drops?.auto_claim_drops ?? true,
                    auto_claim_channel_points: settings.drops?.auto_claim_channel_points ?? true,
                    notify_on_drop_available: settings.drops?.notify_on_drop_available ?? true,
                    notify_on_drop_claimed: enabled,
                    notify_on_points_claimed: settings.drops?.notify_on_points_claimed ?? false,
                    check_interval_seconds: settings.drops?.check_interval_seconds ?? 60,
                  },
                });
                updateSettings({
                  ...settings,
                  drops: { ...settings.drops, notify_on_drop_claimed: enabled },
                });
              } catch (error) {
                console.error('Failed to update drops settings:', error);
              }
            }}
            className="w-5 h-5 accent-accent cursor-pointer"
          />
          <div>
            <span className="text-sm font-medium text-textPrimary">Notify When Drop Claimed</span>
            <p className="text-xs text-textSecondary">
              Show notification when a drop has been claimed
            </p>
          </div>
        </label>
      </div>

      {/* Notify on Points Claimed */}
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.drops?.notify_on_points_claimed ?? false}
            onChange={async (e) => {
              const enabled = e.target.checked;
              try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('update_drops_settings', {
                  settings: {
                    auto_claim_drops: settings.drops?.auto_claim_drops ?? true,
                    auto_claim_channel_points: settings.drops?.auto_claim_channel_points ?? true,
                    notify_on_drop_available: settings.drops?.notify_on_drop_available ?? true,
                    notify_on_drop_claimed: settings.drops?.notify_on_drop_claimed ?? true,
                    notify_on_points_claimed: enabled,
                    check_interval_seconds: settings.drops?.check_interval_seconds ?? 60,
                  },
                });
                updateSettings({
                  ...settings,
                  drops: { ...settings.drops, notify_on_points_claimed: enabled },
                });
              } catch (error) {
                console.error('Failed to update drops settings:', error);
              }
            }}
            className="w-5 h-5 accent-accent cursor-pointer"
          />
          <div>
            <span className="text-sm font-medium text-textPrimary">Notify When Points Claimed</span>
            <p className="text-xs text-textSecondary">
              Show notification when channel points are claimed
            </p>
          </div>
        </label>
      </div>

      {/* Check Interval */}
      <div>
        <label className="block text-sm font-medium text-textPrimary mb-2">
          Check Interval: {settings.drops?.check_interval_seconds ?? 60} seconds
        </label>
        <input
          type="range"
          min="30"
          max="300"
          step="30"
          value={settings.drops?.check_interval_seconds ?? 60}
          onChange={async (e) => {
            const interval = parseInt(e.target.value);
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke('update_drops_settings', {
                settings: {
                  auto_claim_drops: settings.drops?.auto_claim_drops ?? true,
                  auto_claim_channel_points: settings.drops?.auto_claim_channel_points ?? true,
                  notify_on_drop_available: settings.drops?.notify_on_drop_available ?? true,
                  notify_on_drop_claimed: settings.drops?.notify_on_drop_claimed ?? true,
                  notify_on_points_claimed: settings.drops?.notify_on_points_claimed ?? false,
                  check_interval_seconds: interval,
                },
              });
              updateSettings({
                ...settings,
                drops: { ...settings.drops, check_interval_seconds: interval },
              });
            } catch (error) {
              console.error('Failed to update drops settings:', error);
            }
          }}
          className="w-full accent-accent cursor-pointer"
        />
        <p className="text-xs text-textSecondary mt-1">
          How often to check for drops and channel points (lower = more frequent checks)
        </p>
      </div>
    </div>
  );
};

export default DropsSettings;
