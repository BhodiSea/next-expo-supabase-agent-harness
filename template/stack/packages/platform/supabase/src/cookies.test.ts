// The cookie layer's failure mode is not "an error" — it is a session that
// reassembles WRONG. A stale chunk left behind, a code point cut in half, or a
// bare cookie shadowing a fresh chunk set all produce a string that reaches
// JSON.parse inside Supabase's auth boot, throws, and presents as an app that
// crashes on launch for one user and nobody else. Everything below is that
// class of bug.
import { describe, expect, it } from 'vitest'
import {
  chunkCookieValue,
  cookieDeletions,
  cookieSessionStorage,
  cookieWrites,
  readChunkedCookie,
  type SupabaseCookie,
  type SupabaseCookieAdapter,
  type SupabaseCookieToSet,
} from './cookies.js'

/** A cookie jar in nine lines — the reason the adapter is an interface. */
function fakeJar(initial: readonly SupabaseCookie[] = []): SupabaseCookieAdapter & {
  readonly entries: () => readonly SupabaseCookie[]
} {
  const store = new Map(initial.map((cookie) => [cookie.name, cookie.value]))
  return {
    entries: () => [...store].map(([name, value]) => ({ name, value })),
    getAll: () => [...store].map(([name, value]) => ({ name, value })),
    setAll: (cookiesToSet: readonly SupabaseCookieToSet[]) => {
      for (const { name, options, value } of cookiesToSet) {
        // A real user agent deletes on Max-Age=0. The fake must too, or every
        // expiry assertion below would pass against a jar that never forgets.
        if (options.maxAge === 0) store.delete(name)
        else store.set(name, value)
      }
    },
  }
}

describe('chunkCookieValue', () => {
  it('keeps a short value in one chunk', () => {
    expect(chunkCookieValue('short', 100)).toEqual(['short'])
  })

  it('yields one empty chunk for an empty value, never zero', () => {
    // Zero chunks would write no cookie at all, and "no cookie" is a different
    // state from "a cookie holding an empty session".
    expect(chunkCookieValue('', 100)).toEqual([''])
  })

  it('splits on the BYTE budget, not on string length', () => {
    // 'é' is two UTF-8 bytes and one JS character. A limit of 4 therefore holds
    // two of them, not four — sizing by String#length would overflow the 4096
    // byte cookie budget for exactly the users least likely to be in a fixture.
    expect(chunkCookieValue('éééé', 4)).toEqual(['éé', 'éé'])
  })

  it('never splits a surrogate pair', () => {
    // A lone surrogate survives the round trip as U+FFFD and corrupts the JSON
    // it was part of. Each of these is 4 UTF-8 bytes.
    const chunks = chunkCookieValue('🔒🔑🗝', 5)
    expect(chunks).toEqual(['🔒', '🔑', '🗝'])
    expect(chunks.join('')).toBe('🔒🔑🗝')
  })

  it('never emits a chunk over the limit, and loses nothing', () => {
    const value = 'x'.repeat(1000)
    const chunks = chunkCookieValue(value, 64)
    expect(chunks.every((chunk) => chunk.length <= 64)).toBe(true)
    expect(chunks.join('')).toBe(value)
  })
})

describe('readChunkedCookie', () => {
  it('reads an unchunked value', () => {
    expect(readChunkedCookie('sb-auth', [{ name: 'sb-auth', value: 'session' }])).toBe('session')
  })

  it('reassembles chunks in index order, not jar order', () => {
    const jar: readonly SupabaseCookie[] = [
      { name: 'sb-auth.2', value: 'c' },
      { name: 'sb-auth.0', value: 'a' },
      { name: 'sb-auth.1', value: 'b' },
    ]
    expect(readChunkedCookie('sb-auth', jar)).toBe('abc')
  })

  it('returns null for an absent key', () => {
    expect(readChunkedCookie('sb-auth', [{ name: 'other', value: 'x' }])).toBeNull()
  })

  it('reads a GAP in the sequence as absent rather than concatenating fragments', () => {
    // Handing Supabase a truncated JSON document makes it throw during auth
    // boot — a crash, not a sign-out. Null means "no session", the user signs
    // in again, and the next write replaces the whole set.
    const jar: readonly SupabaseCookie[] = [
      { name: 'sb-auth.0', value: 'a' },
      { name: 'sb-auth.2', value: 'c' },
    ]
    expect(readChunkedCookie('sb-auth', jar)).toBeNull()
  })

  it('does not confuse a different key that shares a prefix', () => {
    const jar: readonly SupabaseCookie[] = [{ name: 'sb-auth-code-verifier', value: 'v' }]
    expect(readChunkedCookie('sb-auth', jar)).toBeNull()
  })
})

