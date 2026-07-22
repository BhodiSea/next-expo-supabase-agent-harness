# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-07-20

The four-pillar wave (W10): the reference app gains a design system with
depth — motion, elevation, iconography, haptics, skeletons — the styleguide
gate learns to enforce it, expo-policy learns today's store-rejection surface,
the perf floor grows update-cost and per-image budgets, and positive design
doctrine ships as guidance surfaces (a skill and a sixth reviewer). Honest
limit up front: the guidance half is advisory by design — the deterministic
floor changes are exactly the gate/check items below, each with its can-fail
proof, and the full chain plus every Stop-chain suite (live RLS included) runs
green on a fresh scaffold with zero edits. Counts: the chain stays 21 gates
and the canary registry 30 steps (existing proofs extended in place); guard
rules grow 72 → 73 (`tools/store-policy.json` write-protection, canaried).

### Added

- **Design-token depth** (`tools/styleguide.manifest.json`, all four families
  optional and content-conditional — an older seeded manifest renders
  byte-identically, a malformed family fails the generator): `motion`
  (durations/easings/pressScale), `elevation` (spreadable shadow levels),
  `sizing` (the 44dp `minTarget` + the icon scale), `fontScaleCap`
  (maxFontSizeMultiplier caps). Proven by shipped-manifest block presence, a
  legacy-shape backward-compat render, and a RED case per family.
- **The motion seam** (`src/lib/motion.ts` — the api-client one-door pattern,
  for animation): `useEntrance`/`usePulse`/`usePressScale` animate
  transform/opacity only (native-driver) over the motion tokens and collapse
  to static under OS reduce-motion by construction. New primitives: `Skeleton`
  (announced progressbar mirroring the incoming layout), `Spinner`, `Card`
  (tone + elevation), `PressableScale` (spring scale + opacity + the 44dp
  floor + optional haptic — Button and OptionRow refactor onto it), and the
  closed glyph set behind `Icon` (react-native-svg 15.15.4, one-door'd; tab
  bar, toast tones, and OptionRow chevrons gain glyphs). expo-haptics ~57.0.1
  joins the catalog behind `src/lib/haptics.ts` (selection/success/warning
  vocabulary only). Pull-to-refresh on both lists; keyboard avoidance moves to
  the Screen primitive; matrix rows move to 44dp (un-clipping font_scale 1.3).
- **Styleguide design-depth sub-checks** (each keyed on manifest data, keyless
  self-disables with ONE combined adoption NOTE, malformed/stale fail closed):
  literal `duration:`/`delay:` values red; raw
  `Animated`/`LayoutAnimation`/`Easing` references red outside the seam + the
  components home with NO allow escape; `shadow*`/`elevation` keys are spelled
  only in the generated tokens module; a home file styling a raw control must
  reference `sizes.minTarget`; `controlPrimitives.base` confines the
  pressable-class tags to the one touchable base. Ten new can-fail proofs; the
  e2e states sweep now asserts every route's loading surface is a progressbar
  (prose loading reds).
- **The store-readiness floor** in expo-policy, driven by the reviewed
  `tools/store-policy.json` (guard rule 73; malformed fails closed): iOS
  usage-description strings reviewed bidirectionally (`ios[]` in
  `tools/expo-permissions.json`) and never placeholder-shaped, with
  plugin-implied keys required; `ITSAppUsesNonExemptEncryption` explicitly
  declared (the scaffold declares `false`); `ios.privacyManifests` validated
  in shape + reviewed lockstep when declared (never required — absence NOTEs
  toward the store-metadata sweep); App Tracking Transparency consistent in
  both directions; the Android targetSdk floor (declared or the pinned
  per-Expo-SDK default, unknown majors fail closed, the device lane re-checks
  the generated gradle project); icon integrity via the zero-dependency
  `tools/lib/png.mjs` (marketing icon 1024×1024 opaque; solid-color
  placeholder art NOTEs by default, reds when the policy escalates — the
  pre-submission step); and the account-deletion closure (Apple 5.1.1(v)).
  Twelve new red/green fixture pairs.
