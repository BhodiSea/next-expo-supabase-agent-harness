import { describe, expect, it } from 'vitest'
import {
  type AalSnapshot,
  type AuthenticatorAssuranceLevel,
  type ChallengeState,
  challengeCeremony,
  challengeCodeSubmitted,
  challengeFaulted,
  challengeIssued,
  challengeVerified,
  decideAfterSignIn,
  type EnrolmentState,
  enrolmentCodeSubmitted,
  enrolmentIdle,
  enrolmentVerified,
  factorEnrolled,
  isTotpCode,
  TOTP_CODE_LENGTH,
  type TotpEnrolment,
  totpEnrolmentOf,
} from './mfa-flow.js'

// Every transition, both directions: the legal arcs move, and the illegal ones
// return the INPUT STATE BY IDENTITY (`toBe`, not `toEqual`) — the machine's
// contract is that a stray event cannot move a ceremony backwards, and identity
// is the strongest observable form of "nothing happened".

const FACTOR: TotpEnrolment = {
  factorId: 'factor-1',
  secret: 'JBSWY3DPEHPK3PXP',
  uri: 'otpauth://totp/App:person@example.com?secret=JBSWY3DPEHPK3PXP',
  qrCode: 'data:image/svg+xml;utf-8,<svg/>',
}

describe('decideAfterSignIn', () => {
  // The full truth table over the 3x3 level space, not just the two poles: the
  // ambiguous pairs (null anywhere, aal2 anywhere) are exactly the ones a
  // hand-rolled `currentLevel !== nextLevel` in a screen would misjudge.
  const LEVELS: readonly AuthenticatorAssuranceLevel[] = ['aal1', 'aal2', null]

  it('challenges ONLY the aal1 session that a verified factor could lift to aal2', () => {
    for (const currentLevel of LEVELS) {
      for (const nextLevel of LEVELS) {
        const snapshot: AalSnapshot = { currentLevel, nextLevel }
        const expected = currentLevel === 'aal1' && nextLevel === 'aal2' ? 'challenge' : 'proceed'
        expect(decideAfterSignIn(snapshot)).toBe(expected)
      }
    }
  })

  it('an unenrolled user proceeds — enrolment is offered, never mandated', () => {
    // GoTrue's MFA configuration carries no `required` field, so aal1/aal1 is
    // the steady state of every user who never enrolled. Challenging them would
    // dead-end sign-in on a code they cannot have.
    expect(decideAfterSignIn({ currentLevel: 'aal1', nextLevel: 'aal1' })).toBe('proceed')
  })
})

describe('isTotpCode', () => {
  it('accepts exactly six digits, tolerating pasted whitespace', () => {
    expect(isTotpCode('123456')).toBe(true)
    expect(isTotpCode(' 123456 ')).toBe(true)
    expect(TOTP_CODE_LENGTH).toBe(6)
  })

  it('rejects short, long, and non-numeric codes', () => {
    expect(isTotpCode('12345')).toBe(false)
    expect(isTotpCode('1234567')).toBe(false)
    expect(isTotpCode('12345a')).toBe(false)
    expect(isTotpCode('')).toBe(false)
  })
})

describe('totpEnrolmentOf', () => {
  it("flattens enroll's snake_case payload into the machine's factor shape", () => {
    expect(
      totpEnrolmentOf({
        id: FACTOR.factorId,
        totp: { qr_code: FACTOR.qrCode, secret: FACTOR.secret, uri: FACTOR.uri },
      }),
    ).toEqual(FACTOR)
  })
})

