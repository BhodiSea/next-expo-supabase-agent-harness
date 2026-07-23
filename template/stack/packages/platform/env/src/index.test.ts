// The environment's four promises, every one of them silent when broken:
//   1. LOUDNESS — a missing or malformed variable stops the process at startup
//      with the variable's NAME in the message. Never a default, never a lazy
//      first-read failure inside one unlucky request.
//   2. SEPARATION — the client parsers see class (b) and (c) only. A server-only
//      name handed to one is refused, not quietly stripped.
//   3. THE BARREL WALL — nothing server-side is reachable from ./client, which
//      is the file Metro bundles into the native binary.
//   4. THE CROSS-CHECK — the elevated key and the publishable key are never the
//      same string, because that mistake makes everything work.
//
// The server barrel is imported DYNAMICALLY throughout. That is not test
// plumbing, it is the assertion: ./index.ts parses at module evaluation, so
// `import('./index.js')` itself is what rejects on a bad environment. A static
// import at the top of this file would take the whole suite down with it — which
// is exactly the behaviour a deployment gets, and the reason it is spelled out
// here rather than worked around.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvSource } from './client.js'
import * as clientBarrel from './client.js'
import {
  NativePublicEnvSchema,
  parseNativePublicEnv,
  parseWebPublicEnv,
  PUBLIC_PREFIXES,
  readNativePublicEnv,
  readWebPublicEnv,
  WebPublicEnvSchema,
} from './client.js'

// The test host's environment, typed exactly as narrowly as the modules under
// test type theirs (this package compiles with an empty ambient type list, so
// there is no @types/node `ProcessEnv` here either).
declare const process: { readonly env: Record<string, string | undefined> }

// Fixtures with no entropy and no credential shape. A realistic-looking key in a
// committed test file is a secret-scanner finding forever after, and every
// assertion below cares about length and identity, never about format.
const A_KEY = 'a'.repeat(24)
const B_KEY = 'b'.repeat(24)
const LOCAL_DB_URL = 'postgresql://postgres@127.0.0.1:54322/postgres'
const PROJECT_URL = 'https://project-ref.supabase.co'
const WEB_ORIGIN = 'https://notes.example.com'

const WEB_OK: EnvSource = {
  NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE: A_KEY,
  NEXT_PUBLIC_WEB_ORIGIN: WEB_ORIGIN,
}

const NATIVE_OK: EnvSource = {
  EXPO_PUBLIC_SUPABASE_URL: PROJECT_URL,
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE: A_KEY,
  EXPO_PUBLIC_WEB_ORIGIN: WEB_ORIGIN,
}

// Everything a server boot needs: class (a) plus class (b), which is what
// ./index.ts validates in one pass.
const SERVER_OK: EnvSource = {
  ...WEB_OK,
  SUPABASE_SERVICE_ROLE_KEY: B_KEY,
  SUPABASE_DB_URL: LOCAL_DB_URL,
}

const TOUCHED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE',
  'NEXT_PUBLIC_WEB_ORIGIN',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE',
  'EXPO_PUBLIC_WEB_ORIGIN',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
] as const

