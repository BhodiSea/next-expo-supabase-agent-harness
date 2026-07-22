import { type Palette, useThemedStyles } from '../theme/theme'
import { radius, spacing } from '../theme/tokens.gen'
import { AppText } from './AppText'
import { Icon } from './icons/Icon'
import { PressableScale } from './PressableScale'

// The selectable-row primitive: one pressable option in a picker surface (the
// actions modal's command rows), rendered through the PressableScale base. Like
// Button, `label` is BOTH the visible text and the accessible name (a single
// source, so they can never disagree) and the role is always button; the base
// contributes the scale-plus-opacity pressed affordance, the 44dp hit target,
// and the selection haptic — picking an option is the canonical selection
// moment. The testID rides the base's Pressable — the interactive LEAF — never
// a wrapper View (design record: CI-LANE-FACTS, New Architecture caveat).
interface OptionRowProps {
  readonly label: string
  readonly onPress: () => void
  /** What pressing DOES, when the label alone does not say (announced after the name). */
  readonly accessibilityHint?: string
  readonly testID?: string
}

const optionRowStyles = (palette: Palette) => ({
  row: {
    alignItems: 'center' as const,
    backgroundColor: palette.canvas,
    borderColor: palette.edge,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row' as const,
    gap: spacing * 2,
    justifyContent: 'space-between' as const,
    paddingHorizontal: spacing * 3,
    paddingVertical: spacing * 2,
  },
})

export function OptionRow({ label, onPress, accessibilityHint, testID }: OptionRowProps) {
  const styles = useThemedStyles(optionRowStyles)
  return (
    <PressableScale
      onPress={onPress}
      haptic="selection"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      testID={testID}
      style={styles.row}
    >
      <AppText>{label}</AppText>
      {/* The trailing chevron is the "this row goes somewhere" affordance —
          decorative by Icon's construction; the label stays the whole name. */}
      <Icon name="chevronRight" size="sm" />
    </PressableScale>
  )
}
