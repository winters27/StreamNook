import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import DropsSettingsTab from '../drops/DropsSettingsTab';
import { Logger } from '../../utils/logger';

// The full DropsSettings shape with sensible defaults, so the rich settings
// tab always has every field present even before the plugin reports its
// config. This is the automation config the plugin owns and persists.
type Cfg = Record<string, unknown>;
const DEFAULTS: Cfg = {
  auto_claim_drops: true,
  auto_claim_channel_points: true,
  notify_on_drop_available: true,
  notify_on_drop_claimed: true,
  notify_on_points_claimed: false,
  check_interval_seconds: 60,
  auto_mining_enabled: false,
  priority_games: [],
  excluded_games: [],
  priority_mode: 'PriorityOnly',
  watch_interval_seconds: 20,
  recovery_settings: {},
  reserve_token_for_current_stream: true,
  auto_reserve_on_watch: true,
  priority_farm_channels: [],
};

interface Props {
  pluginId: string;
}

/**
 * The mining plugin's settings screen. It is core's own rich Drops settings
 * UI (the same component, with the follower-search channel picker, priority
 * lists, recovery sliders, and token-allocation map), but it reads and writes
 * the plugin's own config through the hooks rather than core settings. It only
 * renders when the plugin is installed, so the automation config belongs to
 * the plugin: uninstall it and these settings are gone.
 */
const DropsAutomationSettings = ({ pluginId }: Props) => {
  const [config, setConfig] = useState<Cfg | null>(null);

  useEffect(() => {
    let mounted = true;
    invoke<Cfg | null>('plugins_invoke_action', { action: 'drops.get-config', args: {} })
      .then((c) => {
        if (mounted) setConfig({ ...DEFAULTS, ...(c ?? {}) });
      })
      .catch((e) => {
        Logger.warn('[DropsAutomationSettings] get-config failed:', e);
        if (mounted) setConfig({ ...DEFAULTS });
      });
    return () => {
      mounted = false;
    };
  }, [pluginId]);

  const updateSettings = async (partial: Cfg) => {
    const merged = { ...(config ?? DEFAULTS), ...partial };
    setConfig(merged);
    try {
      await invoke('plugins_invoke_action', { action: 'drops.configure', args: merged });
    } catch (e) {
      Logger.warn('[DropsAutomationSettings] configure failed:', e);
    }
  };

  const startAutoMining = async () => {
    await invoke('plugins_invoke_action', { action: 'drops.mine-auto', args: {} }).catch((e) =>
      Logger.warn('[DropsAutomationSettings] start failed:', e)
    );
  };
  const stopMining = () => {
    invoke('plugins_invoke_action', { action: 'drops.stop', args: {} }).catch((e) =>
      Logger.warn('[DropsAutomationSettings] stop failed:', e)
    );
  };

  return (
    // DropsSettingsTab is built for a full tab; give it a bounded, scrollable
    // height so it sits cleanly inside the plugin card.
    <div className="h-[60vh] -mx-4 overflow-hidden rounded-lg border border-white/[0.06]">
      <DropsSettingsTab
        settings={config as never}
        onUpdateSettings={updateSettings as never}
        onStartAutoMining={startAutoMining}
        onStopMining={stopMining}
      />
    </div>
  );
};

export default DropsAutomationSettings;
