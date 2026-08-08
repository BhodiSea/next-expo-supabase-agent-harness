import { Card, Text } from '@app/design-system'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { resolveOrgs } from '../../../lib/auth/session'
import { t } from '../../../lib/i18n'
import { createRequestScopedClient } from '../../../lib/supabase/server'
import { CreateWorkspaceButton } from './create-workspace-button'
import { meta } from './page.meta'

// The org picker, and the landing spot after sign-in.
//
// One org redirects straight through, which matches what createContext does for a request
// with no x-org-id header: when there is exactly one possible answer there is no choice to
// present. With several it lists them — it does NOT pick the first, because a default that
// depends on sort order is a default that silently moves when a user joins an org.

// The title comes from the route's OWN meta, so the browser tab and the registry cannot say
// different things about what this page is called. `t()` is a plain function, not a hook —
// that is what lets a Server Component's module-scope `metadata` export use it at all.
export const metadata = { title: t(meta.titleKey) }

export default async function OrgPickerPage(): Promise<ReactNode> {
  const orgs = await resolveOrgs(await createRequestScopedClient())

  if (orgs.length === 1 && orgs[0] !== undefined) redirect(`/o/${orgs[0].slug}/notes`)

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <Text as="h1" size="2xl" weight="semibold">
        {t('route.orgs')}
      </Text>

      {orgs.length === 0 ? (
        <Card testID={meta.states.empty}>
          <div className="flex flex-col items-start gap-3">
            <Text weight="medium">{t('orgs.empty.title')}</Text>
            <Text tone="muted" size="sm">
              {t('orgs.empty.description')}
            </Text>
            <CreateWorkspaceButton />
          </div>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {orgs.map((org) => (
            <li key={org.id}>
              {/* The switcher IS this list plus the links in the org header. Navigation, not
                  client state: the acting org is a route segment, so a bookmark, a refresh
                  and a second tab all agree about which tenant is on screen — and a stale
                  tab cannot write into an org the user switched away from. */}
              <Link
                href={`/o/${org.slug}/notes`}
                className="block rounded-lg border border-line px-4 py-3 hover:bg-canvas-subtle"
                data-testid={`org-link-${org.slug}`}
              >
                <span className="font-medium text-ink">{org.name}</span>
                <span className="ml-2 text-sm text-ink-muted">{org.role}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
