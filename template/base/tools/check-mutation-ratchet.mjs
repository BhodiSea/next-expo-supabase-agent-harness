#!/usr/bin/env node
// Gate: mutation-ratchet (G09) — the assertion-quality control. Coverage measures whether a
// test EXECUTED a line; mutation measures whether it would NOTICE that line breaking. The
// difference is not academic: on the v0.1.5 exemplar every gate was green, coverage floors
// passed, and the auth module's algorithm allowlist could be emptied without a single test
// failing.
//
// SET-BASED, not score-based. A mutation SCORE threshold lets quality churn silently (kill
// three mutants here, birth three survivors there — same score, worse net) and is either
// vacuous or a permanent red light. This compares the exact SET of surviving mutants against
// a committed, human-reasoned baseline (tools/mutation-baseline.json — write-guard-protected
// and hashed by gate-integrity):
//   - a survivor NOT in the baseline            -> FAIL (kill it with a test, or a human
//                                                  records it WITH A REASON, eyes open)
//   - a baseline survivor that no longer survives -> NOTE (tighten: --write)
//   - a baseline entry with an empty reason      -> FAIL (accepting a survivor is a
//                                                  reviewed act, not a rubber stamp)
//
// CI-ONLY. Never in the Stop chain: a full run is minutes, and the warm validate chain
// measures ~24s wall. The PR lane mutates only the CRITICAL files the PR touched (tools/mutation-scope.mjs);
// the nightly mutates the whole critical set.
//
// SURVIVOR IDENTITY IS POSITION-INDEPENDENT. Keying a survivor by file:line:column (the
// obvious choice, and what the pre-promotion module did) makes the baseline worthless: add
// one line at the top of a file and every entry below it becomes a "new" survivor. Identity
// here is (file, mutator, the ORIGINAL source span, the replacement, and an occurrence index
// among identical siblings) — stable under line shifts and reformatting, and it changes
// exactly when the mutated code changes, which is when a human SHOULD re-examine it.
//
// FILE-SCOPED COMPARISON. Only the files THIS report mutated are compared. A diff-scoped PR
// run reports one file; without this scoping every other file's baseline entries would look
// "no longer surviving" and --write would silently erase them.
// SOURCE: docs/harness/gates-catalog.md (mutation-ratchet) [corpus: harness/doctrine]
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fail, ok, skipOrFail } from './lib/gate.mjs'

const GATE = 'mutation-ratchet'
const REPORT = 'reports/mutation/mutation.json'
const BASELINE = 'tools/mutation-baseline.json'
const writeMode = process.argv.includes('--write')

// A mutant no test EXECUTES is strictly worse than one no test NOTICES — both are "our tests
// would not catch this", so both are survivors here.
const NOT_KILLED = new Set(['Survived', 'NoCoverage'])

const norm = (text) => text.replace(/\s+/g, ' ').trim()

/** The exact source the mutator replaced — the thing that makes identity position-free. */
function spanText(lines, loc) {
  const { start, end } = loc
  if (start.line === end.line) {
    return (lines[start.line - 1] ?? '').slice(start.column - 1, end.column - 1)
  }
  const head = (lines[start.line - 1] ?? '').slice(start.column - 1)
  const mid = lines.slice(start.line, end.line - 1)
  const tail = (lines[end.line - 1] ?? '').slice(0, end.column - 1)
  return [head, ...mid, tail].join('\n')
}

// ---- read the report ----------------------------------------------------------------
if (!existsSync(REPORT)) {
  fail(
    GATE,
    `${REPORT} missing — run the mutation lane first (\`pnpm mutation\`, or \`pnpm mutation:ci\` for the changed-files lane)`,
  )
}
let report
try {
  report = JSON.parse(readFileSync(REPORT, 'utf8'))
} catch (e) {
  fail(GATE, `${REPORT} is not valid JSON (${e.message})`)
}

const mutatedFiles = Object.keys(report.files ?? {})
if (mutatedFiles.length === 0) {
  ok(GATE, 'the report mutated no files (an empty diff scope) — nothing to ratchet')
}

const found = []
for (const [file, data] of Object.entries(report.files ?? {})) {
  const lines = String(data.source ?? '').split('\n')
  const seen = new Map()
  // Sort so the occurrence index of identical sibling mutants is deterministic.
  const mutants = [...(data.mutants ?? [])].sort(
    (a, b) =>
      a.location.start.line - b.location.start.line ||
      a.location.start.column - b.location.start.column,
  )
  for (const m of mutants) {
    if (!NOT_KILLED.has(m.status)) continue
    const original = norm(spanText(lines, m.location))
    const replacement = norm(String(m.replacement ?? ''))
    const base = `${file}\u0000${m.mutatorName}\u0000${original}\u0000${replacement}`
    const occurrence = seen.get(base) ?? 0
    seen.set(base, occurrence + 1)
    found.push({
      id: createHash('sha1')
        .update(`${base}\u0000#${String(occurrence)}`)
        .digest('hex')
        .slice(0, 12),
      file,
      mutator: m.mutatorName,
      original: original.slice(0, 120),
      replacement: replacement.slice(0, 120),
      // Informational only — NOT part of the identity, so a line shift never reds the gate.
      snippet: norm(lines[m.location.start.line - 1] ?? '').slice(0, 120),
      status: m.status,
      reason: '',
    })
  }
}

// ---- read the baseline --------------------------------------------------------------
if (!existsSync(BASELINE) && !writeMode) {
  skipOrFail(
    GATE,
    `${BASELINE} is absent — this install has not adopted the mutation ratchet. Seed it deliberately: run the lane, then \`node tools/check-mutation-ratchet.mjs --write\`, write a reason for every survivor, and commit (the file is write-guard-protected). Pull the template's: \`npx expo-postgres-agent-harness update --refresh-seeded tools/mutation-baseline.json\``,
  )
}

