#!/usr/bin/env node
// Gate: auth-posture — the Supabase auth configuration matches the reviewed policy in
// tools/auth-posture.json, BY VALUE and IN BOTH DIRECTIONS.
//
// THE DEFERRAL THIS DISCHARGES. CHANGELOG 0.3.0, "Deferred, with the reason": "the Supabase
// [auth] posture gate (a CLI-compatibility spike goes first — seeding new [auth] keys against a
// caret-ranged CLI pin can make `supabase start` refuse, which reds the one lane that IS the
// fresh-scaffold-green proof)". The spike ran for 0.6.0 and the blocker did not reproduce:
// against the CLI the `^2.34.3` pin resolves to today (2.111.0), a config carrying
// `minimum_password_length`, `password_requirements`, `[auth.mfa]` and `[auth.mfa.totp]` brought
// the stack up — Postgres started, all eight migrations applied, the seed ran, GoTrue came up.
//
// WHAT THE SPIKE FOUND INSTEAD, and it is why this gate is worth more than it looked.
// The CLI parses config.toml LENIENTLY: an unknown key under [auth] produces NO error and NO
// warning. So `enable_refresh_token_rotaton = true` — one letter short — reads to every reviewer
// as a security property while GoTrue quietly runs its default. supabase/config.toml is the most
// heavily commented file in the scaffold and every one of those comments could be describing a
// posture the platform never applied. That is not a hypothetical: it is the same class as the
// stale README number 0.5.0 found, on a file whose subject is authentication.
//
// So the closure runs BOTH ways, and the second direction is the one that earns the gate:
//   forward  — every key in the policy is present in config with that value (drift reds);
//   backward — every key under [auth*] in config appears in the policy (an unreviewed key
//              reds, whether it is a deliberate widening or a typo that does nothing).
//
// AND A SECTION CENSUS, also both ways. A Supabase config SECTION is a surface, not a setting:
// `[realtime]` replays row changes through its own policy check and `[storage]` has a separate
// bucket policy model, so both ship `enabled = false` and neither should be flipped quietly. The
// absent direction is what caught the shipped `[inbucket]`, which upstream renamed to
// `[local_smtp]` and merely WARNS about — see the note at check 5 for why asking the CLI
// directly was built, worked, found that defect, and is still not what ships.
//
// WHAT IT CANNOT DO: judge the DEPLOYED project. config.toml governs the local stack; a
// production project's posture lives in its [remotes] blocks or the Dashboard, and neither is
// visible from here. `auth.email.enable_confirmations` is the row where that gap is loudest and
// tools/auth-posture.json says so in writing rather than leaving it implied.
// SOURCE: https://supabase.com/docs/guides/local-development/cli/config (the [auth] surface)
// SOURCE: docs/harness/README.md (skip-local / fail-closed-CI asymmetry) [corpus: harness/doctrine]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'
import { sessionTransportProblems } from './lib/session-transport.mjs'
import { parseToml } from './lib/toml.mjs'

/** Every .ts/.tsx under `dir`, sorted — a directory listing is only deterministic sorted. */
function walkSources(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkSources(p))
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

const GATE = 'auth-posture'
const CONFIG = 'supabase/config.toml'
const POLICY = 'tools/auth-posture.json'
const TUNABLES = 'tools/auth-tunables.json'
const RAMP = '0.6.0'

if (!existsSync(CONFIG)) {
  skipOrFail(GATE, `${CONFIG} not found (no Supabase surface yet)`)
}

// The policy is the gate's whole subject: absent, there is nothing to diff against, so it fails
// closed rather than passing vacuously. That is also why it is a DELIBERATE_PLANT in
// scripts/check-seeded-migrations.mjs — the same call tenancy.json and db-limits.json make.
if (!existsSync(POLICY)) {
  fail(
    GATE,
    `${POLICY} is missing — the reviewed auth posture is this gate's entire subject, so its absence is a broken control rather than an empty policy. Restore it from git history, or re-run \`npx … update\`.`,
  )
}
let policy
try {
  policy = JSON.parse(readFileSync(POLICY, 'utf8'))
} catch (e) {
  fail(GATE, `${POLICY} is not valid JSON (${e.message}) — the policy must be reviewable data`)
}

