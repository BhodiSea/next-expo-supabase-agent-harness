# Gates catalog

Companion to [the harness doctrine](./README.md). One section per default-on gate (the
21-step `VALIDATE_STEPS` chain in `tools/harness.config.mjs`), the Stop-hook runtime
suites, the CI-only lanes, every opt-in module, and the gates we considered and rejected.

Every section carries an **anti-vacuity proof**: how to inject a violation and watch the
gate fail. A gate whose failure you have never seen is a gate you should not trust —
exercise any of them in a scratch branch. (The write guard blocks some injections
in-session; inject via a plain editor or `HARNESS_ALLOW_SELF_EDIT=1` when noted.)

Shared behavior: gates self-skip LOUDLY when their prerequisite (an install, a database,
the resolved Expo toolchain, the surface itself) is absent locally, and fail closed in CI
(`CI=true` / `HARNESS_REQUIRE_TOOLCHAINS=1`). See the doctrine's
"skip-local / fail-closed-CI asymmetry".

## Honest losses (stated plainly, so nobody discovers them in an incident)

Two things the desktop original's chain had that this chain does NOT have, recorded
here deliberately rather than papered over:

- **The Stop chain contains no on-device proof.** The `e2e` gate and the `mobile-unit`
  suite run jest-expo + React Native Testing Library under Node — the shipped screens,
  expo-router navigation, api-client and i18n run for real, but Hermes bytecode load,
  native module init, Fabric layout, and the OS keychain do not. The on-device half is
  the Maestro emulator lane plus the startup-budget measurement, and those are CI-ONLY
  (quality-gate `mobile-e2e` + `perf-lane`, path-filtered + nightly; `mobile-perf
  --closure` in the Stop chain is the static half that guarantees every screen HAS a
  flow and a budget row the day it registers). A turn can end green having never booted
  the app on a device. That is a deliberate trade (seconds-fast, laptop-complete agent
  loop), not an oversight — and the selftest maestro-smoke job proves the trade is
  real coverage, not decoration: a broken container testID leaves the jest lane green
  (asserted) while the device sweep reds.
- **The a11y floor is weaker than a browser-driven axe sweep.** The desktop original
  swept every route with axe-core in a real browser engine per theme. There is no axe
  for React Native: this harness's floor is eslint-plugin-react-native-a11y (every rule
  at error) plus the RNTL suites' role/label/state assertions (`primitives-a11y`,
  the states sweep). That catches missing roles, labels, hints, and touch-target
  props — it does NOT compute painted contrast against real pixels (the styleguide
  gate computes contrast from the OKLCH tokens instead), and it cannot see what a
  real screen reader announces. Treat an on-device screen-reader pass (TalkBack /
  VoiceOver) as a release-checklist item, not something a gate has proven.

## Default-on gates (`pnpm validate`, in order, cheap → expensive)

### 1. format — `pnpm exec biome ci .`

Formatting, import organization, read-only (CI-grade `ci`, not `check --write`).
Fix with `pnpm format`. Generated-but-committed artifacts (tokens.gen.ts,
openapi.json, drizzle SQL) are excluded — byte-stability there belongs to their
regen-diff gates.
**Anti-vacuity:** mis-indent any `.ts` file → FAIL naming the file.

### 2. gate-integrity — `node tools/check-gate-integrity.mjs`

Recomputes sha256 over the RAW bytes of every harness-owned enforcement file recorded
in `.harness/manifest.json` (`tools/`, `.claude/hooks/`, the RLS and migration
runners) and fails on any mismatch or missing file — a raw write that slipped past the
write-guard hook (shell redirection, `sed -i`, an external editor) reds the very next
validate run. `config` and `seeded` entries are human-tunable and skipped. Deliberately
the first gate after format: tampered gates must not get to run.
**Anti-vacuity:** `echo '// x' >> tools/check-migrations.mjs` from a plain terminal →
FAIL naming the file.

### 3. types — `pnpm exec tsc -b`

Solution-mode strict TypeScript across all six projects (composite project
references: contracts, schema, importer, eval, server, mobile). Catches
cross-package breakage the per-package editors miss.
**Anti-vacuity:** change a DTO field name in `@app/contracts` without updating the
server → FAIL in the dependent project.

### 4. lint — `pnpm exec eslint . --max-warnings 0 --cache`

Type-aware rules (strictTypeChecked + stylisticTypeChecked via projectService),
react-hooks (including the React Compiler rule set) on the Expo app,
eslint-plugin-react-native + eslint-plugin-react-native-a11y with EVERY rule at
error, sonarjs cognitive-complexity ≤ 15, plus the boundary bans: global `fetch`
outside `src/lib/api-client.ts`, `expo-secure-store` outside `src/host/**` +
`src/auth/**`, chart libraries in the dense features, raw text outside AppText,
bare `console` outside `src/lib/log.ts`.
**Anti-vacuity:** `import * as SecureStore from 'expo-secure-store'` in a random
feature → FAIL no-restricted-imports; call `fetch()` in a screen → FAIL
no-restricted-globals (depcruise walls the same seams at the module-graph level —
defense in depth).
**Papercut:** `--cache` keys on file content + eslint config, NOT on tsconfig —
after a tsconfig change fixes a typed-lint error, the stale `.eslintcache` can
keep reporting it (observed live: a `jest.setup.ts` include fix stayed red until
the cache was dropped). If lint contradicts a fix you just made, `rm
.eslintcache` and re-run before debugging further.

### 5. provenance — `node tools/check-sources.mjs`

