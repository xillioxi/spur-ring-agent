import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudBridgePlugin } from './cloud-bridge.mjs'

export default defineConfig({
  plugins: [react(), cloudBridgePlugin()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    fs: {
      // Runtime data and server credentials must never be served as Vite assets.
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.runtime/**', '**/*.env'],
    },
    proxy: {
      '/api': {
        target:
          process.env.VITE_CREATOR_AGENT_BACKEND || 'http://127.0.0.1:4173',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, incoming) => {
            const target = new URL(
              process.env.VITE_CREATOR_AGENT_BACKEND || 'http://127.0.0.1:4173'
            )
            const devHost = incoming.headers.host
            const localDev =
              typeof devHost === 'string' && /^(?:127\.0\.0\.1|localhost):\d+$/.test(devHost)
            const origin = incoming.headers.origin
            const sameOrigin =
              origin === `http://${devHost}` ||
              (!origin && incoming.headers['sec-fetch-site'] === 'same-origin')
            // Match the existing local-only origin contract, never attach a cloud Bearer.
            if (
              localDev &&
              sameOrigin &&
              ['127.0.0.1', 'localhost'].includes(target.hostname) &&
              target.port === '4173'
            ) {
              outgoing.setHeader('Origin', target.origin)
            }
          })
        },
      },
    },
  },
})
