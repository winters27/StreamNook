import React, { useEffect, useRef } from 'react';
import { useContextMenuStore } from '../stores/contextMenuStore';
import { useAppStore } from '../stores/AppStore';
import { usemultiNookStore } from '../stores/multiNookStore';
import { LayoutGrid, Heart, UserPlus, UserMinus, Loader2, Scissors, Copy, ClipboardPaste, Type } from 'lucide-react';
import { Logger } from '../utils/logger';
import { invoke } from '@tauri-apps/api/core';

export const StreamContextMenu: React.FC = () => {
    const { isOpen, x, y, stream, inputElement, selectionText, menuType, isFollowing, isCheckingFollow, closeMenu, toggleFollow } = useContextMenuStore();
    const { toggleFavoriteStreamer, isFavoriteStreamer } = useAppStore();
    const { addSlot, slots } = usemultiNookStore();
    
    const menuRef = useRef<HTMLDivElement>(null);

    // Close on escape key
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeMenu();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, closeMenu]);

    // Handle collision detection / positioning
    // 200px approx width, 140px approx height
    const MENU_WIDTH = 200; 
    const MENU_HEIGHT = 140;
    
    let safeX = x;
    let safeY = y;
    
    if (typeof window !== 'undefined') {
        if (x + MENU_WIDTH > window.innerWidth) {
            safeX = x - MENU_WIDTH;
        }
        if (y + MENU_HEIGHT > window.innerHeight) {
            safeY = y - MENU_HEIGHT;
        }
        // Boundaries checks just in case
        safeX = Math.max(0, safeX);
        safeY = Math.max(0, safeY);
    }

    if (!isOpen) return null;

    if (menuType === 'input' && inputElement) {
        const handleCut = (e: React.MouseEvent) => {
            e.stopPropagation();
            inputElement.focus();
            document.execCommand('cut');
            closeMenu();
        };

        const handleCopy = (e: React.MouseEvent) => {
            e.stopPropagation();
            inputElement.focus();
            document.execCommand('copy');
            closeMenu();
        };

        const handlePaste = async (e: React.MouseEvent) => {
            e.stopPropagation();
            try {
                // Bypass Tauri frontend capabilities and call Rust backend directly
                const text = await invoke<string>('read_clipboard_text_native');
                if (!text) {
                    closeMenu();
                    return;
                }

                inputElement.focus();

                if (inputElement instanceof HTMLInputElement || inputElement instanceof HTMLTextAreaElement) {
                    const start = inputElement.selectionStart || 0;
                    const end = inputElement.selectionEnd || 0;
                    const proto = Object.getPrototypeOf(inputElement);
                    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                    
                    if (setter) {
                        const currentVal = inputElement.value;
                        const newVal = currentVal.substring(0, start) + text + currentVal.substring(end);
                        
                        setter.call(inputElement, newVal);
                        inputElement.dispatchEvent(new Event('input', { bubbles: true }));
                        
                        inputElement.setSelectionRange(start + text.length, start + text.length);
                    } else {
                        document.execCommand('insertText', false, text);
                    }
                } else {
                    document.execCommand('insertText', false, text);
                }
            } catch (err) {
                Logger.error("Failed to paste", err);
            }
            closeMenu();
        };

        const handleSelectAll = (e: React.MouseEvent) => {
            e.stopPropagation();
            inputElement.focus();
            document.execCommand('selectAll');
            closeMenu();
        };

        return (
            <div 
                className="fixed inset-0 z-[100] cursor-default"
                onPointerDown={(e) => {
                    e.stopPropagation();
                    closeMenu();
                }}
                onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    closeMenu();
                }}
            >
                <div
                    ref={menuRef}
                    className="absolute w-44 glass-panel rounded-xl flex flex-col p-1 shadow-2xl origin-top-left animate-in fade-in zoom-in-95 duration-150"
                    style={{ top: safeY, left: safeX }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                    }}
                >
                    <button onClick={handleCut} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-textSecondary hover:text-white hover:bg-glass-hover transition-all">
                        <Scissors size={16} />
                        <span>Cut</span>
                    </button>
                    <button onClick={handleCopy} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-textSecondary hover:text-white hover:bg-glass-hover transition-all">
                        <Copy size={16} />
                        <span>Copy</span>
                    </button>
                    <button onClick={handlePaste} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-textSecondary hover:text-white hover:bg-glass-hover transition-all">
                        <ClipboardPaste size={16} />
                        <span>Paste</span>
                    </button>
                    <div className="h-px bg-borderSubtle my-1 mx-2" />
                    <button onClick={handleSelectAll} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-textSecondary hover:text-white hover:bg-glass-hover transition-all">
                        <Type size={16} />
                        <span>Select All</span>
                    </button>
                </div>
            </div>
        );
    }

    if (menuType === 'selection') {
        const handleCopy = async (e: React.MouseEvent) => {
            e.stopPropagation();
            if (selectionText) {
                try {
                    await navigator.clipboard.writeText(selectionText);
                } catch (err) {
                    Logger.error("Failed to copy", err);
                }
            }
            closeMenu();
        };

        return (
            <div 
                className="fixed inset-0 z-[100] cursor-default"
                onPointerDown={(e) => {
                    e.stopPropagation();
                    closeMenu();
                }}
                onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    closeMenu();
                }}
            >
                <div
                    ref={menuRef}
                    className="absolute w-44 glass-panel rounded-xl flex flex-col p-1 shadow-2xl origin-top-left animate-in fade-in zoom-in-95 duration-150"
                    style={{ top: safeY, left: safeX }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                    }}
                >
                    <button onClick={handleCopy} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-textSecondary hover:text-white hover:bg-glass-hover transition-all">
                        <Copy size={16} />
                        <span>Copy</span>
                    </button>
                </div>
            </div>
        );
    }

    if (!stream || menuType !== 'stream') return null;

    const isFavorite = isFavoriteStreamer(stream.user_id);
    const hasRoomForMultiNook = slots.length < 25;

    const handleFavorite = (e: React.MouseEvent) => {
        e.stopPropagation();
        toggleFavoriteStreamer(stream.user_id);
        closeMenu();
    };

    const handleMultiNook = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!hasRoomForMultiNook) return;
        
        // Trigger flying animation from context menu click position
        usemultiNookStore.getState().triggerAddAnimation(safeX, safeY, stream.user_login);
        addSlot(stream.user_login);
        
        closeMenu();
    };

    const handleFollow = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isCheckingFollow) return;
        toggleFollow();
    };

    return (
        // Backdrop overlay to capture clicks outside
        <div 
            className="fixed inset-0 z-[100] cursor-default"
            onPointerDown={(e) => {
                e.stopPropagation();
                closeMenu();
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                closeMenu();
            }}
        >
            {/* Global SVG Definitions for Liquid Glass Heart (Local Fallback) */}
            <svg width="0" height="0" className="absolute pointer-events-none">
                <defs>
                    <linearGradient id="glass-heart-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(255, 255, 255, 0.4)" />
                        <stop offset="30%" stopColor="rgba(236, 72, 153, 0.2)" />
                        <stop offset="100%" stopColor="rgba(236, 72, 153, 0.6)" />
                    </linearGradient>
                    <linearGradient id="glass-heart-stroke" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(255, 255, 255, 0.8)" />
                        <stop offset="100%" stopColor="rgba(255, 255, 255, 0.1)" />
                    </linearGradient>
                </defs>
            </svg>

            <div
                ref={menuRef}
                className="absolute w-48 glass-panel rounded-xl flex flex-col p-1 shadow-2xl origin-top-left animate-in fade-in zoom-in-95 duration-150"
                style={{ top: safeY, left: safeX }}
                onPointerDown={(e) => e.stopPropagation()} // Prevent closing when interacting with menu
                onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                }}
            >
                {/* Header (Stream name for context) */}
                <div className="px-3 py-2 border-b border-borderSubtle mb-1">
                    <span className="text-xs font-semibold text-textPrimary truncate block">
                        {stream.user_name}
                    </span>
                    <span className="text-[10px] text-textMuted uppercase tracking-wider block">
                        Options
                    </span>
                </div>

                {/* Add to MultiNook */}
                <button
                    onClick={handleMultiNook}
                    disabled={!hasRoomForMultiNook}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                        hasRoomForMultiNook 
                            ? 'text-textSecondary hover:text-white hover:bg-glass-hover' 
                            : 'text-textMuted opacity-50 cursor-not-allowed'
                    }`}
                >
                    <LayoutGrid size={16} />
                    <span>Add to MultiNook</span>
                </button>

                {/* Favorite */}
                <button
                    onClick={handleFavorite}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-textSecondary hover:text-pink-400 hover:bg-glass-hover transition-all"
                >
                    <Heart 
                        size={16} 
                        fill={isFavorite ? 'url(#glass-heart-fill)' : 'none'} 
                        stroke={isFavorite ? 'url(#glass-heart-stroke)' : 'currentColor'}
                        strokeWidth={isFavorite ? 1.5 : 2}
                        className={isFavorite ? 'drop-shadow-[0_4px_8px_rgba(236,72,153,0.5)]' : ''} 
                    />
                    <span>{isFavorite ? 'Unfavorite' : 'Favorite'}</span>
                </button>

                {/* Follow / Unfollow */}
                <button
                    onClick={handleFollow}
                    disabled={isCheckingFollow || isFollowing === null}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-textSecondary hover:text-purple-400 hover:bg-glass-hover transition-all"
                >
                    {isCheckingFollow ? (
                        <>
                            <Loader2 size={16} className="animate-spin text-textMuted" />
                            <span className="text-textMuted">Checking...</span>
                        </>
                    ) : isFollowing ? (
                        <>
                            <UserMinus size={16} className="text-red-400" />
                            <span className="text-red-400">Unfollow</span>
                        </>
                    ) : (
                        <>
                            <UserPlus size={16} className="text-green-400" />
                            <span className="text-green-400">Follow</span>
                        </>
                    )}
                </button>
            </div>
        </div>
    );
};

