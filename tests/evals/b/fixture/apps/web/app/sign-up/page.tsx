import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n'
import { getVerifiedUser } from '../../lib/supabase/server'
import { CeremonyShell } from '../sign-in/ceremony-shell'
import { SignUpForm } from './sign-up-form'

// The account-creation route — sign-in's structural twin: a SERVER component
// wrapping one client island, in the shared ceremony shell. Chrome, not
// content (tools/web-route-allowlist.json): like sign-in it has no canonical
// data states and must stay reachable to the signed-out visitor a data-state
// contract presumes away.
//
// The redirect is the same convenience sign-in's is, NOT a guard: a signed-in
// user has no business creating the account they already hold. Nothing here
// protects anything — the protection is RLS, and the MFA rail on top of it is
// the database's (supabase/migrations/20260812000000_mfa_aal2.sql), not this page's.

export const metadata = { title: t('route.signUp') }

export default async function SignUpPage(): Promise<ReactNode> {
  if ((await getVerifiedUser()) !== null) redirect('/o')

  return (
    <CeremonyShell title={t('route.signUp')} lede={t('auth.signUp.lede')}>
      <SignUpForm />
    </CeremonyShell>
  )
}
