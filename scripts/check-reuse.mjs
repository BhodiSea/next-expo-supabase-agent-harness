#!/usr/bin/env node
// REUSE structural mirror (repo selftest only — never shipped to consumers).
// CI runs the real `pipx run reuse==<pin> lint` (lint.yml reuse-lint job); this
// script is the dependency-free offline mirror so `reuse` never becomes a local
// prerequisite. It asserts the same failure classes reuse lint would red on:
//   1. REUSE.toml parses — against a PINNED TOML subset (exactly the grammar
//      this repo emits; anything else is a parse FAIL, never a silent skip),
//   2. every SPDX id referenced by an annotation has LICENSES/<id>.txt, every
//      LICENSES/ file is referenced (unused licenses red under reuse lint),
//      and every id is on the repo's known-license allowlist (the offline
//      stand-in for the full SPDX list — extend it when licensing changes),
//   3. every tracked-or-untracked-unignored file is covered by at least one
//      annotation glob (spec-ignored paths excluded), mirroring reuse-tool's
//      file discovery (`git ls-files --cached --others --exclude-standard`),
//   4. license-consistency: README's License section, CITATION.cff `license`,
//      and package.json `license` agree with REUSE.toml. This is the ONE home
//      for license-consistency — check-release-lockstep.mjs stays version-only.
//   usage: node scripts/check-reuse.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Offline stand-in for the SPDX license list: only ids this repo actually
// uses. A typo'd or unknown id must red HERE, not only under the real tool.
export const KNOWN_LICENSE_IDS = new Set(['Apache-2.0', '0BSD'])

// ---------------------------------------------------------------------------
// 1. TOML-subset parser. Accepted grammar — pinned, fail closed on the rest:
//      blank lines | full-line `#` comments | `version = 1` (top level)
//      | `[[annotations]]` | `<key> = "<value>"` inside an annotations table,
//      keys limited to path/precedence/SPDX-FileCopyrightText/
//      SPDX-License-Identifier, values double-quoted with no escapes.
//    No other tables, no arrays, no multi-line values, no inline comments —
//    the file this repo emits never needs them, and a parser that guesses at
//    grammar it does not pin is how a licensing gate goes silently vacuous.
// ---------------------------------------------------------------------------
const ANNOTATION_KEYS = new Map([
  ['path', 'path'],
  ['precedence', 'precedence'],
  ['SPDX-FileCopyrightText', 'copyright'],
  ['SPDX-License-Identifier', 'license'],
])

// eslint-disable-next-line sonarjs/cognitive-complexity -- ceiling is machine-enforced by scripts/complexity-ratchet.json (G16); this directive only silences the rule, the ratchet is what stops the score growing
export function parseReuseToml(text) {
  let version = null
  const annotations = []
  let current = null // keys seen in the [[annotations]] table being parsed

  const finish = (lineNo) => {
    if (current === null) return
    for (const key of ANNOTATION_KEYS.keys()) {
      if (!(key in current.raw)) {
        throw new Error(`line ${lineNo}: [[annotations]] table is missing required key "${key}"`)
      }
    }
    if (current.raw.precedence !== 'aggregate') {
      throw new Error(
        `line ${lineNo}: precedence "${current.raw.precedence}" is outside the pinned subset (only "aggregate" is emitted here)`,
      )
    }
    annotations.push({
      path: current.raw.path,
      precedence: current.raw.precedence,
      copyright: current.raw['SPDX-FileCopyrightText'],
      license: current.raw['SPDX-License-Identifier'],
    })
    current = null
  }

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const no = i + 1
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    if (/^\[\[annotations\]\]\s*$/.test(line)) {
      finish(no)
      current = { raw: {} }
      continue
    }
    const versionMatch = line.match(/^version\s*=\s*(\d+)\s*$/)
    if (versionMatch) {
      if (current !== null) throw new Error(`line ${no}: "version" inside an [[annotations]] table`)
      if (version !== null) throw new Error(`line ${no}: duplicate "version"`)
      version = Number(versionMatch[1])
      continue
    }
    const kv = line.match(/^([A-Za-z0-9-]+)\s*=\s*"([^"\\]*)"\s*$/)
    if (kv && current !== null && ANNOTATION_KEYS.has(kv[1])) {
      if (kv[1] in current.raw) throw new Error(`line ${no}: duplicate key "${kv[1]}"`)
      if (kv[2] === '') throw new Error(`line ${no}: empty value for "${kv[1]}"`)
      current.raw[kv[1]] = kv[2]
      continue
    }
    throw new Error(`line ${no}: outside the pinned TOML subset: ${line.trim()}`)
  }
  finish(lines.length)

  if (version !== 1) throw new Error(`REUSE.toml must declare version = 1 (got ${version})`)
  if (annotations.length === 0) throw new Error('REUSE.toml declares no [[annotations]] tables')
  return { version, annotations }
}

