// Eval B's frozen pre-dogfood fixture (2.1.0, #188): how tests/evals/b/fixture/ is made.
//
// WHAT IT IS. The tree a core-tier `init --with-demo` wrote at the 2.0.0 stack head
// (FIXTURE_COMMIT, #143's head, before any dogfood change), with the push-notifications
// module's slice applied the way its APPLY.md says. It is frozen so that the dogfood PRs
// cannot make eval B vacuous (plan v2 §11, B): they delete the second homes the eval counts.
//
// WHAT IS KEPT. Only what the sweep and the wire checks read: TS sources under apps/ and
// packages/ (tests, declarations and generated files are out of every scan), every
// workspace package.json and tsconfig*.json, supabase/schemas and supabase/migrations, the
// tools/generated manifests, tools/exports-walls.json (the census), tools/reviewer-triggers.json
// and PARITY.md, and .dependency-cruiser.cjs, which home() judges every move by. That last
// one is JavaScript, so it is stored as `.dependency-cruiser.cjs.txt` (lib/evals.mjs).
//
// THE PUSH SLICE. APPLY.md's `cp "$SLICE/…"` and `cat "$SLICE/…" >>` lines, and the whole
// files its "Add `<path>`" steps print (the vertical's package.json and tsconfig.json), read
// from the module as it stood at FIXTURE_COMMIT. Step 4's indented hunks (the router and
// manifest edits) are edits to files the fixture keeps as they were; they add no callable.
//
// It runs once, by hand (`node scripts/eval-b.mjs --freeze`), and needs the commit in the
// local history. CI only checks the result against its manifest.
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { walkFiles } from '../../template/base/tools/lib/fs-walk.mjs'
import { removeTree } from './evals.mjs'

/** The 2.0.0 stack head the fixture is taken from (#143's head). */
export const FIXTURE_COMMIT = 'b158f5a01b345bded0e7d2b41b5bb54000aa43a1'

const SLICE = 'template/modules/push-notifications/docs/modules/push-notifications'

const SETS = [
  '--set', 'PROJECT_NAME=Fixture App',
  '--set', 'GITHUB_OWNER=fixture-owner',
  '--set', 'SECURITY_OWNERS=@fixture-owner/security',
]

/** @param {string} cmd @param {string[]} args @param {string} cwd */
function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${res.stdout ?? ''}${res.stderr ?? ''}`)
  }
  return res.stdout
}

/** Extract `paths` of the repository at `commit` into `dir`. */
function archive(repo, commit, dir, paths) {
  const tar = join(dir, 'src.tar')
  run('git', ['archive', '--format=tar', `--output=${tar}`, commit, ...paths], repo)
  run('tar', ['-xf', 'src.tar'], dir)
}

const TEST = /\.(test|spec)\.tsx?$|(^|\/)(__tests__|e2e)\/|\.d\.ts$/
const SOURCE = /\.(ts|tsx|mts|cts)$/
const MANIFEST = /(^|\/)(package\.json|tsconfig[\w.-]*\.json)$/
const EXCLUDE = new Set(['node_modules', 'dist', 'coverage', '.next', '.expo', '.turbo'])

/**
 * Whether the fixture keeps a path of the rendered tree, and under what name.
 * @param {string} rel @returns {string | null}
 */
export function keptAs(rel) {
  if (rel === '.dependency-cruiser.cjs') return `${rel}.txt`
  if (['package.json', 'tsconfig.json', 'tsconfig.base.json', 'PARITY.md'].includes(rel)) return rel
  if (['tools/exports-walls.json', 'tools/reviewer-triggers.json'].includes(rel)) return rel
  if (/^tools\/generated\/[^/]+\.json$/.test(rel)) return rel
  if (/^supabase\/(schemas|migrations)\/[^/]+\.sql$/.test(rel)) return rel
  if (!/^(apps|packages)\//.test(rel)) return null
  if (MANIFEST.test(rel)) return rel
  return SOURCE.test(rel) && !TEST.test(rel) && !/(^|\/)generated\//.test(rel) ? rel : null
}

/**
 * APPLY.md's steps: every `cp`/`cat >>` line of a `sh` block (continuations joined), and
 * every whole JSON file the first fenced block after an "Add `<path>.json`" paragraph prints.
 * @param {string} md
 */
export function applySteps(md) {
  /** @type {{ op: string, dst: string, src?: string, text?: string }[]} */
  const steps = []
  const lines = md.split(/\r?\n/)
  let prose = ''
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^```(\w*)\s*$/.exec(lines[i])
    if (open === null) {
      if (/^Add `/.test(lines[i])) prose = lines[i]
      continue
    }
    const body = []
    for (i += 1; i < lines.length && lines[i].trim() !== '```'; i += 1) body.push(lines[i])
    if (open[1] === 'sh') steps.push(...shellSteps(body.join('\n').replace(/\\\n\s*/g, ' ')))
    const target = /^Add `([^`]+\.json)`/.exec(prose)?.[1]
    if (open[1] === 'json' && target !== undefined) steps.push({ op: 'write', dst: target, text: `${body.join('\n')}\n` })
    prose = ''
  }
  return steps
}

/** @param {string} text */
function shellSteps(text) {
  /** @type {{ op: string, dst: string, src: string }[]} */
  const out = []
  for (const line of text.split('\n')) {
    const cp = /^cp "\$SLICE\/([^"]+)"\s+(\S+)\s*$/.exec(line.trim())
    if (cp !== null) out.push({ op: 'copy', src: cp[1], dst: cp[2].endsWith('/') ? `${cp[2]}${basename(cp[1])}` : cp[2] })
    const cat = /^cat "\$SLICE\/([^"]+)"\s+>>\s+(\S+)\s*$/.exec(line.trim())
    if (cat !== null) out.push({ op: 'append', src: cat[1], dst: cat[2] })
  }
  return out
}

/** Apply the push slice to the rendered tree `out`, from the module at `src`. */
function applySlice(src, out) {
  const root = join(src, SLICE)
  for (const step of applySteps(readFileSync(join(root, 'APPLY.md'), 'utf8'))) {
    const dst = join(out, ...step.dst.split('/'))
    mkdirSync(dirname(dst), { recursive: true })
    if (step.op === 'write') writeFileSync(dst, step.text)
    else if (step.op === 'copy') copyFileSync(join(root, 'slice', ...step.src.split('/')), dst)
    else appendFileSync(dst, readFileSync(join(root, 'slice', ...step.src.split('/'))))
  }
}

/**
 * Write the fixture into `dest` (which must not exist yet) from the repository at `repo`.
 * @param {string} repo @param {string} dest
 */
export function freezeFixture(repo, dest) {
  if (existsSync(dest)) throw new Error(`${dest} exists: remove it first, then freeze again`)
  const work = mkdtempSync(join(tmpdir(), 'epah-eval-b-'))
  try {
    const src = join(work, 'src')
    const out = join(work, 'out')
    mkdirSync(src)
    archive(repo, FIXTURE_COMMIT, src, ['installer', 'template', 'package.json'])
    run(process.execPath, [join(src, 'installer/cli.mjs'), 'init', '--dir', out, '--tier', 'core', '--with-demo', '--yes', ...SETS], src)
    applySlice(src, out)
    for (const rel of walkFiles(out, { excludeDirs: EXCLUDE })) {
      const as = keptAs(rel)
      if (as === null) continue
      const to = join(dest, ...as.split('/'))
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(join(out, ...rel.split('/')), to)
    }
  } finally {
    removeTree(work)
  }
}
