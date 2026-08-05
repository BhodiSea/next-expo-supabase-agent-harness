#!/usr/bin/env node
// Gate: test-quality (G09, agent-time half) — a test that asserts nothing, and a test that
// does not run, are both a coverage number pretending to be a guarantee.
//
// The harness's floors all measure EXECUTION: coverage counts lines a test touched, and the
// per-file floors count them per file. Neither can see that the test body has no `expect`.
// And test bodies are content-check-exempt in the write-guard (an agent may write them
// freely, by design — that is what makes them writable at all), so nothing else looks.
//
// THIS GATE IS THE CHEAP HALF, AND IT IS GAMEABLE ALONE — `expect(true).toBe(true)` satisfies
// it. The PRIMARY control is the mutation lane (tools/check-mutation-ratchet.mjs), which
// asks the only question that cannot be faked: change the code, does a test go red? This
// gate exists because mutation is CI-only (minutes), and an agent should not be able to end
// a TURN with an assertion-free test — it catches the blatant case in ~50ms, in the Stop
// chain, where the mutation lane cannot go.
//
// Three findings, and the first is the sharp one:
//   1. `.only`  — a single committed `.only` silently disables THE ENTIRE REST OF THE SUITE
//                 while every gate stays green. There is no legitimate reason to commit one,
//                 so it is fatal with NO escape hatch.
//   2. `.skip` / `.todo` / `.failing` / `xit` — a declared test that never runs. Reviewable
//                 via tools/test-quality-allow.json (a reason is mandatory).
//   3. a test body with NO assertion call at all.
//
// Both unit runners in this stack — vitest (server, packages, the RLS suites) and jest-expo
// (apps/mobile components/screens) — share the it/test/expect grammar, so ONE scan covers
// every suite.
//
// NOT a floor step (the 21-gate floor is frozen): a Stop-chain step and a blocking CI lane.
// Ramped — an install whose baseVersion predates the check gets a NOTE, not an ambush; in
// this lineage it ships in 0.1.0, so it is live from the first install.
// SOURCE: docs/harness/gates-catalog.md (test-quality) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, rampNote } from './lib/gate.mjs'
import { blankComments, lineOf, skipBalanced } from './lib/source-text.mjs'

const GATE = 'test-quality'
const ALLOW = 'tools/test-quality-allow.json'

const ROOTS = ['apps', 'packages', 'e2e', 'tests']
const IS_TEST = /\.(?:test|spec)\.tsx?$/

