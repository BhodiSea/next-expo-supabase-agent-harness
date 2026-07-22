// Recents suite (pure vitest). recents.ts reaches storage only through
// src/lib/kv.ts, whose native backend is mocked at the module boundary — same
// convention as src/lib/kv.test.ts: what is under test is the corrupt-safe
// DISCIPLINE (validate, dedupe, re-cap, never throw), not expo-sqlite.
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The storage key is module-private; tests address it by the same literal so a
// drive-by rename (which would strand every user's persisted recents) fails here.
const STORAGE_KEY = 'actions.recents'

const { backing } = vi.hoisted(() => ({ backing: new Map<string, string>() }))

vi.mock('expo-sqlite/kv-store', () => ({
  default: {
    getItemSync: (key: string): string | null => backing.get(key) ?? null,
    setItemSync: (key: string, value: string): void => {
      backing.set(key, value)
    },
    removeItemSync: (key: string): void => {
      backing.delete(key)
    },
  },
}))

import { pushRecent, readRecents } from './recents'

beforeEach(() => {
  backing.clear()
})

describe('readRecents', () => {
  it('reads empty storage as no recents', () => {
    expect(readRecents()).toEqual([])
  })

  it('round-trips what pushRecent persisted', () => {
    pushRecent('a')
    pushRecent('b')
    expect(readRecents()).toEqual(['b', 'a'])
  })

  it('resets on corrupt JSON instead of throwing', () => {
    backing.set(STORAGE_KEY, '{definitely not json')
    expect(readRecents()).toEqual([])
  })

  it('resets on a non-array payload', () => {
    backing.set(STORAGE_KEY, '{"sneaky":"object"}')
    expect(readRecents()).toEqual([])
  })

  it('filters non-string entries and dedupes repeats', () => {
    backing.set(STORAGE_KEY, JSON.stringify([1, 'a', null, 'b', 'a', { x: 1 }]))
    expect(readRecents()).toEqual(['a', 'b'])
  })

  it('re-caps an overlong historical payload at five', () => {
    backing.set(STORAGE_KEY, JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g']))
    expect(readRecents()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('pushRecent', () => {
  it('returns the new list AND persists it', () => {
    expect(pushRecent('a')).toEqual(['a'])
    expect(JSON.parse(backing.get(STORAGE_KEY) ?? 'null')).toEqual(['a'])
  })

  it('floats a re-run id to the front without duplicating it', () => {
    pushRecent('a')
    pushRecent('b')
    pushRecent('c')
    expect(pushRecent('a')).toEqual(['a', 'c', 'b'])
  })

  it('caps at five, dropping the oldest', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) pushRecent(id)
    expect(readRecents()).toEqual(['f', 'e', 'd', 'c', 'b'])
  })

  it('recovers from a corrupt payload: the push replaces it wholesale', () => {
    backing.set(STORAGE_KEY, 'not even close')
    expect(pushRecent('a')).toEqual(['a'])
    expect(readRecents()).toEqual(['a'])
  })
})
