// The delete-account handler under vitest, in plain Node (1.1.0). handler.ts takes its
// clients and its environment as parameters, so these suites hand it scripted fakes and
// read back every call it made, in order. The order is the point: handler.ts's header
// explains why deleteUser must never run before the personal-org sweep is VERIFIED, and
// the first suite below goes red on a handler with steps 3 and 4 swapped.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CORS_HEADERS, createDeleteAccountHandler, readKey } from './handler.ts'

interface Step {
  data: unknown[] | null
  error: { message: string } | null
}

interface Script {
  user?: { id: string } | null
  userError?: { message: string } | null
  lookup?: Step
  sweep?: Step
  recheck?: Step
  deleteError?: { message: string } | null
}

const URL = 'https://project.supabase.test'
const PUBLISHABLE = 'sb_publishable_test_value'
const SECRET = 'sb_secret_test_value'
const ONE_ORG: Step = { data: [{ id: 'org-1' }], error: null }
const NO_ORG: Step = { data: [], error: null }

const BASE_ENV: Record<string, string> = {
  SUPABASE_URL: URL,
  SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
  SUPABASE_SECRET_KEY: SECRET,
}

/** A chain that records every call under its operation's name and resolves to `result`. */
function chain(op: string, calls: string[], result: () => Step | undefined) {
  const self = {
    eq(column: string, value: string) {
      calls.push(`${op}.eq(${column}=${value})`)
      return self
    },
    select(columns: string) {
      calls.push(`${op}.select(${columns})`)
      return self
    },
    then(resolve: (v: Step) => unknown, reject?: (e: unknown) => unknown) {
      calls.push(`${op}.await`)
      return Promise.resolve(result() ?? NO_ORG).then(resolve, reject)
    },
  }
  return self
}

/** The two clients the handler builds, scripted, plus every call made to them in order. */
function world(script: Script, env: Record<string, string> = BASE_ENV) {
  const calls: string[] = []
  const connects: Array<{ url: string; key: string; options: unknown }> = []
  let selects = 0
  const admin = {
    from(table: string) {
      calls.push(`from(${table})`)
      return {
        select(columns: string) {
          const op = selects === 0 ? 'lookup' : 'recheck'
          selects += 1
          calls.push(`${op}.select(${columns})`)
          return chain(op, calls, () => script[op])
        },
        delete() {
          calls.push('sweep.delete')
          return chain('sweep', calls, () => script.sweep)
        },
      }
    },
    auth: {
      admin: {
        deleteUser(id: string) {
          calls.push(`deleteUser(${id})`)
          return Promise.resolve({ error: script.deleteError ?? null })
        },
      },
    },
  }
  const caller = {
    auth: {
      getUser() {
        calls.push('getUser')
        return Promise.resolve({
          data: { user: script.user === undefined ? { id: 'user-1' } : script.user },
          error: script.userError ?? null,
        })
      },
    },
  }
  const logged: string[] = []
  const envReads: string[] = []
  const handler = createDeleteAccountHandler({
    env: (name) => {
      envReads.push(name)
      return env[name]
    },
    connect: ((url: string, key: string, options: unknown) => {
      connects.push({ url, key, options })
      return key === SECRET ? admin : caller
    }) as never,
    log: (message) => logged.push(message),
  })
  return { handler, calls, connects, logged, envReads }
}

const post = (headers: Record<string, string> = { Authorization: 'Bearer caller-token' }) =>
  new Request('https://fn.test/delete-account', { method: 'POST', headers })

async function body(res: Response): Promise<unknown> {
  return JSON.parse(await res.text())
}

