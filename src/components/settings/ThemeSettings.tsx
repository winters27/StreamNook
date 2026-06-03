import { useState, useEffect } from 'react';
import { useAppStore } from '../../stores/AppStore';
import { themes, themeCategories, getThemeById, applyTheme, customThemeToTheme, getThemeByIdWithCustom, applyGlassStrength, DEFAULT_GLASS_TRANSPARENCY, Theme } from '../../themes';
import { Check, Palette, Sparkles, Moon, Leaf, Code, Star, Plus, Edit2, PaintBucket, Droplets } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import ThemeCreator from './ThemeCreator';
import type { CustomTheme } from '../../types';

const getCategoryIcon = (categoryId: string) => {
    switch (categoryId) {
        case 'signature':
            return <Star size={16} />;
        case 'universal':
            return <Sparkles size={16} />;
        case 'modern':
            return <Moon size={16} />;
        case 'classic':
            return <Code size={16} />;
        case 'cozy':
            return <Leaf size={16} />;
        default:
            return <Palette size={16} />;
    }
};

interface ThemeCardProps {
    theme: Theme;
    isSelected: boolean;
    onSelect: () => void;
    isCustom?: boolean;
    onEdit?: () => void;
}

const ThemeCard = ({ theme, isSelected, onSelect, isCustom, onEdit }: ThemeCardProps) => {
    const { palette } = theme;

    return (
        <button
            onClick={onSelect}
            className={`
                relative w-full p-3 rounded-lg transition-all duration-200
                border-2 text-left group
                ${isSelected
                    ? 'border-accent ring-2 ring-accent/30'
                    : 'border-borderSubtle hover:border-borderLight'
                }
            `}
            style={{
                backgroundColor: palette.background,
            }}
        >
            {/* Color Preview */}
            <div className="flex gap-1.5 mb-2">
                <Tooltip content="Accent" side="top">
                <div
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: palette.accent }}
                />
                </Tooltip>
                <Tooltip content="Pink" side="top">
                <div
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: palette.highlight.pink }}
                />
                </Tooltip>
                <Tooltip content="Purple" side="top">
                <div
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: palette.highlight.purple }}
                />
                </Tooltip>
                <Tooltip content="Blue" side="top">
                <div
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: palette.highlight.blue }}
                />
                </Tooltip>
                <Tooltip content="Green" side="top">
                <div
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: palette.highlight.green }}
                />
                </Tooltip>
            </div>

            {/* Theme Info */}
            <div className="mb-1 flex items-center justify-between">
                <h4
                    className="font-semibold text-sm"
                    style={{ color: palette.textPrimary }}
                >
                    {theme.name}
                </h4>
                {isCustom && onEdit && (
                    <Tooltip content="Edit theme" side="top">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onEdit();
                        }}
                        className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/10"
                    >
                        <Edit2 size={12} style={{ color: palette.textSecondary }} />
                    </button>
                    </Tooltip>
                )}
            </div>

            <p
                className="text-xs leading-relaxed line-clamp-2"
                style={{ color: palette.textSecondary }}
            >
                {theme.description}
            </p>

            {/* Selection Indicator */}
            {isSelected && (
                <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-accent flex items-center justify-center">
                    <Check size={12} className="text-background" strokeWidth={3} />
                </div>
            )}

            {/* Custom Badge */}
            {isCustom && (
                <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent/20 text-accent">
                    Custom
                </div>
            )}

            {/* Hover effect overlay */}
            <div
                className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                style={{
                    background: `linear-gradient(135deg, ${palette.accent}10 0%, transparent 50%)`,
                }}
            />
        </button>
    );
};

