// The Lists plugin's own settings panel, mounted by the host on the plugin's
// card in the plugins page. Reuses the host's native controls so it reads as
// part of the app, not a bolted-on form.

import type { FC } from 'react';
import { ClipboardList } from 'lucide-react';
import { getApi } from './host';
import { useListsSettings, setTitleBarButton, openListsPanel } from './uiStore';

export const ListsSettings: FC = () => {
  const api = getApi();
  const { Tooltip } = api.components;
  const titleBarButton = useListsSettings((s) => s.titleBarButton);

  return (
    <div className="rounded-lg bg-white/[0.02] p-1">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <ClipboardList size={16} className="shrink-0 text-accent" />
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-textPrimary">Title bar button</div>
            <div className="text-[11px] text-textMuted">
              Show a Lists button in the title bar to open the panel with one click.
            </div>
          </div>
        </div>
        <Tooltip
          content={titleBarButton ? 'Hide from the title bar' : 'Show in the title bar'}
          delay={300}
        >
          <button
            type="button"
            role="switch"
            aria-checked={titleBarButton}
            onClick={() => setTitleBarButton(!titleBarButton)}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              titleBarButton ? 'bg-accent/80' : 'bg-white/10'
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                titleBarButton ? 'translate-x-[18px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </Tooltip>
      </div>

      {!titleBarButton && (
        <div className="px-3 pb-2.5 text-[11px] text-textMuted">
          You can still open Lists from the command palette, the{' '}
          <span className="text-textSecondary">Ctrl+Shift+L</span> shortcut, or{' '}
          <button
            type="button"
            onClick={() => openListsPanel()}
            className="text-accent hover:underline"
          >
            right here
          </button>
          .
        </div>
      )}
    </div>
  );
};

export default ListsSettings;
