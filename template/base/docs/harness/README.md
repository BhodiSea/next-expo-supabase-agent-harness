# The harness doctrine

This document is the canonical reference for every `// SOURCE: docs/harness/README.md`
citation in the codebase. It explains **why** each enforcement mechanism exists, **which
script implements it**, and **where the honest limits are**. The per-gate reference lives
in [gates-catalog.md](./gates-catalog.md).

## The gate is the enforcement

The one-sentence thesis: **quality is a deterministic gate, not a request.** Memory files
(AGENTS.md, `.claude/rules/*.md`) are advisory context; hooks, gate scripts, and CI are
the enforcement. The harness is built so the model produces green-on-first-try code and
the gate rarely has to fire — but when it does fire, it cannot be talked out of it.

Every mechanism belongs to one of six layers:

| # | Layer | Concrete mechanisms |
|---|---|---|
| 1 | **Grounding / context** | AGENTS.md + `.claude/rules/*.md`, the pinned corpus (`tools/mcp/corpus/index.json`), `specs/_template.md` |
| 2 | **Generation** | plan-mode design first; data structures before code (the quality bar in AGENTS.md) |
| 3 | **In-loop verification** | mid-turn MCP tools (`corpus_search`, `rls_verify`), `posttool-fast-check.mjs` per-edit feedback |
| 4 | **Provenance capture** | `// SOURCE:` + `[corpus: <id>]` comments, `posttool-source-check.mjs`, `tools/check-sources.mjs`, one ADR per slice (`/adr`) |
| 5 | **Adversarial review** | read-only reviewer subagents (`security-reviewer`, `web-security-reviewer`, `mobile-security-reviewer`, `torvalds-reviewer`, `accessibility-reviewer`, `design-reviewer`, `citation-verifier` via `/verify-citations`) |
| 6 | **Gated completion** | the Stop hook (`stop-validate-gate.mjs`) running the full validate chain with exit-2 semantics; CI as the floor |

Layers 1–2 raise the probability of correct output; layers 3–6 make incorrect output
unable to ship. Doctrine: never rely on a layer-1 instruction for anything a layer-3/6
gate could enforce deterministically.

## One gate config, three enforcement layers

`tools/harness.config.mjs` is the single source of truth for what "done" means:
`VALIDATE_STEPS` (the 34-step chain `pnpm validate` runs) and `STOP_HOOK_STEPS` (what the
Stop hook runs — validate plus the runtime suites). Three enforcement layers consume it
and can therefore never disagree:

1. **`pnpm validate`** → `node tools/validate.mjs` — the developer/agent fast path.
2. **The Stop hook** → runs `STOP_HOOK_STEPS` **directly** (`node tools/validate.mjs
   --report-all` — every red at once — then the RLS, vitest, and jest-expo suites and
   the diff-coverage/duplication/i18n/test-quality/mobile-perf steps) — never through a
   package.json script name, because script indirection would let an agent redefine
   `validate` to `true` in package.json (an auto-accepted, unguarded edit) and pass a
   hollow gate. **The Stop gate defines done** locally.
3. **CI** → re-runs `node tools/validate.mjs --min-floor`, which reads the FROZEN
   snapshot `tools/validate.floor.json` — a verbatim copy of all 34 canonical steps that
   the runner trusts OVER the local config, and **FAILS CLOSED** (missing/corrupt
   snapshot → exit 1) rather than degrade to a possibly-weakened config. **The CI floor**
   means editing the config can ADD steps but can never weaken the non-negotiable ones
   on a PR.

The gate config is harness-protected and mirrored in CI: `harness.config.mjs`,
`validate.mjs`, `validate.floor.json`, every gate script, and the runners the Stop hook
invokes are all write-guard-protected (see tamper evidence).

## The hook map (deterministic enforcement)

Exit-code semantics (the crux of the design):

- **exit 0** — proceed. Stdout may carry a structured JSON decision
  (`hookSpecificOutput.permissionDecision: "deny"` on PreToolUse blocks the call with a
  machine-readable reason).
- **exit 2** — block, and **stderr is fed back to the model** as the correction signal.
  On `PreToolUse` this blocks the tool call; on `Stop` it forces the turn to continue.
- **any other non-zero** — non-blocking error; the action proceeds. Security hooks must
  therefore always use exit 2 (or the structured deny), never exit 1.
- `PostToolUse` cannot un-run a tool; its exit 2 surfaces stderr so the model fixes what
  just landed.

