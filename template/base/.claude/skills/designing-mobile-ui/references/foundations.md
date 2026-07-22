# Foundations — typography, spacing, color, depth

Every value below is a TOKEN with a ROLE. The styleguide gate bans the raw
literal; this file says which token plays which part.

## Typography roles (typeScale + fontWeight, via AppText variants)

- **One title per screen.** `AppText variant="title"` (xl/semibold) names the
  screen, once, at the top. A second title-sized run on the same screen is a
  hierarchy bug, not emphasis.
- **Section headers** are `variant="label"` (sm/medium) — quiet, structural,
  usually above a group of rows (the actions modal's group headers are the
  worked pattern).
- **Body** is `variant="body"` (base/normal): anything the user actually
  reads. **Secondary** facts (timestamps, counts, hints) are
  `variant="muted"` — smaller AND lower-contrast, two signals saying the same
  thing.
- **Failure copy** is `variant="danger"` — status ink plus medium weight, so
  an error reads differently even before color arrives (color is a redundant
  channel, never the only one).
- Two adjacent text runs must never carry the same role by accident: if they
  read as one run, merge them; if they are different kinds of fact, give them
  different variants. Numeric columns use `fontVariant: ['tabular-nums']`
  (the matrix cells) so digits never jitter.
- Never disable font scaling. Caps are tokens: AppText applies
  `fontScaleCap.default` (2×); fixed-height rows pass
  `maxFontSizeMultiplier={fontScaleCap.dense}` (1.3×) — see MatrixList.

## Spacing rhythm (the base-4 grid)

- Every gap/padding/margin is `spacing * n`. Pick n by relationship, not eye:
  **1–2** inside a control or between a label and its value; **2–3** between
  siblings in a group (rows in a list, fields in a form); **3–4** between
  GROUPS (the Screen gutter is `spacing * 4`, its stack gap `spacing * 3`).
- The Screen primitive owns the outer gutter — content never adds its own
  screen-edge padding on top of it.
- When two spacings look interchangeable, choose the SMALLER one between
  related things and the LARGER one between unrelated things: rhythm comes
  from contrast between the two, not from the absolute values.

## Color discipline (near-monochrome + one accent)

- Surfaces are `canvas` (the screen) and `surface` (things sitting on it);
  `edge` draws every border. Ink is `ink` / `ink-muted`. That is the whole
  neutral vocabulary — a new gray is a manifest conversation.
- **One accent moment per region.** The accent exists to say "this is the one
  thing here" (the primary Button's border, the active tab). The styleguide
  gate budgets total accent references (`accentUsageBudget`); spend them like
  money. Status hues (`danger`/`success`) are not accents — they are meaning,
  and they never substitute for the accent.
- Both themes always: every factory takes the palette; check any new surface
  mentally against dark AND light (dark is the design base and the launch
  frame).

## Depth and shape

- Radii by role: `radius.sm` for controls (Button, Input, rows), `radius.md`
  for containers (Card, error boxes, toasts), `radius.lg` for large detached
  surfaces. Never mix roles on one element class.
- Depth is SPREAD, not spelled: `{ ...elevation.raised }` lifts a card,
  `elevation.overlay` floats a toast/modal. The shadow keys themselves live
  only in the generated tokens module (gate-enforced). In dark themes the
  `edge` border stays the primary separator — elevation is an additive
  channel, not a replacement.
- Cards render through the `Card` primitive (tone drives the status border;
  `elevated` opts into depth). A hand-built bordered View is a fork.

## Iconography

- Icons come from the closed glyph set (`src/components/icons/Icon.tsx`),
  sized by the `sizes.icon` tokens, toned by palette token name, decorative by
  construction (the adjacent text carries the meaning). Growing the vocabulary
  = adding a named glyph in that file, in review — never a second icon idiom.
