import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { X, Send, MessageCircle, Loader2 } from 'lucide-react';
import type { WhisperConversation, Whisper } from '../types';

interface WhisperChatWindowProps {
    conversation: WhisperConversation;
    currentUserId: string;
    currentUserLogin: string;
    currentUserName: string;
    onClose: () => void;
    onSendMessage: (message: string) => Promise<void>;
}

const WhisperChatWindow = ({
    conversation,
    currentUserId: _currentUserId,
    currentUserLogin: _currentUserLogin,
    currentUserName: _currentUserName,
    onClose,
    onSendMessage,
}: WhisperChatWindowProps) => {
    const [message, setMessage] = useState('');
    const [isSending, setIsSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Scroll to bottom when new messages arrive
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [conversation.messages]);

    // Focus input on mount
    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const handleSend = async () => {
        if (!message.trim() || isSending) return;

        const messageToSend = message.trim();
        setMessage('');
        setIsSending(true);
        setError(null);

        try {
            await onSendMessage(messageToSend);
        } catch (err) {
            // Parse the error to provide a more specific message
            const errorString = String(err);
            let errorMessage = 'Failed to send message. Please try again.';

            // Check for specific Twitch API errors
            if (errorString.includes('recipient\'s settings prevent') ||
                errorString.includes('recipient\\"s settings prevent') ||
                errorString.includes('settings prevent this sender from whispering')) {
                errorMessage = 'Cannot send: This user\'s privacy settings prevent them from receiving whispers from you.';
            } else if (errorString.includes('403') || errorString.includes('Forbidden')) {
                errorMessage = 'Cannot send: You don\'t have permission to whisper this user.';
            } else if (errorString.includes('401') || errorString.includes('Unauthorized')) {
                errorMessage = 'Cannot send: Your session has expired. Please log in again.';
            } else if (errorString.includes('429') || errorString.includes('Too Many Requests')) {
                errorMessage = 'Sending too fast. Please wait a moment before trying again.';
            } else if (errorString.includes('404') || errorString.includes('Not Found')) {
                errorMessage = 'Cannot send: User not found.';
            }

            setError(errorMessage);
            setMessage(messageToSend); // Restore message on error
        } finally {
            setIsSending(false);
            inputRef.current?.focus();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const formatTime = (timestamp: number) => {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="fixed bottom-4 right-4 w-80 h-96 flex flex-col bg-background border border-borderLight rounded-xl shadow-2xl overflow-hidden z-50"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-secondary border-b border-borderSubtle">
                <div className="flex items-center gap-3">
                    {conversation.profile_image_url ? (
                        <img
                            src={conversation.profile_image_url}
                            alt={conversation.user_name}
                            className="w-8 h-8 rounded-full object-cover"
                        />
                    ) : (
                        <div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center">
                            <MessageCircle size={16} className="text-purple-400" />
                        </div>
                    )}
                    <div>
                        <span className="text-textPrimary font-semibold text-sm block">
                            {conversation.user_name}
                        </span>
                        <span className="text-textMuted text-xs">
                            @{conversation.user_login}
                        </span>
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-colors"
                >
                    <X size={18} />
                </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin">
                {conversation.messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-textMuted">
                        <MessageCircle size={32} className="mb-2 opacity-50" />
                        <span className="text-sm">No messages yet</span>
                        <span className="text-xs">Start a conversation!</span>
                    </div>
                ) : (
                    conversation.messages.map((msg: Whisper, index: number) => (
                        <motion.div
                            key={`${msg.id}-${index}`}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className={`flex ${msg.is_sent ? 'justify-end' : 'justify-start'}`}
                        >
                            <div
                                className={`
                                    max-w-[80%] px-3 py-2 rounded-2xl
                                    ${msg.is_sent
                                        ? 'bg-purple-500 text-white rounded-br-md'
                                        : 'bg-glass text-textPrimary rounded-bl-md'
                                    }
                                `}
                            >
                                <p className="text-sm break-words">{msg.message}</p>
                                <span className={`text-[10px] mt-1 block ${msg.is_sent ? 'text-white/60' : 'text-textMuted'}`}>
                                    {formatTime(msg.timestamp)}
                                </span>
                            </div>
                        </motion.div>
                    ))
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Error Message */}
            {error && (
                <div className="px-3 py-2 bg-red-500/10 border-t border-red-500/20">
                    <span className="text-red-400 text-xs">{error}</span>
                </div>
            )}

            {/* Input */}
            <div className="p-3 border-t border-borderSubtle bg-secondary">
                <div className="flex items-center gap-2">
                    <input
                        ref={inputRef}
                        type="text"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Type a message..."
                        disabled={isSending}
                        maxLength={500}
                        className="flex-1 bg-glass border border-borderLight rounded-lg px-3 py-2 text-sm text-textPrimary placeholder:text-textMuted focus:outline-none focus:border-purple-500 transition-colors disabled:opacity-50"
                    />
                    <button
                        onClick={handleSend}
                        disabled={!message.trim() || isSending}
                        className="p-2 bg-purple-500 hover:bg-purple-600 disabled:bg-purple-500/30 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                    >
                        {isSending ? (
                            <Loader2 size={18} className="animate-spin" />
                        ) : (
                            <Send size={18} />
                        )}
                    </button>
                </div>
                <div className="flex justify-between mt-1.5">
                    <span className="text-[10px] text-textMuted">
                        Press Enter to send
                    </span>
                    <span className="text-[10px] text-textMuted">
                        {message.length}/500
                    </span>
                </div>
            </div>
        </motion.div>
    );
};

export default WhisperChatWindow;
