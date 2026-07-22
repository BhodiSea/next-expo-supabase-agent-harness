// readPackageVersion() — the version /healthz reports and, more importantly, the version
// the SKEW GUARD compares every mobile request against. It resolves package.json through
// TWO candidate paths because the module runs from two layouts: `src/` next to package.json
// under tsx (dev), and `dist/src/` under node (packaged). Exactly one of those layouts
// exists at a time, so the OTHER branch is unreachable from any single test run — the only
// way to prove the fallback is real is to control what the filesystem answers. Hence the
// node:fs stub: it is the filesystem, not the code, that is faked.
//
// If this loop silently resolved nothing, the packaged server would boot with a version it
// invented and 409 every client in the fleet.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AppOptions, createApp } from './app.js'
import type { NotesDal } from './types.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

// The two candidates app.ts tries, resolved against THIS file's URL — it sits in the same
// directory as app.ts, so `../package.json` means the same file to both.
const DEV_LAYOUT = new URL('../package.json', import.meta.url).href
const DIST_LAYOUT = new URL('../../package.json', import.meta.url).href

const emptyDal: NotesDal = {
  list: () => Promise.resolve({ items: [], nextCursor: null }),
  create: () => Promise.reject(new Error('not under test')),
  get: () => Promise.resolve(null),
  remove: () => Promise.resolve(false),
}

// No `version`: that is the whole point — the app must read it off disk.
const options: AppOptions = {
  verifyToken: () => Promise.resolve({ userId: '11111111-1111-4111-8111-111111111111' }),
  notesDal: emptyDal,
}

/**
 * Stubs the filesystem to hold exactly the given package.json files (href → version).
 * Anything else raises ENOENT, exactly as fs does; a non-utf8 encoding raises too, because
 * the real readFileSync rejects an unknown encoding rather than quietly handing back bytes.
 * Returns the list of paths the code actually tried, in order.
 */
function stubFilesystem(files: Readonly<Record<string, string>>): string[] {
  const attempted: string[] = []
  vi.mocked(readFileSync).mockImplementation((path, encoding): string => {
    const href = String(path)
    attempted.push(href)
    if (encoding !== 'utf8') {
      throw new TypeError(`Unknown encoding while reading ${href}`)
    }
    const version = files[href]
    if (version === undefined) {
      throw new Error(`ENOENT: no such file or directory, open '${href}'`)
    }
    return JSON.stringify({ name: 'server', version })
  })
  return attempted
}

async function versionFrom(app: ReturnType<typeof createApp>): Promise<unknown> {
  const res = await app.request('/healthz')
  expect(res.status).toBe(200)
  return res.json()
}

afterEach(() => {
  vi.mocked(readFileSync).mockReset() // back to the real fs for every other file
})

describe('readPackageVersion: resolves both layouts', () => {
  it('reads the package.json next to src/ (the tsx dev layout) and reports its version', async () => {
    const attempted = stubFilesystem({ [DEV_LAYOUT]: '1.0.0' })

    expect(await versionFrom(createApp(options))).toEqual({ ok: true, version: '1.0.0' })
    // It stops at the first hit — the fallback is a fallback, not a second read.
    expect(attempted).toEqual([DEV_LAYOUT])
  })

  it('falls back one directory up (the compiled dist/src layout) when the first is absent', async () => {
    const attempted = stubFilesystem({ [DIST_LAYOUT]: '2.0.0' })

    expect(await versionFrom(createApp(options))).toEqual({ ok: true, version: '2.0.0' })
    // Both candidates, in this order: a loop that tried only one path would boot the
    // PACKAGED server with no version at all.
    expect(attempted).toEqual([DEV_LAYOUT, DIST_LAYOUT])
  })

  it('throws — loudly, at construction — when neither candidate exists', () => {
    const attempted = stubFilesystem({})

    // Never a silent '0.0.0': the skew guard would then 409 every real client.
    expect(() => createApp(options)).toThrow(
      'unable to locate the server package.json to read its version',
    )
    expect(attempted).toEqual([DEV_LAYOUT, DIST_LAYOUT])
  })

  it('a package.json without a version field is a hard parse failure, not a blank version', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ name: 'server' }))

    expect(() => createApp(options)).toThrow() // the DTO refuses it
  })

  it('an explicit options.version wins and the filesystem is never touched', async () => {
    const attempted = stubFilesystem({})

    expect(await versionFrom(createApp({ ...options, version: '9.9.9' }))).toEqual({
      ok: true,
      version: '9.9.9',
    })
    expect(attempted).toEqual([])
  })
})
