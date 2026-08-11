# Gates catalog

Companion to [the harness doctrine](./README.md). One section per default-on gate (the
34-step `VALIDATE_STEPS` chain in `tools/harness.config.mjs`), the Stop-hook runtime
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

- **The audit trail covers mutations only.** `audit.events` records every INSERT,
  UPDATE and DELETE on every org-scoped table, and nothing at all about reads. A user
  who only *looks* leaves no trace, so the trail cannot answer "who saw this" — the
  question a data-access investigation usually starts from. `SELECT` auditing needs
  `pgaudit` configuration that is not expressible in a migration, so it stays out of
  scope until that changes — a permanent scoping CONDITION in the `tenancy.json`
  `directoryRpc` style, deliberately carrying no release number (this sentence read
  "for 0.2.0" through four releases that shipped after it, a deferral that had quietly
  become a permanent state while still reading as a plan), re-opened if pgaudit's
  SELECT-audit configuration ever becomes expressible in a migration.
  Related: `request_id` on an audit row is a **correlation** field, not
  evidence — it is server-minted on the paths the server controls and forgeable by a
  client talking straight to PostgREST. `actor_id` is the field with integrity,
  because it comes from the verified JWT and the insert policy re-checks it against
  the database's own opinion. Do not build an investigation on the wrong one.

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
Fix with `pnpm format`. Generated-but-committed artifacts (the design-tokens adapters,
the Supabase type mirror, the committed contract inventories) are excluded —
byte-stability there belongs to their regen-diff gates.
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

### 3. wiring — `node tools/check-wiring.mjs`

The enforcement layers are actually CONNECTED to this project. Five load-bearing
invariants had exactly one check between them — `installer doctor` — and **nothing ran
it**: not the Stop chain, not a validate step, not a CI lane. A control whose only trigger
is a human remembering is not a control, so an install could carry every gate script, pass
every hash, and still have a hook unwired, `pnpm validate` pointed somewhere else, a
CLAUDE.md that silently replaced project memory, an enforcement-surface path no CODEOWNERS
rule covers, and `defaultMode: "bypassPermissions"` — with the whole chain green.

**Two things wiring a hook does not settle, both added in 0.6.0.** First, whether it is AIMED
correctly: the command guard's matcher must name `Bash`, `Monitor` **and** `PowerShell`. A
`Bash(...)` *permission rule* covers Monitor, which is what made the omission invisible — but a
hook matcher is an exact tool name, so a `Bash`-only matcher left every command-content check
reachable-around via `Monitor`, and on Windows without Git Bash (where Claude Code registers no
Bash tool at all) it never fired. A project may ADD a tool to that matcher; it may not drop one.
Second, whether a deny rule is CONSULTED: Claude Code honours file-permission rules under
`Edit(...)` and `Read(...)` only, so every `Write(path)` deny must carry an `Edit(path)` twin or
it reads as protection and enforces nothing.

Asserts, by value: **every** hook wired — a UNION of a required floor and every top-level
`.claude/hooks/*.mjs` present, so `rm`-ing a hook cannot delete its own requirement and a new
hook nobody wired still reds (0.6.0 learned this when a hand-kept list of six silently failed
to require the seventh); the permission posture
(`disableBypassPermissionsMode == "disable"`, `defaultMode != "bypassPermissions"`) as a
hard red; `package.json`'s `validate` script still runs `tools/validate.mjs`; `CLAUDE.md`
is a pure `@AGENTS.md` include; `VALIDATE_STEPS ⊇ tools/validate.floor.json`; and
**CODEOWNERS coverage** over every escape list, every threshold config and every
enforcement-surface prefix — including the empty-owner spelling, which is valid CODEOWNERS
syntax that silently disables review while reading, to a human skimming the file, exactly
like a rule. Parked `.harness/pending/` upgrades and a dormant lefthook are NOTEs, never
reds.

Placed directly after `gate-integrity`: integrity proves the enforcement FILES are the ones
the harness wrote, this proves they are WIRED, and both must hold before any later gate's
verdict means anything.

**Anti-vacuity:** delete the `pretool-mcp-guard` group from `.claude/settings.json` → FAIL
naming it; set `permissions.defaultMode` to `bypassPermissions` → FAIL; append a bare
`/tools/**` line (no owner) to `.github/CODEOWNERS` → FAIL naming the paths it silently
un-reviews. (`tests/gates/check-wiring.test.mjs`; selftest Canary 25.)

### 4. secrets — `node tools/check-secrets.mjs`

A hermetic credential scan inside the chain. `lefthook.yml` prints `SKIP secrets scan` when
the gitleaks binary is absent and `.github/workflows/gitleaks.yml` only scans after a
**push** — both correct for what they are, and together they leave one hole: on any machine
without gitleaks a turn could end green with a service-role key in a tracked file, and the
first thing to notice would be a workflow running after the bytes reached the remote. This
gate is zero-dependency node, so it is present on every machine and in every turn.

Deliberately **not** a Go-regex translation of `.gitleaks.toml`: two scanners that quietly
disagree about what a secret looks like are worse than one, because each gets trusted for
the other's coverage. What it asserts instead is **rule-id lockstep** between
`tools/secret-patterns.json` and `.gitleaks.toml`, both ways — the two policies may differ
in expression, never in scope. gitleaks keeps entropy analysis, the default ruleset and
history scanning.

Shapes: `sb_secret_` (the credential that BYPASSES RLS), credentialed `postgres://` DSNs,
PEM private-key bodies, GCP service-account JSON, a literal Expo access-token assignment,
keystore passwords, Sentry org tokens. Findings never echo the matched value — a gate that
printed the credential it found would have copied it into the CI log, the Stop block and
the transcript. Per-rule allowlists are first-class data ported from `.gitleaks.toml`
(a fixture must LOOK like the real shape, so it is distinguished by SAYING so in the
value); `tools/secret-scan-allow.json` is a tolerated-absent, per-finding acceptance whose
entries each need a real reason and must be committed.

**Anti-vacuity, both directions:** write a real `sb_secret_…` key into a tracked file → FAIL
naming file and line; and the gate self-tests every rule against its own synthetic
`positive` at startup, so a decayed regex reports ITSELF instead of a clean tree. Scanning
zero files is also a hard FAIL. (`tests/gates/check-secrets.test.mjs`; selftest Canary 26.)

### 5. types — `pnpm exec tsc -b`

Solution-mode strict TypeScript across all six projects (composite project
references: contracts, schema, importer, eval, server, mobile). Catches
cross-package breakage the per-package editors miss.
**Anti-vacuity:** change a DTO field name in `@app/contracts` without updating the
server → FAIL in the dependent project.

### 6. lint — `pnpm exec eslint . --max-warnings 0 --cache`

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

### 7. provenance — `node tools/check-sources.mjs`

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

### 8. boundaries — `node tools/check-exports-walls.mjs && node tools/check-workspace-deps.mjs`

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
**Vertical anatomy + intra-vertical layering (0.9.5, part 3 of the same step —
`tools/lib/vertical-anatomy.mjs`).** The worked `packages/verticals/notes` pattern as
law, scoped to what is mechanically checkable: every vertical ships BOTH barrels (`.` +
`./client`, declared and present) and the barrels are PURE (export statements only — a
barrel with logic breaks the Metro-safe claim); `src/domain/**` imports only sibling
domain files, `@app/contracts` and `zod` (no I/O, no clock, no error kernel — domain
returns values, data returns outcomes); `src/data/**` never VALUE-imports
`@app/supabase`/`@supabase/*` (the database arrives through the structural
`src/data/port.ts`, whose presence is itself a law; `import type` of the port shapes is
sanctioned); `src/events.ts` speaks only `@app/events` + `@app/contracts`; and
`select('*')` is banned across vertical src (the explicit projection is the wire
contract). Deliberately NOT law: the presence of `domain/` or `events.ts` at all — a
thin read-only vertical legitimately has neither, and a directory-shaped mandate would
be the max-lines mistake in another form. Escape: reviewed
`tools/vertical-anatomy-allow.json` (seeded, `{package, law, path?, reason ≥ 40,
reviewedOn}`), closed BOTH ways — a stale entry reds. Ramped for pre-0.9.5 installs
until 0.10.0 (`boundaries-vertical-anatomy-ramp-expiry`); the allow-file shape problems
and the zero-files-scanned floor are never ramped.
**Anti-vacuity:** add a `./client` export to a package with no census entry → FAIL
naming it; make `@app/api` a runtime mobile dependency → FAIL "import type only"; make one
vertical depend on another → FAIL "verticals never import each other"; put a `node:fs`
import in a domain file → FAIL naming file and law; hollow out every vertical's src →
FAIL "scanned ZERO files".

### 9. observability — `node tools/check-observability.mjs`

