import { useAppStore } from '../../stores/AppStore';
import { themes, themeCategories, getThemeById, applyTheme, Theme } from '../../themes';
import { Check, Palette, Sparkles, Moon, Sun, Leaf, Code, Star } from 'lucide-react';

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
}

const ThemeCard = ({ theme, isSelected, onSelect }: ThemeCardProps) => {
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
                <div
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: palette.accent }}
                    title="Accent"
                />
                <div
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: palette.highlight.pink }}
                    title="Pink"
                />
                <div
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: palette.highlight.purple }}
                    title="Purple"
                />
                <div
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: palette.highlight.blue }}
                    title="Blue"
                />
                <div
                    className="w-4 h-4 rounded-full"
                    style={{ backgroundColor: palette.highlight.green }}
                    title="Green"
                />
            </div>

            {/* Theme Info */}
            <div className="mb-1">
                <h4
                    className="font-semibold text-sm"
                    style={{ color: palette.textPrimary }}
                >
                    {theme.name}
                </h4>
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
    const currentTheme = getThemeById(currentThemeId);

    const handleThemeChange = (themeId: string) => {
        const theme = getThemeById(themeId);
        if (theme) {
            // Apply theme immediately
            applyTheme(theme);
            // Save to settings
            updateSettings({ ...settings, theme: themeId });
        }
    };

    return (
        <div className="space-y-5">
            {/* Header Row */}
            <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                    <Palette size={18} className="text-accent" />
                    <h3 className="text-base font-semibold text-textPrimary">Theme</h3>
                </div>
                {currentTheme && (
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface/50">
                        <div
                            className="w-4 h-4 rounded-full"
                            style={{ backgroundColor: currentTheme.palette.accent }}
                        />
                        <span className="text-xs text-textSecondary font-medium">{currentTheme.name}</span>
                    </div>
                )}
            </div>

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

            {/* Theme Preview Note */}
            <div className="p-3 rounded-lg bg-surface/50 border border-borderSubtle">
                <p className="text-xs text-textMuted flex items-center gap-2">
                    <Sun size={14} />
                    Tip: Theme changes are applied instantly. Find your perfect aesthetic!
                </p>
            </div>
        </div>
    );
};

export default ThemeSettings;
