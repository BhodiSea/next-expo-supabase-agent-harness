import { EMAIL_MAX } from '@app/contracts'
import { decideAfterSignIn } from '@app/supabase/client'
import { router } from 'expo-router'
import { useState } from 'react'
import { AppText } from '../src/components/AppText'
import { Button } from '../src/components/Button'
import { Field } from '../src/components/Field'
import { Input } from '../src/components/Input'
import { Screen } from '../src/components/Screen'
import { useI18n } from '../src/i18n'
import { useSupabase } from '../src/lib/supabase/provider'

// Sign-in over Supabase Auth — email + password, the one flow this scaffold
// seeds. Chrome, not content: no entry in src/routes.ts (see the manifest's
// chrome note), so it declares no canonical data states.
//
// WHY THIS SCREEN NO LONGER CHOOSES AN AUTH MODE. It used to branch on
// configuration: real IdP when its client IDs were present, a dev token
// authority otherwise — two code paths, of which the one that shipped was the
// one nobody exercised in development. Supabase Auth is a single path in every
// environment (the local stack is the same GoTrue the deployment runs), so
// there is no second branch to keep honest and no dev-only credential to keep
// out of a release build.
//
// ADDING A PROVIDER (OAuth, magic link, passkey) is a matter of adding an
// affordance that calls another `supabase.auth.*` method beside this one — the
// client is already mounted, the session storage is already the keychain-backed
// split store, and the transport already reads whatever token the client holds.
// SOURCE: https://supabase.com/docs/guides/auth/quickstarts/react-native

/**
 * A DELIBERATELY LOOSE shape check: a local part, an `@`, and a dotless-or-dotted
 * domain, bounded by the contract's own EMAIL_MAX (RFC 5321's path limit, stated
 * once in @app/contracts). It is not RFC-complete and must not try to be — the
 * authority on whether an address exists is the mail system, and every stricter
 * client-side regex in circulation rejects addresses that genuinely deliver
 * (plus-tags, new TLDs, quoted local parts). Its whole job is to keep an obvious
 * typo from costing a round trip and then reading as "wrong password".
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/

export default function SignInScreen() {
  const { t } = useI18n()
  const supabase = useSupabase()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState<string | undefined>(undefined)
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const signIn = async (): Promise<void> => {
    const trimmedEmail = email.trim()
    // Both fields are validated BEFORE either is sent, and both errors are set
    // in the same pass: validating one at a time makes a user with two typos
    // submit twice to learn about the second one.
    const badEmail = trimmedEmail.length > EMAIL_MAX || !EMAIL_SHAPE.test(trimmedEmail)
    const badPassword = password === ''
    setEmailError(badEmail ? t('signin.email.invalid') : undefined)
    setPasswordError(badPassword ? t('signin.password.invalid') : undefined)
    if (badEmail || badPassword) return

    setFailure(null)
    setPending(true)
    // Supabase's auth methods RESOLVE with `{ data, error }`; they do not
    // reject. So there is no try/catch here and no swallowed rejection path —
    // the failure is a value, on the same channel as the success, which is the
    // same envelope discipline the rest of this app runs on.
    const { error } = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    })
    setPending(false)
    if (error !== null) {
      // ONE sentence for every credential failure. GoTrue's own message
      // distinguishes "invalid login credentials" from "email not confirmed",
      // and rendering that distinction would tell an attacker which addresses
      // have accounts — an enumeration oracle wearing helpful copy. The
      // provider's message is not shown at all here (it is not ours to
      // translate and not safe to echo).
      setFailure(t('signin.failed'))
      return
    }
    // THE AAL BRANCH. The password minted an aal1 session; whether that session
    // is FINISHED is the mfa-flow machine's decision, not this screen's: an
    // enrolled user's aal1 token reads nothing (the database rail refuses it on
    // every surface), so the challenge screen is the only route that ends
    // anywhere. An AAL read that itself fails yields null levels and proceeds —
    // the rail still holds, and a dead end here would lock out the un-enrolled
    // majority on a network blip.
    // SOURCE: docs/adr/20260812-mfa-aal2.md (the rail) ·
    // packages/platform/supabase/src/mfa-flow.ts (decideAfterSignIn)
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (
      decideAfterSignIn({
        currentLevel: aal?.currentLevel ?? null,
        nextLevel: aal?.nextLevel ?? null,
      }) === 'challenge'
    ) {
      router.replace('/mfa-challenge')
      return
    }
    // The client persisted the session to the keychain-backed store before this
    // resolved, so Home's first query already carries the new bearer token.
    router.replace('/')
  }

  return (
    <Screen keyboard testID="sign-in-screen">
      <AppText variant="title">{t('signin.title')}</AppText>
      <AppText variant="muted">{t('signin.body')}</AppText>
      <Field label={t('signin.email.label')} error={emailError}>
        {(control) => (
          <Input
            value={email}
            onChangeText={setEmail}
            placeholder={t('signin.email.placeholder')}
            // keyboardType + autoComplete are what make the OS offer the saved
            // address and the @-bearing keyboard; autoCapitalize/autoCorrect
            // off because an autocapitalised address is a failed sign-in the
            // user cannot see.
            keyboardType="email-address"
            textContentType="username"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={control.accessibilityLabel}
            accessibilityHint={control.accessibilityHint}
            invalid={control.invalid}
            testID="sign-in-email"
          />
        )}
      </Field>
      <Field label={t('signin.password.label')} error={passwordError}>
        {(control) => (
          <Input
            value={password}
            onChangeText={setPassword}
            placeholder={t('signin.password.placeholder')}
            // secureTextEntry AND textContentType='password': the first masks
            // the field, the second is what lets the platform password manager
            // fill and offer to save it. Without the content type the OS treats
            // it as an anonymous masked box and users are pushed toward
            // memorable (weak) passwords.
            secureTextEntry
            textContentType="password"
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={control.accessibilityLabel}
            accessibilityHint={control.accessibilityHint}
            invalid={control.invalid}
            testID="sign-in-password"
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
          void signIn()
        }}
        testID="sign-in-submit"
      />
      <Button
        label={t('signin.createAccount')}
        variant="ghost"
        onPress={() => {
          router.replace('/sign-up')
        }}
        testID="sign-in-to-sign-up"
      />
    </Screen>
  )
}