Tree-wide scan for decision-site keywords (RLS SQL, `set_config`/`SET LOCAL`,
`jwtVerify`/JWKS/`clockTolerance`, vector index choices, sampling/retry/timeout
constants) lacking `// SOURCE:` (`-- SOURCE:` in SQL) within a 3-line window.
Identical heuristic to the PostToolUse hook, so in-session and CI can never disagree.
Cited corpus entries must carry a `groups` key covering the site's decision class
(reviewed cross-group escapes in `tools/provenance-overrides.json`); a bare-URL
citation grounds only on a `tools/lib/citation-domains.mjs` allowlisted host.
Consumer-added decision classes live in `tools/decision-groups.json`.
**Anti-vacuity:** add `const timeoutMs = 5000` with no citation → FAIL with
file:line; cite a corpus entry whose groups do not cover the flagged class → FAIL
naming the mismatch.

### 6. boundaries — `node tools/check-exports-walls.mjs && node tools/check-workspace-deps.mjs`

The boundary triad, part 1 (part 2 — the import-graph layering — is the later
`architecture` step). Both consumers derive from the ONE census
`tools/exports-walls.json`, never a per-consumer copy. **check-exports-walls**: every
package that ships a `./client` subpath export must carry a sanctioned `{package,
reason}` entry (Metro does not tree-shake, so a `./client` on a package holding a
server graph puts it one import from the native binary); two-way, so a sanction naming
a missing package reds too. `sanctioned` is MAY not MUST — a listed package shipping
only `.` is fine. **check-workspace-deps** (the declared-dependency allow-matrix):
apps/mobile may take a runtime `@app/*` dependency only if it is sanctioned OR
universally-importable (the error/event kernel, the wire contracts, the RN-only design
system); `@app/api` must be an import-type-only devDependency; verticals never depend on
each other; shared never depends on a vertical; apps/web never carries the RN-only design
system.
**Anti-vacuity:** add a `./client` export to a package with no census entry → FAIL
naming it; make `@app/api` a runtime mobile dependency → FAIL "import type only"; make one
vertical depend on another → FAIL "verticals never import each other".

### 7. expo-policy — `node tools/check-expo-policy.mjs`

Asserts over the RESOLVED Expo config (`expo config --json --type public` — dynamic
config executed, plugins expanded), the store/security surface the app actually
ships: store identity matches `tools/identity.lock.json` (bundle id == android
package == lock, scheme, EAS projectId — upgrade identity never drifts);
`runtimeVersion` stays exactly `{ policy: 'appVersion' }`; engine floor (jsEngine
absent-or-hermes, `newArchEnabled` absent-or-true, `useHermesV1` never false); no
arbitrary-loads ATS exceptions or cleartext traffic, `extra.apiOrigin`
https-or-loopback; `android.permissions` ↔ `tools/expo-permissions.json` and
resolved plugins ↔ `tools/expo-plugins.json`, bidirectional (unreviewed grant AND
stale entry both red); no secret-shaped keys in `extra` (it ships in the bundle);
the splash/adaptive-icon background hex equals the generated dark `canvas` token
(the anti-flash launch-frame lockstep); eas.json sanity (`appVersionSource:
"local"`, `autoIncrement: false`). CNG purity rides along: `android/`/`ios/` stay
untracked and ignored. Needs `apps/mobile/node_modules` — loud SKIP locally
without it, FAIL CLOSED in CI; unchanged inputs ride a content stamp.

