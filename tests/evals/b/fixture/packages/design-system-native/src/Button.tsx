import { minTouchTarget, motion, space, typeScale } from '@app/design-tokens/native'
import { Pressable, type ViewStyle } from 'react-native'
import { cn } from './cn'
import { Spinner } from './Spinner'
import { Text } from './Text'
import { useReduceMotion } from './useReduceMotion'
import { buttonLabelVariants, buttonVariants } from './variants'

export type ButtonVariant = 'solid' | 'outline' | 'ghost'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps {
  /** BOTH the visible text and the accessible name — one string, so they cannot disagree. */
  readonly label: string
  readonly onPress?: () => void
  readonly variant?: ButtonVariant
  readonly size?: ButtonSize
  readonly disabled?: boolean
  /** In-flight: the control stays focusable and announces busy, rather than vanishing. */
  readonly busy?: boolean
  /** What pressing DOES, when the label alone does not say it. Announced after the name. */
  readonly accessibilityHint?: string
  readonly className?: string
  readonly testID?: string
}

// hitSlop, not a minimum height. The 44dp floor is about where a finger LANDS, not
// about how tall the button looks, and growing the visible box to 44 in a dense row
// wrecks the spacing rhythm the ramp exists to protect. hitSlop expands the touch
// region outward without touching layout, so the shortest button in a list is still
// impossible to miss.
//
// Derived, not measured: the shortest this component can render is the `sm` size —
// space[3] of vertical padding split top and bottom around a `text-sm` line box — and
// the slop is half the shortfall on each side, floored at zero so a future retune that
// makes the button taller than the target cannot produce a negative hitSlop.
const SMALLEST_HEIGHT = typeScale.sm.lineHeight + space[3]
const HIT_SLOP = Math.max(0, Math.round((minTouchTarget - SMALLEST_HEIGHT) / 2))

export function Button({
  label,
  onPress,
  variant,
  size,
  disabled = false,
  busy = false,
  accessibilityHint,
  className,
  testID,
}: ButtonProps) {
  const reduceMotion = useReduceMotion()
  // Transform only, and only when the OS has not asked for less motion. A scale is the
  // one press affordance that costs no layout pass and can be dropped entirely without
  // changing where anything sits.
  const pressedStyle = ({ pressed }: { pressed: boolean }): ViewStyle =>
    pressed && !reduceMotion ? { transform: [{ scale: motion.pressScale }] } : {}

  const inactive = disabled || busy
  return (
    <Pressable
      onPress={onPress}
      // Disabled while busy too: the request is already in flight, so a second press is
      // a duplicate mutation, not impatience the UI should honour.
      disabled={inactive}
      hitSlop={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy }}
      testID={testID}
      style={pressedStyle}
      className={cn(buttonVariants({ variant, size }), inactive && 'opacity-50', className)}
    >
      {/* Additive, never a replacement for the label: swapping the text for a spinner
          collapses the button's width under the finger that is still on it and destroys
          the accessible name at the exact moment someone is waiting to hear it. */}
      {busy ? <Spinner size="sm" label={label} /> : null}
      <Text className={cn(buttonLabelVariants({ variant, size }))}>{label}</Text>
    </Pressable>
  )
}
