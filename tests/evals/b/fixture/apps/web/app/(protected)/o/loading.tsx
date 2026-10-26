import { Skeleton } from '@app/design-system'
import type { ReactNode } from 'react'
import { t } from '../../../lib/i18n'
import { meta } from './page.meta'

// The org picker's loading UI — see the notes twin for the reasoning; this file exists
// SEPARATELY rather than inheriting that one because a `loading.tsx` applies to its segment
// AND every child, so without one here the picker would borrow the notes skeleton's shape.
// SOURCE: https://nextjs.org/docs/app/api-reference/file-conventions/loading (a nested
// loading.js takes precedence for its own segment)
export default function OrgPickerLoading(): ReactNode {
  return (
    // `<output>` — see the notes twin for why the element and not a role.
    <output
      aria-busy="true"
      aria-label={t('orgs.loading')}
      data-testid={meta.states.loading}
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10"
    >
      <Skeleton width={220} height={32} rounded="md" />
      <div className="flex flex-col gap-3">
        <Skeleton fullWidth height={54} rounded="lg" />
        <Skeleton fullWidth height={54} rounded="lg" />
      </div>
    </output>
  )
}