const ThemeSettings = () => {
    const { settings, updateSettings } = useAppStore();
    const currentThemeId = settings.theme || 'winters-glass';
    const customThemes = settings.custom_themes || [];
    
    const [isCreating, setIsCreating] = useState(false);
    const [editingTheme, setEditingTheme] = useState<CustomTheme | undefined>(undefined);

    const glassTransparency = settings.glass_transparency ?? DEFAULT_GLASS_TRANSPARENCY;

    // Track the slider locally so the thumb follows the cursor instantly. The
    // persisted value only catches up on release, so we mirror it here for the
    // controlled input and pick up any changes made from another window.
    const [liveGlass, setLiveGlass] = useState(glassTransparency);
    useEffect(() => {
        setLiveGlass(glassTransparency);
    }, [glassTransparency]);

    // While dragging: only move the thumb and repaint via the CSS variable (cheap).
    // No disk write — persisting on every tick is what made the slider stutter.
    const handleGlassInput = (value: number) => {
        setLiveGlass(value);
        applyGlassStrength(value);
    };

    // On release: persist once. updateSettings writes to disk, broadcasts to other
    // windows, and re-renders the whole app, so it must not run mid-drag.
    const commitGlass = (value: number) => {
        if (value === glassTransparency) return;
        updateSettings({ ...settings, glass_transparency: value });
    };

    // Get current theme (could be custom or built-in)
    const currentTheme = getThemeByIdWithCustom(currentThemeId, customThemes);

    const handleThemeChange = (themeId: string) => {
        const theme = getThemeByIdWithCustom(themeId, customThemes);
        if (theme) {
            // Apply theme immediately
            applyTheme(theme);
            // Save to settings
            updateSettings({ ...settings, theme: themeId });
        }
    };

    const handleSaveCustomTheme = (theme: CustomTheme) => {
        const existingIndex = customThemes.findIndex((t) => t.id === theme.id);
        let newCustomThemes: CustomTheme[];

        if (existingIndex >= 0) {
            // Update existing
            newCustomThemes = [...customThemes];
            newCustomThemes[existingIndex] = theme;
        } else {
            // Add new
            newCustomThemes = [...customThemes, theme];
        }

        // Apply the theme
        applyTheme(customThemeToTheme(theme));

        // Save to settings
        updateSettings({
            ...settings,
            theme: theme.id,
            custom_themes: newCustomThemes,
        });

        setIsCreating(false);
        setEditingTheme(undefined);
    };

    const handleDeleteCustomTheme = (themeId: string) => {
        const newCustomThemes = customThemes.filter((t) => t.id !== themeId);
        
        // If the deleted theme was active, switch to default
        const newActiveTheme = currentThemeId === themeId ? 'winters-glass' : currentThemeId;
        const themeToApply = getThemeById(newActiveTheme) || themes[0];
        applyTheme(themeToApply);

        updateSettings({
            ...settings,
            theme: newActiveTheme,
            custom_themes: newCustomThemes,
        });

        setIsCreating(false);
        setEditingTheme(undefined);
    };

    const handleEditTheme = (theme: CustomTheme) => {
        setEditingTheme(theme);
        setIsCreating(true);
    };

    // Show creator view
    if (isCreating) {
        return (
            <ThemeCreator
                editingTheme={editingTheme}
                onClose={() => {
                    setIsCreating(false);
                    setEditingTheme(undefined);
                }}
                onSave={handleSaveCustomTheme}
                onDelete={editingTheme ? handleDeleteCustomTheme : undefined}
            />
        );
    }

    return (
        <div className="space-y-5">
            {/* Header Row */}
            <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                    <Palette size={18} className="text-accent" />
                    <h3 className="text-base font-semibold text-textPrimary">Theme</h3>
                </div>
                <div className="flex items-center gap-3">
                    {currentTheme && (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface/50">
                            <div
                                className="w-4 h-4 rounded-full"
                                style={{ backgroundColor: currentTheme.palette.accent }}
                            />
                            <span className="text-xs text-textSecondary font-medium">{currentTheme.name}</span>
                        </div>
                    )}
                    <button
                        onClick={() => setIsCreating(true)}
                        className="flex items-center gap-2 px-3 py-1.5 glass-button text-sm font-medium"
                    >
                        <Plus size={14} />
                        Create Theme
                    </button>
                </div>
            </div>

            {/* Global Glassiness — scales how see-through panels are across every theme.
                100% is the signature frosted look; lower makes panels progressively solid. */}
            <div className="glass-panel rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Droplets size={16} className="text-accent" />
                        <h4 className="text-sm font-semibold text-textPrimary">Glassiness</h4>
                    </div>
                    <span className="text-xs text-textMuted font-mono">{liveGlass}%</span>
                </div>
                <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={liveGlass}
                    onChange={(e) => handleGlassInput(parseInt(e.target.value, 10))}
                    onPointerUp={(e) => commitGlass(parseInt(e.currentTarget.value, 10))}
                    onKeyUp={(e) => commitGlass(parseInt(e.currentTarget.value, 10))}
                    className="w-full accent-accent cursor-pointer"
                />
                <p className="text-xs text-textMuted">
                    How see-through panels are, for every theme. 100% is the signature frosted look; lower makes panels more solid.
                </p>
            </div>

            {/* Custom Themes Section */}
            {customThemes.length > 0 && (
                <div className="space-y-3">
                    <div className="flex items-center gap-2">
                        <PaintBucket size={16} className="text-accent" />
                        <h4 className="text-sm font-semibold text-textSecondary">Your Themes</h4>
                        <span className="text-xs text-textMuted">— Custom creations</span>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                        {customThemes.map((customTheme) => {
                            const runtimeTheme = customThemeToTheme(customTheme);
                            return (
                                <ThemeCard
                                    key={customTheme.id}
                                    theme={runtimeTheme}
                                    isSelected={currentThemeId === customTheme.id}
                                    onSelect={() => handleThemeChange(customTheme.id)}
                                    isCustom={true}
                                    onEdit={() => handleEditTheme(customTheme)}
                                />
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Theme Categories */}
            {themeCategories.map((category) => {
                const categoryThemes = themes.filter((t) => t.category === category.id);
                if (categoryThemes.length === 0) return null;

                return (
                    <div key={category.id} className="space-y-3">
                        <div className="flex items-center gap-2">
                            <span className="text-textMuted">{getCategoryIcon(category.id)}</span>
                            <h4 className="text-sm font-semibold text-textSecondary">{category.name}</h4>
                            <span className="text-xs text-textMuted">— {category.description}</span>
                        </div>

                        <div className="grid grid-cols-3 gap-3">
                            {categoryThemes.map((theme) => (
                                <ThemeCard
                                    key={theme.id}
                                    theme={theme}
                                    isSelected={currentThemeId === theme.id}
                                    onSelect={() => handleThemeChange(theme.id)}
                                />
                            ))}
                        </div>
                    </div>
                );
            })}

            {/* Theme Tips */}
            <div className="p-3 rounded-lg bg-surface/50 border border-borderSubtle mb-4">
                <p className="text-xs text-textMuted flex items-center gap-2">
                    <Sparkles size={14} />
                    Tip: Create a custom theme to perfectly match your setup!
                </p>
            </div>
        </div>
    );
};

export default ThemeSettings;
