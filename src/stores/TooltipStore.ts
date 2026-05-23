import { create } from 'zustand';
import React from 'react';

export interface TooltipState {
  isVisible: boolean;
  content: React.ReactNode | string | null;
  rect: DOMRect | null;
  side: 'top' | 'bottom' | 'left' | 'right';
  // Optional className override for the tooltip container. When set, replaces
  // the default chrome (rounded-md / bg-black/80 / border) entirely. Used by
  // StreamNookBadge to render the badge popover as a per-tier pill.
  containerClassName: string | null;
  showTooltip: (id: string, content: React.ReactNode | string, rect: DOMRect, side?: 'top' | 'bottom' | 'left' | 'right', containerClassName?: string) => void;
  hideTooltip: (id?: string) => void;
  // A unique ID or ref to track which element triggered the tooltip
  triggerId: string | null;
}

export const useTooltipStore = create<TooltipState>((set) => ({
  isVisible: false,
  content: null,
  rect: null,
  side: 'top',
  containerClassName: null,
  triggerId: null,
  showTooltip: (id, content, rect, side = 'top', containerClassName) => set({
    isVisible: true,
    content,
    rect,
    side,
    containerClassName: containerClassName ?? null,
    triggerId: id
  }),
  hideTooltip: (id?: string) => set((state) => {
    // If an ID is provided, only hide if it matches the currently active triggerId.
    if (id && state.triggerId !== id) {
      return state;
    }
    return { isVisible: false };
    // We intentionally don't clear content/rect immediately to allow the exit animation to render properly
  }),
}));
