#!/usr/bin/env node
// Gate: diff-coverage (Stop chain, right after the two unit steps) — every CHANGED
// source file must clear the PER-FILE coverage floors its runner declares.
// The aggregate thresholds (enforced by the unit steps themselves) cannot see one
// untested module hiding inside a green 70% total; this gate can, and it reads the
// artifacts the unit steps just wrote so no second test run is paid. TWO maps,
// because the unit floor has two halves (the runner split is documented in
// vitest.config.ts):
//   - coverage/coverage-final.json             — vitest (server, packages, pure
//                                                mobile logic), v8 provider
//   - apps/mobile/coverage/coverage-final.json — jest-expo (RN components/screens)
// Changed files under apps/mobile/** are held to the floors in
// apps/mobile/jest.config.js; every other source file to the floors in
// vitest.config.ts. A file BOTH runners measure (the pure mobile modules) merges
// its coverage before flooring — being measured twice can only ever help a file.
//   changed = in CI with a PR base (CI=true + GITHUB_BASE_REF): merge-base diff
//             against the base branch — the whole PR is the diff;
//             otherwise (agent-time local runs): worktree vs HEAD + staged +
//             untracked source files — an agent's brand-new uncommitted feature
//             file is exactly the case that must not slip.
// The floors and the measured-surface lists are PARSED fail-closed out of the two
// runner configs, never duplicated here: those configs are write-guard-protected
// and already the coverage authorities, and a regex extract of their named const/
// key blocks is the zero-dep option (importing a .ts config from an .mjs gate
// would drag a TS loader into the gate path).
// Empty diff → OK (inherently ramp-safe: a clean upgraded consumer stays green
// without a version ramp). A changed tree whose runner's map file is MISSING →
// FAIL CLOSED naming that runner's command (the Stop chain writes both maps
// immediately before this gate; absence means the chain was reordered or the
// artifact deleted — never pass).
// SOURCE: docs/harness/README.md (coverage floors; tamper evidence) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { toPosix } from './lib/fs-walk.mjs'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'
import { changedFiles, firstLine } from './lib/git-diff.mjs'

const GATE = 'diff-coverage'
const VITEST_CONFIG = 'vitest.config.ts'
const JEST_CONFIG = 'apps/mobile/jest.config.js'
const RUNNERS = {
  vitest: {
    map: 'coverage/coverage-final.json',
    cmd: 'pnpm exec vitest run --coverage --silent',
    floorsIn: VITEST_CONFIG,
  },
  jest: {
    map: 'apps/mobile/coverage/coverage-final.json',
    cmd: 'pnpm --filter mobile exec jest --coverage --silent',
    floorsIn: JEST_CONFIG,
  },
}
const METRICS = ['statements', 'branches', 'functions', 'lines']

// ---- fail-closed parses of the runner-config data blocks -----------------------

export function parsePerFileFloors(configText) {
  const block = configText.match(/PER_FILE_FLOORS\s*=\s*\{([^}]*)\}/)
  if (!block) return null
  const floors = {}
  for (const key of METRICS) {
    const m = block[1].match(new RegExp(`\\b${key}\\s*:\\s*(\\d+(?:\\.\\d+)?)`))
    if (!m) return null
    floors[key] = Number(m[1])
  }
  return floors
}

// Comments are NOT data. The array parsers below scan for quoted literals, and a
// comment inside the array is prose that may legitimately contain an apostrophe
// ("apps/web's") or a `]` — either of which, left in place, silently truncates or
// re-pairs the literal scan and drops every exclusion after it (found 2026-08-17:
// the template's own comment did exactly that, so half of COVERAGE_EXCLUDE never
// applied). String-aware, so `//` inside a quoted URL is preserved.
const QUOTES = new Set(["'", '"', '`'])

// Index just past the closing quote (or end of text); backslash escapes skip a char.
function stringEnd(text, start, quote) {
  let i = start + 1
  while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1
  return Math.min(i + 1, text.length)
}

// Index just past the comment opening at `i`, or -1 when no comment opens there.
function commentEnd(text, i) {
  if (text.startsWith('//', i)) {
    const nl = text.indexOf('\n', i)
    return nl === -1 ? text.length : nl
  }
  if (text.startsWith('/*', i)) {
    const close = text.indexOf('*/', i + 2)
    return close === -1 ? text.length : close + 2
  }
  return -1
}

