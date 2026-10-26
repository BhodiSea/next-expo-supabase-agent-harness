// ---------------------------------------------------------------------------
// The I/O bracket around the enrolment machine's verify arcs — challenge, then
// verify, with every resolution folded through mfa-flow's transitions. It
// exists because FOUR host screens (web sign-up, web security, mobile sign-up,
// mobile security) would otherwise each restate the same eight lines, and a
// restated bracket is where one host forgets that a challenge is minted PER
// ATTEMPT (GoTrue challenges expire) while the other three remember.
//
// STRUCTURAL client type, deliberately: this module names the two calls it
// makes and nothing else, so the browser client and the native client both
// satisfy it without this file importing either factory — which is also what
// keeps it trivially testable with a literal fake. Metro-safe by construction
// (types plus the pure machine), so it rides the `./client` barrel beside it.
// SOURCE: https://supabase.com/docs/guides/auth/auth-mfa/totp (challenge +
// verify complete an enrolment; the code proves the app holds the secret)
// ---------------------------------------------------------------------------
import { type EnrolmentState, enrolmentCodeSubmitted, enrolmentVerified } from './mfa-flow.js'

/** The MFA slice of a supabase-js auth client this bracket needs. Method
 * signatures are the REAL client's shapes narrowed to the fields read here,
 * so `client.auth.mfa` satisfies it structurally on both surfaces. */
export interface MfaCeremonyApi {
  challenge(params: { readonly factorId: string }): Promise<{
    readonly data: { readonly id: string } | null
    readonly error: { readonly message: string } | null
  }>
  verify(params: {
    readonly factorId: string
    readonly challengeId: string
    readonly code: string
  }): Promise<{ readonly error: { readonly message: string } | null }>
}

/**
 * Drive one enrolment-verify attempt: submit the code through the machine,
 * mint a FRESH challenge, verify against it, and fold the outcome back.
 *
 * `setEnrol` receives updater functions (never bare values) so a stale closure
 * cannot overwrite a newer state — React's own re-entrancy contract. Returns
 * whether the factor verified; the HOST owns what success means (sign-up
 * proceeds into the app, the security screen re-reads its factor list).
 * A wrong-phase call returns false without touching anything — the same
 * refusal discipline as the machine it wraps.
 */
export async function verifyEnrolmentCode(
  mfa: MfaCeremonyApi,
  state: EnrolmentState,
  code: string,
  setEnrol: (update: (current: EnrolmentState) => EnrolmentState) => void,
): Promise<boolean> {
  if (state.step !== 'enrolling' && state.step !== 'error') return false
  const factorId = state.factorId
  setEnrol(() => enrolmentCodeSubmitted(state))
  const { data: challenge, error: challengeFailure } = await mfa.challenge({ factorId })
  if (challengeFailure !== null || challenge === null) {
    setEnrol((current) => enrolmentVerified(current, false))
    return false
  }
  const { error: verifyFailure } = await mfa.verify({
    factorId,
    challengeId: challenge.id,
    code,
  })
  if (verifyFailure !== null) {
    setEnrol((current) => enrolmentVerified(current, false))
    return false
  }
  setEnrol((current) => enrolmentVerified(current, true))
  return true
}
