// In-process characterization tests for the provenance heuristic's single source
// of truth (template/base/tools/lib/provenance-rules.mjs). Both enforcement
// layers — the per-edit PostToolUse hook and the tree-wide `provenance` gate —
// import from here, so this file pins the shared decision-site window, the
// comment-line skips, the wrapped-payload extractor, payloadResolves' three
// grounding kinds (corpus ref, existing path, ALLOWLISTED https URL — the
// citation-domains gate), findCitedDecisionSites (the group-match input), and
// the scope predicates (including Windows backslash normalization) branch by
// branch. It pins CURRENT behavior, not a wishlist. The gate's end-to-end
// red/green lives in check-sources.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CITATION_DOMAINS,
  isAllowedCitationHost,
} from '../../template/base/tools/lib/citation-domains.mjs'
import {
  CORPUS_REF,
  DECISION,
  DECISION_GROUPS,
  SOURCE_WINDOW_LINES,
  extractHttpsUrlHosts,
  extractSourceComments,
  findCitedDecisionSites,
  findUncitedDecisionSites,
  gateFileMatch,
  gateScansFile,
  hookScansFile,
  payloadResolves,
} from '../../template/base/tools/lib/provenance-rules.mjs'

// ── exported shape: the decision taxonomy and its knobs ───────────────────────
// NOTE: the harness repo root has no tools/decision-groups.json, so only the six
// BUILT-IN groups load here; the seeded `mobile-security` consumer group is
// covered end-to-end by check-sources.test.mjs against a rendered scaffold.
test('DECISION_GROUPS carries the six built-in stack decision classes in order', () => {
  assert.deepEqual(
    DECISION_GROUPS.map((g) => g.key),
    ['rls-policy', 'guc-identity', 'token-verification', 'vector-index', 'llm-sampling', 'tuning-constants'],
  )
  for (const g of DECISION_GROUPS) {
    assert.ok(Array.isArray(g.patterns) && g.patterns.length > 0, `${g.key} has patterns`)
    assert.equal(typeof g.description, 'string')
  }
  assert.equal(SOURCE_WINDOW_LINES, 3)
})

// ── gateFileMatch: the tree-wide gate-file membership (replaces GATE_FILE_GLOBS) ──
test('gateFileMatch: apps/packages .ts/.tsx and packages .sql are in scope', () => {
  assert.equal(gateFileMatch('apps/mobile/src/App.tsx'), true)
  assert.equal(gateFileMatch('apps/server/src/auth.ts'), true)
  assert.equal(gateFileMatch('packages/schema/src/index.ts'), true)
  assert.equal(gateFileMatch('packages/schema/src/x.tsx'), true)
  assert.equal(gateFileMatch('packages/api/src/schema.sql'), true)
})

test('gateFileMatch: out-of-scope trees, wrong extensions, and apps/*.sql are excluded', () => {
  // .sql is packages-only — the old pathspecs never listed apps/**/*.sql.
  assert.equal(gateFileMatch('apps/mobile/src/query.sql'), false)
  // Only apps/ and packages/ are gate scope (narrower than the hook by design).
  assert.equal(gateFileMatch('tools/check-sources.mjs'), false)
  assert.equal(gateFileMatch('root.ts'), false)
  assert.equal(gateFileMatch('docs/notes.md'), false)
  assert.equal(gateFileMatch('apps/mobile/src/config.json'), false)
})

test('gateFileMatch: WIDENING — files DIRECTLY under apps/ or packages/ are in scope', () => {
  // git ls-files `apps/**/*.ts` requires ≥1 intermediate dir and SKIPS these; the
  // `.+` regex includes them — the wider, fail-closed reading (a decision site
  // directly under apps/ or packages/ is scanned, not silently missed).
  assert.equal(gateFileMatch('apps/top.ts'), true)
  assert.equal(gateFileMatch('apps/top.tsx'), true)
  assert.equal(gateFileMatch('packages/root.sql'), true)
  assert.equal(gateFileMatch('packages/root.ts'), true)
})

