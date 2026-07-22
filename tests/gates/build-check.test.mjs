// Fixture proofs for the build gate (template/base/tools/build-check.mjs + the shared
// measurer tools/lib/bundle-measure.mjs):
//   - a committed tools/perf-baseline.json with a tiny total → RED naming measured vs
//     baseline × ratioCap and the `pnpm perf:baseline` ceremony;
//   - exactly AT the cap → GREEN (the ratchet fails on strict growth only);
//   - absent baseline → NOTE naming the file + command, absolute budgets intact;
//     malformed baseline → fail closed, never open;
//   - purity markers (postgres:// AND postgresql:// DSNs, EXPO_TOKEN, sk_live_,
//     drizzle-orm) red in a fixture dist;
//   - the shared lib measures deterministically, keys Hermes chunks by their
//     hash-stripped `<platform>/<basename>` logical name, aggregates content-addressed
//     assets under one "assets" key, and the regenerator's compose/serialize path
//     writes sorted, byte-stable output.
// SEQUENCING (read from the gate): the `pnpm --filter mobile exec expo export` runs
// BEFORE any budget/baseline read, so every spawned-gate case stands the export in with
// a no-op `pnpm` shim on PATH (sh + .cmd twins — the selftest matrix runs this file on
// windows-latest) and a pre-built fixture dist under apps/mobile/dist; the
// node_modules-absent skip cases need no shim because the gate exits before spawning.
// Malformed-baseline reds therefore happen AFTER the (stubbed) export — proven by the
// spawned fail-closed case below, which is also the exit-1 wiring proof the task asks
// for. Measurement/ratchet arithmetic is additionally unit-tested at the lib level.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import {
  composeBaseline,
  diffBaseline,
  imageFormatOf,
  measureDist,
  parseBaseline,
  ratchetFindings,
  serializeBaseline,
} from '../../template/base/tools/lib/bundle-measure.mjs'

const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))

// A dist tree shaped like an `expo export --platform android` output: Hermes bytecode
// chunks under _expo/static/js/android/<name>-<32 hex md5>.hbc, one content-addressed
// asset (hash IS the filename, no extension), metadata.json. Gzip sizes are computed
// with the same zlib the lib uses, so expectations never drift from the environment.
const HASH_A = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
const HASH_B = 'ffeeddccbbaa99887766554433221100'
const DIST_FILES = {
  'metadata.json': '{"version":0,"bundler":"metro","fileMetadata":{"android":{}}}\n',
  [`_expo/static/js/android/entry-${HASH_A}.hbc`]: `hermes${'entry bundle payload '.repeat(40)}\n`,
  [`_expo/static/js/android/vendor-${HASH_B}.hbc`]: `hermes${'vendor chunk '.repeat(20)}\n`,
  [`assets/${HASH_B}`]: `fontbytes${'asset payload '.repeat(15)}\n`,
}
const gz = (content) => gzipSync(Buffer.from(content)).length
const TOTAL = Object.values(DIST_FILES).reduce((sum, c) => sum + gz(c), 0)
const ENTRY_CHUNK = gz(DIST_FILES[`_expo/static/js/android/entry-${HASH_A}.hbc`])
const VENDOR_CHUNK = gz(DIST_FILES[`_expo/static/js/android/vendor-${HASH_B}.hbc`])
const ASSET_BYTES = gz(DIST_FILES[`assets/${HASH_B}`])

const GENEROUS_BUDGET = { totalGzipKb: 250, largestChunkGzipKb: 180, largestAssetGzipKb: 100 }

/**
 * @param {{ budget?: object | null, baseline?: object | string,
 *           dist?: Record<string, string | Buffer> | null,
 *           nodeModules?: boolean, exportExit?: number }} [opts]
 */
