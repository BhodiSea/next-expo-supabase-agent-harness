# next-expo-supabase-agent-harness

A deterministic agent harness for pnpm monorepos that ship a **Next.js 16 web
app AND an Expo (React Native) mobile app over one shared Supabase backend** —
deployed to **Vercel** and to the **Apple App Store and Google Play via EAS
Build/Submit** — installable into any new or existing project.

Its single purpose is the two-surface shape: one schema, one contract package,
one token source, one authorization boundary (Postgres row-level security),
two clients. The cross-surface seams are enforced by gates, not by discipline.

> **Status: pre-release (0.11.x).** This repo was forked from
> [`expo-postgres-agent-harness`](https://github.com/BhodiSea/expo-postgres-agent-harness)
> (itself descended from
> [`tauri-postgres-agent-harness`](https://github.com/BhodiSea/tauri-postgres-agent-harness));
> the surface-agnostic machinery was ported forward and the single-surface stack
> replaced. The stack tree, gate chain, hooks, and agent layer are this lineage's
> own, and the `hono`/`drizzle` cross-porting detectors are armed, so that
> vocabulary is a hard red anywhere under `template/`.
>
> **What is proven:** `init` → `pnpm install` → `pnpm validate` is green on a
> fresh scaffold with zero edits — all 36 gates — and the selftest matrix proves
> it on every push, including the live-Supabase RLS suite and the 29 can-fail
> canaries (counted from the matrix itself, not hand-authored). The execution
> proofs — the chain, the hooks, the upgrade ladder — run on **Linux**, plus a
> Windows unit matrix (`installer-unit`) over the gate and hook logic, because
> the path-separator/CRLF class only reproduces on a real Windows filesystem.
> There is **no macOS lane and no off-Linux `validate` lane of any kind**:
> `pnpm validate` has never been executed on a runner that is not Linux. Through
> 0.9.9 this paragraph said the opposite — it described "macOS/Windows validate
> legs" as schedule-gated measurement lanes, and `grep -rn macos
> .github/workflows/` returns nothing at all. Nothing is claimed
> here that that matrix does not run.
>
> **Honest losses.** Rate limiting binds the two application seams (the tRPC router
> and the Next Server Action layer) and does **not** bind a client calling PostgREST
> directly with the publishable key and its own JWT, nor sign-in/sign-up, which go to
> GoTrue; the controls that bind every path are the per-org quota trigger and the
> per-role statement timeouts. The limiter **fails open** when its backend is
> unavailable — a recorded decision — but since 0.10.0 it degrades to the in-process
> limiter rather than stopping: a Redis outage multiplies the budget by the instance
> count instead of removing it, and on a serverless platform that discards the process
> it still approaches no limit. Statement timeouts bound duration, not concurrency. SELECT
> auditing is out of scope (the trail covers mutations). DSR export shipped in
> 0.7.0 (`system.exportMyData`); erase ships as `session.deleteAccount` plus the
> `delete-account` Edge Function (the expo-policy gate refuses an auth surface
> without an account-deletion command — Apple 5.1.1(v)), and since 0.11.0 the WEB
> app reaches the same rail from the signed-in shell. `tools/data-flow.json` now
> carries an `erase` record whose `clients` closure names BOTH initiators, so the
> gate that holds export to a delivered surface holds erase to one on each
> surface — the failure it was written for is a backing that works while one
> surface cannot reach it, which is what the previous four releases shipped.
>
> **E2EE ships as RAILS, not as an encrypted app** (0.9.5, the opt-in `e2ee`
> module). What works: a versioned AEAD envelope with mandatory associated data
> binding each ciphertext to its row identity, a local key hierarchy
> (keystore root key → HKDF-derived KEK → a fresh per-item DEK, wrapped), a
> vector-conformant WebCrypto provider, and the doctrine, lint rules, write-guard
> rules and citation corpus that keep primitives behind one door. **No shipped
> feature is encrypted** — the notes vertical stores plaintext, and converting one
> is the consumer's act through the `authoring-e2ee-feature` skill. The mobile
> AEAD provider is a documented consumer decision, not a default (a native crypto
> dependency is a choice the harness refuses to make for you). Sharing, recovery
> and multi-device are DECLARED ports with no implementations: a second device
> sees ciphertext, and **a lost device is lost data**. Encryption hides content,
> not shape — row counts, sizes and timestamps stay server-visible — and an
> encrypted column cannot be searched, sorted or filtered by the database.
> `docs/modules/e2ee/README.md` states each of these losses in full.
>
> **Honest limits.** The chain grew to 36 steps in this release, so the
> wall-clock figures are UNPUBLISHED until the dispatched re-record lands: the
> committed 34/10 measurements in `scripts/chain-budget.json` (recorded
> 2026-08-09, Linux/X64) are history for a chain this tree no longer runs, and a
> figure whose measurement does not count-match the live chain licenses nothing —
> `check-claims` reds on a published figure with no committed measurement behind
> it, and `check-chain-budget --record` is the thing that can produce one
> (dispatch the selftest lane, review the artifact, commit it). The cold path is
> unmeasured and carries no figure for the same reason. The order is measure,
> commit, then publish. The device lanes (Android emulator + Maestro) are schedule- and
> dispatch-gated, so a PR does not pay for them — which also means they are
> proven nightly, not per-commit. The gate chain contains no on-device proof at
> agent time.

## What it is

An npm-installable CLI + Claude Code plugin that scaffolds the monorepo and
installs three enforcement layers into it:

1. **Agent-time hooks** — PreToolUse guards driven by a pure-data rule table
   (136 guard-rule ids: shell-command denials, write-protected harness paths,
   banned content everywhere, the schema/migration SQL surface, the npm
   lifecycle-script surface, and the MCP tool-call registry), a PostToolUse
   provenance check, and a Claude Code `Stop` hook that refuses to end a turn
   until the validation chain, RLS isolation tests, and both unit suites pass.
   Seven hooks are wired, each invoked as `node "<path>"` so a hook's executable
   bit is not in the trust path.
2. **Commit-time checks** — lefthook + commitlint + gitleaks.
3. **CI** — the same validation chain, fail-closed, plus device lanes
   (Android emulator + Maestro) and release automation (release-please +
   EAS Build/Submit with honest degrade when credentials are absent).

## The gate chain

`pnpm validate` in a scaffolded project runs `tools/validate.mjs`, driven by a
single config (`tools/harness.config.mjs`) shared by the Stop hook and CI so
the three layers can never disagree about what "done" means. The chain is
36 gates, cheap → expensive:

format (biome) → gate-integrity (manifest sha over the gate scripts/hooks, the
`node "<path>"` shape of every hook command, and `STOP_HOOK_STEPS ⊇` the frozen
`tools/stop.floor.json` — tampering is turn-fatal) → **wiring** (the enforcement
layers are actually CONNECTED: seven hooks wired, the permission posture,
`pnpm validate` still running the gate, `CLAUDE.md` a pure include, and CODEOWNERS
covering every escape list and enforcement-surface prefix — the invariants `doctor`
was the only check for, and nothing ran `doctor`) → **secrets** (a hermetic,
zero-dependency credential scan inside the chain, in rule-id lockstep with
`.gitleaks.toml`, because lefthook SKIPs without the binary and the gitleaks
workflow only scans after a push) → types (`tsc -b`) → lint (typescript-eslint
strictTypeChecked + react-native/a11y every-rule-error + React Compiler rules +
cognitive-complexity ≤ 15 + the fetch/secure-store/chart-library boundary
bans) → provenance (`SOURCE:` on every decision site) → **boundaries** (the two
census consumers off one `tools/exports-walls.json`: the `./client` wall + the
declared-dependency allow-matrix) → **observability** (vendor telemetry
containment: no telemetry SDK import outside the reviewed `tools/observability.json`
sinks register, every sink behind the redaction pass) → **expo-policy**
(identity lock, ATS/cleartext, permissions + config-plugin allowlists, CNG
purity, secret-shaped `extra` ban, splash-color lockstep, eas.json sanity) →
**native-deps** (`expo install --check`, CNG purity, plugin allowlist) →
version-sync → prompts (hash-locked LLM prompts) → licenses → **schema-rls**
(every `supabase/schemas` table FORCE RLS + per-operation policies + initPlan
predicates + dual isolation-registry coverage, or a reviewed exemption) →
**tenancy** (the multi-tenant contract as data: every tenant-table policy's
top-level OR arms match the closed predicate-form set in `tools/tenancy.json`,
helpers stay zero-argument/STABLE/INVOKER, tenant keys stay `NOT NULL` FKs,
uniques stay partition-ready, freeze triggers hold, and the membership table
stays self-only-read/deny-all-write — schema-rls proves a predicate is REAL,
this proves it scopes by TENANT) →
**types-drift** (the committed Supabase type mirror matches the live schema) →
migrations (append-only, DML-free) →
**db-limits** (the blast-radius ceilings asserted as data: every role×knob pair
in `tools/db-limits.json` present in an `ALTER ROLE … SET`, inside its ceiling,
and folded in *statement order* so a later re-set decides; the per-org quota
trigger is `FOR EACH STATEMENT … REFERENCING NEW TABLE` with a release twin and
an unscoped reconciler; `[api].max_rows` bounded; any `[db.pooler]` in
transaction mode; every `postgres(` construction `prepare: false`) →
contracts →
**query-shapes** (every statement the DALs actually issue is bounded and
index-served, judged against `tools/generated/query-shapes.json` — a manifest
written by EXECUTING each DAL function through a harness-owned recording port,
never by describing it. An index must carry the equality set as its leading
columns and then the `ORDER BY` columns in order and in one scan direction, so
the sort disappears rather than happening in memory; OFFSET pagination, an
unbounded read, a cursor that disagrees with its sort, and a tenant table read
without a leading tenant key all red) →
**rate-limits** (the rate-limit budget as reviewed data: every MUTATION in the
generated action inventory maps to a declared bucket or carries a reasoned
exemption — both ways — and `apps/web/lib/rate-limit.ts` is evaluated and diffed
against `tools/rate-limit-budget.json` by value, so a limit changed in code
without a reviewed diff reds and so does the reverse; both seams are asserted
wired, because a policy nothing consults is a policy in name only) →
**parity** (two-way
surface-parity ledger: every action ↔ a `PARITY.md` row, both ways) →
dead-code (`knip --strict`) →
architecture (dependency-cruiser: mobile never imports server code or the
server stack, driver confined to the db layer, `db/context` DAL-only) → build →
styleguide (OKLCH token manifest regen-diff) → perf-budget → route-manifest →
**security-headers** (the web response posture asserted BY VALUE: the gate
evaluates `apps/web/lib/security-headers.ts` and diffs what it returns against
`tools/security-headers.json` — CSP directives, the nonce/strict-dynamic rule,
framing-control agreement, and `private, no-store` + `Vary` on authenticated
responses) →
e2e (the jest-expo + RNTL fast lane) → docs-sync.

CI runs the same chain against the frozen snapshot `tools/validate.floor.json`
(`node tools/validate.mjs --min-floor`; write-guard-protected, fail-closed if
missing, kept in lockstep with the config by `scripts/generate-floor.mjs`) — a
locally-weakened config cannot weaken CI. Toolchain-dependent gates skip
loudly without their prerequisite locally and fail closed in CI
(`HARNESS_REQUIRE_TOOLCHAINS=1`); a skip is never mistakable for a pass.
**Honest limit:** the chain contains no on-device proof — Maestro device flows
and startup-budget measurement run in CI device lanes, not at agent time.

Before a turn may end, the Stop hook runs the full chain (`--report-all`, so
every red surfaces at once) and then, invoked directly rather than through a
redefinable package script: the RLS isolation suite against real Postgres,
the vitest unit suite and the jest-expo mobile suite (both with coverage),
then per-file diff-coverage over the merged maps, duplication, the i18n seam,
test-quality (assertion presence, no committed `.only`), and the mobile-perf
closure (every route has a Maestro flow and a startup-budget row).

## The harness under its own bar

The repo applies the doctrine to itself: `scripts/` carries the machinery
self-checks, blocking in this repo's CI. `check-rule-integrity.mjs` hashes the
shipped depcruise forbidden rules + scan options and pins the shipped eslint
config text against `scripts/rule-integrity.json`, so a deleted, narrowed, or
severity-flipped boundary rule reds even though the lint/architecture runners
would still exit 0. `check-complexity-ratchet.mjs` re-lints with
`--no-inline-config` so a ratcheted function cannot grow behind its disable
directive. `check-claims.mjs` recomputes the machine-derivable numbers in this
README (chain length, guard-rule ids) and asserts README/CHANGELOG timing
figures cannot contradict each other. `check-release-lockstep.mjs` asserts one
version everywhere (package.json, plugin manifest, hook stamps, CITATION.cff,
CHANGELOG). `generate-floor.mjs` keeps the CI floor snapshot equal to the
canonical chain. `check-obligations.mjs` reads `scripts/obligations.json` — the
register of the release's forward obligations, one row per debt with a kind
discriminator (`release` reds clocklessly when package.json reaches the target;
`calendar` is judged only in the scheduled lane; `condition` is held to shape
and evidence, never to time). The wall-clock figures above are one runner's
committed measurements (`scripts/chain-budget.json`) — a figure with no
committed measurement behind it is a `check-claims` red, not a claim.

## Conformance: the Essential Eight, mapped whole

Every generated project ships `tools/essential-eight.json` — a reviewed map of all 149
requirements of ASD's Essential Eight Maturity Model at Maturity Level Three, each
carrying the requirement text verbatim and a grade against what the application actually
does. The `docs-sync` gate judges the map on every `pnpm validate`: every claimed control
must be one something actually runs, every `not-applicable` must carry a written negative
proof, every unbuilt row must name the obligation that owns it, and no artefact may be
counted twice.

**No application holds an Essential Eight maturity level, and this one does not either.**
Maturity attaches to an organisation's system; ASD certifies no products and publishes no
approved-product list. 46 of the 149 requirements name drivers, firmware, Microsoft
Office, browser fleets and workstation telemetry, which no repository can move — and
because assessment is all-or-nothing per strategy, a repo-scoped reading of the model
lands on Maturity Level Zero rather than Three. `scripts/hygiene.mjs` sweeps the whole
repository for the sentence that says otherwise, so a launch-week README edit cannot
introduce it later.

The map is for the useful thing next door: making sure a generated application is never
the *blocker* to its operator's assessment, and handing an assessor a per-requirement
statement with evidence attached instead of a sales claim. What the harness produces is
machine-checkable evidence for the software-supply-chain, application-audit-log,
authentication and backup portions of an organisation's ML3 assessment — and it hands the
endpoint, driver, firmware, Office, browser-fleet, workstation-telemetry and
incident-response portions back to the organisation.

The standing below is recomputed from the register by `check-claims.mjs` and printed
verbatim by the gate, as the whole partition rather than the flattering half of it:
**149 ML3 requirements: 6 effective, 5 alternate-control, 27 not-implemented, 61
not-applicable, 50 organisation-boundary; 8 shared clauses.** Grades are conservative by
rule — absence of a surface is never a control, where two grades are defensible the lower
one is taken, and an artefact another row already claims is not claimed again. Rows
graded `not-implemented` are honestly unbuilt and each names the obligations row that owns
the gap; the gate deliberately does *not* fail on them, because failing would create
steady pressure to regrade generously to get a green build. Evidence carries ASD's own
ranking, so a row backed only by a written statement is labelled `documentation` rather
than borrowing its neighbours' credibility. The consumer-facing map is
`docs/compliance/essential-eight.md`.

## Install

### Scaffold an app

```sh
npx --yes github:BhodiSea/next-expo-supabase-agent-harness init
```

### Use this template — fork the harness itself

This repository is a GitHub **template repository**. "Use this template"
produces your own copy of the *harness* — installer, `template/`, selftest
machinery — to rebrand and extend into a sibling lineage; it does **not**
produce an app (the npx path above does that). A template copy starts from a
single commit with no upstream history or tags, and the selftest, hygiene, and
lint workflows run owner-agnostically in the copy.

The shipped `template/` tree needs no rebranding — it is placeholder-clean, and
the hygiene gate denies upstream references inside it. What does need rewriting
in a copy is the checklist of repo-root sites that hardcode the upstream owner:

- `package.json` — `repository.url`, `homepage`, `bugs.url`, `author`
- `README.md` — the npx command above, the sibling-harness link in the status
  note, and this checklist
- `CITATION.cff` — `title`, `authors`, `repository-code`
- `CHANGELOG.md` — the lineage note at the top (it names THIS repo as the
  ancestor of yours) and the version line you continue from
- `CONTRIBUTING.md` — rule 2 names the vocabulary your lineage owns
- `SECURITY.md` — the advisories URL and the `update` command
- `.github/CODEOWNERS` — every owner handle
- `.github/ISSUE_TEMPLATE/config.yml` — the advisory, discussions, and repro URLs
  (and `bug-report.yml`'s `npx` line)
- `.claude/settings.json` — you inherit the upstream maintainer's permissions;
  review the default mode before your first agent turn
- `.claude-plugin/plugin.json` — the npx command in `description`, `author`,
  `homepage`, `repository`
- `.claude-plugin/marketplace.json` — `owner`
- `REUSE.toml` and `LICENSES/` — keep the upstream copyright and append yours
- `tests/gates/check-reuse.test.mjs` — it asserts the upstream copyright string
- `scripts/check-corpus-fidelity.mjs` — the User-Agent contact URL
- `installer/lib/detect.mjs` — the sibling-harness redirect messages
- `scripts/hygiene.mjs` — two edits, and the second is the one that bites.
  **(a)** Keep the upstream-handle deny pattern (it stops upstream references
  from ever entering your `template/`) and add your own handle alongside it;
  likewise keep the upstream copyright notices (`REUSE.toml`, `LICENSES/`) and
  append your own. **(b)** Re-seed the **cross-porting detectors**: they ban a
  sibling harness's stack vocabulary anywhere under `template/`, so a lineage
  whose stack *is* that vocabulary reds on its own first file. Drop only the
  words your lineage now owns, and add the words of the lineage you forked
  away from — never delete a pattern to make a run pass. (This fork dropped
  `/supabase/i` and `/vercel/i` immediately, and armed `/\bhono\b/i` +
  `/drizzle/i` once every carrier had been retargeted. Expect that ordering: a
  lineage fork's detectors arm LAST, because until the port is complete they
  would red on the code you are still porting. They earn their keep afterwards —
  the first draft of one commit in this release named the ancestor's ORM in a
  comment explaining its own removal, and the detector caught it.)

Then prove closure the way the harness proves everything else:

```sh
grep -rn "BhodiSea\|Cogvera" --exclude-dir=node_modules .
```

should return only the attribution you deliberately kept and the hygiene deny
pattern.

## Layout

- `installer/` — the CLI (`init`, `update`, `doctor`, `enable`, `graduate`).
  Zero runtime dependencies.
- `template/base/` — the harness machinery installed into a consumer: gate
  scripts, Claude Code hooks/agents/rules, CI workflows (stored dotless),
  db bootstrap, RLS/migration test harnesses.
- `template/stack/` — the reference app: `apps/{web,mobile}` (Next 16 App Router
  + Expo 57 expo-router) + `packages/{api,contracts,verticals/*,shared/*,
  platform/*,design-tokens,design-system,design-system-native}` + `supabase/`
  (SQL-first migrations + RLS + pgTAP). One seeded vertical (`notes`) is
  exercised end-to-end across both surfaces.
- `template/modules/` — opt-in modules (EAS release automation, EAS Update,
  store metadata, device e2e, crash reporting, observability, …).
- `scripts/`, `tests/` — the harness holding itself to its own bar.

## License

Apache-2.0 for the repository; everything under `template/**` is
"Apache-2.0 OR 0BSD" (recipients choose either — the scaffolded code carries
no attribution requirement).
