import { TransportErrorCode } from '@app/contracts'

// ---------------------------------------------------------------------------
// Version-skew doctrine.
//
// Installed mobile fleets update SLOWLY — store review, staged rollouts, and
// users who simply never update. So at any moment the server is talking to
// several client builds at once, and the dangerous ones are not the old builds
// that fail loudly: they are the old builds that keep working while quietly
// meaning something different by the same field.
//
// A hard rejection with a stable machine-readable code beats silent contract
// drift. The client can then say "please update" once, instead of writing
// half-migrated data for a week.
// SOURCE: version-skew doctrine [corpus: harness/doctrine]
//
// Ported from the inherited HTTP-middleware version of this guard. Two things
// changed with the transport, and both are deliberate:
//
//   - There is no route table to walk any more. A tRPC router is mounted at ONE
//     path, so the guard rides the BASE of the procedure ladder instead of a
//     path prefix, and every procedure inherits it by construction rather than
//     by a test that walks routes hoping none were missed.
//   - The inherited server exempted /healthz. This one does not exempt the
//     health procedure: health TOOLING sends no version header and passes
//     regardless, while a skewed CLIENT hitting health learns immediately that
//     it is skewed, which is the one thing it most needs to know.
// ---------------------------------------------------------------------------

/**
 * The stable code a rejected client switches on. It is a contract constant, not
 * a string literal spelled here — the client side reads the same one.
 */
export const VERSION_SKEW_CODE = TransportErrorCode.enum.version_skew

/**
 * Leading whitespace, an optional `v`, then the major digits, then either a dot
 * or the end of the string. Anchored at the start so `x1.2.3` cannot pass by
 * matching in the middle.
 */
export function parseMajor(version: string): number | null {
  const match = /^\s*v?(\d+)(?:\.|$)/.exec(version)
  const major = match?.[1]
  return major === undefined ? null : Number(major)
}

/**
 * Thrown at wiring time — not per request — when the SERVER's own version
 * cannot be parsed. A server with no comparable major has nothing to compare
 * against, so the guard would be silently inert: every client would pass, and
 * the failure would only surface as corrupted data months later. Fail loudly
 * where a deploy can see it.
 */
export function requireServerMajor(serverVersion: string): number {
  const major = parseMajor(serverVersion)
  if (major === null) {
    throw new Error(`cannot parse server version for skew detection: ${serverVersion}`)
  }
  return major
}

/**
 * The verdict. A client version that does not parse is skew, not a pass:
 * `parseMajor` returns null, and `null !== serverMajor` is already true because
 * `serverMajor` is a parsed finite number by construction (see above). A
 * separate `clientMajor === null` branch would be dead code no input can reach
 * — and dead branches in a security-adjacent guard are how a guard rots.
 */
export function isSkewed(serverMajor: number, clientVersion: string): boolean {
  return parseMajor(clientVersion) !== serverMajor
}

/**
 * The marker carried on the rejection's `cause`. A class, not a string match on
 * the message: messages are for humans and get reworded, and a guard whose
 * machine-readable identity depends on prose is one copy-edit from silence.
 */
export class VersionSkewError extends Error {
  readonly code: string = VERSION_SKEW_CODE
  readonly clientVersion: string
  readonly serverVersion: string

  constructor(serverVersion: string, clientVersion: string) {
    super('client major version does not match the server')
    this.name = 'VersionSkewError'
    this.clientVersion = clientVersion
    this.serverVersion = serverVersion
  }
}

/** True when `cause` is a rejection minted by the skew guard. */
export function isVersionSkewError(cause: unknown): cause is VersionSkewError {
  return cause instanceof VersionSkewError
}
