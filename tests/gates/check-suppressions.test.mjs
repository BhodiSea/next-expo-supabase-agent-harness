// Can-fail proofs for the suppressions gate (template/base/tools/check-suppressions.mjs).
//
// Fixture-driven against the SHIPPED tools/suppressions-allow.json and, for the green
// case, the SHIPPED template/stack trees verbatim — so the green verdict is a real
// statement about what the harness installs: every one of the scaffold's own inline
// directives is rule-named, reasoned, and census-matched both ways.
//
// THE HEADLINE PROOF is the rule-less disable: ESLint applies it to every rule id
// including the ones that police suppression itself, so no in-ESLint check can see it
// (tools/eslint-rules/index.mjs records the proven attempt) — this gate is the scanner
// outside ESLint, and the proof below is that scanner going red on exactly that shape.
//
// The ramp proofs include the RAMP EXPIRED branch at harness 1.1.0 — written the
// release the ramp opens (the reviewer-verdicts precedent), so the deadline's executed
// proof exists before the release that meets it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-suppressions.mjs', import.meta.url),
)
const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const STACK_ROOT = fileURLToPath(new URL('../../template/stack', import.meta.url))
const SHIPPED_REGISTER = JSON.parse(readFileSync(join(TOOLS, 'suppressions-allow.json'), 'utf8'))

// A reasoned, registered directive pair: the file and the row that licenses it.
const REASONED_SOURCE = [
  '// eslint-disable-next-line no-console -- the boot banner is the one sanctioned console line in this fixture',
  "console.log('boot')",
  '',
].join('\n')

const REASONED_ROW = {
  file: 'packages/platform/boot.ts',
  directives: [{ family: 'eslint-disable', rule: 'no-console', count: 1 }],
  why: 'Fixture row: the boot banner file is licensed to carry exactly one reasoned console suppression.',
}

/**
 * @param {{ register?: any, edit?: (r: any) => void, files?: Record<string, string>, manifest?: { harnessVersion: string, baseVersion: string }, includeStack?: boolean }} [opts]
 */
function fixture({ register, edit, files = {}, manifest, includeStack = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-suppressions-'))
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  if (includeStack) {
    cpSync(join(STACK_ROOT, 'apps'), join(dir, 'apps'), { recursive: true })
    cpSync(join(STACK_ROOT, 'packages'), join(dir, 'packages'), { recursive: true })
    if (existsSync(join(STACK_ROOT, 'supabase'))) {
      cpSync(join(STACK_ROOT, 'supabase'), join(dir, 'supabase'), { recursive: true })
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
    writeFileSync(join(dir, 'tools/suppressions-allow.json'), JSON.stringify(next, null, 2))
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

// The empty register for minimal fixtures: rows only for what the fixture writes.
const EMPTY_REGISTER = { comment: 'fixture', files: [] }

// ── the green statement about the shipped tree ────────────────────────────────────────

test('GREEN: the shipped stack tree census-matches the shipped register both ways', () => {
  const r = runGate(fixture({ includeStack: true }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /suppressions: OK/)
  // Non-vacuous: the shipped scaffold carries a known-nonzero directive census; zero
  // here means the walk missed the roots.
  const directives = Number(/(\d+) inline directive\(s\)/.exec(r.out)?.[1] ?? '0')
  assert.ok(directives >= 10, `expected the real census, saw ${String(directives)}: ${r.out}`)
})

test('GREEN: a reasoned, registered directive passes in a minimal tree', () => {
  const r = runGate(
    fixture({
      register: { comment: 'fixture', files: [REASONED_ROW] },
      files: { 'packages/platform/boot.ts': REASONED_SOURCE },
    }),
  )
  assert.equal(r.code, 0, r.out)
})

// ── the headline red: the off-switch ESLint cannot police ─────────────────────────────

test('RED: a rule-less eslint-disable is a hard failure naming the off-switch problem', () => {
  const r = runGate(
    fixture({
      register: EMPTY_REGISTER,
      files: {
        'packages/platform/off.ts': '/* eslint-disable */\nexport const x = 1\n',
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /rule-LESS eslint-disable/)
  assert.match(r.out, /switches off EVERY rule/)
})

test('RED: @ts-ignore and @ts-nocheck are refused with the expect-error alternative named', () => {
  const r = runGate(
    fixture({
      register: EMPTY_REGISTER,
      files: {
        'packages/platform/ign.ts': '// @ts-ignore\nexport const x: number = 1\n',
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /@ts-ignore/)
  assert.match(r.out, /@ts-expect-error/)
})

test('RED: a rule-named directive with no inline reason of substance', () => {
  const r = runGate(
    fixture({
      register: EMPTY_REGISTER,
      files: {
        'packages/platform/bare.ts':
          '// eslint-disable-next-line no-console\nconsole.log(1)\n',
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no inline reason of substance/)
})

// ── the census, both directions ──────────────────────────────────────────────────────

test('RED: a reasoned directive in a file with no register row', () => {
  const r = runGate(
    fixture({
      register: EMPTY_REGISTER,
      files: { 'packages/platform/boot.ts': REASONED_SOURCE },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no tools\/suppressions-allow\.json row/)
  assert.match(r.out, /nobody recorded the review/)
})

test('RED: a register row whose file carries no directive (the stale acceptance)', () => {
  const r = runGate(
    fixture({
      register: { comment: 'fixture', files: [REASONED_ROW] },
      files: { 'packages/platform/boot.ts': 'export const clean = true\n' },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /carries no suppression directive/)
})

test('RED: a count mismatch — a second site cannot ride a one-site review', () => {
  const r = runGate(
    fixture({
      register: { comment: 'fixture', files: [REASONED_ROW] },
      files: {
        'packages/platform/boot.ts': REASONED_SOURCE + REASONED_SOURCE,
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /declares 1/)
})

test('RED: a missing register on a directive-carrying tree names the refresh-seeded pull', () => {
  const r = runGate(
    fixture({
      register: null,
      files: { 'packages/platform/boot.ts': REASONED_SOURCE },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /--refresh-seeded tools\/suppressions-allow\.json/)
})

// ── the 1.0.0 ramp, both branches ────────────────────────────────────────────────────

test('NOTE: a pre-1.0.0 install gets findings withheld as dated NOTEs', () => {
  const r = runGate(
    fixture({
      register: EMPTY_REGISTER,
      files: { 'packages/platform/boot.ts': REASONED_SOURCE },
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
      files: { 'packages/platform/boot.ts': REASONED_SOURCE },
      manifest: { harnessVersion: '1.1.0', baseVersion: '0.11.0' },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /RAMP EXPIRED — the inline-suppression census over the product tree/)
})
