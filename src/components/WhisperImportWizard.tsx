import { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    X,
    Check,
    Sparkles,
    Download,
    CheckCircle2,
    AlertCircle,
    Loader2,
    MessageCircle,
    Wand2,
    Search,
    FolderOpen,
    Send
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../stores/AppStore';

interface WhisperImportWizardProps {
    isOpen: boolean;
    onClose: () => void;
}

const STEPS = [
    { id: 1, label: 'Opening Panel', icon: FolderOpen },
    { id: 2, label: 'Finding Conversations', icon: Search },
    { id: 3, label: 'Exporting Messages', icon: Download },
    { id: 4, label: 'Finalizing', icon: Send }
];

// Average time per conversation in seconds (based on testing)
const SECONDS_PER_CONVERSATION = 3;

const WhisperImportWizard = ({ isOpen, onClose }: WhisperImportWizardProps) => {
    const { whisperImportState, setWhisperImportState, resetWhisperImportState } = useAppStore();
    const { isImporting, progress, estimatedEndTime, exportProgress, result, error } = whisperImportState;

    // Countdown timer state (counts down from estimated end time)
    const [timeRemaining, setTimeRemaining] = useState<number | null>(null);

    // Derive status from global state
    const importStatus = error ? 'error' : result ? 'success' : isImporting ? 'importing' : 'idle';

    // Countdown timer effect - ticks every second
    useEffect(() => {
        if (!estimatedEndTime || !isImporting) {
            setTimeRemaining(null);
            return;
        }

        // Calculate initial time remaining
        const updateTimeRemaining = () => {
            const remaining = Math.max(0, Math.ceil((estimatedEndTime - Date.now()) / 1000));
            setTimeRemaining(remaining);
        };

        updateTimeRemaining();

        // Tick every second
        const interval = setInterval(updateTimeRemaining, 1000);

        return () => clearInterval(interval);
    }, [estimatedEndTime, isImporting]);

    // Listen for progress events (always, even when wizard is closed)
    useEffect(() => {
        let unlistenProgress: (() => void) | undefined;
        let unlistenComplete: (() => void) | undefined;

        const setupListeners = async () => {
            // Listen for progress updates
            unlistenProgress = await listen<{ step: number; status: string; detail: string; current: number; total: number }>(
                'whisper-import-progress',
                (event) => {
                    const { step, status, detail, current, total } = event.payload;
                    setWhisperImportState({
                        progress: { step, status: status as any, detail, current, total }
                    });

                    // Track export progress for step 3
                    if (step === 3 && status === 'running') {
                        const match = detail.match(/Exporting: (.+)/);
                        setWhisperImportState({
                            exportProgress: { current, total, username: match ? match[1] : '' }
                        });
                    }

                    // When step 2 completes, set the estimated end time (one-time calculation)
                    if (step === 2 && status === 'complete') {
                        const countMatch = detail.match(/Found (\d+) conversations/);
                        if (countMatch) {
                            const count = parseInt(countMatch[1], 10);
                            const estimatedSeconds = count * SECONDS_PER_CONVERSATION;
                            const endTime = Date.now() + (estimatedSeconds * 1000);
                            setWhisperImportState({
                                totalConversations: count,
                                estimatedEndTime: endTime
                            });
                        }
                    }
                }
            );

            // Listen for completion
            unlistenComplete = await listen<{ success: boolean; message: string; conversations: number; messages: number }>(
                'whisper-import-complete',
                (event) => {
                    const { success, message, conversations, messages } = event.payload;
                    if (success) {
                        setWhisperImportState({
                            isImporting: false,
                            result: { conversations, messages },
                            error: null
                        });
                    } else {
                        setWhisperImportState({
                            isImporting: false,
                            error: message
                        });
                    }
                }
            );
        };

        setupListeners();

        return () => {
            if (unlistenProgress) unlistenProgress();
            if (unlistenComplete) unlistenComplete();
        };
    }, [setWhisperImportState]);

    // Start automated whisper import
    const handleAutoImport = useCallback(async () => {
        setWhisperImportState({
            isImporting: true,
            error: null,
            result: null,
            progress: { step: 0, status: 'running', detail: 'Starting...', current: 0, total: 4 },
            estimatedEndTime: null,
            totalConversations: 0,
            exportProgress: { current: 0, total: 0, username: '' }
        });

        try {
            await invoke<{ success: boolean; message: string }>('scrape_whispers');
            // The actual completion will come via the event listener
        } catch (err) {
            console.error('[WhisperImportWizard] Auto-import failed:', err);
            setWhisperImportState({
                isImporting: false,
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }, [setWhisperImportState]);

    const handleClose = useCallback(() => {
        // Don't reset state if import is running - allow background import
        if (!isImporting) {
            // Only reset if we're done (success/error) and closing
            if (result || error) {
                resetWhisperImportState();
            }
        }
        onClose();
    }, [onClose, isImporting, result, error, resetWhisperImportState]);

    const handleDone = useCallback(() => {
        resetWhisperImportState();
        onClose();
    }, [onClose, resetWhisperImportState]);

    // Format seconds to readable time
    const formatTimeLeft = (seconds: number): string => {
        if (seconds < 60) {
            return `${Math.ceil(seconds)}s`;
        }
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.ceil(seconds % 60);
        if (minutes < 60) {
            return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
        }
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        return `${hours}h ${remainingMinutes}m`;
    };

    const getStepStatus = (stepId: number): 'pending' | 'running' | 'complete' | 'error' => {
        if (progress.step > stepId) return 'complete';
        if (progress.step === stepId) return progress.status;
        return 'pending';
    };

    const renderIdleView = () => (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center text-center px-8 py-10"
        >
            <div className="w-24 h-24 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center mb-6 shadow-lg shadow-purple-500/30">
                <MessageCircle size={48} className="text-white" />
            </div>
            <h2 className="text-2xl font-bold text-textPrimary mb-3">Import Your Whispers</h2>
            <p className="text-textSecondary mb-8 max-w-sm">
                Automatically import your entire Twitch whisper history. This runs silently in the background.
            </p>

            <button
                onClick={handleAutoImport}
                className="flex items-center gap-3 px-8 py-4 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white rounded-xl font-semibold transition-all shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 hover:scale-[1.02] active:scale-[0.98]"
            >
                <Wand2 size={22} />
                Start Import
            </button>

            <div className="mt-8 flex flex-col gap-2">
                <div className="flex items-center gap-2 text-left p-3 bg-glass/50 rounded-lg">
                    <Check size={14} className="text-green-400 flex-shrink-0" />
                    <span className="text-xs text-textMuted">Runs silently in background</span>
                </div>
                <div className="flex items-center gap-2 text-left p-3 bg-glass/50 rounded-lg">
                    <Check size={14} className="text-green-400 flex-shrink-0" />
                    <span className="text-xs text-textMuted">No browser interaction needed</span>
                </div>
                <div className="flex items-center gap-2 text-left p-3 bg-glass/50 rounded-lg">
                    <Check size={14} className="text-green-400 flex-shrink-0" />
                    <span className="text-xs text-textMuted">Your data stays private</span>
                </div>
            </div>
        </motion.div>
    );

    const renderImportingView = () => (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col px-8 py-6"
        >
            <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full bg-purple-500/20 flex items-center justify-center">
                    <Loader2 size={24} className="text-purple-400 animate-spin" />
                </div>
                <div>
                    <h2 className="text-xl font-bold text-textPrimary">Importing Whispers</h2>
                    <p className="text-textSecondary text-sm">Please wait while we fetch your messages...</p>
                </div>
            </div>

            {/* Progress Steps */}
            <div className="space-y-3 mb-6">
                {STEPS.map((step) => {
                    const status = getStepStatus(step.id);
                    const isActive = progress.step === step.id;

                    return (
                        <div
                            key={step.id}
                            className={`flex items-center gap-4 p-4 rounded-xl transition-all ${status === 'complete' ? 'bg-green-500/10 border border-green-500/30' :
                                status === 'running' ? 'bg-purple-500/10 border border-purple-500/30' :
                                    status === 'error' ? 'bg-red-500/10 border border-red-500/30' :
                                        'bg-glass/30 border border-borderSubtle'
                                }`}
                        >
                            <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${status === 'complete' ? 'bg-green-500' :
                                status === 'running' ? 'bg-purple-500' :
                                    status === 'error' ? 'bg-red-500' :
                                        'bg-glass'
                                }`}>
                                {status === 'complete' ? (
                                    <Check size={18} className="text-white" />
                                ) : status === 'running' ? (
                                    <Loader2 size={18} className="text-white animate-spin" />
                                ) : status === 'error' ? (
                                    <AlertCircle size={18} className="text-white" />
                                ) : (
                                    <step.icon size={18} className="text-textMuted" />
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between">
                                    <span className={`font-medium ${status === 'complete' ? 'text-green-400' :
                                        status === 'running' ? 'text-purple-400' :
                                            status === 'error' ? 'text-red-400' :
                                                'text-textMuted'
                                        }`}>
                                        {step.label}
                                    </span>
                                    {isActive && status === 'running' && step.id === 3 && exportProgress.total > 0 && (
                                        <span className="text-xs text-purple-400 font-medium">
                                            {exportProgress.current + 1}/{exportProgress.total}
                                        </span>
                                    )}
                                </div>
                                {isActive && progress.detail && (
                                    <p className="text-xs text-textMuted truncate mt-0.5">
                                        {progress.detail}
                                    </p>
                                )}
                                {/* Progress bar for step 3 */}
                                {isActive && status === 'running' && step.id === 3 && exportProgress.total > 0 && (
                                    <div className="mt-2 h-1.5 bg-glass rounded-full overflow-hidden">
                                        <motion.div
                                            className="h-full bg-purple-500 rounded-full"
                                            initial={{ width: 0 }}
                                            animate={{ width: `${((exportProgress.current + 1) / exportProgress.total) * 100}%` }}
                                            transition={{ duration: 0.3 }}
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Time estimate */}
            <div className="text-center">
                {timeRemaining !== null && timeRemaining > 0 ? (
                    <p className="text-textSecondary text-sm">
                        <span className="text-purple-400 font-medium">~{formatTimeLeft(timeRemaining)}</span> remaining
                    </p>
                ) : progress.step < 3 ? (
                    <p className="text-textMuted text-xs">
                        Calculating time estimate...
                    </p>
                ) : (
                    <p className="text-textMuted text-xs">
                        Almost done...
                    </p>
                )}
            </div>

            {/* Note about background import */}
            <p className="text-center text-textMuted text-xs mt-4 opacity-70">
                You can close this dialog - import will continue in the background
            </p>
        </motion.div>
    );

    const renderSuccessView = () => (
        <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center text-center px-8 py-10"
        >
            <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.1 }}
                className="w-24 h-24 rounded-full bg-green-500/20 flex items-center justify-center mb-6"
            >
                <CheckCircle2 size={56} className="text-green-400" />
            </motion.div>
            <h2 className="text-2xl font-bold text-textPrimary mb-2">Import Complete!</h2>
            <p className="text-textSecondary mb-6">
                Your whisper history has been imported successfully.
            </p>
            {result && (
                <div className="flex gap-8 mb-8">
                    <div className="text-center">
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.2 }}
                            className="text-4xl font-bold text-purple-400"
                        >
                            {result.conversations}
                        </motion.div>
                        <div className="text-xs text-textMuted mt-1">Conversations</div>
                    </div>
                    <div className="text-center">
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.3 }}
                            className="text-4xl font-bold text-purple-400"
                        >
                            {result.messages.toLocaleString()}
                        </motion.div>
                        <div className="text-xs text-textMuted mt-1">Messages</div>
                    </div>
                </div>
            )}
            <button
                onClick={handleDone}
                className="px-8 py-3 bg-purple-500 hover:bg-purple-600 text-white rounded-xl font-medium transition-colors"
            >
                Done
            </button>
        </motion.div>
    );

    const renderErrorView = () => (
        <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center text-center px-8 py-10"
        >
            <div className="w-24 h-24 rounded-full bg-red-500/20 flex items-center justify-center mb-6">
                <AlertCircle size={56} className="text-red-400" />
            </div>
            <h2 className="text-2xl font-bold text-textPrimary mb-2">Import Failed</h2>
            <p className="text-red-400 mb-6 max-w-sm">{error}</p>
            <div className="flex gap-3">
                <button
                    onClick={() => {
                        resetWhisperImportState();
                    }}
                    className="px-6 py-3 bg-purple-500 hover:bg-purple-600 text-white rounded-xl font-medium transition-colors"
                >
                    Try Again
                </button>
                <button
                    onClick={handleDone}
                    className="px-6 py-3 bg-glass border border-borderLight hover:border-purple-500 text-textPrimary rounded-xl font-medium transition-colors"
                >
                    Close
                </button>
            </div>
        </motion.div>
    );

    if (!isOpen) return null;

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={handleClose}
        >
            <motion.div
                initial={{ scale: 0.95, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 20 }}
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                className="bg-background border border-borderLight rounded-2xl shadow-2xl w-[480px] overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-borderSubtle">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                            <Sparkles size={16} className="text-purple-400" />
                        </div>
                        <span className="text-textPrimary font-semibold">Import Whispers</span>
                    </div>
                    <button
                        onClick={handleClose}
                        className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-colors"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Content */}
                <AnimatePresence mode="wait">
                    {importStatus === 'idle' && renderIdleView()}
                    {importStatus === 'importing' && renderImportingView()}
                    {importStatus === 'success' && renderSuccessView()}
                    {importStatus === 'error' && renderErrorView()}
                </AnimatePresence>
            </motion.div>
        </motion.div>
    );
};

export default WhisperImportWizard;
