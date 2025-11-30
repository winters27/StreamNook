import { useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    X,
    Copy,
    Check,
    ExternalLink,
    Upload,
    FileJson,
    ChevronRight,
    ChevronLeft,
    Sparkles,
    Terminal,
    MousePointer,
    Download,
    CheckCircle2,
    AlertCircle,
    Loader2,
    MessageCircle,
    HelpCircle
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';

interface WhisperImportWizardProps {
    isOpen: boolean;
    onClose: () => void;
    onImport: (file: File) => Promise<void>;
}

// The minified scraper script for easy copying
const SCRAPER_SCRIPT = `// StreamNook Whisper Exporter v13
(async function(){const s={title:"font-size:16px;font-weight:bold;color:#a855f7",subtitle:"font-size:12px;color:#94a3b8",step:"font-size:13px;font-weight:bold;color:#60a5fa",success:"font-size:13px;color:#34d399",warning:"font-size:12px;color:#fbbf24",error:"font-size:13px;color:#f87171",progress:"font-size:12px;color:#a78bfa",info:"font-size:11px;color:#64748b",highlight:"font-size:12px;color:#f0abfc;font-weight:bold"},l=(t,e="")=>console.log("%c"+t,e),p=(c,t,w=20)=>{const f=Math.round(c/t*w);return"["+"█".repeat(f)+"░".repeat(w-f)+"] "+c+"/"+t};console.clear();l("","");l("  ✨ StreamNook Whisper Exporter",s.title);l("  Your whisper history, exported safely",s.subtitle);l("","");l("  ─────────────────────────────────────",s.info);l("  💜 This runs entirely in your browser",s.info);l("  🔒 No data is sent anywhere",s.info);l("  ⏱️  Takes 2-5 minutes depending on history",s.info);l("  ─────────────────────────────────────",s.info);l("","");const e={version:1,exportedAt:new Date().toISOString(),myUserId:null,myUsername:null,conversations:[]},w=t=>new Promise(r=>setTimeout(r,t)),g=()=>{const p=document.querySelector('path[d="M9.828 17 12 19.172 14.172 17H19V5H5v12h4.828ZM12 22l-3-3H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4l-3 3Z"]');return p?p.closest("button")||p.closest('[role="button"]'):document.querySelector('[data-a-target="whisper-box-button"]')},L=()=>{for(const el of document.querySelectorAll(".scrollable-area"))if(el.querySelector('[class*="whispers-list-item"]'))return el;return null},O=async()=>{let list=L();if(list?.offsetParent)return list;const btn=g();if(!btn)return null;btn.click();await w(1500);list=L();if(list?.offsetParent)return list;btn.click();await w(1500);return L()},C=async()=>{const btn=document.querySelector('button[aria-label="Close"][data-a-target^="thread-close-button"]');if(btn){btn.click();await w(800);return true}return false};try{const m=document.querySelector('[data-a-target="user-menu-toggle"]')?.querySelector("img");if(m?.alt){e.myUsername=m.alt.replace("'s Avatar","").replace("'s avatar","");l("  👤 Logged in as: "+e.myUsername,s.highlight);l("","")}}catch{}l("  📂 Step 1/4: Opening whispers panel...",s.step);let list=await O();if(!list){l("","");l("  ❌ Could not open whisper panel",s.error);l("  → Make sure you're on twitch.tv/messages",s.info);return}l("  ✓ Panel opened successfully",s.success);l("","");l("  🔍 Step 2/4: Finding your conversations...",s.step);const users=[];await C();list.scrollTop=0;await w(500);let ph=0,nc=0;for(let i=0;i<200;i++){document.querySelectorAll('[class*="whispers-list-item__user-name"]').forEach(el=>{const n=el.getAttribute("title")||el.textContent.trim();if(n&&!users.includes(n))users.push(n)});list.scrollTop+=600;await w(250);const h=list.scrollHeight;if(Math.ceil(list.scrollTop+list.clientHeight)>=h-50){if(h===ph){nc++;if(nc>6)break}else nc=0}ph=h}l("  ✓ Found "+users.length+" conversations",s.success);l("","");if(users.length===0){l("  ⚠️ No conversations found",s.warning);return}l("  📥 Step 3/4: Exporting messages...",s.step);l("  ⏳ Please don't click anywhere while this runs",s.info);l("","");let total=0;const st=Date.now();for(let i=0;i<users.length;i++){const u=users[i];l("  "+p(i+1,users.length)+" "+u,s.progress);list=await O();if(!list)continue;let t=null;list.scrollTop=0;await w(100);for(let x=0;x<80&&!t;x++){for(const el of document.querySelectorAll('[class*="whispers-list-item__user-name"]')){if((el.getAttribute("title")||el.textContent.trim())===u){t=el;break}}if(!t){list.scrollTop+=500;await w(80);if(list.scrollTop+list.clientHeight>=list.scrollHeight-10)break}}if(!t)continue;(t.closest('[class*="whispers-list-item"]')||t).click();for(let x=0;x<25;x++){await w(200);const h=document.querySelector('.thread-header span[title]');if(h?.getAttribute("title")?.toLowerCase()===u.toLowerCase())break}const msgs=[];const tb=document.querySelector(".whispers-thread-messages__thread-box");const sc=tb?.querySelector(".scrollable-area");if(sc){sc.scrollTop=0;await w(300);sc.scrollTop=sc.scrollHeight;await w(200);const sm=sc.querySelector('[data-a-target="whisper-message"]');const con=sm?.parentElement;if(con){let ts=new Date().toLocaleDateString();for(const c of con.children){if(c.classList.contains("thread-message__timestamp")||c.querySelector(".thread-message__timestamp")){const sp=c.querySelector("span[title]");if(sp)ts=sp.getAttribute("title")}const me=c.getAttribute("data-a-target")==="whisper-message"?c:c.querySelector('[data-a-target="whisper-message"]');if(me){const ne=me.querySelector('[data-a-target="whisper-message-name"]');const te=me.querySelector('.text-fragment,[data-a-target="chat-message-text"]');if(ne&&te){const f=ne.getAttribute("aria-label")||ne.textContent.trim();msgs.push({id:"msg-"+u+"-"+msgs.length,fromUserName:f,content:te.textContent.trim(),sentAt:ts,isSent:e.myUsername&&f.toLowerCase()===e.myUsername.toLowerCase()})}}}}}if(msgs.length>0){e.conversations.push({threadId:"thread-"+u,user:{login:u.toLowerCase(),displayName:u},messages:msgs,lastMessageAt:msgs[msgs.length-1].sentAt});total+=msgs.length}await C()}l("","");l("  ✓ Exported "+total.toLocaleString()+" messages",s.success);l("","");l("  💾 Step 4/4: Saving file...",s.step);const blob=new Blob([JSON.stringify(e,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="streamnook_whispers_v13_"+Date.now()+".json";a.click();const el=Math.round((Date.now()-st)/1e3);l("","");l("  ═══════════════════════════════════════",s.info);l("  ✨ Export Complete!",s.title);l("  ═══════════════════════════════════════",s.info);l("","");l("  📊 "+e.conversations.length+" conversations",s.highlight);l("  💬 "+total.toLocaleString()+" messages",s.highlight);l("  ⏱️  "+el+" seconds",s.highlight);l("","");l("  📁 Check your Downloads folder for:",s.info);l("     streamnook_whispers_v13_*.json",s.progress);l("","");l("  🎉 Now import this file in StreamNook!",s.success);l("","")})();`;

const WhisperImportWizard = ({ isOpen, onClose, onImport }: WhisperImportWizardProps) => {
    const [currentStep, setCurrentStep] = useState(0);
    const [copied, setCopied] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [importStatus, setImportStatus] = useState<'idle' | 'importing' | 'success' | 'error'>('idle');
    const [importError, setImportError] = useState<string | null>(null);
    const [importStats, setImportStats] = useState<{ conversations: number; messages: number } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const steps = [
        {
            title: 'Welcome',
            description: 'Import your Twitch whisper history',
            icon: Sparkles
        },
        {
            title: 'Open Twitch',
            description: 'Navigate to your whispers',
            icon: ExternalLink
        },
        {
            title: 'Copy Script',
            description: 'Copy the export script',
            icon: Terminal
        },
        {
            title: 'Run Script',
            description: 'Paste in browser console',
            icon: MousePointer
        },
        {
            title: 'Import File',
            description: 'Drop the exported file',
            icon: Upload
        }
    ];

    const handleCopyScript = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(SCRAPER_SCRIPT);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    }, []);

    const handleOpenTwitch = useCallback(async () => {
        try {
            await open('https://www.twitch.tv/messages');
        } catch (err) {
            // Fallback: open in new window
            window.open('https://www.twitch.tv/messages', '_blank');
        }
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    }, []);

    const processFile = useCallback(async (file: File) => {
        if (!file.name.endsWith('.json')) {
            setImportError('Please select a JSON file');
            setImportStatus('error');
            return;
        }

        setImportStatus('importing');
        setImportError(null);

        try {
            // Read and validate the file
            const text = await file.text();
            const data = JSON.parse(text);

            if (!data.version || !data.conversations || !Array.isArray(data.conversations)) {
                throw new Error('Invalid whisper export file format');
            }

            const totalMessages = data.conversations.reduce((sum: number, conv: { messages: unknown[] }) => sum + conv.messages.length, 0);
            setImportStats({
                conversations: data.conversations.length,
                messages: totalMessages
            });

            await onImport(file);
            setImportStatus('success');
        } catch (err) {
            console.error('Import error:', err);
            setImportError(err instanceof Error ? err.message : 'Failed to import file');
            setImportStatus('error');
        }
    }, [onImport]);

    const handleDrop = useCallback(async (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);

        const file = e.dataTransfer.files[0];
        if (file) {
            await processFile(file);
        }
    }, [processFile]);

    const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            await processFile(file);
        }
    }, [processFile]);

    const handleClose = useCallback(() => {
        setCurrentStep(0);
        setImportStatus('idle');
        setImportError(null);
        setImportStats(null);
        onClose();
    }, [onClose]);

    const renderStepContent = () => {
        switch (currentStep) {
            case 0:
                return (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="flex flex-col items-center text-center px-8 py-6"
                    >
                        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center mb-6">
                            <MessageCircle size={40} className="text-white" />
                        </div>
                        <h2 className="text-2xl font-bold text-textPrimary mb-3">Import Your Whispers</h2>
                        <p className="text-textSecondary mb-6 max-w-md">
                            Bring your entire Twitch whisper history into StreamNook. This process takes about 2-3 minutes
                            and runs entirely in your browser.
                        </p>
                        <div className="flex flex-col gap-3 w-full max-w-xs">
                            <div className="flex items-center gap-3 text-left p-3 bg-glass rounded-lg">
                                <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0">
                                    <Check size={16} className="text-green-400" />
                                </div>
                                <span className="text-sm text-textSecondary">Your data stays private</span>
                            </div>
                            <div className="flex items-center gap-3 text-left p-3 bg-glass rounded-lg">
                                <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0">
                                    <Check size={16} className="text-green-400" />
                                </div>
                                <span className="text-sm text-textSecondary">Works with all conversations</span>
                            </div>
                            <div className="flex items-center gap-3 text-left p-3 bg-glass rounded-lg">
                                <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0">
                                    <Check size={16} className="text-green-400" />
                                </div>
                                <span className="text-sm text-textSecondary">One-time setup</span>
                            </div>
                        </div>
                    </motion.div>
                );

            case 1:
                return (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="flex flex-col items-center text-center px-8 py-6"
                    >
                        <div className="w-16 h-16 rounded-full bg-purple-500/20 flex items-center justify-center mb-6">
                            <ExternalLink size={28} className="text-purple-400" />
                        </div>
                        <h2 className="text-xl font-bold text-textPrimary mb-3">Open Twitch Whispers</h2>
                        <p className="text-textSecondary mb-6">
                            Click the button below to open your Twitch whispers page. Make sure you're logged in!
                        </p>
                        <button
                            onClick={handleOpenTwitch}
                            className="flex items-center gap-2 px-6 py-3 bg-purple-500 hover:bg-purple-600 text-white rounded-xl font-medium transition-colors"
                        >
                            <ExternalLink size={18} />
                            Open twitch.tv/messages
                        </button>
                        <p className="text-textMuted text-xs mt-4">
                            Opens in your default browser
                        </p>
                    </motion.div>
                );

            case 2:
                return (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="flex flex-col items-center text-center px-8 py-6"
                    >
                        <div className="w-16 h-16 rounded-full bg-purple-500/20 flex items-center justify-center mb-6">
                            <Terminal size={28} className="text-purple-400" />
                        </div>
                        <h2 className="text-xl font-bold text-textPrimary mb-3">Copy the Export Script</h2>
                        <p className="text-textSecondary mb-4">
                            Click to copy the script. You'll paste this in Twitch's browser console.
                        </p>
                        <button
                            onClick={handleCopyScript}
                            className={`flex items-center gap-2 px-6 py-3 rounded-xl font-medium transition-all ${copied
                                ? 'bg-green-500 text-white'
                                : 'bg-glass border border-borderLight hover:border-purple-500 text-textPrimary'
                                }`}
                        >
                            {copied ? (
                                <>
                                    <Check size={18} />
                                    Copied!
                                </>
                            ) : (
                                <>
                                    <Copy size={18} />
                                    Copy Script
                                </>
                            )}
                        </button>
                        <div className="mt-6 p-4 bg-glass rounded-xl w-full max-w-md">
                            <div className="flex items-start gap-2 text-left">
                                <HelpCircle size={16} className="text-purple-400 flex-shrink-0 mt-0.5" />
                                <p className="text-xs text-textMuted">
                                    The script navigates through your whispers and exports them to a JSON file.
                                    It runs entirely in your browser and doesn't send data anywhere.
                                </p>
                            </div>
                        </div>
                    </motion.div>
                );

            case 3:
                return (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="flex flex-col items-center text-center px-8 py-6"
                    >
                        <div className="w-16 h-16 rounded-full bg-purple-500/20 flex items-center justify-center mb-6">
                            <MousePointer size={28} className="text-purple-400" />
                        </div>
                        <h2 className="text-xl font-bold text-textPrimary mb-3">Run the Script</h2>
                        <p className="text-textSecondary mb-6">
                            In your browser on the Twitch page:
                        </p>
                        <div className="flex flex-col gap-3 w-full max-w-sm text-left">
                            <div className="flex items-start gap-3 p-3 bg-glass rounded-lg">
                                <div className="w-6 h-6 rounded-full bg-purple-500 flex items-center justify-center flex-shrink-0 text-white text-xs font-bold">
                                    1
                                </div>
                                <div>
                                    <p className="text-sm text-textPrimary font-medium">Press F12</p>
                                    <p className="text-xs text-textMuted">Opens Developer Tools</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3 p-3 bg-glass rounded-lg">
                                <div className="w-6 h-6 rounded-full bg-purple-500 flex items-center justify-center flex-shrink-0 text-white text-xs font-bold">
                                    2
                                </div>
                                <div>
                                    <p className="text-sm text-textPrimary font-medium">Click "Console" tab</p>
                                    <p className="text-xs text-textMuted">Usually at the top of the panel</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3 p-3 bg-glass rounded-lg">
                                <div className="w-6 h-6 rounded-full bg-purple-500 flex items-center justify-center flex-shrink-0 text-white text-xs font-bold">
                                    3
                                </div>
                                <div>
                                    <p className="text-sm text-textPrimary font-medium">Paste & Press Enter</p>
                                    <p className="text-xs text-textMuted">Ctrl+V then Enter</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3 p-3 bg-glass rounded-lg">
                                <div className="w-6 h-6 rounded-full bg-purple-500 flex items-center justify-center flex-shrink-0 text-white text-xs font-bold">
                                    4
                                </div>
                                <div>
                                    <p className="text-sm text-textPrimary font-medium">Wait for Download</p>
                                    <p className="text-xs text-textMuted">A JSON file will download automatically</p>
                                </div>
                            </div>
                        </div>
                        <p className="text-textMuted text-xs mt-4">
                            💡 Tip: Don't click anywhere while the script runs!
                        </p>
                    </motion.div>
                );

            case 4:
                return (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="flex flex-col items-center text-center px-8 py-6"
                    >
                        {importStatus === 'success' ? (
                            <>
                                <div className="w-20 h-20 rounded-full bg-green-500/20 flex items-center justify-center mb-6">
                                    <CheckCircle2 size={40} className="text-green-400" />
                                </div>
                                <h2 className="text-xl font-bold text-textPrimary mb-3">Import Complete!</h2>
                                <p className="text-textSecondary mb-4">
                                    Your whisper history has been imported successfully.
                                </p>
                                {importStats && (
                                    <div className="flex gap-6 mb-6">
                                        <div className="text-center">
                                            <div className="text-3xl font-bold text-purple-400">{importStats.conversations}</div>
                                            <div className="text-xs text-textMuted">Conversations</div>
                                        </div>
                                        <div className="text-center">
                                            <div className="text-3xl font-bold text-purple-400">{importStats.messages}</div>
                                            <div className="text-xs text-textMuted">Messages</div>
                                        </div>
                                    </div>
                                )}
                                <button
                                    onClick={handleClose}
                                    className="px-6 py-3 bg-purple-500 hover:bg-purple-600 text-white rounded-xl font-medium transition-colors"
                                >
                                    Done
                                </button>
                            </>
                        ) : importStatus === 'error' ? (
                            <>
                                <div className="w-20 h-20 rounded-full bg-red-500/20 flex items-center justify-center mb-6">
                                    <AlertCircle size={40} className="text-red-400" />
                                </div>
                                <h2 className="text-xl font-bold text-textPrimary mb-3">Import Failed</h2>
                                <p className="text-red-400 mb-4">{importError}</p>
                                <button
                                    onClick={() => {
                                        setImportStatus('idle');
                                        setImportError(null);
                                    }}
                                    className="px-6 py-3 bg-glass border border-borderLight hover:border-purple-500 text-textPrimary rounded-xl font-medium transition-colors"
                                >
                                    Try Again
                                </button>
                            </>
                        ) : importStatus === 'importing' ? (
                            <>
                                <div className="w-20 h-20 rounded-full bg-purple-500/20 flex items-center justify-center mb-6">
                                    <Loader2 size={40} className="text-purple-400 animate-spin" />
                                </div>
                                <h2 className="text-xl font-bold text-textPrimary mb-3">Importing...</h2>
                                <p className="text-textSecondary">Processing your whisper history</p>
                            </>
                        ) : (
                            <>
                                <div className="w-16 h-16 rounded-full bg-purple-500/20 flex items-center justify-center mb-6">
                                    <Upload size={28} className="text-purple-400" />
                                </div>
                                <h2 className="text-xl font-bold text-textPrimary mb-3">Import Your File</h2>
                                <p className="text-textSecondary mb-4">
                                    Select the JSON file that was downloaded from Twitch.
                                </p>
                                <p className="text-textMuted text-xs mb-6">
                                    Look in your Downloads folder for a file named like:<br />
                                    <code className="text-purple-400">streamnook_whispers_v13_*.json</code>
                                </p>
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    className="flex items-center gap-3 px-6 py-4 bg-glass border-2 border-dashed border-borderLight hover:border-purple-500 rounded-xl transition-all group cursor-pointer"
                                >
                                    <div className="w-12 h-12 rounded-lg bg-purple-500/20 flex items-center justify-center group-hover:bg-purple-500/30 transition-colors">
                                        <FileJson size={24} className="text-purple-400" />
                                    </div>
                                    <div className="text-left">
                                        <p className="text-textPrimary font-medium">Choose File</p>
                                        <p className="text-textMuted text-xs">Click to browse for JSON file</p>
                                    </div>
                                </button>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".json"
                                    onChange={handleFileSelect}
                                    className="hidden"
                                />
                            </>
                        )}
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
            onClick={handleClose}
        >
            <motion.div
                initial={{ scale: 0.95, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 20 }}
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                className="bg-background border border-borderLight rounded-2xl shadow-2xl w-[520px] overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-borderSubtle">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                            <Download size={16} className="text-purple-400" />
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

                {/* Progress Steps */}
                <div className="px-6 py-4 border-b border-borderSubtle">
                    <div className="flex items-center justify-between">
                        {steps.map((step, index) => (
                            <div key={step.title} className="flex items-center">
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
                                    <span className={`text-[10px] mt-1 ${index === currentStep ? 'text-purple-400' : 'text-textMuted'
                                        }`}>
                                        {step.title}
                                    </span>
                                </div>
                                {index < steps.length - 1 && (
                                    <div className={`w-12 h-0.5 mx-1 mt-[-12px] ${index < currentStep ? 'bg-green-500' : 'bg-borderSubtle'
                                        }`} />
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
                        disabled={currentStep === 0 || importStatus === 'success'}
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
                    ) : importStatus !== 'success' ? (
                        <span className="text-xs text-textMuted">Select your file above</span>
                    ) : null}
                </div>
            </motion.div>
        </motion.div>
    );
};

export default WhisperImportWizard;
