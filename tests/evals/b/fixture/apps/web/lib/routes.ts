// The web route registry's TYPES. Values live in ./routes.generated.ts, which
// tools/gen-web-routes.mjs writes and the `route-manifest` gate regen-diffs.
//
// WHY THE WEB HALF IS GENERATED AND THE MOBILE HALF IS HAND-AUTHORED. The mobile manifest
// (apps/mobile/src/routes.ts) declares `path` and `file` by hand, and check-route-manifest.mjs
// re-derives both from expo-router's rules to catch a manifest that lies about how a screen is
// reached. That check exists because a hand-authored field CAN disagree with the router. Here
// it cannot: the generator reads the App Router's own file tree, derives `path` and `file`
// from position, and writes them. There is no spelling of this registry in which the URL is
// wrong — the class of defect the mobile gate spends thirty lines catching is absent by
// construction.
//
// So what an AUTHOR writes is only what position cannot tell you: the stable id, the catalog
// key for the title, and the test ids the three canonical data states expose. Those live in a
// `page.meta.ts` colocated with the `page.tsx` they describe.
//
// WHY `page.meta.ts` AND NOT `route.meta.ts`. `route.ts` is the App Router's Route Handler
// convention and this tree already ships two (`app/api/trpc/[trpc]/route.ts`,
// `app/api/csp-report/route.ts`). A file named `route.meta.ts` sitting beside a `page.tsx`
// would read as "metadata for a route handler" in a codebase where `route.*` already means
// something else. `page.meta.ts` pairs with the file it describes and collides with nothing.
// Next matches route files by EXACT basename (`page`, `layout`, `route`, `loading`, `error`,
// `not-found`, `template`, `default`), so a colocated `page.meta.ts` is never itself a route.
// SOURCE: https://nextjs.org/docs/app/api-reference/file-conventions/page (exact-basename
// route files; colocation of other files inside app/ is supported)
import type { MessageKey } from './i18n/catalog'

/**
 * The test ids a route's three canonical data states expose — the same contract the mobile
 * manifest declares, so one product does not need two mental models for "what states does
 * this screen have".
 *
 * `null` is the HONEST form for a state a route provably cannot enter, and it is legal ONLY
 * with a reviewed {route, state, reason} row in tools/web-route-allowlist.json. A fabricated
 * spinner would satisfy a dumber gate; a documented null satisfies this one.
 *
 * Not exported: it is reachable as `WebRouteMeta['states']`, and exporting a name nothing
 * imports is what `knip --strict` calls dead — correctly.
 */
interface WebRouteStates {
  /** testID rendered while the segment's data is in flight — usually its `loading.tsx`. */
  readonly loading: string | null
  /** testID rendered when the query resolves to zero rows. */
  readonly empty: string | null
  /** testID rendered when the query fails. */
  readonly error: string | null
}

/** What an author writes, in a `page.meta.ts` beside the `page.tsx` it describes. */
export interface WebRouteMeta {
  /** Stable machine id — lowercase [a-z0-9-], used in test titles and state test ids. */
  readonly id: string
  /** Catalog key for the human title. A KEY, not prose — render with t(). */
  readonly titleKey: MessageKey
  readonly states: WebRouteStates
}

/** A registry entry: the authored meta plus the two facts POSITION decides. */
export interface WebRouteEntry extends WebRouteMeta {
  /** The URL the App Router serves this page at — `(group)` elided, `[p]` as `:p`. */
  readonly path: string
  /** The app/-relative page module, extension omitted (e.g. `(protected)/o/page`). */
  readonly file: string
}
