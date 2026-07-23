import { CLIENT_VERSION_HEADER } from '@app/contracts'
import type { NotesDatabase } from '@app/notes'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import { createContext, type Session } from './context.js'
import { appRouter } from './index.js'
import { isSkewed, isVersionSkewError, parseMajor, requireServerMajor } from './skew.js'
import { createCallerFactory } from './trpc.js'

const SERVER_VERSION = '1.2.3'

const SESSION: Session = {
  actor: {
    displayName: 'Sam',
    email: 'sam@example.test',
    userId: '9b2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5e',
  },
  membership: { role: 'owner', workspaceId: '5c2b1c7e-2a44-4a3e-8f5d-6c1a2b3c4d5f' },
}

/**
 * A database that FAILS if it is ever touched. Every assertion in this file is
 * about short-circuiting, so "the handler did not run" has to be provable, not
 * assumed — this is the tRPC equivalent of the inherited test's handler counter.
 */
const forbiddenDb: NotesDatabase = {
  from: () => {
    throw new Error('a skewed request must be rejected before any handler runs')
  },
}

async function callerFor(clientVersion?: string, serverVersion = SERVER_VERSION) {
  const headers: Record<string, string> = { authorization: 'Bearer test-token' }
  if (clientVersion !== undefined) headers[CLIENT_VERSION_HEADER] = clientVersion
  const ctx = await createContext({
    createClient: () => forbiddenDb,
    headers,
    now: () => '2026-06-01T12:00:00.000Z',
    resolveSession: () => Promise.resolve(SESSION),
    serverVersion,
  })
  return createCallerFactory(appRouter)(ctx)
}

// Each row pins one alternation or anchor of `/^\s*v?(\d+)(?:\.|$)/`.
const clientVersionCases = [
  { clientVersion: '1.2.3', pins: 'a plain matching semver passes', skewed: false },
  { clientVersion: 'v1.2.3', pins: 'the optional v prefix parses (v?)', skewed: false },
  { clientVersion: '1', pins: 'a bare major with no dot parses (the $ branch)', skewed: false },
  { clientVersion: '1.0.0-rc.1', pins: 'a prerelease keeps its major', skewed: false },
  { clientVersion: ' 1.0.0', pins: 'leading whitespace is tolerated (\\s*)', skewed: false },
  { clientVersion: 'x1.2.3', pins: 'the digits must be anchored at the start (^)', skewed: true },
  { clientVersion: 'v 1.2.3', pins: 'v must abut the digits', skewed: true },
  { clientVersion: 'abc', pins: 'a non-numeric version does not parse', skewed: true },
  { clientVersion: '.1.2', pins: 'a leading dot does not parse', skewed: true },
  { clientVersion: '', pins: 'the empty header value does not parse', skewed: true },
  { clientVersion: '2.0.0', pins: 'a different major is skew', skewed: true },
  { clientVersion: '10.0.0', pins: 'a multi-digit different major is skew', skewed: true },
] as const

// Server versions that MUST parse. `same` shares the server's major (must pass),
// `other` does not (must be rejected) — together they prove the parsed NUMBER,
// not merely that a match occurred.
const serverVersionCases = [
  { other: '2.0.0', pins: 'plain semver', same: '1.9.9', serverVersion: '1.2.3' },
  { other: '2.0.0', pins: 'leading whitespace (\\s*)', same: '1.0.0', serverVersion: '  1.2.3' },
  { other: '2.0.0', pins: 'the v prefix (v?)', same: '1.0.0', serverVersion: 'v1.2.3' },
  { other: '2.0.0', pins: 'a bare major (the $ branch)', same: '1.4.0', serverVersion: '1' },
  { other: '1.0.0', pins: 'a multi-digit major (\\d+)', same: '12.0.1', serverVersion: '12.4.0' },
  { other: '1.0.0', pins: 'a bare multi-digit major', same: '10.2.0', serverVersion: '10' },
] as const

// A server whose own version cannot be parsed has no major to compare against,
// so the gate would be silently inert. It must fail loudly at wiring time.
const unparseableVersions = ['not-a-version', 'abc', 'x1.2.3', '', 'v', '.1', 'v.1.0'] as const

describe('parseMajor', () => {
  it.each(clientVersionCases)('$pins', ({ clientVersion, skewed }) => {
    expect(isSkewed(1, clientVersion)).toBe(skewed)
  })

  it('returns the number, not merely a match', () => {
    expect(parseMajor('12.4.0')).toBe(12)
    expect(parseMajor('v0.1.0')).toBe(0)
    expect(parseMajor('nope')).toBeNull()
  })

  it('treats an unparseable client version as skew without a separate branch', () => {
    // `parseMajor` returns null and `null !== serverMajor` is already true,
    // because serverMajor is a parsed finite number by construction. A
    // dedicated null branch would be dead code no input can reach.
    expect(isSkewed(1, 'nope')).toBe(true)
    expect(isSkewed(0, 'nope')).toBe(true)
  })
})