describe('cookieWrites', () => {
  it('writes a small value under the bare name', () => {
    const writes = cookieWrites('sb-auth', 'session', [], {}, 100)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ name: 'sb-auth', value: 'session' })
  })

  it('writes a large value as indexed chunks', () => {
    const writes = cookieWrites('sb-auth', 'abcdef', [], {}, 2)
    expect(writes.map((cookie) => cookie.name)).toEqual(['sb-auth.0', 'sb-auth.1', 'sb-auth.2'])
  })

  it('expires the chunks a SHRINKING value no longer occupies', () => {
    // Three chunks down to two. Without the expiry, the next read appends last
    // week's tail to this week's head and the parse fails.
    const jar: readonly SupabaseCookie[] = [
      { name: 'sb-auth.0', value: 'aa' },
      { name: 'sb-auth.1', value: 'bb' },
      { name: 'sb-auth.2', value: 'cc' },
    ]
    const writes = cookieWrites('sb-auth', 'abcd', jar, {}, 2)
    const expired = writes.filter((cookie) => cookie.options.maxAge === 0)
    expect(expired.map((cookie) => cookie.name)).toEqual(['sb-auth.2'])
  })

  it('expires the bare name when a value grows into chunks', () => {
    // Otherwise readChunkedCookie finds the bare cookie FIRST and returns the
    // stale session forever.
    const jar: readonly SupabaseCookie[] = [{ name: 'sb-auth', value: 'old' }]
    const writes = cookieWrites('sb-auth', 'abcd', jar, {}, 2)
    const expired = writes.filter((cookie) => cookie.options.maxAge === 0)
    expect(expired.map((cookie) => cookie.name)).toEqual(['sb-auth'])
  })

  it('defaults to a root path and lax same-site', () => {
    // A session cookie scoped below root is invisible to /api/* — "signed in on
    // one page, signed out on the next". Strict same-site withholds the cookie
    // on the top-level navigation every magic-link return performs.
    const [cookie] = cookieWrites('sb-auth', 'session', [], {}, 100)
    expect(cookie?.options.path).toBe('/')
    expect(cookie?.options.sameSite).toBe('lax')
  })

  it('leaves secure and httpOnly to the host', () => {
    const [cookie] = cookieWrites('sb-auth', 'session', [], {}, 100)
    expect(cookie?.options.secure).toBeUndefined()
    expect(cookie?.options.httpOnly).toBeUndefined()
    // …and honours them when the host does supply them.
    const [hardened] = cookieWrites('sb-auth', 'session', [], { httpOnly: true, secure: true }, 100)
    expect(hardened?.options).toMatchObject({ httpOnly: true, secure: true })
  })

  it('carries the write attributes onto the expiry', () => {
    // A user agent matches an expiry to the original by path and domain. Reset
    // them and the "delete" creates a second cookie while the first survives.
    const jar: readonly SupabaseCookie[] = [{ name: 'sb-auth', value: 'old' }]
    const writes = cookieWrites('sb-auth', 'abcd', jar, { domain: 'app.test', path: '/' }, 2)
    const expired = writes.find((cookie) => cookie.options.maxAge === 0)
    expect(expired?.options).toMatchObject({ domain: 'app.test', path: '/' })
  })
})

describe('cookieDeletions', () => {
  it('expires the bare name and every chunk, and nothing else', () => {
    const jar: readonly SupabaseCookie[] = [
      { name: 'sb-auth', value: 'a' },
      { name: 'sb-auth.0', value: 'b' },
      { name: 'sb-auth.1', value: 'c' },
      { name: 'unrelated', value: 'd' },
    ]
    const deletions = cookieDeletions('sb-auth', jar)
    expect(deletions.map((cookie) => cookie.name)).toEqual(['sb-auth', 'sb-auth.0', 'sb-auth.1'])
    expect(deletions.every((cookie) => cookie.options.maxAge === 0)).toBe(true)
    expect(deletions.every((cookie) => cookie.value === '')).toBe(true)
  })
})

describe('cookieSessionStorage', () => {
  it('round-trips a session that needs chunking', async () => {
    const jar = fakeJar()
    const storage = cookieSessionStorage(jar)
    const session = JSON.stringify({ user: { id: 'user-1' }, filler: 'x'.repeat(8000) })

    await storage.setItem('sb-auth', session)
    expect(jar.entries().length).toBeGreaterThan(1)
    expect(await storage.getItem('sb-auth')).toBe(session)
  })

  it('leaves nothing behind on removeItem', async () => {
    const jar = fakeJar([{ name: 'unrelated', value: 'keep' }])
    const storage = cookieSessionStorage(jar)

    await storage.setItem('sb-auth', 'x'.repeat(9000))
    await storage.removeItem('sb-auth')

    expect(await storage.getItem('sb-auth')).toBeNull()
    expect(jar.entries()).toEqual([{ name: 'unrelated', value: 'keep' }])
  })

  it('survives a rewrite from many chunks down to one', async () => {
    const jar = fakeJar()
    const storage = cookieSessionStorage(jar)

    await storage.setItem('sb-auth', 'x'.repeat(9000))
    await storage.setItem('sb-auth', 'small')

    // The read must see 'small' and not 'small' plus an orphaned tail.
    expect(await storage.getItem('sb-auth')).toBe('small')
  })

  it('re-reads the jar on every call rather than caching it', async () => {
    // A cached jar shared across an await boundary is one request's session
    // answering another request's read.
    const jar = fakeJar()
    const storage = cookieSessionStorage(jar)
    expect(await storage.getItem('sb-auth')).toBeNull()
    jar.setAll([{ name: 'sb-auth', options: {}, value: 'arrived-later' }])
    expect(await storage.getItem('sb-auth')).toBe('arrived-later')
  })
})
