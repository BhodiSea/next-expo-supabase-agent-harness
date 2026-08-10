// Module-patch EXECUTION proofs for the observability gate: the sanctioned wiring the
// crash-reporting and observability module patches instruct must PASS the gate those
// patches arm. A fresh 0.8.0 install that followed a patch to the letter was hard-red
// (gate.mjs: base >= minVersion means no ramp forgiveness), because the patch docs
// instructed a register row naming a redaction symbol the planted code never references
// — so this suite APPLIES each patch's own instructions and runs the real gate over the
// result. The code blocks and the register additions are PARSED OUT OF THE PATCH .md
// FILES, never copied into this test: when a patch instruction is wrong, the fixture
// built from it is wrong, and the gate reds — which is exactly the defect class this
// suite exists to catch (found red 2026-08-10, the 0.9.0 repair's step-1 record).
//
// Two instruction forms are understood, deliberately:
//   - the corrected form (0.9.0): a fenced ```json block carrying the exact sinks[]
//     rows and redactionSymbols ADDITIONS (append-only — the fixture extends the
//     seeded lists, never replaces them, which is the instruction's own rule);
//   - the legacy inline row template (0.8.0): `{ "file": …, "redaction": "X" … }`,
//     applied the only way the gate admits an import — one row per planted
//     vendor-importing file. Kept as a fallback so a regression to the legacy prose
//     is judged by the gate rather than slipping past on a parse failure.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { extractImports, vendorFor } from '../../template/base/tools/lib/observability.mjs'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-observability.mjs', import.meta.url),
)
const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const MODULES = fileURLToPath(new URL('../../template/modules', import.meta.url))
const SHIPPED_POLICY = JSON.parse(readFileSync(join(TOOLS, 'observability.json'), 'utf8'))

const patchText = (rel) => readFileSync(join(MODULES, rel), 'utf8')

/** The body of the first fenced code block after `anchor` — the patch's own snippet. */
function fenceAfter(md, anchor, ctx) {
  const at = md.indexOf(anchor)
  assert.notEqual(at, -1, `${ctx}: anchor ${JSON.stringify(anchor)} not found in the patch`)
  const open = md.indexOf('```', at)
  assert.notEqual(open, -1, `${ctx}: no fenced block after ${JSON.stringify(anchor)}`)
  const bodyStart = md.indexOf('\n', open) + 1
  const close = md.indexOf('\n```', bodyStart)
  assert.notEqual(close, -1, `${ctx}: unterminated fence after ${JSON.stringify(anchor)}`)
  return md.slice(bodyStart, close + 1)
}

/** Same, but null when the section between `anchor` and the next `## ` has no fence. */
function optionalFenceAfter(md, anchor, ctx) {
  const at = md.indexOf(anchor)
  assert.notEqual(at, -1, `${ctx}: anchor ${JSON.stringify(anchor)} not found in the patch`)
  const open = md.indexOf('```', at)
  const nextHeading = md.indexOf('\n## ', at)
  if (open === -1 || (nextHeading !== -1 && open > nextHeading)) return null
  return fenceAfter(md, anchor, ctx)
}

const importsVendor = (src) =>
  extractImports(src).some(
    ({ specifier }) => vendorFor(specifier, SHIPPED_POLICY.vendorSpecifiers) !== null,
  )

/**
 * The register additions the patch instructs, in either understood form.
 * @param {string} md
 * @param {string} ctx
 * @param {{ path: string, src: string }[]} planted
 * @returns {{ redactionSymbols?: string[], sinks: object[] }}
 */
function registerInstruction(md, ctx, planted) {
  for (const m of md.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    let parsed
    try {
      parsed = JSON.parse(m[1])
    } catch {
      continue // some other json block (e.g. an expo-plugins row)
    }
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.sinks)) {
      return parsed
    }
  }
  const prose = md.replace(/^>[ \t]?/gm, '') // the legacy template lives in a blockquote
  const redaction = /"redaction":\s*"([A-Za-z0-9_$]+)"/.exec(prose)
  const vendors = /"vendors":\s*\[\s*"([^"]+)"\s*\]/.exec(prose)
  assert.ok(
    redaction !== null && vendors !== null,
    `${ctx}: no register instruction found (neither a json block with sinks[] nor the inline row template)`,
  )
  return {
    sinks: planted
      .filter((p) => importsVendor(p.src))
      .map((p) => ({
        file: p.path,
        vendors: [vendors[1]],
        redaction: redaction[1],
        reason: `${ctx} module patch applied verbatim: the vendor transport this file wires is licensed by the patch's own register instruction.`,
      })),
  }
}

/**
 * A consumer tree that followed the patch: the planted snippets, the module-shipped
 * files, and the shipped policy EXTENDED (append-only) by the instructed additions.
 */
function stageFixture({ planted, copies = {}, register }) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-observability-patch-'))
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  for (const { path, src } of planted) {
    mkdirSync(join(dir, dirname(path)), { recursive: true })
    writeFileSync(join(dir, path), src)
  }
  for (const [rel, absSource] of Object.entries(copies)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    cpSync(absSource, join(dir, rel))
  }
  const policy = structuredClone(SHIPPED_POLICY)
  for (const symbol of register.redactionSymbols ?? []) {
    if (!policy.redactionSymbols.includes(symbol)) policy.redactionSymbols.push(symbol)
  }
  policy.sinks = [...policy.sinks, ...register.sinks]
  writeFileSync(join(dir, 'tools/observability.json'), JSON.stringify(policy, null, 2))
  return dir
}

