// Staged register edits (1.1.0, #65): the data half of `apply-proposal`, and what `doctor`
// reads to list the pending ones.
//
// An agent may not write a reviewed register under tools/ (the write guard denies it), and
// before 1.1.0 it had no way to hand a human the edit except as prose. It now writes the
// WHOLE proposed file as one JSON document in harness-proposals/, a committed directory that
// no deny layer names, and a human applies it with `apply-proposal <id>`:
//
//   { "version": 1, "target": "tools/<register>.json", "reason": "…",
//     "base": "<git rev-parse HEAD:<target>, or null when the target is not in HEAD>",
//     "content": "<the whole proposed file>" }
//
// Nothing here writes. Zero dependencies, like everything under installer/.
// SOURCE: docs/harness/README.md (tamper evidence; proposing a register edit)
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

// Outside `.harness/`, `tools/`, `.claude/` and every other path the settings deny list, the
// write guard's WRITE_PROTECTED or the bash guard's PROT_DIRS names, so staging a proposal
// narrows no deny layer, and committed rather than gitignored, so it survives a fresh clone
// and is reviewed in the pull request. tests/hooks/hook-contract.test.mjs holds all three.
export const PROPOSALS_DIR = 'harness-proposals'

// The registers a proposal may target. The installer never imports a template module (see
// lib/fs-walk.mjs), so this is a COPY, and scripts/check-escape-registry.mjs reconciles it
// as the fourth list: tools/lib/enforcement-surface.mjs#ESCAPE_LISTS, plus the `advisory`
// members of its KINDS map (tools/field-notes.json), minus its NOT_PROPOSABLE map, which
// holds the two baselines only their generators write (tools/perf-baseline.json,
// tools/mutation-baseline.json). Owned files, the agent surface, settings, and the pin,
// hash and generated kinds are never in it.
export const PROPOSABLE = Object.freeze([
  'tools/rls-exempt.json',
  'tools/tenancy.json',
  'tools/security-definer-allow.json',
  'tools/audit-columns.json',
  'tools/pii-columns.json',
  'tools/db-limits.json',
  'tools/data-flow.json',
  'tools/reviewer-triggers.json',
  'tools/security-headers.json',
  'tools/rate-limit-budget.json',
  'tools/db-perf-baseline.json',
  'tools/provenance-overrides.json',
  'tools/decision-groups.json',
  'tools/mcp/corpus/project.json',
  'tools/license-exceptions.json',
  'tools/eol.json',
  'tools/backup-posture.json',
  'tools/route-allowlist.json',
  'tools/web-route-allowlist.json',
  'tools/dto-bounds-allow.json',
  'tools/observability.json',
  'tools/suppressions-allow.json',
  'tools/resilience.json',
  'tools/support-register.json',
  'tools/surfaces.json',
  'tools/mutation-scope-extra.json',
  'tools/auth-tunables.json',
  'tools/store-tunables.json',
  'tools/duplication-allow.json',
  'tools/vertical-anatomy-allow.json',
  'tools/i18n-allow.json',
  'tools/expo-permissions.json',
  'tools/expo-plugins.json',
  'tools/perf-budget.json',
  'tools/interaction-budget.json',
  'tools/startup-budget.json',
  'tools/bundle-budget.json',
  'tools/styleguide.manifest.json',
  'tools/test-quality-allow.json',
  'tools/approved-tools.json',
  'tools/retrofit-accept.json',
  'tools/secret-scan-allow.json',
  'tools/migrations-allow.json',
  'tools/field-notes.json',
])

// A proposal id is the file's name without `.json`: plain enough to type, and to print.
export const PROPOSAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const FIELDS = ['version', 'target', 'reason', 'base', 'content']
const BLOB_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

// The characters that can make a terminal show something other than the bytes: C0 and C1
// controls other than tab, newline and carriage return (an escape sequence can erase or
// rewrite the diff line above it), and the bidirectional formatting characters (they
// reorder what is shown). Matched by code point, not by a regex literal with control
// characters in it.
/** @param {number} cp */
function hidesText(cp) {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true
  return cp === 0x061c || cp === 0x200e || cp === 0x200f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)
}

