import { Skeleton } from '@app/design-system'
import type { ReactNode } from 'react'
import { t } from '../../../../../lib/i18n'
import { meta } from './page.meta'

// The notes route's loading UI. A `loading.tsx` is the App Router's own way of wrapping the
// segment in a Suspense boundary — the shell (the org nav, the heading, the composer's slot)
// streams immediately and only this region waits, which is the difference between a page that
// appears in 80ms and a page that appears when the slowest query finishes.
// SOURCE: https://nextjs.org/docs/app/api-reference/file-conventions/loading (loading.js
// creates a Suspense boundary around the segment and its children)
//
// The test id comes from `meta.states.loading`, not from a literal. That is the form the
// route-manifest gate names as the one that cannot drift: the id the registry DECLARES and the
// id this component RENDERS are the same expression, so they cannot be changed apart.
//
// Skeletons, never prose ("Loading…"), and they mirror the incoming layout: one composer-sized
// block and three card-sized rows, which is what apps/web/app/(protected)/o/[orgSlug]/notes
// resolves to. A spinner in the middle of an empty page tells the reader nothing about what is
// arriving; a shaped placeholder does, and it does not reflow when the content lands.
export default function NotesLoading(): ReactNode {
  return (
    // `<output>`, NOT a div with `role="status"` or `role="progressbar"` — and the divergence
    // from the mobile twin is the platform, not an inconsistency. Mobile paints Views, so
    // `role="progressbar"` on a View is the only way to say "loading" and the RNTL states sweep
    // asserts exactly that. HTML has an ELEMENT for a live region that reports a result, and
    // jsx-a11y's `prefer-tag-over-role` makes using it mandatory here (every a11y rule in this
    // repo is an error): a role attribute is a promise to assistive tech, while the element is
    // the thing itself, and only the element gets the browser's own behaviour.
    //
    // `<output>` carries an implicit polite `status` live region, so paired with `aria-busy` a
    // screen reader hears "loading notes" ONCE — each Skeleton is aria-hidden by construction
    // (see the primitive) rather than a screenful of announced empty boxes.
    // SOURCE: https://www.w3.org/TR/html-aria/ (ARIA in HTML — the output element's implicit
    // ARIA role is status)
    <output
      aria-busy="true"
      aria-label={t('notes.loading')}
      data-testid={meta.states.loading}
      className="mt-6 flex flex-col gap-6"
    >
      <Skeleton fullWidth height={92} rounded="lg" />
      <div className="flex flex-col gap-3">
        <Skeleton fullWidth height={64} rounded="lg" />
        <Skeleton fullWidth height={64} rounded="lg" />
        <Skeleton fullWidth height={64} rounded="lg" />
      </div>
    </output>
  )
}
