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

| Layer | Covers | Does NOT cover | Why | Compensated by | Target |
|---|---|---|---|---|---|
| vitest unit + aggregate coverage | `packages/**/src`, an explicit file list of pure `apps/mobile` modules | `apps/web` (`app/`, `lib/`), `apps/mobile` component/screen code | The root config declares two projects, `unit-node` and `rls`; neither includes `apps/web`. React-native components cannot run under vitest without a transform pipeline the determinism doctrine refuses. | `mobile-unit` | 0.4.0 |
| jest-expo unit + coverage | `apps/mobile` components/screens | `apps/web` | jest-expo is the RN runner; it has no reason to know about Next. | `web-e2e` | 0.4.0 |
| diff-coverage per-file floors | `apps/*/src`, `packages/*/src` (over the MERGED istanbul maps) | `apps/web` — its code lives in `app/` and `lib/`, which `SRC_RE` does not match | Widening `SRC_RE` without the unit lane produces a gate with **no green path**: no runner measures `apps/web`, so every changed web file reports 0%, and the only edit that restores green is lowering the floors — the harness reward-hacking its own bar. 0.3.0 ships the dated decision; 0.4.0 ships the machinery. | `web-e2e` | 0.4.0 |
| duplication (token clone detector) | `apps/*/src`, `packages/*/src` | `apps/web` (`app/`, `lib/`) | Same `src/` assumption as diff-coverage; the scan roots are built from `apps/*/src` and `packages/*/src`. | `lint` | 0.4.0 |
| mutation ratchet | `packages/api/src`, `packages/platform/{supabase,errors}/src`, `packages/verticals/*/src` | `apps/web`, `apps/mobile`, `packages/contracts/src`, the design packages | Mutating React rendering yields survivors that are style, not behaviour. Contract DTOs are declarations `tsc` and the regen-diff already kill. | `web-e2e` | — |
| a11y lint (every rule an error) | `apps/mobile` (react-native-a11y) | `apps/web` | The RN a11y plugin does not understand DOM semantics; the web equivalent is `jsx-a11y`, which is not installed. | `web-e2e` | 0.4.0 |
| RLS isolation suite | the database, for both surfaces at once | — | RLS is one boundary reached identically by web and mobile; there is nothing surface-specific to miss. | `rls-isolation` | — |
| device perf + Maestro flows | `apps/mobile` | `apps/web` | Cold-start and frame budgets are native-runtime properties. Web performance is a different measurement with different instruments. | `perf-lane` | — |

## What this table does NOT do

It does not stop the next one-surface gate from being written. Making a gate author DECLARE
their surface — a coverage closure that reds a new `check-*.mjs` with no row here — is a
factory-side control (it belongs where new gate scripts are actually authored, not as chain
step 32), and it is **0.4.0**.
