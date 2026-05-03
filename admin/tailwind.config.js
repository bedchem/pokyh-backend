export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        dark: {
          900: '#080810',
          800: '#0e0f1c',
          700: '#141528',
          600: '#1a1b30',
          500: '#212338',
        },
        accent: {
          DEFAULT: '#6366f1',
          hover: '#818cf8',
        }
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
    }
  },
  plugins: [],
}
