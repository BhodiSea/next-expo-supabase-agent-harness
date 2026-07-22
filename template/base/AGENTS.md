# AGENTS.md — {{PROJECT_NAME}} mobile platform

Canonical project memory (CLAUDE.md points here). Advisory context — the Stop
hook + CI are the real enforcement. Keep under ~200 lines.
SOURCE: docs/harness/README.md.

## Stack (pnpm monorepo, versions live ONLY in the pnpm-workspace.yaml catalog)

- **apps/mobile** — Expo SDK 57 (React Native 0.86 + React 19, Hermes, New
  Architecture, React Compiler on) with expo-router file routes under `app/`.
  CNG: `android/` and `ios/` are prebuild OUTPUT — generated, never committed,
  never hand-edited; native change = config plugin from the reviewed allowlist
  (`tools/expo-plugins.json`). The keychain (expo-secure-store) has ONE door:
  `src/host/**` — auth providers own the credential lifecycle but store through
  the host seam's `secure*` helpers; the API only via `src/lib/api-client.ts`.
- **apps/server** — Hono + Node 22 API on `PORT` (default 8787). Auth =
  `AUTH_MODE=stub|entra`, one jose `jwtVerify` path (pinned iss/aud/alg,
  `clockTolerance: 300`). Boot-time fatal: `NODE_ENV=production` + stub.
- **packages/contracts** — `@app/contracts`: pure-Zod wire contracts, the ONLY
  schema surface both sides import. `EMBEDDING_DIM = 1024`.
- **packages/schema** — `@app/schema`: Drizzle tables + append-only migrations
  in `packages/schema/drizzle/`. Server-side only — mobile never resolves it.
- **packages/importer** — deterministic parsers + fast-check property tests.
- **packages/eval** — Inference/Embedding ports, fixture-scored eval, versioned
  hash-locked prompts. NO live model calls anywhere in the repo.
