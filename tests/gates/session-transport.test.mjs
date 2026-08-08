// The session-transport closure (0.6.0) — the control that would have caught the seeded web
// app shipping a SIGN-IN LOOP for two releases, and which no lane in the tree could catch.
//
// THE DEFECT, so the fixtures below are read as history rather than as hypotheses.
// `apps/web/lib/supabase/client.ts` constructed the browser client with no `storage`, so
// @supabase/supabase-js persisted the session to localStorage — its documented default —
// while `proxy.ts`, `lib/supabase/server.ts` and the tRPC route's cookie branch all read the
// session out of the COOKIE JAR. Two disjoint stores. Sign-in succeeded, the protected
// layout's getVerifiedUser() saw nothing, and it redirected straight back to /sign-in.
//
// Separately, four comments asserted the session cookie was `httpOnly` and no code set it —
// and on this architecture nothing could, because the browser writes the cookie and a user
// agent ignores HttpOnly on a `document.cookie` write.
//
// Every fixture marked AS SHIPPED is the real prior text, not an invention. A red-proof
// written against a made-up violation proves the arithmetic; one written against the code
// that actually shipped proves the control.
// SOURCE: template/base/tools/lib/session-transport.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { sessionTransportProblems } from '../../template/base/tools/lib/session-transport.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const STACK = join(ROOT, 'template/stack')
const POLICY = JSON.parse(
  readFileSync(join(ROOT, 'template/base/tools/auth-posture.json'), 'utf8'),
).sessionTransport

const shipped = (rel) => ({ path: rel, text: readFileSync(join(STACK, rel), 'utf8') })
const judge = (files, policy = POLICY) =>
  sessionTransportProblems({ app: 'apps/web', files, policy })

const SEEDED = [
  'apps/web/lib/supabase/client.ts',
  'apps/web/lib/supabase/server.ts',
  'apps/web/proxy.ts',
  'packages/platform/supabase/src/cookies.ts',
  'packages/platform/supabase/src/cookie-server.ts',
].map(shipped)

// ── the seeded tree ────────────────────────────────────────────────────────────────────

test('the SHIPPED web surface satisfies the closure', () => {
  assert.deepEqual(judge(SEEDED), [])
})

test('the policy declares a required attribute and an unavailable one', () => {
  // A closure with an empty policy is a gate that cannot red. Both lists are load-bearing:
  // `required` drives the writer census, `unavailable` drives the prose check.
  assert.ok((POLICY.requiredCookieAttributes ?? []).includes('secure'))
  assert.ok((POLICY.unavailableCookieAttributes ?? []).includes('httpOnly'))
  assert.ok((POLICY.unavailableWhy ?? '').length > 40, 'an unavailable attribute needs a reason')
})

// ── §1 transport agreement ─────────────────────────────────────────────────────────────

test('CANARY — the browser client as it ACTUALLY SHIPPED reds', () => {
  const asShipped = [
    {
      path: 'apps/web/lib/supabase/client.ts',
      text: `import { createBrowserSupabaseClient } from '@app/supabase/client'
let browserClient = null
export function getBrowserClient() {
  browserClient ??= createBrowserSupabaseClient()
  return browserClient
}`,
    },
    shipped('apps/web/lib/supabase/server.ts'),
  ]
  const problems = judge(asShipped)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /constructed without a `storage`/)
  // The message must name the CONSEQUENCE, because the reader of this red is someone whose
  // app appears to work until they sign in.
  assert.match(problems[0], /sign-in LOOP/)
  assert.match(problems[0], /localStorage is never sent with a request/)
})

test('a browser client WITHOUT a cookie-reading server is not a finding', () => {
  // The pairing is the defect, never either half alone: a localStorage-backed browser client
  // is exactly right for an SPA that never server-renders an identity. A rule that reddened
  // that would be a rule telling correct code it is wrong, and it would get deleted.
  const spa = [
    {
      path: 'apps/spa/lib/client.ts',
      text: `const c = createBrowserSupabaseClient()`,
    },
  ]
  assert.deepEqual(judge(spa), [])
})

test('a cookie-reading server with NO browser client is not a finding either', () => {
  const ssrOnly = [shipped('apps/web/lib/supabase/server.ts')]
  assert.deepEqual(judge(ssrOnly), [])
})

// ── §2 cookie attributes at every writer ───────────────────────────────────────────────

test('CANARY — either server writer dropping cookieOptions reds', () => {
  for (const rel of ['apps/web/proxy.ts', 'apps/web/lib/supabase/server.ts']) {
    const stripped = SEEDED.map((f) =>
      f.path === rel
        ? {
            path: rel,
            text: f.text.replace(
              /createServerSupabaseClient\((\w+),[\s\S]*?\n {2}\}\)/,
              'createServerSupabaseClient($1)',
            ),
          }
        : f,
    )
    const problems = judge(stripped)
    assert.equal(
      problems.length,
      1,
      `${rel}: expected exactly one finding, got ${JSON.stringify(problems)}`,
    )
    assert.match(problems[0], new RegExp(`^${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `))
    // BOTH writers, not one: this client REWRITES the cookie, so a posture held at two of
    // three writers is a silent downgrade rather than a posture.
    assert.match(problems[0], /strips off the value another writer set/)
  }
})

test('a cookieOptions missing a REQUIRED attribute reds, naming the attribute', () => {
  const half = [
    {
      path: 'apps/web/proxy.ts',
      text: `createServerSupabaseClient(cookies, { cookieOptions: { sameSite: 'lax' } })`,
    },
  ]
  const problems = judge(half)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /names no `secure`/)
})

test('the factory DEFINITION is not mistaken for a call site', () => {
  // The signature `export function createServerSupabaseClient(cookies, options)` passes no
  // cookieOptions by construction. Reporting it would make the gate fire inside the package
  // it protects, on every install, forever.
  const definition = [shipped('packages/platform/supabase/src/cookie-server.ts')]
  assert.deepEqual(judge(definition), [])
})

// ── §3 an unavailable attribute may be NAMED only to DISCLAIM it ───────────────────────

test('CANARY — the false hardening comment as it ACTUALLY SHIPPED reds', () => {
  const asShipped = [
    {
      path: 'packages/platform/supabase/src/cookie-server.ts',
      text: `/** Attributes for cookies this client writes. The host supplies \`secure\` and
   * \`httpOnly\`, because only the host knows its scheme and its readers. */
  readonly cookieOptions?: SupabaseCookieOptions`,
    },
  ]
  const problems = judge(asShipped)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /names `httpOnly` without recording that it is UNAVAILABLE/)
  assert.match(problems[0], /A false hardening claim is worse than a missing one/)
})

test('naming the attribute WITH a disclaimer is clean', () => {
  const honest = [
    {
      path: 'apps/web/lib/supabase/client.ts',
      text: `// \`httpOnly\` cannot be set here: the browser writes this cookie.
const jar = 1`,
    },
  ]
  assert.deepEqual(judge(honest), [])
})

test('the prose check reads COMMENTS, not code', () => {
  // `httpOnly` appearing in an options type or a forwarded literal is code doing its job.
  // Only a CLAIM is a claim, which is why the scan is over comment text alone.
  const codeOnly = [{ path: 'a.ts', text: `const o = { httpOnly: true }` }]
  assert.deepEqual(judge(codeOnly), [])
})

test('an empty unavailable list disables the prose check rather than matching everything', () => {
  const claim = [{ path: 'a.ts', text: `// the host supplies httpOnly` }]
  assert.deepEqual(judge(claim, { ...POLICY, unavailableCookieAttributes: [] }), [])
})
