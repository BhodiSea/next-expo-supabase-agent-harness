// cspell:ignore jdoe amqps apikey Bearerabc undertests -- deliberate fixtures: a username, a
// URL scheme, the no-separator api-key alternative, and a no-whitespace negative case
import { type CrashEvent, redactCrashEvent, redactText } from './redact'

// Redaction policy tests (crash-reporting module). These run under jest-expo —
// the Stop chain's mobile-unit step and the CI unit lane — the moment the
// module is enabled: the policy is enforced BEFORE any crash transport exists.
// Extend the fixtures with every PII shape your deployment handles (student
// identifiers, tenant names, …): a redaction test that only covers generic
// shapes undertests YOUR data.
//
// KILL STANDARD: every alternative of the secret-key regex, every flag/anchor
// of the text scrubbers, and every branch of the value walker is pinned by a
// row here, so any single weakening reds exactly one named test. The mutation
// lane's runner is vitest, and this suite lives in the jest-expo half of the
// runner split (src/crash/ is outside tools/lib/mutation-critical.mjs), so
// mutants in this file are a recorded honest loss — see the module README's
// mutation note for how to move the policy under the vitest runner if you want
// it mutated. The suite is written to the mutation-contract discipline anyway:
// production code is only ever called from inside an `it(...)` body — never a
// `beforeAll` — because a mutant that throws in a hook shows up as SKIPPED
// (which a mutation scorer counts as SURVIVED) instead of FAILED.

// Runs one context entry through the real pipeline and hands back the redacted
// value for that key. Plain function, called from inside tests only.
function redactedValue(key: string, value: unknown): unknown {
  const { context } = redactCrashEvent({ message: 'boot', context: { [key]: value } })
  return context?.[key]
}

// macOS home-path fixtures are COMPOSED, never written literally: the harness
// repo's leak scanner (scripts/hygiene.mjs) reds any literal macOS home-path
// text in shipped template files, and that includes test fixtures. join('/')
// on a leading '' yields the absolute path at runtime.
const macHome = ['', 'Users', 'jdoe'].join('/')

describe('redactText', () => {
  it('strips userinfo from credentialed connection strings', () => {
    expect(redactText('db failed: postgres://postgres:postgres@127.0.0.1:5432/app timeout')).toBe(
      'db failed: postgres://[redacted]@127.0.0.1:5432/app timeout',
    )
    expect(redactText('cache at redis://svc:hunter2@cache.internal:6379/0')).toBe(
      'cache at redis://[redacted]@cache.internal:6379/0',
    )
  })

  it('strips bearer tokens and JWT-shaped blobs', () => {
    expect(redactText('header was Bearer abc.def-123')).toBe('header was Bearer [redacted]')
    expect(redactText('token eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.c2ln leaked')).toBe(
      'token [redacted-jwt] leaked',
    )
  })

  it('strips e-mail addresses and home-directory usernames', () => {
    expect(redactText('user jane.doe@example.edu reported')).toBe('user [redacted-email] reported')
    expect(redactText('at C:\\Users\\jdoe\\AppData\\Roaming\\app\\logs')).toBe(
      'at C:\\Users\\[redacted]\\AppData\\Roaming\\app\\logs',
    )
    expect(redactText('read /home/jdoe/.config/app')).toBe('read /home/[redacted]/.config/app')
  })

  it('collapses macOS home paths to one marker (Metro dev-bundle stack frames)', () => {
    // The macOS rule consumes '/U…s/<username>' and emits '[redacted-home]'
    // WITHOUT reconstructing the path prefix — deliberately unlike the Windows
    // and Linux rules, so the rule's replacement string never contains the
    // literal the repo's leak scanner reds (see the comment in redact.ts).
    expect(redactText(`Error: boom at ${macHome}/dev/app/src/lib/api-client.ts:12:3`)).toBe(
      'Error: boom at [redacted-home]/dev/app/src/lib/api-client.ts:12:3',
    )
  })

  it('redacts EVERY macOS home path in the string, not just the first (the /g flag)', () => {
    const out = redactText(`${macHome}/a and ${macHome}/b`)
    expect(out).toBe('[redacted-home]/a and [redacted-home]/b')
  })

  it('leaves ordinary diagnostics untouched', () => {
    const message = 'ECONNREFUSED 127.0.0.1:5432 after 3000ms (attempt 2)'
    expect(redactText(message)).toBe(message)
  })
})

