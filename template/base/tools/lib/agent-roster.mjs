// tools/lib/agent-roster.mjs — the agent roster's frontmatter grammar and the
// reviewer read-only policy, shared by the docs-sync gate
// (tools/check-docs-sync.mjs) and, in the harness repo, the repo-side mirror
// (scripts/check-plugin-manifest.mjs) — one parser, one allowlist, no second copy.
// Since 1.1.0 it also holds the one definition of where a reviewer body's verdict
// demand must sit (verdictDemandProblem, at the end of this file), which docs-sync
// runs over every install and the harness's own tests run over the shipped bodies.
//
// parseFrontmatter is a dependency-free YAML SUBSET, deliberately NOT a YAML
// implementation. The grammar is pinned to what the shipped agent files use
// plus obvious variants: top-level `key: value` scalars (optionally quoted),
// `key: >`/`key: |` block scalars (indented continuation lines; `-`/`+` chomping
// suffixes accepted), comma-separated inline lists (optionally [bracketed] —
// split via splitList), `#` comment lines, and blank lines. ANYTHING ELSE IS A
// PARSE ERROR the caller must surface as a red: an unreadable roster fails
// CLOSED — skipping it would let a malformed reviewer hide a write grant.
// SOURCE: docs/harness/README.md (adversarial review: reviewers are read-only
// by construction) [corpus: harness/doctrine]

// The reviewer agents the README claims are "read-only by construction".
export const REVIEWER_AGENTS = [
  'accessibility-reviewer',
  'architecture-reviewer',
  'citation-verifier',
  'design-reviewer',
  'mobile-security-reviewer',
  'security-reviewer',
  'torvalds-reviewer',
  'web-security-reviewer',
]

// The security reviewers (1.1.0, #62): the reviewers whose PASS counts only on a model their
// hash-locked agent file names, the pin or an entry of its fallback list. Every other
// reviewer's verdict on another model still counts, and is named at Stop.
export const SECURITY_REVIEWERS = [
  'mobile-security-reviewer',
  'security-reviewer',
  'web-security-reviewer',
]

// The fallback list's frontmatter key (1.1.0, #62): `harnessFallbackModels: fable, <full id>`,
// an inline list read with splitList. Claude Code ignores a key it does not recognize, and
// the prefix keeps any future Claude Code field from taking this name, so Claude Code never
// acts on the list: it is what reviewer-verdicts judges a verdict's recorded model against
// (design/CONTROL-PLANE-FACTS.md, Fact 16). The file hash in tools/agents.lock.json covers it;
// the lock's `models` map keeps the pin alone.
export const FALLBACK_MODELS_KEY = 'harnessFallbackModels'

/**
 * An agent file's model policy: its pin and its fallback list, or null when the frontmatter
 * does not parse. A file with no list has `fallbacks: []`; one with no `model` has `pin: null`.
 * @param {unknown} text the whole agent file
 * @returns {{ pin: string|null, fallbacks: string[] }|null}
 */
export function modelPolicy(text) {
  if (typeof text !== 'string') return null
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return null
  const pin = parsed.data.model?.trim()
  return { pin: pin ? pin : null, fallbacks: splitList(parsed.data[FALLBACK_MODELS_KEY]) }
}

/**
 * What is wrong with an agent's fallback list, one sentence each: [] when the list is absent
 * or well formed. A list that is present must name at least one model and name each one once;
 * the pin counts as an entry, compared case-insensitively.
 * @param {any} fm parsed frontmatter data (parseFrontmatter's `data`)
 * @returns {string[]}
 */
export function fallbackListProblems(fm) {
  if (fm === undefined || fm === null || !Object.hasOwn(fm, FALLBACK_MODELS_KEY)) return []
  const entries = splitList(fm[FALLBACK_MODELS_KEY])
  if (entries.length === 0) {
    return [
      `'${FALLBACK_MODELS_KEY}' is present but lists no model — name at least one (\`${FALLBACK_MODELS_KEY}: fable\`), or delete the key and let the pin alone count`,
    ]
  }
  const seen = new Set([
    String(fm.model ?? '')
      .trim()
      .toLowerCase(),
  ])
  const problems = []
  for (const e of entries) {
    const key = e.toLowerCase()
    if (seen.has(key)) {
      problems.push(
        `'${FALLBACK_MODELS_KEY}' repeats '${e}' — each model is named once, and the pin already counts`,
      )
    }
    seen.add(key)
  }
  return problems
}

// Genuinely read-only capabilities ONLY: file reads/searches, documentation
// fetches, and the two read-only MCP probes the roster ships (`rls_verify` is a
// transaction-local isolation probe; `corpus_search` is a corpus lookup —
// neither can write or execute). Bash/Write/Edit/Task NEVER belong here:
// widening this list weakens the README claim, so it is a human decision (the
// file is write-guard-protected like every tools/lib helper).
export const REVIEWER_READONLY_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'mcp__rls_verify',
  'mcp__corpus_search',
]

