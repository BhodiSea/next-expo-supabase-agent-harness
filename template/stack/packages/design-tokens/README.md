# @app/design-tokens

The single source for every visual constant in the workspace: colour ramps in OKLCH, a
spacing ramp, a type ramp, radii, and the motion vocabulary. No React, no Tailwind, no
CSS, no react-native, no runtime dependencies at all.

## The token arrow

```
src/*.ts  (OKLCH colours, unitless ramps)          ← edit HERE, only here
    │
    ├── scripts/gen.mjs ──▶ src/generated/web.css     Tailwind v4 @theme block
    └── scripts/gen.mjs ──▶ src/generated/native.ts   the React Native theme object
```

One way. Both outputs are **generated and committed**, and both are regen-diffed:

| command | what it does |
| --- | --- |
| `pnpm --filter @app/design-tokens run gen` | rewrite both artifacts from the TypeScript source |
| `pnpm --filter @app/design-tokens run gen:check` | exit 2 if either committed artifact drifts |

`src/render.test.ts` asserts the same freshness on every `vitest` run, so a retuned
token that was never regenerated reds in the turn it was written rather than in CI an
hour later. **Never hand-edit a file under `src/generated/`** — it is a red gate, not a
design change.

## Why the direction matters

In the codebase this lineage descends from, the TypeScript token module was *derived
from* the stylesheet and a test asserted the mirror. That meant the CSS could be edited
freely and the "source" quietly followed. Here the stylesheet is an artifact: editing it
fails.

## Why the two platforms cannot share more than numbers

Web is **Tailwind v4** (CSS-first `@theme`, no config file). Mobile is pinned to
**Tailwind v3** because NativeWind 4 requires it. A shared `tailwind.config` or a shared
CSS token file is not a design choice that was declined — it is structurally impossible
across those two majors. Sharing the *numbers*, one level up, is what actually works,
and it is why `@app/design-system` and `@app/design-system-native` share this package
and nothing else.

## Import surface

| specifier | what you get | who imports it |
| --- | --- | --- |
| `@app/design-tokens` | the OKLCH/unitless source + types + the OKLCH↔WCAG helpers | anything |
| `@app/design-tokens/client` | identical; the key exists so the mobile import wall has a name to allow | the mobile side |
| `@app/design-tokens/native` | the resolved **hex** theme, RN-shaped | `@app/design-system-native`, `apps/mobile` |
| `@app/design-tokens/web.css` | the Tailwind v4 `@theme` block | `apps/web` global stylesheet |

The two adapters are deliberately **not** re-exported from the barrel: they reuse the
source names (`ramps`, `radius`, `typeScale`) with platform-resolved values, so
flattening them together would give two different things the same name and let a web
component import mobile hex by accident — which typechecks perfectly and paints an
unthemed colour.

Web usage:

```css
@import "tailwindcss";
@import "@app/design-tokens/web.css";
```

## What is enforced, not assumed

- **Gamut.** Every ramp value must sit inside sRGB. An out-of-gamut OKLCH colour is a
  generator *failure*, never a clamp: the browser would gamut-map it, React Native
  would not, and every contrast number computed for it would describe a colour nobody
  sees.
- **Contrast.** `CONTRAST_CONTRACT` is computed per theme before a single byte is
  emitted. The primary reading pairs (`ink` on `canvas`, `ink` on `surface`) carry the
  AAA 7:1 bar in *both* themes; muted text, the accent and the status hues carry AA
  4.5:1 deliberately — pushing them to 7 collapses the muted/primary distinction that
  makes a dense screen readable.
- **Determinism.** Every loop in the renderers walks a canonical `ORDER` array exported
  by the token modules, never `Object.keys()`, so the emitted bytes cannot depend on
  object key ordering.

## Shape of the colour system

Four ramps (`neutral` hue 240, `accent` 200, `danger` 25, `success` 150) over eleven
shared lightness steps, and eight semantic tokens — `canvas`, `surface`, `edge`, `ink`,
`ink-muted`, `accent`, `danger`, `success` — each of which resolves to an actual ramp
step, never a bespoke value.

There is deliberately **no on-accent ink token**: the accent is a tint (borders, focus
rings, links), never a fill sitting behind text. That one rule is why the contrast
contract is ten pairs instead of twenty, and why no screen can produce an unreadable
accent button.

`edge` carries no contrast pair on purpose — it divides two filled surfaces. The
control-boundary role (WCAG SC 1.4.11, 3:1) is filled by `ink-muted`, which already
clears 4.5, and that is why input borders use `ink-muted` at rest.
