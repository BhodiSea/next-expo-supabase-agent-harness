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
 * A full `major.minor.patch` triple, for the minimum-supported-client floor.
 * `parseMajor` decides SKEW (a different major is a contract break); this decides
 * "too old WITHIN the same major", which needs the lower components too.
 *
 * Anchored like `parseMajor`, and null for anything without all three numeric
 * components — a bare `1` or `1.2` cannot be ordered against a `1.2.3` floor, and
 * the floor is inert rather than guessing. A pre-release tail (`-rc.1`) is
 * ignored: it shares the triple of the release it precedes, which is the
 * conservative reading (an rc is treated as its release, never rejected for being
 * "below" it).
 */
export function parseSemver(version: string): readonly [number, number, number] | null {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * True when `clientVersion` is strictly below `minSupported` — the minimum-
 * supported-client floor. This is NOT skew: skew is a different major (a contract
 * break); this is an OLD build within the SAME major that the server has decided
 * to stop serving — a shipped client bug, or a security fix that must be forced
 * out faster than a major bump. Both end the same way for the client ("please
 * update"), so the guard raises the same rejection for both.
 *
 * Inert unless a floor is set AND both versions parse as full semver: a floor
 * cannot order a version it cannot read, and a malformed client is already caught
 * as skew by the major check. A null or empty `minSupported` means no floor.
 */
export function isBelowMinimum(clientVersion: string, minSupported: string | null): boolean {
  if (minSupported === null || minSupported === '') return false
  const client = parseSemver(clientVersion)
  const min = parseSemver(minSupported)
  if (client === null || min === null) return false
  const [cMajor, cMinor, cPatch] = client
  const [mMajor, mMinor, mPatch] = min
  if (cMajor !== mMajor) return cMajor < mMajor
  if (cMinor !== mMinor) return cMinor < mMinor
  return cPatch < mPatch
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
    // Generic on purpose: this cause is raised for BOTH a major mismatch and a
    // below-minimum-floor rejection, so its message names neither. The client
    // switches on `code`, not this prose.
    super('client version is not supported by the server')
    this.name = 'VersionSkewError'
    this.clientVersion = clientVersion
    this.serverVersion = serverVersion
  }
}

/** True when `cause` is a rejection minted by the skew guard. */
export function isVersionSkewError(cause: unknown): cause is VersionSkewError {
  return cause instanceof VersionSkewError
}
