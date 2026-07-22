// kv seam suite (pure vitest; the sqlite kv-store native module is mocked at
// the module boundary — what is under test is the corrupt-safe DISCIPLINE, not
// expo-sqlite). The mock's throwing branch simulates the exact failure mode the
// seam exists to absorb: a native layer that is absent (jest), locked, or
// corrupt must read as "no value", never crash boot.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { backing } = vi.hoisted(() => ({ backing: new Map<string, string>() }))
const THROWING_KEY = 'throws'

vi.mock('expo-sqlite/kv-store', () => ({
  default: {
    getItemSync: (key: string): string | null => {
      if (key === THROWING_KEY) throw new Error('native store unavailable')
      return backing.get(key) ?? null
    },
    setItemSync: (key: string, value: string): void => {
      if (key === THROWING_KEY) throw new Error('native store unavailable')
      backing.set(key, value)
    },
    removeItemSync: (key: string): void => {
      if (key === THROWING_KEY) throw new Error('native store unavailable')
      backing.delete(key)
    },
  },
}))

import { kvDelete, kvGet, kvSet } from './kv'

beforeEach(() => {
  backing.clear()
})

describe('kv', () => {
  it('round-trips a value', () => {
    kvSet('theme', 'dark')
    expect(kvGet('theme')).toBe('dark')
  })

  it('a missing key reads as null, not undefined and not a throw', () => {
    expect(kvGet('never-written')).toBeNull()
  })

  it('delete makes a key read as absent', () => {
    kvSet('locale', 'en')
    kvDelete('locale')
    expect(kvGet('locale')).toBeNull()
  })

  it('an unavailable native store reads as absent on get — never a boot crash', () => {
    expect(kvGet(THROWING_KEY)).toBeNull()
  })

  it('an unavailable native store swallows set/delete — the in-memory stores stay live', () => {
    expect(() => {
      kvSet(THROWING_KEY, 'value')
    }).not.toThrow()
    expect(() => {
      kvDelete(THROWING_KEY)
    }).not.toThrow()
  })
})