The STORE-READINESS floor (0.1.2), driven by `tools/store-policy.json`
(reviewed data, write-guard-protected; malformed fails CLOSED — the checks can
never silently disarm): iOS `*UsageDescription` strings reviewed bidirectionally
against the `ios[]` list in `tools/expo-permissions.json`, never empty or
placeholder-shaped, and every plugin-implied key present (pre-prebuild honesty:
the implication map is keyed by PLUGIN — a bare npm dep is invisible until
prebuild, and Apple's post-submission validation is the backstop);
`ITSAppUsesNonExemptEncryption` explicitly DECLARED (undeclared re-asks the
export-compliance question on every build; `true` needs the reviewed
`iosEncryption` escape); `ios.privacyManifests` never REQUIRED (SDK packages
self-declare their own — absence gets a NOTE pointing at the store-metadata
sweep) but whatever is declared must use Apple's category vocabulary, real
reason codes, and the reviewed `privacyAccessedApiTypes` lockstep (both
directions red); App Tracking Transparency consistent BOTH ways (no tracking
SDK → an ATT string or `NSPrivacyTracking` claim reds; an SDK signal → all
three declarations must agree); Android targetSdk floored (declared value, or
the pinned per-Expo-SDK default — an unknown SDK major fails closed); icon
integrity via a zero-dependency PNG parse (`tools/lib/png.mjs`: marketing icon
1024×1024 and opaque, adaptive-icon layers 1024×1024, splash parses;
solid-color placeholder art NOTEs by default and reds when
`icons.solidColorPlaceholder` escalates to `"error"` — the pre-submission
step); and the ACCOUNT-DELETION closure (Apple 5.1.1(v)): an app shipping an
auth surface must register the deletion action (or route) AND back it with the
contract-visible `DELETE` operation — the shipped `session.deleteAccount` +
`DELETE /api/me` slice is the worked pattern, and the deletion's completeness
is the RLS suite's live sweep case, not this static check. The device lane
closes the targetSdk half against the GENERATED gradle project after prebuild.
**Anti-vacuity:** add a permission to app.config.ts without a reviewed
`tools/expo-permissions.json` entry (editor — the write guard also watches this
surface) → FAIL naming it; change the splash hex one nibble → FAIL the
lockstep; delete `ITSAppUsesNonExemptEncryption` → FAIL naming the declaration;
declare a usage string as "TODO" → FAIL; empty the deletion registry entry
while sign-in ships → FAIL citing 5.1.1(v); swap the marketing icon for a
512×512 or alpha-carrying PNG → FAIL with the measured dimensions.

### 8. native-deps — `node tools/check-native-deps.mjs`

The native dependency floor for a CNG app: (1) `expo install --check` exits clean —
every Expo-managed package at the SDK-blessed version (an Expo package's MAJOR
tracks the SDK since 55, so drift is a native ABI risk, not a nit; the fix list
surfaces verbatim); (2) CNG purity (shared `tools/lib/cng-purity.mjs`); (3)
`tools/expo-plugins.json` integrity (parses; every entry has a reviewed reason);
(4) local config-plugin closure — every `apps/mobile/plugins/*` rewrites the
generated native project at prebuild time and must ship a same-basename test.
Deliberately hermetic: `expo-doctor` talks to the network and belongs to the CI
native lane, not here. Loud SKIP without the toolchain; FAIL CLOSED in CI.
**Anti-vacuity:** pin an expo-* package one patch off the SDK set → FAIL with
expo's own fix list; commit a file under `apps/mobile/android/` → FAIL CNG purity.

### 9. version-sync — `node tools/check-version-sync.mjs`

One version everywhere — root/server/mobile package.json agree AND the RESOLVED
Expo config equals the app.config.ts derivation formulas (`ios.buildNumber` =
version; `android.versionCode` = maj·1e6 + min·1e3 + pat), so replacing the
derivation with literals reds on the next bump, not at store review;
`runtimeVersion.policy` stays `appVersion`; Node majors agree across
`.nvmrc`/`.node-version`/`engines` AND `eas.json` pins the same Node plus the
EXACT pnpm from `packageManager` (EAS ignores package.json's packageManager — the
eas.json fields are the only pin a cloud build obeys); expo / expo-router /
react-native / babel-preset-expo / drizzle-kit EXACT-pinned in the catalog;
exactly one zod instance resolves workspace-wide. Stamped for warm runs; CI
always re-runs.
**Anti-vacuity:** bump only `apps/server/package.json` → FAIL listing the
disagreeing versions; replace the versionCode derivation with a literal → FAIL on
the next version bump.

### 10. prompts — `node tools/check-prompts-lock.mjs`

Every prompt file under `packages/*/prompts/` / `apps/*/prompts/` is sha256-locked
in `tools/prompts.lock.json` and versioned in its filename (`extract.v1.md`). Pass
by creating a NEW `.vN` file, re-running the eval, then deliberately updating the
lock (write-guard-protected — a human act).
**Anti-vacuity:** edit one word in `packages/eval/prompts/extract.v1.md` → FAIL
hash mismatch.

### 11. licenses — `node tools/check-licenses.mjs`

The production npm dependency tree stays inside a permissive allowlist
(MIT/ISC/Apache-2.0/BSD/MPL-2.0 etc.); exceptions are reviewable data in
`tools/license-exceptions.json`. The Stop gate itself refuses a copyleft/unknown
dependency the moment an agent adds one.
**Anti-vacuity:** `pnpm add` any GPL-3.0-only package as a prod dep → FAIL naming it.

### 12. schema-rls — `node tools/check-rls-manifest.mjs`

Static <100ms cross-reference over the SQL, not substring vibes. Every table declared
in `supabase/schemas/*.sql` has ENABLE + FORCE ROW LEVEL SECURITY and per-operation
policies in the applied `supabase/migrations/*.sql`, or an entry in the human-reviewed
`tools/rls-exempt.json`. Policy predicates must be real (no `USING (true)`) and resolve
identity through the initPlan sub-select `(select auth.uid())`, not a per-row call. Every
migration-created table must be declared in a schema; every non-exempt table must appear
in BOTH runtime registries — `ISOLATION_TARGETS` (`tests/rls/db-context.ts`) and the pgTAP
`rls_targets` (`supabase/tests/rls_structure.test.sql`), on the same owner column — and
that owner column must be the LEADING column of some migration-declared index (an inline
`PRIMARY KEY` counts). Existence proof only — the runtime twins prove isolation and the
access path.
**Anti-vacuity:** declare a table with no migration → FAIL (no ENABLE, no FORCE, missing
policies); `USING (true)` → FAIL naming the vacuous predicate; a per-row `auth.uid()` →
FAIL "per row"; drop the owner index → FAIL naming the missing leading column; add a table
to one registry but not the other → FAIL naming the gap.

### 13. types-drift — `node tools/check-types-drift.mjs`

Regenerates the Supabase type mirror (`supabase gen types typescript --local`) from the
running local stack and byte-diffs it against the committed
`packages/platform/supabase/src/database.types.ts`; a mismatch means a migration landed
without a `pnpm db:types` regen, so the checked-in types describe a schema no database
runs. A LIVE-STACK gate: it SKIPS LOUDLY (exit 0) with no supabase CLI/stack — its
fail-closed enforcement is the CI supabase lane that brings the stack up — and the mirror
is opt-in (`pnpm db:types` writes it), so until it exists there is nothing to diff. The
generic is deliberately NOT in the compile graph (`packages/platform/supabase/src/types.ts`):
rows are re-parsed against zod at the DAL exit, so this is a CI drift assertion, never a
compile-time licence to skip validation.
**Anti-vacuity:** edit a committed migration's column and re-run without `pnpm db:types` →
FAIL "stale"; break a migration so `gen types` errors while the stack is up → FAIL "failed
while the stack is up".

### 14. migrations — `node tools/check-migrations.mjs`

Append-only (no committed migration modified/deleted vs HEAD, or vs the PR base in
CI); no DML without `-- harness-allow-dml: <reason>`; destructive DDL requires
`-- adr: docs/adr/<file>` pointing at an existing ADR. Always generate a NEW
migration; follow `docs/runbooks/expand-contract.md` for destructive phases.
**Anti-vacuity:** append a comment to an existing migration file (editor) → FAIL
append-only; add `DROP TABLE notes;` in a new migration without an ADR line → FAIL.

### 15. contracts — `node tools/check-contract-drift.mjs`

(1) Contract-inventory regen-diff: regenerate the two committed inventories —
`tools/generated/action-inventory.json` (every tRPC procedure `appRouter` exposes)
and `tools/generated/event-catalog.json` (every event the platform + vertical
catalogs declare) — from the LIVE values and diff against the committed copies, so
adding OR removing an action/event without `pnpm gen` reds. Needs an install (tsx,
to walk the runtime router/catalogs); skips loudly without one, fails closed in CI.
(2) tsconfig project references mirror the pnpm workspace dependency graph —
parallel topologies desynchronize into confusing type errors otherwise. (3) Bounded
wire strings (G18): every `z.string()` in `@app/contracts` carries `.max(N)`, or a
reviewed entry in `tools/dto-bounds-allow.json` — an unbounded wire string is a
memory-amplification vector.
**Anti-vacuity:** add a procedure without regenerating → FAIL stale; delete a
`references` entry from a package tsconfig → FAIL naming the missing ref; add an
unbounded `z.string()` to a wire DTO → FAIL naming the site.

### 16. parity — `node tools/check-mobile-parity.mjs`

Two-way surface parity: every action in the contracts-verified inventory
(`tools/generated/action-inventory.json`) maps to EXACTLY ONE row in the seeded
`PARITY.md` ledger, naming the web screen and the mobile screen that surface it —
each an existing repo-relative path, or `—` (exempt) WITH a reason in the Notes
cell. The closure runs both directions: a new action with no row reds (forward), a
row for a deleted/renamed action reds (backward — the fix to the source scanner's
one-way rot). Action names admit digits (`billing.v2Invoice`), unlike the source
regex that silently dropped them. Runs right after `contracts` so the inventory is
byte-fresh. Ships **soft** via `rampNote` (NOTE-only on installs predating it) and
**strict** on fresh installs + the template tree; `CHECK_MOBILE_PARITY_STRICT=1`
forces strict anywhere.
**Anti-vacuity:** add a procedure without a `PARITY.md` row → FAIL (strict) naming
the action; leave a row for a removed action → FAIL naming the stale row; set a
surface cell to `—` with an empty Notes cell → FAIL demanding the reason.

### 17. dead-code — `pnpm exec knip --strict`

Unused files, exports, and dependencies, in production mode (test-only reachability
does not keep production code alive). Wire everything you add or delete it.
Deliberate test-facing seam exports carry an explicit `@public` JSDoc tag — a
visible, greppable claim, reviewed like code. NEVER `knip --fix` (blocked): it
auto-deletes with false positives.
**Anti-vacuity:** add an exported-but-unimported function → FAIL.

### 18. architecture — `pnpm exec depcruise apps packages --config .dependency-cruiser.cjs`

The dependency law: no cycles; mobile resolves no `postgres|drizzle-orm|pino|@hono/*`,
nothing in `apps/server`, and NOT `@app/schema` (wire contracts come from
`@app/contracts` only); drizzle confined to schema+server; the postgres driver only
under `apps/server/src/db/`; `withUserContext` importable only from the DAL;
`expo-secure-store` only under `src/host/**` + `src/auth/**`; LLM SDKs only from
`packages/eval` adapters.
**Anti-vacuity:** import a server module from a mobile file (editor — the write
guard also denies it in-session) → FAIL with the violation path.

### 19. build — `node tools/build-check.mjs`

The app must actually export (`expo export --platform android` — one canonical
platform keeps the byte accounting deterministic and laptop-fast; the CI device
lanes exercise both platforms for real), and the emitted `dist/` must be PURE: no
ORM/server markers, no privileged DSN names, no secret-shaped strings. Bundle
purity is the runtime backstop for gates 4/15 — a transitive leak past static
analysis still shows up in the emitted Hermes bundle. Bytes are gated twice:
absolute gzip budgets (`tools/bundle-budget.json`, ~3x headroom) and the byte-true
ratchet against the committed `tools/perf-baseline.json` (measured ≤ baseline ×
ratioCap; re-baseline only via `pnpm perf:baseline` in a reviewed commit; a
malformed baseline FAILS CLOSED). Stamped — editing the baseline invalidates the
stamp, so a warm validate re-runs the real export.
**Anti-vacuity:** embed the literal `MIGRATOR_DATABASE_URL` in a mobile constant →
export succeeds, gate FAILs on bundle purity; halve `gzip.total` in the baseline →
FAIL naming measured vs baseline × ratioCap and the re-baseline ceremony.

### 20. styleguide — `node tools/check-styleguide-manifest.mjs`

The design system is DATA, and the token VALUES are owned by `@app/design-tokens`
(the TypeScript modules in `packages/design-tokens/src`, OKLCH). This gate does two
things. (1) **Regen-diff the package** — `pnpm --filter @app/design-tokens run
gen:check` (`tsx packages/design-tokens/scripts/gen.mjs --check`): one command
re-asserts BOTH committed adapters byte-for-byte — `src/generated/native.ts` (the RN
theme `apps/mobile` consumes via `@app/design-tokens/native`) and
`src/generated/web.css` (the Tailwind v4 `@theme` `apps/web` imports) — AND the
gamut + WCAG contrast contract (`render()` throws before emitting a byte), so a hand
edit to a generated file, or a retune that breaks readability, is a red gate. Needs
an install (tsx); skips loudly without one, fails closed in CI. (2) **Source-scan**
`apps/mobile/{src,app}` (outside `src/theme`) for raw values: hex/rgb color literals,
CSS named colors on color props, raw dimension literals, inline `style={{…}}` numeric
values. `tools/styleguide.manifest.json` (write-guard-protected) is now the gate
POLICY — accent budget, status surfaces, primitive boundary, motion seam, allow
lists — not token values; the token names it references (accentTokens,
statusSurfaces.tokens) are validated against the committed `native.ts` palette. The
launch-frame lockstep (splash/adaptive-icon background == the dark canvas token) is
shared with expo-policy, which reads the same `native.ts` adapter.

The DESIGN-DEPTH sub-checks: **motion discipline** (`motionSeam`) — literal
`duration:`/`delay:` numerics red anywhere in the walk (the motion vocabulary lives
in `@app/design-tokens` `motion`; 0 passes), and raw
`Animated.`/`LayoutAnimation.`/`Easing.` references red outside the seam file + the
components home with NO allow escape; **elevation keys** — the `shadow*`/`elevation`
style keys are spelled only inside the generated adapter, consumers spread a level
(`{ ...elevation.raised }`); **hit-target floor** — a home file styling a raw control
must reference `minTouchTarget` (the 44dp floor `@app/design-tokens` exports), and
with `controlPrimitives.base` declared the pressable-class tags may be styled in
exactly ONE home file (the PressableScale touchable base — pressed feedback, the hit
target, and the haptic live there).
**Anti-vacuity:** hand-edit `native.ts`/`web.css` → FAIL regen-diff; retune a token
below a contrast floor → FAIL (`render()` throws in gen:check); add a hex literal to
a component style → FAIL naming the file; write `duration: 250` in a feature → FAIL
naming the literal; call `Animated.timing` from a screen → FAIL pointing at the seam;
spell `shadowOpacity:` outside src/theme → FAIL; style a raw `<Pressable>` in a second
home file → FAIL naming the base; name a non-existent token in `accentTokens` → FAIL.

### 21. perf-budget — `node tools/check-perf-budget.mjs`

Median-of-N full react-test-renderer mount time over REAL feature subjects,
asserted against `tools/perf-budget.json` (write-guard-protected; raising a budget
is a reviewed human decision). A red requires TWO independent over-budget medians
(one automatic re-measure), so scheduler noise cannot fail a turn while a genuine
10× regression still cannot pass. The UPDATE phase (0.1.2): after each timed
mount the harness re-renders the SAME mounted tree with a changed `tick` prop
and times the reconciliation pass — the re-render cost a mount-only benchmark
never sees, and because props change every update a `React.memo` wrapper cannot
fake a fast one. The update median is always measured and printed; it is
ASSERTED only when the entry declares `medianUpdateBudgetMs` (seeded ~10× the
fresh-scaffold update median, same doctrine as the mount budget), and the
updated tree must still carry the scaled markers. One budget shape — `subjects:
[{ subject, cells, medianBudgetMs, medianUpdateBudgetMs?, expect? }]` under one
shared `runs` — and it arms the
DENSE-FEATURE CLOSURE: every `features/*` dir importing `useKeysetQuery` must ship
a `perfSubject.tsx` declared in `subjects[]`; declared-but-missing and
present-but-undeclared both red (`features/matrix/perfSubject.tsx` is the worked
pattern — an island reachable only from tests and this gate). This is the
RELATIVE, deterministic canary; absolute startup/UX numbers live in the CI device
lane (mobile-perf), never in the chain.
**Anti-vacuity:** slow the row render 10× → FAIL twice-measured; slow only the
UPDATE path → FAIL naming the re-render cost; add a features dir importing
`useKeysetQuery` with no perfSubject → FAIL with the create-FIX line; declare a
subject that does not exist → FAIL naming it.

### 22. route-manifest — `node tools/check-route-manifest.mjs`

Every screen is REGISTERED: `apps/mobile/src/routes.ts` ROUTES must be non-empty;
every entry carries id / titleKey (a catalog KEY, so route names are translatable)
/ path / file / `states.{loading,empty,error}` test ids (the RNTL states sweep
drives each; the Maestro flows and startup budgets iterate the same array); every
route file under `apps/mobile/app/` is claimed by EXACTLY ONE entry or allowlisted
chrome in `tools/route-allowlist.json` (reasons required). Closure runs both ways
— stale manifest/allowlist entries fail too. The file→URL derivation mirrors
expo-router's own rules (`(group)` segments vanish, `index` maps to the parent,
`[param]`/`[...param]` declared as `:param`/`*param`; layouts, `+not-found`, API
routes are plumbing, not screens), so `path` cannot silently disagree with the URL
the router serves. Static, <100ms.
**Anti-vacuity:** add `app/reports.tsx` without a ROUTES entry → FAIL naming the
orphan; empty the ROUTES array → FAIL ("vacuous pass"); drop `states.error` → FAIL
naming the entry and key.

