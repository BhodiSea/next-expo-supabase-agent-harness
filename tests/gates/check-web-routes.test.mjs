// Can-fail proofs for the WEB half of the route-manifest gate
// (template/base/tools/check-web-routes.mjs, 0.6.0).
//
// Same fixture discipline as the mobile twin (check-route-manifest.test.mjs): the GREEN case
// copies the SHIPPED apps/web/app tree, the shipped page.meta.ts files, the shipped
// web-route-allowlist.json and the shipped web catalog verbatim, then runs the real gate with
// cwd inside the fixture — so template drift reds HERE rather than on someone's first scaffold.
//
// What this pins that the mobile suite cannot: the App Router's own derivation ((group) elided,
// [param]→:param, [...param] and [[...param]]→*param, private _folders excluded, parallel and
// intercepting routes REFUSED rather than guessed), the generated registry's regen-diff, and
// the check that has no mobile counterpart — that every declared state test id is actually
// RENDERED in its own route segment, because the web half has no runtime states sweep to prove
// it at request time.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(new URL('../../template/base/tools/check-web-routes.mjs', import.meta.url))
const GEN = fileURLToPath(new URL('../../template/base/tools/gen-web-routes.mjs', import.meta.url))
const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const WEB = fileURLToPath(new URL('../../template/stack/apps/web', import.meta.url))
const SHIPPED_ALLOWLIST = readFileSync(join(TOOLS, 'web-route-allowlist.json'), 'utf8')

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

/**
 * A scaffold-shaped tree: the shipped app/, lib/ and e2e/ verbatim, plus the gate's own lib/
 * so the script's relative imports resolve. `mutate(dir)` edits the tree before the gate runs.
 * e2e/ joined the copy in 1.1.0 (#77): the per-route browser closure reads the specs.
 * @param {{ allowlist?: any, mutate?: (dir: string) => void }} [opts]
 */
function fixture({ allowlist = SHIPPED_ALLOWLIST, mutate } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-webroutes-'))
  cpSync(join(WEB, 'app'), join(dir, 'apps/web/app'), { recursive: true })
  cpSync(join(WEB, 'lib'), join(dir, 'apps/web/lib'), { recursive: true })
  cpSync(join(WEB, 'e2e'), join(dir, 'apps/web/e2e'), { recursive: true })
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  if (allowlist !== null) {
    writeFileSync(join(dir, 'tools/web-route-allowlist.json'), asText(allowlist))
  }
  mutate?.(dir)
  return dir
}

function allowlistWith(mutate) {
  const a = JSON.parse(SHIPPED_ALLOWLIST)
  mutate(a)
  return a
}

/** Write a page (and optionally its meta) at an app/-relative directory. */
function addPage(dir, segment, { meta = null, body = 'export default function P() {\n  return null\n}\n' } = {}) {
  const abs = join(dir, 'apps/web/app', segment, 'page.tsx')
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body)
  if (meta !== null) writeFileSync(join(dirname(abs), 'page.meta.ts'), meta)
}

function run(script, dir, { ci = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  if (ci) env.CI = 'true'
  const res = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const runGate = (dir, opts) => run(GATE, dir, opts)
/** Regenerate in place — used by the tests that must isolate one finding from the regen-diff. */
const regen = (dir) => run(GEN, dir)

test('GREEN: the shipped web surface passes verbatim', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('route-manifest: OK'), r.out)
  assert.ok(r.out.includes('in sync'), r.out)
  assert.ok(r.out.includes('not-found present'), r.out)
})

test('the GENERATOR and the GATE agree on the shipped tree — --check is in sync', () => {
  // The regen-diff is only a control if the committed artifact really is what the generator
  // emits. If this reds, apps/web/lib/routes.generated.ts was hand-edited or a page moved.
  const r = run(GEN, fixture(), {})
  assert.equal(r.code, 0, r.out)
})

