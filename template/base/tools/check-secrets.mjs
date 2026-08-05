#!/usr/bin/env node
// Gate: secrets — a hermetic credential scan INSIDE the chain.
//
// WHY IT IS IN THE CHAIN AND NOT LEFT TO GITLEAKS. lefthook prints `SKIP secrets scan`
// when the gitleaks binary is absent, and .github/workflows/gitleaks.yml only runs after a
// PUSH. Both are correct designs for what they are, and together they leave one hole: on
// any machine without gitleaks a turn can end GREEN with a service-role key in a tracked
// file, and the first thing to notice is a workflow running after the bytes reached the
// remote. This gate is zero-dependency node, so it is present on every machine and in
// every turn — presence, everywhere, always. gitleaks keeps entropy analysis, the default
// ruleset and history scanning; neither subsumes the other.
//
// DELIBERATELY NOT A GO-REGEX TRANSLATION of .gitleaks.toml. Two scanners that quietly
// disagree about what a secret looks like are worse than one, because each gets trusted
// for the other's coverage. What is asserted instead is RULE-ID LOCKSTEP: every id in
// tools/secret-patterns.json exists in .gitleaks.toml and vice versa, so the two policies
// may differ in expression but never in SCOPE.
//
// ANTI-VACUITY, both directions:
//   - every rule self-tests against its own synthetic `positive` at startup, so a decayed
//     regex reports ITSELF instead of reporting a clean tree;
//   - scanning ZERO files is a FAIL, because "no findings over no input" is the exact
//     shape of a green that means nothing.
// SOURCE: docs/security/sandbox-and-supply-chain.md; .gitleaks.toml (the deep scanner)
import { existsSync, readFileSync, statSync } from 'node:fs'
import { toPosix, walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, runCmd } from './lib/gate.mjs'

const GATE = 'secrets'
const PATTERNS = 'tools/secret-patterns.json'
const GITLEAKS = '.gitleaks.toml'
const ACCEPT = 'tools/secret-scan-allow.json'

// The gate FAILS CLOSED without its patterns: an absent policy is not an empty policy.
// The file is PLANTED by `update` for exactly this reason.
if (!existsSync(PATTERNS)) {
  fail(
    GATE,
    `${PATTERNS} is missing, so this gate has no policy and cannot report a clean tree. It is harness-owned and write-guard-protected — restore it from git history, or run \`npx next-expo-supabase-agent-harness update\`.`,
  )
}

let policy
try {
  policy = JSON.parse(readFileSync(PATTERNS, 'utf8'))
} catch (e) {
  fail(GATE, `${PATTERNS} is not valid JSON (${e.message}) — restore it from git history`)
}

const rules = Array.isArray(policy.rules) ? policy.rules : []
if (rules.length === 0) {
  fail(GATE, `${PATTERNS} declares no rules — a scanner with an empty rule set finds nothing`)
}

// ── 0. the rules compile, and each one still matches its own positive ───────────
// A regex that stopped matching what it was written for reports a clean tree forever.
//
// Patterns are authored in the SAME DIALECT as .gitleaks.toml, leading `(?i)` and all —
// deliberately, so a reviewer diffing the two policies is comparing like with like rather
// than translating in their head. JS has no inline flag group, so the prefix is lifted
// into the flags here. A `(?i)` anywhere but the start is refused rather than guessed at:
// RE2 scopes it to the remainder of the pattern and JS has no equivalent, so silently
// applying it to the whole expression would WIDEN the rule.
/** @param {string} source @param {string} flags @returns {RegExp} */
function toJsRegExp(source, flags) {
  let body = source
  let f = flags
  if (body.startsWith('(?i)')) {
    body = body.slice(4)
    if (!f.includes('i')) f += 'i'
  }
  if (body.includes('(?i)')) {
    fail(
      GATE,
      `${PATTERNS}: a pattern carries a non-leading \`(?i)\` (${JSON.stringify(source)}). RE2 scopes that to the rest of the expression and JS has no equivalent — applying it to the whole pattern would WIDEN the rule. Rewrite it with an explicit character class, or move the (?i) to the front.`,
    )
  }
  return new RegExp(body, f)
}

