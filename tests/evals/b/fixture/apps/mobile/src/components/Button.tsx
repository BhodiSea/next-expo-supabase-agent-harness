import { Text } from 'react-native'
import {
  fontScaleCap,
  fontWeight,
  minTouchTarget,
  type Palette,
  radius,
  space,
  typeScale,
  useThemedStyles,
} from '../theme/theme'
import { PressableScale } from './PressableScale'

// The one button primitive, rendered through the PressableScale base — the
// accent affordance and the a11y contract live in exactly ONE place: `label` is
// BOTH the visible text and the accessible name (a single source, so they can
// never disagree), the role is always button, and the disabled state is
// mirrored into accessibilityState by the base. Variant picks from a closed
// map, never free-form styles; pressed/disabled feedback (scale + opacity) and
// the 44dp hit target come from the base.
type ButtonVariant = 'solid' | 'outline' | 'ghost'

interface ButtonProps {
  readonly label: string
  readonly onPress: () => void
  readonly variant?: ButtonVariant
  readonly disabled?: boolean
  /** What pressing DOES, when the label alone does not say (announced after the name). */
  readonly accessibilityHint?: string
  readonly testID?: string
}

const buttonStyles = (palette: Palette) => ({
  container: {
    alignSelf: 'flex-start' as const,
  },
  base: {
    alignItems: 'center' as const,
    borderRadius: radius.sm,
    minWidth: minTouchTarget,
    paddingHorizontal: space[4],
    paddingVertical: space[2],
  },
  // The accent-tinted border is the SOLE accent highlight across the control set.
  solid: {
    backgroundColor: palette.surface,
    borderColor: palette.accent,
    borderWidth: 1,
  },
  outline: {
    backgroundColor: 'transparent',
    borderColor: palette.edge,
    borderWidth: 1,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
  label: {
    color: palette.ink,
    fontSize: typeScale.sm.fontSize,
    lineHeight: typeScale.sm.lineHeight,
    fontWeight: fontWeight.medium,
  },
  labelQuiet: {
    color: palette['ink-muted'],
  },
})

export function Button({
  label,
  onPress,
  variant = 'solid',
  disabled = false,
  accessibilityHint,
  testID,
}: ButtonProps) {
  const styles = useThemedStyles(buttonStyles)
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      testID={testID}
      containerStyle={styles.container}
      style={[styles.base, styles[variant]]}
    >
      <Text
        maxFontSizeMultiplier={fontScaleCap.default}
        style={[styles.label, variant !== 'solid' && styles.labelQuiet]}
      >
        {label}
      </Text>
    </PressableScale>
  )
}
