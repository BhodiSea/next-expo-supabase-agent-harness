import { Animated, View } from 'react-native'
import { useI18n } from '../i18n'
import { usePulse } from '../lib/motion'
import { type Palette, useThemedStyles } from '../theme/theme'
import { radius, spacing } from '../theme/tokens.gen'

// The loading primitive. A loading surface is never prose ("Loading…") — it is a
// skeleton that MIRRORS the final content's layout so arrival shifts nothing:
// callers size `lines` to the content they are about to paint. The pulse rides
// the motion seam (src/lib/motion.ts), so reduce-motion collapses it to a static
// placeholder for free. Announced as a progressbar with the catalog's loading
// copy — assistive tech hears "Loading…" even though sighted users never read it.
// SOURCE: WCAG 2.2 SC 4.1.2 Name, Role, Value — the busy region exposes role +
// name https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html
interface SkeletonProps {
  /** Placeholder line count — mirror the layout the content will occupy. */
  readonly lines?: number
  readonly testID?: string
}

const skeletonStyles = (palette: Palette) => ({
  block: {
    gap: spacing * 2,
  },
  line: {
    backgroundColor: palette.surface,
    borderColor: palette.edge,
    borderRadius: radius.sm,
    borderWidth: 1,
    height: spacing * 5,
  },
  // The last line runs short — the asymmetry is what reads as "text is coming",
  // not a decorative stripe pattern.
  lineShort: {
    width: '60%' as const,
  },
})

export function Skeleton({ lines = 3, testID }: SkeletonProps) {
  const { t } = useI18n()
  const styles = useThemedStyles(skeletonStyles)
  const opacity = usePulse()
  const pulse = { opacity }
  return (
    // eslint-disable-next-line react-native-a11y/has-accessibility-hint -- a progressbar's name ("Loading…") IS the whole message; a hint would only repeat it
    <View
      // ONE accessibility element for the whole placeholder block — the lines
      // inside are decorative and must not be reachable individually.
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('common.loading')}
      testID={testID}
      style={styles.block}
    >
      {Array.from({ length: lines }, (_, index) => (
        // Positional keys are correct here: placeholder lines have no data identity.
        <Animated.View
          key={index}
          style={[styles.line, index === lines - 1 && styles.lineShort, pulse]}
        />
      ))}
    </View>
  )
}
