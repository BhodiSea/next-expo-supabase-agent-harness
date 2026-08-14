import { Text } from '@app/design-system'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { requireOrgContext } from '../../../../lib/auth/session'
import { t } from '../../../../lib/i18n'

// The org chrome, and the org SWITCHER.
//
// The switcher is a list of links, not client state, and that is the design decision worth
// defending. With the acting org as a route segment: a bookmark reopens the same tenant, a
// refresh keeps it, two tabs can sit in two different orgs without fighting over one store,
// and — the one that matters — a stale tab cannot submit a write into an org the user
// switched away from ten minutes ago, because its forms are bound to ITS segment.
//
// A slug that is not one of the caller's seats renders 404, deliberately, and it is the same
// 404 a genuinely nonexistent org gets. Anything else — a 403, a "you do not have access to
// Acme" — confirms Acme exists, which is the existence disclosure the RLS suites refuse one
// layer down. The org gate returns an outcome; turning it into notFound() here is what keeps
// the two answers indistinguishable.

export default async function OrgLayout({
  children,
  params,
}: {
  readonly children: ReactNode
  readonly params: Promise<{ readonly orgSlug: string }>
}): Promise<ReactNode> {
  const { orgSlug } = await params
  const gate = await requireOrgContext(orgSlug)
  if (!gate.ok) notFound()

  const { org, orgs } = gate.data

  return (
    <div className="flex flex-1 flex-col">
      <nav aria-label={t('nav.organization')} className="border-b border-line px-6 py-2">
        <div className="mx-auto flex max-w-3xl items-center gap-3 overflow-x-auto">
          {orgs.map((candidate) => {
            const current = candidate.id === org.id
            return (
              <Link
                key={candidate.id}
                href={`/o/${candidate.slug}/notes`}
                // aria-current is what tells a screen-reader user which tenant they are in.
                // Colour alone would leave that information visible only to people who can
                // see it — and "which company's data am I looking at" is not decorative.
                aria-current={current ? 'page' : undefined}
                // `min-h-(--size-touch-min)` + `inline-flex items-center`, not decoration:
                // these were `px-3 py-1 text-sm`, which renders under 24 CSS px tall and is
                // a WCAG 2.2 SC 2.5.8 (target size) failure the moment this route is
                // axe-scanned with the 0.10.0 tag ladder. The token is the 44px floor the
                // design system already applies to every button and input, so this makes the
                // tenant switcher agree with the rest of the system rather than inventing a
                // size for it. Found by widening the tags, not by review.
                className={
                  current
                    ? 'inline-flex min-h-(--size-touch-min) items-center rounded-md bg-accent px-3 py-1 text-sm font-medium text-canvas'
                    : 'inline-flex min-h-(--size-touch-min) items-center rounded-md px-3 py-1 text-sm text-ink-muted hover:bg-canvas-subtle'
                }
                data-testid={`org-switch-${candidate.slug}`}
              >
                {candidate.name}
              </Link>
            )
          })}
        </div>
      </nav>
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <Text as="h1" size="2xl" weight="semibold" testID="org-heading">
          {org.name}
        </Text>
        {children}
      </div>
    </div>
  )
}
