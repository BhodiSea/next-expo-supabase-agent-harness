# Module: gate-a11y-deep

The deep accessibility lane for the React Native app, in two honest halves:

1. **The enforceable half** — `apps/mobile/__tests__/a11y-deep.test.tsx`, a
   jest-expo sweep keyed to the canonical route manifest
   (`apps/mobile/src/routes.ts`): per route × per reachable canonical data
   state, every interactive element must expose a non-empty accessible name,
   every `TextInput` must carry an explicit label prop, the manifest's state
   surface must be *visible to assistive technology* (not just present), and
   the error state's retry must be reachable **by role with its catalog
   name**. Seconds-fast, laptop-complete, falsifiable.
2. **The judgement half** — `docs/runbooks/screen-reader-checklist.md`, the
   on-device TalkBack/VoiceOver release pass keyed to the same manifest:
   announcement order and quality, gesture navigation, live-region behavior,
   modal containment — everything a tree-level assertion cannot hear.

There is **no automated device-side ATF pass in this module** — deliberately.
The research verdict below records why, so nobody re-litigates it from vibes.

## What it adds

| File | Purpose |
| --- | --- |
| `apps/mobile/__tests__/a11y-deep.test.tsx` | the deep sweep: manifest × canonical states × accessible names |
| `.github/workflows/a11y-deep.yml` | the named lane: per-PR on mobile paths + nightly |
| `docs/runbooks/screen-reader-checklist.md` | the manual on-device release pass |
| `docs/modules/gate-a11y-deep/README.md` | this document |

The route manifest itself ships with the scaffold and is closure-checked by
the default `route-manifest` gate: a screen directory no `ROUTES` entry
references (and that is not allowlisted chrome) fails `pnpm validate` — so
this sweep cannot be starved by an unregistered screen, and a screen that
registers joins the sweep the same day with zero wiring.

## How enabling works

```
npx next-expo-supabase-agent-harness enable gate-a11y-deep
```

The sweep lands inside `apps/mobile/__tests__/`, which means it **joins the
existing chain immediately** — no config edit, no new gate id:

- `pnpm validate` → the `e2e` gate (`tools/check-e2e.mjs`) runs the whole RN
  jest suite, now including this sweep — so an agent turn cannot end green
  with a deep-sweep red;
- the Stop chain's `mobile-unit` coverage run and CI's `quality-gate`
  `unit` + `e2e-fast` jobs execute it on every PR;
- the module's own workflow adds the NAMED signal: a per-PR `a11y-deep`
  check on mobile-path changes plus a nightly run.

Locally: `pnpm --filter mobile exec jest __tests__/a11y-deep.test.tsx`.

Disable with `… enable`'s counterpart `disable gate-a11y-deep`; the files are
removed and the chain returns to the base floor.

## Prerequisites

None beyond the base scaffold: the jest-expo lane (`apps/mobile/jest.config.js`),
the route manifest, the in-process mock server (`src/testing/mock-server.ts`),
and the message catalog. No other module is required.

## Why there is no automated device-side ATF pass (the research verdict)

Verified 2026-07-18 against the sources named below. Re-verify on major
toolchain bumps before extending this module.