### 23. e2e — `node tools/check-e2e.mjs`

The agent-time fast lane: the WHOLE react-native suite in `apps/mobile` (jest-expo
+ React Native Testing Library) — the states sweep over every ROUTES entry
(loading/empty/error via the mock network seam), screen flows (notes optimistic
write, matrix pagination, actions modal), boot/layout wiring, primitives a11y —
with the shipped screens, expo-router navigation, api-client and error
translation running for real against the in-process mock server. Seconds,
laptop-complete, and exactly what the CI e2e job runs. Runner detection is module
resolution (jest-expo resolved FROM apps/mobile), never subprocess vibes: absent →
loud local skip with the install command; CI → fail closed. Hard timeout kill; the
last output lines surface on failure. An exit-0 run reporting ZERO tests FAILS
("an empty e2e run is a vacuous pass"). The pure suites (routes closure, i18n, kv,
sse, fuzzy scorer) run under the root vitest config instead — no test runs under
both runners. The ON-DEVICE proof is the CI Maestro lane, deliberately not here
(see Honest losses).
**Anti-vacuity:** break a state testID in a screen → the states sweep (and thus
the gate) reds; empty the jest suite → FAIL vacuous-pass.

### 24. docs-sync — `node tools/check-docs-sync.mjs`

The agent-facing documentation cannot lie about the gate: CLAUDE.md stays a pure
`@AGENTS.md` include; the AGENTS.md "The N gates, in order: ..." sentence must
match `VALIDATE_STEPS` exactly (names, order, count — the release-time doc sweep
becomes mechanical); every `pnpm <script>` command AGENTS.md advertises must exist
in the root package.json scripts; and every `VALIDATE_STEPS` name has its own
numbered section (`### <n>. <name> — `) in THIS catalog — the anti-vacuity record
is part of the gate, so an undocumented step cannot ship. The agent roster is part
of the same surface: every `.claude/agents/*.md` must parse under the pinned
frontmatter grammar (`tools/lib/agent-roster.mjs`; a parse failure is a RED, never
a skip) and the six reviewers (`security-reviewer`, `mobile-security-reviewer`,
`accessibility-reviewer`, `design-reviewer`, `torvalds-reviewer`,
`citation-verifier`) may hold ONLY
the read-only allowlist and must disallow `Write` + `Edit` — the README's
"read-only by construction" claim, machine-asserted.
**Anti-vacuity:** add a gate to VALIDATE_STEPS without touching AGENTS.md → FAIL
printing documented-vs-actual chains; advertise `pnpm ghost` → FAIL naming it;
delete a numbered section here → FAIL naming the undocumented gate; grant
`security-reviewer` Bash → FAIL naming the agent, the grant, and the doctrine.