const compiled = []
const decayed = []
for (const rule of rules) {
  for (const field of ['id', 'description', 'regex', 'positive']) {
    if (typeof rule?.[field] !== 'string' || !rule[field]) {
      fail(
        GATE,
        `${PATTERNS}: a rule is missing '${field}' — every rule needs an id, a description, a pattern and a synthetic positive to self-test against`,
      )
    }
  }
  let re
  try {
    re = toJsRegExp(rule.regex, rule.flags ?? 'g')
  } catch (e) {
    fail(GATE, `${PATTERNS}: rule '${rule.id}' has an uncompilable regex (${e.message})`)
  }
  const allow = (rule.allow ?? []).map((a) => {
    try {
      return toJsRegExp(a, '')
    } catch (e) {
      fail(GATE, `${PATTERNS}: rule '${rule.id}' has an uncompilable allow pattern (${e.message})`)
    }
  })
  // The positive is written with JSON escapes (\\n), so decode the two that matter for a
  // realistic multi-line shape before testing.
  const positive = rule.positive.replaceAll('\\n', '\n').replaceAll('\\t', '\t')
  if (!toJsRegExp(rule.regex, (rule.flags ?? 'g').replace('g', '')).test(positive)) {
    decayed.push(
      `rule '${rule.id}' NO LONGER MATCHES ITS OWN POSITIVE (${JSON.stringify(rule.positive)}) — the pattern has decayed, and a decayed pattern reports a clean tree forever`,
    )
  }
  compiled.push({ id: rule.id, description: rule.description, re, allow })
}
failures(
  GATE,
  decayed,
  'Fix the pattern in tools/secret-patterns.json, or fix the positive it is meant to catch.',
)

// ── 1. rule-id lockstep with the deep scanner ──────────────────────────────────
// Two policies may differ in EXPRESSION (RE2 vs JS) but never in SCOPE. A shape gitleaks
// hunts and this gate does not is a shape that only exists after a push; a shape this gate
// hunts and gitleaks does not is a shape with no history coverage.
const lockstepErrs = []
if (existsSync(GITLEAKS)) {
  const toml = readFileSync(GITLEAKS, 'utf8')
  const theirs = new Set([...toml.matchAll(/^\s*id\s*=\s*["']([^"']+)["']/gm)].map((m) => m[1]))
  const ours = new Set(compiled.map((r) => r.id))
  for (const id of ours) {
    if (!theirs.has(id)) {
      lockstepErrs.push(
        `${PATTERNS} declares rule '${id}' but ${GITLEAKS} has no rule with that id — this shape would have no history coverage. Add the matching [[rules]] block.`,
      )
    }
  }
  for (const id of theirs) {
    if (!ours.has(id)) {
      lockstepErrs.push(
        `${GITLEAKS} declares rule '${id}' but ${PATTERNS} has no rule with that id — this shape is only caught after a PUSH, on machines that have gitleaks. Add the matching rule.`,
      )
    }
  }
}
failures(
  GATE,
  lockstepErrs,
  'The two scanners may differ in expression; they may not differ in scope.',
)

