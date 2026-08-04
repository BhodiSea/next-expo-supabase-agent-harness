// Can-fail proofs for the security-headers gate
// (template/base/tools/check-security-headers.mjs).
//
// The gate EVALUATES apps/web/lib/security-headers.ts rather than grepping it, so
// every case here mutates the real shipped module and asserts the gate judges the
// VALUE that results. That distinction is the whole point of the gate: a grep is
// satisfied by a directive that appears in a comment.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const GATE_SRC = join(ROOT, 'template/base/tools/check-security-headers.mjs')
const POLICY_SRC = join(ROOT, 'template/base/tools/security-headers.json')
const LIB_SRC = join(ROOT, 'template/base/tools/lib')
const MODULE_SRC = join(ROOT, 'template/stack/apps/web/lib/security-headers.ts')

/** A scaffold-shaped tree; `mutate` perturbs the module, `policy` perturbs the policy. */
/**
 * `mutate` rewrites the shipped security-headers MODULE text; `policy` edits the reviewed
 * JSON it is judged against. The two halves are separate on purpose: a canary must be able
 * to move one without the other, which is what proves the gate compares them.
 * @param {{ mutate?: (src: string) => string, policy?: (base: any) => any }} [opts]
 */
function fixture({ mutate, policy } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-sechdr-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'apps/web/lib'), { recursive: true })
  cpSync(GATE_SRC, join(dir, 'tools/check-security-headers.mjs'))
  cpSync(LIB_SRC, join(dir, 'tools/lib'), { recursive: true })
  writeFileSync(
    join(dir, 'tools/security-headers.json'),
    policy === undefined
      ? readFileSync(POLICY_SRC, 'utf8')
      : JSON.stringify(policy(JSON.parse(readFileSync(POLICY_SRC, 'utf8')))),
  )
  const src = readFileSync(MODULE_SRC, 'utf8')
  const out = mutate ? mutate(src) : src
  // A mutation that silently matched nothing would still red the assertion below it,
  // but with a message about the gate rather than about the fixture — and the next
  // person would go looking in the gate. Fail here, where the fault is.
  if (mutate) assert.notEqual(out, src, 'the mutation matched nothing — the module text moved')
  writeFileSync(join(dir, 'apps/web/lib/security-headers.ts'), out)
  return dir
}

function runGate(dir) {
  const res = spawnSync(process.execPath, ['tools/check-security-headers.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: the untouched shipped module matches the reviewed policy', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('match tools/security-headers.json by value'), r.out)
})

