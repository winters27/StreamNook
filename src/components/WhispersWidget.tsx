import { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { X, MessageCircle, Send, Search, Plus, ArrowLeft, Loader2, Users, Upload, ChevronDown, Smile, SortAsc, User, Trash2, Clock, Download, Sparkles } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { getAppleEmojiUrl } from '../services/emojiService';
import WhisperImportWizard from './WhisperImportWizard';
import type { WhisperConversation, Whisper, UserInfo } from '../types';

interface WhisperFromBackend {
    from_user_id: string;
    from_user_login: string;
    from_user_name: string;
    to_user_id: string;
    to_user_login: string;
    to_user_name: string;
    whisper_id: string;
    text: string;
}

interface WhispersWidgetProps {
    isOpen: boolean;
    onClose: () => void;
}

type SortOption = 'recent' | 'name' | 'unread';

const WHISPERS_STORAGE_KEY = 'streamnook-whisper-conversations';

// Parse various date formats from imported whispers
const parseWhisperDate = (dateStr: string): number => {
    if (!dateStr) return Date.now();

    // Try standard Date parsing first
    let timestamp = new Date(dateStr).getTime();
    if (!isNaN(timestamp)) return timestamp;

    // Try parsing locale format like "5/31/2021, 8:30:39 PM PDT"
    // Remove timezone abbreviation and try again
    const withoutTz = dateStr.replace(/\s+[A-Z]{2,4}$/, '');
    timestamp = new Date(withoutTz).getTime();
    if (!isNaN(timestamp)) return timestamp;

    // Fallback: try to extract date components manually
    const match = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2}):?(\d{2})?\s*(AM|PM)?/i);
    if (match) {
        let [, month, day, year, hours, minutes, seconds, ampm] = match;
        let h = parseInt(hours);
        if (ampm) {
            if (ampm.toUpperCase() === 'PM' && h < 12) h += 12;
            if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;
        }
        return new Date(parseInt(year), parseInt(month) - 1, parseInt(day), h, parseInt(minutes), parseInt(seconds || '0')).getTime();
    }

    return Date.now();
};

// Emoji categories for the picker
const emojiCategories: Record<string, string[]> = {
    'Smileys': ['😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐'],
    'Gestures': ['👍', '👎', '👊', '✊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👋', '🤚', '🖐️', '✋', '🖖', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁️', '👅', '👄'],
    'Hearts': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️', '💌', '💋'],
    'Animals': ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🦟', '🦗', '🕷️', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊'],
    'Food': ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗'],
    'Activities': ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '🤺', '⛹️', '🤾', '🏌️', '🏇', '🧘', '🏄', '🏊', '🤽', '🚣', '🧗', '🚵', '🚴', '🏆', '🥇', '🥈', '🥉'],
    'Objects': ['⌚', '📱', '💻', '⌨️', '🖥️', '💡', '🔦', '💎', '🔮', '🎮', '🎯', '🎨', '🎭', '🎪', '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎸', '🪕', '🎻', '🎬', '🏹'],
    'Symbols': ['❤️', '💯', '✨', '⭐', '🔥', '💥', '✅', '❌', '➕', '➖', '✖️', '➡️', '⬅️', '⬆️', '⬇️', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🟤']
};

