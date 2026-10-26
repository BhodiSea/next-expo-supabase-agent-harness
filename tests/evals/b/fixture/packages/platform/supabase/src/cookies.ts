import type { SessionStorageAdapter } from './session-storage.js'

// ---------------------------------------------------------------------------
//        THE COOKIE ADAPTER — the indirection that keeps this package
//                       usable from a non-Next host
// ---------------------------------------------------------------------------
// THIS PACKAGE MUST NEVER IMPORT `next/*`, AT ANY LEVEL, AT ANY DEPTH.
//
// A single `import { cookies } from 'next/headers'` in this file would weld the
// one package both surfaces reach the database through to one web framework.
// The consequences are not hypothetical:
//
//   · Metro would try to resolve `next/headers` while bundling the native app —
//     it cannot, and the failure surfaces as an opaque bundling error rather
//     than as the layering violation it is.
//   · A standalone `apps/api`, a Supabase Edge Function, a migration script or
//     a Node test runner would all fail to import this package at all.
//   · Promoting the tRPC router out of apps/web would stop being a routing
//     change and become a rewrite — the reversibility wall, breached from
//     underneath.
//
// So the package declares WHAT it needs (a cookie jar) and the host supplies
// WHERE that jar lives. `apps/web` satisfies this interface over `next/headers`
// in `lib/supabase/server.ts` and over `NextRequest`/`NextResponse` in
// `proxy.ts` — two different jars, one interface, zero framework imports here.
// SOURCE: design/W1-STACK-SPEC.md §2 (the reversibility wall: packages must not
// import next/*) · apps/web/proxy.ts (the adapter is apps/web's whole obligation)
//
// ─── WHY `getAll`/`setAll` AND NOT `get`/`set`/`remove` ─────────────────────
// A per-NAME triple cannot see a cookie's siblings, and a Supabase session does
// not fit in one cookie. RFC 6265 §6.1 only guarantees 4096 bytes per cookie
// (name + value + attributes), while a session carrying an access token, a
// refresh token and user metadata routinely exceeds that. The session is
// therefore CHUNKED across `<key>.0`, `<key>.1`, … and reading it back means
// enumerating the jar. So does writing it: a rewrite that produces FEWER chunks
// than last time must expire the leftovers, and a `remove(name)` that only
// knows one name leaves them behind. Orphan chunks are the worst possible
// failure here — the next read concatenates a stale tail onto a fresh head,
// `JSON.parse` throws inside auth boot, and the user is signed out with a
// corrupted jar that signing in again does not clear.
//
// Batch shape has a second, independent reason: a host that has to rebuild its
// response object when cookies change (Next's proxy does exactly that) can do
// it once per request instead of once per cookie.
// SOURCE: https://www.rfc-editor.org/rfc/rfc6265#section-6.1 (user agents must
// support at least 4096 bytes per cookie)
// ---------------------------------------------------------------------------

/** One cookie as read from the jar. Only what this package uses. */
export interface SupabaseCookie {
  readonly name: string
  readonly value: string
}

/**
 * Attributes for a cookie being written.
 *
 * `secure` is deliberately ABSENT from the defaults below and is the HOST's
 * call, because only the host knows whether it is served over TLS: a hard-coded
 * `secure: true` makes plain-http local development fail to persist a session at
 * all, since a user agent DROPS a Secure cookie set over http. apps/web derives
 * it from the scheme at all three writers (the browser jar, `proxy.ts`, and
 * `lib/supabase/server.ts`) and passes it explicitly at each — an omitted value
 * at one writer is that writer STRIPPING the attribute the others set.
 *
 * `httpOnly` is a different case and it is worth being blunt about, because the
 * comment that used to sit here claimed apps/web set it and nothing did. On an
 * architecture where the BROWSER writes the session cookie — which is the one
 * apps/web chose, so the password never crosses an extra hop — `httpOnly` is not
 * merely unset, it is UNAVAILABLE: the attribute exists to make a cookie
 * invisible to script, and a user agent ignores it on a `document.cookie` write.
 * A host that needs an httpOnly session cookie must move sign-in server-side
 * first; until then the honest mitigations are `Secure`, `SameSite`, the CSRF
 * guard on the ambient-credential path, and a short-lived rotating token.
 * SOURCE: https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies#restrict_access_to_cookies
 */
export interface SupabaseCookieOptions {
  readonly domain?: string
  readonly httpOnly?: boolean
  readonly maxAge?: number
  readonly path?: string
  readonly sameSite?: 'lax' | 'none' | 'strict'
  readonly secure?: boolean
}

/** A cookie the auth client wants written (or, with `maxAge: 0`, expired). */
export interface SupabaseCookieToSet extends SupabaseCookie {
  readonly options: SupabaseCookieOptions
}

