#!/usr/bin/env node
// Gate: security-headers — the web app's response security posture matches the
// reviewed policy in tools/security-headers.json.
//
// BY VALUE, NOT BY TEXT. The gate EVALUATES apps/web/lib/security-headers.ts and
// inspects what it returns. The obvious cheaper implementation — grep the source for
// "frame-ancestors 'none'" — is satisfied by a directive that appears in a comment,
// in a disabled branch, or in a string that is never joined into the header. This is
// the same failure the harness already rejected for type-shaped checks: a text parse
// of a value is not a check of the value.
//
// HERMETIC WITHOUT A TOOLCHAIN. The module is deliberately zero-import, so
// `node --experimental-strip-types` runs it with no bundler, no tsx, no node_modules
// and no new dependency (the installer's zero-runtime-dep ethic applies to gates
// too). If type stripping is unavailable the gate skips locally and FAILS in CI.
//
// WHAT IT CANNOT DO: prove the DEPLOYED response carries these headers. A correct
// config and a wrong CDN in front of it look identical from here. That half is the
// web-e2e lane's security-headers spec, which reads real response.headers() from a
// real browser and collects securitypolicyviolation events — check-web-e2e.mjs holds
// that spec present the same way it holds the axe scan present.
// SOURCE: docs/harness/gates-catalog.md (security-headers) [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fail, failures, ok, rampNote, runCmd, skipOrFail, stampGate } from './lib/gate.mjs'
import { STAMP_INPUTS } from './lib/stamp-inputs.mjs'

const GATE = 'security-headers'
const MODULE = 'apps/web/lib/security-headers.ts'
const POLICY = 'tools/security-headers.json'
const RAMP = '0.2.0'
// Fixtures, so the evaluation is byte-deterministic run to run.
const NONCE = 'GATEFIXTURENONCE'
const SUPABASE_ORIGIN = 'https://fixture.supabase.co'

// THE RAMP GUARDS ADOPTION, NOT CORRECTNESS — and the distinction is the whole
// reason this gate is not ramped the usual way.
//
// rampNote exists so a check applied to CONSUMER-AUTHORED content cannot ambush an
// upgrade: projects grow into gates. But the subject here is a file the HARNESS
// ships. Ramping the findings meant that on a brand-new scaffold — whose manifest
// records the release it was built from, which is older than the ramp until the
// version bumps — every finding printed as a NOTE and the gate could not go red at
// all. A new gate that is advisory on fresh installs is decoration.
//
// So: the ramp covers only the case an upgrade can actually hit — an existing
// install that does not have the module yet. Once the module is present the install
// has adopted the surface, and wrong header values are a hard red.
if (!existsSync(MODULE)) {
  if (
    rampNote(
      GATE,
      RAMP,
      `${MODULE} not found — the web security-header surface arrives in ${RAMP}`,
      {
        until: '0.4.0',
      },
    )
  ) {
    ok(GATE, `pre-${RAMP} install without ${MODULE} — run \`npx … update\` to adopt the surface`)
  }
  skipOrFail(GATE, `${MODULE} not found (no web surface yet)`)
}
if (!existsSync(POLICY))
  fail(GATE, `${POLICY} is missing — the gate cannot judge without its policy`)

let policy
try {
  policy = JSON.parse(readFileSync(POLICY, 'utf8'))
} catch (e) {
  fail(GATE, `${POLICY} is not valid JSON (${e.message}) — the policy must be reviewable data`)
}

// Every key the gate reads must be PRESENT, so a policy that silently loses a section
// cannot green the thing that section governed.
for (const key of [
  'staticHeaders',
  'permissionsPolicyDenied',
  'cspRequiredDirectives',
  'cspRequiredTokens',
  'cspBannedTokens',
  'authenticatedCache',
  'decisions',
]) {
  if (policy[key] === undefined) fail(GATE, `${POLICY} is missing the "${key}" section`)
}
// The two irreversible-ish choices must be RECORDED, present with a reason, so
// shipping without them is a decision in the diff rather than an omission.
for (const key of ['hstsPreload', 'coep']) {
  const d = policy.decisions[key]
  if (d === undefined || typeof d.reason !== 'string' || d.reason.trim().length < 20) {
    fail(
      GATE,
      `${POLICY}: decisions.${key} must carry a non-trivial "reason" — shipping with or without it is a choice that gets recorded, not omitted`,
    )
  }
}

const recordGreen = stampGate(GATE, STAMP_INPUTS[GATE])

// ---- evaluate the module -------------------------------------------------------
// ONE PHYSICAL LINE. runCmd goes through a shell, and a `-e` payload containing real
// newlines arrives at node as literal backslash-n — a syntax error that reads exactly
// like "type stripping is unavailable" and would have made this gate skip forever
// while reporting a plausible reason.
const url = pathToFileURL(MODULE).href
const n = JSON.stringify(NONCE)
const o = JSON.stringify(SUPABASE_ORIGIN)
const probe =
  `import(${JSON.stringify(url)}).then((m) => process.stdout.write(JSON.stringify(` +
  `{ static: m.staticSecurityHeaders(), csp: m.contentSecurityPolicy(${n}, ${o}), ` +
  `reportOnly: m.contentSecurityPolicyReportOnly(${n}, ${o}), cache: m.authenticatedCacheHeaders() })))`

