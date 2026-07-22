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

// The six reviewer agents the README claims are "read-only by construction".
export const REVIEWER_AGENTS = [
  'accessibility-reviewer',
  'citation-verifier',
  'design-reviewer',
  'mobile-security-reviewer',
  'security-reviewer',
  'torvalds-reviewer',
]

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
