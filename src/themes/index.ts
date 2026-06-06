// StreamNook Theme System
// All themes follow a consistent structure for easy switching

export interface ThemePalette {
    // Core colors
    background: string;
    backgroundSecondary: string;
    backgroundTertiary: string;

    // Surface colors (for glass panels, cards, etc.)
    surface: string;
    surfaceHover: string;
    surfaceActive: string;

    // Text colors
    textPrimary: string;
    textSecondary: string;
    textMuted: string;

    // Accent colors
    accent: string;
    accentHover: string;
    accentMuted: string;

    // Border colors
    border: string;
    borderLight: string;
    borderSubtle: string;

    // Semantic colors
    success: string;
    warning: string;
    error: string;
    info: string;

    // Special colors
    scrollbarThumb: string;
    scrollbarTrack: string;

    // Glass effect opacities
    glassOpacity: string;
    glassHoverOpacity: string;
    glassActiveOpacity: string;

    // Syntax/highlight colors (for chat, code, etc.)
    highlight: {
        pink: string;
        purple: string;
        blue: string;
        cyan: string;
        green: string;
        yellow: string;
        orange: string;
        red: string;
    };
}

export interface Theme {
    id: string;
    name: string;
    description: string;
    category: 'signature' | 'universal' | 'modern' | 'classic' | 'cozy';
    palette: ThemePalette;
}

// ============================================
// SIGNATURE THEMES
// ============================================

// Standard Issue - Military inspired, olive greens, tan, light browns. Built
// from an early supporter's palette; credited in the description. (id unchanged:
// persisted in existing user settings.)
export const standardIssue: Theme = {
    id: 'antidepressants-tactical',
    name: 'Standard Issue',
    description: 'Military aesthetic with olive greens, tan, and warm browns. Stark and grounding. A nod to Antidepressant.',
    category: 'signature',
    palette: {
        background: '#1c1c18',
        backgroundSecondary: 'rgba(107, 111, 87, 0.08)',
        backgroundTertiary: '#262620',

        surface: 'rgba(107, 111, 87, 0.22)',
        surfaceHover: 'rgba(107, 111, 87, 0.32)',
        surfaceActive: 'rgba(107, 111, 87, 0.42)',

        textPrimary: '#e8e4d9',
        textSecondary: '#a8a48a',
        textMuted: 'rgba(168, 164, 138, 0.65)',

        accent: '#8b9068',
        accentHover: '#9ca378',
        accentMuted: 'rgba(139, 144, 104, 0.55)',

        border: 'rgba(139, 144, 104, 0.40)',
        borderLight: 'rgba(139, 144, 104, 0.28)',
        borderSubtle: 'rgba(139, 144, 104, 0.16)',

        success: '#7d9c5a',
        warning: '#c4a35a',
        error: '#b85c4c',
        info: '#7a9a9c',

        scrollbarThumb: 'rgba(139, 144, 104, 0.40)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.22',
        glassHoverOpacity: '0.32',
        glassActiveOpacity: '0.42',

        highlight: {
            pink: '#c49a8c',
            purple: '#9c8ca4',
            blue: '#7a9a9c',
            cyan: '#8caca4',
            green: '#7d9c5a',
            yellow: '#c4a35a',
            orange: '#c48a5a',
            red: '#b85c4c',
        },
    },
};

// OLED - True black for OLED screens, with a user-chosen accent color. The
// palette below holds the DEFAULT accent so the theme renders correctly before
// any choice is made; when OLED is the active theme its accent-derived slots are
// recomputed from the saved accent via getOledTheme(). Credited in the
// description. (id unchanged: persisted in existing user settings.)
export const oledTheme: Theme = {
    id: 'prince0fdubai-oled',
    name: 'OLED',
    description: 'Pure black for OLED screens, with an accent color you choose. A nod to prince0fdubai.',
    category: 'signature',
    palette: {
        background: '#000000',
        backgroundSecondary: 'rgba(255, 255, 255, 0.02)',
        backgroundTertiary: '#080808',

        surface: 'rgba(255, 255, 255, 0.08)',
        surfaceHover: 'rgba(255, 255, 255, 0.14)',
        surfaceActive: 'rgba(255, 255, 255, 0.20)',

        textPrimary: '#ffffff',
        textSecondary: '#b8a0d0',
        textMuted: 'rgba(255, 255, 255, 0.45)',

        accent: '#a064ff',
        accentHover: '#b88aff',
        accentMuted: 'rgba(160, 100, 255, 0.5)',

        border: 'rgba(255, 255, 255, 0.15)',
        borderLight: 'rgba(255, 255, 255, 0.10)',
        borderSubtle: 'rgba(255, 255, 255, 0.05)',

        success: '#00ff88',
        warning: '#ffcc00',
        error: '#ff4466',
        info: '#66b3ff',

        scrollbarThumb: 'rgba(160, 100, 255, 0.25)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.08',
        glassHoverOpacity: '0.14',
        glassActiveOpacity: '0.20',

        highlight: {
            pink: '#ff66b2',
            purple: '#a064ff',
            blue: '#66b3ff',
            cyan: '#66ffcc',
            green: '#00ff88',
            yellow: '#ffcc00',
            orange: '#ff9933',
            red: '#ff4466',
        },
    },
};

// The OLED theme is the one configurable signature theme: pick any accent and
// the rest of its accent-derived colors follow. These exports drive that picker.
export const OLED_THEME_ID = 'prince0fdubai-oled';

// Default accent = the original OLED purple, so existing users see no change.
export const DEFAULT_OLED_ACCENT = '#a064ff';

// One-click accents shown when OLED is selected. Purple is the original; orange
// preserves the look of the retired second OLED variant; the rest cover common
// tastes. Users can also dial in any color with the full picker.
export const OLED_ACCENT_PRESETS: { name: string; value: string }[] = [
    { name: 'Purple', value: '#a064ff' },
    { name: 'Orange', value: '#ff9933' },
    { name: 'Blue', value: '#66b3ff' },
    { name: 'Cyan', value: '#22d3ee' },
    { name: 'Green', value: '#22c55e' },
    { name: 'Pink', value: '#ff66b2' },
    { name: 'Red', value: '#ff4466' },
    { name: 'Gold', value: '#ffcc00' },
];

// Frosted Glass - The signature StreamNook theme. (id unchanged: it's the
// default theme and is persisted in existing user settings.)
export const frostedGlass: Theme = {
    id: 'winters-glass',
    name: 'Frosted Glass',
    description: 'Cool, frosted glass with icy blue accents. The original StreamNook look, shaped by Winters.',
    category: 'signature',
    palette: {
        background: '#0c0c0d',
        backgroundSecondary: 'rgba(255, 255, 255, 0.03)',
        backgroundTertiary: '#1a1a1b',

        surface: 'rgba(151, 177, 185, 0.15)',
        surfaceHover: 'rgba(151, 177, 185, 0.25)',
        surfaceActive: 'rgba(151, 177, 185, 0.35)',

        textPrimary: '#ffffff',
        textSecondary: '#97b1b9',
        textMuted: 'rgba(151, 177, 185, 0.6)',

        accent: '#97b1b9',
        accentHover: '#adc4cc',
        accentMuted: 'rgba(151, 177, 185, 0.5)',

        border: 'rgba(151, 177, 185, 0.3)',
        borderLight: 'rgba(151, 177, 185, 0.2)',
        borderSubtle: 'rgba(151, 177, 185, 0.1)',

        success: '#22c55e',
        warning: '#eab308',
        error: '#ef4444',
        info: '#6b9dff',

        scrollbarThumb: 'rgba(151, 177, 185, 0.3)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.15',
        glassHoverOpacity: '0.25',
        glassActiveOpacity: '0.35',

        highlight: {
            pink: '#ff6b9d',
            purple: '#c06bff',
            blue: '#6b9dff',
            cyan: '#6bffc0',
            green: '#22c55e',
            yellow: '#ffc06b',
            orange: '#ff9f6b',
            red: '#ff6b6b',
        },
    },
};

