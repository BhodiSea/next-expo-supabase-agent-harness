import type { ReactNode } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import { Animated, Pressable } from 'react-native'
import { type HapticKind, haptic } from '../lib/haptics'
import { usePressScale } from '../lib/motion'
import { sizes } from '../theme/tokens.gen'

// THE touchable base. Every interactive primitive (Button, OptionRow) renders
// through it, so the pressed affordance (spring scale through the motion seam +
// opacity dip), the disabled treatment, the 44dp minimum hit target
// (sizes.minTarget — Apple HIG 44pt floor), and the optional haptic all live in
// exactly ONE place. The a11y contract rides the Pressable LEAF (role, label,
// state, testID) — the Animated wrapper only carries the scale transform and
// the caller's layout (design record: CI-LANE-FACTS, leaf-testID discipline).
// SOURCE: Apple HIG — give controls a hit target of at least 44×44 pt
// https://developer.apple.com/design/human-interface-guidelines/accessibility#Buttons-and-controls
// Aliased once: two adjacent generic-typed props would end/open lines with
// >/<, which the i18n scanner's JSX-text heuristic mis-reads as copy.
type PressableStyle = StyleProp<ViewStyle>

interface PressableScaleProps {
  readonly onPress: () => void
  readonly children: ReactNode
  readonly disabled?: boolean
  /** Tactile feedback on press — 'selection' for pickers/rows; omit for plain buttons. */
  readonly haptic?: HapticKind | undefined
  /** BOTH the visible meaning and the accessible name — callers pass their label. */
  readonly accessibilityLabel: string
  readonly accessibilityHint?: string | undefined
  readonly testID?: string | undefined
  /** Layout of the scaled wrapper (alignSelf etc.) — the transform rides it. */
  readonly containerStyle?: PressableStyle
  /** The control's own look (border/background/padding) — tokens-only, from the caller's factory. */
  readonly style?: PressableStyle
}

// Theme-independent: the hit-target floor and the two state dips carry no
// palette colour, so they live outside the themed-factory cache.
const base = {
  justifyContent: 'center' as const,
  minHeight: sizes.minTarget,
}
const pressedDip = { opacity: 0.7 }
const disabledDip = { opacity: 0.5 }

export function PressableScale({
  onPress,
  children,
  disabled = false,
  haptic: hapticKind,
  accessibilityLabel,
  accessibilityHint,
  testID,
  containerStyle,
  style,
}: PressableScaleProps) {
  const { scale, pressIn, pressOut } = usePressScale()
  const scaled = { transform: [{ scale }] }
  return (
    <Animated.View style={[scaled, containerStyle]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => {
          if (hapticKind !== undefined) haptic(hapticKind)
          onPress()
        }}
        onPressIn={pressIn}
        onPressOut={pressOut}
        testID={testID}
        style={({ pressed }) => [base, style, pressed && pressedDip, disabled && disabledDip]}
      >
        {children}
      </Pressable>
    </Animated.View>
  )
}