// A redaction boundary must scrub by DEFAULT, not scrub-what-it-listed. The scheme pattern
// used to be an allow-list — (postgres|mysql|redis|amqp) — and every scheme it forgot leaked
// the password in full. These rows are one per scheme the old allow-list missed.
describe('redactText: credentialed URLs of ANY scheme', () => {
  // Exactly the schemes the old allow-list FORGOT. (postgres/mysql/redis/amqp were already
  // covered above; the harness repo's own hygiene scanner rejects a postgres:// URL with a
  // non-sanctioned password in source, which is why they are not repeated here.)
  it.each([
    ['mongodb', 'mongodb://admin:hunter2@localhost:27017/app'],
    ['https', 'https://svc:hunter2@internal-api/health'],
    ['amqps', 'amqps://svc:hunter2@broker:5671'],
    ['ftp', 'ftp://anon:hunter2@files.internal'],
    ['mongodb+srv', 'mongodb+srv://admin:hunter2@cluster0/app'],
  ])('scrubs the userinfo from a %s:// URL', (scheme, url) => {
    const out = redactText(`connect ${url} failed`)
    expect(out).not.toContain('hunter2')
    expect(out).toContain(`${scheme}://[redacted]@`)
  })

  it('does not mistake an @ in a PATH for credentials', () => {
    const message = 'GET http://registry.internal/pkg/@scope/name failed'
    expect(redactText(message)).toBe(message)
  })
})

describe('redactText: bearer tokens are matched case-INSENSITIVELY', () => {
  // `authorization: bearer abc123opaque` is what a lowercase-header logger emits. Without the
  // /i flag an OPAQUE (non-JWT) lowercase token leaked in full — the JWT rule only rescues
  // the eyJ-shaped ones, so this row is the one that actually proves the flag.
  it.each(['Bearer', 'bearer', 'BEARER', 'BeArEr'])('redacts a %s-cased token', (word) => {
    const out = redactText(`authorization: ${word} abc123opaque-not-a-jwt`)
    expect(out).not.toContain('abc123opaque')
    expect(out).toContain('Bearer [redacted]')
  })

  it('redacts across MULTIPLE spaces — `\\s+`, not `\\s`', () => {
    // A pretty-printed header dump emits `Bearer   <token>`. With a single `\s` the class
    // would fail to reach the token and it would leak in full.
    const out = redactText('authorization: Bearer   abc123opaque-not-a-jwt')
    expect(out).not.toContain('abc123opaque')
    expect(out).toContain('Bearer [redacted]')
  })
})

// ---------------------------------------------------------------------------
// SECRET_KEY_PATTERN — every alternative, the /i flag, and the optional
// separator in api[-_]?key. One row per alternative, so dropping any single
// alternative from the pattern reds exactly one row.
// ---------------------------------------------------------------------------

