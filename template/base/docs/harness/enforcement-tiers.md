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
`tools/harness.config.mjs` (`VALIDATE_STEPS` or `STOP_HOOK_STEPS`), a **job** in any
workflow under `.github/workflows/`, or a **gate script** a workflow invokes. The
`docs-sync` gate asserts it, because *a compensating control nobody runs is not a control*
— that is exactly the class of claim this release exists to delete, and this table would be
the easiest place to reintroduce it.

**Three of those words were doing less work than they looked like, and 0.5.0 fixed each.**

- *any workflow.* The check resolved against one hard-coded `quality-gate.yml` while
  **nine** ship, so a row compensated by `gitleaks` or `scan-pr` resolved to nothing. Same
  defect `check-canary-coverage.mjs` corrected in 0.3.0; the derivation is now shared
  (`tools/lib/live-controls.mjs`) rather than written a third time.
- *live.* `web-e2e`, `perf-lane`, `mobile-e2e`, `native` and `db-scale` are **path-filtered**
  — they do not run on a PR that misses their paths, and `tools/ci/summarize-gate.mjs`
  deliberately greens over a skipped lane after naming it. "This control exists" and "this
  control ran on this commit" are different claims, and eleven rows were making the second
  while the check verified the first. A chain gate runs on a laptop and cannot ask which
  lanes ran; what it can do is read the workflow, tell a conditional job from an
  unconditional one, and **require a row whose only compensating controls are conditional to
  say `(path-filtered)`**. Nine rows now do. That is a smaller claim than the table used to
  make, and it is the true one.
- *gate script.* Two rows name a script (`check-e2e-device.mjs`) rather than a step or a
  job. The cell parser matched kebab names only, so those two cells resolved to the empty
  set and were exempt from the whole check — an exemption nobody chose, in the one table
  whose subject is exactly that.

`Target` is the release the gap is scheduled to close in, and it is a commitment, not a
wish: the row stays until the machinery lands. **As of 0.5.0 something reads this column.**
When an install's `harnessVersion` reaches a row's `Target`, `docs-sync` re-derives whether
that gate still hard-codes a single product surface — the identical derivation
`scripts/check-tier-coverage.mjs` uses to demand the row — and reds if it does. `—` is a
legitimate answer meaning no other half is owed, justified by the `Why` cell; it is not a
missing commitment. Moving a date is the other legitimate answer, and because this file is
harness-owned and sha-pinned by `gate-integrity`, moving one is a reviewed diff rather than
a flag. Three rows carried `Target 0.5.0` and nothing read the column: `build`'s purity half
was discharged, and `i18n` and `route-manifest` were moved to 0.6.0 in the diff that shipped
the check — the mechanism extending its own deadline, which is the point.

## Tiers

`Gate` is the machine-readable key: a step name in `tools/harness.config.mjs`, or the
`check-*.mjs` basename for a layer that is not a chain step. `scripts/check-tier-coverage.mjs`
reads this column — a shipped gate that hard-codes a single-surface scan root and has no row
here is a red, which is what makes "declare your surface" a control rather than a habit.