describe('the order: the sweep is verified BEFORE deleteUser, and a mismatch never reaches it', () => {
  it('deletes the caller only after the lookup, the sweep and the recheck, in that order', async () => {
    const w = world({ lookup: ONE_ORG, sweep: ONE_ORG, recheck: NO_ORG })
    const res = await w.handler(post())
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true })
    expect(w.calls).toEqual([
      'getUser',
      'from(orgs)',
      'lookup.select(id)',
      'lookup.eq(created_by=user-1)',
      'lookup.eq(kind=personal)',
      'lookup.await',
      'from(orgs)',
      'sweep.delete',
      'sweep.eq(created_by=user-1)',
      'sweep.eq(kind=personal)',
      'sweep.select(id)',
      'sweep.await',
      'from(orgs)',
      'recheck.select(id)',
      'recheck.eq(created_by=user-1)',
      'recheck.eq(kind=personal)',
      'recheck.await',
      'deleteUser(user-1)',
    ])
    expect(w.logged).toEqual([])
  })

  it('returns 500 and never calls deleteUser when the swept count does not match the lookup', async () => {
    const w = world({ lookup: ONE_ORG, sweep: NO_ORG, recheck: NO_ORG })
    const res = await w.handler(post())
    expect(res.status).toBe(500)
    expect(await body(res)).toEqual({ error: 'deletion_failed' })
    expect(w.calls).not.toContain('deleteUser(user-1)')
    expect(w.logged).toEqual([
      'delete-account: personal-org sweep unverified for user-1 (expected 1, swept 0, remaining 0) — refusing to delete the auth user, because created_by is ON DELETE SET NULL and deleting it now would orphan the org beyond recovery',
    ])
  })

  it('returns 500 and never calls deleteUser when the recheck still finds the org', async () => {
    const w = world({ lookup: ONE_ORG, sweep: ONE_ORG, recheck: ONE_ORG })
    const res = await w.handler(post())
    expect(res.status).toBe(500)
    expect(w.calls).not.toContain('deleteUser(user-1)')
    expect(w.logged[0]).toContain('(expected 1, swept 1, remaining 1)')
  })

  it('returns 500 and never calls deleteUser when the recheck itself fails', async () => {
    const w = world({
      lookup: ONE_ORG,
      sweep: ONE_ORG,
      recheck: { data: null, error: { message: 'recheck down' } },
    })
    const res = await w.handler(post())
    expect(res.status).toBe(500)
    expect(w.calls).not.toContain('deleteUser(user-1)')
    expect(w.logged[0]).toContain(
      '(expected 1, swept 1, remaining ?, recheck failed: recheck down)',
    )
  })

  it('stops at the lookup when it fails: no sweep, no deleteUser', async () => {
    const w = world({ lookup: { data: null, error: { message: 'grant missing' } } })
    const res = await w.handler(post())
    expect(res.status).toBe(500)
    expect(await body(res)).toEqual({ error: 'deletion_failed' })
    expect(w.calls).not.toContain('sweep.delete')
    expect(w.calls).not.toContain('deleteUser(user-1)')
    expect(w.logged).toEqual([
      'delete-account: personal-org lookup failed for user-1: grant missing',
    ])
  })

  it('stops at the sweep when it fails: no recheck, no deleteUser', async () => {
    const w = world({ lookup: ONE_ORG, sweep: { data: null, error: { message: 'sweep down' } } })
    const res = await w.handler(post())
    expect(res.status).toBe(500)
    expect(w.calls).not.toContain('recheck.select(id)')
    expect(w.calls).not.toContain('deleteUser(user-1)')
    expect(w.logged).toEqual(['delete-account: personal-org sweep failed for user-1: sweep down'])
  })

  it('treats a null result as zero rows: a caller with no personal org is still deleted', async () => {
    const empty: Step = { data: null, error: null }
    const w = world({ lookup: empty, sweep: empty, recheck: empty })
    const res = await w.handler(post())
    expect(res.status).toBe(200)
    expect(w.calls.at(-1)).toBe('deleteUser(user-1)')
  })

  it('reports a failed deleteUser as 500, after the verified sweep', async () => {
    const w = world({
      lookup: ONE_ORG,
      sweep: ONE_ORG,
      recheck: NO_ORG,
      deleteError: { message: 'admin api down' },
    })
    const res = await w.handler(post())
    expect(res.status).toBe(500)
    expect(await body(res)).toEqual({ error: 'deletion_failed' })
    expect(w.logged).toEqual(['delete-account: admin.deleteUser failed for user-1: admin api down'])
  })
})