| Event | Matcher | Script | Enforces |
|---|---|---|---|
| PreToolUse | `Bash\|Monitor\|PowerShell` | `.claude/hooks/pretool-bash-guard.mjs` | denies destructive shell, secret access, migration bypasses — on **all three** command-executing tools (0.6.0) |
| PreToolUse | `Edit\|Write\|MultiEdit\|NotebookEdit` | `.claude/hooks/pretool-write-guard.mjs` | blocks invariant-violating file **content** before it lands; denies edits to harness-owned paths |
| PreToolUse | `mcp__.*` | `.claude/hooks/pretool-mcp-guard.mjs` | default-deny over `tools/approved-tools.json`: unregistered servers, tools outside a server's list, and write-shaped tool names on a `readOnly` server |
| PostToolUse | `Edit\|Write\|MultiEdit` | `.claude/hooks/posttool-fast-check.mjs` | fast per-file feedback (Biome), non-blocking |
| PostToolUse | `Edit\|Write\|MultiEdit` | `.claude/hooks/posttool-source-check.mjs` | flags decision sites lacking `// SOURCE:` (exit 2) |
| Stop | — | `.claude/hooks/stop-validate-gate.mjs` | runs the UNION of `STOP_HOOK_STEPS` and the frozen `tools/stop.floor.json`; exits 2 with failures on stderr until green |
| SubagentStop | `*` | `.claude/hooks/subagent-verdict.mjs` | reads each reviewer's terminal `VERDICT:` line from the payload's `last_assistant_message`, blocks a reviewer that gave none, and records the rest for Stop step `reviewer-verdicts` |

Seven hooks, and **every command is `node "$CLAUDE_PROJECT_DIR/…"`** (0.3.0). Before that
the commands were bare paths relying on the executable bit, and `check-gate-integrity`
hashes CONTENT and never MODE — so `chmod -x` on the Stop hook silently disarmed the turn
gate while every sha256 still matched. The fix deletes the vulnerability rather than
detecting it: the bit is no longer in the trust path at all. (A mode check would also have
had to skip on win32, where there is no exec bit — and a skip that is never a pass cannot
be written for a property half the platforms do not have.) `gate-integrity` now asserts the
command SHAPE instead: every hook command names `node` and an existing file, so one
rewritten to `true` reds.

**Hooks fail closed** (`.claude/hooks/lib/hookio.mjs`):
`uncaughtException`/`unhandledRejection` handlers exit 2, because a crashed guard that
exits 1 would be treated as a *non-blocking* hook error and wave the action through.
Malformed, non-empty stdin throws → blocked. A broken harness blocks; it never silently
passes.

### stop-validate-gate (the unbreakable core)

A turn **cannot end** while the gate is red. Details that matter: it imports
`STOP_HOOK_STEPS` from the config UNIONED with the frozen `tools/stop.floor.json`, so
projects may APPEND a step and may never subtract one (the config is manifest mode
`config`, which gate-integrity's owned-file loop skips — so until 0.3.0 nothing hashed the
list of checks that decide whether a turn may end). A floored step missing from the config
still runs, and gate-integrity reds naming it;
if the config cannot load it falls back to `pnpm validate` and warns — never skips.
`stop_hook_active` escalates the message on repeat blocks — a payload field the docs do not
list for `Stop` and every test supplies synthetically, so 0.6.0 **observed it** against a real
invocation rather than trusting either (`design/CONTROL-PLANE-FACTS.md`).
Failure output is truncated tail-first so the model sees the actual errors.

**The block cap leaves a mark (0.6.0).** `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` in
`.claude/settings.json` is the safety valve so a genuinely stuck session terminates: after 8
CONSECUTIVE blocks Claude Code ends the turn anyway. The valve is right and it stays — a hook
that can block forever is a bricked machine. But it is also the ONE documented way the
headline claim ("a turn cannot end on a red build") is false, and through 0.5.0 a turn that
ran out of blocks left exactly the trace a green turn leaves: none. So every outcome now
appends to `.harness/turn-outcomes.jsonl`; the last block a turn is allowed says
`LAST CHANCE` while the transcript can still act on it; and the **next** turn reports a
predecessor that ended at the cap **even when the tree is green again by then** — which is
precisely when the fact would otherwise be lost. `subagent-verdict.mjs` writes to the same
ledger, because the cap is documented over both events in one sentence and a count that saw
half of them would go quiet on the turns that needed the warning. The file is a diagnostic,
not a control: it authorizes nothing, so a corrupt line is tolerated rather than fatal — the
deliberate opposite of the reviewer ledger, which fails closed because it does authorize.

