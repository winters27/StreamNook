import { useAppStore } from '../../stores/AppStore';
import { useState, useEffect } from 'react';

const DropsSettings = () => {
  const { settings, updateSettings } = useAppStore();
  const [isMining, setIsMining] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [showPrioritySettings, setShowPrioritySettings] = useState(false);
  const [showRecoverySettings, setShowRecoverySettings] = useState(false);

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

  // Check mining status on mount and listen for updates
  useEffect(() => {
    const checkMiningStatus = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const mining = await invoke<boolean>('is_auto_mining');
        setIsMining(mining);
      } catch (error) {
        console.error('Failed to check mining status:', error);
      }
    };
    checkMiningStatus();

    // Listen for mining status updates from backend
    let unlisten: (() => void) | undefined;
    const setupListener = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<any>('mining-status-update', (event) => {
        const status = event.payload;
        console.log('Mining status update received:', status);

        // Update mining state based on actual status
        setIsMining(status.is_mining);

        // Clear initializing state when we get confirmation
        if (status.is_mining && isInitializing) {
          setIsInitializing(false);
        }
      });
    };
    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [isInitializing]);

  const handleMiningToggle = async () => {
    const enabled = !isMining;
    try {
      const { invoke } = await import('@tauri-apps/api/core');

      if (enabled) {
        // Show loading state when turning on
        setIsInitializing(true);

        // First update the setting
        await updateDropsSettings({ auto_mining_enabled: enabled });

        // Start the mining service (this spawns a background task)
        // The mining-status-update event will tell us when it's actually running
        await invoke('start_auto_mining');

        // Note: Don't set isMining or clear isInitializing here
        // Wait for the mining-status-update event to confirm it started
      } else {
        // Stopping is more immediate
        await updateDropsSettings({ auto_mining_enabled: enabled });
        await invoke('stop_auto_mining');
        setIsMining(false);
        setIsInitializing(false);
      }
    } catch (error) {
      console.error('Failed to toggle mining:', error);
      setIsInitializing(false);
      setIsMining(false);
    }
  };

  const updateDropsSettings = async (newSettings: Partial<typeof settings.drops>) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const updatedSettings = {
        auto_claim_drops: settings.drops?.auto_claim_drops ?? true,
        auto_claim_channel_points: settings.drops?.auto_claim_channel_points ?? true,
        notify_on_drop_available: settings.drops?.notify_on_drop_available ?? true,
        notify_on_drop_claimed: settings.drops?.notify_on_drop_claimed ?? true,
        notify_on_points_claimed: settings.drops?.notify_on_points_claimed ?? false,
        check_interval_seconds: settings.drops?.check_interval_seconds ?? 60,
        auto_mining_enabled: settings.drops?.auto_mining_enabled ?? false,
        priority_games: settings.drops?.priority_games ?? [],
        excluded_games: settings.drops?.excluded_games ?? [],
        priority_mode: settings.drops?.priority_mode ?? 'PriorityOnly',
        watch_interval_seconds: settings.drops?.watch_interval_seconds ?? 20,
        ...newSettings,
      };
      await invoke('update_drops_settings', { settings: updatedSettings });
      updateSettings({
        ...settings,
        drops: { ...settings.drops, ...newSettings },
      });
    } catch (error) {
      console.error('Failed to update drops settings:', error);
    }
  };

  return (
    <div className="space-y-6">
      {/* Auto Mining Section */}
      <div className="border-b border-border pb-6">
        <h3 className="text-lg font-semibold text-textPrimary mb-4">Automated Mining</h3>

        {/* Enable Auto Mining */}
        <div className="mb-4">
          <div className="flex items-center justify-between gap-4">
            <div className="relative flex items-center gap-3">
              {isInitializing && (
                <div className="flex items-center justify-center">
                  <svg
                    className="animate-spin h-4 w-4 text-accent"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                </div>
              )}
              <div>
                <span className="text-sm font-medium text-textPrimary">
                  Enable Auto Mining
                  {isInitializing && <span className="ml-2 text-xs text-accent">(Initializing...)</span>}
                </span>
                <p className="text-xs text-textSecondary">
                  Automatically watch streams to earn drops
                </p>
              </div>
            </div>
            <Toggle
              enabled={isMining}
              onChange={handleMiningToggle}
              disabled={isInitializing}
            />
          </div>
        </div>

        {/* Priority Mode */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-textPrimary mb-2">
            Priority Mode
          </label>
          <select
            value={settings.drops?.priority_mode ?? 'PriorityOnly'}
            onChange={(e) => updateDropsSettings({
              priority_mode: e.target.value as 'PriorityOnly' | 'EndingSoonest' | 'LowAvailFirst'
            })}
            className="w-full px-3 py-2 bg-background border border-border rounded-md text-textPrimary text-sm"
          >
            <option value="PriorityOnly">Priority Games Only</option>
            <option value="EndingSoonest">Campaigns Ending Soonest</option>
            <option value="LowAvailFirst">Low Availability First</option>
          </select>
          <p className="text-xs text-textSecondary mt-1">
            How to select which campaigns to mine
          </p>
        </div>

        {/* Watch Interval */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-textPrimary mb-2">
            Watch Interval: {settings.drops?.watch_interval_seconds ?? 20} seconds
          </label>
          <input
            type="range"
            min="10"
            max="60"
            step="5"
            value={settings.drops?.watch_interval_seconds ?? 20}
            onChange={(e) => updateDropsSettings({ watch_interval_seconds: parseInt(e.target.value) })}
            className="w-full accent-accent cursor-pointer"
          />
          <p className="text-xs text-textSecondary mt-1">
            How often to update mining progress (lower = more frequent updates)
          </p>
        </div>

        {/* Priority Settings Button */}
        <button
          onClick={() => setShowPrioritySettings(!showPrioritySettings)}
          className="w-full px-4 py-2 bg-accent hover:bg-accent/80 text-white rounded-md text-sm font-medium transition-colors"
        >
          {showPrioritySettings ? 'Hide' : 'Configure'} Priority Games
        </button>

        {/* Priority Settings Panel */}
        {showPrioritySettings && (
          <div className="mt-4 p-4 bg-background border border-border rounded-md">
            <h4 className="text-sm font-semibold text-textPrimary mb-3">Priority Games</h4>
            <p className="text-xs text-textSecondary mb-3">
              Add games in order of priority. The miner will prefer these games when selecting channels.
            </p>

            {/* Priority Games List */}
            <div className="space-y-2 mb-3">
              {(settings.drops?.priority_games ?? []).map((game, index) => (
                <div key={index} className="flex items-center gap-2 bg-backgroundSecondary p-2 rounded">
                  <span className="text-xs text-textSecondary w-6">{index + 1}.</span>
                  <span className="text-sm text-textPrimary flex-1">{game}</span>
                  <button
                    onClick={() => {
                      const newPriority = [...(settings.drops?.priority_games ?? [])];
                      newPriority.splice(index, 1);
                      updateDropsSettings({ priority_games: newPriority });
                    }}
                    className="text-red-500 hover:text-red-400 text-xs px-2 py-1"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {(settings.drops?.priority_games ?? []).length === 0 && (
                <p className="text-xs text-textSecondary italic">No priority games set</p>
              )}
            </div>

            {/* Add Priority Game */}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Enter game name..."
                id="priority-game-input"
                className="flex-1 px-3 py-2 bg-background border border-border rounded-md text-textPrimary text-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const input = e.currentTarget;
                    const gameName = input.value.trim();
                    if (gameName && !(settings.drops?.priority_games ?? []).includes(gameName)) {
                      updateDropsSettings({
                        priority_games: [...(settings.drops?.priority_games ?? []), gameName]
                      });
                      input.value = '';
                    }
                  }
                }}
              />
              <button
                onClick={() => {
                  const input = document.getElementById('priority-game-input') as HTMLInputElement;
                  const gameName = input.value.trim();
                  if (gameName && !(settings.drops?.priority_games ?? []).includes(gameName)) {
                    updateDropsSettings({
                      priority_games: [...(settings.drops?.priority_games ?? []), gameName]
                    });
                    input.value = '';
                  }
                }}
                className="px-4 py-2 bg-accent hover:bg-accent/80 text-white rounded-md text-sm"
              >
                Add
              </button>
            </div>

            {/* Excluded Games */}
            <h4 className="text-sm font-semibold text-textPrimary mt-6 mb-3">Excluded Games</h4>
            <p className="text-xs text-textSecondary mb-3">
              Games to never mine, even if they have active campaigns.
            </p>

            <div className="space-y-2 mb-3">
              {(settings.drops?.excluded_games ?? []).map((game, index) => (
                <div key={index} className="flex items-center gap-2 bg-backgroundSecondary p-2 rounded">
                  <span className="text-sm text-textPrimary flex-1">{game}</span>
                  <button
                    onClick={() => {
                      const newExcluded = [...(settings.drops?.excluded_games ?? [])];
                      newExcluded.splice(index, 1);
                      updateDropsSettings({ excluded_games: newExcluded });
                    }}
                    className="text-red-500 hover:text-red-400 text-xs px-2 py-1"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {(settings.drops?.excluded_games ?? []).length === 0 && (
                <p className="text-xs text-textSecondary italic">No excluded games</p>
              )}
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Enter game name to exclude..."
                id="excluded-game-input"
                className="flex-1 px-3 py-2 bg-background border border-border rounded-md text-textPrimary text-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const input = e.currentTarget;
                    const gameName = input.value.trim();
                    if (gameName && !(settings.drops?.excluded_games ?? []).includes(gameName)) {
                      updateDropsSettings({
                        excluded_games: [...(settings.drops?.excluded_games ?? []), gameName]
                      });
                      input.value = '';
                    }
                  }
                }}
              />
              <button
                onClick={() => {
                  const input = document.getElementById('excluded-game-input') as HTMLInputElement;
                  const gameName = input.value.trim();
                  if (gameName && !(settings.drops?.excluded_games ?? []).includes(gameName)) {
                    updateDropsSettings({
                      excluded_games: [...(settings.drops?.excluded_games ?? []), gameName]
                    });
                    input.value = '';
                  }
                }}
                className="px-4 py-2 bg-accent hover:bg-accent/80 text-white rounded-md text-sm"
              >
                Add
              </button>
            </div>
          </div>
        )}

        {/* Recovery Settings Button */}
        <button
          onClick={() => setShowRecoverySettings(!showRecoverySettings)}
          className="w-full mt-3 px-4 py-2 bg-backgroundSecondary hover:bg-backgroundSecondary/80 border border-border text-textPrimary rounded-md text-sm font-medium transition-colors"
        >
          {showRecoverySettings ? 'Hide' : 'Configure'} Recovery Settings
        </button>

        {/* Recovery Settings Panel */}
        {showRecoverySettings && (
          <div className="mt-4 p-4 bg-background border border-border rounded-md">
            <h4 className="text-sm font-semibold text-textPrimary mb-3 flex items-center gap-2">
              <span className="text-lg">🛡️</span>
              Mining Recovery System
            </h4>
            <p className="text-xs text-textSecondary mb-4">
              Configure how StreamNook handles stuck mining sessions, offline streamers, and stale progress.
            </p>

            {/* Recovery Mode */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-textPrimary mb-2">
                Recovery Mode
              </label>
              <select
                value={settings.drops?.recovery_settings?.recovery_mode ?? 'Automatic'}
                onChange={(e) => updateDropsSettings({
                  recovery_settings: {
                    ...(settings.drops?.recovery_settings ?? {}),
                    recovery_mode: e.target.value as 'Automatic' | 'Relaxed' | 'ManualOnly'
                  }
                })}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-textPrimary text-sm"
              >
                <option value="Automatic">Automatic (7 min threshold)</option>
                <option value="Relaxed">Relaxed (15 min threshold)</option>
                <option value="ManualOnly">Manual Only (notify but don't switch)</option>
              </select>
              <p className="text-xs text-textSecondary mt-1">
                How aggressively to handle stuck mining sessions
              </p>
            </div>

            {/* Stale Progress Threshold */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-textPrimary mb-2">
                Stale Progress Threshold: {Math.round((settings.drops?.recovery_settings?.stale_progress_threshold_seconds ?? 420) / 60)} minutes
              </label>
              <input
                type="range"
                min="180"
                max="900"
                step="60"
                value={settings.drops?.recovery_settings?.stale_progress_threshold_seconds ?? 420}
                onChange={(e) => updateDropsSettings({
                  recovery_settings: {
                    ...(settings.drops?.recovery_settings ?? {}),
                    stale_progress_threshold_seconds: parseInt(e.target.value)
                  }
                })}
                className="w-full accent-accent cursor-pointer"
              />
              <p className="text-xs text-textSecondary mt-1">
                Switch streamers if no progress increase for this long (3-15 minutes)
              </p>
            </div>

            {/* Streamer Blacklist Duration */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-textPrimary mb-2">
                Streamer Blacklist Duration: {Math.round((settings.drops?.recovery_settings?.streamer_blacklist_duration_seconds ?? 600) / 60)} minutes
              </label>
              <input
                type="range"
                min="300"
                max="1800"
                step="60"
                value={settings.drops?.recovery_settings?.streamer_blacklist_duration_seconds ?? 600}
                onChange={(e) => updateDropsSettings({
                  recovery_settings: {
                    ...(settings.drops?.recovery_settings ?? {}),
                    streamer_blacklist_duration_seconds: parseInt(e.target.value)
                  }
                })}
                className="w-full accent-accent cursor-pointer"
              />
              <p className="text-xs text-textSecondary mt-1">
                How long to avoid a streamer after they fail (5-30 minutes)
              </p>
            </div>

            {/* Campaign Deprioritize Duration */}
            <div className="mb-4">
              <label className="block text-sm font-medium text-textPrimary mb-2">
                Campaign Deprioritize Duration: {Math.round((settings.drops?.recovery_settings?.campaign_deprioritize_duration_seconds ?? 1800) / 60)} minutes
              </label>
              <input
                type="range"
                min="600"
                max="3600"
                step="300"
                value={settings.drops?.recovery_settings?.campaign_deprioritize_duration_seconds ?? 1800}
                onChange={(e) => updateDropsSettings({
                  recovery_settings: {
                    ...(settings.drops?.recovery_settings ?? {}),
                    campaign_deprioritize_duration_seconds: parseInt(e.target.value)
                  }
                })}
                className="w-full accent-accent cursor-pointer"
              />
              <p className="text-xs text-textSecondary mt-1">
                How long to deprioritize a campaign with no working streamers (10-60 minutes)
              </p>
            </div>

            {/* Detect Game Category Change */}
            <div className="mb-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="text-sm font-medium text-textPrimary">Detect Game Category Changes</span>
                  <p className="text-xs text-textSecondary">
                    Switch if streamer changes to a different game
                  </p>
                </div>
                <Toggle
                  enabled={settings.drops?.recovery_settings?.detect_game_category_change ?? true}
                  onChange={async () => {
                    await updateDropsSettings({
                      recovery_settings: {
                        ...(settings.drops?.recovery_settings ?? {}),
                        detect_game_category_change: !(settings.drops?.recovery_settings?.detect_game_category_change ?? true)
                      }
                    });
                  }}
                />
              </div>
            </div>

            {/* Notify on Recovery Actions */}
            <div className="mb-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="text-sm font-medium text-textPrimary">Notify on Recovery Actions</span>
                  <p className="text-xs text-textSecondary">
                    Show notifications when streamers are switched
                  </p>
                </div>
                <Toggle
                  enabled={settings.drops?.recovery_settings?.notify_on_recovery_action ?? true}
                  onChange={async () => {
                    await updateDropsSettings({
                      recovery_settings: {
                        ...(settings.drops?.recovery_settings ?? {}),
                        notify_on_recovery_action: !(settings.drops?.recovery_settings?.notify_on_recovery_action ?? true)
                      }
                    });
                  }}
                />
              </div>
            </div>

            {/* Max Recovery Attempts */}
            <div className="mb-2">
              <label className="block text-sm font-medium text-textPrimary mb-2">
                Max Recovery Attempts: {settings.drops?.recovery_settings?.max_recovery_attempts ?? 5}
              </label>
              <input
                type="range"
                min="3"
                max="10"
                step="1"
                value={settings.drops?.recovery_settings?.max_recovery_attempts ?? 5}
                onChange={(e) => updateDropsSettings({
                  recovery_settings: {
                    ...(settings.drops?.recovery_settings ?? {}),
                    max_recovery_attempts: parseInt(e.target.value)
                  }
                })}
                className="w-full accent-accent cursor-pointer"
              />
              <p className="text-xs text-textSecondary mt-1">
                Stop mining after this many consecutive failures (3-10)
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Auto-claim Section */}
      <div className="border-b border-border pb-6">
        <h3 className="text-lg font-semibold text-textPrimary mb-4">Auto-claim</h3>

        {/* Auto-claim Drops */}
        <div className="mb-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-sm font-medium text-textPrimary">Auto-claim Drops</span>
              <p className="text-xs text-textSecondary">
                Automatically claim drops when they're ready
              </p>
            </div>
            <Toggle
              enabled={settings.drops?.auto_claim_drops ?? true}
              onChange={async () => {
                await updateDropsSettings({ auto_claim_drops: !(settings.drops?.auto_claim_drops ?? true) });
              }}
            />
          </div>
        </div>

        {/* Auto-claim Channel Points */}
        <div className="mb-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-sm font-medium text-textPrimary">Auto-claim Channel Points</span>
              <p className="text-xs text-textSecondary">
                Automatically claim channel point bonuses
              </p>
            </div>
            <Toggle
              enabled={settings.drops?.auto_claim_channel_points ?? true}
              onChange={async () => {
                await updateDropsSettings({ auto_claim_channel_points: !(settings.drops?.auto_claim_channel_points ?? true) });
              }}
            />
          </div>
        </div>
      </div>

      {/* Notifications Section */}
      <div className="border-b border-border pb-6">
        <h3 className="text-lg font-semibold text-textPrimary mb-4">Notifications</h3>

        {/* Notify on Drop Available */}
        <div className="mb-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-sm font-medium text-textPrimary">Notify When Drop Ready</span>
              <p className="text-xs text-textSecondary">
                Show notification when a drop is ready to claim
              </p>
            </div>
            <Toggle
              enabled={settings.drops?.notify_on_drop_available ?? true}
              onChange={async () => {
                await updateDropsSettings({ notify_on_drop_available: !(settings.drops?.notify_on_drop_available ?? true) });
              }}
            />
          </div>
        </div>

        {/* Notify on Drop Claimed */}
        <div className="mb-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-sm font-medium text-textPrimary">Notify When Drop Claimed</span>
              <p className="text-xs text-textSecondary">
                Show notification when a drop has been claimed
              </p>
            </div>
            <Toggle
              enabled={settings.drops?.notify_on_drop_claimed ?? true}
              onChange={async () => {
                await updateDropsSettings({ notify_on_drop_claimed: !(settings.drops?.notify_on_drop_claimed ?? true) });
              }}
            />
          </div>
        </div>

        {/* Notify on Points Claimed */}
        <div className="mb-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-sm font-medium text-textPrimary">Notify When Points Claimed</span>
              <p className="text-xs text-textSecondary">
                Show notification when channel points are claimed
              </p>
            </div>
            <Toggle
              enabled={settings.drops?.notify_on_points_claimed ?? false}
              onChange={async () => {
                await updateDropsSettings({ notify_on_points_claimed: !(settings.drops?.notify_on_points_claimed ?? false) });
              }}
            />
          </div>
        </div>
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
            await updateDropsSettings({ check_interval_seconds: parseInt(e.target.value) });
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