Vendor telemetry containment: the seam header's invariant
(`packages/platform/observability/src/index.ts` — "NO VENDOR SDK, on purpose. A crash
reporter or a tracing agent is a MODULE… and it attaches HERE, at the sink, behind the
redaction pass") made decidable. The gate scans every source file under `apps/`,
`packages/` and `supabase/functions/` (comments blanked; static `import … from`,
side-effect `import`, dynamic `import()` and `require()` all count; `npm:` and URL
specifiers normalize to their package coordinate) and reds any import matching the
telemetry-vendor detector outside the reviewed `tools/observability.json` `sinks[]`
register. The register is closed BOTH directions — an entry naming a missing file, and
an entry whose vendor import went away, both red — and each declared sink must
reference its declared redaction symbol in code (a symbol named only in a comment
satisfies nothing) with a reason of 40+ characters, because registering a sink is
licensing an off-device egress path for operational data. The detector is EXTEND-ONLY:
`vendorSpecifiers` may grow for a vendor the harness has never heard of, but the gate
reds when it is missing any entry of `REQUIRED_VENDOR_FLOOR` in
`tools/lib/observability.mjs` (owned, so detector improvements ride `update`; the
register is seeded, because its rows are the consumer's egress decisions).

**Honest limits, stated per the enforcement-tiers discipline:** the scan is static over
import specifiers. It cannot prove a vendor call's ARGUMENT flowed through
`redactFields` (no call graph — the sink file referencing the symbol is the bar), see a
vendor SDK reached through a transitive dependency, or notice telemetry sent by raw
`fetch()` to an ingest URL; test files are excluded. The redaction pass's BEHAVIOR is
the `unit` lane's (`packages/platform/observability/src/index.test.ts`). The pre-0.8.0
adoption ramp (a tree may have hand-wired a vendor transport before the gate existed)
expired on schedule at 0.9.0: the containment findings are hard reds on every vintage
now, and the '0.9.0 — the fifth alarm' section of `docs/runbooks/harness-upgrade.md`
carries the sweep.
**Anti-vacuity:** import `@sentry/react-native` in an unregistered file → FAIL naming
the file and both moves; register a sink whose file never references its redaction
symbol → FAIL quoting the ordering; narrow `vendorSpecifiers` below the shipped floor →
FAIL; a zero-file scan → FAIL rather than a vacuous green.

### 10. expo-policy — `node tools/check-expo-policy.mjs`

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

### 11. native-deps — `node tools/check-native-deps.mjs`

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

### 12. version-sync — `node tools/check-version-sync.mjs`

Root and `apps/mobile` move in LOCKSTEP AND the RESOLVED Expo config equals the
app.config.ts derivation formulas (`ios.buildNumber` = version; `android.versionCode`
= maj·1e6 + min·1e3 + pat), so replacing the derivation with literals reds on the
next bump, not at store review. `apps/web` is DELIBERATELY excluded from that lockstep
— it deploys on Vercel's push-to-main cadence (~1000× the store cadence), so coupling
it would force a web hotfix to cut a store submission or red the gate; its independence
is bounded instead by `apps/web`'s MAJOR == `@app/api`'s MAJOR (the tRPC skew middleware
rejects an x-client-version major mismatch, so a web release crossing a major the router
has not is a breaking client). `runtimeVersion.policy` stays `appVersion`; Node majors
agree across `.nvmrc`/`.node-version`/`engines` AND `eas.json` pins the same Node plus
the EXACT pnpm from `packageManager` (EAS ignores package.json's packageManager — the
eas.json fields are the only pin a cloud build obeys); expo / expo-router /
react-native / babel-preset-expo EXACT-pinned in the catalog; exactly one
zod instance resolves workspace-wide, and exactly one `react` resolves WITHIN each
surface's graph (web and mobile pin React independently — separate bundles — so two
versions across surfaces is correct; two within one bundle break the hooks dispatcher).
Stamped for warm runs; CI always re-runs.

**The Claude Code floor (0.6.0).** `tools/cc-floor.json` holds the tool this harness RUNS
INSIDE to a cited minimum — the one dependency whose compromise compromises every other control,
and the only one that had no floor. The scalar is DERIVED: this step recomputes it as the newest
`patched` among the advisories cited in the file and reds if the two disagree in either
direction, `required.setBy` must match the evidence **both ways**, and every row must carry an
openable `github.com/advisories/` URL plus a sentence on what it does to this harness. The edit
worth catching is not lowering the number — it is deleting an advisory row, after which the
derived floor falls with it and nothing else would notice. Clockless and offline by design;
"has anyone re-queried the advisory database lately" is the scheduled `floor-review` job's
question, on a 45-day window.

**The framework security floor (0.5.0).** Every package in `tools/framework-floor.json`
resolves at or above the patched release for its major line — read from the RESOLVED
`pnpm-lock.yaml`, not the catalog string, so a transitive resolution below the floor reds
too. The floor is keyed by MAJOR LINE because that is the shape upstream security releases
take, and a single flat minimum would red a consumer legitimately sitting on an older but
patched line; a major with no row is judged unsupported, derived rather than listed twice.
**Why this is not `osv-scan`, and why it is not `pnpm audit`.** The osv PR lane is
diff-aware and fails only on NEWLY introduced vulnerabilities, so a pin that was already
in the tree when the advisory landed never reds there — which is the exact state this
harness shipped in for two releases. The osv full-tree lane is schedule-and-network bound,
and a live database makes a verdict that changes with the calendar, which is the same
reason `pnpm audit` is not in this chain at all. This half is CLOCKLESS and OFFLINE: same
lockfile, same floor, same verdict on any machine on any day. Whether the review is still
FRESH is the one time-dependent question, and it rides the scheduled `floor-review` job in
`osv-scan.yml` (`reviewedUntil`, schedule + workflow_dispatch only — never a PR, because a
lapsed review must not block a contributor's unrelated patch).
**The review WINDOW is judged here, though (0.6.0), because it is not a calendar question.**
`reviewedUntil - reviewedOn` must be at most **31 days** — one calendar month, matching the
roughly monthly cadence upstream now publishes security releases on. Before this the window
was the reviewer's free text, and the file shipped with 92 days: a review that read as live
across about three releases. Worse than long, it was an **off switch reachable from inside
the file it protects** — a single distant `reviewedUntil` retires the freshness control, and
the only check that would object is the scheduled one that edit just disarmed. So the
reviewer now supplies WHEN THEY LOOKED and the harness supplies HOW LONG THAT IS WORTH; the
arithmetic is over two committed dates, which is why it can red at the moment the window is
written rather than a quarter later. The floor is harness-OWNED,
so `update` carries a new advisory to existing installs, and `gate-integrity` sha-pins it,
so lowering a minimum without a reviewed commit reds at step 2.
**The iOS build-toolchain floor (0.7.0).** Apple has required uploads to build against
**Xcode 26 / iOS 26 SDK or later since 2026-04-28** — a FIXED floor, not a moving
"current SDK" requirement, and macOS is excluded (facts: `design/CONFORMANCE-FACTS.md`
§3). The reviewed floor lives in `tools/store-policy.json` (`iosToolchain`: `xcodeFloor`,
`inForceSince`, `source`, `why` — the record the enforcement-tiers version-sync Target
discharges through), and the check is static, offline and clockless: it resolves the
production profile's `ios.image` through the `eas.json` `extends` chain and matches
`-xcode-(\d+)` against the floor. **The red directions, and why each one reds:** an
ABSENT image reds because *no pin means nothing can red* — a too-old toolchain would
burn a whole build-and-submit cycle with no gate output; `auto`, `latest`, `sdk-NN`
and any name without a literal `-xcode-<major>` red as UNVERIFIABLE, because an alias
moves under the build and a check that passes an unpinned profile passes every profile;
a matched major BELOW the floor reds naming both numbers, the in-force date and the
source; and a `store-policy.json` carrying no `iosToolchain` record while `eas.json`
exists reds, because a floor nobody reviewed is not a floor (the file is harness-owned —
`update` restores it). The template pins the CONCRETE image `macos-tahoe-26.5-xcode-26.6`
(the `sdk-57` alias's resolution on 2026-08-08), never the alias. Ramped for pre-0.7.0
installs (their seeded `eas.json` predates the pin; the `seededSourceFixes` channel
carries it) with dated NOTEs until 0.8.0. Honest limit: no lane runs an EAS build, so an
image RETIRED upstream is invisible here — the pin's freshness rides the consumer's next
build and the floor's rides review.
**Anti-vacuity:** drift `apps/mobile/package.json` from root → FAIL listing the
disagreeing versions; set `apps/web`'s major off `@app/api`'s → FAIL the skew-contract
check; resolve two `react` versions inside one surface → FAIL naming the project;
replace the versionCode derivation with a literal → FAIL on the next version bump;
revert the `next` catalog pin below its floor → FAIL naming the resolved version, the
floor and the HIGH advisory ids; move a version onto a major line the floor has no row
for → FAIL naming the supported lines; a present `pnpm-lock.yaml` the scanner matches
ZERO packages in → FAIL, because that is the shape a silently vacuous floor takes;
push `reviewedUntil` more than 31 days past `reviewedOn` → FAIL naming the window, the
maximum, and roughly how many upstream releases that many days hides; drop the
production `ios.image` (or alias it to `auto`/`latest`/`sdk-NN`, or pin
`-xcode-25.x`) → FAIL per the toolchain directions above; delete the `iosToolchain`
record while `eas.json` exists → FAIL naming the missing review.

### 13. prompts — `node tools/check-prompts-lock.mjs`

Two surfaces, locked for the same reason and judged with different strictness.

**LLM prompts.** Every file under `packages/*/prompts/` / `apps/*/prompts/` is
sha256-locked in `tools/prompts.lock.json` and versioned in its filename
(`extract.v1.md`). Pass by creating a NEW `.vN` file, re-running the eval, then
deliberately updating the lock (write-guard-protected — a human act).

**The agent surface (0.2.0).** `.claude/{agents,commands,skills}` — sha256 per file in
`tools/agents.lock.json`, plus each agent's pinned model id. This is the most privileged
prose in the repository: which reviewers exist, what they may touch, what a slash command
does, what the skills prescribe. Before the lock, **nothing in the chain noticed it
changing** — the `docs-sync` roster check reads reviewer FRONTMATTER (name, model, tools)
and never the body, which is where the instructions actually are. An agent could soften
`security-reviewer.md`, widen a skill or repoint a command and stay green.

The model id is recorded beside the hash because they answer different questions: a hash
proves the file did not change, and a roster silently repointed from a frontier model to a
cheap one leaves every byte identical.

**The asymmetry is the design.** "Not in the lock" is RAMPED — an install predating the
lock has files nobody has covered, and ambushing it on upgrade would break the harness's
own promise that projects grow into gates. "In the lock and the hash moved" is UNRAMPED at
every vintage: that is not a vintage gap, it is an edit to instructions somebody already
reviewed. In practice no install sees the ramp at all, because the installer **writes the
lock from the install's own current files** — at `init` always, at `update` only when
there is no lock yet. An update never REWRITES one: doing so would launder every edit made
since, which is the act the lock exists to make visible.

**Three layers, because one env var is not a control.** `tools/gen-agents-lock.mjs`
refuses `--write` without `HARNESS_ALLOW_SELF_EDIT=1`; the bash-guard denies invoking any
`gen-*lock*.mjs … --write` by name shape; the lock file and all four `.claude` directories
are write-guard-protected. The distinction from the other three generators is worth
keeping straight: `gen-action-inventory`, `gen-event-catalog` and `gen-query-shapes` derive
their output from something else the gates check, so running them launders nothing. This
one's output is a hash OF the files being checked, so running it after an edit is exactly
how the edit disappears.
**Anti-vacuity:** edit one word in `packages/eval/prompts/extract.v1.md` → FAIL hash
mismatch; append one line to `.claude/agents/security-reviewer.md` → FAIL, unramped, at
every vintage; delete a locked reviewer → FAIL (removing an agent is a reviewed act, not a
cleanup); `node tools/gen-agents-lock.mjs --write` without the env var → the generator
refuses, and the bash-guard denies the invocation before it runs.

### 14. licenses — `node tools/check-licenses.mjs`

The production npm dependency tree stays inside a permissive allowlist
(MIT/ISC/Apache-2.0/BSD/MPL-2.0 etc.); exceptions are reviewable data in
`tools/license-exceptions.json`. The Stop gate itself refuses a copyleft/unknown
dependency the moment an agent adds one.
**Anti-vacuity:** `pnpm add` any GPL-3.0-only package as a prod dep → FAIL naming it.

### 15. schema-rls — `node tools/check-rls-manifest.mjs`

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
Four checks joined in 0.2.0, each closing a hole the gate provably had: the RLS
**negation set** (a later `DISABLE ROW LEVEL SECURITY` / `NO FORCE` / `DISABLE TRIGGER`
reds naming the migration — unramped, because no legitimate install ever turned RLS off);
**helper-body resolution** (a predicate calling a locally-defined SQL helper is judged on
the helper's inlined body, so relocating `auth.uid()` into a function no longer vacates
the initPlan rule); the **correlated-subquery ban** (a sub-select with a `FROM` is a
per-row SubPlan, not a hoisted InitPlan — ramped `0.2.0`); and **SECURITY DEFINER
discipline** (allowlisted with a reason in `tools/security-definer-allow.json`,
`SET search_path = ''`, no identity-shaped parameter — ramped `0.2.0`; the EXECUTE
half below is not). On the EXECUTE surface the rule is not "no wide grant" but
**prove the default was undone**: PostgreSQL grants `EXECUTE` to `PUBLIC` on every
new function and Supabase's default privileges additionally grant `anon`, so a
migration that names no grants at all still ships an anon-callable definer function
— and a gate that only inspects `GRANT` statements reads it as clean. Every definer
function must therefore show a `REVOKE … FROM PUBLIC` **and** `FROM anon`; `EXECUTE`
to `authenticated` is legal only for an allowlisted function, because PostgREST
switches to the JWT's role before calling and there is no other way a client-callable
RPC can exist. Unramped, by the same reasoning as the negation set: the shipped
scaffold has no definer functions, so ramping would protect only a tree that added
one.

**The POLICY → GRANT closure (0.6.0).** Table privileges are checked BEFORE row
security, so a policy naming a role that holds no privilege on the table is
**unreachable code that reads in review as a granted one** — the statement raises
`42501` (PostgREST: HTTP 403) before any policy is consulted. This gate has parsed
grants since 0.2.0 and consumed only the FUNCTION half, above; the TABLE half was dead
output, so a table with ENABLE + FORCE + four policies + both registries + an owner
index and **no `GRANT` statement anywhere** was green. It is invisible because
Supabase's default privileges hand `anon`/`authenticated`/`service_role` their
privileges on every new table in `public` — and those defaults **stop applying to
projects created on or after 2026-10-30**, which makes the same migration file work in
the project it was written against and 403 in the next one it is replayed into. So: for
every `CREATE POLICY`, for every operation it names (`FOR ALL` expands to four), for
every role in its `TO` clause, the GRANT/REVOKE history **folded in statement order**
must leave that role holding that privilege. Three carve-outs, each load-bearing — a
predicate that is literally `false` needs no grant (that is how the tenancy spine says
"never"), a `RESTRICTIVE` policy only subtracts rows and so carries no reachability
claim, and a policy with no `TO` clause names no role to close over. **The reverse
direction is not asserted:** `GRANT SELECT, DELETE ON TABLE public.orgs TO
service_role` is a legitimate ADR'd grant with no policy behind it, because
`service_role` bypasses row security. Ramped `0.6.0` → `0.7.0`, unlike the negation set:
here there IS a legacy population, because on a pre-flip project the missing grant
genuinely works.
SOURCE: https://supabase.com/docs/guides/api (Data API grants and exposed schemas)

**Anti-vacuity:** declare a table with no migration → FAIL (no ENABLE, no FORCE, missing
policies); `USING (true)` → FAIL naming the vacuous predicate; a per-row `auth.uid()` →
FAIL "per row"; drop the owner index → FAIL naming the missing leading column; add a table
to one registry but not the other → FAIL naming the gap; append a `DISABLE ROW LEVEL
SECURITY` to a fresh migration → FAIL naming the file (selftest Canary 22); delete the
one `GRANT` line from the **shipped** `notes` migration → FAIL naming the policy, the
date and the exact statement that discharges it (which is what makes the shipped-tree
green non-vacuous, as opposed to a fixture merely shaped like it).

### 16. tenancy — `node tools/check-tenancy.mjs`

The multi-tenant contract as reviewed data. schema-rls proves a predicate is REAL;
this proves it scopes by TENANT — `org_id = (SELECT auth.uid())` (a tenant column
compared to a user id) passes every schema-rls rule and isolates nothing, which is
the exact hole this gate exists to close. The contract is `tools/tenancy.json`:
`predicateForms` is a CLOSED set of reviewed predicate shapes (owned, hash-pinned
data — the definition of correct, never an escape hatch), and every policy on every
tenant table (any table carrying `tenantColumn`) must carry one of them in EVERY
top-level `OR` arm after normalization — an AND inside an arm can only narrow, but
`<scope> OR owner_id = (SELECT auth.uid())` is as open as its weakest arm. Failures
print the exact normalized predicate, so admitting a new reviewed form is a
copy-paste CODEOWNERS diff. On top of the form match: the **correlated-argument
ban** (`(SELECT private.member_rank(org_id)) >= 30` is wrapped in `(SELECT` and
passes every wrapper check, but passing a column of the row under test makes it a
per-row SubPlan that re-enters the membership table's own policies); a rank floor
must be one of the configured `roles` values; tenant keys must be `NOT NULL` FKs to
the org table (folded across the whole history, so the expand→contract adoption
path — nullable `ADD COLUMN`, later `SET NOT NULL` — lands green); every UNIQUE/PK
on a tenant table must include the tenant column (partition-ready; per-constraint
escapes in `uniqueWithoutTenantColumn` with reasons) and each tenant table needs a
no-`WHEN` `BEFORE UPDATE` freeze trigger; the helpers must be zero-argument STABLE
SECURITY INVOKER with `search_path = ''` reading the membership table; the
membership table itself is held to the opposite shape — self-only SELECT, deny-all
writes *to authenticated*, no helper calls in a SELECT policy (the recursion SMELL
TEST; the executable recursion probe in `supabase/tests` is the proof — it asserts the
reads LIVE rather than naming a SQLSTATE, because with `search_path = ''` pinned the
failure arrives as 54001 stack-depth, not the 42P17 the docs lead you to expect); and
`nonPublicSchemas` must stay out of `[api].schemas`.

Two structural rules exist because the alternative fails **silently**. First, the
**rpc writer role**: every table ships `FORCE ROW LEVEL SECURITY`, so a
`SECURITY DEFINER` function's writes are policy-checked against the role that OWNS
it — the owner is not exempt. With seat writes denied to `authenticated` (as they
must be — a self-keyed INSERT policy is a self-service seat grant), a database in
which no *other* role holds a write policy is one where no seat can ever be created:
the first `create_org` fails 42501 and `supabase db reset` dies at seed. The
reviewed `rpcWriterRole` is that writer, and its policies are judged by the same
closed form set. Admitting it is not sufficient, though: a rank-scoped write policy
TO that role calls the rank helper, which is `SECURITY INVOKER` and therefore reads
the seat table *as the rpc role*. Give the role no SELECT policy and the read hits
RLS default-deny, the helper returns an empty map, every rank comparison is false,
and the write matches **zero rows and reports success** — every promotion in
production looks fine and changes nothing. So the gate requires the **pair**: any
helper-bearing write policy TO the rpc role obliges a self-only SELECT policy for
that role on the seat table (self-only because `auth.uid()` is GUC-derived and
role-switch-independent, and because a helper-bearing SELECT policy here would be
re-entered by the helper that called it).

Second, the **org table** is judged explicitly, with its own primary key
substituted as the scope column. It carries no tenant column, so column-driven
discovery never reaches the root of the whole model — `USING (created_by = (SELECT
auth.uid()) OR name IS NOT NULL)` would otherwise pass every static gate in the repo
while publishing every org row to every signed-in user.

A predicate form may be narrowed to specific `tables` (which obliges a reason): that
is how the two writes performed by someone who is **not yet a member** — creating an
org, redeeming an invitation — stay reviewable instead of becoming a general licence
every tenant table can claim. The `0.2.0` ramp covers ADOPTION only (a pre-0.2.0
install with no tenant column NOTEs instead of failing); once any table carries the
tenant column, findings are hard reds regardless of manifest vintage.

`dualScopedTables` is the one escape in the harness **with a deadline**, and it exists
because an install that already holds production rows cannot become org-scoped in a
single migration: `org_id` must arrive NULLable on populated tables, be backfilled out
of band, and only then take `NOT NULL` — with the old owner-scoped policies alive
beside the new ones throughout, since permissive policies OR and dropping the old set
early blanks the product. An entry licenses exactly that state on exactly the named
table (the arm `<ownerColumn> = (SELECT auth.uid())` becomes legal *for that table*, the
tenant key may be NULLable, and its pre-tenancy tenant-blind uniques stand) and carries
an `until` harness version. That version is compared against the manifest's
`harnessVersion`, **not** `baseVersion`: `baseVersion` moves only when a human
graduates a ramp, so a deadline measured against it is one the escape's own author
controls. On the happy path the entry never reaches its deadline — it reds the moment
the tenant key becomes `NOT NULL`, because from there it is pure widening.
`docs/runbooks/tenancy-adoption.md` is the procedure.

**The audit trail (0.2.0).** The same gate owns `audit.events`, and judges it by
different rules than every other tenant table because for this one the ordinary rules
are *wrong* rather than merely inconvenient: its tenant key must **not** be a foreign
key (an `ON DELETE CASCADE` makes deleting an org delete the record of what was done
inside it — the evidence destroyed by the act most likely to need investigating), and
it carries no freeze trigger, because it refuses `UPDATE` outright, which is strictly
stronger than freezing one column. It is correspondingly listed in
`tools/rls-exempt.json`, which moves its judgment *here* rather than removing it: the
per-operation policy manifest `schema-rls` enforces is the opposite of what an
append-only table needs, since **the absence of an UPDATE/DELETE policy is itself
layer 1 of four**.

What is required instead: no update/delete policy and no client grant (layers 1–2); a
`BEFORE UPDATE OR DELETE` row trigger (layer 3 — the only layer that binds a role
holding `BYPASSRLS`, and `postgres` on Supabase holds it); a `BEFORE TRUNCATE`
**statement** trigger on the parent *and on every partition a migration creates*,
because PostgreSQL clones row triggers to partitions (including ones created later)
but never `TRUNCATE` triggers, so a parent-only guard leaves the trail emptiable one
month at a time; an actor derived **inside** the writer rather than from a column
`DEFAULT` (a default is applied only when the writer omits the column, so it records
whoever the writer says they are); a writer and a reader that are **separate roles**;
and — the closure that makes all of the above non-vacuous — an `AFTER INSERT OR UPDATE
OR DELETE ... FOR EACH ROW` trigger with **no `WHEN` clause** on every org-scoped
table. Without that last rule every other audit check is satisfiable by a beautifully
built trail that records nothing.

Value capture is closed both ways against `tools/audit-columns.json` and
`tools/pii-columns.json`: an undeclared capture is unreviewed, a declared capture with
no trigger argument is stale, and a capture of anything on the PII list is refused.
The deny list is itself checked against the live schema, so an entry naming a renamed
column reds instead of silently protecting nothing.

The pairing rule generalized in the same change. It previously covered only the rpc
writer; it now covers **every** non-`authenticated` role in a helper-bearing policy,
because the audit reader has the identical failure with the opposite consequence — a
write that silently changes nothing versus a read that silently returns nothing, which
an admin reads as "no activity" rather than as a fault.

**Adoption ramps, correctness does not.** A pre-0.2.0 install has no audit schema (the
migration is `seedOnInitOnly`, so `update` never plants it) and gets a NOTE. The moment
the table exists, every rule above is a hard red regardless of manifest vintage.

**Anti-vacuity:** change a notes policy USING to `org_id = (SELECT auth.uid())` →
FAIL printing the normalized predicate; append `OR owner_id = (SELECT auth.uid())`
→ FAIL naming the scope-free OR arm; call `private.member_rank(org_id)` → FAIL
naming the correlated argument; delete the rpc role's self-only SELECT policy while
leaving its rank-scoped writes → FAIL naming the zero-rows-and-succeeds failure mode;
rewrite the orgs SELECT policy to `created_by = (SELECT auth.uid()) OR name IS NOT
NULL` → FAIL naming the scope-free OR arm; an empty `predicateForms`, malformed JSON,
a missing section, a table-narrowed form with no reason, or a reasonless/stale escape
entry → FAIL (never fail-open); a `dualScopedTables` entry whose `until` the install
has passed, whose tenant key is already `NOT NULL`, whose `ownerColumn` does not
exist, or that has no `.harness/manifest.json` to measure its deadline against → FAIL
(and the licensed owner arm on any OTHER table still FAILs, so the escape cannot leak
into the general form set); and `tests/gates/check-tenancy.test.mjs` pins that an
ancient `baseVersion` cannot downgrade findings to NOTEs once the surface exists, nor
shelter an overdue transition. For the trail: delete the audit trigger on one
org-scoped table → FAIL naming the table; add a `WHEN` clause to it → FAIL; drop one
operation from its event list → FAIL naming the operation; make it `BEFORE` → FAIL;
remove the layer-3 row trigger → FAIL naming BYPASSRLS; remove a partition's TRUNCATE
guard → FAIL naming the non-cloning; give the tenant key a foreign key, or `actor_id` a
`DEFAULT` → FAIL; grant `service_role` on the trail → FAIL; make the writer
`SECURITY INVOKER`, or have it read the actor from the row → FAIL; set
`auditReaderRole` equal to `auditWriterRole`, or drop `audit` from `nonPublicSchemas`
→ FAIL closed. The runtime twin is `supabase/tests/audit_immutability.test.sql`, whose
26 assertions prove what no parser can: that the trigger fires *for a BYPASSRLS role*,
that `TRUNCATE` on a partition raises, and that the read path admits rank 40 and
refuses a rank-20 member **of the same org** — the bidirectional pair that separates a
working floor from one that refuses everybody.

### 17. auth-posture — `node tools/check-auth-posture.mjs`

The Supabase auth configuration matches the reviewed policy in
`tools/auth-posture.json`, BY VALUE and IN BOTH DIRECTIONS. It is the deferral CHANGELOG
0.3.0 recorded under "Deferred, with the reason" — *"the Supabase `[auth]` posture gate (a
CLI-compatibility spike goes first)"* — discharged in 0.6.0 after the spike ran.

**The spike, and what it actually found.** The stated blocker did not reproduce: against the
CLI the `^2.34.3` pin resolves to today (2.111.0), a config carrying
`minimum_password_length`, `password_requirements`, `[auth.mfa]` and `[auth.mfa.totp]` brought
the stack all the way up — Postgres started, all eight migrations applied, the seed ran, GoTrue
came up. What it found instead is the reason this gate is worth more than it looked: **the CLI
parses `config.toml` leniently.** An unknown key under `[auth]` produces no error and no
warning, so `enable_refresh_token_rotaton = true` — one letter short — reads to every reviewer
as a security property while GoTrue quietly applies its default. `supabase/config.toml` is the
most heavily commented file in the scaffold, and every one of those comments could have been
describing a posture the platform never applied.

Covers, all four closures both ways: the reviewed `[auth*]` values (`jwt_expiry`,
`enable_refresh_token_rotation`, `refresh_token_reuse_interval`, `enable_anonymous_sign_ins`,
`enable_signup`, `enable_confirmations`, `double_confirm_changes`) — a changed value reds and a
DELETED line reds, because the CLI silently applies its own default for an absent key; every
`[auth*]` key present in config appears in the policy (an unreviewed widening and a typo the
CLI is ignoring are indistinguishable to the gate, which is why it asks a human); project-valued
keys (`site_url`) reviewed for presence and SHAPE rather than equality, so a plaintext origin
reds while a filled-in one does not; the redirect allowlist's entry ceiling and wildcard ban,
because the provider hands the authorization code to any URL the list matches; and a section
census, since a Supabase config SECTION is a surface — `[realtime]` replays row changes through
its own policy check, `[storage]` has a separate bucket policy model, and both ship
`enabled = false`.

**Does NOT cover the deployed project.** `config.toml` governs the local stack; a production
project's posture lives in its `[remotes]` blocks or the Dashboard, and neither is visible from
here. `auth.email.enable_confirmations` is where that gap is loudest — `false` is correct
locally and wrong in production — and `tools/auth-posture.json` says so in writing.

**Deferred to 0.10.0: asking the CLI directly** (deferral ledger: `auth-posture-cli-census`).
A check that read the CLI's own deprecation
warnings was built, worked, and found a real defect — the harness shipped `[inbucket]` against a
CLI that renamed it to `[local_smtp]` and warns on every command, with nothing reading the
warning. It is not shipped, because no subcommand at this pin parses `config.toml` without side
effects: `config push` needs a project ref, `functions list` needs an access token, and
`status` — the one that works — binds to whatever stack holds the default ports (it reported
*another project's* containers during the spike) and prints `SECRET_KEY` and `JWT_SECRET` into
output the gate would then handle. A control that reads a neighbour's stack and handles their
credentials is not a control. The `[inbucket]` defect itself is fixed; the standing check waits
on an UPSTREAM condition — a side-effect-free `config lint`-shaped subcommand, re-checked at
every CLI pin bump — and the date is no longer decoration: this sentence, the twin notes in
`tools/auth-posture.json` and `tools/check-auth-posture.mjs`, and the `tools/deferrals.json`
entry are closed both ways by the `docs-sync` deferral scan, which reds the release the target
arrives. The first deferral of this check rolled past its own date with nothing reading it;
this one cannot — and the mechanism has now fired TWICE as designed: at 0.8.0 the arrival
forced the re-check (CLI 2.113.0, config group still push-only, the ask open as
supabase/cli#5894) and a reviewed four-site move to 0.9.0; at 0.9.0 it fired again against an
unchanged upstream (latest still 2.113.0, the v2.114.0 betas' only config-adjacent change a
docker image bump, #5894 still open with no milestone and no linked PR) and moved to 0.10.0.
The 0.8.0 move licensed itself "once"; the second firing proved the shape recurs, so the rule
is now standing: each arrival with the upstream condition unmet forces the re-check and a
one-minor move in a reviewed diff — the discharge happens only when the side-effect-free
subcommand actually ships.

Static, <100ms, no Docker, no install: a hand-written TOML reader
(`tools/lib/toml.mjs`) over the committed file, for the same reason every other gate hand-parses
its subject — the chain must run on a checkout with cold `node_modules`.
**Anti-vacuity:** widen `jwt_expiry` → FAIL naming both values; misspell
`enable_refresh_token_rotation` → FAIL TWICE (missing reviewed key, unreviewed key present);
`enable_anonymous_sign_ins = true` → FAIL; add a wildcard redirect → FAIL; delete a reviewed
line → FAIL; point `site_url` at an `http://` host → FAIL; rename `[local_smtp]` back to
`[inbucket]` → FAIL both ways; remove `tools/auth-posture.json` → FAIL closed.

**The SESSION TRANSPORT half (0.6.0).** `[auth]` above is the posture of the auth *server*;
this is the posture of the *wire*. It exists because the seeded web app shipped a **sign-in
loop** for two releases: `apps/web/lib/supabase/client.ts` built the browser client with no
`storage`, so supabase-js persisted the session to `localStorage` — its documented default —
while `proxy.ts`, `lib/supabase/server.ts` and the tRPC cookie branch all read the session out
of the **cookie jar**. Two disjoint stores. Sign-in succeeded, every protected server render
saw an anonymous caller, and the layout redirected straight back to `/sign-in`.

Nothing saw it, and the reasons are worth keeping: `storage` is legitimately **optional** (a
pure SPA that never server-renders an identity needs none), so the type-checker was right to
be silent; the unit suite tested the cookie *codec* with options passed in, never the *wiring*
that passes them; `knip` was told to ignore the one dependency whose missing import would have
shouted; and every spec in the browser lane is **anonymous**, so no test in the repository has
ever completed a successful sign-in — while `enforcement-tiers.md` exempts `apps/web/app` from
unit coverage on the grounds that a real browser proves it. That is vacuity *inside a lane that
ran*, which "'exists' is not 'ran'" does not catch.

Three assertions over committed source, all pure text: **(1) transport agreement** — an app
whose server reads sessions from cookies must construct its browser client with a `storage`
(the *pairing* is the defect; neither half is wrong alone, so an SPA with no cookie-reading
server stays clean); **(2) every writer** — each `createServerSupabaseClient` call site must
pass `cookieOptions` naming every `requiredCookieAttributes` entry, because that client
*rewrites* the cookie and an attribute one writer omits is one it strips off the value another
set; **(3) prose** — an attribute listed under `unavailableCookieAttributes` may be **named
only to disclaim it**. `httpOnly` is that attribute here: the browser writes this cookie, and a
user agent ignores `HttpOnly` on a `document.cookie` write, so it cannot be set at all. Four
separate comments asserted apps/web set it while every executable control stayed green — a
false hardening claim is worse than a missing one, because it is read as a control by everyone
who reviews the file.

The general lesson, and why this is a gate rather than only a fix: **an optional seam between
two halves that must agree will eventually be left unwired, and it fails silently on both
sides.** Mobile is structurally immune — `createNativeClient` takes its storage as a *required
positional* — so this closes the same hole on the surface where the parameter has to stay
optional.
**Anti-vacuity:** drop the browser client's `storage` → FAIL naming the sign-in loop; drop
`cookieOptions` at either server writer → FAIL naming the silent downgrade; name `httpOnly` in
a comment without disclaiming it → FAIL quoting the comment. The factory's own *definition*
must not read as a call site, and that is pinned too.

### 18. data-flow — `node tools/check-data-flow.mjs`

What happens to a person's data when they ask to be forgotten, and what a portability
request has to hand back. Both are decided from files this repository already commits: a
delete of `auth.users` does exactly what the `FOREIGN KEY` actions say it does, and those
are in the migration history.

`docs/adr/20260201-org-scoped-tenancy.md` records that after the org re-scope *"DSR
completeness is now procedure-backed, not schema-backed… residual rows can no longer be
enumerated back to the subject."* That sentence was true, serious, and checkable by nothing:
the procedure lived in one Edge Function's header, the reason for each surviving column lived
in a different SQL comment, and no file listed what actually survives. This gate is that
sentence made mechanical.

Every link out of the subject lands in exactly one bucket:

- **ERASED** — a chain of `ON DELETE CASCADE` reaches it. Nothing to review.
- **SEVERED** — `ON DELETE SET NULL` / `SET DEFAULT`. The **row survives** and only the link
  is cut. Needs a reviewed reason in `tools/data-flow.json` `severed[]`, because it is a
  decision that somebody else is the data controller for that row.
- **RETAINED** — no delete will ever reach it (`audit.events.actor_id` has no foreign key at
  all, deliberately). Needs a reason **and** a `procedure` naming a committed file — the gate
  requires that file to exist, because procedure-backed with no procedure is not backed.
- **BLOCKING** — `RESTRICT`, `NO ACTION`, **or no `ON DELETE` clause at all**, which
  PostgreSQL treats as `NO ACTION`. The delete **fails**: a GDPR Art. 17 failure and an Apple
  5.1.1(v) rejection from a line that looks like every other column definition. Allowed only
  with a reviewed pre-delete sweep, the way `delete-account` sweeps the personal org first.

The portability half closes `export.projection` against the schema both ways, and every table
carrying subject data is either projected or excluded **with a reason**. `export.surface`
declares how the export is delivered, or states its absence with a dated `target` — the same
shape `store-policy.json` uses for `accountDeletion`.

It also does the one thing nothing else in the repo does: it compares `supabase/schemas/`
against `supabase/migrations/` on the referential actions. `check-migrations.mjs` used to
claim that reconciliation ran in "CI's db lane"; no workflow runs `supabase db diff`, and that
header is corrected in 0.6.0. The gap mattered here more than most, because `notes.owner_id`
was created `ON DELETE CASCADE` and demoted to `SET NULL` by a later `ALTER` — so a reviewer
reading the declarative file and one reading the creating migration reach opposite conclusions
about whether a note dies with its author.

Reviewed data: `tools/data-flow.json` (write-guard-protected, git-clean-enforced). Procedure:
`docs/runbooks/data-subject-requests.md`. Ramped at `minVersion 0.6.0`, expiring **0.7.0**.

### 19. types-drift — `node tools/check-types-drift.mjs`

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

### 20. migrations — `node tools/check-migrations.mjs`

Append-only (no committed migration modified/deleted vs HEAD, or vs the PR base in
CI); no DML without `-- harness-allow-dml: <reason>`; destructive DDL requires
`-- adr: docs/adr/<file>` pointing at an existing ADR. Always generate a NEW
migration; follow `docs/runbooks/expand-contract.md` for destructive phases.
**Anti-vacuity:** append a comment to an existing migration file (editor) → FAIL
append-only; add `DROP TABLE notes;` in a new migration without an ADR line → FAIL.

**The one escape, and why it exists (0.4.0).** Two rules — the ADR requirement on
authorization-destructive DDL and the `SET lock_timeout` preamble on ACCESS EXCLUSIVE —
were added in 0.2.0 and ramped, because history written before them could not satisfy
them. Both remedies live INSIDE the migration, and rule 1 above reds any edit to a
committed one, so on the day the ramp expired an install carrying either finding in
APPLIED history had a red whose only in-file fix was a different red. Editing is also
wrong on the merits: a lock preamble on a migration that ran months ago governs a lock
already released. So applied history is acknowledged instead, in the reviewed
`tools/migrations-allow.json` (`{"file", "rule": "authz-adr"|"lock-timeout", "reason"}`).
Three bounds keep it from becoming a hole: it exempts a **(file, rule) pair**, never a
file; the migration **must already exist at the diff base**, so one written today cannot
be exempted at all; and a **stale entry reds**. Absent by default — creating it is a
widening, so it is in `ESCAPE_LISTS` and must be committed.

### 21. db-limits — `node tools/check-db-limits.mjs`

The per-role resource ceilings and the per-org quota machinery, judged as data
(`tools/db-limits.json`). Runs right after `migrations` because it reads the same
migration text that step just parsed, and because its subject is the same: what the
applied history does to a running database.

**The role×knob matrix** is folded in statement order, not collected — `ALTER ROLE x
RESET y` after a `SET` is legal, and the LAST word is what the database holds, so a
gate that only gathered `SET`s would report a ceiling a later `RESET` had removed.
Each value must equal the contract's and sit under the contract's ceiling; raising a
ceiling is therefore a reviewed diff rather than a one-line migration edit.

**What makes those settings bind is PostgREST, not PostgreSQL**, and the gate's scope
is honest about it. `ALTER ROLE x SET y` writes a `pg_db_role_setting` row that
PostgreSQL applies when role `x` *starts a session*, and `SET ROLE` does not start
one — verified: as `authenticator`, `SET LOCAL ROLE authenticated` left
`statement_timeout` at the authenticator's value. They bind because PostgREST reads
`pg_db_role_setting` for the role it impersonates and applies it per request; verified
end to end, a 5-second RPC as `anon` (2s) was cancelled at **2.03s** with SQLSTATE
57014. So these ceilings bound traffic arriving **through PostgREST** — every
supabase-js call from web and mobile — and do **not** bound a direct connection, which
gets its own login role's settings. That is why the runtime twin is a client-side
assertion via `public.effective_limits()` rather than only a pgTAP read of the catalog:
the row proves what PostgREST will read, never that PostgREST applied it.

**The inverted half is the one that matters most.** `temp_file_limit` and
`CONNECTION LIMIT` must NEVER appear, and the gate reds when they do. Both read as
obvious hardening, both were in this release's plan, and both bind nothing here:
`temp_file_limit` is superuser-only so `postgres` cannot set it at all, and a
connection limit binds at LOGIN — the only role that logs in is `authenticator`, which
is reserved. A number that cannot bind is worse than no number, because a reviewer
reads it as a control.

**The quota's shape** is asserted structurally because both wrong implementations are
one word away and neither fails loudly. `FOR EACH ROW` serializes every insert behind
the org's single usage tuple; a RESTRICTIVE policy over a `STABLE` count is hoisted to
one evaluation per statement against the **pre-statement** count, so a single
multi-row `INSERT` of any size passes wholesale — it fails **open**. The gate requires
`FOR EACH STATEMENT` with `REFERENCING NEW TABLE`, the `AFTER DELETE` release twin, no
`WHEN` clause, and no client write grant on the counter. It also reds if
`reconcile_org_usage` is ever reassigned to the tenant-scoped writer role: pg_cron has
no JWT, so a scoped owner would read an empty scope, produce an empty truth set, and
set **every counter in the database to zero** on a schedule.

**Pooled-connection discipline** is the fifth section, and it walks the source tree
rather than a list of known files — a gate that names `tools/mcp/rls-verify-server.mjs`
and `tests/rls/db-context.ts` is green by construction the moment someone adds a third
client. Three shapes red: a `postgres()` construction without `prepare: false` (a
prepared statement lives on a backend the next request does not get, so the driver
sends the cached name — an intermittent 26000 no test against a direct connection
reproduces), a timeout GUC set without `LOCAL` (a pooled backend carries the widened
ceiling into the next tenant's request), and `pg_advisory_lock` (session-scoped, so an
error path leaks a lock that blocks every later caller of that key and no pool release
clears it). The write-guard denies all three at the moment of the edit
(`pg-prepared-statement`, `pg-session-timeout-set`, `pg-advisory-session-lock`); this
is the half that judges a file the hook never watched being written. The `prepare:
false` search is per-construction within a 600-character window, not per file, so a
compliant client later in the same file cannot clear a non-compliant one above it —
which is exactly what the hook's file-scoped tripwire cannot decide.

**Anti-vacuity:** drop one `ALTER ROLE ... SET` → FAIL naming the role and knob;
`RESET` it later → FAIL; disagree with the contract, or exceed a ceiling → FAIL; add
`temp_file_limit` or `CONNECTION LIMIT 60` → FAIL (the inverted rule); make the quota
trigger `FOR EACH ROW`, drop its `REFERENCING NEW TABLE`, delete the release trigger,
or add a RESTRICTIVE counting policy → FAIL, each naming the specific failure mode;
reassign the reconciler's owner, or grant it to `authenticated` → FAIL; grant a client
`UPDATE` on `org_usage` → FAIL; raise `[api].max_rows`, or set a session-mode pooler →
FAIL; build a `postgres()` client with prepared statements on, `SET statement_timeout`
without `LOCAL`, or take a `pg_advisory_lock` → FAIL, with `SET LOCAL`, `ALTER ROLE x
SET`, `pg_advisory_xact_lock` and a `postgres(?:ql)?://` URL regex all proven to stay
green; malformed JSON, an empty role matrix, a knob with no declared ceiling, or an
`unavailable` entry with a thin reason → FAIL closed.
`tests/gates/check-db-limits.test.mjs` carries 31 cases; the runtime twins are the
pg_db_role_setting + quota block in `supabase/tests/rls_structure.test.sql` and
`tests/rls/resource-limits.test.ts`, which proves the ceilings are in FORCE through
PostgREST rather than merely present in the catalog.

### 22. contracts — `node tools/check-contract-drift.mjs`

(1) Contract-inventory regen-diff: regenerate the three committed inventories —
`tools/generated/action-inventory.json` (every tRPC procedure `appRouter` exposes),
`tools/generated/event-catalog.json` (every event the platform + vertical
catalogs declare) and `tools/generated/query-shapes.json` (every statement the DALs
issue, recorded by driving them through the harness-owned recording port) — from the
LIVE values and diff against the committed copies, so adding OR removing an action,
event or query without `pnpm gen` reds. Needs an install (tsx, to walk the runtime
router/catalogs/DALs); skips loudly without one, fails closed in CI.
(2) tsconfig project references mirror the pnpm workspace dependency graph —
parallel topologies desynchronize into confusing type errors otherwise. (3) Bounded
wire strings (G18): every `z.string()` in `@app/contracts` carries `.max(N)`, or a
reviewed entry in `tools/dto-bounds-allow.json` — an unbounded wire string is a
memory-amplification vector.
**Anti-vacuity:** add a procedure without regenerating → FAIL stale; delete a
`references` entry from a package tsconfig → FAIL naming the missing ref; add an
unbounded `z.string()` to a wire DTO → FAIL naming the site.

### 23. query-shapes — `node tools/check-query-shapes.mjs`

Every statement the DALs actually issue is BOUNDED and SERVED BY AN INDEX — judged
against `tools/generated/query-shapes.json`, which is written by executing the DALs
rather than by describing them. `tools/gen-query-shapes.mjs` drives each DAL function
through a harness-owned recording port (`tools/lib/query-recorder.mjs`) and records the
builder chain it produced; the `contracts` step immediately before proves that file is
byte-fresh. A hand-authored query manifest would be a tautology — the same turn writes
the DAL and the manifest, and the cheapest repair for a red is to edit the manifest.

The recording port is a **Proxy**, not a fake with methods: it records every call by
name, including ones no port declares, so `.range()`/`.offset()` arrive as `extra` and
red **by name** instead of crashing the instrument into being taught to ignore them.
Two closures keep it non-vacuous: generation fails if any exported DAL function has no
probe (the probe module re-exports its DAL as a namespace, so the comparison is against
the functions that exist, not a list), and fails if a probe issues no query at all.

The rules, each catching something the others cannot: **bounded** (a read with no LIMIT
and no aggregate costs the tenant's whole row count — fine on the day it ships,
forever); **no unreviewed builder method** (OFFSET pagination re-reads and discards
every skipped row, so page 500 costs 500 pages); **served** — an index whose leading
columns are the equality set followed by the ORDER BY columns in order and in one scan
direction (PostgreSQL walks a btree backwards, so an all-reversed sort is served too; a
MIXED order is not); **cursor/sort agreement** (a keyset cursor whose columns disagree
with the ORDER BY skips or repeats rows at every page boundary); **tenant-led** (on a
tenant table the tenant column must be in the equality set and lead the serving index —
a performance rule with an authorization shadow: the policy filters by org either way,
but without the leading column it filters by SCANNING); and **ceiling** (no LIMIT above
`[api].max_rows`, which PostgREST truncates to silently, so the sentinel row a keyset
page uses to detect "has more" never arrives).

This is the static half. It cannot prove the planner CHOOSES the index it found — that
is `tools/check-db-perf.mjs` in the path-filtered `db-scale` CI lane, against 2M seeded
rows. Neither subsumes the other: this one is decidable from migration text in ~60ms,
and that one needs a real planner, real statistics and real cardinality.
**Anti-vacuity:** delete `notes_org_id_created_at_id_idx` → FAIL naming the shape and
printing the exact `CREATE INDEX` that would serve it; swap the index's sort tail to
`(created_at DESC, id ASC)` → FAIL on the mixed direction while `schema-rls` and pgTAP
stay green (both only see the leading column); drop the `.limit()` from a list DAL →
FAIL unbounded; add `.range(0, 20)` → FAIL naming `.range()`; add a DAL function with
no probe → `pnpm gen` FAILS and `contracts` reds; empty the manifest → FAIL (an empty
manifest passes every rule above without judging anything).

### 24. rate-limits — `node tools/check-rate-limits.mjs`

The rate-limit budget as reviewed data (`tools/rate-limit-budget.json`), closed against
the router the deployment actually exposes. Runs right after `contracts`, and the order is
load-bearing rather than cosmetic: this gate's whole value rests on
`tools/generated/action-inventory.json`, and `contracts` is the step that proves that file
is not stale. Judging a budget against a stale inventory reports full coverage of a router
that no longer exists.

**The vacuity it exists to prevent is not "the numbers are wrong."** It is a limiter that
is wired, tested, and reaches nothing: a new mutation lands, nobody adds it to the policy,
and the seam happily limits the five procedures it already knew about while the newest
write path runs unbounded — everything green. So the load-bearing rule is a CLOSURE against
a GENERATED inventory (walked out of the composed router, never hand-written): every
mutation is mapped to a bucket or carries a reasoned exemption, **in both directions**, and
a mapping or exemption naming a procedure the router no longer exposes reds as stale.

**The budget is diffed BY VALUE.** `apps/web/lib/rate-limit.ts` is the code that runs; the
JSON is what a human approved. The gate evaluates the module under node's type stripping —
the same technique `security-headers` uses, and the reason that module has zero value
imports — and compares bucket limits, windows, and both resolvers. A number changed in code
without a reviewed diff reds; so does a number changed in the JSON that the code does not
honour, and so does a documented exemption the code fails to apply.

**An unknown name must NOT resolve to null.** The resolvers fall back to the write bucket,
so a procedure added without touching the policy is limited (wrongly, in the harmless
direction) for the seconds between writing a router and running the chain. A gate that
allowed `null` there would make "forgot to map it" and "deliberately unlimited" the same
value.

**Both seams are asserted wired**, because a policy nothing consults is a policy in name
only: the tRPC host must pass a `rateLimit` port to `createContext` (`@app/api` treats a
missing port as an UNLIMITED router — correct for a worker or a test, silent total loss for
the web host), and every Server Action the budget names must call
`enforceActionRateLimit('<name>')`. The reverse also reds: an exported `*Action` with no
budget entry is the same hole as an unmapped mutation, because a Server Action is a public
HTTP endpoint with a generated id.

**Anti-vacuity:** delete a mutation's bucket → FAIL naming it; map and exempt the same
procedure → FAIL (the two say opposite things and the gate will not choose); name a bucket
`buckets` does not declare, or declare one nothing spends from → FAIL; exceed the reviewed
`ceilings` → FAIL (a budget nobody can exceed is not a budget, and neither is a window long
enough never to close); change a limit in code only, or in the JSON only → FAIL with both
numbers printed; return `null` for an unknown name → FAIL; drop the `rateLimit` port from
the route, or the guard from an action → FAIL naming the seam; malformed JSON, an empty
bucket set, a bucket with a thin reason, an exemption with a thin reason, or a `failOpen`
decision that was never recorded → FAIL closed. `tests/gates/check-rate-limits.test.mjs`
carries the fixture proofs; `packages/api/src/ratelimit.test.ts` proves the router refuses
BEFORE any handler runs against a database that throws if touched.

**Honest loss, stated here because this is where someone will look for it:** these budgets
bind the two APPLICATION seams. They do not bind a client that POSTs straight to
`/rest/v1/notes` with the publishable key and its own JWT, and they do not bind sign-in or
sign-up, which go to GoTrue. The controls that bind every path are the per-org quota
trigger and the per-role statement timeouts (`db-limits`). The limiter also FAILS OPEN when
its backend is unavailable — an explicit, recorded decision (see
`docs/adr/20260204-rate-limiting.md`), which means a Redis outage is a window with no rate
limiting at all.

### 25. parity — `node tools/check-mobile-parity.mjs`

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

### 26. dead-code — `pnpm exec knip --strict`

Unused files, exports, and dependencies, in production mode (test-only reachability
does not keep production code alive). Wire everything you add or delete it.
Deliberate test-facing seam exports carry an explicit `@public` JSDoc tag — a
visible, greppable claim, reviewed like code. NEVER `knip --fix` (blocked): it
auto-deletes with false positives.

**A SEAM A GATE READS IS A PRODUCTION ENTRY, not an ignore.** `knip.json` has no
comments, so the reasoning lives here. `apps/web/lib/i18n/index.ts` and
`apps/web/lib/routes.generated.ts` are declared production entries (`"…!"`), the same
declaration `apps/mobile` makes for `src/host/env.ts` and `src/crash/redact.ts`. Both
are seams a GATE reads rather than only the app: `check-i18n.mjs` parses `LOCALES` out
of the locale module and bans `Intl`/`toLocale*`/`.toFixed()` everywhere else, so
`formatNumber`/`formatDate` are the one legal way to format even before a screen needs
one; `check-web-routes.mjs` regen-diffs the registry. `--strict` ignores non-production
entries, so a test-only consumer does not keep either alive — and the alternative,
deleting the unused half of a seam, deletes the API the other gate exists to funnel code
into. An `ignore` entry would silence the file entirely; an entry keeps the rest of the
closure live over it.

**Anti-vacuity:** add an exported-but-unimported function → FAIL.

### 27. architecture — `pnpm exec depcruise apps packages --config .dependency-cruiser.cjs`

The dependency law: no cycles; `verticals ⊥ verticals`; `shared ↛ verticals`;
`platform/* → {errors,events}` only; `packages/api ↛ next/*` (the reversibility wall);
`apps/mobile ↛ web-only packages` (no `next`/`react-dom`/`@app/design-system`) and
`apps/web ↛ react-native`; the `@supabase/ssr` server client stays out of the mobile
graph; `expo-secure-store` only under `src/lib/supabase/**`; LLM SDKs only from
`packages/eval` adapters.
**Anti-vacuity:** import a server module from a mobile file (editor — the write
guard also denies it in-session) → FAIL with the violation path.

### 28. build — `node tools/build-check.mjs`

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
**Anti-vacuity:** embed the literal `SUPABASE_SERVICE_ROLE_KEY` in a mobile constant →
export succeeds, gate FAILs on bundle purity; halve `gzip.total` in the baseline →
FAIL naming measured vs baseline × ratioCap and the re-baseline ceremony.

### 29. styleguide — `node tools/check-styleguide-manifest.mjs`

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

### 30. perf-budget — `node tools/check-perf-budget.mjs`

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

### 31. route-manifest — `node tools/check-route-manifest.mjs && node tools/check-web-routes.mjs`

Every screen and every page is REGISTERED. Two scripts, one step — the shape
`boundaries` has used since 0.1.x — because the two routers share no rule: expo-router
maps a trailing `index` to its parent path and has no route groups, parallel routes,
intercepting routes or private `_folder` exclusion; the App Router has all four and no
`index` convention. Forcing one parser to serve both would mean branching on surface at
every line, which is two parsers with worse names.

**The mobile half** (`check-route-manifest.mjs`) — a hand-authored manifest, re-derived.
**The web half** (`check-web-routes.mjs`, 0.6.0) — a generated registry.

#### 28a. the mobile half — `apps/mobile/src/routes.ts`

`apps/mobile/src/routes.ts` ROUTES must be non-empty;
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

#### 28b. the web half — `apps/web/lib/routes.generated.ts` (0.6.0)

The commitment `docs/harness/enforcement-tiers.md` dated to 0.6.0, in its own words:
*"the App Router has no equivalent registry, so a web page can land with no id, no
title key and no declared loading/empty/error states."*

The registry is **generated, not authored** — `tools/gen-web-routes.mjs` walks
`apps/web/app` for `page.*` files and derives `path` and `file` from position, so the
defect the mobile half spends thirty lines catching (a manifest that disagrees with the
URL the router serves) cannot be written on this surface at all. What an author writes is
only what position cannot tell you — id, `titleKey`, and the three state test ids — in a
`page.meta.ts` colocated with the `page.tsx` it describes. (`page.meta.ts`, not
`route.meta.ts`: `route.ts` is the Route Handler convention and this tree ships two.)

Enumeration is a file walk, not a runtime import, which is the opposite choice from
`gen-action-inventory.mjs` and deliberate: the tRPC router is a value that must be built to
be read, and the App Router's route set IS a file tree. So this generator needs no install,
no `next build` and no network, and runs inside the chain on cold `node_modules`.

Covers: every page has a `page.meta.ts` or is reviewed chrome in
`tools/web-route-allowlist.json` (reasons required); every `titleKey` RESOLVES in
`apps/web/lib/i18n/catalog.ts`; ids and derived URLs are globally unique (two pages under
different route groups at the same position are a build-time conflict, not two routes);
state test ids are globally unique; a `null` state needs a reviewed `unreachableStates`
row; the committed registry matches the file tree; `app/not-found.tsx` exists, because
without it an unmatched URL renders Next's built-in 404 — unbranded, untranslated, outside
every lane. Route groups, `[param]`, `[...param]` and `[[...param]]` are derived;
parallel (`@slot`) and intercepting (`(.)`/`(..)`/`(...)`) routes are REFUSED by name
rather than guessed at, because a page reached at two URLs cannot have one manifest row.

**And the one the mobile half gets for free:** mobile proves its declared test ids exist
by DRIVING them in the RNTL states sweep. The web half has no such sweep, so the gate
proves it statically — each declared id must be rendered somewhere in the route's own
segment (non-recursively, and never counting `page.meta.ts` itself, or every declaration
would prove itself). `data-testid={meta.states.empty}` is the form named in the failure
message because with it the declared id and the rendered id are one expression and cannot
drift apart.

Shipped **ramped** (`minVersion 0.6.0`, `until 0.7.0`): an install created before 0.6.0 has
pages and no `page.meta.ts` anywhere, and projects grow into gates rather than being
ambushed by them.

**Anti-vacuity:** add `app/(protected)/o/[orgSlug]/settings/page.tsx` with no
`page.meta.ts` → FAIL naming the page and the URL it would be served at; declare a state
test id nothing in the segment renders → FAIL; delete `app/not-found.tsx` → FAIL; change a
meta's `id` without regenerating → FAIL ("stale"); allowlist a page that no longer exists
→ FAIL; declare `error: null` with no reviewed reason → FAIL.

### 32. security-headers — `node tools/check-security-headers.mjs`

The web response posture, asserted BY VALUE. The gate EVALUATES
`apps/web/lib/security-headers.ts` under `node --experimental-strip-types` (no
bundler, no tsx, no `node_modules`, no new dependency) and diffs what the module
actually returns against the reviewed policy in `tools/security-headers.json`.

The cheaper implementation — grep the source for `frame-ancestors 'none'` — is
satisfied by a directive that appears in a comment, in a disabled branch, or in a
string that is never joined into the header. Evaluating is what makes this a check
of the value rather than a check of the text, and it is the same reason the
telemetry-redaction gate was cut in design review: a text parse of a value is not a
check of the value.

Covers: every static header by exact value (HSTS, nosniff, referrer-policy,
X-Frame-Options, COOP, CORP); every `permissions-policy` feature denied by an
EXPLICITLY EMPTY allowlist rather than by omission; the CSP directives that must
hold exact values (`default-src`, `object-src`, `base-uri`, `form-action`,
`frame-ancestors`); required and banned CSP tokens; that `'unsafe-inline'` in
`script-src` never appears WITHOUT `'strict-dynamic'` (with it, a CSP3 browser
ignores it and it is a CSP2 fallback — without it, it is an open door); that
X-Frame-Options and `frame-ancestors` AGREE, so the answer does not depend on which
control the browser honours; that the report-only twin carries a `report-uri`; and
that authenticated responses are `private, no-store` with a `Vary` naming the acting
-org selector — same URL, same edge cache key, different tenant's rows is the shape
of a cross-tenant CDN poisoning bug.

Two decisions are RECORDED rather than omitted, and the gate requires each to carry
a non-trivial reason: `hstsPreload` (close to irreversible — removal from the browser
preload list takes months) and `coep` (ships UNSET, because `require-corp` breaks
every third-party embed that does not send its own CORP header, and a gate that
produces a broken app is a gate everyone exempts).

**Honest limit.** It cannot prove the DEPLOYED response carries these headers. A
correct config behind a header-stripping CDN, or a nonce that never reaches Next's
inline bootstrap, is invisible from here. That half is the `web-e2e` lane's
`security-headers.spec.ts`, which reads real `response.headers()`, asserts Next
actually STAMPED the minted nonce onto its bootstrap script, and collects
`securitypolicyviolation` events so a policy that blanks the app cannot ship green.
`check-web-e2e.mjs` holds that spec present via its `anySecurityHeaders` closure, the
same way it holds the axe scan present.

**Anti-vacuity:** delete the `frame-ancestors 'none'` entry → FAIL naming the missing
directive AND the framing disagreement; swap `'strict-dynamic'` for `'unsafe-eval'` →
FAIL on the banned token; remove `'strict-dynamic'` leaving `'unsafe-inline'` → FAIL;
shorten the HSTS `max-age` → FAIL; drop `camera=()` → FAIL; drop `x-org-id` from
`Vary` → FAIL; make authenticated responses `public, max-age=60` → FAIL; drop the
`report-uri` → FAIL. Anti-vacuity on the POLICY itself: a `tools/security-headers.json`
missing a section FAILS rather than silently skipping the checks that section governed,
and a `decisions.coep` reason shorter than 20 characters FAILS.

### 33. e2e — `node tools/check-e2e.mjs`

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

### 34. docs-sync — `node tools/check-docs-sync.mjs`

The agent-facing documentation cannot lie about the gate: CLAUDE.md stays a pure
`@AGENTS.md` include; the AGENTS.md "The N gates, in order: ..." sentence must
match `VALIDATE_STEPS` exactly (names, order, count — the release-time doc sweep
becomes mechanical); every `pnpm <script>` command AGENTS.md advertises must exist
in the root package.json scripts; and every `VALIDATE_STEPS` name has its own
numbered section (`### <n>. <name> — `) in THIS catalog — the anti-vacuity record
is part of the gate, so an undocumented step cannot ship. The agent roster is part
of the same surface: every `.claude/agents/*.md` must parse under the pinned
frontmatter grammar (`tools/lib/agent-roster.mjs`; a parse failure is a RED, never
a skip) and the reviewers (`security-reviewer`, `web-security-reviewer`,
`mobile-security-reviewer`, `accessibility-reviewer`, `design-reviewer`,
`architecture-reviewer`, `torvalds-reviewer`, `citation-verifier` — the roster is
`REVIEWER_AGENTS` in `tools/lib/agent-roster.mjs`) may hold ONLY
the read-only allowlist and must disallow `Write` + `Edit` — the README's
"read-only by construction" claim, machine-asserted.

**The deferral ledger (0.7.0).** The harness's prose makes dated promises —
"Deferred to x.y.z", "out of scope for x.y.z" — and until this release nothing read
them: three sites carried the same stale one into the very release it named, and a
scoping line stayed frozen four versions. Every such sentence now has ONE machine-read
home, `tools/deferrals.json` (entries `{ id, file, target, reason ≥ 40 chars,
reviewedOn }`; `file` may be an array when one decision is stated at several sites),
closed BOTH ways over a DECLARED surface list: this catalog, the top-level
`tools/*.mjs` gate scripts, and `tools/auth-posture.json`. A dated sentence with no
entry for its file reds; an entry whose file dropped the sentence reds as stale; and
an entry whose target the installed `harnessVersion` has reached reds until the author
ships the check or moves the date — the ledger is git-clean-enforced, so a move is a
reviewed diff, never a flag. The sentence regexes are `\s+`-joined because markdown
hard-wraps dates onto the next line, which is how a per-line reader missed the stale
one. `enforcement-tiers.md` is deliberately excluded (its Target column has its own
reader — the surface derivation and the `closes:` probe), as is every SEEDED file
(a consumer's prose is not the harness's to red; `tools/data-flow.json`'s export
target has its own enforcement in `check-data-flow.mjs`). Honest limit: the scan
reads the template's OWNED surfaces only. The factory-side reader that limit used to
owe now ships: the harness repo's own dated and conditioned debts live in its
`scripts/obligations.json` register, read by `scripts/check-obligations.mjs` — release
targets judged clocklessly against package.json in its per-PR machinery lane, calendar
targets only in its scheduled lane, conditions held to shape + evidence rather than
time, with the deferral census and the future-until ramp fleet closed as unions
against this ledger and the shipped call sites. Version-ramped
(0.7.0, expires 0.8.0): an install whose own `tools/*.mjs` carry dated prose gets one
release of dated NOTEs to ledger or re-word it.

**Anti-vacuity:** add a gate to VALIDATE_STEPS without touching AGENTS.md → FAIL
printing documented-vs-actual chains; advertise `pnpm ghost` → FAIL naming it;
delete a numbered section here → FAIL naming the undocumented gate; grant
`security-reviewer` Bash → FAIL naming the agent, the grant, and the doctrine;
write "Deferred to x.y.z" (a real release number) in any scanned surface with no
ledger entry → FAIL naming file, line and target; delete the sentence an entry
ledgers → FAIL naming the stale entry; plant a manifest at or past an entry's
target → FAIL demanding discharge or a reviewed re-date
(`tests/gates/check-docs-sync.test.mjs`).

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
predicates, patched pgvector, non-BYPASSRLS role). Unreachable database → loud
SKIP locally; in CI with migrations present, unreachable = FAIL.

**There is no plan probe in THIS suite, and that is a placement decision, not an
omission.** A plan is a planner opinion at one statistics snapshot; against the
handful of rows `supabase/seed.sql` writes it is not merely noisy but WRONG — the
planner correctly reads one page rather than using an index, so a plan assertion
here would either flap or be satisfied for the wrong reason. The probe therefore
lives where the cardinality does: `tools/check-db-perf.mjs`, in the path-filtered
`db-scale` CI lane, against `supabase/seeds/scale.sql`. See **db-perf** below.
**Anti-vacuity:** drop one policy in a new migration → catalog gate + isolation
matrix FAIL; break the impersonation helper → the positive control fails, proving
the suite cannot green vacuously.

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

Per-file coverage floors on every CHANGED source file under `apps/*/src` or
`packages/*/src` (merge-base diff in CI;
worktree + staged + untracked locally — the brand-new uncommitted feature file is
exactly the case that must not slip), read from the TWO maps the unit steps just
wrote: the vitest map for server/packages/pure-mobile files, the jest map for
`apps/mobile/**`. Each changed code file must be present in its runner's map
(absent = no test imports it) and clear the per-file floors declared next to that
runner's config. A missing map FAILS CLOSED (the chain was reordered or the
artifact deleted); an empty diff passes with a note.
**Anti-vacuity:** add an untracked `apps/web/src/` file with an exported
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

### reviewer-verdicts — `node tools/check-reviewer-verdicts.mjs`

Stop-chain step 10, and the only check in the harness whose subject is the TURN
rather than the tree: every reviewer whose `MUST BE USED` trigger patterns
(reviewed data in `tools/reviewer-triggers.json`) match this turn's diff must
have returned `VERDICT: PASS`, recorded by the SubagentStop hook
(`.claude/hooks/subagent-verdict.mjs`) into the session-scoped ledger at
`.harness/reviewer-ledger.jsonl`. The Stop hook passes the turn's identity down
(`HARNESS_SESSION_ID`/`HARNESS_PROMPT_ID`) and the step narrows the ledger to
THIS turn, so last turn's PASS satisfies nothing. Four failure modes: an owed
reviewer that never ran BLOCKS, naming the trigger path that summoned it; a
reviewer that ran and returned `VERDICT: BLOCK` blocks loudly — that is the
finding it exists to produce, and a turn does not end on a BLOCK; a PASS whose
`path_state` binding does not match the tree at Stop time reds as the reviewer
having seen a DIFFERENT TREE than the one the turn is shipping — the hook
records, beside each verdict, a sha256 over the sorted (path, content-sha256)
pairs of the changed files matching that reviewer's triggers (per-reviewer
scope, so follow-up work on non-owed paths sends nothing stale; deleted files
hash as `DELETED`), the step recomputes it, and a mismatched binding — or a
null/missing one, as every pre-0.7.0 hook entry is — fails toward re-review,
because "a reviewer ran" and "a reviewer reviewed THIS" are different claims
(this class alone rides a fresh 0.7.0 ramp, until 0.8.0: a mid-session upgrade
delivers the new gate into a turn whose earlier PASSes lack the binding); and
on an install whose baseVersion predates 0.6.0 running harness >= 0.7.0, the
formerly NOTE-withheld findings land as hard reds under a `RAMP EXPIRED`
banner (the 0.6.0 ramp's deadline arrived — sweep the findings, then
graduate), while a 0.6.0-vintage install reds plainly with no banner: its ramp
is inert, not expired. Fail closed in every direction that matters: a missing
`tools/reviewer-triggers.json` is a broken control, not an empty policy
(FAIL); a missing, unreadable, or unparseable ledger BLOCKS; a missing turn
identity skips loudly outside the Stop hook and FAILS in CI, where the hook
that supplies it must have changed. What it deliberately does NOT judge is the
CONTENT of a review: a PASS is an attestation by a read-only agent whose
tools, model, and body are locked in `tools/agents.lock.json` — whether it was
a GOOD review is not a property any file can hold.
**Anti-vacuity:** tests/gates/check-reviewer-verdicts.test.mjs — the owed
reviewer that never ran, last turn's PASS refused, the cross-session PASS
refused, the BLOCK that blocks, the unparseable ledger failing closed, the
`RAMP EXPIRED` branch EXECUTED at harness 0.7.0 (with the 0.6.0-vintage
sibling case pinning the plain red, no banner), the PASS-then-edit stale
binding red (with edit-then-PASS green, the non-owed post-PASS edit staying
green, and the unbound PASS failing toward re-review), and the 0.7.0 binding
ramp's NOTE and `RAMP EXPIRED` branches both executed; the record half — the
hook appending `path_state` and the digest MOVING when the owed file moves —
is tests/hooks/subagent-verdict-pathstate.test.mjs.

## CI-only lanes (outside the chain and the Stop hook)

- **db-perf** (`db-scale` lane) — `node tools/check-db-perf.mjs`, after
  `supabase/seeds/scale.sql` has written two million rows and ANALYZEd. It is the
  live half of `query-shapes` and the only check here that can falsify the claim
  the tenancy design rests on. For each read shape in the generated manifest it
  rebuilds the statement, impersonates a real member of the largest tenant
  (`SET LOCAL ROLE authenticated` + a transaction-local `request.jwt.claims`, so
  RLS is live underneath), and runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.
  It asserts **shape, never milliseconds**: the planner chose the index the static
  gate resolved, no `Sort`/`Incremental Sort` above a keyset leaf, no node whose
  parent relationship is `SubPlan` (a correlated helper re-evaluated per row), and
  the returned rows and buffer count inside `tools/db-perf-baseline.json`. Timings
  are printed and never compared — a wall-clock threshold on a shared runner is a
  coin flip, and a flaky perf gate is a deleted perf gate.
  **`SET enable_seqscan = off` is deliberately not used**: with it, the planner
  will use any index at all, so a table whose only index is useless still yields an
  Index Scan node and the assertion becomes a statement about the flag.
  **Anti-vacuity, and it is the most important line in this entry:** below
  `minRows` in the baseline the gate SKIPS LOUDLY locally and FAILS in CI. A plan
  probe against a small table certifies nothing, because the planner correctly
  ignores an index on one — so the seed's row count is overridable and the floor is
  what stops that knob from buying a green.
  **The proof it is not redundant** (Canary 24, measured): drop
  `notes_org_id_created_at_id_idx` from the live database and leave every file
  alone. `schema-rls`, `tenancy`, `query-shapes` and all 109 pgTAP tests stay
  green — the index is still in the migration, and `notes_pkey` still satisfies the
  leading-column assertion — while db-perf reds on all three ordered shapes at once
  (a Sort node, the planner falling back to `notes_pkey`, and 1491 buffers against
  a 900 budget). Deliberately a different edit from Canary 17, which must drop the
  primary key too before pgTAP notices anything.

- **query-budget** (`integration-lane`) — `node tools/check-query-budget.mjs -- <workload>`.
  It wraps the live-api-proof suite rather than issuing its own requests, resets
  `pg_stat_statements`, and reads the delta filtered to
  `userid = 'authenticator'::regrole` (so GoTrue/Realtime/Storage traffic, none of
  which the application controls, is excluded). This is the **N+1 detector**, and it
  is the only thing here that can see one: `query-shapes` and `db-perf` are
  per-statement, and an N+1 is a defect of COUNT — a hundred perfectly-indexed point
  reads in one request. pg_stat_statements normalizes literals away, so a hundred
  reads of a hundred ids collapse into one row with `calls = 100`, which is the
  only signature the shape has.
  **Anti-vacuity, both directions:** a non-zero count immediately after the reset
  fails (the reset did not take, so every delta carries an unknown constant), and a
  ZERO count after the workload fails (the workload never reached PostgREST — a
  budget met by an instrument that is not connected is not a budget).

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
- **Web browser lane** (`web-e2e`) — the ONLY browser-side accessibility net in
  the harness (the mobile a11y floor is lint + RNTL; neither renders the DOM).
  `tools/check-web-e2e.mjs` fails closed FIRST on a missing `playwright.config`,
  an EMPTY `apps/web/e2e` suite (Playwright exits 0 on an empty run — the reason
  the lane runs a runner, not a bare `playwright test`), an assertion-free spec,
  or a spec set with no axe scan; then it runs Playwright, whose `webServer` boots
  a PRODUCTION build against the Supabase local stack (started in the job; its URL
  + publishable key exported from `supabase status` at runtime — no key is
  committed). The seeded `home.spec.ts` asserts the landing heading renders and
  axe finds no critical/serious WCAG 2 A/AA violations. Path-filtered (the `web`
  arm covers `apps/web` + the packages it bundles) + nightly, like the device
  lanes; the Playwright report uploads on failure. Falsifiability:
  `tests/gates/check-web-e2e.test.mjs` spawns the runner against a fake `pnpm` and
  proves each closure above reds (the browser run itself is CI-only, like the
  Maestro half of `mobile-e2e`).
  **The AUTHENTICATED-RENDER axis (0.6.0).** The suite must also contain a spec
  that mints a real identity, signs in **through the form**, and then calls
  `page.reload()`. Until 0.6.0 every spec in the lane was anonymous — its only
  sign-in submitted a deliberately wrong password — so no test in the repository
  had ever completed a successful sign-in, while the seeded app shipped for two
  releases persisting the browser session to `localStorage` and reading it back
  from the cookie jar on the server. The lane ran on every relevant PR and was
  green throughout: **vacuity inside a lane that ran**, which is past what
  *"'exists' is not 'ran'"* catches, and `enforcement-tiers.md` names this lane as
  the compensating control on nine rows that assume otherwise. Two positive
  markers and one negative — a real identity, a full reload, and NOT
  `context.addCookies` (a planted session proves the server reads a cookie and says
  nothing about what the browser writes, which is the half that broke). Every axis
  reads code with comments blanked, so a marker named only in prose satisfies
  nothing. The honest limit is stated in the runner: a static reader cannot tell
  that the assertion after the reload is about a protected route.
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
ci-provenance + ci-mobile-release + ci-web-deploy, `strict` = all.

| Module | What it adds | Why not default-on |
|---|---|---|
| `ci-mobile-release` | the EAS release DAG: store-credentialed builds, submission, signed-artifact checks | needs store credentials and a release cadence |
| `ci-web-deploy` | tag-triggered rebuild of the web `next build` + SLSA L2 attestation + in-CI verify of the GitHub-built artifact (the host deploys separately) | attesting a rebuild is meaningful once you ship to a host and want an independent provenance record; needs the public `NEXT_PUBLIC_*` build vars set |
| `device-e2e` | the extended on-device Maestro matrix beyond the base lane | slow emulator runners; the base lane covers the floor |
| `eas-update` | OTA update channel wiring + staged-rollout runbooks | OTA is a policy decision (runtimeVersion reach, rollback story) |
| `store-metadata` | store listing metadata as reviewable JSON in-repo (+ iOS privacy manifests) | meaningful once a listing exists |
| `ci-provenance` | SBOM + build attestation + verification step + NOTICES drift check | meaningful once artifacts ship to a consumer who verifies them |
| `gate-a11y-deep` | screen-reader checklist + extended a11y assertions beyond the lint/RNTL floor | needs human-in-the-loop passes; the floor already lint/test-enforces |
| `crash-reporting` | crash/error ingestion wiring, symbol upload, redaction unit test | needs an ingestion endpoint; redaction policy is project-specific |
| `push-notifications` | push credential wiring + permission-prompt discipline | a product decision with store-policy weight |
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
- ~~**pgTAP**~~ — **ADOPTED, and this entry was stale ancestor text.** The claim
  it made ("plain-SQL catalog assertions check the same facts without a second
  toolchain") is false in this tree and had been for some time: pgTAP is shipped
  and load-bearing. `supabase/tests/rls_structure.test.sql`,
  `rls_isolation.test.sql` and `audit_immutability.test.sql` all
  `CREATE EXTENSION IF NOT EXISTS pgtap`, `pnpm db:test` runs them, and CI's
  runtime-rls lane blocks on them. It earns the toolchain because plain SQL
  cannot do the two things the suite exists for: `lives_ok` / `throws_ok`
  (asserting that a read SUCCEEDS, or that a write raises a specific SQLSTATE,
  is how the recursion probe and the audit-immutability suite work at all) and
  a plan count, which is what makes a *silently truncated* test set a red
  instead of a shorter green. A rejection record kept after the thing was
  adopted is worse than no record — it tells the next reader not to look.
- **ts-prune / lockfile-lint / type-coverage / markdownlint** — superseded by
  `knip --strict`, the version-sync committed-lockfile floor + frozen CI
  installs over it (a frozen install only pins what a committed lockfile
  records, which is why the gate reds an absent one), the type-aware ESLint
  bans, and Biome respectively.
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
