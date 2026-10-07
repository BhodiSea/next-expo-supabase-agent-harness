// Falsifiability + behavior contract for the duplication gate (G17). Spawns the real
// gate against a temp tree and asserts: a pasted block reds, a DRY tree is green, the
// reviewed allowlist mutes an accepted clone, a stale/malformed allowlist fails closed,
// and a baseVersion predating the check downgrades a clone to a ramp NOTE (in this
// lineage the check ships in 0.1.0, so every real install is live).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import process from 'node:process'
import { test } from 'node:test'

// The gate imports its `./lib/*` relative to its own file, so spawning it with cwd = a
// temp tree keeps the real lib while only the scanned apps/packages roots vary.
const GATE = fileURLToPath(new URL('../../template/base/tools/check-duplication.mjs', import.meta.url))

// A ~9-line, ~130-token function — comfortably over the 70-token / 6-line thresholds.
const BLOCK = (name) => `export function ${name}(rows: readonly { id: string; title: string; pending: boolean }[]): string {
  const done = rows.filter((r) => !r.pending)
  const waiting = rows.filter((r) => r.pending)
  const names = done.map((r) => r.title.trim()).filter((t) => t.length > 0)
  const head = names.slice(0, 3).join(', ')
  const rest = names.length > 3 ? \` and \${String(names.length - 3)} more\` : ''
  const pendingNote = waiting.length > 0 ? \` (\${String(waiting.length)} pending)\` : ''
  return \`\${String(done.length)} saved: \${head}\${rest}\${pendingNote}\`
}
`

function runReal(treeFiles, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-dup-'))
  for (const [rel, content] of Object.entries(treeFiles)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  if (extra.allow !== undefined) {
    mkdirSync(join(dir, 'tools'), { recursive: true })
    writeFileSync(join(dir, 'tools/duplication-allow.json'), extra.allow)
  }
  if (extra.manifest !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), extra.manifest)
  }
  const env = { ...process.env, ...extra.env }
  if (extra.env?.HARNESS_ADVISORY_REPORT_DIR === undefined) delete env.HARNESS_ADVISORY_REPORT_DIR
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  rmSync(dir, { recursive: true, force: true })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('duplication: a pasted block across two files reds (no manifest → live)', () => {
  const r = runReal({
    'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
    'apps/mobile/src/b.ts': BLOCK('summariseBeta'),
  })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /clone \(\d+ tokens/)
  assert.match(r.out, /a\.ts/)
  assert.match(r.out, /b\.ts/)
})

