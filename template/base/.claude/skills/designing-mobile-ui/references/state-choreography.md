# State choreography — loading, empty, error, optimistic writes

Every route registers `states.{loading,empty,error}` testIDs in
`src/routes.ts` and the e2e states sweep drives all three. This file is how
each state should BEHAVE.

## Loading: skeleton → content, no shift

- Loading is never prose. Render the `Skeleton` primitive (or `Spinner` for
  in-place waits too small for a block) — the states sweep asserts the loading
  surface announces as a progressbar.
- **The skeleton mirrors the layout it is standing in for.** Size `lines` to
  the content shape (the matrix screen uses 6 dense lines; notes uses the
  default 3) so arrival replaces pixels instead of reflowing them. If content
  arrival visibly shifts layout, the skeleton is wrong, not the content.
- The pulse comes from the seam and collapses under reduce-motion for free —
  never hand-animate a placeholder.
- In-flight refinements (pull-to-refresh, load-more) keep the EXISTING content
  visible: the RefreshControl/inline Spinner is the indicator, never a screen
  blank-out. Full-surface skeletons are for the FIRST load only.

## Empty: propose the next action

- Empty states render through `EmptyState` — headline (what this place is),
  one sentence of description, and a CTA that starts the obvious next thing
  ("Try again" / "Create a note"). A bare "No data" is a dead end, and a
  dead end is a design bug.
- An empty state after a FILTER (no search matches) says so and how to widen —
  it is a different sentence than "nothing exists yet" (the actions modal's
  no-match copy is the worked pattern).

## Error: keep the retry, keep the receipt

- Errors render in a `Card tone="danger"` (the failure surface must never be
  the same box as a neutral one) and the surface CONTAINS its retry — the
  route-manifest contract, and the states sweep proves the retry recovers.
- Three registers, in order (NotesPanel is the worked pattern): WHAT failed
  (catalog copy), WHY (catalog copy selected by the envelope's stable `code`),
  then the raw failure text + request id — quiet, muted, last. The receipt is
  what turns "it failed" into a support ticket someone can act on.
- `role="alert"` on the WHY line announces the failure; the styleguide gate
  requires a status token on any announcing surface.

## Writes: optimistic, reconciled, never phantom

- Follow `features/notes` (useCreateNote): insert the optimistic row at the
  head with a temp id and the pending look (dashed edge + muted ink — never
  an opacity fade that dips under AA), reconcile-or-rollback in ONE reducer,
  and surface failures as envelope-code toasts. A failed write leaves NO
  phantom row and keeps the user's draft so they retry without retyping.
- Pending buttons relabel from the catalog ("Adding…") and disable — the
  relabel IS the accessible pending announcement. Keep the button's width
  stable while it swaps.
- Destructive actions take a native confirm (two steps, the second explicitly
  destructive — the account-deletion command is the worked pattern), do the
  server work FIRST, and only then drop local state; a failure keeps the
  world consistent.

## Toasts

- Toasts are for outcomes the user must not miss, not narration. `error` tone
  for lost writes (it interrupts AT and fires the warning haptic), `success`
  only when the user needs the confirmation to proceed, `info` rarely. The
  message carries the meaning; tone adds border, glyph, haptic — redundant
  channels, all of them.
