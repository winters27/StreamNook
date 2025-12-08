import { useState, useEffect } from 'react';
import { Layout, Eye, EyeOff, Columns, X } from 'lucide-react';

// Sidebar mode types
export type SidebarMode = 'expanded' | 'compact' | 'hidden' | 'disabled';

// Get sidebar settings from localStorage
export const getSidebarSettings = () => {
    const mode = localStorage.getItem('sidebar-mode') as SidebarMode | null;
    const expandOnHover = localStorage.getItem('sidebar-expand-on-hover');

    return {
        mode: mode || 'compact',
        expandOnHover: expandOnHover ? JSON.parse(expandOnHover) : true
    };
};

// Save sidebar settings to localStorage
export const saveSidebarSettings = (mode: SidebarMode, expandOnHover: boolean) => {
    localStorage.setItem('sidebar-mode', mode);
    localStorage.setItem('sidebar-expand-on-hover', JSON.stringify(expandOnHover));

    // Dispatch custom event so Sidebar component can react
    window.dispatchEvent(new CustomEvent('sidebar-settings-changed', {
        detail: { mode, expandOnHover }
    }));
};

const InterfaceSettings = () => {
    const [sidebarMode, setSidebarMode] = useState<SidebarMode>('compact');
    const [expandOnHover, setExpandOnHover] = useState(true);

    // Load settings on mount
    useEffect(() => {
        const settings = getSidebarSettings();
        setSidebarMode(settings.mode);
        setExpandOnHover(settings.expandOnHover);
    }, []);

    const handleModeChange = (mode: SidebarMode) => {
        setSidebarMode(mode);
        saveSidebarSettings(mode, expandOnHover);
    };

    const handleExpandOnHoverChange = (enabled: boolean) => {
        setExpandOnHover(enabled);
        saveSidebarSettings(sidebarMode, enabled);
    };

    return (
        <div className="space-y-6">
            <div>
                <h3 className="text-lg font-semibold text-textPrimary mb-4 flex items-center gap-2">
                    <Layout size={20} />
                    Interface Settings
                </h3>
            </div>

            {/* Sidebar Section */}
            <div className="space-y-4">
                <h4 className="text-sm font-medium text-textSecondary uppercase tracking-wider">
                    Sidebar
                </h4>

                {/* Sidebar Mode Selection */}
                <div className="space-y-3">
                    <label className="text-sm text-textPrimary font-medium">
                        Sidebar Display Mode
                    </label>
                    <div className="grid grid-cols-4 gap-2">
                        {/* Expanded Mode */}
                        <button
                            onClick={() => handleModeChange('expanded')}
                            className={`p-3 rounded-lg border transition-all flex flex-col items-center gap-2 ${sidebarMode === 'expanded'
                                ? 'border-accent bg-accent/10 text-accent'
                                : 'border-borderSubtle hover:border-border text-textSecondary hover:text-textPrimary'
                                }`}
                        >
                            <Columns size={24} />
                            <span className="text-xs font-medium">Expanded</span>
                            <span className="text-[10px] text-textMuted text-center">
                                Always show full sidebar
                            </span>
                        </button>

                        {/* Compact Mode */}
                        <button
                            onClick={() => handleModeChange('compact')}
                            className={`p-3 rounded-lg border transition-all flex flex-col items-center gap-2 ${sidebarMode === 'compact'
                                ? 'border-accent bg-accent/10 text-accent'
                                : 'border-borderSubtle hover:border-border text-textSecondary hover:text-textPrimary'
                                }`}
                        >
                            <Eye size={24} />
                            <span className="text-xs font-medium">Compact</span>
                            <span className="text-[10px] text-textMuted text-center">
                                Show avatars only
                            </span>
                        </button>

                        {/* Hidden Mode */}
                        <button
                            onClick={() => handleModeChange('hidden')}
                            className={`p-3 rounded-lg border transition-all flex flex-col items-center gap-2 ${sidebarMode === 'hidden'
                                ? 'border-accent bg-accent/10 text-accent'
                                : 'border-borderSubtle hover:border-border text-textSecondary hover:text-textPrimary'
                                }`}
                        >
                            <EyeOff size={24} />
                            <span className="text-xs font-medium">Hidden</span>
                            <span className="text-[10px] text-textMuted text-center">
                                Show on hover only
                            </span>
                        </button>

                        {/* Disabled Mode */}
                        <button
                            onClick={() => handleModeChange('disabled')}
                            className={`p-3 rounded-lg border transition-all flex flex-col items-center gap-2 ${sidebarMode === 'disabled'
                                ? 'border-accent bg-accent/10 text-accent'
                                : 'border-borderSubtle hover:border-border text-textSecondary hover:text-textPrimary'
                                }`}
                        >
                            <X size={24} />
                            <span className="text-xs font-medium">Disabled</span>
                            <span className="text-[10px] text-textMuted text-center">
                                Completely hidden
                            </span>
                        </button>
                    </div>
                </div>

                {/* Expand on Hover - only show for compact mode */}
                {sidebarMode === 'compact' && (
                    <div className="flex items-center justify-between p-3 rounded-lg bg-surface border border-borderSubtle">
                        <div>
                            <label className="text-sm text-textPrimary font-medium">
                                Expand on Hover
                            </label>
                            <p className="text-xs text-textMuted mt-0.5">
                                Sidebar expands when you hover over it
                            </p>
                        </div>
                        <button
                            onClick={() => handleExpandOnHoverChange(!expandOnHover)}
                            className={`w-11 h-6 rounded-full transition-colors ${expandOnHover ? 'bg-accent' : 'bg-borderSubtle'
                                }`}
                        >
                            <div
                                className={`w-5 h-5 rounded-full bg-white shadow-sm transform transition-transform ${expandOnHover ? 'translate-x-5' : 'translate-x-0.5'
                                    }`}
                            />
                        </button>
                    </div>
                )}

                {/* Mode descriptions */}
                <div className="p-3 rounded-lg bg-surface/50 border border-borderSubtle">
                    <p className="text-xs text-textMuted">
                        {sidebarMode === 'expanded' && (
                            <>
                                <strong className="text-textSecondary">Expanded:</strong> The sidebar is always fully visible showing streamer names, game categories, and viewer counts.
                            </>
                        )}
                        {sidebarMode === 'compact' && (
                            <>
                                <strong className="text-textSecondary">Compact:</strong> Shows only profile pictures. {expandOnHover ? 'Hovers to reveal full details.' : 'Click the arrow to expand.'}
                            </>
                        )}
                        {sidebarMode === 'hidden' && (
                            <>
                                <strong className="text-textSecondary">Hidden:</strong> The sidebar is completely hidden until you move your cursor to the left edge of the window. It will stay visible while your cursor is within the sidebar area.
                            </>
                        )}
                        {sidebarMode === 'disabled' && (
                            <>
                                <strong className="text-textSecondary">Disabled:</strong> The sidebar is completely disabled and will not appear at all. Use this option if you prefer a cleaner interface without the streams list.
                            </>
                        )}
                    </p>
                </div>
            </div>
        </div>
    );
};

export default InterfaceSettings;
