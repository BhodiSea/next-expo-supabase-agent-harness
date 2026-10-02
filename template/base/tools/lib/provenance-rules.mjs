// tools/lib/provenance-rules.mjs — the SINGLE source of truth for the provenance
// heuristic. Both enforcement layers import from here — the per-edit PostToolUse hook
// (.claude/hooks/posttool-source-check.mjs) and the tree-wide `provenance` gate
// (tools/check-sources.mjs) — so the decision-site patterns, file scoping, and the
// 3-line SOURCE window can never drift apart the way hand-duplicated regexes did.
// SOURCE: docs/harness/README.md (provenance; one heuristic, two enforcement layers) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { isAllowedCitationHost } from './citation-domains.mjs'
import { toPosix } from './fs-walk.mjs'

// Decision-site keyword groups for THIS stack. Each group's key must be covered by
// at least one corpus entry's `groups` tag in tools/mcp/corpus/index.json or the
// project's tools/mcp/corpus/project.json — the gate asserts that lockstep, so the
// heuristic cannot grow a new decision class without the corpus growing an authority
// that can ground it. A group a project adds is covered from project.json.
const BUILTIN_DECISION_GROUPS = [
  {
    key: 'rls-policy',
    description: 'RLS policy SQL — row-security enablement and policy declarations',
    // SQL-first schema: `supabase/schemas/*.sql` is the declarative source and
    // `supabase/migrations/*.sql` the append-only record, so the decision sites are
    // the SQL statements themselves — there is no ORM policy builder in this path.
    // Deliberately NOT `auth.uid()`: it appears in every policy predicate and in the
    // owner-column default, so keying on it would demand a citation per LINE of a
    // policy rather than per policy, and red a correct migration.
    patterns: [/FORCE ROW LEVEL SECURITY/, /CREATE POLICY/],
  },
  {
    key: 'guc-identity',
    description: 'GUC identity discipline — transaction-local RLS identity plumbing',
    patterns: [/current_setting\(/, /set_config\(/, /SET LOCAL/],
  },
  {
    key: 'token-verification',
    description: 'Token verification — jwtVerify, JWKS key resolvers, clock tolerance',
    patterns: [/jwtVerify/, /createRemoteJWKSet/, /createLocalJWKSet/, /clockTolerance/],
  },
  {
    key: 'vector-index',
    description: 'Vector index choices — HNSW vs IVFFlat and operator-class selection',
    patterns: [/USING hnsw/, /USING ivfflat/, /vector_cosine_ops/],
  },
  {
    key: 'llm-sampling',
    description: 'LLM sampling parameters — temperature / top_p constants',
    patterns: [/temperature\s*[:=]/, /top_p\s*[:=]/],
  },
  {
    key: 'tuning-constants',
    description: 'Tuning constants — retry, timeout, rate-limit, backoff values',
    patterns: [/maxRetries/, /timeoutMs/, /rateLimit/, /backoff/],
  },
  {
    // 0.9.5, with the e2ee rails. Before it, a cryptographic decision site had no
    // citation CLASS to resolve against: an AEAD choice, an IV length or a KDF
    // parameter would either go uncited or be grounded against a group that does
    // not cover it. Built-in rather than a tools/decision-groups.json entry
    // because that file is SEEDED — an edit there never reaches an existing
    // install, and the doctrine has to bind every consumer, module enabled or not.
    //
    // Keyed on the CONSTRUCTION CHOICE, not on the vocabulary: `aeadSeal`/
    // `aeadOpen` are the port calls whose parameters are the choice,
    // `deriveBits`/`hkdf`/`Argon2` are KDF selections, and `AES-GCM`/`XChaCha20`
    // name a construction.
    //
    // Deliberately NOT `getRandomValues`, `randomUUID` or `createHash` — the
    // same call the `rls-policy` group makes about `auth.uid()`, for the same
    // reason. Reading the platform CSPRNG is the CORRECT act at a dozen sites
    // that are not cryptographic trade-offs at all: the CSP nonce in
    // apps/web/proxy.ts, a request id, an optimistic temp id. Keying on it would
    // demand a citation per CSPRNG CALL rather than per cryptographic decision,
    // and red a correct file — which is how a provenance rule earns its way into
    // tools/provenance-overrides.json instead of being obeyed.
    key: 'cryptography',
    description:
      'Cryptographic construction choices — AEAD selection and parameters, KDF selection, key-wrapping structure',
    patterns: [
      /aeadSeal|aeadOpen/,
      /AES-\d{3}-GCM|AES-GCM|XChaCha20|ChaCha20-Poly1305/,
      /hkdf|HKDF|deriveBits|Argon2|scrypt|PBKDF2/,
      /wrapDek|unwrapDek|deriveKek/,
    ],
  },
]

// THE ADVISORY CLASSES (1.1.0, #69). A decision class is MANDATORY unless it is named here:
// an uncited site, or a group-match miss, in a mandatory class reds the gate and blocks the
// per-edit hook, as every class did before 1.1.0. These three guard no security decision —
// an index choice, a sampling parameter, a retry or timeout constant — so a missing citation
// on one is REPORTED on every run (the gate prints an ADVISORY line, the hook hands the model
// an additionalContext note) and is never a red on its own. Everything else is mandatory:
// the other built-ins, the seeded mobile-security, any group a project adds, and any
// built-in a later release adds, because the default for a class this list does not name is
// the old, strict one. A site that matches ANY mandatory class is mandatory. The seeded
// tools/decision-groups.json can PROMOTE an advisory class back (its "mandatory" list,
// parsed below) and cannot demote anything: this constant is the only place a class becomes
// advisory, and it is owned and sha-pinned. Resolvability, the host allowlist, corpus
// integrity and the coverage lockstep stay hard for every class — a citation that is written
// must be true.
// SOURCE: docs/harness/README.md (provenance; one heuristic, two enforcement layers) [corpus: harness/doctrine]
export const ADVISORY_DECISION_GROUPS = Object.freeze([
  'vector-index',
  'llm-sampling',
  'tuning-constants',
])

// G27 — the CONSUMER's own decision classes. The built-in groups cover THIS stack's
// security/LLM surface, but a consumer's domain constants (a RAG chunk size, a similarity
// threshold, an epsilon, a sampling seed) carried no citation duty at all — they are the
// research decisions a research-grade artifact most needs grounded. tools/decision-groups.json
// (write-guard-protected, so extending it is a reviewed act) is merged in here, so both
// enforcement layers pick it up at once, and the corpus coverage lockstep then forces a
// consumer-added group to ship with an authority that can ground it. This template SEEDS
// one group there — `mobile-security` (ATS/cleartext exceptions, Android permission
// strings, runtimeVersion policy, the updates URL) — because those are exactly the
// mobile decision sites the design record locks; consumers extend the file, never
// shrink it. The file is read ONCE: its `groups` are validated here and its `mandatory`
// promotions in parseMandatoryPromotions, from the same parsed object.
// SOURCE: docs/harness/README.md (provenance; one heuristic, two enforcement layers) [corpus: harness/doctrine]
function readConsumerDecisionFile() {
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
  const path = resolve(root, 'tools/decision-groups.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    // Fail CLOSED: a malformed extension file must not silently disable citation duty.
    // The gate reds; the hook (fail-closed handlers) blocks.
    throw new Error(`tools/decision-groups.json is not valid JSON (${e.message})`)
  }
}

/** @param {unknown} parsed the parsed tools/decision-groups.json, or null when it is absent */
function loadConsumerDecisionGroups(parsed) {
  if (parsed === null) return []
  const list = /** @type {{ groups?: unknown }} */ (parsed)?.groups
  if (!Array.isArray(list)) {
    throw new Error(
      'tools/decision-groups.json must carry a "groups" ARRAY of {key, description, patterns}',
    )
  }
  const builtinKeys = new Set(BUILTIN_DECISION_GROUPS.map((g) => g.key))
  return list.map((g) => {
    if (
      g === null ||
      typeof g !== 'object' ||
      typeof g.key !== 'string' ||
      !/^[a-z][a-z0-9-]*$/.test(g.key) ||
      typeof g.description !== 'string' ||
      g.description.trim() === '' ||
      !Array.isArray(g.patterns) ||
      g.patterns.length === 0 ||
      !g.patterns.every((p) => typeof p === 'string' && p !== '')
    ) {
      throw new Error(
        `tools/decision-groups.json: each group must be {key: lowercase-kebab, description: non-empty, patterns: non-empty string[]} — got ${JSON.stringify(g)}`,
      )
    }
    if (builtinKeys.has(g.key)) {
      throw new Error(
        `tools/decision-groups.json: '${g.key}' shadows a built-in decision group — choose a distinct key`,
      )
    }
    // Patterns are authored as regex-source strings; compile once here.
    return {
      key: g.key,
      description: g.description,
      patterns: g.patterns.map((p) => new RegExp(p)),
    }
  })
}

/**
 * The seeded file's top-level `"mandatory": ["<key>", …]` (1.1.0, #69): the classes a project
 * PROMOTES to mandatory. Absent (no file, or no key) promotes nothing, so a file written
 * before 1.1.0 behaves exactly as it did. A value that is not an array, or an entry that is
 * not a known group key, fails CLOSED like the file's other shape errors: a typo'd promotion
 * would silently leave the class advisory while a reviewer believes it was promoted. It can
 * only add: nothing here, or anywhere in the seeded file, demotes a class.
 * @public exported for the harness repo's gate suite (tests/gates/provenance-rules.test.mjs)
 * @param {unknown} parsed the parsed tools/decision-groups.json, or null when it is absent
 * @param {Iterable<string>} knownKeys every built-in and consumer group key
 * @returns {string[]}
 */
export function parseMandatoryPromotions(parsed, knownKeys) {
  if (parsed === null || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'mandatory'))
    return []
  const list = /** @type {{ mandatory: unknown }} */ (parsed).mandatory
  if (!Array.isArray(list)) {
    throw new Error(
      `tools/decision-groups.json: "mandatory" must be an ARRAY of decision-group keys — got ${JSON.stringify(list)}`,
    )
  }
  const known = [...knownKeys]
  const unknown = list.filter((k) => typeof k !== 'string' || !known.includes(k))
  if (unknown.length > 0) {
    throw new Error(
      `tools/decision-groups.json: "mandatory" names ${JSON.stringify(unknown)}, not a known decision-group key (known: ${known.join(', ')}) — a promotion must name a group exactly`,
    )
  }
  return [...new Set(list)]
}

const CONSUMER_FILE = readConsumerDecisionFile()

export const DECISION_GROUPS = [
  ...BUILTIN_DECISION_GROUPS,
  ...loadConsumerDecisionGroups(CONSUMER_FILE),
]

const PROMOTED = new Set(
  parseMandatoryPromotions(
    CONSUMER_FILE,
    DECISION_GROUPS.map((g) => g.key),
  ),
)

/**
 * Is this decision class mandatory? Yes unless the owned advisory list names it and the
 * seeded file does not promote it — so an unknown key is mandatory too.
 * @param {string} key
 */
export function isMandatoryGroup(key) {
  return !ADVISORY_DECISION_GROUPS.includes(key) || PROMOTED.has(key)
}

/**
 * Is a decision site mandatory? Yes when ANY class it matches is. A site with no class at
 * all (a combined-matcher hit no single group re-matches, or a finding from a copy of this
 * lib that predates `groups`) is mandatory: the split only ever relaxes a site it can name.
 * @param {unknown} groups the site's decision-group keys
 */
export function isMandatorySite(groups) {
  return !Array.isArray(groups) || groups.length === 0 || groups.some((g) => isMandatoryGroup(g))
}

// Combined matcher — every built-in and consumer group's patterns, in order.
export const DECISION = new RegExp(
  DECISION_GROUPS.flatMap((g) => g.patterns.map((p) => p.source)).join('|'),
)

// A citation comment: `// SOURCE:` (or `-- SOURCE:` in SQL).
export const CITED = /(\/\/|--)\s*SOURCE:/

// A decision line is cited when a SOURCE comment appears on it or within the
// N lines above it.
export const SOURCE_WINDOW_LINES = 3

// What gets scanned at all: code that can carry comments. JSON cannot (eas.json
// and other JSON-only decision surfaces are documented in ADRs and owned by
// check-expo-policy).
export const SCANNABLE_FILE = /\.(ts|tsx|sql)$/

// Excluded everywhere: tests and machine-generated adapters (the design-tokens
// output under src/generated/, the Supabase type mirror).
export const SCAN_EXCLUDES = [/\.(test|spec)\.tsx?$/, /\/generated\//, /\/database\.types\.ts$/]

// Hook-only exclusion: harness tooling under .claude/ (the gate's globs below never
// reach it, but the hook sees absolute paths for every edited file).
export const HOOK_EXCLUDES = [/\/\.claude\//]

// Tree-wide gate-file membership. Replaces the old GATE_FILE_GLOBS git pathspecs
// (`apps/**/*.ts` etc.) so check-sources can enumerate the tree ONCE with a bare
// `git ls-files` and filter in-process — the twin `git ls-files` calls collapse to one.
// The old pathspecs required ≥1 intermediate directory: `git ls-files 'apps/**/*.ts'`
// silently SKIPS `apps/top.ts`, and `packages/**/*.sql` skips `packages/foo.sql`. The
// `.+` here matches those directly-under-scope files too — the WIDER, fail-closed
// reading, so a decision site directly under apps/ or packages/ is scanned, never
// missed. POSIX-normalized at this boundary so a backslash path (windows-latest) can
// never dodge the `/`-anchored match. Same apps|packages scope as before, so the gate
// stays narrower than the hook's whole-tree SCANNABLE_FILE by design; gateScansFile
// still applies the test/tokens/meta excludes on top.
//
// `supabase/**.sql` is load-bearing, not a nicety. In this lineage the schema is
// SQL-FIRST — `supabase/schemas/*.sql` declares it and `supabase/migrations/*.sql`
// is the append-only record — so the RLS policies, the FORCE statements and the
// initPlan predicates all live there. The inherited scope only covered
// `packages/**.sql`, where the ancestor kept its ORM schema, which meant the most
// security-critical decision surface in the stack carried `SOURCE:` comments that
// NOTHING verified. Widening this is what makes the provenance canary bite.
export function gateFileMatch(file) {
  const posix = toPosix(file)
  return (
    /^(apps|packages)\/.+\.(ts|tsx)$/.test(posix) || /^(packages|supabase)\/.+\.sql$/.test(posix)
  )
}

// Per-edit scope check used by the PostToolUse hook. The hook receives the
// OS-native absolute path from tool_input — normalize to POSIX at this
// boundary so the `/`-based excludes hold on Windows (`apps\mobile\...`).
export function hookScansFile(file) {
  const posix = toPosix(file)
  return (
    SCANNABLE_FILE.test(posix) &&
    !SCAN_EXCLUDES.some((re) => re.test(posix)) &&
    !HOOK_EXCLUDES.some((re) => re.test(posix))
  )
}

// Tree-wide scope check used by the gate on git-listed paths.
export function gateScansFile(file) {
  return !SCAN_EXCLUDES.some((re) => re.test(file))
}

const COMMENT_START = /^(\/\/|\*|\/\*|--)/

/**
 * The decision-group keys a line matches, in taxonomy order: the ONE group matcher both
 * finders below use (1.1.0), so the class an uncited site is judged by and the class a cited
 * site must be justified for can never disagree.
 * @public exported for the harness repo's gate suite (tests/gates/provenance-rules.test.mjs)
 * @param {string} line
 * @returns {string[]}
 */
export function decisionGroupsOf(line) {
  return DECISION_GROUPS.filter((g) => g.patterns.some((p) => p.test(line))).map((g) => g.key)
}

// The heuristic itself: flag decision keywords appearing in CODE (not in comments
// that merely mention them) with no SOURCE citation in the window above.
// Returns [{ line, excerpt, groups }] with 1-based line numbers; `groups` (1.1.0) are the
// decision classes the line matched, which decide whether the finding is mandatory.
export function findUncitedDecisionSites(src) {
  const lines = src.split('\n')
  const flagged = []
  lines.forEach((ln, i) => {
    const trimmed = ln.trim()
    if (COMMENT_START.test(trimmed)) return
    if (!DECISION.test(ln)) return
    const window = lines.slice(Math.max(0, i - SOURCE_WINDOW_LINES), i + 1).join('\n')
    if (!CITED.test(window)) {
      flagged.push({ line: i + 1, excerpt: trimmed.slice(0, 80), groups: decisionGroupsOf(ln) })
    }
  })
  return flagged
}

// A corpus reference: `[corpus: <id>]`. The id charset deliberately excludes `<`/`>`
// so documentation placeholders like `[corpus: <id>]` never parse as references.
export const CORPUS_REF = /\[corpus:\s*([A-Za-z0-9][A-Za-z0-9/._-]*)\s*\]/g

// The wrapped-payload walk shared by extractSourceComments and
// findCitedDecisionSites: the text after `SOURCE:` on line idx plus any
// continuation comment lines below it (real citations routinely wrap; the
// corpus tail usually lands on the last wrapped line). A new SOURCE comment
// or a non-comment line ends the payload.
function payloadAt(lines, idx) {
  let payload = lines[idx].slice(lines[idx].indexOf('SOURCE:') + 'SOURCE:'.length)
  for (let j = idx + 1; j < lines.length; j += 1) {
    const trimmed = lines[j].trim()
    if (!COMMENT_START.test(trimmed) || CITED.test(trimmed)) break
    payload += `\n${trimmed}`
  }
  return payload
}

// Every SOURCE comment in a file, with its full payload. Returns [{ line, payload }].
export function extractSourceComments(src) {
  const lines = src.split('\n')
  const found = []
  lines.forEach((ln, i) => {
    if (!CITED.test(ln)) return
    found.push({ line: i + 1, payload: payloadAt(lines, i) })
  })
  return found
}

// The complement of findUncitedDecisionSites: decision lines that DO carry a
// SOURCE in the window, with the decision-group keys the line matched and the
// full payload of the NEAREST SOURCE comment at/above it. The gate uses this
// for the corpus group-match (a citation must justify the decision class it
// sits on, not merely resolve). The per-edit hook deliberately does NOT — it
// has no corpus context per edit; see payloadResolves below for the shared
// asymmetry note. Returns [{ line, groups, payload }] (1-based lines).
export function findCitedDecisionSites(src) {
  const lines = src.split('\n')
  const sites = []
  lines.forEach((ln, i) => {
    const trimmed = ln.trim()
    if (COMMENT_START.test(trimmed)) return
    if (!DECISION.test(ln)) return
    let srcIdx = -1
    for (let j = i; j >= Math.max(0, i - SOURCE_WINDOW_LINES); j -= 1) {
      if (CITED.test(lines[j])) {
        srcIdx = j
        break
      }
    }
    if (srcIdx === -1) return // uncited — findUncitedDecisionSites owns that failure
    sites.push({ line: i + 1, groups: decisionGroupsOf(ln), payload: payloadAt(lines, srcIdx) })
  })
  return sites
}

// Every https:// URL host named in a payload, lowercased and deduplicated.
// Trailing punctuation that prose glues onto a URL is stripped before parsing;
// an unparseable URL contributes no host (and therefore grounds nothing).
const HTTPS_URL = /https:\/\/[^\s"'`<>)\]}]+/g
export function extractHttpsUrlHosts(payload) {
  const hosts = new Set()
  for (const raw of payload.match(HTTPS_URL) ?? []) {
    try {
      hosts.add(new URL(raw.replace(/[.,;:]+$/, '')).hostname.toLowerCase())
    } catch {
      // not a parseable URL — no host to allow
    }
  }
  return [...hosts]
}

// A SOURCE payload resolves when it carries at least one of:
//   (a) a `[corpus: <id>]` reference (the gate separately resolves the id),
//   (b) a repo-relative path that exists on disk (any token containing '/'),
//   (c) an https:// URL whose host is on the shared citation-domains allowlist
//       (tools/lib/citation-domains.mjs) — an arbitrary URL is a claim, not an
//       authority, so non-allowlisted hosts ground nothing.
// Presence-only prose ("trust me") is not provenance.
// ASYMMETRY NOTE: only the tree-wide gate calls this. The PostToolUse hook
// stays presence-only (findUncitedDecisionSites) by design: resolvability
// needs disk/corpus context (does the path exist? does the id resolve?) that a
// per-edit hook deliberately does not load, so it enforces the cheap presence
// floor — blocking on a mandatory class, advising on an advisory one (1.1.0) —
// and the gate owns everything semantic. Same reason the hook never gains the
// corpus group-match: no corpus load per edit.
export function payloadResolves(payload, cwd = process.cwd()) {
  if (new RegExp(CORPUS_REF.source).test(payload)) return true
  for (const raw of payload.split(/\s+/)) {
    const token = raw.replace(/^[('"`[{<]+/, '').replace(/[)'"`\]}>,.;:]+$/, '')
    if (!token.includes('/') || token.startsWith('/') || /^https?:/i.test(token)) continue
    if (existsSync(resolve(cwd, token))) return true
  }
  return extractHttpsUrlHosts(payload).some((h) => isAllowedCitationHost(h))
}