test('gateFileMatch: Windows backslash paths are POSIX-normalized before matching', () => {
  assert.equal(gateFileMatch('apps\\mobile\\src\\App.tsx'), true)
  assert.equal(gateFileMatch('packages\\api\\src\\schema.sql'), true)
  // Normalization must not widen scope: apps\...\*.sql is still out (packages-only).
  assert.equal(gateFileMatch('apps\\mobile\\src\\query.sql'), false)
})

test('DECISION matches one representative token per group and is case-sensitive', () => {
  const reps = [
    'FORCE ROW LEVEL SECURITY', 'CREATE POLICY', 'auth.uid()',
    'current_setting(', 'set_config(', 'SET LOCAL',
    'jwtVerify', 'createRemoteJWKSet', 'createLocalJWKSet', 'clockTolerance',
    'USING hnsw', 'USING ivfflat', 'vector_cosine_ops',
    'temperature: 0.2', 'top_p = 1',
    'maxRetries', 'timeoutMs', 'rateLimit', 'backoff',
  ]
  for (const r of reps) assert.ok(DECISION.test(r), `DECISION should match ${r}`)
  // No `i` flag: the heuristic keys off exact identifiers, not prose lookalikes.
  assert.ok(!DECISION.test('jwtverify'), 'lowercased identifier must not match')
  assert.ok(!DECISION.test('the temperature outside'), 'temperature without :/= must not match')
})

// ── hookScansFile: scannability + excludes + POSIX normalization ───────────────
test('hookScansFile: scannable extensions in-scope; non-code files out', () => {
  assert.equal(hookScansFile('apps/server/src/auth.ts'), true)
  assert.equal(hookScansFile('apps/mobile/src/App.tsx'), true)
  assert.equal(hookScansFile('supabase/migrations/0001_x.sql'), true)
  // Only .ts/.tsx/.sql carry the comments the heuristic reads.
  assert.equal(hookScansFile('apps/server/src/config.json'), false)
  assert.equal(hookScansFile('tools/notes.md'), false)
  assert.equal(hookScansFile('apps/mobile/src/main.js'), false)
})

test('hookScansFile: SCAN_EXCLUDES drop tests and machine-generated adapters', () => {
  assert.equal(hookScansFile('apps/web/lib/app-data/notes.test.ts'), false)
  assert.equal(hookScansFile('apps/mobile/src/App.spec.tsx'), false)
  // The generated token adapter is regen-diffed by the styleguide gate, never cited.
  assert.equal(hookScansFile('packages/design-tokens/src/generated/native.ts'), false)
  // The Supabase type mirror is `supabase gen types` output, never cited.
  assert.equal(hookScansFile('packages/platform/supabase/src/database.types.ts'), false)
})

test('hookScansFile: HOOK_EXCLUDES drop .claude tooling ONLY when nested (leading slash required)', () => {
  // The hook receives OS-absolute paths, so `.claude` is always a nested segment.
  assert.equal(hookScansFile('/home/me/proj/.claude/hooks/posttool.ts'), false)
  // A bare relative path starting with `.claude` has no `/` before it — the
  // exclude regex (`/\.claude\/`) does not fire. Documents the leading-slash
  // requirement; the hook never actually feeds this form.
  assert.equal(hookScansFile('.claude/hooks/posttool.ts'), true)
})

test('hookScansFile: Windows backslash paths are POSIX-normalized before the /-based excludes run', () => {
  // The whole point of toPosix at this boundary — `packages\...\src\generated\native.ts`
  // must still hit the `/generated/` exclude on windows-latest.
  assert.equal(hookScansFile('packages\\design-tokens\\src\\generated\\native.ts'), false)
  assert.equal(hookScansFile('apps\\mobile\\src\\App.test.tsx'), false)
  assert.equal(hookScansFile('packages\\platform\\supabase\\src\\database.types.ts'), false)
  assert.equal(hookScansFile('C:\\proj\\.claude\\hooks\\posttool.ts'), false)
  // A normal Windows path that is NOT excluded still scans (normalization must
  // not break the happy path).
  assert.equal(hookScansFile('apps\\server\\src\\auth.ts'), true)
})

