export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        apple: {
          bg:        '#000000',
          bg2:       '#1c1c1e',
          bg3:       '#2c2c2e',
          bg4:       '#3a3a3c',
          blue:      '#0a84ff',
          green:     '#30d158',
          red:       '#ff453a',
          orange:    '#ff9f0a',
          yellow:    '#ffd60a',
          teal:      '#40c8e0',
          purple:    '#bf5af2',
          indigo:    '#5e5ce6',
          label:     '#ffffff',
          label2:    'rgba(235,235,245,0.6)',
          label3:    'rgba(235,235,245,0.3)',
          sep:       'rgba(84,84,88,0.65)',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Display"',
          '"SF Pro Text"',
          '"Helvetica Neue"',
          'Arial',
          'system-ui',
          'sans-serif',
        ],
      },
      borderRadius: {
        apple: '16px',
        'apple-sm': '10px',
        'apple-xs': '8px',
      },
      boxShadow: {
        apple:    '0 4px 20px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.06) inset',
        'apple-lg': '0 14px 44px rgba(0,0,0,0.55)',
        blue:     '0 2px 16px rgba(10,132,255,0.38)',
      },
      backdropBlur: {
        apple: '24px',
      },
    }
  },
  plugins: [],
}
