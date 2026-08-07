// The WEB half of the build gate (0.5.0) — and `lanes['web-build']`'s red-proof.
//
// WHAT WAS WRONG. build-check.mjs was `const APP = 'apps/mobile'`, so the impure-import
// and secret-shaped-string scan never saw the web bundle — while
// docs/security/sandbox-and-supply-chain.md described the build gate as grepping the
// exported bundle, without qualification. Two shipped documents contradicting each other
// about a secret-exfiltration control, and the one a security reviewer opens was the one
// that overstated. docs/harness/enforcement-tiers.md carried the honest version as
// `build … Target 0.5.0`, and nothing read that column either.
//
// WHAT A FIXTURE CAN AND CANNOT PROVE. The lane runs a real `next build` on CI; no test
// here does. What decides whether the lane is a CONTROL rather than decoration is
// decidable without one: does the scan red on a forbidden marker in a client chunk, does
// it refuse to call an empty build pure, and does it stay quiet about `.next/server/**`,
// where a service-role factory is correct code rather than a leak. All three are below.
// SOURCE: template/base/tools/build-check.mjs (--web) · docs/harness/enforcement-tiers.md
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))

/**
 * A tree shaped like a real `next build` output, rooted at apps/web/.next.
 * `buildId` defaults true because a SUCCESSFUL build is the ordinary case; the one test
 * that omits it is proving what a half-finished build looks like.
 */
function webFixture(files, { buildId = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-webbuild-'))
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TOOLS, 'build-check.mjs'), join(dir, 'tools/build-check.mjs'))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, 'apps/web/.next', rel, '..'), { recursive: true })
    writeFileSync(join(dir, 'apps/web/.next', rel), content)
  }
  if (buildId && Object.keys(files).length > 0) {
    writeFileSync(join(dir, 'apps/web/.next/BUILD_ID'), 'test-build-id\n')
  }
  return dir
}

