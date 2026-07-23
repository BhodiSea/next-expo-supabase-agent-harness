import type { TextProps } from 'react-native'
import { Text } from 'react-native'
import { fontScaleCap, fontWeight, type Palette, typeScale, useThemedStyles } from '../theme/theme'

// The one text primitive. Every visible string renders through it, so the type
// scale and ink tokens live in exactly ONE place — a raw <Text> with ad-hoc
// styling is how a second, off-scale typography grows. Variants are a closed
// map, never free-form styles.
type TextVariant = 'title' | 'body' | 'muted' | 'label' | 'danger'

interface AppTextProps extends TextProps {
  readonly variant?: TextVariant
}

const textStyles = (palette: Palette) => ({
  title: {
    color: palette.ink,
    fontSize: typeScale.xl.fontSize,
    lineHeight: typeScale.xl.lineHeight,
    fontWeight: fontWeight.semibold,
  },
  body: {
    color: palette.ink,
    fontSize: typeScale.base.fontSize,
    lineHeight: typeScale.base.lineHeight,
    fontWeight: fontWeight.normal,
  },
  muted: {
    color: palette['ink-muted'],
    fontSize: typeScale.sm.fontSize,
    lineHeight: typeScale.sm.lineHeight,
    fontWeight: fontWeight.normal,
  },
  label: {
    color: palette.ink,
    fontSize: typeScale.sm.fontSize,
    lineHeight: typeScale.sm.lineHeight,
    fontWeight: fontWeight.medium,
  },
  // Status ink, not an accent: failure copy must be typographically
  // distinguishable from a hint — colour is the redundant channel next to the
  // text + role="alert" the caller supplies (WCAG 1.4.1).
  danger: {
    color: palette.danger,
    fontSize: typeScale.sm.fontSize,
    lineHeight: typeScale.sm.lineHeight,
    fontWeight: fontWeight.medium,
  },
})

export function AppText({ variant = 'body', style, ...props }: AppTextProps) {
  const styles = useThemedStyles(textStyles)
  return (
    // OS font scaling is honored up to the default cap (fontScaleCap tokens) —
    // uncapped scaling breaks fixed layouts long before it helps readability.
    // Callers with fixed-height rows pass the dense cap; the prop spread comes
    // AFTER so an explicit caller cap always wins.
    <Text
      maxFontSizeMultiplier={fontScaleCap.default}
      {...props}
      style={[styles[variant], style]}
    />
  )
}
