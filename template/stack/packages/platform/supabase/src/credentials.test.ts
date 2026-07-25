// The one mix-up this file exists to catch: a SECRET key reaching a factory
// whose client ships to the caller. Nothing about the two keys' TYPE
// distinguishes them — both are strings — and the mistake is silent, because a
// client holding the secret key works perfectly. It just stops being subject to
// any policy in the repository.
import { describe, expect, it } from 'vitest'
import { isSecretKey, requireCredentials } from './credentials.js'

const URL_OK = 'https://project.supabase.co'
const PUBLISHABLE = 'sb_publishable_example-not-a-real-key'
const SECRET = 'sb_secret_example-not-a-real-key'

describe('requireCredentials', () => {
  it('passes a well-formed pair through unchanged', () => {
    expect(requireCredentials({ publishableKey: PUBLISHABLE, url: URL_OK }, 'test')).toEqual({
      publishableKey: PUBLISHABLE,
      url: URL_OK,
    })
  })

  it('rejects a SECRET key in a public factory', () => {
    // The whole point. In a browser bundle this key is published; in a native
    // binary it is published on devices that cannot be recalled. And because it
    // bypasses RLS, every policy stops applying to whoever extracts it.
    expect(() => requireCredentials({ publishableKey: SECRET, url: URL_OK }, 'test')).toThrow(
      /SECRET key/,
    )
  })

  it('rejects a present-but-empty value, not just a missing one', () => {
    // env.example ships every value blank, so `SUPABASE_URL=` is the ordinary
    // shape of "not configured yet". A blank URL makes every call a relative
    // fetch, which reads as a server outage rather than as missing config.
    expect(() => requireCredentials({ publishableKey: PUBLISHABLE, url: '' }, 'test')).toThrow()
    expect(() => requireCredentials({ publishableKey: '', url: URL_OK }, 'test')).toThrow()
    expect(() => requireCredentials({}, 'test')).toThrow()
  })

  it('rejects a relative or non-http project URL', () => {
    expect(() =>
      requireCredentials({ publishableKey: PUBLISHABLE, url: '/supabase' }, 'test'),
    ).toThrow(/absolute/)
  })

  it('names the source in the message so the fix is the next thing you read', () => {
    expect(() => requireCredentials({}, 'EXPO_PUBLIC_SUPABASE_URL')).toThrow(
      /EXPO_PUBLIC_SUPABASE_URL/,
    )
  })

  it('accepts a legacy-format key — the prefix guard is a second line, not the first', () => {
    // Legacy anon and service-role keys are outwardly identical signed tokens,
    // so no prefix test can separate them. Those projects are covered by the
    // env split (a server-only variable is not reachable from a client bundle
    // at all), which is why this function does not pretend otherwise.
    const legacy = 'legacy-format-key-value'
    expect(requireCredentials({ publishableKey: legacy, url: URL_OK }, 'test').publishableKey).toBe(
      legacy,
    )
  })
})

describe('isSecretKey', () => {
  it('recognises the current secret-key prefix and nothing else', () => {
    expect(isSecretKey(SECRET)).toBe(true)
    expect(isSecretKey(PUBLISHABLE)).toBe(false)
    expect(isSecretKey('')).toBe(false)
  })
})

// --- R3c mutation-kill tests (added by triage) ---
describe('requireCredentials — mutation-baseline kills', () => {
  it('rejects a URL that merely CONTAINS http(s):// rather than starting with it', () => {
    expect(() =>
      requireCredentials({ publishableKey: PUBLISHABLE, url: 'see https://example.com' }, 'test'),
    ).toThrow(/absolute/)
  })

  it('accepts a plain http:// URL, not only https://', () => {
    expect(
      requireCredentials({ publishableKey: PUBLISHABLE, url: 'http://localhost:54321' }, 'test')
        .url,
    ).toBe('http://localhost:54321')
  })

  it('treats an ABSENT publishable key the same as an empty one', () => {
    expect(() => requireCredentials({ url: URL_OK }, 'test')).toThrow()
  })

  it('reports an ABSENT url as "not configured", not as a malformed absolute URL', () => {
    expect(() => requireCredentials({ publishableKey: PUBLISHABLE }, 'test')).toThrow(
      /not configured/,
    )
  })

  it('reports an EMPTY url with the "not configured" diagnostic, distinct from the absolute-URL message', () => {
    expect(() => requireCredentials({ publishableKey: PUBLISHABLE, url: '' }, 'test')).toThrow(
      /not configured/,
    )
  })
})
