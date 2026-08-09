// Can-fail proofs for the observability gate (template/base/tools/check-observability.mjs).
//
// Fixture-driven against the SHIPPED tools/observability.json and, for the green case, the
// SHIPPED template/stack apps/ + packages/ trees verbatim — so the green verdict is a real
// statement about what the harness installs (zero vendor telemetry imports outside declared
// sinks, of which the shipped register declares none).
//
// THE HEADLINE PROOFS are the containment pair: an undeclared `@sentry/react-native` import
// reds naming the file and both legitimate moves, and a REGISTERED sink whose file never
// references its redaction symbol reds too — the ordering ("a vendor transport attaches at
// the sink, BEHIND the redaction pass") is the seam header's whole design, and a register
// that only checked membership would license exactly the bypass it exists to prevent.
//
// The ramp proofs at the bottom include the RAMP EXPIRED branch at harness 0.9.0 — written
// the release the ramp opens, like the reviewer-verdicts precedent, so the deadline's
// executed proof exists before the release that meets it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  extractImports,
  matchesVendor,
  normalizeSpecifier,
  REQUIRED_VENDOR_FLOOR,
  vendorFor,
} from '../../template/base/tools/lib/observability.mjs'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-observability.mjs', import.meta.url),
)
const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const STACK_ROOT = fileURLToPath(new URL('../../template/stack', import.meta.url))
const SHIPPED_POLICY = JSON.parse(readFileSync(join(TOOLS, 'observability.json'), 'utf8'))

// A registered-sink file that satisfies every register rule: imports a vendor SDK and
// references the shipped redaction symbol in code.
const SINK_SOURCE = [
  "import * as Sentry from '@sentry/react-native'",
  "import { redactFields } from '@app/observability'",
  'export const attach = (record) =>',
  '  Sentry.captureMessage(JSON.stringify(redactFields(record.fields)))',
  '',
].join('\n')

const SINK_ROW = {
  file: 'apps/mobile/src/crash/init.ts',
  vendors: ['@sentry/'],
  redaction: 'redactFields',
  reason:
    'Crash reporting transport attached at the seam sink, behind the redaction pass, per the crash-reporting module patch.',
}

/**
 * A project root. Default: the shipped policy plus one innocent source file (so the scan
 * is never vacuous). `files` writes extra sources; `includeStack: true` copies the REAL
 * template/stack apps/ + packages/ trees for the green-on-shipped-tree statement;
 * `manifest` plants .harness/manifest.json — the lever every ramp fixture uses.
 * @param {{ policy?: any, edit?: (p: any) => void, files?: Record<string, string>, manifest?: { harnessVersion: string, baseVersion: string }, includeStack?: boolean, noInnocent?: boolean }} [opts]
 */
function fixture({ policy, edit, files = {}, manifest, includeStack = false, noInnocent = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-observability-'))
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
  } else if (!noInnocent) {
    mkdirSync(join(dir, 'packages/platform'), { recursive: true })
    writeFileSync(
      join(dir, 'packages/platform/log.ts'),
      "export const level = 'info' as const\n",
    )
  }
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  if (manifest !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify(manifest))
  }
  const next = policy === null ? null : structuredClone(policy ?? SHIPPED_POLICY)
  if (next !== null && edit) edit(next)
  if (next !== null) {
    writeFileSync(join(dir, 'tools/observability.json'), JSON.stringify(next, null, 2))
  }
  return dir
}