// ── gateScansFile: excludes-only, no scannability or hook excludes ─────────────
test('gateScansFile applies SCAN_EXCLUDES but NOT scannability or HOOK_EXCLUDES', () => {
  assert.equal(gateScansFile('apps/server/src/auth.ts'), true)
  assert.equal(gateScansFile('apps/server/src/auth.test.ts'), false)
  assert.equal(gateScansFile('packages/design-tokens/src/generated/native.ts'), false)
  assert.equal(gateScansFile('packages/platform/supabase/src/database.types.ts'), false)
  // Excludes-only: the gate trusts its git globs to only feed .ts/.tsx/.sql, so
  // a non-code path is "not excluded" -> true, and `.claude` is not a gate
  // exclude (its globs never reach there). Contrast hookScansFile above.
  assert.equal(gateScansFile('foo.js'), true)
  assert.equal(gateScansFile('.claude/hooks/foo.ts'), true)
})

// ── findUncitedDecisionSites: the window + comment-line heuristic ──────────────
test('an uncited decision line is flagged with 1-based line and a trimmed excerpt', () => {
  const flagged = findUncitedDecisionSites('  const claims = await jwtVerify(token, jwks)\n')
  assert.deepEqual(flagged, [{ line: 1, excerpt: 'const claims = await jwtVerify(token, jwks)' }])
})

test('a keyword appearing INSIDE a `//`, `*`, `/*` or `--` comment line is a mention, not a decision', () => {
  assert.deepEqual(findUncitedDecisionSites('// we call jwtVerify below\n'), [])
  assert.deepEqual(findUncitedDecisionSites(' * jwtVerify in the JSDoc\n'), [])
  assert.deepEqual(findUncitedDecisionSites('/* jwtVerify note */\n'), [])
  assert.deepEqual(findUncitedDecisionSites('-- CREATE POLICY described here\n'), [])
})

test('a SOURCE on the decision line itself (trailing comment) cites it', () => {
  const src = 'const c = jwtVerify(t) // SOURCE: https://example.com/jose\n'
  assert.deepEqual(findUncitedDecisionSites(src), [])
})

test('SOURCE_WINDOW_LINES=3: a citation exactly three lines above cites; four above does not', () => {
  const covered = ['// SOURCE: x', 'a', 'b', 'const c = jwtVerify()'].join('\n')
  assert.deepEqual(findUncitedDecisionSites(covered), [])
  const justOut = ['// SOURCE: x', 'a', 'b', 'c', 'const d = jwtVerify()'].join('\n')
  assert.deepEqual(findUncitedDecisionSites(justOut), [{ line: 5, excerpt: 'const d = jwtVerify()' }])
})

test('the window only looks UP — a SOURCE on the line below does not cite the decision', () => {
  const src = ['const c = jwtVerify()', '// SOURCE: x'].join('\n')
  assert.deepEqual(findUncitedDecisionSites(src), [{ line: 1, excerpt: 'const c = jwtVerify()' }])
})

test('mixed cited/uncited sites: only lines outside every SOURCE window are returned', () => {
  const src = [
    '// SOURCE: https://a', // 1
    'const a = jwtVerify()', // 2 — cited (SOURCE one line up)
    'const p = 1', // 3 — padding, pushes the SOURCE out of range
    'const q = 2', // 4
    'const r = 3', // 5
    'const b = createRemoteJWKSet(u)', // 6 — uncited (SOURCE five lines up)
    'const t = { clockTolerance: 300 }', // 7 — uncited
  ].join('\n')
  assert.deepEqual(findUncitedDecisionSites(src), [
    { line: 6, excerpt: 'const b = createRemoteJWKSet(u)' },
    { line: 7, excerpt: 'const t = { clockTolerance: 300 }' },
  ])
})

