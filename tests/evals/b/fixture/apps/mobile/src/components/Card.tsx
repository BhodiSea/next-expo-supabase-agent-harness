import type { ViewProps } from 'react-native'
import { View } from 'react-native'
import { elevation, type Palette, radius, space, useThemedStyles } from '../theme/theme'

// The bordered-surface primitive: ONE home for the card look (surface fill,
// edge border, md radius, base padding) so content boxes cannot drift apart
// screen by screen. `tone` drives the border's status channel — a failure box
// must never be the same box as a neutral one (the statusSurfaces doctrine);
// `elevated` lifts the card with the raised elevation level (overlays like the
// Toast use their own overlay level). ViewProps pass through, so a card can be
// an accessible element and carry a testID like any styled View.
type CardTone = 'neutral' | 'danger' | 'success'

interface CardProps extends ViewProps {
  readonly tone?: CardTone
  readonly elevated?: boolean
}

const cardStyles = (palette: Palette) => ({
  base: {
    backgroundColor: palette.surface,
    borderColor: palette.edge,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: space[2],
    padding: space[3],
  },
  danger: {
    borderColor: palette.danger,
  },
  success: {
    borderColor: palette.success,
  },
  elevated: {
    ...elevation.raised,
  },
})

export function Card({ tone = 'neutral', elevated = false, style, ...props }: CardProps) {
  const styles = useThemedStyles(cardStyles)
  return (
    <View
      {...props}
      style={[styles.base, tone !== 'neutral' && styles[tone], elevated && styles.elevated, style]}
    />
  )
}
