import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      colors: {
        ink: { DEFAULT: '#0f172a', soft: '#334155', muted: '#64748b' },
        brand: { DEFAULT: '#2563eb', soft: '#dbeafe', dark: '#1d4ed8' },
      },
    },
  },
  plugins: [],
} satisfies Config;