- **Postgres 16 + pgvector** via `docker-compose.yml` (`pnpm db:up`). Roles from
  `db/init/01-roles.sql`: `app_migrator` (owns schema, migrations only) and
  `app_api` (the server's login role — NOSUPERUSER, NOBYPASSRLS, FORCE RLS).

## Package manager: pnpm 11 (pinned via `packageManager`), Node >= 22

ALWAYS `pnpm`, never `npm`/`yarn`. Workspace deps = `workspace:*`; external
versions = `catalog:` (the catalog is the only place version numbers appear).

## Commands

- `pnpm validate` — **THE GATE**: `node tools/validate.mjs`, the 21-step chain
  from `tools/harness.config.mjs` (see below). Must be green before a turn ends.
- `pnpm typecheck` (`tsc -b`) · `pnpm lint` / `pnpm lint:fix` · `pnpm format`
  (`biome check --write .`) · `pnpm knip` · `pnpm arch` (depcruise).
- `pnpm test` (`vitest run`) · `pnpm test:mobile` (jest-expo, the RN half) ·
  `pnpm test:rls` (`node tests/rls/run-rls.mjs` — live isolation vs Postgres).
- `pnpm db:up` · `pnpm db:migrate` (drizzle-kit migrate as `app_migrator`).
- `pnpm dev:server` · `pnpm dev:mobile` · `pnpm openapi:emit` · `pnpm mutation`.

## The validate contract (YOU MUST)

- A turn is NOT done until `pnpm validate` is green. The Stop hook re-runs
  validate (`--report-all`) + `node tests/rls/run-rls.mjs` + the vitest suite
  with coverage + the jest-expo suite with coverage (`mobile-unit` — the two
  istanbul maps are merged) + `node tools/check-diff-coverage.mjs` (per-file
  floors on every CHANGED file) + `node tools/check-duplication.mjs` (token
  clones across `apps/*/src` + `packages/*/src`) + `node tools/check-i18n.mjs`
  (no hardcoded user-facing string; Intl/toLocale*/toFixed only in `src/i18n/`)
  + `node tools/check-test-quality.mjs` (every test asserts; nothing focused or
  disabled) + `node tools/check-mobile-perf.mjs --closure` (every route has a
  Maestro flow AND a startup-budget row) and exits 2 until everything passes.
- **Prove, don't claim.** Show passing gate output; never assert "it works".
- Do NOT edit a test in the same turn as the fix it covers (reward-hacking).
- The 21 gates, in order: `format`, `gate-integrity`, `types`, `lint`,
  `provenance`, `expo-policy`, `native-deps`, `version-sync`, `prompts`,
  `licenses`, `schema-rls`, `migrations`, `contracts`, `dead-code`,
  `architecture`, `build`, `styleguide`, `perf-budget`, `route-manifest`,
  `e2e`, `docs-sync` (docs/harness/gates-catalog.md documents each).
- **Toolchain asymmetry:** gates needing a live database, an install, or a
  network-verified toolchain SKIP LOUDLY locally when the prerequisite is
  absent and FAIL CLOSED in CI (`CI=true` / `HARNESS_REQUIRE_TOOLCHAINS=1`).
  A skip is never a pass — do not treat a SKIPPED line as done.

## Security invariants (NON-NEGOTIABLE — hook- and lint-enforced)

- **`withUserContext(userId, fn)` IS the authorization boundary.** Every
  `apps/server/src/dal/*` module acquires the database through it (opens a tx,
  `SET LOCAL app.user_id`), returns Zod-parsed DTOs, never raw rows. Routes
  never touch the db driver. **The mobile app, its URL scheme, and the OS
  keychain are NOT authorization** — the app is an untrusted client bearing a
  scoped token; authorize in the DAL, on FORCE RLS.
- **The app talks to the API ONLY through `src/lib/api-client.ts`** —
  `apiFetch`/`apiPost` attach the bearer token and decode the error envelope
  (with the one refresh-then-retry-once 401 path). Never call `fetch()` from a
  feature (lint-banned): a bare request 401s against the real server, and every
  unit test mocks the network, so nothing local would tell you. The token lives
  in the platform keychain behind `src/host/**` (expo-secure-store one-door —
  lint + depcruise), never in JS-visible storage and never behind an
  `EXPO_PUBLIC_` name (those are inlined into the shipped JS bundle).
  `__tests__/live-api-proof.test.ts` is where both halves run for real.
- **GUC discipline:** RLS identity is `set_config('app.user_id', $uuid, true)`
  inside a transaction. NEVER `set_config(..., false)`, `SET SESSION app.*`, or
  bare `SET app.*` — session GUCs leak identity across pooled connections.
- **Migrations are append-only.** Never edit or delete a committed migration —
  add a new one (`drizzle-kit generate`). `drizzle-kit push`/`drop` are blocked.
  Destructive DDL (DROP TABLE/COLUMN, TRUNCATE) needs `-- adr: docs/adr/<file>`;
  DML in a migration needs `-- harness-allow-dml: <reason>`.
- **`MIGRATOR_DATABASE_URL` bypasses RLS** (schema owner). Sanctioned uses only:
  drizzle-kit migrate/generate/check and the harness RLS runners
  (`tests/migrations/`, `tests/rls/` — plan-probe seeding + ANALYZE). Never in
  app or assertion code: isolation asserts always run as `app_api`.
- **Every new table ships FORCE RLS**: `ENABLE` + `FORCE ROW LEVEL SECURITY` +
  four per-operation policies reading
  `(select current_setting('app.user_id', true)::uuid)` (initPlan pattern) +
  a leading-column index on the owner column, in the same migration.
  Exemptions = human-reviewed `tools/rls-exempt.json`.
- **Every DAL method is registered in `tests/rls/dal-shapes.ts`** — and so is every
  interesting ARGUMENT shape (a first page and a cursor page plan differently). The plan
  probe drives the REAL DAL through a capturing pg-proxy and `EXPLAIN`s the SQL it emits at
  scale, redding on any `Seq Scan`, `Sort` or per-row `SubPlan`. **The index must carry the
  ORDERING, not just the filter**: index `(owner_id, <the ORDER BY columns, declared
  direction>)` so one index serves the policy, the sort and the cursor range
  (`0002_notes_keyset_idx.sql` is the worked pattern).
- **Mobile-bundle purity:** `apps/mobile` never imports `postgres`,
  `drizzle-orm`, `pg`, `@hono/*`, `pino`, `@app/schema`, or anything in
  `apps/server`. It talks to the API via `@app/contracts` DTOs only.
- **No EXPO_PUBLIC_-prefixed secret-shaped names** (`*KEY|SECRET|TOKEN|
  PASSWORD|PRIVATE`) — EXPO_PUBLIC_ vars are inlined into the shipped bundle.
- **Store identity is locked** in `tools/identity.lock.json` (bundle id /
  package) — it is upgrade identity and never changes. `version`,
  `ios.buildNumber`, `android.versionCode` are DERIVED from package.json in
  `app.config.ts`; `eas.json` keeps `appVersionSource: "local"`,
  `autoIncrement: false`; `runtimeVersion.policy` stays `appVersion`.
- **Store readiness is gate data** (`tools/store-policy.json`, reviewed):
  export compliance stays DECLARED (`ITSAppUsesNonExemptEncryption`), every
  iOS usage string is reviewed in `tools/expo-permissions.json` `ios[]`, the
  targetSdk floor holds, and an auth surface requires the account-deletion
  surface (`session.deleteAccount` + `DELETE /api/me` — Apple 5.1.1(v)).
- **`WITH RECURSIVE` requires a `CYCLE` clause or visited guard** — graph data
  loops forever otherwise.
- **Prompt lock discipline:** every LLM prompt file is versioned in its name
  (`extract.v1.md`) and hash-locked in `tools/prompts.lock.json`. Changing a
  prompt = new `.vN` file + re-run the eval + deliberate lock update (the lock
  is write-guard-protected).
- **Shell hygiene** (bash-guard enforced): no `rm -rf`, no force-push, no
  `git reset --hard`, no `git commit --no-verify`, no reading `.env*` /
  `.dev-auth/`, no `pnpm update` (Renovate owns bumps), no `knip --fix`, no
  destructive raw SQL outside migrations, and store/signing credentials
  (`EXPO_TOKEN`, Android keystores, Apple API keys) never touch shell or repo.

## Quality bar

- Data structures first: design schema/DTO/contract before code.
- Eliminate special-casing; delete code; justify every abstraction. `knip
  --strict` stays green. Cognitive complexity <= 15 (ESLint error).
- Adversarial self-review before declaring done: try to break your own code.
- **Server surface:** errors through the ONE envelope
  (`src/errors.ts` — `{ error: { code, message, requestId } }`); every wire
  string bounded (`.max()`); every list keyset-paginated with an unconditional
  LIMIT (`dal/notes.ts` + `dal/cursor.ts` are the worked pattern).
- **Coverage floors are enforced**: the Stop hook runs BOTH unit lanes with
  coverage (vitest for server/packages/pure mobile logic; jest-expo for RN
  components/screens), then `tools/check-diff-coverage.mjs` holds every CHANGED
  source file to the per-file floors over the merged maps.
- **Coverage is not verification.** `tools/check-test-quality.mjs` (Stop chain)
  reds assertion-free tests, `.only` (fatal, no escape), and dead `.skip`
  declarations; the mutation lane (`pnpm mutation`, CI-blocking) changes the
  code and asks whether a test goes red — a SET-based ratchet against
  `tools/mutation-baseline.json`, never a score. Accepting a survivor is a
  reviewed human act (empty reasons FAIL).
- **Styling is tokens-only, in BOTH themes.** `tools/styleguide.manifest.json`
  (OKLCH) is the design source; `tools/gen-theme.mjs` emits the committed
  `src/theme/tokens.gen.ts`; components style via `useThemedStyles((palette) =>`
  factories over those tokens. No color literals, no inline styles (lint), no
  hand-edited tokens.gen.ts (regen-diff). The styleguide gate COMPUTES WCAG
  contrast from the OKLCH tokens for every declared pair in both themes.
- **Controls render through `src/components` primitives** (AppText/Button/
  Input/Field/Screen/Toast/EmptyState/OptionRow) — raw text outside AppText is
  lint-red; new control styling goes into the primitive.
- **Put testID on the interactive/accessible LEAF element** — Fabric view
  flattening can detach a testID riding an unstyled wrapper View: the New
  Architecture optimizes layout-only Views out of the native tree
  (https://reactnative.dev/architecture/view-flattening). A styled or
  accessible element survives; a bare layout View may not.
- **Every effect that registers tears down in the cleanup it RETURNS** — the
  perf-budget gate's leak scan pairs `.addEventListener`→`.removeEventListener`/
  `.remove()`, `.addListener`→`.remove()`, `setInterval`→`clearInterval`,
  `requestAnimationFrame`→`cancelAnimationFrame`, `.subscribe(`→`.unsubscribe()`,
  `runAfterInteractions`→`.cancel()`. Mobile apps live for days between cold
  starts — a leaked AppState/Keyboard listener compounds. Escape = reviewed
  `tools/perf-budget.json` `effectCleanupAllow[]` entry.
- **Write UX follows `features/notes`**: optimistic insert with a temp id,
  reconcile-or-rollback in ONE reducer (`useCreateNote.ts`), zod errors inline
  at the contract boundary, failures as envelope-code toasts translated via
  `i18n/errors.ts` — never a phantom row after a failed write.
- **Every user-facing string is a catalog key** (`src/i18n/catalog.ts`); render
  with `t('key')` / `useI18n()`. Plurals via `Intl.PluralRules` with a `count`
  param, never an `if`. `Intl`, `toLocale*`, `.toFixed()` are BANNED outside
  `src/i18n/` (turn-fatal `i18n` Stop step). Hermes ships NO `Intl.PluralRules`,
  `Intl.RelativeTimeFormat`, or `Intl.Locale` — the @formatjs polyfills load
  FIRST in `app/_layout.tsx`, unconditionally, so device and Node run the same
  CLDR data; avoid `NumberFormat.formatToParts` (Android-only under Hermes).
  Error copy comes from the envelope's stable `code`, never its raw `message`.
- **Every screen registers in `src/routes.ts`** (id, `titleKey` — a catalog
  key, path, file, `states.{loading,empty,error}` testIDs). The route-manifest
  gate closes both ways; chrome lives in `tools/route-allowlist.json`. The
  mobile-perf closure requires a Maestro flow + `tools/startup-budget.json` row
  per route — an unmeasured screen cannot land.
- **Data-dense screens follow `features/matrix`**: FlatList IS the virtualizer
  (fixed row height shared with `getItemLayout`, tuned window), keyset
  pagination via `useKeysetQuery`, one accessible element per row, an explicit
  Load-more control alongside the scroll trigger.
- **Commands follow `features/actions`** (the `app/actions.tsx` modal): typed
  registry (`registry.ts` — the `ActionGroup` union makes an unsectioned
  command a compile error; titles are catalog keys, ranked over the RESOLVED
  text), deterministic pure scorer (`fuzzyScore.ts` — total order: score desc,
  title asc, id asc; no Date, no randomness), recents persisted through the kv
  seam (`recents.ts` — corrupt payloads read as empty, capped, stale ids
  filtered at render). New commands extend the registry, never the modal.

- **Design bar (the `designing-mobile-ui` skill is the full doctrine; the
  `design-reviewer` holds diffs to it).** Motion uses motion tokens only,
  through the seam (`src/lib/motion.ts`), animates transform/opacity only, and
  collapses under reduce-motion by construction. Loading is skeleton→content
  (the Skeleton primitive mirrors the incoming layout — never prose; the
  states sweep asserts the progressbar role). Touchables render through
  PressableScale (scale + 44dp `sizes.minTarget` + optional haptic); cards
  through Card; icons from the closed glyph set. One accent moment per region
  (the accent budget). Empty states carry a primary action; error surfaces
  keep their retry + three registers. UI diffs end with a `design-reviewer`
  PASS.

## Provenance

- Non-trivial decision sites (RLS SQL, jwtVerify/JWKS options, vector index
  choices, retry/timeout/sampling constants, ATS/policy choices) carry
  `// SOURCE: <authority> [corpus: <id>]` (`-- SOURCE:` in SQL). Corpus ids
  resolve against `tools/mcp/corpus/index.json` (use the `corpus_search` MCP
  tool mid-turn; extend the corpus in the PR that cites it). Cite an entry whose
  `groups` cover the decision's class (cross-group escapes = human-reviewed
  `tools/provenance-overrides.json`); a bare URL counts only on a
  `tools/lib/citation-domains.mjs` allowlisted host.
- Emit one ADR per slice via `/adr <slice>` (records in `docs/adr/`); then run
  `/verify-citations` until it returns `CITATIONS: CLEAN`.

## Spec-first & governance

- **Spec-first** for anything touching auth, RLS, migrations, the native config
  surface (`app.config.ts` / `eas.json` / config plugins / permissions), or the
  API contract: write `specs/<feature>.md` (template: `specs/_template.md`),
  get sign-off, then implement.
- Schema changes follow the expand→contract runbook
  (`docs/runbooks/expand-contract.md`) — mobile clients skew by MORE than a
  version: store review lags, rollouts are staged, and some installs never
  update. Server first, contract phase last.
- `/new-feature <name>` drives the one-turn slice recipe (the
  `authoring-vertical-slice` skill): migration + RLS → DAL → route + contract
  regen → mobile screen → tests → provenance → green gate.
- Reviewers are read-only subagents (the `docs-sync` gate asserts their
  frontmatter stays read-only): `security-reviewer` (MUST run on RLS/DAL/auth
  changes), `mobile-security-reviewer` (MUST run on keychain/api-client/
  app.config/eas.json/permission changes), `accessibility-reviewer` and
  `design-reviewer` on UI changes, `torvalds-reviewer` before finishing,
  `citation-verifier` via `/verify-citations`.
- PRs paste real `pnpm validate` + `pnpm test:rls` output; CODEOWNERS
  ({{SECURITY_OWNERS}}) sign off on auth/data/harness surfaces. New MCP servers
  or Skills must be registered in `docs/security/approved-tools.md` first. Keep
  private data out of the lethal trifecta
  (`docs/security/sandbox-and-supply-chain.md`).
