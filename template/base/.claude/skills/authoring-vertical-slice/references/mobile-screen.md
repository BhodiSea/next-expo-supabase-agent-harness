# Mobile screen reference (React Native + expo-router)

## Where and how

- Feature dir: `apps/mobile/src/features/<feature>/` — components + hooks; the
  screen itself is a thin `app/` route file (expo-router file-based routing) that
  composes the feature. RN component/screen tests live in
  `apps/mobile/__tests__/` (jest-expo) — NEVER inside `app/` (the router would
  treat them as routes). Pure logic (`.ts` with zero react-native in its import
  closure) is tested under the root vitest config instead, wired into BOTH runner
  lists (the vitest `unit-node` include and the jest `testPathIgnorePatterns`).
- **Every screen is REGISTERED** in `apps/mobile/src/routes.ts` (`ROUTES`):
  `{ id, titleKey, path, file, states: { loading, empty, error } }` — the states
  are `testID`s your UI must render for each canonical data state (read path:
  `NotesPanel.tsx` + `useListQuery.ts`; write path: `NoteComposer.tsx` +
  `useCreateNote.ts` — optimistic insert with a temp id, reconcile-or-rollback in
  one plain reducer, envelope-message toasts). The screen's root is the styled
  `Screen` primitive with `testID="<route-id>-screen"` (see `app/sign-in.tsx`) —
  the device lane asserts exactly that container id for every `ROUTES` entry
  (`tools/lib/maestro-flows.mjs`), so a screen without it reds its first sweep.
  An `app/` screen no entry references (and that is not allowlisted chrome in
  `tools/route-allowlist.json` — human decision) fails the `route-manifest`
  gate; the test lanes ITERATE the array (the RNTL states sweep per state, the
  Maestro device lane per flow, the startup-budget closure per screen), so
  registering the screen is what buys it coverage. Every screen needs real
  loading/empty/error surfaces — the error state must contain its retry
  affordance.
- **Closure duties for a NEW screen** (the `mobile-perf --closure` Stop step reds
  otherwise): a Maestro flow for the screen — scaffold it with
  `node tools/gen-maestro-flows.mjs --flow <route-id>` (writes
  `maestro/flows/<route-id>.yaml` with the correct appId + container assert;
  refuses to overwrite a hand-tuned flow) — and a row in
  `tools/startup-budget.json` (human-reviewed budget — propose the row in your
  report if you cannot write it).
- **Design doctrine lives in the `designing-mobile-ui` skill** — surface
  checklists, typography roles, motion, state choreography. Read its checklist
  for this screen's surface type before composing.
- **Styling is tokens-only** (the `styleguide` gate enforces it):
  `tools/styleguide.manifest.json` is the OKLCH source of truth, rendered by
  `tools/gen-theme.mjs` into the committed `src/theme/tokens.gen.ts` (regen-diffed
  — never hand-edited). Style through `useThemedStyles((palette) => ...)` +
  the token scales (`spacing`, `radius`, type sizes); no literal hex colors, no
  magic pixel numbers, both palettes supported. Extending the vocabulary = manifest
  edit + regen in one reviewed diff.
- **Every user-facing string is a catalog key** (`src/i18n/catalog.ts`), rendered
  with `t('key')` — `useI18n()` in components, the plain `t` export outside them.
  Plurals via the `count` param (CLDR), never an `if`. `Intl`/`toLocale*`/
  `.toFixed()` are banned outside `src/i18n/` (the `i18n` Stop step). Error copy
  comes from the envelope's stable `code` via `translateError()` — the server's
  raw message is a support detail, never the sentence a user reads.
- Data access: ONLY through `src/lib/api-client.ts` (`apiFetch`/`apiPost` — the
  one door that attaches the bearer token and decodes the error envelope; a bare
  `fetch()` in a feature 401s against the real server and no mocked test will
  tell you). Zod-parse every response with the `@app/contracts` schemas at the
  fetch boundary. Expect 401 (session), 409 `version_skew` (update the app), and
  network failure as first-class states.
- React Compiler is on (`experiments.reactCompiler`): follow the Rules of React —
  pure components/hooks, no conditional hooks; the eslint react-hooks + compiler
  rules fail the gate on violations. `[corpus: react/compiler]`

## Boundaries (hook-, lint-, depcruise-, and bundle-gate-enforced)

- NEVER import server/database modules (`postgres`, `drizzle-orm`, `@hono/*`,
  `pino`) or anything from `apps/server` — the write-guard denies it, depcruise
  fails it, and the `build` gate checks the exported bundle.
- `expo-secure-store` is imported ONLY inside `src/host/**` (the one-door
  credential seam — tokens live in the platform keychain, never JS-visible
  storage). Feature code stays storage-agnostic; ephemeral prefs go through
  `src/lib/kv.ts` (corrupt-safe), never a credential.
- No `EXPO_PUBLIC_` secret-shaped env names — the prefix is inlined into the
  shipped bundle (fine for the transport origin, fatal for a credential).
- No raw-HTML rendering or WebView HTML/script injection from data.
- New native surface = an `app.config.ts` change + a config plugin allowlisted in
  `tools/expo-plugins.json` (+ `tools/expo-permissions.json` for permissions) —
  both human-reviewed; the generated `android/`/`ios/` dirs are never touched.

## Every effect tears down what it registers

`addEventListener` → remove, `setInterval` → clear, a subscription →
`.remove()`/`.unsubscribe()` — in the cleanup the effect RETURNS. A leaked
listener costs nothing on first mount, so no render benchmark sees it; the only
shipped enforcement is the static leak scan in `tools/check-perf-budget.mjs`
(each registration paired with a teardown inside the returned cleanup), and it
proves pairing, not behaviour — write the teardown with the effect.

## Connection-aware UI

The app must degrade gracefully when the API is unreachable: the connection
probe Zod-parses `GET /healthz`. Features follow the same doctrine — render a
useful offline/degraded state, disable mutations while degraded, announce
transitions to assistive tech, and recover without a restart.

## Accessibility (WCAG 2.2 AA, native edition)

Semantics come only from props — there is no DOM:

- Compose interactive controls from the `src/components` primitives (Button,
  Input, Field, Toast, EmptyState, Screen, AppText) — they carry the
  name/role/state contract and the `__tests__/primitives-a11y.test.tsx` proof;
  a raw Pressable/TextInput outside them dodges that test.
- `accessibilityLabel` on icon-only controls; `accessibilityRole` +
  `accessibilityState` everywhere interactive; composite rows grouped with
  `accessible` + a composed label.
- Async status changes announced (`accessibilityLiveRegion` /
  `AccessibilityInfo.announceForAccessibility` / the Toast primitive).
- Touch targets ≥ 44×44 pt; never `allowFontScaling={false}`; layouts survive
  200% font scale; animations respect reduced motion.
- Fabric view flattening can detach `testID`s on nested plain Views — put
  `testID` on interactive/accessible LEAF elements or on a STYLED container
  (the `Screen` primitive's `<route-id>-screen` id survives because the
  container is styled — the selector doctrine in `tools/lib/maestro-flows.mjs`),
  never a deep testID inside an unstyled wrapper.
