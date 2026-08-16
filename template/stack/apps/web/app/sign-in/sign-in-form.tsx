'use client'

import { Button } from '@app/design-system'
import { decideAfterSignIn } from '@app/supabase/client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { t } from '../../lib/i18n'
import { getBrowserClient } from '../../lib/supabase/client'
import { CredentialFields } from './credential-fields'

// The credential form. A CLIENT component, and it has to be: signing in must happen in the
// browser so the browser client writes the session cookie the whole app then reads. Posting
// the password to a Server Action instead would mean the password crosses an extra hop and
// the server has to hand the session back through a cookie it sets by hand — more code, more
// places to get the attributes wrong, no benefit.
//
// THE COST OF THAT CHOICE, stated because it used to be denied here: a cookie the browser
// writes cannot be `HttpOnly`. That is not an oversight to fix later — the attribute exists
// to hide a cookie from script, and a user agent ignores it on a `document.cookie` write. The
// session is therefore script-readable, and what protects it is `Secure`, `SameSite=Lax`, the
// CSRF guard on the ambient-credential path, and a short-lived rotating token. A deployment
// that needs an httpOnly session cookie must move sign-in server-side first.
// SOURCE: apps/web/lib/supabase/client.ts (the jar, and the whole trade)
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
    const client = getBrowserClient()
    const { error: failure } = await client.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (failure !== null) {
      // ONE message for every failure mode. Distinguishing "no such account" from "wrong
      // password" turns this form into an account-existence oracle: an attacker enumerates a
      // customer list by watching which addresses answer differently. The provider's own
      // message is deliberately not forwarded for the same reason.
      setError(t('auth.signIn.failed'))
      return
    }
    // THE AAL BRANCH. The password minted an aal1 session; whether that session
    // is FINISHED is the machine's decision, not this form's: an enrolled user's
    // aal1 token reads nothing (the database rail refuses it on every surface),
    // so routing them to the challenge is the only path that ends anywhere.
    // push(), not replace() — the challenge is a step FORWARD in the same
    // ceremony, and Back honestly returns to the credential form. An AAL read
    // that itself fails yields null levels and proceeds: the rail still holds,
    // and a dead end here would lock out the un-enrolled majority on a blip.
    // SOURCE: supabase/migrations/20260812000000_mfa_aal2.sql (the rail) ·
    // packages/platform/supabase/src/mfa-flow.ts (decideAfterSignIn)
    const { data: aal } = await client.auth.mfa.getAuthenticatorAssuranceLevel()
    if (
      decideAfterSignIn({
        currentLevel: aal?.currentLevel ?? null,
        nextLevel: aal?.nextLevel ?? null,
      }) === 'challenge'
    ) {
      router.push('/sign-in/mfa')
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
      {/* The shared email/password pair + PAIR-level alert (see
          credential-fields.tsx for the non-enumeration rationale). */}
      <CredentialFields
        idPrefix="sign-in"
        email={email}
        password={password}
        onEmailChange={setEmail}
        onPasswordChange={setPassword}
        error={error}
      />
      <Button label={t('auth.signIn')} type="submit" busy={busy} testID="sign-in-submit" />
      <Link href="/sign-up" className="text-sm text-ink-muted underline">
        {t('auth.signIn.needAccount')}
      </Link>
    </form>
  )
}
