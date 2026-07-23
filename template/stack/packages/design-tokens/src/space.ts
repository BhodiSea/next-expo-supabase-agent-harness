// The spacing ramp and the two structural sizes every interactive surface needs.
//
// One base unit (4) multiplied by a CLOSED set of steps. The closure is the point:
// with a free `padding: 13` available, two screens built a week apart will never
// align, and no gate can tell "13 because the design says so" from "13 because it
// looked right at 2am". Every value below is `SPACE_UNIT * step`.
//
// The numbers are UNITLESS. Web renders them as rem (÷16) and native as dp — that
// divergence is applied by the generators, not encoded here, so the ramp itself
// stays framework-neutral.

/** The base unit. Everything in `space` is a whole multiple of it. */
export const SPACE_UNIT = 4

/** Canonical step ORDER — the generators iterate this array. */
export const SPACE_STEPS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16] as const
export type SpaceStep = (typeof SPACE_STEPS)[number]

// Written out rather than computed so the shipped values are greppable and a
// deliberate retune is a visible diff. The `space[n] === SPACE_UNIT * n` identity is
// asserted by a test, so the two representations cannot drift.
export const space: Readonly<Record<SpaceStep, number>> = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
}

/** Closed icon scale — the three sizes glyphs are allowed to be. */
export const ICON_SIZES = ['sm', 'md', 'lg'] as const
export type IconSize = (typeof ICON_SIZES)[number]

export const iconSize: Readonly<Record<IconSize, number>> = {
  sm: 16,
  md: 20,
  lg: 24,
}

/**
 * The minimum hit target, in dp/px. 44 is a FLOOR, not a target — primitives may
 * exceed it, never undercut it. Apple's HIG specifies 44pt; Android's guidance is
 * 48dp; 44 is the smaller of the two and both platforms' primitives here honour it
 * by expanding the touchable area, not by growing the visible box (a 44dp visible
 * button in a dense list would wreck the rhythm the spacing ramp exists to protect).
 * SOURCE: Apple Human Interface Guidelines — minimum 44x44pt tappable area
 * https://developer.apple.com/design/human-interface-guidelines/accessibility
 * SOURCE: Android accessibility — 48dp minimum touch target
 * https://developer.android.com/develop/ui/views/touch-and-input/accessibility
 */
export const MIN_TOUCH_TARGET = 44
