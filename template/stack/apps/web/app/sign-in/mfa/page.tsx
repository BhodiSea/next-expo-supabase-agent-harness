import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { t } from '../../../lib/i18n'
import { getVerifiedUser } from '../../../lib/supabase/server'
import { CeremonyShell } from '../ceremony-shell'
import { MfaChallengeForm } from './mfa-challenge-form'

// The second half of sign-in for an enrolled user: the TOTP challenge. Chrome,
// not content (tools/web-route-allowlist.json) — it is a step INSIDE the
// credential ceremony, with no canonical data states of its own.
//
// The redirect runs the OPPOSITE way from its siblings' (out when signed out,
// where they bounce the signed-in), and it guards nothing either: there is no
// aal1 session to lift if nobody is signed in — the form would only fail later
// and less legibly. The actual enforcement is the database rail: an enrolled
// user's aal1 session reads nothing whether or not this page ever loads, which
// is exactly why the sign-in form routes here rather than hoping the user
// finds it.
// SOURCE: docs/adr/20260812-mfa-aal2.md (aal2 enforced at the database for every
// user holding a verified factor — the migration is the ADR's implementation)

export const metadata = { title: t('route.mfa') }

export default async function MfaChallengePage(): Promise<ReactNode> {
  if ((await getVerifiedUser()) === null) redirect('/sign-in')

  return (
    <CeremonyShell title={t('route.mfa')} lede={t('mfa.challenge.lede')}>
      <MfaChallengeForm />
    </CeremonyShell>
  )
}
