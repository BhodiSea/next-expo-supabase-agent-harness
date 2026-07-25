# Mobile screen reference (Expo 57 · React Native · expo-router)

## Where and how

- Feature dir: `apps/mobile/src/features/<slice>/` — components + hooks. The screen itself is
  a thin `app/` route file (expo-router file-based routing) that composes the feature. RN
  component/screen tests live in `apps/mobile/__tests__/` (jest-expo) — NEVER inside `app/`
  (the router would treat them as routes). Pure logic (`.ts` with zero react-native in its
  import closure) is tested under the root vitest config instead.
- **Every content screen is REGISTERED** in `apps/mobile/src/routes.ts` (`ROUTES`):
  `{ id, titleKey, path, file, states: { loading, empty, error } }`. `titleKey` is a CATALOG
  KEY, not prose. The `states` are `testID`s your UI must render for each canonical data
  state. The screen's root is the styled `Screen` primitive with `testID="<route-id>-screen"`
  — the Maestro device lane (`tools/lib/maestro-flows.mjs`) asserts exactly that container id
  for every `ROUTES` entry, so a screen without it reds its first sweep. An `app/` screen no
  entry references (and that is not allowlisted chrome in `tools/route-allowlist.json` — a
  human decision) fails the `route-manifest` gate. The test lanes ITERATE the array (the RNTL
  states sweep per state, the Maestro device lane per flow, the startup-budget closure per
  screen), so registering the screen is what buys it coverage. Every screen needs real
  loading/empty/error surfaces — the error state must CONTAIN its retry affordance.
- **Closure duties for a NEW screen** (the `perf-budget`/`mobile-perf --closure` Stop step
  reds otherwise): a Maestro flow — scaffold it with
  `node tools/gen-maestro-flows.mjs --flow <route-id>` (writes `maestro/flows/<route-id>.yaml`
  with the correct appId + container assert; refuses to overwrite a hand-tuned flow) — and a
  row in `tools/startup-budget.json` (human-reviewed budget — propose the row in your report
  if you cannot write it).
- **Design doctrine lives in the `designing-mobile-ui` skill** — surface checklists,
  typography roles, motion, state choreography. Read its checklist for this screen's surface
  type before composing. UI diffs end with a `design-reviewer` PASS.

## Data access

- **Class-B (default): the mobile tRPC client.** Resolve it with `useApi()`
  (`src/lib/trpc/use-api.ts`) — ONE client per Supabase session, keyed on the Supabase client
  in a `WeakMap` so a sign-out/re-sign-in gets a fresh client and `httpBatchLink`'s batch
  window stays real. Every call is awaited through `callProcedure` (`src/lib/trpc/normalize.ts`),
  which folds transport rejections (a dropped socket, a 401, a version-skew `CONFLICT`) onto
  the DATA channel so `!outcome.ok` is the WHOLE failure vocabulary and no call site needs a
  try/catch. `@app/api` is imported `import type` ONLY (it is a devDependency): a value import
  drags the server graph into the native binary, and `src/lib/trpc/client.ts` carries an
  `IsAny<AppRouter>` assertion that reds at typecheck if the router type ever silently
  degrades to `any`.
- **Class-A (opt-in read): the vertical `./client`.** For a Class-A slice a read may call the
  vertical's Metro-safe barrel directly against `useSupabase()`'s RLS-scoped client. This is a
  security-census decision, not the reflex.