### the validate runner — serial by default, pooled under `--report-all`

`node tools/validate.mjs` runs the chain strictly serially with streamed output,
stopping at the first failure — the fast agent edit-loop (one red, one fix). The
Stop hook instead passes `--report-all` so an agent sees EVERY red at once; there,
maximal runs of consecutive read-only gates (the `PARALLEL_SAFE` set: provenance,
expo-policy, native-deps, version-sync, prompts, licenses, schema-rls, migrations,
contracts, styleguide, route-manifest, docs-sync) execute in a small pool, with
output flushed in CANONICAL order. Any step NOT in that set runs exclusive:
build/e2e (subprocess-heavy), `perf-budget` (a wall-time measurement CPU
contention would flake red), and any consumer-added custom step — an unknown step
is never assumed pool-safe. `provenance` and `migrations` share a `git` resource
key so they never race `.git/index.lock`.

## Stop-hook runtime suites (`STOP_HOOK_STEPS`)

### rls-isolation — `node tests/rls/run-rls.mjs`

Live cross-user isolation against local Postgres (fresh-applies all migrations
first). Seeded positive control (a deny-all database must NOT pass), zero-row
cross-user SELECT/UPDATE/DELETE, SQLSTATE 42501 on INSERT smuggling,
pooled-connection GUC-leak detector (pool max=1), and the pg_catalog gate (FORCE
RLS flags, per-op policies, leading-column owner indexes, initPlan-shaped
predicates, patched pgvector, non-BYPASSRLS role). The plan-regression probe then
bulk-seeds at scale and EXPLAINs both a bare policy-shape SELECT and every query
the DAL ACTUALLY ISSUES (captured through a drizzle pg-proxy, registered in the
seeded `tests/rls/dal-shapes.ts`), redding on any `Seq Scan`, `Sort`, or per-row
`SubPlan` — the index must carry the ORDERING, not just the filter
(`0002_notes_keyset_idx.sql` is the worked pattern). Unreachable database → loud
SKIP locally; in CI with migrations present, unreachable = FAIL.
**Anti-vacuity:** drop one policy in a new migration → catalog gate + isolation
matrix FAIL; break the impersonation helper → the positive control fails, proving
the suite cannot green vacuously; delete the keyset index migration → the DAL plan
probe FAILs on a `Sort` while the policy-shape probe stays green — the proof the
simpler check was structurally blind.

