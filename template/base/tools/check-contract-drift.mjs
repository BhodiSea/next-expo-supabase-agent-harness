#!/usr/bin/env node
// Gate: contracts — the committed API contract and the project graph cannot drift.
//   1. openapi.json regen-diff: re-emit the OpenAPI document from the live route
//      definitions (apps/server/scripts/emit-openapi.ts, stable-stringified) and diff
//      against the committed apps/server/openapi.json. Requires an install (tsx);
//      skips loudly without one, fails closed in CI.
//   2. tsconfig project-references sync: the solution tsconfig and each package's
//      references must mirror the pnpm workspace dependency graph — three parallel
//      topologies (workspace deps, project refs, knip map) desynchronize into
//      confusing type errors otherwise. Pure static check, no install needed.
//   3. bounded wire strings (G18): every `z.string()` in the shared wire contract —
//      @app/contracts (the pure-Zod DTO package the mobile app imports) plus
//      @app/schema (the drizzle surface, should a DTO ever land there) — must be
//      length-bounded with `.max(N)`. An unbounded wire string is a
//      memory-amplification vector — the server accepts a 50 MB "title" the client
//      never meant to send. The app.errors spec-walk already proves the ENVELOPE on
//      every OpenAPI route; this closes the other half (a new field's `z.string()`
//      passed every gate). Reviewed exceptions live in tools/dto-bounds-allow.json.
// SOURCE: docs/harness/README.md (contracts gate) [corpus: harness/doctrine]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, runCmd, skipOrFail, stampGate } from './lib/gate.mjs'
import { parseJsonc } from './lib/jsonc.mjs'
import { blankComments, lineOf, skipBalanced } from './lib/source-text.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'contracts'
// Content-addressed local skip (declared inputs: lib/stamp-inputs.mjs — the
// server sources, committed contract, and workspace topology). CI always re-runs.
const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])
const errs = []

// tsconfig reference paths are POSIX; join()/relative() yield backslashes on
// Windows — normalize every compared path or the sync check false-fails there.
const posix = (p) => p.split(sep).join('/')