describe('who it deletes, and with which key', () => {
  it('resolves the caller with the publishable key and their own token, and sweeps with the secret key', async () => {
    const w = world({ lookup: NO_ORG, sweep: NO_ORG, recheck: NO_ORG })
    await w.handler(post({ Authorization: 'Bearer caller-token' }))
    expect(w.connects).toEqual([
      {
        url: URL,
        key: PUBLISHABLE,
        options: {
          global: { headers: { Authorization: 'Bearer caller-token' } },
          auth: { persistSession: false, autoRefreshToken: false },
        },
      },
      {
        url: URL,
        key: SECRET,
        options: { auth: { persistSession: false, autoRefreshToken: false } },
      },
    ])
  })

  it('answers 401 without an Authorization header, before building any client', async () => {
    const w = world({})
    const res = await w.handler(post({}))
    expect(res.status).toBe(401)
    expect(await body(res)).toEqual({ error: 'unauthorized' })
    expect(w.connects).toEqual([])
  })

  it('answers 401 when the token does not verify, and never builds the elevated client', async () => {
    const w = world({ userError: { message: 'bad jwt' } })
    const res = await w.handler(post())
    expect(res.status).toBe(401)
    expect(await body(res)).toEqual({ error: 'unauthorized' })
    expect(w.connects.map((c) => c.key)).toEqual([PUBLISHABLE])
  })

  it('answers 401 when the token verifies to no user', async () => {
    const w = world({ user: null })
    const res = await w.handler(post())
    expect(res.status).toBe(401)
    expect(await body(res)).toEqual({ error: 'unauthorized' })
    expect(w.connects.map((c) => c.key)).toEqual([PUBLISHABLE])
  })
})

describe('the HTTP surface', () => {
  it('answers the CORS preflight with the fixed headers', async () => {
    const w = world({})
    const res = await w.handler(
      new Request('https://fn.test/delete-account', { method: 'OPTIONS' }),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(Object.fromEntries(res.headers)).toEqual({
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
      'content-type': 'text/plain;charset=UTF-8',
    })
    expect(CORS_HEADERS['Access-Control-Allow-Origin']).toBe('*')
  })

  it('refuses any method but POST with 405, as JSON with the CORS headers', async () => {
    const w = world({})
    const res = await w.handler(new Request('https://fn.test/delete-account', { method: 'GET' }))
    expect(res.status).toBe(405)
    expect(await body(res)).toEqual({ error: 'method_not_allowed' })
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS')
  })

  it.each([
    ['SUPABASE_URL'],
    ['SUPABASE_PUBLISHABLE_KEY'],
    ['SUPABASE_SECRET_KEY'],
  ])('answers 500 server_misconfigured without %s, naming both key generations', async (missing) => {
    const env = { ...BASE_ENV }
    delete env[missing]
    const w = world({}, env)
    const res = await w.handler(post())
    expect(res.status).toBe(500)
    expect(await body(res)).toEqual({ error: 'server_misconfigured' })
    expect(w.connects).toEqual([])
    expect(w.logged).toEqual([
      'delete-account: missing SUPABASE_URL, or a publishable key (SUPABASE_PUBLISHABLE_KEYS / SUPABASE_PUBLISHABLE_KEY / SUPABASE_ANON_KEY), or a secret key (SUPABASE_SECRET_KEYS / SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY)',
    ])
  })

  it('reads the environment once, when the handler is built, not per request', async () => {
    const w = world({ lookup: NO_ORG, sweep: NO_ORG, recheck: NO_ORG })
    const atBuild = w.envReads.length
    await w.handler(post())
    await w.handler(post())
    expect(w.envReads.length).toBe(atBuild)
    expect(w.envReads).toContain('SUPABASE_URL')
  })

  it.each([
    [
      'the JSON-object publishable key and the legacy secret key',
      {
        SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }),
        SUPABASE_SERVICE_ROLE_KEY: SECRET,
      },
    ],
    [
      'the legacy publishable key and the JSON-object secret key',
      {
        SUPABASE_ANON_KEY: PUBLISHABLE,
        SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
      },
    ],
  ])('reads %s', async (_, keys) => {
    const w = world(
      { lookup: NO_ORG, sweep: NO_ORG, recheck: NO_ORG },
      { SUPABASE_URL: URL, ...keys },
    )
    const res = await w.handler(post())
    expect(res.status).toBe(200)
    expect(w.connects.map((c) => c.key)).toEqual([PUBLISHABLE, SECRET])
  })
})

