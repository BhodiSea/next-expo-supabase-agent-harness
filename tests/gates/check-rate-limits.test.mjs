// Can-fail proofs for the rate-limits gate (template/base/tools/check-rate-limits.mjs).
//
// The gate has three independent halves and they fail for different reasons, so the cases
// do too:
//
//   the CLOSURE — a mutation the policy never heard of. This is the one that matters: the
//     seam is wired, the tests pass, and the newest write path is the only thing running
//     unbounded. Nothing else in the chain notices.
//   the BY-VALUE diff — the budget that runs is not the budget somebody approved, in
//     either direction.
//   the WIRING — a policy nothing consults. Both seams are asserted separately because
//     they share no code: a browser posting a Server Action id never goes near a
//     procedure.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const GATE_SRC = join(ROOT, 'template/base/tools/check-rate-limits.mjs')
const LIB_SRC = join(ROOT, 'template/base/tools/lib')
const BUDGET_SRC = join(ROOT, 'template/base/tools/rate-limit-budget.json')

/** The shipped inventory shape: the generator emits `{ action, type }` rows. */
const INVENTORY = [
  { action: 'notes.create', type: 'mutation' },
  { action: 'notes.get', type: 'query' },
  { action: 'notes.list', type: 'query' },
  { action: 'notes.remove', type: 'mutation' },
  { action: 'notes.update', type: 'mutation' },
  { action: 'system.health', type: 'query' },
  { action: 'system.me', type: 'query' },
]

/**
 * A stand-in for apps/web/lib/rate-limit.ts, built from the same knobs the real one is.
 * The gate EVALUATES this file, so it has to be real TypeScript with zero value imports —
 * which is exactly the property the real module is required to keep.
 */
/**
 * @param {{ buckets?: { limit: number, name: string, windowSeconds: number }[],
 *           procedures?: Record<string, string | null>, actions?: Record<string, string | null>,
 *           unknownIsNull?: boolean }} [opts]
 */
function policyModule({ buckets, procedures, actions, unknownIsNull = false } = {}) {
  const decl = (buckets ?? [
    { limit: 300, name: 'read', windowSeconds: 60 },
    { limit: 60, name: 'write', windowSeconds: 60 },
    { limit: 10, name: 'provisioning', windowSeconds: 3600 },
  ])
    .map((b) => `  { limit: ${b.limit}, name: '${b.name}', windowSeconds: ${b.windowSeconds} },`)
    .join('\n')
  const procMap = Object.entries(
    procedures ?? {
      'notes.create': 'write',
      'notes.get': 'read',
      'notes.list': 'read',
      'notes.remove': 'write',
      'notes.update': 'write',
      'system.health': null,
      'system.me': 'read',
    },
  )
    .map(([k, v]) => `  '${k}': ${v === null ? 'null' : `byName('${v}')`},`)
    .join('\n')
  const actionMap = Object.entries(
    actions ?? {
      acceptInvitationAction: 'provisioning',
      createNoteAction: 'write',
      ensurePersonalOrgAction: 'provisioning',
    },
  )
    .map(([k, v]) => `  '${k}': ${v === null ? 'null' : `byName('${v}')`},`)
    .join('\n')
  const fallback = unknownIsNull ? 'null' : "byName('write')"
  return `interface Bucket { readonly limit: number; readonly name: string; readonly windowSeconds: number }
const BUCKETS: readonly Bucket[] = [
${decl}
]
function byName(n: string): Bucket {
  const found = BUCKETS.find((b) => b.name === n)
  if (found === undefined) throw new Error('unknown bucket ' + n)
  return found
}
export function rateLimitBuckets(): readonly Bucket[] {
  return BUCKETS
}
const PROCEDURES: Readonly<Record<string, Bucket | null>> = {
${procMap}
}
const ACTIONS: Readonly<Record<string, Bucket | null>> = {
${actionMap}
}
export function bucketForProcedure(p: string): Bucket | null {
  if (!Object.hasOwn(PROCEDURES, p)) return ${fallback}
  return PROCEDURES[p] ?? null
}
export function bucketForAction(a: string): Bucket | null {
  if (!Object.hasOwn(ACTIONS, a)) return ${fallback}
  return ACTIONS[a] ?? null
}
`
}

