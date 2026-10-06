// Every module that ships a feature slice, applied the way its APPLY.md says (#156).
//
// A module slice is reference code stored as `.ts.txt` under docs/, so nothing compiles,
// lints or gate-checks it, in this repo or in an install that enabled the module and has
// not applied it yet. The laws its APPLIED copy is judged by kept moving, and the slice
// drifted from them unseen: applied to a 2.0.x scaffold, @app/push redded five
// vertical-anatomy findings, and the module round trip in lifecycle.test.mjs only ever
// checked that the files land and stay inert.
//
// So this test is the consumer. It scaffolds with `--tier core`, and again with the worked
// example (`--with-demo`), enables the module, and follows the INSTALLED APPLY.md: its
// `cp "$SLICE/…"` and `cat "$SLICE/…" >>` lines, the files its "Add `<file>.json`" steps
// print, and only the allow rows it prints, filled in the way a human fills them (today's
// date, the fingerprint the duplication gate reports). Then the two gates that judge a
// vertical's source must pass: boundaries (tools/check-workspace-deps.mjs, which carries
// the vertical-anatomy laws) and duplication (tools/check-duplication.mjs). Both import
// only Node built-ins, so the scaffold needs no `pnpm install`.
//
// Nothing about a module is restated here. The copy list, the manifests and the allow rows
// are read from APPLY.md, so a step APPLY.md gets wrong is a step this test gets wrong, and
// a slice file no step copies is a failure of its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkFiles } from '../../template/base/tools/lib/fs-walk.mjs'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))
const MODULES_ROOT = fileURLToPath(new URL('../../template/modules/', import.meta.url))

const SETS = [
  '--set', 'PROJECT_NAME=Fixture App',
  '--set', 'GITHUB_OWNER=fixture-owner',
  '--set', 'SECURITY_OWNERS=@fixture-owner/security',
]

const made = []
test.after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})

/** @param {string} cwd @param {string} cmd @param {string[]} args */
function run(cwd, cmd, args) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// The modules whose tree carries docs/modules/<name>/slice/ — derived, never listed.
const SLICE_MODULES = existsSync(MODULES_ROOT)
  ? [...new Set(walkFiles(MODULES_ROOT).map((rel) => rel.split('/')[0]))]
      .filter((name) => existsSync(join(MODULES_ROOT, name, 'docs/modules', name, 'slice')))
      .sort()
  : []

const VARIANTS = [
  { label: 'core', flags: [] },
  { label: 'core --with-demo', flags: ['--with-demo'] },
]

/**
 * Every fenced block in a markdown file, with the paragraph of prose just before it.
 * `indented` marks a block nested in a list item: those are hunks of an edit to an
 * existing file (step 4's router and manifest lines), never a whole file to write.
 * @param {string} md
 * @returns {{ lang: string, body: string, prose: string, indented: boolean }[]}
 */
function fencedBlocks(md) {
  const blocks = []
  let prose = []
  let gap = false
  const lines = md.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(\s*)```(\w*)\s*$/.exec(lines[i])
    if (open === null) {
      if (lines[i].trim() === '') gap = true
      else {
        if (gap) prose = []
        gap = false
        prose.push(lines[i].trim())
      }
      continue
    }
    const body = []
    for (i += 1; i < lines.length && lines[i].trim() !== '```'; i += 1) body.push(lines[i])
    blocks.push({ lang: open[2], body: body.join('\n'), prose: prose.join(' '), indented: open[1] !== '' })
    prose = []
    gap = false
  }
  return blocks
}

/**
 * What APPLY.md tells a consumer to do with the slice: the `SLICE=` it names, every
 * `cp "$SLICE/<src>" <dst>` and `cat "$SLICE/<src>" >> <dst>` (continuation lines joined),
 * every whole file an "Add `<file>.json`" step prints, and every row an "Add … to
 * `tools/<name>-allow.json`" step prints.
 * @param {string} md
 */
