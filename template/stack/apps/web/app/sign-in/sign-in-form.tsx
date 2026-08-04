'use client'

import { Button, Field, Input } from '@app/design-system'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { getBrowserClient } from '../../lib/supabase/client'

// The credential form. A CLIENT component, and it has to be: signing in must happen in the
// browser so @supabase/ssr's browser client writes the session cookie the whole app then
// reads. Posting the password to a Server Action instead would mean the password crosses an
// extra hop and the server has to hand the session back through a cookie it sets by hand —
// more code, more places to get httpOnly and SameSite wrong, no benefit.
//
// WHAT THIS SCREEN IS NOT. It is not an authorization boundary and it is not a gate. A user
// who never visits it and forges a cookie still reads nothing: getUser() verifies against the
// auth server and every row is behind RLS. This is a convenience — the place to obtain a
// credential — and its only security-relevant job is to not leak WHICH half of a wrong
// credential was wrong.
// SOURCE: docs/security/sandbox-and-supply-chain.md (the client is an untrusted bearer of a
// scoped token; authorize in RLS)

export function SignInForm(): React.ReactNode {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const { error: failure } = await getBrowserClient().auth.signInWithPassword({ email, password })
    setBusy(false)
    if (failure !== null) {
      // ONE message for every failure mode. Distinguishing "no such account" from "wrong
      // password" turns this form into an account-existence oracle: an attacker enumerates a
      // customer list by watching which addresses answer differently. The provider's own
      // message is deliberately not forwarded for the same reason.
      setError('That email and password did not match an account.')
      return
    }
    // `refresh()` after `replace()`, and both are needed. replace() moves the route;
    // refresh() re-runs the Server Components so the layout re-reads the session it now has.
    // Without the refresh the protected layout renders from the cached anonymous pass and
    // bounces straight back here — the classic "sign in does nothing" loop.
    router.replace('/o')
    router.refresh()
  }

  return (
    <form
      onSubmit={(event) => {
        void submit(event)
      }}
      className="flex flex-col gap-4"
      noValidate
    >
      <Field label="Email">
        <Input value={email} onChangeText={setEmail} keyboard="email" testID="sign-in-email" />
      </Field>
      <Field label="Password">
        <Input value={password} onChangeText={setPassword} secure testID="sign-in-password" />
      </Field>
      {/* A FORM-level alert, not a Field error, because the failure is about the PAIR: the
          server will not say which half was wrong, so pinning the message to one input would
          claim knowledge nobody has. role="alert" announces it without the user going looking;
          rendered only when present, since a permanently-mounted empty live region is
          announced as a change on every render by some engines. */}
      {error !== null && (
        <p role="alert" className="text-sm text-danger" data-testid="sign-in-error">
          {error}
        </p>
      )}
      <Button label="Sign in" type="submit" busy={busy} testID="sign-in-submit" />
    </form>
  )
}
