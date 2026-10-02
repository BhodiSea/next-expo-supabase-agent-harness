// Contract tests for template/base/tools/lib/gate.mjs: the FIX[gate] feedback
// line on every failure path (an agent reading a red Stop block gets the exact
// reproduce command), and the content-addressed stamp machinery (stale-pass
// prevention is the whole risk of stamping, so invalidation is asserted per
// declared input class in tools/lib/stamp-inputs.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// Static for the in-process uses (0.8.0 — knip opacity + the Windows workaround,
// check-query-shapes precedent). GATE_LIB stays: it is interpolated into a GENERATED
// fixture script below, where a static specifier is impossible and the file:// href is
// the correct cross-platform form (the ramp-expiry.test.mjs pattern).
import * as gateLib from '../../template/base/tools/lib/gate.mjs'
// A namespace import (1.0.4): `withMachinery` is exported for the module gates, and a named
// import of an export the register lacks would fail this whole file at link time instead of
// failing the one test that needs it.
import * as stampRegister from '../../template/base/tools/lib/stamp-inputs.mjs'

const { hashInputs, noteMissingPrerequisite, rampNote } = gateLib
const { STAMP_INPUTS } = stampRegister
// Every regex metacharacter, backslash included: a path is matched literally.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const GATE_LIB = pathToFileURL(
  fileURLToPath(new URL('../../template/base/tools/lib/gate.mjs', import.meta.url)),
).href