test('duplication: a DRY tree is green', () => {
  const r = runReal({
    'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
    'apps/mobile/src/b.ts': 'export const answer = 42\n',
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /no clones/)
})

test('duplication: test files are excluded (they legitimately repeat setup)', () => {
  const r = runReal({
    'apps/mobile/src/a.test.ts': BLOCK('summariseAlpha'),
    'apps/mobile/src/b.test.ts': BLOCK('summariseBeta'),
  })
  assert.equal(r.code, 0, r.out)
})

test('duplication: generated *.gen.ts modules are excluded (machine-written, e.g. theme tokens)', () => {
  // The port swaps the source harness's specta-bindings exclusion for a
  // generated-module pattern: machine-written *.gen.ts modules stay out of the
  // duplication census.
  const r = runReal({
    'apps/mobile/src/theme/tokens.gen.ts': BLOCK('summariseAlpha'),
    'apps/mobile/src/other.gen.ts': BLOCK('summariseBeta'),
  })
  assert.equal(r.code, 0, r.out)
})

test('duplication: a generated/ DIRECTORY is excluded too — the shape the scaffold actually emits', () => {
  // Regression proof. The exclusion used to be the `*.gen.ts` SUFFIX alone, which
  // matched nothing in the shipped scaffold: the design-tokens compiler writes to
  // packages/design-tokens/src/generated/{native.ts,web.css}. So the gate reported
  // the generator's own output as a clone of its source on a clean tree, and the
  // test above passed only because it fabricated a filename the generator never emits.
  const r = runReal({
    'packages/design-tokens/src/generated/native.ts': BLOCK('summariseAlpha'),
    'packages/design-tokens/src/typography.ts': BLOCK('summariseBeta'),
  })
  assert.equal(r.code, 0, r.out)
})

test('duplication: a data table of MEMBER EXPRESSIONS is not a clone (the palette-map shape)', () => {
  // Regression proof. `looksLikeData` counted every non-literal token, so a lookup
  // table whose values are member expressions — `canvas: ramps.neutral[950],` — was
  // scored as code: each slot name and each property name inflated the distinct
  // count past the threshold. That is exactly the shipped design-tokens palette
  // (color.ts themes.dark / themes.light), which reported itself as a clone.
  const palette = (theme, a, b) => `
export const ${theme} = {
  canvas: ramps.neutral[${a}],
  surface: ramps.neutral[${b}],
  edge: ramps.neutral[700],
  ink: ramps.neutral[100],
  accent: ramps.accent[300],
  danger: ramps.danger[400],
  success: ramps.success[400],
  warning: ramps.warning[400],
  info: ramps.info[400],
}
`
  const r = runReal({
    'packages/design-tokens/src/dark.ts': palette('dark', 950, 900),
    'packages/design-tokens/src/light.ts': palette('light', 50, 100),
  })
  assert.equal(r.code, 0, r.out)
})

test('duplication: a reviewed allowlist fingerprint mutes an accepted clone', () => {
  const found = runReal({
    'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
    'apps/mobile/src/b.ts': BLOCK('summariseBeta'),
  })
  const fp = /fingerprint ([0-9a-f]{12})/.exec(found.out)?.[1]
  assert.ok(fp, `expected a fingerprint in: ${found.out}`)
  const r = runReal(
    {
      'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
      'apps/mobile/src/b.ts': BLOCK('summariseBeta'),
    },
    { allow: JSON.stringify({ allow: [{ fingerprint: fp, reason: 'reviewed parallel' }] }) },
  )
  assert.equal(r.code, 0, r.out)
})

test('duplication: a malformed allowlist FAILS CLOSED', () => {
  const r = runReal(
    { 'apps/mobile/src/a.ts': 'export const x = 1\n' },
    { allow: JSON.stringify({ allow: [{ fingerprint: 42 }] }) },
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /fingerprint/)
})

test('duplication: even a pre-lineage baseVersion is held — the check is unconditional', () => {
  // 0.4.0 DELETED this ramp rather than expiring it: its minVersion sat below v0.1.3,
  // the oldest release this lineage ever tagged, so gate.mjs returned false at
  // `base >= minVersion` for every install that has ever existed. This test used to
  // prove the NOTE path with a HYPOTHETICAL pre-lineage manifest — its own comment said
  // so — which is proof of a path no consumer can take. Inverted: the check is
  // unconditional now, so even that manifest is held.
  const r = runReal(
    {
      'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
      'apps/mobile/src/b.ts': BLOCK('summariseBeta'),
    },
    { manifest: JSON.stringify({ harnessVersion: '0.1.0', baseVersion: '0.0.9' }) },
  )
  assert.equal(r.code, 1, r.out)
  assert.doesNotMatch(r.out, /NOTE.*ramp/, 'the ramp is gone; a NOTE here would mean it came back')
})

test('duplication: a 0.1.0 baseVersion makes the same clone turn-fatal', () => {
  const r = runReal(
    {
      'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
      'apps/mobile/src/b.ts': BLOCK('summariseBeta'),
    },
    { manifest: JSON.stringify({ harnessVersion: '0.1.0', baseVersion: '0.1.0' }) },
  )
  assert.equal(r.code, 1, r.out)
})

// ---- a repeating DATA LITERAL is not a code clone ----
// The tokenizer normalizes strings to `S` (deliberately — a paste that swapped a constant must
// still match), which means a key/value table tokenizes to `S : S ,` forever and every window
// matches every other. The detector reported the i18n message catalog as duplicating itself the
// moment the catalog existed. Structure, not size, separates the two: code names things.

const CATALOG = (n) =>
  `export const en = {\n${Array.from({ length: n }, (_, i) => `  'some.key.${String(i)}': 'Some user-facing copy number ${String(i)}',`).join('\n')}\n} as const\n`

test('duplication: a long key/value data table is NOT a clone of itself', () => {
  const r = runReal({ 'apps/mobile/src/catalog.ts': CATALOG(120) })
  assert.equal(r.code, 0, r.out)
})

test('duplication: two data tables in DIFFERENT files are not clones of each other either', () => {
  const r = runReal({
    'apps/mobile/src/a.ts': CATALOG(80),
    'apps/mobile/src/b.ts': CATALOG(80),
  })
  assert.equal(r.code, 0, r.out)
})

test('duplication: real pasted CODE still reds — the data filter did not blunt the detector', () => {
  const r = runReal({
    'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
    'apps/mobile/src/b.ts': BLOCK('summariseBeta'),
  })
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('clone'), r.out)
})