function fixture({
  budget = GENEROUS_BUDGET,
  baseline,
  dist = DIST_FILES,
  nodeModules = true,
  exportExit = 0,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-buildgate-'))
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TOOLS, 'build-check.mjs'), join(dir, 'tools/build-check.mjs'))
  if (nodeModules) mkdirSync(join(dir, 'node_modules'), { recursive: true })
  mkdirSync(join(dir, 'apps/mobile'), { recursive: true })
  writeFileSync(join(dir, 'apps/mobile/package.json'), '{"name":"mobile"}\n')
  if (dist !== null) {
    for (const [rel, content] of Object.entries(dist)) {
      mkdirSync(join(dir, 'apps/mobile/dist', rel, '..'), { recursive: true })
      writeFileSync(join(dir, 'apps/mobile/dist', rel), content)
    }
  }
  if (budget !== null) {
    mkdirSync(join(dir, 'tools'), { recursive: true })
    writeFileSync(join(dir, 'tools/bundle-budget.json'), `${JSON.stringify(budget)}\n`)
  }
  if (baseline !== undefined) {
    const text = typeof baseline === 'string' ? baseline : `${JSON.stringify(baseline)}\n`
    writeFileSync(join(dir, 'tools/perf-baseline.json'), text)
  }
  // pnpm shims (sh + .cmd): `pnpm --filter mobile exec expo export …` becomes a no-op
  // with the chosen exit code, so the gate proceeds to measure the fixture dist.
  const bin = join(dir, 'fakebin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\nexit ${exportExit}\n`)
  chmodSync(join(bin, 'pnpm'), 0o755)
  writeFileSync(join(bin, 'pnpm.cmd'), `@echo off\r\nexit /b ${exportExit}\r\n`)
  return dir
}

// Windows names the variable Path; override THAT key or the child gets two PATHs.
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'

