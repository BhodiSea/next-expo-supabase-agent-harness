import { cva } from 'class-variance-authority'

// Every class string the native design system paints with, in ONE file — the mirror of
// the web package's variants.ts, and deliberately NOT an import of it.
//
// The variant NAMES and the option names are identical on both sides (`solid` /
// `outline` / `ghost`, `sm` / `md`, `none` / `sm` / `md` / `lg`), because that parity
// is the contract a feature relies on when it moves a screen between surfaces. The
// class strings are not, and cannot be:
//
//   - Tailwind majors differ. Web is v4, mobile is v3 (NativeWind 4 requires it), and
//     the two do not share a class vocabulary — `rounded-sm` alone means 4px on one
//     and 2px on the other. The Tailwind v3 preset this package ships re-pins those
//     scales to the token values so the two majors agree again.
//   - React Native has no cascade and no pseudo-classes. `focus-visible:`,
//     `placeholder:` and `disabled:` have no meaning here; the equivalents are props
//     (`placeholderTextColor`, `accessibilityState`) or conditional classes composed
//     in the component.
//   - The box models differ. RN's flex defaults are column and `flex: 0 1 auto` is
//     not a thing, so `flex-row` has to be stated where the web gets it from `inline-flex`.
//
// Colour names are semantic (`bg-canvas`, `text-ink`) and resolve through the CSS
// variables that ThemeProvider injects with NativeWind's `vars()`. Naming a ramp step
// here would hard-code one theme into a component.

export const textVariants = cva('', {
  variants: {
    size: {
      xs: 'text-xs',
      sm: 'text-sm',
      base: 'text-base',
      lg: 'text-lg',
      xl: 'text-xl',
      '2xl': 'text-2xl',
    },
    tone: {
      default: 'text-ink',
      muted: 'text-ink-muted',
      accent: 'text-accent',
      danger: 'text-danger',
      success: 'text-success',
    },
    weight: {
      normal: 'font-normal',
      medium: 'font-medium',
      semibold: 'font-semibold',
      bold: 'font-bold',
    },
  },
  defaultVariants: { size: 'base', tone: 'default', weight: 'normal' },
})

// flex-row, because RN lays out in a column by default and a button whose label and
// spinner stack vertically is the first thing you notice porting a screen.
//
// No min-height for the 44dp target: on this platform the touchable area is expanded
// with `hitSlop` (a prop the component computes from the token), which grows the hit
// region WITHOUT growing the visible box — so a button in a dense list still looks
// right and still cannot be missed.
export const buttonVariants = cva(
  'flex-row items-center justify-center gap-2 rounded-md border px-4 py-2',
  {
    variants: {
      variant: {
        solid: 'border-accent bg-surface',
        outline: 'border-edge bg-transparent',
        ghost: 'border-transparent bg-transparent',
      },
      size: { sm: 'px-3 py-1.5', md: 'px-4 py-2' },
    },
    defaultVariants: { variant: 'solid', size: 'md' },
  },
)

/** The label colour for each button variant — RN Text cannot inherit it from the parent. */
export const buttonLabelVariants = cva('font-medium', {
  variants: {
    variant: { solid: 'text-ink', outline: 'text-ink-muted', ghost: 'text-ink-muted' },
    size: { sm: 'text-sm', md: 'text-base' },
  },
  defaultVariants: { variant: 'solid', size: 'md' },
})

export const cardVariants = cva('rounded-lg border border-edge bg-surface', {
  variants: {
    padding: { none: 'p-0', sm: 'p-3', md: 'p-4', lg: 'p-6' },
    // No shadow utility: RN shadows are two different APIs (shadow* on iOS, elevation
    // on Android) that Tailwind's single `shadow-md` cannot express, so the component
    // spreads a platform style object instead. The variant exists to keep the API
    // identical; the implementation is in Card.tsx.
    elevated: { true: '', false: '' },
  },
  defaultVariants: { padding: 'md', elevated: false },
})

export const inputVariants = cva('w-full rounded-md border bg-canvas px-3 py-2 text-base text-ink', {
  variants: {
    // ink-muted, not edge — a control boundary must clear 3:1 against its backdrop to
    // be identifiable, and `edge` is tuned for dividers between filled surfaces.
    invalid: { true: 'border-danger', false: 'border-ink-muted' },
  },
  defaultVariants: { invalid: false },
})

export const skeletonVariants = cva('bg-surface', {
  variants: {
    rounded: { sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg', full: 'rounded-full' },
    fullWidth: { true: 'w-full', false: 'w-auto' },
  },
  defaultVariants: { rounded: 'md', fullWidth: false },
})

/** Sizes the spinner's container. The indicator itself is the platform's own. */
export const spinnerVariants = cva('items-center justify-center', {
  variants: { size: { sm: 'w-4 h-4', md: 'w-5 h-5', lg: 'w-6 h-6' } },
  defaultVariants: { size: 'md' },
})

export const emptyStateVariants = cva(
  'items-center justify-center gap-2 rounded-lg border border-dashed border-edge px-6 py-10',
)