### unit — `pnpm exec vitest run --coverage --silent`

The node-side behavioral net: server (auth clock-skew, envelope bounds,
production+stub boot-fatal, skew middleware, SSE abort), packages (contracts
drift, importer property tests, eval fixture scorer), and the PURE mobile modules
(i18n incl. the pseudo-locale derivation and RTL direction table, routes closure,
kv, the SSE parser, the fuzzy scorer, recents) — pure meaning zero react-native in
the import closure, so Node's runner is honest for them. `--coverage` enforces the
aggregate thresholds in `vitest.config.ts` and writes the istanbul map the
diff-coverage step reads.
**Anti-vacuity:** drop a large untested module → the aggregate threshold reds the
run.

### mobile-unit — jest-expo `--coverage --silent` (via `pnpm test:mobile`)

The react-native half of the unit floor: RN components/screens cannot run under
the node runner without a fragile transform pipeline, so `apps/mobile` runs under
jest-expo (RNTL) — the same suites the `e2e` gate runs, here with `--coverage` so
the jest istanbul map lands in `apps/mobile/coverage/` for the next step. The
runner split is pinned in `jest.config.js` (its ignore list mirrors the vitest
include list, so no test ever runs under both runners).
**Anti-vacuity:** break a screen's reducer → the flow suite reds; delete every
assertion from a suite → test-quality reds it below.

### diff-coverage — `node tools/check-diff-coverage.mjs`

Per-file coverage floors on every CHANGED source file (merge-base diff in CI;
worktree + staged + untracked locally — the brand-new uncommitted feature file is
exactly the case that must not slip), read from the TWO maps the unit steps just
wrote: the vitest map for server/packages/pure-mobile files, the jest map for
`apps/mobile/**`. Each changed code file must be present in its runner's map
(absent = no test imports it) and clear the per-file floors declared next to that
runner's config. A missing map FAILS CLOSED (the chain was reordered or the
artifact deleted); an empty diff passes with a note.
**Anti-vacuity:** add an untracked `apps/server/src/` file with an exported
function and no test → FAIL naming the file as absent from the coverage map.

### duplication — `node tools/check-duplication.mjs`

