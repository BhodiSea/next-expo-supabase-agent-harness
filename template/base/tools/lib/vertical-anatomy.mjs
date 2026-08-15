// Vertical anatomy + intra-vertical layering — the worked pattern as law (0.9.5;
// behavior-keyed since 1.0.0).
//
// packages/verticals/notes is the harness's taught anatomy: a `.` server barrel and a
// Metro-safe `./client` barrel, pure domain logic under src/domain/, a DAL that
// receives its database through a structural port (the witness: src/data/port.ts)
// and never constructs a client, and an events module that speaks only the kernel.
// Until 0.9.5 every one of those properties was prose (the authoring-vertical-slice
// skill, the torvalds rubric) — a second vertical could invert all of them and stay
// green. These are the MECHANICALLY CHECKABLE laws, each observed in the seeded
// witness; judgment-shaped properties (cohesion, abstraction accounting) stay with the
// architecture-reviewer.
//
// THE 1.0.0 RE-KEYING. Until 1.0.0 the DAL laws read DIRECTORY NAMES: client reach
// was judged only under src/data/, and port-presence asked whether src/data/port.ts
// existed. A vertical that named its data layer src/repo/ satisfied both by
// construction — an adversarial review put a module-scope service-role client there
// and the scan reported zero findings (the discharged register row
// vertical-anatomy-folder-name-coupling). The laws now key on BEHAVIOR:
// `dal-client-value-import` reds a value-import of `@app/supabase`/`@supabase/*`
// anywhere under src/**, and `port-presence` reds any file that speaks PostgREST —
// `.from(` / `.rpc(` / `.select(` in call position — without importing a port.ts
// that exists, wherever both live. Single-hop, stated: the port import must be in
// the CALLING file, so a sibling that receives an inline-typed builder is an
// undeclared port and the reviewed allow-file is its escape. The re-keying also
// corrects the old shape's inversion — a src/data/ directory that never speaks
// PostgREST no longer owes a port it has nothing to receive through. Each finding
// carries a `vintage` ('0.9.5' for what the directory keying already produced,
// '1.0.0' for what only the behavior keying sees) so the gate can ramp the widening
// without weakening the armed laws.
//
// Deliberately still convention-keyed, each with its limit stated: domain-purity
// arms only where src/domain/ exists, and events-purity only on src/events.ts.
// Mandating those files by name would be the max-lines mistake in directory form
// (see gates-catalog "Considered and rejected"), so a vertical that names them
// differently escapes those two laws and owes the architecture-reviewer's judgment
// instead — and neither escape can reach a database, because the tree-wide laws
// above are the ones with teeth.
//
// Textual scanner, not a compiler — the source-text.mjs trade: zero dependencies,
// comments blanked first, over-detection reds with the reviewed allow-file
// (tools/vertical-anatomy-allow.json) as the escape.
// SOURCE: docs/harness/gates-catalog.md (boundaries gate; anti-vacuity) [corpus: harness/doctrine]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { walkFiles } from './fs-walk.mjs'
import { blankComments, lineOf } from './source-text.mjs'

// Not exported: the law ids are consumed only by the allow-file validator
// below, and knip --strict reds an export nothing imports.
const ANATOMY_LAWS = new Set([
  'dual-barrel',
  'pure-barrel',
  'domain-purity',
  'dal-client-value-import',
  'port-presence',
  'events-purity',
  'select-star',
])

const SCAN_EXCLUDES = new Set(['node_modules', 'dist', 'coverage', '.turbo'])

// PostgREST in CALL position — a leading dot, so a port INTERFACE declaring
// `from(table: string): …` (no dot before the name) is not the subject; the
// behavior that makes a file the DAL is calling the builder, not describing it.
const POSTGREST_CALL = /\.(?:from|rpc|select)\s*\(/

/**
 * Resolve `spec` against the directory of the file at `rel`, both POSIX module
 * paths — the specifiers here are module specifiers, never OS paths, so
 * node:path would add a platform dependency for nothing (and would resolve
 * '\\' on win32, which a module specifier never means). Returns the normalised
 * path, or null when the specifier climbs above the root `rel` is relative to.
 */
function resolveRelative(rel, spec) {
  const parts = `${rel.split('/').slice(0, -1).join('/')}/${spec}`.split('/')
  const out = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null // climbed above the scan root
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

const isTest = (rel) => /\.test\.tsx?$/.test(rel) || /(^|\/)__tests__\//.test(rel)

// Every import specifier a file names, in any form: static import/export-from,
// side-effect import, dynamic import(), require(). Comments already blanked.
function importSpecifiers(src) {
  const specs = []
  for (const re of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|[;\s])import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ]) {
    for (const m of src.matchAll(re)) specs.push({ spec: m[1], index: m.index ?? 0 })
  }
  return specs
}

