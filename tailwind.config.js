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
    },
  },
  plugins: [],
}
