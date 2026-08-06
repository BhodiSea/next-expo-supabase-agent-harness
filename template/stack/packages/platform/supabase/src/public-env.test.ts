import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The PUBLIC environment seam — the single edge between @app/supabase and @app/env for the
// web surfaces. Small, and load-bearing for one structural reason: it imports
// `@app/env/client`, NOT `@app/env`. The `.` barrel's schema NAMES every server secret, and
// this module is reachable from `./client`, which Metro bundles into the native binary.
//
// The parse is lazy — inside the function, never at module scope — because module-scope
// evaluation runs during import, before a test has arranged its environment and on a native
// host where these variables do not exist at all. A throw during module evaluation cannot be
// caught by the code that caused it.
// SOURCE: packages/platform/supabase/src/public-env.ts (the `./client` reachability rule)

// A LOCAL ambient declaration, not `@types/node` — this package sets `types: []` so that an
// ambient node typing cannot reach the `./client` barrel Metro bundles into the native
// binary. Same pattern as packages/platform/env/src/index.ts.
declare const process: { readonly env: Record<string, string | undefined> }

const URL_OK = 'https://project.supabase.co'
const PUBLISHABLE = 'sb_publishable_example-not-a-real-key'
const SECRET = 'sb_secret_example-not-a-real-key'

const TOUCHED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE',
  'NEXT_PUBLIC_WEB_ORIGIN',
] as const

const BASE: Readonly<Record<string, string>> = {
  NEXT_PUBLIC_SUPABASE_URL: URL_OK,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE: PUBLISHABLE,
  NEXT_PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
}

const saved = new Map<string, string | undefined>()

function setHostEnv(source: Readonly<Record<string, string | undefined>>): void {
  for (const name of TOUCHED) {
    const value = source[name]
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
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

describe('publicCredentials', () => {
  it('reads the NEXT_PUBLIC pair', async () => {
    const { publicCredentials } = await import('./public-env.js')
    expect(publicCredentials()).toEqual({ publishableKey: PUBLISHABLE, url: URL_OK })
  })

  it('parses LAZILY — importing the module with a hostile environment does not throw', async () => {
    // The structural property, asserted directly. If the parse moved to module scope, this
    // import would throw and there would be no call site able to catch it — on a native
    // host, in a test file, or in a Server Component render.
    setHostEnv({})
    await expect(import('./public-env.js')).resolves.toBeDefined()
  })

  it('refuses a SECRET key in the publishable slot', async () => {
    // requireCredentials' guard, reached through this seam. A secret key inlined into the
    // web bundle is the failure that ends a project; the name-shape check is what stops a
    // copy-paste from the server env file.
    setHostEnv({ ...BASE, NEXT_PUBLIC_SUPABASE_PUBLISHABLE: SECRET })
    const { publicCredentials } = await import('./public-env.js')
    expect(() => publicCredentials()).toThrow()
  })

  it('throws a message naming BOTH variables when the environment is empty', async () => {
    // The message is the whole value of the failure: a caller reading "missing credentials"
    // has to go find which two names to set.
    setHostEnv({})
    const { publicCredentials } = await import('./public-env.js')
    expect(() => publicCredentials()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/)
  })
})