// ============================================
// THE BIG THREE - Universal Themes
// ============================================

export const dracula: Theme = {
    id: 'dracula',
    name: 'Dracula',
    description: 'High contrast, vampiric theme with neon pink, green, and purple accents.',
    category: 'universal',
    palette: {
        background: '#282a36',
        backgroundSecondary: 'rgba(189, 147, 249, 0.05)',
        backgroundTertiary: '#343746',

        surface: 'rgba(189, 147, 249, 0.12)',
        surfaceHover: 'rgba(189, 147, 249, 0.2)',
        surfaceActive: 'rgba(189, 147, 249, 0.28)',

        textPrimary: '#f8f8f2',
        textSecondary: '#bd93f9',
        textMuted: 'rgba(248, 248, 242, 0.5)',

        accent: '#bd93f9',
        accentHover: '#caa8fc',
        accentMuted: 'rgba(189, 147, 249, 0.5)',

        border: 'rgba(189, 147, 249, 0.3)',
        borderLight: 'rgba(189, 147, 249, 0.2)',
        borderSubtle: 'rgba(189, 147, 249, 0.1)',

        success: '#50fa7b',
        warning: '#f1fa8c',
        error: '#ff5555',
        info: '#8be9fd',

        scrollbarThumb: 'rgba(189, 147, 249, 0.4)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.12',
        glassHoverOpacity: '0.2',
        glassActiveOpacity: '0.28',

        highlight: {
            pink: '#ff79c6',
            purple: '#bd93f9',
            blue: '#8be9fd',
            cyan: '#8be9fd',
            green: '#50fa7b',
            yellow: '#f1fa8c',
            orange: '#ffb86c',
            red: '#ff5555',
        },
    },
};

export const nord: Theme = {
    id: 'nord',
    name: 'Nord',
    description: 'Arctic, cool, and professional with icy blue and frost-colored accents.',
    category: 'universal',
    palette: {
        background: '#2e3440',
        backgroundSecondary: 'rgba(136, 192, 208, 0.05)',
        backgroundTertiary: '#434c5e',

        surface: 'rgba(136, 192, 208, 0.1)',
        surfaceHover: 'rgba(136, 192, 208, 0.18)',
        surfaceActive: 'rgba(136, 192, 208, 0.25)',

        textPrimary: '#eceff4',
        textSecondary: '#88c0d0',
        textMuted: 'rgba(216, 222, 233, 0.5)',

        accent: '#88c0d0',
        accentHover: '#8fbcbb',
        accentMuted: 'rgba(136, 192, 208, 0.5)',

        border: 'rgba(136, 192, 208, 0.25)',
        borderLight: 'rgba(136, 192, 208, 0.15)',
        borderSubtle: 'rgba(136, 192, 208, 0.08)',

        success: '#a3be8c',
        warning: '#ebcb8b',
        error: '#bf616a',
        info: '#81a1c1',

        scrollbarThumb: 'rgba(136, 192, 208, 0.35)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.1',
        glassHoverOpacity: '0.18',
        glassActiveOpacity: '0.25',

        highlight: {
            pink: '#b48ead',
            purple: '#b48ead',
            blue: '#81a1c1',
            cyan: '#88c0d0',
            green: '#a3be8c',
            yellow: '#ebcb8b',
            orange: '#d08770',
            red: '#bf616a',
        },
    },
};

export const gruvbox: Theme = {
    id: 'gruvbox',
    name: 'Gruvbox',
    description: 'Retro, earthy, and warm with browns, greens, and mustard yellows.',
    category: 'universal',
    palette: {
        background: '#282828',
        backgroundSecondary: 'rgba(251, 189, 46, 0.05)',
        backgroundTertiary: '#3c3836',

        surface: 'rgba(251, 189, 46, 0.1)',
        surfaceHover: 'rgba(251, 189, 46, 0.18)',
        surfaceActive: 'rgba(251, 189, 46, 0.26)',

        textPrimary: '#ebdbb2',
        textSecondary: '#fabd2f',
        textMuted: 'rgba(235, 219, 178, 0.5)',

        accent: '#fabd2f',
        accentHover: '#fcc44e',
        accentMuted: 'rgba(251, 189, 46, 0.5)',

        border: 'rgba(251, 189, 46, 0.3)',
        borderLight: 'rgba(251, 189, 46, 0.2)',
        borderSubtle: 'rgba(251, 189, 46, 0.1)',

        success: '#b8bb26',
        warning: '#fabd2f',
        error: '#fb4934',
        info: '#83a598',

        scrollbarThumb: 'rgba(251, 189, 46, 0.35)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.1',
        glassHoverOpacity: '0.18',
        glassActiveOpacity: '0.26',

        highlight: {
            pink: '#d3869b',
            purple: '#d3869b',
            blue: '#83a598',
            cyan: '#8ec07c',
            green: '#b8bb26',
            yellow: '#fabd2f',
            orange: '#fe8019',
            red: '#fb4934',
        },
    },
};

// ============================================
// MODERN & SOOTHING - Atmospheric Themes
// ============================================

export const rosePine: Theme = {
    id: 'rose-pine',
    name: 'Rosé Pine',
    description: 'Classy, organic, and soft with pine, foam, gold, and rose colors.',
    category: 'modern',
    palette: {
        background: '#191724',
        backgroundSecondary: 'rgba(235, 188, 186, 0.05)',
        backgroundTertiary: '#26233a',

        surface: 'rgba(235, 188, 186, 0.1)',
        surfaceHover: 'rgba(235, 188, 186, 0.18)',
        surfaceActive: 'rgba(235, 188, 186, 0.25)',

        textPrimary: '#e0def4',
        textSecondary: '#ebbcba',
        textMuted: 'rgba(224, 222, 244, 0.5)',

        accent: '#ebbcba',
        accentHover: '#f0ccc9',
        accentMuted: 'rgba(235, 188, 186, 0.5)',

        border: 'rgba(235, 188, 186, 0.25)',
        borderLight: 'rgba(235, 188, 186, 0.15)',
        borderSubtle: 'rgba(235, 188, 186, 0.08)',

        success: '#9ccfd8',
        warning: '#f6c177',
        error: '#eb6f92',
        info: '#c4a7e7',

        scrollbarThumb: 'rgba(235, 188, 186, 0.35)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.1',
        glassHoverOpacity: '0.18',
        glassActiveOpacity: '0.25',

        highlight: {
            pink: '#eb6f92',
            purple: '#c4a7e7',
            blue: '#31748f',
            cyan: '#9ccfd8',
            green: '#9ccfd8',
            yellow: '#f6c177',
            orange: '#f6c177',
            red: '#eb6f92',
        },
    },
};

