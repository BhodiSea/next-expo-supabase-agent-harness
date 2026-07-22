import { describe, expect, it } from 'vitest'
import { type AppOptions, createApp } from '../app.js'
import type { NotesDal } from '../types.js'

// Span-per-route contract (observability module). Doctrine: every API route
// produces exactly one server span named `METHOD /route/path` — low-cardinality
// (the TEMPLATE path, never the resolved id) so traces aggregate. This suite
// pins the two halves that are checkable BEFORE the OTel SDK is wired:
//   1. the span-name manifest derives from the REAL route table (a new route
//      cannot dodge the naming contract silently — this test's expectations
//      must change in the same PR),
//   2. every derived span name is template-shaped (no uuid/number segments).
// The it.todo seams below activate when you apply the wiring patch in
// docs/modules/observability/otel-server.patch.md.

const USER_ID = '11111111-1111-4111-8111-111111111111'

// NotesDal.list returns a keyset PAGE ({ items, nextCursor }), never a bare
// array — a `[]` fake here would red `tsc -b` on every install that enables
// this module, because this file type-checks against the real DAL contract.
const emptyDal: NotesDal = {
  list: () => Promise.resolve({ items: [], nextCursor: null }),
  create: () => Promise.reject(new Error('not under test')),
  get: () => Promise.resolve(null),
  remove: () => Promise.resolve(false),
}

const options: AppOptions = {
  version: '1.2.3',
  verifyToken: () => Promise.resolve({ userId: USER_ID }),
  notesDal: emptyDal,
}

// The span-name manifest: derived from the live route table, deduplicated
// (middleware registers additional handlers on the same method+path).
function spanNameManifest(): string[] {
  const app = createApp(options)
  const names = app.routes
    .filter((route) => route.method !== 'ALL' && route.path.startsWith('/api/'))
    .map((route) => `${route.method} ${route.path}`)
  return [...new Set(names)].sort()
}

describe('span-per-route manifest (walks the real route table)', () => {
  it('derives one span name per API route — extend the expectation when routes land', () => {
    // Non-vacuous: the scaffold's five /api routes must all be present. When you
    // add a route, this expectation fails until you add its span name HERE —
    // that same-PR friction is the contract.
    // Hono stores OpenAPI `{id}` params as `:id` in its route table.
    expect(spanNameManifest()).toEqual([
      'DELETE /api/notes/:id',
      'GET /api/events/demo',
      'GET /api/notes',
      'GET /api/notes/:id',
      'POST /api/notes',
    ])
  })

  it('keeps every span name low-cardinality (template segments, never resolved ids)', () => {
    for (const name of spanNameManifest()) {
      const path = name.split(' ')[1] ?? ''
      for (const segment of path.split('/').filter((s) => s !== '')) {
        const isTemplate = segment.startsWith('{') || segment.startsWith(':')
        const looksResolved = /^[0-9a-f-]{8,}$/i.test(segment) || /^\d+$/.test(segment)
        expect(
          isTemplate || !looksResolved,
          `span name "${name}" contains a resolved-looking segment "${segment}" — span names must use the route TEMPLATE`,
        ).toBe(true)
      }
    }
  })

  // Activate after applying docs/modules/observability/otel-server.patch.md:
  it.todo(
    'emits exactly one server span per request, named from this manifest (wire @opentelemetry/sdk-node + an InMemorySpanExporter, request each route, assert one span with the manifest name)',
  )
  it.todo(
    'propagates pino log correlation (trace_id/span_id appear on request-scoped log lines via instrumentation-pino)',
  )
})
