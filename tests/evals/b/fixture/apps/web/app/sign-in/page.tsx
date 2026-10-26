import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n'
import { getVerifiedUser } from '../../lib/supabase/server'
import { CeremonyShell } from './ceremony-shell'
import { SignInForm } from './sign-in-form'

// The credential route. A SERVER component wrapping one client island — the smallest
// 'use client' boundary that can hold the form's state, with the shell, the copy and the
// already-signed-in check staying on the server.
//
// The redirect is a convenience, NOT a guard: it saves a signed-in user from staring at a
// form they do not need. Nothing here protects anything, and nothing here needs to — the
// protection is RLS, and it holds for a caller who never loads this page at all.

export const metadata = { title: t('route.signIn') }

export default async function SignInPage(): Promise<ReactNode> {
  if ((await getVerifiedUser()) !== null) redirect('/o')

  return (
    <CeremonyShell title={t('route.signIn')} lede={t('auth.signIn.lede')}>
      <SignInForm />
    </CeremonyShell>
  )
}
