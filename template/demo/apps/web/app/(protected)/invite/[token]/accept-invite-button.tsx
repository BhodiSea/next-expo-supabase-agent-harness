'use client'

import { Button } from '@app/design-system'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { t } from '../../../../lib/i18n'
import { errorCopy } from '../../../../lib/i18n/errors'
import { acceptInvitationAction } from '../../../actions/orgs'

export function AcceptInviteButton({ token }: { readonly token: string }): React.ReactNode {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function accept(): Promise<void> {
    setBusy(true)
    setError(null)
    const outcome = await acceptInvitationAction(token)
    setBusy(false)
    if (!outcome.ok) {
      // ONE message for malformed, expired, already-used and someone-else's — the action
      // collapses them deliberately. Distinguishing them here would rebuild the oracle the
      // RPC was written to avoid.
      setError(errorCopy(outcome.error))
      return
    }
    // Straight into the org that was just joined. `replace`, not `push`: the invitation URL
    // is spent, and leaving it in history invites a back-button retry that can only fail.
    router.replace(`/o/${outcome.data.slug}/notes`)
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        label={t('invite.accept')}
        onPress={() => {
          void accept()
        }}
        busy={busy}
        testID="accept-invite"
      />
      {error !== null && (
        <p role="alert" className="text-sm text-danger" data-testid="accept-invite-error">
          {error}
        </p>
      )}
    </div>
  )
}
