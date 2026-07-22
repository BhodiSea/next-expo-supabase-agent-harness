// HITL backfill state machine — transition-matrix contract (ops-backup module).
// Two layers:
//   1. PURE (runs from day one): the matrix itself is consistent — terminal
//      states, reachability, no self-transitions, no undeclared states.
//   2. DATABASE (skeleton — skips loudly until the consuming app creates its
//      approval table): every transition NOT in the matrix must be rejected by
//      the DATABASE (CHECK/trigger/RLS), not by application politeness.
// See docs/runbooks/backfill.md for the state machine this encodes.
// cspell:ignore hitl
import { describe, expect, it } from 'vitest'
import { appSql, RLS_SUITE_READY } from './db-context'

// ---- CONFIG (TODO seams: rename to match your schema when it lands) ----------
const HITL_TABLE = 'review_queue'
const STATE_COLUMN = 'state'

type HitlState = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'executed' | 'aborted'

// The ONLY legal transitions (docs/runbooks/backfill.md). Everything else must
// be impossible at the database layer.
const TRANSITIONS: Readonly<Record<HitlState, readonly HitlState[]>> = {
  draft: ['pending_review'],
  pending_review: ['approved', 'rejected'],
  rejected: ['draft'],
  approved: ['executed', 'aborted'],
  executed: [],
  aborted: [],
}

const STATES = Object.keys(TRANSITIONS) as HitlState[]

describe('HITL transition matrix — pure consistency (always runs)', () => {
  it('declares terminal states and only terminal states with no exits', () => {
    const terminal = STATES.filter((s) => TRANSITIONS[s].length === 0)
    expect(terminal.sort()).toEqual(['aborted', 'executed'])
  })

  it('contains no self-transitions (a no-op "transition" hides audit gaps)', () => {
    for (const state of STATES) {
      expect(TRANSITIONS[state], `${state} must not transition to itself`).not.toContain(state)
    }
  })

  it('reaches every state from draft (no orphaned states)', () => {
    const reachable = new Set<HitlState>(['draft'])
    let grew = true
    while (grew) {
      grew = false
      for (const state of [...reachable]) {
        for (const next of TRANSITIONS[state]) {
          if (!reachable.has(next)) {
            reachable.add(next)
            grew = true
          }
        }
      }
    }
    expect([...reachable].sort()).toEqual([...STATES].sort())
  })

  it('never lets a non-review state reach approved directly', () => {
    for (const state of STATES) {
      if (state === 'pending_review') continue
      expect(TRANSITIONS[state], `${state} → approved would bypass human review`).not.toContain(
        'approved',
      )
    }
  })
})

if (!RLS_SUITE_READY) {
  describe.skip('HITL transition matrix — database enforcement (skipped: database not ready)', () => {
    it('database not ready — run via node tests/rls/run-rls.mjs', () => {
      expect(true).toBe(true)
    })
  })
} else {
  describe('HITL transition matrix — database enforcement (skeleton)', () => {
    it('rejects every transition absent from the matrix', async (ctx) => {
      const sql = appSql()
      try {
        const table = await sql`
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ${HITL_TABLE}`
        if (table.length === 0) {
          console.log(
            `[hitl] TODO: table "${HITL_TABLE}" does not exist yet — this skeleton activates when your approval schema lands (see docs/runbooks/backfill.md)`,
          )
          ctx.skip()
          return
        }
        // TODO(project): with the table present, drive the real assertion —
        // for each pair (from, to) NOT in TRANSITIONS:
        //   1. seed a row in state `from` (through the app path, as its creator)
        //   2. attempt UPDATE ${HITL_TABLE} SET ${STATE_COLUMN} = to
        //   3. expect rejection from the DATABASE: check violation (SQLSTATE
        //      23514), trigger exception, or RLS (42501) — never a silent 0-row
        //      "success" and never an app-layer-only guard.
        expect.fail(
          `table "${HITL_TABLE}" exists (column "${STATE_COLUMN}") but the transition assertions are still the skeleton — implement the TODO above before relying on this gate`,
        )
      } finally {
        await sql.end({ timeout: 5 })
      }
    })
  })
}
