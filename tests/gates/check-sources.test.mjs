// Can-fail proofs for the provenance gate (template/base/tools/check-sources.mjs).
// Every rule here is fixture-driven: build a scaffold-shaped git tree (the gate
// enumerates via `git ls-files` and reads tools/mcp/corpus/index.json + the G27
// tools/decision-groups.json extension from CWD, but imports its rules lib
// relative to its own file), run the real gate with cwd inside it, assert the
// exact red/green. Unlike the source harness, ALL FOUR checks are FLOOR-NATIVE
// here — this harness shipped them from its first release, so there is no
// version ramp: the semantic checks stay hard on every install vintage (pinned
// below where the SRC suite had a ramp case).
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))
const GATE = fileURLToPath(new URL('../../template/base/tools/check-sources.mjs', import.meta.url))
const SHIPPED_CORPUS = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/mcp/corpus/index.json', import.meta.url)),
  'utf8',
)
// The seeded G27 consumer extension (mobile-security). The shipped corpus tags
// entries with its key, so scaffold-shaped fixtures must carry it too — without
// it the gate would red on "unknown decision group" for the shipped data.
const SHIPPED_GROUPS = readFileSync(
  fileURLToPath(new URL('../../template/base/tools/decision-groups.json', import.meta.url)),
  'utf8',
)
const ALL_GROUP_KEYS = [
  'rls-policy', 'guc-identity', 'token-verification',
  'vector-index', 'llm-sampling', 'tuning-constants',
  'mobile-security',
]

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`)
}

// Minimal scaffold-shaped fixture: a git index (the gate scans `git ls-files`
// relative to cwd) plus corpus + decision-groups copies where the gate reads
// them FROM CWD. A files entry for tools/decision-groups.json overrides the
// seeded copy; one for tools/mcp/corpus/project.json writes the project corpus
// (1.0.4); `corpus: null` omits tools/mcp/corpus/index.json altogether.
function fixture({ files = {}, corpus = SHIPPED_CORPUS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-srcgate-'))
  git(dir, 'init', '-q')
  mkdirSync(join(dir, 'tools/mcp/corpus'), { recursive: true })
  if (corpus !== null) writeFileSync(join(dir, 'tools/mcp/corpus/index.json'), corpus)
  writeFileSync(join(dir, 'tools/decision-groups.json'), SHIPPED_GROUPS)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  git(dir, 'add', '-A')
  return dir
}

function runGate(dir) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, CI: 'true' }
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  delete env.GITHUB_BASE_REF
  // The rules lib resolves tools/decision-groups.json against CLAUDE_PROJECT_DIR
  // when set — the fixture (cwd) must always win here.
  delete env.CLAUDE_PROJECT_DIR
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// ── the backfill proof: a real rendered scaffold is green ─────────────────────
let scaffold

before(() => {
  scaffold = mkdtempSync(join(tmpdir(), 'epah-srcgate-scaffold-'))
  const res = spawnSync(
    'node',
    [
      CLI, 'init', '--dir', scaffold, '--yes',
      '--set', 'PROJECT_NAME=Provenance App',
      '--set', 'GITHUB_OWNER=fixture-owner',
      '--set', 'SECURITY_OWNERS=@fixture-owner/security',
    ],
    { encoding: 'utf8' },
  )
  assert.equal(res.status, 0, `${res.stdout ?? ''}${res.stderr ?? ''}`)
  git(scaffold, 'init', '-q')
  git(scaffold, 'add', '-A')
})

test('GREEN: a rendered scaffold passes — every cited corpus id resolves, hashes are real, all groups covered', () => {
  const r = runGate(scaffold)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('corpus verified'), r.out)
  // 7 built-in groups (0.9.5 added `cryptography` with the e2ee rails) + the
  // seeded mobile-security G27 extension. The count is the LOCKSTEP that matters:
  // a new decision class ships only with a corpus authority that can ground it.
  assert.ok(r.out.includes('8/8 decision groups covered'), r.out)
})

// ── decision-site presence (hook parity) ──────────────────────────────────────
test('RED: an uncited decision site fails naming file:line', () => {
  const r = runGate(fixture({
    files: { 'apps/server/src/auth.ts': 'const claims = await jwtVerify(token, jwks)\n' },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/server/src/auth.ts:1'), r.out)
  assert.ok(r.out.includes('lack an inline'), r.out)
})

// ── gate-file membership: the single-enumeration refactor + fail-closed widening ─
test('WIDENING: a decision site DIRECTLY under apps/ is scanned (old `apps/**/*.ts` pathspec skipped it)', () => {
  // git ls-files `apps/**/*.ts` required ≥1 intermediate dir, so `apps/direct.ts`
  // silently fell out of the old two-pathspec sweep. The single bare `git ls-files`
  // + gateFileMatch's `.+` now catches it — a decision site here can no longer hide.
  const r = runGate(fixture({
    files: { 'apps/direct.ts': 'const claims = await jwtVerify(token, jwks)\n' },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/direct.ts:1'), r.out)
  assert.ok(r.out.includes('lack an inline'), r.out)
})

test('WIDENING: RLS policy SQL under supabase/ is scanned — the schema is SQL-FIRST here', () => {
  // The regression this encodes. The inherited scope admitted `packages/**.sql`,
  // where the ancestor kept its ORM schema. This lineage declares the schema in
  // `supabase/schemas/*.sql` and records it in `supabase/migrations/*.sql`, so the
  // RLS policies — the authorization boundary, the single most security-critical
  // decision surface in the stack — were carrying SOURCE comments that NOTHING
  // verified, and the provenance canary could not bite.
  const policy = [
    'ALTER TABLE public.notes FORCE ROW LEVEL SECURITY;',
    'CREATE POLICY notes_select_own ON public.notes',
    '  FOR SELECT TO authenticated',
    '  USING (owner_id = (SELECT auth.uid()));',
    '',
  ].join('\n')

  const red = runGate(fixture({ files: { 'supabase/migrations/0001_notes.sql': policy } }))
  assert.equal(red.code, 1, red.out)
  assert.ok(red.out.includes('supabase/migrations/0001_notes.sql:1'), red.out)
  assert.ok(red.out.includes('lack an inline'), red.out)

  // …and a cited one passes, so the widening is not simply "always red".
  const green = runGate(
    fixture({
      files: {
        'supabase/migrations/0001_notes.sql':
          '-- SOURCE: https://www.postgresql.org/docs/17/ddl-rowsecurity.html\n' + policy,
      },
    }),
  )
  assert.equal(green.code, 0, green.out)
})

test('gate scope stays apps/packages: an uncited decision in a root/tools .ts is NOT flagged', () => {
  // The gate is deliberately narrower than the hook's whole-tree SCANNABLE_FILE —
  // gateFileMatch only admits apps/ and packages/. A decision site in tools/ is out
  // of the decision sweep (it is still read by the corpus sweep, which finds nothing).
  const r = runGate(fixture({
    files: { 'tools/helper.ts': 'const claims = await jwtVerify(token, jwks)\n' },
  }))
  assert.equal(r.code, 0, r.out)
})

// ── citation resolvability ────────────────────────────────────────────────────
test('RED: a SOURCE citing an unknown corpus id fails naming file, line, and id', () => {
  const r = runGate(fixture({
    files: {
      'apps/server/src/auth.ts':
        '// SOURCE: pinned in corpus [corpus: nonexistent/id]\nconst claims = await jwtVerify(token, jwks)\n',
    },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/server/src/auth.ts:1'), r.out)
  assert.ok(r.out.includes('[corpus: nonexistent/id] does not resolve'), r.out)
})

test('RED: a SOURCE payload with no URL, no existing path, no corpus ref (presence-only prose)', () => {
  const r = runGate(fixture({
    files: {
      'apps/server/src/auth.ts':
        '// SOURCE: trust me\nconst claims = await jwtVerify(token, jwks)\n',
    },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('SOURCE payload resolves to nothing'), r.out)
  assert.ok(r.out.includes('trust me'), r.out)
})

test('GREEN: payloads ground via allowlisted https URL, existing repo-relative path, or corpus id (multi-line comments too)', () => {
  const r = runGate(fixture({
    files: {
      'docs/decisions.md': '# decisions\n',
      'apps/web/lib/supabase/server.ts': [
        // developer.mozilla.org is on the tools/lib/citation-domains.mjs allowlist
        // (a bare URL grounds only on an allowlisted host).
        '// SOURCE: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Authorization',
        'const claims = await jwtVerify(token, jwks)',
        '// SOURCE: rationale recorded in docs/decisions.md',
        'const tolerance = { clockTolerance: 300 }',
        '// SOURCE: getClaims verifies locally against the published key — the corpus',
        '// tail lands on a continuation line, like real wrapped citations',
        '// [corpus: supabase/asymmetric-keys]',
        'const keys = createRemoteJWKSet(url)',
        '',
      ].join('\n'),
    },
  }))
  assert.equal(r.code, 0, r.out)
})

// ── bare-URL host allowlist (tools/lib/citation-domains.mjs) ──────────────────
test('RED: a bare-URL SOURCE on a non-allowlisted host fails naming the host and both remedies', () => {
  const r = runGate(fixture({
    files: {
      'apps/server/src/auth.ts':
        '// SOURCE: https://some-blog.example.dev/jwt-in-five-minutes\nconst claims = await jwtVerify(token, jwks)\n',
    },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/server/src/auth.ts:1'), r.out)
  assert.ok(r.out.includes('some-blog.example.dev'), r.out)
  assert.ok(r.out.includes('citation-domains.mjs'), r.out)
  // 1.0.4: the remedy names the PROJECT corpus. Extending the owned index forks it, and
  // gate-integrity then reds until a human re-records its sha.
  assert.ok(r.out.includes('tools/mcp/corpus/project.json'), r.out)
})

test('GREEN: an allowlisted host grounds a bare-URL citation', () => {
  const r = runGate(fixture({
    files: {
      'apps/web/lib/limits.ts':
        '// SOURCE: https://react.dev/reference/react\nconst opts = { timeoutMs: 5000 }\n',
    },
  }))
  assert.equal(r.code, 0, r.out)
})

test('GREEN: a SUBDOMAIN of an allowlisted domain grounds (www.postgresql.org under postgresql.org)', () => {
  const r = runGate(fixture({
    files: {
      'packages/schema/drizzle/0001_guc.sql':
        "-- SOURCE: https://www.postgresql.org/docs/current/sql-set.html\nSET LOCAL app.user_id = '';\n",
    },
  }))
  assert.equal(r.code, 0, r.out)
})

// ── corpus decision-group match ───────────────────────────────────────────────
test('RED: a decision site citing a corpus entry of the WRONG group fails naming site, group, and cited groups', () => {
  // llamacpp/sampling is pinned with groups: ["llm-sampling"] — it resolves, but
  // it cannot JUSTIFY a token-verification decision.
  const r = runGate(fixture({
    files: {
      'apps/server/src/auth.ts':
        '// SOURCE: pinned but off-topic [corpus: llamacpp/sampling]\nconst claims = await jwtVerify(token, jwks)\n',
    },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('apps/server/src/auth.ts:2'), r.out)
  assert.ok(r.out.includes("decision group 'token-verification'"), r.out)
  assert.ok(r.out.includes('llamacpp/sampling (groups: llm-sampling)'), r.out)
  assert.ok(r.out.includes('tools/provenance-overrides.json'), r.out)
})

test('GREEN: a reviewed { file, group, id, reason } override accepts a specific cross-group cite', () => {
  const r = runGate(fixture({
    files: {
      'apps/server/src/auth.ts':
        '// SOURCE: pinned but off-topic [corpus: llamacpp/sampling]\nconst claims = await jwtVerify(token, jwks)\n',
      'tools/provenance-overrides.json': JSON.stringify({
        comment: 'fixture escape hatch',
        entries: [{
          file: 'apps/server/src/auth.ts',
          group: 'token-verification',
          id: 'llamacpp/sampling',
          reason: 'fixture: cross-group cite reviewed by a human',
        }],
      }),
    },
  }))
  assert.equal(r.code, 0, r.out)
})

test('RED: a PRESENCE-ONLY (groups: []) corpus entry cannot justify a flagged decision — no wildcard', () => {
  // react/compiler ships groups: [] (a real authority for a decision NOT in the
  // flagged taxonomy). A presence-only entry contributes no covered group, so
  // citing it at a token-verification site is unjustified — the site must cite a
  // token-verification entry.
  const r = runGate(fixture({
    files: {
      'apps/server/src/auth.ts':
        '// SOURCE: presence-only, wrong class [corpus: react/compiler]\nconst claims = await jwtVerify(token, jwks)\n',
    },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("decision group 'token-verification'"), r.out)
  assert.ok(r.out.includes('react/compiler (groups: none)'), r.out)
})

test('RED: a corpus entry MISSING its groups key fails closed (groups are mandatory)', () => {
  // A missing `groups` key was the wildcard that made an entry a universal justifier
  // in the source harness's pre-0.1.6 gate. It is a hard corpus-integrity error here:
  // every entry must declare its groups, or [] for a presence-only authority.
  const r = runGate(fixture({
    corpus: JSON.stringify([
      {
        // no `groups` key
        id: 'x/no-groups',
        title: 'T',
        url: 'https://example.com',
        version: '1',
        text: 'body',
        sha256: createHash('sha256').update('body', 'utf8').digest('hex'),
      },
    ]),
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('missing/invalid `groups`'), r.out)
})

test('G27: a consumer decision-groups extension makes an uncited domain constant a flagged site', () => {
  // The seeded groups don't cover a RAG chunk size; the consumer declares it, so
  // `chunkSize` becomes a decision site. The coverage lockstep then reds because no
  // corpus entry grounds the new group — forcing the consumer to add an authority.
  const merged = JSON.parse(SHIPPED_GROUPS)
  merged.groups.push({ key: 'chunk-size', description: 'RAG chunk sizing', patterns: ['chunkSize'] })
  const r = runGate(fixture({
    files: {
      'tools/decision-groups.json': JSON.stringify(merged),
      'packages/importer/src/rag.ts': 'export const chunkSize = 512\n',
    },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('chunk-size'), r.out)
})

test('G27: a malformed decision-groups extension fails CLOSED (citation duty cannot be silently disabled)', () => {
  const r = runGate(fixture({
    files: {
      'tools/decision-groups.json': JSON.stringify({ groups: [{ key: 'BadKey', patterns: [] }] }),
      'packages/importer/src/x.ts': 'export const x = 1\n',
    },
  }))
  assert.equal(r.code, 1, r.out)
})

test('FLOOR-NATIVE: a pre-ramp baseVersion manifest does NOT soften the semantic checks (no NOTE, still red)', () => {
  // The source harness downgraded the group-match + host-allowlist checks to NOTEs
  // for installs whose baseVersion predates 0.1.5. This harness shipped both checks
  // from its first release, so the same manifest changes nothing: hard red, no ramp.
  const r = runGate(fixture({
    files: {
      '.harness/manifest.json': JSON.stringify({ harnessVersion: '0.1.4', baseVersion: '0.1.4' }),
      'apps/server/src/auth.ts': [
        '// SOURCE: pinned but off-topic [corpus: llamacpp/sampling]',
        'const claims = await jwtVerify(token, jwks)',
        '// SOURCE: https://some-blog.example.dev/jwt-in-five-minutes',
        'const tolerance = { clockTolerance: 300 }',
        '',
      ].join('\n'),
    },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("decision group 'token-verification'"), r.out)
  assert.ok(r.out.includes('some-blog.example.dev'), r.out)
  assert.ok(!r.out.includes('NOTE'), r.out)
})

test('RED: a malformed overrides file fails CLOSED even when no finding needs it', () => {
  // Well-formed JSON, broken schema: entries[0] is missing group/id/reason.
  const r = runGate(fixture({
    files: {
      'apps/clean.ts': 'export const nothing = 1\n',
      'tools/provenance-overrides.json': JSON.stringify({
        comment: 'broken fixture',
        entries: [{ file: 'apps/clean.ts' }],
      }),
    },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('malformed overrides fail closed'), r.out)
})

test('RED: an overrides file that is not JSON at all fails closed with the tamper message', () => {
  const r = runGate(fixture({
    files: { 'tools/provenance-overrides.json': 'not json {' },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('not valid JSON'), r.out)
})

// ── corpus integrity: tamper-evident data ─────────────────────────────────────
test('RED: a tampered corpus sha256 fails with the tamper-evidence message', () => {
  const corpus = JSON.parse(SHIPPED_CORPUS)
  corpus[0].sha256 = '0'.repeat(64)
  const r = runGate(fixture({ corpus: JSON.stringify(corpus, null, 2) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(
    r.out.includes(`corpus entry ${corpus[0].id} text/hash mismatch — the corpus is tamper-evident data`),
    r.out,
  )
})

test('RED: a corpus entry with empty url/version fails loud (malformed entries never pass)', () => {
  const corpus = JSON.parse(SHIPPED_CORPUS)
  corpus[1].url = ''
  corpus[1].version = ''
  const r = runGate(fixture({ corpus: JSON.stringify(corpus, null, 2) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`corpus entry ${corpus[1].id}: missing/empty url`), r.out)
  assert.ok(r.out.includes(`corpus entry ${corpus[1].id}: missing/empty version`), r.out)
})

// ── depth lockstep: every decision group needs an authorizing corpus entry ────
test('RED: stripping all groups tags fails naming every uncovered decision group', () => {
  const corpus = JSON.parse(SHIPPED_CORPUS)
  for (const e of corpus) delete e.groups
  const r = runGate(fixture({ corpus: JSON.stringify(corpus, null, 2) }))
  assert.equal(r.code, 1, r.out)
  for (const key of ALL_GROUP_KEYS) {
    assert.ok(r.out.includes(`decision group '${key}'`), `${key}: ${r.out}`)
  }
})

test('RED: a missing corpus index is a broken provenance surface, not a pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-srcgate-'))
  git(dir, 'init', '-q')
  mkdirSync(join(dir, 'apps/server/src'), { recursive: true })
  writeFileSync(
    join(dir, 'apps/server/src/auth.ts'),
    '// SOURCE: entra docs [corpus: entra/jwt-verify]\nconst claims = await jwtVerify(token, jwks)\n',
  )
  git(dir, 'add', '-A')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('tools/mcp/corpus/index.json: missing'), r.out)
})

// ── scope: docs placeholders are not references ───────────────────────────────
test('GREEN: `[corpus: <id>]` documentation placeholders never parse as references', () => {
  const r = runGate(fixture({
    files: { 'docs/howto.md': 'Cite as `// SOURCE: <authority> [corpus: <id>]` on the line above.\n' },
  }))
  assert.equal(r.code, 0, r.out)
})

// ── the project corpus, tools/mcp/corpus/project.json (1.0.4) ─────────────────
// A project adds an authority here instead of forking the owned, hash-pinned index.
// The same per-entry lint judges both files, a project id may not reuse an upstream
// id, and every message about a project entry names the project file.
const PROJECT = 'tools/mcp/corpus/project.json'
const INDEX = 'tools/mcp/corpus/index.json'
// Read inside the test that needs it, so a missing seeded file reds that test alone.
const shippedProject = () =>
  readFileSync(
    fileURLToPath(new URL('../../template/base/tools/mcp/corpus/project.json', import.meta.url)),
    'utf8',
  )

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

function projectEntry(overrides = {}) {
  const text = overrides.text ?? 'A project-pinned authority for verifying the session token.'
  return {
    id: 'project/token-authority',
    title: 'Fixture authority',
    url: 'https://example.com/authority',
    version: '1',
    text,
    sha256: sha(text),
    groups: ['token-verification'],
    ...overrides,
  }
}

const projectCorpus = (entries, extra = {}) =>
  JSON.stringify({ comment: 'fixture project corpus', entries, ...extra }, null, 2)

const CITES_PROJECT_ID =
  '// SOURCE: project authority [corpus: project/token-authority]\nconst claims = await jwtVerify(token, jwks)\n'

test('GREEN: the seeded project.json (an empty entries list) changes no verdict', () => {
  const seeded = shippedProject()
  const r = runGate(fixture({ files: { [PROJECT]: seeded } }))
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(JSON.parse(seeded).entries, [])
})

test('GREEN: a site cites an id that exists only in project.json', () => {
  const r = runGate(fixture({
    files: {
      [PROJECT]: projectCorpus([projectEntry()]),
      'apps/server/src/auth.ts': CITES_PROJECT_ID,
    },
  }))
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('corpus verified'), r.out)
})

test('GREEN: a consumer decision group is covered only by a project entry', () => {
  // The G27 case that used to force a fork: a group added to the seeded
  // decision-groups.json needs a covering entry, and the index is owned.
  const merged = JSON.parse(SHIPPED_GROUPS)
  merged.groups.push({ key: 'chunk-size', description: 'RAG chunk sizing', patterns: ['chunkSize'] })
  const r = runGate(fixture({
    files: {
      'tools/decision-groups.json': JSON.stringify(merged),
      [PROJECT]: projectCorpus([
        projectEntry({ id: 'project/chunking', groups: ['chunk-size'], text: 'Chunk at 512 tokens.' }),
      ]),
      'packages/importer/src/rag.ts':
        '// SOURCE: our chunking study [corpus: project/chunking]\nexport const chunkSize = 512\n',
    },
  }))
  assert.equal(r.code, 0, r.out)
})

test('RED: a project entry justifies only the groups it declares', () => {
  const r = runGate(fixture({
    files: {
      [PROJECT]: projectCorpus([projectEntry({ groups: ['llm-sampling'] })]),
      'apps/server/src/auth.ts': CITES_PROJECT_ID,
    },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("decision group 'token-verification' is not justified"), r.out)
  assert.ok(r.out.includes('project/token-authority (groups: llm-sampling)'), r.out)
  assert.ok(r.out.includes(`add the authority to ${PROJECT}`), r.out)
})

test('RED: a project entry whose text does not match its sha256 names project.json', () => {
  const r = runGate(fixture({
    files: { [PROJECT]: projectCorpus([projectEntry({ sha256: '0'.repeat(64) })]) },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(
    r.out.includes(`${PROJECT}: corpus entry project/token-authority text/hash mismatch`),
    r.out,
  )
})

test('RED: a project entry with bad groups names project.json (missing key, unknown group)', () => {
  const noGroups = projectEntry()
  delete noGroups.groups
  const missing = runGate(fixture({ files: { [PROJECT]: projectCorpus([noGroups]) } }))
  assert.equal(missing.code, 1, missing.out)
  assert.ok(
    missing.out.includes(`${PROJECT}: corpus entry project/token-authority: missing/invalid \`groups\``),
    missing.out,
  )

  const unknown = runGate(fixture({
    files: { [PROJECT]: projectCorpus([projectEntry({ groups: ['no-such-group'] })]) },
  }))
  assert.equal(unknown.code, 1, unknown.out)
  assert.ok(
    unknown.out.includes(
      `${PROJECT}: corpus entry project/token-authority: unknown decision group "no-such-group"`,
    ),
    unknown.out,
  )
})

test('RED: a project entry with an empty url names project.json', () => {
  const r = runGate(fixture({
    files: { [PROJECT]: projectCorpus([projectEntry({ url: '' })]) },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`${PROJECT}: corpus entry project/token-authority: missing/empty url`), r.out)
})

test('RED: a project.json that is not JSON names project.json and fails closed', () => {
  const r = runGate(fixture({ files: { [PROJECT]: 'not json {' } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`${PROJECT}: invalid JSON`), r.out)
})

test('RED: a project.json whose top level is not { comment, entries } names project.json', () => {
  const r = runGate(fixture({ files: { [PROJECT]: JSON.stringify([projectEntry()]) } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`${PROJECT}: expected { comment: string, entries: array }`), r.out)
})

test('RED: a project.json whose entries is not an array names project.json', () => {
  const r = runGate(fixture({
    files: { [PROJECT]: JSON.stringify({ comment: 'x', entries: { id: 'project/a' } }) },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`${PROJECT}: \`entries\` is not an array`), r.out)
})

test('RED: a project.json with an unknown top-level key names project.json and the key', () => {
  const r = runGate(fixture({ files: { [PROJECT]: projectCorpus([], { overrides: [] }) } }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`${PROJECT}: unknown top-level key "overrides"`), r.out)
})

test('RED: a project id equal to an upstream id names both files, and the upstream entry still decides', () => {
  // llamacpp/sampling ships with groups: ["llm-sampling"]. A project copy that claims
  // token-verification must not widen what the upstream authority justifies.
  const r = runGate(fixture({
    files: {
      [PROJECT]: projectCorpus([projectEntry({ id: 'llamacpp/sampling' })]),
      'apps/server/src/auth.ts':
        '// SOURCE: pinned [corpus: llamacpp/sampling]\nconst claims = await jwtVerify(token, jwks)\n',
    },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`${PROJECT}: corpus id "llamacpp/sampling" is already pinned in ${INDEX}`), r.out)
  assert.ok(r.out.includes('llamacpp/sampling (groups: llm-sampling)'), r.out)
})

test('RED: index.json missing while project.json is present — the project file never stands in for it', () => {
  const r = runGate(fixture({
    corpus: null,
    files: {
      [PROJECT]: projectCorpus([projectEntry()]),
      'apps/server/src/auth.ts': CITES_PROJECT_ID,
    },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`${INDEX}: missing`), r.out)
})

test('RED: an id in neither file names both files', () => {
  const r = runGate(fixture({
    files: {
      [PROJECT]: projectCorpus([projectEntry()]),
      'apps/server/src/auth.ts':
        '// SOURCE: pinned nowhere [corpus: project/ghost]\nconst claims = await jwtVerify(token, jwks)\n',
    },
  }))
  assert.equal(r.code, 1, r.out)
  assert.ok(
    r.out.includes(`[corpus: project/ghost] does not resolve to any entry in ${INDEX} or ${PROJECT}`),
    r.out,
  )
})
