// tools/lib/agent-roster.mjs — the agent roster's frontmatter grammar and the
// reviewer read-only policy, shared by the docs-sync gate
// (tools/check-docs-sync.mjs) and, in the harness repo, the repo-side mirror
// (scripts/check-plugin-manifest.mjs) — one parser, one allowlist, no second copy.
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
// (design/CONTROL-PLANE-FACTS.md, Fact 15). The file hash in tools/agents.lock.json covers it;
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