test('the excerpt is trimmed and hard-capped at 80 characters', () => {
  const long = `const x = jwtVerify(${'a'.repeat(120)})`
  const [hit] = findUncitedDecisionSites(long)
  assert.equal(hit.excerpt.length, 80)
  assert.ok(hit.excerpt.startsWith('const x = jwtVerify('))
})

test('LINE-BASED LIMIT: a block-comment interior line not starting with `*` is still scanned', () => {
  // Characterization, not endorsement: the heuristic is line-based, so a `/* */`
  // interior line that does not lead with `*` looks like code and gets flagged.
  // Properly-formatted JSDoc (`*`-prefixed) is skipped (asserted above).
  const src = ['/*', '  jwtVerify happens here', '*/'].join('\n')
  assert.deepEqual(findUncitedDecisionSites(src), [{ line: 2, excerpt: 'jwtVerify happens here' }])
})

test('empty source yields no flags', () => {
  assert.deepEqual(findUncitedDecisionSites(''), [])
})

// ── extractSourceComments: wrapped-payload extraction ─────────────────────────
test('a single-line SOURCE returns everything after `SOURCE:` (leading space preserved)', () => {
  assert.deepEqual(extractSourceComments('// SOURCE: https://example.com/x\n'), [
    { line: 1, payload: ' https://example.com/x' },
  ])
})

test('a wrapped citation appends continuation comment lines until a non-comment line', () => {
  const src = [
    '// SOURCE: jose is the reference',
    '  // implementation [corpus: entra/jwt-verify]',
    'const x = 1',
    'more',
  ].join('\n')
  // Continuation lines are trimmed but keep their `//` marker; the code line ends it.
  assert.deepEqual(extractSourceComments(src), [
    { line: 1, payload: ' jose is the reference\n// implementation [corpus: entra/jwt-verify]' },
  ])
})

test('CITED requires `//` or `--`: a `/** SOURCE: ... */` JSDoc-block citation is NOT recognized', () => {
  // Genuine gotcha — the head marker must be `//` (or `--`), so a block-comment
  // SOURCE is silently invisible to both extraction and the citation check.
  assert.deepEqual(extractSourceComments('/** SOURCE: entra docs [corpus: entra/jwt-verify] */\ncode\n'), [])
})

test('`*`-prefixed continuation lines are folded into the payload (COMMENT_START `*` branch)', () => {
  const src = ['// SOURCE: entra docs', ' * [corpus: entra/jwt-verify]', ' */', 'code'].join('\n')
  assert.deepEqual(extractSourceComments(src), [
    { line: 1, payload: ' entra docs\n* [corpus: entra/jwt-verify]\n*/' },
  ])
})

test('a new SOURCE comment terminates the previous payload — both are captured separately', () => {
  const src = ['// SOURCE: a', '// SOURCE: b', 'code'].join('\n')
  assert.deepEqual(extractSourceComments(src), [
    { line: 1, payload: ' a' },
    { line: 2, payload: ' b' },
  ])
})

test('`-- SOURCE:` in SQL is extracted like `//`, with 1-based line numbers', () => {
  const src = ['SELECT 1;', '-- SOURCE: pgvector docs [corpus: pgvector/hnsw]', 'code'].join('\n')
  assert.deepEqual(extractSourceComments(src), [
    { line: 2, payload: ' pgvector docs [corpus: pgvector/hnsw]' },
  ])
})

// ── CORPUS_REF: the reference matcher ─────────────────────────────────────────
test('CORPUS_REF captures each id via matchAll and rejects the `<id>` placeholder', () => {
  const ids = [...'x [corpus: a/b] y [corpus: c.d]'.matchAll(CORPUS_REF)].map((m) => m[1])
  assert.deepEqual(ids, ['a/b', 'c.d'])
  // The id charset excludes `<`/`>`, so documentation placeholders never parse.
  assert.deepEqual([...'[corpus: <id>]'.matchAll(CORPUS_REF)], [])
})