- **The read exemplar is `features/notes/useListQuery.ts`** (one page, three canonical states,
  a reload; latest-ref so the fetcher's per-render identity does not re-fire the query). The
  paged counterpart is `features/matrix/useKeysetQuery.ts`.
- **The write exemplar is `features/notes/useCreateNote.ts`**: optimistic insert with a temp
  id, reconcile-or-rollback in ONE plain reducer, failures as envelope-code toasts translated
  via `src/i18n/errors.ts` `translateError()` — never a phantom row after a failed write.

## Session and credentials (do not touch unless the slice is auth)

The Supabase session lives in `LargeSecureStore` (`src/host/large-secure-store.ts`): a
fresh AES-256 key per value in `expo-secure-store` (the iOS Keychain / Android Keystore, ~2 KB
cap), the CIPHERTEXT in AsyncStorage (no size limit) — the refresh token never exists in plain
AsyncStorage. The client is constructed ONCE at component scope in
`src/lib/supabase/provider.tsx` (never module scope — that races two clients against one
keychain entry under fast refresh) and reached with `useSupabase()`. Import
`@app/supabase/client`, NEVER `@app/supabase` — the `.` barrel carries the service-role factory
that Metro would ship into an unzippable binary.

## Styling is tokens-only (the `styleguide` gate enforces it, both themes)

- `@app/design-tokens` (the OKLCH TypeScript modules in `packages/design-tokens/src`) is the
  SINGLE source. Its own `packages/design-tokens/scripts/gen.mjs` compiles them — fail-closed
  on gamut + WCAG contrast — into the committed adapter `src/generated/native.ts`, consumed as
  `@app/design-tokens/native`. There is NO `tools/gen-theme.mjs` and NO `tools/lib/oklch.mjs`
  — those are deleted; do not reference them.
- Style through `useThemedStyles((palette) => ...)` (`src/theme/theme.ts`) over the token
  scales. No literal hex colors, no inline styles, no magic pixel numbers, both palettes
  supported. The gate regen-diffs the design-tokens package (`gen:check`) and source-scans
  `apps/mobile` for raw values; `tools/styleguide.manifest.json` is the gate POLICY (accent
  budget, status surfaces, primitive boundary, motion seam), not the token values. Extending
  the vocabulary = a token-package edit + regen in one reviewed diff.

## Every user-facing string is a catalog key

Rendered with `t('key')` — `useI18n()` in components, the plain `t` export outside them
(`src/i18n/catalog.ts`). Plurals via the `count` param (CLDR / `Intl.PluralRules`), never an
`if`. `Intl`/`toLocale*`/`.toFixed()` are BANNED outside `src/i18n/` (the `i18n` Stop step);
Hermes ships no `Intl.PluralRules`/`RelativeTimeFormat`/`Locale`, so the @formatjs polyfills
load first in `app/_layout.tsx`. Error copy comes from the envelope's stable `code` via
`translateError()` — the server's raw message is a support detail, never the sentence a user
reads.

## Controls render through `src/components` primitives

`AppText`, `Button`, `Input`, `Field`, `Screen`, `Toast`, `EmptyState`, `OptionRow`, `Card`,
`PressableScale`, `Skeleton` — they carry the name/role/state contract and the
`primitives-a11y` proof; a raw `Pressable`/`TextInput` outside them dodges that test. Raw text
outside `AppText` is lint-red; new control styling goes INTO the primitive.

## Accessibility (WCAG 2.2 AA, native edition)

Semantics come only from props — there is no DOM. `accessibilityLabel` on icon-only controls;
`accessibilityRole` + `accessibilityState` everywhere interactive; composite rows grouped with
`accessible` + a composed label; async status changes announced (`accessibilityLiveRegion` /
the `Toast` primitive). Touch targets >= 44x44 pt (`PressableScale`'s `sizes.minTarget`);
never `allowFontScaling={false}`; layouts survive 200% font scale; animations respect
reduce-motion (motion only through `src/lib/motion.ts`, transform/opacity only). Fabric view
flattening can detach `testID`s on nested plain Views — put `testID` on interactive/accessible
LEAF elements or on a STYLED container (the `Screen` primitive's id survives because it is
styled), never a deep testID inside an unstyled wrapper.

## Boundaries (hook-, lint-, depcruise-, and bundle-gate-enforced)

- NEVER import a server/Next/DOM module: `next/*`, `react-dom`, `@app/design-system` (the web
  DOM system — mobile uses `@app/design-system-native` + `@app/design-tokens`), or a value
  from `@app/api`. depcruise fails it and the `build` gate checks the exported bundle.
- No `EXPO_PUBLIC_` secret-shaped names (`*KEY|SECRET|TOKEN|PASSWORD|PRIVATE`) — the prefix is
  inlined into the shipped bundle. The Supabase anon/publishable key is public by design (RLS
  is the boundary, the key only authenticates the request to the gateway) and rides
  `EXPO_PUBLIC_SUPABASE_PUBLISHABLE` precisely because that name carries no secret substring;
  the service-role key NEVER appears in an `EXPO_PUBLIC_` name.
- No raw-HTML rendering or WebView HTML/script injection from data.

## Every effect tears down what it registers

`addEventListener` -> `remove`, `setInterval` -> `clear`, a subscription -> `.remove()`/
`.unsubscribe()`, `requestAnimationFrame` -> `cancelAnimationFrame` — in the cleanup the effect
RETURNS. A leaked listener costs nothing on first mount, so no render benchmark sees it; the
only shipped enforcement is the static leak scan in the `perf-budget` gate (each registration
paired with a teardown inside the returned cleanup), and it proves pairing, not behaviour —
write the teardown with the effect. Mobile apps live for days between cold starts.

## Connection-aware UI

Degrade gracefully when the API is unreachable — `callProcedure` returns
`appError.unavailable()` (the kernel's one retryable kind) for a request that never reached a
procedure, and `features/connection/ConnectionStatus.tsx` renders the app-level probe. Render a
useful degraded state, disable mutations while degraded, announce transitions to assistive
tech, recover without a restart.

## React Compiler is on

`experiments.reactCompiler` — follow the Rules of React: pure components/hooks, no conditional
hooks; the eslint react-hooks + compiler rules fail the gate on violations.
`[corpus: react/compiler]`
