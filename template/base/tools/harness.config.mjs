// tools/harness.config.mjs — the single source of truth for the quality gate.
// Consumed by tools/validate.mjs (`pnpm validate`), the Stop hook, and CI, so the three
// enforcement layers can never disagree about what "done" means.
//
// HARNESS-PROTECTED: the write-guard hook denies agent edits to this file unless
// HARNESS_ALLOW_SELF_EDIT=1 is set, and CI re-runs the same steps with a hardcoded
// floor (`node tools/validate.mjs --min-floor`) — so editing this config can ADD
// steps but can never weaken the non-negotiable ones.
// SOURCE: docs/harness/README.md (the gate config is harness-protected and mirrored in CI) [corpus: harness/doctrine]

// Each step is [name, shellCommand]. Steps run sequentially, cheap → expensive;
// the first failure stops the run. Toolchain-dependent steps and surface-dependent
// gate scripts self-skip LOUDLY when their prerequisite is absent locally and fail
// closed in CI (HARNESS_REQUIRE_TOOLCHAINS=1) — a skip must never be mistakable
// for a pass.
export const VALIDATE_STEPS = [
  ['format', 'pnpm exec biome ci .'],
  ['gate-integrity', 'node tools/check-gate-integrity.mjs'],
  // Integrity proves the enforcement FILES are the ones the harness wrote; `wiring` proves
  // they are CONNECTED. Both must hold before any later gate's verdict means anything, so
  // it sits here. Five of its invariants had exactly one check between them — `installer
  // doctor` — and nothing ran it: an install could pass every hash while a hook was
  // unwired, `pnpm validate` pointed somewhere else, an enforcement path had no CODEOWNERS
  // rule, and `bypassPermissions` was the default mode, with the whole chain green.
  ['wiring', 'node tools/check-wiring.mjs'],
  // Credentials, before anything expensive runs. lefthook prints `SKIP secrets scan` when
  // gitleaks is absent and gitleaks.yml only scans after a PUSH, so a turn could end green
  // with a service-role key in a tracked file on any machine without the binary. Hermetic,
  // zero-dependency, and self-tested against one synthetic positive per rule id at startup.
  ['secrets', 'node tools/check-secrets.mjs'],
  // `tsc -b .` builds the composite package graph; `apps/web apps/mobile` are added as
  // extra build ROOTS so the two non-composite leaf apps are typechecked in the same
  // invocation (they cannot be `references` of the solution — a referenced project must be
  // composite, and an app that emits a declaration reds on the tRPC client's private
  // symbol; see apps/*/tsconfig.json). One command, whole workspace. SOURCE: design/W1-STACK-SPEC.md §3
  ['types', 'pnpm exec tsc -b . apps/web apps/mobile'],
  ['lint', 'pnpm exec eslint . --max-warnings 0 --cache'],
  ['provenance', 'node tools/check-sources.mjs'],
  // The boundary TRIAD, part 1: the two census consumers (check-exports-walls +
  // check-workspace-deps) that derive from the ONE tools/exports-walls.json. Cheap,
  // pure-node, static. The import-GRAPH half of the triad (the census-derived
  // dependency-cruiser layering) is enforced by the later `architecture` step.
  ['boundaries', 'node tools/check-exports-walls.mjs && node tools/check-workspace-deps.mjs'],
  ['expo-policy', 'node tools/check-expo-policy.mjs'],
  ['native-deps', 'node tools/check-native-deps.mjs'],
  ['version-sync', 'node tools/check-version-sync.mjs'],
  ['prompts', 'node tools/check-prompts-lock.mjs'],
  ['licenses', 'node tools/check-licenses.mjs'],
  ['schema-rls', 'node tools/check-rls-manifest.mjs'],
  // The tenancy contract, judged as data: schema-rls proves every predicate is REAL;
  // this proves it scopes by TENANT — a closed set of reviewed predicate forms
  // (tools/tenancy.json) that every top-level OR arm must carry, the correlated-
  // argument ban, NOT NULL FK tenant keys, partition-ready uniques, freeze triggers,
  // and the membership table's self-only/deny-all shape. Runs right after schema-rls
  // on the migration text it just parsed.
  ['tenancy', 'node tools/check-tenancy.mjs'],
  // The AUTH half of the same backend, judged the same way: reviewed data, diffed by value, in
  // both directions. It sits here because it reads supabase/config.toml — the file the two steps
  // around it are about — and because it is a <100ms static parse that should red before
  // anything expensive runs. The backward direction is the one that earns it: the Supabase CLI
  // parses config.toml LENIENTLY, so `enable_refresh_token_rotaton = true` (one letter short)
  // reads as a security property while GoTrue applies its default, and nothing said so.
  ['auth-posture', 'node tools/check-auth-posture.mjs'],
  ['data-flow', 'node tools/check-data-flow.mjs'],
  ['types-drift', 'node tools/check-types-drift.mjs'],
  ['migrations', 'node tools/check-migrations.mjs'],
  // The resource ceilings and the quota machinery, judged as data. It runs right after
  // `migrations` because it reads the same migration text that step just parsed (warm
  // page cache) and because its subject is the same: what the applied history does to a
  // running database. Its most valuable rule is INVERTED — `temp_file_limit` and
  // `CONNECTION LIMIT` must NEVER appear, because on this platform they bind nothing
  // and a number that cannot bind reads to a reviewer as a control that exists.
  ['db-limits', 'node tools/check-db-limits.mjs'],
  ['contracts', 'node tools/check-contract-drift.mjs'],
  // The one claim the whole tenancy design rests on, finally falsifiable: that the
  // statements the DALs issue are ORDERED INDEX SCANS and not filters over every
  // tenant's rows followed by a Sort. It runs after `contracts` because `contracts` is
  // what proves tools/generated/query-shapes.json is byte-fresh — judging index
  // service against a stale manifest would certify the queries the app used to send.
  // The live half (a real planner, real statistics, 2M rows) is tools/check-db-perf.mjs
  // in the path-filtered `db-scale` CI lane; neither half subsumes the other.
  ['query-shapes', 'node tools/check-query-shapes.mjs'],
  // After `contracts`, because the closure this step's whole value rests on is over
  // tools/generated/action-inventory.json — and `contracts` is the step that proves that
  // file is not stale. Judging a budget against a stale inventory would report full
  // coverage of a router that no longer exists.
  ['rate-limits', 'node tools/check-rate-limits.mjs'],
  // Two-way surface parity: every action in the contracts-verified inventory maps to exactly
  // one PARITY.md row (a web screen, a mobile screen, or a reasoned —), and every row names a
  // LIVE action. Runs right after `contracts` so the inventory it contains against is proven
  // byte-fresh. Ships soft via rampNote (strict on fresh installs + the template tree).
  ['parity', 'node tools/check-mobile-parity.mjs'],
  ['dead-code', 'pnpm exec knip --strict'],
  ['architecture', 'pnpm exec depcruise apps packages --config .dependency-cruiser.cjs'],
  ['build', 'node tools/build-check.mjs'],
  ['styleguide', 'node tools/check-styleguide-manifest.mjs'],
  ['perf-budget', 'node tools/check-perf-budget.mjs'],
  // TWO SCRIPTS, ONE STEP — the same shape `boundaries` uses above. The routers do not agree
  // on a single rule (expo-router maps a trailing `index` to its parent path and has no route
  // groups, parallel routes, intercepting routes or private `_folder` exclusion; the App Router
  // has all four and no `index` convention), so one parser serving both would branch on surface
  // at every line. Both scripts declare `GATE = 'route-manifest'`, so the chain, the canary
  // registry and the tiers table see ONE control that covers both surfaces — which is what
  // discharges the 0.6.0 Target on the `route ↔ screen closure` row.
  // ONE LINE, deliberately, like `boundaries` above: installer/lib/migrations.mjs injects a new
  // step by anchoring on a single-line `['name', 'cmd'],` entry, so a wrapped entry is a place a
  // later injection lands INSIDE. The suite caught it the moment this was written multi-line.
  ['route-manifest', 'node tools/check-route-manifest.mjs && node tools/check-web-routes.mjs'],
  // The web response posture, asserted BY VALUE: the gate evaluates
  // apps/web/lib/security-headers.ts under node's type stripping (no bundler, no
  // node_modules, no new dependency) and diffs what it returns against the reviewed
  // policy in tools/security-headers.json. It cannot prove the DEPLOYED response —
  // that half is the web-e2e lane's security-headers spec, which check-web-e2e.mjs
  // holds present the same way it holds the axe scan present.
  ['security-headers', 'node tools/check-security-headers.mjs'],
  ['e2e', 'node tools/check-e2e.mjs'],
  ['docs-sync', 'node tools/check-docs-sync.mjs'],
]

