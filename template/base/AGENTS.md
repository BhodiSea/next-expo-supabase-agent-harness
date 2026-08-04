# AGENTS.md — {{PROJECT_NAME}} web + mobile platform

Canonical project memory (CLAUDE.md points here). Advisory context — the Stop
hook + CI are the real enforcement. Keep under ~200 lines.
SOURCE: docs/harness/README.md.

## Stack (pnpm monorepo, versions live ONLY in the pnpm-workspace.yaml catalog)

- **apps/web** — Next 16 (App Router, React 19, Server Components + Server
  Actions), deployed on Vercel. It SERVES the API: `app/api/trpc/[trpc]/route.ts`
  mounts `@app/api`, choosing the cookie-backed Supabase client for browser
  sessions and the bearer client for mobile. Server-side identity is
  `getUser()`/`getClaims()`, NEVER `getSession()`; the request-scoped client is
  built per request, never at module scope. `proxy.ts` refreshes the session
  cookie and is NOT an authorization boundary (CVE-2025-29927).
- **apps/mobile** — Expo SDK 57 (React Native 0.86 + React 19, Hermes, New
  Architecture, React Compiler on) with expo-router file routes under `app/`.
  CNG: `android/`/`ios/` are prebuild OUTPUT — generated, never committed; native
  change = config plugin from the reviewed allowlist (`tools/expo-plugins.json`).
  Data flows through the tRPC client (`src/lib/trpc/client.ts`) or a vertical's
  `./client`; the Supabase session lives in `LargeSecureStore`
  (`src/lib/supabase/**` — AES-256-CTR key in expo-secure-store, ciphertext in
  AsyncStorage), never JS-visible storage.
- **packages/api** — `@app/api`: the framework-neutral tRPC v11 router
  (`publicProcedure` → `authedProcedure` → `memberProcedure`; the version-skew
  guard on the base). Imports NO `next/*` — the reversibility wall. Mobile takes
  it as a devDependency, `import type` only (Metro does not tree-shake).
- **packages/contracts** — `@app/contracts`: hand-authored zod DTOs + the
  GENERATED action/event inventories both surfaces import; the `contracts` gate
  regen-diffs the inventories.
- **packages/verticals/\*** — feature domains (never import each other), each a
  `.` server barrel + a Metro-safe `./client` barrel (the `exports` census is
  `tools/exports-walls.json`).
- **packages/platform/\*** — `{errors, events}` are the KERNEL (import nothing —
  the bottom of the graph; the single `ActionOutcome` envelope lives here).
  `@app/supabase` owns the five Supabase factories (`service_role` BYPASSES RLS —
  ADR-governed Edge Functions only); `@app/env` validates env per surface.
- **packages/design-tokens** — the single OKLCH TS token source →
  `src/generated/native.ts` (mobile) + `src/generated/web.css` (Tailwind v4);
  `design-system` (web/Radix) and `design-system-native` (NativeWind) share only
  tokens + icon paths, never components.
- **Supabase** — Postgres + RLS + Auth, ONE backend for both surfaces. Schema is
  SQL-first: `supabase/schemas/*.sql` (declarative) + `supabase/migrations/*.sql`
  (append-only). RLS keys on `auth.uid()`; the caller runs as `authenticated`.
  `pnpm db:up` = `supabase start` (API 54321, Postgres 54322, Studio 54323).

## Package manager: pnpm 11 (pinned via `packageManager`), Node >= 22

ALWAYS `pnpm`, never `npm`/`yarn`. Workspace deps = `workspace:*`; external
versions = `catalog:` (the catalog is the only place version numbers appear).

## Commands

- `pnpm validate` — **THE GATE**: `node tools/validate.mjs`, the 29-step chain
  from `tools/harness.config.mjs` (see below). Must be green before a turn ends.
- `pnpm typecheck` (`tsc -b`) · `pnpm lint` / `pnpm lint:fix` · `pnpm format`
  (`biome check --write .`) · `pnpm knip` · `pnpm arch` (depcruise).
- `pnpm test` (`vitest run`) · `pnpm test:mobile` (jest-expo, the RN half) ·
  `pnpm test:rls` (`node tests/rls/run-rls.mjs` — live isolation vs the supabase stack:
  pgTAP + the supabase-js client suite).
- `pnpm db:up` (`supabase start`) · `pnpm db:reset` · `pnpm db:test` (pgTAP) ·
  `pnpm db:types` (regenerate the Supabase type mirror) · `pnpm gen` (types + tokens).