export const tokyoNight: Theme = {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: 'Cyberpunk, neon city vibes with deep blues and bright neon accents.',
    category: 'modern',
    palette: {
        background: '#1a1b26',
        backgroundSecondary: 'rgba(122, 162, 247, 0.05)',
        backgroundTertiary: '#24283b',

        surface: 'rgba(122, 162, 247, 0.1)',
        surfaceHover: 'rgba(122, 162, 247, 0.18)',
        surfaceActive: 'rgba(122, 162, 247, 0.26)',

        textPrimary: '#c0caf5',
        textSecondary: '#7aa2f7',
        textMuted: 'rgba(192, 202, 245, 0.5)',

        accent: '#7aa2f7',
        accentHover: '#89b4fa',
        accentMuted: 'rgba(122, 162, 247, 0.5)',

        border: 'rgba(122, 162, 247, 0.25)',
        borderLight: 'rgba(122, 162, 247, 0.15)',
        borderSubtle: 'rgba(122, 162, 247, 0.08)',

        success: '#9ece6a',
        warning: '#e0af68',
        error: '#f7768e',
        info: '#7dcfff',

        scrollbarThumb: 'rgba(122, 162, 247, 0.4)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.1',
        glassHoverOpacity: '0.18',
        glassActiveOpacity: '0.26',

        highlight: {
            pink: '#f7768e',
            purple: '#bb9af7',
            blue: '#7aa2f7',
            cyan: '#7dcfff',
            green: '#9ece6a',
            yellow: '#e0af68',
            orange: '#ff9e64',
            red: '#f7768e',
        },
    },
};

export const kanagawa: Theme = {
    id: 'kanagawa',
    name: 'Kanagawa',
    description: 'Feudal Japan aesthetic inspired by "The Great Wave" painting.',
    category: 'modern',
    palette: {
        background: '#1f1f28',
        backgroundSecondary: 'rgba(114, 144, 177, 0.05)',
        backgroundTertiary: '#2a2a37',

        surface: 'rgba(114, 144, 177, 0.1)',
        surfaceHover: 'rgba(114, 144, 177, 0.18)',
        surfaceActive: 'rgba(114, 144, 177, 0.26)',

        textPrimary: '#dcd7ba',
        textSecondary: '#7e9cd8',
        textMuted: 'rgba(220, 215, 186, 0.5)',

        accent: '#7e9cd8',
        accentHover: '#8faee0',
        accentMuted: 'rgba(126, 156, 216, 0.5)',

        border: 'rgba(114, 144, 177, 0.25)',
        borderLight: 'rgba(114, 144, 177, 0.15)',
        borderSubtle: 'rgba(114, 144, 177, 0.08)',

        success: '#76946a',
        warning: '#dca561',
        error: '#c34043',
        info: '#7fb4ca',

        scrollbarThumb: 'rgba(114, 144, 177, 0.4)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.1',
        glassHoverOpacity: '0.18',
        glassActiveOpacity: '0.26',

        highlight: {
            pink: '#d27e99',
            purple: '#957fb8',
            blue: '#7e9cd8',
            cyan: '#7fb4ca',
            green: '#76946a',
            yellow: '#e6c384',
            orange: '#ffa066',
            red: '#c34043',
        },
    },
};

// ============================================
// CLASSICS - Strict & Functional Themes
// ============================================

export const githubDark: Theme = {
    id: 'github-dark',
    name: 'GitHub Dark',
    description: 'Clean, professional dark theme inspired by GitHub\'s interface.',
    category: 'classic',
    palette: {
        background: '#0d1117',
        backgroundSecondary: 'rgba(56, 139, 253, 0.05)',
        backgroundTertiary: '#21262d',

        surface: 'rgba(56, 139, 253, 0.1)',
        surfaceHover: 'rgba(56, 139, 253, 0.18)',
        surfaceActive: 'rgba(56, 139, 253, 0.26)',

        textPrimary: '#c9d1d9',
        textSecondary: '#58a6ff',
        textMuted: 'rgba(201, 209, 217, 0.5)',

        accent: '#58a6ff',
        accentHover: '#79b8ff',
        accentMuted: 'rgba(88, 166, 255, 0.5)',

        border: 'rgba(48, 54, 61, 0.6)',
        borderLight: 'rgba(48, 54, 61, 0.4)',
        borderSubtle: 'rgba(48, 54, 61, 0.2)',

        success: '#3fb950',
        warning: '#d29922',
        error: '#f85149',
        info: '#58a6ff',

        scrollbarThumb: 'rgba(88, 166, 255, 0.4)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.1',
        glassHoverOpacity: '0.18',
        glassActiveOpacity: '0.26',

        highlight: {
            pink: '#f778ba',
            purple: '#bc8cff',
            blue: '#58a6ff',
            cyan: '#39c5cf',
            green: '#3fb950',
            yellow: '#d29922',
            orange: '#db6d28',
            red: '#f85149',
        },
    },
};

export const solarizedSand: Theme = {
    id: 'solarized-sand',
    name: 'Solarized Sand',
    description: 'Warm sandy desert aesthetic inspired by Solarized with beige and tan tones.',
    category: 'cozy',
    palette: {
        // Light-mode depth recipe: warm tan canvas with translucent cream PANELS
        // that sit lighter than it (cards lift via lightness + the panel
        // drop-shadow), while interactive surfaces use a low-alpha brown tint so
        // hovers and the selected state darken visibly instead of washing pale.
        background: '#d4c5a9',
        backgroundSecondary: 'rgba(255, 250, 240, 0.62)',
        backgroundTertiary: '#e7dcc6',

        surface: 'rgba(139, 116, 87, 0.12)',
        surfaceHover: 'rgba(139, 116, 87, 0.2)',
        surfaceActive: 'rgba(139, 116, 87, 0.28)',

        textPrimary: '#3d3426',
        textSecondary: '#6e5d45',
        textMuted: 'rgba(61, 52, 38, 0.55)',

        accent: '#9c8364',
        accentHover: '#8b7457',
        accentMuted: 'rgba(156, 131, 100, 0.6)',

        border: 'rgba(110, 93, 68, 0.26)',
        borderLight: 'rgba(110, 93, 68, 0.16)',
        borderSubtle: 'rgba(110, 93, 68, 0.09)',

        success: '#7a8a3f',
        warning: '#b88932',
        error: '#c55a4d',
        info: '#5a8a8a',

        scrollbarThumb: 'rgba(110, 93, 68, 0.4)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.15',
        glassHoverOpacity: '0.25',
        glassActiveOpacity: '0.35',

        highlight: {
            pink: '#c96a84',
            purple: '#9080b4',
            blue: '#5a8a8a',
            cyan: '#67968a',
            green: '#7a8a3f',
            yellow: '#b88932',
            orange: '#c67a34',
            red: '#c55a4d',
        },
    },
};

