// ---------------------------------------------------------------------------
// The MFA ceremony, as a PURE state machine. No I/O, no client, no import.
//
// WHY A MACHINE AND NOT TWO SCREENS. Both surfaces run the same three
// ceremonies — enrol a TOTP factor, answer a challenge, decide after a password
// sign-in whether a second factor is owed — and the inherited pattern would be
// four screens each hand-rolling its own ad-hoc phase flags. Phase flags drift:
// the web screen learns a retry arc the mobile one never gets, and the two
// surfaces stop agreeing about what "verifying" even means. This module is the
// one place the ceremony's SHAPE lives; the screens hold only the wiring
// between a transition and the `supabase.auth.mfa.*` call it brackets.
//
// WHAT IT DELIBERATELY IS NOT: enforcement. The database rail
// (supabase/migrations/20260812000000_mfa_aal2.sql) refuses aal1 reads for any
// user holding a verified factor, on every surface including one nobody wrote.
// This machine only choreographs the UI that lets a user SATISFY that rail —
// a client that skips every transition here still reads nothing it should not.
//
// TRANSITIONS ARE TOTAL, AND AN ILLEGAL ONE IS A REFUSAL, NOT A THROW. Each
// function returns the state UNCHANGED when called in a phase it does not
// serve. A throw would hand every screen a try/catch obligation for a
// programming error; returning the input keeps the machine a fold over events —
// a stray resolve from a stale promise (the classic double-submit race) simply
// cannot move the ceremony backwards. The refusal arcs are tested by identity.
//
// Metro-safe BY CONSTRUCTION (pure data over string literals), so it rides the
// `./client` barrel; the `.` barrel re-exports that barrel in full, which is
// how one declaration serves both surfaces without either barrel widening.
// ---------------------------------------------------------------------------

/**
 * GoTrue's authenticator assurance vocabulary: `aal1` is a password (or other
 * first factor) alone, `aal2` is a session that has also passed a verified
 * second factor. `null` is the honest reading of a response with no session.
 * SOURCE: https://supabase.com/docs/guides/auth/auth-mfa (AAL semantics;
 * getAuthenticatorAssuranceLevel returns currentLevel/nextLevel)
 */
export type AuthenticatorAssuranceLevel = 'aal1' | 'aal2' | null

/** What `getAuthenticatorAssuranceLevel()` answers: where the session IS and
 * the highest level it COULD reach with the factors the user holds.
 *
 * Typed `string | null` rather than the closed union above, deliberately:
 * supabase-js string-widens its AAL type (a future GoTrue level must not be a
 * compile error in every consumer), so a snapshot built from the client's own
 * response has to be assignable HERE without a cast that would silence real
 * mistakes. The decision below judges only the two levels the vocabulary
 * defines; anything else proceeds, which is the fail-open reading the
 * un-enrolled majority needs. */
export interface AalSnapshot {
  readonly currentLevel: string | null
  readonly nextLevel: string | null
}

/**
 * The post-sign-in decision, and the whole reason it is a function: the pair
 * of levels reads ambiguously in a screen (`currentLevel !== nextLevel` also
 * matches states that owe nothing), so the branch belongs in one tested place.
 *
 * `challenge` EXACTLY when the session sits at aal1 and a verified factor
 * could lift it to aal2 — the one state where the database rail would refuse
 * this session's reads. Every other pair proceeds: an unenrolled user has
 * nothing to answer (GoTrue cannot mandate enrolment — its MFA configuration
 * carries no `required` field, so enrolment is always an OFFERED step), an
 * aal2 session already answered, and a null level means no session to gate.
 */
export function decideAfterSignIn(snapshot: AalSnapshot): 'proceed' | 'challenge' {
  return snapshot.currentLevel === 'aal1' && snapshot.nextLevel === 'aal2' ? 'challenge' : 'proceed'
}

/**
 * A TOTP code is six decimal digits — the shape GoTrue issues and verifies.
 * Checked client-side for the same reason sign-in shape-checks the email: an
 * obvious typo must not cost a round trip and then read as a wrong code.
 * SOURCE: https://supabase.com/docs/guides/auth/auth-mfa/totp (six-digit codes)
 */
export const TOTP_CODE_LENGTH = 6

/** True when `code` is exactly six digits (after trimming user whitespace). */
export function isTotpCode(code: string): boolean {
  return new RegExp(`^\\d{${String(TOTP_CODE_LENGTH)}}$`).test(code.trim())
}

/**
 * What `mfa.enroll({ factorType: 'totp' })` hands back, flattened to the four
 * facts the ceremony needs. `qrCode` is the data URI the WEB surface renders
 * as an image; mobile shows `secret` as a copyable setup key instead, because
 * a device cannot scan its own screen. Both travel through the state so an
 * error arc can re-render the same factor without a second enrol call.
 */
