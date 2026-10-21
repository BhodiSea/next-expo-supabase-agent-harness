'use client'

import { Button } from '@app/design-system'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { deleteAccount } from '../../lib/account/delete-account'
import { t } from '../../lib/i18n'
import { getBrowserClient } from '../../lib/supabase/client'

// The web half of DSR erase. A CLIENT action for the same reason sign-out is: the browser
// client owns the session cookie and the refresh timer, and it is the thing that has to tear
// both down once the server has confirmed the deletion.
//
// TWO STEPS, NEVER ONE. The mobile half uses the native Alert; the web has no equivalent
// affordance the reviewer can rely on, so the confirmation is rendered inline — the first
// press ARMS, the second commits, and a cancel is always available. `window.confirm` is
// deliberately not used: it is suppressible, unstyleable, and invisible to the e2e lane.
//
// The choreography lives in lib/account/delete-account.ts, under the unit floor. This file
// holds the confirm state and the error surface, which is what `apps/web/app/**` is for.
export function DeleteAccountButton(): React.ReactNode {
  const router = useRouter()
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  async function commit(): Promise<void> {
    setBusy(true)
    setFailed(null)
    const outcome = await deleteAccount(getBrowserClient())
    if (outcome.status === 'failed') {
      // The session SURVIVES a failure — nothing half-deletes — so the control returns to
      // its disarmed state and the user can retry or walk away.
      setBusy(false)
      setArmed(false)
      setFailed(outcome.detail)
      return
    }
    // refresh() as well as replace(), so the Server Components re-run without the session.
    router.replace('/sign-in')
    router.refresh()
  }

  if (!armed) {
    return (
      <Button
        label={t('account.delete')}
        variant="ghost"
        size="sm"
        onPress={() => {
          setArmed(true)
        }}
        testID="account-delete"
      />
    )
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-ink-muted">{t('account.delete.confirmBody')}</span>
      <Button
        label={t('account.delete.confirm')}
        // `solid` because ButtonVariant is solid | outline | ghost — there is no danger
        // variant, and inventing one here would put a colour decision outside the tokens
        // the styleguide gate owns. The destructive weight is carried by the confirm step
        // and the copy, which is where the mobile half carries it too.
        variant="solid"
        size="sm"
        onPress={() => {
          void commit()
        }}
        busy={busy}
        testID="account-delete-confirm"
      />
      <Button
        label={t('account.delete.cancel')}
        variant="ghost"
        size="sm"
        onPress={() => {
          setArmed(false)
          setFailed(null)
        }}
        testID="account-delete-cancel"
      />
      {failed !== null && (
        <p role="alert" className="text-sm text-danger" data-testid="account-delete-error">
          {t('account.delete.failed')}
        </p>
      )}
    </div>
  )
}