test('RED: a page with no page.meta.ts is named, with the URL it would be served at', () => {
  const r = runGate(
    fixture({ mutate: (dir) => addPage(dir, '(protected)/o/[orgSlug]/settings') }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no id, no title key and no declared loading\/empty\/error states/)
  assert.match(r.out, /"\/o\/:orgSlug\/settings"/)
})

test('RED: a declared state test id that nothing in the segment renders', () => {
  const r = runGate(
    fixture({
      mutate: (dir) => {
        const p = join(dir, 'apps/web/app/(protected)/o/[orgSlug]/notes/page.tsx')
        writeFileSync(p, readFileSync(p, 'utf8').replace('meta.states.empty', '"unrelated"'))
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /states\.empty declares test id "notes-empty" but nothing under/)
})

test('ANTI-VACUITY: page.meta.ts itself does not satisfy the rendered-state check', () => {
  // The declaration lives in page.meta.ts. If the segment scan included it, every declared id
  // would prove itself and this whole check would pass for every route, always — the precise
  // shape of vacuous control the harness keeps finding. Deleting the ONLY renderer while
  // leaving the meta in place must still red.
  const r = runGate(
    fixture({
      mutate: (dir) =>
        rmSync(join(dir, 'apps/web/app/(protected)/o/[orgSlug]/notes/loading.tsx')),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /states\.loading declares test id "notes-loading" but nothing under/)
})

test("RED: a CHILD segment's markup does not satisfy a PARENT's declaration", () => {
  // The segment scan is non-recursive on purpose: letting a nested route's markup answer for
  // its parent is how a state test id gets "found" in a screen the user never sees it on.
  // Here the parent borrows the child's id, which the global-uniqueness rule catches first —
  // and that ordering is itself the point: the two rules close the same hole from both sides.
  const r = runGate(
    fixture({
      mutate: (dir) => {
        const p = join(dir, 'apps/web/app/(protected)/o/page.meta.ts')
        writeFileSync(p, readFileSync(p, 'utf8').replace("'orgs-loading'", "'notes-loading'"))
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /already used by notes\.loading/)
})

test('RED: app/not-found.tsx is REQUIRED chrome', () => {
  const r = runGate(fixture({ mutate: (dir) => rmSync(join(dir, 'apps/web/app/not-found.tsx')) }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /not-found\.tsx is MISSING/)
  assert.match(r.out, /Next renders its own built-in 404/)
})

test('RED: a meta change without regenerating leaves the registry STALE', () => {
  const r = runGate(
    fixture({
      mutate: (dir) => {
        const p = join(dir, 'apps/web/app/(protected)/o/[orgSlug]/notes/page.meta.ts')
        writeFileSync(p, readFileSync(p, 'utf8').replace("id: 'notes'", "id: 'notes2'"))
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /routes\.generated\.ts is stale/)
})

test('RED: an allowlist entry naming a page that no longer exists', () => {
  const r = runGate(
    fixture({ mutate: (dir) => rmSync(join(dir, 'apps/web/app/sign-in'), { recursive: true }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /allowlists "sign-in" but/)
  assert.match(r.out, /stale allowlist entry/)
})

test('RED: a null state with no reviewed unreachableStates row', () => {
  const r = runGate(
    fixture({ allowlist: allowlistWith((a) => { a.unreachableStates = [] }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /states\.error is null with no documented reason/)
})

test('RED: an unreachableStates row whose state became reachable again is STALE', () => {
  const r = runGate(
    fixture({
      allowlist: allowlistWith((a) => {
        a.unreachableStates.push({ route: 'notes', state: 'error', reason: 'x'.repeat(20) })
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /the state became reachable/)
})

test('RED: an allow entry with an EMPTY reason is a bypass, not an escape', () => {
  const r = runGate(
    fixture({ allowlist: allowlistWith((a) => { a.allow[1].reason = '   ' }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /non-empty string/)
})

test('RED: a malformed allowlist FAILS rather than reading as "nothing is allowlisted"', () => {
  const r = runGate(fixture({ allowlist: '{ not json' }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /not valid JSON/)
})

test('RED: a titleKey the web catalog does not carry', () => {
  const r = runGate(
    fixture({
      mutate: (dir) => {
        const p = join(dir, 'apps/web/app/(protected)/o/page.meta.ts')
        writeFileSync(p, readFileSync(p, 'utf8').replace("'route.orgs'", "'route.orgz'"))
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /is not a key in apps\/web\/lib\/i18n\/catalog\.ts/)
})

test('RED: two pages resolving to ONE URL through route groups', () => {
  // Route groups organise the tree and the layout scope; they contribute nothing to the URL.
  // Two pages at the same position under different groups is a build-time conflict, and the
  // registry has to say so rather than silently registering one of them.
  const meta =
    "import type { WebRouteMeta } from '../../../lib/routes'\n" +
    "export const meta = {\n  id: 'orgs-alt',\n  titleKey: 'route.orgs',\n" +
    "  states: { loading: 'alt-loading', empty: 'alt-empty', error: 'alt-error' },\n" +
    '} as const satisfies WebRouteMeta\n'
  const r = runGate(
    fixture({
      mutate: (dir) =>
        addPage(dir, '(marketing)/o', {
          meta,
          body: 'export default function P() {\n  return <div data-testid="alt-loading alt-empty alt-error" />\n}\n',
        }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /two pages resolve to the URL "\/o"/)
})

test('the App Router derivation: [param], [...param] and [[...param]]', async () => {
  const { deriveRoutePath } = await import('../../template/base/tools/lib/web-routes.mjs')
  assert.deepEqual(deriveRoutePath(''), { path: '/' })
  assert.deepEqual(deriveRoutePath('(protected)/o'), { path: '/o' })
  assert.deepEqual(deriveRoutePath('(a)/(b)'), { path: '/' })
  assert.deepEqual(deriveRoutePath('o/[orgSlug]/notes'), { path: '/o/:orgSlug/notes' })
  assert.deepEqual(deriveRoutePath('docs/[...slug]'), { path: '/docs/*slug' })
  assert.deepEqual(deriveRoutePath('docs/[[...slug]]'), { path: '/docs/*slug' })
})

test('the derivation REFUSES conventions it cannot model rather than guessing', async () => {
  const { deriveRoutePath } = await import('../../template/base/tools/lib/web-routes.mjs')
  // An intercepted route renders at two URLs; a manifest row can name one. A parallel slot
  // renders INTO a layout and has no URL of its own. Deriving either one wrong yields a
  // registry that is confidently incorrect about where a page lives, which is worse than one
  // that says it cannot tell.
  //
  // `refusal()` rather than `deriveRoutePath(x).error`: the return is a `{path} | {error}`
  // union, so reading `.error` off it is a type error under the repo's own `tsc --noEmit` —
  // which is the point of returning a union instead of an optional field. Asserting the
  // refusal HAPPENED is a separate claim from what it said, so it is asserted separately.
  const refusal = (dirKey) => {
    const r = deriveRoutePath(dirKey)
    assert.ok('error' in r, `${dirKey} must be refused, got ${JSON.stringify(r)}`)
    return r.error
  }
  assert.match(refusal('feed/(.)photo'), /INTERCEPTING route/)
  assert.match(refusal('feed/(..)photo'), /INTERCEPTING route/)
  assert.match(refusal('dashboard/@analytics/views'), /PARALLEL route slot/)
  assert.match(refusal('o/Settings'), /not a canonical URL segment/)
})

test('a private _folder is not routable and is excluded from enumeration entirely', () => {
  // An underscore-prefixed folder opts itself AND every child out of routing, so a page.tsx
  // beneath one is not a page. Demanding a meta for it would be demanding a registration for
  // a URL that does not exist.
  const r = runGate(fixture({ mutate: (dir) => addPage(dir, '_scratch/draft') }))
  assert.equal(r.code, 0, r.out)
})

test('a Route Handler (route.ts) is plumbing, not a page', () => {
  const r = runGate(
    fixture({
      mutate: (dir) => {
        const abs = join(dir, 'apps/web/app/api/health/route.ts')
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, 'export function GET() {\n  return new Response()\n}\n')
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('SKIP-LOUDLY locally / FAIL-CLOSED in CI when there is no web surface', () => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-webroutes-none-'))
  const ci = runGate(dir)
  assert.equal(ci.code, 1, ci.out)
  assert.match(ci.out, /skips are not allowed in CI/)
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.match(local.out, /SKIPPED/)
})

test('the RAMP: a pre-0.6.0 install gets NOTES, not a red', () => {
  // Projects grow into gates. An install created before 0.6.0 has pages and no page.meta.ts
  // anywhere, so without the ramp every finding would land at once on an upgrade the consumer
  // did not ask for. The findings are still PRINTED — a ramp withholds the exit code, never
  // the information.
  const dir = fixture({
    mutate: (d) => {
      rmSync(join(d, 'apps/web/app/(protected)/o/page.meta.ts'))
      mkdirSync(join(d, '.harness'), { recursive: true })
      writeFileSync(
        join(d, '.harness/manifest.json'),
        JSON.stringify({ baseVersion: '0.5.0', harnessVersion: '0.6.0' }),
      )
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /NOTE — \d+ web-route finding\(s\) withheld by the 0\.6\.0 ramp/)
  assert.match(r.out, /no id, no title key/)
})

test('the RAMP EXPIRES: at harness 0.7.0 the same install reds', () => {
  const dir = fixture({
    mutate: (d) => {
      rmSync(join(d, 'apps/web/app/(protected)/o/page.meta.ts'))
      mkdirSync(join(d, '.harness'), { recursive: true })
      writeFileSync(
        join(d, '.harness/manifest.json'),
        JSON.stringify({ baseVersion: '0.5.0', harnessVersion: '0.7.0' }),
      )
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /RAMP EXPIRED/)
})

test('a FRESH 0.6.0 install is NOT ramped — the check is live from day one', () => {
  const dir = fixture({
    mutate: (d) => {
      rmSync(join(d, 'apps/web/app/(protected)/o/page.meta.ts'))
      mkdirSync(join(d, '.harness'), { recursive: true })
      writeFileSync(
        join(d, '.harness/manifest.json'),
        JSON.stringify({ baseVersion: '0.6.0', harnessVersion: '0.6.0' }),
      )
    },
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.doesNotMatch(r.out, /NOTE/)
})

test('the generator refuses to write a registry it cannot describe', () => {
  // A generator that emitted a partial registry would make the gate's regen-diff pass over a
  // tree with an unregistered page in it — green artifact, missing route.
  const dir = fixture({ mutate: (d) => addPage(d, 'reports') })
  const r = regen(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /are not registrable/)
})

// ── the per-route browser closure (1.1.0, #77) ───────────────────────────────────────
// For every registry entry, some spec under apps/web/e2e must contain at least one of that
// entry's non-null declared state test ids as a QUOTED LITERAL, read after comments are
// blanked. State test ids are globally unique (the check above), so a literal names exactly
// one route. On mobile every route closes through a Maestro flow to a startup budget; until
// this check the web lane was judged on aggregates only, and the seeded suite rendered one
// of its three registered routes (`orgs`) — `notes` was visited only as an anonymous
// redirect and `security` never.

/** Rewrite every spec under the fixture's apps/web/e2e with `edit(text, name)`. */
function editSpecs(dir, edit) {
  const e2e = join(dir, 'apps/web/e2e')
  for (const name of readdirSync(e2e)) {
    const p = join(e2e, name)
    writeFileSync(p, edit(readFileSync(p, 'utf8'), name))
  }
}

/** Every literal of an `orgs` state test id, removed from every spec. */
const ORGS_LITERAL = /(['"`])orgs-(?:loading|empty)\1/g
const dropOrgsIds = (text) => text.replace(ORGS_LITERAL, '$1orgs-renamed$1')

/** A manifest recording the install's vintage. */
function withManifest(dir, baseVersion, harnessVersion) {
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify({ baseVersion, harnessVersion }))
}

test('the shipped suite names a state test id of every registered route', () => {
  // The GREEN above now carries this: the seeded specs cover orgs, notes and security.
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /3 route\(s\) each named by a spec under apps\/web\/e2e/)
})

test('RED: a route no spec names fails, naming the id, the path and its state test ids', () => {
  const r = runGate(fixture({ mutate: (dir) => editSpecs(dir, dropOrgsIds) }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /route-manifest: FAIL/)
  const finding = r.out.split('\n').find((l) => l.includes('orgs (/o)'))
  assert.ok(finding, `no finding names orgs and /o:\n${r.out}`)
  assert.ok(finding.includes("'orgs-loading'") && finding.includes("'orgs-empty'"), finding)
  assert.ok(finding.includes('apps/web/e2e'), finding)
  // One route, one finding: notes and security stay covered by their own specs.
  assert.doesNotMatch(r.out, /notes \(\/o\/:orgSlug\/notes\): no spec/)
})

test('RED: an id that appears only in a comment does not count', () => {
  const r = runGate(
    fixture({
      mutate: (dir) =>
        editSpecs(dir, (text, name) =>
          name === 'authenticated.spec.ts'
            ? `${dropOrgsIds(text)}\n// the empty picker renders 'orgs-empty'\n/* and 'orgs-loading' while it resolves */\n`
            : dropOrgsIds(text),
        ),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.split('\n').some((l) => l.includes('orgs (/o)')), r.out)
})

test('a null state is not required: one named non-null id closes the route', () => {
  // orgs declares error: null (a reviewed unreachableStates row). The finding lists only the
  // two real ids, and a spec naming just one of them — here the loading id — is enough.
  const red = runGate(fixture({ mutate: (dir) => editSpecs(dir, dropOrgsIds) }))
  const finding = red.out.split('\n').find((l) => l.includes('orgs (/o)')) ?? ''
  assert.doesNotMatch(finding, /null|error/, finding)
  const green = runGate(
    fixture({
      mutate: (dir) =>
        editSpecs(dir, (text) => text.replace(/(['"`])orgs-empty\1/g, '$1orgs-loading$1')),
    }),
  )
  assert.equal(green.code, 0, green.out)
})

test('a spec file outside the *.spec.* shape does not close a route', () => {
  // Playwright runs *.spec.* only, so an id in a helper module proves nothing ran.
  const r = runGate(
    fixture({
      mutate: (dir) => {
        editSpecs(dir, dropOrgsIds)
        writeFileSync(join(dir, 'apps/web/e2e/helpers.ts'), "export const ORGS = 'orgs-empty'\n")
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.split('\n').some((l) => l.includes('orgs (/o)')), r.out)
})

test('THE CLOSURE RAMP: a pre-1.1.0 manifest turns the finding into a NOTE', () => {
  const dir = fixture({ mutate: (d) => editSpecs(d, dropOrgsIds) })
  withManifest(dir, '1.0.3', '1.1.0')
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /route-manifest: NOTE — .*expires in 1\.2\.0/)
  assert.ok(r.out.split('\n').some((l) => l.includes('orgs (/o)')), 'the NOTE still lists the finding')
})

test('THE CLOSURE RAMP stays silent when every route is covered, even on a pre-1.1.0 manifest', () => {
  const dir = fixture()
  withManifest(dir, '1.0.3', '1.1.0')
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /NOTE/)
})

test('THE CLOSURE RAMP expires at harness 1.2.0, and a 1.1.0 manifest is never ramped', () => {
  const late = fixture({ mutate: (d) => editSpecs(d, dropOrgsIds) })
  withManifest(late, '1.0.3', '1.2.0')
  const expired = runGate(late)
  assert.equal(expired.code, 1, expired.out)
  assert.match(expired.out, /route-manifest: RAMP EXPIRED/)
  const fresh = fixture({ mutate: (d) => editSpecs(d, dropOrgsIds) })
  withManifest(fresh, '1.1.0', '1.1.0')
  const live = runGate(fresh)
  assert.equal(live.code, 1, live.out)
  assert.doesNotMatch(live.out, /NOTE/)
})

test('the closure findings ride their own ramp: a pre-1.1.0 install still reds on a registry finding', () => {
  // The two lists are separate so the closure's ramp withholds only the closure. A page with
  // no meta is the 0.6.0 check, long expired, and stays a hard red beside the NOTE.
  const dir = fixture({
    mutate: (d) => {
      editSpecs(d, dropOrgsIds)
      addPage(d, '(protected)/o/[orgSlug]/settings')
    },
  })
  withManifest(dir, '1.0.3', '1.1.0')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no id, no title key/)
  assert.match(r.out, /route-manifest: NOTE — /)
})