// ── 2. the file set: what is, or would be, committed ───────────────────────────
// `git ls-files --cached --others --exclude-standard` is exactly "tracked, plus untracked
// but not ignored" — the set whose contents reach a remote. It deliberately EXCLUDES
// gitignored files, because .env.local holds real credentials by design and reading it is
// denied everywhere else in this harness; scanning it would red every correct machine.
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.expo',
  'dist',
  'gen',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
  '.harness',
  'android',
  'ios',
  '.turbo',
])
/** @returns {string[]} POSIX paths relative to the project root */
function fileSet() {
  try {
    const out = runCmd('git ls-files --cached --others --exclude-standard', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const list = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (list.length > 0) return [...new Set(list.map(toPosix))]
  } catch {
    // no git, shallow clone, or not a work tree — fall through to the walk
  }
  // Fallback walk. `.env*` is excluded by NAME here for the reason git's exclude-standard
  // handles above: a real local env file is not a finding, it is the point.
  return walkFiles('.', { excludeDirs: EXCLUDE_DIRS }).filter((p) => !/(^|\/)\.env($|\.)/.test(p))
}

const allowPaths = (policy.allowPaths ?? []).map((p) => new RegExp(p))
const files = fileSet().filter((p) => {
  if (allowPaths.some((re) => re.test(p))) return false
  if ([...EXCLUDE_DIRS].some((d) => p === d || p.startsWith(`${d}/`) || p.includes(`/${d}/`)))
    return false
  return true
})

// "No findings over no input" is the exact shape of a green that means nothing.
if (files.length === 0) {
  fail(
    GATE,
    'the scan found ZERO files to read. A clean result over an empty input set is not a clean tree — it is a broken file enumeration. Check that this is a git work tree with content.',
  )
}

// ── 3. per-finding acceptances (tolerated-absent) ──────────────────────────────
/** @type {Array<{ path?: string, rule?: string, reason?: string }>} */
let accepted = []
if (existsSync(ACCEPT)) {
  try {
    const parsed = JSON.parse(readFileSync(ACCEPT, 'utf8'))
    accepted = Array.isArray(parsed.allow) ? parsed.allow : []
  } catch (e) {
    fail(
      GATE,
      `${ACCEPT} is not valid JSON (${e.message}) — an unparseable acceptance file cannot fail open`,
    )
  }
  for (const a of accepted) {
    if (typeof a?.reason !== 'string' || a.reason.trim().length < 10) {
      fail(
        GATE,
        `${ACCEPT}: every acceptance needs a real \`reason\` (>= 10 chars) — an empty reason is an acceptance nobody reviewed. Offending entry: ${JSON.stringify(a)}`,
      )
    }
  }
}
const isAccepted = (path, rule) =>
  accepted.some((a) => a.path === path && (a.rule === undefined || a.rule === rule))

// ── 4. the scan ────────────────────────────────────────────────────────────────
// Text only, and bounded: a 5 MB ceiling keeps a vendored fixture or a large lockfile
// from turning a ~200ms gate into a stall, and binary content is skipped by the NUL probe
// rather than by an extension list that would need maintaining.
const MAX_BYTES = 5 * 1024 * 1024
const errs = []
let scanned = 0
for (const path of files) {
  let raw
  try {
    if (statSync(path).size > MAX_BYTES) continue
    raw = readFileSync(path)
  } catch {
    continue // vanished mid-run, or a directory entry from a stale index
  }
  if (raw.includes(0)) continue // binary
  const text = raw.toString('utf8')
  scanned += 1
  for (const rule of compiled) {
    rule.re.lastIndex = 0
    for (const m of text.matchAll(rule.re)) {
      const hit = m[0]
      if (rule.allow.some((a) => a.test(hit))) continue
      if (isAccepted(path, rule.id)) continue
      const line = text.slice(0, m.index).split('\n').length
      // The finding NEVER echoes the matched value — a gate that prints the credential it
      // found has copied it into the CI log, the Stop block and the transcript.
      errs.push(
        `${path}:${String(line)} — ${rule.id}: ${rule.description} (${String(hit.length)} chars, value withheld)`,
      )
    }
  }
}

failures(
  GATE,
  errs,
  `Remove the credential and ROTATE it — a secret that reached the working tree must be assumed disclosed. Secrets are injected at runtime (see .env.example) and live in the EAS/CI/Supabase secret store. If a finding is genuinely a fixture or a documented local-development value, prefer making the VALUE say so (the allowlists in ${PATTERNS} key on words like "example" and "placeholder"); a per-finding acceptance in ${ACCEPT} is the last resort and must be committed.`,
)
ok(
  GATE,
  `${String(scanned)} file(s) scanned against ${String(compiled.length)} credential shape(s), all self-tested; rule ids in lockstep with ${GITLEAKS}${accepted.length > 0 ? `; ${String(accepted.length)} reviewed acceptance(s)` : ''}`,
)