function runGate(dir) {
  // CI=true so skipOrFail fails closed; the toolchain flag and the self-edit escape are
  // scrubbed so the fixture runs with the consumer's env shape (the lane-porosity trap,
  // applied to a unit test — see tests/gates/check-data-flow.test.mjs).
  const env = { ...process.env }
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.HARNESS_ALLOW_SELF_EDIT
  env.CI = 'true'
  const res = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// ── the green statement about the shipped tree ────────────────────────────────────────

test('GREEN: the shipped stack tree has zero vendor telemetry imports under the shipped register', () => {
  const r = runGate(fixture({ includeStack: true }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /observability: OK/)
  // Non-vacuous: the real tree is hundreds of files; a single-digit count means the walk
  // silently missed the roots, which is the vacuity this assertion exists to catch.
  const scanned = Number(/(\d+) file\(s\) scanned/.exec(r.out)?.[1] ?? '0')
  assert.ok(scanned > 50, `expected a real scan of the shipped tree, saw ${String(scanned)}: ${r.out}`)
  assert.match(r.out, /0 vendor import\(s\)/)
})

// ── containment: undeclared imports red, in every import form ─────────────────────────

test('RED: an undeclared static vendor import names the file and both moves', () => {
  const r = runGate(
    fixture({
      files: { 'apps/mobile/src/crash/init.ts': "import * as Sentry from '@sentry/react-native'\n" },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /apps\/mobile\/src\/crash\/init\.ts:1 imports "@sentry\/react-native"/)
  assert.match(r.out, /register the file in tools\/observability\.json sinks\[\]/)
})

test('RED: dynamic import() and require() are the same egress path', () => {
  const r = runGate(
    fixture({
      files: {
        'apps/web/lib/trace.ts': "export const t = await import('@opentelemetry/sdk-node')\n",
        'packages/platform/metrics.cjs': "const dd = require('dd-trace')\nmodule.exports = dd\n",
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /apps\/web\/lib\/trace\.ts:1 imports "@opentelemetry\/sdk-node"/)
  assert.match(r.out, /packages\/platform\/metrics\.cjs:1 imports "dd-trace"/)
})

test('GREEN: a comment-only mention is not an egress path', () => {
  const r = runGate(
    fixture({
      files: {
        'apps/web/lib/notes.ts':
          "// import * as Sentry from '@sentry/nextjs' — the module patch wires this at the sink\nexport const n = 1\n",
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
})

// ── the register: a declared sink passes, and every register rule can fail ────────────

test('GREEN: a declared sink behind the redaction pass passes with real counts', () => {
  const r = runGate(
    fixture({
      files: { [SINK_ROW.file]: SINK_SOURCE },
      edit: (p) => {
        p.sinks = [SINK_ROW]
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /1 vendor import\(s\) all inside 1 declared sink\(s\)/)
})

test('RED: a sink that never references its redaction symbol — the ordering is the design', () => {
  const r = runGate(
    fixture({
      files: {
        [SINK_ROW.file]:
          "import * as Sentry from '@sentry/react-native'\n// redactFields is applied upstream, honest\nexport const attach = (r) => Sentry.captureMessage(String(r))\n",
      },
      edit: (p) => {
        p.sinks = [SINK_ROW]
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /never references its declared redaction symbol `redactFields` in code/)
  assert.match(r.out, /NO VENDOR SDK, on purpose/)
})

test('RED: a stale sink entry, both directions', () => {
  const missing = runGate(
    fixture({
      edit: (p) => {
        p.sinks = [{ ...SINK_ROW, file: 'apps/mobile/src/crash/gone.ts' }]
      },
    }),
  )
  assert.equal(missing.code, 1, missing.out)
  assert.match(missing.out, /names apps\/mobile\/src\/crash\/gone\.ts, which is not a file in this tree/)

  const importless = runGate(
    fixture({
      files: { [SINK_ROW.file]: "import { redactFields } from '@app/observability'\nexport const x = redactFields\n" },
      edit: (p) => {
        p.sinks = [SINK_ROW]
      },
    }),
  )
  assert.equal(importless.code, 1, importless.out)
  assert.match(importless.out, /imports no vendor telemetry SDK the detector knows/)
})

test('RED: a sink licensing a vendor the detector cannot see, and a thin reason', () => {
  const r = runGate(
    fixture({
      files: { [SINK_ROW.file]: SINK_SOURCE },
      edit: (p) => {
        p.sinks = [{ ...SINK_ROW, vendors: ['@acme-telemetry/'], reason: 'crash reporting' }]
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /licenses vendor "@acme-telemetry\/", which is not in vendorSpecifiers/)
  assert.match(r.out, /reason under 40 characters/)
})

test('RED: a sink declaring a redaction symbol the register does not name', () => {
  const r = runGate(
    fixture({
      files: { [SINK_ROW.file]: SINK_SOURCE },
      edit: (p) => {
        p.sinks = [{ ...SINK_ROW, redaction: 'scrubEverything' }]
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /declares redaction "scrubEverything", which is not one of redactionSymbols/)
})

// ── the detector floor: extend-only ───────────────────────────────────────────────────

test('RED: narrowing vendorSpecifiers below the shipped floor', () => {
  const r = runGate(
    fixture({
      edit: (p) => {
        p.vendorSpecifiers = p.vendorSpecifiers.filter((v) => v !== '@sentry/')
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /missing the shipped floor entry "@sentry\/"/)
  assert.match(r.out, /extended, never narrowed/)
})

// ── fail-closed shapes ────────────────────────────────────────────────────────────────

test('FAIL CLOSED: a malformed register cannot un-declare every sink', () => {
  const dir = fixture({ policy: null })
  writeFileSync(join(dir, 'tools/observability.json'), '{ not json')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /is not valid JSON/)
})

test('FAIL: an absent register asks for the seeded exemplar (after the scan still ran)', () => {
  const r = runGate(fixture({ policy: null }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /tools\/observability\.json is missing/)
  assert.match(r.out, /update --refresh-seeded tools\/observability\.json/)
})

test('FAIL: zero files scanned is vacuous, not green', () => {
  const dir = fixture({ noInnocent: true })
  mkdirSync(join(dir, 'apps'), { recursive: true })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /zero source files found/)
})

test('FAIL CLOSED in CI: no product surface at all', () => {
  const r = runGate(fixture({ noInnocent: true }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no product surface yet/)
})

// ── the ramp: NOTE before the deadline, EXPIRED at it, inert never disarms ────────────

test('NOTE: a pre-0.8.0 install is ramped, not ambushed — the lane greps this exact shape', () => {
  const r = runGate(
    fixture({
      files: { 'apps/mobile/src/crash/init.ts': "import * as Sentry from '@sentry/react-native'\n" },
      manifest: { harnessVersion: '0.8.0', baseVersion: '0.7.0' },
    }),
  )
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /observability: NOTE — the vendor-telemetry containment closure over declared sinks \(ramp: live from baseVersion 0\.8\.0/)
  assert.match(r.out, /expires in 0\.9\.0/)
  assert.match(r.out, /1 finding\(s\) withheld by the 0\.8\.0 ramp/)
})

test('the 0.8.0 containment ramp EXPIRES at harness 0.9.0 — the branch EXECUTED', () => {
  // The registered proof for the NEXT release, written the release the ramp opens (the
  // reviewer-verdicts precedent): scripts/ci/upgrade-lane.sh §7e will demand this branch
  // exists the release the deadline arrives.
  const r = runGate(
    fixture({
      files: { 'apps/mobile/src/crash/init.ts': "import * as Sentry from '@sentry/react-native'\n" },
      manifest: { harnessVersion: '0.9.0', baseVersion: '0.7.0' },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /observability: RAMP EXPIRED/)
  assert.match(r.out, /deadline of 0\.9\.0/)
})

test('REGRESSION: an inert ramp cannot disarm findings on a current-vintage install', () => {
  const r = runGate(
    fixture({
      files: { 'apps/mobile/src/crash/init.ts': "import * as Sentry from '@sentry/react-native'\n" },
      manifest: { harnessVersion: '0.8.0', baseVersion: '0.8.0' },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /is not a declared sink/)
})

// ── the pure matcher, at its boundaries ───────────────────────────────────────────────

test('vendor matching is package-boundary exact: prefixes, subpaths, npm:/URL forms', () => {
  assert.equal(matchesVendor('@sentry/react-native', '@sentry/'), true)
  assert.equal(matchesVendor('@sentryfoo/x', '@sentry/'), false)
  assert.equal(matchesVendor('posthog-js/react', 'posthog-js'), true)
  assert.equal(matchesVendor('posthog-js-extras', 'posthog-js'), false)
  assert.equal(normalizeSpecifier('npm:posthog-node@4'), 'posthog-node')
  assert.equal(normalizeSpecifier('https://esm.sh/@sentry/deno@8.9.0'), '@sentry/deno')
  assert.equal(vendorFor('npm:@sentry/deno@8', REQUIRED_VENDOR_FLOOR), '@sentry/')
  assert.equal(vendorFor('https://esm.sh/posthog-node@4.1.0', REQUIRED_VENDOR_FLOOR), 'posthog-node')
  assert.equal(vendorFor('@app/observability', REQUIRED_VENDOR_FLOOR), null)
})

test('import extraction sees all four forms and skips comments', () => {
  const src = [
    "import a from '@sentry/nextjs'",
    "import '@sentry/react-native'",
    "export { b } from '@opentelemetry/api'",
    "const c = await import('posthog-js')",
    "const d = require('dd-trace')",
    "// import e from '@bugsnag/js'",
    '/* import f from "logrocket" */',
  ].join('\n')
  const specs = extractImports(src).map((i) => i.specifier)
  assert.deepEqual(specs, [
    '@sentry/nextjs',
    '@sentry/react-native',
    '@opentelemetry/api',
    'posthog-js',
    'dd-trace',
  ])
})