// What the Stop hook runs before a turn may end. These invoke the gate DIRECTLY —
// `node tools/validate.mjs`, `node tests/rls/run-rls.mjs`, `pnpm exec vitest` — never
// through a package.json script name. Script indirection (`pnpm validate`) would let an
// agent redefine "validate" to `true` in package.json (an auto-accepted, unguarded edit)
// and pass a hollow gate; direct invocation keeps the Stop gate tamper-evident, since this
// config and those runners are all write-guard-protected.
// SOURCE: docs/harness/README.md (tamper evidence) [corpus: harness/doctrine]
export const STOP_HOOK_STEPS = [
  // --report-all: the Stop block must show EVERY red at once — serial
  // one-red-per-turn discovery would exhaust the agent's block budget.
  ['validate', 'node tools/validate.mjs --report-all'],
  ['rls-isolation', 'node tests/rls/run-rls.mjs'],
  // --coverage enforces the thresholds in vitest.config.ts (write-guard-protected)
  // so a turn cannot end with a coverage-cratering change.
  ['unit', 'pnpm exec vitest run --coverage --silent'],
  // The RN component/screen half of the unit floor: react-native code cannot run
  // under vitest without a fragile transform pipeline, so apps/mobile tests run
  // under jest-expo. Both runners emit istanbul coverage-final.json and
  // diff-coverage merges the two maps.
  ['mobile-unit', 'pnpm --filter mobile exec jest --coverage --silent'],
  // Per-file floors on every CHANGED source file under apps/*/src or packages/*/src
  // (uncommitted + untracked work included), read from the merged coverage maps the unit
  // steps just wrote — a new module cannot land 0%-covered inside a green aggregate.
  // apps/web's app/ and lib/ are OUTSIDE that shape and are a DECLARED tier, with its
  // compensating control and target release in docs/harness/enforcement-tiers.md.
  ['diff-coverage', 'node tools/check-diff-coverage.mjs'],
  // Copy-paste rot: a token clone detector over apps/*/src + packages/*/src. A
  // Stop-chain step, NOT a floor member (the floor stays frozen) — fast and
  // deterministic.
  ['duplication', 'node tools/check-duplication.mjs'],
  // The locale seam: no hardcoded user-facing string, and locale-sensitive formatting
  // (Intl, toLocale*, toFixed) only inside apps/mobile/src/i18n/. The behavioural half
  // (a pseudo-locale + RTL sweep over every route) runs in the e2e fast lane (RNTL)
  // and on-device in the Maestro CI lane.
  ['i18n', 'node tools/check-i18n.mjs'],
  // Assertion PRESENCE — the cheap, fast half of the assertion-quality control. Coverage
  // counts lines a test EXECUTED; nothing else in this chain notices that the test body has
  // no `expect`, or that a committed `.only` has silently disabled every other test in the
  // suite. ~50ms, so it belongs here. What it CANNOT do is prove a test would notice the
  // code breaking — that is the mutation lane (tools/check-mutation-ratchet.mjs), which runs
  // in CI because it takes minutes and this chain has a ~6s budget.
  ['test-quality', 'node tools/check-test-quality.mjs'],
  // CLOSURE half of the mobile perf floor: every route in src/routes.ts must have a
  // Maestro flow file AND a committed row in tools/startup-budget.json (and stale
  // rows red). Static (~10ms — it reads three files), so it belongs here: an agent
  // cannot end a turn having added a screen that no machine check will ever time.
  // The MEASUREMENT half needs an emulator (minutes) and runs in the CI perf lane.
  ['mobile-perf', 'node tools/check-mobile-perf.mjs --closure'],
  // THE PROCESS STEP (0.6.0), and the first check in this chain whose subject is not the
  // TREE but the TURN. Every reviewer whose MUST-BE-USED paths this diff touched has to have
  // returned VERDICT: PASS, recorded by .claude/hooks/subagent-verdict.mjs from the
  // SubagentStop payload. It is last because it is the only step that can be satisfied by
  // doing something OTHER than editing code — reaching it means the tree is already green,
  // which is the state a reviewer should be reading.
  ['reviewer-verdicts', 'node tools/check-reviewer-verdicts.mjs'],
]