describe('enrolment ceremony', () => {
  it('walks the happy path: idle → enrolling → verifying → enrolled', () => {
    const idle = enrolmentIdle()
    expect(idle).toEqual({ step: 'idle' })

    const enrolling = factorEnrolled(idle, FACTOR)
    expect(enrolling).toEqual({ step: 'enrolling', ...FACTOR })

    const verifying = enrolmentCodeSubmitted(enrolling)
    expect(verifying).toEqual({ step: 'verifying', ...FACTOR })

    expect(enrolmentVerified(verifying, true)).toEqual({ step: 'enrolled' })
  })

  it('a failed verify lands in error KEEPING the factor, and retry re-verifies the same factor', () => {
    const verifying = enrolmentCodeSubmitted(factorEnrolled(enrolmentIdle(), FACTOR))
    const failed = enrolmentVerified(verifying, false)
    // The factor survives the failure — a wrong code must re-render the SAME
    // secret, never enrol a second orphaned factor.
    expect(failed).toEqual({ step: 'error', ...FACTOR })

    // The retry arc: error → verifying is the same submission transition.
    expect(enrolmentCodeSubmitted(failed)).toEqual({ step: 'verifying', ...FACTOR })
  })

  it('refuses every out-of-phase transition by returning the input state itself', () => {
    const idle = enrolmentIdle()
    const enrolling = factorEnrolled(idle, FACTOR)
    const verifying = enrolmentCodeSubmitted(enrolling)
    const enrolled = enrolmentVerified(verifying, true)

    // A second enroll resolve cannot restart a ceremony already past idle.
    expect(factorEnrolled(enrolling, FACTOR)).toBe(enrolling)
    expect(factorEnrolled(verifying, FACTOR)).toBe(verifying)
    expect(factorEnrolled(enrolled, FACTOR)).toBe(enrolled)
    // A double submit cannot re-enter verifying from verifying or from rest.
    expect(enrolmentCodeSubmitted(idle)).toBe(idle)
    expect(enrolmentCodeSubmitted(verifying)).toBe(verifying)
    expect(enrolmentCodeSubmitted(enrolled)).toBe(enrolled)
    // A stale verify resolve cannot land outside verifying.
    expect(enrolmentVerified(idle, true)).toBe(idle)
    expect(enrolmentVerified(enrolling, false)).toBe(enrolling)
    expect(enrolmentVerified(enrolled, false)).toBe(enrolled)
  })

  it('the error state also refuses a fresh factor — retry means the SAME factor', () => {
    const failed: EnrolmentState = enrolmentVerified(
      enrolmentCodeSubmitted(factorEnrolled(enrolmentIdle(), FACTOR)),
      false,
    )
    expect(factorEnrolled(failed, { ...FACTOR, factorId: 'factor-2' })).toBe(failed)
  })
})

describe('challenge ceremony', () => {
  it('walks the happy path: factors-known → challenged → verifying → satisfied', () => {
    const known = challengeCeremony('factor-1')
    expect(known).toEqual({ step: 'factors-known', factorId: 'factor-1' })

    const challenged = challengeIssued(known, 'challenge-1')
    expect(challenged).toEqual({
      step: 'challenged',
      factorId: 'factor-1',
      challengeId: 'challenge-1',
    })

    const verifying = challengeCodeSubmitted(challenged)
    expect(verifying).toEqual({
      step: 'verifying',
      factorId: 'factor-1',
      challengeId: 'challenge-1',
    })

    expect(challengeVerified(verifying, true)).toEqual({ step: 'satisfied' })
  })

  it('a failed verify keeps the factor, and retry issues a FRESH challenge', () => {
    const verifying = challengeCodeSubmitted(
      challengeIssued(challengeCeremony('factor-1'), 'challenge-1'),
    )
    const failed = challengeVerified(verifying, false)
    expect(failed).toEqual({ step: 'error', factorId: 'factor-1' })

    // The dead challengeId is deliberately GONE from the error state: GoTrue
    // challenges expire, so the retry arc must mint a new one.
    const retried = challengeIssued(failed, 'challenge-2')
    expect(retried).toEqual({
      step: 'challenged',
      factorId: 'factor-1',
      challengeId: 'challenge-2',
    })
  })

  it('a fault before any challenge exists still reaches error — and terminal phases refuse it', () => {
    const known = challengeCeremony('factor-1')
    // `mfa.challenge` itself refused: without this arc the screen would sit in
    // factors-known holding a rejection it has no phase to show.
    expect(challengeFaulted(known)).toEqual({ step: 'error', factorId: 'factor-1' })

    const challenged = challengeIssued(known, 'challenge-1')
    expect(challengeFaulted(challenged)).toEqual({ step: 'error', factorId: 'factor-1' })

    const satisfied = challengeVerified(challengeCodeSubmitted(challenged), true)
    // A stray rejection landing after success cannot un-satisfy the ceremony.
    expect(challengeFaulted(satisfied)).toBe(satisfied)
    const failed = challengeFaulted(known)
    expect(challengeFaulted(failed)).toBe(failed)
  })

  it('refuses every out-of-phase transition by returning the input state itself', () => {
    const known = challengeCeremony('factor-1')
    const challenged = challengeIssued(known, 'challenge-1')
    const verifying = challengeCodeSubmitted(challenged)
    const satisfied: ChallengeState = challengeVerified(verifying, true)

    // A second challenge resolve cannot replace a live challenge.
    expect(challengeIssued(challenged, 'challenge-2')).toBe(challenged)
    expect(challengeIssued(verifying, 'challenge-2')).toBe(verifying)
    expect(challengeIssued(satisfied, 'challenge-2')).toBe(satisfied)
    // A submit outside a live challenge moves nothing.
    expect(challengeCodeSubmitted(known)).toBe(known)
    expect(challengeCodeSubmitted(verifying)).toBe(verifying)
    expect(challengeCodeSubmitted(satisfied)).toBe(satisfied)
    // A stale verify resolve cannot land outside verifying.
    expect(challengeVerified(known, true)).toBe(known)
    expect(challengeVerified(challenged, false)).toBe(challenged)
    expect(challengeVerified(satisfied, false)).toBe(satisfied)
  })
})
