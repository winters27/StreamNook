/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{html,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Frost Glass Theme Colors
        background: '#0c0c0d',
        secondary: 'rgba(255, 255, 255, 0.03)',
        accent: '#97b1b9',
        textPrimary: '#ffffff',
        textSecondary: '#97b1b9',
        border: 'rgba(151, 177, 185, 0.3)',
        borderLight: 'rgba(151, 177, 185, 0.2)',
        borderSubtle: 'rgba(151, 177, 185, 0.1)',
        glass: {
          DEFAULT: 'rgba(151, 177, 185, 0.15)',
          hover: 'rgba(151, 177, 185, 0.3)',
          active: 'rgba(151, 177, 185, 0.4)',
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
        shimmer: 'shimmer 3s linear infinite',
        droplet: 'droplet 2.5s ease-in-out infinite',
        splash: 'splash 0.6s ease-out forwards',
        ripple: 'ripple 2.5s ease-out infinite',
      },
    },
  },
  plugins: [],
}
