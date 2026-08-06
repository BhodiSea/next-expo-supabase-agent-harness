import { describe, expect, it } from 'vitest'
import {
  authenticatedCacheHeaders,
  contentSecurityPolicy,
  contentSecurityPolicyReportOnly,
  staticSecurityHeaders,
} from '../lib/security-headers'

// DELIBERATELY NOT A SECOND COPY OF tools/security-headers.json. That file is the reviewed
// policy and `tools/check-security-headers.mjs` already diffs this module's return values
// against it BY VALUE — asserting the same directive strings here would create a second
// source of truth and a lockstep burden with no new coverage.
//
// What this suite asserts is the class the value-diff cannot: RELATIONSHIPS between the
// parts, and behaviour under an input. A reviewed constant can be correct in isolation and
// still be wrong next to its twin.
// SOURCE: docs/harness/gates-catalog.md (security-headers: the gate asserts values; the
// unit lane asserts the invariants between them)

const ORIGIN = 'https://abcdefgh.supabase.co'
const NONCE = 'r4nd0mNonceValue'

const directive = (policy: string, name: string): string =>
  policy
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `)) ?? ''

describe('contentSecurityPolicy', () => {
  it("never ships 'unsafe-inline' on script-src without 'strict-dynamic'", () => {
    // THE load-bearing assertion. 'unsafe-inline' is listed only as the CSP2 fallback that
    // a CSP3 browser ignores in the presence of a nonce — but ONLY while 'strict-dynamic'
    // is there to make it ignorable. Drop strict-dynamic and the same string becomes a
    // blanket permit for injected inline script, on every response, silently.
    // SOURCE: https://www.w3.org/TR/CSP3/#strict-dynamic-usage
    const script = directive(contentSecurityPolicy(NONCE, ORIGIN), 'script-src')
    if (script.includes("'unsafe-inline'")) {
      expect(script).toContain("'strict-dynamic'")
    }
    expect(script).toContain("'strict-dynamic'")
  })

  it('embeds the per-request nonce in the nonce- source form', () => {
    expect(directive(contentSecurityPolicy(NONCE, ORIGIN), 'script-src')).toContain(
      `'nonce-${NONCE}'`,
    )
  })

  it('is per-request — two nonces yield two different policies', () => {
    // A policy that ignored its nonce argument would hand every response the same token,
    // which is a nonce in name only: replaying one injected script would work forever.
    expect(contentSecurityPolicy('aaa', ORIGIN)).not.toBe(contentSecurityPolicy('bbb', ORIGIN))
  })

  it('derives the websocket origin from the http origin and allows both', () => {
    // Supabase realtime dials wss:// on the same host. Allowing only the https origin is
    // how realtime dies in production and nowhere else — the local stack is http://, whose
    // ws:// twin the same replace() produces, so a wrong rule still passes locally.
    const connect = directive(contentSecurityPolicy(NONCE, ORIGIN), 'connect-src')
    expect(connect).toContain(ORIGIN)
    expect(connect).toContain('wss://abcdefgh.supabase.co')
  })

  it('derives ws:// (not wss://) for a loopback http origin', () => {
    const connect = directive(contentSecurityPolicy(NONCE, 'http://127.0.0.1:54321'), 'connect-src')
    expect(connect).toContain('ws://127.0.0.1:54321')
  })

  it("agrees with x-frame-options — frame-ancestors 'none' and DENY are one decision", () => {
    // Engines honour one or the other. If they disagree, the app's framing posture depends
    // on which browser the reader happens to be using, which is not a posture.
    const framing = directive(contentSecurityPolicy(NONCE, ORIGIN), 'frame-ancestors')
    const xfo = staticSecurityHeaders().find((h) => h.key === 'x-frame-options')
    expect(framing).toBe("frame-ancestors 'none'")
    expect(xfo?.value).toBe('DENY')
  })
})

describe('contentSecurityPolicyReportOnly', () => {
  it('is the enforced policy plus a report-uri, never a weaker one', () => {
    // A report-only twin that drifts from the enforced policy reports violations the real
    // policy would not have blocked — and stays silent about the ones it would.
    const enforced = contentSecurityPolicy(NONCE, ORIGIN)
    const reportOnly = contentSecurityPolicyReportOnly(NONCE, ORIGIN)
    expect(reportOnly.startsWith(enforced)).toBe(true)
    expect(reportOnly).toContain('report-uri /api/csp-report')
  })
})

describe('staticSecurityHeaders', () => {
  it('emits lower-case keys with no duplicates', () => {
    // Next merges by key; a duplicate is a silently-dropped header, and a capitalised key
    // is a second entry rather than an override.
    const keys = staticSecurityHeaders().map((h) => h.key)
    expect(keys).toEqual(keys.map((k) => k.toLowerCase()))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('has no empty values', () => {
    for (const h of staticSecurityHeaders()) {
      expect(h.value.trim().length, `${h.key} is empty`).toBeGreaterThan(0)
    }
  })
})

describe('authenticatedCacheHeaders', () => {
  it('marks tenant responses private and unstorable', () => {
    const cacheControl = authenticatedCacheHeaders().find((h) => h.key === 'cache-control')
    expect(cacheControl?.value).toContain('private')
    expect(cacheControl?.value).toContain('no-store')
  })

  it('varies on BOTH the session cookie and the acting-org selector', () => {
    // Omitting x-org-id from Vary is the shape of a cross-tenant CDN poisoning bug: same
    // URL, same cookie-less edge key, a different tenant's rows served from cache.
    const vary = authenticatedCacheHeaders().find((h) => h.key === 'vary')?.value ?? ''
    const names = vary.split(',').map((v) => v.trim().toLowerCase())
    expect(names).toContain('cookie')
    expect(names).toContain('x-org-id')
  })
})
