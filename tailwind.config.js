/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{html,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Theme-aware colors using CSS variables
        background: 'var(--color-background)',
        secondary: 'var(--color-background-secondary)',
        tertiary: 'var(--color-background-tertiary)',
        accent: 'var(--color-accent)',
        'accent-hover': 'var(--color-accent-hover)',
        'accent-muted': 'var(--color-accent-muted)',
        textPrimary: 'var(--color-text-primary)',
        textSecondary: 'var(--color-text-secondary)',
        textMuted: 'var(--color-text-muted)',
        border: 'var(--color-border)',
        borderLight: 'var(--color-border-light)',
        borderSubtle: 'var(--color-border-subtle)',
        surface: 'var(--color-surface)',
        'surface-hover': 'var(--color-surface-hover)',
        'surface-active': 'var(--color-surface-active)',
        // Semantic colors
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        error: 'var(--color-error)',
        info: 'var(--color-info)',
        // Glass utility
        glass: {
          DEFAULT: 'var(--color-surface)',
          hover: 'var(--color-surface-hover)',
          active: 'var(--color-surface-active)',
        },
        // Highlight colors
        highlight: {
          pink: 'var(--color-highlight-pink)',
          purple: 'var(--color-highlight-purple)',
          blue: 'var(--color-highlight-blue)',
          cyan: 'var(--color-highlight-cyan)',
          green: 'var(--color-highlight-green)',
          yellow: 'var(--color-highlight-yellow)',
          orange: 'var(--color-highlight-orange)',
          red: 'var(--color-highlight-red)',
        },
      },
      fontFamily: {
        sans: ['Satoshi', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },
      backdropBlur: {
        xs: '2px',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        droplet: {
          '0%, 100%': {
            transform: 'translateY(-8px)',
            opacity: '0'
          },
          '20%': {
            transform: 'translateY(-8px)',
            opacity: '1'
          },
          '40%': {
            transform: 'translateY(-8px)',
            opacity: '1'
          },
          '60%': {
            transform: 'translateY(8px)',
            opacity: '1'
          },
          '80%': {
            transform: 'translateY(12px)',
            opacity: '0'
          },
        },
        splash: {
          '0%': {
            transform: 'scale(0.5)',
            opacity: '1'
          },
          '50%': {
            transform: 'scale(1.5)',
            opacity: '0.6'
          },
          '100%': {
            transform: 'scale(2.5)',
            opacity: '0'
          },
        },
        ripple: {
          '0%, 56%': {
            transform: 'scale(0.8)',
            opacity: '0'
          },
          '60%': {
            transform: 'scale(1.0)',
            opacity: '0.5'
          },
          '68%': {
            transform: 'scale(1.3)',
            opacity: '0.4'
          },
          '78%': {
            transform: 'scale(1.6)',
            opacity: '0.2'
          },
          '88%': {
            transform: 'scale(1.9)',
            opacity: '0.1'
          },
          '100%': {
            transform: 'scale(2.2)',
            opacity: '0'
          },
        },
      },
      animation: {
        shimmer: 'shimmer 2s ease-in-out infinite',
        droplet: 'droplet 2.5s ease-in-out infinite',
        splash: 'splash 0.6s ease-out forwards',
        ripple: 'ripple 2.5s ease-out infinite',
      },
    },
  },
  plugins: [],
}
