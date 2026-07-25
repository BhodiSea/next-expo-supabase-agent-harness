#!/usr/bin/env node
// PreToolUse / matcher: Edit|Write|MultiEdit — block invariant-violating file CONTENT
// before it lands. The only reliable place to stop forbidden code being written.
// Mirrors the ESLint/depcruise rules (defense-in-depth) and provides tamper evidence
// (layer 2) for the gate surface itself. Exempts the harness's own tooling (.claude/**)
// and test bodies, which legitimately reference banned patterns.
//
// The protected-path list (WRITE_PROTECTED) and everywhere-content-checks
// (WRITE_GLOBAL_CHECKS) live in ./lib/guard-rules.mjs (pure data, importable by tests);
// this hook keeps the I/O, path-normalization, and path-scoped decision plumbing. Every
// rule id there has a behavioral canary in tests/hooks/hook-contract.test.mjs.
// SOURCE: docs/harness/README.md (pretool-write-guard)
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { denyTool, pass, readHookInput } from './lib/hookio.mjs'

export const HARNESS_HOOK_VERSION = '0.1.2'

// Dynamic import AFTER hookio installed its fail-closed handlers: a missing, broken, or
// mis-shaped rules module must BLOCK (exit 2) — a guard that cannot load its rules approves
// nothing.
let rules
try {
  rules = await import('./lib/guard-rules.mjs')
} catch (err) {
  process.stderr.write(
    `HOOK CRASHED (guard-rules import) — failing closed, action blocked: ${err?.stack ?? err}\n`,
  )
  process.exit(2)
}
const { WRITE_PROTECTED, WRITE_GLOBAL_CHECKS } = rules
if (
  !Array.isArray(WRITE_PROTECTED) ||
  WRITE_PROTECTED.length === 0 ||
  !Array.isArray(WRITE_GLOBAL_CHECKS) ||
  WRITE_GLOBAL_CHECKS.length === 0
) {
  process.stderr.write(
    'HOOK CRASHED (guard-rules shape) — failing closed, action blocked: WRITE_PROTECTED / WRITE_GLOBAL_CHECKS missing or empty\n',
  )
  process.exit(2)
}

const input = await readHookInput()
const ti = input?.tool_input ?? {}
const path = String(ti.file_path ?? ti.path ?? '')

// Resolve to a path RELATIVE to the project root so the protected patterns can be
// root-anchored (^…) — otherwise a nested node_modules/x/tools/validate.mjs would
// false-match. CLAUDE_PROJECT_DIR is guaranteed for hook subprocesses. Normalize
// to POSIX separators FIRST: on Windows the tool delivers D:\…\tools\validate.mjs,
// and without this every `/`-based PROTECTED pattern silently fails OPEN.
const toPosix = (p) => p.replaceAll('\\', '/')
const projectDir = toPosix(process.env.CLAUDE_PROJECT_DIR ?? '')
const posixPath = toPosix(path)
/** @param {string} p @param {string} root @returns {string} */
const relativize = (p, root) =>
  root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p.replace(/^\.?\/+/, '')
const rel = relativize(posixPath, projectDir)

// Symlink shadowing: a link whose NAME is innocuous but whose TARGET is protected used to
// walk straight through — the RAW tool path was matched against WRITE_PROTECTED, so
// `ln -s tools/validate.mjs shim` then `Write shim` edited the gate runner unguarded (and
// from there .harness/manifest.json can be forged so gate-integrity re-hashes to green).
// Resolve the destination through the filesystem — the leaf when it exists, else its parent
// directory, so a NEW file created inside a symlinked directory is caught too — and judge
// BOTH spellings: a write is protected if the NAME or the bytes' TRUE destination is.
// SOURCE: docs/harness/README.md (tamper evidence)
/** @param {string} p @returns {string | null} */
function realpathOrNull(p) {
  if (!p) return null
  try {
    return toPosix(realpathSync(p))
  } catch {
    try {
      return `${toPosix(realpathSync(dirname(p)))}/${basename(p)}`
    } catch {
      return null
    }
  }
}
const projectDirReal = projectDir ? (realpathOrNull(projectDir) ?? projectDir) : ''
const realPath = realpathOrNull(path)
const realRel = realPath ? relativize(realPath, projectDirReal) : null
// The path spellings this write must be judged under: what it is called, and where its
// bytes actually land. Deduped; `null` when the target does not resolve (a brand-new file
// in a brand-new directory) — then the raw path is all there is.
const rels = [...new Set([rel, realRel].filter((r) => typeof r === 'string' && r !== ''))]