// Helper to serialize Map to localStorage
const saveConversationsToStorage = (conversations: Map<string, WhisperConversation>) => {
    try {
        const data = Array.from(conversations.entries());
        localStorage.setItem(WHISPERS_STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
        console.warn('[Whispers] Failed to save to localStorage:', error);
    }
};

// Helper to load Map from localStorage with deduplication
const loadConversationsFromStorage = (): Map<string, WhisperConversation> => {
    try {
        const data = localStorage.getItem(WHISPERS_STORAGE_KEY);
        if (data) {
            const entries = JSON.parse(data) as [string, WhisperConversation][];
            // Deduplicate messages in each conversation
            const deduplicatedEntries = entries.map(([userId, conv]) => {
                const seenIds = new Set<string>();
                const uniqueMessages = conv.messages.filter(msg => {
                    if (seenIds.has(msg.id)) {
                        return false;
                    }
                    seenIds.add(msg.id);
                    return true;
                });
                return [userId, { ...conv, messages: uniqueMessages }] as [string, WhisperConversation];
            });
            return new Map(deduplicatedEntries);
        }
    } catch (error) {
        console.warn('[Whispers] Failed to load from localStorage:', error);
    }
    return new Map();
};

const WhispersWidget = ({ isOpen, onClose }: WhispersWidgetProps) => {
    const [conversations, setConversations] = useState<Map<string, WhisperConversation>>(() => loadConversationsFromStorage());
    const [activeConversation, setActiveConversation] = useState<string | null>(null);
    const { whisperTargetUser, clearWhisperTargetUser } = useAppStore();
    const previousActiveConversationRef = useRef<string | null>(null);
    const [message, setMessage] = useState('');
    const [isSending, setIsSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    const [searchResults, setSearchResults] = useState<UserInfo[]>([]);
    const [showNewConversation, setShowNewConversation] = useState(false);
    const [isImportingAll, setIsImportingAll] = useState(false);
    const [importProgress, setImportProgress] = useState<string>('');
    const [sortOption, setSortOption] = useState<SortOption>('recent');
    const [showSortMenu, setShowSortMenu] = useState(false);
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [emojiSearchQuery, setEmojiSearchQuery] = useState('');
    const [selectedEmojiCategory, setSelectedEmojiCategory] = useState<string>('Smileys');
    const [showImportWizard, setShowImportWizard] = useState(false);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const sortMenuRef = useRef<HTMLDivElement>(null);
    const emojiPickerRef = useRef<HTMLDivElement>(null);
    const sendingRef = useRef(false);

    const { currentUser, settings } = useAppStore();

    // Handle initial target user from profile card whisper button
    useEffect(() => {
        if (isOpen && whisperTargetUser) {
            // Create or select conversation for the target user
            const userId = whisperTargetUser.id;
            if (!conversations.has(userId)) {
                setConversations(prev => {
                    const n = new Map(prev);
                    n.set(userId, {
                        user_id: userId,
                        user_login: whisperTargetUser.login,
                        user_name: whisperTargetUser.display_name,
                        profile_image_url: whisperTargetUser.profile_image_url ?? undefined,
                        messages: [],
                        last_message_timestamp: Date.now(),
                        unread_count: 0
                    });
                    return n;
                });
            }
            setActiveConversation(userId);
            setShowNewConversation(false);
            // Clear the target user after handling
            clearWhisperTargetUser();
        }
    }, [isOpen, whisperTargetUser, conversations, clearWhisperTargetUser]);

    // Get current conversation
    const currentConversation = activeConversation ? conversations.get(activeConversation) : null;

    // Save conversations to localStorage whenever they change
    useEffect(() => {
        if (conversations.size > 0) {
            saveConversationsToStorage(conversations);
        }
    }, [conversations]);

    // Close menus when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (sortMenuRef.current && !sortMenuRef.current.contains(event.target as Node)) {
                setShowSortMenu(false);
            }
            if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) {
                setShowEmojiPicker(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Play notification sound
    const playNotificationSound = useCallback(() => {
        try {
            const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(520, audioContext.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(380, audioContext.currentTime + 0.12);
            gainNode.gain.setValueAtTime(0, audioContext.currentTime);
            gainNode.gain.linearRampToValueAtTime(0.07, audioContext.currentTime + 0.02);
            gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.25);
            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.25);
        } catch (err) {
            console.warn('Could not play notification sound:', err);
        }
    }, []);

    // Listen for incoming whispers
    useEffect(() => {
        const unlisten = listen<WhisperFromBackend>('whisper-received', async (event) => {
            const data = event.payload;
            if (settings.live_notifications?.play_sound) {
                playNotificationSound();
            }
            let profileImageUrl: string | undefined;
            try {
                const userInfo = await invoke<UserInfo>('get_user_by_id', { userId: data.from_user_id });
                profileImageUrl = userInfo.profile_image_url;
            } catch {
                // Ignore
            }
            const whisperMessage: Whisper = {
                id: data.whisper_id,
                from_user_id: data.from_user_id,
                from_user_login: data.from_user_login,
                from_user_name: data.from_user_name,
                to_user_id: data.to_user_id,
                to_user_login: data.to_user_login,
                to_user_name: data.to_user_name,
                message: data.text,
                timestamp: Date.now(),
                is_sent: false,
            };
            setConversations(prev => {
                const newConversations = new Map(prev);
                const existing = newConversations.get(data.from_user_id);
                if (existing) {
                    // Check for duplicate message before adding
                    const messageExists = existing.messages.some(m => m.id === whisperMessage.id);
                    if (!messageExists) {
                        existing.messages.push(whisperMessage);
                        existing.last_message_timestamp = Date.now();
                        if (activeConversation !== data.from_user_id) {
                            existing.unread_count += 1;
                        }
                    }
                } else {
                    newConversations.set(data.from_user_id, {
                        user_id: data.from_user_id,
                        user_login: data.from_user_login,
                        user_name: data.from_user_name,
                        profile_image_url: profileImageUrl,
                        messages: [whisperMessage],
                        last_message_timestamp: Date.now(),
                        unread_count: activeConversation === data.from_user_id ? 0 : 1,
                    });
                }
                return newConversations;
            });
        });
        return () => { unlisten.then((fn) => fn()); };
    }, [activeConversation, playNotificationSound, settings.live_notifications?.play_sound]);

    // Scroll to bottom when new messages arrive
    useEffect(() => {
        if (activeConversation) {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [conversations, activeConversation]);

    // Focus input when opening a conversation
    useEffect(() => {
        if (activeConversation) {
            inputRef.current?.focus();
        }
    }, [activeConversation]);

    // Mark conversation as read when viewing and clean up empty conversations when switching away
    useEffect(() => {
        // Clean up the previous conversation if it was empty
        if (previousActiveConversationRef.current && previousActiveConversationRef.current !== activeConversation) {
            const prevConvId = previousActiveConversationRef.current;
            setConversations(prev => {
                const prevConv = prev.get(prevConvId);
                if (prevConv && prevConv.messages.length === 0) {
                    // Remove empty conversation
                    const newConversations = new Map(prev);
                    newConversations.delete(prevConvId);
                    console.log('[Whispers] Removed empty conversation:', prevConvId);
                    return newConversations;
                }
                return prev;
            });
        }

        // Update the ref to current
        previousActiveConversationRef.current = activeConversation;

        // Mark current conversation as read
        if (activeConversation) {
            setConversations(prev => {
                const newConversations = new Map(prev);
                const existing = newConversations.get(activeConversation);
                if (existing && existing.unread_count > 0) {
                    existing.unread_count = 0;
                }
                return newConversations;
            });
        }
    }, [activeConversation]);

    // Clean up empty conversations when closing the widget
    const handleClose = useCallback(() => {
        // Clean up the current conversation if it's empty
        if (activeConversation) {
            setConversations(prev => {
                const conv = prev.get(activeConversation);
                if (conv && conv.messages.length === 0) {
                    const newConversations = new Map(prev);
                    newConversations.delete(activeConversation);
                    console.log('[Whispers] Removed empty conversation on close:', activeConversation);
                    return newConversations;
                }
                return prev;
            });
        }
        setActiveConversation(null);
        onClose();
    }, [activeConversation, onClose]);

    // Import whispers from exported JSON file
    const handleFileImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setIsImportingAll(true);
        setImportProgress('Reading file...');
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.version || !data.conversations || !Array.isArray(data.conversations)) {
                throw new Error('Invalid file format.');
            }
            setImportProgress(`Importing ${data.conversations.length} conversations...`);
            const myUsername = currentUser?.login || currentUser?.username || data.myUsername || '';
            const myUserId = currentUser?.user_id || data.myUserId || '';
            const myDisplayName = currentUser?.display_name || currentUser?.username || data.myUsername || '';

            // First pass: import all conversations
            const newConversations = new Map(conversations);
            const usersNeedingProfilePics: string[] = [];

            for (const conv of data.conversations) {
                const userId = conv.user.id || conv.user.login.toLowerCase();
                const existing = newConversations.get(userId);
                const importedMessages: Whisper[] = conv.messages.map((msg: any) => {
                    const isSent = msg.isSent === true || (msg.fromUserName && myUsername && msg.fromUserName.toLowerCase() === myUsername.toLowerCase());
                    return {
                        id: msg.id,
                        from_user_id: msg.fromUserId || (isSent ? myUserId : userId),
                        from_user_login: msg.fromUserLogin || (isSent ? myUsername : conv.user.login),
                        from_user_name: msg.fromUserName || (isSent ? myDisplayName : conv.user.displayName),
                        to_user_id: isSent ? userId : myUserId,
                        to_user_login: isSent ? conv.user.login : myUsername,
                        to_user_name: isSent ? conv.user.displayName : myDisplayName,
                        message: msg.content,
                        timestamp: parseWhisperDate(msg.sentAt),
                        is_sent: isSent,
                    };
                });
                if (existing) {
                    const existingIds = new Set(existing.messages.map(m => m.id));
                    const uniqueNewMessages = importedMessages.filter(m => !existingIds.has(m.id));
                    existing.messages = [...existing.messages, ...uniqueNewMessages].sort((a, b) => a.timestamp - b.timestamp);
                    if (!existing.profile_image_url && conv.user.profileImageURL) {
                        existing.profile_image_url = conv.user.profileImageURL;
                    }
                    if (!existing.profile_image_url) {
                        usersNeedingProfilePics.push(userId);
                    }
                    if (existing.messages.length > 0) {
                        existing.last_message_timestamp = existing.messages[existing.messages.length - 1].timestamp;
                    }
                } else {
                    newConversations.set(userId, {
                        user_id: userId,
                        user_login: conv.user.login,
                        user_name: conv.user.displayName,
                        profile_image_url: conv.user.profileImageURL || null,
                        messages: importedMessages.sort((a, b) => a.timestamp - b.timestamp),
                        last_message_timestamp: conv.lastMessageAt ? parseWhisperDate(conv.lastMessageAt) : Date.now(),
                        unread_count: 0,
                    });
                    if (!conv.user.profileImageURL) {
                        usersNeedingProfilePics.push(userId);
                    }
                }
            }

            setConversations(newConversations);
            const totalMessages = data.conversations.reduce((sum: number, conv: any) => sum + conv.messages.length, 0);
            setImportProgress(`✓ Imported ${totalMessages} messages`);

            // Second pass: fetch missing profile pictures in background
            if (usersNeedingProfilePics.length > 0) {
                setImportProgress(`Fetching ${usersNeedingProfilePics.length} profile pictures...`);
                for (const visitorId of usersNeedingProfilePics) {
                    try {
                        const conv = newConversations.get(visitorId);
                        if (!conv) continue;

                        // Try to get user info by login name (most reliable for imported whispers)
                        let profileUrl: string | undefined;

                        // First try search_whisper_user which uses login
                        try {
                            const result = await invoke<[string, string, string, string | null] | null>('search_whisper_user', { username: conv.user_login });
                            if (result && result[3]) {
                                profileUrl = result[3];
                                // Also update the user_id with the real Twitch ID
                                const realUserId = result[0];
                                if (realUserId && realUserId !== visitorId) {
                                    // Update conversation with real user ID
                                    newConversations.delete(visitorId);
                                    conv.user_id = realUserId;
                                    conv.profile_image_url = profileUrl;
                                    newConversations.set(realUserId, conv);
                                }
                            }
                        } catch {
                            // Fallback: try get_user_by_id if we have a numeric ID
                            if (/^\d+$/.test(visitorId)) {
                                try {
                                    const userInfo = await invoke<UserInfo>('get_user_by_id', { userId: visitorId });
                                    if (userInfo?.profile_image_url) {
                                        profileUrl = userInfo.profile_image_url;
                                    }
                                } catch {
                                    // Ignore
                                }
                            }
                        }

                        if (profileUrl) {
                            setConversations(prev => {
                                const updated = new Map(prev);
                                const c = updated.get(conv.user_id) || updated.get(visitorId);
                                if (c && !c.profile_image_url) {
                                    c.profile_image_url = profileUrl;
                                }
                                return updated;
                            });
                        }
                    } catch {
                        // Ignore errors fetching profile pics
                    }
                }
                // Update state with corrected user IDs
                setConversations(newConversations);
                setImportProgress(`✓ Imported ${totalMessages} messages`);
            }

            if (fileInputRef.current) fileInputRef.current.value = '';
            setTimeout(() => setImportProgress(''), 3000);
        } catch (err) {
            console.error('[Whispers] Failed to import file:', err);
            setError(err instanceof Error ? err.message : 'Failed to import');
            setImportProgress('');
        } finally {
            setIsImportingAll(false);
        }
    };

    // Search for users
    const handleSearch = async () => {
        if (!searchQuery.trim()) { setSearchResults([]); return; }
        setIsSearching(true);
        try {
            try {
                const whisperSearchResult = await invoke<[string, string, string, string | null] | null>('search_whisper_user', { username: searchQuery });
                if (whisperSearchResult) {
                    const [userId, userLogin, displayName, profileImageUrl] = whisperSearchResult;
                    setSearchResults([{ id: userId, login: userLogin, display_name: displayName, profile_image_url: profileImageUrl || undefined }]);
                    return;
                }
            } catch { /* fallback */ }
            const results = await invoke<any[]>('search_channels', { query: searchQuery });
            setSearchResults(results.slice(0, 10).map((r: any) => ({ id: r.user_id || r.id, login: r.user_login || r.login, display_name: r.user_name || r.display_name, profile_image_url: r.profile_image_url })).filter(r => r.id && r.login));
        } catch { setSearchResults([]); }
        finally { setIsSearching(false); }
    };

    // Start conversation with user
    const startConversation = async (user: UserInfo) => {
        if (!conversations.has(user.id)) {
            setConversations(prev => {
                const n = new Map(prev);
                n.set(user.id, { user_id: user.id, user_login: user.login, user_name: user.display_name, profile_image_url: user.profile_image_url, messages: [], last_message_timestamp: Date.now(), unread_count: 0 });
                return n;
            });
        }
        setActiveConversation(user.id);
        setShowNewConversation(false);
        setSearchQuery('');
        setSearchResults([]);
    };

    const generateMessageId = () => `sent-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

    const handleSend = async () => {
        if (!message.trim() || isSending || !activeConversation || sendingRef.current) return;
        const conversation = conversations.get(activeConversation);
        if (!conversation) return;
        const messageToSend = message.trim();
        const messageId = generateMessageId();
        sendingRef.current = true;
        setMessage('');
        setIsSending(true);
        setError(null);
        setShowEmojiPicker(false);
        try {
            await invoke('send_whisper', { toUserId: activeConversation, message: messageToSend });
            const sentMessage: Whisper = {
                id: messageId,
                from_user_id: currentUser?.user_id || '',
                from_user_login: currentUser?.login || currentUser?.username || '',
                from_user_name: currentUser?.display_name || currentUser?.username || '',
                to_user_id: activeConversation,
                to_user_login: conversation.user_login,
                to_user_name: conversation.user_name,
                message: messageToSend,
                timestamp: Date.now(),
                is_sent: true,
            };
            setConversations(prev => {
                const n = new Map(prev);
                const existing = n.get(activeConversation);
                if (existing && !existing.messages.some(m => m.id === messageId)) {
                    existing.messages.push(sentMessage);
                    existing.last_message_timestamp = Date.now();
                }
                return n;
            });
        } catch (err) {
            console.error('Failed to send whisper:', err);
            setError('Failed to send message. Please try again.');
            setMessage(messageToSend);
        } finally {
            setIsSending(false);
            sendingRef.current = false;
            inputRef.current?.focus();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const insertEmoji = (emoji: string) => {
        setMessage(prev => prev + emoji);
        inputRef.current?.focus();
    };

    const formatTime = (timestamp: number) => {
        const date = new Date(timestamp);
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();
        if (isToday) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    // Get sorted conversations
    const sortedConversations = Array.from(conversations.values()).sort((a, b) => {
        if (sortOption === 'recent') return b.last_message_timestamp - a.last_message_timestamp;
        if (sortOption === 'name') return a.user_name.localeCompare(b.user_name);
        if (sortOption === 'unread') return b.unread_count - a.unread_count || b.last_message_timestamp - a.last_message_timestamp;
        return 0;
    });

    const totalUnread = sortedConversations.reduce((sum, c) => sum + c.unread_count, 0);

    // Get filtered emojis
    const getFilteredEmojis = () => {
        const categoryEmojis = emojiCategories[selectedEmojiCategory] || [];
        if (!emojiSearchQuery) return categoryEmojis;
        const allEmojis = Object.values(emojiCategories).flat();
        return allEmojis.filter(emoji => emoji.includes(emojiSearchQuery));
    };

    if (!isOpen) return null;

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={handleClose}
        >
            <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                className="bg-background border border-borderLight rounded-xl shadow-2xl w-[700px] h-[650px] flex overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Sidebar - Conversation List */}
                <div className={`w-full md:w-[280px] flex-shrink-0 border-r border-borderSubtle flex flex-col ${activeConversation && 'hidden md:flex'}`}>
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-4 border-b border-borderSubtle">
                        <div className="flex items-center gap-2">
                            <MessageCircle size={20} className="text-purple-400" />
                            <span className="text-textPrimary font-semibold text-lg">Whispers</span>
                            {totalUnread > 0 && (
                                <span className="bg-purple-500 text-white text-xs px-2 py-0.5 rounded-full font-medium">
                                    {totalUnread}
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-1">
                            <input type="file" ref={fileInputRef} onChange={handleFileImport} accept=".json" className="hidden" />
                            <button
                                onClick={() => setShowImportWizard(true)}
                                disabled={isImportingAll}
                                className="p-2 text-textSecondary hover:text-purple-400 hover:bg-glass rounded-lg transition-colors disabled:opacity-50"
                                title="Import whisper history"
                            >
                                {isImportingAll ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
                            </button>
                            <button
                                onClick={() => setShowNewConversation(true)}
                                className="p-2 text-textSecondary hover:text-purple-400 hover:bg-glass rounded-lg transition-colors"
                                title="New conversation"
                            >
                                <Plus size={18} />
                            </button>
                            <button onClick={handleClose} className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-colors md:hidden">
                                <X size={18} />
                            </button>
                        </div>
                    </div>

                    {/* Sort Options */}
                    <div className="px-4 py-2 border-b border-borderSubtle">
                        <div className="relative" ref={sortMenuRef}>
                            <button
                                onClick={() => setShowSortMenu(!showSortMenu)}
                                className="flex items-center gap-2 text-xs text-textSecondary hover:text-textPrimary transition-colors"
                            >
                                <SortAsc size={14} />
                                <span>Sort by: {sortOption === 'recent' ? 'Recent' : sortOption === 'name' ? 'Name' : 'Unread'}</span>
                                <ChevronDown size={14} className={`transition-transform ${showSortMenu ? 'rotate-180' : ''}`} />
                            </button>
                            {showSortMenu && (
                                <div className="absolute top-full left-0 mt-1 bg-background border border-borderLight rounded-lg shadow-lg z-10 py-1 min-w-[120px]">
                                    <button onClick={() => { setSortOption('recent'); setShowSortMenu(false); }} className={`w-full px-3 py-1.5 text-left text-xs hover:bg-glass transition-colors flex items-center gap-2 ${sortOption === 'recent' ? 'text-purple-400' : 'text-textSecondary'}`}>
                                        <Clock size={12} /> Recent
                                    </button>
                                    <button onClick={() => { setSortOption('name'); setShowSortMenu(false); }} className={`w-full px-3 py-1.5 text-left text-xs hover:bg-glass transition-colors flex items-center gap-2 ${sortOption === 'name' ? 'text-purple-400' : 'text-textSecondary'}`}>
                                        <User size={12} /> Name
                                    </button>
                                    <button onClick={() => { setSortOption('unread'); setShowSortMenu(false); }} className={`w-full px-3 py-1.5 text-left text-xs hover:bg-glass transition-colors flex items-center gap-2 ${sortOption === 'unread' ? 'text-purple-400' : 'text-textSecondary'}`}>
                                        <MessageCircle size={12} /> Unread
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Import Progress */}
                    {importProgress && (
                        <div className="px-4 py-2 bg-purple-500/10 border-b border-purple-500/20">
                            <span className="text-purple-400 text-xs">{importProgress}</span>
                        </div>
                    )}

                    {/* Conversation List */}
                    <div className="flex-1 overflow-y-auto scrollbar-thin">
                        {sortedConversations.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-full text-textMuted p-6">
                                <Users size={40} className="mb-3 opacity-50" />
                                <span className="text-sm text-center mb-2">No conversations yet</span>
                                <button onClick={() => setShowNewConversation(true)} className="text-purple-400 hover:text-purple-300 text-sm">
                                    Start a new conversation
                                </button>
                            </div>
                        ) : (
                            sortedConversations.map((conv) => (
                                <div
                                    key={conv.user_id}
                                    className={`group relative w-full flex items-center gap-3 px-4 py-3 hover:bg-glass transition-colors cursor-pointer ${activeConversation === conv.user_id ? 'bg-glass' : ''}`}
                                    onClick={() => setActiveConversation(conv.user_id)}
                                >
                                    <div className="relative flex-shrink-0">
                                        {conv.profile_image_url ? (
                                            <img src={conv.profile_image_url} alt={conv.user_name} className="w-11 h-11 rounded-full object-cover" />
                                        ) : (
                                            <div className="w-11 h-11 rounded-full bg-purple-500/20 flex items-center justify-center">
                                                <MessageCircle size={18} className="text-purple-400" />
                                            </div>
                                        )}
                                        {conv.unread_count > 0 && (
                                            <div className="absolute -top-1 -right-1 w-5 h-5 bg-purple-500 rounded-full flex items-center justify-center text-white text-[10px] font-bold">
                                                {conv.unread_count > 9 ? '9+' : conv.unread_count}
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0 text-left">
                                        <span className="text-textPrimary text-sm font-medium block truncate">{conv.user_name}</span>
                                        <span className="text-textMuted text-xs block truncate">
                                            {conv.messages.length > 0 ? conv.messages[conv.messages.length - 1].message : 'No messages'}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                        <span className="text-textMuted text-[10px] group-hover:hidden">{formatTime(conv.last_message_timestamp)}</span>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                // Delete the conversation
                                                setConversations(prev => {
                                                    const newConversations = new Map(prev);
                                                    newConversations.delete(conv.user_id);
                                                    return newConversations;
                                                });
                                                // If this was the active conversation, clear it
                                                if (activeConversation === conv.user_id) {
                                                    setActiveConversation(null);
                                                }
                                            }}
                                            className="hidden group-hover:flex p-1.5 text-textMuted hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                                            title="Delete conversation"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {/* Main Content */}
                <div className={`flex-1 flex flex-col ${!activeConversation && !showNewConversation && 'hidden md:flex'}`}>
                    {showNewConversation ? (
                        <>
                            <div className="flex items-center gap-3 px-5 py-4 border-b border-borderSubtle">
                                <button onClick={() => { setShowNewConversation(false); setSearchQuery(''); setSearchResults([]); }} className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-colors">
                                    <ArrowLeft size={18} />
                                </button>
                                <span className="text-textPrimary font-semibold">New Conversation</span>
                            </div>
                            <div className="p-5">
                                <div className="flex items-center gap-3">
                                    <div className="flex-1 relative">
                                        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-textMuted" />
                                        <input
                                            type="text"
                                            value={searchQuery}
                                            onChange={(e) => setSearchQuery(e.target.value)}
                                            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                                            placeholder="Search for a user..."
                                            className="w-full bg-glass border border-borderLight rounded-lg pl-10 pr-4 py-2.5 text-sm text-textPrimary placeholder:text-textMuted focus:outline-none focus:border-purple-500 transition-colors"
                                        />
                                    </div>
                                    <button onClick={handleSearch} disabled={isSearching} className="px-5 py-2.5 bg-purple-500 hover:bg-purple-600 disabled:bg-purple-500/50 text-white rounded-lg text-sm transition-colors">
                                        {isSearching ? <Loader2 size={16} className="animate-spin" /> : 'Search'}
                                    </button>
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto px-5 pb-5">
                                {searchResults.length > 0 ? (
                                    <div className="space-y-2">
                                        {searchResults.map((user) => (
                                            <button key={user.id} onClick={() => startConversation(user)} className="w-full flex items-center gap-3 p-3 bg-glass hover:bg-glass/80 rounded-lg transition-colors">
                                                {user.profile_image_url ? (
                                                    <img src={user.profile_image_url} alt={user.display_name} className="w-11 h-11 rounded-full object-cover" />
                                                ) : (
                                                    <div className="w-11 h-11 rounded-full bg-purple-500/20 flex items-center justify-center">
                                                        <MessageCircle size={18} className="text-purple-400" />
                                                    </div>
                                                )}
                                                <div className="text-left">
                                                    <span className="text-textPrimary text-sm font-medium block">{user.display_name}</span>
                                                    <span className="text-textMuted text-xs">@{user.login}</span>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                ) : searchQuery && !isSearching ? (
                                    <div className="text-center text-textMuted py-8">No users found</div>
                                ) : null}
                            </div>
                        </>
                    ) : activeConversation && currentConversation ? (
                        <>
                            {/* Conversation Header */}
                            <div className="flex items-center gap-3 px-5 py-4 border-b border-borderSubtle">
                                <button onClick={() => setActiveConversation(null)} className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-colors md:hidden">
                                    <ArrowLeft size={18} />
                                </button>
                                {currentConversation.profile_image_url ? (
                                    <img src={currentConversation.profile_image_url} alt={currentConversation.user_name} className="w-10 h-10 rounded-full object-cover" />
                                ) : (
                                    <div className="w-10 h-10 rounded-full bg-purple-500/20 flex items-center justify-center">
                                        <MessageCircle size={16} className="text-purple-400" />
                                    </div>
                                )}
                                <div className="flex-1">
                                    <span className="text-textPrimary font-semibold text-sm block">{currentConversation.user_name}</span>
                                    <span className="text-textMuted text-xs">@{currentConversation.user_login}</span>
                                </div>
                                <button onClick={handleClose} className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-colors hidden md:block">
                                    <X size={18} />
                                </button>
                            </div>

                            {/* Messages */}
                            <div className="flex-1 overflow-y-auto p-5 space-y-3 scrollbar-thin">
                                {currentConversation.messages.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center h-full text-textMuted">
                                        <MessageCircle size={40} className="mb-3 opacity-50" />
                                        <span className="text-sm">No messages yet</span>
                                        <span className="text-xs mt-1">Start the conversation!</span>
                                    </div>
                                ) : (
                                    currentConversation.messages.map((msg, index) => (
                                        <motion.div key={`${msg.id}-${index}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className={`flex ${msg.is_sent ? 'justify-end' : 'justify-start'}`}>
                                            <div className={`max-w-[70%] px-4 py-2.5 rounded-2xl ${msg.is_sent ? 'bg-purple-500 text-white rounded-br-md' : 'bg-glass text-textPrimary rounded-bl-md'}`}>
                                                <p className="text-sm break-words whitespace-pre-wrap">{msg.message}</p>
                                                <span className={`text-[10px] mt-1 block ${msg.is_sent ? 'text-white/60' : 'text-textMuted'}`}>{formatTime(msg.timestamp)}</span>
                                            </div>
                                        </motion.div>
                                    ))
                                )}
                                <div ref={messagesEndRef} />
                            </div>

                            {/* Error */}
                            {error && (
                                <div className="px-5 py-2 bg-red-500/10 border-t border-red-500/20">
                                    <span className="text-red-400 text-xs">{error}</span>
                                </div>
                            )}

                            {/* Input Area */}
                            <div className="p-4 border-t border-borderSubtle relative">
                                {/* Emoji Picker */}
                                {showEmojiPicker && (
                                    <div ref={emojiPickerRef} className="absolute bottom-full left-4 right-4 mb-2 bg-background border border-borderLight rounded-xl shadow-xl overflow-hidden" style={{ height: '320px' }}>
                                        <div className="p-3 border-b border-borderSubtle">
                                            <input
                                                type="text"
                                                value={emojiSearchQuery}
                                                onChange={(e) => setEmojiSearchQuery(e.target.value)}
                                                placeholder="Search emojis..."
                                                className="w-full bg-glass border border-borderLight rounded-lg px-3 py-2 text-xs text-textPrimary placeholder:text-textMuted focus:outline-none focus:border-purple-500"
                                            />
                                            <div className="flex gap-1 mt-2 overflow-x-auto scrollbar-thin pb-1">
                                                {Object.keys(emojiCategories).map((category) => (
                                                    <button
                                                        key={category}
                                                        onClick={() => { setSelectedEmojiCategory(category); setEmojiSearchQuery(''); }}
                                                        className={`px-2 py-1 text-xs rounded whitespace-nowrap transition-colors ${selectedEmojiCategory === category ? 'bg-purple-500 text-white' : 'bg-glass text-textSecondary hover:bg-glass/80'}`}
                                                    >
                                                        {category}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="p-3 overflow-y-auto scrollbar-thin" style={{ height: 'calc(100% - 90px)' }}>
                                            <div className="grid grid-cols-8 gap-1">
                                                {getFilteredEmojis().map((emoji, idx) => (
                                                    <button
                                                        key={`${emoji}-${idx}`}
                                                        onClick={() => insertEmoji(emoji)}
                                                        className="flex items-center justify-center p-2 hover:bg-glass rounded-lg transition-colors"
                                                        title={emoji}
                                                    >
                                                        <img src={getAppleEmojiUrl(emoji)} alt={emoji} className="w-6 h-6 object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).insertAdjacentText('afterend', emoji); }} />
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}

                                <div className="flex items-end gap-2">
                                    <button onClick={() => setShowEmojiPicker(!showEmojiPicker)} className="p-2.5 text-textSecondary hover:text-purple-400 hover:bg-glass rounded-lg transition-colors flex-shrink-0">
                                        <Smile size={20} />
                                    </button>
                                    <textarea
                                        ref={inputRef}
                                        value={message}
                                        onChange={(e) => setMessage(e.target.value)}
                                        onKeyDown={handleKeyDown}
                                        placeholder="Type a message..."
                                        disabled={isSending}
                                        maxLength={500}
                                        rows={1}
                                        className="flex-1 bg-glass border border-borderLight rounded-xl px-4 py-2.5 text-sm text-textPrimary placeholder:text-textMuted focus:outline-none focus:border-purple-500 transition-colors disabled:opacity-50 resize-none min-h-[42px] max-h-[120px]"
                                        style={{ height: 'auto' }}
                                        onInput={(e) => {
                                            const target = e.target as HTMLTextAreaElement;
                                            target.style.height = 'auto';
                                            target.style.height = Math.min(target.scrollHeight, 120) + 'px';
                                        }}
                                    />
                                    <button onClick={handleSend} disabled={!message.trim() || isSending} className="p-2.5 bg-purple-500 hover:bg-purple-600 disabled:bg-purple-500/30 disabled:cursor-not-allowed text-white rounded-xl transition-colors flex-shrink-0">
                                        {isSending ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
                                    </button>
                                </div>
                                <div className="flex justify-between mt-2 px-1">
                                    <span className="text-[10px] text-textMuted">Press Enter to send, Shift+Enter for new line</span>
                                    <span className="text-[10px] text-textMuted">{message.length}/500</span>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-textMuted p-8">
                            <MessageCircle size={56} className="mb-4 opacity-30" />
                            <span className="text-lg font-medium mb-1">Select a conversation</span>
                            <span className="text-sm mb-4">or start a new one</span>
                            <button onClick={() => setShowNewConversation(true)} className="px-5 py-2.5 bg-purple-500 hover:bg-purple-600 text-white rounded-lg text-sm transition-colors">
                                New Conversation
                            </button>
                            <button onClick={handleClose} className="mt-4 p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-colors hidden md:block">
                                <X size={22} />
                            </button>
                        </div>
                    )}
                </div>
            </motion.div>

            {/* Import Wizard */}
            <WhisperImportWizard
                isOpen={showImportWizard}
                onClose={() => setShowImportWizard(false)}
                onImport={async (file: File) => {
                    // Create a synthetic event for the existing handler
                    const dataTransfer = new DataTransfer();
                    dataTransfer.items.add(file);

                    // Create a mock input element with the file
                    const mockInput = document.createElement('input');
                    mockInput.type = 'file';
                    Object.defineProperty(mockInput, 'files', {
                        value: dataTransfer.files
                    });

                    // Create a synthetic event
                    const syntheticEvent = {
                        target: mockInput
                    } as React.ChangeEvent<HTMLInputElement>;

                    await handleFileImport(syntheticEvent);
                }}
            />
        </motion.div>
    );
};

export default WhispersWidget;