describe('secret-key pattern', () => {
  const SECRET_KEYS: readonly string[] = [
    // one row per alternative in the pattern, in source order
    'password',
    'passwd',
    'secret',
    'token',
    'authorization',
    'cookie',
    'apikey', // api[-_]?key with the separator absent
    'api-key', // …with a hyphen
    'api_key', // …with an underscore
    'credential',
    'dsn',
  ]

  it.each([...SECRET_KEYS])('drops the value under secret-shaped key "%s"', (key) => {
    expect(redactedValue(key, 'hunter2-super-secret')).toBe('[redacted]')
  })

  it.each([...SECRET_KEYS])('never lets the value under "%s" reach the wire', (key) => {
    const event: CrashEvent = { message: 'boot', context: { [key]: 'hunter2-super-secret' } }
    expect(JSON.stringify(redactCrashEvent(event))).not.toContain('hunter2-super-secret')
  })

  // The /i flag: same alternatives, shouted or camel-cased.
  const CASE_VARIANT_KEYS: readonly string[] = [
    'PASSWORD',
    'PASSWD',
    'Secret',
    'X-Auth-TOKEN',
    'Authorization',
    'Cookie',
    'ApiKey',
    'Api-Key',
    'API_KEY',
    'Credential',
    'DSN',
  ]

  it.each([...CASE_VARIANT_KEYS])('matches key "%s" case-insensitively (the /i flag)', (key) => {
    expect(redactedValue(key, 'hunter2-super-secret')).toBe('[redacted]')
  })

  // Substring matching: the pattern is unanchored, so a secret alternative
  // anywhere inside a longer key still drops the value.
  it.each([
    'sessionToken',
    'db_password',
    'SENTRY_DSN',
    'setCookieHeader',
  ])('matches secret alternatives embedded in longer key "%s"', (key) => {
    expect(redactedValue(key, 'hunter2-super-secret')).toBe('[redacted]')
  })

  // The other direction — without these, a pattern mutated to match everything
  // would still pass. Values are chosen so redactText() is a no-op on them.
  it.each([
    'username',
    'count',
    'hostname',
    'attempt',
    'stage',
    'requestId',
  ])('leaves the value under non-secret key "%s" alone', (key) => {
    expect(redactedValue(key, 'keep-me')).toBe('keep-me')
  })
})

// ---------------------------------------------------------------------------
// The Bearer scrubber: /\bBearer\s+[A-Za-z0-9._~+/=-]+/g → 'Bearer [redacted]'
// Anchor (\b), separator (\s+), character class, quantifier (+) and flag (g)
// each get an assertion that fails if that piece is mutated away.
// ---------------------------------------------------------------------------

describe('redactText: bearer tokens', () => {
  it('consumes the whole token, including every punctuation char in the class', () => {
    // Every member of [A-Za-z0-9._~+/=-] appears in this token; if any one of
    // them were dropped from the class the tail would survive the replacement.
    expect(redactText('Bearer eyJhbGciOi.J9.abc-_~+/=')).toBe('Bearer [redacted]')
  })

  it.each([
    { label: 'dot', char: '.' },
    { label: 'underscore', char: '_' },
    { label: 'tilde', char: '~' },
    { label: 'plus', char: '+' },
    { label: 'slash', char: '/' },
    { label: 'equals', char: '=' },
    { label: 'hyphen', char: '-' },
  ])('consumes a $label ("$char") inside the token so no fragment leaks', ({ char }) => {
    expect(redactText(`Bearer abc${char}def`)).toBe('Bearer [redacted]')
  })

  it('redacts EVERY bearer token in the string, not just the first (the /g flag)', () => {
    expect(redactText('h1 Bearer tok-one then h2 Bearer tok-two end')).toBe(
      'h1 Bearer [redacted] then h2 Bearer [redacted] end',
    )
  })

  it('requires a word boundary before Bearer, so "NotBearer" is not a bearer header', () => {
    // \b means the pattern only fires at a word start: with the boundary removed
    // this becomes 'NotBearer [redacted]'.
    expect(redactText('NotBearer xyz')).toBe('NotBearer xyz')
  })

  it('requires whitespace between the scheme and the token', () => {
    // \s+ (not \s*): 'Bearerabc' is one word, not a header.
    expect(redactText('Bearerabc')).toBe('Bearerabc')
  })

  it('leaves a bare "Bearer" with no token material alone', () => {
    // The token quantifier is + (not *): there is nothing to redact here.
    expect(redactText('Bearer !')).toBe('Bearer !')
  })
})

// ---------------------------------------------------------------------------
// Array values. The secret-key check runs FIRST, so the array branch is only
// reachable under a non-secret key; both facts are pinned below.
// ---------------------------------------------------------------------------

