import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { motion } from 'framer-motion';
import { MultiNookSlot } from '../../types';
import { useMultiNookPlayer } from './useMultiNookPlayer';
import { usemultiNookStore } from '../../stores/multiNookStore';
import StreamTitleWithEmojis from '../StreamTitleWithEmojis';
import { Tooltip } from '../ui/Tooltip';
import { GripHorizontal, Undo2 } from 'lucide-react';

interface MultiNookCellProps {
  slot: MultiNookSlot;
  cssOrder?: number;
  gridSpanClass?: string;
  customStyle?: React.CSSProperties;
}

export const MultiNookCell: React.FC<MultiNookCellProps> = ({ slot, cssOrder, gridSpanClass = '', customStyle = {} }) => {
  const { id, channelLogin, channelName, volume, muted, isFocused, streamUrl, isMinimized = false } = slot;
  const { toggleFocusSlot, dockSlot, removeSlot } = usemultiNookStore();
  
  const isLoading = !streamUrl;

  const { videoRef, isBuffering, error } = useMultiNookPlayer({
    streamUrl,
    streamId: id,
    volume,
    muted,
    isMinimized
  });

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useSortable({ id });

  // Map dnd-kit's drag offset cleanly to Framer Motion's coordinate space
  const x = transform ? Math.round(transform.x) : 0;
  const y = transform ? Math.round(transform.y) : 0;
  const scale = transform ? transform.scaleX : 1;

  const style: React.CSSProperties = {
    zIndex: isDragging ? 10 : 1,
    order: cssOrder,
  };

  const combinedStyle = { ...style, ...customStyle };

  return (
    <motion.div
      layout
      animate={{ x, y, scale }}
      transition={isDragging ? { duration: 0 } : { type: 'spring', stiffness: 350, damping: 30 }}
      ref={setNodeRef}
      style={combinedStyle}
      onClick={(e) => {
        // Only focus if the click wasn't on a button, tool, or plyr control slider
        const target = e.target as HTMLElement;
        if (!target.closest('button') && !target.closest('.plyr__controls')) {
          toggleFocusSlot(id);
        }
      }}
      className={`${gridSpanClass} relative w-full h-full rounded-lg overflow-hidden border border-white/5 ${
        isFocused ? 'shadow-[0_0_25px_var(--color-accent-muted)]' : ''
      } ${
        isDragging ? 'opacity-50 blur-sm' : 'opacity-100'
      } bg-black/40 transition-[box-shadow,opacity,filter] duration-300 group flex items-center justify-center video-player-container [&_.plyr]:w-full [&_.plyr]:h-full [&_.plyr]:absolute [&_.plyr]:inset-0 cursor-pointer`}
    >
      <video
        ref={videoRef}
        className="w-full h-full"
        style={{ backgroundColor: '#000', objectFit: 'cover' }}
        autoPlay
        playsInline
      />

      {/* Loading & Error States */}
      {(isLoading || isBuffering) && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm z-10 pointer-events-none">
          <i className="ri-loader-4-line text-4xl text-white animate-spin"></i>
        </div>
      )}
      
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-10 text-rose-500 pointer-events-none">
          <i className="ri-error-warning-fill text-4xl mb-2"></i>
          <p className="text-sm font-medium">{error}</p>
        </div>
      )}

      {/* Stream Title Overlay — Top-left (Matches VideoPlayer) */}
      <div
        className={`stream-title-overlay absolute top-0 left-0 right-0 z-40 transition-all duration-300 opacity-0 group-hover:opacity-100`}
      >
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/20 to-transparent pointer-events-none" />
        <div className="relative px-3 pt-2 pb-6 flex items-start justify-between">
          {/* Absolute Center Grab Handle */}
          <div className="absolute left-1/2 -translate-x-1/2 top-1.5 z-20">
            <Tooltip content="Drag to reposition stream" delay={500} side="top">
              <div 
                className="cursor-grab active:cursor-grabbing px-3 py-1 hover:bg-emerald-400/10 rounded-md transition-colors [&_*]:cursor-grab flex items-center justify-center text-emerald-400/50"
                {...attributes}
                {...listeners}
              >
                <GripHorizontal className="w-5 h-5 group-hover:text-emerald-400/80 transition-colors drop-shadow-md" />
              </div>
            </Tooltip>
          </div>

          {/* Left: Title */}
          <div className="flex-1 min-w-0 pr-12 z-10">
            <Tooltip content={channelName || channelLogin} delay={200} side="top">
              <h3 className="text-sm font-medium truncate drop-shadow-lg flex items-center gap-1.5 select-none text-white/90 mt-1">
                <StreamTitleWithEmojis title={channelName || channelLogin} />
                {isFocused && (
                  <Tooltip content="Focused Stream" delay={200} side="right">
                    <i className="ri-focus-3-line text-white/80 text-[12px] ml-1 shrink-0" />
                  </Tooltip>
                )}
              </h3>
            </Tooltip>
          </div>

          {/* Controls Overlay - Top Right */}
          <div className="flex items-center gap-2 shrink-0">
            <Tooltip content="Minimize Stream" delay={200} side="top">
              <button 
                onClick={() => dockSlot(id)}
                className="p-1 px-2 rounded bg-white/5 border border-white/10 backdrop-blur-md text-white/70 hover:bg-white/10 hover:text-white transition-colors flex items-center justify-center gap-1"
              >
                <i className="ri-subtract-line text-lg"></i>
                <span className="text-[10px] font-bold uppercase tracking-wider">Dock</span>
              </button>
            </Tooltip>
            <Tooltip content="Remove Stream" delay={200} side="top">
              <button 
                onClick={() => removeSlot(id)}
                className="p-1 px-2 rounded bg-white/5 border border-rose-500/20 backdrop-blur-md text-rose-400/70 hover:bg-rose-500/10 hover:border-rose-500/30 hover:text-rose-400 transition-colors flex items-center justify-center gap-1"
              >
                <Undo2 size={14} strokeWidth={2} className="mt-[1px]" />
                <span className="text-[10px] font-bold uppercase tracking-wider">Close</span>
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

