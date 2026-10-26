import type { ChallengeState } from '@app/supabase/client'
import {
  challengeCeremony,
  challengeCodeSubmitted,
  challengeFaulted,
  challengeIssued,
  challengeVerified,
  isTotpCode,
} from '@app/supabase/client'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { AppText } from '../src/components/AppText'
import { Button } from '../src/components/Button'
import { Field } from '../src/components/Field'
import { Input } from '../src/components/Input'
import { Screen } from '../src/components/Screen'
import { useI18n } from '../src/i18n'
import { useSupabase } from '../src/lib/supabase/provider'

// The second half of sign-in for an enrolled user: the TOTP challenge. Chrome,
// not content (tools/route-allowlist.json) — a step INSIDE the credential
// ceremony, with no canonical data states of its own. The sign-in screen
// routes here when decideAfterSignIn says the aal1 session is unfinished; the
// database rail is what actually refuses that session's reads, whether or not
// this screen ever mounts.
//
// The challenge is minted PER VERIFY ATTEMPT, not at mount: GoTrue challenges
// expire, and a user who fetches their phone slowly would otherwise submit a
// valid code against a dead challenge — the machine's error arc goes back
// through challengeIssued for exactly this reason.
// SOURCE: https://supabase.com/docs/guides/auth/auth-mfa/totp (listFactors →
// challenge → verify; verify lifts the session to aal2)

/** The mount-time factor lookup: which verified factor this session answers with. */
type FactorLookup = 'resolving' | 'unavailable' | 'ready'

export default function MfaChallengeScreen() {
  const { t } = useI18n()
  const supabase = useSupabase()
  const [lookup, setLookup] = useState<FactorLookup>('resolving')
  const [ceremony, setCeremony] = useState<ChallengeState | null>(null)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void supabase.auth.mfa.listFactors().then(({ data, error }) => {
      if (cancelled) return
      const factorId = data?.totp[0]?.id
      if (error !== null || factorId === undefined) {
        // No verified factor to answer with — reachable only by deep-linking
        // here directly (sign-in routes here on decideAfterSignIn's say-so,
        // which requires nextLevel aal2). An honest dead end with a way back.
        setLookup('unavailable')
        return
      }
      setCeremony(challengeCeremony(factorId))
      setLookup('ready')
    })
    return () => {
      cancelled = true
    }
  }, [supabase])

  const verify = async (): Promise<void> => {
    if (ceremony === null || ceremony.step === 'verifying' || ceremony.step === 'satisfied') return
    if (!isTotpCode(code)) {
      setCodeError(t('mfa.code.invalid'))
      return
    }
    setCodeError(undefined)
    const { data: challenge, error: challengeFailure } = await supabase.auth.mfa.challenge({
      factorId: ceremony.factorId,
    })
    if (challengeFailure !== null) {
      // The fault arc, not the failed-verify one: no challenge exists yet.
      setCeremony((current) => (current === null ? null : challengeFaulted(current)))
      return
    }
    const issued = challengeIssued(ceremony, challenge.id)
    setCeremony(challengeCodeSubmitted(issued))
    const { error: verifyFailure } = await supabase.auth.mfa.verify({
      factorId: ceremony.factorId,
      challengeId: challenge.id,
      code: code.trim(),
    })
    if (verifyFailure !== null) {
      setCeremony((current) => (current === null ? null : challengeVerified(current, false)))
      return
    }
    setCeremony((current) => (current === null ? null : challengeVerified(current, true)))
    // The session now carries aal2 — Home's first query passes the rail.
    router.replace('/')
  }

  return (
    <Screen keyboard testID="mfa-challenge-screen">
      <AppText variant="title">{t('mfa.challenge.title')}</AppText>
      {lookup === 'unavailable' ? (
        <>
          <AppText variant="danger" role="alert" testID="mfa-challenge-unavailable">
            {t('mfa.challenge.unavailable')}
          </AppText>
          <Button
            label={t('mfa.challenge.back')}
            onPress={() => {
              router.replace('/sign-in')
            }}
            testID="mfa-challenge-back"
          />
        </>
      ) : (
        <>
          <AppText variant="muted">{t('mfa.challenge.body')}</AppText>
          <Field label={t('mfa.code.label')} error={codeError}>
            {(control) => (
              <Input
                value={code}
                onChangeText={setCode}
                placeholder={t('mfa.code.placeholder')}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={control.accessibilityLabel}
                accessibilityHint={control.accessibilityHint}
                invalid={control.invalid}
                testID="mfa-challenge-code"
              />
            )}
          </Field>
          {ceremony?.step === 'error' && (
            <AppText variant="danger" role="alert" testID="mfa-challenge-failed">
              {t('mfa.code.failed')}
            </AppText>
          )}
          <Button
            label={
              ceremony?.step === 'verifying' ? t('mfa.verify.pending') : t('mfa.challenge.verify')
            }
            disabled={lookup === 'resolving' || ceremony?.step === 'verifying'}
            onPress={() => {
              void verify()
            }}
            testID="mfa-challenge-verify"
          />
        </>
      )}
    </Screen>
  )
}
