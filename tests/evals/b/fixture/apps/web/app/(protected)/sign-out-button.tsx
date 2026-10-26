'use client'

import { Button } from '@app/design-system'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { t } from '../../lib/i18n'
import { getBrowserClient } from '../../lib/supabase/client'

// Sign-out is a CLIENT action for the mirror of the reason sign-in is: the browser client
// owns the session cookie and the refresh timer, and it is the thing that has to tear both
// down. Clearing the cookie server-side would leave that timer running in the tab, quietly
// re-minting a session the user just ended.
export function SignOutButton(): React.ReactNode {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function signOut(): Promise<void> {
    setBusy(true)
    await getBrowserClient().auth.signOut()
    // refresh() as well as replace(), so the Server Components re-run without the session.
    // Without it the cached signed-in render survives the navigation.
    router.replace('/sign-in')
    router.refresh()
  }

  return (
    <Button
      label={t('auth.signOut')}
      variant="ghost"
      size="sm"
      onPress={() => {
        void signOut()
      }}
      busy={busy}
      testID="sign-out"
    />
  )
}
