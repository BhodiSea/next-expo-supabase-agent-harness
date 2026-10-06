// Proofs for the vertical-slice scaffolder
// (template/base/.claude/skills/authoring-vertical-slice/scripts/scaffold-slice.mjs, #155): it
// writes the shape the worked example uses, so a slice an agent scaffolds starts in that shape
// rather than drifted from it.
//
//   - the web screen is a segment under the org scope, apps/web/app/(protected)/o/[orgSlug]/<slice>/,
//     with its page.meta.ts and loading.tsx, rendering every declared state from meta.states.*;
//   - every data seam the example has gets a stub that cites its reference section:
//     src/data/{port,rows,errors,query-probes,<slice>}.ts, apps/web/lib/app-data/<slice>.ts, and
//     apps/web/lib/app-data/<slice>-port.ts, the ONE function that narrows a client to the port;
//   - `as unknown as` is in that one file and in no other stub;
//   - the Server Action stub teaches the org-gated write;
//   - each step the script must not take itself is a printed `next:` line, and on a web tree
//     shaped like a default scaffold every route-manifest finding the stubs cause is one a
//     `next:` line names, and the gate is green after the three route steps.
//
// Every fixture is a mkdtemp directory removed after the file. No bash and no git: the
// installer-unit job runs tests/gates on windows-latest too.
// SOURCE: template/demo/apps/web/app/(protected)/o/[orgSlug]/notes (the segment the stubs model)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCAFFOLD_SLICE = fileURLToPath(
  new URL(
    '../../template/base/.claude/skills/authoring-vertical-slice/scripts/scaffold-slice.mjs',
    import.meta.url,
  ),
)
const GATE = fileURLToPath(new URL('../../template/base/tools/check-web-routes.mjs', import.meta.url))
const GEN = fileURLToPath(new URL('../../template/base/tools/gen-web-routes.mjs', import.meta.url))
const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const WEB = fileURLToPath(new URL('../../template/stack/apps/web', import.meta.url))

const SLICE = 'release-notes'
const SEGMENT = 'apps/web/app/(protected)/o/[orgSlug]/release-notes'
const VERTICAL = 'packages/verticals/release-notes/src'

/** @type {string[]} */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/** An empty root, removed after the file. */
function emptyRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'epah-scaffold-slice-'))
  made.push(dir)
  return dir
}

/**
 * A web tree shaped like a default (`--tier core`) scaffold: the stack's app/, lib/ and e2e/
 * verbatim, the gate's own lib/ so its relative imports resolve, and the shipped allowlist.
 */
function webRoot() {
  const dir = emptyRoot()
  for (const sub of ['app', 'lib', 'e2e']) {
    cpSync(join(WEB, sub), join(dir, 'apps/web', sub), { recursive: true })
  }
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TOOLS, 'web-route-allowlist.json'), join(dir, 'tools/web-route-allowlist.json'))
  return dir
}

/** Run the scaffolder for SLICE into `dir`. */
function scaffold(dir) {
  const run = spawnSync(process.execPath, [SCAFFOLD_SLICE, SLICE], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  })
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
  return run.stdout
}