- **Espresso + Accessibility Test Framework** is the real automated ATF path
  on Android: `AccessibilityChecks.enable()` with the
  `espresso-accessibility` test artifact, running checks on
  every view action. It lives in `androidTest` **instrumentation code** — and
  under CNG the `android/` tree is generated and untracked (the expo-policy
  gate enforces exactly that purity). Shipping the pass would mean a config
  plugin that injects native test sources at prebuild: native test code by
  another name, regenerated outside every gate's reach and brittle across SDK
  majors. Rejected.
  (SOURCE: https://developer.android.com/training/testing/espresso/accessibility-checking)
- **Accessibility Scanner** (the on-device app built on ATF) is interactive
  only: tap-to-scan, on-screen suggestions. Google documents no CLI, adb, or
  headless mode, so there is nothing a lane can drive. Rejected.
  (SOURCE: https://developer.android.com/guide/topics/ui/accessibility/testing
  — Scanner section; its getting-started lives on support.google.com and is an
  interactive tap-based workflow. Verified 2026-07-18.)
- **Maestro has no audit primitive.** It *drives* the app through the
  accessibility layer — selectors resolve against accessibility ids and
  labels, which makes every device flow a weak de-facto reachability check
  (an element Maestro cannot address by label is one assistive tech cannot
  either) — but its docs document no command that scans a screen for
  violations: no accessibility-audit primitive exists, and its AI
  visual-defect assertions are not compliance checks. (docs.maestro.dev,
  full-corpus query — verified 2026-07-18.)
- **Hosted wrappers** (e.g. BrowserStack App Accessibility, which can run
  checks over a Maestro suite) are credentialed paid cloud services. This
  harness's CI doctrine is credential-free lanes; a consumer with that
  contract can wire it out-of-band, but it cannot be this module's gate.
- **iOS `performAccessibilityAudit()`** (Xcode 15+) audits contrast,
  element descriptions, hit regions, Dynamic Type — from inside a native
  Xcode UI-test target. Same CNG objection as Espresso, plus macOS-runner cost.
  Rejected for the lane; noted here because it is the strongest candidate to
  revisit if Expo ever ships a managed hook for UI-test targets.
- **What you get for free later**: Google Play's pre-launch report runs
  ATF-based accessibility checks automatically on uploaded builds. The day
  the `ci-mobile-release` module ships builds to a Play track, that report is
  real-device ATF coverage — review it as a release artifact. It runs on
  Google's side, after upload, so no gate in this repo can red on it.
  (SOURCE: https://developer.android.com/guide/topics/ui/accessibility/testing)

The floor that remains enforceable without any of the above — and what this
module deepens — is the tree-level contract: eslint-plugin-react-native-a11y
with every rule at error (base), the primitives' role/label/state tests
(base), and this sweep at the screen level (module).

## How this gate can FAIL (anti-vacuity)

Each of these was exercised red before the module shipped:

- Add an icon-only `Pressable` with `accessibilityRole="button"` and no label
  to any swept screen → the sweep reds naming the element and role
  (`View#<testID> [role=button]`) in every state of that route.
- Add a `TextInput` with no `accessibilityLabel`/`aria-label` → reds naming
  `TextInput#<testID>` (placeholder text and typed values deliberately do NOT
  count as labels).
- Hide a manifest state surface from assistive tech (an
  `aria-hidden`/`display:none` ancestor) → `toBeVisible` reds that state.
- Strip the retry button's role or catalog name from an error surface →
  `getByRole('button', { name: t('common.retry') })` reds.
- Empty the `ROUTES` array → this suite's manifest guard reds — alongside the
  `route-manifest` gate and the routes-closure vitest suite.
- Break the sweep itself so it audits nothing → the final tally test reds
  ("the sweep audited real surfaces"): a sweep that saw zero interactive
  elements can never pass vacuously.

## Honest limits

- **Tree-level only.** No painted pixels: contrast is computed from the OKLCH
  styleguide tokens by the base styleguide gate, not measured off the screen;
  Fabric view-flattening detachment is the CI device lane's job (leaf-testID
  sweeps); announcement order and quality are the checklist's.
- **The ready-state sweep uses one fixture note.** A control that only
  renders under exotic data shapes is not audited — screens with such states
  should register them in the manifest, which enrolls them here.
- **The audited role set is the operable set** (button, link, tab, switch, …).
  A custom gesture surface with no role is invisible to this sweep — and to
  assistive technology, which is the actual defect; the base a11y lint rules
  (`has-valid-accessibility-descriptors` and friends) are the floor that
  catches those at the component level.
- **The checklist is the release bar, not decoration.** The sweep proves a
  name EXISTS; only a human can judge that it is the RIGHT name, in the right
  order, on real hardware.