export const solarizedDark: Theme = {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    description: 'Mathematical precision with a unique teal background and low contrast.',
    category: 'classic',
    palette: {
        background: '#002b36',
        backgroundSecondary: 'rgba(38, 139, 210, 0.05)',
        backgroundTertiary: '#094959',

        surface: 'rgba(38, 139, 210, 0.12)',
        surfaceHover: 'rgba(38, 139, 210, 0.2)',
        surfaceActive: 'rgba(38, 139, 210, 0.28)',

        textPrimary: '#839496',
        textSecondary: '#268bd2',
        textMuted: 'rgba(131, 148, 150, 0.6)',

        accent: '#268bd2',
        accentHover: '#2a9bea',
        accentMuted: 'rgba(38, 139, 210, 0.5)',

        border: 'rgba(38, 139, 210, 0.3)',
        borderLight: 'rgba(38, 139, 210, 0.2)',
        borderSubtle: 'rgba(38, 139, 210, 0.1)',

        success: '#859900',
        warning: '#b58900',
        error: '#dc322f',
        info: '#2aa198',

        scrollbarThumb: 'rgba(38, 139, 210, 0.4)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.12',
        glassHoverOpacity: '0.2',
        glassActiveOpacity: '0.28',

        highlight: {
            pink: '#d33682',
            purple: '#6c71c4',
            blue: '#268bd2',
            cyan: '#2aa198',
            green: '#859900',
            yellow: '#b58900',
            orange: '#cb4b16',
            red: '#dc322f',
        },
    },
};

export const monokai: Theme = {
    id: 'monokai',
    name: 'Monokai',
    description: 'The iconic code aesthetic with vibrant yellow, pink, and green.',
    category: 'classic',
    palette: {
        background: '#272822',
        backgroundSecondary: 'rgba(249, 38, 114, 0.05)',
        backgroundTertiary: '#3e3d32',

        surface: 'rgba(249, 38, 114, 0.1)',
        surfaceHover: 'rgba(249, 38, 114, 0.18)',
        surfaceActive: 'rgba(249, 38, 114, 0.26)',

        textPrimary: '#f8f8f2',
        textSecondary: '#f92672',
        textMuted: 'rgba(248, 248, 242, 0.5)',

        accent: '#f92672',
        accentHover: '#fa4d8b',
        accentMuted: 'rgba(249, 38, 114, 0.5)',

        border: 'rgba(249, 38, 114, 0.25)',
        borderLight: 'rgba(249, 38, 114, 0.15)',
        borderSubtle: 'rgba(249, 38, 114, 0.08)',

        success: '#a6e22e',
        warning: '#e6db74',
        error: '#f92672',
        info: '#66d9ef',

        scrollbarThumb: 'rgba(249, 38, 114, 0.4)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.1',
        glassHoverOpacity: '0.18',
        glassActiveOpacity: '0.26',

        highlight: {
            pink: '#f92672',
            purple: '#ae81ff',
            blue: '#66d9ef',
            cyan: '#66d9ef',
            green: '#a6e22e',
            yellow: '#e6db74',
            orange: '#fd971f',
            red: '#f92672',
        },
    },
};

export const oneDark: Theme = {
    id: 'one-dark',
    name: 'One Dark',
    description: 'The balanced, corporate-safe theme from Atom that works everywhere.',
    category: 'classic',
    palette: {
        background: '#282c34',
        backgroundSecondary: 'rgba(97, 175, 239, 0.05)',
        backgroundTertiary: '#2c323c',

        surface: 'rgba(97, 175, 239, 0.1)',
        surfaceHover: 'rgba(97, 175, 239, 0.18)',
        surfaceActive: 'rgba(97, 175, 239, 0.26)',

        textPrimary: '#abb2bf',
        textSecondary: '#61afef',
        textMuted: 'rgba(171, 178, 191, 0.5)',

        accent: '#61afef',
        accentHover: '#74baf2',
        accentMuted: 'rgba(97, 175, 239, 0.5)',

        border: 'rgba(97, 175, 239, 0.25)',
        borderLight: 'rgba(97, 175, 239, 0.15)',
        borderSubtle: 'rgba(97, 175, 239, 0.08)',

        success: '#98c379',
        warning: '#e5c07b',
        error: '#e06c75',
        info: '#56b6c2',

        scrollbarThumb: 'rgba(97, 175, 239, 0.4)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.1',
        glassHoverOpacity: '0.18',
        glassActiveOpacity: '0.26',

        highlight: {
            pink: '#e06c75',
            purple: '#c678dd',
            blue: '#61afef',
            cyan: '#56b6c2',
            green: '#98c379',
            yellow: '#e5c07b',
            orange: '#d19a66',
            red: '#e06c75',
        },
    },
};

// ============================================
// COZY & PASTEL - Aesthetic Wave Themes
// ============================================

export const catppuccinMocha: Theme = {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    description: 'Soft, warm, and whimsical with pastel accents like flamingo and lavender.',
    category: 'cozy',
    palette: {
        background: '#1e1e2e',
        backgroundSecondary: 'rgba(203, 166, 247, 0.05)',
        backgroundTertiary: '#313244',

        surface: 'rgba(203, 166, 247, 0.1)',
        surfaceHover: 'rgba(203, 166, 247, 0.18)',
        surfaceActive: 'rgba(203, 166, 247, 0.26)',

        textPrimary: '#cdd6f4',
        textSecondary: '#cba6f7',
        textMuted: 'rgba(205, 214, 244, 0.5)',

        accent: '#cba6f7',
        accentHover: '#d4b5f9',
        accentMuted: 'rgba(203, 166, 247, 0.5)',

        border: 'rgba(203, 166, 247, 0.25)',
        borderLight: 'rgba(203, 166, 247, 0.15)',
        borderSubtle: 'rgba(203, 166, 247, 0.08)',

        success: '#a6e3a1',
        warning: '#f9e2af',
        error: '#f38ba8',
        info: '#89b4fa',

        scrollbarThumb: 'rgba(203, 166, 247, 0.4)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.1',
        glassHoverOpacity: '0.18',
        glassActiveOpacity: '0.26',

        highlight: {
            pink: '#f5c2e7',
            purple: '#cba6f7',
            blue: '#89b4fa',
            cyan: '#94e2d5',
            green: '#a6e3a1',
            yellow: '#f9e2af',
            orange: '#fab387',
            red: '#f38ba8',
        },
    },
};

export const catppuccinLatte: Theme = {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    description: 'Soft, creamy light theme with layered surfaces and gentle, low-glare contrast.',
    category: 'cozy',
    palette: {
        // Light-mode depth recipe: a calm grey canvas with translucent WHITE
        // PANELS that sit lighter than it (cards lift via lightness + the panel
        // drop-shadow), while interactive surfaces use a low-alpha ACCENT tint so
        // hovers and the selected state darken visibly instead of washing white.
        background: '#d8dce4',
        backgroundSecondary: 'rgba(255, 255, 255, 0.6)',
        backgroundTertiary: '#eef0f4',

        surface: 'rgba(136, 57, 239, 0.1)',
        surfaceHover: 'rgba(136, 57, 239, 0.16)',
        surfaceActive: 'rgba(136, 57, 239, 0.24)',

        textPrimary: '#4c4f69',
        // Muted slate, not the vivid mauve accent — keeps secondary text calm.
        textSecondary: '#6c6f85',
        textMuted: 'rgba(76, 79, 105, 0.55)',

        accent: '#8839ef',
        accentHover: '#9752f2',
        accentMuted: 'rgba(136, 57, 239, 0.5)',

        // Neutral slate borders read as clean layer separators on a light canvas.
        border: 'rgba(76, 79, 105, 0.16)',
        borderLight: 'rgba(76, 79, 105, 0.1)',
        borderSubtle: 'rgba(76, 79, 105, 0.06)',

        success: '#40a02b',
        warning: '#df8e1d',
        error: '#d20f39',
        info: '#1e66f5',

        scrollbarThumb: 'rgba(76, 79, 105, 0.3)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.08',
        glassHoverOpacity: '0.15',
        glassActiveOpacity: '0.22',

        highlight: {
            pink: '#ea76cb',
            purple: '#8839ef',
            blue: '#1e66f5',
            cyan: '#179299',
            green: '#40a02b',
            yellow: '#df8e1d',
            orange: '#fe640b',
            red: '#d20f39',
        },
    },
};