// The tunables register (1.0.0 split): the consumer's own values for the keys the owned
// policy declares tunable. SEEDED — a retune is the consumer's reviewed commit — and
// planted-when-absent, so a missing file is a deleted file, not an unshipped one.
if (!existsSync(TUNABLES)) {
  fail(
    GATE,
    `${TUNABLES} is missing — it is the seeded register holding this project's OWN values for the tunable auth keys (${POLICY} holds the floor and the bounds). Pull the seeded exemplar with \`npx next-expo-supabase-agent-harness update --refresh-seeded ${TUNABLES}\`.`,
  )
}
let tunables
try {
  tunables = JSON.parse(readFileSync(TUNABLES, 'utf8'))
} catch (e) {
  fail(
    GATE,
    `${TUNABLES} is not valid JSON (${e.message}) — an unreadable tunables register fails CLOSED rather than un-reviewing every retune; restore it from git history`,
  )
}

const { values, sections, errors: tomlErrs } = parseToml(readFileSync(CONFIG, 'utf8'))
if (tomlErrs.length > 0) {
  // A config the reader cannot fully parse must not be judged on the part it could read: a
  // partial parse reports on a subset while reading as a verdict on the whole file.
  fail(
    GATE,
    `${CONFIG} contains syntax this gate's TOML reader does not support, so it cannot be judged:\n  - ${tomlErrs.join('\n  - ')}\n  See tools/lib/toml.mjs for the supported subset.`,
  )
}

const errs = []
const AUTH_KEY = /^auth(\.|$)/

// ── the [auth.mfa] findings, held apart (0.9.9) ──────────────────────────────────────
// 0.9.9 added the MFA rail, and with it ten reviewed `[auth.mfa]` keys across four new
// sections. THIS FILE IS HARNESS-OWNED AND supabase/config.toml IS SEEDED, which is the
// whole problem in one sentence: `update` arms the new posture on every install at once
// and cannot write the section it now demands. Left alone, every upgrading consumer meets
// fourteen hard failures on a file they never touched and that `update` refuses to
// rewrite — the exact ambush upgrade-lane leg I caught for the 0.9.5 env register.
//
// So MFA findings are routed here and downgraded to NOTEs on a pre-0.9.9 install, while
// every other finding in this gate stays hard. A whole-gate ramp would have been the
// easy move and the wrong one: it would withhold the redirect-allowlist and session-cookie
// findings too, which have nothing to do with this release and are the ones worth having.
// The instruction to apply the section rides the seededSourceFixes channel, so it arrives
// in `.harness/pending/` rather than only in a NOTE that scrolls past.
const mfaErrs = []
const MFA_RAMP = '0.9.9'
const isMfaName = (name) => /^auth\.mfa(\.|$)/.test(name)
/** Route a finding by the config name it is about. @param {string} name @param {string} msg */
const push = (name, msg) => (isMfaName(name) ? mfaErrs : errs).push(msg)

// ── 1. forward: the reviewed posture holds ───────────────────────────────────────────
for (const [key, want] of Object.entries(policy.posture ?? {})) {
  if (!values.has(key)) {
    push(
      key,
      `${CONFIG}: \`${key}\` is MISSING — ${POLICY} reviews it as ${JSON.stringify(want)}. The CLI ignores an absent key silently and applies its own default, so a deleted line is a posture change nobody sees.`,
    )
    continue
  }
  const got = values.get(key)
  if (got !== want) {
    const note = policy.postureNotes?.[key]
    push(
      key,
      `${CONFIG}: \`${key}\` is ${JSON.stringify(got)}, reviewed as ${JSON.stringify(want)} in ${POLICY}.${note ? ` ${note}` : ''}`,
    )
  }
}