// ---------------------------------------------------------------------------
// 2. Glob semantics — exactly the subset REUSE.toml here emits, mirroring
//    reuse-tool: `**` matches anything including `/`; `*` matches within one
//    path segment. Any other glob metacharacter is a FAIL (unpinned grammar).
// ---------------------------------------------------------------------------
export function globToRegExp(glob) {
  if (/[?[\]{}]/.test(glob)) {
    throw new Error(`glob "${glob}" uses metacharacters outside the pinned subset (** and * only)`)
  }
  let out = ''
  let i = 0
  while (i < glob.length) {
    if (glob.startsWith('**', i)) {
      out += '.*'
      i += 2
    } else if (glob[i] === '*') {
      out += '[^/]*'
      i += 1
    } else {
      out += glob[i].replace(/[.+^${}()|\\]/, '\\$&')
      i += 1
    }
  }
  return new RegExp(`^${out}$`)
}

// Latest match wins — reuse-tool resolves a file to the LAST [[annotations]]
// table whose path glob matches (find_annotations_item), so ordering in
// REUSE.toml is semantic and the mirror must agree exactly.
export function coveringAnnotation(path, annotations) {
  let found = null
  for (const a of annotations) {
    if (globToRegExp(a.path).test(path)) found = a
  }
  return found
}

// Paths the REUSE spec / reuse-tool exclude from needing an annotation.
export function specIgnored(path) {
  if (path === 'REUSE.toml' || path.startsWith('LICENSES/')) return true
  if (path.endsWith('.license')) return true
  const base = path.split('/').at(-1)
  return /^LICENSE(\..+)?$/.test(base) || /^COPYING(\..+)?$/.test(base)
}

// SPDX expression subset: ids joined by OR (all this repo emits — a dual
// license is a recipient CHOICE). AND/WITH/parentheses are outside the pin.
export function licenseIdsFromExpression(expr) {
  if (!/^[A-Za-z0-9.-]+( OR [A-Za-z0-9.-]+)*$/.test(expr)) {
    throw new Error(`license expression "${expr}" is outside the pinned subset (ids joined by " OR ")`)
  }
  return expr.split(' OR ')
}

