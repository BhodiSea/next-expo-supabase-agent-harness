import { SEMANTIC_TOKENS, TYPE_STEPS } from '@app/design-tokens'
import { describe, expect, it } from 'vitest'
import {
  buttonVariants,
  cardVariants,
  emptyStateVariants,
  inputVariants,
  skeletonVariants,
  spinnerVariants,
  textVariants,
} from './variants'

// The variant factories are the only part of a React component that is a pure function
// of its props, so they are the only part a node runner can hold to account. Everything
// asserted here is a design RULE that would otherwise be enforced by nobody: that the
// danger state is actually red, that the accent never becomes a fill, that motion is
// gated on motion-safe.

describe('textVariants', () => {
  it('defaults to base size, default tone, normal weight', () => {
    const classes = textVariants()
    expect(classes).toContain('text-base')
    expect(classes).toContain('text-ink')
    expect(classes).toContain('font-normal')
  })

  it('covers every step of the type ramp', () => {
    for (const step of TYPE_STEPS) {
      expect(textVariants({ size: step })).toContain(`text-${step}`)
    }
  })

  it('maps every tone to its semantic token', () => {
    expect(textVariants({ tone: 'muted' })).toContain('text-ink-muted')
    expect(textVariants({ tone: 'accent' })).toContain('text-accent')
    expect(textVariants({ tone: 'danger' })).toContain('text-danger')
    expect(textVariants({ tone: 'success' })).toContain('text-success')
  })
})

describe('buttonVariants', () => {
  it('meets the minimum touch target at every size', () => {
    for (const size of ['sm', 'md'] as const) {
      expect(buttonVariants({ size })).toContain('min-h-(--size-touch-min)')
    }
  })

  // The accent is a TINT. If a variant ever gains `bg-accent`, text lands on a
  // saturated fill with no on-accent ink token to guarantee it stays readable — which
  // is precisely the combination the token set is shaped to make impossible.
  it('never fills a button with the accent', () => {
    for (const variant of ['solid', 'outline', 'ghost'] as const) {
      expect(buttonVariants({ variant })).not.toContain('bg-accent')
    }
    expect(buttonVariants({ variant: 'solid' })).toContain('border-accent')
  })

  it('gates the press animation on motion-safe and always ships a focus ring', () => {
    const classes = buttonVariants()
    expect(classes).toContain('motion-safe:scale-(--press-scale)')
    expect(classes).toContain('focus-visible:outline-accent')
  })
})

describe('inputVariants', () => {
  // WCAG SC 1.4.11 wants 3:1 for a control boundary. `edge` is tuned for dividers
  // between filled surfaces and sits under that; `ink-muted` clears 4.5.
  it('draws its resting boundary with ink-muted, not edge', () => {
    expect(inputVariants({ invalid: false })).toContain('border-ink-muted')
    expect(inputVariants({ invalid: false })).not.toContain('border-edge')
  })

  it('turns the boundary danger when invalid', () => {
    expect(inputVariants({ invalid: true })).toContain('border-danger')
  })
})

describe('cardVariants', () => {
  it('signals elevation with the shadow TOKEN, never with a lighter fill', () => {
    const raised = cardVariants({ elevated: true })
    // The token, not Tailwind's shadow-md: the native side renders the same intent
    // through a different API, and only a shared token makes the two agree.
    expect(raised).toContain('shadow-raised')
    // A brightness-based lift inverts in dark mode, where nearer is lighter but
    // further away is darker.
    expect(raised).toContain('bg-surface')
  })

  it('offers the whole padding vocabulary', () => {
    expect(cardVariants({ padding: 'none' })).toContain('p-0')
    expect(cardVariants({ padding: 'lg' })).toContain('p-6')
  })
})

describe('skeletonVariants and spinnerVariants', () => {
  it('gate both animations on motion-safe', () => {
    expect(skeletonVariants()).toContain('motion-safe:animate-pulse')
    expect(spinnerVariants()).toContain('motion-safe:animate-spin')
  })

  it('keep the spinner legible as a partial ring when the animation is off', () => {
    const classes = spinnerVariants()
    expect(classes).toContain('rounded-full')
    expect(classes).toContain('border-t-accent')
  })
})

// Closure: every class string in the design system paints with the SEMANTIC layer.
// Naming a ramp step (`bg-neutral-950`) re-introduces the light/dark branch the
// semantic tokens exist to erase — it typechecks, it renders, and it is wrong in
// exactly one theme.
describe('token discipline', () => {
  const factories = [
    textVariants,
    buttonVariants,
    cardVariants,
    inputVariants,
    skeletonVariants,
    spinnerVariants,
    emptyStateVariants,
  ]

  it('never names a raw ramp step or a hex colour', () => {
    for (const factory of factories) {
      const classes = factory()
      // A COLOR ramp step (`bg-neutral-950`) is the light/dark leak this guards —
      // NOT every utility that shares the 50–950 scale. `opacity-50`,
      // `duration-150`, `delay-100` are theme-invariant and legitimate, so
      // exclude those numeric non-color utilities from the match.
      expect(classes).not.toMatch(
        /(?<!opacity|duration|delay)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/,
      )
      expect(classes).not.toMatch(/#[0-9a-f]{3,8}/i)
    }
  })

  // The bg-/text-/border-/outline- prefixes are shared by colour utilities and
  // structural ones (text-sm, border-dashed, outline-offset-2), so the structural
  // vocabulary is enumerated and everything left over must be a semantic token. An
  // unlisted word is either a Tailwind palette colour that slipped in or a new
  // structural utility that should be named here deliberately.
  const STRUCTURAL = new Set<string>([
    ...TYPE_STEPS,
    'transparent',
    'current',
    'dashed',
    'center',
    'offset',
  ])
  const COLOR_UTILITY = /(?:^|[\s:])(?:bg|text|border|outline)-([a-z][a-z-]*)/g

  it('paints only with semantic token names', () => {
    const semantic = new Set<string>(SEMANTIC_TOKENS)
    for (const factory of factories) {
      for (const match of factory().matchAll(COLOR_UTILITY)) {
        // Strip a side modifier (border-t-accent) and any trailing dash left by a
        // numeric suffix the capture could not take (outline-offset-2).
        const name = (match[1] ?? '').replace(/^[tblrxy]-/, '').replace(/-$/, '')
        if (name === '' || STRUCTURAL.has(name)) continue
        expect(semantic.has(name), `"${name}" is not a semantic token`).toBe(true)
      }
    }
  })
})
