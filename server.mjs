import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { backendMiddleware, shutdownBackend } from './server/api.mjs'
import { attachVoiceWebSocket } from './server/voice.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
const dist = resolve(root, 'dist')
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url || '/', 'http://localhost')
  let pathname = decodeURIComponent(requestUrl.pathname)
  if (pathname === '/') pathname = '/index.html'

  let file = resolve(dist, `.${pathname}`)
  if (!file.startsWith(`${dist}${sep}`) && file !== resolve(dist, 'index.html')) {
    res.writeHead(403).end('Forbidden')
    return
  }

  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
  } catch {
    file = resolve(dist, 'index.html')
  }

  try {
    const body = await readFile(file)
    res.writeHead(200, {
      'Content-Type': mimeTypes[extname(file)] || 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('Build the app first with npm run build.')
  }
}

const tlsCertPath = process.env.MUSE_TLS_CERT
const tlsKeyPath = process.env.MUSE_TLS_KEY
if (Boolean(tlsCertPath) !== Boolean(tlsKeyPath)) {
  throw new Error('Set both MUSE_TLS_CERT and MUSE_TLS_KEY to enable HTTPS.')
}
const tlsOptions = tlsCertPath
  ? { cert: await readFile(tlsCertPath), key: await readFile(tlsKeyPath) }
  : null
const handleRequest = (req, res) => {
  backendMiddleware(req, res, () => serveStatic(req, res))
}
const server = createHttpServer(handleRequest)
attachVoiceWebSocket(server)
const port = Number(process.env.PORT || 4173)
const host = process.env.MUSE_HOST || '127.0.0.1'
const httpsPort = Number(process.env.MUSE_HTTPS_PORT || port + 1)
const httpsServer = tlsOptions ? createHttpsServer(tlsOptions, handleRequest) : null
if (httpsServer) attachVoiceWebSocket(httpsServer)

function urlsFor(protocol, listenPort) {
  const addresses = Object.values(networkInterfaces())
    .flatMap((items) => items || [])
    .filter((item) => item.family === 'IPv4' && !item.internal)
    .map((item) => item.address)
  return [...new Set(['127.0.0.1', ...addresses])]
    .map((address) => `${protocol}://${address}:${listenPort}`)
}

server.listen(port, host, () => {
  console.log(`Muse HTTP is running:\n${urlsFor('http', port).map((url) => `  ${url}`).join('\n')}`)
})
httpsServer?.listen(httpsPort, host, () => {
  console.log(`Muse HTTPS is running:\n${urlsFor('https', httpsPort).map((url) => `  ${url}`).join('\n')}`)
})

function stop() {
  const servers = httpsServer ? [server, httpsServer] : [server]
  let remaining = servers.length
  for (const item of servers) item.close(() => {
    remaining -= 1
    if (remaining === 0) {
      shutdownBackend()
      process.exit(0)
    }
  })
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
