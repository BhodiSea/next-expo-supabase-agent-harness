import Link from 'next/link'
import type { ReactNode } from 'react'
import { getVerifiedUser } from '../lib/supabase/server'

// The public landing route. It renders for anonymous visitors, so it must not assume a
// session — but it still asks for one, because "signed in already" is the difference between
// a useful first screen and a dead end.
//
// getVerifiedUser() reaches the auth server, which makes this route dynamic. That is the
// correct trade here (a landing page that lies about your sign-in state is worse than a
// landing page that costs a request), and it is stated rather than discovered: if this page
// later needs to be static, the session read moves into a small client island instead.

export default async function HomePage(): Promise<ReactNode> {
  const user = await getVerifiedUser()

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      {/* Literal, not the project-name placeholder — see the note in app/layout.tsx: a
          rendered name carrying an apostrophe would break the file it lands in. */}
      <h1 className="text-4xl font-semibold tracking-tight">Welcome</h1>
      <p className="text-ink-muted text-lg">
        One Supabase backend, two surfaces: this web app and the Expo client. Both call the same
        tRPC router and the same domain packages — the API you are looking at is served from this
        deployment.
      </p>
      {user === null ? (
        <Link
          href="/sign-in"
          className="bg-accent text-canvas inline-flex w-fit items-center rounded-lg px-4 py-2 font-medium"
        >
          Sign in
        </Link>
      ) : (
        <Link
          href="/o"
          className="bg-accent text-canvas inline-flex w-fit items-center rounded-lg px-4 py-2 font-medium"
        >
          Go to your organizations
        </Link>
      )}
    </main>
  )
}
