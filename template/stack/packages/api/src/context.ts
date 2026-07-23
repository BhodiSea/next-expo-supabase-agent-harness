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
  /**
   * Verify a bearer/explicit token and resolve the caller, or null for an absent
   * or invalid one — the TOKEN path.
   *
   * OPTIONAL, because there are two ways a host can supply identity and it need
   * only pick one. A host that carries the session in a header this context can
   * extract (a worker with a bearer token, a test with a literal) provides this
   * port and lets the context call it. A host that resolves identity ITSELF —
   * apps/web, which reads a cookie jar AND verifies bearer tokens with its own
   * client, so it already holds the answer — injects `session` below and omits
   * this. When NEITHER is given and a token is present, the token cannot be turned
   * into an identity and the caller is anonymous: a fail-safe (RLS still governs
   * every row), never a silent elevation.
   */
  readonly resolveSession?: (accessToken: string) => Promise<Session | null>
  /**
   * A session the HOST has already resolved and verified itself — the INJECTION
   * path, and apps/web's. A browser's credential lives in a cookie jar this
   * framework-neutral file has no way to read and must never trust unverified; the
   * host reads it, verifies with getUser() against the auth server (never
   * getSession()), and hands the result in here already proven.
   *
   * When present it WINS over token resolution, for the same reason `accessToken`
   * wins over the header: identity a host has already established outranks anything
   * this context would re-derive. `null` is a first-class value — it means the host
   * looked and found no verified caller (anonymous), DISTINCT from omitting the
   * field to defer to `resolveSession`. Injected, the token is used only to mint
   * the RLS-scoped client, never to re-resolve an identity the host already knows.
   */
  readonly session?: Session | null
  /**
   * The oldest client the server will still serve, as a full `major.minor.patch`
   * — the minimum-supported-client floor. OPTIONAL and off by default (null): most
   * deploys rely on the major-skew check alone, and set this only to force out a
   * specific old build within the current major (a shipped client bug, a security
   * fix). Unlike `serverVersion`, an unparseable value here is NOT fatal — the
   * floor is simply inert (see `isBelowMinimum`), because a broken floor must not
   * take down a deployment whose major-skew guard is still sound.
   */
  readonly minSupportedClient?: string | null
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
  /** The minimum-supported-client floor, or null when none is set. See CreateContextOptions. */
  readonly minSupportedClient: string | null
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
export function readHeader(source: HeaderSource, name: string): string | null {
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
  // Identity, in priority order:
  //   1. A session the host already resolved and verified (apps/web's path) wins —
  //      re-deriving it here would second-guess a proof the host already holds, and
  //      for a cookie caller there is no token to re-derive it FROM.
  //   2. Otherwise, if a token AND the resolveSession port are both present,
  //      resolve from the token.
  //   3. Otherwise anonymous. No token means no lookup at all (calling
  //      `resolveSession('')` would spend a round trip proving what is already
  //      known, on every unauthenticated request — the reason the health check
  //      stays cheap); and a host that injected neither identity source fails safe.
  const session =
    options.session !== undefined
      ? options.session
      : token !== null && token !== '' && options.resolveSession !== undefined
        ? await options.resolveSession(token)
        : null

  return {
    actor: session?.actor ?? null,
    clientVersion: readHeader(options.headers, CLIENT_VERSION_HEADER),
    // The client is minted with the SAME token the session was resolved from,
    // so RLS sees exactly the identity the router believes it is serving.
    db: options.createClient(token),
    emit: options.emit ?? dropEvents,
    membership: session?.membership ?? null,
    // Carried, never parsed here: an unparseable floor is inert, not fatal (unlike
    // serverVersion), so the parse lives at the point of use in `isBelowMinimum`.
    minSupportedClient: options.minSupportedClient ?? null,
    now: options.now?.() ?? new Date().toISOString(),
    requestId: newRequestId(),
    serverMajor,
    serverVersion: options.serverVersion,
  }
}