### pretool-bash-guard

Deterministic regex denial of the commands permission pattern-matching handles
unreliably. A high-value tripwire, NOT a sandbox — obfuscated commands can evade
substring checks; the settings.json deny list and CI are the primary controls. Denies:
`rm -rf`, force-push, hard reset, `--no-verify` commits, fork bombs, reading `.env*` /
`.dev-auth/`, `knip --fix`, bulk `pnpm update` (Renovate-owned), destructive
raw SQL via psql, and any shell contact with store/signing credentials (`EXPO_TOKEN`,
keystore/keychain material, store API keys — those live in CI secrets only).

**It matches three tools, not one (0.6.0).** Through 0.5.0 the matcher was the single word
`Bash`, and both omissions were live bypasses rather than theoretical ones. `Monitor` runs a
command in the background; permission rules spelled `Bash(...)` *do* cover it, which is
exactly what made the gap invisible — but a hook matcher is an **exact tool name**, not a
permission namespace, so the identical command asked for under `Monitor` met no content check
at all. `PowerShell` is the sharper of the two: on **Windows without Git Bash, Claude Code does
not register the Bash tool at all**, so a `Bash`-only matcher never fired for those sessions —
the guard was not weaker there, it was absent. PowerShell also carries its own
`PowerShell(...)` permission namespace, so the settings deny list does not reach it either;
this hook is the only layer that does. The rule table gained the canonical cmdlet spellings to
match (`Remove-Item`, `Get-Content`, `Set-Content`, `Copy-Item`…) — PowerShell's
bash-compatible aliases were already covered, and `rm -Recurse -Force` turned out to have been
covered from the day the flag-class regex was written. `check-wiring` holds the matcher to
naming all three; a project may add a tool, never drop one.

### pretool-write-guard

The only reliable place to stop forbidden code being **written**. Three duties:
(1) tamper protection — denies edits to the PROTECTED list without
`HARNESS_ALLOW_SELF_EDIT=1`; (2) append-only migrations — editing an existing
`supabase/migrations/*.sql` is denied outright; (3) content checks on the written
text: security-surface weakenings in `app.config.ts`/`eas.json` (cleartext/ATS
exceptions, identity or runtimeVersion drift, secret-shaped `extra` keys),
EXPO_PUBLIC_-prefixed secret-shaped names, session-scoped GUCs, `WITH RECURSIVE`
without CYCLE/visited, mobile imports of server/db modules, keychain access outside the
host/auth seam, and the two web-process credential mistakes (the service-role key, and
`getSession()` in server-side web code). It deliberately does NOT
blanket-protect the app config — adding a plugin or permission is routine vertical-slice
work; only the specific weakenings are content-checked, and the reviewed data files
(`tools/expo-permissions.json`, `tools/expo-plugins.json`) are where grants get their
human eyes.

## Tamper evidence (honest limits)

The harness protects its own machinery, but be precise about the claim: it is
**tamper-EVIDENT, not tamper-proof**. An agent (or developer) with shell access can
ultimately modify anything in the working tree. The design goal is that tampering
(a) requires a deliberate, visible override, (b) leaves a diff a human reviews, and
(c) is caught by CI even if the local session was fully compromised.

The layers, in order of engagement:

1. **Permission denies** in `.claude/settings.json` — network exfiltration, `.env` and
   `.dev-auth/` reads, ssh keys, force-push, hard reset, and direct writes to
   `.claude/hooks/**`, settings, `.mcp.json`, `.harness/**`.
2. **Write-guard PROTECTED paths** — the gate config, `validate.mjs` + the floor
   snapshot, every `tools/check-*.mjs`, `tools/lib/`, the lockfiles gates verify against
   (`identity.lock.json`, `prompts.lock.json`, `rls-exempt.json`, the budget/manifest
   data files), the Stop-hook runners, `lefthook.yml`, `.github/workflows/`, and the
   lint/architecture config surface. A human who genuinely needs to change the harness
   sets `HARNESS_ALLOW_SELF_EDIT=1` for that session — an explicit, auditable act.
3. **The `.harness` manifest** — the installer records a SHA-256 for every
   harness-owned file; `npx next-expo-supabase-agent-harness doctor` re-hashes the tree so
   silent in-place edits are evident as drift, and the `gate-integrity` gate re-checks
   the enforcement files on every validate.
4. **The CI floor** — CI does not trust the config: `--min-floor` enforces the frozen
   snapshot, fail-closed. Local bypasses change nothing about what merges.
