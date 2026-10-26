import type { EnrolmentState } from '@app/supabase/client'
import { isTotpCode } from '@app/supabase/client'
import { useState } from 'react'
import { AppText } from '../../components/AppText'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { Input } from '../../components/Input'
import { useI18n } from '../../i18n'

// The TOTP enrolment ceremony's RENDERING — shared by the sign-up screen (where
// the step is offered and skippable) and the security screen (where it is
// invoked deliberately). The ceremony's SHAPE lives in @app/supabase's mfa-flow
// machine; the supabase calls live in whichever host mounts this. That split is
// what lets two hosts with different exits (skip → home, cancel → the factor
// list) share every pixel of the step itself.
//
// NO QR CODE HERE, deliberately: a device cannot scan its own screen, so the
// SETUP KEY is the enrolment affordance on this surface — rendered selectable,
// which is what puts the platform's long-press copy affordance on it without a
// clipboard dependency. The web twin (apps/web/app/sign-up/enrol-totp.tsx)
// renders the qr_code data URI and keeps the key as its fallback.
// SOURCE: https://supabase.com/docs/guides/auth/auth-mfa/totp (enroll returns
// totp.secret alongside the QR; either enrols the same factor)

interface EnrolCeremonyProps {
  /** The live ceremony — `idle` and `enrolled` render nothing (the host owns
   *  what those phases look like: a button, a redirect, a reloaded list). */
  readonly state: EnrolmentState
  /** Called with a shape-valid code; the host brackets challenge + verify. */
  readonly onVerify: (code: string) => void
  /** The decline affordance — skip on sign-up, cancel on the security screen. */
  readonly secondaryLabel: string
  readonly onSecondary: () => void
}

export function EnrolCeremony({
  state,
  onVerify,
  secondaryLabel,
  onSecondary,
}: EnrolCeremonyProps) {
  const { t } = useI18n()
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | undefined>(undefined)

  if (state.step === 'idle' || state.step === 'enrolled') return null

  const submit = (): void => {
    // Shape-checked BEFORE any request — a typo'd code must not cost a
    // challenge round trip and then read as "wrong code".
    if (!isTotpCode(code)) {
      setCodeError(t('mfa.code.invalid'))
      return
    }
    setCodeError(undefined)
    onVerify(code.trim())
  }

  return (
    <>
      <AppText variant="title">{t('mfa.enrol.title')}</AppText>
      <AppText variant="muted">{t('mfa.enrol.body')}</AppText>
      <AppText variant="label">{t('mfa.enrol.secret')}</AppText>
      {/* `selectable` is the copy affordance: long-press selects the key so the
          platform's own copy action carries it into the authenticator app. */}
      <AppText selectable testID="mfa-enrol-secret">
        {state.secret}
      </AppText>
      <Field label={t('mfa.code.label')} error={codeError}>
        {(control) => (
          <Input
            value={code}
            onChangeText={setCode}
            placeholder={t('mfa.code.placeholder')}
            // number-pad + one-time-code content type: the OS offers the numeric
            // keyboard, and iOS can autofill a code it just saw arrive.
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={control.accessibilityLabel}
            accessibilityHint={control.accessibilityHint}
            invalid={control.invalid}
            testID="mfa-enrol-code"
          />
        )}
      </Field>
      {state.step === 'error' && (
        <AppText variant="danger" role="alert" testID="mfa-enrol-failed">
          {t('mfa.code.failed')}
        </AppText>
      )}
      <Button
        label={state.step === 'verifying' ? t('mfa.verify.pending') : t('mfa.enrol.verify')}
        disabled={state.step === 'verifying'}
        onPress={submit}
        testID="mfa-enrol-verify"
      />
      <Button
        label={secondaryLabel}
        variant="ghost"
        onPress={onSecondary}
        testID="mfa-enrol-secondary"
      />
    </>
  )
}
