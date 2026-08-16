import type { EnrolmentState } from '@app/supabase/client'
import {
  enrolmentIdle,
  factorEnrolled,
  totpEnrolmentOf,
  verifyEnrolmentCode,
} from '@app/supabase/client'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../src/components/AppText'
import { Button } from '../src/components/Button'
import { Card } from '../src/components/Card'
import { EmptyState } from '../src/components/EmptyState'
import { Screen } from '../src/components/Screen'
import { Skeleton } from '../src/components/Skeleton'
import { useToast } from '../src/components/Toast'
import { EnrolCeremony } from '../src/features/security/EnrolCeremony'
import { useI18n } from '../src/i18n'
import { useSupabase } from '../src/lib/supabase/provider'
import { ROUTES } from '../src/routes'
import { type Palette, radius, space, useThemedStyles } from '../src/theme/theme'

// The security route: the enrolled second factors, with enrol and remove
// actions. CONTENT, never chrome — the factor list is a real query with all
// three canonical states (src/routes.ts declares their testIDs; the RNTL suite
// drives each one), reached through the actions palette's Go-to-Security
// command and the /security deep link.
//
// What ENFORCES the second factor is the database rail
// (supabase/migrations/20260812000000_mfa_aal2.sql) — this screen only lets a
// user opt into it, see what they opted into, and opt back out. The list is
// re-read from the server after every action rather than patched locally: a
// factor row is a security fact, and an optimistic security fact is a lie
// waiting for a network blip.

// ROUTES entry 3 IS the security entry (id 'security') — literal-typed testIDs.
const SECURITY = ROUTES[3]

interface FactorRow {
  readonly id: string
  /** `friendly_name` when the factor has one; null resolves to catalog copy at
   *  RENDER time — resolving it in the load effect would put `t` (a fresh
   *  closure every render) into the effect's dependencies, re-firing the read
   *  on every commit. */
  readonly name: string | null
}

type FactorsState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly factors: readonly FactorRow[] }

const securityStyles = (palette: Palette) => ({
  row: {
    alignItems: 'center' as const,
    backgroundColor: palette.canvas,
    borderColor: palette.edge,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row' as const,
    gap: space[2],
    justifyContent: 'space-between' as const,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
  },
  list: {
    gap: space[2],
  },
})

export default function SecurityScreen() {
  const { t } = useI18n()
  const supabase = useSupabase()
  const styles = useThemedStyles(securityStyles)
  const toast = useToast()
  const [state, setState] = useState<FactorsState>({ status: 'loading' })
  const [enrol, setEnrol] = useState<EnrolmentState>(enrolmentIdle)
  // Bumping this re-runs the read — the useListQuery shape: the effect keys on
  // INTENT (mount, reload) and every setState happens inside the resolve
  // callback, never synchronously in the effect body (the cascading-render
  // class react-hooks/set-state-in-effect reds).
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    void supabase.auth.mfa.listFactors().then(({ data, error }) => {
      // A stale resolve must not write state over a newer load's result.
      if (cancelled) return
      if (error !== null) {
        setState({ status: 'error' })
        return
      }
      setState({
        status: 'ready',
        factors: data.totp.map((factor) => ({
          id: factor.id,
          name: factor.friendly_name ?? null,
        })),
      })
    })
    return () => {
      cancelled = true
    }
  }, [supabase, reloadToken])

  /** Discard and re-run — the retry affordance and every post-action re-read. */
  const reload = (): void => {
    setState({ status: 'loading' })
    setReloadToken((token) => token + 1)
  }

  const beginEnrol = async (): Promise<void> => {
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
    if (error !== null) {
      // 'error', not the default tone: a security step failing to start is not
      // a message to scroll past.
      toast.show(t('security.enrol.failed'), 'error')
      return
    }
    setEnrol(factorEnrolled(enrolmentIdle(), totpEnrolmentOf(data)))
  }

  const verify = async (code: string): Promise<void> => {
    // The shared bracket — @app/supabase's verifyEnrolmentCode, the same call
    // the sign-up screens make; only what SUCCESS means differs per host.
    if (await verifyEnrolmentCode(supabase.auth.mfa, enrol, code, setEnrol)) {
      // Enrolled: close the ceremony and re-read the list — the new row must
      // come from the server's answer, never an optimistic local append.
      setEnrol(enrolmentIdle())
      reload()
    }
  }

  const unenroll = async (factorId: string): Promise<void> => {
    const { error } = await supabase.auth.mfa.unenroll({ factorId })
    if (error !== null) {
      toast.show(t('security.unenroll.failed'), 'error')
      return
    }
    reload()
  }

  const ceremonyOpen = enrol.step !== 'idle' && enrol.step !== 'enrolled'

  return (
    <Screen keyboard testID="security-screen">
      {ceremonyOpen ? (
        <EnrolCeremony
          state={enrol}
          onVerify={(code) => {
            void verify(code)
          }}
          secondaryLabel={t('mfa.enrol.cancel')}
          onSecondary={() => {
            setEnrol(enrolmentIdle())
          }}
        />
      ) : (
        <>
          <AppText variant="title">{t(SECURITY.titleKey)}</AppText>
          <AppText variant="muted">{t('security.body')}</AppText>
          <SecurityBody
            state={state}
            styles={styles}
            onRetry={reload}
            onEnrol={() => {
              void beginEnrol()
            }}
            onUnenroll={(id) => {
              void unenroll(id)
            }}
          />
        </>
      )}
    </Screen>
  )
}

