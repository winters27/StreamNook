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

// Antidepressants - OE Military inspired, olive greens, tan, light browns
export const antidepressants: Theme = {
    id: 'antidepressants',
    name: 'Antidepressants',
    description: 'OE military aesthetic with olive greens, tan, and warm browns. Stark and grounding.',
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

// prince0fdubai's OLED - True black for OLED screens with subtle purple accents
export const prince0fdubaiOLED: Theme = {
    id: 'prince0fdubai-oled',
    name: "prince0fdubai's OLED",
    description: 'Pitch black OLED-friendly theme with subtle purple accents. Pure darkness.',
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

// Winters' Glass - The signature StreamNook theme
export const wintersGlass: Theme = {
    id: 'winters-glass',
    name: "Winters' Glass",
    description: 'Cool, frosted aesthetic with icy blue accents. The signature StreamNook theme.',
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
        backgroundSecondary: '#21222c',
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
        backgroundSecondary: '#3b4252',
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
        backgroundSecondary: '#32302f',
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
        backgroundSecondary: '#1f1d2e',
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
        backgroundSecondary: '#16161e',
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
        backgroundSecondary: '#16161d',
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

export const solarizedDark: Theme = {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    description: 'Mathematical precision with a unique teal background and low contrast.',
    category: 'classic',
    palette: {
        background: '#002b36',
        backgroundSecondary: '#073642',
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
        backgroundSecondary: '#1e1f1c',
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
        backgroundSecondary: '#21252b',
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
        backgroundSecondary: '#181825',
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
    description: 'Light, creamy variant of Catppuccin for those who prefer light themes.',
    category: 'cozy',
    palette: {
        background: '#eff1f5',
        backgroundSecondary: '#e6e9ef',
        backgroundTertiary: '#dce0e8',

        surface: 'rgba(136, 57, 239, 0.08)',
        surfaceHover: 'rgba(136, 57, 239, 0.15)',
        surfaceActive: 'rgba(136, 57, 239, 0.22)',

        textPrimary: '#4c4f69',
        textSecondary: '#8839ef',
        textMuted: 'rgba(76, 79, 105, 0.6)',

        accent: '#8839ef',
        accentHover: '#9752f2',
        accentMuted: 'rgba(136, 57, 239, 0.5)',

        border: 'rgba(136, 57, 239, 0.2)',
        borderLight: 'rgba(136, 57, 239, 0.12)',
        borderSubtle: 'rgba(136, 57, 239, 0.06)',

        success: '#40a02b',
        warning: '#df8e1d',
        error: '#d20f39',
        info: '#1e66f5',

        scrollbarThumb: 'rgba(136, 57, 239, 0.3)',
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

export const everforest: Theme = {
    id: 'everforest',
    name: 'Everforest',
    description: 'Nature-inspired with mossy greens, sage, and calming earth tones.',
    category: 'cozy',
    palette: {
        background: '#2d353b',
        backgroundSecondary: '#272e33',
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
    wintersGlass,
    prince0fdubaiOLED,
    antidepressants,
    // Universal
    dracula,
    nord,
    gruvbox,
    // Modern
    rosePine,
    tokyoNight,
    kanagawa,
    // Classic
    solarizedDark,
    monokai,
    oneDark,
    // Cozy
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

export const DEFAULT_THEME_ID = 'winters-glass';

// Apply theme to CSS variables
export const applyTheme = (theme: Theme): void => {
    const root = document.documentElement;
    const { palette } = theme;

    // Core colors
    root.style.setProperty('--color-background', palette.background);
    root.style.setProperty('--color-background-secondary', palette.backgroundSecondary);
    root.style.setProperty('--color-background-tertiary', palette.backgroundTertiary);

    // Surface colors
    root.style.setProperty('--color-surface', palette.surface);
    root.style.setProperty('--color-surface-hover', palette.surfaceHover);
    root.style.setProperty('--color-surface-active', palette.surfaceActive);

    // Text colors
    root.style.setProperty('--color-text-primary', palette.textPrimary);
    root.style.setProperty('--color-text-secondary', palette.textSecondary);
    root.style.setProperty('--color-text-muted', palette.textMuted);

    // Accent colors
    root.style.setProperty('--color-accent', palette.accent);
    root.style.setProperty('--color-accent-hover', palette.accentHover);
    root.style.setProperty('--color-accent-muted', palette.accentMuted);

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