function runWeb(dir, { ci = true } = {}) {
  const childEnv = { ...process.env }
  delete childEnv.CI
  delete childEnv.HARNESS_REQUIRE_TOOLCHAINS
  if (ci) childEnv.CI = 'true'
  const res = spawnSync('node', [join(dir, 'tools/build-check.mjs'), '--web'], {
    cwd: dir,
    encoding: 'utf8',
    env: childEnv,
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const CLEAN_CHUNKS = {
  'static/chunks/main-abc123.js':
    'export const u="https://x.supabase.co";const k="sb_publishable_ok"\n',
  'static/chunks/app/page-def456.js': 'console.log("hello")\n',
  'static/css/app-1.css': 'body{color:red}\n',
}

test('WEB GREEN: a clean client bundle passes, and says how much it scanned', () => {
  // The count is in the OK line on purpose: "pure" over zero files and "pure" over three
  // read identically otherwise, and only one of them means anything.
  const r = runWeb(webFixture(CLEAN_CHUNKS))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /web client bundle is pure \(3 file\(s\)/)
})

test('CANARY: a secret-shaped VALUE in a client chunk reds', () => {
  // The leak this job exists for. `sb_secret_` is a literal prefix, so unlike the legacy
  // JWT service-role key it is greppable by VALUE and not only by variable name — which
  // is why the marker list gained it in the same release.
  const r = runWeb(
    webFixture({
      ...CLEAN_CHUNKS,
      'static/chunks/leak-999.js': 'const k="sb_secret_9f2a1c4b7e0d3856aa11bb22"\n',
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /static\/chunks\/leak-999\.js: contains "sb_secret_/)
  assert.match(r.out, /a Supabase SECRET key/)
})

test('the sb_secret_ GUARD CONSTANT is not a leak — the bare prefix must not red', () => {
  // THE FALSE POSITIVE THIS PINS, found by running the upgrade lane rather than by
  // reading the code. `packages/platform/supabase/src/credentials.ts` ships
  // `const SECRET_KEY_PREFIX = 'sb_secret_'` — the constant the runtime uses to REFUSE a
  // secret key on a client surface — and the mobile app imports that module, so the
  // literal is in every Hermes bundle by construction. Matched as a bare substring, this
  // gate reddened `build` on every scaffold that had run an export, accusing the code that
  // prevents the leak of being the leak. A gate that reds on correct code gets deleted,
  // and this one would have deserved it.
  const r = runWeb(
    webFixture({
      ...CLEAN_CHUNKS,
      'static/chunks/credentials-1.js':
        'const SECRET_KEY_PREFIX="sb_secret_";export function isSecretKey(k){return k.startsWith(SECRET_KEY_PREFIX)}\n',
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('a PLACEHOLDER key is not a leak either — gitleaks.toml’s ruling, reused', () => {
  // `sb_secret_unit_test_placeholder_do_not_use` carries more than sixteen characters of
  // key-shaped material, so a shape rule alone would red it. gitleaks.toml already decided
  // this question for this repository with an allowlist of exactly this vocabulary;
  // deciding it a second time here is how two controls start disagreeing about what a
  // secret is.
  const r = runWeb(
    webFixture({
      ...CLEAN_CHUNKS,
      'static/chunks/fixture-1.js': 'const k="sb_secret_unit_test_placeholder_do_not_use"\n',
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('sk_live_ stays a SUBSTRING, because nothing in the template ships it as a constant', () => {
  // The asymmetry is deliberate and evidence-based: sb_secret_ was relaxed to a shape
  // because a shipped guard constant proved the substring wrong. No such constant exists
  // for sk_live_, and weakening a check with no measured reason is how coverage leaks away
  // one symmetry argument at a time. If a sk_live_ guard constant ever ships, this test is
  // the one that should change.
  const r = runWeb(webFixture({ ...CLEAN_CHUNKS, 'static/chunks/pay-1.js': 'const p="sk_live_"\n' }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /sk_live_/)
})

test('CANARY: the service-role FACTORY name in a client chunk reds', () => {
  const r = runWeb(
    webFixture({
      ...CLEAN_CHUNKS,
      'static/chunks/oops-1.js':
        'import{createServiceRoleClient_BYPASSES_RLS}from"@app/supabase"\n',
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /createServiceRoleClient_BYPASSES_RLS/)
})

test('CANARY: a database connection string in a client chunk reds', () => {
  const r = runWeb(
    webFixture({ ...CLEAN_CHUNKS, 'static/chunks/dsn.js': 'const d="postgresql://u:p@h/db"\n' }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /postgresql:\/\//)
})

test('`.next/server/**` is NOT scanned — a gate that reds on correct code gets deleted', () => {
  // The server build legitimately contains the service-role factory, the server env
  // schema and every server-only import. That is what a server build IS. Only
  // `.next/static/**` reaches a browser, so only it can hold a shipped leak. Getting this
  // boundary wrong would red every correct install on its first run.
  const r = runWeb(
    webFixture({
      ...CLEAN_CHUNKS,
      'server/app/page.js':
        'createServiceRoleClient_BYPASSES_RLS();const d="postgres://u:p@h/db"\n',
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('ANTI-VACUITY: a build that did not FINISH is a red, not a pure bundle', () => {
  // MEASURED. The first real execution of this mode ran against a `next build` that had
  // exited 1 while collecting page data for /api/trpc/[trpc] — and found 34 client chunks
  // already on disk, scanned them, and reported the bundle pure. Next emits `static/`
  // during compilation and writes BUILD_ID only on success, so the absence of BUILD_ID is
  // exactly "this build did not finish". In the shipped lane the build step fails first and
  // this step never runs; that is the job's ordering, not this gate's property, and anyone
  // running it by hand has no ordering at all.
  const r = runWeb(webFixture(CLEAN_CHUNKS, { buildId: false }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /BUILD_ID/)
  assert.match(r.out, /did not finish/)
})

test('ANTI-VACUITY: an EMPTY client output is a red, not a pure bundle', () => {
  // A build that emitted no client chunks and a scanner that stopped matching produce the
  // identical observation. Reporting either as "pure" is the vacuous-green this whole
  // repository is written against.
  const dir = webFixture({ 'server/app/page.js': 'noop\n' })
  mkdirSync(join(dir, 'apps/web/.next/static'), { recursive: true })
  const r = runWeb(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /contains no files/)
  assert.match(r.out, /vacuous-green/)
})

test('no build at all SKIPS LOUDLY locally and FAILS CLOSED in CI', () => {
  // The house asymmetry. `.next` is a build artifact, so its absence on a laptop is
  // ordinary; in the job whose entire purpose is to build then scan, it is a broken lane.
  const dir = webFixture({})
  const inCI = runWeb(dir)
  assert.equal(inCI.code, 1, inCI.out)
  assert.match(inCI.out, /pnpm --filter web build/)

  const local = runWeb(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.match(local.out, /SKIPPED/)
})