// The three canonical states, split out so each surface stays small enough to
// read (and the screen function under the complexity bar the lint enforces).
function SecurityBody({
  state,
  styles,
  onRetry,
  onEnrol,
  onUnenroll,
}: {
  readonly state: FactorsState
  readonly styles: ReturnType<typeof securityStyles>
  readonly onRetry: () => void
  readonly onEnrol: () => void
  readonly onUnenroll: (factorId: string) => void
}) {
  const { t } = useI18n()
  if (state.status === 'loading') {
    // Skeleton, not prose: mirrors the factor rows about to paint and
    // announces itself as a progressbar (the states-sweep contract).
    return <Skeleton lines={2} testID={SECURITY.states.loading} />
  }
  if (state.status === 'error') {
    return (
      // The error testID sits on a surface CONTAINING the retry affordance —
      // the src/routes.ts contract every content screen holds.
      <Card tone="danger" testID={SECURITY.states.error}>
        <AppText variant="label" role="alert">
          {t('security.error.title')}
        </AppText>
        <Button variant="outline" label={t('common.retry')} onPress={onRetry} />
      </Card>
    )
  }
  if (state.factors.length === 0) {
    return (
      <EmptyState
        testID={SECURITY.states.empty}
        title={t('security.empty.title')}
        description={t('security.empty.description')}
        cta={{ label: t('security.enrol'), onPress: onEnrol }}
      />
    )
  }
  return (
    <View style={styles.list}>
      {state.factors.map((factor) => (
        // Styled (border/background), so Fabric never flattens it and the
        // testID survives — but NOT `accessible`: an accessible container
        // would fold the Remove button into one announcement and take it off
        // the a11y tree. The name text and the button stay separate elements.
        <View key={factor.id} style={styles.row} testID="security-factor">
          <AppText>{factor.name ?? t('security.factor.unnamed')}</AppText>
          <Button
            variant="ghost"
            label={t('security.unenroll')}
            accessibilityHint={t('security.unenroll.hint')}
            onPress={() => {
              onUnenroll(factor.id)
            }}
            testID={`security-unenroll-${factor.id}`}
          />
        </View>
      ))}
      <Button
        variant="outline"
        label={t('security.enrol')}
        onPress={onEnrol}
        testID="security-enrol"
      />
    </View>
  )
}
