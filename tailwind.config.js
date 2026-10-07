module.exports = {
  content: ['./index.html', './app.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Noto Sans KR"', 'sans-serif'],
      },
      colors: {
        app: {
          bg: '#f8f9fa',
          card: '#ffffff',
          primary: '#09090b',
          accent: '#18181b',
          muted: '#71717a',
          border: '#e4e4e7',
        },
      },
      boxShadow: {
        card: '0 4px 20px -2px rgba(0, 0, 0, 0.04)',
        nav: '0 -2px 15px rgba(0, 0, 0, 0.04)',
        floating: '0 10px 25px -5px rgba(0, 0, 0, 0.15)',
      },
    },
  },
  plugins: [],
};