// ── 1a. the TUNABLES closure (1.0.0 split), three ways ───────────────────────────────
// The owned policy declares WHICH keys are tunable and the bound each must stay inside;
// the seeded register holds the project's VALUE and why. Three closures, each with its
// own failure: a declared tunable with no row (an unreviewed posture), a row outside its
// bound (a retune the floor refuses), and a config value that disagrees with the row
// (the two-place act half-done). The reverse census — a row for a key the policy never
// declared — reds too: a consumer cannot mint a tunable, because widening the tunable
// SET is a harness-release act exactly like widening the floor.
/** @param {string} key @param {any} bound @param {any} row */
function tunableRowProblems(key, bound, row) {
  const out = []
  if (row === undefined || row === null || typeof row !== 'object') {
    out.push(
      `${TUNABLES}: no row for \`${key}\` — ${POLICY} declares it tunable, so this project owes a reviewed value and why here (the seeded exemplar carries the template defaults).`,
    )
    return out
  }
  const v = row.value
  const typeOk = bound.type === 'number' ? typeof v === 'number' : typeof v === 'boolean'
  if (!typeOk) {
    out.push(
      `${TUNABLES}: \`${key}\` value ${JSON.stringify(v)} is not a ${bound.type} — the bound in ${POLICY} types the key, and a mistyped value is a posture the CLI would silently ignore.`,
    )
    return out
  }
  if (typeof v === 'number' && (v < (bound.min ?? -Infinity) || v > (bound.max ?? Infinity))) {
    out.push(
      `${TUNABLES}: \`${key}\` is ${String(v)}, outside the owned bound ${String(bound.min)}..${String(bound.max)} declared in ${POLICY} — retuning is yours, the bound is the floor's. ${bound.why ?? ''}`,
    )
  }
  if (String(row.why ?? '').trim().length < 40) {
    out.push(
      `${TUNABLES}: \`${key}\` has a \`why\` under 40 characters — the row IS the review record of this project's value; a bare number reviews nothing.`,
    )
  }
  const got = values.get(key)
  if (got === undefined) {
    out.push(
      `${CONFIG}: \`${key}\` is MISSING — ${TUNABLES} reviews it as ${JSON.stringify(v)}. The CLI ignores an absent key silently and applies its own default, so a deleted line is a posture change nobody sees.`,
    )
  } else if (got !== v) {
    out.push(
      `${CONFIG}: \`${key}\` is ${JSON.stringify(got)} but this project's ${TUNABLES} row says ${JSON.stringify(v)} — retuning is editing BOTH in one diff; half the act is drift, not a decision.`,
    )
  }
  return out
}

const tunableBounds = Object.entries(policy.tunables ?? {}).filter(([k]) => !k.startsWith('//'))
for (const [key, bound] of tunableBounds) {
  for (const msg of tunableRowProblems(key, bound, tunables.values?.[key])) push(key, msg)
}
for (const key of Object.keys(tunables.values ?? {})) {
  if (policy.tunables?.[key] === undefined) {
    errs.push(
      `${TUNABLES} carries a row for \`${key}\`, which ${POLICY} does not declare tunable — a consumer cannot mint a tunable; if this key genuinely belongs to the project, widening the tunable set is a harness-release act with a bound.`,
    )
  }
}

// ── 1b. project-valued keys: present, and the right SHAPE ────────────────────────────
// Some keys hold the project's value rather than the harness's — `site_url` is the consumer's
// origin. Pinning those by equality would either red on every scaffold that filled one in, or
// pin the template placeholder forever. Both make the row a lie, so they are reviewed for
// presence and shape instead.
for (const [key, rule] of Object.entries(policy.projectValued ?? {})) {
  if (key.startsWith('//')) continue
  const got = values.get(key)
  if (typeof got !== 'string' || got.trim() === '') {
    errs.push(
      `${CONFIG}: \`${key}\` is missing or empty — ${POLICY} reviews it as project-valued but REQUIRED. ${rule.why ?? ''}`,
    )
    continue
  }
  if (rule.mustMatch !== undefined && !new RegExp(rule.mustMatch).test(got)) {
    errs.push(
      `${CONFIG}: \`${key}\` is ${JSON.stringify(got)}, which does not match the reviewed shape \`${rule.mustMatch}\`. ${rule.why ?? ''}`,
    )
  }
}