const ROUTE_OK = `export const handler = async (request: Request) => {
  return fetchRequestHandler({
    createContext: () => createContext({ headers: request.headers, rateLimit: async (r) => spend(r) }),
  })
}
`

const ACTIONS_OK = `'use server'
export async function createNoteAction() {
  const limited = await enforceActionRateLimit('createNoteAction')
  if (limited !== null) return limited
}
export async function ensurePersonalOrgAction() {
  const limited = await enforceActionRateLimit('ensurePersonalOrgAction')
  if (limited !== null) return limited
}
export async function acceptInvitationAction() {
  const limited = await enforceActionRateLimit('acceptInvitationAction')
  if (limited !== null) return limited
}
`

/**
 * `budget` edits the shipped budget in place; `rawBudget` replaces the file BYTE for byte
 * (the malformed-JSON cases, which a structured edit cannot express).
 * @param {{ budget?: (base: any) => any, rawBudget?: string,
 *           inventory?: { action: string, type: string }[], policy?: string,
 *           route?: string, actions?: string }} [opts]
 */
function fixture({
  budget,
  rawBudget,
  inventory = INVENTORY,
  policy = policyModule(),
  route = ROUTE_OK,
  actions = ACTIONS_OK,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-ratelimits-'))
  mkdirSync(join(dir, 'tools/generated'), { recursive: true })
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  mkdirSync(join(dir, 'apps/web/lib'), { recursive: true })
  mkdirSync(join(dir, 'apps/web/app/api/trpc/[trpc]'), { recursive: true })
  mkdirSync(join(dir, 'apps/web/app/actions'), { recursive: true })
  cpSync(GATE_SRC, join(dir, 'tools/check-rate-limits.mjs'))
  cpSync(LIB_SRC, join(dir, 'tools/lib'), { recursive: true })

  const base = JSON.parse(readFileSync(BUDGET_SRC, 'utf8'))
  writeFileSync(
    join(dir, 'tools/rate-limit-budget.json'),
    rawBudget ?? JSON.stringify(budget ? budget(base) : base),
  )
  if (inventory !== null) {
    writeFileSync(join(dir, 'tools/generated/action-inventory.json'), JSON.stringify(inventory))
  }
  if (policy !== null) writeFileSync(join(dir, 'apps/web/lib/rate-limit.ts'), policy)
  if (route !== null) writeFileSync(join(dir, 'apps/web/app/api/trpc/[trpc]/route.ts'), route)
  if (actions !== null) writeFileSync(join(dir, 'apps/web/app/actions/notes.ts'), actions)
  return dir
}

function runGate(dir) {
  const env = { ...process.env }
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  const res = spawnSync(process.execPath, ['tools/check-rate-limits.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...env, CI: 'true' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// ── the reference shape ───────────────────────────────────────────────────────

test('GREEN: the shipped budget passes against the shipped router shape', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
})

// ── THE CLOSURE ───────────────────────────────────────────────────────────────

test('RED: a mutation with no bucket and no exemption — the failure the gate exists for', () => {
  // Everything else about this tree is correct: the limiter is wired, both seams call it,
  // the budgets are reviewed, the tests pass. One write path is unbounded and nothing
  // else in the chain can see it.
  const r = runGate(
    fixture({
      inventory: [...INVENTORY, { action: 'notes.archive', type: 'mutation' }],
      policy: policyModule(),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('notes.archive is a MUTATION with no bucket'), r.out)
  assert.ok(r.out.includes('running unbounded'), r.out)
})

test('GREEN: the same mutation with a reasoned exemption', () => {
  const r = runGate(
    fixture({
      inventory: [...INVENTORY, { action: 'notes.archive', type: 'mutation' }],
      budget: (b) => ({
        ...b,
        exemptProcedures: [
          ...b.exemptProcedures,
          {
            action: 'notes.archive',
            reason: 'exercising the escape, not a real exemption — it must be long enough to be a real argument',
          },
        ],
      }),
      policy: policyModule({
        procedures: {
          'notes.create': 'write',
          'notes.get': 'read',
          'notes.list': 'read',
          'notes.remove': 'write',
          'notes.update': 'write',
          'notes.archive': null,
          'system.health': null,
          'system.me': 'read',
        },
      }),
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('RED: mapped AND exempt — the contract contradicts itself', () => {
  // The policy module honours the mapping too, so the by-value diff is SILENT and the
  // contradiction is the only finding. A case that reds for two reasons proves neither.
  const r = runGate(
    fixture({
      budget: (b) => ({
        ...b,
        procedures: { ...b.procedures, 'system.health': 'read' },
      }),
      policy: policyModule({
        procedures: {
          'notes.create': 'write',
          'notes.get': 'read',
          'notes.list': 'read',
          'notes.remove': 'write',
          'notes.update': 'write',
          'system.health': 'read',
          'system.me': 'read',
        },
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('BOTH mapped'), r.out)
})

test('RED: a stale mapping naming a procedure the router no longer exposes', () => {
  const r = runGate(
    fixture({ budget: (b) => ({ ...b, procedures: { ...b.procedures, 'notes.gone': 'write' } }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('the router does not expose'), r.out)
})

test('RED: a stale EXEMPTION is a hole waiting for a procedure to arrive under that name', () => {
  const r = runGate(
    fixture({
      budget: (b) => ({
        ...b,
        exemptProcedures: [
          {
            action: 'system.metrics',
            reason: 'a procedure that was removed, whose unlimited status outlived it entirely',
          },
        ],
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('hole waiting for a procedure'), r.out)
})

// ── the BY-VALUE diff ─────────────────────────────────────────────────────────

test('RED: a limit changed in CODE without a reviewed diff', () => {
  const r = runGate(
    fixture({
      policy: policyModule({
        buckets: [
          { limit: 300, name: 'read', windowSeconds: 60 },
          { limit: 999, name: 'write', windowSeconds: 60 },
          { limit: 10, name: 'provisioning', windowSeconds: 3600 },
        ],
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('runs 999/60s but'), r.out)
})

test('RED: a limit changed in the JSON that the code does not honour', () => {
  const r = runGate(
    fixture({
      budget: (b) => ({
        ...b,
        buckets: b.buckets.map((x) => (x.name === 'write' ? { ...x, limit: 5 } : x)),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('approves 5/60s'), r.out)
})

test('RED: a documented exemption the code does not apply', () => {
  // The worst of the three: the reason sits in the contract reading as if it were in
  // force, and the endpoint it describes is being limited anyway (or vice versa).
  const r = runGate(
    fixture({
      policy: policyModule({
        procedures: {
          'notes.create': 'write',
          'notes.get': 'read',
          'notes.list': 'read',
          'notes.remove': 'write',
          'notes.update': 'write',
          'system.health': 'read',
          'system.me': 'read',
        },
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('but tools/rate-limit-budget.json exempts it'), r.out)
})

test('RED: an unknown name resolving to null makes "forgot to map it" and "unlimited" the same value', () => {
  const r = runGate(fixture({ policy: policyModule({ unknownIsNull: true }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('returns null (unlimited) for an UNKNOWN name'), r.out)
})

test('RED: a bucket declared in code that the contract never approved', () => {
  const r = runGate(
    fixture({
      policy: policyModule({
        buckets: [
          { limit: 300, name: 'read', windowSeconds: 60 },
          { limit: 60, name: 'write', windowSeconds: 60 },
          { limit: 10, name: 'provisioning', windowSeconds: 3600 },
          { limit: 100000, name: 'bulk', windowSeconds: 60 },
        ],
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('emits bucket "bulk"'), r.out)
})

// ── ceilings and bucket hygiene ───────────────────────────────────────────────

test('RED: a budget above the reviewed ceiling is not a budget', () => {
  const r = runGate(
    fixture({
      budget: (b) => ({
        ...b,
        buckets: b.buckets.map((x) => (x.name === 'write' ? { ...x, limit: 100000 } : x)),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('a budget nobody can exceed is not a budget'), r.out)
})

test('RED: a window long enough never to close', () => {
  const r = runGate(
    fixture({
      budget: (b) => ({
        ...b,
        buckets: b.buckets.map((x) =>
          x.name === 'provisioning' ? { ...x, windowSeconds: 31_536_000 } : x,
        ),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('spelled slowly'), r.out)
})

test('RED: a mapping to a bucket that does not exist limits nothing', () => {
  const r = runGate(
    fixture({ budget: (b) => ({ ...b, procedures: { ...b.procedures, 'notes.create': 'gone' } }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('which "buckets" does not declare'), r.out)
})

test('RED: a declared bucket nothing spends from', () => {
  const r = runGate(
    fixture({
      budget: (b) => ({
        ...b,
        buckets: [...b.buckets, { limit: 5, name: 'orphan', reason: 'a bucket left behind by a surface that was removed entirely', windowSeconds: 60 }],
      }),
      policy: policyModule({
        buckets: [
          { limit: 300, name: 'read', windowSeconds: 60 },
          { limit: 60, name: 'write', windowSeconds: 60 },
          { limit: 10, name: 'provisioning', windowSeconds: 3600 },
          { limit: 5, name: 'orphan', windowSeconds: 60 },
        ],
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('nothing spends from it'), r.out)
})

// ── the WIRING ────────────────────────────────────────────────────────────────

test('RED: the tRPC host does not pass a rateLimit port — a silent, total loss of the seam', () => {
  // @app/api treats a missing port as an unlimited router, which is CORRECT for a worker
  // or a test. That is exactly why the absence cannot be caught from inside the router
  // and has to be asserted here.
  const r = runGate(fixture({ route: 'export const handler = () => createContext({ headers })\n' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('does not pass a `rateLimit` port'), r.out)
})

test('RED: a Server Action with a budget it never consults', () => {
  const r = runGate(
    fixture({
      actions: ACTIONS_OK.replace("enforceActionRateLimit('createNoteAction')", 'noop()'),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('calls enforceActionRateLimit'), r.out)
})

test('RED: an exported Server Action with no budget entry at all', () => {
  const r = runGate(
    fixture({
      actions: `${ACTIONS_OK}\nexport async function purgeOrgAction() {\n  return null\n}\n`,
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('purgeOrgAction'), r.out)
  assert.ok(r.out.includes('the same hole as an unmapped mutation'), r.out)
})

// ── fail closed ───────────────────────────────────────────────────────────────

test('FAIL CLOSED: malformed budget JSON', () => {
  const r = runGate(fixture({ rawBudget: '{ not json' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('not valid JSON'), r.out)
})

test('FAIL CLOSED: an EMPTY bucket set never passes vacuously', () => {
  const r = runGate(fixture({ budget: (b) => ({ ...b, buckets: [] }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('non-empty array'), r.out)
})

test('FAIL CLOSED: a bucket with a thin reason', () => {
  const r = runGate(
    fixture({ budget: (b) => ({ ...b, buckets: b.buckets.map((x) => ({ ...x, reason: 'because' })) }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('substantive "reason"'), r.out)
})

test('FAIL CLOSED: an exemption with a thin reason', () => {
  const r = runGate(
    fixture({
      budget: (b) => ({
        ...b,
        exemptProcedures: [{ action: 'system.health', reason: 'health check' }],
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('an unlimited endpoint is a decision'), r.out)
})

test('FAIL CLOSED: a fail-open decision that was never recorded', () => {
  // The single most consequential choice in the subsystem. An install that never made it
  // deliberately made it by accident.
  const r = runGate(fixture({ budget: (b) => ({ ...b, failOpen: { decided: false } }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('must record the decision AND its argument'), r.out)
})

test('FAIL CLOSED: no ceilings at all', () => {
  const r = runGate(fixture({ budget: (b) => ({ ...b, ceilings: {} }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('must declare integer'), r.out)
})

// ── adoption ──────────────────────────────────────────────────────────────────

test('ADOPTION RAMP: a pre-0.2.0 tree with no budget file NOTEs rather than reds', () => {
  const dir = fixture()
  rmSync(join(dir, 'tools/rate-limit-budget.json'))
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('pre-0.2.0'), r.out)
})
