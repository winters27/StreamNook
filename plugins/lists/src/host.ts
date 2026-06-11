// Module-level holder for the host api object. Set by activate (main window)
// or windowSurface (popout window) before any component renders.

import type { PluginApi } from '../../../src/plugins-ui/types';

let current: PluginApi | null = null;

export function setApi(api: PluginApi): void {
  current = api;
}

export function getApi(): PluginApi {
  if (!current) throw new Error('Lists plugin used before activation');
  return current;
}
