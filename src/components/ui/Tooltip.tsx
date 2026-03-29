import React, { useRef, useEffect, useId } from "react";
import { useTooltipStore } from "../../stores/TooltipStore";

export interface TooltipProps {
  content: React.ReactNode | string;
  side?: "top" | "bottom" | "left" | "right";
  delay?: number;
  children: React.ReactElement;
  disabled?: boolean;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  side = "top",
  delay = 250,
  children,
  disabled = false,
}) => {
  const showTooltip = useTooltipStore(state => state.showTooltip);
  const hideTooltip = useTooltipStore(state => state.hideTooltip);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const tooltipId = useId();

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      hideTooltip(tooltipId);
    };
  }, [hideTooltip, tooltipId]);

  useEffect(() => {
    if (disabled || !content) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      hideTooltip(tooltipId);
    }
  }, [disabled, content, hideTooltip, tooltipId]);

  if (disabled || !content) {
    return children;
  }

  const handleMouseEnter = (e: React.MouseEvent) => {
    // Call original handler if exists
    if (children.props.onMouseEnter) {
      children.props.onMouseEnter(e);
    }
    
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    
    // Store reference to element synchronously because e.currentTarget becomes null after event bubbling
    const targetElement = e.currentTarget as HTMLElement;
    
    timeoutRef.current = setTimeout(() => {
      const rect = targetElement.getBoundingClientRect();
      showTooltip(tooltipId, content, rect, side);
      // It's okay, if we hover over something else, the store overrides it.
    }, delay);
  };

  const handleMouseLeave = (e: React.MouseEvent) => {
    if (children.props.onMouseLeave) {
      children.props.onMouseLeave(e);
    }
    
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    hideTooltip(tooltipId);
  };

  const handleFocus = (e: React.FocusEvent) => {
    if (children.props.onFocus) {
      children.props.onFocus(e);
    }
    const targetElement = e.currentTarget as HTMLElement;
    const rect = targetElement.getBoundingClientRect();
    showTooltip(tooltipId, content, rect, side);
  };

  const handleBlur = (e: React.FocusEvent) => {
    if (children.props.onBlur) {
      children.props.onBlur(e);
    }
    hideTooltip(tooltipId);
  };

  return React.cloneElement(children, {
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
    // Add aria-label if children don't have one and content is string
    ...(typeof content === 'string' && !children.props['aria-label'] && { 'aria-label': content }),
    // Remove title attribute to prevent native tooltip
    title: undefined,
  });
};