describe('requireServerMajor', () => {
  it.each(serverVersionCases)('accepts $serverVersion — $pins', ({ serverVersion }) => {
    expect(() => requireServerMajor(serverVersion)).not.toThrow()
  })

  it.each(unparseableVersions)('throws on the unparseable server version %j', (serverVersion) => {
    expect(() => requireServerMajor(serverVersion)).toThrow(
      `cannot parse server version for skew detection: ${serverVersion}`,
    )
  })

  it('names the offending version in the error', () => {
    expect(() => requireServerMajor('nope')).toThrow(/cannot parse server version/)
    expect(() => requireServerMajor('nope')).toThrow(/nope/)
  })

  it('fails the WIRING, not a handler: createContext rejects a bad server version', async () => {
    await expect(
      createContext({
        createClient: () => forbiddenDb,
        headers: {},
        resolveSession: () => Promise.resolve(null),
        serverVersion: 'not-a-version',
      }),
    ).rejects.toThrow(/cannot parse server version/)
  })
})

describe('the skew gate on the wire', () => {
  it.each(clientVersionCases)('a client on $clientVersion — $pins', async ({
    clientVersion,
    skewed,
  }) => {
    const caller = await callerFor(clientVersion)
    if (skewed) {
      await expect(caller.system.health()).rejects.toMatchObject({ code: 'CONFLICT' })
    } else {
      await expect(caller.system.health()).resolves.toEqual({ ok: true, version: SERVER_VERSION })
    }
  })

  it.each(serverVersionCases)('a server on $serverVersion — $pins', async ({
    other,
    same,
    serverVersion,
  }) => {
    const matched = await callerFor(same, serverVersion)
    await expect(matched.system.health()).resolves.toMatchObject({ ok: true })

    const skewed = await callerFor(other, serverVersion)
    await expect(skewed.system.health()).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('passes a request with NO version header (curl, health tooling, smoke checks)', async () => {
    const caller = await callerFor()
    await expect(caller.system.health()).resolves.toEqual({ ok: true, version: SERVER_VERSION })
  })

  it('does NOT exempt the health procedure — a skewed client learns immediately', async () => {
    // A deliberate divergence from the inherited server, which exempted
    // /healthz. Tooling sends no header and still passes; a skewed CLIENT gets
    // the one answer it most needs.
    const caller = await callerFor('99.0.0')
    await expect(caller.system.health()).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('carries the stable machine-readable code on the rejection cause', async () => {
    const caller = await callerFor('2.0.0')
    const thrown: unknown = await caller.system.health().catch((cause: unknown) => cause)

    expect(thrown).toBeInstanceOf(TRPCError)
    if (!(thrown instanceof TRPCError)) return
    expect(thrown.code).toBe('CONFLICT')
    // The identity is on the CAUSE, not in the message: messages get reworded,
    // and a guard whose machine-readable identity depends on prose is one
    // copy-edit from silence.
    expect(isVersionSkewError(thrown.cause)).toBe(true)
    if (!isVersionSkewError(thrown.cause)) return
    expect(thrown.cause.code).toBe('version_skew')
    expect(thrown.cause.serverVersion).toBe(SERVER_VERSION)
    expect(thrown.cause.clientVersion).toBe('2.0.0')
  })
})

describe('gate coverage — no procedure can dodge the guard', () => {
  /**
   * Walks the REAL router rather than a hand-kept list. The guard sits on the
   * base of the procedure ladder, so this cannot fail by construction — which is
   * exactly why it is worth asserting: the day someone adds a rung that starts
   * from `t.procedure` instead of `publicProcedure`, this reds.
   */
  const procedurePaths = Object.keys(appRouter._def.procedures)

  it('sees the whole surface (non-vacuous: notes CRUD + health + me)', () => {
    expect(procedurePaths).toEqual(
      expect.arrayContaining([
        'notes.create',
        'notes.get',
        'notes.list',
        'notes.remove',
        'notes.update',
        'system.health',
        'system.me',
      ]),
    )
  })

  it.each(procedurePaths)('rejects a skewed client on %s before any handler', async (path) => {
    const caller = await callerFor('2.0.0')
    const [namespace, procedure] = path.split('.')
    const groups = caller as unknown as Record<
      string,
      Record<string, (input?: unknown) => Promise<unknown>>
    >
    const call = groups[namespace ?? '']?.[procedure ?? '']
    expect(call).toBeTypeOf('function')

    // Input is deliberately `undefined` — invalid for most of these procedures.
    // The gate runs BEFORE the input parser, so a CONFLICT (never a
    // BAD_REQUEST) is what proves the ordering.
    await expect(call?.(undefined)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