5. **CODEOWNERS** — harness-owned paths and auth/data surfaces require sign-off from
   {{SECURITY_OWNERS}}, so even an evident tamper needs a human accomplice to land.

## Skip-local / fail-closed-CI asymmetry

Doctrine (implemented in `tools/lib/gate.mjs#skipOrFail`): a gate that cannot run its
real check — no install, no reachable database, the Expo toolchain unresolvable, the
surface not yet created — **SKIPS LOUDLY** locally
(`SKIPPED — <reason> (this gate FAILS CLOSED in CI)`) and **FAILS CLOSED** in CI
(`CI=true` or `HARNESS_REQUIRE_TOOLCHAINS=1`). A skip must never be mistakable for a
pass, and CI must never be green because a prerequisite was absent. Shape-awareness
lives INSIDE each gate script, never in which steps run.

## The security invariants

Enforced as hooks + lint + depcruise + gates (defense-in-depth); the grounding rules
restate them so the model rarely trips a gate: `security-invariants.md` (always
loaded), `provenance.md` (always loaded), `mobile-server-split.md` (path-scoped;
never rely on conditional loading for invariants).

Doctrine notes for the citations:

- **mobile-server split** — the mobile app is an untrusted client: it holds a scoped
  bearer token and can send any request it likes; the OS keychain, the app scheme, and
  store review are containment, never authorization. THE authorization boundary is
  **RLS at the database**, not a code wrapper: every exposed table is `ENABLE` +
  `FORCE ROW LEVEL SECURITY` with `owner_id = (select auth.uid())` policies, and
  `auth.uid()` reads the request's `request.jwt.claims`. The DAL
  (`packages/verticals/<name>/src/data/*.ts`) reaches Postgres only through a
  request-scoped supabase-js client built from the caller's JWT — PostgREST, never a raw
  SQL wrapper — and re-parses every row against the vertical's zod contract at its EXIT
  (rows enter as `unknown`; the compiler is never trusted for row shapes). Normal
  requests run as `authenticated` (the RLS-subject role); `service_role` BYPASSES RLS and
  is Edge-Function-only, ADR-governed.
- **the api-client one-door** — every request goes through
  `apps/mobile/src/lib/api-client.ts` (origin, bearer, envelope decode, the single
  401-refresh-retry). In the source harness, features once called the network directly
  with no auth header and every mocked lane stayed green; the one-door plus the
  live-api proof is the answer. The token lives behind `src/host/**`
  (expo-secure-store — iOS Keychain / Android Keystore), never in JS-visible app
  storage and never behind an `EXPO_PUBLIC_` name (inlined into the shipped bundle).
- **GUC discipline** — production identity rides the request-scoped supabase-js client's
  JWT (`auth.uid()` reads `request.jwt.claims`), never an app-side GUC. Tests and the
  mid-turn probe impersonate with `SET LOCAL ROLE authenticated` plus a transaction-local
  `request.jwt.claims`, and that GUC MUST be transaction-local by construction
  (`set_config('request.jwt.claims', …, true)` / `SET LOCAL`): a session-scoped GUC
  survives the transaction and LEAKS the previous user's identity to whoever gets the
  pooled connection next. [corpus: postgres/guc-set-local]
- **append-only migrations** — editing an already-committed migration desynchronizes
  every database that ran the original. New state = a new timestamped migration; never
  edit or delete an applied one.
- **migration discipline** — migrations carry structure, not data (DML needs
  `-- harness-allow-dml: <reason>`); destructive DDL must reference an ADR. Two-phase
  changes follow `docs/runbooks/expand-contract.md` — and the mobile fleet skews HARDER
  than a desktop fleet: store review lags, rollouts are staged, some installs never
  update.
- **CNG purity** — `android/` and `ios/` are `expo prebuild` OUTPUT. A committed or
  hand-edited native dir is configuration that CNG will silently regenerate away;
  native intent lives in `app.config.ts` + reviewed config plugins
  (`tools/expo-plugins.json`), where gates can diff it.
- **graph queries** — `WITH RECURSIVE` over graph-shaped data loops forever on cycles
  unless terminated: use the `CYCLE` clause (Postgres 14+) or a visited guard.
  [corpus: postgres/recursive-cycle]

## RLS testing doctrine

