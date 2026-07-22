import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(async () => {
  // workbox-core's dev-mode logger reads `self` (a browser/SW global) at module load
  // time. `vite dev` runs this config under plain Node (NODE_ENV=development), which
  // has no `self`, so a static top-level import of workbox-range-requests would throw
  // before the config resolves. `vite build` is unaffected: it sets NODE_ENV=production
  // before loading this file, which short-circuits that logger branch. The dynamic
  // import below runs after the polyfill instead of being hoisted above it.
  if (typeof globalThis.self === 'undefined') {
    globalThis.self = globalThis
  }
  const { RangeRequestsPlugin } = await import('workbox-range-requests')

  return {
    define: {
      global: 'globalThis',
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        // Registered manually in main.jsx (via virtual:pwa-register) instead of the
        // default auto-injected script, so a new deployment can force-reload the
        // page immediately instead of waiting for the next natural navigation.
        injectRegister: false,
        includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'],
        manifest: {
          id: '/',
          name: 'Charta Logica',
          short_name: 'Charta Logica',
          description: 'Jeu de cartes tactique 2 joueurs pour affronter l\'IA ou d\'autres joueurs en ligne sur un plateau 5x5, avec deck-building et boosters de cartes.',
          lang: 'fr',
          theme_color: '#0f172a',
          background_color: '#0f172a',
          display: 'standalone',
          orientation: 'portrait',
          scope: '/',
          start_url: '/',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
          ],
          screenshots: [
            {
              src: '/screenshots/menu-wide.png',
              sizes: '1272x2644',
              type: 'image/png',
              form_factor: 'narrow',
              label: 'Menu principal de Charta Logica'
            },
            {
              src: '/screenshots/game-narrow.png',
              sizes: '1272x2637',
              type: 'image/png',
              form_factor: 'narrow',
              label: 'Partie en cours sur le plateau 5x5'
            }
          ]
        },
        workbox: {
          // Pre-cache JS, CSS, HTML only — large images/audio cached at runtime
          globPatterns: ['**/*.{js,css,html,ico,woff2}'],
          runtimeCaching: [
            {
              // Music tracks — cache on first use for offline play. <audio>/Audio()
              // playback issues Range requests (206 partial content), which Workbox's
              // default cacheable-response check rejects — without RangeRequestsPlugin
              // every play attempt also fires a doomed-to-fail cache-write behind the
              // scenes (visible in devtools as a spurious extra 503 on the same URL).
              // The plugin caches the full response once and serves any requested byte
              // range out of that single cached copy instead.
              urlPattern: /\/musiques\/.+\.mp3$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'audio-cache',
                expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 30 },
                plugins: [new RangeRequestsPlugin()]
              }
            },
            {
              // Combat/UI sound effects — same idea as the music cache above
              urlPattern: /\/sounds\/.+\.wav$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'sfx-cache',
                expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 30 }
              }
            },
            {
              // Game images
              urlPattern: /\/images\/.+\.(png|jpg|webp|svg)$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'image-cache',
                expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 }
              }
            },
            {
              // Google Fonts CSS
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-css',
                expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] }
              }
            },
            {
              // Google Fonts assets
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-assets',
                expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] }
              }
            }
          ]
        },
        devOptions: { enabled: false }
      })
    ]
  }
})
