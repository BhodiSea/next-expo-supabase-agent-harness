import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { assertAuthBootSafety } from './auth/verify.js'
import { closeDb } from './db/client.js'

// Fatal before binding a port: production must never boot with the stub verifier.
assertAuthBootSafety(process.env)

function resolvePort(): number {
  const raw = process.env['PORT']
  if (raw === undefined || raw === '') {
    return 8787
  }
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid PORT: ${raw}`)
  }
  return port
}

const app = createApp()
const server = serve({ fetch: app.fetch, port: resolvePort() }, (info) => {
  console.log(`server listening on http://localhost:${String(info.port)}`)
})

let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  console.log(`${signal} received — draining connections`)
  server.close(() => {
    void closeDb().finally(() => {
      process.exit(0)
    })
  })
  // SOURCE: graceful-shutdown doctrine — bound the drain: long-lived SSE sockets can
  // hold close() open forever; 10s then force-exit nonzero [corpus: harness/doctrine]
  setTimeout(() => {
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM')
})
process.on('SIGINT', () => {
  shutdown('SIGINT')
})