The `schema-rls` gate proves policies **exist**; the runtime suite proves they
**isolate**. `node tests/rls/run-rls.mjs` (the `rls-isolation` Stop-hook step /
`pnpm test:rls`) orchestrates: resolve `SUPABASE_DB_URL` (env wins; the local
`supabase start` default otherwise), probe Postgres (unreachable → loud SKIP locally; in
CI with migrations present, unreachable = FAIL), fresh-apply all migrations, then run the
suite. Per
`ISOLATION_TARGETS` entry:

- **Seeded positive control** — user A sees its OWN row first. Without this, a deny-all
  database would pass every negative assertion vacuously. The same doctrine applies to
  the mid-turn `rls_verify` MCP probe.
- Cross-user SELECT returns **zero rows, no error**; cross-user UPDATE/DELETE match
  **0 rows**; INSERT smuggling the other user's id fails with **SQLSTATE 42501**; the
  victim's data is untouched afterwards.
- **GUC-leak detector** — pool `max: 1` ON PURPOSE: after an impersonated transaction,
  the SAME physical connection must have no identity. Connection rotation would hide
  exactly the session-GUC bug class this exists to catch.
- **Catalog gate** — facts from `pg_catalog`, not vibes: FORCE RLS flags, per-operation
  policies, leading-column owner indexes, patched pgvector, non-BYPASSRLS role.
- **Index shape, asserted statically** — the tenant index must carry the ORDERING, not just
  the filter: `(org_id, <ORDER BY columns, direction>)`, so one index serves the policy,
  the sort and the cursor range. The pgTAP structural suite and the `schema-rls` gate read
  that from `pg_catalog`, and the `query-shapes` gate closes it against the statements the
  DALs actually issue. There is deliberately **no EXPLAIN plan probe in THIS suite** — a
  plan is a planner opinion at one statistics snapshot, and against the handful of rows
  `seed.sql` writes it is not merely noisy but wrong: the planner correctly reads one page
  rather than using an index, so an assertion here would flap or pass for the wrong reason.
  The probe lives where the cardinality does — `tools/check-db-perf.mjs` in the
  path-filtered `db-scale` CI lane, over `supabase/seeds/scale.sql`. It asserts plan SHAPE
  (which index the planner chose, no Sort above a keyset leaf, no per-row SubPlan) and
  never milliseconds, and it refuses to certify a table below the reviewed row floor.

Tests impersonate the Supabase way — `SET LOCAL ROLE authenticated` plus a
transaction-local `request.jwt.claims` whose `sub` is the user id (exactly what
`auth.uid()` reads) — so the suite exercises the same RLS path a request-scoped client
takes in production. The mid-turn probe (`tools/mcp/rls-verify-server.mjs`, the
`rls_verify` MCP tool) is read-only, transaction-local, always rolled back, positive
control first — anything preventing a real probe is a SKIP, never a green.

## The provenance pipeline

The chain runs **corpus → code → check → ADR → verification → gate**:

1. **Pinned corpus** — `tools/mcp/corpus/index.json` holds version-pinned entries for
   every external authority the code relies on; `corpus_search` serves it mid-turn —
   no network, honest `NO_MATCH` over fabricated results.
2. **In-code convention** — every non-trivial decision carries `// SOURCE:` with
   `[corpus: <id>]` when pinned.
3. **Enforcement** — `posttool-source-check.mjs` per edit; `tools/check-sources.mjs`
   tree-wide in validate/CI (identical heuristic, so the two can never disagree).
4. **`/adr`** — one ADR per slice into `docs/adr/`, its Sources section reconciled
   against every inline `// SOURCE:` in the slice.
5. **`/verify-citations`** — the read-only `citation-verifier` subagent resolves each
   citation for existence AND support. A turn does not end with rejected citations.

## The validate contract

- **Done means green gate.** A turn is not finished until `pnpm validate` and the
  Stop-hook runtime suites pass. Do not summarize a red build as "mostly working".
- **Prove, don't claim.** The gate output is the evidence.
- **No same-turn test edits.** Deliberately a review-time rule (AGENTS.md contract +
  reviewer subagents + PR review), not a hook: a legitimate feature adds code and tests
  together, and a deterministic ban cannot tell the two apart.

### Spec-first SOP

For any change touching auth, RLS, migrations, the native config surface
(`app.config.ts` / `eas.json` / config plugins / permissions), or the API contract:
write `specs/<feature>.md` (from `specs/_template.md`), get human sign-off, **then**
implement. The spec is necessary but not sufficient; the gate holds the line either way.

## Adversarial review (the agent roster)