- **The account-deletion slice** — store compliance as a worked vertical
  slice: `DELETE /api/me` (Bearer, 204, idempotent) →
  `accountDal.deleteAllOwnedData` (ONE unqualified DELETE under FORCE RLS —
  the policy qual is the filter; statement shape pinned via the capturing
  pg-proxy, the plan probe EXPLAINs the new shape at 25k rows with no Seq
  Scan), the command palette's `session.deleteAccount` behind a native
  destructive confirm (server first, then sign-out; failures keep the
  session), `apiDelete` in the one-door api-client, and the LIVE cross-tenant
  sweep proof (A's unqualified DELETE removes only A — B survives). ADR
  20260720 records the slice; app-review-notes names the path for reviewers.
- **Perf-floor growth**: the perf-budget gate measures the UPDATE phase (the
  same mounted tree re-rendered with a changed `tick` — a `React.memo` wrapper
  cannot fake it; asserted only when `medianUpdateBudgetMs` is declared,
  seeded ~10× the fresh-scaffold median); the build gate budgets images by
  magic bytes and raw size (`largestImageKb`, `maxImageCount`,
  `pngOverKbPreferWebp`); the startup lane rolls median-of-3 cold starts plus
  a warm start per route (`maxWarmTotalTimeMs`, the declared-but-unreported
  red), and records honestly that `reportFullyDrawn()` has no managed binding
  — the median + warm split is the managed replacement.
- **Guidance surfaces**: the `designing-mobile-ui` skill (an operational
  procedure over four references — foundations, motion, state choreography,
  six per-surface checklists, each bottoming out in existing gates; prose
  only, no scripts) and the `design-reviewer` — the sixth read-only reviewer
  (taste + choreography; read-only machine-asserted by docs-sync and
  check-plugin-manifest, `6/6 reviewers read-only`). AGENTS.md gains the
  compact design bar and a store-readiness invariant; the vertical-slice
  recipe cross-references the design skill and requires its PASS.

### Changed

- `developer.apple.com` joins the citation-domain allowlist (HIG hit targets,
  App Review Guidelines, Info.plist keys — the store checks cite it inline).
- `design/PORT-SPEC.md` locks the motion decision (core `Animated` + manifest
  motion tokens through one seam) and adds react-native-reanimated to
  Considered-and-rejected; the gates catalog records why `pnpm audit` stays
  out of the chain (the diff-aware `osv-scan` PR lane is the deterministic
  form — now documented under CI-only lanes) and reaffirms the no-memory-
  budget stance.
- Truth-ups the wave surfaced: `osv-scan.yml` sheds its cross-port
  second-ecosystem wording (this lineage is npm-only); the approved-tools
  registry now lists BOTH shipped skills (the vertical-slice skill had been
  missing from its own default-deny registry); the store-metadata
  privacy-manifest doc states what the base gate now automates (shape +
  lockstep) and what remains manual (the union sweep).

## [0.1.1] — 2026-07-19

Patch release: the repository is now a GitHub template repository, and the
release-lockstep check runs on every PR instead of only at tag time. No gate,
hook, or installer behavior changes for consumers beyond the version stamps.

### Added

- README: the Install section now documents both acquisition paths — the npx
  installer that scaffolds an app, and the GitHub "Use this template" button
  that produces your own copy of the harness itself to rebrand and extend into
  a sibling lineage — plus an owner-rebrand checklist covering every repo-root
  site that hardcodes the upstream owner, closed by a grep one-liner. (The
  shipped `template/` tree needs no rebranding: it is placeholder-clean, and
  the hygiene gate denies upstream references inside it.)
- `scripts/check-release-lockstep.mjs` is wired into the selftest matrix's
  installer-unit job, making its "asserted on every PR" header claim true:
  version skew between `package.json`, the plugin manifest, the hook stamps,
  `CITATION.cff`, and the CHANGELOG previously merged silently and only redded
  at tag time in `release.yml`.
- CONTRIBUTING's release runbook now lists the full lockstep surface (plugin
  manifest, CITATION.cff, and the five hook stamps in addition to CHANGELOG
  and `package.json`) plus the pre-tag verification command.

### Changed

- The repository is flagged as a GitHub template repository — "Use this
  template" yields a harness fork to make your own, not a scaffolded app.

## [0.1.0] — 2026-07-18

Initial development release, under construction: the sibling
`tauri-postgres-agent-harness` ported workstream by workstream to Expo
(React Native) + Hono + Postgres 16 (FORCE RLS) monorepos deployed via EAS
Build/Submit to the Apple App Store and Google Play. Nothing below is claimed
beyond what the repo's own checks verify.

### Added

- Repository bootstrap: installer CLI and repo self-check machinery ported
  from the sibling harness (syntax, hygiene leak-scan + placeholder closure,
  REUSE structural mirror, dead-code, machinery eslint/tsc, complexity
  ratchet).