let baseline = []
if (existsSync(BASELINE)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(BASELINE, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${BASELINE} is not valid JSON (${e.message}) — the baseline must be reviewable data`,
    )
  }
  if (!Array.isArray(parsed.survivors)) {
    fail(GATE, `${BASELINE} must carry a "survivors" ARRAY — got ${typeof parsed.survivors}`)
  }
  baseline = parsed.survivors
}

// ---- --write: MERGE, never clobber ---------------------------------------------------
// Only the files this report mutated are rewritten; every other file's entries survive
// untouched (a diff-scoped run must not erase the rest of the baseline). Reasons already
// written by a human are preserved across regeneration.
if (writeMode) {
  const scoped = new Set(mutatedFiles)
  const priorReason = new Map(baseline.map((e) => [e.id, e.reason]))
  const kept = baseline.filter((e) => !scoped.has(e.file))
  const merged = [...kept, ...found.map((s) => ({ ...s, reason: priorReason.get(s.id) ?? '' }))]
  merged.sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id))
  const unexplained = merged.filter((e) => String(e.reason).trim() === '').length
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        '//': 'Surviving mutants this project has ACCEPTED. Every entry needs a reason — a survivor is a place your tests would not notice the code breaking, so accepting one is a deliberate, reviewed act (the gate FAILS on an empty reason). Regenerate with `node tools/check-mutation-ratchet.mjs --write`; identity is position-independent, so line shifts never invalidate an entry. This file is write-guard-protected and hashed by gate-integrity.',
        survivors: merged,
      },
      null,
      2,
    )}\n`,
  )
  console.log(
    `${GATE}: baseline written — ${String(merged.length)} survivor(s) across ${String(new Set(merged.map((e) => e.file)).size)} file(s); ${String(unexplained)} still need a reason. Fill every reason in, then commit it as a reviewed decision.`,
  )
  process.exit(0)
}

// ---- shape: a survivor is only "accepted" if a human said WHY -------------------------
const shapeErrors = []
for (const entry of baseline) {
  const okShape =
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.id === 'string' &&
    typeof entry.file === 'string' &&
    typeof entry.reason === 'string'
  if (!okShape) {
    shapeErrors.push(`malformed entry (needs id, file, reason): ${JSON.stringify(entry)}`)
    continue
  }
  if (entry.reason.trim() === '') {
    shapeErrors.push(
      `${entry.file} — mutant ${entry.id} (${String(entry.mutator)}: ${String(entry.snippet)}) is recorded with NO REASON. A survivor is a place your tests would not notice this code breaking. Kill it with a test, or write down why it is genuinely equivalent.`,
    )
  }
}
if (shapeErrors.length > 0) {
  console.error(`${GATE}: FAIL (${String(shapeErrors.length)}) — ${BASELINE} is not reviewable`)
  for (const e of shapeErrors) console.error(`  - ${e}`)
  fail(GATE, `${BASELINE} must justify every accepted survivor`)
}

// ---- compare, scoped to the files this run actually mutated ---------------------------
const scoped = new Set(mutatedFiles)
const accepted = new Set(baseline.map((e) => e.id))
const surviving = new Set(found.map((s) => s.id))

const fresh = found.filter((s) => !accepted.has(s.id))
const tightenable = baseline.filter((e) => scoped.has(e.file) && !surviving.has(e.id))
const stale = baseline.filter((e) => !existsSync(e.file))

if (stale.length > 0) {
  console.log(
    `${GATE}: NOTE — ${String(stale.length)} baseline entr(ies) name a file that no longer exists (a deleted file, or a module this tier does not install). Harmless; prune with --write on a full run.`,
  )
}
if (tightenable.length > 0) {
  console.log(
    `${GATE}: NOTE — ${String(tightenable.length)} accepted survivor(s) are now KILLED by your tests. Tighten the ratchet so they can never come back: \`node tools/check-mutation-ratchet.mjs --write\`\n  ${tightenable
      .map((e) => `${e.file} (${String(e.mutator)}: ${String(e.snippet)})`)
      .join('\n  ')}`,
  )
}

if (fresh.length > 0) {
  console.error(`${GATE}: FAIL (${String(fresh.length)}) — new surviving mutant(s)`)
  console.error(
    '  Your tests EXECUTE this code but would not NOTICE it breaking. Each line below is a change a machine made to your source that every test still passed.\n',
  )
  for (const s of fresh) {
    console.error(`  ${s.file}  [${s.status}]  ${s.mutator}`)
    console.error(`      ${s.snippet}`)
    console.error(`      change: ${s.original || '(block)'}  -->  ${s.replacement || '(removed)'}`)
  }
  fail(
    GATE,
    `${String(fresh.length)} mutant(s) survived that the baseline does not accept. Write a test that kills each one. If a mutant is genuinely EQUIVALENT (no behaviour can distinguish it — e.g. a redundant guard TypeScript needs but no input can reach), record it: \`node tools/check-mutation-ratchet.mjs --write\`, then write the reason. Accepting a survivor is a reviewed human act — ${BASELINE} is write-guard-protected`,
  )
}

ok(
  GATE,
  `${String(found.length)} survivor(s) across ${String(mutatedFiles.length)} mutated file(s), all within the committed baseline${
    tightenable.length > 0 ? ` (${String(tightenable.length)} ready to ratchet out)` : ''
  }`,
)
