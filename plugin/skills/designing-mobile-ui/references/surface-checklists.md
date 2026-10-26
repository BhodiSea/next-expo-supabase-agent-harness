# Surface checklists — "default beautiful", bottoming out in gates

Each checklist ends in the deterministic hooks that already exist — the last
line of every list is machine-checked, so a finished surface is one where the
taste items are done and the gate items were never violated.

## 1. List screen (worked pattern: matrix)

- [ ] One title (`variant="title"`), summary line in `muted` when counts help.
- [ ] Rows: fixed height where the list is dense (share the constant with
      `getItemLayout`), one accessible element per row, `tabular-nums` on
      numeric cells, dense font-scale cap on fixed-height text.
- [ ] Pagination is visible AND reachable: the near-end trigger plus an
      explicit Load-more control; the in-flight page shows an inline Spinner
      beside the disabled control.
- [ ] Pull-to-refresh wired to the same reload the header button runs.
- [ ] Machine floor: route registered with states, Maestro flow + startup row
      (mobile-perf closure), perfSubject if dense, virtualization tuned.

## 2. Form (worked pattern: NoteComposer)

- [ ] Every control renders through Field + Input; the label is the accessible
      name; errors arrive inline through Field's three channels.
- [ ] The screen sets `keyboard` on Screen; taps land while the keyboard is up
      (`keyboardShouldPersistTaps`); return-key submits.
- [ ] Submit is optimistic where the write shape allows it; pending relabels
      from the catalog and keeps width; failure keeps the draft.
- [ ] Machine floor: zod validation at the contract boundary, i18n keys for
      every string, diff-coverage on the reducer.

## 3. Modal / palette (worked pattern: actions modal)

- [ ] Opens focused on its input; the list re-ranks as the user types; recents
      pin only on the empty query.
- [ ] Rows through OptionRow (selection haptic + chevron affordance for free);
      running a command closes the modal FIRST, then acts.
- [ ] A no-match state that names the query problem, not just "empty".
- [ ] Machine floor: registry-typed commands (a group is a compile error to
      omit), states registered, the sweep drives empty.

## 4. Detail / read surface

- [ ] Hierarchy: title → body → secondary facts, one variant each; muted
      timestamps phrased by the locale (formatRelativeTime — never hand-rolled
      "N ago").
- [ ] Content cards through Card; depth only when the surface genuinely sits
      above its context (`elevated`).
- [ ] Machine floor: tokens-only styling, status surfaces carry status tokens.

## 5. Empty state

- [ ] EmptyState primitive: headline names the place, description is ONE
      sentence, CTA starts the next action.
- [ ] Filter-empties differ from nothing-exists-empties in copy.
- [ ] Machine floor: the state's testID registered and swept.

## 6. Settings / options rows

- [ ] OptionRow per choice — label is the whole accessible name; destructive
      choices carry the destructive confirm pattern and live LAST in their
      group.
- [ ] Section headers are `label` variant with the group-gap above them.
- [ ] Machine floor: 44dp targets (the base primitive), selection haptics,
      i18n keys.

## Every surface, always

- [ ] Both themes checked; accent spent at most once; no raw literals
      anywhere (the gate would tell you, but design against it, not into it).
- [ ] Motion only through the seam; nothing animates layout; reduce-motion
      collapse inherited, not re-implemented.
- [ ] testIDs on interactive/accessible LEAF elements (Fabric flattening).
- [ ] Finish with the `design-reviewer` subagent → `PASS`, and
      `accessibility-reviewer` on the same diff.