// The shipped scaffolds themselves. `duplication` is a Stop step, not a chain gate, so the
// zero-edit `validate` the Local development list runs never executes it: a template change
// that shifts a clone's extent (and so its fingerprint) reaches CI's Stop-chain lane before
// anything local. 2.0.0 did exactly that: the default scaffold's i18n catalogs lost the
// example's keys, the catalog pair matched over a new span, and bootstrap-linux's Stop chain
// went red on a fingerprint the shipped allowlist did not carry. Render both shapes the
// installer ships and run the real gate over each, with the shipped allowlist.
const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))

for (const [label, flags] of [
  ['a default init', []],
  ['an init --with-demo', ['--with-demo']],
]) {
  test(`duplication: ${label} is clean under the shipped allowlist`, () => {
    const root = mkdtempSync(join(tmpdir(), 'epah-dup-init-'))
    const dir = join(root, 'app')
    try {
      const init = spawnSync('node', [CLI, 'init', '--dir', dir, '--tier', 'core', '--yes', ...flags], {
        encoding: 'utf8',
      })
      assert.equal(init.status, 0, `${init.stdout ?? ''}${init.stderr ?? ''}`)
      const res = spawnSync('node', [join(dir, 'tools/check-duplication.mjs')], { cwd: dir, encoding: 'utf8' })
      assert.equal(res.status, 0, `${res.stdout ?? ''}${res.stderr ?? ''}`)
      assert.match(res.stdout ?? '', /duplication: OK/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

// ── the L0 leg terminator (2.1.0, #185) ─────────────────────────────────────────
// `duplication` is the first converted producer: under HARNESS_ADVISORY_REPORT_DIR its scan
// writes exactly one {producer: 'duplication', leg: 'l0', complete: true} right before its
// verdict, green or red, and none on an early exit. The red text and the verdict do not move.

/** Every record the gate run wrote into `dir`. @param {string} dir */
function recorded(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((f) =>
    readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  )
}

const TERMINATOR = { v: 1, producer: 'duplication', leg: 'l0', complete: true }

/** @param {string} tag */
const reportDir = (tag) => join(mkdtempSync(join(tmpdir(), `epah-dup-advisory-${tag}-`)), 'report')

test('duplication: a green tree writes exactly one L0 terminator', () => {
  const dir = reportDir('green')
  const r = runReal({ 'apps/mobile/src/a.ts': BLOCK('summariseAlpha') }, { env: { HARNESS_ADVISORY_REPORT_DIR: dir } })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(recorded(dir), [TERMINATOR])
})

test('duplication: a red tree writes exactly one L0 terminator, and its red text is unchanged', () => {
  const tree = { 'apps/mobile/src/a.ts': BLOCK('summariseAlpha'), 'apps/mobile/src/b.ts': BLOCK('summariseBeta') }
  const dir = reportDir('red')
  const recordedRun = runReal(tree, { env: { HARNESS_ADVISORY_REPORT_DIR: dir } })
  const plain = runReal(tree)
  assert.equal(recordedRun.code, 1, recordedRun.out)
  assert.equal(recordedRun.out, plain.out, 'the variable changes no output')
  assert.deepEqual(recorded(dir), [TERMINATOR])
})

test('duplication: the no-source skip writes no terminator, locally or in CI', () => {
  for (const ci of ['', 'true']) {
    const dir = reportDir(`skip${ci}`)
    const r = runReal({ 'README.md': '# nothing to scan\n' }, { env: { HARNESS_ADVISORY_REPORT_DIR: dir, CI: ci, HARNESS_REQUIRE_TOOLCHAINS: '' } })
    assert.equal(r.code, ci === 'true' ? 1 : 0, r.out)
    assert.deepEqual(recorded(dir), [])
  }
})

test('duplication: a malformed allow file writes no terminator', () => {
  for (const allow of ['{ not json', '{"allow": {}}', '{"allow": [{"fingerprint": "x"}]}']) {
    const dir = reportDir('allow')
    const r = runReal({ 'apps/mobile/src/a.ts': BLOCK('summariseAlpha') }, { allow, env: { HARNESS_ADVISORY_REPORT_DIR: dir } })
    assert.equal(r.code, 1, r.out)
    assert.deepEqual(recorded(dir), [], allow)
  }
})
