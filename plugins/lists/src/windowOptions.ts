// Shared options for the popout Lists window, used by the panel's pop-out
// button (and anything else that opens the window).

import type { PluginWindowOptions } from '../../../src/plugins-ui/types';

export const LISTS_WINDOW: PluginWindowOptions = {
  surface: 'main',
  title: 'Lists',
  width: 360,
  height: 540,
  minWidth: 280,
  minHeight: 360,
};