Copy-paste rot: a zero-dep token clone detector over `apps/*/src` +
`packages/*/src` (comments stripped, string/number literals normalized, ≥70-token
AND ≥6-line matching runs reported once with both sites and a stable content
fingerprint). Exact-ish matching, so a red is a genuine paste, not two functions
that rhyme. Reviewed accepted clones live in `tools/duplication-allow.json`
(write-guard-protected), keyed by fingerprint so an accepted clone stays accepted
after it moves lines.
**Anti-vacuity:** paste a ≥70-token block across two files → FAIL naming both
sites + fingerprint.

### i18n — `node tools/check-i18n.mjs`

The locale seam is real and nothing bypasses it: (1) no hardcoded user-facing
string — JSX text under AppText, user-facing props (`accessibilityLabel`,
`accessibilityHint`, `placeholder`, alert/toast copy), and the object literals
that hold copy (route titles, action command titles, matrix column headers) all
resolve through catalog keys; (2) `Intl` / `toLocale*` / `.toFixed(` only inside
`src/i18n/` — `.toFixed(2)` hardcodes the `.` decimal mark; (3) no dead catalog
key. A text scan, not a compiler: a string assembled at runtime is invisible BY
CONSTRUCTION — the pseudo-locale sweep in the RNTL lane (every `en` source string
must come back mangled under `en-XA`; `ar-XB` is the RTL pass) is the behavioral
other half. `tools/i18n-allow.json` is the reviewed escape (malformed or stale
entries FAIL).
**Anti-vacuity:** hardcode "Add a note" in a screen → the scan reds it; assemble
it from fragments → the scan stays green and the pseudo-locale sweep reds it —
run both before trusting either.

### test-quality — `node tools/check-test-quality.mjs`

Assertion PRESENCE — the cheap ~50ms half of the assertion-quality control:
(1) a committed `.only` is FATAL with no escape (it silently disables every other
test while the suite reports green); (2) a declared-but-never-run test
(`.skip`/`.todo` modifier, `xit`) is reviewable via `tools/test-quality-allow.json`
(reason mandatory); (3) a test body with no assertion call reds. The runtime
conditional `test.skip(condition, reason)` is a different construct and stays
green. This gate is GAMEABLE ALONE (`expect(true).toBe(true)` clears it) and that
is understood: what proves a test would NOTICE a break is the mutation lane, and
that is why both exist.
**Anti-vacuity:** commit an `it.only` → FAIL, no allowlist accepted.

### mobile-perf — `node tools/check-mobile-perf.mjs --closure`

The CLOSURE half of the mobile performance floor, static and ~10ms: every route in
`src/routes.ts` must have a Maestro flow (`maestro/flows/<id>.yaml`) AND a budget
row in `tools/startup-budget.json` — and stale flows/rows red. This is what makes
the device lane a FLOOR rather than a note about the seed screens: an agent cannot
end a turn having added a screen that no machine check will ever time. The
MEASUREMENT half (`check-mobile-perf.mjs` without `--closure`, reading the device
lane's `artifacts/perf-results.json`: cold-start `am start -W` TotalTime,
`reportFullyDrawn`, per-screen budgets) needs an emulator and minutes — CI-only.
**Anti-vacuity:** register a route with no flow file → FAIL naming the missing
flow and budget row; leave a stale row for a deleted route → FAIL.

## CI-only lanes (outside the chain and the Stop hook)

- **Maestro device lane** (`mobile-e2e`) — credential-free: `expo prebuild -p
  android` → gradle assemble → install on a GH-hosted emulator → the per-route
  flows plus the GENERATED route sweep (`tools/check-e2e-device.mjs`, flows
  derived from `src/routes.ts` by `tools/lib/maestro-flows.mjs` — a new route is
  swept with zero YAML edits), re-run under a flipped OS theme and font_scale
  1.3. Two installs, honestly split: the RELEASE binary (minified Hermes — where
  Fabric view flattening actually bites) runs the sweeps signed-out; the DEV
  binary (Metro on the runner) runs what release cannot — the kv-pre-seeded
  ar-XB/RTL boot (`maestro/journeys/i18n-rtl.yaml`), the mutation flow
  (stub sign-in → create note → relaunch → persists, against the real server +
  Postgres), and the perf-harness journey (the dev screen self-measures against
  `tools/interaction-budget.json` and the flow asserts its `perf-pass` leaf).
  Path-filtered + nightly (emulator cost); anti-vacuity: a phase that executed
  zero flows exits red, and evidence (Maestro debug output, screenshot, logcat
  tail) uploads on every failure.
- **Startup measurement lane** (`perf-lane`) — `tools/measure-startup.mjs`
  cold-starts every ROUTES entry ×3 on its own quiet emulator (`am force-stop`
  + `am start -W` per deep link; `totalTimeMs` is the MEDIAN, every roll
  recorded in `coldSamplesMs`), then one WARM start per route (HOME +
  relaunch; `warmTotalTimeMs`, capped only by rows declaring
  `maxWarmTotalTimeMs` — a declared-but-unreported cap reds), writes
  `artifacts/perf-results.json`, and `HARNESS_PERF_LANE=1 node
  tools/check-mobile-perf.mjs` enforces `tools/startup-budget.json` — failing
  CLOSED if the artifact is missing. Honest limit: `fullyDrawnMs` stays absent
  in the managed scaffold (no RN/Expo binding for `reportFullyDrawn()`;
  injecting native source would break CNG purity) — the median + warm split is
  the managed replacement, and the parse stays armed for consumers that add a
  native binding.
- **mutation** — `pnpm mutation` (StrykerJS over the critical surface —
  authorization and transport boundary code), a SET-based ratchet against
  `tools/mutation-baseline.json`: a NEW surviving mutant reds; accepting one is a
  reviewed human act (empty reason FAILS; the file is write-guard-protected and
  gate-integrity-hashed). Never in the Stop chain — minutes vs the chain's
  seconds budget.
