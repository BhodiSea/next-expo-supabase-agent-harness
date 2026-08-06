# Enforcement tiers — where each layer stops, and what stands in for it

**A tier is legitimate. An undeclared tier the docs deny is not.**

Several enforcement layers in this harness cover one product surface and not the other.
That is a defensible engineering position — react-native code does not run under vitest
without a fragile transform pipeline, `apps/web` has no `src/` directory, a plan probe
cannot be run against four rows — and each one is stated here with its reason.

What was NOT defensible until 0.3.0 is that three files said otherwise:

- `apps/web/vitest.config.ts` opened with "The root config lists this directory in its
  `projects` array". It does not: the root config declares exactly two projects,
  `unit-node` and `rls`. `pnpm --filter web test` loads the web config directly; a plain
  `pnpm test` never does.
- The root `vitest.config.ts` header described `unit-node` as covering "apps/web's non-DOM
  modules", which its `include` list does not contain: the globs are `packages/*/src/**`,
  `packages/*/*/src/**` and an explicit file list of pure `apps/mobile` modules.
- The `diff-coverage` gate is described as holding "per-file floors on every CHANGED source
  file". Its `SRC_RE` is `^(?:apps|packages)/[^/]+/src/`, and `apps/web` has `app/` and
  `lib/` — so the claim is overstated for half the product.

This file is the honest version. It is named **enforcement-tiers**, deliberately not
*surface parity*: `PARITY.md` and the `parity` gate own that phrase, and they are about the
PRODUCT surface (every action reachable on both web and mobile). This is about the
ENFORCEMENT surface, which is a different question with a different answer.

## The rule this table is held to

Every row carries all five fields, and `Compensated by` must name a **live** step in
`tools/harness.config.mjs` (`VALIDATE_STEPS` or `STOP_HOOK_STEPS`) or a **job** in
`.github/workflows/quality-gate.yml`. The `docs-sync` gate asserts both, because *a
compensating control nobody runs is not a control* — that is exactly the class of claim
this release exists to delete, and this table would be the easiest place to reintroduce it.

`Target` is the release the gap is scheduled to close in, and it is a commitment, not a
wish: the row stays until the machinery lands.

## Tiers

`Gate` is the machine-readable key: a step name in `tools/harness.config.mjs`, or the
`check-*.mjs` basename for a layer that is not a chain step. `scripts/check-tier-coverage.mjs`
reads this column — a shipped gate that hard-codes a single-surface scan root and has no row
here is a red, which is what makes "declare your surface" a control rather than a habit.