// ── 2. backward: nothing under [auth*] is unreviewed ─────────────────────────────────
// The direction the spike made load-bearing. A key here that the policy does not name is
// either a widening nobody reviewed or a typo the CLI is silently ignoring, and the gate
// cannot tell those apart — which is precisely why it asks a human.
const reviewed = new Set(
  [
    ...Object.keys(policy.posture ?? {}),
    ...tunableBounds.map(([k]) => k),
    ...Object.keys(policy.projectValued ?? {}).filter((k) => !k.startsWith('//')),
    policy.redirectAllowlist?.key,
  ].filter(Boolean),
)
for (const key of [...values.keys()].filter((k) => AUTH_KEY.test(k)).sort()) {
  if (reviewed.has(key)) continue
  push(
    key,
    `${CONFIG}: \`${key}\` is set but appears nowhere in ${POLICY}. Either it is a deliberate posture change that needs a reviewed row, or it is a key the CLI does not recognise and is silently ignoring — a config line that reads as protection and applies nothing. The gate cannot tell those apart; a human can.`,
  )
}

// ── 3. the redirect allowlist ────────────────────────────────────────────────────────
// Not expressible as scalar equality: what matters is that no entry WIDENS the list, and the
// provider hands the authorization code to any URL on it.
const redirect = policy.redirectAllowlist
if (redirect?.key !== undefined) {
  const urls = values.get(redirect.key)
  if (!Array.isArray(urls)) {
    errs.push(
      `${CONFIG}: \`${redirect.key}\` is missing or not an array — the redirect allowlist is the one place an open redirect becomes account takeover, so an unreadable one is a red, not a default.`,
    )
  } else {
    if (typeof redirect.maxEntries === 'number' && urls.length > redirect.maxEntries) {
      errs.push(
        `${CONFIG}: \`${redirect.key}\` has ${String(urls.length)} entries, reviewed ceiling is ${String(redirect.maxEntries)}. ${redirect.why ?? ''}`,
      )
    }
    for (const url of urls) {
      for (const banned of redirect.bannedSubstrings ?? []) {
        if (String(url).includes(banned)) {
          errs.push(
            `${CONFIG}: \`${redirect.key}\` entry ${JSON.stringify(url)} contains ${JSON.stringify(banned)} — the provider hands the authorization code to any URL this list matches, so a wildcard readmits the whole open-redirect class.`,
          )
        }
      }
    }
  }
}

// ── 4. required sections ─────────────────────────────────────────────────────────────
for (const name of policy.requiredSections ?? []) {
  if (!sections.includes(name)) {
    errs.push(`${CONFIG}: section \`[${name}]\` is absent — ${POLICY} requires it`)
  }
}

