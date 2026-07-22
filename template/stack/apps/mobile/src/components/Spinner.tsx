import { ActivityIndicator } from 'react-native'
import { useI18n } from '../i18n'
import { usePalette } from '../theme/theme'

// The inline busy primitive: for in-place waits too small for a Skeleton block
// (a button's pending state, a footer prefetch). Palette-tinted, announced as a
// progressbar with the catalog's loading copy. Size vocabulary is the platform
// pair — RN's cross-platform ActivityIndicator contract is 'small' | 'large'
// (numeric sizes are Android-only), so the primitive exposes exactly that.
// SOURCE: react-native ActivityIndicator size prop contract
// https://reactnative.dev/docs/activityindicator#size
interface SpinnerProps {
  readonly size?: 'small' | 'large'
  readonly testID?: string
}

export function Spinner({ size = 'small', testID }: SpinnerProps) {
  const { t } = useI18n()
  const palette = usePalette()
  return (
    // eslint-disable-next-line react-native-a11y/has-accessibility-hint -- a progressbar's name ("Loading…") IS the whole message; a hint would only repeat it
    <ActivityIndicator
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('common.loading')}
      color={palette['ink-muted']}
      size={size}
      testID={testID}
    />
  )
}