/** @param {string} script @param {{ env?: Record<string, string>, cwd?: string, args?: string[] }} [opts] */
function runInFixture(script, { env = {}, cwd, args = [] } = {}) {
  const dir = cwd ?? mkdtempSync(join(tmpdir(), 'epah-gatelib-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  const file = join(dir, 'tools', 'check-fake.mjs')
  writeFileSync(file, `import { fail, failures, ok, rampNote, skipOrFail, stampGate } from '${GATE_LIB}'\n${script}`)
  const res = spawnSync('node', [file, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: '', HARNESS_REQUIRE_TOOLCHAINS: '', GITHUB_BASE_REF: '', ...env },
  })
  return { dir, code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('fail() emits the FIX[gate] line with the exact reproduce command', () => {
  const r = runInFixture(`fail('fake', 'boom')`)
  assert.equal(r.code, 1)
  assert.ok(r.out.includes('fake: FAIL — boom'), r.out)
  assert.ok(r.out.includes('FIX[fake]: reproduce with `node tools/check-fake.mjs`'), r.out)
  assert.ok(r.out.includes('docs/harness/gates-catalog.md ("fake")'), r.out)
})

test('the FIX line keeps path arguments and elides the value of a KEY=VALUE pair', () => {
  // 1.0.4 (#10): the line kept only [a-z0-9-] tokens, so `--file maestro/journeys/x.yaml
  // --out-dir artifacts/maestro/x` reproduced as `--file --out-dir`, which the runner
  // rejects. A token still needing shell quoting is dropped, as before, and so is the flag
  // it was the value of, so what is printed still parses.
  const r = runInFixture(`fail('fake', 'boom')`, {
    args: [
      '--phase',
      'journey',
      '--file',
      'maestro/journeys/mutation.yaml',
      '--env',
      'DEVICE_PASSWORD=hunter2',
      '--note',
      'two words',
      '--out-dir',
      'artifacts/maestro/mutation',
    ],
  })
  assert.equal(r.code, 1)
  assert.ok(
    r.out.includes(
      'FIX[fake]: reproduce with `node tools/check-fake.mjs --phase journey --file maestro/journeys/mutation.yaml --env DEVICE_PASSWORD=… --out-dir artifacts/maestro/mutation`',
    ),
    r.out,
  )
  assert.ok(!r.out.includes('hunter2'), r.out)
  assert.ok(!r.out.includes('two words'), r.out)
})

test('failures() and CI-mode skipOrFail() emit the FIX line; local skip does not', () => {
  const lists = runInFixture(`failures('fake', ['a', 'b'], 'hint line')`)
  assert.equal(lists.code, 1)
  assert.ok(lists.out.includes('hint line'), lists.out)
  assert.ok(lists.out.includes('FIX[fake]:'), lists.out)

  const ciSkip = runInFixture(`skipOrFail('fake', 'toolchain missing')`, { env: { CI: 'true' } })
  assert.equal(ciSkip.code, 1)
  assert.ok(ciSkip.out.includes('FIX[fake]:'), ciSkip.out)

  const localSkip = runInFixture(`skipOrFail('fake', 'toolchain missing')`)
  assert.equal(localSkip.code, 0)
  assert.ok(localSkip.out.includes('SKIPPED'), localSkip.out)
  assert.ok(!localSkip.out.includes('FIX['), localSkip.out)
})

// ── field notes (1.1.0, #61): the project's own line under a gate's FIX line ────────────
// tools/field-notes.json maps a gate token (the `<gate>` of `<gate>: FAIL` and `FIX[<gate>]`)
// to one string, printed as `FIELD-NOTE[<gate>]: <text>` right after the FIX line on the
// three failure paths, and nowhere else. PRINT-ONLY: the exit code never moves, and the FAIL,
// bullet and FIX lines are byte-identical with and without the file, so each case below
// compares against the same script run with no file at all.
const NOTE_TEXT = 'this gate usually means the fixture in supabase/tests needs a db:reset first'
const NOTE_LINE = `FIELD-NOTE[fake]: ${NOTE_TEXT}`
const INVALID_NOTE_LINE = 'FIELD-NOTE[fake]: tools/field-notes.json is not valid JSON; no note printed'
const FAILING_SCRIPTS = {
  fail: { script: `fail('fake', 'boom')`, env: {} },
  failures: { script: `failures('fake', ['a', 'b'], 'hint line')`, env: {} },
  'CI-mode skipOrFail': { script: `skipOrFail('fake', 'toolchain missing')`, env: { CI: 'true' } },
}

/** A fresh fixture dir whose tools/field-notes.json holds `content` (a string is written raw). */
function notesDir(content) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-fieldnote-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  writeFileSync(
    join(dir, 'tools', 'field-notes.json'),
    typeof content === 'string' ? content : JSON.stringify(content),
  )
  return dir
}

test('fail(), failures() and CI-mode skipOrFail() print the field note right after FIX, and exit 1', () => {
  for (const [label, { script, env }] of Object.entries(FAILING_SCRIPTS)) {
    const bare = runInFixture(script, { env })
    const noted = runInFixture(script, { env, cwd: notesDir({ comment: 'x', notes: { fake: NOTE_TEXT } }) })
    assert.equal(noted.code, 1, `${label}: ${noted.out}`)
    const lines = noted.out.split('\n')
    const fixAt = lines.findIndex((l) => l.startsWith('FIX[fake]: '))
    assert.ok(fixAt >= 0, `${label}: no FIX line\n${noted.out}`)
    assert.equal(lines[fixAt + 1], NOTE_LINE, `${label}: the note must be the line after FIX\n${noted.out}`)
    assert.equal(lines.filter((l) => l.startsWith('FIELD-NOTE[')).length, 1, `${label}: one note\n${noted.out}`)
    // Byte-identical FAIL, bullet and FIX lines: the note is the ONLY difference.
    assert.equal(noted.out, `${bare.out}${NOTE_LINE}\n`, `${label}: the note may only append one line`)
  }
})

test('a note keyed on another gate prints nothing under this one', () => {
  const r = runInFixture(`fail('fake', 'boom')`, { cwd: notesDir({ notes: { 'other-gate': NOTE_TEXT } }) })
  assert.equal(r.code, 1, r.out)
  assert.ok(!r.out.includes('FIELD-NOTE['), r.out)
})

test('ok() and a local skipOrFail() print no field note and exit 0', () => {
  const notes = { notes: { fake: NOTE_TEXT } }
  const green = runInFixture(`ok('fake', 'fine')`, { cwd: notesDir(notes) })
  assert.equal(green.code, 0, green.out)
  assert.ok(!green.out.includes('FIELD-NOTE['), green.out)
  const localSkip = runInFixture(`skipOrFail('fake', 'toolchain missing')`, { cwd: notesDir(notes) })
  assert.equal(localSkip.code, 0, localSkip.out)
  assert.ok(localSkip.out.includes('fake: SKIPPED'), localSkip.out)
  assert.ok(!localSkip.out.includes('FIELD-NOTE['), localSkip.out)
})

test('with no notes file, a failing gate ends on its FIX line exactly as before', () => {
  for (const [label, { script, env }] of Object.entries(FAILING_SCRIPTS)) {
    const r = runInFixture(script, { env })
    assert.equal(r.code, 1, `${label}: ${r.out}`)
    assert.ok(!r.out.includes('FIELD-NOTE'), `${label}: ${r.out}`)
    assert.match(r.out.trimEnd().split('\n').at(-1) ?? '', /^FIX\[fake\]: reproduce with `node tools\/check-fake\.mjs/, label)
  }
})

test('an invalid notes file still exits 1 with FAIL and FIX intact, and prints the one invalid-JSON line', () => {
  for (const [label, { script, env }] of Object.entries(FAILING_SCRIPTS)) {
    const bare = runInFixture(script, { env })
    const r = runInFixture(script, { env, cwd: notesDir('{ "notes": { "fake": "unterminated') })
    assert.equal(r.code, 1, `${label}: ${r.out}`)
    assert.equal(r.out, `${bare.out}${INVALID_NOTE_LINE}\n`, `${label}: ${r.out}`)
  }
})

test('a notes path that cannot be read (a directory) prints nothing and changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-fieldnote-dir-'))
  mkdirSync(join(dir, 'tools', 'field-notes.json'), { recursive: true })
  const bare = runInFixture(`fail('fake', 'boom')`)
  const r = runInFixture(`fail('fake', 'boom')`, { cwd: dir })
  assert.equal(r.code, 1, r.out)
  assert.equal(r.out, bare.out)
})

// In-process, so the tools/lib/** coverage floor counts the renderer. It is pure: the gate
// token and the file's raw text (null when absent) in, the line to print (or null) out.
// Reached through the namespace so a lib without it fails these tests, not the whole file.
/** @param {string} gate @param {string | null} raw @returns {string | null} */
const render = (gate, raw) => gateLib.renderFieldNote(gate, raw)
const notesJson = (notes) => JSON.stringify({ comment: 'x', notes })
const MAX = /** @type {number} */ (gateLib.FIELD_NOTE_MAX_CHARS)

test('renderFieldNote: an absent file, or a present key, render as null or one prefixed line', () => {
  assert.equal(render('fake', null), null)
  assert.equal(render('fake', notesJson({ fake: NOTE_TEXT })), NOTE_LINE)
  assert.equal(render('fake', notesJson({})), null)
  assert.equal(render('fake', notesJson({ 'fake-two': NOTE_TEXT })), null)
})

test('renderFieldNote: newlines and other whitespace collapse to single spaces, ends trimmed', () => {
  const raw = notesJson({ fake: '\n  first line\r\n\tsecond third  \u0085fourth  \n' })
  assert.equal(render('fake', raw), 'FIELD-NOTE[fake]: first line second third fourth')
})

test('renderFieldNote: ESC and every other control or format character is removed', () => {
  const cases = [
    ['\u001b[31mred\u001b[0m', '[31mred[0m'], // ESC (a terminal colour sequence loses its introducer)
    ['nul\u0000 del\u007f c1\u009b', 'nul del c1'], // C0, DEL, C1
    ['\u202eevil\u202c ok', 'evil ok'], // a bidirectional override and its pop
    ['zero\u200bwidth\u200d join\u2066iso\u2069 \ufeffbom', 'zerowidth joiniso bom'], // Cf, BOM
    ['a \u200b b', 'a b'], // removing one never leaves a double space
  ]
  for (const [input, want] of cases) {
    assert.equal(render('fake', notesJson({ fake: input })), `FIELD-NOTE[fake]: ${want}`, JSON.stringify(input))
  }
  // A note that is nothing but removed characters prints nothing.
  assert.equal(render('fake', notesJson({ fake: '\u001b\u200b \u0000\n' })), null)
})

test('renderFieldNote: the text is capped at FIELD_NOTE_MAX_CHARS code points, ending in … when cut', () => {
  assert.equal(typeof MAX, 'number', 'tools/lib/gate.mjs must export FIELD_NOTE_MAX_CHARS')
  const text = (line) => (line ?? '').slice('FIELD-NOTE[fake]: '.length)
  const exact = 'x'.repeat(MAX)
  assert.equal(text(render('fake', notesJson({ fake: exact }))), exact, 'at the cap: unchanged')
  const over = text(render('fake', notesJson({ fake: 'x'.repeat(MAX + 1) })))
  assert.equal([...over].length, MAX)
  assert.equal(over, `${'x'.repeat(MAX - 1)}…`)
  // A surrogate pair straddling the cut: a UTF-16 slice would keep its high half alone.
  const emoji = '\u{1F600}'
  const straddle = text(render('fake', notesJson({ fake: `${'a'.repeat(MAX - 2)}${emoji}tail` })))
  assert.equal(straddle, `${'a'.repeat(MAX - 2)}${emoji}…`)
  // In a u-mode regex only a LONE surrogate matches \p{Cs}; a whole pair is one code point.
  assert.doesNotMatch(straddle, /\p{Cs}/u, 'no lone surrogate at the cut')
  const dropped = text(render('fake', notesJson({ fake: `${'a'.repeat(MAX - 1)}${emoji}tail` })))
  assert.equal(dropped, `${'a'.repeat(MAX - 1)}…`)
  assert.doesNotMatch(dropped, /\p{Cs}/u)
})

test('renderFieldNote: foreign keys, non-string values and a non-object `notes` are ignored', () => {
  // Keys must match ^[a-z0-9-]+$; a near-miss of the token never matches it.
  assert.equal(render('fake', notesJson({ Fake: 'x', 'fake ': 'x', fa_ke: 'x' })), null)
  assert.equal(render('Fake', notesJson({ Fake: 'x' })), null, 'a key outside the token shape is ignored')
  assert.equal(render('constructor', notesJson({})), null, 'never an inherited property')
  for (const value of [42, true, null, ['x'], { text: 'x' }]) {
    assert.equal(render('fake', notesJson({ fake: value })), null, JSON.stringify(value))
  }
  for (const raw of ['{}', '{"notes": []}', '{"notes": "x"}', '{"notes": null}', '[]', 'null', '"x"', '7']) {
    assert.equal(render('fake', raw), null, raw)
  }
})

test('renderFieldNote: invalid JSON renders the one invalid-JSON line, and never throws', () => {
  for (const raw of ['{ not json', '', '{"notes": {"fake": "x"},}']) {
    assert.equal(render('fake', raw), INVALID_NOTE_LINE, JSON.stringify(raw))
  }
})

test('the seeded tools/field-notes.json is the empty skeleton, and the catalog names the cap by its constant', () => {
  const base = fileURLToPath(new URL('../../template/base/', import.meta.url))
  const seeded = JSON.parse(readFileSync(join(base, 'tools', 'field-notes.json'), 'utf8'))
  assert.deepEqual(Object.keys(seeded).sort(), ['comment', 'notes'])
  assert.deepEqual(seeded.notes, {}, 'seeded empty: the harness has no notes about a project it has not seen')
  assert.match(seeded.comment, /FAIL/, 'the comment says to key on the token printed in the FAIL line')
  assert.equal(render('fake', JSON.stringify(seeded)), null)
  const catalog = readFileSync(join(base, 'docs', 'harness', 'gates-catalog.md'), 'utf8')
  const shared = catalog.slice(catalog.indexOf('Shared behavior'), catalog.indexOf('## Honest losses'))
  for (const want of ['tools/field-notes.json', 'FIELD-NOTE[<gate>]:', 'FIELD_NOTE_MAX_CHARS']) {
    assert.ok(shared.includes(want), `the catalog's "Shared behavior" paragraph must name ${want}`)
  }
  assert.ok(!shared.includes(String(MAX)), 'the cap is named by its constant, never written as a number')
})

test('every shipped gate script routes failures through lib/gate.mjs (the FIX contract)', async () => {
  const toolsDir = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
  // build-check.mjs is the one gate whose name does not start with check- here.
  const gateScripts = readdirSync(toolsDir).filter((f) => /^(check-.*|build-check)\.mjs$/.test(f))
  assert.ok(gateScripts.length >= 12, `expected the gate fleet, got ${gateScripts.length}`)
  for (const f of gateScripts) {
    const src = readFileSync(join(toolsDir, f), 'utf8')
    assert.match(src, /from '\.\/lib\/gate\.mjs'/, `${f} must use lib/gate.mjs so every failure carries the FIX[gate] line`)
    assert.ok(!/process\.exit\(1\)/.test(src), `${f} must not exit(1) directly — use fail()/failures()/skipOrFail()`)
  }
})

const STAMP_SCRIPT = `
const recordGreen = stampGate('fake', ['input.txt'])
recordGreen()
ok('fake', 'ran the real check')
`

test('stampGate: green run stamps; unchanged inputs print STAMPED; mutation re-runs; CI ignores stamps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-stamp-'))
  writeFileSync(join(dir, 'input.txt'), 'v1\n')

  const first = runInFixture(STAMP_SCRIPT, { cwd: dir })
  assert.equal(first.code, 0)
  assert.ok(first.out.includes('ran the real check'), first.out)

  // A stamp hit is its OWN status (1.0.4): an OK line read exactly like a re-proof, so a
  // turn that ended on warm stamps looked like one that re-checked everything.
  const second = runInFixture(STAMP_SCRIPT, { cwd: dir })
  assert.equal(second.code, 0)
  assert.ok(second.out.includes('fake: STAMPED — inputs unchanged since last green run'), second.out)
  assert.ok(!second.out.includes('fake: OK'), second.out)

  writeFileSync(join(dir, 'input.txt'), 'v2\n')
  const third = runInFixture(STAMP_SCRIPT, { cwd: dir })
  assert.ok(third.out.includes('ran the real check'), third.out)

  const inCi = runInFixture(STAMP_SCRIPT, { cwd: dir, env: { CI: 'true' } })
  assert.ok(inCi.out.includes('ran the real check'), `CI must never trust a stamp: ${inCi.out}`)
})

