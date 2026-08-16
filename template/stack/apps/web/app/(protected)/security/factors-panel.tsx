'use client'

import { Button, Card, EmptyState, Skeleton, Text } from '@app/design-system'
import type { EnrolmentState } from '@app/supabase/client'
import {
  enrolmentIdle,
  factorEnrolled,
  totpEnrolmentOf,
  verifyEnrolmentCode,
} from '@app/supabase/client'
import { useCallback, useEffect, useState } from 'react'
import { t } from '../../../lib/i18n'
import { getBrowserClient } from '../../../lib/supabase/client'
import { EnrolTotp } from '../../sign-up/enrol-totp'
import { meta } from './page.meta'

// The factor list and its two actions. All three canonical states are real:
// the list is a network read (loading), a fresh account has no factors (empty),
// and a dropped connection fails it (error, with retry). Each state renders
// its id FROM the meta (`data-testid={meta.states.*}`), so the declared and
// rendered ids cannot drift — the stronger of the two forms the route-manifest
// gate accepts.
//
// The enrol ceremony is the SAME component sign-up offers, driving the same
// machine — here its decline affordance is Cancel (back to the list) where
// sign-up's is Skip (on to the app), which is the only difference the two
// hosts have.

interface FactorRow {
  readonly id: string
  readonly name: string
}

type FactorsState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly factors: readonly FactorRow[] }

export function FactorsPanel(): React.ReactNode {
  const [state, setState] = useState<FactorsState>({ status: 'loading' })
  const [enrol, setEnrol] = useState<EnrolmentState>(enrolmentIdle)
  const [actionFailure, setActionFailure] = useState<string | null>(null)

  // `load` deliberately does NOT set the loading state: the initial state IS
  // loading (so the mount effect stays free of synchronous setState), and the
  // retry handler is the one caller that must flip back to it explicitly.
  const load = useCallback(async (): Promise<void> => {
    const { data, error } = await getBrowserClient().auth.mfa.listFactors()
    if (error !== null) {
      setState({ status: 'error' })
      return
    }
    setState({
      status: 'ready',
      factors: data.totp.map((factor) => ({
        id: factor.id,
        // `friendly_name` is optional at enrol time and this flow does not ask
        // for one — a name prompt before the user has even decided to enrol is
        // a form field tax. The unnamed fallback is honest and translatable.
        name: factor.friendly_name ?? t('security.factor.unnamed'),
      })),
    })
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function beginEnrol(): Promise<void> {
    setActionFailure(null)
    const { data, error } = await getBrowserClient().auth.mfa.enroll({ factorType: 'totp' })
    if (error !== null) {
      setActionFailure(t('security.enrol.failed'))
      return
    }
    setEnrol(factorEnrolled(enrolmentIdle(), totpEnrolmentOf(data)))
  }

  async function verify(code: string): Promise<void> {
    // The shared bracket — @app/supabase's verifyEnrolmentCode, the same call
    // the sign-up form makes; only what SUCCESS means differs per host.
    if (await verifyEnrolmentCode(getBrowserClient().auth.mfa, enrol, code, setEnrol)) {
      // Enrolled: close the ceremony and re-read the list — the row must come
      // from the server's answer, never from an optimistic local append.
      setEnrol(enrolmentIdle())
      void load()
    }
  }

  async function unenroll(factorId: string): Promise<void> {
    setActionFailure(null)
    const { error } = await getBrowserClient().auth.mfa.unenroll({ factorId })
    if (error !== null) {
      setActionFailure(t('security.unenroll.failed'))
      return
    }
    void load()
  }

  if (state.status === 'loading') {
    return (
      // `<output>` with aria-busy, the shape the loading segments use: the
      // skeletons are aria-hidden, so the label is the announced state.
      <output
        aria-busy="true"
        aria-label={t('security.loading')}
        data-testid={meta.states.loading}
        className="flex flex-col gap-3"
      >
        <Skeleton fullWidth height={54} rounded="lg" />
        <Skeleton fullWidth height={54} rounded="lg" />
      </output>
    )
  }

  if (state.status === 'error') {
    return (
      <Card testID={meta.states.error}>
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-danger">
            {t('security.error.title')}
          </p>
          <Button
            label={t('security.retry')}
            variant="outline"
            onPress={() => {
              setState({ status: 'loading' })
              void load()
            }}
            testID="security-retry"
          />
        </div>
      </Card>
    )
  }

  const ceremonyOpen = enrol.step !== 'idle' && enrol.step !== 'enrolled'

  return (
    <div className="flex flex-col gap-4">
      {actionFailure !== null && (
        <p role="alert" className="text-sm text-danger" data-testid="security-action-failed">
          {actionFailure}
        </p>
      )}

      {ceremonyOpen ? (
        <EnrolTotp
          state={enrol}
          onVerify={(code) => {
            void verify(code)
          }}
          secondaryLabel={t('mfa.enrol.cancel')}
          onSecondary={() => {
            setEnrol(enrolmentIdle())
          }}
        />
      ) : state.factors.length === 0 ? (
        <EmptyState
          title={t('security.empty.title')}
          description={t('security.empty.description')}
          testID={meta.states.empty}
          action={
            <Button
              label={t('security.enrol')}
              onPress={() => {
                void beginEnrol()
              }}
              testID="security-enrol"
            />
          }
        />
      ) : (
        <>
          <ul className="flex flex-col gap-3" data-testid="security-factor-list">
            {state.factors.map((factor) => (
              <li key={factor.id}>
                <Card>
                  <div className="flex items-center justify-between gap-4">
                    <Text weight="medium">{factor.name}</Text>
                    <Button
                      label={t('security.unenroll')}
                      variant="ghost"
                      size="sm"
                      onPress={() => {
                        void unenroll(factor.id)
                      }}
                      testID={`security-unenroll-${factor.id}`}
                    />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
          <Button
            label={t('security.enrol')}
            variant="outline"
            onPress={() => {
              void beginEnrol()
            }}
            testID="security-enrol"
          />
        </>
      )}
    </div>
  )
}
