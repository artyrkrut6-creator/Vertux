module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#050505',
        primary: '#8b5cf6', // Electric Violet
        accent: '#06b6d4', // Cyan
      },
      fontFamily: {
        inter: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        'glow-violet-sm': '0 0 8px rgba(139,92,246,0.35)',
        'glow-violet': '0 0 18px rgba(139,92,246,0.45)',
        'glow-cyan': '0 0 14px rgba(6,182,212,0.35)'
      },
      dropShadow: {
        'neon-violet': '0 0 8px rgba(139,92,246,0.6)',
        'neon-cyan': '0 0 8px rgba(6,182,212,0.6)'
      }
    }
  },
  plugins: []
}