Reviewer subagents are **read-only by construction** — file reads/searches only, so a
prompt-injected reviewer cannot become a writer. `citation-verifier` additionally holds
`WebFetch` (allow-listed documentation domains) + `corpus_search`, and the security
reviewers the read-only `rls_verify` probe — never a write or shell tool. The claim is
machine-asserted: the `docs-sync` gate parses every `.claude/agents/*.md` frontmatter
(pinned grammar in `tools/lib/agent-roster.mjs`; unparseable frontmatter fails closed)
and reds a reviewer holding anything outside the read-only allowlist or missing
`disallowedTools: Write, Edit`.

- `security-reviewer` — MUST run on any change to RLS SQL, migrations, the
  server-only data layer (tRPC procedures / Server Actions / a vertical's
  `./client`), or `service_role` usage.
- `web-security-reviewer` — MUST run on any change to Server Actions, the web
  Supabase seam (`apps/web/lib/supabase/**`), `proxy.ts`, the tRPC route handler
  (`app/api/trpc/[trpc]/route.ts`), or `NEXT_PUBLIC_` env.
- `mobile-security-reviewer` — MUST run on any change to the Supabase session
  storage (`LargeSecureStore`), `app.config.ts`/`eas.json`, permissions, or
  config plugins.
- `torvalds-reviewer` — the quality red-team (data structures first, kill special
  cases, delete code) before a slice is declared done.
- `accessibility-reviewer` — RN accessibility review (roles/labels/hints, touch
  targets, screen-reader sanity) on UI-heavy slices.
- `design-reviewer` — design-quality review (typography roles, spacing rhythm,
  accent discipline, motion tokens, state choreography — the
  `designing-mobile-ui` doctrine) on UI-touching slices; taste and
  choreography, where the gates cannot judge.
- `citation-verifier` — the provenance verifier, via `/verify-citations`.

Author agents (`dal-author`, `migration-rls-author`, `test-author`) keep their write
tools; only the universal frontmatter fields apply to them.

## Stop-hook cost (and how to trim it)

`STOP_HOOK_STEPS` ends with the runtime suites; the expensive validate steps are
`build` (the export + bundle grep; stamped) and `e2e` (the jest-expo suite). To trade
turn-end latency for CI-time discovery, a HUMAN can comment steps out of
`tools/harness.config.mjs` (harness-protected — `HARNESS_ALLOW_SELF_EDIT=1`); CI still
enforces the frozen floor via `--min-floor`, so nothing is lost on the PR, only
discovered later. Keep `e2e` in while doing screen-heavy work; the feedback loop is
worth the seconds.

## The lethal-trifecta posture

An agent is dangerous when it combines (1) access to private data, (2) exposure to
untrusted content, and (3) the ability to communicate externally. Break at least one
leg for any agent that touches real data (see
`docs/security/sandbox-and-supply-chain.md`):

- **No standing exfiltration** — Bash network commands denied; `WebFetch` allow-listed
  to a small set of documentation domains.
- **No privileged-role exposure** — the `service_role` key (RLS-bypassing) lives only
  in ADR-governed Edge Functions and is kept out of the client bundle (build-check) and
  the mobile graph (depcruise); store/signing credentials exist only in CI secrets. RLS is the
  backstop.
- **Read-only reviewers** — the subagents most exposed to untrusted content cannot
  write or execute.
- **Default-deny tooling** — no MCP server or Skill runs unless registered in
  `docs/security/approved-tools.md`, version-pinned and reviewed.

## Statusline

`.claude/statusline.mjs` renders `model | branch±dirty | gate: pnpm validate` — a
standing reminder of the gate command (a live validate per render would be too slow).

## Threat model / honest limits

What this harness claims, precisely:

- **Tamper-evident, not tamper-proof.** Shell access can modify anything; the design
  makes tampering visible and non-load-bearing (CI floor + CODEOWNERS decide what
  merges).
- **Guards are tripwires, not sandboxes.** Regex guards catch the common dangerous
  forms; obfuscation can evade them. The permission deny list, the read-only reviewer
  construction, and CI are the layers that do not depend on pattern-matching.
- **RLS is the data boundary; everything client-side is UX.** A compromised app binary
  can send any request it likes — it still authenticates as one user and FORCE RLS
  bounds the blast radius to that user's rows.
- **The Stop chain contains no on-device proof, and the a11y floor is lint + component
  tests, not a browser sweep.** Both stated in full in the gates catalog's
  "Honest losses" — read it before trusting a green chain to mean "works on a phone".
- **Skips are visible by design.** Any gate that could not run says so loudly and fails
  closed in CI; treat a `SKIPPED` line in local output as work remaining, not as green.
