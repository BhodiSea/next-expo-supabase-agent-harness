import { describe, expect, it } from 'vitest'
import { CSRF_REJECTED_CODE, hasAmbientSessionCookie, isCrossSiteRequest } from './csrf.js'

// The origin this endpoint is served from, in the shape the host derives from the request URL.
const SELF = 'https://app.example.test'

describe('CSRF_REJECTED_CODE', () => {
  it('is a stable machine string the host stamps on a 403 body', () => {
    // Pinned: a rejected browser client (and any log grep) switches on this, so a reword is a
    // silent breaking change, not a copy edit.
    expect(CSRF_REJECTED_CODE).toBe('csrf_failed')
  })
})

describe('isCrossSiteRequest — Sec-Fetch-Site, the primary and unforgeable signal', () => {
  // The header is a forbidden header name: page JS cannot set it, so the browser's own verdict
  // is trustworthy. Only `cross-site` is an attack; the other three are first-party.
  const fetchSiteCases = [
    { crossSite: false, pins: 'same-origin is a first-party request', site: 'same-origin' },
    {
      crossSite: false,
      pins: 'same-site is a sibling subdomain, still same-party',
      site: 'same-site',
    },
    {
      crossSite: false,
      pins: 'none is user-initiated — no attacker document to forge',
      site: 'none',
    },
    { crossSite: true, pins: 'cross-site is the one attack value', site: 'cross-site' },
    { crossSite: true, pins: 'an unrecognised value fails closed', site: 'nonsense' },
  ] as const

  it.each(fetchSiteCases)('$site → $pins', ({ crossSite, site }) => {
    expect(isCrossSiteRequest({ 'sec-fetch-site': site }, SELF)).toBe(crossSite)
  })

  it('wins over Origin — the unforgeable signal decides even against a spoofable one', () => {
    // same-origin passes even if a (spoofable) Origin looks foreign …
    expect(
      isCrossSiteRequest(
        { origin: 'https://evil.example.test', 'sec-fetch-site': 'same-origin' },
        SELF,
      ),
    ).toBe(false)
    // … and cross-site is refused even if the Origin matches.
    expect(isCrossSiteRequest({ origin: SELF, 'sec-fetch-site': 'cross-site' }, SELF)).toBe(true)
  })

  it('reads through a Headers instance, case-insensitively', () => {
    expect(isCrossSiteRequest(new Headers({ 'Sec-Fetch-Site': 'cross-site' }), SELF)).toBe(true)
  })
})

describe('isCrossSiteRequest — Origin fallback for clients with no Fetch Metadata', () => {
  it('an Origin equal to the endpoint origin passes', () => {
    expect(isCrossSiteRequest({ origin: SELF }, SELF)).toBe(false)
  })

  it('a different Origin is refused', () => {
    expect(isCrossSiteRequest({ origin: 'https://evil.example.test' }, SELF)).toBe(true)
  })

  it('neither Fetch Metadata nor Origin fails closed on an ambient-credential endpoint', () => {
    expect(isCrossSiteRequest({}, SELF)).toBe(true)
  })
})

describe('hasAmbientSessionCookie — is there an ambient credential CSRF must guard', () => {
  const cases = [
    { cookie: undefined, present: false, pins: 'no Cookie header at all (anonymous, curl)' },
    {
      cookie: 'theme=dark; lang=en',
      present: false,
      pins: 'cookies present, but none is a session',
    },
    {
      cookie: 'sb-projref01-auth-token=stored',
      present: true,
      pins: 'the @supabase/ssr session cookie',
    },
    {
      cookie: 'theme=dark; sb-projref01-auth-token=stored; other=1',
      present: true,
      pins: 'the session cookie found among others',
    },
    {
      cookie: 'sb-projref01-auth-token.0=part0; sb-projref01-auth-token.1=part1',
      present: true,
      pins: 'a chunked session cookie',
    },
    {
      cookie: 'sb-projref01-refresh=x',
      present: false,
      pins: 'a non-auth sb- cookie is not a session',
    },
  ] as const

  it.each(cases)('$pins', ({ cookie, present }) => {
    const headers = cookie === undefined ? {} : { cookie }
    expect(hasAmbientSessionCookie(headers)).toBe(present)
  })

  it('reads the Cookie header through a Headers instance too', () => {
    expect(hasAmbientSessionCookie(new Headers({ cookie: 'sb-projref01-auth-token=stored' }))).toBe(
      true,
    )
  })
})

// --- R3c mutation-kill tests (added by triage) ---
describe('hasAmbientSessionCookie — session cookie after a space-less delimiter (mutation kill)', () => {
  it('detects the auth cookie when it follows a semicolon with no space', () => {
    expect(hasAmbientSessionCookie({ cookie: 'theme=dark;sb-projref01-auth-token=stored' })).toBe(
      true,
    )
  })
})
