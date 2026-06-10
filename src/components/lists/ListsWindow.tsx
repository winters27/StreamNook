// ListsWindow: standalone OS-window shell for ListsSurface.
//
// Spawned by openListsWindow() and routed via the `#/lists` hash in main.tsx.
// Each Tauri window has its own JS context, so this shell hydrates what the
// surface needs on mount: settings (for the theme) and the cross-window list
// sync. The list data itself comes straight from localStorage, which every
// window shares.
//
// The titlebar carries a pin (always-on-top) so the roster can float over a
// game or another app while moderating, which is the whole point of popping
// the panel out of the main window.

import React, { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Pin, PinOff, X } from 'lucide-react';
import { Minus } from 'phosphor-react';
import { ListsSurface } from './ListsSurface';
import { startListSync } from '../../stores/listStore';
import { useAppStore } from '../../stores/AppStore';
import { listenForSettingsUpdates } from '../../utils/settingsBroadcast';
import { TooltipManager } from '../ui/TooltipManager';
import { Tooltip } from '../ui/Tooltip';
import { Logger } from '../../utils/logger';
import {
  applyTheme,
  applyGlassStrength,
  applyFont,
  getThemeById,
  getThemeByIdWithCustom,
  getOledTheme,
  DEFAULT_THEME_ID,
  DEFAULT_GLASS_TRANSPARENCY,
  DEFAULT_FONT_ID,
  OLED_THEME_ID,
} from '../../themes';
import streamNookLogoUrl from '../../assets/streamnook-logo.png';

export const ListsWindow: React.FC = () => {
  const settings = useAppStore((s) => s.settings);
  const [pinned, setPinned] = useState(false);

  // Hydrate settings (this window's AppStore boots empty) and keep them fresh
  // when any other window saves; subscribe to cross-window list updates.
  useEffect(() => {
    const store = useAppStore.getState();
    void store.loadSettings().catch((err) => {
      Logger.warn('[ListsWindow] loadSettings failed:', err);
    });

    let unlistenSettings: (() => void) | undefined;
    let unlistenLists: (() => void) | undefined;
    let cancelled = false;
    void listenForSettingsUpdates(() => {
      void useAppStore.getState().loadSettings();
    }).then((u) => {
      if (cancelled) {
        u();
        return;
      }
      unlistenSettings = u;
    });
    void startListSync().then((u) => {
      if (cancelled) {
        u?.();
        return;
      }
      unlistenLists = u;
    });
    return () => {
      cancelled = true;
      unlistenSettings?.();
      unlistenLists?.();
    };
  }, []);

  // Apply the user's theme so the popout matches the main app (same
  // resolution logic as App.tsx's theme effect).
  useEffect(() => {
    const themeId = settings.theme || DEFAULT_THEME_ID;
    const theme =
      themeId === OLED_THEME_ID
        ? getOledTheme(settings.oled_accent)
        : getThemeByIdWithCustom(themeId, settings.custom_themes || []) || getThemeById(DEFAULT_THEME_ID);
    if (theme) applyTheme(theme);
    applyGlassStrength(settings.glass_transparency ?? DEFAULT_GLASS_TRANSPARENCY);
    applyFont(settings.font ?? DEFAULT_FONT_ID);
  }, [settings.theme, settings.custom_themes, settings.glass_transparency, settings.font, settings.oled_accent]);

  const togglePin = async () => {
    try {
      await getCurrentWindow().setAlwaysOnTop(!pinned);
      setPinned(!pinned);
    } catch (err) {
      Logger.warn('[ListsWindow] setAlwaysOnTop failed:', err);
    }
  };

  const minimize = () => void getCurrentWindow().minimize();
  const close = () => void getCurrentWindow().close();

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-textPrimary">
      {/* Titlebar */}
      <div
        data-tauri-drag-region
        className="relative z-50 flex h-[33px] select-none items-center justify-between border-b border-borderSubtle bg-secondary px-3 shrink-0"
      >
        <div data-tauri-drag-region className="pointer-events-none flex items-center gap-2">
          <img src={streamNookLogoUrl} alt="StreamNook" className="h-4 w-4 object-contain" draggable={false} />
          <span className="text-xs font-semibold tracking-wide text-textSecondary">Lists</span>
        </div>
        <div className="flex space-x-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <Tooltip content={pinned ? 'Unpin from top' : 'Keep on top'} delay={200}>
            <button
              type="button"
              onClick={() => void togglePin()}
              data-tauri-drag-region="false"
              aria-pressed={pinned}
              className={`p-1.5 rounded transition-all duration-200 ${
                pinned ? 'text-accent' : 'text-textSecondary hover:text-textPrimary'
              }`}
            >
              {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          </Tooltip>
          <Tooltip content="Minimize" delay={200}>
            <button
              type="button"
              onClick={minimize}
              data-tauri-drag-region="false"
              className="p-1.5 text-textSecondary hover:text-textPrimary rounded transition-all duration-200"
            >
              <Minus size={14} />
            </button>
          </Tooltip>
          <Tooltip content="Close" delay={200}>
            <button
              type="button"
              onClick={close}
              data-tauri-drag-region="false"
              className="p-1.5 text-textSecondary hover:text-red-400 rounded transition-all duration-200"
            >
              <X size={14} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Surface fills the window; the OS handles resize from any edge. */}
      <div className="flex-1 min-h-0">
        <ListsSurface variant="window" />
      </div>

      <TooltipManager />
    </div>
  );
};

export default ListsWindow;