function runGate(dir, { ci = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  if (ci) env.CI = 'true'
  env[PATH_KEY] = `${join(dir, 'fakebin')}${delimiter}${process.env[PATH_KEY] ?? ''}`
  const res = spawnSync('node', [join(dir, 'tools/build-check.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    env,
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// ── gate-level ratchet proofs ─────────────────────────────────────────────────
test('RED ratchet: a tiny committed baseline → fails naming measured, baseline × ratioCap, the ceremony', () => {
  const dir = fixture({ baseline: { gzip: { total: 10 }, ratioCap: 1.25 } })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`bundle total ${TOTAL} B gzip exceeds the committed ratchet`), r.out)
  assert.ok(r.out.includes('baseline 10 B × ratioCap 1.25'), r.out)
  assert.ok(r.out.includes('pnpm perf:baseline'), r.out)
  assert.ok(r.out.includes('reviewed commit'), r.out)
})

test('GREEN exact boundary: measured == baseline × ratioCap passes (strict-growth ratchet)', () => {
  const green = runGate(fixture({ baseline: { gzip: { total: TOTAL }, ratioCap: 1 } }))
  assert.equal(green.code, 0, green.out)
  assert.ok(green.out.includes('build: OK'), green.out)
  // …and one byte less of allowance is the red side of the same boundary.
  const red = runGate(fixture({ baseline: { gzip: { total: TOTAL - 1 }, ratioCap: 1 } }))
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('committed ratchet'), red.out)
})

test('RED per-chunk ratchet: a declared logical chunk over its cap fails naming the chunk key', () => {
  const dir = fixture({
    baseline: { gzip: { total: TOTAL, chunks: { 'android/vendor.hbc': 1 } }, ratioCap: 1.25 },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('chunk "android/vendor.hbc"'), r.out)
  assert.ok(r.out.includes(`${VENDOR_CHUNK} B gzip exceeds the committed ratchet`), r.out)
})

test('NOTE, not red: a baseline chunk key the export no longer emits — total still ratchets', () => {
  const dir = fixture({
    baseline: { gzip: { total: TOTAL, chunks: { 'android/ghost.hbc': 123 } }, ratioCap: 1 },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('NOTE — baseline chunk "android/ghost.hbc" is no longer emitted'), r.out)
})

test('absent baseline: loud NOTE names file + command; absolute budgets keep their behavior', () => {
  const green = runGate(fixture())
  assert.equal(green.code, 0, green.out)
  assert.ok(green.out.includes('NOTE — tools/perf-baseline.json absent'), green.out)
  assert.ok(green.out.includes('pnpm perf:baseline'), green.out)
  // The absolute-cap red is untouched: a tiny totalGzipKb still fails with the budget
  // message and no ratchet vocabulary.
  const red = runGate(fixture({ budget: { totalGzipKb: 0.001 } }))
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('KB budget (tools/bundle-budget.json)'), red.out)
  assert.ok(!red.out.includes('committed ratchet'), red.out)
})

test('malformed baseline FAILS CLOSED: invalid JSON and bad shapes red with the regenerate FIX', () => {
  const cases = [
    ['{ not json', 'is not valid JSON'],
    ['{"ratioCap": 1.25}\n', 'gzip.total'],
    [`${JSON.stringify({ gzip: { total: TOTAL } })}\n`, 'ratioCap'],
    [
      `${JSON.stringify({ gzip: { total: TOTAL, chunks: { 'android/entry.hbc': -5 } }, ratioCap: 1.25 })}\n`,
      'chunks',
    ],
  ]
  for (const [text, needle] of cases) {
    const r = runGate(fixture({ baseline: text }))
    assert.equal(r.code, 1, `${needle}: ${r.out}`)
    assert.ok(r.out.includes(needle), r.out)
    assert.ok(r.out.includes('FAILS CLOSED'), r.out)
    assert.ok(r.out.includes('pnpm perf:baseline'), r.out)
  }
})

test('purity: every forbidden marker in an emitted file reds naming file, marker, and why', () => {
  const cases = [
    ['fetch("postgres://app:secret@db/prod")', 'connection string in the client bundle'],
    ['fetch("postgresql://app:secret@db/prod")', 'connection string in the client bundle'],
    ['const t = process.env.EXPO_TOKEN', 'EAS credential name in the client bundle'],
    ['const k = "sk_live_abc"', 'live secret-key material reference in the client bundle'],
    ['require("drizzle-orm")', 'ORM code in the client bundle (server/db leak)'],
  ]
  for (const [payload, why] of cases) {
    const dist = { ...DIST_FILES, [`_expo/static/js/android/leak-${HASH_A}.hbc`]: `${payload}\n` }
    const r = runGate(fixture({ dist }))
    assert.equal(r.code, 1, `${why}: ${r.out}`)
    assert.ok(r.out.includes(why), r.out)
    assert.ok(r.out.includes(`leak-${HASH_A}.hbc`), r.out)
  }
})

// ── per-image budgets (0.1.2): magic-byte classification, raw-size caps ──────
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const fakePng = (kb) => Buffer.concat([PNG_MAGIC, Buffer.alloc(kb * 1024, 7)])
const fakeJpeg = (kb) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(kb * 1024, 9)])

test('RED image budgets: an oversized image reds raw-named; a PNG over threshold gets the WebP fix', () => {
  const dist = { ...DIST_FILES, [`assets/${HASH_A}`]: fakePng(8) }
  const largest = runGate(
    fixture({ dist, budget: { ...GENEROUS_BUDGET, largestImageKb: 4 } }),
  )
  assert.equal(largest.code, 1, largest.out)
  assert.ok(largest.out.includes(`assets/${HASH_A}`), largest.out)
  assert.ok(largest.out.includes('raw png exceeds the 4 KB per-image budget'), largest.out)

  const webp = runGate(
    fixture({ dist, budget: { ...GENEROUS_BUDGET, pngOverKbPreferWebp: 4 } }),
  )
  assert.equal(webp.code, 1, webp.out)
  assert.ok(webp.out.includes('PNG exceeds the 4 KB PNG threshold'), webp.out)
  assert.ok(webp.out.includes('convert the source to WebP'), webp.out)

  // The same bytes as a JPEG trip neither the PNG threshold nor the (higher) cap.
  const jpegDist = { ...DIST_FILES, [`assets/${HASH_A}`]: fakeJpeg(8) }
  const jpegGreen = runGate(
    fixture({
      dist: jpegDist,
      budget: { ...GENEROUS_BUDGET, largestImageKb: 16, pngOverKbPreferWebp: 4 },
    }),
  )
  assert.equal(jpegGreen.code, 0, jpegGreen.out)
})

test('RED maxImageCount: more shipped images than budgeted reds with the audit hint; text assets never count', () => {
  const dist = {
    ...DIST_FILES,
    [`assets/${HASH_A}`]: fakePng(1),
    'assets/deadbeefdeadbeefdeadbeefdeadbeef': fakeJpeg(1),
  }
  const red = runGate(fixture({ dist, budget: { ...GENEROUS_BUDGET, maxImageCount: 1 } }))
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('2 image file(s), over the maxImageCount 1'), red.out)

  // The default DIST_FILES carry no image magic bytes — count 0, always green.
  const green = runGate(fixture({ budget: { ...GENEROUS_BUDGET, maxImageCount: 0 } }))
  assert.equal(green.code, 0, green.out)
})

