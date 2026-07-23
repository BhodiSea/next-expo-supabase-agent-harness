import type { TextInputProps } from 'react-native'
import { TextInput } from 'react-native'
import {
  minTouchTarget,
  type Palette,
  radius,
  space,
  typeScale,
  usePalette,
  useThemedStyles,
} from '../theme/theme'

// The one text-input primitive: tokens-only look, a11y wiring spread THROUGH
// from Field (callers own the contract, this owns the pixels).
//
// The invalid state arrives as a prop Field computes as the single source of
// truth, so the border can never disagree with what assistive tech is told
// (Field puts the error into the control's accessibilityHint and renders the
// alert line). The danger border is the redundant visual channel (WCAG 1.4.1
// Use of Color — the text + hint carry the meaning).
interface InputProps extends TextInputProps {
  readonly invalid?: boolean
}

const inputStyles = (palette: Palette) => ({
  base: {
    backgroundColor: palette.canvas,
    borderColor: palette.edge,
    borderRadius: radius.sm,
    borderWidth: 1,
    color: palette.ink,
    fontSize: typeScale.sm.fontSize,
    // The 44dp hit-target floor (minTouchTarget) — a text field is a touch
    // target too, and the padding alone left it ~36dp.
    minHeight: minTouchTarget,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    width: '100%' as const,
  },
  invalid: {
    borderColor: palette.danger,
  },
})

export function Input({ invalid = false, style, ...props }: InputProps) {
  const styles = useThemedStyles(inputStyles)
  const palette = usePalette()
  return (
    <TextInput
      placeholderTextColor={palette['ink-muted']}
      {...props}
      style={[styles.base, invalid && styles.invalid, style]}
    />
  )
}