/**
 * The whole of a host's obligation to this package: read the jar, write the
 * jar. Implemented by apps/web over `next/headers`; implementable by any host
 * with cookies, and by a plain `Map` in a test.
 *
 * `setAll` is synchronous because every jar this targets is synchronous once
 * the host has awaited its own request context. An async `setAll` would force
 * the storage shim below to be async-only in a place Supabase's auth client
 * calls during construction.
 */
export interface SupabaseCookieAdapter {
  getAll(): readonly SupabaseCookie[]
  setAll(cookiesToSet: readonly SupabaseCookieToSet[]): void
}

/**
 * Bytes per chunk. Under RFC 6265 §6.1's 4096-byte floor with ~900 bytes of
 * headroom for the cookie NAME and its attributes (`Path`, `Max-Age`,
 * `SameSite`, `Secure`, and a `Domain` long enough to matter), all of which
 * count against the same budget. Sizing to exactly 4096 is the classic
 * off-by-attributes bug: it works until someone adds a domain attribute, and
 * then the last chunk is silently dropped by the user agent.
 *
 * The headroom is deliberately conservative rather than computed: `HttpOnly` is
 * never written on this architecture (it cannot be — see the options doc above),
 * so the budget already carries slack for an attribute that does not appear, and
 * a host that later moves sign-in server-side gains it without a resize.
 */
const CHUNK_BYTES = 3180

/** 400 days — the maximum lifetime a user agent will honour anyway, so asking
 * for more just makes the header longer. Supabase's own refresh cadence expires
 * the session long before this; the attribute exists so a closed tab does not
 * lose it. SOURCE: RFC 6265bis caps cookie lifetime at 400 days. */
const DEFAULT_MAX_AGE_SECONDS = 34_560_000

/** Expiring a cookie IS setting it, with a zero lifetime and an empty value.
 * There is no "delete" in the cookie protocol — `Max-Age=0` is the delete. */
const EXPIRE_NOW = 0

const DEFAULT_OPTIONS: SupabaseCookieOptions = {
  maxAge: DEFAULT_MAX_AGE_SECONDS,
  // Root path, always. A session cookie scoped to `/app` is invisible to a
  // request for `/api/...`, which presents as "signed in on one page, signed
  // out on the next".
  path: '/',
  // `lax`, not `strict`: `strict` withholds the cookie on a top-level
  // navigation that arrived from another site, so every magic-link and OAuth
  // return lands on a signed-out render before the client recovers. `none`
  // would require `secure` and invite cross-site delivery this app never needs.
  sameSite: 'lax',
}

/**
 * UTF-8 byte length of one code point. Chunking has to be measured in BYTES
 * because the 4096-byte cookie budget is bytes, while JavaScript strings are
 * counted in UTF-16 units — a session whose user metadata carries a name in a
 * non-Latin script, or a single emoji, is up to four times longer on the wire
 * than `String#length` claims. Sizing chunks by `length` overflows the budget
 * exactly for the users least likely to be in a test fixture.
 */
