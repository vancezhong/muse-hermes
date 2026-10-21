import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import vue from '@vitejs/plugin-vue'
import { backendMiddleware, shutdownBackend } from './server/api.mjs'
import { attachVoiceWebSocket } from './server/voice.mjs'

const tlsCertPath = process.env.MUSE_TLS_CERT
const tlsKeyPath = process.env.MUSE_TLS_KEY
if (Boolean(tlsCertPath) !== Boolean(tlsKeyPath)) {
  throw new Error('Set both MUSE_TLS_CERT and MUSE_TLS_KEY to enable HTTPS.')
}
const https = tlsCertPath
  ? { cert: readFileSync(tlsCertPath), key: readFileSync(tlsKeyPath) }
  : undefined

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'muse-local-hermes-api',
      configureServer(server) {
        server.middlewares.use(backendMiddleware)
        if (server.httpServer) {
          attachVoiceWebSocket(server.httpServer)
          server.httpServer.once('close', shutdownBackend)
        }
      },
    },
  ],
  server: {
    host: process.env.MUSE_HOST || '127.0.0.1',
    https,
    strictPort: true,
  },
})