describe('the default log is console.error', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes a misconfiguration to console.error when no log is given', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const handler = createDeleteAccountHandler({
      env: () => undefined,
      connect: (() => null) as never,
    })
    const res = await handler(post())
    expect(res.status).toBe(500)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0]?.[0])).toContain('delete-account: missing SUPABASE_URL')
  })
})

describe('readKey: which key the function runs with', () => {
  const NAMES = { object: 'KEYS', singular: 'KEY', legacy: 'LEGACY' }
  const read = (env: Record<string, string>) => {
    const logged: string[] = []
    const key = readKey(
      (name) => env[name],
      NAMES,
      (m) => logged.push(m),
    )
    return { key, logged }
  }

  it("takes the entry named 'default' even beside others", () => {
    expect(read({ KEYS: JSON.stringify({ other: 'b', default: 'a' }), KEY: 'c' })).toEqual({
      key: 'a',
      logged: [],
    })
  })

  it('takes the only entry when there is exactly one and none is named default', () => {
    expect(read({ KEYS: JSON.stringify({ primary: 'a' }), KEY: 'c' })).toEqual({
      key: 'a',
      logged: [],
    })
  })

  it("refuses to pick when there are several and none is named 'default'", () => {
    expect(read({ KEYS: JSON.stringify({ one: 'a', two: 'b' }) })).toEqual({
      key: undefined,
      logged: [
        "delete-account: KEYS holds 2 key(s) and none named 'default' — refusing to pick one by iteration order",
      ],
    })
  })

  it('falls back to the singular name after refusing', () => {
    expect(read({ KEYS: JSON.stringify({ one: 'a', two: 'b' }), KEY: 'c' }).key).toBe('c')
  })

  it("does not take an empty 'default' or an empty only entry", () => {
    expect(read({ KEYS: JSON.stringify({ default: '' }), KEY: 'c' })).toEqual({
      key: 'c',
      logged: [
        "delete-account: KEYS holds 1 key(s) and none named 'default' — refusing to pick one by iteration order",
      ],
    })
    expect(read({ KEYS: JSON.stringify({ only: '' }) }).key).toBeUndefined()
  })

  it('ignores entries that are not strings when counting', () => {
    expect(read({ KEYS: JSON.stringify({ default: 7, only: 'a' }) }).key).toBe('a')
  })

  it('ignores a value that is not JSON, says so, and falls back', () => {
    expect(read({ KEYS: 'not-json', LEGACY: 'l' })).toEqual({
      key: 'l',
      logged: ['delete-account: KEYS is set but is not valid JSON — ignoring it'],
    })
  })

  it('ignores JSON that is not an object, silently', () => {
    expect(read({ KEYS: '"a"', KEY: 'c' })).toEqual({ key: 'c', logged: [] })
    expect(read({ KEYS: 'null', KEY: 'c' })).toEqual({ key: 'c', logged: [] })
  })

  it('prefers the singular name to the legacy one, and returns undefined when neither is set', () => {
    expect(read({ KEY: 'c', LEGACY: 'l' }).key).toBe('c')
    expect(read({ LEGACY: 'l' }).key).toBe('l')
    expect(read({}).key).toBeUndefined()
  })
})
