import { describe, expect, it } from 'vitest'
import {
  contrastOf,
  contrastRatio,
  inSrgbGamut,
  oklchToHex,
  oklchToLinearSrgb,
  relativeLuminance,
} from './oklch'

// These assertions exist to PIN the CSS Color 4 reference constants. Nothing else in
// the workspace would notice a coefficient being "tidied" from 4.0767416621 to
// 4.07674: every emitted hex would shift by a byte or two, the diff would look like a
// deliberate retune, and the contrast contract would still pass. The three anchors
// below (black, white, and the achromatic midpoint) fix the matrices at both ends and
// in the middle, so any edit to the math changes a number here.
describe('oklch → sRGB conversion', () => {
  it('anchors the achromatic axis at both ends and the middle', () => {
    expect(oklchToHex({ l: 0, c: 0, h: 0 })).toBe('#000000')
    expect(oklchToHex({ l: 1, c: 0, h: 0 })).toBe('#ffffff')
    // Not #808080: L=0.5 in OKLCH is perceptual middle grey, which is DARKER than the
    // arithmetic midpoint of the gamma-encoded channel. Getting #808080 here would
    // mean the transfer function had been skipped.
    expect(oklchToHex({ l: 0.5, c: 0, h: 0 })).toBe('#636363')
  })

  it('refuses to emit a color outside the sRGB gamut', () => {
    // A chroma no sRGB display can reproduce at that lightness. The browser would
    // gamut-map it; React Native would not. Failing beats either.
    expect(inSrgbGamut(oklchToLinearSrgb({ l: 0.5, c: 0.4, h: 150 }))).toBe(false)
    expect(() => oklchToHex({ l: 0.5, c: 0.4, h: 150 })).toThrow(/outside the sRGB gamut/)
  })

  it('reports the WCAG extremes exactly', () => {
    const white = relativeLuminance(oklchToLinearSrgb({ l: 1, c: 0, h: 0 }))
    const black = relativeLuminance(oklchToLinearSrgb({ l: 0, c: 0, h: 0 }))
    expect(contrastRatio(white, black)).toBeCloseTo(21, 10)
    // Symmetric by construction — the helper sorts its arguments, so a caller cannot
    // get a ratio below 1 by passing fg/bg the wrong way round.
    expect(contrastRatio(black, white)).toBe(contrastRatio(white, black))
  })

  it('contrastOf composes the same numbers as the primitives', () => {
    const fg = { l: 0.93, c: 0.004, h: 240 }
    const bg = { l: 0.16, c: 0.005, h: 240 }
    expect(contrastOf(fg, bg)).toBe(
      contrastRatio(
        relativeLuminance(oklchToLinearSrgb(fg)),
        relativeLuminance(oklchToLinearSrgb(bg)),
      ),
    )
  })
})
