import { CLIENT_VERSION_HEADER, type MembershipRole } from '@app/contracts'
import type { NotesDatabase } from '@app/notes'
import { requireServerMajor } from './skew.js'

// ---------------------------------------------------------------------------
// The per-request context.
//
// FRAMEWORK-AGNOSTIC BY CONSTRUCTION. This file takes headers, not a Next
// `Request`; it takes ports, not imports. That is the reversibility wall doing
// its job: `packages/api` must never import `next/*`, because the day this
// router is promoted to a standalone service, that promotion has to be a
// routing change rather than a rewrite.
//
// It is also why the Supabase client and the session lookup arrive as INJECTED
// FUNCTIONS. The host wires them once (the web app from cookies via
// @supabase/ssr, a worker from a bearer token, a test from a literal), and this
// package never has to know which.
//
// The one thing this file will NOT do is decode the JWT itself. A base64 JSON
// payload read without verification is attacker-controlled data wearing a
// user's name — deriving `actor.userId` from it would make every RLS policy
// downstream decorative. Verification happens in `resolveSession`, against
// Supabase, where the signing key is.
// ---------------------------------------------------------------------------

/** The verified caller. Nothing here is ever read from the wire. */
export interface Actor {
  readonly displayName: string
  readonly email: string | null
  readonly userId: string
}

/** The caller's standing in the active workspace, or the absence of one. */
export interface Membership {
  readonly role: MembershipRole
  readonly workspaceId: string
}

/**
 * `membership` is nullable on purpose: an authenticated user with no active
 * membership is a real, reachable state (invitation pending, seat revoked,
 * trial lapsed). Modelling it as impossible is how a signed-in user ends up
 * looking at a crash screen.
 */
export interface Session {
  readonly actor: Actor
  readonly membership: Membership | null
}

/**
 * A minimal, structural header reader. `Headers` satisfies it, and so does a
 * plain object — which keeps this file free of a lib-dependent global that
 * differs between the Node, Edge and test type environments.
 */
export interface HeaderReader {
  get(name: string): string | null
}

export type HeaderSource = HeaderReader | Readonly<Record<string, string | string[] | undefined>>

/**
 * A domain fact on its way to a sink. Structural and deliberately minimal, so a
 * vertical's own closed event union is assignable to it without this package
 * ever importing that union — which is what keeps the context free of any one
 * vertical's vocabulary.
 */
export interface DomainEvent {
  readonly name: string
  readonly payload: unknown
}

export type EventSink = (event: DomainEvent) => void

export interface CreateContextOptions {
  /**
   * An explicit token, for hosts that carry the session somewhere other than an
   * Authorization header (the web app reads Supabase's cookies). When present
   * it WINS over the header: a host that has already resolved the session
   * should not be second-guessed by a header a caller controls.
   */
  readonly accessToken?: string | null
  /** Mints the per-request, RLS-scoped client. Anonymous when the token is null. */
  readonly createClient: (accessToken: string | null) => NotesDatabase
  /** Where domain events go. Defaults to dropping them, so a test needs no sink. */
  readonly emit?: EventSink
  readonly headers: HeaderSource
  /**
   * The instant the request started, ISO-8601 UTC. Injected so a write path is
   * deterministic under test — and so ONE instant is shared by every write in a
   * request rather than each of them reading a slightly different clock.
   */
  readonly now?: () => string
  /** Verifies the token and resolves the caller. Returns null for an absent or invalid session. */
  readonly resolveSession: (accessToken: string) => Promise<Session | null>
  /**
   * This deployment's version. Parsed ONCE here, at wiring time: a version the
   * skew gate cannot parse makes the gate inert, and that must fail loudly.
   */
  readonly serverVersion: string
}

export interface RequestContext {
  readonly actor: Actor | null
  readonly clientVersion: string | null
  readonly db: NotesDatabase
  readonly emit: EventSink
  readonly membership: Membership | null
  readonly now: string
  readonly requestId: string
  readonly serverMajor: number
  readonly serverVersion: string
}

const AUTHORIZATION = 'authorization'
const BEARER = /^bearer\s+(.+)$/i

function isHeaderReader(source: HeaderSource): source is HeaderReader {
  // Probed through `{ get?: unknown }` rather than through HeaderReader itself:
  // the plain-record arm of the union has an index signature whose `get` is a
  // string, so a direct assertion between the two arms has no overlap and the
  // compiler (rightly) refuses it.
  return typeof (source as { get?: unknown }).get === 'function'
}

/**
 * Header lookup that behaves the same for a `Headers` instance and for Node's
 * lowercased header record. Field names are case-insensitive per RFC 9110 §5.1,
 * and a lookup that assumes otherwise silently misses on one of the two hosts.
 * SOURCE: https://www.rfc-editor.org/rfc/rfc9110#section-5.1
 */
function readHeader(source: HeaderSource, name: string): string | null {
  if (isHeaderReader(source)) return source.get(name)
  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() !== name) continue
    // A repeated header arrives as an array. Only the first value is honoured:
    // picking one deliberately beats joining them into a string no parser
    // downstream expects.
    const first = Array.isArray(value) ? value[0] : value
    return first ?? null
  }
  return null
}

function bearerToken(source: HeaderSource): string | null {
  const header = readHeader(source, AUTHORIZATION)
  if (header === null) return null
  const match = BEARER.exec(header.trim())
  return match?.[1] ?? null
}

/**
 * A request-scoped correlation id, minted SERVER-SIDE. It is never read from an
 * inbound header: an id a caller supplies can be reused to forge log
 * correlation, and the only thing that costs is the ability to trust the logs.
 *
 * `globalThis.crypto` rather than `node:crypto` — the same expression works on
 * Node 22, on the Edge runtime and in a browser, which is exactly the set of
 * places this package has to keep running.
 */
function newRequestId(): string {
  return globalThis.crypto.randomUUID()
}

const dropEvents: EventSink = () => undefined

/**
 * Build the context for one request.
 *
 * Ordering matters: the server version is validated FIRST, before any IO. A
 * deployment whose own version cannot be parsed has an inert skew guard, and
 * that must surface on the first request of the first deploy rather than as
 * corrupted data later.
 */
export async function createContext(options: CreateContextOptions): Promise<RequestContext> {
  const serverMajor = requireServerMajor(options.serverVersion)

  const token = options.accessToken ?? bearerToken(options.headers)
  // No token means no session lookup at all. Calling `resolveSession('')` would
  // spend a network round trip proving what is already known, on every
  // unauthenticated request.
  const session = token === null || token === '' ? null : await options.resolveSession(token)

  return {
    actor: session?.actor ?? null,
    clientVersion: readHeader(options.headers, CLIENT_VERSION_HEADER),
    // The client is minted with the SAME token the session was resolved from,
    // so RLS sees exactly the identity the router believes it is serving.
    db: options.createClient(token),
    emit: options.emit ?? dropEvents,
    membership: session?.membership ?? null,
    now: options.now?.() ?? new Date().toISOString(),
    requestId: newRequestId(),
    serverMajor,
    serverVersion: options.serverVersion,
  }
}
