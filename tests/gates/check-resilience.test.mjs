// Can-fail proofs for the resilience gate (template/base/tools/check-resilience.mjs).
//
// Fixture-driven against the SHIPPED tools/resilience.json and, for the green case,
// the SHIPPED template/stack trees verbatim — so the green verdict is a real statement
// about what the harness installs: all eight outbound seam files declared, every
// posture claim backed by the symbol that implements it.
//
// THE HEADLINE PROOFS are the vacuity pair: an outbound transport with NO register row
// reds (an undeclared seam's posture is whatever the runtime default is, decided by
// nobody), and a register row claiming a timeout its file does not implement ALSO reds
// — a posture that exists only in the register is exactly the paper claim this gate
// exists to refuse.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-resilience.mjs', import.meta.url),
)
const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const STACK_ROOT = fileURLToPath(new URL('../../template/stack', import.meta.url))
const SHIPPED_REGISTER = JSON.parse(readFileSync(join(TOOLS, 'resilience.json'), 'utf8'))

// A declared seam that satisfies every rule: a server fetch with a real deadline.
const TIMED_FETCH_SOURCE = [
  'export async function ping(base: string): Promise<number> {',
  '  const response = await fetch(`${base}/health`, {',
  '    signal: AbortSignal.timeout(1000),',
  '  })',
  '  return response.status',
  '}',
  '',
].join('\n')

const TIMED_FETCH_ROW = {
  id: 'fixture-ping',
  file: 'packages/platform/ping.ts',
  kind: 'server-fetch',
  posture: { timeoutMs: 1000, retries: 0, backoffMs: null },
  why: 'Fixture row: a health probe with its own 1s deadline and no retry — the declared-modest legal shape.',
}

/**
 * @param {{ register?: any, edit?: (r: any) => void, files?: Record<string, string>, manifest?: { harnessVersion: string, baseVersion: string }, includeStack?: boolean }} [opts]
 */
function fixture({ register, edit, files = {}, manifest, includeStack = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-resilience-'))
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  if (includeStack) {
    cpSync(join(STACK_ROOT, 'apps'), join(dir, 'apps'), { recursive: true })
    cpSync(join(STACK_ROOT, 'packages'), join(dir, 'packages'), { recursive: true })
    if (existsSync(join(STACK_ROOT, 'supabase/functions'))) {
      cpSync(join(STACK_ROOT, 'supabase/functions'), join(dir, 'supabase/functions'), {
        recursive: true,
      })
    }
  } else {
    mkdirSync(join(dir, 'packages/platform'), { recursive: true })
    writeFileSync(join(dir, 'packages/platform/innocent.ts'), 'export const ok = true\n')
  }
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  if (manifest !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify(manifest))
  }
  const next = register === null ? null : structuredClone(register ?? SHIPPED_REGISTER)
  if (next !== null && edit) edit(next)
  if (next !== null) {
    writeFileSync(join(dir, 'tools/resilience.json'), JSON.stringify(next, null, 2))
  }
  return dir
}

function runGate(dir) {
  const env = { ...process.env }
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.HARNESS_ALLOW_SELF_EDIT
  env.CI = 'true'
  const res = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const EMPTY_REGISTER = { comment: 'fixture', seams: [] }

// ── the green statement about the shipped tree ────────────────────────────────────────

test('GREEN: the shipped stack tree declares all its outbound seams in the shipped register', () => {
  const r = runGate(fixture({ includeStack: true }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /resilience: OK/)
  const seams = Number(/(\d+) outbound seam file\(s\)/.exec(r.out)?.[1] ?? '0')
  assert.ok(seams >= 5, `expected the real seam census, saw ${String(seams)}: ${r.out}`)
})

test('GREEN: a declared seam with a backed posture passes in a minimal tree', () => {
  const r = runGate(
    fixture({
      register: { comment: 'fixture', seams: [TIMED_FETCH_ROW] },
      files: { 'packages/platform/ping.ts': TIMED_FETCH_SOURCE },
    }),
  )
  assert.equal(r.code, 0, r.out)
})

// ── the vacuity pair ─────────────────────────────────────────────────────────────────

test('RED: an outbound transport with no register row', () => {
  const r = runGate(
    fixture({
      register: EMPTY_REGISTER,
      files: { 'packages/platform/ping.ts': TIMED_FETCH_SOURCE },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /constructs an outbound transport/)
  assert.match(r.out, /decided by nobody/)
})

test('RED: a register row claiming a timeout its file does not implement', () => {
  const r = runGate(
    fixture({
      register: { comment: 'fixture', seams: [TIMED_FETCH_ROW] },
      files: {
        'packages/platform/ping.ts':
          'export async function ping(base: string) {\n  return (await fetch(`${base}/health`)).status\n}\n',
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /never calls AbortSignal\.timeout/)
})

test('RED: a register row whose file no longer exists', () => {
  const r = runGate(fixture({ register: { comment: 'fixture', seams: [TIMED_FETCH_ROW] } }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /not a file in this tree/)
})

test('RED: a register row whose seam went away (the stale acceptance)', () => {
  const r = runGate(
    fixture({
      register: { comment: 'fixture', seams: [TIMED_FETCH_ROW] },
      files: { 'packages/platform/ping.ts': 'export const quiet = true\n' },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /constructs no outbound transport/)
})

test('RED: a kind the file does not construct', () => {
  const r = runGate(
    fixture({
      register: {
        comment: 'fixture',
        seams: [{ ...TIMED_FETCH_ROW, kind: 'trpc-client' }],
      },
      files: { 'packages/platform/ping.ts': TIMED_FETCH_SOURCE },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /cannot license another/)
})

test('RED: backoffMs beside retries: 0 is incoherent', () => {
  const r = runGate(
    fixture({
      register: {
        comment: 'fixture',
        seams: [
          {
            ...TIMED_FETCH_ROW,
            posture: { timeoutMs: 1000, retries: 0, backoffMs: 250 },
          },
        ],
      },
      files: { 'packages/platform/ping.ts': TIMED_FETCH_SOURCE },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /paces nothing/)
})

test('RED: a missing register on a seam-carrying tree names the refresh-seeded pull', () => {
  const r = runGate(
    fixture({
      register: null,
      files: { 'packages/platform/ping.ts': TIMED_FETCH_SOURCE },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /--refresh-seeded tools\/resilience\.json/)
})

// ── the 1.0.0 ramp, both branches ────────────────────────────────────────────────────

test('NOTE: a pre-1.0.0 install gets findings withheld as dated NOTEs', () => {
  const r = runGate(
    fixture({
      register: EMPTY_REGISTER,
      files: { 'packages/platform/ping.ts': TIMED_FETCH_SOURCE },
      manifest: { harnessVersion: '1.0.0', baseVersion: '0.11.0' },
    }),
  )
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /NOTE — 1 finding\(s\) withheld by the 1\.0\.0 ramp/)
  assert.match(r.out, /expires in 1\.1\.0/)
})

test('RAMP EXPIRED: at harness 1.1.0 the withheld finding is a hard failure', () => {
  const r = runGate(
    fixture({
      register: EMPTY_REGISTER,
      files: { 'packages/platform/ping.ts': TIMED_FETCH_SOURCE },
      manifest: { harnessVersion: '1.1.0', baseVersion: '0.11.0' },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /RAMP EXPIRED — the outbound-seam resilience register closure/)
})