- **osv-scan** (`osv-scan.yml`, its own workflow) — known-vulnerability SCA over
  every discovered `pnpm-lock.yaml` against the OSV database. The PR job is
  DIFF-AWARE (only newly introduced vulns red a PR — the deterministic form of a
  vulnerability gate: an unchanged tree never reds on an upstream advisory); the
  weekly full-tree scan owns time-based discovery; Renovate owns the fix path.
  Google's official reusable workflows, SHA-pinned. This is why `pnpm audit`
  stays out of the validate chain (see Considered and rejected).
- **live-api proof** — `__tests__/live-api-proof.test.ts` (jest, self-skipping
  unless `LIVE_PROOF=1` + a running `AUTH_MODE=stub` server): the one place the
  mobile client's real api-client talks to the real server over real Postgres
  under FORCE RLS. Every other lane mocks the network — which is exactly how the
  desktop original once shipped requests with no Authorization header at all
  while every gate stayed green. Its negative control (an unauthenticated call
  must fail) keeps it falsifiable, and the harness selftest proves the lane
  end-to-end (Canary C01: strip the api-client's one bearer-attaching line →
  the suite reds, restore → green).

## Opt-in modules

`npx next-expo-supabase-agent-harness enable <module>` copies the module's files and
records it in `.harness/manifest.json`. Tiers: `core` = none, `standard` =
ci-provenance + ci-mobile-release, `strict` = all.

| Module | What it adds | Why not default-on |
|---|---|---|
| `ci-mobile-release` | the EAS release DAG: store-credentialed builds, submission, signed-artifact checks | needs store credentials and a release cadence |
| `device-e2e` | the extended on-device Maestro matrix beyond the base lane | slow emulator runners; the base lane covers the floor |
| `eas-update` | OTA update channel wiring + staged-rollout runbooks | OTA is a policy decision (runtimeVersion reach, rollback story) |
| `store-metadata` | store listing metadata as reviewable JSON in-repo (+ iOS privacy manifests) | meaningful once a listing exists |
| `ci-provenance` | SBOM + build attestation + verification step + NOTICES drift check | meaningful once artifacts ship to a consumer who verifies them |
| `gate-a11y-deep` | screen-reader checklist + extended a11y assertions beyond the lint/RNTL floor | needs human-in-the-loop passes; the floor already lint/test-enforces |
| `crash-reporting` | crash/error ingestion wiring, symbol upload, redaction unit test | needs an ingestion endpoint; redaction policy is project-specific |
| `push-notifications` | push credential wiring + permission-prompt discipline | a product decision with store-policy weight |
| `ops-backup` | pgBackRest configuration + restore-drill runner | operational infrastructure, not repo code |
| `eval-live` | GPU-runner live-model eval lane: GBNF/schema pre-validation, exemplar/holdout disjointness check | needs GPU hardware and a served model; the default eval is fixture-scored by design |
| `observability` | OpenTelemetry wiring for the server + span-per-route test | adds a runtime dependency and an OTLP target decision better made deliberately |

## Considered and rejected

Recorded so the next maintainer doesn't re-litigate (the port-time decisions live
in the design record; the enduring ones repeat here):

- **`runtimeVersion.policy = 'fingerprint'`** — a computed hash is not
  PR-reviewable; `appVersion` is. Revisit only if OTA reach across store versions
  becomes a product requirement.
- **EAS remote version source / autoIncrement** — moves a version surface into a
  database no gate can diff; breaks the hermetic selftest.
- **A styling compile layer (utility-class or native styling runtime)** — a
  compiler between the styleguide manifest and the pixels defeats the
  tokens-as-data scannability the styleguide gate depends on.
- **Maestro-in-the-chain** — an emulator boot ahead of every validate would turn
  a seconds gate into a minutes gate; the closure check keeps the floor while the
  device lane pays the cost in CI.
- **A second SSE dependency** — an XHR-based client would bypass the api-client
  one-door; the SSE client is a hand-rolled pure parser driven through injected
  streaming fetch, unit-tested at every chunk boundary.
- **pgTAP** — the plain-SQL catalog assertions inside the RLS suite check the
  same pg_catalog facts without a second test toolchain.
- **ts-prune / lockfile-lint / type-coverage / markdownlint** — superseded by
  `knip --strict`, pnpm strict lockfiles + frozen CI installs, the type-aware
  ESLint bans, and Biome respectively.
- **`pnpm audit` in the validate chain** — non-deterministic in TIME: a new
  upstream advisory in the Expo dependency tree would red an unchanged tree —
  and brick every fresh scaffold — and an allowlist only converts each advisory
  into an emergency edit of a write-protected file. The `osv-scan` PR lane is
  the deterministic form of the same control (diff-aware: only NEWLY introduced
  vulns red a PR), the weekly full scan owns time-based discovery, and Renovate
  owns the fix path.
- **react-native-reanimated (0.1.2)** — a Babel transform plus a native worklet
  runtime between the motion tokens and the pixels — the styling-compiler class,
  for motion — when everything this tier needs (press scale, entrance
  fade/slide, skeleton pulse) sits inside core `Animated`'s native-driver
  whitelist with zero added dependencies. Revisit only for gesture-driven
  surfaces (sheets/swipes), as an opt-in module.
- **A runtime memory budget** — reaffirmed against the 0.1.2 perf wave: no
  managed-runtime measurement is honest enough to gate on (a jest heap number
  measures jest), so leak discipline stays the static effect-cleanup scan plus
  the emitter-count spec, and unmeasured numbers do not ship.
- **max-lines file/function caps** — proxy metrics that punish cohesive modules;
  sonarjs cognitive-complexity ≤ 15 targets the actual failure mode.
- **deterministic same-turn test-edit bans** — a hook cannot distinguish
  reward-hacking from legitimate code+tests work; kept as a review-time rule plus
  the mutation lane, which catches the damage rather than the act.
