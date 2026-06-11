// Headless per-window loader for ui plugins. Mount once in any window whose
// surfaces consume plugin contributions (the main app, the MultiChat popout).
// Loads enabled ui plugins on mount and keeps the loaded set in sync with
// enable/disable/install changes via plugin://state-changed.

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../stores/AppStore';
import { syncUiPlugins } from './loader';

const PluginUiHost = () => {
  const addToast = useAppStore((s) => s.addToast);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const onError = (message: string) => addToast(message, 'error');
    void syncUiPlugins(onError);
    void listen('plugin://state-changed', () => {
      void syncUiPlugins(onError);
    }).then((u) => {
      if (disposed) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // Plugins stay loaded for the window's lifetime; the host component is
    // never unmounted, so no unload-on-cleanup is needed here.
  }, [addToast]);

  return null;
};

export default PluginUiHost;
