---
paths:
  - "packages/**"
  - "apps/**"
---

# Boundaries & the single error channel (best-effort scoped; the gates are the invariant)

`paths:` scoping is best-effort — the hard walls live in the `boundaries` and
`architecture` gates, the ESLint `app-error-only` rule, and the tsc `exports` maps.
Never rely on this doc loading; rely on the gates.

SOURCE: docs/harness/README.md (boundaries + error-channel doctrine)

## One census, three consumers

`tools/exports-walls.json` is the SINGLE list of packages permitted a `./client`
subpath. It exists once because where it was copy-pasted per consumer it drifted and
the weakest copy silently won. Three consumers derive from it — the `check-exports-walls`
wall, the `check-workspace-deps` allow-matrix, and the dependency-cruiser barrel rules —
so edit the census (a `{{SECURITY_OWNERS}}` review), never a consumer.

- `.` is the SERVER barrel: `"use server"` leaves, the service-role client, Next-coupled
  imports. `./client` is the METRO-SAFE barrel: pure domain, zod, direct RLS reads.
- Metro does not tree-shake, so a `./client` added casually to a package that holds a
  server graph puts that graph one import from the shipped native binary. A package that
  handles elevated writes stays hardened to the single `.` key and is NOT added to the
  census; if it also needs a mobile surface, extract that surface into its own package.
- `@app/api` is deliberately ABSENT from the census: `apps/mobile` takes it as a
  devDependency and imports it `import type` only.

## The layering laws (enforced by `boundaries` + `architecture`)

- `verticals ⊥ verticals` — a feature domain never imports another; cross-feature calls
  go through the API, shared code goes to `packages/shared`.
- `shared ↛ verticals` — shared code is importable BY verticals, never the reverse.
- `platform/*` imports only the `{errors, events}` kernel (plus its own foundations).
- `packages/api ↛ next/*` — the reversibility wall: the router stays framework-neutral so
  it can be promoted to its own `apps/api` by moving one `route.ts`.
- `apps/mobile ↛ web-only packages` — no `@app/design-system` (DOM), no `react-dom`, no
  `next`; the mobile design system is `@app/design-system-native`.
- `apps/web ↛ react-native` — and no `@app/design-system-native`.
- `@app/errors` and `@app/events` are the BOTTOM of the graph (they import nothing) and
  are universally importable from either surface, census entry or not.

## The single error channel

Procedures (`@app/api`) and web Server Actions return ONE envelope on the DATA channel:
`ActionOutcome<T>` from `@app/errors`. A domain failure is a returned
`outcomeErr(appError.X())`, never a thrown error — throwing flattens the discriminated
`AppError` a screen switches on into an HTTP status, and "someone else deleted this note"
becomes "something went wrong". Exactly two things bypass the envelope, because both are
transport facts a handler could not produce: the auth middleware's UNAUTHORIZED and the
version-skew guard's CONFLICT. A `.input()` parse failure is the framework's, not yours.
The `app-error-only` ESLint rule is the static half of this doctrine.
