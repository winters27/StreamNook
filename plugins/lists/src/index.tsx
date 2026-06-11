// Lists plugin entry. Registers every surface through the host api:
// the title bar button, the floating panel overlay, the Moderator Logs dock
// column, the Ctrl+Shift+L command, the palette rows, and the popout window
// surface. List data lives in localStorage under the same keys the feature
// has always used, so lists created before the plugin carry over.

import { AnimatePresence } from 'framer-motion';
import { ClipboardList } from 'lucide-react';
import type { FC } from 'react';
import type { PluginApi } from '../../../src/plugins-ui/types';
import { setApi } from './host';
import { startListSync, useListStore } from './listStore';
import { ListsSurface } from './ListsSurface';
import { ListsPanel } from './ListsPanel';
import { useListsUi, openListsPanel, toggleListsPanel } from './uiStore';

const ListsOverlay: FC = () => {
  const open = useListsUi((s) => s.panelOpen);
  return <AnimatePresence>{open && <ListsPanel />}</AnimatePresence>;
};

const DockedLists: FC = () => <ListsSurface variant="docked" />;

const WindowContent: FC = () => (
  <div className="h-full min-h-0">
    <ListsSurface variant="window" />
  </div>
);

/** One-time migration of the pre-plugin Moderator Logs dock preference key
 *  to the generic slot key the pane persists per contribution. */
function migrateDockPreference(): void {
  try {
    const legacy = localStorage.getItem('streamnook.modlogs.lists');
    if (legacy !== null && localStorage.getItem('streamnook.modlogs.dock.lists') === null) {
      localStorage.setItem('streamnook.modlogs.dock.lists', legacy);
    }
  } catch {
    // preference migration is best-effort
  }
}

export function activate(api: PluginApi): void {
  setApi(api);
  migrateDockPreference();
  void startListSync();

  api.ui.registerTitleBarButton({
    id: 'lists',
    tooltip: 'Lists',
    Icon: ClipboardList,
    onClick: toggleListsPanel,
    useIsActive: () => useListsUi((s) => s.panelOpen),
  });

  api.ui.registerOverlay({ id: 'lists-panel', Component: ListsOverlay });

  api.ui.registerSlot('modlogs.dock', {
    id: 'lists',
    label: 'lists',
    Icon: ClipboardList,
    Component: DockedLists,
  });

  // Historical command id, so user rebinds from when Lists was built in
  // keep working.
  api.commands.registerKeybinding({
    id: 'qa.openLists',
    label: 'Toggle Lists panel',
    description: 'Floating panel of your reference lists: usernames, commands, titles.',
    category: 'Navigation',
    defaultBindings: ['Ctrl+Shift+L'],
    keywords: 'lists notes reference ban evaders commands copy paste',
    run: toggleListsPanel,
  });

  api.commands.registerPaletteItems(() => [
    {
      id: 'qa.openLists',
      title: 'Open Lists',
      subtitle: 'Your reference lists: usernames, commands, titles',
      keywords: 'lists list notes reference ban evaders snipers commands copy paste',
      run: () => openListsPanel(),
    },
    ...useListStore.getState().lists.map((list) => ({
      id: `list.${list.id}`,
      title: `Open list: ${list.name}`,
      subtitle: `Lists · ${list.entries.length} ${list.entries.length === 1 ? 'entry' : 'entries'}`,
      keywords: `list lists open ${list.name.toLowerCase()}`,
      initial: list.name.slice(0, 1).toUpperCase(),
      run: () => openListsPanel(list.id),
    })),
  ]);
}

export function windowSurface(surface: string, api: PluginApi): FC | null {
  if (surface !== 'main') return null;
  setApi(api);
  void startListSync();
  return WindowContent;
}