// ── 5. the section census ────────────────────────────────────────────────────────────
// Both directions over the config's SECTION names, for the same reason as the key closure:
// a section that appears without review is a surface nobody decided to enable, and a section
// that disappears is one nobody decided to turn off. `[realtime]` and `[storage]` are the
// worked case — both ship `enabled = false` with a comment explaining that each is its own
// authorization surface, and flipping either one is exactly the kind of change that should
// not reach main quietly.
//
// WHAT THIS IS NOT, and the distinction cost a spike to establish. It is NOT "ask the CLI
// whether any section is deprecated". That check was built, it worked, and it found a real
// defect — the harness shipped `[inbucket]` against a CLI that renamed it to `[local_smtp]`
// and warned on every command, with a `^2.34.3` pin resolving to 2.111.0. It is not shipped,
// because no CLI subcommand at this pin parses config.toml without side effects: `config
// push` needs a project ref, `functions list` needs an access token, and `status` — the one
// that works — binds to whatever stack is on the default ports (it reported ANOTHER project's
// containers during this spike) and prints `SECRET_KEY` and `JWT_SECRET` into the output a
// gate would then be handling. A control that reads a neighbour's stack and handles their
// credentials is not a control. The `[inbucket]` defect itself IS fixed; the standing check is
// deferred to 0.12.0 (deferral ledger: auth-posture-cli-census) — RE-CHECKED AT 0.11.0
// (2026-08-13), the FIRST firing against a real pin bump: npm latest moved 2.113.0 -> 2.114.0
// (GA 2026-08-12), so the 're-check at every CLI pin bump' clause fired on its own terms. The
// CLI is now a pnpm/nx monorepo and the Go CLI moved to apps/cli-go — the path changed, the
// answer did not: apps/cli-go/cmd/config.go at tag v2.114.0 still registers `push` alone (read
// at the tag, not inferred from release notes). v2.114.0's config-adjacent changes are
// --project-ref, skip-vault-sync and stack persistence; the TS port serves `db diff`,
// `db reset`, `functions download`, `migration squash`, none of which parse config.toml. The
// ask is still open as supabase/cli#5894 with no milestone and no linked PR. The upstream
// condition is a side-effect-free `config lint`-shaped subcommand, re-checked at every CLI
// pin bump, and the docs-sync deferral scan reds this sentence the release the date arrives —
// the standing rule (written at 0.9.0, the second scheduled firing) is that each such arrival
// moves the date one minor in a reviewed diff until the upstream subcommand actually ships.
// The census unions the owned core with the seeded additionalSections (the 1.0.0 split
// applied to sections): a consumer who enables [realtime] records it in the tunables
// register with the same two-place discipline as a key retune. A malformed addition reds
// rather than silently widening the census.
const additional = Array.isArray(tunables.additionalSections) ? tunables.additionalSections : []
for (const name of additional) {
  if (typeof name !== 'string' || name.trim() === '') {
    errs.push(
      `${TUNABLES}: additionalSections carries a non-string entry — a section the census cannot name is a section it cannot watch.`,
    )
  }
}
const known = [...(policy.knownSections ?? []), ...additional.filter((n) => typeof n === 'string')]
for (const name of sections) {
  if (!known.includes(name)) {
    push(
      name,
      `${CONFIG}: section \`[${name}]\` is present but in neither ${POLICY} knownSections nor ${TUNABLES} additionalSections — a Supabase config section is a SURFACE (realtime replays row changes through its own policy check; storage has a separate bucket policy model), so one appearing without review is a door in the wall that no test in this repo watches. Enabling a surface is the consumer's act: record it in ${TUNABLES} additionalSections.`,
    )
  }
}
for (const name of known) {
  if (!sections.includes(name)) {
    push(
      name,
      `${CONFIG}: section \`[${name}]\` is reviewed (${POLICY} knownSections or ${TUNABLES} additionalSections) but ABSENT from the config — either it was removed without review, or upstream renamed it (the CLI renames sections and warns rather than erroring, which is how the shipped \`[inbucket]\` sat deprecated with nothing reading the warning).`,
    )
  }
}
const cliSummary = `${String(sections.length)} section(s) reviewed`

