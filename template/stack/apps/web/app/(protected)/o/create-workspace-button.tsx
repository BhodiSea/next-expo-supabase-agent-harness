'use client'

import { Button } from '@app/design-system'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { t } from '../../../lib/i18n'
import { errorCopy } from '../../../lib/i18n/errors'
import { ensurePersonalOrgAction } from '../../actions/orgs'

// One button, one POST. See the header in app/actions/orgs.ts for why provisioning is not a
// side effect of rendering /o.
export function CreateWorkspaceButton(): React.ReactNode {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create(): Promise<void> {
    setBusy(true)
    setError(null)
    const outcome = await ensurePersonalOrgAction()
    setBusy(false)
    if (!outcome.ok) {
      setError(errorCopy(outcome.error))
      return
    }
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        label={t('orgs.create')}
        onPress={() => {
          void create()
        }}
        busy={busy}
        testID="create-workspace"
      />
      {error !== null && (
        <p role="alert" className="text-sm text-danger" data-testid="create-workspace-error">
          {error}
        </p>
      )}
    </div>
  )
}
