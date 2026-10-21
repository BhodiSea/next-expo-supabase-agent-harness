'use client'

import { Button, Text } from '@app/design-system'
import type { EnrolmentState } from '@app/supabase/client'
import {
  enrolmentIdle,
  factorEnrolled,
  totpEnrolmentOf,
  verifyEnrolmentCode,
} from '@app/supabase/client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { t } from '../../lib/i18n'
import { getBrowserClient } from '../../lib/supabase/client'
import { CredentialFields } from '../sign-in/credential-fields'
import { EnrolTotp } from './enrol-totp'

// Account creation, then the OFFERED authenticator step. A CLIENT component for
// the same reason sign-in's form is: the browser client must write the session
// cookie the whole app then reads (see sign-in-form.tsx for the full trade).
//
// THE ENROL STEP IS OFFERED, NEVER MANDATED, and that is a platform fact before
// it is a product choice: GoTrue's MFA configuration carries no `required`
// field, so "no account without a factor" cannot be enforced at sign-up — a
// caller driving the API directly would mint a factorless account regardless of
// what this form refuses. What makes enrolment MEAN something is the database
// rail (supabase/migrations/20260812000000_mfa_aal2.sql): once a factor is
// verified, a password alone stops reaching the data on every surface. So this
// form offers the step where it is cheapest — the secret is fresh, the user is
// already holding their phone — and Skip is a first-class exit, not a failure.
//
// The ceremony's phases come from @app/supabase's mfa-flow machine; this file
// owns only the wiring between a transition and the supabase call it brackets,
// which is the same division the mobile sign-up screen makes — the two surfaces
// cannot drift on WHAT the ceremony is, only on how it is painted.
// SOURCE: https://supabase.com/docs/guides/auth/auth-mfa/totp (enroll →
// challenge → verify; the code confirms the app holds the secret)

export function SignUpForm(): React.ReactNode {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmSent, setConfirmSent] = useState(false)
  const [enrol, setEnrol] = useState<EnrolmentState>(enrolmentIdle)

  function finish(): void {
    // Same pair as sign-in: replace() moves the route, refresh() re-runs the
    // Server Components so the layout re-reads the session it now has.
    router.replace('/o')
    router.refresh()
  }

  async function submit(event: React.SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const client = getBrowserClient()
    const { data, error: failure } = await client.auth.signUp({ email, password })
    setBusy(false)
    if (failure !== null) {
      // ONE sentence for every failure mode, sign-in's discipline mirrored:
      // "already registered" would make this form an account-existence oracle.
      setError(t('auth.signUp.failed'))
      return
    }
    if (data.session === null) {
      // Deployed projects confirm email before minting a session (local dev
      // does not — supabase/config.toml). Without a session there is nothing to
      // enrol a factor AGAINST, so the offer moves to Security, post-confirm.
      setConfirmSent(true)
      return
    }
    const { data: factor, error: enrolFailure } = await client.auth.mfa.enroll({
      factorType: 'totp',
    })
    if (enrolFailure !== null) {
      // The OFFER could not start; the account exists and the session is live,
      // so proceeding is correct — the security page offers the step again.
      finish()
      return
    }
    setEnrol(factorEnrolled(enrolmentIdle(), totpEnrolmentOf(factor)))
  }

  async function verify(code: string): Promise<void> {
    // The shared bracket (challenge minted per attempt, outcomes folded through
    // the machine) — @app/supabase's verifyEnrolmentCode, the same call the
    // security page and both mobile hosts make.
    if (await verifyEnrolmentCode(getBrowserClient().auth.mfa, enrol, code, setEnrol)) {
      finish()
    }
  }

  if (confirmSent) {
    return (
      <div className="flex flex-col gap-4">
        <Text data-testid="sign-up-confirm-sent">{t('auth.signUp.confirmSent')}</Text>
        <Link href="/sign-in" className="text-sm text-ink underline">
          {t('auth.signUp.haveAccount')}
        </Link>
      </div>
    )
  }

  if (enrol.step !== 'idle' && enrol.step !== 'enrolled') {
    return (
      <EnrolTotp
        state={enrol}
        onVerify={(code) => {
          void verify(code)
        }}
        secondaryLabel={t('mfa.enrol.skip')}
        onSecondary={finish}
      />
    )
  }

  return (
    <form
      onSubmit={(event) => {
        void submit(event)
      }}
      className="flex flex-col gap-4"
      noValidate
    >
      {/* The shared email/password pair + PAIR-level alert (see
          credential-fields.tsx for the non-enumeration rationale). */}
      <CredentialFields
        idPrefix="sign-up"
        email={email}
        password={password}
        onEmailChange={setEmail}
        onPasswordChange={setPassword}
        error={error}
      />
      <Button label={t('auth.signUp')} type="submit" busy={busy} testID="sign-up-submit" />
      <Link href="/sign-in" className="text-sm text-ink-muted underline">
        {t('auth.signUp.haveAccount')}
      </Link>
    </form>
  )
}
