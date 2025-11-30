import { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    X,
    Check,
    ExternalLink,
    ChevronRight,
    ChevronLeft,
    Sparkles,
    Download,
    CheckCircle2,
    Loader2,
    RefreshCw,
    Monitor,
    Puzzle,
    User,
    Tv,
    Package,
    AlertCircle
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../stores/AppStore';

interface SetupWizardProps {
    isOpen: boolean;
    onClose: () => void;
}

interface StepStatus {
    streamlinkInstalled: boolean | null;
    streamlinkPath: string;
    ttvlolInstalled: boolean | null;
    dropsAuthenticated: boolean;
    mainAuthenticated: boolean;
}

const SetupWizard = ({ isOpen, onClose }: SetupWizardProps) => {
    const [currentStep, setCurrentStep] = useState(0);
    const [isDownloading, setIsDownloading] = useState(false);
    const [isInstalling, setIsInstalling] = useState(false);
    const [isAuthenticating, setIsAuthenticating] = useState(false);
    const [status, setStatus] = useState<StepStatus>({
        streamlinkInstalled: null,
        streamlinkPath: 'C:\\Program Files\\Streamlink\\bin\\streamlinkw.exe',
        ttvlolInstalled: null,
        dropsAuthenticated: false,
        mainAuthenticated: false,
    });
    const [error, setError] = useState<string | null>(null);

    const { addToast, settings, updateSettings, isAuthenticated, checkAuthStatus, loginToTwitch } = useAppStore();

    const steps = [
        { title: 'Welcome', description: 'Get started with StreamNook', icon: Sparkles },
        { title: 'Download', description: 'Download the video player', icon: Download },
        { title: 'Verify', description: 'Check installation', icon: Monitor },
        { title: 'Ads', description: 'Install TTV LOL plugin', icon: Puzzle },
        { title: 'Drops', description: 'Sign in for drops/inventory', icon: Package },
        { title: 'Login', description: 'Sign in to Twitch', icon: User },
        { title: 'Ready!', description: 'All set up', icon: Tv }
    ];

    // Check Streamlink installation
    const checkStreamlinkInstallation = useCallback(async () => {
        try {
            const isInstalled = await invoke('verify_streamlink_installation', {
                path: status.streamlinkPath
            }) as boolean;
            setStatus(prev => ({ ...prev, streamlinkInstalled: isInstalled }));
            return isInstalled;
        } catch (e) {
            console.error('Failed to verify Streamlink:', e);
            setStatus(prev => ({ ...prev, streamlinkInstalled: false }));
            return false;
        }
    }, [status.streamlinkPath]);

    // Check TTV LOL installation
    const checkTtvlolInstallation = useCallback(async () => {
        try {
            const version = await invoke('get_installed_ttvlol_version') as string | null;
            const isInstalled = version !== null;
            setStatus(prev => ({ ...prev, ttvlolInstalled: isInstalled }));
            return isInstalled;
        } catch (e) {
            console.error('Failed to verify TTV LOL:', e);
            setStatus(prev => ({ ...prev, ttvlolInstalled: false }));
            return false;
        }
    }, []);

    // Initial check on mount
    useEffect(() => {
        if (isOpen) {
            checkStreamlinkInstallation();
            checkTtvlolInstallation();
            setStatus(prev => ({ ...prev, mainAuthenticated: isAuthenticated }));
        }
    }, [isOpen, isAuthenticated, checkStreamlinkInstallation, checkTtvlolInstallation]);

    // Download Streamlink installer
    const handleDownloadStreamlink = useCallback(async () => {
        setIsDownloading(true);
        setError(null);
        try {
            const filePath = await invoke('download_streamlink_installer') as string;
            const downloadsDir = filePath.substring(0, filePath.lastIndexOf('\\'));
            addToast('Streamlink installer downloaded!', 'success', {
                label: 'Open Folder',
                onClick: async () => {
                    try {
                        await invoke('open_browser_url', { url: downloadsDir });
                    } catch (e) {
                        console.error('Failed to open downloads folder:', e);
                    }
                },
            });
            setCurrentStep(2);
        } catch (e) {
            console.error('Failed to download Streamlink:', e);
            setError(`Failed to download: ${e}`);
        } finally {
            setIsDownloading(false);
        }
    }, [addToast]);

    // Open Streamlink download page as fallback
    const handleOpenStreamlinkPage = useCallback(async () => {
        try {
            await open('https://github.com/streamlink/windows-builds/releases/latest');
        } catch (e) {
            window.open('https://github.com/streamlink/windows-builds/releases/latest', '_blank');
        }
    }, []);

    // Install TTV LOL plugin
    const handleInstallTtvlol = useCallback(async () => {
        setIsInstalling(true);
        setError(null);
        try {
            const version = await invoke('download_and_install_ttvlol_plugin') as string;
            addToast(`TTV LOL plugin v${version} installed!`, 'success');
            setStatus(prev => ({ ...prev, ttvlolInstalled: true }));
            await updateSettings({
                ...settings,
                ttvlol_plugin: { enabled: true, installed_version: version },
            });
        } catch (e) {
            console.error('Failed to install TTV LOL:', e);
            setError(`Failed to install: ${e}`);
        } finally {
            setIsInstalling(false);
        }
    }, [addToast, settings, updateSettings]);

    // Handle drops authentication (Android client)
    const handleDropsLogin = useCallback(async () => {
        setIsAuthenticating(true);
        setError(null);
        try {
            await open('https://id.twitch.tv/oauth2/authorize?client_id=kd1unb4b3q4t58fwlpcbzcbnm76a8fp&redirect_uri=https://passport.twitch.tv/authenticate&response_type=code&scope=user:read:email%20openid%20channel:read:subscriptions%20user:read:follows%20user:read:email%20bits:read%20chat:read%20chat:edit%20user:manage:whispers%20user:read:broadcast%20channel_check_subscription%20channel_subscriptions%20channel:read:redemptions%20channel:manage:redemptions%20user:edit:broadcast%20user:read:blocked_users%20user:manage:blocked_users');
            addToast('Complete the login in your browser, then come back here.', 'info');
        } catch (e) {
            console.error('Failed to open Twitch login:', e);
            setError(`Failed to open login page: ${e}`);
        } finally {
            setIsAuthenticating(false);
        }
    }, [addToast]);

    // Handle main app Twitch login
    const handleMainLogin = useCallback(async () => {
        setIsAuthenticating(true);
        setError(null);
        try {
            await loginToTwitch();
            const unlisten = await listen('twitch-login-complete', async () => {
                await checkAuthStatus();
                setStatus(prev => ({ ...prev, mainAuthenticated: true }));
                setIsAuthenticating(false);
                unlisten();
            });
            const unlistenError = await listen('twitch-login-error', (event) => {
                setError(`Login failed: ${event.payload}`);
                setIsAuthenticating(false);
                unlistenError();
            });
        } catch (e) {
            console.error('Failed to start login:', e);
            setError(`Failed to start login: ${e}`);
            setIsAuthenticating(false);
        }
    }, [loginToTwitch, checkAuthStatus]);

    // Complete setup
    const handleCompleteSetup = useCallback(async () => {
        try {
            await updateSettings({
                ...settings,
                streamlink_path: status.streamlinkPath,
                setup_complete: true,
            });
            onClose();
        } catch (e) {
            console.error('Failed to save settings:', e);
            addToast('Failed to save settings', 'error');
        }
    }, [settings, status.streamlinkPath, updateSettings, onClose, addToast]);

    const renderStepContent = () => {
        switch (currentStep) {
            case 0: // Welcome
                return (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="flex flex-col items-center text-center px-8 py-6"
                    >
                        <div className="w-24 h-24 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center mb-6">
                            <Sparkles size={48} className="text-white" />
                        </div>
                        <h2 className="text-2xl font-bold text-textPrimary mb-3">Welcome to StreamNook!</h2>
                        <p className="text-textSecondary mb-6 max-w-md">
                            Let's get you set up. We'll install a couple of things and get you logged in.
                            This only takes a few minutes!
                        </p>
                        <div className="flex flex-col gap-3 w-full max-w-xs">
                            <div className="flex items-center gap-3 text-left p-3 bg-glass rounded-lg">
                                <div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center flex-shrink-0">
                                    <Download size={16} className="text-purple-400" />
                                </div>
                                <span className="text-sm text-textSecondary">Install Streamlink for video playback</span>
                            </div>
                            <div className="flex items-center gap-3 text-left p-3 bg-glass rounded-lg">
                                <div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center flex-shrink-0">
                                    <Puzzle size={16} className="text-purple-400" />
                                </div>
                                <span className="text-sm text-textSecondary">TTV LOL plugin for ad-free viewing</span>
                            </div>
                            <div className="flex items-center gap-3 text-left p-3 bg-glass rounded-lg">
                                <div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center flex-shrink-0">
                                    <User size={16} className="text-purple-400" />
                                </div>
                                <span className="text-sm text-textSecondary">Sign in to your Twitch account</span>
                            </div>
                        </div>
                    </motion.div>
                );

            case 1: // Download Streamlink
                return (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="flex flex-col items-center text-center px-8 py-6"
                    >
                        <div className="w-16 h-16 rounded-full bg-purple-500/20 flex items-center justify-center mb-6">
                            <Download size={28} className="text-purple-400" />
                        </div>
                        <h2 className="text-xl font-bold text-textPrimary mb-3">Download Streamlink</h2>
                        <p className="text-textSecondary mb-6 max-w-md">
                            Streamlink is required to play Twitch streams. Click below to download the installer.
                        </p>
                        {error && (
                            <div className="flex items-center gap-2 text-red-400 text-sm mb-4 p-3 bg-red-500/10 rounded-lg">
                                <AlertCircle size={16} />
                                <span>{error}</span>
                            </div>
                        )}
                        <div className="flex flex-col gap-3 w-full max-w-xs">
                            <button
                                onClick={handleDownloadStreamlink}
                                disabled={isDownloading}
                                className="flex items-center justify-center gap-2 px-6 py-3 bg-purple-500 hover:bg-purple-600 disabled:bg-purple-500/50 text-white rounded-xl font-medium transition-colors"
                            >
                                {isDownloading ? (
                                    <>
                                        <Loader2 size={18} className="animate-spin" />
                                        Downloading...
                                    </>
                                ) : (
                                    <>
                                        <Download size={18} />
                                        Download Installer
                                    </>
                                )}
                            </button>
                            <button
                                onClick={handleOpenStreamlinkPage}
                                className="flex items-center justify-center gap-2 px-4 py-2 text-textSecondary hover:text-textPrimary transition-colors text-sm"
                            >
                                <ExternalLink size={14} />
                                Or download from GitHub
                            </button>
                        </div>
                        <div className="mt-6 p-4 bg-glass rounded-xl w-full max-w-md">
                            <p className="text-xs text-textMuted">
                                💡 After downloading, run the installer with default settings.
                                Install to the default location (C:\Program Files\Streamlink).
                            </p>
                        </div>
                    </motion.div>
                );

            case 2: // Verify Streamlink
                return (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="flex flex-col items-center text-center px-8 py-6"
                    >
                        <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-6 ${status.streamlinkInstalled === true ? 'bg-green-500/20' : status.streamlinkInstalled === false ? 'bg-yellow-500/20' : 'bg-purple-500/20'}`}>
                            {status.streamlinkInstalled === true ? (
                                <CheckCircle2 size={28} className="text-green-400" />
                            ) : status.streamlinkInstalled === false ? (
                                <AlertCircle size={28} className="text-yellow-400" />
                            ) : (
                                <Monitor size={28} className="text-purple-400" />
                            )}
                        </div>
                        <h2 className="text-xl font-bold text-textPrimary mb-3">Verify Installation</h2>
                        <p className="text-textSecondary mb-4">
                            {status.streamlinkInstalled === true
                                ? 'Streamlink is installed and ready!'
                                : status.streamlinkInstalled === false
                                    ? 'Streamlink not found. Please install it first.'
                                    : 'Checking if Streamlink is installed...'}
                        </p>
                        {status.streamlinkInstalled === false && (
                            <div className="w-full max-w-sm mb-4">
                                <label className="block text-sm font-medium text-textSecondary mb-2 text-left">
                                    Custom Install Path (optional)
                                </label>
                                <input
                                    type="text"
                                    value={status.streamlinkPath}
                                    onChange={(e) => setStatus(prev => ({ ...prev, streamlinkPath: e.target.value }))}
                                    className="w-full glass-input text-textPrimary text-sm px-3 py-2"
                                    placeholder="C:\Program Files\Streamlink\bin\streamlinkw.exe"
                                />
                            </div>
                        )}
                        <button
                            onClick={checkStreamlinkInstallation}
                            className={`flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium transition-colors ${status.streamlinkInstalled === true ? 'bg-green-500 text-white' : 'bg-purple-500 hover:bg-purple-600 text-white'}`}
                        >
                            <RefreshCw size={18} />
                            {status.streamlinkInstalled === true ? 'Verified!' : 'Check Again'}
                        </button>
                        {status.streamlinkInstalled === false && (
                            <p className="text-xs text-textMuted mt-4">
                                Make sure you've run the installer and it completed successfully.
                            </p>
                        )}
                    </motion.div>
                );

            case 3: // TTV LOL Plugin
                return (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="flex flex-col items-center text-center px-8 py-6"
                    >
                        <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-6 ${status.ttvlolInstalled ? 'bg-green-500/20' : 'bg-purple-500/20'}`}>
                            {status.ttvlolInstalled ? (
                                <CheckCircle2 size={28} className="text-green-400" />
                            ) : (
                                <Puzzle size={28} className="text-purple-400" />
                            )}
                        </div>
                        <h2 className="text-xl font-bold text-textPrimary mb-3">TTV LOL Ad Blocker</h2>
                        <p className="text-textSecondary mb-6 max-w-md">
                            {status.ttvlolInstalled
                                ? 'TTV LOL plugin is installed! Enjoy ad-free streams.'
                                : 'This plugin blocks Twitch ads. Highly recommended!'}
                        </p>
                        {error && (
                            <div className="flex items-center gap-2 text-red-400 text-sm mb-4 p-3 bg-red-500/10 rounded-lg">
                                <AlertCircle size={16} />
                                <span>{error}</span>
                            </div>
                        )}
                        {!status.ttvlolInstalled ? (
                            <button
                                onClick={handleInstallTtvlol}
                                disabled={isInstalling || !status.streamlinkInstalled}
                                className="flex items-center justify-center gap-2 px-6 py-3 bg-purple-500 hover:bg-purple-600 disabled:bg-purple-500/50 text-white rounded-xl font-medium transition-colors"
                            >
                                {isInstalling ? (
                                    <>
                                        <Loader2 size={18} className="animate-spin" />
                                        Installing...
                                    </>
                                ) : (
                                    <>
                                        <Download size={18} />
                                        Install Plugin
                                    </>
                                )}
                            </button>
                        ) : (
                            <div className="flex items-center gap-2 text-green-400">
                                <CheckCircle2 size={20} />
                                <span className="font-medium">Plugin Installed!</span>
                            </div>
                        )}
                        {!status.streamlinkInstalled && (
                            <p className="text-xs text-yellow-400 mt-4">
                                ⚠️ Please install Streamlink first before installing this plugin.
                            </p>
                        )}
                        <button
                            onClick={() => setCurrentStep(4)}
                            className="mt-4 text-sm text-textSecondary hover:text-textPrimary transition-colors"
                        >
                            Skip for now →
                        </button>
                    </motion.div>
                );

            case 4: // Drops Login (Android client)
                return (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="flex flex-col items-center text-center px-8 py-6"
                    >
                        <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-6 ${status.dropsAuthenticated ? 'bg-green-500/20' : 'bg-purple-500/20'}`}>
                            {status.dropsAuthenticated ? (
                                <CheckCircle2 size={28} className="text-green-400" />
                            ) : (
                                <Package size={28} className="text-purple-400" />
                            )}
                        </div>
                        <h2 className="text-xl font-bold text-textPrimary mb-3">Drops & Inventory Login</h2>
                        <p className="text-textSecondary mb-2 max-w-md">
                            Sign in to access Twitch Drops, inventory, and auto-claim features.
                        </p>
                        <p className="text-textMuted text-xs mb-6 max-w-md">
                            This opens a browser login. After signing in, return here and click "I've Logged In".
                        </p>
                        {error && (
                            <div className="flex items-center gap-2 text-red-400 text-sm mb-4 p-3 bg-red-500/10 rounded-lg">
                                <AlertCircle size={16} />
                                <span>{error}</span>
                            </div>
                        )}
                        <div className="flex flex-col gap-3 w-full max-w-xs">
                            {!status.dropsAuthenticated ? (
                                <>
                                    <button
                                        onClick={handleDropsLogin}
                                        disabled={isAuthenticating}
                                        className="flex items-center justify-center gap-2 px-6 py-3 bg-purple-500 hover:bg-purple-600 disabled:bg-purple-500/50 text-white rounded-xl font-medium transition-colors"
                                    >
                                        {isAuthenticating ? (
                                            <>
                                                <Loader2 size={18} className="animate-spin" />
                                                Opening Browser...
                                            </>
                                        ) : (
                                            <>
                                                <ExternalLink size={18} />
                                                Sign In for Drops
                                            </>
                                        )}
                                    </button>
                                    <button
                                        onClick={() => setStatus(prev => ({ ...prev, dropsAuthenticated: true }))}
                                        className="flex items-center justify-center gap-2 px-4 py-2 bg-glass border border-borderLight hover:border-purple-500 text-textSecondary hover:text-textPrimary rounded-xl transition-all"
                                    >
                                        <Check size={16} />
                                        I've Logged In
                                    </button>
                                </>
                            ) : (
                                <div className="flex items-center justify-center gap-2 text-green-400">
                                    <CheckCircle2 size={20} />
                                    <span className="font-medium">Drops Login Complete!</span>
                                </div>
                            )}
                        </div>
                        <button
                            onClick={() => setCurrentStep(5)}
                            className="mt-4 text-sm text-textSecondary hover:text-textPrimary transition-colors"
                        >
                            Skip for now →
                        </button>
                    </motion.div>
                );

            case 5: // Main App Login
                return (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="flex flex-col items-center text-center px-8 py-6"
                    >
                        <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-6 ${status.mainAuthenticated ? 'bg-green-500/20' : 'bg-purple-500/20'}`}>
                            {status.mainAuthenticated ? (
                                <CheckCircle2 size={28} className="text-green-400" />
                            ) : (
                                <User size={28} className="text-purple-400" />
                            )}
                        </div>
                        <h2 className="text-xl font-bold text-textPrimary mb-3">Sign In to StreamNook</h2>
                        <p className="text-textSecondary mb-2 max-w-md">
                            Sign in to access your followed streams, chat, and more.
                        </p>
                        <p className="text-textMuted text-xs mb-6 max-w-md">
                            Uses Twitch Device Code login - a code will appear for you to enter on Twitch.
                        </p>
                        {error && (
                            <div className="flex items-center gap-2 text-red-400 text-sm mb-4 p-3 bg-red-500/10 rounded-lg">
                                <AlertCircle size={16} />
                                <span>{error}</span>
                            </div>
                        )}
                        {!status.mainAuthenticated ? (
                            <button
                                onClick={handleMainLogin}
                                disabled={isAuthenticating}
                                className="flex items-center justify-center gap-2 px-6 py-3 bg-purple-500 hover:bg-purple-600 disabled:bg-purple-500/50 text-white rounded-xl font-medium transition-colors"
                            >
                                {isAuthenticating ? (
                                    <>
                                        <Loader2 size={18} className="animate-spin" />
                                        Waiting for Login...
                                    </>
                                ) : (
                                    <>
                                        <User size={18} />
                                        Sign In with Twitch
                                    </>
                                )}
                            </button>
                        ) : (
                            <div className="flex items-center justify-center gap-2 text-green-400">
                                <CheckCircle2 size={20} />
                                <span className="font-medium">Signed In!</span>
                            </div>
                        )}
                        <button
                            onClick={() => setCurrentStep(6)}
                            className="mt-4 text-sm text-textSecondary hover:text-textPrimary transition-colors"
                        >
                            Skip for now →
                        </button>
                    </motion.div>
                );

            case 6: // Complete
                return (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="flex flex-col items-center text-center px-8 py-6"
                    >
                        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-green-500 to-emerald-500 flex items-center justify-center mb-6">
                            <CheckCircle2 size={40} className="text-white" />
                        </div>
                        <h2 className="text-2xl font-bold text-textPrimary mb-3">You're All Set!</h2>
                        <p className="text-textSecondary mb-6 max-w-md">
                            StreamNook is ready to use. Enjoy watching your favorite streams!
                        </p>
                        <div className="flex flex-col gap-2 w-full max-w-xs mb-6">
                            <div className={`flex items-center gap-3 p-3 rounded-lg ${status.streamlinkInstalled ? 'bg-green-500/10' : 'bg-yellow-500/10'}`}>
                                {status.streamlinkInstalled ? (
                                    <CheckCircle2 size={18} className="text-green-400" />
                                ) : (
                                    <AlertCircle size={18} className="text-yellow-400" />
                                )}
                                <span className="text-sm text-textSecondary">
                                    Streamlink {status.streamlinkInstalled ? 'installed' : 'not installed'}
                                </span>
                            </div>
                            <div className={`flex items-center gap-3 p-3 rounded-lg ${status.ttvlolInstalled ? 'bg-green-500/10' : 'bg-gray-500/10'}`}>
                                {status.ttvlolInstalled ? (
                                    <CheckCircle2 size={18} className="text-green-400" />
                                ) : (
                                    <X size={18} className="text-gray-400" />
                                )}
                                <span className="text-sm text-textSecondary">
                                    TTV LOL {status.ttvlolInstalled ? 'installed' : 'not installed'}
                                </span>
                            </div>
                            <div className={`flex items-center gap-3 p-3 rounded-lg ${status.mainAuthenticated ? 'bg-green-500/10' : 'bg-gray-500/10'}`}>
                                {status.mainAuthenticated ? (
                                    <CheckCircle2 size={18} className="text-green-400" />
                                ) : (
                                    <X size={18} className="text-gray-400" />
                                )}
                                <span className="text-sm text-textSecondary">
                                    Twitch {status.mainAuthenticated ? 'signed in' : 'not signed in'}
                                </span>
                            </div>
                        </div>
                        <button
                            onClick={handleCompleteSetup}
                            className="flex items-center justify-center gap-2 px-8 py-3 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white rounded-xl font-medium transition-all shadow-lg"
                        >
                            <Tv size={18} />
                            Start Watching
                        </button>
                    </motion.div>
                );

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
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        >
            <motion.div
                initial={{ scale: 0.95, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 20 }}
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                className="bg-background border border-borderLight rounded-2xl shadow-2xl w-[520px] overflow-hidden"
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-borderSubtle">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                            <Sparkles size={16} className="text-purple-400" />
                        </div>
                        <span className="text-textPrimary font-semibold">First Time Setup</span>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 text-textSecondary hover:text-textPrimary hover:bg-glass rounded-lg transition-colors"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Progress Steps */}
                <div className="px-6 py-4 border-b border-borderSubtle">
                    <div className="flex items-center">
                        {steps.map((step, index) => (
                            <div key={step.title} className="flex items-center flex-1 last:flex-none">
                                <div className="flex flex-col items-center">
                                    <div
                                        className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${index < currentStep
                                            ? 'bg-green-500 text-white'
                                            : index === currentStep
                                                ? 'bg-purple-500 text-white'
                                                : 'bg-glass text-textMuted'
                                            }`}
                                    >
                                        {index < currentStep ? (
                                            <Check size={14} />
                                        ) : (
                                            <step.icon size={14} />
                                        )}
                                    </div>
                                    <span className={`text-[10px] mt-1 whitespace-nowrap ${index === currentStep ? 'text-purple-400' : 'text-textMuted'}`}>
                                        {step.title}
                                    </span>
                                </div>
                                {index < steps.length - 1 && (
                                    <div className={`flex-1 h-0.5 mx-2 mt-[-12px] ${index < currentStep ? 'bg-green-500' : 'bg-borderSubtle'}`} />
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Content */}
                <div className="min-h-[360px] flex items-center justify-center">
                    <AnimatePresence mode="wait">
                        {renderStepContent()}
                    </AnimatePresence>
                </div>

                {/* Footer Navigation */}
                <div className="flex items-center justify-between px-6 py-4 border-t border-borderSubtle">
                    <button
                        onClick={() => setCurrentStep(Math.max(0, currentStep - 1))}
                        disabled={currentStep === 0 || currentStep === 6}
                        className="flex items-center gap-2 px-4 py-2 text-textSecondary hover:text-textPrimary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                        <ChevronLeft size={16} />
                        Back
                    </button>
                    {currentStep < steps.length - 1 ? (
                        <button
                            onClick={() => setCurrentStep(currentStep + 1)}
                            className="flex items-center gap-2 px-5 py-2 bg-purple-500 hover:bg-purple-600 text-white rounded-lg font-medium transition-colors"
                        >
                            Next
                            <ChevronRight size={16} />
                        </button>
                    ) : null}
                </div>
            </motion.div>
        </motion.div>
    );
};

export default SetupWizard;
