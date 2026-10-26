import { cva } from 'class-variance-authority'

// Every class string the web design system paints with, in ONE file.
//
// Two reasons it lives here rather than inside each component. First, these are pure
// functions of their variant props, so they are the only part of a React component
// that can be unit-tested in a node runner with no DOM — and an untested design
// system is one where "the danger variant lost its colour" ships. Second, collecting
// them makes the token discipline auditable at a glance: a reviewer can see that no
// string below names a raw colour, a raw pixel size, or a Tailwind palette class that
// the token theme did not define.
//
// The vocabulary is deliberately semantic — `bg-canvas`, `text-ink`, `border-edge` —
// never `bg-neutral-950`. The ramp classes exist (the generated @theme emits them) but
// naming a ramp step in a component re-introduces the light/dark branch the semantic
// layer exists to erase.
//
// The native design system carries the SAME variant names and the SAME option names.
// It does NOT import this file: Tailwind v4 and the v3 that NativeWind requires do not
// share a class vocabulary (`outline-*`, `motion-safe:` and arbitrary-value syntax all
// differ), and every RN primitive has a different default box model. Parity is a
// contract on the API, not shared implementation.

/** Focus treatment, one string, so no control can quietly ship without one. */
const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

export const textVariants = cva('font-sans', {
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

// The accent is a TINT — a border, never a fill behind text. That is why `solid` is a
// surface with an accent edge rather than an accent background: there is deliberately
// no on-accent ink token to guarantee readable text on a saturated fill, so the design
// system cannot produce that combination at all.
export const buttonVariants = cva(
  `inline-flex items-center justify-center gap-2 rounded-md border font-medium
   transition-[transform,opacity] duration-(--duration-fast) ease-standard
   active:motion-safe:scale-(--press-scale)
   disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`,
  {
    variants: {
      variant: {
        solid: 'border-accent bg-surface text-ink',
        outline: 'border-edge bg-transparent text-ink-muted',
        ghost: 'border-transparent bg-transparent text-ink-muted',
      },
      size: {
        // min-h keeps the 44px floor without forcing a 44px-tall visible box in a
        // dense row: the padding sets the look, the minimum sets the target.
        sm: 'min-h-(--size-touch-min) px-3 py-1.5 text-sm',
        md: 'min-h-(--size-touch-min) px-4 py-2 text-base',
      },
    },
    defaultVariants: { variant: 'solid', size: 'md' },
  },
)

export const cardVariants = cva('rounded-lg border border-edge bg-surface', {
  variants: {
    padding: { none: 'p-0', sm: 'p-3', md: 'p-4', lg: 'p-6' },
    // shadow-raised is a TOKEN (the generated @theme emits --shadow-raised), not
    // Tailwind's shadow-md — the native side has to render the same intent through a
    // completely different API, and only a shared token makes the two agree.
    //
    // A shadow, not a lighter fill: a raised card that reads by brightness alone
    // inverts in dark mode, where "raised" is lighter but "further away" is darker.
    elevated: { true: 'shadow-raised', false: 'shadow-none' },
  },
  defaultVariants: { padding: 'md', elevated: false },
})

export const inputVariants = cva(
  `w-full min-h-(--size-touch-min) rounded-md border bg-canvas px-3 py-2 text-base text-ink
   placeholder:text-ink-muted disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`,
  {
    variants: {
      // ink-muted, not edge: a control boundary has to clear 3:1 against its backdrop
      // to be identifiable (WCAG SC 1.4.11), and `edge` is tuned for dividers between
      // filled surfaces, which sits well under that.
      invalid: { true: 'border-danger', false: 'border-ink-muted' },
    },
    defaultVariants: { invalid: false },
  },
)

export const skeletonVariants = cva(
  // motion-safe: a full-screen list of pulsing placeholders is exactly the
  // "background animation" reduced-motion exists to switch off. The static state is a
  // flat surface block, which still reads as "loading" because of where it sits.
  'block bg-surface motion-safe:animate-pulse',
  {
    variants: {
      rounded: { sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg', full: 'rounded-full' },
      fullWidth: { true: 'w-full', false: 'w-auto' },
    },
    defaultVariants: { rounded: 'md', fullWidth: false },
  },
)

export const spinnerVariants = cva(
  // A ring whose top quarter is the accent: under reduced motion it stops turning but
  // stays visibly a partial ring, so "busy" is still legible without the animation.
  'inline-block rounded-full border-edge border-t-accent motion-safe:animate-spin',
  {
    variants: {
      size: {
        sm: 'size-(--size-icon-sm) border-2',
        md: 'size-(--size-icon-md) border-2',
        lg: 'size-(--size-icon-lg) border-[3px]',
      },
    },
    defaultVariants: { size: 'md' },
  },
)

export const emptyStateVariants = cva(
  `flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed
   border-edge px-6 py-10 text-center`,
)