- `pnpm dev:web` · `pnpm dev:mobile` · `pnpm mutation`.

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
- The 29 gates, in order: `format`, `gate-integrity`, `types`, `lint`,
  `provenance`, `boundaries`, `expo-policy`, `native-deps`, `version-sync`,
  `prompts`, `licenses`, `schema-rls`, `tenancy`, `types-drift`, `migrations`,
  `db-limits`, `contracts`, `query-shapes`, `rate-limits`,
  `parity`, `dead-code`, `architecture`, `build`, `styleguide`, `perf-budget`,
  `route-manifest`, `security-headers`, `e2e`, `docs-sync`
  (docs/harness/gates-catalog.md documents each).
- **Toolchain asymmetry:** gates needing a live database, an install, or a
  network-verified toolchain SKIP LOUDLY locally when the prerequisite is
  absent and FAIL CLOSED in CI (`CI=true` / `HARNESS_REQUIRE_TOOLCHAINS=1`).
  A skip is never a pass — do not treat a SKIPPED line as done.

## Security invariants (NON-NEGOTIABLE — hook- and lint-enforced)

- **RLS on `auth.uid()` IS the authorization boundary.** Every user-scoped table
  ships `ENABLE` + `FORCE ROW LEVEL SECURITY` in the SAME migration, with
  per-operation policies (`TO authenticated`, `WITH CHECK` on INSERT/UPDATE) keyed
  on `auth.uid()`, a leading-column owner index, `REVOKE ALL` from `service_role`,
  and grants to `authenticated`. Web and mobile hit the SAME policies, so isolation
  is enforced in ONE place; `supabase/tests/**` (pgTAP) + `tests/rls/` (supabase-js)
  prove tenant B cannot read A on every `db reset`. **The owner index must carry the
  ORDERING, not just the filter** — `(owner_id, <ORDER BY columns, direction>)` so
  one index serves the policy, the sort and the cursor range. Exemptions =
  human-reviewed `tools/rls-exempt.json`.
- **`service_role` bypasses RLS — it lives ONLY in an ADR-governed Edge Function**
  (`supabase/functions/<name>/index.ts`), built via
  `createServiceRoleClient_BYPASSES_RLS(warrant)`. NEVER in a Server Action, tRPC
  procedure, Route Handler, component, or the mobile bundle. Migrations `REVOKE ALL`
  from `service_role`; a function reaches a table only through an explicit per-table
  grant attached to the ADR.
- **Server-side identity is `getUser()`/`getClaims()`, NEVER `getSession()`** — the
  cookie is attacker-controlled and `getSession()` does not verify the signature.
  The request-scoped Supabase client is built per request from `cookies()`, never at
  module scope (a hoisted client leaks one request's identity into another's render).
  `proxy.ts` is not an authz boundary (CVE-2025-29927) — it only refreshes the
  session cookie.
- **The single error channel.** Procedures (`@app/api`) and web Server Actions return
  `ActionOutcome<T>` from `@app/errors` on the DATA channel; a domain failure is a
  returned `outcomeErr(appError.X())`, never a thrown error. Only two transport facts
  bypass it: the auth middleware's UNAUTHORIZED and the version-skew CONFLICT. The
  `app-error-only` ESLint rule is the static half.
- **Boundaries.** `verticals ⊥ verticals`; `shared ↛ verticals`; `platform/* →
  {errors,events}` only; `packages/api ↛ next/*` (reversibility wall); `apps/mobile ↛
  web-only packages`; `apps/web ↛ react-native`. The dual-barrel `exports` census is
  `tools/exports-walls.json`; `@app/api` is absent (mobile `import type` only).
