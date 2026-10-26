// Corner radii. Three real steps plus one pill.
//
// Three, not six: radius is the token family that most invites invention (every
// component "needs" its own), and the visible difference between 6 and 7 is nothing
// while the cost — a screen where four cards round differently — is everything.
// sm is for controls sitting inside other controls, md is the default for anything
// with a border, lg is for surfaces that float above the canvas.

/** Canonical ORDER — the generators iterate this array. */
export const RADIUS_STEPS = ['sm', 'md', 'lg', 'full'] as const
export type RadiusStep = (typeof RADIUS_STEPS)[number]

// `full` is a sentinel, not a measurement: it means "round the short axis
// completely" (pills, avatars, spinner tracks). 9999 is the value React Native
// wants; the web generator translates it to `calc(infinity * 1px)`, which is what
// CSS wants and what survives an element taller than 9999px. Encoding it as a
// number here keeps the token family one type instead of `number | 'full'`.
export const radius: Readonly<Record<RadiusStep, number>> = {
  sm: 4,
  md: 6,
  lg: 8,
  full: 9999,
}

/** The `full` sentinel, named so adapters can special-case it without a magic number. */
export const RADIUS_FULL = 9999
