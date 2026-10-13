// Every colour resolves to a CSS variable defined in src/index.css, so the
// same class follows the light and the dark theme.
const tone = (name) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: tone('canvas'),
        sheet:  tone('sheet'),
        raise:  tone('raise'),
        well:   { DEFAULT: tone('well'), deep: tone('well-2') },
        line:   tone('line'),
        ink:    { DEFAULT: tone('ink'), 2: tone('ink-2'), 3: tone('ink-3'), 4: tone('ink-4') },
        sky:    { DEFAULT: tone('sky'),   deep: tone('sky-deep'),   wash: tone('sky-wash') },
        amber:  { DEFAULT: tone('amber'), deep: tone('amber-deep'), wash: tone('amber-wash') },
        mint:   { DEFAULT: tone('mint'),  deep: tone('mint-deep'),  wash: tone('mint-wash') },
        rose:   { DEFAULT: tone('rose'),  deep: tone('rose-deep'),  wash: tone('rose-wash') },
        // The inverted surface of tooltips, toasts and menus.
        tip:    { DEFAULT: 'var(--tip)', ink: 'var(--tip-ink)', dim: 'var(--tip-dim)' },
      },
      fontFamily: {
        sans: ['Poppins', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', '"SF Mono"', '"Cascadia Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        sheet: '34px',
        well:  '22px',
      },
      transitionTimingFunction: {
        glide: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
}
