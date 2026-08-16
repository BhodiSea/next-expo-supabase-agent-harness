// Can-fail proofs for the auth-posture gate (template/base/tools/check-auth-posture.mjs).
//
// Fixture-driven against the SHIPPED supabase/config.toml and the SHIPPED
// tools/auth-posture.json, verbatim — so template drift reds here rather than on someone's
// first scaffold, and so the GREEN case is a real statement about what the harness installs.
//
// The headline proof is `RED: a MISSPELLED key`. The 0.6.0 spike established that the Supabase
// CLI parses config.toml LENIENTLY — an unknown key under [auth] produces no error and no
// warning — so `enable_refresh_token_rotaton = true` reads to a reviewer as a security property
// while GoTrue applies its default. That is the defect this gate exists for, and it must red
// TWICE: once because the reviewed key is missing, once because an unreviewed key is present.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(
  new URL('../../template/base/tools/check-auth-posture.mjs', import.meta.url),
)
const TOOLS = fileURLToPath(new URL('../../template/base/tools', import.meta.url))
const CONFIG_SRC = fileURLToPath(
  new URL('../../template/stack/supabase/config.toml', import.meta.url),
)
const SHIPPED_CONFIG = readFileSync(CONFIG_SRC, 'utf8')
const SHIPPED_POLICY = readFileSync(join(TOOLS, 'auth-posture.json'), 'utf8')
const SHIPPED_TUNABLES = readFileSync(join(TOOLS, 'auth-tunables.json'), 'utf8')

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

// The trail's presence, as the gate reads it: the migration TEXT naming the two hook
// functions. The shipped config enables both hooks, so a fixture modelling the shipped tree
// must carry the trail too — the paired act the 1.0.0 gate holds — and a fixture modelling a
// pre-trail install passes `trail: false`.
const TRAIL_MARKER =
  '-- fixture: the auth-event trail\ncreate function auth_trail.password_verification_hook(event jsonb) returns jsonb language sql as $$ select $1 $$;\ncreate function auth_trail.mfa_verification_hook(event jsonb) returns jsonb language sql as $$ select $1 $$;\n'

/** @param {{ config?: string|null, policy?: any, tunables?: any, edit?: (s: string) => string, trail?: boolean }} [opts] */
function fixture({
  config = SHIPPED_CONFIG,
  policy = SHIPPED_POLICY,
  tunables = SHIPPED_TUNABLES,
  edit,
  trail = true,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-authposture-'))
  mkdirSync(join(dir, 'supabase'), { recursive: true })
  mkdirSync(join(dir, 'tools/lib'), { recursive: true })
  cpSync(join(TOOLS, 'lib'), join(dir, 'tools/lib'), { recursive: true })
  if (trail) {
    mkdirSync(join(dir, 'supabase/migrations'), { recursive: true })
    writeFileSync(
      join(dir, 'supabase/migrations/20260816000000_auth_event_trail.sql'),
      TRAIL_MARKER,
    )
  }
  if (config !== null) {
    writeFileSync(join(dir, 'supabase/config.toml'), edit ? edit(config) : config)
  }
  if (policy !== null) writeFileSync(join(dir, 'tools/auth-posture.json'), asText(policy))
  if (tunables !== null) writeFileSync(join(dir, 'tools/auth-tunables.json'), asText(tunables))
  return dir
}

function runGate(dir, { ci = true } = {}) {
  const env = { ...process.env }
  delete env.CI
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  if (ci) env.CI = 'true'
  const res = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8', env })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const sub = (from, to) => (s) => s.replace(from, to)

test('GREEN: the shipped config satisfies the shipped policy', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /auth-posture: OK/)
  assert.match(r.out, /no unreviewed \[auth\*\] key/)
})

test('RED: a config-side jwt_expiry change without its register half is drift, not a retune', () => {
  // jwt_expiry is TUNABLE since the 1.0.0 split — but a retune is a TWO-place act, and
  // this fixture performs only the config half. The finding names both values and the
  // seeded register the other half lives in.
  const r = runGate(fixture({ edit: sub('jwt_expiry = 3600', 'jwt_expiry = 86400') }))
  assert.equal(r.code, 1, r.out)
  assert.match(
    r.out,
    /`auth\.jwt_expiry` is 86400 but this project's tools\/auth-tunables\.json row says 3600/,
  )
  assert.match(r.out, /half the act is drift, not a decision/)
})

test('GREEN: a legitimate retune — both places edited, inside the bound', () => {
  const retuned = JSON.parse(SHIPPED_TUNABLES)
  retuned.values['auth.jwt_expiry'].value = 7200
  retuned.values['auth.jwt_expiry'].why =
    'Two hours: this deployment serves long-lived kiosk sessions and the rotation floor still holds; reviewed here per the split.'
  const r = runGate(
    fixture({ tunables: retuned, edit: sub('jwt_expiry = 3600', 'jwt_expiry = 7200') }),
  )
  assert.equal(r.code, 0, r.out)
})