// A link inside the project pointing OUT of it is never legitimate agent work, and it is
// the other half of the shadowing trick (write through the tree to an unguarded absolute
// path). Judge escape only when the raw path was project-relative — an explicit absolute
// path outside the repo (a scratchpad file) stays the caller's business.
if (
  process.env.HARNESS_ALLOW_SELF_EDIT !== '1' &&
  projectDirReal &&
  realPath &&
  !posixPath.startsWith('/') &&
  !realPath.startsWith(`${projectDirReal}/`)
) {
  denyTool(
    'PreToolUse',
    `symlink escape: ${rel} resolves to ${realPath}, outside the project root — writing through a link out of the tree bypasses every path-scoped guard. SOURCE: docs/harness/README.md (tamper evidence)`,
  )
}

// Tamper evidence (layer 2): the gate must not be able to rewrite itself. Edits to the
// harness config, the gate runner + the frozen CI floor + every gate script, the RLS
// runner, the lockfiles the gates verify against, the lint/architecture config surface, git
// hooks, and CI workflows require an explicit human-in-the-loop escape hatch. Layer 1 is the
// settings.json deny list. NOTE: app.config.ts / eas.json are deliberately NOT
// blanket-protected — adding a plugin or a permission is routine vertical-slice work;
// specific app.config.* / app.json weakenings are content-checked below; eas.json's
// weakening surface (secret-shaped build-profile env names) is asserted by the
// expo-policy gate instead.
// SOURCE: docs/harness/README.md (tamper evidence)
if (
  process.env.HARNESS_ALLOW_SELF_EDIT !== '1' &&
  WRITE_PROTECTED.some(({ re }) => rels.some((r) => re.test(r)))
) {
  denyTool(
    'PreToolUse',
    'harness-protected file: set HARNESS_ALLOW_SELF_EDIT=1 (human-in-the-loop) to modify the gate itself. SOURCE: docs/harness/README.md (tamper evidence)',
  )
}

// Migrations are APPEND-ONLY: editing an already-committed migration file rewrites
// history that may already be applied to a database. New migration files are fine.
// SOURCE: docs/harness/README.md (append-only migrations)
if (rels.some((r) => /^supabase\/migrations\/[^/]+\.sql$/.test(r)) && existsSync(path)) {
  denyTool(
    'PreToolUse',
    'migrations are append-only: never edit an existing migration — add a new one (supabase migration new) that transforms the schema forward.',
  )
}

// Every path-scoped decision below is judged over BOTH spellings (name and true
// destination), so a symlink cannot borrow an exempt name to smuggle content into a
// checked location.
/** @param {RegExp} re @returns {boolean} */
const anyRel = (re) => rels.some((r) => re.test(r))

// Exempt harness tooling and test bodies from the content checks below.
// Deliberately NARROW: only the root-level test trees (the harness's own RLS/
// migration suites), the mobile __tests__ tree, and colocated *.test.* / *.spec.*
// FILES. A directory merely named "tests" deeper in the app tree (src/dal/tests/…)
// is product code and stays fully content-checked — the old any-segment match
// let real invariant violations ship from such paths.
// EVERY spelling must be exempt: a link named `x.test.ts` pointing at a DAL module
// lands product bytes, so one exempt-looking name must not buy an exemption.
const isExempt = (/** @type {string} */ r) =>
  /^\.claude\//.test(r) ||
  /^tests?\//.test(r) ||
  /^apps\/mobile\/__tests__\//.test(r) ||
  /\.(test|spec)\.[a-z]+$/.test(r)
if (rels.every(isExempt)) {
  pass()
}

const text = [
  ti.content,
  ti.new_string,
  ti.new_str,
  ti.replacement,
  ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e?.new_string ?? '') : []),
]
  .filter((s) => typeof s === 'string')
  .join('\n')
// Positive requirements (X must be present) can only be judged on whole-file
// writes; an Edit fragment legitimately omits distant lines.
const isWholeFile = typeof ti.content === 'string'

