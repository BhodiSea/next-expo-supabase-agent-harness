import { Text } from '@app/design-system'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { getVerifiedUser } from '../../lib/supabase/server'
import { SignInForm } from './sign-in-form'

// The credential route. A SERVER component wrapping one client island — the smallest
// 'use client' boundary that can hold the form's state, with the shell, the copy and the
// already-signed-in check staying on the server.
//
// The redirect is a convenience, NOT a guard: it saves a signed-in user from staring at a
// form they do not need. Nothing here protects anything, and nothing here needs to — the
// protection is RLS, and it holds for a caller who never loads this page at all.

export const metadata = { title: 'Sign in' }

export default async function SignInPage(): Promise<ReactNode> {
  if ((await getVerifiedUser()) !== null) redirect('/o')

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6 py-16">
      <Text as="h1" size="2xl" weight="semibold">
        Sign in
      </Text>
      <Text tone="muted">
        Your session is verified server-side on every request, and every row you can reach is
        decided by row-level security in Postgres — never by this browser.
      </Text>
      <SignInForm />
    </main>
  )
}
