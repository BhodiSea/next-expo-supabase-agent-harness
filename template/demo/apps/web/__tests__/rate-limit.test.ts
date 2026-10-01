import { describe, expect, it } from 'vitest'
import { bucketForAction, bucketForProcedure, rateLimitBuckets } from '../lib/rate-limit'

// The budget VALUES are reviewed data — tools/check-rate-limits.mjs evaluates this module
// and diffs what it returns against tools/rate-limit-budget.json, both ways. Repeating the
// numbers here would only add a second place to update.
//
// What this suite asserts is the RESOLUTION LOGIC, which no value-diff reaches: the
// strict-by-default fallback, the difference between an unknown path and a deliberate
// exemption, and the two seams staying independent.
// SOURCE: docs/adr/20260204-rate-limiting.md

describe('rateLimitBuckets', () => {
  it('declares uniquely-named buckets with positive limits and windows', () => {
    const buckets = rateLimitBuckets()
    expect(buckets.length).toBeGreaterThan(0)
    expect(new Set(buckets.map((b) => b.name)).size).toBe(buckets.length)
    for (const b of buckets) {
      expect(b.limit, `${b.name}.limit`).toBeGreaterThan(0)
      expect(b.windowSeconds, `${b.name}.windowSeconds`).toBeGreaterThan(0)
    }
  })

  it('keeps writes strictly tighter than reads', () => {
    // Not a style preference: a write costs a transaction, an audit row and a quota check,
    // and it is the direction that leaves damage behind. A budget where writes are the
    // looser bucket is a budget someone edited without reading the ADR.
    const rate = (name: string) => {
      const b = rateLimitBuckets().find((x) => x.name === name)
      if (!b) throw new Error(`no ${name} bucket`)
      return b.limit / b.windowSeconds
    }
    expect(rate('write')).toBeLessThan(rate('read'))
  })

  it('gives provisioning an hour-scale window, not a minute-scale one', () => {
    // The window is the control here. A per-minute provisioning budget lets an attacker
    // grind invitation tokens all day at 59-second intervals and never trip.
    const provisioning = rateLimitBuckets().find((b) => b.name === 'provisioning')
    expect(provisioning?.windowSeconds).toBeGreaterThanOrEqual(3600)
  })
})

describe('bucketForProcedure', () => {
  it('falls to the WRITE budget for an unmapped path — strict, not unlimited', () => {
    // A procedure added without touching the map must be limited as a write: wrong in the
    // harmless direction. Returning null here would ship an unlimited endpoint every time
    // someone forgot the map, which is the failure this default exists to prevent.
    const unknown = bucketForProcedure('billing.charge')
    expect(unknown).not.toBeNull()
    expect(unknown?.name).toBe('write')
  })

  it('distinguishes a deliberate exemption from an unknown path', () => {
    // `system.health` is exempt ON PURPOSE — a load balancer calls it to decide whether the
    // instance is alive, and limiting it turns a traffic spike into an instance pulled from
    // rotation. Collapsing "declared null" into the unknown default would silently limit it.
    expect(bucketForProcedure('system.health')).toBeNull()
    expect(bucketForProcedure('system.nonexistent')?.name).toBe('write')
  })

  it('maps reads to the read budget and mutations to the write budget', () => {
    expect(bucketForProcedure('notes.list')?.name).toBe('read')
    expect(bucketForProcedure('notes.get')?.name).toBe('read')
    expect(bucketForProcedure('notes.create')?.name).toBe('write')
    expect(bucketForProcedure('notes.remove')?.name).toBe('write')
  })

  it('resolves a path that collides with an Object.prototype key', () => {
    // The map is a plain object literal, so a bare `path in map` or `map[path]` would treat
    // 'constructor' and 'toString' as declared entries and return a function — or, worse,
    // something truthy that is not a bucket. Object.hasOwn is what makes these unknown.
    for (const evil of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(bucketForProcedure(evil)?.name, evil).toBe('write')
    }
  })
})

describe('bucketForAction', () => {
  it('limits Server Actions independently of the router', () => {
    // A Server Action is a public HTTP endpoint with a generated id — the form on the page
    // is not the only caller, merely the only one you wrote. The two seams share no code,
    // so each is limited on its own.
    expect(bucketForAction('createNoteAction')?.name).toBe('write')
    expect(bucketForAction('acceptInvitationAction')?.name).toBe('provisioning')
    expect(bucketForAction('ensurePersonalOrgAction')?.name).toBe('provisioning')
  })

  it('falls to the WRITE budget for an unmapped action', () => {
    expect(bucketForAction('someNewAction')?.name).toBe('write')
  })

  it('resolves an action name that collides with an Object.prototype key', () => {
    for (const evil of ['constructor', 'toString', '__proto__']) {
      expect(bucketForAction(evil)?.name, evil).toBe('write')
    }
  })
})
