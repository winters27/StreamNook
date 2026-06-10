// ListsPanel: the in-app floating chrome around ListsSurface.
//
// A non-modal corner panel (the stream and chat stay fully interactive) that
// the user can drag anywhere by its header and resize from the bottom-right
// corner. The "pop out" control hands the surface off to its own OS window
// (ListsWindow) for placement outside the app entirely.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useDragControls, useMotionValue } from 'framer-motion';
import { PictureInPicture2, X } from 'lucide-react';
import { useAppStore } from '../stores/AppStore';
import { ListsSurface } from './lists/ListsSurface';
import { openListsWindow } from '../utils/listsWindow';
import { Tooltip } from './ui/Tooltip';

const EDGE_MARGIN = 8;
const DEFAULT_W = 320;
const DEFAULT_H = 460;
const MIN_W = 280;
const MIN_H = 380;
const MAX_W = 560;
const MAX_H = 760;

interface DragBounds {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export const ListsPanel: React.FC = () => {
  const setShowListsPanel = useAppStore((s) => s.setShowListsPanel);
  const initialListId = useAppStore((s) => s.listsPanelInitialListId);

  const panelRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();
  // Track the drag offset ourselves so the layout box (rect minus offset) can
  // be recovered when recomputing bounds after a resize.
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  // Anchor top-left, starting in the bottom-left corner: a top anchor makes
  // resizing grow downward, which is what a bottom-right grip implies.
  const [initialTop] = useState(() =>
    Math.max(EDGE_MARGIN, window.innerHeight - DEFAULT_H - 16),
  );
  const [dragBounds, setDragBounds] = useState<DragBounds | undefined>();

  // Constrain dragging to the window. The entrance is opacity-only, so the
  // rect is the true layout box from the first frame; re-measured whenever the
  // panel is resized.
  const measureBounds = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const layoutLeft = r.left - x.get();
    const layoutTop = r.top - y.get();
    setDragBounds({
      left: -(layoutLeft - EDGE_MARGIN),
      top: -(layoutTop - EDGE_MARGIN),
      right: window.innerWidth - EDGE_MARGIN - (layoutLeft + r.width),
      bottom: window.innerHeight - EDGE_MARGIN - (layoutTop + r.height),
    });
  }, [x, y]);

  useEffect(() => {
    measureBounds();
  }, [measureBounds, size.w, size.h]);

  // ---- corner resize -------------------------------------------------------

  const resizeState = useRef<{ px: number; py: number; w: number; h: number } | null>(null);

  const onResizePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizeState.current = { px: e.clientX, py: e.clientY, w: size.w, h: size.h };
  };

  const onResizePointerMove = (e: React.PointerEvent) => {
    const s = resizeState.current;
    if (!s) return;
    const rect = panelRef.current?.getBoundingClientRect();
    const maxW = rect ? Math.min(MAX_W, window.innerWidth - rect.left - EDGE_MARGIN) : MAX_W;
    const maxH = rect ? Math.min(MAX_H, window.innerHeight - rect.top - EDGE_MARGIN) : MAX_H;
    setSize({
      w: Math.min(Math.max(MIN_W, s.w + e.clientX - s.px), maxW),
      h: Math.min(Math.max(MIN_H, s.h + e.clientY - s.py), maxH),
    });
  };

  const onResizePointerUp = () => {
    resizeState.current = null;
  };

  const startHeaderDrag = (e: React.PointerEvent) => {
    // Only blank header space drags; buttons and inputs keep their clicks.
    if ((e.target as HTMLElement).closest('button, input')) return;
    dragControls.start(e);
  };

  const popOut = () => {
    void openListsWindow();
    setShowListsPanel(false);
  };

  return (
    <motion.div
      ref={panelRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      drag
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      dragElastic={0}
      dragConstraints={dragBounds}
      style={{ x, y, left: 16, top: initialTop, width: size.w, height: size.h }}
      className="fixed z-40 glass-panel flex flex-col overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,0.45)] bg-surface/60 !backdrop-blur-2xl"
    >
      <ListsSurface
        variant="floating"
        initialListId={initialListId}
        onHeaderPointerDown={startHeaderDrag}
        trailing={
          <span className="flex items-center gap-0.5 shrink-0">
            <Tooltip content="Pop out into its own window" delay={300}>
              <button
                onClick={popOut}
                className="p-1 text-textSecondary hover:text-textPrimary rounded transition-colors"
              >
                <PictureInPicture2 size={14} />
              </button>
            </Tooltip>
            <Tooltip content="Close" delay={300}>
              <button
                onClick={() => setShowListsPanel(false)}
                className="p-1 text-textSecondary hover:text-textPrimary rounded transition-colors"
              >
                <X size={14} />
              </button>
            </Tooltip>
          </span>
        }
      />

      {/* Resize grip */}
      <div
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize flex items-end justify-end p-1"
      >
        <span className="w-2 h-2 border-r-2 border-b-2 border-textMuted/40 rounded-br-sm" />
      </div>
    </motion.div>
  );
};

export default ListsPanel;