test('RED: deleting frame-ancestors reds AND surfaces the framing disagreement', () => {
  const r = runGate(fixture({ mutate: (s) => s.replace(/\s*"frame-ancestors 'none'",\n/, '\n') }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('missing the frame-ancestors directive'), r.out)
  // x-frame-options still says DENY, so the two controls now disagree — a second,
  // independent finding. Either alone would have caught it; both is the point.
  assert.ok(r.out.includes('framing controls disagree') || r.out.includes('disagree'), r.out)
})

test("RED: 'unsafe-eval' in script-src", () => {
  // The adjacent-token form targets the CSP line specifically — a bare
  // `'strict-dynamic'` replace hits the doc comment's first mention instead and
  // leaves the actual directive untouched, which is a test that proves nothing.
  const r = runGate(
    fixture({
      mutate: (s) => s.replace("'strict-dynamic' 'unsafe-inline'", "'unsafe-eval' 'unsafe-inline'"),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('banned token'), r.out)
})

test("RED: 'unsafe-inline' WITHOUT 'strict-dynamic' is not a CSP2 fallback", () => {
  const r = runGate(fixture({ mutate: (s) => s.replace(" 'strict-dynamic'", '') }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("WITHOUT 'strict-dynamic'"), r.out)
})

test('RED: a weakened static header value (HSTS max-age dropped)', () => {
  const r = runGate(fixture({ mutate: (s) => s.replace('max-age=63072000', 'max-age=600') }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('strict-transport-security'), r.out)
})

test('RED: a permissions-policy feature that stops being denied', () => {
  const r = runGate(fixture({ mutate: (s) => s.replace("'camera=()',", '') }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("does not deny 'camera'"), r.out)
})

test('RED: Vary loses the acting-org selector (cross-tenant cache poisoning)', () => {
  const r = runGate(fixture({ mutate: (s) => s.replace("'Cookie, x-org-id'", "'Cookie'") }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("different tenant's rows"), r.out)
})

test('RED: authenticated responses become cacheable', () => {
  const r = runGate(fixture({ mutate: (s) => s.replace("'private, no-store'", "'public, max-age=60'") }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('shared cache'), r.out)
})

test('RED: the report-only twin stops reporting', () => {
  const r = runGate(fixture({ mutate: (s) => s.replace('; report-uri /api/csp-report', '') }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('report-uri'), r.out)
})

test('ANTI-VACUITY: a policy missing a section fails the gate, never greens it', () => {
  const r = runGate(
    fixture({
      policy: (p) => Object.fromEntries(
        Object.entries(p).filter(([k]) => k !== 'cspRequiredDirectives'),
      ),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('missing the "cspRequiredDirectives" section'), r.out)
})

test('ANTI-VACUITY: the coep/hstsPreload decisions must carry a real reason', () => {
  const r = runGate(
    fixture({
      policy: (p) => ({ ...p, decisions: { ...p.decisions, coep: { value: null, reason: 'n/a' } } }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('decisions.coep'), r.out)
})

test('REGRESSION: a fresh scaffold whose baseVersion predates the ramp still goes RED', () => {
  // The bug this pins: the gate originally ramped its FINDINGS, so on a brand-new
  // scaffold — whose .harness/manifest.json records the release it was built from,
  // which is older than the ramp until the version bumps — every finding printed as
  // a NOTE and the gate could not go red at all. A new gate that is advisory on
  // fresh installs is decoration. The ramp now covers ADOPTION (module absent) only;
  // once the module is present, wrong values are a hard red regardless of vintage.
  const dir = fixture({ mutate: (s) => s.replace(/\s*"frame-ancestors 'none'",\n/, '\n') })
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(
    join(dir, '.harness/manifest.json'),
    JSON.stringify({ baseVersion: '0.1.3', harnessVersion: '0.1.3', files: {} }),
  )
  const r = runGate(dir)
  assert.equal(r.code, 1, `an ancient baseVersion must not disarm the gate:\n${r.out}`)
  assert.ok(!r.out.includes('NOTE —'), `findings must not print as NOTEs:\n${r.out}`)
})

test('ADOPTION RAMP: a pre-0.2.0 install without the module passes with a NOTE, not a FAIL', () => {
  // The case the ramp legitimately covers: an existing 0.1.3 install upgrading to
  // 0.2.0 has no apps/web/lib/security-headers.ts yet, and hard-failing it would be
  // exactly the upgrade ambush the ramp doctrine exists to prevent.
  const dir = fixture()
  rmSync(join(dir, 'apps/web/lib/security-headers.ts'))
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(
    join(dir, '.harness/manifest.json'),
    JSON.stringify({ baseVersion: '0.1.3', harnessVersion: '0.1.3', files: {} }),
  )
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('NOTE'), r.out)
})

test('a missing module SKIPS locally and FAILS in CI', () => {
  const dir = fixture()
  writeFileSync(join(dir, 'apps/web/lib/security-headers.ts'), '')
  const ci = runGate(dir)
  assert.equal(ci.code, 1, ci.out)

  const dir2 = mkdtempSync(join(tmpdir(), 'nesah-sechdr-none-'))
  mkdirSync(join(dir2, 'tools'), { recursive: true })
  cpSync(GATE_SRC, join(dir2, 'tools/check-security-headers.mjs'))
  cpSync(LIB_SRC, join(dir2, 'tools/lib'), { recursive: true })
  cpSync(POLICY_SRC, join(dir2, 'tools/security-headers.json'))
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  const local = spawnSync(process.execPath, ['tools/check-security-headers.mjs'], {
    cwd: dir2,
    encoding: 'utf8',
    env,
  })
  assert.equal(local.status, 0, `${local.stdout}${local.stderr}`)
  assert.ok(`${local.stdout}`.includes('SKIPPED'), local.stdout)
})