// A from-clause naming `spec` that is NOT statement-level type-only, plus any
// dynamic import()/require() of it — both are value reaches by construction.
// Mixed `import { type X, Y }` counts as a value import on purpose: it carries values.
function valueImportsOf(src, specPrefixes) {
  const covers = (spec) => specPrefixes.some((p) => spec === p || spec.startsWith(`${p}/`))
  const hits = []
  for (const m of src.matchAll(/\b(import|export)(\s+type)?\s[^;'"`]*?from\s*(['"])([^'"]+)\3/g)) {
    if (m[2] === undefined && covers(m[4])) hits.push({ spec: m[4], index: m.index ?? 0 })
  }
  for (const re of [/\bimport\s*\(\s*(['"])([^'"]+)\1/g, /\brequire\s*\(\s*(['"])([^'"]+)\1/g]) {
    for (const m of src.matchAll(re)) {
      if (covers(m[2])) hits.push({ spec: m[2], index: m.index ?? 0 })
    }
  }
  return hits
}

// A pure barrel: after blanking comments, removing every well-formed export
// statement leaves only whitespace. `export * from`, `export { … } from`,
// `export type { … } from`, and bare `export { … }` are the whole grammar.
function barrelResidue(blanked) {
  const stripped = blanked
    .replace(/export\s*\*\s*(as\s+\w+\s+)?from\s*['"][^'"]+['"]\s*;?/g, (s) =>
      s.replace(/[^\n]/g, ' '),
    )
    .replace(/export\s+(type\s+)?\{[^}]*\}\s*(from\s*['"][^'"]+['"])?\s*;?/g, (s) =>
      s.replace(/[^\n]/g, ' '),
    )
  const m = stripped.match(/\S/)
  return m ? { line: lineOf(stripped, m.index ?? 0) } : null
}

function readBlanked(path) {
  return blankComments(readFileSync(path, 'utf8'))
}

function scanBarrels(dir, name, findings) {
  let pkg = null
  const manifestName = ['package.json', 'package.json.tmpl'].find((n) => existsSync(join(dir, n)))
  try {
    pkg = JSON.parse(readFileSync(join(dir, manifestName ?? 'package.json'), 'utf8'))
  } catch {
    findings.push({
      package: name,
      law: 'dual-barrel',
      path: 'package.json',
      detail:
        'package.json is unreadable or invalid JSON — the dual-barrel contract cannot be verified',
    })
    return
  }
  const exportsMap = pkg.exports !== null && typeof pkg.exports === 'object' ? pkg.exports : {}
  for (const [key, file] of [
    ['.', 'src/index.ts'],
    ['./client', 'src/client.ts'],
  ]) {
    if (exportsMap[key] === undefined) {
      findings.push({
        package: name,
        law: 'dual-barrel',
        path: 'package.json',
        detail: `exports map lacks the "${key}" key — every vertical ships BOTH barrels (the \`.\` server surface and the Metro-safe \`./client\`); a single-barrel vertical either leaks the server graph to Metro or has no server seam at all`,
      })
    }
    if (!existsSync(join(dir, file))) {
      findings.push({
        package: name,
        law: 'dual-barrel',
        path: file,
        detail: `${file} is missing — the "${key}" barrel has no module behind it`,
      })
      continue
    }
    const residue = barrelResidue(readBlanked(join(dir, file)))
    if (residue !== null) {
      findings.push({
        package: name,
        law: 'pure-barrel',
        path: file,
        detail: `line ${residue.line} is not an export statement — a barrel with logic breaks the "Metro-safe surface" claim; barrels only re-export (move the logic behind the barrel)`,
      })
    }
  }
}

function scanDomain(dir, name, findings) {
  const domainDir = join(dir, 'src/domain')
  if (!existsSync(domainDir)) return
  for (const rel of walkFiles(domainDir, { excludeDirs: SCAN_EXCLUDES })) {
    if (!/\.tsx?$/.test(rel) || isTest(rel)) continue
    const blanked = readBlanked(join(domainDir, rel))
    for (const { spec, index } of importSpecifiers(blanked)) {
      // `!spec.startsWith('../')` was the whole containment test, and './../x'
      // walks straight past it — one character, and the law evaporates. Normalise
      // the path instead: any specifier that climbs OUT of src/domain/ is not a
      // sibling, however it is spelled. zod subpaths ('zod/v4') and contracts
      // subpaths are legitimate; exact-match was noise.
      const relative = spec.startsWith('.')
      const escapes = relative && resolveRelative(rel, spec) === null
      const ok =
        (!relative &&
          (spec === 'zod' ||
            spec.startsWith('zod/') ||
            spec === '@app/contracts' ||
            spec.startsWith('@app/contracts/'))) ||
        (relative && !escapes)
      if (!ok) {
        findings.push({
          package: name,
          law: 'domain-purity',
          path: `src/domain/${rel}`,
          detail: `line ${lineOf(blanked, index)} imports '${spec}' — domain modules import only sibling domain files, '@app/contracts' and 'zod'; no I/O, no clock, no error kernel (domain returns values; data returns outcomes)`,
        })
      }
    }
  }
}

/**
 * True when the file imports — in any form — a specifier that resolves inside
 * this vertical's src/ to a `port.ts` that EXISTS. Any import form satisfies it
 * on purpose: the port is a types-only module, so whether the import is
 * `import type` is tsc's business; the law's subject is that the file is
 * WRITTEN AGAINST a real structural port.
 */
function importsAPort(srcDir, rel, blanked) {
  for (const { spec } of importSpecifiers(blanked)) {
    if (!spec.startsWith('.')) continue
    const resolved = resolveRelative(rel, spec)
    if (resolved === null) continue
    if (!/(^|\/)port(\.js|\.ts)?$/.test(resolved)) continue
    if (existsSync(join(srcDir, `${resolved.replace(/\.(js|ts)$/, '')}.ts`))) return true
  }
  return false
}

function clientReachFindings(name, rel, blanked, findings) {
  for (const { spec, index } of valueImportsOf(blanked, ['@app/supabase', '@supabase'])) {
    findings.push({
      package: name,
      law: 'dal-client-value-import',
      path: `src/${rel}`,
      vintage: rel.startsWith('data/') ? '0.9.5' : '1.0.0',
      detail: `line ${lineOf(blanked, index)} value-imports '${spec}' — a vertical never constructs or reaches a client anywhere in its tree, whatever the directory is called; the database arrives through a structural port (\`import type\` of the port shapes is the sanctioned form)`,
    })
  }
}

function portDisciplineFinding(srcDir, name, rel, blanked, findings) {
  const call = blanked.match(POSTGREST_CALL)
  if (call === null || importsAPort(srcDir, rel, blanked)) return
  // The directory keying only ever produced this finding under src/data/ with
  // src/data/port.ts absent — that exact shape keeps the armed 0.9.5 vintage;
  // everything else is the 1.0.0 behavior keying's widening.
  const legacyShape = rel.startsWith('data/') && !existsSync(join(srcDir, 'data/port.ts'))
  findings.push({
    package: name,
    law: 'port-presence',
    path: `src/${rel}`,
    vintage: legacyShape ? '0.9.5' : '1.0.0',
    detail: `line ${lineOf(blanked, call.index ?? 0)} speaks PostgREST (.from(/.rpc(/.select() — that behavior makes this file the DAL wherever it lives; it must import a structural port.ts that exists (the witness: src/data/port.ts) and receive its database through it, never construct or inline-type one`,
  })
}

function selectStarFinding(name, rel, blanked, findings) {
  // `'*'` AND `'*, author(*)'`: PostgREST's embed form is the common spelling
  // and is still a star projection of the base table. Anchored on the opening
  // quote followed by `*`, so `select('id, *')`-style column lists that merely
  // CONTAIN a star elsewhere are not the subject.
  const m = blanked.match(/\.select\(\s*(['"`])\s*\*/)
  if (m) {
    findings.push({
      package: name,
      law: 'select-star',
      path: `src/${rel}`,
      detail: `line ${lineOf(blanked, m.index ?? 0)} calls select('*') — the explicit projection is the wire contract; '*' welds the DTO to whatever the table grows (see the witness src/data/rows.ts)`,
    })
  }
}

// The tree-wide laws, one walk (1.0.0): client reach, port discipline,
// select-star. One walk is also the file COUNT — every non-test source file in
// the vertical is scanned by these three, so the anti-vacuity floor counts here
// and nowhere else.
function scanTree(dir, name, findings, counted) {
  const srcDir = join(dir, 'src')
  if (!existsSync(srcDir)) return
  for (const rel of walkFiles(srcDir, { excludeDirs: SCAN_EXCLUDES })) {
    if (!/\.tsx?$/.test(rel) || isTest(rel)) continue
    counted.n += 1
    const blanked = readBlanked(join(srcDir, rel))
    clientReachFindings(name, rel, blanked, findings)
    portDisciplineFinding(srcDir, name, rel, blanked, findings)
    selectStarFinding(name, rel, blanked, findings)
  }
}

function scanEvents(dir, name, findings) {
  const eventsFile = join(dir, 'src/events.ts')
  if (!existsSync(eventsFile)) return
  const blanked = readBlanked(eventsFile)
  for (const { spec, index } of importSpecifiers(blanked)) {
    if (spec !== '@app/events' && spec !== '@app/contracts') {
      findings.push({
        package: name,
        law: 'events-purity',
        path: 'src/events.ts',
        detail: `line ${lineOf(blanked, index)} imports '${spec}' — events.ts speaks only the kernel ('@app/events') and the wire contracts ('@app/contracts'); payloads are identifiers, never rich objects from elsewhere in the vertical`,
      })
    }
  }
}

/**
 * Scan every package under packages/verticals/ against the anatomy laws.
 * @returns {{ verticals: number, filesScanned: number, findings: Array<{package: string, law: string, path: string, detail: string, vintage?: string}> }}
 */
export function scanVerticalAnatomy({ packagesDir = 'packages' } = {}) {
  const root = join(packagesDir, 'verticals')
  const findings = []
  const counted = { n: 0 }
  let verticals = 0
  if (!existsSync(root)) return { verticals, filesScanned: 0, findings }
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry)
    // `package.json.tmpl` too: the harness's OWN template stores manifests with
    // that suffix, so scanning only `package.json` meant the laws never ran
    // against the very vertical they were derived from — the scan reported zero
    // verticals on the template tree and the anti-vacuity floor cannot fire when
    // the count is zero. A rendered scaffold was the only place this ever ran.
    if (!statSync(dir).isDirectory()) continue
    const manifest = ['package.json', 'package.json.tmpl'].find((n) => existsSync(join(dir, n)))
    if (manifest === undefined) continue
    verticals += 1
    let name = entry
    try {
      name = JSON.parse(readFileSync(join(dir, manifest), 'utf8')).name ?? entry
    } catch {
      /* scanBarrels reports the unreadable manifest */
    }
    scanBarrels(dir, name, findings)
    scanDomain(dir, name, findings)
    scanTree(dir, name, findings, counted)
    scanEvents(dir, name, findings)
  }
  return { verticals, filesScanned: counted.n, findings }
}

/**
 * Validate the reviewed allow-file's SHAPE, returning the usable entries and every
 * problem found. Split from applyAnatomyAllow below for the harness's own ≤15
 * cognitive-complexity ratchet — the release that makes that ceiling unsuppressable
 * for consumers does not get to record an exemption for itself.
 * @param {any} allowDoc parsed tools/vertical-anatomy-allow.json, or null when absent
 * @returns {{entries: any[], problems: string[]}}
 */
function readAnatomyAllowEntries(allowDoc) {
  if (allowDoc === null) return { entries: [], problems: [] }
  if (!Array.isArray(allowDoc?.allow)) {
    return {
      entries: [],
      problems: [
        'tools/vertical-anatomy-allow.json must carry an "allow" ARRAY of {package, law, path?, reason, reviewedOn} entries',
      ],
    }
  }
  const entries = []
  const problems = []
  for (const [i, e] of allowDoc.allow.entries()) {
    const problem = anatomyAllowEntryProblem(e, i)
    if (problem === null) entries.push(e)
    else problems.push(problem)
  }
  return { entries, problems }
}

/** The per-entry bars, in order. Returns the first failure, or null when usable. */
function anatomyAllowEntryProblem(e, i) {
  if (typeof e?.package !== 'string' || !ANATOMY_LAWS.has(e?.law)) {
    return `allow[${i}] needs a "package" and a "law" from: ${[...ANATOMY_LAWS].join(', ')}`
  }
  if (typeof e.reason !== 'string' || e.reason.trim().length < 40) {
    return `allow[${i}] (${e.package} ${e.law}) needs a reason of at least 40 characters — a one-word escape is not a review`
  }
  if (typeof e.reviewedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.reviewedOn)) {
    return `allow[${i}] (${e.package} ${e.law}) needs a reviewedOn date (YYYY-MM-DD)`
  }
  return null
}

/**
 * Reconcile findings against the reviewed allow-file, CLOSED BOTH WAYS: a
 * malformed entry is a problem, and an entry matching no live finding is stale
 * (the duplication-allow pattern — an escape that outlives its finding is a
 * standing hole nobody reviews).
 * @param {Array<{package: string, law: string, path: string, detail: string, vintage?: string}>} findings
 * @param {any} allowDoc parsed tools/vertical-anatomy-allow.json, or null when absent
 */
export function applyAnatomyAllow(findings, allowDoc) {
  const { entries, problems } = readAnatomyAllowEntries(allowDoc)
  const matched = new Set()
  const remaining = findings.filter((f) => {
    const hit = entries.find(
      (e) =>
        e.package === f.package && e.law === f.law && (e.path === undefined || e.path === f.path),
    )
    if (hit) matched.add(hit)
    return !hit
  })
  const stale = entries.filter((e) => !matched.has(e))
  return { remaining, stale, problems }
}
