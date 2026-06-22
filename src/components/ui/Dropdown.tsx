import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export interface DropdownOption<T extends string | number> {
    value: T;
    label: string;
    icon?: React.ReactNode;
}

interface DropdownProps<T extends string | number> {
    value: T;
    options: DropdownOption<T>[];
    onChange: (value: T) => void;
    /** Optional prefix shown in the trigger, e.g. "Sort" renders "Sort: Newest". */
    triggerPrefix?: string;
    /** Optional icon shown at the left of the trigger button. */
    leadingIcon?: React.ReactNode;
    placeholder?: string;
    /** Extra classes for the trigger button (width, sizing, etc.). */
    className?: string;
    /** Align the menu to the left or right edge of the trigger. */
    align?: 'left' | 'right';
    disabled?: boolean;
    ariaLabel?: string;
}

/**
 * Fully theme-styled dropdown that replaces native <select>. The menu is
 * portalled to <body> and positioned with fixed coordinates so it is never
 * clipped by scrollable/overflow-hidden parents and never falls back to the
 * un-themable OS popup that a native <select> renders.
 */
export function Dropdown<T extends string | number>({
    value,
    options,
    onChange,
    triggerPrefix,
    leadingIcon,
    placeholder = 'Select…',
    className = '',
    align = 'left',
    disabled = false,
    ariaLabel,
}: DropdownProps<T>) {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});

    const selected = options.find(o => o.value === value);
    const selectedLabel = selected?.label ?? placeholder;

    const reposition = () => {
        const el = triggerRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const width = Math.max(r.width, 176);
        const rawLeft = align === 'right' ? r.right - width : r.left;
        const left = Math.max(8, Math.min(rawLeft, window.innerWidth - width - 8));
        setMenuStyle({
            position: 'fixed',
            top: Math.round(r.bottom + 6),
            left: Math.round(left),
            width: Math.round(width),
            zIndex: 9999,
        });
    };

    useLayoutEffect(() => {
        if (open) reposition();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node;
            if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        // Keep the portalled menu glued to its trigger as the page scrolls or the
        // window resizes, rather than closing it. A scroll inside the menu's own
        // option list is ignored so flicking through a long list never collapses it.
        const onResize = () => reposition();
        const onScroll = (e: Event) => {
            if (menuRef.current?.contains(e.target as Node)) return;
            reposition();
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', onResize);
        window.addEventListener('scroll', onScroll, true);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', onResize);
            window.removeEventListener('scroll', onScroll, true);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={ariaLabel}
                onClick={() => !disabled && setOpen(o => !o)}
                className={`flex items-center gap-2 rounded-lg bg-glass hover:bg-glass-hover border border-borderLight px-2.5 py-1.5 text-sm font-medium text-textPrimary transition-colors focus:outline-none focus:border-accent/60 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
            >
                {leadingIcon && (
                    <span className="shrink-0 flex items-center text-accent">{leadingIcon}</span>
                )}
                <span className="flex-1 truncate text-left">
                    {triggerPrefix ? `${triggerPrefix}: ${selectedLabel}` : selectedLabel}
                </span>
                <ChevronDown
                    size={14}
                    className={`text-textSecondary shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                />
            </button>
            {createPortal(
                <AnimatePresence>
                    {open && (
                    <motion.div
                        ref={menuRef}
                        role="listbox"
                        style={menuStyle}
                        initial={{ opacity: 0, y: -4, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -4, scale: 0.97 }}
                        transition={{ duration: 0.14, ease: 'easeOut' }}
                        className="glass-panel border border-borderLight rounded-lg p-1 shadow-xl max-h-72 overflow-y-auto custom-scrollbar"
                    >
                        {options.map(opt => {
                            const active = opt.value === value;
                            return (
                                <button
                                    key={String(opt.value)}
                                    type="button"
                                    role="option"
                                    aria-selected={active}
                                    onClick={() => {
                                        onChange(opt.value);
                                        setOpen(false);
                                    }}
                                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-sm text-left transition-colors ${active ? 'bg-accent/20 text-accent' : 'text-textPrimary hover:bg-glass-hover'}`}
                                >
                                    <span className="flex items-center gap-2 min-w-0">
                                        {opt.icon && <span className="shrink-0 flex items-center">{opt.icon}</span>}
                                        <span className="truncate">{opt.label}</span>
                                    </span>
                                    {active && <Check size={14} className="shrink-0" />}
                                </button>
                            );
                        })}
                    </motion.div>
                    )}
                </AnimatePresence>,
                document.body,
            )}
        </>
    );
}
