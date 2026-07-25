import { describe, expect, it } from 'vitest'
import { appRouter } from '../index.js'

// Span-per-procedure contract (observability module). Doctrine: the tRPC API is
// mounted at a SINGLE Next route handler (apps/web/app/api/trpc/[trpc]/route.ts),
// so there is no HTTP route TABLE to walk — the low-cardinality unit is the tRPC
// PROCEDURE PATH (`notes.create`, `system.health`). Each path is a static, dotted
// identifier by construction: it never carries a resolved id, so a server span
// named from it aggregates cleanly instead of exploding one time series per row.
// This suite pins the two halves that are checkable BEFORE the OTel SDK is wired:
//   1. the span-name manifest derives from the REAL router (a procedure cannot
//      dodge the naming contract silently — this test's expectation must change
//      in the same PR that adds the procedure),
//   2. every derived span name is identifier-shaped (no uuid/number segments).
// The it.todo seams below activate when you apply the wiring patch in
// docs/modules/observability/otel-server.patch.md.

// The span-name manifest: every procedure path the router exposes, deduplicated
// and sorted. tRPC v11 flattens nested routers into a SINGLE `_def.procedures`
// record keyed by the full dotted path — the same walk skew.test.ts uses to prove
// no procedure escapes the version-skew guard, so the two contracts read the
// router the one identical way.
function spanNameManifest(): string[] {
  return [...new Set(Object.keys(appRouter._def.procedures))].sort()
}

describe('span-per-procedure manifest (walks the real tRPC router)', () => {
  it('derives one span name per procedure — extend the expectation when procedures land', () => {
    // Non-vacuous: the scaffold's seven procedures must all be present. When you
    // add a procedure to a router, this expectation fails until you add its span
    // name HERE — that same-PR friction is the contract: a procedure cannot ship
    // without its span name being reviewed.
    expect(spanNameManifest()).toEqual([
      'notes.create',
      'notes.get',
      'notes.list',
      'notes.remove',
      'notes.update',
      'system.health',
      'system.me',
    ])
  })

  it('keeps every span name low-cardinality (identifier segments, never resolved ids)', () => {
    for (const name of spanNameManifest()) {
      for (const segment of name.split('.').filter((s) => s !== '')) {
        const looksResolved = /^[0-9a-f-]{8,}$/i.test(segment) || /^\d+$/.test(segment)
        expect(
          !looksResolved,
          `span name "${name}" contains a resolved-looking segment "${segment}" — a tRPC span name must be the static procedure PATH, never a resolved id`,
        ).toBe(true)
      }
    }
  })

  // Activate after applying docs/modules/observability/otel-server.patch.md:
  it.todo(
    'emits exactly one server span per call, named from this manifest (wire @opentelemetry/sdk-trace-node + an InMemorySpanExporter, call each procedure through createCallerFactory(appRouter), assert one span whose name equals the manifest entry)',
  )
  it.todo(
    'propagates log correlation (trace_id/span_id appear on request-scoped @app/observability records emitted during a procedure call)',
  )
})