function runGate(dir) {
  // Same env shape as check-observability.test.mjs: CI=true so nothing skips, the
  // toolchain flag and self-edit escape scrubbed (the lane-porosity trap). No
  // .harness/manifest.json is planted, so every check is LIVE — this is the fresh
  // install the patch docs address, and the ramp forgives it nothing.
  const env = { ...process.env }
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.HARNESS_ALLOW_SELF_EDIT
  env.CI = 'true'
  const res = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const REDACT_TS = join(MODULES, 'crash-reporting/apps/mobile/src/crash/redact.ts')

// ── crash-reporting: mobile ───────────────────────────────────────────────────────────

test('mobile-sentry.patch.md: the instructed wiring + register pass the gate the patch arms', () => {
  const md = patchText('crash-reporting/docs/modules/crash-reporting/mobile-sentry.patch.md')
  const planted = [
    { path: 'apps/mobile/metro.config.js', src: fenceAfter(md, '## 2. Metro config', 'mobile-sentry') },
    { path: 'apps/mobile/src/crash/report.ts', src: fenceAfter(md, '## 5. Wiring', 'mobile-sentry') },
    { path: 'apps/mobile/app/_layout.tsx', src: fenceAfter(md, 'Then in `app/_layout.tsx`', 'mobile-sentry') },
  ]
  // Non-vacuity: the transport file and the metro base swap must actually import the
  // SDK, or the fixture proves nothing about containment.
  assert.ok(importsVendor(planted[1].src), 'report.ts snippet must import @sentry/react-native')
  assert.ok(importsVendor(planted[0].src), 'metro.config.js snippet must require the Sentry metro wrapper')

  const register = registerInstruction(md, 'mobile-sentry', planted)
  const dir = stageFixture({
    planted,
    copies: { 'apps/mobile/src/crash/redact.ts': REDACT_TS },
    register,
  })
  const r = runGate(dir)
  assert.equal(
    r.code,
    0,
    `the patch's own instructions must pass the gate the patch arms:\n${r.out}`,
  )
  assert.match(r.out, /vendor import\(s\) all inside \d+ declared sink\(s\)/)
})

// ── crash-reporting: server ───────────────────────────────────────────────────────────

test('server-sentry.patch.md: the instructed wiring + register pass the gate the patch arms', () => {
  const md = patchText('crash-reporting/docs/modules/crash-reporting/server-sentry.patch.md')
  const planted = [
    {
      path: 'apps/web/sentry.server.config.ts',
      src: fenceAfter(md, '`apps/web/sentry.server.config.ts` (new file', 'server-sentry'),
    },
    {
      path: 'apps/web/instrumentation.ts',
      src: fenceAfter(md, '`apps/web/instrumentation.ts` —', 'server-sentry'),
    },
  ]
  const routeEdit = optionalFenceAfter(md, '## 5. Route-level capture', 'server-sentry')
  if (routeEdit !== null) {
    planted.push({ path: 'apps/web/app/api/trpc/[trpc]/route.ts', src: routeEdit })
  }
  assert.ok(importsVendor(planted[0].src), 'sentry.server.config.ts snippet must import @sentry/nextjs')

  const register = registerInstruction(md, 'server-sentry', planted)
  const dir = stageFixture({
    planted,
    copies: { 'apps/web/lib/crash/redact.ts': REDACT_TS }, // §2's reviewed-copy flow
    register,
  })
  const r = runGate(dir)
  assert.equal(
    r.code,
    0,
    `the patch's own instructions must pass the gate the patch arms:\n${r.out}`,
  )
  assert.match(r.out, /vendor import\(s\) all inside \d+ declared sink\(s\)/)
})

// ── observability: OTel server ────────────────────────────────────────────────────────

test('otel-server.patch.md: the instructed wiring + register pass the gate the patch arms', () => {
  const md = patchText('observability/docs/modules/observability/otel-server.patch.md')
  const planted = [
    { path: 'apps/web/instrumentation.ts', src: fenceAfter(md, '## 3. Wiring', 'otel-server') },
    { path: 'packages/api/src/trpc.ts', src: fenceAfter(md, '## 4. One span per procedure', 'otel-server') },
    { path: 'packages/api/src/context.ts', src: fenceAfter(md, 'fold the active span context', 'otel-server') },
  ]
  assert.ok(importsVendor(planted[0].src), 'instrumentation.ts snippet must import the OTel SDK')
  assert.ok(importsVendor(planted[1].src), 'trpc.ts snippet must import @opentelemetry/api')

  const register = registerInstruction(md, 'otel-server', planted)
  const dir = stageFixture({ planted, register })
  const r = runGate(dir)
  assert.equal(
    r.code,
    0,
    `the patch's own instructions must pass the gate the patch arms:\n${r.out}`,
  )
  assert.match(r.out, /vendor import\(s\) all inside \d+ declared sink\(s\)/)
})