export const materialTheme: Theme = {
    id: 'material-theme',
    name: 'Material Theme',
    description: 'Google\'s Material Design with vibrant teal, purple, and amber accents.',
    category: 'modern',
    palette: {
        background: '#263238',
        backgroundSecondary: 'rgba(128, 203, 196, 0.05)',
        backgroundTertiary: '#2c3b41',

        surface: 'rgba(128, 203, 196, 0.12)',
        surfaceHover: 'rgba(128, 203, 196, 0.2)',
        surfaceActive: 'rgba(128, 203, 196, 0.28)',

        textPrimary: '#eeffff',
        textSecondary: '#80cbc4',
        textMuted: 'rgba(238, 255, 255, 0.5)',

        accent: '#80cbc4',
        accentHover: '#99d5cf',
        accentMuted: 'rgba(128, 203, 196, 0.5)',

        border: 'rgba(128, 203, 196, 0.3)',
        borderLight: 'rgba(128, 203, 196, 0.2)',
        borderSubtle: 'rgba(128, 203, 196, 0.1)',

        success: '#c3e88d',
        warning: '#ffcb6b',
        error: '#f07178',
        info: '#82aaff',

        scrollbarThumb: 'rgba(128, 203, 196, 0.4)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.12',
        glassHoverOpacity: '0.2',
        glassActiveOpacity: '0.28',

        highlight: {
            pink: '#f07178',
            purple: '#c792ea',
            blue: '#82aaff',
            cyan: '#89ddff',
            green: '#c3e88d',
            yellow: '#ffcb6b',
            orange: '#f78c6c',
            red: '#f07178',
        },
    },
};

export const ayuDark: Theme = {
    id: 'ayu-dark',
    name: 'Ayu Dark',
    description: 'Sublime, minimalist theme with perfect contrast and warm orange accents.',
    category: 'modern',
    palette: {
        background: '#0a0e14',
        backgroundSecondary: 'rgba(255, 160, 122, 0.05)',
        backgroundTertiary: '#0d1016',

        surface: 'rgba(255, 160, 122, 0.1)',
        surfaceHover: 'rgba(255, 160, 122, 0.18)',
        surfaceActive: 'rgba(255, 160, 122, 0.26)',

        textPrimary: '#b3b1ad',
        textSecondary: '#ff8f40',
        textMuted: 'rgba(179, 177, 173, 0.5)',

        accent: '#ff8f40',
        accentHover: '#ffa759',
        accentMuted: 'rgba(255, 143, 64, 0.5)',

        border: 'rgba(255, 143, 64, 0.25)',
        borderLight: 'rgba(255, 143, 64, 0.15)',
        borderSubtle: 'rgba(255, 143, 64, 0.08)',

        success: '#bae67e',
        warning: '#ffd580',
        error: '#ff3333',
        info: '#59c2ff',

        scrollbarThumb: 'rgba(255, 143, 64, 0.4)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.1',
        glassHoverOpacity: '0.18',
        glassActiveOpacity: '0.26',

        highlight: {
            pink: '#f29668',
            purple: '#d4bfff',
            blue: '#59c2ff',
            cyan: '#95e6cb',
            green: '#bae67e',
            yellow: '#ffd580',
            orange: '#ff8f40',
            red: '#ff3333',
        },
    },
};

export const nightOwl: Theme = {
    id: 'night-owl',
    name: 'Night Owl',
    description: 'Fine-tuned for those who code late into the night with blue accents.',
    category: 'modern',
    palette: {
        background: '#011627',
        backgroundSecondary: 'rgba(128, 203, 196, 0.05)',
        backgroundTertiary: '#0b2942',

        surface: 'rgba(128, 203, 196, 0.1)',
        surfaceHover: 'rgba(128, 203, 196, 0.18)',
        surfaceActive: 'rgba(128, 203, 196, 0.26)',

        textPrimary: '#d6deeb',
        textSecondary: '#7fdbca',
        textMuted: 'rgba(214, 222, 235, 0.5)',

        accent: '#7fdbca',
        accentHover: '#9ce7d7',
        accentMuted: 'rgba(127, 219, 202, 0.5)',

        border: 'rgba(127, 219, 202, 0.25)',
        borderLight: 'rgba(127, 219, 202, 0.15)',
        borderSubtle: 'rgba(127, 219, 202, 0.08)',

        success: '#addb67',
        warning: '#ecc48d',
        error: '#ef5350',
        info: '#82aaff',

        scrollbarThumb: 'rgba(127, 219, 202, 0.4)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.1',
        glassHoverOpacity: '0.18',
        glassActiveOpacity: '0.26',

        highlight: {
            pink: '#c792ea',
            purple: '#c792ea',
            blue: '#82aaff',
            cyan: '#7fdbca',
            green: '#addb67',
            yellow: '#ecc48d',
            orange: '#f78c6c',
            red: '#ef5350',
        },
    },
};

export const synthwave84: Theme = {
    id: 'synthwave84',
    name: 'Synthwave \'84',
    description: 'Neon-soaked cyberpunk vibes with hot pink, electric blue, and neon green.',
    category: 'modern',
    palette: {
        background: '#241b2f',
        backgroundSecondary: 'rgba(255, 71, 176, 0.05)',
        backgroundTertiary: '#2a2139',

        surface: 'rgba(255, 71, 176, 0.12)',
        surfaceHover: 'rgba(255, 71, 176, 0.2)',
        surfaceActive: 'rgba(255, 71, 176, 0.28)',

        textPrimary: '#f2f2f2',
        textSecondary: '#ff7edb',
        textMuted: 'rgba(242, 242, 242, 0.5)',

        accent: '#ff7edb',
        accentHover: '#ff9ce5',
        accentMuted: 'rgba(255, 126, 219, 0.5)',

        border: 'rgba(255, 126, 219, 0.3)',
        borderLight: 'rgba(255, 126, 219, 0.2)',
        borderSubtle: 'rgba(255, 126, 219, 0.1)',

        success: '#72f1b8',
        warning: '#fede5d',
        error: '#fe4450',
        info: '#36f9f6',

        scrollbarThumb: 'rgba(255, 126, 219, 0.4)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.12',
        glassHoverOpacity: '0.2',
        glassActiveOpacity: '0.28',

        highlight: {
            pink: '#ff7edb',
            purple: '#b893ce',
            blue: '#36f9f6',
            cyan: '#36f9f6',
            green: '#72f1b8',
            yellow: '#fede5d',
            orange: '#fe9867',
            red: '#fe4450',
        },
    },
};