// ── payloadResolves: the three grounding kinds (URL allowlist-gated) ──────────
test('payloadResolves: corpus refs and ALLOWLISTED https URLs ground; other hosts, http-only and prose do not', () => {
  assert.equal(payloadResolves('pinned [corpus: entra/jwt-verify]'), true)
  // A bare URL grounds only when its host is on the shared allowlist in
  // tools/lib/citation-domains.mjs.
  assert.equal(payloadResolves('see https://react.dev/reference/react'), true)
  assert.equal(payloadResolves('see https://www.postgresql.org/docs/current/sql-set.html'), true)
  // learn.microsoft.com IS allowlisted in this stack (Entra ID / API guidelines)
  // — the source harness kept it off; the port added it deliberately.
  assert.equal(payloadResolves('see https://learn.microsoft.com/entra'), true)
  // github.com user content is NOT provenance (docs.github.com is; see below).
  assert.equal(payloadResolves('see https://github.com/someone/some-repo'), false)
  // A disallowed URL plus a corpus ref still grounds — the corpus is the authority.
  assert.equal(
    payloadResolves('https://login.microsoftonline.com/{tenant}/v2.0 [corpus: entra/jwt-verify]'),
    true,
  )
  // Only https:// counts as a URL — a plain http:// token is skipped by the
  // `^https?:` guard in the path loop and grounds nothing (even on an allowlisted host).
  assert.equal(payloadResolves('see http://react.dev/x'), false)
  // Presence-only prose ("trust me") is not provenance.
  assert.equal(payloadResolves('trust me'), false)
  // The `<id>` placeholder is not a resolvable corpus ref.
  assert.equal(payloadResolves('[corpus: <id>]'), false)
})

// ── citation-domains: the shared bare-URL host allowlist ──────────────────────
test('isAllowedCitationHost: exact match, subdomain match, case/trailing-dot normalization; no suffix spoofing', () => {
  assert.ok(CITATION_DOMAINS.includes('react.dev'))
  assert.equal(isAllowedCitationHost('react.dev'), true)
  assert.equal(isAllowedCitationHost('www.postgresql.org'), true) // subdomain of postgresql.org
  assert.equal(isAllowedCitationHost('REACT.DEV'), true)
  assert.equal(isAllowedCitationHost('react.dev.'), true) // FQDN trailing dot normalized
  // A registrable domain that merely ENDS with an allowlisted string is not a match.
  assert.equal(isAllowedCitationHost('evilreact.dev'), false)
  assert.equal(isAllowedCitationHost('react.dev.attacker.io'), false)
  assert.equal(isAllowedCitationHost('github.com'), false) // user content — corpus-pin instead
})

test("isAllowedCitationHost: this stack's platform docs hosts are ON; their apexes stay off where stated", () => {
  // docs.expo.dev is the documentation host — the expo.dev apex carries
  // marketing and user-generated project pages and is deliberately NOT listed.
  assert.equal(isAllowedCitationHost('docs.expo.dev'), true)
  assert.equal(isAllowedCitationHost('expo.dev'), false)
  assert.equal(isAllowedCitationHost('reactnative.dev'), true)
  assert.equal(isAllowedCitationHost('developer.android.com'), true)
  // developer.apple.com joined in 0.1.2: HIG hit-target guidance and the App
  // Review Guidelines/Info.plist keys the store-readiness checks cite.
  assert.equal(isAllowedCitationHost('developer.apple.com'), true)
  assert.equal(isAllowedCitationHost('apple.com'), false)
  // docs.github.com (GitHub's OWN product docs) matches; github.com does not.
  assert.equal(isAllowedCitationHost('docs.github.com'), true)
  // learn.microsoft.com is listed — but not microsoft.com at large.
  assert.equal(isAllowedCitationHost('learn.microsoft.com'), true)
  assert.equal(isAllowedCitationHost('www.microsoft.com'), false)
})

