import { HealthReport } from '@app/contracts'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/AppText'
import { useI18n } from '../../i18n'
import { useApi } from '../../lib/trpc/use-api'
import { type Palette, space, useThemedStyles } from '../../theme/theme'

// SOURCE: harness doctrine — degraded-network states are a first-class UI
// concern; probe cadence is slow enough to stay invisible in server logs and
// the per-probe timeout keeps a dead API from wedging the indicator
// [corpus: harness/doctrine]
const POLL_INTERVAL_MS = 10_000
const PROBE_TIMEOUT_MS = 3_000

// PORT NOTE: the desktop original exposed a window event so the command palette
// could force a probe. This host has no window event bus and no palette-driven
// probe command — the indicator owns its loop outright; a future contribution
// seam would inject a callback prop, not a global event.

// Three states, not two: rendering "unreachable — retrying" before the FIRST
// probe resolves is a lie that trains users to distrust the indicator.
type ProbeState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ok'; readonly version: string }
  | { readonly status: 'degraded' }

const statusStyles = (palette: Palette) => ({
  root: {
    alignItems: 'center' as const,
    flexDirection: 'row' as const,
    gap: space[2],
  },
  // The dot is decorative — the text beside it carries the meaning; colour is
  // the redundant channel (WCAG 1.4.1). Degraded takes the danger token,
  // connected takes success: at a glance a dead API must not be
  // indistinguishable from one still connecting.
  dot: {
    borderRadius: space[1],
    height: space[2],
    width: space[2],
  },
  dotOk: {
    backgroundColor: palette.success,
  },
  dotConnecting: {
    backgroundColor: 'transparent',
    borderColor: palette['ink-muted'],
    borderWidth: 1,
  },
  dotDegraded: {
    backgroundColor: palette.danger,
  },
})

export function ConnectionStatus() {
  const { t } = useI18n()
  const styles = useThemedStyles(statusStyles)
  const api = useApi()
  const [state, setState] = useState<ProbeState>({ status: 'connecting' })

  useEffect(() => {
    let cancelled = false
    const probe = async (): Promise<void> => {
      // Hand-rolled timeout: AbortSignal.timeout is not a guaranteed global on
      // this host's JS engine, and a dangling timer per probe would be a leak.
      const controller = new AbortController()
      const timeout = setTimeout(() => {
        controller.abort()
      }, PROBE_TIMEOUT_MS)
      try {
        // `system.health` is a publicProcedure and the ONE call in this app that
        // is not enveloped — health has no failure mode: if it can answer at
        // all, the answer is ok. So this is also the one place a raw `try/catch`
        // is the right shape rather than `callProcedure`: there is no
        // ActionOutcome to fold a rejection into, and a rejection here IS the
        // signal the indicator exists to show.
        //
        // It is likewise the one UNAUTHENTICATED call: a reachable server with
        // no session must read as connected, not degraded, or a signed-out user
        // is told their network is broken.
        // SOURCE: packages/api/src/routers/system.ts (health is public and
        // un-enveloped, and why)
        const body: unknown = await api.system.health.query(undefined, {
          signal: controller.signal,
        })
        // HealthReport pins `ok: literal(true)` — a degraded body fails the
        // parse and lands in the catch below rather than being reported as a
        // successfully-parsed failure.
        const health = HealthReport.parse(body)
        if (!cancelled) setState({ status: 'ok', version: health.version })
      } catch {
        if (!cancelled) setState({ status: 'degraded' })
      } finally {
        clearTimeout(timeout)
      }
    }
    void probe()
    const timer = setInterval(() => {
      void probe()
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [api])

  return (
    <View style={styles.root}>
      <View
        accessible={false}
        style={[
          styles.dot,
          state.status === 'ok' && styles.dotOk,
          state.status === 'connecting' && styles.dotConnecting,
          state.status === 'degraded' && styles.dotDegraded,
        ]}
      />
      {/* role=status: announced politely on change without stealing focus. The
          version rides in as an interpolation param rather than a JSX sibling: a
          locale is free to move it ("v{version} — API connected"), which a
          hardcoded suffix would forbid. testID on the Text LEAF (CI-LANE-FACTS). */}
      <AppText
        variant={state.status === 'ok' ? 'body' : 'muted'}
        role="status"
        testID="connection-status"
      >
        {state.status === 'ok'
          ? t('connection.connected', { version: state.version })
          : state.status === 'connecting'
            ? t('connection.connecting')
            : t('connection.unreachable')}
      </AppText>
    </View>
  )
}
