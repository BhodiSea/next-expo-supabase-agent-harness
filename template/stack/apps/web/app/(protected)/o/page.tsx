import { Card, Text } from '@app/design-system'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { resolveOrgs } from '../../../lib/auth/session'
import { createRequestScopedClient } from '../../../lib/supabase/server'
import { CreateWorkspaceButton } from './create-workspace-button'

// The org picker, and the landing spot after sign-in.
//
// One org redirects straight through, which matches what createContext does for a request
// with no x-org-id header: when there is exactly one possible answer there is no choice to
// present. With several it lists them — it does NOT pick the first, because a default that
// depends on sort order is a default that silently moves when a user joins an org.

export const metadata = { title: 'Organizations' }

export default async function OrgPickerPage(): Promise<ReactNode> {
  const orgs = await resolveOrgs(await createRequestScopedClient())

  if (orgs.length === 1 && orgs[0] !== undefined) redirect(`/o/${orgs[0].slug}/notes`)

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
      <Text as="h1" size="2xl" weight="semibold">
        Organizations
      </Text>

      {orgs.length === 0 ? (
        <Card>
          <div className="flex flex-col items-start gap-3">
            <Text weight="medium">You are not in any organization yet.</Text>
            <Text tone="muted" size="sm">
              Create your personal workspace to get started, or open an invitation link someone sent
              you.
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