// ---------------------------------------------------------------------------
// 3+4. Structural problems, as data (the CLI prints them; tests assert them).
// ---------------------------------------------------------------------------
// eslint-disable-next-line sonarjs/cognitive-complexity -- ceiling is machine-enforced by scripts/complexity-ratchet.json (G16); this directive only silences the rule, the ratchet is what stops the score growing
export function reuseProblems({ reuse, trackedPaths, licenseFiles, readme, citation, packageJson }) {
  const problems = []

  // Every referenced id has its LICENSES/<id>.txt; no unused/unknown texts.
  const referenced = new Set()
  for (const a of reuse.annotations) {
    for (const id of licenseIdsFromExpression(a.license)) referenced.add(id)
  }
  for (const id of referenced) {
    if (!KNOWN_LICENSE_IDS.has(id)) {
      problems.push(`license id "${id}" is not on KNOWN_LICENSE_IDS (scripts/check-reuse.mjs) — typo, or extend the allowlist deliberately`)
    }
    if (!licenseFiles.includes(`${id}.txt`)) {
      problems.push(`LICENSES/${id}.txt is missing but "${id}" is referenced by REUSE.toml`)
    }
  }
  for (const f of licenseFiles) {
    const id = f.replace(/\.txt$/, '')
    if (!f.endsWith('.txt')) problems.push(`LICENSES/${f}: only <SPDX-id>.txt files belong here`)
    else if (!referenced.has(id)) problems.push(`LICENSES/${f} is not referenced by any REUSE.toml annotation (unused license)`)
  }

  // Full coverage: every discovered file matches at least one annotation.
  for (const p of trackedPaths) {
    if (specIgnored(p)) continue
    if (coveringAnnotation(p, reuse.annotations) === null) {
      problems.push(`${p} is covered by no REUSE.toml annotation`)
    }
  }

  // License-consistency (single home — see header). Probe paths, not glob
  // string equality, so annotation refactors cannot silently detach the check.
  const templateExpr = coveringAnnotation('template/probe', reuse.annotations)?.license
  const repoExpr = coveringAnnotation('installer/probe', reuse.annotations)?.license
  if (!templateExpr || !repoExpr) {
    problems.push('REUSE.toml no longer covers template/ or the repo root — consistency checks cannot anchor')
    return problems
  }

  // README must state BOTH expressions verbatim: the repo-wide license and the
  // template/** dual choice ("additionally 0BSD" ⇒ recipient picks either ⇒ OR).
  if (!readme.includes(repoExpr)) {
    problems.push(`README License section does not state the repo license "${repoExpr}" from REUSE.toml`)
  }
  if (!readme.includes(`\`template/**\``) || !readme.includes(templateExpr)) {
    problems.push(`README License section does not state \`template/**\` as "${templateExpr}" per REUSE.toml`)
  }

  // CITATION.cff / package.json describe the WORK AS A WHOLE, whose license is
  // the repo-wide expression — "consistent" here means exactly equal to it,
  // NOT to the template/** dual expression (0BSD is an extra grant on a
  // subtree, and Apache-2.0 remains a valid choice for every file).
  const citLicense = citation.match(/^license:\s*(\S+)\s*$/m)?.[1]
  if (citLicense !== repoExpr) {
    problems.push(`CITATION.cff license "${citLicense ?? '(absent)'}" != repo-wide REUSE.toml expression "${repoExpr}"`)
  }
  if (packageJson.license !== repoExpr) {
    problems.push(`package.json license "${packageJson.license}" != repo-wide REUSE.toml expression "${repoExpr}"`)
  }

  return problems
}

// CLI wrapper — only when executed directly, so tests import the pure core.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let reuse
  try {
    reuse = parseReuseToml(readFileSync(join(ROOT, 'REUSE.toml'), 'utf8'))
  } catch (err) {
    console.error(`REUSE: FAIL — REUSE.toml does not parse: ${err.message}`)
    process.exit(1)
  }

  // Same discovery reuse-tool uses in a git work tree: tracked plus untracked
  // non-ignored (a brand-new file must be covered BEFORE it is ever staged).
  const trackedPaths = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const licensesDir = join(ROOT, 'LICENSES')
  if (!existsSync(licensesDir)) {
    console.error('REUSE: FAIL — LICENSES/ directory is missing')
    process.exit(1)
  }

  let problems
  try {
    problems = reuseProblems({
      reuse,
      trackedPaths,
      licenseFiles: readdirSync(licensesDir),
      readme: readFileSync(join(ROOT, 'README.md'), 'utf8'),
      citation: readFileSync(join(ROOT, 'CITATION.cff'), 'utf8'),
      packageJson: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')),
    })
  } catch (err) {
    console.error(`REUSE: FAIL — ${err.message}`)
    process.exit(1)
  }

  if (problems.length > 0) {
    console.error(`REUSE: FAIL (${problems.length})`)
    for (const p of problems) console.error(`  - ${p}`)
    console.error('  why: the dual-license claim is only credible if machine-verifiable — CI also runs the real `reuse lint`; this mirror keeps the check runnable offline.')
    process.exit(1)
  }
  console.log(
    `REUSE: OK (${reuse.annotations.length} annotations cover ${trackedPaths.filter((p) => !specIgnored(p)).length} files; ids: ${[...KNOWN_LICENSE_IDS].join(', ')})`,
  )
}