let evaluated
try {
  evaluated = JSON.parse(
    runCmd(`node --experimental-strip-types --no-warnings -e ${JSON.stringify(probe)}`),
  )
} catch (e) {
  const reason = (e.stderr?.toString() ?? e.message).trim().split('\n').slice(0, 3).join(' / ')
  skipOrFail(GATE, `could not evaluate ${MODULE} (${reason}) — needs node >= 22.6 type stripping`)
}

const errs = []
const headerMap = new Map(evaluated.static.map((h) => [h.key.toLowerCase(), h.value]))

// ---- 1. static headers, by exact value ------------------------------------------
for (const [key, want] of Object.entries(policy.staticHeaders)) {
  const got = headerMap.get(key)
  if (got === undefined) errs.push(`${MODULE} does not emit the ${key} header (policy requires it)`)
  else if (got !== want) errs.push(`${key}: emits '${got}' but ${POLICY} requires '${want}'`)
}

// ---- 2. permissions-policy denies -----------------------------------------------
const pp = headerMap.get('permissions-policy') ?? ''
for (const feature of policy.permissionsPolicyDenied) {
  if (!new RegExp(`\\b${feature}\\s*=\\s*\\(\\s*\\)`).test(pp)) {
    errs.push(
      `permissions-policy does not deny '${feature}' — an omitted feature is permitted by the browser default in some engines, so the allowlist must be explicitly empty`,
    )
  }
}

// ---- 3. the two frame controls must AGREE ---------------------------------------
const csp = String(evaluated.csp)
const directives = new Map(
  csp
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const sp = d.indexOf(' ')
      return sp === -1
        ? [d.toLowerCase(), '']
        : [d.slice(0, sp).toLowerCase(), d.slice(sp + 1).trim()]
    }),
)
const xfo = headerMap.get('x-frame-options')
const fa = directives.get('frame-ancestors')
if (xfo === 'DENY' && fa !== "'none'") {
  errs.push(
    `x-frame-options says DENY but CSP frame-ancestors says '${fa ?? '(absent)'}' — the two framing controls disagree, so the answer depends on which one the browser honours`,
  )
}

// ---- 4. CSP required directives, by value ---------------------------------------
for (const [name, want] of Object.entries(policy.cspRequiredDirectives)) {
  const got = directives.get(name)
  if (got === undefined) errs.push(`CSP is missing the ${name} directive (policy requires ${want})`)
  else if (got !== want) errs.push(`CSP ${name}: emits '${got}' but policy requires '${want}'`)
}

// ---- 5. required + banned tokens -------------------------------------------------
for (const [name, tokens] of Object.entries(policy.cspRequiredTokens)) {
  const got = directives.get(name) ?? ''
  for (const t of tokens) {
    if (!got.includes(t)) errs.push(`CSP ${name} must contain ${t} — emits '${got}'`)
  }
}
for (const [name, tokens] of Object.entries(policy.cspBannedTokens)) {
  const got = (directives.get(name) ?? '').split(/\s+/)
  for (const t of tokens) {
    if (got.includes(t)) errs.push(`CSP ${name} contains banned token ${t}`)
  }
}

// ---- 6. the 'unsafe-inline' rule --------------------------------------------------
// 'unsafe-inline' in script-src is legitimate ONLY as the CSP2 fallback that a CSP3
// browser ignores in the presence of a nonce. Without 'strict-dynamic' beside it, it
// is not a fallback — it is an open door.
const scriptSrc = directives.get('script-src') ?? ''
if (scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'strict-dynamic'")) {
  errs.push(
    "CSP script-src carries 'unsafe-inline' WITHOUT 'strict-dynamic' — that is not a CSP2 fallback, it permits every inline script in a CSP3 browser too",
  )
}

// ---- 7. the report-only twin actually reports ------------------------------------
if (!String(evaluated.reportOnly).includes('report-uri')) {
  errs.push(
    'the report-only CSP carries no report-uri — a production violation would be as invisible as it is without the header',
  )
}

// ---- 8. authenticated-response cache discipline ----------------------------------
const cache = new Map(evaluated.cache.map((h) => [h.key.toLowerCase(), h.value]))
if (cache.get('cache-control') !== policy.authenticatedCache['cache-control']) {
  errs.push(
    `authenticated cache-control emits '${cache.get('cache-control') ?? '(absent)'}' but policy requires '${policy.authenticatedCache['cache-control']}' — a shared cache storing a tenant's rows serves them to the next caller`,
  )
}
const vary = (cache.get('vary') ?? '').toLowerCase()
for (const part of policy.authenticatedCache.varyMustInclude) {
  if (!vary.includes(part.toLowerCase())) {
    errs.push(
      `Vary does not include '${part}' — same URL, same edge cache key, different tenant's rows`,
    )
  }
}

// ---- report ----------------------------------------------------------------------
// Unramped by construction — see the adoption-vs-correctness note at the top.
failures(GATE, errs, `Policy lives in ${POLICY}; widening it is a CODEOWNERS-reviewed diff.`)

recordGreen()
ok(
  GATE,
  `${headerMap.size} static header(s) + ${directives.size} CSP directive(s) match ${POLICY} by value; framing controls agree; report-only twin reports`,
)