function unquote(v) {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) {
    return v.slice(1, -1)
  }
  return v
}

// Returns { ok: true, data } or { ok: false, error } — never throws, never
// guesses. Folded (`>`) continuation lines join with a space, literal (`|`)
// with a newline; callers here assert content, not layout, so paragraph-break
// fidelity is deliberately out of scope.
// eslint-disable-next-line sonarjs/cognitive-complexity -- ceiling is machine-enforced by scripts/complexity-ratchet.json (G16); this directive only silences the rule, the ratchet is what stops the score growing
export function parseFrontmatter(text) {
  const lines = String(text)
    .replace(/^\uFEFF/, '') // strip a BOM so it cannot hide the opening `---`
    .split(/\r?\n/)
  if ((lines[0] ?? '').trimEnd() !== '---') {
    return { ok: false, error: 'no frontmatter block — the file must open with `---` on line 1' }
  }
  const data = {}
  let i = 1
  while (i < lines.length) {
    const lineNo = i + 1
    const line = lines[i].trimEnd()
    if (line === '---') return { ok: true, data }
    i += 1
    const bare = line.trim()
    if (bare === '' || bare.startsWith('#')) continue
    if (/^[ \t]/.test(line)) {
      return {
        ok: false,
        error: `line ${String(lineNo)}: indented line outside a block scalar (nested maps and \`- \` sequences are outside the pinned grammar — use \`key: a, b, c\`)`,
      }
    }
    const m = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line)
    if (!m) {
      return { ok: false, error: `line ${String(lineNo)}: not a \`key: value\` line` }
    }
    const [, key, rawRest] = m
    if (Object.hasOwn(data, key)) {
      return { ok: false, error: `line ${String(lineNo)}: duplicate key '${key}'` }
    }
    const rest = rawRest.trim()
    if (/^[>|][+-]?$/.test(rest)) {
      // Block scalar: consume every following blank or indented line.
      const parts = []
      while (i < lines.length) {
        const cont = lines[i]
        if (cont.trim() !== '' && !/^[ \t]/.test(cont)) break
        if (cont.trim() !== '') parts.push(cont.trim())
        i += 1
      }
      data[key] = parts.join(rest.startsWith('>') ? ' ' : '\n')
      continue
    }
    data[key] = unquote(rest)
  }
  return { ok: false, error: 'unterminated frontmatter — no closing `---`' }
}

// Inline list: `Read, Grep, Glob` or `[Read, Grep, Glob]`, entries optionally
// quoted. Empty/absent values split to [].
export function splitList(value) {
  let v = String(value ?? '').trim()
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1)
  return v
    .split(',')
    .map((s) => unquote(s.trim()))
    .filter((s) => s !== '')
}

// ── THE SEVERITY CONTRACT (1.1.0, #71) ──────────────────────────────────────────────────
// Every reviewer body states which severities it ranks findings at and which of them make
// the verdict BLOCK, each on a line of its own, before its closing verdict paragraph:
//
//   Severities: CRITICAL, HIGH, MEDIUM, LOW
//   Blocking: CRITICAL, HIGH
//
// Two readers. The SubagentStop hook takes the Blocking line and sends back a PASS that
// lists a finding at one of those severities. docs-sync holds both lines to their shape,
// behind its 1.1.0 ramp. The lines are anchored to the start of a line, like the verdict
// grammar, and read from the BODY only, so a frontmatter key of the same name states
// nothing. They are parsed here, not in parseFrontmatter, which the complexity ratchet
// already holds at its ceiling.

// The severities every reviewer's Blocking line must include: the shipped policy. A narrower
// line would let a HIGH finding ride a PASS, which is the downgrade the floor refuses. A
// wider one blocks on more, which is the body's own business.
export const BLOCKING_FLOOR = ['CRITICAL', 'HIGH']

const CONTRACT_LINE = /^(Severities|Blocking):(.*)$/

/**
 * An agent file's body lines: everything after its frontmatter block, the whole text when
 * it has none, and nothing when the block never closes (parseFrontmatter reds that).
 * @param {unknown} text
 */
function bodyLines(text) {
  const lines = String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
  if ((lines[0] ?? '').trimEnd() !== '---') return lines
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---')
  return close === -1 ? [] : lines.slice(close + 1)
}

/** `critical , High` → ['CRITICAL', 'HIGH']: trimmed, upper-cased, blanks dropped. */
const severityList = (value) =>
  value
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== '')

/**
 * An agent body's severity contract. Each list is the union of every line of its key, in
 * first-seen order, or null when the body has no such line; `repeated` names each key stated
 * more than once. The union is the strict reading for the hook, because a second
 * `Blocking:` line can only add severities that block, and docs-sync reds the repetition.
 * @param {unknown} text the whole agent file
 * @returns {{ severities: string[]|null, blocking: string[]|null, repeated: string[] }}
 */
