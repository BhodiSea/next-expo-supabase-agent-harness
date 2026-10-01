import type { OrgSummary } from '@app/contracts'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../src/components/AppText'
import { Button } from '../../src/components/Button'
import { Card } from '../../src/components/Card'
import { EmptyState } from '../../src/components/EmptyState'
import { Screen } from '../../src/components/Screen'
import { Skeleton } from '../../src/components/Skeleton'
import { ConnectionStatus } from '../../src/features/connection/ConnectionStatus'
import { useI18n } from '../../src/i18n'
import { translateError, type UserFacingError } from '../../src/i18n/errors'
import { stampBootTiming } from '../../src/lib/boot-timing'
import { callProcedure } from '../../src/lib/trpc/normalize'
import { useApi } from '../../src/lib/trpc/use-api'
import { ROUTES } from '../../src/routes'
import { type Palette, radius, space, useThemedStyles } from '../../src/theme/theme'

// The home screen: who you are signed in as, and the organizations you hold a
// seat in. Its ROUTES entry's states (home-loading/-empty/-error) are all REAL —
// `system.me` is a query over the tRPC client, so it can be in flight, it can
// fail, and a signed-in user mid-invitation genuinely holds no seat. The states
// sweep drives each one through the fake API.
//
// It is the default scaffold's one content screen, and deliberately a small one:
// the first screen a project builds usually takes its place. The notes panel
// `init --with-demo` plants here is the worked example of a vertical's screen,
// with a list query, a write and an optimistic row.
//
// Header row: the screen title, the liveness connection indicator (the
// degraded-network surface), and the entry point to the actions modal.

const [HOME] = ROUTES

type OrgsState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: UserFacingError }
  | { readonly status: 'empty' }
  | { readonly status: 'ready'; readonly orgs: readonly OrgSummary[] }

const homeStyles = (palette: Palette) => ({
  header: {
    alignItems: 'center' as const,
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
  },
  list: {
    gap: space[2],
  },
  row: {
    backgroundColor: palette.canvas,
    borderColor: palette.edge,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
  },
})

/** The caller's seats, read once per mount and on every retry. */
function useOrgs(): { readonly state: OrgsState; readonly reload: () => void } {
  const api = useApi()
  const [state, setState] = useState<OrgsState>({ status: 'loading' })
  // Bumping this re-runs the read — the effect keys on INTENT (mount, reload) and
  // every setState happens inside the resolve callback, never synchronously in the
  // effect body (the cascading-render class react-hooks/set-state-in-effect reds).
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    void callProcedure(api.system.me.query()).then((outcome) => {
      // A stale resolve must not write state over a newer load's result.
      if (cancelled) return
      if (!outcome.ok) {
        setState({ status: 'error', error: translateError(outcome.error) })
        return
      }
      const { orgs } = outcome.data
      setState(orgs.length === 0 ? { status: 'empty' } : { status: 'ready', orgs })
    })
    return () => {
      cancelled = true
    }
  }, [api, reloadToken])

  const reload = (): void => {
    setState({ status: 'loading' })
    setReloadToken((token) => token + 1)
  }
  return { state, reload }
}

function OrgsPanel() {
  const { t } = useI18n()
  const styles = useThemedStyles(homeStyles)
  const { state, reload } = useOrgs()
  if (state.status === 'loading') {
    // Skeleton, not prose: it announces itself as a progressbar, and the state
    // testID rides its accessible container.
    return <Skeleton testID={HOME.states.loading} />
  }
  if (state.status === 'error') {
    return (
      // The error testID sits on a surface that CONTAINS the retry button
      // (src/routes.ts contract).
      <Card tone="danger" testID={HOME.states.error}>
        <AppText variant="label">{t('home.error.title')}</AppText>
        <AppText role="alert">{state.error.message}</AppText>
        {state.error.detail !== null && state.error.detail !== '' && (
          <AppText variant="muted">
            {state.error.detail}
            {state.error.code !== null && ` — ${t('error.reference', { id: state.error.code })}`}
          </AppText>
        )}
        <Button variant="outline" label={t('common.retry')} onPress={reload} />
      </Card>
    )
  }
  if (state.status === 'empty') {
    return (
      <EmptyState
        title={t('home.empty.title')}
        description={t('home.empty.description')}
        testID={HOME.states.empty}
      />
    )
  }
  return (
    <View style={styles.list}>
      <AppText variant="muted">{t('home.orgs.summary', { count: state.orgs.length })}</AppText>
      {state.orgs.map((org) => (
        <View key={org.id} style={styles.row} testID="home-org">
          <AppText>{org.name}</AppText>
        </View>
      ))}
    </View>
  )
}

export default function HomeScreen() {
  const { t } = useI18n()
  const styles = useThemedStyles(homeStyles)
  useEffect(() => {
    // First screen on-screen == interactive: the one honest place to stamp
    // cold-start (stamp-once; see src/lib/boot-timing.ts).
    stampBootTiming()
  }, [])
  return (
    <Screen testID="home-screen">
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
      <OrgsPanel />
    </Screen>
  )
}
