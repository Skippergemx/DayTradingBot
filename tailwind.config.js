/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        navy: "#020617",
        'cyan-neon': "#22d3ee",
        'signal-pink': "#f472b6",
        'signal-orange': "#fb923c",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      animation: {
        'pulse-signal': 'pulse-signal 2s infinite',
        'marquee': 'marquee 30s linear infinite',
        'scanline': 'scanline 8s linear infinite',
      },
      keyframes: {
        'pulse-signal': {
          '0%': { boxShadow: '0 0 0 0 rgba(244, 114, 182, 0.4)' },
          '70%': { boxShadow: '0 0 0 15px rgba(244, 114, 182, 0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(244, 114, 182, 0)' },
        },
        'marquee': {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-25%)' },
        },
        'scanline': {
          '0%': { top: '-100%' },
          '100%': { top: '100%' },
        }
      }
    },
  },
  plugins: [],
}