export const everforest: Theme = {
    id: 'everforest',
    name: 'Everforest',
    description: 'Nature-inspired with mossy greens, sage, and calming earth tones.',
    category: 'cozy',
    palette: {
        background: '#2d353b',
        backgroundSecondary: 'rgba(163, 190, 140, 0.05)',
        backgroundTertiary: '#343f44',

        surface: 'rgba(163, 190, 140, 0.1)',
        surfaceHover: 'rgba(163, 190, 140, 0.18)',
        surfaceActive: 'rgba(163, 190, 140, 0.26)',

        textPrimary: '#d3c6aa',
        textSecondary: '#a7c080',
        textMuted: 'rgba(211, 198, 170, 0.5)',

        accent: '#a7c080',
        accentHover: '#b5cb92',
        accentMuted: 'rgba(167, 192, 128, 0.5)',

        border: 'rgba(163, 190, 140, 0.25)',
        borderLight: 'rgba(163, 190, 140, 0.15)',
        borderSubtle: 'rgba(163, 190, 140, 0.08)',

        success: '#a7c080',
        warning: '#dbbc7f',
        error: '#e67e80',
        info: '#7fbbb3',

        scrollbarThumb: 'rgba(163, 190, 140, 0.4)',
        scrollbarTrack: 'transparent',

        glassOpacity: '0.1',
        glassHoverOpacity: '0.18',
        glassActiveOpacity: '0.26',

        highlight: {
            pink: '#d699b6',
            purple: '#d699b6',
            blue: '#7fbbb3',
            cyan: '#83c092',
            green: '#a7c080',
            yellow: '#dbbc7f',
            orange: '#e69875',
            red: '#e67e80',
        },
    },
};

// ============================================
// THEME REGISTRY
// ============================================

export const themes: Theme[] = [
    // Signature
    frostedGlass,
    standardIssue,
    oledTheme,
    // Universal
    dracula,
    nord,
    gruvbox,
    // Modern
    materialTheme,
    ayuDark,
    nightOwl,
    synthwave84,
    rosePine,
    tokyoNight,
    kanagawa,
    // Classic
    githubDark,
    solarizedDark,
    monokai,
    oneDark,
    // Cozy
    solarizedSand,
    catppuccinMocha,
    catppuccinLatte,
    everforest,
];

export const themeCategories = [
    { id: 'signature', name: 'Signature', description: 'The StreamNook original' },
    { id: 'universal', name: 'Universal', description: 'The Big Three - most popular everywhere' },
    { id: 'modern', name: 'Modern & Soothing', description: 'Atmospheric and moody' },
    { id: 'classic', name: 'Classics', description: 'Strict and functional' },
    { id: 'cozy', name: 'Cozy & Pastel', description: 'Soft aesthetic vibes' },
];

// Helper functions
export const getThemeById = (id: string): Theme | undefined => {
    return themes.find((theme) => theme.id === id);
};

export const getThemesByCategory = (category: Theme['category']): Theme[] => {
    return themes.filter((theme) => theme.category === category);
};

// ============================================
// CUSTOM THEME UTILITIES
// ============================================

import type { CustomTheme, CustomThemeColor, CustomThemePalette } from '../types';

// Resolve a CustomThemeColor to a CSS-compatible string
const resolveColor = (c: CustomThemeColor): string => {
    if (c.opacity < 100) {
        // Convert hex to rgba with opacity
        const hex = c.value.replace('#', '');
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${c.opacity / 100})`;
    }
    return c.value;
};

// Convert CustomTheme to runtime Theme format
export const customThemeToTheme = (custom: CustomTheme): Theme => {
    const p = custom.palette;
    return {
        id: custom.id,
        name: custom.name,
        description: `Custom theme created ${new Date(custom.createdAt).toLocaleDateString()}`,
        category: 'signature', // Custom themes appear in signature category
        palette: {
            background: resolveColor(p.background),
            backgroundSecondary: resolveColor(p.backgroundSecondary),
            backgroundTertiary: resolveColor(p.backgroundTertiary),
            surface: resolveColor(p.surface),
            surfaceHover: resolveColor(p.surfaceHover),
            surfaceActive: resolveColor(p.surfaceActive),
            textPrimary: resolveColor(p.textPrimary),
            textSecondary: resolveColor(p.textSecondary),
            textMuted: resolveColor(p.textMuted),
            accent: resolveColor(p.accent),
            accentHover: resolveColor(p.accentHover),
            accentMuted: resolveColor(p.accentMuted),
            border: resolveColor(p.border),
            borderLight: resolveColor(p.borderLight),
            borderSubtle: resolveColor(p.borderSubtle),
            success: resolveColor(p.success),
            warning: resolveColor(p.warning),
            error: resolveColor(p.error),
            info: resolveColor(p.info),
            scrollbarThumb: resolveColor(p.scrollbarThumb),
            scrollbarTrack: resolveColor(p.scrollbarTrack),
            glassOpacity: p.glassOpacity,
            glassHoverOpacity: p.glassHoverOpacity,
            glassActiveOpacity: p.glassActiveOpacity,
            highlight: {
                pink: resolveColor(p.highlight.pink),
                purple: resolveColor(p.highlight.purple),
                blue: resolveColor(p.highlight.blue),
                cyan: resolveColor(p.highlight.cyan),
                green: resolveColor(p.highlight.green),
                yellow: resolveColor(p.highlight.yellow),
                orange: resolveColor(p.highlight.orange),
                red: resolveColor(p.highlight.red),
            },
        },
    };
};

// Parse color to extract hex value (handles rgba, rgb, and hex formats)
const parseColorToHex = (color: string): string => {
    if (color.startsWith('#')) {
        return color.length === 4
            ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
            : color;
    }
    if (color.startsWith('rgba') || color.startsWith('rgb')) {
        const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (match) {
            const r = parseInt(match[1]).toString(16).padStart(2, '0');
            const g = parseInt(match[2]).toString(16).padStart(2, '0');
            const b = parseInt(match[3]).toString(16).padStart(2, '0');
            return `#${r}${g}${b}`;
        }
    }
    return '#000000';
};

// Parse color to extract opacity (0-100)
const parseColorOpacity = (color: string): number => {
    if (color.startsWith('rgba')) {
        const match = color.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\)/);
        if (match) {
            return Math.round(parseFloat(match[1]) * 100);
        }
    }
    return 100;
};

// Create default custom theme palette based on an existing theme
export const createDefaultCustomPalette = (baseTheme: Theme): CustomThemePalette => {
    const makeColor = (value: string): CustomThemeColor => ({
        value: parseColorToHex(value),
        opacity: parseColorOpacity(value),
    });
    const p = baseTheme.palette;

    return {
        background: makeColor(p.background),
        backgroundSecondary: makeColor(p.backgroundSecondary),
        backgroundTertiary: makeColor(p.backgroundTertiary),
        surface: makeColor(p.surface),
        surfaceHover: makeColor(p.surfaceHover),
        surfaceActive: makeColor(p.surfaceActive),
        textPrimary: makeColor(p.textPrimary),
        textSecondary: makeColor(p.textSecondary),
        textMuted: makeColor(p.textMuted),
        accent: makeColor(p.accent),
        accentHover: makeColor(p.accentHover),
        accentMuted: makeColor(p.accentMuted),
        border: makeColor(p.border),
        borderLight: makeColor(p.borderLight),
        borderSubtle: makeColor(p.borderSubtle),
        success: makeColor(p.success),
        warning: makeColor(p.warning),
        error: makeColor(p.error),
        info: makeColor(p.info),
        scrollbarThumb: makeColor(p.scrollbarThumb),
        scrollbarTrack: makeColor(p.scrollbarTrack),
        glassOpacity: p.glassOpacity,
        glassHoverOpacity: p.glassHoverOpacity,
        glassActiveOpacity: p.glassActiveOpacity,
        highlight: {
            pink: makeColor(p.highlight.pink),
            purple: makeColor(p.highlight.purple),
            blue: makeColor(p.highlight.blue),
            cyan: makeColor(p.highlight.cyan),
            green: makeColor(p.highlight.green),
            yellow: makeColor(p.highlight.yellow),
            orange: makeColor(p.highlight.orange),
            red: makeColor(p.highlight.red),
        },
    };
};

