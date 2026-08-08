import { describe, expect, it } from 'vitest'
import { en } from '../lib/i18n/catalog'
import { WEB_ROUTES } from '../lib/routes.generated'

// The registry's closure test — the cheap, always-on precursor of the `route-manifest` gate's
// web half, and the mirror of apps/mobile/src/routes.test.ts.
//
// It overlaps the gate ON PURPOSE, and the overlap is not duplication: the gate runs in the
// chain and in CI, and this runs in the unit lane on every `pnpm test`, which is the loop a
// developer is actually inside while moving a route. A closure that only reports at gate time
// is a closure you learn about after you have finished.
//
// What it does NOT restate is anything the gate can see and this cannot. The gate reads the
// FILE TREE — whether a page has a meta at all, whether a declared test id is rendered in its
// segment, whether the committed registry is stale. Those need a filesystem walk. What lives
// here is what the TYPE SYSTEM plus the imported values can decide: that the registry is
// non-empty, and that every identity it hands the rest of the app is unique and resolvable.

describe('WEB_ROUTES', () => {
  it('is not empty', () => {
    // A vacuous registry would make every closure below pass while describing nothing — the
    // same reason the mobile gate reds on an empty ROUTES array.
    expect(WEB_ROUTES.length).toBeGreaterThan(0)
  })

  it('route ids are unique', () => {
    const ids = WEB_ROUTES.map((route) => route.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('URLs are unique — two pages cannot share one address', () => {
    // Route groups do not create distinct URLs, so two pages at the same position under
    // different groups are a build-time conflict rather than two routes.
    const paths = WEB_ROUTES.map((route) => route.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('every titleKey resolves in the catalog', () => {
    // A titleKey the catalog does not carry renders the KEY itself into the browser tab —
    // visible, but only to whoever looked.
    for (const route of WEB_ROUTES) {
      expect(Object.keys(en)).toContain(route.titleKey)
    }
  })

  it('every declared state test id is globally unique', () => {
    // A reused test id makes an e2e assertion pass against the wrong route's markup.
    const declared: string[] = WEB_ROUTES.flatMap((route) =>
      Object.values(route.states).filter((id) => id !== null),
    )
    expect(new Set(declared).size).toBe(declared.length)
  })

  it('every path is a canonical URL — leading slash, no trailing slash', () => {
    for (const route of WEB_ROUTES) {
      // WIDENED to string deliberately. WEB_ROUTES is `as const`, so `route.path` is a union of
      // the literal URLs this scaffold happens to ship — and comparing a literal union against
      // '/' is a TYPE error ("no overlap") the moment no route is the root. The assertion is
      // about the SHAPE every future path must hold, not about today's five.
      const path: string = route.path
      expect(path.startsWith('/')).toBe(true)
      expect(path === '/' || !path.endsWith('/')).toBe(true)
    }
  })
})
