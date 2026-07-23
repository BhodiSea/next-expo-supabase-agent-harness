import { describe, expect, it } from 'vitest'
import {
  CONTRAST_CONTRACT,
  RAMP_FAMILIES,
  RAMP_STEPS,
  ramps,
  SEMANTIC_TOKENS,
  THEME_NAMES,
  themes,
} from './color'
import { ramps as nativeRamps, palettes } from './generated/native'
import { contrastOf, inSrgbGamut, oklchToHex, oklchToLinearSrgb } from './oklch'
import { SPACE_STEPS, SPACE_UNIT, space } from './space'
import { TYPE_STEPS, typeScale } from './typography'

describe('the color source', () => {
  it('keeps every ramp value inside the sRGB gamut', () => {
    for (const family of RAMP_FAMILIES) {
      for (const step of RAMP_STEPS) {
        const color = ramps[family][step]
        expect(
          inSrgbGamut(oklchToLinearSrgb(color)),
          `${family}.${step} is outside sRGB — it would be gamut-mapped on screen and every contrast number computed for it would describe a color nobody sees`,
        ).toBe(true)
      }
    }
  })

  // The semantic layer is an INDEX into the ramps, never a bespoke value. An orphan
  // color is one nobody can re-derive when the ramp is retuned, and it is exactly how
  // a palette starts growing a second, undocumented blue.
  it('resolves every semantic token to an actual ramp step', () => {
    const rampValues = new Set(
      RAMP_FAMILIES.flatMap((family) =>
        RAMP_STEPS.map((step) => JSON.stringify(ramps[family][step])),
      ),
    )
    for (const theme of THEME_NAMES) {
      for (const token of SEMANTIC_TOKENS) {
        expect(rampValues.has(JSON.stringify(themes[theme][token])), `${theme}.${token}`).toBe(true)
      }
    }
  })

  it('meets the declared contrast contract in BOTH themes', () => {
    for (const theme of THEME_NAMES) {
      for (const pair of CONTRAST_CONTRACT) {
        const ratio = contrastOf(themes[theme][pair.fg], themes[theme][pair.bg])
        expect(ratio, `${theme}: ${pair.fg} on ${pair.bg}`).toBeGreaterThanOrEqual(pair.min)
      }
    }
  })

  // Closure, both directions: a token that carries text but has no declared pair is a
  // readability claim nobody checked. `edge` is the one deliberate omission — it is a
  // divider between filled surfaces, never a text or control boundary.
  it('declares a contrast pair for every ink-bearing token against both backdrops', () => {
    const covered = new Set(CONTRAST_CONTRACT.map((pair) => `${pair.fg}/${pair.bg}`))
    const backdrops = ['canvas', 'surface'] as const
    const inkBearing = SEMANTIC_TOKENS.filter(
      (token) => !backdrops.some((backdrop) => backdrop === token) && token !== 'edge',
    )
    for (const token of inkBearing) {
      for (const backdrop of backdrops) {
        expect(covered.has(`${token}/${backdrop}`), `${token}/${backdrop}`).toBe(true)
      }
    }
  })
})

describe('the numeric ramps', () => {
  it('keeps every spacing step a whole multiple of the base unit', () => {
    for (const step of SPACE_STEPS) {
      expect(space[step]).toBe(SPACE_UNIT * step)
    }
  })

  // Leading below the size is not a design choice, it is a rendering bug that only
  // shows up on the third line of a wrapped paragraph.
  it('never sets a line height under its own font size', () => {
    for (const step of TYPE_STEPS) {
      expect(typeScale[step].lineHeight).toBeGreaterThan(typeScale[step].fontSize)
    }
  })

  it('orders the type ramp monotonically', () => {
    const sizes = TYPE_STEPS.map((step) => typeScale[step].fontSize)
    expect(sizes).toStrictEqual([...sizes].sort((a, b) => a - b))
  })
})

// The committed native adapter is the file mobile actually paints from. Regenerating
// it is one command; NOT regenerating it after a retune is the silent failure, and it
// looks exactly like a working app with last month's colors.
describe('the generated native adapter', () => {
  it('matches the OKLCH source, converted', () => {
    for (const family of RAMP_FAMILIES) {
      for (const step of RAMP_STEPS) {
        expect(nativeRamps[family][step]).toBe(oklchToHex(ramps[family][step]))
      }
    }
    for (const theme of THEME_NAMES) {
      for (const token of SEMANTIC_TOKENS) {
        expect(palettes[theme][token]).toBe(oklchToHex(themes[theme][token]))
      }
    }
  })

  it('carries exactly the canonical token set in every theme', () => {
    for (const theme of THEME_NAMES) {
      expect(Object.keys(palettes[theme]).sort()).toStrictEqual([...SEMANTIC_TOKENS].sort())
    }
  })
})