// ── the SESSION TRANSPORT half (0.6.0) ───────────────────────────────────────────────
// `[auth]` in config.toml is the posture of the auth SERVER. This is the posture of the auth
// TRANSPORT — where the session a browser obtains actually lands, and with which attributes.
// It belongs in this step because it asks the same question ("is the auth surface what it is
// supposed to be") over the same kind of reviewed data, and because folding it in costs none
// of the eleven registrations a new chain step would.
//
// It is here at all because the seeded web app shipped a SIGN-IN LOOP for two releases: the
// browser persisted to localStorage (the supabase-js default when no `storage` is passed)
// while every server reader read the cookie jar. See tools/lib/session-transport.mjs for why
// nothing else in the tree could see it.
const transportFiles = []
for (const dir of policy.sessionTransport?.surfaces ?? []) {
  if (!existsSync(dir)) continue
  for (const rel of walkSources(dir))
    transportFiles.push({ path: rel, text: readFileSync(rel, 'utf8') })
}
if (transportFiles.length > 0) {
  errs.push(
    ...sessionTransportProblems({
      app: policy.sessionTransport?.app ?? 'this surface',
      files: transportFiles,
      policy: policy.sessionTransport ?? {},
    }),
  )
} else if ((policy.sessionTransport?.surfaces ?? []).length > 0) {
  // Not skipOrFail: a scaffold that dropped apps/web legitimately has no web session
  // transport, and demanding one would assert a product shape the harness does not require.
  console.log(
    `${GATE}: NOTE — no source under ${(policy.sessionTransport?.surfaces ?? []).join(', ')}, so the session-transport closure judged nothing.`,
  )
}

// ── the [auth.mfa] ramp (0.9.9) ──────────────────────────────────────────────────────
// Scoped to the MFA findings alone, for the reason recorded where mfaErrs is declared:
// the posture is harness-owned and the config is seeded, so `update` demands a section it
// cannot write. On a pre-0.9.9 install these are NOTEs and the seededSourceFixes channel
// parks the instruction; from 0.10.0 the ramp expires and rampNote itself says so.
// The findings are still PRINTED either way — a withheld finding nobody can read is a
// check shipped disabled.
if (
  mfaErrs.length > 0 &&
  rampNote(GATE, MFA_RAMP, `the [auth.mfa] posture (the MFA rail, new in ${MFA_RAMP})`, {
    until: '0.10.0',
  })
) {
  console.log(
    `${GATE}: NOTE — ${String(mfaErrs.length)} [auth.mfa] finding(s) withheld by the ${MFA_RAMP} ramp. Apply the section from the template (\`npx next-expo-supabase-agent-harness update --refresh-seeded supabase/config.toml\` shows it) or copy it from docs/adr/20260812-mfa-aal2.md; until then the aal2 rail is inert on this install:`,
  )
  for (const e of mfaErrs) console.log(`  - ${e}`)
} else {
  errs.push(...mfaErrs)
}

// ── the ramp ─────────────────────────────────────────────────────────────────────────
// A gate whose subject is a file the HARNESS ships, applied to an install that has its own
// supabase/config.toml (it is seeded, so `update` never rewrites it). Projects grow into gates.
if (
  errs.length > 0 &&
  rampNote(GATE, RAMP, `the ${GATE} closure over ${CONFIG}`, { until: '0.7.0' })
) {
  console.log(`${GATE}: NOTE — ${String(errs.length)} finding(s) withheld by the ${RAMP} ramp:`)
  for (const e of errs) console.log(`  - ${e}`)
  ok(GATE, `NOTE-only on this pre-${RAMP} install (the ramp expires in 0.7.0)`)
}

failures(
  GATE,
  errs,
  `The reviewed posture is split since 1.0.0: the FLOOR and the bounds live in ${POLICY} (harness-owned, sha-pinned — weakening it is a harness-release act), the project's TUNABLE values live in ${TUNABLES} (seeded, write-guard-protected — a retune edits that register and ${CONFIG} in ONE reviewed diff). The diff between config and register is the finding.`,
)
// The count is the REVIEWED total minus anything a ramp withheld. An OK line claiming
// nineteen values hold while ten of them are missing is the same class of untrue summary
// this gate exists to catch, one layer up.
const held = Object.keys(policy.posture ?? {}).length - mfaErrs.length
ok(
  GATE,
  `${String(Math.max(held, 0))} floor value(s) and ${String(tunableBounds.length)} bounded tunable(s) hold${mfaErrs.length > 0 ? ` (${String(mfaErrs.length)} [auth.mfa] finding(s) NOTE-only under the ${MFA_RAMP} ramp — the rail is inert here)` : ''}, no unreviewed [auth*] key, redirect allowlist unwidened; ${cliSummary}`,
)
process.exitCode = 0
