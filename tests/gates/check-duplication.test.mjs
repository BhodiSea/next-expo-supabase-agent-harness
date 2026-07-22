// Falsifiability + behavior contract for the duplication gate (G17). Spawns the real
// gate against a temp tree and asserts: a pasted block reds, a DRY tree is green, the
// reviewed allowlist mutes an accepted clone, a stale/malformed allowlist fails closed,
// and a baseVersion predating the check downgrades a clone to a ramp NOTE (in this
// lineage the check ships in 0.1.0, so every real install is live).
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
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
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8' })
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
  // The port swaps the source harness's specta-bindings exclusion for the
  // generated-module pattern this stack ships (tokens.gen.ts from gen-theme).
  const r = runReal({
    'apps/mobile/src/theme/tokens.gen.ts': BLOCK('summariseAlpha'),
    'apps/mobile/src/other.gen.ts': BLOCK('summariseBeta'),
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

test('duplication: a baseVersion predating the check downgrades a clone to a ramp NOTE (green)', () => {
  // Ramp minimum is 0.1.0 in this lineage — only a hypothetical pre-lineage
  // manifest rides the NOTE, but the shared rampNote path must stay provable.
  const r = runReal(
    {
      'apps/mobile/src/a.ts': BLOCK('summariseAlpha'),
      'apps/mobile/src/b.ts': BLOCK('summariseBeta'),
    },
    { manifest: JSON.stringify({ harnessVersion: '0.1.0', baseVersion: '0.0.9' }) },
  )
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /NOTE.*ramp/)
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
