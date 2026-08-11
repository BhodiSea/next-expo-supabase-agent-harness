// Vertical anatomy + intra-vertical layering — the worked pattern as law (0.9.5).
//
// packages/verticals/notes is the harness's taught anatomy: a `.` server barrel and a
// Metro-safe `./client` barrel, pure domain logic under src/domain/, a DAL under
// src/data/ that receives its database through the structural port (src/data/port.ts)
// and never constructs a client, and an events module that speaks only the kernel.
// Until 0.9.5 every one of those properties was prose (the authoring-vertical-slice
// skill, the torvalds rubric) — a second vertical could invert all of them and stay
// green. These are the MECHANICALLY CHECKABLE laws, each observed in the seeded
// witness; judgment-shaped properties (cohesion, abstraction accounting) stay with the
// architecture-reviewer.
//
// Deliberately NOT law: the presence of domain/ or events.ts at all — a thin read-only
// vertical legitimately has neither, and mandating the full anatomy would be the
// max-lines mistake in directory form (see gates-catalog "Considered and rejected").
//
// Textual scanner, not a compiler — the source-text.mjs trade: zero dependencies,
// comments blanked first, over-detection reds with the reviewed allow-file
// (tools/vertical-anatomy-allow.json) as the escape.
// SOURCE: docs/harness/gates-catalog.md (boundaries gate; anti-vacuity) [corpus: harness/doctrine]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { walkFiles } from './fs-walk.mjs'
import { blankComments, lineOf } from './source-text.mjs'

export const ANATOMY_LAWS = new Set([
  'dual-barrel',
  'pure-barrel',
  'domain-purity',
  'dal-client-value-import',
  'port-presence',
  'events-purity',
  'select-star',
])

const SCAN_EXCLUDES = new Set(['node_modules', 'dist', 'coverage', '.turbo'])
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
    .replace(/export\s*\*\s*(as\s+\w+\s+)?from\s*['"][^'"]+['"]\s*;?/g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/export\s+(type\s+)?\{[^}]*\}\s*(from\s*['"][^'"]+['"])?\s*;?/g, (s) => s.replace(/[^\n]/g, ' '))
  const m = stripped.match(/\S/)
  return m ? { line: lineOf(stripped, m.index ?? 0) } : null
}

function readBlanked(path) {
  return blankComments(readFileSync(path, 'utf8'))
}

function scanBarrels(dir, name, findings, counted) {
  let pkg = null
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    findings.push({ package: name, law: 'dual-barrel', path: 'package.json', detail: 'package.json is unreadable or invalid JSON — the dual-barrel contract cannot be verified' })
    return
  }
  const exportsMap = pkg.exports !== null && typeof pkg.exports === 'object' ? pkg.exports : {}
  for (const [key, file] of [
    ['.', 'src/index.ts'],
    ['./client', 'src/client.ts'],
  ]) {
    if (exportsMap[key] === undefined) {
      findings.push({ package: name, law: 'dual-barrel', path: 'package.json', detail: `exports map lacks the "${key}" key — every vertical ships BOTH barrels (the \`.\` server surface and the Metro-safe \`./client\`); a single-barrel vertical either leaks the server graph to Metro or has no server seam at all` })
    }
    if (!existsSync(join(dir, file))) {
      findings.push({ package: name, law: 'dual-barrel', path: file, detail: `${file} is missing — the "${key}" barrel has no module behind it` })
      continue
    }
    counted.n += 1
    const residue = barrelResidue(readBlanked(join(dir, file)))
    if (residue !== null) {
      findings.push({ package: name, law: 'pure-barrel', path: file, detail: `line ${residue.line} is not an export statement — a barrel with logic breaks the "Metro-safe surface" claim; barrels only re-export (move the logic behind the barrel)` })
    }
  }
}

function scanDomain(dir, name, findings, counted) {
  const domainDir = join(dir, 'src/domain')
  if (!existsSync(domainDir)) return
  for (const rel of walkFiles(domainDir, { excludeDirs: SCAN_EXCLUDES })) {
    if (!/\.tsx?$/.test(rel) || isTest(rel)) continue
    counted.n += 1
    const blanked = readBlanked(join(domainDir, rel))
    for (const { spec, index } of importSpecifiers(blanked)) {
      const ok =
        spec === 'zod' ||
        spec === '@app/contracts' ||
        (spec.startsWith('./') && !spec.startsWith('../'))
      if (!ok) {
        findings.push({ package: name, law: 'domain-purity', path: `src/domain/${rel}`, detail: `line ${lineOf(blanked, index)} imports '${spec}' — domain modules import only sibling domain files, '@app/contracts' and 'zod'; no I/O, no clock, no error kernel (domain returns values; data returns outcomes)` })
      }
    }
  }
}