// An assertion is any call whose name STARTS with expect/assert — `expect(x).toBe(y)`,
// `expect.soft(...)`, `assert.equal(...)`, `expectTypeOf(...)`, and the helper functions real
// suites factor out (`assertRouteIsClean(screen)`, `expectNoViolations(results)`). Deliberately
// generous: this layer's job is catching the EMPTY test body, not adjudicating assertion
// style, and a false red here would just push people to write worse tests.
//
// The optional `<…>` is the TYPE-ARGUMENT form, and it is not cosmetic: a pure type test
// reads `expectTypeOf<Payload>().toEqualTypeOf<Other>()`, where the `<` sits exactly where
// a call paren would be. Without this branch every type-only test in the tree scored as
// "contains NO assertion" — which is what the shipped platform/events suite did.
// The generic must be attached with NO leading space, so an ordinary comparison
// (`expected < 5`) cannot masquerade as a call; `[^;{}()]*` is greedy so nested type
// arguments (`expectTypeOf<Foo<Bar>>()`) still close on the final `>`.
const ASSERTION = /\b(?:expect|assert)\w*(?:<[^;{}()]*>)?\s*[.(]/

// `it(` / `test(` — and `it.each(table)(...)`, whose test body is in the SECOND call.
// Deliberately does NOT match `test.step(`, `test.describe(`, or `test.extend(`.
const TEST_DECL = /\b(?:it|test)\s*(?:\.\s*each\s*)?\(/g

// A DISABLED test is the MODIFIER form — a string title plus a body. It is not the same
// construct as a RUNTIME conditional skip, `test.skip(condition, reason)` — the form
// data-driven suites use ("skip unless the database is ready"); browser-e2e runners rely
// on it too, and this stack's runners (vitest + jest-expo) express the same intent via
// ternaries over the describe/it references, which never match a call-form scan. Those
// are a feature, not rot. The discriminator is the first argument: a string LITERAL is a
// test title; anything else is a condition.
const DISABLED = /\b(?:it|test|describe)\s*\.\s*(skip|todo|failing)\s*\(/g
const FOCUSED = /\b(?:it|test|describe)\s*\.\s*only\s*\(/g
const X_PREFIXED = /\b(xit|xdescribe|fit|fdescribe)\s*\(/g

const FIRST_ARG_IS_TITLE = /^\(\s*(['"`])/

// ---- reviewed exemptions -------------------------------------------------------------
// Keyed by `<file>::<test title>` — the TITLE, not a line number, so an entry survives the
// file being reformatted or a test being moved. A stale entry (its file is gone, e.g. an
// opt-in module this tier does not install) is ignored, not an error.
const allow = new Map()
if (existsSync(ALLOW)) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(ALLOW, 'utf8'))
  } catch (e) {
    fail(GATE, `${ALLOW} is not valid JSON (${e.message}) — the exemption list must be reviewable`)
  }
  if (!Array.isArray(parsed.allow)) {
    fail(GATE, `${ALLOW} must carry an "allow" ARRAY of {"test": string, "reason": string}`)
  }
  for (const entry of parsed.allow) {
    const okShape =
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.test === 'string' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim() !== ''
    if (!okShape) {
      fail(
        GATE,
        `${ALLOW}: every entry must be {"test": string, "reason": NON-EMPTY string} — got ${JSON.stringify(entry)}`,
      )
    }
    allow.set(entry.test, entry.reason)
  }
}

/**
 * The title argument of a call whose `(` sits at `open`, or '' when it is not a literal.
 * Skips ANY whitespace after the paren, not just one space: a long title is routinely wrapped
 * onto its own line (`it.todo(\n  'a very long title',\n)`), and reading only src[open + 1]
 * yielded an EMPTY title for exactly those — which silently made them unallowlistable.
 */
function titleAt(src, open) {
  let i = open + 1
  while (i < src.length && /\s/.test(src[i])) i += 1
  const quote = src[i]
  if (quote !== "'" && quote !== '"' && quote !== '`') return ''
  return src.slice(i + 1, skipDelimitedTitle(src, i, quote)).trim()
}

function skipDelimitedTitle(src, i, quote) {
  let j = i + 1
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2
      continue
    }
    if (src[j] === quote) return j
    j += 1
  }
  return src.length
}

/** The full argument text of the call opening at `open` — including a chained `(...)`. */
function callArgs(src, open) {
  const end = skipBalanced(src, open)
  let text = src.slice(open, end)
  // `it.each(table)(name, fn)` — the body lives in the SECOND argument list.
  const next = src.slice(end).match(/^\s*\(/)
  if (next !== null) {
    const second = end + next[0].length - 1
    text += src.slice(second, skipBalanced(src, second))
  }
  return text
}

// ---- scan ----------------------------------------------------------------------------
const errs = []
let scanned = 0
let tests = 0

for (const root of ROOTS) {
  if (!existsSync(root)) continue
  for (const rel of walkFiles(root, { filter: (p) => IS_TEST.test(p) })) {
    const path = `${root}/${rel}`
    const raw = readFileSync(path, 'utf8')
    const src = blankComments(raw)
    scanned += 1

    for (const m of src.matchAll(FOCUSED)) {
      errs.push(
        `${path}:${String(lineOf(src, m.index))} — \`${m[0].trim()}\` is committed. A focused test silently DISABLES EVERY OTHER TEST in the run while the suite still reports green. There is no reviewed escape for this: remove it.`,
      )
    }

    for (const m of src.matchAll(X_PREFIXED)) {
      const open = m.index + m[0].length - 1
      const title = titleAt(src, open)
      const key = `${path}::${title}`
      if (allow.has(key)) continue
      errs.push(
        `${path}:${String(lineOf(src, m.index))} — \`${m[1]}(\` declares a test that never runs ("${title}"). Delete it or fix it; if it must stay, add {"test": ${JSON.stringify(key)}, "reason": …} to ${ALLOW}.`,
      )
    }

    for (const m of src.matchAll(DISABLED)) {
      const open = m.index + m[0].length - 1
      // A RUNTIME conditional skip — `test.skip(!READY, 'reason')` — is a different
      // construct and legitimate. Only the modifier form (a string TITLE) declares a
      // dead test.
      if (!FIRST_ARG_IS_TITLE.test(src.slice(open))) continue
      const title = titleAt(src, open)
      const key = `${path}::${title}`
      if (allow.has(key)) continue
      errs.push(
        `${path}:${String(lineOf(src, m.index))} — \`.${m[1]}\` declares a test that never runs ("${title}"). A skipped test is a hole in the net that every coverage number still counts as covered. Fix it, delete it, or add {"test": ${JSON.stringify(key)}, "reason": …} to ${ALLOW} (reviewed).`,
      )
    }

    for (const m of src.matchAll(TEST_DECL)) {
      const open = m.index + m[0].length - 1
      const args = callArgs(src, open)
      const title = titleAt(src, open)
      if (title === '') continue // a computed title — not a shape this scan adjudicates
      tests += 1
      if (ASSERTION.test(args)) continue
      const key = `${path}::${title}`
      if (allow.has(key)) continue
      errs.push(
        `${path}:${String(lineOf(src, m.index))} — the test "${title}" contains NO assertion. It executes code and reports success no matter what that code does — it raises the coverage number and guarantees nothing. Assert something, or add {"test": ${JSON.stringify(key)}, "reason": …} to ${ALLOW}.`,
      )
    }
  }
}

if (scanned === 0) {
  ok(GATE, 'no test files found to scan')
}

// Ramp: an install predating this check carries tests it never held them to — NOTE, don't
// ambush the update. In this lineage the check ships in 0.1.0: every fresh scaffold is
// turn-fatal.
if (
  errs.length > 0 &&
  rampNote(GATE, '0.1.0', `${String(errs.length)} test-quality finding(s)`, { until: '0.4.0' })
) {
  for (const e of errs) console.log(`  - ${e}`)
  ok(GATE, `${String(errs.length)} finding(s) held as a ramp NOTE (pre-0.1.0 baseVersion)`)
}

failures(
  GATE,
  errs,
  '  Assertion PRESENCE is the floor, not the bar — `expect(true).toBe(true)` clears it. What proves a test would notice the code breaking is the mutation lane (docs/harness/gates-catalog.md, "mutation-ratchet").',
)
ok(GATE, `${String(tests)} test(s) across ${String(scanned)} file(s): all assert, none disabled`)