// ---- 2. tsconfig references sync (run first: static, always possible) ----
const pkgDirs = []
for (const scope of ['apps', 'packages']) {
  if (!existsSync(scope)) continue
  for (const d of readdirSync(scope)) {
    if (existsSync(join(scope, d, 'package.json'))) pkgDirs.push(join(scope, d))
  }
}
const byName = new Map()
for (const dir of pkgDirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  byName.set(pkg.name, dir)
}
for (const dir of pkgDirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const wanted = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter((d) => byName.has(d))
    .map((d) => byName.get(d))
  const tsconfigPath = join(dir, 'tsconfig.json')
  if (!existsSync(tsconfigPath)) {
    errs.push(`${dir}: missing tsconfig.json (every workspace package is a TS project)`)
    continue
  }
  const tsconfig = parseJsonc(readFileSync(tsconfigPath, 'utf8'))
  const refs = new Set(
    (tsconfig.references ?? []).map((r) => posix(relative(dir, join(dir, r.path)))),
  )
  for (const dep of wanted) {
    const expected = posix(relative(dir, dep))
    if (!refs.has(expected)) {
      errs.push(
        `${dir}/tsconfig.json: missing project reference to ${dep} (workspace dep ${relative('.', dep)}) — tsc -b cannot order the build without it`,
      )
    }
  }
}
if (existsSync('tsconfig.json')) {
  const solution = parseJsonc(readFileSync('tsconfig.json', 'utf8'))
  const refs = new Set((solution.references ?? []).map((r) => r.path.replace(/^\.\//, '')))
  for (const dir of pkgDirs) {
    if (!refs.has(posix(dir))) errs.push(`tsconfig.json (solution): missing reference to ${dir}`)
  }
}

// ---- 1. openapi regen-diff ----
const EMIT = 'apps/server/scripts/emit-openapi.ts'
const COMMITTED = 'apps/server/openapi.json'
if (existsSync(EMIT)) {
  if (!existsSync('node_modules')) {
    if (errs.length) failures(GATE, errs)
    skipOrFail(GATE, 'node_modules missing — openapi regen-diff needs an install')
  }
  try {
    // --silent: under CI=true pnpm prints its auto-install/verify banner to
    // STDOUT, which would pollute the captured JSON and false-fail the diff.
    const regenerated = runCmd(`pnpm --silent exec tsx ${EMIT} --stdout`)
    const committed = existsSync(COMMITTED) ? readFileSync(COMMITTED, 'utf8') : ''
    if (regenerated.trim() !== committed.trim()) {
      errs.push(
        `${COMMITTED} is stale — routes changed without regenerating the contract. Run: pnpm openapi:emit (then review the diff; consumers depend on it)`,
      )
    }
  } catch (e) {
    errs.push(`openapi emit failed: ${(e.stderr?.toString() ?? e.message).slice(0, 400)}`)
  }
}

// ---- 3. bounded wire strings (G18): every z.string() carries .max() ----
// The wire DTOs live in @app/contracts (mobile-importable pure Zod); @app/schema is
// scanned too so a DTO drifting into the drizzle package cannot dodge the bound.
// Internal packages (eval fixtures, importer) are NOT wire surface and stay out.
const WIRE_SRC = ['packages/contracts/src', 'packages/schema/src']
const DTO_ALLOW = 'tools/dto-bounds-allow.json'
let boundedChecked = 0
const wireRoots = WIRE_SRC.filter((p) => existsSync(p))
if (wireRoots.length > 0) {
  // Reviewed escape hatch: a genuinely-unbounded string the contract accepts on
  // purpose. Same fail-closed-parse discipline as every other exemption list.
  const allow = new Set()
  if (existsSync(DTO_ALLOW)) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(DTO_ALLOW, 'utf8'))
    } catch (e) {
      fail(
        GATE,
        `${DTO_ALLOW} is not valid JSON (${e.message}) — the exemption list must be reviewable data`,
      )
    }
    if (!Array.isArray(parsed.allow)) {
      fail(
        GATE,
        `${DTO_ALLOW} must carry an "allow" ARRAY of {"site": "file:line", "reason": string} entries`,
      )
    }
    for (const entry of parsed.allow) {
      const okShape =
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.site === 'string' &&
        typeof entry.reason === 'string' &&
        entry.reason.trim() !== ''
      if (!okShape) {
        fail(
          GATE,
          `${DTO_ALLOW}: every entry must be {"site": "file:line", "reason": non-empty string} — got ${JSON.stringify(entry)}`,
        )
      }
      allow.add(entry.site)
    }
  }

  // From the end of a `z.string(...)` call, walk the fluent method chain
  // (`.name(...)` / `.name`) and report whether `.max(` appears in it. Whitespace and
  // newlines between a value and its `.method` are the chain continuing.
  const chainHasMax = (text, afterCall) => {
    let i = afterCall
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i += 1
      if (text[i] !== '.') return false
      const m = /^\.([A-Za-z_$][\w$]*)/.exec(text.slice(i))
      if (m === null) return false
      const name = m[1]
      i += m[0].length
      while (i < text.length && /\s/.test(text[i])) i += 1
      if (text[i] === '(') i = skipBalanced(text, i)
      if (name === 'max') return true
    }
  }

  // blankComments (tools/lib/source-text.mjs) replaces comment text with SPACES rather
  // than removing it, so byte offsets — and therefore reported line numbers — stay
  // identical to the source file. Blanking a commented-out `z.string()` also stops it
  // matching (no phantom sites), and blanking a documentation `.max(...)` inside a comment
  // stops it falsely satisfying a real, uncommented site — the strip can only make this
  // check STRICTER, never fail open.
  const STRING_CALL = /\bz\s*\.\s*(?:coerce\s*\.\s*)?string\s*\(/g
  for (const root of wireRoots) {
    for (const file of walkFiles(root, {
      filter: (p) => /\.ts$/.test(p) && !/\.(test|spec)\.ts$/.test(p),
    })) {
      const rel = `${root}/${file}`
      const text = blankComments(readFileSync(rel, 'utf8'))
      for (const m of text.matchAll(STRING_CALL)) {
        boundedChecked += 1
        const afterCall = skipBalanced(text, text.indexOf('(', m.index))
        if (chainHasMax(text, afterCall)) continue
        const line = lineOf(text, m.index)
        if (allow.has(`${rel}:${line}`)) continue
        errs.push(
          `${rel}:${line}: unbounded z.string() — every wire string DTO must carry .max(N) (an unbounded string lets a client send an arbitrarily large payload the server buffers and stores). Add a .max(...) bound, or a reviewed {"site": "${rel}:${line}", "reason": …} entry in ${DTO_ALLOW}`,
        )
      }
    }
  }
}

failures(GATE, errs)
recordGreen()
ok(
  GATE,
  `openapi.json in sync; tsconfig references mirror the workspace graph; ${boundedChecked} wire string(s) length-bounded`,
)