// ---- App config surface: content-checked, not blanket-protected ----
// The expo-policy gate enforces the full floor tree-wide; these are the weakenings
// worth stopping at the moment of the edit.
if (anyRel(/(^|\/)app\.config\.(ts|js|mjs)$/) || anyRel(/(^|\/)app\.json$/)) {
  /** @type {[RegExp, string][]} */
  const weakenings = [
    [/usesCleartextTraffic['"]?\s*:\s*true/, 'Android cleartext traffic stays off — the transport is TLS-or-loopback, asserted by the expo-policy gate.'],
    [/NSAllowsArbitraryLoads['"]?\s*:\s*true/, 'disabling App Transport Security wholesale is banned — pin a per-domain exception with a reviewed reason instead.'],
    [/newArchEnabled['"]?\s*:\s*false/, 'the New Architecture stays on — it is the runtime the whole template is tested against.'],
  ]
  for (const [re, msg] of weakenings) if (re.test(text)) denyTool('PreToolUse', `app config: ${msg}`)
}

// ---- SQL (any location): recursion + GUC discipline ----
if (anyRel(/\.(sql|ts|tsx|mjs)$/) && /WITH\s+RECURSIVE/i.test(text) && !/CYCLE|visited/i.test(text)) {
  denyTool(
    'PreToolUse',
    'WITH RECURSIVE without a CYCLE clause / visited guard can loop forever on graph data — add one. SOURCE: docs/harness/README.md (graph queries)',
  )
}

// Police source code only from here down. Docs/markdown/config legitimately
// mention the banned patterns by name.
if (!anyRel(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/)) pass()

// Everywhere-checks: banned in any source file (WRITE_GLOBAL_CHECKS is pure data).
for (const { re, message } of WRITE_GLOBAL_CHECKS) {
  if (re.test(text)) denyTool('PreToolUse', message)
}

// Mobile-bundle purity: the client never touches server/database modules, and
// the platform keychain stays wrapped inside src/host/** (the one-door seam).
if (anyRel(/^apps\/mobile\//)) {
  if (/from\s+['"](postgres|pg|@supabase\/ssr|pino)['"]/.test(text)) {
    denyTool(
      'PreToolUse',
      'the mobile client must never import server/database modules — reach data through the tRPC client (@app/api, import type) or the vertical ./client.',
    )
  }
  // The seam exemption requires EVERY spelling to sit inside it — a link named
  // src/host/x.ts landing outside the seam would otherwise import the keychain unwrapped.
  const inHostSeam = rels.every((r) => /^apps\/mobile\/src\/host\//.test(r))
  if (!inHostSeam && /from\s+['"]expo-secure-store['"]/.test(text)) {
    denyTool(
      'PreToolUse',
      'the platform keychain is wrapped: import expo-secure-store only inside src/host/** (the one-door credential seam) — feature code stays storage-agnostic.',
    )
  }
}

// ---- Web surface: the two web-specific credential mistakes, at the moment of the
// edit (defense-in-depth over the eslint/RLS layers). ----
if (anyRel(/^apps\/web\//)) {
  // The service-role key BYPASSES row-level security and never belongs in the web
  // process — its one sanctioned home is an ADR-governed Edge Function
  // (supabase/functions/<name>). The factory name is the deliberate grep signal;
  // the env accessor + the key name are the other two ways it gets reached for.
  if (/createServiceRoleClient_BYPASSES_RLS|serviceRoleCredentials|SUPABASE_SERVICE_ROLE_KEY/.test(text)) {
    denyTool(
      'PreToolUse',
      'the service-role key BYPASSES row-level security and must never sit in the web process — its only sanctioned home is an ADR-governed Edge Function (supabase/functions/<name>/index.ts). SOURCE: packages/platform/supabase/src/service-role.ts',
    )
  }
  // Server-side web code must resolve the user with getUser()/getClaims(), NEVER
  // getSession(): getSession returns an UNVERIFIED token straight from an
  // attacker-controlled cookie. Judged on whole-file writes so 'use client' (which
  // marks a browser component, where a cheap session read is legitimate) can exempt.
  const isClientComponent = /^\s*['"]use client['"]/m.test(text)
  if (isWholeFile && !isClientComponent && /\.\s*getSession\s*\(/.test(text)) {
    denyTool(
      'PreToolUse',
      "server-side web code must resolve the user with getUser()/getClaims(), NEVER getSession() — getSession decodes an UNVERIFIED token from an attacker-controlled cookie and does not check its signature. If this is a browser component, mark it 'use client'. SOURCE: apps/web/lib/supabase/server.ts (getUser, never getSession)",
    )
  }
}

// Authorization at the DAL is not a code wrapper in this stack: it is RLS at the
// database (owner_id = (select auth.uid()) under FORCE ROW LEVEL SECURITY), the
// structural PostgREST port re-parsing rows against the vertical's zod contract at
// the DAL's exit, and the depcruise boundary — enforced by the schema-rls / RLS
// isolation suite and the architecture gates, not by a positive content check here.
pass()
