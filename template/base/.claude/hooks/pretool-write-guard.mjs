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
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { denyTool, pass, readHookInput } from './lib/hookio.mjs'

// An Edit fragment cannot carry a file-level directive ('use client'), so a rule that
// needs one reads it off disk. Unreadable is treated as absent — the exemption has to be
// PROVEN, never assumed, or an unreadable file becomes the way past the rule.
/** @param {string} p @returns {string} */
function readFileSafe(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

export const HARNESS_HOOK_VERSION = '0.5.0'

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
const { WRITE_PROTECTED, WRITE_GLOBAL_CHECKS, WRITE_SQL_CHECKS, WRITE_CONFIG_CHECKS } = rules
if (
  !Array.isArray(WRITE_PROTECTED) ||
  WRITE_PROTECTED.length === 0 ||
  !Array.isArray(WRITE_GLOBAL_CHECKS) ||
  WRITE_GLOBAL_CHECKS.length === 0 ||
  !Array.isArray(WRITE_SQL_CHECKS) ||
  WRITE_SQL_CHECKS.length === 0 ||
  !Array.isArray(WRITE_CONFIG_CHECKS) ||
  WRITE_CONFIG_CHECKS.length === 0
) {
  process.stderr.write(
    'HOOK CRASHED (guard-rules shape) — failing closed, action blocked: WRITE_PROTECTED / WRITE_GLOBAL_CHECKS / WRITE_SQL_CHECKS / WRITE_CONFIG_CHECKS missing or empty\n',
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

// Exempt the two surfaces that must be able to NAME a banned pattern in order to ban it,
// plus test bodies. Deliberately NARROW: only the root-level test trees (the harness's own
// RLS/migration suites), the mobile __tests__ tree, and colocated *.test.* / *.spec.* FILES.
// A directory merely named "tests" deeper in the app tree (src/dal/tests/…) is product code
// and stays fully content-checked — the old any-segment match let real invariant violations
// ship from such paths.
//
// The `.claude/` half was a BLANKET exemption until 0.3.0, which is wider than its own
// reasoning: it was written for the guards (whose rule tables must literally contain
// `dangerouslySetInnerHTML` to forbid it) and for the prose agent surface (rules, agents,
// commands and skill docs, which quote every banned pattern by name). It also silently
// exempted `.claude/statusline.mjs` and every executable script bundled with a skill —
// real code, running on a developer's machine, that no content rule ever saw.
//
// EVERY spelling must be exempt: a link named `x.test.ts` pointing at a DAL module lands
// product bytes, so one exempt-looking name must not buy an exemption.
const isExempt = (/** @type {string} */ r) =>
  // the guards themselves — a rule table has to contain what it bans
  /^\.claude\/hooks\//.test(r) ||
  // the prose agent surface — it forbids by quoting
  /^\.claude\/(?:agents|commands|rules)\//.test(r) ||
  /^\.claude\/(?:skills\/.*|[^/]*)\.md$/.test(r) ||
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

// ---- SQL schema + migration surface: the authorization boundary itself ----
// This block sits ABOVE the source-extension gate below on purpose. That gate ends
// the hook for every non-TS/JS file, which meant .sql — the one file class where
// this codebase's authorization boundary is actually written — reached no content
// rule at all. Each rule is scoped by pathRe, so the same bytes under
// supabase/tests/** stay writable: a fixture proving `USING (true)` is rejected must
// be allowed to contain `USING (true)`.
// SOURCE: docs/harness/README.md (layer 3 prevention beside layer 6 enforcement)
for (const { pathRe, re, message } of WRITE_SQL_CHECKS) {
  if (anyRel(pathRe) && re.test(text)) denyTool('PreToolUse', message)
}

// ---- Non-source CONFIG surface: the weakenings that live in JSON/YAML ----
// Same placement reasoning as the SQL table above it: the source-extension gate on the
// next line ends the hook for every .json file, so package.json's npm lifecycle hooks —
// code that runs on every install, before any gate — reached no content rule at all.
for (const { pathRe, re, message } of WRITE_CONFIG_CHECKS) {
  if (anyRel(pathRe) && re.test(text)) denyTool('PreToolUse', message)
}

// Police source code only from here down. Docs/markdown/config legitimately
// mention the banned patterns by name.
if (!anyRel(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/)) pass()

// Everywhere-checks: banned in any source file (WRITE_GLOBAL_CHECKS is pure data).
// `pathRe` is optional and means the same thing it does in the SQL table above: a rule
// carrying one is scoped to the surface it is about. Absent, the rule applies to every
// source file — which is the default precisely because most of these bans are about the
// shape of the code, not where it lives.
for (const { pathRe, re, message } of WRITE_GLOBAL_CHECKS) {
  if (pathRe !== undefined && !anyRel(pathRe)) continue
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

// ---- The two credential mistakes, over the WHOLE SERVER GRAPH ----
// Until 0.3.0 both of these sat inside `if (anyRel(/^apps\/web\//))`, and the getSession
// rule additionally fired only on whole-file writes. The consequence was that the
// doctrine's own "single most consequential line" was barely guarded: an Edit inserting
// `.getSession()` into packages/api, a vertical's server barrel or an Edge Function passed
// every layer, and even in apps/web an Edit fragment was invisible.
//
// Scope is the server graph — code where the stored session is ATTACKER-CONTROLLED INPUT
// because it arrived with someone else's request. apps/mobile is deliberately OUT of it:
// the mobile app is an untrusted bearer of its OWN scoped token, reading its OWN session
// out of LargeSecureStore to attach it (apps/mobile/src/lib/trpc/client.ts), which is not
// the same act at all. That distinction is doctrine, not convenience — see
// .claude/rules/security-invariants.md.
//
// tools/eslint-rules/index.mjs holds the same two properties with AST precision inside the
// `lint` step; this is the layer-3 tripwire at the moment of the edit.
const SERVER_GRAPH = /^(?:apps\/web|packages|supabase)\//

// The service-role key BYPASSES row-level security. Its one sanctioned runtime home is an
// ADR-governed Edge Function; the only other places the SYMBOLS may appear are the module
// that defines the factory and the env validators that type its credentials.
const SERVICE_ROLE_HOME =
  /^(?:supabase\/functions\/|packages\/platform\/supabase\/src\/|packages\/platform\/env\/src\/)/
if (
  anyRel(SERVER_GRAPH) &&
  !rels.some((r) => SERVICE_ROLE_HOME.test(r)) &&
  /createServiceRoleClient_BYPASSES_RLS|serviceRoleCredentials|SUPABASE_SERVICE_ROLE_KEY/.test(text)
) {
  denyTool(
    'PreToolUse',
    'the service-role key BYPASSES row-level security — no policy in the repo constrains it and the RLS suite cannot cover it. Its only sanctioned home is an ADR-governed Edge Function (supabase/functions/<name>/index.ts), reached through createServiceRoleClient_BYPASSES_RLS(warrant); never a Server Action, a tRPC procedure, a script or a screen. SOURCE: packages/platform/supabase/src/service-role.ts',
  )
}

// Server-side code must resolve the user with getUser()/getClaims(), NEVER getSession():
// getSession decodes whatever JWT it finds in the stored session and returns it WITHOUT
// verifying the signature, so on a server — where that store is a cookie the caller sent —
// anyone can claim any `sub`.
//
// 'use client' marks a browser component, where reading one's own session is legitimate.
// On an Edit the fragment cannot carry the directive, so the guard reads it off the file
// on disk: judging a fragment as if it were the whole file is what made this rule
// whole-file-only, and dropping the check entirely for Edits is what made it bypassable.
if (anyRel(SERVER_GRAPH) && /\.\s*getSession\s*\(/.test(text)) {
  const onDisk = isWholeFile || !existsSync(path) ? '' : readFileSafe(path)
  const isClientComponent =
    /^\s*['"]use client['"]/m.test(text) || /^\s*['"]use client['"]/m.test(onDisk)
  if (!isClientComponent) {
    denyTool(
      'PreToolUse',
      "server-side code must resolve the user with getUser()/getClaims(), NEVER getSession() — getSession decodes an UNVERIFIED token from an attacker-controlled cookie and does not check its signature, so a forged `sub` is accepted. If this is a browser component, mark it 'use client'; if it is the mobile client reading its own stored session, it does not belong in the server graph. SOURCE: apps/web/lib/supabase/server.ts (getUser, never getSession)",
    )
  }
}

// Authorization at the DAL is not a code wrapper in this stack: it is RLS at the
// database (owner_id = (select auth.uid()) under FORCE ROW LEVEL SECURITY), the
// structural PostgREST port re-parsing rows against the vertical's zod contract at
// the DAL's exit, and the depcruise boundary — enforced by the schema-rls / RLS
// isolation suite and the architecture gates, not by a positive content check here.
pass()