test('RED: a register value outside the owned bound reds even when config agrees', () => {
  // The bound is the FLOOR's half of the bargain: the consumer may retune, never stretch
  // past what the owned policy declares — agreement between the two consumer-editable
  // files is not review.
  const stretched = JSON.parse(SHIPPED_TUNABLES)
  stretched.values['auth.jwt_expiry'].value = 172800
  stretched.values['auth.jwt_expiry'].why =
    'Two days, because sign-in friction was annoying somebody — exactly the retune the bound exists to refuse.'
  const r = runGate(
    fixture({ tunables: stretched, edit: sub('jwt_expiry = 3600', 'jwt_expiry = 172800') }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /outside the owned bound 300\.\.86400/)
})

test('RED: a minted tunable — a register row the owned policy never declared', () => {
  const minted = JSON.parse(SHIPPED_TUNABLES)
  minted.values['auth.enable_anonymous_sign_ins'] = {
    value: true,
    why: 'Trying to license anonymous sign-ins from the seeded side — the floor key must stay the floor’s.',
  }
  const r = runGate(fixture({ tunables: minted }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /a consumer cannot mint a tunable/)
})

test('RED: a missing tunables register FAILS CLOSED naming the refresh-seeded pull', () => {
  const r = runGate(fixture({ tunables: null }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /--refresh-seeded tools\/auth-tunables\.json/)
})

test('additionalSections: a consumer-enabled surface section is recorded, or it reds', () => {
  // The census split: [functions.report] appears in config — red while unrecorded, green
  // once additionalSections carries it. The owned core still owns the shipped sections.
  const withSection = (s) => `${s}\n[functions.report]\nenabled = true\n`
  const unrecorded = runGate(fixture({ edit: withSection }))
  assert.equal(unrecorded.code, 1, unrecorded.out)
  assert.match(unrecorded.out, /\[functions\.report\]` is present but in neither/)

  const recorded = JSON.parse(SHIPPED_TUNABLES)
  recorded.additionalSections = ['functions.report']
  const green = runGate(fixture({ tunables: recorded, edit: withSection }))
  assert.equal(green.code, 0, green.out)
})

test('RED: a MISSPELLED key reds TWICE — the case the CLI silently ignores', () => {
  // THE proof this gate exists for. Verified against CLI 2.111.0: an unknown [auth] key
  // produces no error and no warning, so the config reads as protection and applies nothing.
  const r = runGate(
    fixture({ edit: sub('enable_refresh_token_rotation', 'enable_refresh_token_rotaton') }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /auth-posture: FAIL \(2\)/)
  assert.match(r.out, /`auth\.enable_refresh_token_rotation` is MISSING/)
  assert.match(r.out, /`auth\.enable_refresh_token_rotaton` is set but appears nowhere/)
  assert.match(r.out, /silently ignoring/)
})

test('RED: a DELETED reviewed line — an absent key silently gets the CLI default', () => {
  const r = runGate(fixture({ edit: sub('refresh_token_reuse_interval = 10\n', '') }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /`auth\.refresh_token_reuse_interval` is MISSING/)
})

test('RED: anonymous sign-ins turned on', () => {
  const r = runGate(
    fixture({ edit: sub('enable_anonymous_sign_ins = false', 'enable_anonymous_sign_ins = true') }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /satisfies EVERY auth\.uid\(\) policy/)
})

test('RED: a wildcard entry in the redirect allowlist', () => {
  const r = runGate(
    fixture({
      edit: sub(
        '"{{APP_SCHEME}}://auth/callback",',
        '"{{APP_SCHEME}}://auth/callback", "{{WEB_ORIGIN}}/**",',
      ),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /additional_redirect_urls/)
})

test('RED: site_url on a plaintext host — shape, not equality', () => {
  // Project-valued: the harness cannot pin the VALUE (every scaffold fills in its own origin),
  // so it pins the shape. A filled-in https origin must stay green.
  const bad = runGate(
    fixture({ edit: sub('site_url = "{{WEB_ORIGIN}}"', 'site_url = "http://evil.example.com"') }),
  )
  assert.equal(bad.code, 1, bad.out)
  assert.match(bad.out, /does not match the reviewed shape/)

  const good = runGate(
    fixture({ edit: sub('site_url = "{{WEB_ORIGIN}}"', 'site_url = "https://app.example.com"') }),
  )
  assert.equal(good.code, 0, good.out)
})

test('RED: a RENAMED section reds in BOTH directions', () => {
  // How the shipped `[inbucket]` deprecation was found: the CLI renamed the section to
  // `[local_smtp]` and only WARNS about the old name, so nothing in the repo noticed.
  // Anchored to the line start: `[local_smtp]` also appears in a COMMENT above the section
  // (explaining the rename), and a bare string replace rewrites the comment instead of the
  // header — which passed, because the config was then unchanged. The first draft of this test
  // asserted nothing for exactly that reason.
  const r = runGate(fixture({ edit: sub(/^\[local_smtp\]$/m, '[inbucket]') }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /section `\[inbucket\]` is present but in neither/)
  assert.match(r.out, /section `\[local_smtp\]` is reviewed .* but ABSENT/)
})

test('RED: a new config SECTION is a surface, not a setting', () => {
  const r = runGate(fixture({ edit: (s) => `${s}\n[storage.buckets.avatars]\npublic = true\n` }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /\[storage\.buckets\.avatars\]` is present but in neither/)
})

test('RED: a missing policy file FAILS CLOSED — an absent policy is not an empty one', () => {
  const r = runGate(fixture({ policy: null }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /is missing — the reviewed auth posture is this gate's entire subject/)
})

test('RED: a malformed policy file fails closed too', () => {
  const r = runGate(fixture({ policy: '{ not json' }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /not valid JSON/)
})

test('RED: TOML the reader cannot parse FAILS rather than judging the part it could read', () => {
  // A partial parse would report on a subset while reading as a verdict on the whole file —
  // the exact shape of vacuous control this release is about.
  const r = runGate(fixture({ edit: (s) => `${s}\n[[weird]]\nx = 1\n` }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /TOML reader does not support/)
})

test('SKIP-LOUDLY locally / FAIL-CLOSED in CI with no Supabase surface', () => {
  const dir = fixture()
  rmSync(join(dir, 'supabase/config.toml'))
  const ci = runGate(dir)
  assert.equal(ci.code, 1, ci.out)
  assert.match(ci.out, /skips are not allowed in CI/)
  const local = runGate(dir, { ci: false })
  assert.equal(local.code, 0, local.out)
  assert.match(local.out, /SKIPPED/)
})

test('the RAMP: a pre-0.6.0 install gets NOTES, and a fresh 0.6.0 one does not', () => {
  const withManifest = (base) => {
    const dir = fixture({ edit: sub('jwt_expiry = 3600', 'jwt_expiry = 86400') })
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(
      join(dir, '.harness/manifest.json'),
      JSON.stringify({ baseVersion: base, harnessVersion: '0.6.0' }),
    )
    return dir
  }
  const ramped = runGate(withManifest('0.5.0'))
  assert.equal(ramped.code, 0, ramped.out)
  assert.match(ramped.out, /withheld by the 0\.6\.0 ramp/)
  // A ramp withholds the exit code, never the information.
  assert.match(ramped.out, /jwt_expiry/)

  const fresh = runGate(withManifest('0.6.0'))
  assert.equal(fresh.code, 1, fresh.out)
})

test('the TOML reader handles the shipped config with zero errors', async () => {
  // Anti-vacuity for the parser itself: if it silently produced an empty map, every closure
  // above would pass over nothing.
  const { parseToml } = await import('../../template/base/tools/lib/toml.mjs')
  const { values, sections, errors } = parseToml(SHIPPED_CONFIG)
  assert.deepEqual(errors, [])
  assert.ok(sections.includes('auth'), 'the [auth] section must be found')
  assert.ok([...values.keys()].filter((k) => k.startsWith('auth')).length >= 8)
  assert.equal(values.get('auth.jwt_expiry'), 3600)
  assert.equal(values.get('auth.enable_anonymous_sign_ins'), false)
  assert.ok(Array.isArray(values.get('auth.additional_redirect_urls')))
})

// ── THE [auth.mfa] RAMP (0.9.9) ───────────────────────────────────────────────────
// This file is harness-OWNED and supabase/config.toml is SEEDED, which is the whole
// problem in one sentence: `update` arms ten new [auth.mfa] keys across four new sections
// on every install at once and cannot write the section it now demands. Left alone that is
// fourteen hard failures on a file the consumer never touched — the ambush upgrade-lane
// leg I caught for the 0.9.5 env register, in a new place.
//
// The ramp is scoped to the MFA findings ALONE, and both halves of that are asserted: a
// pre-0.9.9 install takes NOTES for [auth.mfa] and still takes a HARD RED for anything
// else. A whole-gate ramp was the easy move and the wrong one — it would withhold the
// redirect-allowlist and session-cookie findings, which have nothing to do with this
// release and are the ones worth having.
const withVersion = (base, opts) => {
  const dir = fixture(opts)
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(
    join(dir, '.harness/manifest.json'),
    JSON.stringify({ baseVersion: base, harnessVersion: '0.9.9' }),
  )
  return dir
}
const stripMfa = (s) =>
  s.replace(
    /# ─+\n# Multi-factor authentication[\s\S]*?\n(?=# Realtime and Storage are OFF at seed\.)/,
    '',
  )

test('the [auth.mfa] RAMP: a pre-0.9.9 install takes NOTES for the whole absent section', () => {
  const r = runGate(withVersion('0.9.0', { edit: stripMfa }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /finding\(s\) withheld by the 0\.9\.9 ramp/)
  // Ten missing keys and four missing sections. A ramp withholds the exit code, never the
  // information — and the OK line must not then claim the withheld values "hold".
  assert.match(r.out, /auth\.mfa\.totp\.enroll_enabled` is MISSING/)
  assert.match(r.out, /section `\[auth\.mfa\]` is reviewed .* but ABSENT/)
  assert.match(r.out, /\[auth\.mfa\] finding\(s\) NOTE-only under the 0\.9\.9 ramp/)
})

test('the [auth.mfa] RAMP: a fresh 0.9.9 install enforces the whole section', () => {
  const r = runGate(withVersion('0.9.9', { edit: stripMfa }))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /auth\.mfa\.totp\.enroll_enabled` is MISSING/)
})

test('the [auth.mfa] RAMP is SCOPED: a pre-0.9.9 install still reds on a non-MFA finding', () => {
  // The assertion that makes the ramp a scoped one rather than a gate switched off.
  const r = runGate(
    withVersion('0.9.0', {
      edit: (s) => stripMfa(sub('jwt_expiry = 3600', 'jwt_expiry = 86400')(s)),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /jwt_expiry/)
})

test('RED: a wrong [auth.mfa] value on a current install — the documented default is the wrong one', () => {
  // 5s is the CLI's own default, verified against its embedded config template; the
  // published documentation says 10s. A gate pinned to the documented value would red on
  // every untouched scaffold, which is how a correct control gets deleted for being noisy.
  const r = runGate(
    withVersion('0.9.9', { edit: sub('max_frequency = "5s"', 'max_frequency = "10s"') }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /max_frequency` is "10s", reviewed as "5s"/)
})

test('RED: enabling WebAuthn without review — the factor the CLI silently downgrades', () => {
  const r = runGate(
    withVersion('0.9.9', {
      edit: (s) =>
        s.replace(
          /\[auth\.mfa\.web_authn\]\nenroll_enabled = false/,
          '[auth.mfa.web_authn]\nenroll_enabled = true',
        ),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /web_authn\.enroll_enabled` is true, reviewed as false/)
})

// ── 1.0.0: the trail's PAIRED ACT ─────────────────────────────────────────────────────
test('PAIRED ACT: hooks ENABLED with no trail migration is a HARD red — every sign-in would fail', () => {
  // The shape a naive "append the reviewed [auth.hook.*] block" produces on an install that
  // never adopted the migration: GoTrue calls a function nothing created. Never ramped.
  const dir = fixture({ trail: false })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(
    r.out,
    /enables auth\.hook\.password_verification_attempt\.enabled.*no migration under supabase\/migrations creates the auth_trail hook functions/,
  )
  assert.match(r.out, /EVERY password\/MFA sign-in will fail/)
})

test('PAIRED ACT: no trail and no hook sections — the four floors are NOT demanded, one plain line says so, and it is not a NOTE', () => {
  // A pre-1.0.0 install that has not adopted the trail owes the paired adoption the runbook
  // describes, not a config edit alone — so nothing is demanded and nothing NOTEs (a NOTE here
  // would be a ramp no sweep may clear without adopting a migration on the consumer's behalf).
  const dir = fixture({
    trail: false,
    edit: (c) =>
      c.replace(
        /\[auth\.hook\.password_verification_attempt\][\s\S]*?\n\n\[auth\.hook\.mfa_verification_attempt\][\s\S]*?\n\n/,
        '',
      ),
  })
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(
    r.out,
    /the auth-event trail is not in this tree .* 4 \[auth\.hook\.\*\] floor\(s\) are not demanded here/,
  )
  assert.doesNotMatch(r.out, /NOTE — \(ramp\)/)
  assert.match(
    r.out,
    /auth-posture: OK — 14 floor value\(s\).*\(4 \[auth\.hook\] floor\(s\) not demanded — the trail is not adopted here\)/,
  )
})

test('PAIRED ACT: trail present, sections missing — the floors ARE demanded (hard at base >= 1.0.0)', () => {
  const dir = fixture({
    edit: (c) =>
      c.replace(
        /\[auth\.hook\.password_verification_attempt\][\s\S]*?\n\n\[auth\.hook\.mfa_verification_attempt\][\s\S]*?\n\n/,
        '',
      ),
  })
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /auth\.hook\.password_verification_attempt\.enabled/)
})
