'use client'

import { Field, Input } from '@app/design-system'
import { t } from '../../lib/i18n'

// The email/password pair plus the form-level failure line — the half of the
// credential form sign-in and sign-up genuinely share. The testID prefix is
// the only thing that distinguishes them to the test lanes; sharing the markup
// is what keeps the two forms asking for the same two facts the same way.
//
// The failure renders as a FORM-level alert, not a Field error, because on
// both forms the failure is about the PAIR: the server will not say which half
// was wrong (the non-enumeration discipline both submit handlers hold), so
// pinning the message to one input would claim knowledge nobody has.
// role="alert" announces it without the user going looking; rendered only when
// present, since a permanently-mounted empty live region is announced as a
// change on every render by some engines.

interface CredentialFieldsProps {
  /** Namespaces the three testIDs: `<prefix>-email/-password/-error`. */
  readonly idPrefix: 'sign-in' | 'sign-up'
  readonly email: string
  readonly password: string
  readonly onEmailChange: (next: string) => void
  readonly onPasswordChange: (next: string) => void
  /** The one non-enumerating failure sentence, or null. */
  readonly error: string | null
}

export function CredentialFields({
  idPrefix,
  email,
  password,
  onEmailChange,
  onPasswordChange,
  error,
}: CredentialFieldsProps): React.ReactNode {
  return (
    <>
      <Field label={t('auth.email')}>
        <Input
          value={email}
          onChangeText={onEmailChange}
          keyboard="email"
          testID={`${idPrefix}-email`}
        />
      </Field>
      <Field label={t('auth.password')}>
        <Input
          value={password}
          onChangeText={onPasswordChange}
          secure
          testID={`${idPrefix}-password`}
        />
      </Field>
      {error !== null && (
        <p role="alert" className="text-sm text-danger" data-testid={`${idPrefix}-error`}>
          {error}
        </p>
      )}
    </>
  )
}
