'use client'

import { Button, Field, Input, Text } from '@app/design-system'
import type { EnrolmentState } from '@app/supabase/client'
import { isTotpCode } from '@app/supabase/client'
import { useState } from 'react'
import { t } from '../../lib/i18n'

// The TOTP enrolment ceremony's RENDERING — shared by the sign-up form (where
// the step is offered and skippable) and the security page (where it is invoked
// deliberately). The ceremony's SHAPE lives in @app/supabase's mfa-flow machine;
// the supabase calls live in whichever host mounts this. Splitting it that way
// is what lets two hosts with different exits (skip → /o, cancel → the factor
// list) share every pixel of the step itself.
//
// The QR image is the `qr_code` DATA URI Supabase's enroll response carries —
// rendered directly, so no QR library ships in this bundle. The setup key sits
// beside it because a QR code is unusable to anyone enrolling ON the device
// that shows it, and because screen-reader users cannot scan at all.
// SOURCE: https://supabase.com/docs/guides/auth/auth-mfa/totp (enroll returns
// id + totp.qr_code/secret/uri; challenge + verify complete the ceremony)

interface EnrolTotpProps {
  /** The live ceremony — `idle` and `enrolled` render nothing (the host owns
   *  what those phases look like: a button, a redirect, a reloaded list). */
  readonly state: EnrolmentState
  /** Called with a shape-valid code; the host brackets challenge + verify. */
  readonly onVerify: (code: string) => void
  /** The decline affordance — skip on sign-up, cancel on the security page. */
  readonly secondaryLabel: string
  readonly onSecondary: () => void
}

export function EnrolTotp({
  state,
  onVerify,
  secondaryLabel,
  onSecondary,
}: EnrolTotpProps): React.ReactNode {
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)

  if (state.step === 'idle' || state.step === 'enrolled') return null

  function submit(): void {
    // Shape-checked BEFORE any request — a typo'd code must not cost a
    // challenge round trip and then read as "wrong code".
    if (!isTotpCode(code)) {
      setCodeError(t('mfa.code.invalid'))
      return
    }
    setCodeError(null)
    onVerify(code.trim())
  }

  return (
    <div className="flex flex-col gap-4" data-testid="mfa-enrol">
      <Text as="h2" size="lg" weight="semibold">
        {t('mfa.enrol.title')}
      </Text>
      <Text tone="muted" size="sm">
        {t('mfa.enrol.lede')}
      </Text>
      {/* A plain <img> on purpose: the source is an inline data URI from the
          enroll response, so next/image's loader pipeline has nothing to
          optimize and would only forbid the scheme. */}
      <img src={state.qrCode} alt={t('mfa.enrol.qrAlt')} width={176} height={176} />
      <div className="flex flex-col gap-1">
        {/* NOT a Field: Field labels a form CONTROL through its id context, and
            the secret is read-only prose — a label pointing at no control is
            markup lying to assistive tech. */}
        <Text as="span" size="sm" weight="medium">
          {t('mfa.enrol.secret')}
        </Text>
        {/* The secret as selectable text — the fallback for the person enrolling
            on the very device that shows the QR code. */}
        <code className="break-all text-sm text-ink" data-testid="mfa-enrol-secret">
          {state.secret}
        </code>
      </div>
      {/* The spread, not `error={codeError ?? undefined}`: FieldProps declares
          `error?: string` and exactOptionalPropertyTypes forbids an explicit
          undefined — absent and undefined are different facts there. */}
      <Field label={t('mfa.code')} {...(codeError !== null ? { error: codeError } : {})}>
        <Input value={code} onChangeText={setCode} keyboard="number" testID="mfa-enrol-code" />
      </Field>
      {state.step === 'error' && (
        <p role="alert" className="text-sm text-danger" data-testid="mfa-enrol-failed">
          {t('mfa.code.failed')}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          label={t('mfa.enrol.verify')}
          onPress={submit}
          busy={state.step === 'verifying'}
          testID="mfa-enrol-verify"
        />
        <Button
          label={secondaryLabel}
          variant="ghost"
          onPress={onSecondary}
          testID="mfa-enrol-secondary"
        />
      </div>
    </div>
  )
}
