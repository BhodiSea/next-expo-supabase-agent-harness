import { EMAIL_MAX } from '@app/contracts'
import type { EnrolmentState } from '@app/supabase/client'
import {
  enrolmentIdle,
  factorEnrolled,
  totpEnrolmentOf,
  verifyEnrolmentCode,
} from '@app/supabase/client'
import { router } from 'expo-router'
import { useState } from 'react'
import { AppText } from '../src/components/AppText'
import { Button } from '../src/components/Button'
import { Field } from '../src/components/Field'
import { Input } from '../src/components/Input'
import { Screen } from '../src/components/Screen'
import { EnrolCeremony } from '../src/features/security/EnrolCeremony'
import { useI18n } from '../src/i18n'
import { useSupabase } from '../src/lib/supabase/provider'

// Account creation over Supabase Auth, then the OFFERED authenticator step.
// Chrome, not content: no entry in src/routes.ts (same reasoning as sign-in —
// a credential ceremony has no canonical data states, and it must stay
// reachable to the signed-out user the manifest's contract presumes away).
//
// THE ENROL STEP IS OFFERED, NEVER MANDATED, and that is a platform fact
// before it is a product choice: GoTrue's MFA configuration carries no
// `required` field, so "no account without a factor" cannot be enforced at
// sign-up — a caller driving the API directly would mint a factorless account
// regardless of what this screen refuses. What makes enrolment MEAN something
// is the database rail (supabase/migrations/20260812000000_mfa_aal2.sql):
// once a factor is verified, a password alone stops reaching the data on
// every surface. So the step is offered where it is cheapest — the secret is
// fresh, the user is already holding the device — and Skip is a first-class
// exit, not a failure. The security screen re-offers it forever after.
//
// The ceremony's phases come from @app/supabase's mfa-flow machine, the same
// transitions the web sign-up form walks — the two surfaces cannot drift on
// WHAT the ceremony is, only on how it is painted.
// SOURCE: https://supabase.com/docs/guides/auth/auth-mfa/totp (enroll →
// challenge → verify; the code confirms the app holds the secret)

/** Sign-in's deliberately loose shape check, for the same stated reasons. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/

export default function SignUpScreen() {
  const { t } = useI18n()
  const supabase = useSupabase()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState<string | undefined>(undefined)
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [confirmSent, setConfirmSent] = useState(false)
  const [enrol, setEnrol] = useState<EnrolmentState>(enrolmentIdle)

  const signUp = async (): Promise<void> => {
    const trimmedEmail = email.trim()
    // Both fields validated in one pass — sign-in's discipline: a user with
    // two typos must not submit twice to learn about the second one.
    const badEmail = trimmedEmail.length > EMAIL_MAX || !EMAIL_SHAPE.test(trimmedEmail)
    const badPassword = password === ''
    setEmailError(badEmail ? t('signin.email.invalid') : undefined)
    setPasswordError(badPassword ? t('signin.password.invalid') : undefined)
    if (badEmail || badPassword) return

    setFailure(null)
    setPending(true)
    const { data, error } = await supabase.auth.signUp({ email: trimmedEmail, password })
    setPending(false)
    if (error !== null) {
      // ONE sentence for every failure mode: "already registered" would make
      // this screen an account-existence oracle (signin.failed's reasoning).
      setFailure(t('signup.failed'))
      return
    }
    if (data.session === null) {
      // Deployed projects confirm email before minting a session; without a
      // session there is nothing to enrol a factor AGAINST, so the offer moves
      // to the security screen, post-confirmation.
      setConfirmSent(true)
      return
    }
    const { data: factor, error: enrolFailure } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
    })
    if (enrolFailure !== null) {
      // The OFFER could not start; the account exists and the session is live,
      // so proceeding is correct — the security screen offers the step again.
      router.replace('/')
      return
    }
    setEnrol(factorEnrolled(enrolmentIdle(), totpEnrolmentOf(factor)))
  }

  const verify = async (code: string): Promise<void> => {
    // The shared bracket (challenge minted per attempt, outcomes folded through
    // the machine) — @app/supabase's verifyEnrolmentCode, the same call the
    // security screen and both web hosts make.
    if (await verifyEnrolmentCode(supabase.auth.mfa, enrol, code, setEnrol)) {
      // The session already carries aal2 (verify lifted it), so Home's first
      // query passes the database rail without a second sign-in.
      router.replace('/')
    }
  }

  const ceremonyOpen = enrol.step !== 'idle' && enrol.step !== 'enrolled'

  // Three phases, one early-return each — a nested ternary here would read as
  // JSX text to the i18n literal scan, and reads no better to a human.
  if (confirmSent) {
    return (
      <Screen keyboard testID="sign-up-screen">
        <AppText variant="title">{t('signup.title')}</AppText>
        <AppText testID="sign-up-confirm-sent">{t('signup.confirmSent')}</AppText>
        <Button
          label={t('signup.haveAccount')}
          onPress={() => {
            router.replace('/sign-in')
          }}
          testID="sign-up-to-sign-in"
        />
      </Screen>
    )
  }

  if (ceremonyOpen) {
    return (
      <Screen keyboard testID="sign-up-screen">
        <EnrolCeremony
          state={enrol}
          onVerify={(code) => {
            void verify(code)
          }}
          secondaryLabel={t('mfa.enrol.skip')}
          onSecondary={() => {
            // Skipping is the first-class exit — see the header.
            router.replace('/')
          }}
        />
      </Screen>
    )
  }

  return (
    <Screen keyboard testID="sign-up-screen">
      <AppText variant="title">{t('signup.title')}</AppText>
      <AppText variant="muted">{t('signup.body')}</AppText>
      <Field label={t('signin.email.label')} error={emailError}>
        {(control) => (
          <Input
            value={email}
            onChangeText={setEmail}
            placeholder={t('signin.email.placeholder')}
            keyboardType="email-address"
            textContentType="username"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={control.accessibilityLabel}
            accessibilityHint={control.accessibilityHint}
            invalid={control.invalid}
            testID="sign-up-email"
          />
        )}
      </Field>
      <Field label={t('signin.password.label')} error={passwordError}>
        {(control) => (
          <Input
            value={password}
            onChangeText={setPassword}
            placeholder={t('signin.password.placeholder')}
            // new-password, not current-password: it tells the platform
            // password manager to OFFER a generated strong password here
            // instead of filling the old one.
            secureTextEntry
            textContentType="newPassword"
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={control.accessibilityLabel}
            accessibilityHint={control.accessibilityHint}
            invalid={control.invalid}
            testID="sign-up-password"
          />
        )}
      </Field>
      {failure !== null && (
        <AppText variant="danger" role="alert" testID="sign-up-failure">
          {failure}
        </AppText>
      )}
      <Button
        label={pending ? t('signup.pending') : t('signup.submit')}
        disabled={pending}
        onPress={() => {
          void signUp()
        }}
        testID="sign-up-submit"
      />
      <Button
        label={t('signup.haveAccount')}
        variant="ghost"
        onPress={() => {
          router.replace('/sign-in')
        }}
        testID="sign-up-to-sign-in"
      />
    </Screen>
  )
}