export function stripComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (QUOTES.has(text[i])) {
      const end = stringEnd(text, i, text[i])
      out += text.slice(i, end)
      i = end
      continue
    }
    const skipTo = commentEnd(text, i)
    if (skipTo !== -1) {
      i = skipTo
      continue
    }
    out += text[i]
    i += 1
  }
  return out
}

function parseStringArray(configText, headRe) {
  const block = stripComments(configText).match(headRe)
  if (!block) return null
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

export function parseCoverageExcludes(configText) {
  return parseStringArray(configText, /COVERAGE_EXCLUDE\s*=\s*\[([^\]]*)\]/)
}

// jest's measured surface IS its collectCoverageFrom array (positives define the
// tree, '!'-negations carve it) — parsed, not re-declared, so the two cannot drift.
export function parseCollectCoverageFrom(configText) {
  return parseStringArray(configText, /collectCoverageFrom\s*:\s*\[([^\]]*)\]/)
}

// ---- pure classifier ------------------------------------------------------------
// Mirrors the two coverage surfaces: apps/mobile/** belongs to jest-expo (its
// collectCoverageFrom decides which files), everything else in apps/*/src/** +
// packages/*/src/** to vitest (the workspace shape is BUILD-SPEC-fixed), code
// files only, minus test files, .d.ts, and each config's own exclusions — a
// changed file its runner does not measure must never be demanded coverage for.
// The NON-MOBILE measured surface (apps/mobile is intercepted by MOBILE_RE above and
// routed to jest). Every alternative below names a shape that vitest.config.ts's
// `coverage.include` actually measures — keep the two in lockstep; the drift test in
// tests/gates/check-diff-coverage.test.mjs asserts it.
//
// 0.4.0 CORRECTED THIS REGEX TWICE OVER, and both halves were the same bug: the pattern
// described a tree shape rather than the measured surface, so it silently exempted whatever
// the tree did not happen to look like.
//   (a) `packages/[^/]+/src/` matches ONE segment after `packages`, so the LAYERED groups —
//       `packages/platform/*/src` and `packages/verticals/*/src` — never matched. The
//       kernel, the Supabase seam, the rate limiter and every vertical were outside the
//       per-file floor while `coverage.include` measured them and AGENTS.md claimed the
//       floor held "every CHANGED source file under apps/*/src or packages/*/src". The root
//       vitest config's own comment warns about exactly this ("BOTH glob depths are
//       required … a single-depth glob would silently measure half the workspace") — for
//       the coverage array. The gate that consumes it repeated the mistake.
//   (b) apps/web has no `src/`; its code is `app/` and `lib/`. `lib/` is now measured (see
//       the web-unit project) and is held here. `app/` is NOT — Server Components, Server
//       Actions and route handlers are the browser lane's proof and remain a declared tier
//       in docs/harness/enforcement-tiers.md, so they must not match: a file this gate
//       demands coverage for but no runner measures reports 0% with no green path.
const SRC_RE = /^(?:apps\/web\/lib|apps\/[^/]+\/src|packages\/[^/]+(?:\/[^/]+)?\/src)\//
const MOBILE_RE = /^apps\/mobile\//
const CODE_RE = /\.[cm]?[jt]sx?$/
const NON_UNIT_RE = /[.-](?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Conservative mirror of the glob shapes the two configs actually use (exact
// relative paths, '**/*.d.ts'-style suffixes, and jest's '{ts,tsx}' braces):
// '**' spans path segments, '*' stays within one, braces expand first.
export function expandBraces(glob) {
  const m = glob.match(/^([^{]*)\{([^}]*)\}(.*)$/)
  if (!m) return [glob]
  return m[2].split(',').flatMap((alt) => expandBraces(`${m[1]}${alt}${m[3]}`))
}
const globToRe = (glob) =>
  new RegExp(
    `^${glob
      .split('**')
      .map((part) => part.split('*').map(escapeRe).join('[^/]*'))
      .join('.*')}$`,
  )

// collectCoverageFrom globs are relative to apps/mobile (jest's rootDir); root
// them so they compare against repo-relative paths like everything else here.
function buildJestSurface(coverageFrom) {
  const includeRes = []
  const excludeRes = []
  for (const glob of coverageFrom) {
    const negated = glob.startsWith('!')
    const bare = (negated ? glob.slice(1) : glob).replace(/^\.\//, '')
    for (const expanded of expandBraces(`apps/mobile/${bare}`)) {
      ;(negated ? excludeRes : includeRes).push(globToRe(expanded))
    }
  }
  return { includeRes, excludeRes }
}

// Which runner's floors a changed file is held to; null = no runner measures it.
// jestSurface null (config absent) falls back to the seeded tree shape — the CLI
// fails closed before that matters, so the fallback can only ever be stricter.
function classifyChanged(file, vitestExcludeRes, jestSurface) {
  if (!CODE_RE.test(file) || NON_UNIT_RE.test(file)) return null
  if (MOBILE_RE.test(file)) {
    if (jestSurface === null) return /^apps\/mobile\/(?:src|app)\//.test(file) ? 'jest' : null
    const inSurface =
      jestSurface.includeRes.some((re) => re.test(file)) &&
      !jestSurface.excludeRes.some((re) => re.test(file))
    return inSurface ? 'jest' : null
  }
  if (!SRC_RE.test(file)) return null
  if (vitestExcludeRes.some((re) => re.test(file))) return null
  return 'vitest'
}

// v8/istanbul coverage keys are ABSOLUTE paths (backslashed on Windows); every
// comparison here is POSIX-relative to the project root. Windows drive letters
// can differ in case between the map and cwd, hence the lowercase retry.
function relativeToRoot(key, root) {
  const k = toPosix(key)
  const r = toPosix(root).replace(/\/+$/, '')
  if (r === '') return k
  if (k.startsWith(`${r}/`)) return k.slice(r.length + 1)
  if (k.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return k.slice(r.length + 1)
  return k
}

function indexMap(coverageJson, root) {
  if (coverageJson === null || coverageJson === undefined) return null
  const byRel = new Map()
  for (const [key, entry] of Object.entries(coverageJson)) {
    byRel.set(relativeToRoot(key, root), entry)
  }
  return byRel
}

// Per-file percentages, derived exactly the way istanbul summarizes a
// FileCoverage (lines = max statement hit per line; pct floored to 2 decimals),
// so an at-floor file agrees with the report the agent just read.
const pct = (covered, total) => (total === 0 ? 100 : Math.floor((covered / total) * 10000) / 100)

function lineHits(fc) {
  const lineHit = new Map()
  for (const [id, loc] of Object.entries(fc.statementMap ?? {})) {
    const line = loc?.start?.line
    if (line === undefined) continue
    lineHit.set(line, lineHit.get(line) === true || (fc.s?.[id] ?? 0) > 0)
  }
  return lineHit
}

function fileMetrics(fc) {
  const stmts = Object.values(fc.s ?? {})
  const fns = Object.values(fc.f ?? {})
  let bTot = 0
  let bCov = 0
  for (const arr of Object.values(fc.b ?? {})) {
    bTot += arr.length
    bCov += arr.filter((n) => n > 0).length
  }
  const lineHit = lineHits(fc)
  return {
    statements: pct(stmts.filter((n) => n > 0).length, stmts.length),
    branches: pct(bCov, bTot),
    functions: pct(fns.filter((n) => n > 0).length, fns.length),
    lines: pct([...lineHit.values()].filter(Boolean).length, lineHit.size),
  }
}

// A file both runners measure merges before flooring. The two instrumenters
// (v8-to-istanbul, babel-plugin-istanbul) emit DIFFERENT statement/branch maps
// for the same source, so a structural union is not computable without their
// libraries; what IS honestly computable zero-dep:
//   - lines: a true per-line union — both maps key hits on original-source line
//     numbers, so "some runner executed this line" is well-defined;
//   - statements/branches/functions: the per-map MAX — each map is a complete
//     measurement under its own structure, and the best one is a lower bound on
//     the union. Conservative: merging can only ever RAISE a file's numbers.
function mergedMetrics(entries) {
  const per = entries.map(fileMetrics)
  if (per.length === 1) return per[0]
  const union = new Map()
  for (const fc of entries) {
    for (const [line, hit] of lineHits(fc)) union.set(line, union.get(line) === true || hit)
  }
  const unionLines = pct([...union.values()].filter(Boolean).length, union.size)
  return {
    statements: Math.max(...per.map((m) => m.statements)),
    branches: Math.max(...per.map((m) => m.branches)),
    functions: Math.max(...per.map((m) => m.functions)),
    lines: Math.max(unionLines, ...per.map((m) => m.lines)),
  }
}

// The pure core (unit-tested without git): which changed files are held to which
// floors, every violation — absent from every map (no test imports it) or below
// a per-file floor — and which required map artifacts were missing entirely.
export function evaluateDiffCoverage({
  changedFiles: changed,
  maps,
  floors,
  vitestExcludes = [],
  jestCoverageFrom = null,
  root = '',
}) {
  const vitestExcludeRes = vitestExcludes.map(globToRe)
  const jestSurface = jestCoverageFrom === null ? null : buildJestSurface(jestCoverageFrom)
  const byRel = { vitest: indexMap(maps.vitest, root), jest: indexMap(maps.jest, root) }
  const checked = []
  const findings = []
  const missing = new Set()
  for (const raw of changed) {
    const file = toPosix(raw)
    const runner = classifyChanged(file, vitestExcludeRes, jestSurface)
    if (runner === null) continue
    checked.push(file)
    if (byRel[runner] === null) {
      missing.add(runner)
      continue
    }
    const entries = [byRel.vitest?.get(file), byRel.jest?.get(file)].filter((e) => e !== undefined)
    if (entries.length === 0) {
      findings.push({ file, kind: 'uncovered', runner })
      continue
    }
    const metrics = mergedMetrics(entries)
    for (const metric of METRICS) {
      if (metrics[metric] < floors[runner][metric]) {
        findings.push({
          file,
          kind: 'below-floor',
          runner,
          metric,
          actual: metrics[metric],
          floor: floors[runner][metric],
        })
      }
    }
  }
  return { findings, checked, missing }
}

// ---- CLI wrapper (git plumbing) — only when executed directly ------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!existsSync(VITEST_CONFIG)) {
    fail(
      GATE,
      `${VITEST_CONFIG} not found — the per-file floors live there; restore it from git (it is write-guard-protected)`,
    )
  }
  const vitestText = readFileSync(VITEST_CONFIG, 'utf8')
  const vitestFloors = parsePerFileFloors(vitestText)
  if (vitestFloors === null) {
    fail(
      GATE,
      `${VITEST_CONFIG} carries no parseable PER_FILE_FLOORS block (statements/branches/functions/lines) — this gate fails closed rather than invent numbers; restore vitest.config.ts from git`,
    )
  }
  const vitestExcludes = parseCoverageExcludes(vitestText)
  if (vitestExcludes === null) {
    fail(
      GATE,
      `${VITEST_CONFIG} carries no parseable COVERAGE_EXCLUDE array — this gate fails closed rather than guess which files vitest measures; restore vitest.config.ts from git`,
    )
  }

  let jestFloors = null
  let jestCoverageFrom = null
  if (existsSync(JEST_CONFIG)) {
    const jestText = readFileSync(JEST_CONFIG, 'utf8')
    jestFloors = parsePerFileFloors(jestText)
    if (jestFloors === null) {
      fail(
        GATE,
        `${JEST_CONFIG} carries no parseable PER_FILE_FLOORS block (statements/branches/functions/lines) — this gate fails closed rather than invent numbers; restore jest.config.js from git`,
      )
    }
    jestCoverageFrom = parseCollectCoverageFrom(jestText)
    if (jestCoverageFrom === null) {
      fail(
        GATE,
        `${JEST_CONFIG} carries no parseable collectCoverageFrom array — this gate fails closed rather than guess which files jest-expo measures; restore jest.config.js from git`,
      )
    }
  }

  let changed
  try {
    changed = changedFiles()
  } catch (e) {
    skipOrFail(
      GATE,
      `cannot enumerate changed files (${firstLine(e)}) — this gate needs a git baseline (git init + an initial commit). In CI a shallow checkout is the usual cause: set fetch-depth: 0.`,
    )
  }

  // A mobile tree without its floor config is a tree this gate cannot hold.
  const mobileChanged = changed.some(
    (f) => MOBILE_RE.test(toPosix(f)) && CODE_RE.test(f) && !NON_UNIT_RE.test(f),
  )
  if (mobileChanged && jestFloors === null) {
    fail(
      GATE,
      `${JEST_CONFIG} not found but apps/mobile source changed — the mobile per-file floors live there; restore it from git (it is write-guard-protected)`,
    )
  }

  const maps = {}
  for (const [runner, spec] of Object.entries(RUNNERS)) {
    if (!existsSync(spec.map)) {
      maps[runner] = null
      continue
    }
    try {
      maps[runner] = JSON.parse(readFileSync(spec.map, 'utf8'))
    } catch (e) {
      fail(GATE, `${spec.map} is not valid JSON (${e.message}) — re-run \`${spec.cmd}\``)
    }
  }

  const { findings, checked, missing } = evaluateDiffCoverage({
    changedFiles: changed,
    maps,
    floors: { vitest: vitestFloors, jest: jestFloors ?? vitestFloors },
    vitestExcludes,
    jestCoverageFrom,
    root: process.cwd(),
  })

  if (checked.length === 0) {
    ok(GATE, 'no changed source files — the per-file floors have nothing to hold this run')
  }
  for (const runner of [...missing].sort()) {
    fail(
      GATE,
      `${RUNNERS[runner].map} not found but changed files in its tree need it — run \`${RUNNERS[runner].cmd}\` first. The Stop chain writes it immediately before this gate, so a missing artifact means the chain was reordered or coverage/ was deleted — never a pass.`,
    )
  }
  // THE 0.4.0 SURFACE RAMP. This release widened SRC_RE twice — to apps/web/lib (the new
  // web-unit project measures it) and to the LAYERED packages, packages/*/*/src, which the
  // old single-depth pattern never matched. Both are correct, and both are findings an
  // existing install could not have anticipated: its apps/web carries no __tests__/ (the
  // seed suites are seedOnInitOnly, pulled deliberately), and its platform/verticals files
  // were never held to a per-file floor before today.
  //
  // A FRESH scaffold is unaffected — it has no manifest vintage, so rampNote returns false
  // and every finding below is a hard red on the tree that ships. That asymmetry is the
  // point: projects grow into gates, fresh scaffolds start already grown.
  const NEW_IN_040 = /^(?:apps\/web\/lib|packages\/[^/]+\/[^/]+\/src)\//
  const preExisting = findings.filter((f) => !NEW_IN_040.test(f.file))
  const newSurface = findings.filter((f) => NEW_IN_040.test(f.file))
  const rampedAway =
    newSurface.length > 0 &&
    rampNote(
      GATE,
      '0.4.0',
      `${String(newSurface.length)} finding(s) on the surface 0.4.0 added (apps/web/lib + the layered packages)`,
      { until: '0.5.0' },
    )
  const reportable = rampedAway ? preExisting : findings
  failures(
    GATE,
    reportable.map((f) =>
      f.kind === 'uncovered'
        ? `${f.file}: absent from every coverage map (vitest + jest-expo) — no unit test imports it (a new module must land with tests)`
        : `${f.file}: ${f.metric} ${String(f.actual)}% is below the ${f.runner} per-file floor ${String(f.floor)}% (${RUNNERS[f.runner].floorsIn})`,
    ),
    `Cover every changed source file to the PER_FILE_FLOORS blocks (${VITEST_CONFIG} for server/packages/pure-mobile; ${JEST_CONFIG} for the mobile tree) — reproduce with \`${RUNNERS.vitest.cmd}\` and \`${RUNNERS.jest.cmd}\` (they rewrite the maps), then re-run this gate.`,
  )
  ok(
    GATE,
    `${String(checked.length)} changed source file(s) clear the per-file floors (vitest ${METRICS.map((m) => vitestFloors[m]).join('/')}; jest ${METRICS.map((m) => (jestFloors ?? vitestFloors)[m]).join('/')})`,
  )
}
