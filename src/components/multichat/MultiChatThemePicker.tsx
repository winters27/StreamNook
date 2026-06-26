import { Check } from 'lucide-react';
import { useAppStore } from '../../stores/AppStore';
import {
  themes,
  applyTheme,
  getThemeByIdWithCustom,
  getOledTheme,
  customThemeToTheme,
  OLED_THEME_ID,
  DEFAULT_THEME_ID,
} from '../../themes';

// A condensed theme picker for the MultiChat settings — a compact swatch grid of
// the built-in themes (+ any custom ones), no accent/glass/font sub-controls. Theme
// is a global setting, so picking here applies + persists it everywhere (the full
// picker with all the extras stays in the main app's Theme tab).
export default function MultiChatThemePicker() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const currentThemeId = settings.theme || DEFAULT_THEME_ID;
  const customThemes = settings.custom_themes || [];

  const select = (id: string) => {
    const theme =
      id === OLED_THEME_ID ? getOledTheme(settings.oled_accent) : getThemeByIdWithCustom(id, customThemes);
    if (!theme) return;
    applyTheme(theme);
    updateSettings({ ...settings, theme: id });
  };

  const cards = [
    ...customThemes.map((c) => ({ id: c.id, name: c.name, palette: customThemeToTheme(c).palette })),
    ...themes.map((t) => ({ id: t.id, name: t.name, palette: t.palette })),
  ];

  return (
    <div>
      <div className="mb-3 text-xs leading-relaxed text-textSecondary">
        Pick a theme. It applies everywhere; the full theme controls (accent, glass, font) live in the
        main app&apos;s settings.
      </div>
      <div className="grid grid-cols-3 gap-2">
        {cards.map((t) => {
          const selected = t.id === currentThemeId;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => select(t.id)}
              className={`relative flex flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors ${
                selected ? 'border-accent' : 'border-borderSubtle hover:border-white/20'
              }`}
            >
              <div
                className="flex h-9 items-center gap-1 overflow-hidden rounded-md px-2"
                style={{ backgroundColor: t.palette.background }}
              >
                <span className="text-xs font-semibold" style={{ color: t.palette.textPrimary }}>
                  Aa
                </span>
                <span
                  className="ml-auto h-3 w-3 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: t.palette.accent }}
                />
              </div>
              <span className="truncate px-0.5 text-[11px] text-textSecondary">{t.name}</span>
              {selected && (
                <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-accent text-background">
                  <Check size={11} strokeWidth={3} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