// The salt (1.0.4) is state no declared file carries: for `rls-isolation`, the Supabase CLI
// version and the running database's identity. A different salt is a different digest.
const SALTED_SCRIPT = `
const recordGreen = stampGate('fake', ['input.txt'], process.env.X_SALT)
recordGreen()
ok('fake', 'ran the real check')
`

test('stampGate: a changed salt forces a real run; the same salt rides the stamp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-stampsalt-'))
  writeFileSync(join(dir, 'input.txt'), 'v1\n')
  const salted = (salt) => runInFixture(SALTED_SCRIPT, { cwd: dir, env: { X_SALT: salt } })

  assert.ok(salted('cli 1|db a').out.includes('ran the real check'))
  const warm = salted('cli 1|db a')
  assert.ok(warm.out.includes('fake: STAMPED — inputs unchanged since last green run'), warm.out)
  const moved = salted('cli 1|db b')
  assert.equal(moved.code, 0, moved.out)
  assert.ok(moved.out.includes('ran the real check'), `a changed salt must force a real run: ${moved.out}`)
  assert.ok(!moved.out.includes('STAMPED'), moved.out)
})

test('stampGate (in-process): the salt enters the recorded digest; no salt records hashInputs alone', () => {
  // In-process so the floor on tools/lib counts it: a miss returns recordGreen without exiting.
  const dir = mkdtempSync(join(tmpdir(), 'epah-stampdigest-'))
  writeFileSync(join(dir, 'input.txt'), 'v1\n')
  const prev = process.cwd()
  const saved = { CI: process.env.CI, HARNESS_REQUIRE_TOOLCHAINS: process.env.HARNESS_REQUIRE_TOOLCHAINS }
  // A stamp HIT calls process.exit(0), which in-process would end this whole file green. So
  // each call starts from no stamp (always a miss), and exit throws for the duration.
  const realExit = process.exit
  process.exit = (code) => {
    throw new Error(`stampGate exited (${String(code)}) in-process: the stamp hit where a miss was set up`)
  }
  process.chdir(dir)
  process.env.CI = ''
  process.env.HARNESS_REQUIRE_TOOLCHAINS = ''
  const stamp = join('.harness', 'fake.ok')
  /** @param {string} [salt] */
  const record = (salt) => {
    rmSync(stamp, { force: true })
    gateLib.stampGate('fake', ['input.txt'], salt)()
    return readFileSync(stamp, 'utf8')
  }
  try {
    const plain = record()
    assert.equal(plain, hashInputs(['input.txt']), 'no salt: the digest is the inputs alone')
    const a = record('cli 1|db a')
    const b = record('cli 1|db b')
    assert.notEqual(a, plain, 'a salt must change the digest')
    assert.notEqual(a, b, 'two salts must record two digests')
    assert.equal(record('cli 1|db a'), a, 'the same salt records the same digest')
    assert.match(a, /^[0-9a-f]{64}$/)
  } finally {
    process.exit = realExit
    process.chdir(prev)
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

// ── rampNote: the shared version ramp — NOTE-only on installs whose baseVersion
// predates a check, live everywhere else, fail-closed on tampering. ──────────

// In-process: rampNote reads .harness/manifest.json from process.cwd() and
// RETURNS (no exit) on every non-tampered path, so the live/ramped matrix is
// directly assertable.
// `until` defaults far enough out that these cases exercise the ramp, never the
// clock — expiry has its own suite (tests/gates/ramp-expiry.test.mjs).
async function rampInDir(manifest, { min = '0.1.5', until = '0.4.0' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-ramp-'))
  if (manifest !== null) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness', 'manifest.json'), manifest)
  }
  const prev = process.cwd()
  const logged = []
  const origLog = console.log
  process.chdir(dir)
  console.log = (...a) => logged.push(a.map(String).join(' '))
  try {
    return { ramped: rampNote('fake', min, 'new-check details', { until }), out: logged.join('\n') }
  } finally {
    console.log = origLog
    process.chdir(prev)
  }
}

test('rampNote: no manifest (template dev tree / gate fixtures) → live, no NOTE', async () => {
  const r = await rampInDir(null)
  assert.equal(r.ramped, false)
  assert.equal(r.out, '')
})

test('rampNote: baseVersion below the ramp → NOTE naming check, ramp, and runbook; returns true', async () => {
  const r = await rampInDir(JSON.stringify({ harnessVersion: '0.1.5', baseVersion: '0.1.4' }))
  assert.equal(r.ramped, true)
  assert.ok(r.out.includes('fake: NOTE — new-check details'), r.out)
  assert.ok(r.out.includes('live from baseVersion 0.1.5'), r.out)
  assert.ok(r.out.includes("this install's baseVersion is 0.1.4"), r.out)
  assert.ok(r.out.includes('docs/runbooks/harness-upgrade.md'), r.out)
})

test('rampNote: baseVersion at/above the ramp → live; compare is numeric, not lexical', async () => {
  const atMin = await rampInDir(JSON.stringify({ harnessVersion: '0.1.5', baseVersion: '0.1.5' }))
  assert.equal(atMin.ramped, false)
  assert.equal(atMin.out, '')
  const above = await rampInDir(JSON.stringify({ harnessVersion: '0.2.0', baseVersion: '0.2.0' }))
  assert.equal(above.ramped, false)
  // 0.1.10 > 0.1.5 numerically (a lexical compare would call it ramped)
  const tenth = await rampInDir(JSON.stringify({ baseVersion: '0.1.10', harnessVersion: '0.1.10' }))
  assert.equal(tenth.ramped, false)
})

test('rampNote: a manifest without baseVersion falls back to harnessVersion', async () => {
  const old = await rampInDir(JSON.stringify({ harnessVersion: '0.1.4', files: {} }))
  assert.equal(old.ramped, true)
  assert.ok(old.out.includes("baseVersion is 0.1.4"), old.out)
  const current = await rampInDir(JSON.stringify({ harnessVersion: '0.1.5', files: {} }))
  assert.equal(current.ramped, false)
})

test('rampNote: corrupt or version-less manifest FAILS CLOSED with the FIX line (tampering, not a ramp)', () => {
  const script = `if (!rampNote('fake', '0.1.5', 'x', { until: '0.4.0' })) ok('fake', 'live')`

  const corrupt = mkdtempSync(join(tmpdir(), 'epah-rampbad-'))
  mkdirSync(join(corrupt, '.harness'), { recursive: true })
  writeFileSync(join(corrupt, '.harness', 'manifest.json'), '{ not json')
  const r1 = runInFixture(script, { cwd: corrupt })
  assert.equal(r1.code, 1, r1.out)
  assert.ok(r1.out.includes('not valid JSON'), r1.out)
  assert.ok(r1.out.includes('FIX[fake]:'), r1.out)

  const versionless = mkdtempSync(join(tmpdir(), 'epah-rampbad-'))
  mkdirSync(join(versionless, '.harness'), { recursive: true })
  writeFileSync(join(versionless, '.harness', 'manifest.json'), '{"files":{}}')
  const r2 = runInFixture(script, { cwd: versionless })
  assert.equal(r2.code, 1, r2.out)
  assert.ok(r2.out.includes('no usable baseVersion'), r2.out)
})

// ── the stamp register: MEMBERSHIP proofs, not a re-proof of hashInputs ─────────
// The predecessor of these tests materialized every declared input and mutated each
// in turn — which only re-proved that hashInputs hashes what it is given (any listed
// file invalidates when edited, tautologically) and could never fail on an input
// class MISSING from a list. Stale-pass prevention lives in membership: the paths
// whose edits must re-arm a stamp are IN the register, and the churn the Stop chain
// itself writes (coverage maps, build output) is NOT hashed.

// The test's own copy of lib/stamp-inputs.mjs's MACHINERY. tools/lib/fs-walk.mjs joins it in
// 1.0.4: gate.mjs imports it (hashInputs walks directories with it), so it decides every digest.
const STAMP_MACHINERY = [
  '.harness/manifest.json',
  'tools/lib/gate.mjs',
  'tools/lib/stamp-inputs.mjs',
  'tools/lib/fs-walk.mjs',
]
// A stamped script: a base gate under tools/, or the rls runner (1.0.4), which is a Stop step
// rather than a validate gate and lives under tests/rls/.
const STAMPED_SCRIPT_RE = /^(tools\/(check-[\w-]+|build-check)\.mjs|tests\/rls\/run-rls\.mjs)$/

test('every stamped gate declares the manifest, its own script, and the stamp machinery', () => {
  for (const [gate, inputs] of Object.entries(STAMP_INPUTS)) {
    for (const p of STAMP_MACHINERY) {
      assert.ok(inputs.includes(p), `${gate}: ${p} must be a declared input — an update or graduation (manifest), or a rewritten check (script/machinery), must re-arm the stamp`)
    }
    assert.ok(
      inputs.some((p) => STAMPED_SCRIPT_RE.test(p)),
      `${gate}: the gate's own script must be a declared input`,
    )
  }
})

// ── the IMPORT CLOSURE (1.0.4, #42) ─────────────────────────────────────────────
// A stamp that hashes a gate's script but not the libraries the script imports serves a warm
// green after an edit to exactly the code that decides the verdict: through 1.0.3 `tenancy`
// declared its script and five data paths and not lib/sql-parse.mjs, the parser that reads
// every policy predicate. Every relative module a stamped script reaches through STATIC
// imports, followed transitively, must be a declared input.
//
// The module gates are read as TEXT: their `./lib/` specifiers resolve only inside a
// scaffold, where the module's tools/ sits beside base's tools/lib (the factory's knip
// ignores template/modules/** for the same reason).
const TEMPLATE_DIR = fileURLToPath(new URL('../../template/', import.meta.url))
const BASE_DIR = join(TEMPLATE_DIR, 'base')
// Top-level static import/export-from statements only: no dynamic import(), and the clause
// may span lines but never a string literal, so it cannot run on into the next statement.
const STATIC_IMPORT_RE = /^(?:import|export)\s+(?:[^'"`;]*?\sfrom\s*)?['"]([^'"]+)['"]/gm

/**
 * The scaffold-relative files `script` reaches through relative static imports, transitively.
 * @param {string} script scaffold-relative, e.g. tools/check-tenancy.mjs
 * @param {string[]} roots template trees to read from, searched in order (a module, then base)
 * @returns {string[]}
 */
function importClosure(script, roots) {
  const seen = new Set()
  const queue = [script]
  while (queue.length > 0) {
    const file = queue.shift()
    const root = roots.find((r) => existsSync(join(r, file)))
    assert.ok(root, `${file} (reached from ${script}) is not in ${roots.join(' or ')}`)
    const src = readFileSync(join(root, file), 'utf8')
    for (const [, spec] of src.matchAll(STATIC_IMPORT_RE)) {
      if (!spec.startsWith('.')) continue
      const target = posix.normalize(posix.join(posix.dirname(file), spec))
      if (seen.has(target)) continue
      seen.add(target)
      queue.push(target)
    }
  }
  seen.delete(script)
  return [...seen].sort()
}

test('the closure reader finds a multi-line import and follows a lib into its own imports', () => {
  // Self-check: tenancy's sql-parse import spans lines, and gate.mjs imports fs-walk.mjs.
  const closure = importClosure('tools/check-tenancy.mjs', [BASE_DIR])
  assert.ok(closure.includes('tools/lib/sql-parse.mjs'), closure.join(', '))
  assert.ok(closure.includes('tools/lib/fs-walk.mjs'), closure.join(', '))
})

test('every STAMP_INPUTS entry declares its script, the machinery, and the script\'s whole import closure', () => {
  const missing = []
  for (const [gate, inputs] of Object.entries(STAMP_INPUTS)) {
    const script = inputs.find((p) => STAMPED_SCRIPT_RE.test(p))
    assert.ok(script, `${gate}: no stamped script among its inputs`)
    for (const need of new Set([...STAMP_MACHINERY, ...importClosure(script, [BASE_DIR])])) {
      if (!inputs.includes(need)) missing.push(`${gate}: ${need}`)
    }
  }
  assert.deepEqual(missing, [], `stamp inputs that a stamped script imports but its list omits:\n${missing.join('\n')}`)
})

test('every base stampGate( call site passes its STAMP_INPUTS entry, never an inline list', () => {
  const sites = [
    ...readdirSync(join(BASE_DIR, 'tools'))
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => `tools/${f}`),
    'tests/rls/run-rls.mjs',
  ]
  const calls = []
  for (const site of sites) {
    const src = readFileSync(join(BASE_DIR, site), 'utf8')
    for (const m of src.matchAll(/\bstampGate\(([^,]+),\s*([^,)\n]+)/g)) {
      calls.push(site)
      assert.match(m[2], /^STAMP_INPUTS\[/, `${site}: stampGate must read its list from STAMP_INPUTS, where the closure test sees it`)
    }
  }
  assert.ok(calls.includes('tests/rls/run-rls.mjs'), 'the rls runner stamps through stampGate (1.0.4)')
  assert.ok(calls.length >= 13, `expected every stamped base gate plus the rls runner, got ${calls.join(', ')}`)
})

test('withMachinery is exported and adds the script and the machinery to a list', () => {
  const { withMachinery } = stampRegister
  assert.equal(typeof withMachinery, 'function', 'the module gates need withMachinery exported from lib/stamp-inputs.mjs')
  const list = withMachinery('tools/check-x.mjs', ['data.json'])
  for (const p of ['data.json', 'tools/check-x.mjs', ...STAMP_MACHINERY]) {
    assert.ok(list.includes(p), `withMachinery must add ${p}: ${list.join(', ')}`)
  }
})

test('every module gate that stamps passes withMachinery(<its script>, […]) naming its whole import closure', () => {
  const modulesDir = join(TEMPLATE_DIR, 'modules')
  const found = []
  for (const mod of readdirSync(modulesDir).sort()) {
    const toolsDir = join(modulesDir, mod, 'tools')
    if (!existsSync(toolsDir)) continue
    for (const f of readdirSync(toolsDir).filter((x) => x.endsWith('.mjs')).sort()) {
      const src = readFileSync(join(toolsDir, f), 'utf8')
      // The call, never a comment that names it: `stampGate(` at the start of an expression.
      const m = /^[^/\n]*?\bstampGate\(/m.exec(src)
      if (m === null) continue
      const call = callText(src, m.index + m[0].length - 1)
      assert.ok(call, `${mod}/tools/${f}: unbalanced stampGate( call`)
      const script = `tools/${f}`
      found.push(`${mod}/${script}`)
      assert.match(
        call,
        new RegExp(`^\\(\\s*\\w+\\s*,\\s*withMachinery\\(\\s*'${escapeRe(script)}'`),
        `${mod}/${script}: pass withMachinery('${script}', […]) so the list carries the script, the manifest and the machinery`,
      )
      for (const need of importClosure(script, [join(modulesDir, mod), BASE_DIR])) {
        if (STAMP_MACHINERY.includes(need)) continue // withMachinery adds these
        assert.ok(call.includes(`'${need}'`), `${mod}/${script}: its stamp list omits ${need}, which it imports`)
      }
    }
  }
  assert.ok(found.includes('eas-update/tools/check-eas-update.mjs'), `the eas-update gate stamps: ${found.join(', ')}`)
})

/**
 * The balanced-paren text of a call whose `(` is at `open`, or null when it never closes.
 * @param {string} src @param {number} open
 */
function callText(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1
    else if (src[i] === ')') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return null
}

// 1.1.0 (#68). The two compliance-register scripts of the `docs-sync` step stamp too, and
// their lists are held to the files the verdicts actually read, derived from the source
// text: every `const NAME = '<path>'` literal with a `/` in either script and in the
// generator conformance-map spawns, and every relative import of those three files, followed
// transitively through tools/lib. The directories each script walks are named here, because
// a walk has no literal to derive. The negative proof's reads stay OUT of the essential-eight
// list: that proof runs on every run, before the stamp is consulted, so a stamp keyed on
// them would walk five product trees each run and miss on nearly every product edit.
const REGISTER_STAMPS = {
  'essential-eight': { reads: ['tools/check-essential-eight.mjs'], dirs: ['.github/workflows'] },
  'conformance-map': {
    reads: ['tools/check-conformance-map.mjs', 'tools/gen-conformance-docs.mjs'],
    dirs: ['.github/workflows', 'docs/modules'],
  },
}
const PATH_CONST_RE = /^const [A-Z][A-Z0-9_]* = '([^'\n]*\/[^'\n]*)'/gm
const NEGATIVE_PROOF_READS = [
  'supabase/config.toml',
  'apps/web/app',
  'apps/mobile/src',
  'apps/mobile/app',
  'packages/api/src',
  'supabase/functions',
]

test('essential-eight and conformance-map stamps: each list holds every path its verdict reads', () => {
  const missing = []
  for (const [gate, { reads, dirs }] of Object.entries(REGISTER_STAMPS)) {
    const inputs = STAMP_INPUTS[gate]
    assert.ok(Array.isArray(inputs), `${gate}: no STAMP_INPUTS entry`)
    const need = new Set(dirs)
    for (const file of reads) {
      need.add(file)
      const src = readFileSync(join(BASE_DIR, file), 'utf8')
      for (const [, p] of src.matchAll(PATH_CONST_RE)) need.add(p)
      for (const p of importClosure(file, [BASE_DIR])) need.add(p)
    }
    for (const p of need) if (!inputs.includes(p)) missing.push(`${gate}: ${p}`)
  }
  assert.deepEqual(missing, [], `paths a register verdict reads but its stamp list omits:\n${missing.join('\n')}`)
})

test('the derivation is not vacuous: it finds the constants and the transitive imports', () => {
  const src = readFileSync(join(BASE_DIR, 'tools/check-conformance-map.mjs'), 'utf8')
  const consts = [...src.matchAll(PATH_CONST_RE)].map((m) => m[1])
  for (const p of ['tools/conformance-map.json', 'tools/modules.json', '.claude/hooks/lib/guard-rules.mjs', 'tools/gen-conformance-docs.mjs']) {
    assert.ok(consts.includes(p), `${p} must be derived from check-conformance-map.mjs: ${consts.join(', ')}`)
  }
  const gen = readFileSync(join(BASE_DIR, 'tools/gen-conformance-docs.mjs'), 'utf8')
  const genConsts = [...gen.matchAll(PATH_CONST_RE)].map((m) => m[1])
  for (const p of ['docs/compliance/controls-crosswalk.md', 'docs/security/threat-model.md']) {
    assert.ok(genConsts.includes(p), `${p} must be derived from the generator: ${genConsts.join(', ')}`)
  }
  // lib/conformance-map.mjs imports lib/standards-claim.mjs: only the transitive walk sees it.
  assert.ok(importClosure('tools/gen-conformance-docs.mjs', [BASE_DIR]).includes('tools/lib/standards-claim.mjs'))
})

test('the essential-eight stamp leaves out config.toml and the five upload-scan roots', () => {
  const inputs = STAMP_INPUTS['essential-eight']
  assert.ok(Array.isArray(inputs), 'essential-eight: no STAMP_INPUTS entry')
  const src = readFileSync(join(BASE_DIR, 'tools/check-essential-eight.mjs'), 'utf8')
  for (const p of NEGATIVE_PROOF_READS) {
    assert.ok(!inputs.includes(p), `essential-eight: ${p} is a negative-proof read, which runs before the stamp and must not key it`)
    // The list above is the script's, not a stale copy: each root is still one it scans.
    const [head, ...rest] = p.split('/')
    assert.ok(src.includes(`'${p}'`) || src.includes(`'${head}', '${rest.join("', '")}'`), `${p} is no longer read by the script; update NEGATIVE_PROOF_READS`)
  }
})

// 1.0.4 (#46). expo-policy reads the store tunables (the account-deletion surface and,
// from 1.0.4, the registry path it names), the whole mobile source tree (the EXPO_PUBLIC_
// name scan, the routes the `route` surface reads, the auth-surface probe, any legal
// registry path) and whichever Edge Function the tunables name. Through 1.0.3 its list held
// only the default registry and delete-account, so an edit to any other of these rode a
// warm stamp locally.
test('expo-policy stamp: the tunables, both mobile source roots and every Edge Function are declared inputs', () => {
  const inputs = STAMP_INPUTS['expo-policy']
  for (const p of ['tools/store-tunables.json', 'apps/mobile/src', 'apps/mobile/app', 'supabase/functions']) {
    assert.ok(inputs.includes(p), `expo-policy: ${p} must be a declared stamp input — the gate reads it after it stamps`)
  }
  // The pre-1.0.4 entries stay: narrower paths under the new roots are kept, not replaced.
  for (const p of [
    'tools/store-policy.json',
    'apps/mobile/src/features/actions/registry.ts',
    'supabase/functions/delete-account/index.ts',
    'supabase/config.toml',
  ]) {
    assert.ok(inputs.includes(p), `expo-policy: ${p} must stay a declared stamp input`)
  }
})

test('contracts stamp: declared inputs and the manifest invalidate; excluded churn dirs do not', () => {
  const inputs = STAMP_INPUTS.contracts
  // 1.1.0 (#82). The event-catalog generator the gate spawns reads the root package.json
  // (the 1.0.x compatibility entry applies while it lists @app/notes) and imports
  // lib/event-catalogs.mjs, which imports lib/source-text.mjs. The closure test above sees
  // only the gate script's own imports, not a spawned generator's, so these are named here.
  for (const p of ['package.json', 'tools/lib/event-catalogs.mjs', 'tools/lib/source-text.mjs']) {
    assert.ok(inputs.includes(p), `contracts: ${p} must be a declared stamp input — the event-catalog generator reads it`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'epah-stampreg-'))
  const prev = process.cwd()
  process.chdir(dir)
  try {
    // materialize a representative file for each declared input path
    for (const p of inputs) {
      if (/\.[a-z0-9]+$/i.test(p)) {
        mkdirSync(join(dir, p, '..'), { recursive: true })
        writeFileSync(join(dir, p), 'seed\n')
      } else {
        mkdirSync(join(dir, p), { recursive: true })
        writeFileSync(join(dir, p, 'file.txt'), 'seed\n')
      }
    }
    const base = hashInputs(inputs)

    // (i) a declared input file: mutation invalidates, restoration restores.
    writeFileSync(join(dir, 'tsconfig.json'), 'mutated\n')
    assert.notEqual(hashInputs(inputs), base, 'editing a declared input must flip the digest')
    writeFileSync(join(dir, 'tsconfig.json'), 'seed\n')
    assert.equal(hashInputs(inputs), base, 'restoring it must restore the digest')

    // (ii) the manifest IS a member, so an `update` or a graduation — which changes
    // rampNote verdicts over unchanged sources — re-arms the stamp.
    writeFileSync(join(dir, '.harness', 'manifest.json'), '{"baseVersion":"9.9.9"}\n')
    assert.notEqual(hashInputs(inputs), base, 'a manifest edit must flip the digest')
    writeFileSync(join(dir, '.harness', 'manifest.json'), 'seed\n')
    assert.equal(hashInputs(inputs), base)

    // (iii) churn under STAMP_EXCLUDES dirs — the Stop chain's own coverage output,
    // a web/mobile build — must NOT self-invalidate the bare apps/packages roots.
    for (const excluded of ['coverage', '.next', '.expo', '.turbo']) {
      mkdirSync(join(dir, 'apps', 'web', excluded, 'deep'), { recursive: true })
      writeFileSync(join(dir, 'apps', 'web', excluded, 'deep', 'churn.txt'), 'churn\n')
    }
    assert.equal(hashInputs(inputs), base, 'excluded churn dirs must never flip the digest')

    // control: real source churn under the same root still invalidates.
    writeFileSync(join(dir, 'apps', 'web', 'new-file.ts'), 'export {}\n')
    assert.notEqual(hashInputs(inputs), base, 'non-excluded churn under apps/ must still invalidate')
  } finally {
    process.chdir(prev)
  }
})

// ── noteMissingPrerequisite: the record `validate --ci-parity` closes with (1.0.4) ──
// In-process, so the tools/lib coverage floor measures it. Each case sets or clears
// HARNESS_PARITY_REPORT_DIR and restores the previous value afterwards.

/** @param {string | undefined} value @param {() => void} fn */
function withReportDir(value, fn) {
  const prev = process.env.HARNESS_PARITY_REPORT_DIR
  if (value === undefined) delete process.env.HARNESS_PARITY_REPORT_DIR
  else process.env.HARNESS_PARITY_REPORT_DIR = value
  const printed = []
  const origLog = console.log
  const origError = console.error
  console.log = (...a) => printed.push(a.map(String).join(' '))
  console.error = (...a) => printed.push(a.map(String).join(' '))
  try {
    fn()
  } finally {
    console.log = origLog
    console.error = origError
    if (prev === undefined) delete process.env.HARNESS_PARITY_REPORT_DIR
    else process.env.HARNESS_PARITY_REPORT_DIR = prev
  }
  return printed
}

test('noteMissingPrerequisite: records one JSON line in <dir>/<pid>.jsonl, creating the directory', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'epah-parity-note-')), '3')
  const printed = withReportDir(dir, () => noteMissingPrerequisite('fake', 'no database reachable'))
  assert.deepEqual(printed, [], 'it prints nothing')
  assert.deepEqual(readdirSync(dir), [`${process.pid}.jsonl`])
  const text = readFileSync(join(dir, `${process.pid}.jsonl`), 'utf8')
  assert.equal(text, `${JSON.stringify({ gate: 'fake', reason: 'no database reachable' })}\n`)
})

test('noteMissingPrerequisite: does nothing when the variable is unset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-parity-unset-'))
  const prev = process.cwd()
  process.chdir(dir)
  try {
    const printed = withReportDir(undefined, () => noteMissingPrerequisite('fake', 'reason'))
    assert.deepEqual(printed, [])
    assert.deepEqual(readdirSync(dir), [], 'nothing is written anywhere near the cwd')
  } finally {
    process.chdir(prev)
  }
})

