import { router } from 'expo-router'
import { useState } from 'react'
import { entraConfigured } from '../src/auth/providers/entra'
import { sessionProvider } from '../src/auth/session'
import { AppText } from '../src/components/AppText'
import { Button } from '../src/components/Button'
import { Field } from '../src/components/Field'
import { Input } from '../src/components/Input'
import { Screen } from '../src/components/Screen'
import { useI18n } from '../src/i18n'
import { translateError } from '../src/i18n/errors'

// Sign-in — MODE-AWARE, honestly: when the Entra IDs are present
// (EXPO_PUBLIC_ENTRA_*, see src/auth/providers/entra.ts) the screen is a single
// "Sign in with Microsoft" affordance over the real PKCE flow; otherwise it is
// the dev stub screen (boot wiring installs the stub only under __DEV__).
// Chrome, not content: no entry in src/routes.ts (see the manifest's chrome
// note).
//
// The optional subject uuid (stub mode only) pins the SAME dev user across
// reinstalls (the server mints a fresh uuid per token otherwise) — validated
// inline BEFORE any request, through the Field/Input three-channel error
// contract.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default function SignInScreen() {
  const { t } = useI18n()
  const entra = entraConfigured()
  const [subject, setSubject] = useState('')
  const [subjectError, setSubjectError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const signIn = async (hint?: string): Promise<void> => {
    setFailure(null)
    setPending(true)
    try {
      await sessionProvider().signIn(hint)
      router.replace('/')
    } catch (cause) {
      // Envelope code -> translated copy; the raw message stays a detail.
      setFailure(translateError(cause).message)
    } finally {
      setPending(false)
    }
  }

  const signInDev = async (): Promise<void> => {
    const trimmed = subject.trim()
    if (trimmed !== '' && !UUID_SHAPE.test(trimmed)) {
      setSubjectError(t('signin.subject.invalid'))
      return
    }
    setSubjectError(undefined)
    await signIn(trimmed === '' ? undefined : trimmed)
  }

  if (entra) {
    return (
      <Screen keyboard testID="sign-in-screen">
        <AppText variant="title">{t('signin.title')}</AppText>
        <AppText variant="muted">{t('signin.entra.body')}</AppText>
        {failure !== null && (
          <AppText variant="danger" role="alert" testID="sign-in-failure">
            {failure}
          </AppText>
        )}
        <Button
          label={pending ? t('signin.pending') : t('signin.entra.submit')}
          disabled={pending}
          onPress={() => {
            void signIn()
          }}
          testID="sign-in-entra"
        />
      </Screen>
    )
  }

  return (
    <Screen keyboard testID="sign-in-screen">
      <AppText variant="title">{t('signin.title')}</AppText>
      <AppText variant="muted">{t('signin.body')}</AppText>
      <Field label={t('signin.subject.label')} error={subjectError}>
        {(control) => (
          <Input
            value={subject}
            onChangeText={setSubject}
            placeholder={t('signin.subject.placeholder')}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={control.accessibilityLabel}
            accessibilityHint={control.accessibilityHint}
            invalid={control.invalid}
            testID="sign-in-subject"
          />
        )}
      </Field>
      {failure !== null && (
        <AppText variant="danger" role="alert" testID="sign-in-failure">
          {failure}
        </AppText>
      )}
      <Button
        label={pending ? t('signin.pending') : t('signin.submit')}
        disabled={pending}
        onPress={() => {
          void signInDev()
        }}
        testID="sign-in-submit"
      />
    </Screen>
  )
}
