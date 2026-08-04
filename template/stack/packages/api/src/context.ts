import { CLIENT_VERSION_HEADER, ORG_ID_HEADER, type OrgSummary } from '@app/contracts'
import type { NotesDatabase } from '@app/notes'
import type { RateLimitPort } from './ratelimit.js'
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

/**
 * The verified caller plus EVERY seat they actually hold, resolved by the host
 * from public.memberships on this request.
 *
 * A LIST, not a single membership, and that is the whole shape of the change
 * from the pre-org model. The old `Membership | null` said a user is in one
 * workspace or none — which was only ever true because the field was a hardcode
 * (`{ role: 'owner', workspaceId: user.userId }`) and no membership table
 * existed. With a real table the common case is several seats, and a type that
 * can hold one forces the org choice to happen somewhere upstream and arrive
 * here already collapsed — which is exactly where an org the caller does not
 * belong to gets to slip in unchecked.
 *
 * Empty is a first-class value: mid-invitation, or last seat revoked. Modelling
 * it as impossible is how a signed-in user ends up looking at a crash screen.
 *
 * Resolved PER REQUEST rather than read from a token claim, so revocation takes
 * effect on the next request instead of at the next token refresh. That is the
 * same argument the RLS policies make by keying on the table rather than on
 * auth.jwt(), applied one layer up so both layers agree.
 */
export interface Session {
  readonly actor: Actor
  readonly orgs: readonly OrgSummary[]
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
   * The rate-limit port, or omitted when this deployment does not limit.
   *
   * OPTIONAL AND NULL-BY-DEFAULT on purpose. A worker, a test and a CLI caller have no
   * budget to spend and no Redis to spend it against, and a context that demanded one
   * would make every one of them wire an infrastructure concern to call a procedure.
   * The web host wires it; everything else gets an unlimited router, which is the
   * correct default for a caller the deployment already trusts.
   */
  // SOURCE: docs/adr/20260204-rate-limiting.md (the port is injected; the router never picks a limiter)
  readonly rateLimit?: RateLimitPort
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
  /**
   * The org this request acts in, or null. ALWAYS an element of `orgs` — it is
   * produced by looking the `x-org-id` header up in that list, so there is no
   * reachable state in which a handler holds an active org the caller is not a
   * member of. That invariant is the reason this field is resolved here rather
   * than by each host.
   */
  readonly activeOrg: OrgSummary | null
  readonly actor: Actor | null
  readonly clientVersion: string | null
  readonly db: NotesDatabase
  readonly emit: EventSink
  /** Every seat the caller holds right now. Empty for a seatless authenticated user. */
  readonly orgs: readonly OrgSummary[]
  /** The minimum-supported-client floor, or null when none is set. See CreateContextOptions. */
  readonly minSupportedClient: string | null
  readonly now: string
  /** The rate-limit port the host wired, or null for an unlimited router. */
  // SOURCE: docs/adr/20260204-rate-limiting.md
  readonly rateLimit: RateLimitPort | null
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
 * Resolve the acting org from the `x-org-id` header against the caller's REAL
 * seats. The only function in this package that reads a caller-supplied value
 * and turns it into an authorization-adjacent fact, so every branch is spelled
 * out rather than folded into a `??` chain.
 *
 *   header names a held seat   -> that org
 *   header names anything else -> null   (unknown id, malformed, another
 *                                         tenant's org, empty string)
 *   header absent, ONE seat    -> that org
 *   header absent, 0 or 2+     -> null
 *
 * Three of those deserve their reasons on the record.
 *
 * A MISS IS NULL, NEVER A FALLBACK. It is tempting to fall back to the caller's
 * only org when the header does not match — it would make a stale bookmark
 * "just work". It is precisely wrong: a request that explicitly said "act in
 * org B" would then execute against org A, and the caller would be told it
 * succeeded. Whatever the client meant, it did not mean that. Null is the
 * honest answer and the rung above turns it into a good error.
 *
 * A MISS IS NOT AN ERROR EITHER. Raising would make the header a probe: an
 * attacker distinguishes "org exists but is not yours" from "no such org" by
 * the shape of the failure, which is the same existence disclosure the RLS
 * suites exist to prevent one layer down. Unknown and not-yours are
 * indistinguishable here by construction, because both are simply absent from
 * `orgs`.
 *
 * ABSENT + EXACTLY ONE is a convenience with no judgement in it — there is one
 * possible answer and it is a seat the caller holds. ABSENT + SEVERAL is null
 * because picking "the first" would make the acting tenant a function of array
 * order, and a write landing in whichever org happened to sort first is a data
 * corruption nobody would think to look for.
 */
export function resolveActiveOrg(
  orgs: readonly OrgSummary[],
  header: string | null,
): OrgSummary | null {
  const requested = header?.trim().toLowerCase() ?? ''
  if (requested === '') return orgs.length === 1 ? (orgs[0] ?? null) : null
  return orgs.find((o) => o.id.toLowerCase() === requested) ?? null
}

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

  const orgs = session?.orgs ?? []
  return {
    activeOrg: resolveActiveOrg(orgs, readHeader(options.headers, ORG_ID_HEADER)),
    actor: session?.actor ?? null,
    clientVersion: readHeader(options.headers, CLIENT_VERSION_HEADER),
    // The client is minted with the SAME token the session was resolved from,
    // so RLS sees exactly the identity the router believes it is serving.
    db: options.createClient(token),
    emit: options.emit ?? dropEvents,
    orgs,
    // Carried, never parsed here: an unparseable floor is inert, not fatal (unlike
    // serverVersion), so the parse lives at the point of use in `isBelowMinimum`.
    minSupportedClient: options.minSupportedClient ?? null,
    now: options.now?.() ?? new Date().toISOString(),
    // SOURCE: docs/adr/20260204-rate-limiting.md (absent port = unlimited, for workers and tests)
    rateLimit: options.rateLimit ?? null,
    requestId: newRequestId(),
    serverMajor,
    serverVersion: options.serverVersion,
  }
}
