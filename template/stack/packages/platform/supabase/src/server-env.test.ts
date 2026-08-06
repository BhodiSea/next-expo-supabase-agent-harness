import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The SERVER environment seam. Two functions, and the second is the only place in the
// repository that reads the elevated key — so its guards are the difference between a
// configuration typo and an authorization boundary that silently stops boundary-ing.
//
// `@app/env`'s `.` barrel parses EAGERLY at module scope (`export const serverEnv =
// parseServerEnv()`), so every case here arranges `process.env` first, then imports the
// module under test through `vi.resetModules()` + a dynamic import. Setting the environment
// after the import would test the previous case's parse.
// SOURCE: packages/platform/env/src/index.ts (serverEnv is a module-scope parse)

// A LOCAL ambient declaration, not `@types/node`. This package sets `types: []` deliberately
// — an ambient node typing here would declare `process`, `Buffer` and `node:*` for the
// `./client` barrel too, and that barrel is bundled by Metro into the native binary. The same
// pattern (and the same reasoning) is at packages/platform/env/src/index.ts. Mutable here,
// unlike the source declaration, because arranging the environment is what these tests do.
declare const process: { readonly env: Record<string, string | undefined> }

const URL_OK = 'https://project.supabase.co'
const PUBLISHABLE = 'sb_publishable_example-not-a-real-key'
const SECRET = 'sb_secret_example-not-a-real-key'
const LEGACY_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.example.not-a-real-key'

const TOUCHED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE',
  'NEXT_PUBLIC_WEB_ORIGIN',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
] as const

const BASE: Readonly<Record<string, string>> = {
  NEXT_PUBLIC_SUPABASE_URL: URL_OK,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE: PUBLISHABLE,
  NEXT_PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
  SUPABASE_DB_URL: 'postgres://postgres:postgres@127.0.0.1:54322/postgres',
  SUPABASE_SERVICE_ROLE_KEY: SECRET,
}

const saved = new Map<string, string | undefined>()

function setHostEnv(source: Readonly<Record<string, string | undefined>>): void {
  for (const name of TOUCHED) {
    const value = source[name]
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
}

/** Import the module under test AFTER the environment is arranged. */
async function loadServerEnv() {
  vi.resetModules()
  return await import('./server-env.js')
}

beforeEach(() => {
  for (const name of TOUCHED) saved.set(name, process.env[name])
  setHostEnv(BASE)
})

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  saved.clear()
  vi.resetModules()
})

describe('serverPublicCredentials', () => {
  it('returns the PUBLISHABLE pair — a server request is not privileged for being a server request', async () => {
    // The invariant this test exists for: ordinary server work runs on the same key the
    // browser carries, so RLS is checking the forwarded identity. Reaching for the secret
    // key here "because it is server-side anyway" makes the boundary decorative.
    const { serverPublicCredentials } = await loadServerEnv()
    const creds = serverPublicCredentials()
    expect(creds.publishableKey).toBe(PUBLISHABLE)
    expect(creds.publishableKey).not.toBe(SECRET)
    expect(creds.url).toBe(URL_OK)
  })
})

describe('serviceRoleCredentials', () => {
  it('returns the secret key and the public project URL', async () => {
    const { serviceRoleCredentials } = await loadServerEnv()
    expect(serviceRoleCredentials()).toEqual({ secretKey: SECRET, url: URL_OK })
  })

  it('refuses a PUBLISHABLE key in the elevated slot', async () => {
    // THE test in this file. A publishable key here builds a client that works for
    // everything the caller could already do and fails only on the elevated operation —
    // a failure that reads as a policy bug and gets "fixed" by loosening a policy, which
    // is the worst possible outcome of a configuration typo.
    //
    // A DIFFERENT publishable value from the NEXT_PUBLIC one on purpose: an identical pair
    // trips @app/env's distinctness guard at import (asserted below), and this case has to
    // reach the guard that lives in server-env.ts itself.
    setHostEnv({
      ...BASE,
      SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_a-second-not-a-real-key',
    })
    const { serviceRoleCredentials } = await loadServerEnv()
    expect(() => serviceRoleCredentials()).toThrow(/not a secret key/i)
  })

  it('stays silent for a legacy JWT-shaped key rather than refusing it', async () => {
    // Prefix-checked deliberately: projects still on the legacy key format have no `sb_`
    // prefix to judge, and refusing them would brick a valid configuration. Recorded here
    // so the asymmetry is a tested decision rather than a gap someone closes by accident.
    setHostEnv({ ...BASE, SUPABASE_SERVICE_ROLE_KEY: LEGACY_JWT })
    const { serviceRoleCredentials } = await loadServerEnv()
    expect(serviceRoleCredentials().secretKey).toBe(LEGACY_JWT)
  })
})

describe('the guards that fire BEFORE this module runs', () => {
  // Both cases below are refused by @app/env's module-scope parse, so the failure lands at
  // IMPORT — not at the call. That ordering is the fail-fast doctrine working, and it is
  // worth pinning: it means serviceRoleCredentials()'s own `=== ''` branch is unreachable
  // through the ordinary environment path, and a future refactor that made @app/env lazy
  // would move these failures hours later into whichever request first read the value.

  it('refuses an EMPTY elevated key at startup, not at the call site', async () => {
    setHostEnv({ ...BASE, SUPABASE_SERVICE_ROLE_KEY: '' })
    await expect(loadServerEnv()).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('refuses an elevated key EQUAL to the publishable key at startup', async () => {
    // The catastrophic misconfiguration: the row-security-bypassing key compiled into the
    // bundle served to every browser. Every tenant would hold read and write access to
    // every other tenant's rows.
    setHostEnv({ ...BASE, SUPABASE_SERVICE_ROLE_KEY: PUBLISHABLE })
    await expect(loadServerEnv()).rejects.toThrow(/SAME value/i)
  })
})