| Gate | Layer | Covers | Does NOT cover | Why | Compensated by | Target |
|---|---|---|---|---|---|---|
| `unit` | vitest unit + aggregate coverage | `packages/**/src`, `apps/web/lib`, an explicit file list of pure `apps/mobile` modules | `apps/web/app`, `apps/mobile` component/screen code | 0.4.0 added the `web-unit` project, so `apps/web/lib` is measured. `app/` stays out: Server Components, Server Actions and route handlers are proved by a real browser, and counting eighteen unrunnable files as 0% would force the floors down. React-native components cannot run under vitest without a transform pipeline the determinism doctrine refuses. | `web-e2e` (path-filtered), `mobile-unit` | — |
| `mobile-unit` | jest-expo unit + coverage | `apps/mobile` components/screens | `apps/web` | jest-expo is the RN runner; it has no reason to know about Next. Its `collectCoverageFrom` is rooted at `apps/mobile`, so it never attributes a package file either. | `unit`, `web-e2e` (path-filtered) | — |
| `diff-coverage` | per-file coverage floors | `apps/*/src`, `apps/web/lib`, `packages/*/src`, `packages/*/*/src` (over the MERGED istanbul maps) | `apps/web/app`, the design-system packages | 0.4.0 corrected `SRC_RE` twice: it never matched the LAYERED packages (`platform/*`, `verticals/*`), and `apps/web` has no `src/`. What it still must not match is a path no runner measures — a file this gate demands coverage for but nothing measures reports 0% with no green path. | `web-e2e` (path-filtered) | — |
| `duplication` | token clone detector | `apps/*/src`, `apps/web/{app,lib}`, `packages/*/src`, `packages/*/*/src` | generated files (`*.gen.*`, `generated/`, `database.types.ts`) | Same two corrections as `diff-coverage`, plus generated modules are excluded by construction: they RESTATE their source, so scanning them reports the generator's output as a clone of its input. | — | — |
| `check-mutation-ratchet.mjs` | mutation ratchet | `packages/api/src`, `packages/platform/{supabase,errors}/src`, `packages/verticals/*/src` | `apps/web`, `apps/mobile`, `packages/contracts/src`, the design packages | Mutating React rendering yields survivors that are style, not behaviour. Contract DTOs are declarations `tsc` and the regen-diff already kill. | `web-e2e` (path-filtered) | — |
| `lint` | a11y lint (every rule an error) | `apps/mobile` (react-native-a11y), `apps/web` (jsx-a11y) | painted contrast, focus order, screen-reader output; **anything behind a design-system wrapper on the mobile half** | 0.4.0 installed `jsx-a11y` for the web half. Both halves are STATIC: neither computes contrast against real pixels nor hears what a screen reader announces. **0.6.0 measured the mobile half instead of assuming it**, because the EAA research made the size of the claim matter: `eslint-plugin-react-native-a11y` ships **14 rules**, **4 of which target props React Native no longer documents** — they can never fire, and a rule that cannot fire is a false green. The set covers the **syntactic half of one success criterion** (WCAG 4.1.2). And it resolves props on the JSX element it can see, so it **goes silent on `src/components` primitives** — which is the structure `AGENTS.md` MANDATES, so the required architecture defeats the rule. Stated rather than deferred: closing it needs an a11y contract at the primitive boundary, which is a design piece, not a config. Facts: `design/CONFORMANCE-FACTS.md` §6. | `web-e2e` (axe, path-filtered), `styleguide` (OKLCH contrast), the RNTL states sweep | — |
| `rls-isolation` | RLS isolation suite | the database, for both surfaces at once | — | RLS is one boundary reached identically by web and mobile; there is nothing surface-specific to miss. | — | — |
| `perf-lane` | device perf + Maestro flows | `apps/mobile` | `apps/web` | Cold-start and frame budgets are native-runtime properties. Web performance is a different measurement with different instruments. | — | — |
| `i18n` | the locale seam | `apps/mobile/src` + `apps/mobile/app`; `apps/web/lib` + `apps/web/app` | the @formatjs locale-data closure on the web half | **Declared in 0.4.0; DISCHARGED in 0.6.0.** The gate is surface-parameterised now (`SURFACES` in `check-i18n.mjs`): each surface owns its catalog, its `LOCALES` array and its own adoption state, and checks 1–3 run per surface. It was not a second scan root — `I18N_DIR`/`CATALOG`/`LOCALES_MODULE` were single-valued and mobile-derived, and one un-adopted surface used to `ok()` out of the whole gate. What stays mobile-only is check 4, and that is the RUNTIME differing rather than a half owed: Hermes ships no `Intl.PluralRules`/`RelativeTimeFormat`/`Locale`, so the mobile seam force-installs @formatjs polyfills plus per-language CLDR data and the gate holds that closure; Node and every browser ship full ICU, so running it on the web half would demand imports that must not exist. | `web-e2e` (path-filtered) | — |
| `route-manifest` | route ↔ screen closure | `apps/mobile/app` + `src/routes.ts`; `apps/web/app` + `lib/routes.generated.ts` | that a declared state test id is REACHED at runtime on the web half | **Declared in 0.4.0; DISCHARGED in 0.6.0.** The step now runs two scripts — `check-route-manifest.mjs` (expo-router) and `check-web-routes.mjs` (App Router) — the same shape `boundaries` has used since 0.1.x, because the two routers share no rule: expo-router maps a trailing `index` to its parent path and has no route groups, parallel routes, intercepting routes or private `_folder` exclusion, and the App Router has all four and no `index` convention. The web registry is GENERATED (`tools/gen-web-routes.mjs` walks the file tree; `path` and `file` are derived, never declared), so the class of defect the mobile gate spends thirty lines catching — a manifest that lies about the URL — cannot be written here. What remains uncovered is the runtime half: mobile has the RNTL states sweep driving every declared test id, and the web half has no equivalent, so `check-web-routes.mjs` proves STATICALLY that each declared id is rendered somewhere in its own segment instead. | `web-e2e` (path-filtered) | — |
| `perf-budget` | render budgets + effect-cleanup leak scan | `apps/mobile/{src,app}` | `apps/web` | **Declared in 0.4.0.** `SCAN_ROOTS` is mobile-only. The leak scan is framework-shaped (RN listener pairs) and web performance wants different instruments (Core Web Vitals in a browser), so this is a genuinely different measurement rather than a missing half. | `web-e2e` (path-filtered) | — |
| `build` | bundle purity (BOTH surfaces) + byte budgets | `apps/mobile` export; `apps/web/.next/static` client chunks | the web BYTE budgets; `apps/web/.next/server` | **Declared in 0.4.0 with `Target 0.5.0`; the purity half was DISCHARGED in 0.5.0** — `build-check.mjs --web` scans the client chunks a browser actually downloads for the same forbidden markers, in the path-filtered `web-build` job (a `next build` is minutes, not seconds, so it is a lane and not a chain step). `.next/server` is deliberately out: it legitimately contains the service-role factory and every server-only import, and a gate that reds on correct code gets deleted. Byte budgets stay mobile-only — the mobile ratchet measures a single Hermes bundle, and Next's per-route code-splitting makes "the bundle size" a different measurement that wants Core Web Vitals in a browser. | `web-build` (path-filtered), `perf-lane` (path-filtered) for the byte half | — |
| `expo-policy` | the resolved native config (ATS, permissions, plugins, identity) | `apps/mobile` | `apps/web` | **Declared in 0.4.0.** Single-surface BY NATURE, not by omission: ATS exception domains, Android permission strings and config plugins are properties of a native binary. There is no web counterpart to owe. | — | — |
| `native-deps` | Expo dependency floor + CNG purity | `apps/mobile` | `apps/web` | **Declared in 0.4.0.** Same reason as `expo-policy` — `expo install --check` judges a native dependency graph the web app does not have. | — | — |
| `version-sync` | store/runtime version lockstep | `apps/mobile` (+ `app.config.ts`, `eas.json`) | `apps/web`; an EAS build actually RUNNING the pinned image | **Declared in 0.4.0.** `apps/web` is deliberately EXCLUDED from build-number lockstep (a web deploy has no store version); it is bounded instead by the major-agreement check against `@app/api`, which this gate also performs. So the exclusion is a decision, not a gap. **The toolchain floor, a gap since 0.6.0, EXISTS as of 0.7.0.** Apple has required uploads to build against **Xcode 26 / iOS 26 SDK or later since 2026-04-28** — a fixed floor, not a moving "current SDK" requirement, and macOS is excluded. The reviewed floor is `tools/store-policy.json` `iosToolchain` and the gate resolves the production profile's `ios.image` through the `extends` chain: only a concrete pinned name is statically checkable (`-xcode-(\d+)` ≥ the floor), so `auto`, `latest`, `sdk-NN` and absent RED as unverifiable rather than read green. The template pins the concrete image `macos-tahoe-26.5-xcode-26.6` (the `sdk-57` alias's resolution on 2026-08-08 — a versioned name precisely so the alias's future movement cannot move the toolchain silently). Honest limit: **no lane runs an EAS build**, so an image name RETIRED upstream is invisible to the chain — the pin's freshness rides the consumer's next build, and the floor's rides review. Facts and sources: `design/CONFORMANCE-FACTS.md` §3. | — | 0.7.0 — closes: `tools/store-policy.json#iosToolchain` |
| `mobile-perf` | startup-budget + Maestro flow closure | `apps/mobile/src/routes.ts` | `apps/web` | **Declared in 0.4.0.** Cold-start time is a native-runtime property; the web equivalent is Core Web Vitals in a browser, a different instrument on a different lane. | `web-e2e` (path-filtered) | — |
| `e2e` | the jest-expo fast lane (screens, states sweep, primitives a11y) | `apps/mobile` — the whole RN suite, and since 0.9.0 the gate asserts `apps/mobile/__tests__/primitives-a11y.test.tsx` is PRESENT (the mobile mirror of `check-web-e2e.mjs`'s axe-scan-PRESENT rule), so deleting the a11y net reds instead of riding a green `Tests:` summary | `apps/web` | **Declared in 0.9.0**, when the anti-vacuity closure named the a11y suite by path and made the gate single-surface to this table's scanner — the coverage was always mobile-only by design: jest-expo is the RN runner, and the browser suite needs a real browser on a lane. | `web-e2e` (path-filtered) | — |
| `security-headers` | the web response posture, by value | `apps/web/lib/security-headers.ts` | `apps/mobile` | **Declared in 0.4.0.** Single-surface by nature in the other direction: CSP, HSTS and framing control are HTTP response semantics. The mobile transport posture is `expo-policy`'s ATS/cleartext half. | `expo-policy` | — |
| `rate-limits` | the rate-limit budget, by value | `apps/web/{app/actions,lib/rate-limit.ts}` | direct PostgREST calls, GoTrue sign-in/sign-up | **Declared in 0.4.0.** It binds the two APPLICATION seams; a client hitting PostgREST with its own JWT reaches neither. That loss is already recorded in the gates-catalog and README; this row is where the SURFACE half is stated. The controls that bind every path are the per-org quota trigger and the per-role statement timeouts. | `db-limits` | — |
| `check-web-e2e.mjs` | the browser lane's closure + invocation | `apps/web` | `apps/mobile` | **Declared in 0.4.0.** A lane runner, not a chain gate. Its mobile twin is `check-e2e-device.mjs`. Path-filtered in CI, so it does not run on a mobile-only PR — which is why the static halves (`lint` jsx-a11y, `unit`) matter. | `check-e2e-device.mjs` (path-filtered) | — |
| `check-e2e-device.mjs` | the Maestro device sweep | `apps/mobile/src/routes.ts` | `apps/web` | **Declared in 0.4.0.** The mobile twin of `check-web-e2e.mjs`; schedule- and dispatch-gated, so it is proven nightly rather than per-commit. | `check-web-e2e.mjs` (path-filtered) | — |
| `styleguide` | token regen-diff + raw-value scan | `packages/design-tokens`, `apps/mobile/{src,app}` | `apps/web` | **Declared in 0.4.0.** The token regen-diff covers BOTH surfaces (one OKLCH source compiles to `native.ts` and `web.css`); only the raw-value source scan is mobile-only, because Tailwind utility classes are not colour literals and the browser axe sweep judges the painted result. | `web-e2e` (path-filtered) | — |
| `observability` | the observability seam (vendor telemetry containment) | vendor telemetry SDK imports — static, side-effect, dynamic `import()` and `require()`, `npm:`/URL-normalized — under `apps/`, `packages/`, `supabase/functions/`, closed against the reviewed `tools/observability.json` `sinks[]` register both directions; each declared sink referencing its redaction symbol in code; the extend-only detector floor | that a vendor call's ARGUMENT flowed through the redaction pass (no call graph — the sink referencing the symbol is the bar); a vendor SDK reached via a transitive dependency; telemetry over raw `fetch()` to an ingest URL; test files | **Declared in 0.7.0, deferred MACHINE-HELD; DISCHARGED in 0.8.0 through the declared probe.** The gate ships as chain step `observability`, asserting the seam header's own invariant (`packages/platform/observability/src/index.ts`, "NO VENDOR SDK, on purpose"). The Target keeps the probe form deliberately: this row's gap was never single-surface-shaped, so the surface derivation would have discharged it VACUOUSLY the release the date arrived with no gate in the tree — the probe makes the discharge rest on the shipped register and the step's own gate reading it, re-derived every run. | `unit` (the redaction pass's behavior — the half the static scan deliberately does not judge) | 0.8.0 — closes: `tools/observability.json#vendorSpecifiers` |

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

**And 0.6.0 found the thing the derivation itself was getting wrong.** Both controls ask a
question about a ROW, and a row's `Gate` cell names a chain STEP — but the derivation answered
about a SCRIPT. Those coincide only while every step runs one script, and `boundaries` has run
two since 0.1.x. Discharging `route-manifest` made it concrete: the step gained
`check-web-routes.mjs` beside `check-route-manifest.mjs`, each script is single-surface, the
step covers both, and the row is about the step — so unfolded, the arrived `Target` could never
discharge no matter what shipped. `singleSurfaceGates` now groups scripts by step key and a
step whose scripts jointly reach both surfaces is not a single-surface control. What that fold
deliberately does NOT check is whether the second script asserts anything; the tier table says
which surfaces a control reaches, and `tests/canary/injections.json` is what says it works.

## A named compensating control is a claim, and 0.6.0 found one that was false

`web-e2e` appears in the **Compensated by** column of nine rows above, and the `unit` row's
justification for exempting `apps/web/app` is, in its own words, that those files "are proved
by a real browser". Both statements were checked in exactly one way: that the lane exists and
runs. It does run — path-filtered, on every PR touching `apps/web/**`, green every time.

**Every spec in it was anonymous.** The one sign-in it performed submitted a deliberately wrong
password, to prove the error copy is not an account-existence oracle. So no test in the
repository had ever completed a successful sign-in, and the seeded web app shipped for two
releases in a state where nobody could: the browser client persisted its session to
`localStorage` while every server reader took it from the cookie jar, so sign-in succeeded, the
protected layout saw an anonymous caller, and it redirected back to `/sign-in`. Nine rows
pointed at a lane that could not have noticed.

This is a failure mode past *"'exists' is not 'ran'"* — **vacuity inside a lane that ran.** The
structural half of the fix is in `tools/check-web-e2e.mjs`, which now requires the suite to
contain a spec that mints a real identity, signs in through the form and then **reloads**, so
the server has to re-read what the browser wrote. The general half is not fixed and should not
be claimed: nothing derives, from a `Compensated by` cell, what that control must assert. The
cell still records a human's judgement. What changed is that this particular judgement now has
a red-proof behind it.