export interface TotpEnrolment {
  readonly factorId: string
  readonly secret: string
  readonly uri: string
  readonly qrCode: string
}

/** Flatten `mfa.enroll`'s TOTP payload into the machine's factor shape — the
 * one place the response's snake_case field names are known, so four host
 * screens do not each restate the mapping. Structural parameter, no client
 * import: the machine stays pure. */
export function totpEnrolmentOf(response: {
  readonly id: string
  readonly totp: { readonly qr_code: string; readonly secret: string; readonly uri: string }
}): TotpEnrolment {
  return {
    factorId: response.id,
    secret: response.totp.secret,
    uri: response.totp.uri,
    qrCode: response.totp.qr_code,
  }
}

/**
 * The enrolment ceremony. `error` keeps the factor details: a wrong code does
 * not burn the factor, so the retry arc re-renders the SAME secret and asks
 * for a fresh code rather than enrolling a second orphaned factor.
 */
export type EnrolmentState =
  | { readonly step: 'idle' }
  | ({ readonly step: 'enrolling' } & TotpEnrolment)
  | ({ readonly step: 'verifying' } & TotpEnrolment)
  | { readonly step: 'enrolled' }
  | ({ readonly step: 'error' } & TotpEnrolment)

/** A fresh ceremony. A function rather than a shared constant so no caller can
 * ever mutate a singleton another screen is holding. */
export function enrolmentIdle(): EnrolmentState {
  return { step: 'idle' }
}

/** idle → enrolling: `mfa.enroll` succeeded and handed back the factor. */
export function factorEnrolled(state: EnrolmentState, factor: TotpEnrolment): EnrolmentState {
  return state.step === 'idle' ? { step: 'enrolling', ...factor } : state
}

/** enrolling | error → verifying: the user submitted a code (the error arc's
 * retry IS this transition — same factor, fresh code). */
export function enrolmentCodeSubmitted(state: EnrolmentState): EnrolmentState {
  if (state.step !== 'enrolling' && state.step !== 'error') return state
  const { step: _step, ...factor } = state
  return { step: 'verifying', ...factor }
}

/** verifying → enrolled | error: how `mfa.verify` resolved. */
export function enrolmentVerified(state: EnrolmentState, verified: boolean): EnrolmentState {
  if (state.step !== 'verifying') return state
  if (verified) return { step: 'enrolled' }
  const { step: _step, ...factor } = state
  return { step: 'error', ...factor }
}

/**
 * The challenge ceremony. `error` keeps only the factorId — a GoTrue challenge
 * EXPIRES, so the retry arc goes back through `challengeIssued` with a fresh
 * challengeId rather than replaying a code against a dead challenge.
 */
export type ChallengeState =
  | { readonly step: 'factors-known'; readonly factorId: string }
  | { readonly step: 'challenged'; readonly factorId: string; readonly challengeId: string }
  | { readonly step: 'verifying'; readonly factorId: string; readonly challengeId: string }
  | { readonly step: 'satisfied' }
  | { readonly step: 'error'; readonly factorId: string }

/** A fresh ceremony against one known verified factor (`mfa.listFactors`). */
export function challengeCeremony(factorId: string): ChallengeState {
  return { step: 'factors-known', factorId }
}

/** factors-known | error → challenged: `mfa.challenge` minted a challenge.
 * From `error` this IS the retry — a fresh challenge, never the dead one. */
export function challengeIssued(state: ChallengeState, challengeId: string): ChallengeState {
  if (state.step !== 'factors-known' && state.step !== 'error') return state
  return { step: 'challenged', factorId: state.factorId, challengeId }
}

/** challenged → verifying: the user submitted a code against the live challenge. */
export function challengeCodeSubmitted(state: ChallengeState): ChallengeState {
  if (state.step !== 'challenged') return state
  return { step: 'verifying', factorId: state.factorId, challengeId: state.challengeId }
}

/** Any mid-ceremony server refusal → error. Distinct from a failed VERIFY
 * (`challengeVerified(state, false)`) because it can strike before a challenge
 * exists at all — `mfa.challenge` itself refusing — and the machine would
 * otherwise strand the screen in a phase with no message to show. Terminal
 * phases refuse it: a satisfied ceremony cannot be un-satisfied by a stray
 * rejection landing late. */
export function challengeFaulted(state: ChallengeState): ChallengeState {
  if (state.step === 'satisfied' || state.step === 'error') return state
  return { step: 'error', factorId: state.factorId }
}

/** verifying → satisfied | error: how `mfa.verify` resolved. */
export function challengeVerified(state: ChallengeState, verified: boolean): ChallengeState {
  if (state.step !== 'verifying') return state
  return verified ? { step: 'satisfied' } : { step: 'error', factorId: state.factorId }
}
