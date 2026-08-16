'use client'

import { Button, Field, Input } from '@app/design-system'
import type { ChallengeState } from '@app/supabase/client'
import {
  challengeCeremony,
  challengeCodeSubmitted,
  challengeFaulted,
  challengeIssued,
  challengeVerified,
  isTotpCode,
} from '@app/supabase/client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { t } from '../../../lib/i18n'
import { getBrowserClient } from '../../../lib/supabase/client'

// The TOTP challenge form, driven by @app/supabase's mfa-flow machine — the
// same transitions the mobile challenge screen walks, so the two surfaces
// cannot drift on what the ceremony IS.
//
// The challenge is minted PER VERIFY ATTEMPT, not at mount: GoTrue challenges
// expire, and a user who fetches their phone slowly would otherwise submit a
// valid code against a dead challenge — the machine's error arc goes back
// through challengeIssued for exactly this reason.
//
// A failed code shows the catalog's one sentence, never the provider message:
// the raw error is unlocalized developer English, and the useful instruction
// (codes rotate; use the current one) is ours to phrase.
// SOURCE: https://supabase.com/docs/guides/auth/auth-mfa/totp (listFactors →
// challenge → verify; verify lifts the session to aal2)

/** The mount-time factor lookup: which verified factor this session answers with. */
type FactorLookup =
  | { readonly status: 'resolving' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'ready' }

export function MfaChallengeForm(): React.ReactNode {
  const router = useRouter()
  const [lookup, setLookup] = useState<FactorLookup>({ status: 'resolving' })
  const [ceremony, setCeremony] = useState<ChallengeState | null>(null)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getBrowserClient()
      .auth.mfa.listFactors()
      .then(({ data, error }) => {
        if (cancelled) return
        const factorId = data?.totp[0]?.id
        if (error !== null || factorId === undefined) {
          // No verified factor to answer with — reachable only by navigating
          // here directly (the sign-in form routes here on decideAfterSignIn's
          // say-so, which requires nextLevel aal2). Honest dead end, way back.
          setLookup({ status: 'unavailable' })
          return
        }
        setCeremony(challengeCeremony(factorId))
        setLookup({ status: 'ready' })
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function verify(): Promise<void> {
    if (ceremony === null || ceremony.step === 'verifying' || ceremony.step === 'satisfied') return
    if (!isTotpCode(code)) {
      setCodeError(t('mfa.code.invalid'))
      return
    }
    setCodeError(null)
    const client = getBrowserClient()
    const { data: challenge, error: challengeFailure } = await client.auth.mfa.challenge({
      factorId: ceremony.factorId,
    })
    if (challengeFailure !== null) {
      // The fault arc, not the failed-verify one: no challenge exists yet.
      setCeremony((current) => (current === null ? null : challengeFaulted(current)))
      return
    }
    const issued = challengeIssued(ceremony, challenge.id)
    setCeremony(challengeCodeSubmitted(issued))
    const { error: verifyFailure } = await client.auth.mfa.verify({
      factorId: ceremony.factorId,
      challengeId: challenge.id,
      code: code.trim(),
    })
    if (verifyFailure !== null) {
      setCeremony((current) => (current === null ? null : challengeVerified(current, false)))
      return
    }
    setCeremony((current) => (current === null ? null : challengeVerified(current, true)))
    // The session now carries aal2 — refresh() re-runs the Server Components
    // under the lifted claim, and the database rail admits its reads.
    router.replace('/o')
    router.refresh()
  }

  if (lookup.status === 'unavailable') {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert" className="text-sm text-danger" data-testid="mfa-challenge-unavailable">
          {t('mfa.challenge.unavailable')}
        </p>
        <Link href="/sign-in" className="text-sm text-ink underline">
          {t('route.signIn')}
        </Link>
      </div>
    )
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void verify()
      }}
      className="flex flex-col gap-4"
      noValidate
    >
      {/* The spread, not `error={codeError ?? undefined}` — see enrol-totp.tsx:
          exactOptionalPropertyTypes forbids an explicit undefined here. */}
      <Field label={t('mfa.code')} {...(codeError !== null ? { error: codeError } : {})}>
        <Input value={code} onChangeText={setCode} keyboard="number" testID="mfa-challenge-code" />
      </Field>
      {ceremony?.step === 'error' && (
        <p role="alert" className="text-sm text-danger" data-testid="mfa-challenge-failed">
          {t('mfa.code.failed')}
        </p>
      )}
      <Button
        label={t('mfa.challenge.verify')}
        type="submit"
        busy={lookup.status === 'resolving' || ceremony?.step === 'verifying'}
        testID="mfa-challenge-verify"
      />
    </form>
  )
}
