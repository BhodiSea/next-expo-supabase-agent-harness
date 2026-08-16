import { describe, expect, it } from 'vitest'
import { type MfaCeremonyApi, verifyEnrolmentCode } from './mfa-actions.js'
import { type EnrolmentState, enrolmentIdle, factorEnrolled } from './mfa-flow.js'

// The bracket over a literal fake — the structural client type is the whole
// point: these tests pass the narrowest object that satisfies it, so what is
// proven is the CHOREOGRAPHY (fresh challenge per attempt, outcomes folded
// through the machine's arcs) rather than any client's behaviour.

const FACTOR = {
  factorId: 'factor-1',
  secret: 'JBSWY3DPEHPK3PXP',
  uri: 'otpauth://totp/mock',
  qrCode: 'data:image/svg+xml;utf-8,<svg/>',
}

/** A recording fake. Failure injection per call; every request captured. */
function fakeMfa(behavior: { challengeFails?: boolean; verifyFails?: boolean }) {
  const calls: { challenges: string[]; verifies: { challengeId: string; code: string }[] } = {
    challenges: [],
    verifies: [],
  }
  const api: MfaCeremonyApi = {
    challenge: ({ factorId }) => {
      calls.challenges.push(factorId)
      return Promise.resolve(
        behavior.challengeFails === true
          ? { data: null, error: { message: 'challenge refused' } }
          : { data: { id: 'challenge-1' }, error: null },
      )
    },
    verify: ({ challengeId, code }) => {
      calls.verifies.push({ challengeId, code })
      return Promise.resolve(
        behavior.verifyFails === true ? { error: { message: 'bad code' } } : { error: null },
      )
    },
  }
  return { api, calls }
}

/** Apply recorded updaters the way React would — sequentially over the state. */
function statesDriver(initial: EnrolmentState) {
  let current = initial
  const seen: EnrolmentState[] = [initial]
  const setEnrol = (update: (state: EnrolmentState) => EnrolmentState): void => {
    current = update(current)
    seen.push(current)
  }
  return { seen, setEnrol }
}

describe('verifyEnrolmentCode', () => {
  it('walks verifying → enrolled against a freshly minted challenge', async () => {
    const { api, calls } = fakeMfa({})
    const enrolling = factorEnrolled(enrolmentIdle(), FACTOR)
    const { seen, setEnrol } = statesDriver(enrolling)

    await expect(verifyEnrolmentCode(api, enrolling, '123456', setEnrol)).resolves.toBe(true)

    expect(calls.challenges).toEqual(['factor-1'])
    expect(calls.verifies).toEqual([{ challengeId: 'challenge-1', code: '123456' }])
    expect(seen.map((state) => state.step)).toEqual(['enrolling', 'verifying', 'enrolled'])
  })

  it('a rejected code lands in error KEEPING the factor for the retry arc', async () => {
    const { api } = fakeMfa({ verifyFails: true })
    const enrolling = factorEnrolled(enrolmentIdle(), FACTOR)
    const { seen, setEnrol } = statesDriver(enrolling)

    await expect(verifyEnrolmentCode(api, enrolling, '000000', setEnrol)).resolves.toBe(false)

    expect(seen.at(-1)).toEqual({ step: 'error', ...FACTOR })
  })

  it('a refused challenge is the SAME error arc — no verify is ever attempted', async () => {
    const { api, calls } = fakeMfa({ challengeFails: true })
    const enrolling = factorEnrolled(enrolmentIdle(), FACTOR)
    const { seen, setEnrol } = statesDriver(enrolling)

    await expect(verifyEnrolmentCode(api, enrolling, '123456', setEnrol)).resolves.toBe(false)

    expect(calls.verifies).toHaveLength(0)
    expect(seen.at(-1)).toEqual({ step: 'error', ...FACTOR })
  })

  it('retries from error mint a FRESH challenge rather than replaying the dead one', async () => {
    const { api, calls } = fakeMfa({})
    const failed: EnrolmentState = { step: 'error', ...FACTOR }
    const { seen, setEnrol } = statesDriver(failed)

    await expect(verifyEnrolmentCode(api, failed, '654321', setEnrol)).resolves.toBe(true)

    expect(calls.challenges).toEqual(['factor-1'])
    expect(seen.map((state) => state.step)).toEqual(['error', 'verifying', 'enrolled'])
  })

  it('refuses a wrong-phase call without touching state or the network', async () => {
    const { api, calls } = fakeMfa({})
    const { seen, setEnrol } = statesDriver(enrolmentIdle())

    await expect(verifyEnrolmentCode(api, enrolmentIdle(), '123456', setEnrol)).resolves.toBe(false)

    expect(calls.challenges).toHaveLength(0)
    expect(seen).toHaveLength(1)
  })
})
