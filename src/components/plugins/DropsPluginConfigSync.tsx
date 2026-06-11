import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Logger } from '../../utils/logger';

/**
 * Keeps a drops-mining plugin configured from the app's native Drops settings.
 * Runs app-wide so the plugin is configured (and resumes mining if the user
 * had auto-mining on) whether or not the Drops center is open. The plugin has
 * no settings UI of its own; core's settings are the single source.
 *
 * Core never names the plugin: it asks whether anything provides drops.mining
 * and pushes config and control through the named hooks.
 */
const DropsPluginConfigSync = () => {
  useEffect(() => {
    let disposed = false;
    const sync = async () => {
      try {
        const provider = await invoke<string | null>('plugins_provides', {
          feature: 'drops.mining',
        });
        if (!provider || disposed) return;
        const settings = await invoke<Record<string, unknown>>('get_drops_settings');
        await invoke('plugins_invoke_action', { action: 'drops.configure', args: settings });
        // Resume mining if the user had auto-mining enabled.
        if (settings.auto_mining_enabled) {
          await invoke('plugins_invoke_action', { action: 'drops.mine-auto', args: {} });
        }
      } catch (e) {
        Logger.warn('[DropsPluginConfigSync] sync failed:', e);
      }
    };
    sync();
    let unlisten: (() => void) | undefined;
    listen('plugin://state-changed', () => sync()).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return null;
};

export default DropsPluginConfigSync;
