import type { RadiusStep } from '@app/design-tokens'
import { View } from 'react-native'
import { cn } from './cn'
import { useReduceMotion } from './useReduceMotion'
import { skeletonVariants } from './variants'

export interface SkeletonProps {
  /** Explicit width in dp. Omit and pass `fullWidth` to fill the container instead. */
  readonly width?: number
  readonly height?: number
  readonly fullWidth?: boolean
  readonly rounded?: RadiusStep
  readonly className?: string
  readonly testID?: string
}

// Hidden from the accessibility tree, always — the twin of the web's aria-hidden. A skeleton
// is a picture of content that does not exist yet; exposing it announces a screenful of empty
// boxes. The loading state is announced ONCE, by the Spinner that sits with it, never by the
// placeholders.
//
// TWO props to say one thing, because the platforms disagree on the spelling:
// accessibilityElementsHidden is the iOS switch and importantForAccessibility with
// "no-hide-descendants" is the Android one. Shipping either alone leaves the placeholders
// audible on half the devices, and that half is the half nobody tests on.
// SOURCE: React Native — accessibilityElementsHidden is iOS-only and
// importantForAccessibility is Android-only
// https://reactnative.dev/docs/accessibility#accessibilityelementshidden-ios
//
// THE PULSE IS A CONDITIONAL CLASS, not part of skeletonVariants, and that is the whole
// reason the native variant string is one utility shorter than the web's. The web writes
// `motion-safe:animate-pulse` and the browser evaluates the media query for it — the class
// simply stops applying. There are no media queries here, so the gate is a runtime value
// (useReduceMotion, the package's one door onto that OS setting) and the class has to be
// composed in the component: a variant factory is a pure function of its props and cannot
// read a hook. Composing state-dependent classes in the component rather than in the variant
// is the same move the package already makes for `disabled:` and `focus-visible:`.
//
// Under reduced motion what is left is a flat surface block, which still reads as "loading"
// because of WHERE it sits — the setting is obeyed without the component disappearing, which
// is the line between respecting the preference and breaking the screen for the people who
// set it.
// SOURCE: WCAG 2.2 SC 2.3.3 Animation from Interactions — motion that is not essential must
// be disableable [corpus: wcag/reduced-motion]
// https://www.w3.org/TR/WCAG22/#animation-from-interactions
//
// Width and height are inline styles rather than utility classes because they are caller
// DATA, not design decisions: a skeleton matches the shape of the content it stands in for,
// and that shape is measured at the call site. Everything the design system does own here —
// the surface colour, the radius, the pulse — comes from tokens. The numbers are dp rather
// than px, which is the same arithmetic in a different unit; the token ramp is deliberately
// unitless so this is the only place the distinction has to be said out loud.
export function Skeleton({ width, height, fullWidth, rounded, className, testID }: SkeletonProps) {
  const reduceMotion = useReduceMotion()

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
      style={{ width, height }}
      className={cn(
        skeletonVariants({ rounded, fullWidth }),
        !reduceMotion && 'animate-pulse',
        className,
      )}
    />
  )
}