describe('redactCrashEvent: array values', () => {
  it('redacts every element of an array under a non-secret key, in place', () => {
    expect(redactedValue('notes', ['ping alice@example.com', 'ping bob@example.com'])).toEqual([
      'ping [redacted-email]',
      'ping [redacted-email]',
    ])
  })

  it('returns an array, not an index-keyed object', () => {
    // Without the Array.isArray branch an array falls through to the object
    // branch and comes back as { '0': …, '1': … }.
    const out = redactedValue('notes', ['ping alice@example.com', 'plain'])
    expect(Array.isArray(out)).toBe(true)
    expect(out).toHaveLength(2)
  })

  it('passes an array under a non-secret key through unchanged when nothing matches', () => {
    expect(redactedValue('attempts', [1, 2, 3])).toEqual([1, 2, 3])
    expect(redactedValue('tags', ['alpha', 'beta'])).toEqual(['alpha', 'beta'])
  })

  it('recurses into nested arrays', () => {
    expect(redactedValue('rows', [['alice@example.com'], ['plain', ['deep@example.com']]])).toEqual(
      [['[redacted-email]'], ['plain', ['[redacted-email]']]],
    )
  })

  it('recurses into objects inside arrays, re-applying the key rule per element', () => {
    expect(
      redactedValue('users', [
        { email: 'alice@example.com', token: 't-1' },
        { email: 'bob@example.com', token: 't-2' },
      ]),
    ).toEqual([
      { email: '[redacted-email]', token: '[redacted]' },
      { email: '[redacted-email]', token: '[redacted]' },
    ])
  })

  it('drops an array under a SECRET key wholesale — the key rule wins before the array branch', () => {
    // Actual behaviour: the value is replaced by the '[redacted]' STRING; the
    // elements are never visited, so nothing array-shaped survives.
    expect(redactedValue('apiKeys', ['k-1', 'k-2'])).toBe('[redacted]')
    expect(redactedValue('access_token', [['deep-1'], ['deep-2']])).toBe('[redacted]')

    const event: CrashEvent = { message: 'boot', context: { apiKeys: ['k-1', 'k-2'] } }
    expect(JSON.stringify(redactCrashEvent(event))).not.toContain('k-1')
  })
})

describe('redactCrashEvent', () => {
  it('redacts message, stack, and string context values', () => {
    const event: CrashEvent = {
      message: 'probe by admin@example.com failed',
      stack: 'Error: at C:\\Users\\jdoe\\app\\main.js:1',
      context: { note: 'retrying as admin@example.com' },
    }
    const out = redactCrashEvent(event)
    expect(out.message).toBe('probe by [redacted-email] failed')
    expect(out.stack).toBe('Error: at C:\\Users\\[redacted]\\app\\main.js:1')
    expect(out.context).toEqual({ note: 'retrying as [redacted-email]' })
  })

  it('drops values under secret-shaped keys wholesale, at any nesting depth', () => {
    const event: CrashEvent = {
      message: 'boot',
      context: {
        config: {
          apiKey: 'k-123',
          authorization: 'whatever',
          harmless: 'keep-me',
          nested: { session_token: ['a', 'b'] },
        },
      },
    }
    expect(redactCrashEvent(event).context).toEqual({
      config: {
        apiKey: '[redacted]',
        authorization: '[redacted]',
        harmless: 'keep-me',
        nested: { session_token: '[redacted]' },
      },
    })
  })

  it('passes non-string primitives through unchanged', () => {
    const event: CrashEvent = {
      message: 'tick',
      context: { attempt: 3, degraded: true, latencyMs: 41.5, none: null },
    }
    expect(redactCrashEvent(event).context).toEqual({
      attempt: 3,
      degraded: true,
      latencyMs: 41.5,
      none: null,
    })
  })

  it('omits absent optional fields instead of materializing them', () => {
    const out = redactCrashEvent({ message: 'plain' })
    expect(out).toEqual({ message: 'plain' })
    expect('stack' in out).toBe(false)
    expect('context' in out).toBe(false)
  })
})