function scanData(dir, name, findings, counted) {
  const dataDir = join(dir, 'src/data')
  if (!existsSync(dataDir)) return
  if (!existsSync(join(dataDir, 'port.ts'))) {
    findings.push({ package: name, law: 'port-presence', path: 'src/data', detail: 'src/data/ exists with no src/data/port.ts — the DAL receives its database through the structural port; a portless DAL has nowhere to receive it but a constructed client' })
  }
  for (const rel of walkFiles(dataDir, { excludeDirs: SCAN_EXCLUDES })) {
    if (!/\.tsx?$/.test(rel) || isTest(rel)) continue
    counted.n += 1
    const blanked = readBlanked(join(dataDir, rel))
    for (const { spec, index } of valueImportsOf(blanked, ['@app/supabase', '@supabase'])) {
      findings.push({ package: name, law: 'dal-client-value-import', path: `src/data/${rel}`, detail: `line ${lineOf(blanked, index)} value-imports '${spec}' — the DAL never constructs or reaches a client; the database arrives through src/data/port.ts (\`import type\` of the port shapes is the sanctioned form)` })
    }
  }
}

function scanEvents(dir, name, findings, counted) {
  const eventsFile = join(dir, 'src/events.ts')
  if (!existsSync(eventsFile)) return
  counted.n += 1
  const blanked = readBlanked(eventsFile)
  for (const { spec, index } of importSpecifiers(blanked)) {
    if (spec !== '@app/events' && spec !== '@app/contracts') {
      findings.push({ package: name, law: 'events-purity', path: 'src/events.ts', detail: `line ${lineOf(blanked, index)} imports '${spec}' — events.ts speaks only the kernel ('@app/events') and the wire contracts ('@app/contracts'); payloads are identifiers, never rich objects from elsewhere in the vertical` })
    }
  }
}

function scanSelectStar(dir, name, findings) {
  const srcDir = join(dir, 'src')
  if (!existsSync(srcDir)) return
  for (const rel of walkFiles(srcDir, { excludeDirs: SCAN_EXCLUDES })) {
    if (!/\.tsx?$/.test(rel) || isTest(rel)) continue
    const blanked = readBlanked(join(srcDir, rel))
    const m = blanked.match(/\.select\(\s*(['"`])\*\1\s*\)/)
    if (m) {
      findings.push({ package: name, law: 'select-star', path: `src/${rel}`, detail: `line ${lineOf(blanked, m.index ?? 0)} calls select('*') — the explicit projection is the wire contract; '*' welds the DTO to whatever the table grows (see the witness src/data/rows.ts)` })
    }
  }
}

/**
 * Scan every package under packages/verticals/ against the anatomy laws.
 * @returns {{ verticals: number, filesScanned: number, findings: Array<{package: string, law: string, path: string, detail: string}> }}
 */
export function scanVerticalAnatomy({ packagesDir = 'packages' } = {}) {
  const root = join(packagesDir, 'verticals')
  const findings = []
  const counted = { n: 0 }
  let verticals = 0
  if (!existsSync(root)) return { verticals, filesScanned: 0, findings }
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry)
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'package.json'))) continue
    verticals += 1
    let name = entry
    try {
      name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name ?? entry
    } catch {
      /* scanBarrels reports the unreadable manifest */
    }
    scanBarrels(dir, name, findings, counted)
    scanDomain(dir, name, findings, counted)
    scanData(dir, name, findings, counted)
    scanEvents(dir, name, findings, counted)
    scanSelectStar(dir, name, findings)
  }
  return { verticals, filesScanned: counted.n, findings }
}

/**
 * Reconcile findings against the reviewed allow-file, CLOSED BOTH WAYS: a
 * malformed entry is a problem, and an entry matching no live finding is stale
 * (the duplication-allow pattern — an escape that outlives its finding is a
 * standing hole nobody reviews).
 * @param {Array<{package: string, law: string, path: string, detail: string}>} findings
 * @param {any} allowDoc parsed tools/vertical-anatomy-allow.json, or null when absent
 */
export function applyAnatomyAllow(findings, allowDoc) {
  const problems = []
  const entries = []
  if (allowDoc !== null) {
    if (!Array.isArray(allowDoc?.allow)) {
      problems.push('tools/vertical-anatomy-allow.json must carry an "allow" ARRAY of {package, law, path?, reason, reviewedOn} entries')
    } else {
      for (const [i, e] of allowDoc.allow.entries()) {
        if (typeof e?.package !== 'string' || !ANATOMY_LAWS.has(e?.law)) {
          problems.push(`allow[${i}] needs a "package" and a "law" from: ${[...ANATOMY_LAWS].join(', ')}`)
          continue
        }
        if (typeof e.reason !== 'string' || e.reason.trim().length < 40) {
          problems.push(`allow[${i}] (${e.package} ${e.law}) needs a reason of at least 40 characters — a one-word escape is not a review`)
          continue
        }
        if (typeof e.reviewedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.reviewedOn)) {
          problems.push(`allow[${i}] (${e.package} ${e.law}) needs a reviewedOn date (YYYY-MM-DD)`)
          continue
        }
        entries.push(e)
      }
    }
  }
  const matched = new Set()
  const remaining = findings.filter((f) => {
    const hit = entries.find(
      (e) => e.package === f.package && e.law === f.law && (e.path === undefined || e.path === f.path),
    )
    if (hit) matched.add(hit)
    return !hit
  })
  const stale = entries.filter((e) => !matched.has(e))
  return { remaining, stale, problems }
}
