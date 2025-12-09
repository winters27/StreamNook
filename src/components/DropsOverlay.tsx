import { X, Gift } from 'lucide-react';
import { useAppStore } from '../stores/AppStore';
import DropsCenter from './DropsCenter';

export default function DropsOverlay() {
  const { showDropsOverlay, setShowDropsOverlay } = useAppStore();

  if (!showDropsOverlay) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm group">
      {/* Hover-sensitive background overlay */}
      <div
        className="absolute inset-0 group-hover:pointer-events-none"
        onClick={() => setShowDropsOverlay(false)}
      />

      <div className="w-[95vw] max-w-[1800px] h-[90vh] bg-background rounded-xl shadow-2xl border border-borderLight flex flex-col overflow-hidden relative z-10 animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-borderLight bg-backgroundSecondary">
          <h2 className="text-lg font-semibold text-textPrimary flex items-center gap-2">
            <Gift size={20} className="text-accent" />
            Drops & Channel Points
          </h2>
          <button
            onClick={() => setShowDropsOverlay(false)}
            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          <DropsCenter />
        </div>
      </div>
    </div>
  );
}
