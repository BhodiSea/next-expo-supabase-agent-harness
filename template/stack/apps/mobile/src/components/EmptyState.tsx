import { View } from 'react-native'
import { type Palette, useThemedStyles } from '../theme/theme'
import { spacing } from '../theme/tokens.gen'
import { AppText } from './AppText'
import { Button } from './Button'

// The reference "nothing here yet" surface: a title, a calm explanation, and an
// optional call to action — never a blank panel. Shared so every route's empty
// state reads the same, and so the states.empty testID from src/routes.ts has a
// single home to land on.
interface EmptyStateCta {
  readonly label: string
  readonly onPress: () => void
}

interface EmptyStateProps {
  readonly title: string
  readonly description: string
  /** Optional recovery/primary action rendered through the Button primitive. */
  readonly cta?: EmptyStateCta
  /** Passed through so a route keeps its states.empty testID. */
  readonly testID?: string
}

const emptyStyles = (_palette: Palette) => ({
  root: {
    gap: spacing,
    paddingVertical: spacing * 4,
  },
})

export function EmptyState({ title, description, cta, testID }: EmptyStateProps) {
  const styles = useThemedStyles(emptyStyles)
  return (
    <View testID={testID} style={styles.root}>
      <AppText variant="label">{title}</AppText>
      <AppText variant="muted">{description}</AppText>
      {cta !== undefined && <Button variant="outline" label={cta.label} onPress={cta.onPress} />}
    </View>
  )
}
