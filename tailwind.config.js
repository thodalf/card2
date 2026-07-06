export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {} },
  plugins: [],
  // Without this, `hover:` classes apply on tap on touch devices and stay stuck
  // until another element is tapped (e.g. a card looking permanently enlarged
  // after being moved) — gate hover styles to devices that actually support hover.
  future: { hoverOnlyWhenSupported: true },
}