/** @param {string} text */
export const unsafeForTerminal = (text) => [...text].some((ch) => hidesText(ch.codePointAt(0) ?? 0))

/** Replace every such character, for a line printed without refusing (the listing). @param {string} text */
const printable = (text) => [...text].map((ch) => (hidesText(ch.codePointAt(0) ?? 0) ? '?' : ch)).join('')

/** @param {string} root @param {string} path */
export function isInside(root, path) {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * The real path of `path`, or of its nearest existing ancestor with the rest appended: where
 * a write to `path` would land, even when the file does not exist yet.
 * @param {string} path
 */
export function landingPath(path) {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  if (parent === path) return path
  return resolve(landingPath(parent), relative(parent, path))
}

/**
 * Parse one proposal file's text. Shape only: whether the target is proposable, and the git
 * state of the tree, are the verb's questions.
 * @param {string} text
 * @returns {{ proposal: { version: 1, target: string, reason: string, base: string | null, content: string } } | { problem: string }}
 */
export function parseProposal(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { problem: 'is not JSON' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { problem: 'is not a JSON object' }
  const unknown = Object.keys(value).find((k) => !FIELDS.includes(k))
  if (unknown !== undefined) return { problem: `has an unknown field ${JSON.stringify(printable(unknown))}` }
  const problem = shapeProblem(value)
  return problem === null ? { proposal: value } : { problem }
}

/** @param {Record<string, unknown>} v @returns {string | null} */
function shapeProblem(v) {
  if (v.version !== 1) return 'is not a version 1 proposal: version must be 1'
  if (typeof v.target !== 'string' || v.target === '') return 'has no target: target must be a path such as tools/i18n-allow.json'
  if (typeof v.reason !== 'string' || v.reason.trim() === '') return 'has no reason: reason must be a non-empty string'
  if (v.base !== null && (typeof v.base !== 'string' || !BLOB_ID.test(v.base))) {
    return 'has a malformed base: base must be the output of `git rev-parse HEAD:<target>`, or null'
  }
  if (typeof v.content !== 'string') return 'has no content: content must be the whole proposed file as a string'
  return null
}

/**
 * The pending proposals under `dir`, one entry per `.json` file in harness-proposals/.
 * @param {string} dir
 * @returns {{ file: string, id: string | null, target?: string, reason?: string, problem?: string }[]}
 */
function pendingProposals(dir) {
  const root = resolve(dir, PROPOSALS_DIR)
  let names = []
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
  return names.map((name) => describe(root, name))
}

/** @param {string} path @returns {string | null} */
export function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** @param {string} root @param {string} name */
function describe(root, name) {
  const id = name.slice(0, -'.json'.length)
  const file = `${PROPOSALS_DIR}/${printable(name)}`
  if (!PROPOSAL_ID.test(id)) return { file, id: null, problem: 'is not named like a proposal id (letters, digits, ".", "_" and "-")' }
  const text = readText(resolve(root, name))
  if (text === null) return { file, id, problem: 'cannot be read' }
  const parsed = parseProposal(text)
  if ('problem' in parsed) return { file, id, problem: parsed.problem }
  const { target, reason } = parsed.proposal
  if (!PROPOSABLE.includes(target)) return { file, id, problem: `targets ${printable(target)}, which is outside the proposable set` }
  return { file, id, target, reason: printable(reason.replace(/\s+/g, ' ').trim()).slice(0, 160) }
}

/**
 * One line per pending proposal, for `doctor` and for `apply-proposal` with no id.
 * @param {string} dir
 */
export function proposalLines(dir) {
  return pendingProposals(dir).map((p) =>
    p.problem === undefined
      ? `${p.file} proposes ${p.target}: ${p.reason} — a human applies it with \`npx next-expo-supabase-agent-harness apply-proposal ${p.id}\` in a terminal, or deletes it`
      : `${p.file} ${p.problem}; \`apply-proposal\` will refuse it — fix or delete it`,
  )
}