test('RED: tools/bundle-budget.json missing — the bundle must never lack a byte budget', () => {
  const r = runGate(fixture({ budget: null }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/bundle-budget.json missing'), r.out)
})

test('RED: a "successful" export that produced no dist/ reds naming the directory', () => {
  const r = runGate(fixture({ dist: null }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('expo export produced no apps/mobile/dist/'), r.out)
})

test('RED: a failing expo export reds with its output, before any measurement', () => {
  const r = runGate(fixture({ exportExit: 1 }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('expo export failed'), r.out)
})

test('skip asymmetry: node_modules absent → loud local SKIP before any spawn; CI fail-closed', () => {
  const local = runGate(fixture({ nodeModules: false }), { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.ok(local.out.includes('SKIPPED'), local.out)
  assert.ok(local.out.includes('node_modules missing'), local.out)
  const ci = runGate(fixture({ nodeModules: false }), { ci: true })
  assert.equal(ci.code, 1, ci.out)
})

// ── stamp: the baseline is a build input ─────────────────────────────────────
test('warm stamp: green run records .harness/build.ok; editing the baseline invalidates the skip', () => {
  const dir = fixture({ baseline: { gzip: { total: TOTAL }, ratioCap: 1.25 } })
  const cold = runGate(dir, { ci: false })
  assert.equal(cold.code, 0, cold.out)
  assert.ok(existsSync(join(dir, '.harness/build.ok')), 'green run must record the stamp')
  // Warm re-run WITHOUT the shim: the stamp short-circuits before the export spawn, so
  // the absent shim is never reached — proof expo was not run.
  rmSync(join(dir, 'fakebin'), { recursive: true, force: true })
  const warm = runGate(dir, { ci: false })
  assert.equal(warm.code, 0, warm.out)
  assert.ok(warm.out.includes('inputs unchanged'), warm.out)
  // Edit the committed baseline: the stamp must invalidate and the gate re-run for
  // real — here the tightened baseline goes RED, proof it re-measured.
  mkdirSync(join(dir, 'fakebin'), { recursive: true })
  writeFileSync(join(dir, 'fakebin/pnpm'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'fakebin/pnpm'), 0o755)
  writeFileSync(join(dir, 'fakebin/pnpm.cmd'), '@echo off\r\nexit /b 0\r\n')
  writeFileSync(
    join(dir, 'tools/perf-baseline.json'),
    `${JSON.stringify({ gzip: { total: Math.floor(TOTAL / 2) }, ratioCap: 1 })}\n`,
  )
  const after = runGate(dir, { ci: false })
  assert.equal(after.code, 1, after.out)
  assert.ok(!after.out.includes('inputs unchanged'), after.out)
  assert.ok(after.out.includes('committed ratchet'), after.out)
})

// ── shared measuring lib (pure — no gate spawn, no shim) ─────────────────────
/** @param {Record<string, string>} [files] */
function distFixture(files = DIST_FILES) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-measure-'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

test('measureDist: totals sum every emitted file; Hermes chunks key by platform/logical name; assets aggregate', () => {
  const dist = distFixture()
  const a = measureDist(dist)
  assert.equal(a.totalBytes, TOTAL)
  assert.deepEqual(a.chunks, {
    'android/entry.hbc': ENTRY_CHUNK,
    'android/vendor.hbc': VENDOR_CHUNK,
    assets: ASSET_BYTES,
  })
  // metadata.json never enters chunks; every file enters the total.
  assert.equal(a.files.length, 4)
  const b = measureDist(dist)
  assert.deepEqual(b, a, 'same tree must measure identically')
})

test('measureDist: unhashed names pass through; same logical key sums; a non-hash hyphen survives', () => {
  const dist = distFixture({
    '_expo/static/js/android/entry.hbc': 'no hash\n',
    [`_expo/static/js/android/data-model-${HASH_A}.hbc`]: 'hyphen but the 32-hex tail strips\n',
    [`_expo/static/js/ios/entry-${HASH_A}.hbc`]: 'one, platform keys apart\n',
    [`_expo/static/js/ios/entry-${HASH_B}.hbc`]: 'two, same logical key sums\n',
    'assets/deadbeefdeadbeefdeadbeefdeadbeef': 'asset one\n',
    [`assets/${HASH_A}`]: 'asset two\n',
  })
  const m = measureDist(dist)
  assert.deepEqual(Object.keys(m.chunks).sort(), [
    'android/data-model.hbc',
    'android/entry.hbc',
    'assets',
    'ios/entry.hbc',
  ])
  assert.equal(m.chunks['ios/entry.hbc'], gz('one, platform keys apart\n') + gz('two, same logical key sums\n'))
  assert.equal(m.chunks.assets, gz('asset one\n') + gz('asset two\n'))
})

test('imageFormatOf: magic bytes classify png/jpeg/gif/webp; everything else is null', () => {
  assert.equal(imageFormatOf(fakePng(1)), 'png')
  assert.equal(imageFormatOf(fakeJpeg(1)), 'jpeg')
  assert.equal(imageFormatOf(Buffer.from('GIF89a....')), 'gif')
  assert.equal(
    imageFormatOf(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])),
    'webp',
  )
  assert.equal(imageFormatOf(Buffer.from('hermes bytecode or text')), null)
  assert.equal(imageFormatOf(Buffer.alloc(0)), null)
  // A truncated signature never misclassifies.
  assert.equal(imageFormatOf(PNG_MAGIC.subarray(0, 3)), null)
})

test('parseBaseline: accepts the shipped shape; rejects every malformed variant with a named reason', () => {
  const good = parseBaseline(
    JSON.stringify({
      comment: 'x',
      generatedBy: 'pnpm perf:baseline',
      gzip: { chunks: { 'android/entry.hbc': 10 }, total: 100 },
      installerBudgetBytes: 5,
      ratioCap: 1.25,
    }),
  )
  assert.equal(good.gzip.total, 100)
  /** @type {[string, RegExp][]} */
  const bad = [
    ['nope', /not valid JSON/],
    ['[1]', /JSON object/],
    ['{"gzip":{"total":0},"ratioCap":1.25}', /gzip\.total/],
    ['{"gzip":{"total":"100"},"ratioCap":1.25}', /gzip\.total/],
    ['{"gzip":{"total":100},"ratioCap":0.9}', /ratioCap >= 1/],
    ['{"gzip":{"total":100,"chunks":[1]},"ratioCap":1.25}', /gzip\.chunks/],
    ['{"gzip":{"total":100,"chunks":{"a.hbc":0}},"ratioCap":1.25}', /gzip\.chunks\["a\.hbc"\]/],
    ['{"gzip":{"total":100},"ratioCap":1.25,"installerBudgetBytes":-1}', /installerBudgetBytes/],
  ]
  for (const [text, re] of bad) {
    assert.throws(() => parseBaseline(text), re, text)
  }
})

test('ratchetFindings: strict-growth boundary — at the cap green, one byte over red; missing chunk notes', () => {
  const baseline = {
    gzip: { total: 100, chunks: { 'android/entry.hbc': 40, 'android/gone.hbc': 5 } },
    ratioCap: 1.25,
  }
  const atCap = ratchetFindings({ totalBytes: 125, chunks: { 'android/entry.hbc': 50 } }, baseline)
  assert.deepEqual(atCap.errs, [])
  assert.equal(atCap.notes.length, 1)
  assert.match(atCap.notes[0], /"android\/gone\.hbc" is no longer emitted/)
  const over = ratchetFindings({ totalBytes: 126, chunks: { 'android/entry.hbc': 51 } }, baseline)
  assert.equal(over.errs.length, 2)
  assert.match(over.errs[0], /126 B gzip exceeds .* 125 B/)
  assert.match(over.errs[1], /chunk "android\/entry\.hbc": 51 B/)
})

// ── regenerator compose/serialize (what `pnpm perf:baseline` writes) ─────────
test('composeBaseline + serializeBaseline: sorted keys, stable bytes, human-tuned knobs preserved', () => {
  const measured = { totalBytes: 12345, chunks: { 'z.hbc': 2, 'a.hbc': 1 }, files: [] }
  const fresh = composeBaseline({ measured, prev: null })
  assert.equal(fresh.generatedBy, 'pnpm perf:baseline')
  assert.equal(fresh.ratioCap, 1.25)
  assert.ok(fresh.installerBudgetBytes > 0)
  const text = serializeBaseline(fresh)
  // Deep-sorted and byte-stable: identical input, identical output; keys in order.
  assert.equal(text, serializeBaseline(composeBaseline({ measured, prev: null })))
  assert.ok(text.endsWith('\n'))
  const keyOrder = [...text.matchAll(/^ {2}"([a-zA-Z]+)":/gm)].map((m) => m[1])
  assert.deepEqual(keyOrder, ['comment', 'generatedBy', 'gzip', 'installerBudgetBytes', 'ratioCap'])
  assert.ok(text.indexOf('"a.hbc"') < text.indexOf('"z.hbc"'), 'chunk keys must serialize sorted')
  // A previous baseline's reviewed policy knobs survive; measured bytes move.
  const prev = {
    comment: 'tuned',
    gzip: { total: 1, chunks: {} },
    installerBudgetBytes: 777,
    ratioCap: 2,
  }
  const next = composeBaseline({ measured, prev })
  assert.equal(next.comment, 'tuned')
  assert.equal(next.installerBudgetBytes, 777)
  assert.equal(next.ratioCap, 2)
  assert.equal(next.gzip.total, 12345)
})

test('diffBaseline: seeding line without a previous baseline; total/chunk deltas against one', () => {
  const measured = { totalBytes: 200, chunks: { 'android/entry.hbc': 150, 'new.hbc': 50 }, files: [] }
  const next = composeBaseline({ measured, prev: null })
  assert.match(diffBaseline(null, next)[0], /no previous .*seeding gzip total 200 B/)
  const prev = {
    gzip: { total: 100, chunks: { 'android/entry.hbc': 100, 'old.hbc': 10 } },
    ratioCap: 1.25,
  }
  const lines = diffBaseline(prev, next)
  assert.match(lines[0], /gzip total: 100 B → 200 B \(\+100\.0%\)/)
  assert.ok(lines.some((l) => /chunk "android\/entry\.hbc": 100 B → 150 B/.test(l)), lines.join('|'))
  assert.ok(lines.some((l) => /chunk "new\.hbc": NEW at 50 B/.test(l)), lines.join('|'))
  assert.ok(lines.some((l) => /chunk "old\.hbc": REMOVED/.test(l)), lines.join('|'))
})
