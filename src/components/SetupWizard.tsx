import { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Check,
    ExternalLink,
    ChevronLeft,
    Loader2,
    User,
    Package,
    AlertCircle,
    MessageCircle,
    Wand2,
    CheckCircle2,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useAppStore } from '../stores/AppStore';
import streamnookLogo from '../assets/streamnook-logo.png';

import { Logger } from '../utils/logger';

const STEP_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];
const STEP_DURATION = 0.4;
const STEP_COUNT = 6;

interface SetupWizardProps {
    isOpen: boolean;
    onClose: () => void;
}

interface StepStatus {
    componentsInstalled: boolean | null;
    extractionError: string | null;
    dropsAuthenticated: boolean;
    mainAuthenticated: boolean;
}

interface DropsDeviceCodeInfo {
    user_code: string;
    verification_uri: string;
    device_code: string;
    interval: number;
    expires_in: number;
}

const SetupWizard = ({ isOpen, onClose }: SetupWizardProps) => {
    const [currentStep, setCurrentStep] = useState(0);
    const [isExtracting, setIsExtracting] = useState(false);
    const [isAuthenticating, setIsAuthenticating] = useState(false);
    const [dropsDeviceCode, setDropsDeviceCode] = useState<DropsDeviceCodeInfo | null>(null);
    const [status, setStatus] = useState<StepStatus>({
        componentsInstalled: null,
        extractionError: null,
        dropsAuthenticated: false,
        mainAuthenticated: false,
    });
    const [error, setError] = useState<string | null>(null);

    const { addToast, settings, updateSettings, isAuthenticated, checkAuthStatus, loginToTwitch, whisperImportState, setWhisperImportState, resetWhisperImportState } = useAppStore();
    const [whisperImportStarted, setWhisperImportStarted] = useState(false);
    const unlistenRefs = useRef<Array<() => void>>([]);

    useEffect(() => {
        return () => {
            unlistenRefs.current.forEach(fn => fn());
            unlistenRefs.current = [];
        };
    }, []);

    const checkComponentsInstalled = useCallback(async () => {
        try {
            const installed = await invoke('check_components_installed') as boolean;
            setStatus(prev => ({ ...prev, componentsInstalled: installed }));
            return installed;
        } catch (e) {
            Logger.error('Failed to check components:', e);
            setStatus(prev => ({ ...prev, componentsInstalled: false }));
            return false;
        }
    }, []);

    const checkDropsAuthStatus = useCallback(async () => {
        try {
            const isDropsAuth = await invoke('is_drops_authenticated') as boolean;
            Logger.debug('[SetupWizard] Drops auth status:', isDropsAuth);
            setStatus(prev => ({ ...prev, dropsAuthenticated: isDropsAuth }));
            return isDropsAuth;
        } catch (e) {
            Logger.error('Failed to check drops auth status:', e);
            setStatus(prev => ({ ...prev, dropsAuthenticated: false }));
            return false;
        }
    }, []);

    const extractComponents = useCallback(async () => {
        setIsExtracting(true);
        setStatus(prev => ({ ...prev, extractionError: null }));
        try {
            await invoke('extract_bundled_components');
            setStatus(prev => ({ ...prev, componentsInstalled: true }));
            addToast('Setup complete!', 'success');
            setCurrentStep(2);
        } catch (e) {
            Logger.error('Failed to extract components:', e);
            const errorMsg = String(e);
            setStatus(prev => ({ ...prev, extractionError: errorMsg }));
            setError(errorMsg);
        } finally {
            setIsExtracting(false);
        }
    }, [settings, updateSettings, addToast]);

    // Initial bundled-component and drops-auth checks fire once per wizard open.
    // Kept off the isAuthenticated dep on purpose: re-running checkComponentsInstalled
    // mid-wizard overwrites a user-picked custom streamlink path (which the bundled
    // check doesn't satisfy), making the Ready step show "skipped" for streamlink even
    // though the user configured it correctly.
    useEffect(() => {
        if (isOpen) {
            checkComponentsInstalled();
            checkDropsAuthStatus();
        }
    }, [isOpen, checkComponentsInstalled, checkDropsAuthStatus]);

    // Mirror auth state into wizard status separately, so signing in doesn't trigger
    // the initial-checks effect above.
    useEffect(() => {
        setStatus(prev => ({ ...prev, mainAuthenticated: isAuthenticated }));
    }, [isAuthenticated]);

    useEffect(() => {
        if (currentStep === 1 && status.componentsInstalled === false && !isExtracting && !status.extractionError) {
            extractComponents();
        } else if (currentStep === 1 && status.componentsInstalled === true) {
            setCurrentStep(2);
        }
    }, [currentStep, status.componentsInstalled, isExtracting, status.extractionError, extractComponents]);

    const openDropsVerificationWindow = useCallback(async (verificationUri: string) => {
        try {
            const existingWindow = await WebviewWindow.getByLabel('drops-login');
            if (existingWindow) {
                await existingWindow.close();
            }
        } catch {
            // Window doesn't exist, continue
        }

        const loginWindow = new WebviewWindow('drops-login', {
            url: verificationUri,
            title: 'Drops Login - Twitch',
            width: 500,
            height: 700,
            center: true,
            resizable: true,
            minimizable: true,
            maximizable: false,
        });

        loginWindow.once('tauri://error', (e) => {
            Logger.error('Failed to open drops login window:', e);
        });
    }, []);

    const handleDropsLogin = useCallback(async () => {
        setIsAuthenticating(true);
        setError(null);
        try {
            const deviceInfo = await invoke('start_drops_device_flow') as DropsDeviceCodeInfo;
            setDropsDeviceCode(deviceInfo);

            await openDropsVerificationWindow(deviceInfo.verification_uri);

            try {
                await invoke('poll_drops_token', {
                    deviceCode: deviceInfo.device_code,
                    interval: deviceInfo.interval,
                    expiresIn: deviceInfo.expires_in,
                });

                try {
                    const dropsWindow = await WebviewWindow.getByLabel('drops-login');
                    if (dropsWindow) {
                        await dropsWindow.close();
                        Logger.debug('Drops login window closed');
                    }
                } catch {
                    // Window doesn't exist, continue
                }

                setStatus(prev => ({ ...prev, dropsAuthenticated: true }));
                setDropsDeviceCode(null);
                addToast('Drops login successful!', 'success');

                try {
                    await invoke('focus_window');
                } catch (focusError) {
                    Logger.error('Failed to focus window:', focusError);
                }

                setTimeout(() => setCurrentStep(3), 500);
            } catch (pollError) {
                Logger.error('Failed to complete drops login:', pollError);
                setError(`Login failed: ${pollError}`);
                setDropsDeviceCode(null);
            }
        } catch (e) {
            Logger.error('Failed to start drops login:', e);
            setError(`Failed to start login: ${e}`);
        } finally {
            setIsAuthenticating(false);
        }
    }, [addToast, openDropsVerificationWindow]);

    const handleMainLogin = useCallback(async () => {
        setIsAuthenticating(true);
        setError(null);
        try {
            await loginToTwitch();

            unlistenRefs.current.forEach(fn => fn());
            unlistenRefs.current = [];

            const unlisten = await listen('twitch-login-complete', async () => {
                await checkAuthStatus();
                setStatus(prev => ({ ...prev, mainAuthenticated: true }));
                setIsAuthenticating(false);

                try {
                    await invoke('focus_window');
                } catch (focusError) {
                    Logger.error('Failed to focus window:', focusError);
                }

                setTimeout(() => setCurrentStep(4), 500);

                unlistenRefs.current.forEach(fn => fn());
                unlistenRefs.current = [];
            });
            const unlistenError = await listen('twitch-login-error', (event) => {
                setError(`Login failed: ${event.payload}`);
                setIsAuthenticating(false);
                unlistenRefs.current.forEach(fn => fn());
                unlistenRefs.current = [];
            });

            unlistenRefs.current = [unlisten, unlistenError];
        } catch (e) {
            Logger.error('Failed to start login:', e);
            setError(`Failed to start login: ${e}`);
            setIsAuthenticating(false);
        }
    }, [loginToTwitch, checkAuthStatus]);

    const handleCompleteSetup = useCallback(async () => {
        try {
            await updateSettings({
                ...settings,
                setup_complete: true,
            });
            onClose();
        } catch (e) {
            Logger.error('Failed to save settings:', e);
            addToast('Failed to save settings', 'error');
        }
    }, [settings, updateSettings, onClose, addToast]);

    // Per-step primary CTA that lives bottom-right. null hides it entirely.
    const primaryAction: { label: string; onClick: () => void; disabled?: boolean } | null = (() => {
        switch (currentStep) {
            case 0:
                return { label: 'Get started', onClick: () => setCurrentStep(1) };
            case 1:
                return null;
            case 2:
            case 3:
            case 4:
                return { label: 'Continue', onClick: () => setCurrentStep(currentStep + 1) };
            case 5:
                return { label: 'Start watching', onClick: handleCompleteSetup };
            default:
                return null;
        }
    })();

    const canGoBack = currentStep > 1 && currentStep < 5;

    const renderStepContent = () => {
        switch (currentStep) {
            case 0:
                return (
                    <>
                        <img
                            src={streamnookLogo}
                            alt=""
                            className="h-28 w-auto mb-10 select-none"
                            draggable={false}
                        />
                        <h1 className="text-5xl font-medium text-textPrimary tracking-tight leading-[1.05] mb-5">
                            Welcome to<br />StreamNook
                        </h1>
                        <p className="text-textSecondary text-base max-w-md mb-8">
                            Yeah yeah, another setup wizard. Five clicks and we'll get out of your way, promise.
                        </p>
                        <img
                            src="https://cdn.7tv.app/emote/01F6NMMEER00015NVG2J8ZH77N/4x.avif"
                            alt=""
                            className="h-24 w-auto select-none"
                            draggable={false}
                        />
                    </>
                );

            case 1: {
                if (status.componentsInstalled === true && !status.extractionError) {
                    return (
                        <>
                            <CheckCircle2 size={64} strokeWidth={1.4} className="text-success mb-10" />
                            <h1 className="text-4xl font-medium text-textPrimary tracking-tight mb-4">
                                Components ready
                            </h1>
                            <p className="text-textSecondary text-base max-w-md">
                                Streamlink and the ad blocker are in place. Moving on.
                            </p>
                        </>
                    );
                }

                return (
                    <>
                        <Loader2 size={56} strokeWidth={1.4} className="text-accent animate-spin mb-10" />
                        <h1 className="text-4xl font-medium text-textPrimary tracking-tight mb-4">
                            Setting things up
                        </h1>
                        <p className="text-textSecondary text-base max-w-md mb-8">
                            Installing Streamlink and the ad blocker. This only takes a moment.
                        </p>
                        <div className="flex flex-col gap-2 w-full max-w-xs">
                            <div className="flex items-center gap-3 glass-panel rounded-lg px-4 py-2.5">
                                <Loader2 size={14} className="text-accent animate-spin flex-shrink-0" />
                                <span className="text-sm text-textSecondary">Streamlink</span>
                            </div>
                            <div className="flex items-center gap-3 glass-panel rounded-lg px-4 py-2.5">
                                <Loader2 size={14} className="text-accent animate-spin flex-shrink-0" />
                                <span className="text-sm text-textSecondary">TTV LOL ad blocker</span>
                            </div>
                        </div>
                    </>
                );
            }

            case 2:
                return (
                    <>
                        {status.dropsAuthenticated ? (
                            <CheckCircle2 size={64} strokeWidth={1.4} className="text-success mb-10" />
                        ) : (
                            <Package size={56} strokeWidth={1.4} className="text-accent mb-10" />
                        )}
                        <h1 className="text-4xl font-medium text-textPrimary tracking-tight mb-4">
                            {status.dropsAuthenticated ? "You're in for Drops" : 'Drops and inventory'}
                        </h1>
                        <p className="text-textSecondary text-base max-w-md mb-8">
                            {status.dropsAuthenticated
                                ? 'Drops will claim themselves while you watch.'
                                : 'Sign in to track Twitch Drops, watch your inventory, and auto-claim rewards.'}
                        </p>

                        {isAuthenticating && dropsDeviceCode && (
                            <div className="glass-panel rounded-xl p-6 mb-6 w-full max-w-sm">
                                <p className="text-sm text-textSecondary mb-3">Enter this code on Twitch</p>
                                <div className="text-4xl font-mono font-bold text-accent tracking-[0.3em] py-2 tabular-nums">
                                    {dropsDeviceCode.user_code}
                                </div>
                                <div className="pt-3 border-t border-borderSubtle mt-3 flex items-center justify-center gap-2 text-xs text-textMuted">
                                    <Loader2 size={13} className="animate-spin" />
                                    <span>Waiting for authorization</span>
                                </div>
                                <button
                                    onClick={() => openDropsVerificationWindow(dropsDeviceCode.verification_uri)}
                                    className="mt-3 inline-flex items-center justify-center gap-1.5 w-full text-xs text-textSecondary hover:text-textPrimary transition-colors"
                                >
                                    <ExternalLink size={12} />
                                    Reopen sign-in window
                                </button>
                            </div>
                        )}

                        {error && (
                            <div className="flex items-center gap-2 text-error text-sm mb-5 px-3 py-2 rounded-lg bg-error/10">
                                <AlertCircle size={15} />
                                <span>{error}</span>
                            </div>
                        )}

                        {!status.dropsAuthenticated && !isAuthenticating && (
                            <button
                                onClick={handleDropsLogin}
                                className="glass-button flex items-center justify-center gap-2 px-6 py-3 text-textPrimary rounded-xl font-medium"
                            >
                                <Package size={17} />
                                Sign in for Drops
                            </button>
                        )}
                    </>
                );

            case 3:
                return (
                    <>
                        {status.mainAuthenticated ? (
                            <CheckCircle2 size={64} strokeWidth={1.4} className="text-success mb-10" />
                        ) : (
                            <User size={56} strokeWidth={1.4} className="text-accent mb-10" />
                        )}
                        <h1 className="text-4xl font-medium text-textPrimary tracking-tight mb-4">
                            {status.mainAuthenticated ? "You're signed in" : 'Sign in to Twitch'}
                        </h1>
                        <p className="text-textSecondary text-base max-w-md mb-8">
                            {status.mainAuthenticated
                                ? 'Your follows, chat, and channel actions are connected.'
                                : 'Connect your account to see your follows, chat, and use channel features.'}
                        </p>

                        {error && (
                            <div className="flex items-center gap-2 text-error text-sm mb-5 px-3 py-2 rounded-lg bg-error/10">
                                <AlertCircle size={15} />
                                <span>{error}</span>
                            </div>
                        )}

                        {!status.mainAuthenticated && (
                            <button
                                onClick={handleMainLogin}
                                disabled={isAuthenticating}
                                className="glass-button flex items-center justify-center gap-2 px-6 py-3 text-textPrimary rounded-xl font-medium disabled:opacity-60"
                            >
                                {isAuthenticating ? (
                                    <>
                                        <Loader2 size={17} className="animate-spin" />
                                        Waiting for sign-in
                                    </>
                                ) : (
                                    <>
                                        <User size={17} />
                                        Sign in with Twitch
                                    </>
                                )}
                            </button>
                        )}
                    </>
                );

            case 4:
                return (
                    <>
                        {whisperImportState.result ? (
                            <CheckCircle2 size={64} strokeWidth={1.4} className="text-success mb-10" />
                        ) : whisperImportState.isImporting ? (
                            <Loader2 size={56} strokeWidth={1.4} className="text-accent animate-spin mb-10" />
                        ) : (
                            <MessageCircle size={56} strokeWidth={1.4} className="text-accent mb-10" />
                        )}
                        <h1 className="text-4xl font-medium text-textPrimary tracking-tight mb-4">
                            {whisperImportState.result
                                ? 'Whispers imported'
                                : whisperImportState.isImporting
                                    ? 'Importing whispers'
                                    : 'Import your whispers'}
                        </h1>
                        <p className="text-textSecondary text-base max-w-md mb-8">
                            {whisperImportState.result
                                ? `${whisperImportState.result.conversations.toLocaleString()} conversations, ${whisperImportState.result.messages.toLocaleString()} messages.`
                                : whisperImportState.isImporting
                                    ? 'Running in the background. You can keep going.'
                                    : 'Pull in your private message history so it lives inside the app.'}
                        </p>

                        {whisperImportState.isImporting && whisperImportState.progress && (
                            <div className="glass-panel rounded-xl p-4 mb-6 w-full max-w-sm">
                                <div className="flex items-center gap-3 mb-2">
                                    <Loader2 size={14} className="text-accent animate-spin flex-shrink-0" />
                                    <span className="text-sm text-textPrimary">{whisperImportState.progress.detail}</span>
                                </div>
                                {whisperImportState.exportProgress && whisperImportState.exportProgress.total > 0 && (
                                    <div className="mt-2">
                                        <div className="flex justify-between text-xs text-textMuted mb-1 tabular-nums">
                                            <span>Progress</span>
                                            <span>{whisperImportState.exportProgress.current + 1}/{whisperImportState.exportProgress.total}</span>
                                        </div>
                                        <div className="h-1 bg-borderSubtle rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-accent rounded-full transition-all duration-300"
                                                style={{ width: `${((whisperImportState.exportProgress.current + 1) / whisperImportState.exportProgress.total) * 100}%` }}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {whisperImportState.error && (
                            <div className="flex items-center gap-2 text-error text-sm mb-5 px-3 py-2 rounded-lg bg-error/10">
                                <AlertCircle size={15} />
                                <span>{whisperImportState.error}</span>
                            </div>
                        )}

                        {!whisperImportState.isImporting && !whisperImportState.result && (
                            <button
                                onClick={async () => {
                                    setWhisperImportStarted(true);
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
                                        await invoke('scrape_whispers');
                                    } catch (err) {
                                        Logger.error('[SetupWizard] Whisper import failed:', err);
                                        setWhisperImportState({
                                            isImporting: false,
                                            error: err instanceof Error ? err.message : String(err)
                                        });
                                    }
                                }}
                                className="glass-button flex items-center justify-center gap-2 px-6 py-3 text-textPrimary rounded-xl font-medium"
                            >
                                <Wand2 size={17} />
                                Start import
                            </button>
                        )}
                    </>
                );

            case 5: {
                const rows: Array<{ ok: boolean; pending?: boolean; label: string }> = [
                    { ok: !!status.componentsInstalled, label: 'Streamlink and ad blocker' },
                    { ok: status.dropsAuthenticated, label: 'Drops sign-in' },
                    { ok: status.mainAuthenticated, label: 'Twitch sign-in' },
                    {
                        ok: !!whisperImportState.result,
                        pending: whisperImportState.isImporting,
                        label: 'Whisper history'
                    },
                ];

                return (
                    <>
                        <div className="relative mb-10">
                            <img
                                src={streamnookLogo}
                                alt=""
                                className="h-24 w-auto select-none"
                                draggable={false}
                            />
                        </div>
                        <h1 className="text-5xl font-medium text-textPrimary tracking-tight leading-[1.05] mb-5">
                            You're all set
                        </h1>
                        <p className="text-textSecondary text-base max-w-md mb-10">
                            StreamNook is ready. Pick a stream and dive in.
                        </p>
                        <div className="flex flex-col gap-1.5 w-full max-w-sm">
                            {rows.map((row) => (
                                <div
                                    key={row.label}
                                    className="flex items-center justify-between px-4 py-2.5 rounded-lg glass-panel"
                                >
                                    <span className="text-sm text-textSecondary">{row.label}</span>
                                    {row.ok ? (
                                        <Check size={15} className="text-success" />
                                    ) : row.pending ? (
                                        <Loader2 size={15} className="text-accent animate-spin" />
                                    ) : (
                                        <span className="text-xs text-textMuted">skipped</span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </>
                );
            }

            default:
                return null;
        }
    };

    if (!isOpen) return null;

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45, ease: STEP_EASE }}
            className="fixed inset-0 z-[60] bg-background overflow-hidden"
        >
            {/* Diffused multi-radial accent wash. Three offset radials at different
                scales blend into each other so there's no single hard transition for
                Mach bands to form on. Combined with the grain layer below this is
                effectively dithered into smoothness. */}
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                    backgroundImage: [
                        'radial-gradient(95% 70% at 50% 18%, rgba(151,177,185,0.075), rgba(151,177,185,0) 78%)',
                        'radial-gradient(65% 50% at 42% 38%, rgba(151,177,185,0.055), rgba(151,177,185,0) 82%)',
                        'radial-gradient(130% 100% at 58% 55%, rgba(151,177,185,0.028), rgba(151,177,185,0) 92%)',
                    ].join(','),
                }}
            />

            {/* Film grain. SVG fractalNoise tiled at 200px and composited with overlay
                so it gently lightens and darkens the canvas in equal measure. Opacity
                tuned low enough that it reads as texture, not visible noise. */}
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0 mix-blend-overlay opacity-[0.18]"
                style={{
                    backgroundImage:
                        "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
                    backgroundRepeat: 'repeat',
                }}
            />

            <div
                data-tauri-drag-region
                className="absolute top-0 left-0 right-0 h-12 z-0"
            />

            <div className="relative h-full w-full flex flex-col">
                <div className="flex-1 flex items-center justify-center px-8 py-16 min-h-0">
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={currentStep}
                            initial={{ opacity: 0, y: 14 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -14 }}
                            transition={{ duration: STEP_DURATION, ease: STEP_EASE }}
                            className="w-full max-w-2xl flex flex-col items-center text-center"
                        >
                            {renderStepContent()}
                        </motion.div>
                    </AnimatePresence>
                </div>

                <div className="relative z-10 flex items-center justify-between px-8 py-6">
                    <div className="flex items-center gap-2">
                        {Array.from({ length: STEP_COUNT }).map((_, idx) => {
                            const isActive = idx === currentStep;
                            const isPast = idx < currentStep;
                            return (
                                <button
                                    key={idx}
                                    onClick={() => isPast && setCurrentStep(idx)}
                                    disabled={!isPast}
                                    aria-label={`Step ${idx + 1}`}
                                    aria-current={isActive ? 'step' : undefined}
                                    className={`h-2 rounded-full transition-all duration-300 ${isActive
                                        ? 'w-10 bg-accent shadow-[0_0_14px_rgba(151,177,185,0.55),0_0_4px_rgba(151,177,185,0.8)]'
                                        : isPast
                                            ? 'w-2 bg-accent/50 hover:bg-accent cursor-pointer'
                                            : 'w-2 bg-borderSubtle cursor-default'
                                        }`}
                                />
                            );
                        })}
                    </div>

                    <div className="flex items-center gap-2">
                        {canGoBack && (
                            <button
                                onClick={() => setCurrentStep(Math.max(0, currentStep - 1))}
                                className="flex items-center gap-1 px-3 py-2 text-sm text-textSecondary hover:text-textPrimary transition-colors rounded-lg"
                            >
                                <ChevronLeft size={15} />
                                Back
                            </button>
                        )}
                        {primaryAction && (
                            <button
                                onClick={primaryAction.onClick}
                                disabled={primaryAction.disabled}
                                className="glass-button px-5 py-2.5 text-textPrimary rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {primaryAction.label}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default SetupWizard;