test('noteMissingPrerequisite: a directory beneath a regular file does not throw and prints nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'epah-parity-enotdir-'))
  writeFileSync(join(root, 'a-file'), 'regular\n')
  const printed = withReportDir(join(root, 'a-file', 'report'), () =>
    assert.doesNotThrow(() => noteMissingPrerequisite('fake', 'reason')),
  )
  assert.deepEqual(printed, [])
  assert.deepEqual(readdirSync(root), ['a-file'])
})

test('skipOrFail records its gate and reason under the CI predicate, and never on a local skip', () => {
  const reportDir = join(mkdtempSync(join(tmpdir(), 'epah-parity-skip-')), '0')
  const script = `skipOrFail('fake', 'toolchain missing')`
  const local = runInFixture(script, { env: { HARNESS_PARITY_REPORT_DIR: reportDir } })
  assert.equal(local.code, 0, local.out)
  assert.throws(() => readdirSync(reportDir), /ENOENT/, 'a local skip records nothing')

  const ci = runInFixture(script, {
    env: { HARNESS_REQUIRE_TOOLCHAINS: '1', HARNESS_PARITY_REPORT_DIR: reportDir },
  })
  assert.equal(ci.code, 1, ci.out)
  const files = readdirSync(reportDir)
  assert.equal(files.length, 1, files.join(','))
  const lines = readFileSync(join(reportDir, files[0]), 'utf8').split('\n').filter(Boolean)
  assert.deepEqual(
    lines.map((l) => JSON.parse(l)),
    [{ gate: 'fake', reason: 'toolchain missing' }],
  )
})