/** Put the host into exactly `source` for the variables this package can see. */
function setHostEnv(source: EnvSource): void {
  for (const name of TOUCHED) {
    const value = source[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

beforeEach(() => {
  setHostEnv({})
})

afterEach(() => {
  setHostEnv({})
  vi.resetModules()
})

describe('the public parsers', () => {
  it('parses a well-formed web environment into exactly its declared keys', () => {
    expect(parseWebPublicEnv(WEB_OK)).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE: A_KEY,
      NEXT_PUBLIC_WEB_ORIGIN: WEB_ORIGIN,
    })
  })

  it('parses a well-formed native environment', () => {
    expect(parseNativePublicEnv(NATIVE_OK)).toEqual(NATIVE_OK)
  })

  it('fails loudly on a missing required variable, naming it', () => {
    // The single most common deployment mistake: the variable was never set.
    expect(() =>
      parseWebPublicEnv({ ...WEB_OK, NEXT_PUBLIC_SUPABASE_PUBLISHABLE: undefined }),
    ).toThrow(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE/)
    // ...and the second most common: env.example's bare `NAME=` line copied over.
    expect(() => parseWebPublicEnv({ ...WEB_OK, NEXT_PUBLIC_SUPABASE_PUBLISHABLE: '' })).toThrow(
      /NEXT_PUBLIC_SUPABASE_PUBLISHABLE/,
    )
    expect(() => parseNativePublicEnv({})).toThrow(/EXPO_PUBLIC_SUPABASE_PUBLISHABLE/)
  })

  it('names EVERY offending variable in ONE message, not just the first', () => {
    // A boot-fix-boot-fix loop is how an operator ends up deleting the check.
    // Three assertions against the SAME thunk: each one re-runs it and matches
    // the one message, so all three names have to be in it.
    const emptyEnvironment = (): unknown => parseWebPublicEnv({})
    expect(emptyEnvironment).toThrow(/NEXT_PUBLIC_SUPABASE_URL/)
    expect(emptyEnvironment).toThrow(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE/)
    expect(emptyEnvironment).toThrow(/NEXT_PUBLIC_WEB_ORIGIN/)
  })

  it('rejects an origin carrying a path or a trailing slash', () => {
    // `origin + '/api'` on a trailing-slash value yields a double slash that some
    // gateways route and some 404 — a bug that only shows up in one environment.
    expect(() =>
      parseWebPublicEnv({ ...WEB_OK, NEXT_PUBLIC_WEB_ORIGIN: `${WEB_ORIGIN}/` }),
    ).toThrow(/NEXT_PUBLIC_WEB_ORIGIN/)
    expect(() =>
      parseWebPublicEnv({ ...WEB_OK, NEXT_PUBLIC_WEB_ORIGIN: `${WEB_ORIGIN}/app` }),
    ).toThrow(/NEXT_PUBLIC_WEB_ORIGIN/)
  })

  it('rejects a cleartext origin unless it is loopback', () => {
    expect(() =>
      parseWebPublicEnv({ ...WEB_OK, NEXT_PUBLIC_WEB_ORIGIN: 'http://notes.example.com' }),
    ).toThrow(/NEXT_PUBLIC_WEB_ORIGIN/)
    // The local stack, which never leaves the machine.
    expect(
      parseWebPublicEnv({ ...WEB_OK, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' })
        .NEXT_PUBLIC_SUPABASE_URL,
    ).toBe('http://127.0.0.1:54321')
  })

  it('omits an unset optional native variable rather than inventing a default', () => {
    // Optional here means "this surface has a second, COMMITTED source for the
    // value" (app.config.ts extra), never "we picked something". An absent key is
    // absent — the caller can see that it has to fall back.
    const parsed = parseNativePublicEnv({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE: A_KEY })
    expect(Object.hasOwn(parsed, 'EXPO_PUBLIC_SUPABASE_URL')).toBe(false)
    expect(Object.hasOwn(parsed, 'EXPO_PUBLIC_WEB_ORIGIN')).toBe(false)
    expect(parsed).toEqual({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE: A_KEY })
  })
})

describe('the wall between the three classes', () => {
  it('refuses a server-only name handed to a client parser', () => {
    // Refused, not stripped: the defect is the SHAPE of the call — a record
    // carrying a secret was wired into a parser whose output a client component
    // reads — and the next edit is the one that ships it.
    expect(() => parseWebPublicEnv({ ...WEB_OK, SUPABASE_SERVICE_ROLE_KEY: B_KEY })).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    )
    expect(() => parseNativePublicEnv({ ...NATIVE_OK, SUPABASE_DB_URL: LOCAL_DB_URL })).toThrow(
      /SUPABASE_DB_URL/,
    )
  })

  it('refuses even a present-but-undefined server-only name', () => {
    expect(() => parseWebPublicEnv({ ...WEB_OK, SUPABASE_DB_URL: undefined })).toThrow(
      /SUPABASE_DB_URL/,
    )
  })

  it('never carries the other public class into a parsed result', () => {
    // Both classes are public, so this one is about correctness rather than
    // secrecy: a native value silently satisfying a web schema would let a
    // half-configured web deploy boot green.
    const parsed = parseWebPublicEnv({ ...WEB_OK, EXPO_PUBLIC_SUPABASE_PUBLISHABLE: B_KEY })
    expect(Object.hasOwn(parsed, 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE')).toBe(false)
    expect(PUBLIC_PREFIXES).toEqual(['NEXT_PUBLIC_', 'EXPO_PUBLIC_'])
  })

  it('reads only its own class from the host, whatever else is set', () => {
    setHostEnv({ ...SERVER_OK, ...NATIVE_OK })
    expect(Object.keys(readWebPublicEnv()).sort()).toEqual([
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE',
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_WEB_ORIGIN',
    ])
    expect(Object.keys(readNativePublicEnv()).sort()).toEqual([
      'EXPO_PUBLIC_SUPABASE_PUBLISHABLE',
      'EXPO_PUBLIC_SUPABASE_URL',
      'EXPO_PUBLIC_WEB_ORIGIN',
    ])
  })

  it('exposes no server-side surface on the Metro-safe barrel', () => {
    // The census in tools/exports-walls.json permits apps/mobile to import
    // ./client and forbids the "." barrel. This is the same wall asserted from
    // the inside: nothing server-shaped is reachable from the file Metro bundles.
    const exported = new Set(Object.keys(clientBarrel))
    for (const name of ['parseWebPublicEnv', 'parseNativePublicEnv', 'WebPublicEnvSchema']) {
      expect(exported.has(name)).toBe(true)
    }
    const serverSide = ['serverEnv', 'webEnv', 'parseServerEnv', 'readServerEnv', 'ServerEnvSchema']
    for (const name of serverSide) expect(exported.has(name)).toBe(false)
  })

  it('declares the schemas as data the rest of the tree can read', () => {
    // The schema objects are exported so a surface can generate its own env
    // documentation from them rather than maintaining a second list by hand.
    expect(Object.keys(WebPublicEnvSchema.shape).sort()).toEqual([
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE',
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_WEB_ORIGIN',
    ])
    expect(Object.keys(NativePublicEnvSchema.shape).sort()).toEqual([
      'EXPO_PUBLIC_SUPABASE_PUBLISHABLE',
      'EXPO_PUBLIC_SUPABASE_URL',
      'EXPO_PUBLIC_WEB_ORIGIN',
    ])
  })
})

describe('the server barrel', () => {
  it('parses the whole server-side environment AT IMPORT', async () => {
    setHostEnv(SERVER_OK)
    vi.resetModules()
    const serverBarrel = await import('./index.js')
    expect(serverBarrel.serverEnv).toEqual({
      SUPABASE_SERVICE_ROLE_KEY: B_KEY,
      SUPABASE_DB_URL: LOCAL_DB_URL,
    })
    // The server validates the values it will inline into the browser bundle too:
    // one boot check covers the whole server-side surface.
    expect(serverBarrel.webEnv.NEXT_PUBLIC_WEB_ORIGIN).toBe(WEB_ORIGIN)
    // ./client rides through, so a server module needs one import for all three
    // classes.
    expect(typeof serverBarrel.parseNativePublicEnv).toBe('function')
  })

  it('refuses to LOAD when a secret is missing — the import itself rejects', async () => {
    setHostEnv({ ...SERVER_OK, SUPABASE_DB_URL: undefined })
    vi.resetModules()
    await expect(import('./index.js')).rejects.toThrow(/SUPABASE_DB_URL/)
  })

  it('refuses to load when a secret is malformed', async () => {
    setHostEnv({ ...SERVER_OK, SUPABASE_DB_URL: 'localhost:54322' })
    vi.resetModules()
    await expect(import('./index.js')).rejects.toThrow(/SUPABASE_DB_URL/)
  })

  it('refuses to load when the public web environment is incomplete', async () => {
    setHostEnv({ ...SERVER_OK, NEXT_PUBLIC_SUPABASE_URL: undefined })
    vi.resetModules()
    await expect(import('./index.js')).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL/)
  })

  it('refuses to load when the publishable name holds the elevated key', async () => {
    // The failure this catches is silent in the worst direction: row security is
    // BYPASSED rather than violated, so nothing errors, nothing reds, and the
    // elevated key is now baked into every browser bundle.
    setHostEnv({ ...SERVER_OK, NEXT_PUBLIC_SUPABASE_PUBLISHABLE: B_KEY })
    vi.resetModules()
    await expect(import('./index.js')).rejects.toThrow(/SAME value/)
  })

  it('parses its own record when handed one, without touching the host', async () => {
    setHostEnv(SERVER_OK)
    vi.resetModules()
    const serverBarrel = await import('./index.js')
    setHostEnv({})
    const supplied = { ...SERVER_OK, SUPABASE_SERVICE_ROLE_KEY: A_KEY }
    // The NEXT_PUBLIC_ keys in `supplied` are stripped: class (a)'s schema names
    // class (a) and nothing else.
    expect(serverBarrel.parseServerEnv(supplied)).toEqual({
      SUPABASE_SERVICE_ROLE_KEY: A_KEY,
      SUPABASE_DB_URL: LOCAL_DB_URL,
    })
    expect(() => serverBarrel.parseServerEnv({})).toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
  })
})