- The consumer gate chain: `tools/harness.config.mjs` defines the 21 floor
  gates (format, gate-integrity, types, lint, provenance, expo-policy,
  native-deps, version-sync, prompts, licenses, schema-rls, migrations,
  contracts, dead-code, architecture, build, styleguide, perf-budget,
  route-manifest, e2e, docs-sync) plus the Stop-chain extras (RLS isolation,
  vitest + jest-expo unit suites, diff-coverage over the merged maps,
  duplication, i18n, test-quality, mobile-perf closure). The chain replaces
  the desktop sibling's platform gates with mobile ones: expo-policy
  (identity lock, ATS/cleartext, permissions/plugins allowlists, CNG purity,
  secret-shaped `extra` ban, splash-color lockstep, eas.json sanity),
  native-deps (`expo install --check` + config-plugin allowlist), and the
  mobile-perf route ↔ Maestro flow ↔ startup-budget closure.
- The CI floor snapshot: `template/base/tools/validate.floor.json` generated
  and lockstep-checked by `scripts/generate-floor.mjs` — CI treats the frozen
  snapshot as authoritative, so a locally-weakened config cannot weaken CI.
- Machinery self-checks wired into this repo's CI (W5a):
  `scripts/check-rule-integrity.mjs` + `scripts/rule-integrity.json` (G28 —
  the shipped depcruise forbidden rules/scan options hashed and the shipped
  eslint config text pinned, so a deleted, narrowed, or severity-flipped
  boundary rule reds; blocking in the lint workflow's machinery job);
  `scripts/check-claims.mjs` (G12 — README/CHANGELOG quantitative claims
  recomputed from the sources of truth, timing figures may not contradict;
  blocking in the hygiene workflow; the canary-count class activates when the
  canary registry lands with the test wave); and
  `scripts/check-release-lockstep.mjs` (one version across package.json, the
  plugin manifest, every hook's `HARNESS_HOOK_VERSION` stamp, CITATION.cff,
  and this file).
- Complexity-ratchet coverage extended over the ported template machinery:
  measured records for `template/base/tools/lib/agent-roster.mjs`
  (`parseFrontmatter` 29), `template/base/tools/lib/jsonc.mjs`
  (`parseJsonc` 24), and `template/base/tools/check-expo-policy.mjs`
  (`checkEasJson` 16), each carrying the matching inline disable whose
  ceiling the ratchet enforces.
- The test wave (W5b): `tests/gates/` (fixture-driven can-fail proofs
  spawning every real gate, including the new mobile gates), `tests/hooks/`
  (the hook I/O fail-closed contract plus a behavioral deny/allow canary for
  every one of the 72 guard-rule ids, closure asserted bidirectionally),
  and the restored installer lifecycle/graduate suites. The canary registry
  `tests/canary/injections.json` covers every VALIDATE ∪ STOP step (30 in
  total) and every shipped quality-gate CI lane, initially with W6 PORT NOTEs
  for the device-lane wall-clock canaries that could not exist before the
  emulator lanes (the W6 entry below arms them all and retires the notes);
  `scripts/check-canary-coverage.mjs` enforces gate↔canary lockstep
  (stale or missing proofs red, every proof file executed and structurally
  non-empty) and runs in the selftest matrix on both OSes. The selftest
  workflow gains the `canary` job (a real installed scaffold: 16 injections,
  each inject → gate red → revert → green, plus the RLS runner's no-database
  fail-closed proof) and the `canary-mutation` job (an untested branch in a
  fully-mutation-covered file leaves vitest, jest, diff-coverage and
  test-quality green while only the mutation ratchet reds). Installer
  coverage floors raised to 85/74/91 (measured 91.6/80.2/95.2) with a second
  floor over `template/base/tools/lib/**` at 88/82/78. The SSE suite gains a
  parser-edge kill corpus and a mock-ReadableStream pump corpus, cutting the
  committed mutation baseline from 54 accepted survivors to 25 (663 mutants,
  638 killed; every remaining survivor carries a reviewed
  genuinely-equivalent or lane-ownership reason).
- The device, perf, and integration lanes (W6). The consumer quality-gate's
  two W6 stubs become real jobs, path-filtered + nightly like the native
  lane: `mobile-e2e` (checksum-pinned Maestro cli-2.6.1 on a KVM api-33
  aosp_atd emulator; the release binary runs every committed per-route flow
  plus a GENERATED route sweep — derived from `src/routes.ts` by the
  unit-tested `tools/lib/maestro-flows.mjs`, never hand-copied — re-run under
  a flipped OS theme and font_scale 1.3; the Metro-served dev binary runs the
  kv-pre-seeded ar-XB/RTL journey, the sign-in → create-note → relaunch
  mutation flow against a real server + Postgres, and the perf-harness
  journey) and `perf-lane` (`tools/measure-startup.mjs` cold-starts every
  route via `am start -W` deep links and writes the artifact
  `check-mobile-perf`'s measurement mode enforces, fail-closed). New consumer
  surfaces: `tools/check-e2e-device.mjs` (per-flow timeout, failure evidence
  — Maestro debug output + screenshot + logcat tail — and anti-vacuity: zero
  executed flows is a red), `tools/gen-maestro-flows.mjs` (sweep/perf-harness
  generation + `--flow` scaffolding for the mobile-perf closure), the
  hand-authored `maestro/journeys/` (i18n-rtl, mutation), and the dev-only
  `app/perf-harness.tsx` chrome screen that self-measures against
  `tools/interaction-budget.json` and exposes the `perf-pass`/`perf-fail`
  leaf markers Maestro asserts. Selftest grows `bootstrap-linux` (fresh
  scaffold validate-green out of the box on node 22/24, warm wall-time
  budget with the e2e-stamp positive control, live RLS green), `integration`
  (the LIVE_PROOF suite against a real scaffold + server + Postgres), and
  the schedule/dispatch-only `maestro-smoke` (the emulator lane end-to-end
  on a real scaffold). Every W6 PORT-NOTEd canary is armed as a real
  red-proof: Canary 17 (keyset-index drop → the DAL plan probe reds),
  Canary 18 (a Date.now() config plugin → the prebuild ×2 tree compare
  reds), Canary C01 (strip the api-client's one bearer-attaching line → the
  live suite reds, then green after revert), Canary 19 (a broken container
  testID → the device sweep reds while the agent-time jest lane is asserted
  GREEN), and Canary 20 (a 300ms stall on the ranking path → the perf-pass
  marker flips). The `HARNESS_W6_DEVICE_LANES` arming variable is gone —
  the lanes are unconditional on their triggers, mirroring the native job.
- The opt-in modules (W7): all 11 `template/modules/` trees land —
  `ci-mobile-release`, `device-e2e`, `eas-update`, `store-metadata`,
  `ci-provenance`, `gate-a11y-deep`, `crash-reporting`, `push-notifications`,
  `ops-backup`, `eval-live`, `observability` — each with a
  `docs/modules/<name>/README.md` and a row in the gates-catalog module
  table, so the `standard` and `strict` tiers now install real files.
  Installer hardening in the same wave: `init` gains the per-module
  zero-file guard `enable` already had (the pinned ODDITY test flips to
  prove a zero-file tier module fails loud before anything is written), the
  lifecycle suite round-trips representative module shapes (workflow-heavy,
  doc-plus-test, slice-shaped) with zero placeholder residue, and the
  mapper/walker closure's anti-vacuity floor is restored to the
  finished-template bar (> 200 files checked). Base-template seams the
  modules rely on: a `src/adapters/*.ts` knip entry for the eval package's
  LLM extension point, the two titled observability placeholders in
  `tools/test-quality-allow.json`, cspell words for the provenance module's
  product names, and the RLS cross-tenant UPDATE probe generalized to derive
  its probed column from each isolation target's own seed row (the
  hard-coded `title` column red SQLSTATE 42703 on any second target whose
  table lacks it).
- W7 verification sweep fixes, after eleven independent module verifications:
  the generalized RLS probe is biome-formatted (the unformatted arrow at
  105 chars red the format gate — gate 1 of 21 — on EVERY fresh scaffold,
  the single shared cause of all eleven red verdicts); `src/crash/redact.ts`
  joins the mobile knip entries so enabling `crash-reporting` no longer reds
  the dead-code gate (`knip --strict` counts a doc-wired module's only
  reference — its own test — as non-production; the pattern is inert while
  the module is off, proven both ways); `disable` now prunes the empty
  directory skeletons it used to leave behind (every verifier flagged the
  husks; locked by lifecycle assertions); a fresh scaffold's `pnpm spell` is
  green out of the box (`{{APP_SCHEME}}` renders into the scaffold's own
  cspell words so identifier-derived tokens pass, device/mutation-lane and
  module-workflow product names join the dictionary, and generated
  `NOTICES.md` + `tools/identity.lock.json` are ignorePaths); module-doc
  gaps closed: the eas-update README's `updates.url` snippet carries the
  `// SOURCE:` line the provenance gate requires, push-notifications
  APPLY.md explains why the slice must be committed before the Stop chain
  (diff-coverage measures the uncommitted diff), and the crash-reporting
  source-map steps gate on `HAVE_TOKEN` too (no publish → no `dist/`, and
  nothing shipped that needs maps).
