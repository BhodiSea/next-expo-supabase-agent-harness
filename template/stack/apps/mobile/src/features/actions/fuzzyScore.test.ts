import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { rankCommands } from './fuzzyScore'

// Deterministic PBT (pure vitest): a FIXED seed and run count so a red
// reproduces byte-identically everywhere. All properties drive the ONE public
// surface (rankCommands) — the scorer itself is module-private, so the modal's
// ranking behavior is what gets locked.
// SOURCE: fast-check runner parameters (seed/numRuns)
// https://fast-check.dev/docs/configuration/user-definable-values/
const FC_PARAMS = { seed: 420, numRuns: 200 } as const

interface Cmd {
  readonly id: string
  readonly title: string
}

const cmd = (id: string, title: string): Cmd => ({ id, title })

// Independent subsequence oracle, per UTF-16 code unit over the lowercased
// strings — exactly the alphabet the scorer matches on.
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack.charAt(j) === needle.charAt(i)) i += 1
  }
  return i === needle.length
}

// Titles dense in the characters that exercise matching: repeats, spaces
// (word boundaries), case flips, and a non-ASCII letter.
const denseChar = fc.constantFrom('g', 'o', 't', 'm', 'a', ' ', 'T', 'M', 'é', 'x')
const titleArb = fc.oneof(
  fc.string({ maxLength: 16 }),
  fc.string({ unit: denseChar, maxLength: 16 }),
)
const queryArb = fc.oneof(fc.string({ maxLength: 6 }), fc.string({ unit: denseChar, maxLength: 6 }))

// Unique ids by construction — the id tie-break makes ranking a TOTAL order.
const commandsArb = fc
  .array(titleArb, { maxLength: 8 })
  .map((titles) => titles.map((title, index) => cmd(`c${String(index)}`, title)))

describe('rankCommands properties', () => {
  it('is sound and complete: a command is ranked IFF the query is a subsequence of its title', () => {
    fc.assert(
      fc.property(queryArb, commandsArb, (query, commands) => {
        const rankedIds = new Set(rankCommands(query, commands).map((entry) => entry.id))
        for (const command of commands) {
          expect(rankedIds.has(command.id)).toBe(
            isSubsequence(query.toLowerCase(), command.title.toLowerCase()),
          )
        }
      }),
      FC_PARAMS,
    )
  })

  it('ranks an exact-prefix title above a scattered mid-word match (monotonicity)', () => {
    // A = query + tail starts with a word-boundary consecutive run; B = 'z' +
    // query buries the same characters mid-word. B gets the LOWER id ('a'), so
    // only a strictly higher score can put A first — the assert cannot pass on
    // the tie-break.
    const letters = fc.string({
      unit: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'),
      minLength: 1,
      maxLength: 6,
    })
    fc.assert(
      fc.property(letters, fc.string({ maxLength: 8 }), (query, tail) => {
        const scattered = cmd('a', `z${query}`)
        const prefixed = cmd('b', query + tail)
        expect(rankCommands(query, [scattered, prefixed])[0]).toBe(prefixed)
      }),
      FC_PARAMS,
    )
  })

  it('is stable: the same inputs rank identically, in ANY input order', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: denseChar, minLength: 1, maxLength: 4 }),
        commandsArb.chain((commands) =>
          fc.tuple(
            fc.constant(commands),
            fc.shuffledSubarray(commands, {
              minLength: commands.length,
              maxLength: commands.length,
            }),
          ),
        ),
        (query, [commands, shuffled]) => {
          const ranked = rankCommands(query, commands)
          expect(rankCommands(query, commands)).toEqual(ranked)
          expect(rankCommands(query, shuffled)).toEqual(ranked)
        },
      ),
      FC_PARAMS,
    )
  })
})

// The registry's real command titles (features/actions/registry.ts resolved
// through the en catalog) — the pins the actions-modal jest suite asserts in
// the rendered tree.
const APP_COMMANDS = [
  cmd('nav.home', 'Go to Home'),
  cmd('nav.matrix', 'Go to Matrix'),
  cmd('notes.create', 'Create a note'),
  cmd('session.signOut', 'Sign out'),
] as const

const rankedIds = (query: string): readonly string[] =>
  rankCommands(query, APP_COMMANDS).map((entry) => entry.id)

describe('rankCommands pinned examples', () => {
  it("'tm' ranks Go to Matrix (two word-boundary hits) over the scattered match", () => {
    expect(rankedIds('tm')).toEqual(['nav.matrix', 'nav.home'])
  })

  it("'go' puts the word-boundary Go-titles above the mid-word 'o' matches", () => {
    expect(rankedIds('go')).toEqual(['nav.home', 'nav.matrix', 'session.signOut'])
  })

  it("'note' matches creation by word boundary", () => {
    expect(rankedIds('note')).toEqual(['notes.create'])
  })

  it('drops non-subsequence titles entirely', () => {
    expect(rankedIds('zzzz')).toEqual([])
  })

  it('returns the commands untouched for the empty query (registration order)', () => {
    expect(rankCommands('', APP_COMMANDS)).toEqual(APP_COMMANDS)
  })
})
