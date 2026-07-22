import { router, useLocalSearchParams } from 'expo-router'
import { useEffect } from 'react'
import { View } from 'react-native'
import { AppText } from '../../src/components/AppText'
import { Button } from '../../src/components/Button'
import { Screen } from '../../src/components/Screen'
import { ConnectionStatus } from '../../src/features/connection/ConnectionStatus'
import { NotesPanel } from '../../src/features/notes/NotesPanel'
import { useI18n } from '../../src/i18n'
import { stampBootTiming } from '../../src/lib/boot-timing'
import { type Palette, useThemedStyles } from '../../src/theme/theme'

const homeStyles = (_palette: Palette) => ({
  header: {
    alignItems: 'center' as const,
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
  },
})

// The home screen: the notes vertical slice. Its ROUTES entry's states
// (home-loading/-empty/-error) all live inside NotesPanel, driven by
// useListQuery over the real api-client — the route-manifest contract holds
// with three REACHABLE states now, not a placeholder's honest-empty.
//
// Header row: the screen title, the healthz connection indicator (the
// degraded-network surface), and the entry point to the actions modal.
export default function HomeScreen() {
  const { t } = useI18n()
  const styles = useThemedStyles(homeStyles)
  // The actions modal's "Create a note" deep-links here with ?focus=composer.
  const { focus } = useLocalSearchParams<{ focus?: string }>()
  useEffect(() => {
    // First screen on-screen == interactive: the one honest place to stamp
    // cold-start (stamp-once; see src/lib/boot-timing.ts).
    stampBootTiming()
  }, [])
  return (
    <Screen keyboard testID="home-screen">
      <View style={styles.header}>
        <AppText variant="title">{t('route.home')}</AppText>
        <Button
          variant="ghost"
          label={t('route.actions')}
          testID="open-actions"
          onPress={() => {
            router.push('/actions')
          }}
        />
      </View>
      <ConnectionStatus />
      <NotesPanel autoFocusComposer={focus === 'composer'} />
    </Screen>
  )
}