| Gate | Layer | Covers | Does NOT cover | Why | Compensated by | Target |
|---|---|---|---|---|---|---|
| `unit` | vitest unit + aggregate coverage | `packages/**/src`, `apps/web/lib`, an explicit file list of pure `apps/mobile` modules | `apps/web/app`, `apps/mobile` component/screen code | 0.4.0 added the `web-unit` project, so `apps/web/lib` is measured. `app/` stays out: Server Components, Server Actions and route handlers are proved by a real browser, and counting eighteen unrunnable files as 0% would force the floors down. React-native components cannot run under vitest without a transform pipeline the determinism doctrine refuses. | `web-e2e`, `mobile-unit` | — |
| `mobile-unit` | jest-expo unit + coverage | `apps/mobile` components/screens | `apps/web` | jest-expo is the RN runner; it has no reason to know about Next. Its `collectCoverageFrom` is rooted at `apps/mobile`, so it never attributes a package file either. | `unit`, `web-e2e` | — |
| `diff-coverage` | per-file coverage floors | `apps/*/src`, `apps/web/lib`, `packages/*/src`, `packages/*/*/src` (over the MERGED istanbul maps) | `apps/web/app`, the design-system packages | 0.4.0 corrected `SRC_RE` twice: it never matched the LAYERED packages (`platform/*`, `verticals/*`), and `apps/web` has no `src/`. What it still must not match is a path no runner measures — a file this gate demands coverage for but nothing measures reports 0% with no green path. | `web-e2e` | — |
| `duplication` | token clone detector | `apps/*/src`, `apps/web/{app,lib}`, `packages/*/src`, `packages/*/*/src` | generated files (`*.gen.*`, `generated/`, `database.types.ts`) | Same two corrections as `diff-coverage`, plus generated modules are excluded by construction: they RESTATE their source, so scanning them reports the generator's output as a clone of its input. | — | — |
| `check-mutation-ratchet.mjs` | mutation ratchet | `packages/api/src`, `packages/platform/{supabase,errors}/src`, `packages/verticals/*/src` | `apps/web`, `apps/mobile`, `packages/contracts/src`, the design packages | Mutating React rendering yields survivors that are style, not behaviour. Contract DTOs are declarations `tsc` and the regen-diff already kill. | `web-e2e` | — |
| `lint` | a11y lint (every rule an error) | `apps/mobile` (react-native-a11y), `apps/web` (jsx-a11y) | painted contrast, focus order, screen-reader output | 0.4.0 installed `jsx-a11y` for the web half. Both halves are STATIC: neither computes contrast against real pixels nor hears what a screen reader announces. | `web-e2e` (axe), `styleguide` (OKLCH contrast) | — |
| `rls-isolation` | RLS isolation suite | the database, for both surfaces at once | — | RLS is one boundary reached identically by web and mobile; there is nothing surface-specific to miss. | — | — |
| `perf-lane` | device perf + Maestro flows | `apps/mobile` | `apps/web` | Cold-start and frame budgets are native-runtime properties. Web performance is a different measurement with different instruments. | — | — |
| `i18n` | the locale seam | `apps/mobile/src` | `apps/web` | **Declared in 0.4.0**, when `check-tier-coverage.mjs` first looked. `SRC = 'apps/mobile/src'` — the web app has no catalog seam and no `Intl` confinement, so a hardcoded user-facing string in a Server Component is caught by nothing. The web half needs a catalog decision (next-intl vs the same hand-rolled seam) before a gate can judge it. | `web-e2e` | 0.5.0 |
| `route-manifest` | route ↔ screen closure | `apps/mobile/app` + `src/routes.ts` | `apps/web/app` | **Declared in 0.4.0.** The manifest is `apps/mobile/src/routes.ts`; the App Router has no equivalent registry, so a web page can land with no id, no title key and no declared loading/empty/error states. | `web-e2e` | 0.5.0 |
| `perf-budget` | render budgets + effect-cleanup leak scan | `apps/mobile/{src,app}` | `apps/web` | **Declared in 0.4.0.** `SCAN_ROOTS` is mobile-only. The leak scan is framework-shaped (RN listener pairs) and web performance wants different instruments (Core Web Vitals in a browser), so this is a genuinely different measurement rather than a missing half. | `web-e2e` | — |
| `build` | bundle purity + byte budgets | `apps/mobile` | `apps/web` | **Declared in 0.4.0.** `const APP = 'apps/mobile'`, so the impure-import scan and the gzip ratchet never see the web bundle. A web equivalent needs a `next build` in the chain, which is minutes, not seconds. | `web-e2e` | 0.5.0 |
| `expo-policy` | the resolved native config (ATS, permissions, plugins, identity) | `apps/mobile` | `apps/web` | **Declared in 0.4.0.** Single-surface BY NATURE, not by omission: ATS exception domains, Android permission strings and config plugins are properties of a native binary. There is no web counterpart to owe. | — | — |
| `native-deps` | Expo dependency floor + CNG purity | `apps/mobile` | `apps/web` | **Declared in 0.4.0.** Same reason as `expo-policy` — `expo install --check` judges a native dependency graph the web app does not have. | — | — |
| `version-sync` | store/runtime version lockstep | `apps/mobile` (+ `app.config.ts`, `eas.json`) | `apps/web` | **Declared in 0.4.0.** `apps/web` is deliberately EXCLUDED from build-number lockstep (a web deploy has no store version); it is bounded instead by the major-agreement check against `@app/api`, which this gate also performs. So the exclusion is a decision, not a gap. | — | — |
| `mobile-perf` | startup-budget + Maestro flow closure | `apps/mobile/src/routes.ts` | `apps/web` | **Declared in 0.4.0.** Cold-start time is a native-runtime property; the web equivalent is Core Web Vitals in a browser, a different instrument on a different lane. | `web-e2e` | — |
| `security-headers` | the web response posture, by value | `apps/web/lib/security-headers.ts` | `apps/mobile` | **Declared in 0.4.0.** Single-surface by nature in the other direction: CSP, HSTS and framing control are HTTP response semantics. The mobile transport posture is `expo-policy`'s ATS/cleartext half. | `expo-policy` | — |
| `rate-limits` | the rate-limit budget, by value | `apps/web/{app/actions,lib/rate-limit.ts}` | direct PostgREST calls, GoTrue sign-in/sign-up | **Declared in 0.4.0.** It binds the two APPLICATION seams; a client hitting PostgREST with its own JWT reaches neither. That loss is already recorded in the gates-catalog and README; this row is where the SURFACE half is stated. The controls that bind every path are the per-org quota trigger and the per-role statement timeouts. | `db-limits` | — |
| `check-web-e2e.mjs` | the browser lane's closure + invocation | `apps/web` | `apps/mobile` | **Declared in 0.4.0.** A lane runner, not a chain gate. Its mobile twin is `check-e2e-device.mjs`. Path-filtered in CI, so it does not run on a mobile-only PR — which is why the static halves (`lint` jsx-a11y, `unit`) matter. | `check-e2e-device.mjs` | — |
| `check-e2e-device.mjs` | the Maestro device sweep | `apps/mobile/src/routes.ts` | `apps/web` | **Declared in 0.4.0.** The mobile twin of `check-web-e2e.mjs`; schedule- and dispatch-gated, so it is proven nightly rather than per-commit. | `check-web-e2e.mjs` | — |
| `styleguide` | token regen-diff + raw-value scan | `packages/design-tokens`, `apps/mobile/{src,app}` | `apps/web` | **Declared in 0.4.0.** The token regen-diff covers BOTH surfaces (one OKLCH source compiles to `native.ts` and `web.css`); only the raw-value source scan is mobile-only, because Tailwind utility classes are not colour literals and the browser axe sweep judges the painted result. | `web-e2e` | — |

## What this table does NOT do

It does not stop the next one-surface gate from being written — but as of **0.4.0** it does
stop one from being written SILENTLY. `scripts/check-tier-coverage.mjs` is the closure this
section used to promise: it reads every shipped `template/base/tools/check-*.mjs`, finds the
ones that hard-code a single-surface scan root, and reds when one has no row above. It is a
factory-side control, because that is where gate scripts are actually authored — not chain
step 32, which would ask a consumer to answer for a decision the harness made.

The control earned its keep on the release that shipped it. Five layers — `i18n`,
`route-manifest`, `perf-budget`, `build`, `styleguide` — were mobile-only and in no row,
which is precisely the state this file's opening line calls illegitimate. They are declared
above now, with targets where a web half is genuinely owed and `—` where the measurement is
honestly different.
