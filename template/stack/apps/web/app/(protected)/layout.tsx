import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { getVerifiedUser } from '../../lib/supabase/server'
import { DeleteAccountButton } from './delete-account-button'
import { SignOutButton } from './sign-out-button'

// The signed-in shell. Everything under this route group assumes a verified caller, so the
// check lives here once instead of at the top of every page.
//
// SAY THIS PLAINLY, BECAUSE THE FILE'S NAME INVITES THE OPPOSITE READING: the folder is
// called (protected) and this layout is NOT what protects it. A Next layout is a rendering
// concern — it can be skipped by a client-side navigation that Next resolves without
// re-running it, and it does nothing at all for the API routes and Server Actions that carry
// the actual data. What protects the data is RLS in Postgres plus the org gate in
// lib/auth/session.ts, and both hold for a caller who never renders a single layout.
//
// What this DOES buy is that a signed-out visitor sees the sign-in page instead of a shell
// full of empty states — a UX affordance, priced as one auth round trip per navigation.
// SOURCE: apps/web/proxy.ts (the same non-boundary argument, for CVE-2025-29927)

export default async function ProtectedLayout({
  children,
}: {
  readonly children: ReactNode
}): Promise<ReactNode> {
  const user = await getVerifiedUser()
  if (user === null) redirect('/sign-in')

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line px-6 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <span className="text-sm text-ink-muted">{user.email ?? user.id}</span>
          <div className="flex items-center gap-2">
            {/* DSR erase reaches the WEB surface from 0.11.0. It sits in the signed-in
                shell rather than behind a new route so no page.meta.ts, route-manifest
                entry or state-testid triple is owed for a two-button control. */}
            <DeleteAccountButton />
            <SignOutButton />
          </div>
        </div>
      </header>
      {children}
    </div>
  )
}