function utf8Bytes(codePoint: number): number {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

/**
 * Split a value into chunks of at most `limit` UTF-8 bytes, never splitting a
 * code point. Iterating the string with `for…of` is what guarantees the second
 * half: it yields whole code points, so a surrogate pair cannot be cut in two —
 * which would produce a lone surrogate that survives the round trip as U+FFFD
 * and corrupts the JSON it was part of.
 *
 * An empty value yields one empty chunk, not zero chunks. Zero would write no
 * cookie at all, and "no cookie" is not the same state as "a cookie holding an
 * empty session".
 */
export function chunkCookieValue(value: string, limit: number = CHUNK_BYTES): readonly string[] {
  const chunks: string[] = []
  let current = ''
  let size = 0
  for (const character of value) {
    const bytes = utf8Bytes(character.codePointAt(0) ?? 0)
    if (size + bytes > limit && current !== '') {
      chunks.push(current)
      current = ''
      size = 0
    }
    current += character
    size += bytes
  }
  chunks.push(current)
  return chunks
}

/** `<key>.<n>` — the chunk-name shape, anchored so a cookie that merely shares
 * a prefix (`sb-auth-code-verifier` next to `sb-auth`) is not mistaken for one. */
function chunkPattern(key: string): RegExp {
  return new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+$`)
}

/** Names this key currently occupies in the jar: the bare name and its chunks. */
function occupiedNames(key: string, jar: readonly SupabaseCookie[]): readonly string[] {
  const isChunk = chunkPattern(key)
  return jar.map((cookie) => cookie.name).filter((name) => name === key || isChunk.test(name))
}

/**
 * Reassemble a value from the jar, or null when it is not there.
 *
 * A GAP IN THE CHUNK SEQUENCE READS AS ABSENT. If `.0` and `.2` are present but
 * `.1` is missing, this returns null rather than concatenating what is there.
 * Returning the fragments would hand Supabase's auth client a truncated JSON
 * document; it throws on parse, and a throw during auth boot is a crash rather
 * than a sign-out. Null means "no session", the user signs in again, and the
 * next write replaces the whole set.
 */
export function readChunkedCookie(key: string, jar: readonly SupabaseCookie[]): string | null {
  const byName = new Map(jar.map((cookie) => [cookie.name, cookie.value]))
  // The bare name wins when it is present. `cookieWrites` guarantees the bare
  // form and the chunked form never coexist (it expires whichever the new value
  // does not use), so reaching both means a writer outside this module — and
  // preferring the unchunked one keeps the read deterministic either way.
  const whole = byName.get(key)
  if (whole !== undefined) return whole

  const parts: string[] = []
  for (let index = 0; ; index += 1) {
    const part = byName.get(`${key}.${String(index)}`)
    if (part === undefined) break
    parts.push(part)
  }
  if (parts.length === 0) return null

  // A chunk NUMBERED PAST the contiguous run means the sequence has a hole.
  // Returning the fragment before the hole would be worse than returning
  // nothing: it is a syntactically plausible prefix of a JSON document, and
  // Supabase's auth client throws on it during boot.
  const isChunk = chunkPattern(key)
  const chunkCount = jar.filter((cookie) => isChunk.test(cookie.name)).length
  return chunkCount === parts.length ? parts.join('') : null
}

/**
 * The write set for `key = value`: the fresh chunks, PLUS an expiry for every
 * name this key used to occupy and no longer does.
 *
 * The expiries are the half that is easy to forget and impossible to debug. A
 * session that shrinks (a user's metadata gets smaller, a scope is dropped)
 * goes from three chunks to two; without expiring `.2`, the next read appends a
 * stale tail to a fresh head and the parse fails. Likewise a value that used to
 * fit in one cookie and now needs chunks must expire the bare name, or
 * `readChunkedCookie` will find it first and return last week's session.
 */
export function cookieWrites(
  key: string,
  value: string,
  jar: readonly SupabaseCookie[],
  options: SupabaseCookieOptions = {},
  limit: number = CHUNK_BYTES,
): readonly SupabaseCookieToSet[] {
  const attributes = { ...DEFAULT_OPTIONS, ...options }
  const chunks = chunkCookieValue(value, limit)
  const fresh: SupabaseCookieToSet[] =
    chunks.length === 1 && chunks[0] !== undefined
      ? [{ name: key, options: attributes, value: chunks[0] }]
      : chunks.map((chunk, index) => ({
          name: `${key}.${String(index)}`,
          options: attributes,
          value: chunk,
        }))

  const written = new Set(fresh.map((cookie) => cookie.name))
  const stale = occupiedNames(key, jar)
    .filter((name) => !written.has(name))
    .map((name) => expire(name, attributes))
  return [...fresh, ...stale]
}

/** The write set that removes `key` entirely — every chunk, and the bare name. */
export function cookieDeletions(
  key: string,
  jar: readonly SupabaseCookie[],
  options: SupabaseCookieOptions = {},
): readonly SupabaseCookieToSet[] {
  const attributes = { ...DEFAULT_OPTIONS, ...options }
  return occupiedNames(key, jar).map((name) => expire(name, attributes))
}

function expire(name: string, attributes: SupabaseCookieOptions): SupabaseCookieToSet {
  // Path and domain must MATCH the ones the cookie was written with, or the
  // user agent treats the expiry as a different cookie and the original stays.
  // That is why the attributes are threaded through rather than reset here.
  return { name, options: { ...attributes, maxAge: EXPIRE_NOW }, value: '' }
}

/**
 * Present a cookie jar to Supabase's auth client as session storage.
 *
 * Every method re-reads the jar rather than caching it. On a server the jar is
 * request-scoped and short-lived, so there is nothing to gain from a cache and
 * everything to lose: a cached jar shared across an `await` boundary is one
 * request's session answering another request's read, which is the exact
 * cross-request identity leak the per-request client rule exists to prevent.
 */
export function cookieSessionStorage(
  cookies: SupabaseCookieAdapter,
  options: SupabaseCookieOptions = {},
): SessionStorageAdapter {
  return {
    getItem: (key) => Promise.resolve(readChunkedCookie(key, cookies.getAll())),
    removeItem: (key) => {
      cookies.setAll(cookieDeletions(key, cookies.getAll(), options))
      return Promise.resolve()
    },
    setItem: (key, value) => {
      cookies.setAll(cookieWrites(key, value, cookies.getAll(), options))
      return Promise.resolve()
    },
  }
}
