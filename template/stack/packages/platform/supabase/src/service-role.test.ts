// The friction is the feature. These tests assert that the elevated factory
// CANNOT be reached casually — not that it works, which is the Edge Function's
// own problem. A regression here does not break a build; it removes the
// speed bump in front of the one credential that bypasses every policy in the
// repository.
import { describe, expect, it } from 'vitest'
import { createServiceRoleClient_BYPASSES_RLS, type ServiceRoleWarrant } from './service-role.js'

const WARRANT: ServiceRoleWarrant = {
  adr: 'docs/adr/0007-billing-webhook.md',
  reason: 'the provider calls back with a signature and no user session',
}

describe('the service-role warrant', () => {
  it('rejects a call with no ADR path', () => {
    expect(() => createServiceRoleClient_BYPASSES_RLS({ ...WARRANT, adr: '' })).toThrow(/ADR/)
  })

  it('rejects an ADR path that is not the shape the migrations gate parses', () => {
    // A free-form string would let 'TODO' or 'see slack' pass as a decision
    // record, which is exactly the drift the argument exists to prevent.
    for (const adr of ['TODO', 'docs/adr/billing.md', 'adr/0007-billing.md', '0007-billing.md']) {
      expect(() => createServiceRoleClient_BYPASSES_RLS({ ...WARRANT, adr })).toThrow(/ADR/)
    }
  })

  it('rejects a reason too short to be a justification', () => {
    for (const reason of ['', 'needed', 'because']) {
      expect(() => createServiceRoleClient_BYPASSES_RLS({ ...WARRANT, reason })).toThrow(/reason/)
    }
  })

  it('rejects whitespace padding masquerading as a reason', () => {
    expect(() =>
      createServiceRoleClient_BYPASSES_RLS({ ...WARRANT, reason: '   '.repeat(20) }),
    ).toThrow(/reason/)
  })

  it('checks the warrant BEFORE reading the key', () => {
    // Ordering matters: a bad warrant must fail identically whether or not the
    // environment happens to hold a service key, so a developer cannot discover
    // that the check is skippable by running it on a machine with no key set.
    expect(() => createServiceRoleClient_BYPASSES_RLS({ adr: 'nope', reason: 'x' })).toThrow(/ADR/)
  })
})

describe('the name is the warning', () => {
  it('cannot be called without BYPASSES_RLS appearing at the call site', () => {
    // Not a behavioural assertion — a structural one. The identifier is the
    // grep that answers "does anything elevated exist in this repo?", and a
    // rename to something innocuous would silently remove that.
    expect(createServiceRoleClient_BYPASSES_RLS.name).toBe('createServiceRoleClient_BYPASSES_RLS')
  })
})