function readApply(md) {
  const plan = { slice: null, copies: [], files: [], rows: [] }
  for (const block of fencedBlocks(md)) {
    if (block.lang === 'sh') readShell(block.body, plan)
    if (block.lang !== 'json' || block.indented || !/^Add\b/.test(block.prose)) continue
    const target = /`([^`]+)`/.exec(block.prose)?.[1]
    if (target === undefined || !target.endsWith('.json')) continue
    if (/^tools\/[\w.-]+-allow\.json$/.test(target)) {
      plan.rows.push({ file: target, row: JSON.parse(block.body) })
    } else {
      JSON.parse(block.body) // a manifest the consumer cannot parse is a broken step
      plan.files.push({ path: target, text: `${block.body}\n` })
    }
  }
  return plan
}

/** @param {string} body @param {{ slice: string | null, copies: any[] }} plan */
function readShell(body, plan) {
  for (const line of body.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)) {
    const slice = /^SLICE=(\S+)\s*$/.exec(line)
    if (slice) plan.slice = slice[1]
    const cp = /^cp\s+"\$SLICE\/([^"]+)"\s+(\S+)\s*$/.exec(line)
    if (cp) plan.copies.push({ src: cp[1], dst: cp[2], append: false })
    const cat = /^cat\s+"\$SLICE\/([^"]+)"\s+>>\s+(\S+)\s*$/.exec(line)
    if (cat) plan.copies.push({ src: cat[1], dst: cat[2], append: true })
  }
}

/** POSIX install path -> absolute path in the scaffold. */
const at = (dir, posix) => join(dir, ...posix.split('/'))

/**
 * Carry out the copies, asserting APPLY.md and the slice tree agree both ways: every
 * line names a slice file that exists, and every slice file is named by some line.
 */
function applyCopies(dir, plan, sliceDir) {
  const named = new Set()
  for (const { src, dst, append } of plan.copies) {
    const from = at(dir, `${plan.slice}/${src}`)
    assert.ok(existsSync(from), `APPLY.md copies $SLICE/${src}, which the slice does not ship`)
    named.add(src)
    const to = at(dir, dst.endsWith('/') ? `${dst}${src.split('/').at(-1)}` : dst)
    mkdirSync(dirname(to), { recursive: true })
    if (append) appendFileSync(to, readFileSync(from))
    else copyFileSync(from, to)
  }
  const unnamed = walkFiles(sliceDir).filter((rel) => !named.has(rel))
  assert.deepEqual(unnamed, [], 'slice files no APPLY.md step copies')
  for (const { path, text } of plan.files) {
    mkdirSync(dirname(at(dir, path)), { recursive: true })
    writeFileSync(at(dir, path), text)
  }
}

const DUP_ALLOW = 'tools/duplication-allow.json'

/**
 * The clones check-duplication.mjs reports, each matched to the ONE printed
 * duplication-allow row whose reason names one of its two files. A clone no row names
 * is left alone: the final duplication run reds on it, in the gate's own words.
 * @returns {Map<any, string>} row -> the fingerprint a human copies into it
 */
function claimClones(dir, rows) {
  const claims = new Map()
  const dup = run(dir, process.execPath, ['tools/check-duplication.mjs'])
  const clones = dup.out.matchAll(/fingerprint ([0-9a-f]{12})\) — (\S+?):\d+-\d+ duplicates (\S+?):\d+-\d+/g)
  for (const [, fingerprint, ...sides] of clones) {
    // The gate joins its scan roots with the platform separator.
    const [a, b] = sides.map((p) => p.split('\\').join('/'))
    const owners = rows.filter((r) => r.reason?.includes(a) || r.reason?.includes(b))
    if (owners.length === 0) continue
    assert.equal(owners.length, 1, `clone ${fingerprint} (${a} vs ${b}) is named by more than one printed allow row:\n${dup.out}`)
    assert.ok(!claims.has(owners[0]), `one printed allow row claims two clones:\n${dup.out}`)
    claims.set(owners[0], fingerprint)
  }
  return claims
}

/**
 * Fill the placeholders a human fills: `reviewedOn` with today's date and `fingerprint`
 * with the one the gate printed. Any other `<…>` value is a step nobody can follow.
 */
function filled(row, fingerprint) {
  const out = { ...row }
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== 'string' || !/^<.*>$/.test(value)) continue
    if (key === 'reviewedOn') out[key] = new Date().toISOString().slice(0, 10)
    else if (key === 'fingerprint' && fingerprint !== undefined) out[key] = fingerprint
    else assert.fail(`APPLY.md prints an allow row with an unfillable placeholder ${key}: ${value}`)
  }
  return out
}

/** Append rows to the scaffold's allow file, as the human steps do. */
function appendRows(dir, file, rows) {
  const doc = JSON.parse(readFileSync(at(dir, file), 'utf8'))
  doc.allow.push(...rows)
  writeFileSync(at(dir, file), `${JSON.stringify(doc, null, 2)}\n`)
}

/**
 * Write every printed row the steps call for, and run the two gates. The duplication
 * rows go in only for a clone the gate reports (APPLY.md says to skip the entry when
 * there is none), with its fingerprint filled in; every other row goes in as printed.
 */
function judge(dir, plan) {
  for (const { file, row } of plan.rows) {
    if (file !== DUP_ALLOW) appendRows(dir, file, [filled(row)])
  }
  const boundaries = run(dir, process.execPath, ['tools/check-workspace-deps.mjs'])
  const claims = claimClones(dir, plan.rows.filter((r) => r.file === DUP_ALLOW).map((r) => r.row))
  appendRows(dir, DUP_ALLOW, [...claims].map(([row, fingerprint]) => filled(row, fingerprint)))
  const duplication = run(dir, process.execPath, ['tools/check-duplication.mjs'])
  return { boundaries, duplication }
}

test('at least one module ships a feature slice (anti-vacuity)', () => {
  assert.ok(SLICE_MODULES.length > 0, 'no template/modules/*/docs/modules/*/slice tree found')
})

for (const name of SLICE_MODULES) {
  for (const variant of VARIANTS) {
    test(`the ${name} slice, applied per its APPLY.md to a ${variant.label} scaffold, passes boundaries and duplication`, () => {
      const dir = mkdtempSync(join(tmpdir(), `epah-slice-${name}-`))
      made.push(dir)
      const init = run(dir, process.execPath, [CLI, 'init', '--dir', dir, '--tier', 'core', '--yes', ...variant.flags, ...SETS])
      assert.equal(init.code, 0, init.out)
      const enable = run(dir, process.execPath, [CLI, 'enable', name, '--dir', dir])
      assert.equal(enable.code, 0, enable.out)

      const plan = readApply(readFileSync(at(dir, `docs/modules/${name}/APPLY.md`), 'utf8'))
      assert.equal(plan.slice, `docs/modules/${name}/slice`, 'APPLY.md must name its slice as SLICE=')
      assert.ok(plan.copies.length > 0, 'APPLY.md names no cp line')
      applyCopies(dir, plan, at(dir, plan.slice))

      const { boundaries, duplication } = judge(dir, plan)
      assert.ok(
        boundaries.code === 0 && duplication.code === 0,
        `boundaries, which carries the vertical-anatomy laws (exit ${boundaries.code}):\n${boundaries.out}\n` +
          `duplication (exit ${duplication.code}):\n${duplication.out}`,
      )
    })
  }
}