- **Every org-scoped table carries an audit trigger** in the migration that creates it:
  `AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW EXECUTE FUNCTION
  audit.write_row('<tenant col>', '<identity col>')`, **never with a `WHEN` clause**.
  The trail is `audit.events` — a schema absent from `[api].schemas` with no client
  USAGE (RLS on a partitioned parent does not cascade to partitions, so a `public`
  audit table is one URL per month away from every tenant's history). Append-only in
  four layers: no update/delete policy, no client grant, a `BEFORE UPDATE OR DELETE`
  row trigger (the only one that binds `BYPASSRLS`), and a `BEFORE TRUNCATE` statement
  trigger on the parent AND every partition (TRUNCATE triggers are not cloned).
  Metadata by default; value capture is a reviewed `tools/audit-columns.json` entry and
  is refused for `tools/pii-columns.json` columns. ADR: `docs/adr/20260202-audit-trail.md`.
- **A metered table carries a per-org quota** in the migration that creates it: an
  `AFTER INSERT ... REFERENCING NEW TABLE ... FOR EACH STATEMENT` trigger executing
  `private.enforce_org_quota('<metric>', '<tenant col>')`, plus the `AFTER DELETE`
  release twin. **Never FOR EACH ROW** (it serializes every insert behind the org's
  one usage tuple) and **never a RESTRICTIVE policy over a `STABLE` count** (the
  planner hoists it to one evaluation per statement against the PRE-statement count,
  so a single multi-row INSERT of any size passes wholesale — it fails OPEN). Clients
  hold `SELECT` only on `org_usage`/`org_quota`: a tenant that can raise its own limit
  has none. Overflow is SQLSTATE `53400` → `appError.quotaExceeded()`, which is
  deliberately NOT `rateLimited` — waiting never clears a quota, so a client that
  conflates them retries forever. ADR: `docs/adr/20260203-resource-limits.md`.
- **Migrations are append-only.** Never edit or delete a committed migration — add a
  new timestamped `supabase/migrations/<timestamp>_<slice>.sql`. Destructive DDL
  (DROP/TRUNCATE) needs `-- adr: docs/adr/<file>`; DML in a migration needs
  `-- harness-allow-dml: <reason>`.
- **Mobile-bundle purity:** `apps/mobile` never imports a server-graph or
  service-role module, `next`, `react-dom`, or `@app/design-system` (DOM). It
  reaches data through the tRPC client (`src/lib/trpc/**`) or a vertical's `./client`,
  and holds its Supabase session only in `LargeSecureStore` (`src/lib/supabase/**`) —
  never JS-visible storage, never a log line.
- **No `EXPO_PUBLIC_`- or `NEXT_PUBLIC_`-prefixed secret-shaped names** (`*KEY|SECRET|
  TOKEN|PASSWORD|PRIVATE`) — both prefixes are inlined into their shipped bundle. The
  public config is `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE` /
  `EXPO_PUBLIC_*` transport only; the service-role key and any provider secret stay
  server-env.
- **Store identity is locked** in `tools/identity.lock.json` (bundle id /
  package) — it is upgrade identity and never changes. `version`,
  `ios.buildNumber`, `android.versionCode` are DERIVED from package.json in
  `app.config.ts`; `eas.json` keeps `appVersionSource: "local"`,
  `autoIncrement: false`; `runtimeVersion.policy` stays `appVersion`.
- **Store readiness is gate data** (`tools/store-policy.json`, reviewed):
  export compliance stays DECLARED (`ITSAppUsesNonExemptEncryption`), every
  iOS usage string is reviewed in `tools/expo-permissions.json` `ios[]`, the
  targetSdk floor holds, and an auth surface requires the account-deletion
  surface (a `session.deleteAccount` procedure — Apple 5.1.1(v)).
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
- **API surface:** procedures + Server Actions return the ONE envelope
  (`ActionOutcome` from `@app/errors`); every wire string bounded (`.max()`);
  every list keyset-paginated with an unconditional LIMIT
  (`packages/verticals/notes` is the worked pattern).
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
- **Styling is tokens-only, in BOTH themes.** `@app/design-tokens` (the TS
  modules in `packages/design-tokens/src`, OKLCH) is the single source;
  `packages/design-tokens/scripts/gen.mjs` compiles them — fail-closed on gamut +
  WCAG contrast — into the committed adapters `src/generated/native.ts` (mobile,
  via `@app/design-tokens/native`) and `src/generated/web.css` (web, the Tailwind
  v4 `@theme`). Mobile components style via `useThemedStyles((palette) =>`
  factories over those tokens. No color literals, no inline styles, no hand-edited
  generated file — the `styleguide` gate regen-diffs the package (its `gen:check`
  script) and source-scans `apps/mobile` for raw values;
  `tools/styleguide.manifest.json` is the gate POLICY (accent budget, status
  surfaces, primitive boundary, motion seam), not the token values.
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

- Non-trivial decision sites (RLS SQL, `getUser`/`getClaims` verification, the
  service-role warrant, retry/timeout/sampling constants, ATS/policy choices) carry
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
  `authoring-vertical-slice` skill): migration + RLS → RLS tests → `./client`
  data fn → tRPC procedure (+ web Server Action) → web screen → mobile screen →
  tests → provenance → green gate. `/new-action`, `/new-migration`, `/rls-check`
  and `/verify-invariants` drive the individual steps.
- Reviewers are read-only subagents (the `docs-sync` gate asserts their
  frontmatter stays read-only): `security-reviewer` (MUST run on RLS/migration/
  auth changes), `web-security-reviewer` (MUST run on Server Actions, the web
  Supabase seam, `proxy.ts`, the tRPC route handler, or `NEXT_PUBLIC_` env),
  `mobile-security-reviewer` (keychain/app.config/eas.json/permission changes),
  `accessibility-reviewer` and `design-reviewer` on UI changes,
  `torvalds-reviewer` before finishing, `citation-verifier` via
  `/verify-citations`.
- PRs paste real `pnpm validate` + `pnpm test:rls` output; CODEOWNERS
  ({{SECURITY_OWNERS}}) sign off on auth/data/harness surfaces. New MCP servers
  or Skills must be registered in `docs/security/approved-tools.md` first. Keep
  private data out of the lethal trifecta
  (`docs/security/sandbox-and-supply-chain.md`).