// ── a parked fork of lib/gate.mjs must not break a re-planted gate (1.0.4) ────────────
// `update` re-plants an unmodified gate script but parks the incoming copy of a forked
// tools/lib/gate.mjs, so a 1.0.4 gate can run over a lib that has no
// noteMissingPrerequisite. A named import of it would then fail the gate at link time,
// before any check runs. Every caller outside lib/gate.mjs therefore reaches it through a
// namespace import and a guarded call, and this loads each one over such a fork.
const NOTE_CALL_RE = /\bnoteMissingPrerequisite\b/
// A line of code that names it; a comment that does (validate.mjs's header) is not a call.
/** @param {string} src */
const namesNote = (src) => src.split('\n').some((l) => !l.trim().startsWith('//') && NOTE_CALL_RE.test(l))

test('every gate that records a missing prerequisite still loads over a lib/gate.mjs without the export', () => {
  const callers = readdirSync(join(BASE_DIR, 'tools'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => `tools/${f}`)
    .filter((f) => namesNote(readFileSync(join(BASE_DIR, f), 'utf8')))
    .sort()
  assert.deepEqual(
    callers,
    ['tools/check-migrations.mjs', 'tools/check-styleguide-manifest.mjs', 'tools/check-version-sync.mjs'],
    'the partial legs that record a missing prerequisite (update this list with the docs)',
  )
  const forked = readFileSync(join(BASE_DIR, 'tools/lib/gate.mjs'), 'utf8').replace(
    'export function noteMissingPrerequisite(',
    'function noteMissingPrerequisite(',
  )
  assert.ok(!/export function noteMissingPrerequisite\(/.test(forked), 'precondition: export removed')
  for (const script of callers) {
    const src = readFileSync(join(BASE_DIR, script), 'utf8')
    for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'\.\/lib\/gate\.mjs'/gm)) {
      assert.ok(!NOTE_CALL_RE.test(m[1]), `${script}: a named import of noteMissingPrerequisite fails over a parked fork`)
    }
    const dir = mkdtempSync(join(tmpdir(), 'epah-gatelib-fork-'))
    for (const file of [script, ...importClosure(script, [BASE_DIR])]) {
      mkdirSync(join(dir, posix.dirname(file)), { recursive: true })
      writeFileSync(join(dir, file), file === 'tools/lib/gate.mjs' ? forked : readFileSync(join(BASE_DIR, file), 'utf8'))
    }
    /** @type {Record<string, string | undefined>} */
    const env = { ...process.env, CI: 'true', HARNESS_REQUIRE_TOOLCHAINS: '', GITHUB_BASE_REF: '' }
    delete env.HARNESS_PARITY_REPORT_DIR
    const res = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env })
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
    assert.doesNotMatch(out, /SyntaxError|does not provide an export named/, `${script} failed to load:\n${out}`)
    rmSync(dir, { recursive: true, force: true })
  }
})
