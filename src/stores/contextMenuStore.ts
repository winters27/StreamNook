import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { TwitchStream } from '../types';
import { useAppStore } from './AppStore';
import { Logger } from '../utils/logger';

interface ContextMenuState {
    isOpen: boolean;
    x: number;
    y: number;
    stream: TwitchStream | null;
    inputElement: HTMLElement | null;
    selectionText: string | null;
    menuType: 'stream' | 'input' | 'selection' | null;
    isFollowing: boolean | null; // null means loading/unknown
    isCheckingFollow: boolean;
    
    // Actions
    openMenu: (e: React.MouseEvent | MouseEvent, stream: TwitchStream) => void;
    openInputMenu: (e: React.MouseEvent | MouseEvent, element: HTMLElement) => void;
    openSelectionMenu: (e: React.MouseEvent | MouseEvent) => void;
    closeMenu: () => void;
    toggleFollow: () => Promise<void>;
}

export const useContextMenuStore = create<ContextMenuState>((set, get) => ({
    isOpen: false,
    x: 0,
    y: 0,
    stream: null,
    inputElement: null,
    selectionText: null,
    menuType: null,
    isFollowing: null,
    isCheckingFollow: false,

    openMenu: async (e: React.MouseEvent | MouseEvent, stream: TwitchStream) => {
        // Prevent default window context menu and bubbling
        e.preventDefault();
        e.stopPropagation();

        const x = e.clientX;
        const y = e.clientY;

        // Immediately open the menu with the stream context
        set({ 
            isOpen: true, 
            x, 
            y, 
            menuType: 'stream',
            stream, 
            inputElement: null,
            selectionText: null,
            isFollowing: null, 
            isCheckingFollow: true 
        });

        // Optimization: If the stream is already in our followedStreams cache,
        // we instantly know they are followed. No need to hit the API payload.
        const appStore = useAppStore.getState();
        const isAlreadyFollowed = appStore.followedStreams.some(s => s.user_id === stream.user_id);

        if (isAlreadyFollowed) {
            set({ isFollowing: true, isCheckingFollow: false });
            return;
        }

        // Otherwise, verify against the API (e.g. for streams from Discover or Search)
        try {
            const isFollowingApi = await invoke<boolean>('check_following_status', { targetUserId: stream.user_id });
            set({ isFollowing: isFollowingApi, isCheckingFollow: false });
        } catch (error) {
            Logger.warn('[ContextMenu] Failed to check follow status:', error);
            // Default to null / false on error
            set({ isFollowing: false, isCheckingFollow: false });
        }
    },

    openInputMenu: (e: React.MouseEvent | MouseEvent, element: HTMLElement) => {
        e.preventDefault();
        e.stopPropagation();

        const x = e.clientX;
        const y = e.clientY;

        element.focus();

        set({
            isOpen: true,
            x,
            y,
            menuType: 'input',
            stream: null,
            inputElement: element,
            selectionText: null,
            isFollowing: null,
            isCheckingFollow: false
        });
    },

    openSelectionMenu: (e: React.MouseEvent | MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const x = e.clientX;
        const y = e.clientY;
        const selectionText = window.getSelection()?.toString() || '';

        set({
            isOpen: true,
            x,
            y,
            menuType: 'selection',
            stream: null,
            inputElement: null,
            selectionText: selectionText || null,
            isFollowing: null,
            isCheckingFollow: false
        });
    },

    closeMenu: () => {
        set({ isOpen: false, stream: null, inputElement: null, selectionText: null, menuType: null });
    },

    toggleFollow: async () => {
        const { stream, isFollowing } = get();
        if (!stream || isFollowing === null) return;

        // Optimistic UI update
        const newFollowingState = !isFollowing;
        set({ isFollowing: newFollowingState });

        try {
            if (newFollowingState) {
                await invoke('follow_channel', { targetUserId: stream.user_id });
                Logger.info(`[ContextMenu] Followed channel: ${stream.user_name}`);
            } else {
                await invoke('unfollow_channel', { targetUserId: stream.user_id });
                Logger.info(`[ContextMenu] Unfollowed channel: ${stream.user_name}`);
            }
            
            // Refresh the followed list if needed
            useAppStore.getState().loadFollowedStreams();
            
        } catch (error) {
            Logger.error('[ContextMenu] Failed to toggle follow:', error);
            // Revert optimistic update on failure
            set({ isFollowing: !newFollowingState });
        }
        
        // Close menu after action
        get().closeMenu();
    }
}));
