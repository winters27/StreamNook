// Focused settings surface for the MultiChat title-bar gear icon.
//
// Mounts only the ChatSettings panel — highlight phrases, custom commands,
// per-user nicknames, color overrides, design — without the player, theme,
// drops, integrations, or any other top-level settings tabs. MultiChat windows
// don't host a video player or drops miner, so those settings would be noise.

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import ChatSettings from '../settings/ChatSettings';

interface ChatOnlySettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export default function ChatOnlySettingsModal({ open, onClose }: ChatOnlySettingsModalProps) {
  // Esc to close — only attach the listener while the modal is open so it
  // doesn't compete with other Esc consumers (mod menu, emote picker, etc.)
  // when the modal is closed.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-16 pb-8 px-4 bg-black/60 backdrop-blur-md"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Chat Settings"
    >
      <div
        className="relative flex w-full max-w-2xl max-h-[calc(100vh-8rem)] flex-col overflow-hidden rounded-xl border border-borderSubtle bg-background shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-borderSubtle">
          <h2 className="text-sm font-semibold text-textPrimary">Chat Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 text-textSecondary hover:text-textPrimary rounded transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4">
          <ChatSettings />
        </div>
      </div>
    </div>,
    document.body,
  );
}