test('extractHttpsUrlHosts: lowercased, deduplicated hosts; glued punctuation stripped; junk yields none', () => {
  assert.deepEqual(
    extractHttpsUrlHosts('see https://react.dev/a and https://REACT.dev/b, then https://www.w3.org/TR/.'),
    ['react.dev', 'www.w3.org'],
  )
  assert.deepEqual(extractHttpsUrlHosts('no urls here, only prose and http://x.dev'), [])
})

// ── findCitedDecisionSites: the group-match input (cited complement) ──────────
test('findCitedDecisionSites returns cited sites with their decision groups and the nearest wrapped payload', () => {
  const src = [
    '// SOURCE: entra docs, wrapped onto', // 1
    '// a continuation line [corpus: entra/jwt-verify]', // 2
    'const claims = await jwtVerify(token, jwks)', // 3 — cited, token-verification
    'const pad = 1', // 4
    'const uncited = createRemoteJWKSet(url)', // 5 — nearest SOURCE is 4 lines up: out of window
    '',
  ].join('\n')
  const sites = findCitedDecisionSites(src)
  assert.equal(sites.length, 1)
  assert.equal(sites[0].line, 3)
  assert.deepEqual(sites[0].groups, ['token-verification'])
  assert.ok(sites[0].payload.includes('[corpus: entra/jwt-verify]'))
  // the out-of-window site is findUncitedDecisionSites' finding, never a cited site
  assert.deepEqual(findUncitedDecisionSites(src).map((f) => f.line), [5])
})

test('findCitedDecisionSites: a line matching TWO groups reports both; uncited lines are not returned', () => {
  const src = [
    '-- SOURCE: policy over the GUC [corpus: postgres/rls-initplan]', // 1
    "CREATE POLICY p ON t USING (owner = (select current_setting('app.user_id', true)::uuid));", // 2
    'const a = 1', // 3 — padding pushes the SOURCE out of the next site's window
    'const b = 2', // 4
    'const bare = { maxRetries: 3 }', // 5 — uncited
  ].join('\n')
  const sites = findCitedDecisionSites(src)
  assert.equal(sites.length, 1)
  assert.equal(sites[0].line, 2)
  assert.deepEqual(sites[0].groups, ['rls-policy', 'guc-identity'])
  // the uncited maxRetries line belongs to findUncitedDecisionSites, not here
  assert.deepEqual(findUncitedDecisionSites(src).map((f) => f.line), [5])
})

test('payloadResolves: a corpus ref stays truthy across repeated calls (no global-regex lastIndex leak)', () => {
  // The impl builds a fresh non-global RegExp from CORPUS_REF.source precisely so
  // the module-level global regex cannot drift lastIndex between calls.
  const payload = 'grounded [corpus: harness/doctrine]'
  assert.equal(payloadResolves(payload), true)
  assert.equal(payloadResolves(payload), true)
  assert.equal(payloadResolves(payload), true)
})

test('payloadResolves: a repo-relative path grounds only when it exists on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-provres-'))
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs', 'decisions.md'), '# decisions\n')
  // Bare existing token, plus leading/trailing punctuation stripping.
  assert.equal(payloadResolves('rationale in docs/decisions.md', dir), true)
  assert.equal(payloadResolves('see (docs/decisions.md) for details', dir), true)
  assert.equal(payloadResolves('recorded in docs/decisions.md.', dir), true)
  // A path-shaped token that does not exist grounds nothing.
  assert.equal(payloadResolves('docs/nope.md', dir), false)
  // An absolute path is skipped by the `startsWith('/')` guard even if real.
  assert.equal(payloadResolves('/etc/hosts', dir), false)
  // A single token with no `/` is never treated as a path.
  assert.equal(payloadResolves('decisions', dir), false)
})