// Get theme by ID, checking custom themes first
export const getThemeByIdWithCustom = (id: string, customThemes?: CustomTheme[]): Theme | undefined => {
    // Check custom themes first
    const custom = customThemes?.find((t) => t.id === id);
    if (custom) return customThemeToTheme(custom);
    
    // Fall back to built-in themes
    return themes.find((theme) => theme.id === id);
};

export const DEFAULT_THEME_ID = 'winters-glass';

// Helper function to lighten a hex color for neon effect
const lightenColor = (hex: string, percent: number): string => {
    // Handle rgb/rgba colors
    if (hex.startsWith('rgb')) {
        // For rgba colors, just return the base accent hover which is usually lighter
        return hex;
    }

    // Remove # if present
    hex = hex.replace('#', '');

    // Parse hex values
    let r = parseInt(hex.substring(0, 2), 16);
    let g = parseInt(hex.substring(2, 4), 16);
    let b = parseInt(hex.substring(4, 6), 16);

    // Lighten by mixing with white
    r = Math.min(255, Math.round(r + (255 - r) * (percent / 100)));
    g = Math.min(255, Math.round(g + (255 - g) * (percent / 100)));
    b = Math.min(255, Math.round(b + (255 - b) * (percent / 100)));

    // Convert back to hex
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
};

// Split a #rrggbb string into its channels (for building rgba() strings).
const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
    const h = hex.replace('#', '');
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
    };
};

// Resolve the OLED theme for a chosen accent. OLED is the one signature theme
// whose accent the user picks; this fills the accent-derived slots (hover/muted,
// secondary text, scrollbar) from a single hex so the look stays cohesive on
// pure black. Used both to paint the live theme (via applyTheme) and to preview
// the OLED card with the chosen color. An invalid/empty hex falls back to the
// default accent, so a bad saved value can never break the paint.
export const getOledTheme = (accentHex?: string): Theme => {
    const accent = accentHex && /^#[0-9a-fA-F]{6}$/.test(accentHex) ? accentHex : DEFAULT_OLED_ACCENT;
    const { r, g, b } = hexToRgb(accent);
    return {
        ...oledTheme,
        palette: {
            ...oledTheme.palette,
            accent,
            accentHover: lightenColor(accent, 20),
            accentMuted: `rgba(${r}, ${g}, ${b}, 0.5)`,
            // Soft tint of the accent (lavender for purple, peach for orange…),
            // mixed toward white so secondary text stays readable on black.
            textSecondary: lightenColor(accent, 45),
            scrollbarThumb: `rgba(${r}, ${g}, ${b}, 0.25)`,
        },
    };
};

// ─── Global glassiness ───────────────────────────────────────────────────────
// The Glassiness slider (Theme settings) scales every glass surface from the
// signature frosted, see-through look (100%) down to a completely flat, solid,
// blur-free interface (0%) for users who don't want any glass at all. Two things
// move together for that to read as "no glass": the surface TINTS lose their
// transparency, and the backdrop BLUR goes.
//
// Transparency is handled here in JS by recomputing --color-surface* live, so
// every consumer degrades in lockstep — the .glass-* classes, Tailwind
// `bg-surface`, and inline var(--color-surface) reads alike — with no per-surface
// CSS. Blur is handled in globals.css: the main glass classes scale their blur by
// --glass-strength, and html[data-glass="off"] hard-strips any remaining
// backdrop-filter at 0%.

// The untouched per-theme surface tints, captured on every applyTheme so the
// slider can re-derive the live colours without re-running the whole theme.
let activeSurfaceTints: {
    surface: string;
    surfaceHover: string;
    surfaceActive: string;
    tertiary: string;
} | null = null;

// Last glassiness applied (0..1), so applyTheme can repaint surfaces at the
// user's chosen level instead of flashing full glass on a theme switch.
let lastGlassStrength = 1;

// Blend a translucent surface tint toward a solid colour as glassiness drops.
// At strength 1 the original tint is returned (signature glass); at strength 0
// the tint is composited over the theme's opaque tertiary surface (source-over)
// and returned fully opaque; in between, colour and alpha interpolate, so the
// slider is a smooth continuum rather than an on/off switch.
const blendSurfaceForGlass = (tint: string, tertiaryHex: string, strength: number): string => {
    const a = parseColorOpacity(tint) / 100;
    const { r, g, b } = hexToRgb(parseColorToHex(tint));
    const base = hexToRgb(parseColorToHex(tertiaryHex));
    // Opaque source-over of the tint onto the tertiary surface.
    const solidR = r * a + base.r * (1 - a);
    const solidG = g * a + base.g * (1 - a);
    const solidB = b * a + base.b * (1 - a);
    // Interpolate raw (strength 1) → solid (strength 0).
    const lr = Math.round(r * strength + solidR * (1 - strength));
    const lg = Math.round(g * strength + solidG * (1 - strength));
    const lb = Math.round(b * strength + solidB * (1 - strength));
    const la = a * strength + (1 - strength);
    return `rgba(${lr}, ${lg}, ${lb}, ${la.toFixed(3)})`;
};

// Paint the live --color-surface* vars for a given glassiness (0..1).
const writeSurfaceGlass = (strength: number): void => {
    if (!activeSurfaceTints) return;
    const root = document.documentElement;
    const { surface, surfaceHover, surfaceActive, tertiary } = activeSurfaceTints;
    root.style.setProperty('--color-surface', blendSurfaceForGlass(surface, tertiary, strength));
    root.style.setProperty('--color-surface-hover', blendSurfaceForGlass(surfaceHover, tertiary, strength));
    root.style.setProperty('--color-surface-active', blendSurfaceForGlass(surfaceActive, tertiary, strength));
};