/** Run a tool with cwd inside the fixture, CI-shaped (a skip would read as a pass). */
function tool(script, dir) {
  const env = { ...process.env }
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  env.CI = 'true'
  const res = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8')

/** Every path the run reports as scaffolded, relative to `dir`, with forward slashes. */
const scaffolded = (dir, stdout) =>
  stdout
    .split('\n')
    .filter((l) => l.startsWith('scaffolded: '))
    .map((l) => relative(dir, l.slice('scaffolded: '.length)).split('\\').join('/'))

const nextLines = (stdout) => stdout.split('\n').filter((l) => l.startsWith('next: '))

test('the web screen is a segment under the org scope, with a meta and a loading state', () => {
  const dir = emptyRoot()
  const out = scaffold(dir)
  const files = scaffolded(dir, out)
  for (const name of ['page.tsx', 'page.meta.ts', 'loading.tsx']) {
    assert.ok(files.includes(`${SEGMENT}/${name}`), `${SEGMENT}/${name} is scaffolded:\n${out}`)
  }
  assert.equal(existsSync(join(dir, 'apps/web/app', SLICE)), false, 'nothing lands outside the org scope')

  const meta = read(dir, `${SEGMENT}/page.meta.ts`)
  assert.match(meta, /export const meta = \{[\s\S]*\} as const satisfies WebRouteMeta/)
  assert.match(meta, /\bid: 'release-notes',/)
  assert.match(meta, /\btitleKey: 'route\.releaseNotes',/)
  for (const state of ['loading', 'empty', 'error']) {
    assert.match(meta, new RegExp(`\\b${state}: 'release-notes-${state}',`))
  }

  // The page reads the slug from the route, and the segment renders each id from the meta.
  const page = read(dir, `${SEGMENT}/page.tsx`)
  assert.match(page, /readonly params: Promise<\{ readonly orgSlug: string \}>/)
  assert.ok(page.includes('requireOrgContext(orgSlug)'), page)
  assert.ok(page.includes('testID={meta.states.empty}'), page)
  assert.ok(page.includes('data-testid={meta.states.error}'), page)
  assert.ok(read(dir, `${SEGMENT}/loading.tsx`).includes('data-testid={meta.states.loading}'))
  // The landing-page pointer is gone: the stub cites the read seam instead.
  assert.ok(!page.includes('apps/web/app/page.tsx'), page)
  assert.ok(page.includes('apps/web/lib/app-data/release-notes.ts'), page)
})

test('every data seam the example has gets a stub that cites its reference section', () => {
  const dir = emptyRoot()
  const files = scaffolded(dir, scaffold(dir))
  const seams = {
    [`${VERTICAL}/data/port.ts`]: 'the three DAL laws',
    [`${VERTICAL}/data/rows.ts`]: 'the three DAL laws',
    [`${VERTICAL}/data/errors.ts`]: 'the three DAL laws',
    [`${VERTICAL}/data/query-probes.ts`]: 'the query probes',
    [`${VERTICAL}/data/release-notes.ts`]: 'the three DAL laws',
    'apps/web/lib/app-data/release-notes.ts': 'the web read seam',
    'apps/web/lib/app-data/release-notes-port.ts': 'the port narrowing',
  }
  for (const [path, section] of Object.entries(seams)) {
    assert.ok(files.includes(path), `${path} is scaffolded:\n${files.join('\n')}`)
    const body = read(dir, path)
    assert.ok(body.includes(`references/dal-dto.md (${section}`), `${path} cites "${section}":\n${body}`)
    // Comment-only until the vertical resolves, as the router stub is.
    const code = body.split('\n').filter((l) => l.trim() !== '' && !l.trimStart().startsWith('//'))
    assert.deepEqual(code, [], `${path} is comment-only`)
  }
  // The index stub's commented-out export names a file that now exists.
  assert.ok(read(dir, `${VERTICAL}/index.ts`).includes("from './data/release-notes.js'"))
})

test('`as unknown as` is written once, in the narrowing function, and in no other stub', () => {
  const dir = emptyRoot()
  const files = scaffolded(dir, scaffold(dir))
  const casting = files.filter((f) => read(dir, f).includes('as unknown as'))
  assert.deepEqual(casting, ['apps/web/lib/app-data/release-notes-port.ts'])
  const port = read(dir, 'apps/web/lib/app-data/release-notes-port.ts')
  assert.ok(
    port.includes(
      '// export function toReleaseNotesPort(client: SupabaseServerClient): ReleaseNotesDatabase {',
    ),
    port,
  )
  assert.ok(port.includes('//   const port = client as unknown as ReleaseNotesDatabase'), port)
  assert.ok(port.includes('TS2589'), `the rationale is written here, once:\n${port}`)
})

test('the Server Action stub teaches the org-gated write', () => {
  const dir = emptyRoot()
  scaffold(dir)
  const action = read(dir, 'apps/web/app/actions/release-notes.ts')
  assert.ok(action.startsWith("'use server'\n"), action)
  for (const needle of [
    'bindArgsSchemas',
    'OrgSlug',
    'requireOrgContext(orgSlug)',
    'toReleaseNotesPort(gate.data.client)',
    'revalidatePath(`/o/${gate.data.org.slug}/release-notes`)',
  ]) {
    assert.ok(action.includes(needle), `the stub names ${needle}:\n${action}`)
  }
  for (const stale of ['getVerifiedUser()', 'createRequestScopedClient()', "revalidatePath('/release-notes')"]) {
    assert.ok(!action.includes(stale), `the stub no longer teaches ${stale}:\n${action}`)
  }
})

test('each step the script must not take is a printed next: line', () => {
  const dir = emptyRoot()
  const next = nextLines(scaffold(dir))
  const has = (re) => next.some((l) => re.test(l))
  // The migration in the org_id shape of migration-rls.md, not keyed on the user.
  const migration = next.find((l) => l.startsWith('next: compose the migration'))
  assert.ok(migration !== undefined, next.join('\n'))
  assert.match(migration, /org_id/)
  assert.match(migration, /references\/migration-rls\.md/)
  assert.ok(!migration.includes('auth.uid()'), migration)
  assert.ok(!migration.includes('owner index'), migration)
  // The three route steps.
  assert.ok(has(/'route\.releaseNotes'.*apps\/web\/lib\/i18n\/catalog\.ts/), next.join('\n'))
  assert.ok(has(/node tools\/gen-web-routes\.mjs.*routes\.generated\.ts/), next.join('\n'))
  assert.ok(has(/apps\/web\/e2e.*'release-notes-empty'/), next.join('\n'))
  // The probes and the manifest.
  assert.ok(has(/QUERY_PROBES.*src\/data\/query-probes\.ts.*pnpm gen/), next.join('\n'))
  assert.ok(
    has(/packages\/verticals\/release-notes\/package\.json.*"\.".*"\.\/client".*pnpm install/),
    next.join('\n'),
  )
})

test('a second run writes nothing: every stub already exists', () => {
  const dir = emptyRoot()
  scaffold(dir)
  const again = scaffold(dir)
  assert.deepEqual(scaffolded(dir, again), [])
  assert.ok(again.includes('exists, skipped:'), again)
})

test('route-manifest on a default-shaped web tree: every finding is a next: line, and the three route steps turn it green', () => {
  const dir = webRoot()
  assert.equal(tool(GATE, dir).code, 0, 'the default web tree starts green')
  scaffold(dir)

  // With no edits: two findings, the title key the catalog line names and the browser closure
  // the spec line names. The registry is checked only once the list above it is clean.
  const first = tool(GATE, dir)
  assert.equal(first.code, 1, first.out)
  const findings = first.out.split('\n').filter((l) => l.startsWith('  - '))
  const named = [
    /titleKey 'route\.releaseNotes' is not a key in apps\/web\/lib\/i18n\/catalog\.ts/,
    /release-notes \(\/o\/:orgSlug\/release-notes\): no spec under apps\/web\/e2e names/,
  ]
  assert.deepEqual(
    findings.map((l) => named.findIndex((re) => re.test(l))),
    [0, 1],
    first.out,
  )

  // Step 1: the catalog key. Then the registry is stale, which the gen-web-routes line names.
  const catalog = join(dir, 'apps/web/lib/i18n/catalog.ts')
  const text = readFileSync(catalog, 'utf8')
  const keyed = text.replace(/^(\s*)'route\.home': .*$/m, (line, indent) => `${line}\n${indent}'route.releaseNotes': 'Release notes',`)
  assert.notEqual(keyed, text, 'the fixture catalog carries route.home')
  writeFileSync(catalog, keyed)
  const second = tool(GATE, dir)
  assert.equal(second.code, 1, second.out)
  assert.match(second.out, /routes\.generated\.ts is stale/)

  // Step 2: regenerate. Then only the browser closure is open, which the spec line names.
  assert.equal(tool(GEN, dir).code, 0)
  const third = tool(GATE, dir)
  assert.equal(third.code, 1, third.out)
  assert.match(third.out, /release-notes/)
  assert.doesNotMatch(third.out, /stale|not a key|no apps\/web\/app/)

  // Step 3: a spec that names one state id. Green.
  mkdirSync(join(dir, 'apps/web/e2e'), { recursive: true })
  writeFileSync(
    join(dir, 'apps/web/e2e/release-notes.spec.ts'),
    "import { expect, test } from '@playwright/test'\n\ntest('a new org has no release notes', async ({ page }) => {\n  await expect(page.getByTestId('release-notes-empty')).toBeVisible()\n})\n",
  )
  const last = tool(GATE, dir)
  assert.equal(last.code, 0, last.out)
})