export function severityContract(text) {
  /** @type {Record<string, string[]|null>} */
  const found = { Severities: null, Blocking: null }
  const repeated = []
  for (const line of bodyLines(text)) {
    const m = CONTRACT_LINE.exec(line.trimEnd())
    if (m === null) continue
    const [, key, value] = m
    if (found[key] !== null && !repeated.includes(key)) repeated.push(key)
    found[key] = [...new Set([...(found[key] ?? []), ...severityList(value)])]
  }
  return { severities: found.Severities, blocking: found.Blocking, repeated }
}

/**
 * What is wrong with a reviewer body's severity contract, one sentence each, [] when it is
 * whole: both lines present, each stated once, Blocking a subset of Severities, and Blocking
 * holding every BLOCKING_FLOOR severity.
 * @param {unknown} text the whole agent file
 * @returns {string[]}
 */
export function severityContractProblems(text) {
  const { severities, blocking, repeated } = severityContract(text)
  const problems = []
  if (severities === null) {
    problems.push(
      'no `Severities:` line — the body must list, on a line of its own, the severities it ranks findings at (`Severities: CRITICAL, HIGH, MEDIUM, LOW`)',
    )
  }
  if (blocking === null) {
    problems.push(
      'no `Blocking:` line — the body must say, on a line of its own, which severities make its verdict BLOCK (`Blocking: CRITICAL, HIGH`); without it the SubagentStop hook cannot hold a PASS to the findings it lists',
    )
    return [...problems, ...repeated.map(repeatedLine)]
  }
  problems.push(...repeated.map(repeatedLine))
  const outside = blocking.filter((s) => severities !== null && !severities.includes(s))
  if (outside.length > 0) {
    problems.push(
      `\`Blocking:\` names ${outside.join(', ')}, which \`Severities:\` does not list — Blocking must be a subset of Severities`,
    )
  }
  const missing = BLOCKING_FLOOR.filter((s) => !blocking.includes(s))
  if (missing.length > 0) {
    problems.push(
      `\`Blocking:\` omits ${missing.join(', ')} — every reviewer blocks on at least ${BLOCKING_FLOOR.join(', ')}; a narrower line lets a finding at that severity ride a PASS`,
    )
  }
  return problems
}

/** @param {string} key */
const repeatedLine = (key) => `\`${key}:\` is stated more than once — state it on one line`

// ── THE VERDICT DEMAND CLOSES THE BODY (1.1.0, #72) ─────────────────────────────────────
// A reviewer body must END by demanding the verdict line, because the SubagentStop hook
// reads a PASS only as the reply's terminal line. v1.0.1 shipped two bodies that carried
// the demand and then asked for "the top 3 fixes" after it, in the same paragraph: every
// review that obeyed its own body was bounced, and a presence test passed both.
//
// The rule, on a body trimmed, split into paragraphs on blank (or whitespace-only) lines
// and whitespace-collapsed: the LAST paragraph is exactly VERDICT_DEMAND, optionally
// followed by VERDICT_DEMAND_RATIONALE, the sentence every shipped body carries after it.
// Nothing else may share that paragraph or follow it. One limit, stated in the catalog: an
// EARLIER paragraph that asks for text after the verdict is not judged here; the hook still
// bounces a PASS reply that obeys it (docs/harness/gates-catalog.md, docs-sync).
export const VERDICT_DEMAND =
  'End with exactly one final line: `VERDICT: PASS` or `VERDICT: BLOCK`.'
const VERDICT_DEMAND_RATIONALE =
  'The prefix is what makes the outcome machine-readable — a bare `PASS` can occur anywhere in prose, so a caller (or a future receipt gate) cannot tell a verdict from a sentence.'
// The 1.0.x presence test, verbatim: 'absent' is judged exactly as it always was.
const DEMAND_PRESENCE = /`VERDICT: PASS`\s+or\s+`VERDICT: BLOCK`/
const CLOSINGS = new Set([VERDICT_DEMAND, `${VERDICT_DEMAND} ${VERDICT_DEMAND_RATIONALE}`])

/**
 * Where a reviewer body stands on the verdict demand. Pure; never throws.
 *   'absent'      — the body never asks for `VERDICT: PASS` or `VERDICT: BLOCK`;
 *   'not-closing' — it asks, but its last paragraph is not the demand (plus, optionally,
 *                   the shipped rationale sentence);
 *   null          — it closes on the demand.
 * @param {unknown} body the whole file, frontmatter included; CRLF is accepted
 * @returns {'absent' | 'not-closing' | null}
 */
export function verdictDemandProblem(body) {
  const text = typeof body === 'string' ? body : ''
  if (!DEMAND_PRESENCE.test(text.replace(/\s+/g, ' '))) return 'absent'
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n[ \t]*\n/)
  const last = (paragraphs.at(-1) ?? '').replace(/\s+/g, ' ').trim()
  return CLOSINGS.has(last) ? null : 'not-closing'
}