// Apply theme to CSS variables
export const applyTheme = (theme: Theme): void => {
    const root = document.documentElement;
    const { palette } = theme;

    // Core colors
    root.style.setProperty('--color-background', palette.background);
    root.style.setProperty('--color-background-secondary', palette.backgroundSecondary);
    root.style.setProperty('--color-background-tertiary', palette.backgroundTertiary);

    // Surface colors. Capture the raw per-theme tints, then paint them at the
    // current glassiness via writeSurfaceGlass so switching themes never flashes
    // full glass when the user has dialled it down (and a reduced level carries
    // straight over to the new palette). applyGlassStrength repaints on slider move.
    activeSurfaceTints = {
        surface: palette.surface,
        surfaceHover: palette.surfaceHover,
        surfaceActive: palette.surfaceActive,
        tertiary: palette.backgroundTertiary,
    };
    writeSurfaceGlass(lastGlassStrength);

    // Text colors
    root.style.setProperty('--color-text-primary', palette.textPrimary);
    root.style.setProperty('--color-text-secondary', palette.textSecondary);
    root.style.setProperty('--color-text-muted', palette.textMuted);

    // Accent colors
    root.style.setProperty('--color-accent', palette.accent);
    root.style.setProperty('--color-accent-hover', palette.accentHover);
    root.style.setProperty('--color-accent-muted', palette.accentMuted);
    // Generate neon variant by lightening accent by 30%
    root.style.setProperty('--color-accent-neon', lightenColor(palette.accent, 30));

    // Border colors
    root.style.setProperty('--color-border', palette.border);
    root.style.setProperty('--color-border-light', palette.borderLight);
    root.style.setProperty('--color-border-subtle', palette.borderSubtle);

    // Semantic colors
    root.style.setProperty('--color-success', palette.success);
    root.style.setProperty('--color-warning', palette.warning);
    root.style.setProperty('--color-error', palette.error);
    root.style.setProperty('--color-info', palette.info);

    // Scrollbar colors
    root.style.setProperty('--color-scrollbar-thumb', palette.scrollbarThumb);
    root.style.setProperty('--color-scrollbar-track', palette.scrollbarTrack);

    // Glass effect opacities
    root.style.setProperty('--glass-opacity', palette.glassOpacity);
    root.style.setProperty('--glass-hover-opacity', palette.glassHoverOpacity);
    root.style.setProperty('--glass-active-opacity', palette.glassActiveOpacity);

    // Highlight colors
    root.style.setProperty('--color-highlight-pink', palette.highlight.pink);
    root.style.setProperty('--color-highlight-purple', palette.highlight.purple);
    root.style.setProperty('--color-highlight-blue', palette.highlight.blue);
    root.style.setProperty('--color-highlight-cyan', palette.highlight.cyan);
    root.style.setProperty('--color-highlight-green', palette.highlight.green);
    root.style.setProperty('--color-highlight-yellow', palette.highlight.yellow);
    root.style.setProperty('--color-highlight-orange', palette.highlight.orange);
    root.style.setProperty('--color-highlight-red', palette.highlight.red);

    // Store theme id on body for potential CSS-based theme detection
    document.body.setAttribute('data-theme', theme.id);
};

// Default glassiness (percent). 100 = full frosted glass — the look every
// theme is tuned around.
export const DEFAULT_GLASS_TRANSPARENCY = 100;

// Apply the global glassiness to the live document. `transparency` is a percent
// (0-100): 100 is full frosted glass (the signature look every theme is tuned
// around), 0 is a completely flat, solid, blur-free interface. Writes
// --glass-strength (read by the blur scaling in globals.css), repaints the
// surface tints toward solid, and flags data-glass="off" at 0 so the CSS floor
// strips any remaining backdrop blur. Kept separate from applyTheme so switching
// themes never resets the user's chosen glassiness.
export const applyGlassStrength = (transparency: number): void => {
    const clamped = Math.max(0, Math.min(100, transparency)) / 100;
    lastGlassStrength = clamped;
    const root = document.documentElement;
    root.style.setProperty('--glass-strength', String(clamped));
    writeSurfaceGlass(clamped);
    root.setAttribute('data-glass', clamped === 0 ? 'off' : 'on');
};

// ─── App font ───────────────────────────────────────────────────────────────
// User-selectable interface font, chosen in Theme > Font. Like glassiness, it's
// independent of the color palette, so switching themes never resets it. The
// chosen stack is written to --app-font on :root; body and the Tailwind
// `font-sans` utility both read that variable (see globals.css / tailwind config).

export type FontId = 'satoshi' | 'twitch' | 'geist' | 'manrope' | 'outfit' | 'space-grotesk' | 'serif' | 'system';

export interface FontOption {
    id: FontId;
    label: string;
    description: string;
    /** font-family stack written to --app-font (and used for in-card previews). */
    stack: string;
    /**
     * Chat message body weight for this font, written to --chat-body-weight.
     * Denser faces (Inter) read heavier at a given weight, so they go lighter
     * here to keep chat looking lean. Defaults to 300 when omitted.
     */
    chatWeight?: number;
}

export const FONT_OPTIONS: FontOption[] = [
    {
        id: 'satoshi',
        label: 'Satoshi',
        description: 'The StreamNook house font. Clean, geometric sans.',
        stack: '"Satoshi", -apple-system, BlinkMacSystemFont, sans-serif',
    },
    {
        id: 'twitch',
        label: 'Twitch',
        description: 'Inter — the open-source typeface Twitch uses across its UI and chat.',
        stack: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        // Inter is denser than Satoshi, so chat at the normal 300 reads heavy.
        // Drop to 200 (ExtraLight) so chat stays lean under the Twitch font.
        chatWeight: 200,
    },
    {
        id: 'geist',
        label: 'Geist',
        description: 'A clean, modern geometric sans. Sleek and lean at any size.',
        stack: '"Geist", -apple-system, BlinkMacSystemFont, sans-serif',
    },
    {
        id: 'manrope',
        label: 'Manrope',
        description: 'Modern geometric sans, slightly narrow. Light and lean for dense UI.',
        stack: '"Manrope", -apple-system, BlinkMacSystemFont, sans-serif',
    },
    {
        id: 'outfit',
        label: 'Outfit',
        description: 'Uniform, minimal geometric sans. The most stripped-down of the set.',
        stack: '"Outfit", -apple-system, BlinkMacSystemFont, sans-serif',
    },
    {
        id: 'space-grotesk',
        label: 'Space Grotesk',
        description: 'Geometric sans with a little more character, still lean.',
        stack: '"Space Grotesk", -apple-system, BlinkMacSystemFont, sans-serif',
    },
    {
        id: 'serif',
        label: 'Serif',
        description: 'Fraunces — a soft, characterful serif for an editorial feel.',
        stack: '"Fraunces Variable", Georgia, "Times New Roman", serif',
    },
    {
        id: 'system',
        label: 'System',
        description: "Your device's native font. Fast and familiar.",
        stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    },
];

export const DEFAULT_FONT_ID: FontId = 'satoshi';

const FONT_BY_ID: Record<string, FontOption> = Object.fromEntries(
    FONT_OPTIONS.map((o) => [o.id, o]),
);

// Default chat message body weight (most fonts). Inter overrides lighter.
export const DEFAULT_CHAT_BODY_WEIGHT = 300;

// Apply the chosen interface font to the live document. Unknown ids fall back
// to the default so a stale/garbage setting can never blank the font. Also sets
// --chat-body-weight so chat message text can render lighter under denser faces.
export const applyFont = (fontId: string | undefined): void => {
    const opt = FONT_BY_ID[fontId ?? DEFAULT_FONT_ID] ?? FONT_BY_ID[DEFAULT_FONT_ID];
    const root = document.documentElement;
    root.style.setProperty('--app-font', opt.stack);
    root.style.setProperty('--chat-body-weight', String(opt.chatWeight ?? DEFAULT_CHAT_BODY_WEIGHT));
};
