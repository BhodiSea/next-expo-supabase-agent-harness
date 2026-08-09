# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Lineage note.** This harness was forked from
[`expo-postgres-agent-harness`](https://github.com/BhodiSea/expo-postgres-agent-harness)
and the version line continues from it. Entries at **0.1.2 and below are the
ancestor's** — they describe an Expo-only app over a self-hosted Hono/Drizzle
server and are kept for provenance, not because this repository shipped them.
This lineage's own history starts at 0.1.3.

## [Unreleased]

## [0.7.0] — 2026-08-08

**The graduation release.** Every deadline the harness ever wrote falls due at once, and the
question this release answers is the one the ramp mechanism has owed since 0.3.0: **when the
door is supposed to open, does it?** Seven ramps expire the moment this version is installed —
`auth-posture`, `data-flow`, `docs-sync`, `reviewer-verdicts`, `route-manifest`'s web half,
`schema-rls`'s POLICY→GRANT closure, and `web-e2e` — the whole 0.6.0 fleet, and for the first
time in the lineage the affected population includes the release's own recent predecessors.

### The expiry, as data

`template/migrations.json`'s `0.7.0.rampExpiry` states the population — baseVersion **0.1.3,
0.2.0, 0.2.1, 0.3.0, 0.4.0 and 0.5.0**, six vintages, computed by `check-ramp-ledger` from the
shipped call sites and byte-compared against the record — with the why: seven escapes close at
once, every one opened at minVersion 0.6.0, so every install predating 0.6.0 meets all seven.
The sweep is `docs/runbooks/harness-upgrade.md` "## 0.7.0 — THE THIRD ALARM, AND THE WIDEST",
per-baseVersion, each remedy pointing into the section that shipped it; the honest count is
`pnpm validate 2>&1 | grep "RAMP EXPIRED"` (with the stated caveat that `reviewer-verdicts` and
`web-e2e` red outside that output — the Stop chain and the path-filtered browser lane). Two
tests pin the lineage's widest claim as intent, not accident:
`classifyForInstall('0.4.0'|'0.5.0','0.7.0').expired.length === 7`.

### Leg E's third catch — and the two defects it found this time

The lane that executes the runbook (init at v0.3.0 → update → the documented sweep → `graduate`
must SUCCEED) went red twice before this release was allowed to exist, and both were real:

- **The adoption was one file where it needed four.** Shipping the DSR export flips
  `data-flow.json` to `{kind: "procedure"}`, but the ADOPTION touches the consumer's router
  (the mount), their `PARITY.md` (the surface row), and their regenerated action inventory —
  all seeded. The `seededSourceFixes` entry now names all four, keyed by ONE probe on the
  review file (`"target": "0.7.0"` still present = neither adopted nor re-reviewed), so it
  self-clears on either legitimate move and a consumer who re-reviews carries no parked
  warning for a surface they chose not to ship.
- **Ownership could never move toward the consumer.** `tools/generated/action-inventory.json`
  is generated from the CONSUMER's tRPC router, and it was `owned` — so the moment the
  template's router gained a procedure, `update` planted a description of OUR router into
  every upgraded repo and `contracts` redded on trees nobody had touched, whichever legitimate
  move they intended. It is seeded now (query-shapes.json's exact rationale, one artifact
  over), and `update` learned the directional rule that makes such a reclassification
  DELIVERABLE: a path the install recorded as `owned` that this release classifies seeded
  stops being written immediately and has its manifest mode re-recorded — that direction only
  ever takes the harness's hands OFF a file; the reverse (seeded → owned, which would START
  clobbering) never applies from classification alone.

### The three dated targets, discharged

- **The iOS build-toolchain floor exists** (CONFORMANCE-FACTS §3, `Target 0.7.0`, discharged
  2026-08-08). `tools/store-policy.json#iosToolchain` records the reviewed floor (Xcode ≥ 26,
  in force since 2026-04-28); `version-sync` resolves the production profile's `ios.image`
  through the `extends` chain and reds absent/`auto`/`latest`/`sdk-NN` as UNVERIFIABLE, never
  green; the template pins `macos-tahoe-26.5-xcode-26.6` — the concrete name behind the
  `sdk-57` alias, concrete precisely so the alias's future movement cannot move a consumer's
  toolchain silently. Ramped 0.7.0 → 0.8.0, with the eas.json pin as a probed seeded fix. And
  the Target column can now SEE a discharge that is not a surface change: the tier row's cell
  reads `0.7.0 — closes: `tools/store-policy.json#iosToolchain``, the second discharge form —
  judged by the reviewed key existing AND the gate reading it — because the surface-only form
  would have demanded a change no change could satisfy.
- **The DSR export ships; the date is kept, not moved.** `system.exportMyData` on the tRPC
  system router runs AS THE CALLER under RLS: profile own-row, memberships own-rows bounded,
  notes keyset-paginated and filtered authored-only IN THE QUERY — RLS admits org-mates'
  notes to this caller, and exporting an org into one member's archive is the over-export the
  file's own `excluded[]` rationale forbids. And the deadline that demanded it is REAL now:
  `check-data-flow` compares `export.surface.target` against the installed harness version
  (it only format-checked the date before — the file's claim that the gate "reds" on an
  arrived target was false), ramped 0.7.0 → 0.8.0 so the seeded copies saying `target: 0.7.0`
  NOTE rather than ambush.
- **The auth-posture CLI census is re-deferred ON THE RECORD.** `tools/deferrals.json` opens
  with `auth-posture-cli-census` (target 0.8.0, the 0.6.0 spike's side-effect findings as the
  reason), and `docs-sync` now scans the owned prose surfaces for dated deferral sentences,
  closed both ways against the ledger, arrived = red — a deferral a control reads cannot roll
  silently again. The four-releases-stale "out of scope for 0.2.0" sentence is restated
  dateless as the permanent condition it always was.

### The enforcement of the enforcement

- **The Stop chain runs as a chain outside a live turn for the first time.** The floor-union
  moved to `tools/lib/stop-chain.mjs` (one implementation; the hook imports it), `validate`
  gained `--stop-chain` (fail-closed on a corrupt floor — the deliberate contrast with the
  hook's fail-open-loudly posture), and selftest pipes a synthetic Stop payload into the REAL
  hook on the live-DB scaffold. The canary job's sixteen hand-typed baseline lines — the shape
  that let `duplication` redden on a fresh 0.6.0 scaffold — are replaced by a runner that
  DERIVES the list from the union minus `scripts/ci/stop-chain-exclusions.json`: reviewed,
  printed, staleness-checked exclusions whose `provenBy` must still appear in the workflow.
- **The canary registry closes over the factory itself.** `factoryGates` (23 members) and
  `factoryLanes` (18 jobs) are bidirectional closures; five factory gates that had ZERO test
  references have executable red-proofs, and `check-dependency-channel`'s private
  `previousTag()` — the last surviving `.at(-1)` copy of the bug the v0.6.0 hotfix
  consolidated — is repointed at `highestReleaseBelow`. Its own green summary was the watched
  red: `CLEAN (vs v0.6.0)` on a tree whose package.json IS 0.6.0. The "hygiene had none"
  class is closed permanently.
- **The factory Stop hook grows 13 → 20 steps**, including a scoped CI-shaped test step over
  the red-proof corpus itself — measured, not assumed: dropping the hooks half saves zero
  wall time on the reference machine, and the decision procedure is recorded in the header.
- **A verdict binds to the tree it judged.** The SubagentStop ledger entry gains
  `path_state` — a digest of the owed files at PASS time — and `reviewer-verdicts` reds a
  PASS that predates the last edit to a path that summoned it: "a reviewer ran" and "a
  reviewer reviewed THIS" are different claims. Fresh ramp 0.7.0 → 0.8.0 on only the new
  finding class.
- **The cap-ended turn blocks once.** v-stamped block records in the turn-outcomes ledger
  convert the next green Stop into a one-time exit 2 naming what the previous turn abandoned
  red; the ledger's own append is the acknowledgment. 0.6.0-written marks stay NOTEs — no
  install is ambushed by its own history.
- **Stop steps have budgets.** `chain-budget.json` gains `stopSteps` (nine rows + a stop
  wall); `check-chain-budget --stop-chain` judges the union and a future injected Stop step
  forces a budget row exactly like a validate step. Ceilings are chosen policy; every
  `measuredMs` ships null — the dispatch-only recording now stamps BOTH measurements into one
  artifact, and publishing a figure still requires the measure-commit-publish order.
- **Tag-time parity, both halves.** `lint.yml` runs on `v*` tags (the v0.6.0 failure class
  was a control answering differently at the tag ref) AND `release.yml` blocks on green
  selftest + lint for the SHA via `scripts/ci/wait-for-workflows.mjs` — zero runs for a
  required workflow is a hard fail after timeout, never absence-read-as-green. `hygiene.yml`
  stays tag-triggered but unawaited: a network scan's flake must not stick a tag.
- **The upgrade lane cannot eat a Stop-side expiry.** `narrow()` still filters the executed
  set to the validate chain, but §7e now requires every dropped expiry to carry a registered
  compensating proof in `scripts/ci/stop-side-expiries.json` — `reviewer-verdicts`,
  `diff-coverage` and `web-e2e` each point at a unit proof that drives the REAL gate to its
  RAMP EXPIRED exit (none existed). And the matrix gains **leg F (v0.5.0)**: the first
  release that reds its own recent predecessors watches that population in a lane, not in a
  classifier test.
- **`update` names what it cannot write.** `seededSourceFixes` entries carry probes
  describing the harness-authored BROKEN shape; `update` parks
  `.harness/pending/source-fixes.json`, `doctor` WARNS (exit 2 — never error; the lane's
  doctor step permits only 0/2), and the artifact self-clears when the tree no longer
  matches. The 0.6.0 sign-in-loop fix set carries probes retroactively.
- **The multi-version sweep.** `upgrade-sweep.mjs` iterates every version an upgrade crossed
  with a reviewed per-version SWEEPS table, fail-closed on any crossed version whose sweep
  posture nobody wrote down — at head 0.7.0 the old head-only sweep would have adopted
  nothing and leg E would have died on the release whose expiries most need its proof.
  Backward pin: the (0.3.0 → 0.6.0) sweep set is byte-identical to the single-version
  behavior, proven twice.

### Also

- `check-claims` closes over CONTRIBUTING.md — the one document where a stale derived number
  survived ("all **31** steps", "the **six** stamps", the omitted `check-seeded-migrations`
  were all live and all watched red). The local-list closure is DERIVED from `lint.yml`'s
  blocking steps.
- `gates-catalog.md` documents `reviewer-verdicts` (the newest control was the only chain
  member with no documented failure mode), and `check-docs-sync` closes the catalog over
  every `tools/stop.floor.json` step — floor-keyed, so consumer-appended Stop steps stay the
  consumer's business.
- `STAMP_INPUTS["version-sync"]` learns `tools/store-policy.json` and `tools/cc-floor.json` —
  a warm local stamp could ride over a reviewed-floor edit.
- The upgrade-lane SOURCE citation points at a section that exists; the selftest leg
  commentary states computed 0.7.0 truth (leg A meets no expiry for the first time in the
  lineage — and still refuses on the new ramps' NOTEs; graduate SUCCESS stays leg E's alone).

- **Observability containment is deferred to 0.8.0, and the deferral is machine-held.** The
  `packages/platform/observability` seam ships with its invariant as header contract (no vendor
  telemetry SDK import outside declared sinks; every sink behind the redaction pass), and the gate
  asserting it is 0.8.0's — recorded as the `check-observability.mjs` row in
  `docs/harness/enforcement-tiers.md`, whose dated `Target` column `docs-sync` reads, so the
  commitment is a deadline a gate judges rather than a sentence.

## [0.6.0] — 2026-08-07

**The conformance release.** 0.5.0 turned "every claim must be checkable" on the harness's own
claims and found, everywhere it looked, *a control asserting nothing*. This release asks the
next question: **the harness enforces what a tree LOOKS LIKE, and nothing about what the agent
DID to it — and it trusts a control plane it has never audited.**

> **Release in progress.** Sections are added as each wave lands green; the wave order is a
> dependency order (mechanics → discharge → chain steps → process → control plane →
> conformance → derived numbers). Nothing below is claimed before its proof runs.

### Two counts nobody was deriving, and a required-set that was a hand-kept list

`check-wiring`'s `SHIPPED_HOOKS` was an array of six names typed by hand. The process layer
added a seventh hook in this same release and **nothing asserted it was wired** — a list that
must be edited every time the harness grows is a list that is stale exactly when it matters. It
is now a UNION: a floor of names that must be wired whatever the directory says (so `rm` on a
hook cannot delete its own requirement), plus every top-level `.claude/hooks/*.mjs` present (so
a new hook nobody wired reds). Deriving alone would have been worse than the list, not better.

`check-claims` derived the chain length, the canary registry size, the guard-rule ids and the
executed canary legs — and not the hook count, so "Six hooks" survived in the root README twice
and in the shipped doctrine, whose hook table had also quietly lost the new row. Nobody reads
"six hooks" as a derived number until it is wrong. The matcher reads number **words** as well as
digits, because the word form is what shipped.

### The controls that were asserting nothing — again, and this time about themselves

- **`scripts/check-claims.mjs` could not read its own subject.** Every matcher is written
  against a CONTIGUOUS phrase, and markdown soft-wraps prose where the column runs out. The
  README carried `the 26 can-fail\n> canaries (counted from the matrix itself, not
  hand-authored)` against a matrix of **29**, and the gate was CLEAN — the newline and the
  blockquote marker sat between the number and the noun. A stale hand-authored number, live, in
  the one sentence whose subject is that the number is not hand-authored. The matcher now
  normalises soft wraps before matching, and both directions are pinned: a wrapped STALE claim
  reds, a wrapped TRUE claim stays clean (a normaliser that swallowed the phrase would make the
  red case pass for the wrong reason).
- **`VINTAGES` promised a control that did not exist.** `check-ramp-ledger.mjs` carried the list
  of released vintages under the sentence *"The list must grow with every release, which is what
  the test below pins"* — and the test retyped the array by hand. Two literals, compared to
  nothing. A release that forgot its predecessor would be green in both places while the ledger
  reported that whole population as **unaffected**, which is exactly how 0.4.0 went missing until
  a human noticed in 0.5.0. There is one definition now
  (`scripts/lib/ramp-sites.mjs#VINTAGES`), and `checkVintages` corroborates it against the tags
  git actually has — bidirectionally, so a missing vintage AND a vintage this lineage never
  released both red. The first thing it caught was this release's own missing `0.5.0`.
- **The upgrade lane was asserting two of seven injected chain steps.**
  `scripts/ci/upgrade-lane.sh` §4 read `for step in wiring secrets` — the pair 0.3.0 injected —
  under a heading claiming it proves the `configSteps` injection reached the install. The real
  set at 0.5.0 is **seven** (`tenancy`, `db-limits`, `query-shapes`, `rate-limits`,
  `security-headers`, `wiring`, `secrets`). Five injections had no assertion in the section whose
  title says it checks them; they were caught indirectly by `doctor`'s `requiredConfigSteps`
  error at §5, which is doctor's property borrowed, not this section's proof. It derives the
  expectation from the same function `doctor` reads, so it grows with the release instead of
  being remembered — and an empty expectation is a hard die.

### The seeded web app could not sign anybody in, and nine tier rows said a browser proved it

- **The scaffold shipped a sign-in loop.** `apps/web/lib/supabase/client.ts` constructed the
  browser client with no `storage`, so `@supabase/supabase-js` persisted the session to
  `localStorage` — its documented default, confirmed against the installed
  `@supabase/auth-js` and its compiled `dist`, not from memory. Every server reader —
  `proxy.ts`, `lib/supabase/server.ts`, the tRPC route's cookie branch — reads the session out
  of the **cookie jar**. Two disjoint stores: sign-in succeeded, the protected layout's
  `getVerifiedUser()` saw nothing, and it redirected straight back to `/sign-in`. This is the
  exact failure `browser.ts`'s own doc comment warns about, in the sentence that names
  apps/web as the app that avoided it.
- **Five controls could have caught it and each was aimed one step away.** `storage` is
  legitimately *optional* — a pure SPA that never server-renders an identity needs none — so
  the type-checker was correct to be silent. The unit suite tested the cookie **codec** with
  options passed in, never the **wiring** that passes them. `knip` was told to ignore the one
  dependency whose absent import would have shouted. And every spec in the browser lane is
  **anonymous**: `tenancy.spec.ts` says so in its own header, and its only sign-in submits a
  deliberately wrong password. No test in this repository has ever completed a successful
  sign-in — while `enforcement-tiers.md` exempts `apps/web/app` from unit coverage on the
  grounds that Server Components "are proved by a real browser", naming `web-e2e` as the
  compensating control on nine rows. The lane runs on every PR touching `apps/web/**`. It runs
  and it is vacuous, which is a failure mode past "'exists' is not 'ran'".
- **The fix keeps ONE codec on both sides.** apps/web now supplies a `document.cookie`-backed
  jar to the package's own `cookieSessionStorage`, so the browser WRITES with the same
  `cookieWrites` the server READS with `readChunkedCookie`. A session does not fit in one
  cookie, so it is chunked — and chunking is a **format**, which means two implementations are
  two formats and the one that disagrees presents as "randomly signed out". Reaching for a
  second cookie-session library here would have reintroduced that drift at the one seam where
  a mismatch is not an error.
- **Four comments asserted the session cookie was `httpOnly` and nothing set it — and nothing
  could.** This architecture signs in browser-side so the password never crosses an extra hop,
  and a user agent **ignores** `HttpOnly` on a `document.cookie` write. So the claims are not
  repaired, they are **rewritten**: the cookie is script-readable by construction, and what
  protects it is `Secure`, `SameSite=Lax`, the CSRF guard on the ambient-credential path, and
  a short-lived rotating token. `secure` is the half that was both absent and achievable; all
  three writers now pass it, derived from the scheme rather than hard-coded, because a user
  agent DROPS a `Secure` cookie set over plain http and hard-coding it would break local
  development with the same sign-in loop this release just closed.
- **The test that ratified the un-hardened state is gone.** `cookies.test.ts` asserted the
  codec "leaves secure and httpOnly to the host" and passed on every run — a test that pins an
  ABSENCE cannot tell "the host will supply it" from "no host ever does".
- **The closure rides `auth-posture` rather than a new chain step**, because `[auth]` in
  `config.toml` is the posture of the auth *server* and this is the posture of the *wire* —
  the same question over the same kind of reviewed data, at none of the eleven registrations a
  new step costs. Three axes: transport agreement (the *pairing* is the defect, so an SPA with
  no cookie-reading server stays clean), `cookieOptions` at EVERY writer (this client rewrites
  the cookie, so an attribute one writer omits is one it strips off another's value), and the
  prose rule — an attribute declared unavailable may be **named only to disclaim it**.
- Every injection in the red-proof is **the code that actually shipped**, not an invented
  violation: the zero-argument browser client, both bare `createServerSupabaseClient` call
  sites, and `cookie-server.ts`'s real prior sentence *"The host supplies `secure` and
  `httpOnly`"*. On the fixed tree the closure reports **0**; on the tree as it shipped, **4**.
- The general lesson, and why this is a gate and not only a fix: **an optional seam between two
  halves that must agree will eventually be left unwired, and it fails silently on both
  sides.** Mobile is structurally immune — `createNativeClient` takes its storage as a required
  positional. This closes the same hole on the surface where the parameter must stay optional.
- **And the lane that was supposed to catch it now has to.** `enforcement-tiers.md` exempts
  `apps/web/app` from unit coverage on the grounds that those files "are proved by a real
  browser", and names `web-e2e` as the compensating control on **nine** rows. Both claims were
  checked in exactly one way — that the lane exists and runs. It does run, path-filtered, on
  every PR touching `apps/web/**`, green every time. **Every spec in it was anonymous**, and
  the one sign-in it performed submitted a deliberately wrong password to prove the error copy
  is not an account-existence oracle. No test in the repository had ever completed a successful
  sign-in. That is a failure past *"'exists' is not 'ran'"*: **vacuity inside a lane that ran.**
- `tools/check-web-e2e.mjs` gains an **authenticated-render axis** — the suite must contain a
  spec that mints a real identity, signs in **through the form**, and then calls
  `page.reload()`. Two positive markers and one negative, each encoding one half of the defect:
  a real identity, a full reload (because `replace()` + `refresh()` are client-side and React
  still holds the signed-in render — only a fresh document request makes the server re-read the
  cookie), and **not** `context.addCookies`, since a planted session proves the server reads a
  cookie and says nothing about what the browser writes.
- The seeded `authenticated.spec.ts` is that spec: sign in, land on `/o`, **reload**, and it is
  still there; the session cookie is in the jar with `SameSite=Lax`; and sign-out clears it in
  the server render too, which is the same failure inverted.
- Every axis in that runner now reads code with **comments blanked**, and this release needed
  it: the new spec *describes* `context.addCookies()` in the paragraph explaining why it
  refuses to use it, and was disqualified by its own explanation until the reader stopped
  treating prose as code. The same rule retro-fits the axe and security-header axes, where a
  marker named only in a comment had always counted.
- **What is deliberately not claimed:** nothing derives, from a `Compensated by` cell, what the
  named control must assert. That cell still records a human's judgement. What changed is that
  this particular judgement now has a red-proof behind it — and the honest limit is written in
  the runner: a static reader cannot tell that the assertion after the reload is about a
  protected route.
- **The spec was EXECUTED, against a real browser, a real production build and a real Supabase
  stack — and it found two things a reading would not have.** On the fixed tree: 3 passed. On
  the same tree with the browser client reverted to the zero-argument form it shipped with:
  **3 failed, received URL `http://127.0.0.1:3117/sign-in`.** The sign-in loop, watched
  happening.

### The browser lane could not have started, and two of its own tests were the reason

Both found by running it, neither visible from the file.

- **`quality-gate.yml`'s `web-e2e` job pinned `NODE_ENV: development`, and `next build` fails
  outright under it.** It prerenders the error boundaries against React's development
  resolution and dies with `Cannot read properties of null (reading 'useContext')` before a
  single spec runs. Isolated by running it both ways on one tree — **exit 1 with, exit 0
  without.** The variable was a leftover from when Playwright's `webServer` booted `next dev`;
  the config moved to `pnpm run build && pnpm run start` (the CSP suite is why — `next dev`
  injects `eval` and its own overlay, so a CSP suite pointed at it asserts properties of a
  build nobody ships) and nothing reconciled the two. The job is path-filtered and nightly, and
  this repository's own CI is `selftest.yml`, so **the shipped job had never executed
  anywhere.** A lane that cannot start is worse than a missing one: it is on the checks list.
  Now gated in `tests/gates/workflow-lanes.test.mjs`, scoped to jobs that BUILD — the Metro and
  Expo lanes set `NODE_ENV: development` correctly and a blanket ban would red two jobs that
  are right.
- **The new spec's own fixture identity was a race.** `fullyParallel: true` hands the three
  tests to three workers and `beforeAll` runs once PER WORKER, so all three raced to create
  the same account — two lost on `users_email_partial_key` (which GoTrue reports as the
  uninformative *"Database error creating new user"*) and the first worker to finish then ran
  its `afterAll` and deleted the account the other two were signed in as. The address is
  derived from `TEST_WORKER_INDEX` now, which gives the fixture the same scope its lifecycle
  already had. Read from the environment rather than a `(fixtures, workerInfo)` hook signature
  because Playwright rejects a first argument that is not an object destructuring pattern —
  also found by running it.

### Six of seven deadlines came back corrected, and three would have shipped wrong gates

The plan for this release said of its own deadline table: *"re-verify each date against its
primary source before encoding it — a wrong date in a gate is worse than no gate."* Every row
is now in **`design/CONFORMANCE-FACTS.md`** — dated, sourced, and carrying its disposition, so
a *cut* regime and a *forgotten* one stop looking identical six months later.

- **Supabase grants** — date right, everything else wrong. The role set is **three**
  (`service_role` too), sequences are revoked as well, and the failure is `42501` → **HTTP
  403**, not the "silent 404" the plan named. A gate written against a 404 would never have
  fired. **Shipped** as the policy→grant closure above.
- **splinter** — the plan said "Apache-2.0 and vendorable". It has **no licence at all**: the
  README badge renders an unrelated PyPI package's, and the LICENSE link 404s. It ships 28
  lints, not 29, and `splinter.sql` aborts on stock Postgres for want of the `anon` role.
  **Cut** — vendoring unlicensed code is a legal question, not an engineering trade-off.
- **CRA Art. 14** — date exactly right (2026-09-11, Art. 71(2)), but recital 19 puts an
  unmonetised FOSS project **outside CRA scope entirely**, and "three recipients" is wrong:
  Art. 14(7) is one end-point. The obligation is the **consumer's**, so the deliverable is
  enablement — **`SECURITY.md` now ships**. `security.txt` is deliberately deferred: RFC 9116
  makes `Expires` mandatory, and a reviewer-supplied date in a seeded file with nothing
  bounding it is the exact off-switch shape this release just removed from
  `framework-floor.json`.
- **EAA** — date right, conclusion **over-built**: six enumerated service categories, the
  Directive never mentions WCAG or EN 301 549, and no harmonised standard is cited in the OJ,
  so the Art. 15 presumption of conformity does not exist. **Cut whole**, per the plan's own
  rule that a partial map is worse than none. What survives is a measurement worth keeping:
  `eslint-plugin-react-native-a11y` is **14 rules, 4 of which target props React Native no
  longer documents** — they can never fire — covering the syntactic half of one success
  criterion, and it **goes silent on design-system wrapper components**, which is the
  structure `AGENTS.md` *mandates*. The required architecture defeats the rule. Now stated in
  the `lint` tier row instead of waiting to be discovered.
- **Apple** — date right, characterisation wrong: a **fixed floor** (Xcode 26 / iOS 26 SDK or
  later), not a moving "current SDK", and macOS is excluded. `eas.json` pins **no `image` on
  any profile**, so there is nothing to check and nothing that could red. **`Target 0.7.0`** on
  `version-sync`, and not discharged here for a stated reason: it needs a real image name from
  EAS's published list, and seeding a fabricated one would break every consumer's build.
- **Google Play** — levels confirmed verbatim, but there are **two requirement families**, TV
  did not move in 2026, and the form factor is **not derivable** from any config this template
  can produce. **Cut, already satisfied.** A map would be machinery for a case the scaffold
  cannot reach, and keying one on `EXPO_TV=1` would reproduce the lane-environment porosity
  already recorded here.
- **AI Act Art. 50** — negative confirmed, for a **stronger** reason than the plan gave: Art.
  50(2) binds the *provider of the generative system*, so the role split carries it without
  relying on a guidance paragraph that can be revised.

Also recorded because it silently wastes an afternoon: `minimumReleaseAge` is in **minutes**,
and on pnpm 11 it is honoured in `pnpm-workspace.yaml` **only** — a value in `.npmrc` is
ignored with no warning. The pinned `0` and its live-observation rationale stay; the comment
now says where the setting has to live.

### "Measure, commit the measurement, then publish" had no step one

- **`scripts/chain-budget.json` prescribes that order in its own header, and nothing could
  measure.** `check-chain-budget.mjs` read the chain's `VALIDATE_TIMINGS` line, judged it
  against ceilings, and **discarded the numbers**. There was no writer, so `measuredMs` has
  been `null` for every step and for the wall since the file was introduced, and the README
  has carried no wall-clock figure — not by discipline, but because the first step of the
  procedure was unimplemented.
- **`node scripts/check-chain-budget.mjs <log> --record`** is that step now. It stamps a
  `measurement` block beside the numbers: the date, the **runner** they came from, and the
  chain's step count. `--runner` is required rather than inferred, because the file's own
  header says these are one machine's numbers and are not portable — a figure with no
  provenance is worse than `null`, since it licenses a published claim no CI run can
  reproduce. Wired into the selftest lane on **`workflow_dispatch` only**: a recorded
  measurement is reviewed data, and writing it automatically on every green run would make
  it a number nobody chose, which is the state it exists to replace.
- **The ordering is enforced now, not merely prescribed.** `hasCommittedMeasurement` was
  exported, unit-tested, and **imported by no production caller** — so the header's claim that
  "check-claims.mjs refuses any wall-clock figure in README.md" described no code. The
  consistency check compares the README and the CHANGELOG *to each other*, which means two
  documents agreeing on a number neither of them measured was clean: the one shape a
  consistency check structurally cannot see. `check-claims` reds on it now.
- **And the measurement expires when the chain changes shape.** A figure taken against a
  31-step chain, left in place while 0.6.0 added two steps, is not stale — it is wrong, and
  nothing about a committed integer expires on its own. So the recorded step count must match
  the live chain. That comparison is arithmetic over two committed values — clockless,
  offline, same verdict anywhere — the same split this release applied to the framework
  floor's review window.
- The first version of `--record` attributed a measurement to
  `/opt/homebrew/.../bin/node`: `indexOf('--runner')` returns `-1` when the flag is absent,
  and `argv[-1 + 1]` is `argv[0]`. It reported success. Found by running it, which is the
  only way that one was ever going to be found — an unattributed number wearing a provenance
  string is exactly what the flag exists to prevent.

### The gate that guards every release's plant-or-withhold decision was reading a committed tree

- **`check-seeded-migrations.mjs` diffed `prev..HEAD`, which cannot see the release being
  cut.** Through the whole of 0.6.0 it reported **"0 template file(s) added since v0.5.0"**
  while a dozen new template files sat untracked. A `CLEAN` with a count in it reads as a
  finding; this one was a vacuum. It would have corrected itself in CI, on a branch where
  everything is committed — which is exactly what made it dangerous, because the maintainer
  making the plant-vs-withhold call is the one running it locally, and they were told there
  was nothing to decide.
- Staged and untracked additions are unioned in now. The same command reports **34 files added
  since v0.5.0** — and found two genuinely unregistered ones on its first honest run.
- **`DELIBERATE_PLANT`'s reasons were never read.** The list's own header says *"an empty
  reason is a review reject"*, and the code maps entries to `.file` and drops the rest. The
  proof that nobody was reading it is in the list: two entries had drifted to a `why:` key
  that is not the documented name. A reviewed escape whose review nothing checks is an
  unreviewed escape with a longer entry. Both keys normalised, and the shape is now judged —
  `file` present, no duplicates, a `reason` of real length.
- **`SEEDED_FILES` named `SECURITY.md`, and neither template tree could produce it.** The
  installer advertised a coordinated-disclosure document it would never write, in a list a
  reviewer reads as the set of artifacts a project receives. Closed by a test that runs the
  installer's own `storageToInstall` mapper rather than re-deriving the dotless-rename and
  `.tmpl`-stripping conventions — a re-derived rule would agree only until one of them
  changed, and the disagreement would look like a missing file.

### The security floor had an off switch reachable from inside the file it protects

- **`framework-floor.json`'s review window was the reviewer's free text, and nothing bounded
  it.** The floor is a snapshot of what a human knew on `reviewedOn`; `reviewedUntil` is the
  date that claim stops being made for free, and the scheduled `floor-review` job reds once it
  passes. What nothing anywhere asked was *how far ahead `reviewedUntil` may be set in the
  first place*. So one edit writing a distant date retires the whole control — and the only
  check that would object is the one that edit has just disarmed. A control whose off switch
  is a field inside its own reviewed data is not a control; it is a default.
- **The window this repo actually shipped was 92 days.** Next moved to a *scheduled* security
  programme in July 2026 — releases published on a roughly **monthly** cadence, each with
  advance notice — so a 92-day window spans about **three** of them, and across all three the
  file would have kept reporting a live review. The plan for this release said "shorten it";
  the honest fix is structural rather than numeric, because a shorter number written in the
  same place can be lengthened again by the same edit.
- **The window is now the harness's constant, not the reviewer's.** The reviewer supplies
  WHEN THEY LOOKED; `MAX_REVIEW_WINDOW_DAYS` supplies HOW LONG THAT IS WORTH — 31 days, one
  calendar month, so a maintainer re-reading the feed monthly is never red for the length of a
  month. `reviewedUntil` stays in the file because a failure message needs a date a human can
  act on, but it is derived-and-checked now rather than declared-and-trusted.
- **And it rides the CHAIN, not the schedule.** Whether a review has *lapsed* is a calendar
  question and stays on the scheduled job, for the reason `pnpm audit` is not a chain step. But
  `reviewedUntil - reviewedOn` is arithmetic over two **committed** dates — clockless, offline,
  same verdict on any machine on any day — so it belongs in `version-sync`, where it reds at
  the moment the over-long window is written rather than a quarter after. That ordering is the
  point: a control disarmed silently will not be re-armed by a job that no longer fires.
- The red-proof is the file's own history: the injection is the exact `2026-08-06 →
  2026-11-06` pair this repository shipped, and a second proof pins that the distant-date
  off switch is **inert to `staleReviews` on every real calendar date** — which is why nothing
  caught it before.

### A policy is not a permission, and the whole scaffold was one Supabase release from finding out

- **`schema-rls` has parsed `GRANT` statements since 0.2.0 and thrown half the parse away.**
  `parseGrants(allStatements)` is called at line 136 and consumed only for the `SECURITY
  DEFINER` EXECUTE surface; the TABLE half was dead output. So a table shipping `ENABLE` +
  `FORCE` + four per-operation policies + both isolation registries + an owner-column index
  and **no `GRANT` statement anywhere** was fully green — and every fixture in the gate's own
  test file was exactly that shape. Thirteen red-proofs written against a tree that could not
  have granted anything.
- **PostgreSQL checks table privileges FIRST and row security SECOND.** A policy naming a role
  that holds no privilege on the table is not a narrow permission; it is unreachable code that
  reads in review as a granted one. The statement raises `42501` — PostgREST's HTTP 403 —
  before any predicate is evaluated. Writing `CREATE POLICY … TO app_reader` and stopping
  there produces a table that no reviewer can distinguish from a working one.
- **The reason it has been invisible is also the reason it now has a deadline.** Supabase's
  Data API applies default privileges that grant `anon`, `authenticated` and `service_role` on
  every newly created table in `public`, so the missing `GRANT` genuinely works — the default
  already handed the role what the policy assumes it has. Those defaults **stop being applied
  to projects created on or after 2026-10-30**, and the `auto_expose_new_tables` switch that
  would have restored them is removed on the same date. The same migration file therefore
  passes review, passes this gate, works in the project it was written against, and 403s in
  the next project it is replayed into — byte-identical in both. An explicit `GRANT` is the
  only form that survives the flip.
- **The assertion is a closure, not "every table must carry a GRANT".** For every
  `CREATE POLICY`, for every operation it names (`FOR ALL` expands to four), for every role in
  its `TO` clause, the GRANT/REVOKE history **folded in statement order** must leave that role
  holding that privilege. Order is the whole point: the shipped idiom is
  `REVOKE ALL … FROM anon, service_role` followed by a narrow `GRANT … TO authenticated`, and
  a set-union reading of those two statements concludes that `anon` holds everything.
- **Three carve-outs, each load-bearing, each with its own green proof** — because a gate that
  reds correct SQL gets deleted rather than obeyed. A predicate that is literally `false` needs
  no grant (that is precisely how the tenancy spine says *never*: `memberships_insert_none`
  refuses the privilege a naive rule would demand be granted). A `RESTRICTIVE` policy only ever
  subtracts rows, so it carries no claim that anyone can reach them. A policy with no `TO`
  clause names no role to close over.
- **And the reverse direction is deliberately not asserted.**
  `GRANT SELECT, DELETE ON TABLE public.orgs TO service_role` is a legitimate ADR'd grant with
  no policy behind it, because `service_role` bypasses row security entirely. A grant ⇒ policy
  rule would red the shipped tree for being right.
- The proof that matters is not the fixture: it is **the shipped `notes` migration minus one
  line**, which reds the real scaffold. A closure that passed the shipped tree because it never
  looked at it would have survived every fixture-only red-proof in the file. Ramped `0.6.0` →
  `0.7.0` — unlike the two unramped negation checks beside it, this one has a real legacy
  population, since on a pre-flip project the missing grant genuinely works, and `rampNote`
  prints every finding while it is armed.
- `parseGrants` now records the object-type keyword it matched. Without it,
  `REVOKE ALL ON SCHEMA audit FROM anon, authenticated, service_role` and
  `REVOKE ALL ON TABLE audit.events FROM anon` reduce to names one fold cannot tell apart, and
  a `USAGE` grant on a schema would have read as a `SELECT` grant on a table.

### Both dated commitments, discharged

- **The `i18n` gate covers the web surface.** `docs/harness/enforcement-tiers.md` gave the row
  `Target 0.6.0` after 0.5.0 moved it once, and `Target` is a commitment the `docs-sync` gate
  now reads: at harness 0.6.0 a still-single-surface gate reds on every install. It is
  discharged rather than moved a second time.
  - **It was not a second scan root.** `I18N_DIR`, `CATALOG` and `LOCALES_MODULE` were
    single-valued and mobile-derived, checks 3 and 4 key off them, and one un-adopted surface
    used to `ok()` out of the *whole* gate. The gate is parameterised by a `SURFACES` table
    now: each surface owns its catalog, its `LOCALES` array and its own adoption state, so a
    consumer who has adopted the mobile seam and not the web one is still judged on the half
    they have. The green line NAMES the surfaces it did not judge.
  - **`apps/web/lib/i18n/`** — catalog, `t()`, and the envelope copy. `t()` is a plain
    function, not a hook, and that is the load-bearing difference from the mobile twin: most
    web copy is rendered by Server Components, `generateMetadata` and Server Actions, none of
    which may call a hook. A context-based seam would have forced a second, untranslated code
    path for exactly the surfaces that render the most copy — which is how the web half came
    to have no seam at all. next-intl was considered and rejected: it wants a request-scoped
    provider and a proxy integration, and `apps/web/proxy.ts` is the one file this harness
    insists is *not* an authorization boundary.
  - **`apps/web/lib/error-copy.ts` moved into the seam** (`lib/i18n/errors.ts`). It was the
    single largest block of user-facing copy on the surface and the gate would *not* have
    caught it even after the web root was added — its object-literal rule matches
    `label|title|subtitle|description` keys, and these are keyed by error kind. The mobile
    twin already lived inside the seam. `check-seeded-migrations.mjs` caught the now-stale
    `seedOnInitOnly` entry the moment the template stopped shipping the old path.
  - **Check 4 stays mobile-only, and that is the runtime differing rather than a half owed.**
    Hermes ships no `Intl.PluralRules`/`RelativeTimeFormat`/`Locale`, so the mobile seam
    force-installs @formatjs polyfills plus per-language CLDR data and the gate holds that
    closure. Node and every browser ship full ICU; running check 4 on the web half would
    demand imports that must not exist.
  - **Bringing the web surface into scope found a false-positive class five releases never
    saw.** The JSX-text detector ran from a generic close, across intervening code, to the
    next generic open — reporting `"): Promise"` as user-facing copy. `apps/web` hits it
    constantly (`useState<AppError | null>(null)`,
    `submit(e: React.FormEvent<HTMLFormElement>): Promise<void>`); `apps/mobile` happened not
    to. A generic close ADJACENT to `(`, `)`, `,`, `.`, `[` or `>` is now excluded, and the
    residual false negative is stated rather than hidden.

- **The `route-manifest` gate covers the web surface.** The second `Target 0.6.0` row, and the
  one the tiers table described as *"the App Router has no equivalent registry, so a web page
  can land with no id, no title key and no declared loading/empty/error states."*
  - **A TWIN GATE, not a parameterised one — the opposite call from `i18n`, on evidence.**
    `check-route-manifest.mjs` carries expo-router's file→URL derivation and a hand-written
    parser for the `ROUTES` array literal, and the two routers share no rule: expo-router maps
    a trailing `index` to its parent path and has no route groups, parallel routes,
    intercepting routes or private `_folder` exclusion; the App Router has all four and no
    `index` convention. `check-web-routes.mjs` ships beside it and the one `route-manifest`
    step runs both — the shape `boundaries` has used since 0.1.x.
  - **The web registry is GENERATED.** `tools/gen-web-routes.mjs` walks `apps/web/app` and
    derives `path` and `file` from position into a committed, regen-diffed
    `apps/web/lib/routes.generated.ts`, so the defect the mobile gate spends thirty lines
    catching — a manifest that lies about the URL — cannot be written on this surface. Authors
    write only what position cannot tell you (`id`, `titleKey`, the three state test ids) in a
    `page.meta.ts` beside the `page.tsx`. It is a FILE WALK and not a runtime import, the
    opposite choice from `gen-action-inventory.mjs`: a tRPC router is a value that must be
    built to be enumerated, and a route set IS a file tree — so this needs no install, no
    `next build` and no network, which is what lets it run inside the chain.
  - **The check with no mobile counterpart.** Mobile proves its declared test ids exist by
    DRIVING them in the RNTL states sweep. The web half has none, so the gate proves it
    statically: each declared id must be rendered somewhere in the route's own segment —
    non-recursively (a child's markup must not answer for its parent) and never counting
    `page.meta.ts` itself, or every declaration would prove itself. `data-testid=
    {meta.states.empty}` is the form the failure message names, because with it the declared
    id and the rendered id are one expression.
  - **`app/not-found.tsx` is required chrome**, the twin of `+not-found`: without it an
    unmatched URL renders Next's built-in 404 — unbranded, untranslated, outside every lane.
  - Shipped **ramped** (`minVersion 0.6.0`, `until 0.7.0`): an install predating 0.6.0 has
    pages and no metas anywhere, and projects grow into gates rather than being ambushed.

- **And the derivation those two Targets are judged by was itself wrong.** Both consumers of
  `singleSurfaceGates` ask a question about a tier ROW, and a row's `Gate` cell names a chain
  STEP — but the function answered about a SCRIPT. Those coincide only while every step runs
  one script, and `boundaries` has run two since 0.1.x. Discharging `route-manifest` made it
  concrete: each of its two scripts is single-surface, the step covers the product, and
  unfolded the row's arrived `Target` could never discharge no matter what shipped — a control
  demanding a change that no change could satisfy. Scripts now fold by step key. What the fold
  deliberately does NOT check is whether the second script asserts anything; the tiers table
  says which surfaces a control reaches, and `tests/canary/injections.json` says it works.

### The control plane, audited for the first time — three live bypasses

The harness's whole enforcement layer **is** `.claude/settings.json` plus hooks. It held every
framework it ships to a cited security floor and held the tool it *runs inside* to nothing, and
never asked whether its own hooks were aimed where it thought. Three answers, none of them
theoretical.

**The command guard was aimed at one of three command-executing tools.** The matcher was the
single word `Bash`. Permission rules spelled `Bash(...)` cover **Bash and Monitor** — which is
exactly what hid this, because it makes the settings file *look* like it covers both — but a
hook matcher is an **exact tool name**, not a permission namespace. So every command-content
check in `pretool-bash-guard.mjs` was reachable-around by asking for the same command under
`Monitor`. The same defect class as the `mcp__` gap 0.3.0 closed, whose own comment reads *"a
missing entry is not a degraded posture — it is that whole event unguarded."*

`PowerShell` was the sharper half, and it is not "another shell". **On Windows without Git
Bash, Claude Code does not register the Bash tool at all** — the hooks reference says so in as
many words: *"A hook that matches only `Bash` never fires there."* The guard was not weaker for
those sessions; it was absent. PowerShell also carries its own `PowerShell(...)` permission
namespace, so the settings deny list does not reach it either — this hook is the only layer
that can. The matcher is now `Bash|Monitor|PowerShell`, and `check-wiring` holds it there: a
project may add a tool, never drop one.

Widening the matcher without widening the rules would have been a fix that reads like a fix, so
the rule table gained the canonical cmdlet spellings — `Remove-Item`, `Get-Content`,
`Set-Content`, `Copy-Item`, `Out-File`. PowerShell's bash-compatible aliases (`rm`, `cp`, `cat`,
`tee`) already matched, and `rm -Recurse -Force` turned out to have been covered from the day
the flag-class regex was written — **verified against the shipped rule rather than assumed**,
which is why only the non-alias spellings were added.

**Seven `Write(path)` deny rules were doing nothing.** Claude Code consults file-permission
rules under `Edit(...)` and `Read(...)` only; a `Write(path)` rule is accepted, warned about at
startup, and never consulted. Protection held — every one happens to have an `Edit(...)` twin —
but that was an accident of authoring in a file whose entire job is to be asserted. `check-wiring`
now requires the twin. The `Write(...)` lines stay: they cost nothing, they state intent, and
they are already right if Claude Code ever starts consulting them.

**`tools/cc-floor.json` — a Claude Code version floor, and the citations are the point.** The
published record was never consulted: `gh api /advisories?ecosystem=npm&affects=@anthropic-ai/claude-code`
returns **28 advisories**, ten of them landing on this harness's exact surface — configuration
injection into `settings.json` itself, a repo-controlled-settings trust bypass, **two** git
worktree escapes, and two command-injection bypasses of file-write restrictions that are this
repo's own *"the bash guard is a tripwire, not a sandbox"* caveat as shipped CVEs rather than as
a disclaimer. The required floor is **2.1.163**: the maximum `first_patched_version` across all
28, which is also the earliest release outside every vulnerable range.

That number is **derived, not written**. A bare `"floor": "2.1.163"` is a number the next
maintainer lowers the first time a teammate's CLI is old, because nothing in the file says what
it costs. `version-sync` recomputes the floor from the advisory rows beside it and reds in both
directions; `setBy` must agree with the evidence **both ways**, because an advisory that
*quietly starts* setting the floor — a later one added at the same patched version — is the case
a one-way check never notices. Every row must carry an openable `github.com/advisories/` URL and
a sentence saying what it does to *this* harness, so the file cannot decay into a stale copy of a
vulnerability database. The headline proof deletes an advisory row and watches the floor fall
silently — the one edit a scalar-only floor cannot see.

Split on the clock, the way `framework-floor.json` already argues for: the arithmetic is
clockless and rides the chain, and "has anyone re-queried lately" rides the scheduled
`floor-review` job with a 45-day window. Three hook-versus-permission fixes carry **no CVE at
all** (a PreToolUse hook returning `"allow"` could bypass `permissions.deny` including managed
settings, 2.1.77; `permissions.deny` not overriding a hook's `"ask"`, 2.1.101;
`PermissionRequest` `updatedInput` not re-checked against deny, 2.1.110) — all below the floor,
and recorded because an advisory query alone would have missed every one.

**And the answers came from probing, not reading.** `design/CONTROL-PLANE-FACTS.md` gained four
facts: the observed `Stop` payload (`stop_hook_active` **is** real, closing a question this
release opened against its own doctrine); matcher grammar; the inert `Write(path)` class; and
that **path-scoped rules load on demand and are lost across compaction**. That last one
*vindicates* a decision already in the tree — `boundaries.md` and `mobile-server-split.md` both
open with "best-effort scoped; the gates are the invariant", which is now verified rather than
hopeful. Two things are recorded as **NOT ESTABLISHED** rather than guessed: whether `Monitor`
commands are sandboxed like Bash commands, and whether a `Bash`-matching hook fires for a
skill's `` !`command` `` expansion.

### The layer a developer cannot switch off, and the sandbox's honest limits

`disableAllHooks: true` in a user, project or local settings file stops **every non-managed
hook** — the Stop gate, both PreToolUse guards, the provenance check, the reviewer verdict hook
— and there is no hook left to notice. No setting forbids it. The one documented property that
helps is that hooks living in **managed** settings survive it, so
`docs/security/managed-settings.md` ships the minimal correct policy: the hooks, plus
`disableBypassPermissionsMode: "disable"`, and nothing else.

Nothing else is the point. `allowManagedHooksOnly` reads like the fix and is its opposite — it
**blocks non-managed hooks**, so switching it on while the harness hooks still live in the
project settings disables the harness while trying to protect it.
`allowManagedPermissionRulesOnly` drops every user and project permission `allow` rule and
`additionalDirectories`, which is a real change to how each developer's session behaves rather
than a free hardening line. Both are documented as what NOT to copy.

The doc also solves a problem a managed hook creates: it fires in **every project on the
machine**, including ones that have never seen this harness — and `stop-validate-gate.mjs`
*blocks* when it cannot load its config, which is correct inside an install and catastrophic
outside one. So the policy names a dispatcher that exits 0 when the project has no such hook and
otherwise passes the payload through, propagating the exit code (fail-closed on a spawn failure,
because exit 2 IS the block). Verification is `/doctor`, `--debug-file … --init-only`, or
`--include-hook-events` — explicitly **not** `/hooks`, which has no managed source category at
all.

`sandbox-and-supply-chain.md` gained the sandbox's limits, stated before its benefits: no CLI
flag turns it on, `--dangerously-skip-permissions` does not turn it off, a linked worktree can
write the main repo's shared `.git`, `strictAllowlist` is **ignored from project settings** (so
committing it achieves nothing), plugin monitors run **unsandboxed at hook trust level**,
whether `Monitor` commands are sandboxed at all is undocumented, and **there is no native
Windows support** — the platform that already has no Bash tool without Git Bash. And the network
allowlist is described as blast-radius reduction, never prevention, because CVE-2026-54316 was
exfiltration through a *pre-approved* domain.

### The Stop block cap now leaves a mark

`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (default 8) is the documented safety valve that stops a red
gate looping forever: after N **consecutive** blocks Claude Code ends the turn anyway. The valve
is right and it stays — a hook that can block forever is a bricked machine. But it is also **the
one documented way the headline claim is false**, and through 0.5.0 a turn that ran out of blocks
left exactly the trace a green turn leaves: none.

Every outcome now appends to `.harness/turn-outcomes.jsonl`. The last block a turn is allowed
says `LAST CHANCE` while the transcript can still act on it, naming the gates still red. And the
**next** turn reports a predecessor that ended at the cap **even when the tree is green again by
then** — which is precisely when the fact would otherwise be lost, and is the headline proof.
`subagent-verdict.mjs` writes to the same ledger, because the cap is documented over `Stop` *and*
`SubagentStop` in one sentence and a count that saw half of them would go quiet on exactly the
turns that needed the warning; counting them together can only warn early, which is the safe
direction. The count is of consecutive blocks at the tail, not blocks keyed by `prompt_id` —
"consecutive" is the word the cap is defined with, and a green record is what resets it, the same
reset condition Claude Code uses.

The file is a **diagnostic, not a control**: it authorizes nothing, so a corrupt line is
tolerated rather than fatal — the deliberate opposite of the reviewer ledger, which fails closed
because it does authorize. An unusable `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` value is reported rather
than silently reverting to 8.

**The factory got the same treatment**, because it had the same hole and is the machine where it
is cheapest to notice: a maintainer whose turn ran out of blocks left the machinery inconsistent
with no trace, on the one machine where a bug in this code can actually be fixed.
`stop-factory-gate.mjs` writes the same ledger through the same shipped module — never a second
copy, since two implementations of "how many times have we blocked" would drift and this hook's
whole purpose is to be a live test of the exact bytes consumers get.

That sharing is also why the persistence moved into `turn-outcomes.mjs` as its one impure
function: three hooks write this ledger now — the consumer Stop gate, the SubagentStop verdict
hook, and the factory's own gate — and it swallows every I/O failure into a reported error, so a
ledger that cannot be written loses a record rather than bricking every turn on the machine.

**`stop_hook_active` was observed going `true`.** A one-shot probe blocked exactly once, and the
Stop that followed carried the flag under the *same* `prompt_id`. Two things fell out of that
capture and are recorded in `design/CONTROL-PLANE-FACTS.md`: the payload of the invocation that
BLOCKS is still `false` — the flag means "you are here because a hook blocked", not "a hook is
about to block", which is precisely why the block count is kept by the harness rather than read
off the field — and `settings.json`'s `env` block does reach a hook's process, so the scaffold's
`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` is a real input rather than a decoration. Had it not, every
consumer would have silently fallen back to a default that happens to be the same number, and
nothing would ever have looked wrong.

### The process layer — the agent surface stops being prose nothing observes

**The governing finding of this release.** Ten subagents, seven slash commands and two skills
are the layer that is supposed to make Claude Code's behaviour deterministic. Eight of them
carry `MUST BE USED` declarations. Through 0.5.0, **nothing anywhere read a transcript, hooked
`SubagentStop`, or otherwise observed that any of them ran.**

What *was* enforced is real but orthogonal: the reviewer files must exist, their frontmatter
must parse under a pinned grammar, their tools must be a read-only subset, they must carry
`disallowedTools: Write, Edit`, their bodies must end demanding exactly `VERDICT: PASS` or
`VERDICT: BLOCK`, and the whole surface is sha-locked in `tools/agents.lock.json`. Every one of
those is a property of **what the file says**. None is about whether it ran.

The project scoped this itself and deferred it in 0.3.0, with two conditions: it must fail
closed on an unrecognizable transcript, and it must not move the Stop chain 9 → 10 in the same
release that first freezes it. 0.3.0 *was* that release. Both conditions are met.

- **The design was probed before it was written, and the probe changed it.** Three facts W4
  rested on had been read from documentation and never observed. A hook registered in a
  running session (which, incidentally, is re-read **mid-session** — no restart) recorded a
  real `SubagentStop` payload. It carries **`last_assistant_message` as a first-class field**
  holding the subagent's full final text — so the mandated verdict line is read directly, with
  no transcript scraping and no format to guess at. It also carries `agent_type`, `session_id`
  and `prompt_id`. Recorded in `design/CONTROL-PLANE-FACTS.md`, dated, re-verify-on-bump —
  the pattern `EXPO-FACTS.md` and `CI-LANE-FACTS.md` already use, now applied to the harness's
  most important dependency: the tool it runs inside.
- **The hook BLOCKS a reviewer that does not give a verdict.** Exit 2 on `SubagentStop`
  prevents the subagent from stopping, so it gets another chance to say the thing its own file
  promises it will say. That turns a file-shape assertion into a behavioural one.
- **The step is keyed to the TURN, and that is the whole control.** The ledger is append-only
  across a session, so an entry from an earlier `prompt_id` is exactly what a naive reader
  would accept — and accepting it would report coverage from work somebody did an hour ago.
  It is the one failure mode here that no later check would catch, and it is the suite's
  headline must-red. `stop-validate-gate.mjs` passes the turn's identity down; a step that
  does not receive it fails closed in CI rather than judging the wrong turn.
- **The roster is derived, not listed.** A reviewer is an agent declaring
  `disallowedTools: Write, Edit` — the property `check-docs-sync` already enforces and the one
  that actually separates a reviewer from an author. `dal-author` and `test-author` produce
  diffs and attest to nothing. A `settings.json` matcher naming the reviewers would have been
  a second copy of the roster, and two copies of a list drift.
- **The triggers are narrower than the prose they replace**, deliberately.
  `tools/reviewer-triggers.json` carries five reviewers with path globs and `except` patterns
  (a test beside a policy is not a policy). Two reviewers are **deliberately not
  path-triggered** and say why in the file: `torvalds-reviewer` runs "before finishing", which
  is every turn and which no path glob expresses without either firing on everything or on an
  arbitrary subset; `citation-verifier` is already closed by the `provenance` chain gate, and a
  second, weaker control would let a green path-trigger imply coverage the gate is the real
  source of.
- **A guard rule the coverage checker rejected, correctly.** A write-guard entry for the
  ledger looked prudent and was vacuous: the ledger is runtime output no template ships, and
  `check-canary-coverage.mjs` reds on a deny over a path that cannot exist — "satisfied by
  every input, so its canary passes while the rule guards nothing". The existing `harness-dir`
  rule already covers the whole `.harness/` tree. The rule is deleted and the reason is
  written where the next person will look for it.

### `data-flow` (chain step 33) — the DSR closure

`docs/adr/20260201-org-scoped-tenancy.md` records that after the org re-scope *"DSR
completeness is now procedure-backed, not schema-backed… residual rows can no longer be
enumerated back to the subject."* That sentence was true, serious, and checkable by nothing.
The procedure lived in one Edge Function's header, the reason for each surviving column lived
in a different SQL comment, and **no file anywhere listed what actually survives.**

It is decidable. A delete of `auth.users` does exactly what the `FOREIGN KEY` actions say, so
the gate replays `supabase/migrations/`, walks out from the subject, and puts every link in
one of four buckets — **erased** (a CASCADE chain), **severed** (`SET NULL`: the row survives
and only the link is cut), **retained** (no delete will ever reach it), **blocking**. The two
middle buckets are decisions a human has to defend, and both are legitimate here: the org owns
its notes, and the audit trail must outlive its subjects. Both are also exactly the kind of
decision that stops being reviewed once it is three releases old. `tools/data-flow.json`
carries them, closed both ways — an unreviewed severed link reds, and so does a reviewed one
the schema no longer has.

- **The bucket nobody watches is the fourth.** An FK to the subject with `ON DELETE RESTRICT`
  or `NO ACTION` makes the delete FAIL — and `NO ACTION` is what PostgreSQL assumes when the
  clause is simply **omitted**. So the spelling that breaks account deletion is the one that
  looks like every other column definition: no keyword to notice, nothing to grep for, a GDPR
  Art. 17 failure and an Apple 5.1.1(v) rejection from a line a reviewer reads past. It is the
  suite's headline must-red.
- **`pii-columns.json` becomes load-bearing twice without changing purpose.** That file says
  in its own comment that it is "not a general PII inventory" — it is the audit-capture
  deny-list. So it is used here only as a **lower bound**, which is exactly what it can
  support: every column it names must be erased with its row, severed with a reason, or
  retained with a reason **and** a procedure. The procedure must be a file that exists.
- **The shared SQL parser never replayed a dropped foreign key.** `parseColumnFacts` folded
  `ADD CONSTRAINT` and ignored `DROP CONSTRAINT`, so a foreign key removed by a later
  migration kept its recorded reference forever — and no parser in the repo captured an
  `ON DELETE` action at all. Both are fixed, including the generated `<table>_<column>_fkey`
  name that real migrations drop. This is not academic: `notes.owner_id` was created
  `ON DELETE CASCADE` and demoted to `SET NULL` by a later `ALTER`, so before this the
  CASCADE and SET NULL states were indistinguishable to every consumer of the parser.
- **`check-migrations.mjs` claimed a compensating control that does not exist.** Its header
  said the schema↔migration drift check "runs in CI's db lane via `supabase db diff`".
  **No workflow in this repository runs `supabase db diff`** — not migration-safety.yml, not
  either database lane, not the selftest matrix. So the reconciliation was attributed to a job
  nobody wrote, which is worse than an open deferral because it reads as coverage. The header
  is corrected, and `data-flow` now closes the slice that decides whether a row dies with its
  owner: it is the only place in the repo where `supabase/schemas/` and
  `supabase/migrations/` are compared on a column fact.
- **The export half ships as a closed projection with an undelivered surface, declared.**
  `export.projection` is closed against the schema both ways and every subject-data table is
  projected or excluded with a reason. `export.surface` is `"none"` with a dated target,
  the same shape `store-policy.json` already uses for `accountDeletion` — because a projection
  closed against the schema is worth something on its own, and an *undeclared* absence is how
  "we have an export" becomes true in a README and false in the product. The plan called for
  `supabase/functions/export-account/`; the repo's own rule forbids it (an export runs as the
  caller under RLS, and `supabase/functions/README.md` rule 1 says anything expressible as a
  procedure running as the user is not an Edge Function). That correction is recorded in the
  policy rather than silently followed.

`docs/runbooks/data-subject-requests.md` is the procedure the whole gate points at.

### The deadline ratchet could be walked around by re-opening a ramp, and this release did it

0.5.0 shipped the ratchet that makes *"there is no flag that extends a deadline"* an
enforced sentence rather than a promise: every `until` is compared against the previous
release **tag's** tree, and a date that moved later reds unless a `rampExtensions` record
excuses it. It grouped sites by `(file, minVersion)`.

This release had to **re-open** one. `check-docs-sync.mjs`'s AGENTS.md gate-list ramp expired
at 0.5.0; injecting `auth-posture` through `configSteps` grows an existing install's chain to
32 steps while its seeded `AGENTS.md` still documents 31, and `update` cannot rewrite project
memory — so closing the escape at 0.5.0 would hard-red every install in the lineage for a file
the harness handed them and then refused to update. Re-opening means a wider population
(`minVersion` 0.3.0 → 0.6.0) and a later date (`until` 0.5.0 → 0.7.0).

Under the old key that is **not one site moving**. It is one key vanishing — read as a
deletion, which is stricter, so allowed — and another appearing, read as a new escape, so
also allowed. Two individually-permitted acts composing into the one act the runbook promises
consumers cannot happen, at the cost of editing a single version literal. Every control in the
repository stayed green, including the ratchet's own ledger.

- **The key is now the DETAIL string** — `rampNote`'s third argument, the prose that names the
  escape, already present at all 22 call sites and stable across a re-open, a line move and a
  reflow. `scripts/check-ramp-ledger.mjs` enforces the property that makes it an id rather than
  a comment: every site parses one, and no two sites in a file share one.
- **It closed 0.5.0's documented residual hole as a side effect.** That hole — move one
  deadline while adding a sibling at the old one, so the sorted lists line up — needed a
  per-site id, and 0.5.0 said so in the source and pinned the limit with a test carrying the
  instruction *"if a later release adds ids, this test fails and is DELETED, which is the
  signal."* It failed. It is deleted, and the fixture now asserts the opposite.
- **The residual hole that replaces it is stated, not implied:** rewording the detail in the
  same commit that moves the deadline still evades the ratchet. That is a sentence a consumer
  reads in a NOTE, inside a CODEOWNERS-covered gate script — a visible act rather than a
  one-character edit.
- **The extension is recorded.** `template/migrations.json`'s `0.6.0.rampExtensions` is the
  first entry of its kind in this lineage, and a test closes it against the tree: its `detail`
  must be byte-equal to a shipped call site's, so an excuse cannot name an escape that is not
  there. The record shape changed with the key — `{ file, detail, from, to, why }`, because an
  excuse pinned to `minVersion` would go stale in the exact act it is written for.
- **A must-red went green because the roadmap caught up with its fixture.**
  `chain-budget.test.mjs`'s "a chain step with no budget row reds" used `auth-posture` as its
  unbudgeted step, with a comment explaining that 0.6.0 planned to inject it. Injecting it gave
  the name a budget row, so there was nothing left to be missing and the test passed for the
  wrong reason. It now names a step no release can add, and asserts that of itself.

### Two more the upgrade lane found — both in this release's own fixes

The lane's rule is that no `migrations.json` record is trustworthy until an `update` has
actually executed. 0.6.0 added two records — the `data-flow` chain step and the
`reviewer-verdicts` **Stop-chain** step — and running the lane reddened twice, on the lane
itself both times.

**§4 could not see a Stop-chain injection.** 0.6.0 had already replaced its hardcoded
`for step in wiring secrets` with a set derived from `requiredConfigSteps`, which was the
right fix and an incomplete one: it checked every required step against `validate --list`.
`reviewer-verdicts` targets `STOP_HOOK_STEPS`, so a correct injection was reported MISSING.
The derivation now carries the target array and the Stop chain is read from the installed
config — deliberately **not** from `tools/stop.floor.json`, because the floor is harness-owned
and `update` refreshes it, so a step the union would still RUN could be silently absent from
the consumer's own config. The union is a safety net for a weakened config, never a substitute
for the injection landing.

**§7b made an inference §8 already knew was unsound.** It required every gate with a live ramp
to have printed a NOTE. But `rampNote` prints on every armed call, which is why several gates
now call it only when they have findings to withhold — so on a correct 0.6.0 upgrade
`auth-posture` announces its two findings and `data-flow` says `OK`, because its policy ships
planted and the stack schema already satisfies it. The old assertion called that honest `OK` a
check shipped disabled. §8 had been fixed exactly this way one wave earlier and its comment
names §7a as making "the same unsound step"; §7b was making it too.

The inference is now reversed to match: a ramped gate must have **run** (an `OK`, `SKIPPED` or
`NOTE` line — silence means it never executed), and separately, anything a gate reports as
withheld must carry the ramp banner naming its deadline. That second check is the real
"shipped disabled" failure, and it is judged from the run rather than predicted from the site
list.

All four legs then pass end to end — A (0.5.0), B (0.1.3, where **eleven** expiries land at
once), C (0.2.1) and D (0.3.0, the only shape that can reach the `RAMP EXPIRED` branch at all)
— each upgrading cleanly on 33 steps with `doctor` 0 and `graduate` correctly refusing.

### Leg E: the door nobody had opened

`graduate` has two branches and only one had ever been executed. Every leg above ends with it
REFUSING, because an upgraded install always has ramped findings outstanding — that is what a
ramp is *for*. The SUCCESS branch is the one that moves `baseVersion` and arms every ramped
check at once, and through 0.5.0 nothing anywhere had run it. **A door nobody has opened is not
a door you know opens.**

Leg E performs the sweep `docs/runbooks/harness-upgrade.md` prescribes, then requires
`graduate` to succeed. That makes it a proof of two things at once: that the door opens, and
that **the runbook is sufficient** — a runbook whose steps do not actually clear the findings
is worse than no runbook, and nothing else in this repository would notice. It shares leg D's
baseline deliberately, so the only difference between the two results is the sweep.

The file list is DERIVED, not written: `seedOnInitOnly` is the set a release deliberately
withheld from `update`, which is exactly the set a consumer must adopt by hand — so the same
data that withholds them names the sweep. It refuses to run if that set is empty, because a
sweep that clears nothing cannot prove anything.

**Building it found two more defects, both in this release's own work.**

`apps/web/lib/i18n/errors.ts` was **dead code on any install that adopted the seam**. On a
fresh scaffold a page imports it, so `knip --strict` is happy; on an upgrade the page bodies
are seeded from 0.2.0 and nothing references it — so a consumer following the instruction to
adopt the new i18n seam earned a red `dead-code` step for their trouble. Its two siblings were
declared production entries when the seam was built and this one was missed. This is the same
class as the orphan 0.4.0 shipped, arrived at from the opposite direction, and only an
*upgraded* tree shows it.

And the seam creates an obligation `update` cannot discharge: a `page.meta.ts` **declares**
state test ids, and the gate requires the page to **render** them — but page bodies belong to
the consumer. Adopting the meta file alone therefore leaves a finding the meta file itself
created. The runbook now says so, with the `data-testid={meta.states.<key>}` form that cannot
drift and the `unreachableStates` escape for a state that genuinely cannot occur. Leg E
executes that instruction, so if it ever stops being sufficient the lane reds rather than a
consumer discovering it.

### What running the upgrade lane found, which nothing else could

The lane is the release gate for every ramp and migration claim, and its own header says so.
Running it against this release's tree — rather than reading it — turned up four defects in
one execution, three of them in machinery this release had just written.

- **A shipped gate script was not formatted, and no factory check has ever run the
  formatter.** `format` is step ONE of every consumer's chain and it runs over the files the
  harness ships. Nothing on the factory side ran it — eslint, tsc and knip moved here in
  0.3.0 for exactly this reason and biome was the one left behind. So one over-long line in
  `check-auth-posture.mjs` was invisible to a maintainer's turn and red on step one for every
  consumer who upgraded; the lane reported it, correctly, as a REGRESSION rather than an
  expiry. The factory Stop gate is 13 steps now, and the thirteenth runs the TEMPLATE's own
  `biome.jsonc` — never a factory copy that could drift from what consumers get.
- **`check-web-routes.mjs` armed its ramp before it knew whether it had findings, which
  would have made `graduate` unreachable forever.** `rampNote` PRINTS its NOTE on every armed
  call, and `graduate` refuses while any NOTE stands — so a ramp evaluated unconditionally
  announces itself on a CLEAN tree, and since only `graduate` advances the baseVersion that
  disarms the ramp, the install could never graduate at all. Every other shipped site guards
  the call on having something to withhold; this one shipped for one wave without it.
- **The lane's model of `graduate` was half its contract.** 0.5.0 rewrote §8 to key on the
  chain's exit code, reading the refusal text as *"refuses while validate is RED"*.
  `graduate` refuses on a red chain **and**, separately, while any ramp NOTE stands — which
  is the entire point of graduating. The half was invisible for exactly one release because
  0.5.0 opened no ramp at its own minVersion, so on leg A "green chain" and "no NOTEs"
  coincided. 0.6.0 opens three, every leg's baseline is below 0.6.0, and the old branch would
  have called a CORRECT refusal a defect on all four legs. The direction of inference is
  reversed to fix it: judge what `graduate` DID and require the reason to be true, rather
  than predicting which way it must go and calling the other one a bug.
- **No leg reached `graduate`'s success branch**, and until this release nothing had noticed
  because nothing needed to: 0.5.0 opened no ramp at its own minVersion, so leg A's "green
  chain" and "no NOTEs" coincided and the door appeared to open. 0.6.0 opens three, every
  leg's baseline is below 0.6.0, and all four legs took the refusal branch — the mechanism
  working, and the proof that the door OPENS gone at the same time. That is what leg E was
  built for (above); the gap is recorded here because finding it is what caused it.

### Two more that only the TAG could expose — a release cannot be its own predecessor

Cutting the tag put the repository into a state nothing had ever run in, and two controls
answered differently there. Both had been green on the PR, on `main`, and on every local run,
because in every one of those states **the release's own tag did not exist yet.**

- **`check-ramp-ledger` took the highest tag as "the previous release".** The moment `v0.6.0`
  existed, that was `v0.6.0` — so the deadline ratchet diffed HEAD against its own tree, found
  no deadline move, and reported this release's reviewed `rampExtensions` record as a stale
  standing permission slip. Not a one-build failure: `main` would have been red on that check
  from the tag onward, and every future release would have reproduced it on the day it
  shipped. The function's own comment named the hazard exactly — *"Not `git describe`: on a
  release commit that resolves to itself"* — and then reimplemented it one line later.
  `scripts/ci/upgrade-lane.sh` had the rule right and stated why: *"upgrading from the version
  you are is a no-op that would pass this lane while proving nothing."* It is now
  `highestReleaseBelow` in `scripts/lib/ramp-sites.mjs`, one home, with the pre-tag and
  post-tag answers asserted to be equal.

- **The VINTAGES closure asserted against a one-element view of history.** Its guard was
  `tags.length === 0` — a template copy with no tags — which misses the case that actually
  happened: on a **tag push** `actions/checkout` at its default depth fetches exactly the ref
  being built, so `git tag --list` returns `["v0.6.0"]` and every released vintage looks like
  a tag that never existed. It reported all six of its own releases as fabrications. It now
  skips when no tag below the current version is reachable, because a truncated history
  cannot corroborate anything, and `release.yml` checks out with `fetch-depth: 0` — its gates
  ask questions about release history, and `machinery-lint` already checked out that way for
  the same reason.

The shape is worth naming: **the same commit was green on `main` and red on its own tag.**
Not because the tree differed — it was byte-identical — but because two checks read the
answer out of how the repository had been fetched rather than out of what it contained.

### Two the local ladder could not see, both found by CI on the release PR

The whole local ladder was green — 1790 tests, factory gate, nine machinery-lint checks,
fresh scaffold 33/33, five upgrade legs — and the first CI run failed three jobs. Both causes
were **structurally invisible** to what had been run, which is the more useful half of the
finding than either defect.

- **`duplication` reds on a fresh 0.6.0 scaffold**, so no consumer's turn could have ended.
  The web i18n seam this release added mirrors mobile, and mirroring reproduced the eight-line
  `PluralMessage` interface — 139 tokens, over the clone gate's threshold. It could not be
  seen locally because `duplication` is a **Stop-chain** step and the fresh-scaffold rung runs
  `validate --report-all`, which is the 33-gate chain only. The rung proved the chain and was
  read as proving the scaffold.

  The clone is the type preamble, not the copy — the tokenizer normalizes string literals, so
  the entries fall below the threshold on their own (verified by collapsing the interface to
  one line: the gate goes clean). It is accepted rather than extracted, and the reason is a
  property of the harness rather than of this file: **every shared package source root is
  seeded**, so `update` can never deliver a new export into an existing install. Extracting
  the type would compile on a fresh scaffold and break `types` on every consumer who adopted
  the seam, with no remedy short of asking them to re-adopt their own wire contracts. The
  runbook now tells an adopting consumer to add the entry, because their allowlist is theirs.

- **Nine of `check-reviewer-verdicts.test.mjs`'s twenty-one tests fail on a PR run and nowhere
  else.** The fixture builds a throwaway git repo with one commit and no remote, then spread
  the ambient environment into the gate — so on `pull_request`, `GITHUB_BASE_REF` leaked in,
  the gate resolved a diff base of `origin/main` that does not exist there, and it failed
  closed. Correctly: it genuinely could not compute a diff. Nine tests then asserted against
  the fail-closed verdict instead of the one they meant. **Eighteen sibling test files already
  delete that variable**; the file written in the release that added the gate did not. This is
  the fourth appearance of this class in the repository, after `bootstrap-linux`, the canary
  job's per-gate unset, and the upgrade lane's script-wide one — and the first where the
  green-in-every-shell / red-only-on-a-PR asymmetry hid it.

### Every existing install was going to keep the sign-in loop, and only leg E could say so

The release's headline fix — the seeded web app could not sign anybody in — **reached no
existing install, and the release had no channel that could carry it.** The browser Supabase
client persisted its session to `localStorage` while every server render read the cookie jar,
so a correct sign-in bounced straight back to `/sign-in`. 0.6.0 fixed that in nine seeded
files. `update` does not write seeded files; that is what seeded *means*. So a consumer who
upgraded got the gate that detects the loop and none of the fix for it.

`auth-posture` did its job: six findings, each naming the file and the exact change, withheld
as NOTEs until 0.7.0. What was missing was everything after the alarm — no runbook step, no
declaration, nothing that would ever clear them. And because `graduate` refuses while any NOTE
stands, **an upgraded install could never graduate at all.** That is precisely the state leg E
exists to detect, and it is the first thing it detected: `ramp NOTE(s) survive the documented
sweep — the runbook does not actually clear what this release ramped`. Four legs were green;
the chain after the sweep was green on all 33 steps; the defect was visible only to the leg
that requires the door to open.

`template/migrations.json` gains **`seededSourceFixes`**, the opposite number to
`seedOnInitOnly`: that key is for files a release WITHHOLDS, this one for files the harness
authored and a release CORRECTED, where the consumer's ownership is exactly what blocks
delivery. `configSteps`, `configCommandUpdates` and `dependencyObligations` each cover a
different channel and none covers this one. **It is an instruction, not an action** — nothing
copies these into a real install. The runbook names the set and says why the nine move as one
(a browser client cannot take a storage adapter the platform package does not export), the
sweep models the edit on the lane's pristine scaffold, and `check-seeded-migrations` closes the
record against the template: `adopt()` skips a missing source in **silence**, so a path that
stopped existing would quietly shrink the sweep while the runbook kept prescribing it.

The runbook section is deliberately not written like the others on that page. Every other item
is a new surface a consumer chooses to adopt; this one is a defect they already have.

### The factory gate reddened on the release's own proof, and the file that fixed it caught itself

Re-running the acceptance ladder against the finished tree turned the release's subject onto the
release's own tooling. `scripts/hygiene.mjs` sweeps every text file for a literal NUL — the byte
that makes a file `data`, so `grep` skips it in **silence** — and it chose which files to read by
walking the repo behind a hand-maintained exclude list (`node_modules`, `.git`, `dist`, `build`,
`.next`, `coverage`) that knew nothing about `.gitignore`.

Acceptance rung 4 plants a **git worktree at an old release tag** under `.selftest/`. So running
the lane that is the release gate for every ramp and migration claim made the factory Stop gate
red on two **v0.1.3** files that predate the sweep entirely. Nobody can fix a file in history:
the available moves were *delete your lane output* or *stop running the lane*, and the second is
the one people take. **A gate that punishes running the release proof is a gate that deletes the
release proof.**

The inflated counter is the worse half. `textFilesScanned` is this sweep's anti-vacuity control
— *"a sweep that scanned nothing is a false green"* — and with six scratch scaffolds in scope it
was counting trees that are not the harness. The number that exists to prove the sweep read
**the repository** could not fall while any scratch output sat on disk, so the control could not
fire. The set is now `git ls-files --cached --others --exclude-standard`: tracked, plus
untracked-but-not-ignored so a new NUL reds *before* it is committed, honouring `.gitignore` so
the next scratch directory is out of scope by construction rather than by remembering to extend
a literal. It fails closed when git cannot answer, because a filesystem walk cannot tell source
from scratch — which is how this started. The other two whole-tree factory scripts were checked
in the same pass: `check-residue.mjs` takes a scaffold argument and `check-syntax.mjs` names its
four roots, so neither could reach `.selftest/`.

**The fix introduced the defect it fixes.** The line that splits git's `-z` output was written
with a literal NUL instead of the `\u0000` escape — the fourth time in this repository's history
that this bug has been reproduced *by the act of addressing it*, after the two files it was
written for and the changelog entry describing it. The sweep caught it on the next run, which is
the only reason this sentence is accurate.

And the sweep had no red-proof at all. Factory-gate steps carry no canary-registry entry — that
registry closes over the shipped chain and the Stop chain, and these scripts ship to nobody — so
`hygiene` had spent five releases as a gate whose failure nobody had watched. It now has three
executed tests: the tree as it stands, a planted NUL that must red, and **the same NUL under
`.selftest/` that must not**. Both fixtures assert `git check-ignore` first, because each half
has a silent-green failure mode — a fixture git ignores makes the red test pass for the wrong
reason, and a fixture git tracks makes the green test pass for the wrong reason.

### Fixed

- **`CONTRIBUTING.md` described CI that does not exist, in the file maintainers follow
  literally.** Rule 1 claimed *"the `bootstrap` CI jobs (linux **and** windows)"* — there has
  never been a Windows bootstrap job; the matrix's only Windows runner is `installer-unit`, which
  exists for the path-separator/CRLF bug class and builds no scaffold. So "green on Windows" has
  never meant "a Windows scaffold is green". And the local pre-flight block, whose own header
  says *"This list is the whole of what CI blocks on"*, omitted **four** blocking `machinery-lint`
  checks (`check-escape-registry`, `check-tier-coverage`, `check-ramp-ledger`,
  `check-dependency-channel`) — so following it exactly is how a maintainer goes red in CI on
  four checks they never ran, which is the failure the paragraph above the block warns about.

- **`tools/web-route-allowlist.json` would have shipped `owned`,** because `owned` is what a new
  `tools/` file defaults to and its mobile twin's `seeded` classification is an explicit list
  entry. The gate's own failure text tells a consumer to add a row to it; `check-gate-integrity`'s
  surface is `/^tools\//`, so an owned file there is sha-pinned. The harness would have issued
  two contradictory demands at once — *edit this file* and *your hash moved, restore it* — and
  `update` would have reverted the edit anyway. It is the same defect 0.2.0 fixed for six other
  reviewed-data files, found this time by `scripts/check-escape-registry.mjs` in the same commit
  that created the file.

- **`role="status"` and `role="progressbar"` are both lint errors on the web half**, and the
  divergence from mobile is the platform rather than an inconsistency. jsx-a11y's
  `prefer-tag-over-role` requires the ELEMENT where HTML has one, and every a11y rule here is an
  error. So the new `loading.tsx` surfaces are `<output>` (implicit polite `status` live region)
  while their mobile counterparts stay `role="progressbar"` on a View, which is the only thing a
  View can be. A role attribute is a promise to assistive tech; the element is the thing itself.

## [0.5.0] — 2026-08-07

**The accounting release.** Every claim in this repository is supposed to be checkable by
someone who does not trust it. This release turns that rule on the harness itself, and the
same defect turned up everywhere it looked: **a control asserted that nothing resolved**.

**BREAKING CHANGE — eight escapes close.** The affected population is **every released
vintage below 0.4.0**: `0.1.3`, `0.2.0`, `0.2.1`, `0.3.0`. A 0.4.0 install meets no
deadline. That population is not prose here — `template/migrations.json`'s
`0.5.0.rampExpiry.affects` states it as data and `scripts/check-ramp-ledger.mjs` reds if it
disagrees with what the shipped call sites compute. Six of the eight open at `minVersion
0.3.0` and two at `0.4.0`, so a `0.3.0` install meets exactly two. As always,
`pnpm validate 2>&1 | grep 'RAMP EXPIRED'` is the only honest count for a given tree;
`docs/runbooks/harness-upgrade.md` carries a section per expiring gate. **The eight
`rampNote` wrappers were NOT deleted** — they expire by version comparison, which is the
mechanism working rather than being removed.

### Security

- **The shipped scaffold was pinning a known-vulnerable framework.** `next` moves
  `16.2.7 → 16.2.11`. The [July 2026 Next.js security release](https://nextjs.org/blog/july-2026-security-release)
  (2026-07-20) patched **nine CVEs, four High**, and all four land on surfaces this
  template ships by default: CVE-2026-64642 (middleware/proxy bypass), CVE-2026-64641
  (Server Actions DoS), CVE-2026-64645 and CVE-2026-64649 (SSRF). No gate in the 31-step
  chain reddened on it, and neither osv lane could: the PR lane is diff-aware, so a pin
  already in the tree is never "newly introduced".
- **`tools/framework-floor.json`** — the security floor as reviewed data, judged by
  chain step 11 against the RESOLVED `pnpm-lock.yaml`, keyed by MAJOR LINE (a flat minimum
  would red a consumer legitimately on a patched older line). Clockless and offline;
  whether the review is still FRESH rides the new scheduled `floor-review` job in
  `osv-scan.yml`, never a PR. Harness-owned, so a new advisory reaches existing installs,
  and sha-pinned by `gate-integrity`, so a lowered floor cannot land unreviewed.
- **The only delivered erase path read deprecated key names.** The `delete-account` Edge
  Function read `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` only. Both still work
  today, and stop the moment a project disables legacy keys — the step Supabase's own
  migration guide asks for, with the keys deprecated by the end of 2026. It now reads
  `SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS` (JSON objects keyed by name), the
  CLI's singular local forms, then the legacy names. `verify_jwt` is unaffected.
- **`web-build`** — a path-filtered lane scanning `apps/web/.next/static/**` for
  service-role keys, `sb_secret_`/`sk_live_` prefixes, DSNs and private-key headers.
  `build-check.mjs` was `const APP = 'apps/mobile'` while
  `docs/security/sandbox-and-supply-chain.md` said the build gate greps the exported
  bundle, unqualified. `.next/server/**` is deliberately not scanned.
- **`store-policy.json` `androidTargetSdk.floor` 35 → 36.** Google Play requires API 36
  for new apps **and updates** from 2026-08-31.

### The controls that were asserting nothing

- **`scripts/check-escape-registry.mjs`** — the reviewed-data set was enumerated three
  times by hand and nothing compared the copies, in a file whose own header warned the
  drift would be invisible. First run found three, and the sharpest was unpredicted:
  `tools/security-headers.json` had **no write-guard rule at all**. Guard-rule ids
  116 → 119.
- **The deadline ratchet.** `docs/runbooks/harness-upgrade.md` promised consumers "there is
  no flag that extends a deadline". Nothing checked it: editing `until: '0.5.0'` to
  `'0.6.0'` bought a green release. The ledger now compares every deadline against the
  **previous release tag's tree** — the one artifact a working-tree commit cannot rewrite
  in lockstep — and reds unless a `rampExtensions` record names the file, the versions and
  the reason. Its one residual hole is stated in the source and pinned by a test.
- **`Target` became a control.** Three rows carried `Target: 0.5.0` under a sentence
  calling Target "a commitment, not a wish", and nothing read the column. `docs-sync` now
  re-derives whether an arrived Target's gate still hard-codes one product surface.
  `build`'s was discharged; `i18n` and `route-manifest` moved to 0.6.0 in the diff that
  shipped the check.
- **"Exists" is not "ran".** Eleven tier rows named `web-e2e` or `perf-lane` as their
  compensating control. Both are path-filtered, and `summarize-gate.mjs` greens over a
  skipped lane after naming it. Nine rows now say `(path-filtered)`, and the gate requires
  it. The resolver also stopped reading one hard-coded workflow while eight ship, and
  stopped silently exempting the two rows that name a `.mjs` script.
- **`scripts/check-dependency-channel.mjs` + `dependencyObligations`.** 0.4.0 shipped an
  owned config importing `eslint-plugin-jsx-a11y` against a pin no upgraded tree had, and
  eslint died before linting a file — the whole `lint` step, not one rule. `update` now
  emits a machine-readable obligation and `doctor` reds until it is met; it never writes a
  seeded manifest. The upgrade lane gained a **second `pnpm install`**: it installed once,
  at the previous tag, so it structurally could not have caught the defect it exists for.
- **`scripts/chain-budget.json`.** The only chain budget anywhere was an inline
  `[ "$elapsed" -gt 120 ]` in a shell script. `validate.mjs` now emits one
  `VALIDATE_TIMINGS` line and a per-step budget judges it — including an **unbudgeted step
  is a red**, which is what stops a future release spending against a total nobody holds.
  `measuredMs` ships as `null`: ceilings are policy, measurements are not portable.

### Fixed

- The mobile CI paths-filter omitted `packages/**` while the web filter enumerated seven
  package paths. `packages/contracts` is imported 27× by the app, so a change to it skipped
  both 120-minute device lanes.
- The upgrade lane runs **four baselines in parallel** (`v0.1.3`, `v0.2.1`, `v0.3.0`, and
  the previous release) instead of two. Leg A is kept, not replaced: it is the only leg
  that reaches `graduate`'s success branch.
- The lane's expiry judgement moved out of inline shell into
  `scripts/lib/ramp-verdict.mjs`, so the assertion separating "an expiry fired" from "an
  expiry was supposed to fire and silently did not" is runnable by whoever is editing the
  code it guards.
- **Executing the new lane found two defects in the new lane** — both in the
  dependency-obligation proof above, and both invisible to review. Its `node -e` block
  destructured `process.argv` as though `argv[1]` held a script path; under `-e` there is
  no script path, so the first argument IS `argv[1]` and the body was handed `undefined`.
  Then the assertion that the lockfile MOVED was written as `git diff --name-only`, but the
  scaffold's baseline commit is taken before the lane's first install, so `pnpm-lock.yaml`
  is untracked for the whole run and a diff over tracked files can never name it — the
  obligation applied, pnpm reported `+ eslint-plugin-jsx-a11y 6.10.2`, and the assertion
  reddened anyway. It compares a content digest across the install now. A proof that has
  only ever been read is not a proof.
- The lane prunes stale git worktree registrations before adding its own, so an interrupted
  run no longer bricks every later one at exit 128. CI gets a fresh checkout and never saw
  this; a maintainer's laptop saw it permanently, and a lane only CI can run is a lane that
  gets found wrong on the PR.
- **And then it found four more, in the release's own new work.** Every one of them is a
  control that reviewed as correct:
  - `parseLockVersions` stripped pnpm's peer decoration with `/\([^)]*\)/g`, which cannot
    match a NESTED group. Real keys nest
    (`next@16.2.7…(react-dom@19.2.3(react@19.2.3))(react@19.2.3)`), so it removed the inner
    pair, left the outer `)` stranded, and parsed the version as `16.2.7)`. That did not
    equal the `16.2.7` from `packages:`, so step 11 reported the same four CVEs twice, once
    against a version string that does not exist. It truncates at the first `(` now — a
    package name cannot contain one. The test fixture used a flat suffix and passed
    throughout; it carries the real nested shape now.
  - **`sb_secret_` cannot be value-scanned on a Hermes bundle at all**, which took two
    measurements to establish. As a bare substring it reddened `build` on every scaffold
    that had run an export: `packages/platform/supabase/src/credentials.ts` ships
    `const SECRET_KEY_PREFIX = 'sb_secret_'` — the constant the runtime uses to REFUSE a
    secret key on a client surface — and the mobile app imports it, so the literal is in
    every bundle by construction. The gate was accusing the code that prevents the leak of
    being the leak. Tightening it to a key SHAPE reddened the identical bytes, because
    Hermes interns its string table contiguously with no delimiter: the observed run was
    `…(received \`%s\`).%` + `sb_secret_` + `_getObserverIDcrk-Cans-CAdd`, which satisfies
    any "prefix plus N characters" rule for a healthy N. No quantifier is safe there. The
    value scan therefore runs on `.next/static`, which is JavaScript text where the value
    sits inside quotes and a shape rule means what it says, with `gitleaks.toml`'s existing
    placeholder allowlist reused rather than re-decided. The mobile surface keeps the NAME
    markers, which is what the gate's own comment already called the greppable half.
    `sk_live_` stays a substring on both, because nothing ships it as a constant — the
    asymmetry is evidence, not oversight.
  - **The template shipped two `.mjs` files that `biome` would rewrite**, so step 1
    (`format`) reddened on every scaffold. The harness repository has no biome of its own —
    it is a scaffold dependency — so nothing at factory level could see it, and the control
    that does see it is `bootstrap-linux` running the real chain on a fresh install. That
    control was not missing; it simply had not been run on this branch. Both files are
    formatted, and a fresh 0.5.0 scaffold now reports 31/31.
- **Executing `web-build` — also new, also never run — found two more.** `next build`
  parses BOTH env schemas, and `Collecting page data` imports the tRPC route, which imports
  `@app/env`, which refuses a partial server environment: the job published only the
  `NEXT_PUBLIC_*` half and could not build at all. It publishes synthetic
  `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_URL` values now — and choosing how to SPELL
  them put two of this repository's own controls in direct opposition. Spelled to be caught
  by the client-bundle scan (avoiding the `example|placeholder|…` vocabulary its allowlist
  exempts), they were rejected within the minute by the `secrets` gate, which reds on a
  key-shaped string in a tracked file and whose remedy text says "prefer making the VALUE
  say so". The gate that scans committed files wins: a real key pasted into a workflow is
  the likelier accident by a wide margin. The comment now states the cost rather than
  claiming the property it lost — the lane does not prove these particular values stayed
  out of the bundle, it proves the scan runs on real `next build` output and reds on a
  key-shaped value planted there. Measured on a real build: 34 client chunks, carrying only
  the quoted `"sb_secret_"` guard constant from `credentials.ts`, and planting a real-shaped
  key in one of them reds the scan.
- **And `build-check.mjs --web` called a FAILED build pure.** Next emits `.next/static`
  during compilation and writes `BUILD_ID` only on success, so the run that died collecting
  page data left 34 client chunks behind — which the gate scanned and passed. In the shipped
  lane the build step fails first and the scan never runs, but that is the job's ordering
  rather than the gate's property, and anyone running it by hand has no ordering. A missing
  `BUILD_ID` is a red now: a partial bundle cannot be judged pure, because the chunk that
  would have carried the leak may simply not have been emitted yet.
  - **The security floor had no way to reach a seeded catalog.** `tools/framework-floor.json`
    is owned, so `update` refreshes it into every install; `pnpm-workspace.yaml` is seeded,
    so `update` cannot raise the pin the refreshed floor demands. The consumer gets a red
    step 11 with a precise instruction, which is correct — and it would have made leg A red
    forever, for the most ordinary reason there is, since leg A asserts a green chain and is
    the only leg reaching `graduate`'s success branch. `scripts/ci/apply-framework-floor.mjs`
    has the lane apply the documented remedy, keyed by major line so a patched 15.x is not
    dragged onto 16. `docs/runbooks/harness-upgrade.md` now tells consumers to expect it.
  - **The lane twice mistook a PREDICTED expiry for an OUTSTANDING finding** — one root
    cause, two assertions, both of which only fired once the tree got clean enough to reach
    them. Leg D is the case: its single expectation is `wiring`, whose expiring site is
    guarded by `if (!declared)` on eslint-plugin-jsx-a11y, and the lane's own dependency-
    obligation step applies that pin four sections earlier. The lane remedies the condition
    and then expects an alarm about it. Two correct features; only executing them together
    showed it.
    - `judgeExpiries` demanded that at least one expiry FIRE whenever a deadline was met —
      in a file whose own header says expected-but-silent gates are reported and never
      asserted. What replaces it is the assertion that is sound: an expiry that fired must
      have reddened the chain, which is the v0.4.0 discarded-result defect exactly. The
      case the old rule claimed to cover is decided statically over every shipped site by
      `check-ramp-ledger.mjs` anyway.
    - §8 then branched on the same predicted set to decide whether `graduate` should refuse,
      and called a correct advance a defect. It keys on the observed chain now, which is
      `graduate`'s actual contract — it re-runs the ramp-aware validate and refuses while
      that is red. The matrix still executes both directions: legs B and C carry real
      findings and get the refusal, legs A and D are clean and get the advance.

## [0.4.0] — 2026-08-06

**The alarm release.** 0.3.0 shipped the clock — it made `until` mandatory and dated
every pre-existing escape `0.4.0` — and said so plainly: *"0.3.0 ships the clock, not
the alarm … nothing reds on a deadline here."* This is the release where those
deadlines arrive.

**BREAKING CHANGE:** an `update` to 0.4.0 can leave an install RED, and that is the
designed outcome rather than an accident. The affected population is **installs whose
`baseVersion` is below 0.2.0** — among released vintages, only **0.1.3**. Every 0.2.0,
0.2.1 and 0.3.0 install meets no deadline here; those checks have been live on it all
along, and a fresh `init` never ramped at all. Do not take a count from these notes:
`pnpm validate 2>&1 | grep 'RAMP EXPIRED'` is the only honest answer for a given tree,
and nine of the twelve sites are adoption seams that fire only when the surface is
genuinely absent. `docs/runbooks/harness-upgrade.md` now carries a section per expiring
gate, in three classes — adopt the surface, fix a real finding, or record applied
history. **If the pile is large, upgrade one minor at a time**: each `graduate` moves
`baseVersion` forward and every ramp at or below it goes inert, so each step shrinks the
next. Jumping 0.1.3 → 0.4.0 is the one path that meets all twelve at once.

Measured on the reference scaffold taken from v0.1.3 straight to 0.4.0 — the release's
own proof, `scripts/ci/upgrade-lane.sh --from v0.1.3` — **six** gates red
(`db-limits`, `gate-integrity`, `query-shapes`, `rate-limits`, `security-headers`,
`tenancy`) and three more meet the deadline but stay silent, because a gate calls its
ramp only when it has a finding to withhold.

### Five defects the upgrade lane found, which nothing else could

The lane gained `--from <tag>` and an expectation set computed from the shipped call
sites (`scripts/ci/ramp-expectations.mjs`), replacing an assertion that reduced to
*"every release must invent a ramp at `minVersion == itself` or fail"* — a rule nobody
chose. Rebuilt, it caught four release-blocking defects in this release's own work:

- **A new eslint plugin has no channel to an existing install.** `eslint.config.mjs` is
  harness-**owned** and refreshes on `update`, while `package.json` and
  `pnpm-workspace.yaml` are **seeded** and the workspace-catalog merge runs only under
  `init`. The static `import 'eslint-plugin-jsx-a11y'` therefore resolved to nothing on
  every upgraded install and eslint died before linting a file — not one rule lost, the
  whole `lint` step. It is resolved dynamically now, `check-wiring.mjs` says so out loud
  (hard at `baseVersion >= 0.4.0`, a dated NOTE below it naming the one-line fix), and
  Canary 29 proves the rules still *fire*, because "resolves" and "enforces" are not the
  same green.
- **A shared module extracted from a clone shipped as an orphan.** `plant-when-absent`
  delivered `apps/web/lib/action-outcome.ts` to existing installs whose only callers are
  seeded Server Actions `update` must never rewrite — so `dead-code` reddened a consumer
  for a file the harness had just handed them. Withheld.
- **`check-rate-limits.mjs` discarded `rampNote`'s return value.** Expiry and
  already-live are the same value (`false`), so at the deadline it printed
  `RAMP EXPIRED` and then called `ok()` and exited 0. It shipped that way for three
  releases and this release's notes were counting it.
- **The `migrations` expiry had no legal sweep.** Both remedies live *inside* the
  migration and the append-only rule reds any edit to a committed one — a red whose only
  in-file fix is a different red.
- **`gate-integrity` accused consumers of editing files `update` had just rewritten.**
  `vitest.config.ts` and `eslint.config.mjs` are harness-owned, so any release that
  changes them leaves both dirty against the consumer's last commit — and the
  commit-not-dirty rule reported "threshold-bearing config modified but NOT COMMITTED"
  about files they had never touched, on the run that delivered the upgrade. It now uses
  the same manifest-hash discriminator the planted-escape-list case got in 0.3.0: bytes
  matching the installer's record are a refresh, one byte of tuning on top is still red.

### The alarm, and the machinery that computes it

- **`scripts/check-ramp-ledger.mjs`** — the deadlines a release is responsible for,
  computed rather than remembered. It reds a ramp whose `minVersion` predates this
  lineage's oldest tag (unreachable on every install that has ever existed) and a call
  site whose result is **discarded** (the deadline then changes nothing). Its first run
  corrected this release's own blast radius from 18 sites to **12**: six carried
  `minVersion` 0.1.0/0.1.2, below the v0.1.3 floor, and three surveys had called them
  "expiring". Those six are **deleted** and their checks now run unconditionally.
- **`tools/migrations-allow.json`** (tolerated-absent, in `ESCAPE_LISTS`) — the
  acknowledgement for applied history, bounded three ways: it exempts a **(file, rule)
  pair** and never a file, the migration **must already exist at the diff base** so one
  written today cannot be exempted at all, and a **stale entry reds**.
- **Upgrade leg B** (`--from v0.1.3`) executes a real `RAMP EXPIRED`. Leg A structurally
  cannot: it installs the previous release, so its `baseVersion` is already at or above
  the `minVersion` of every ramp old enough to expire, and `rampNote` returns false at
  its first guard before reading the deadline.

### The web enforcement gap, closed

- **`web-unit` vitest project** over `apps/web/lib`, with six seed suites so it is not
  vacuous. Found and fixed a live defect while writing them: Vitest 4 uses **oxc**, not
  esbuild, so the shipped `esbuild.jsx` config key was silently ignored.
- **`diff-coverage` `SRC_RE` was wrong twice** — it matched neither `apps/web` (which has
  `app/` and `lib/`, no `src/`) nor any **layered** package (`platform/*`, `verticals/*`,
  i.e. the kernel, the Supabase seam and every feature domain), while the gate described
  itself as holding "every CHANGED source file". Widened, ramped at `minVersion 0.4.0`,
  and Canary 27 proves both directions: `apps/web/lib` is judged and `apps/web/app`
  deliberately is not, because a root no runner measures has no green path.
- **`duplication`** walks the layered groups and `apps/web/{app,lib}`; the two clones
  this exposed are extracted, not exempted (Canary 28).
- **`jsx-a11y`** for the web half, every rule an error.

### Tiers, claims, and a parser that had stopped asking

- **`scripts/check-tier-coverage.mjs`** — every single-surface gate must declare its
  surface. It found **13** undeclared tiers, not the 5 found by hand.
- **`check-docs-sync.mjs` now reads the tiers table BY COLUMN NAME.** Its positional
  parser answered a seven-column table with *zero rows*, so the file that declares every
  one-surface gate read as declaring nothing — and the `Compensated by` liveness
  assertion beneath it silently stopped running. That half had shipped in 0.3.0 with no
  can-fail proof at all; it has six now.
- **Five stale chain-count claims fixed**, including `docs/harness/README.md` saying
  "21-step chain" for three releases — in a file installed into every consumer.
  `check-claims.mjs` derives over the shipped doctrine, the runner header and the README
  status line, so they cannot rot again.
- **The test suite stopped checking less than CI.** `HARNESS_ALLOW_SELF_EDIT=1` — which
  must be exported to edit the enforcement surface — leaked into every spawned hook and
  disarmed **138** write-guard deny cases. They did not fail; they stopped asserting, and
  the reds read as environmental noise. Sanitized at the spawn helper, with two ENV
  HYGIENE tests that keep it fixed in both directions.

## [0.3.0] — 2026-08-05

**The closed-surface release.** The governing finding is one sentence: the
harness's enforcement surface was not closed over itself, and in several places it
**claimed enforcement it did not perform**. Every gap below was green on 0.2.1 —
not because a rule judged it safe, but because no rule looked.

Chain **29 → 31** (`wiring` step 3, `secrets` step 4). Shipped hooks **5 → 6**.
Guard-rule ids **91 → 116**. quality-gate jobs **12 → 13**. Canary steps **38 → 40**,
and the lane closure went from one workflow to **all eight**.

### The clock, and the lane that proves an upgrade (blocks everything else)

- **Ramps expire.** `rampNote()` now REQUIRES an `until` deadline; a call site
  without one throws. Before this, "shipped ramped" meant "shipped disabled,
  indefinitely" across 20 call sites in 16 files: the check printed an advisory
  NOTE — in CI too — and the only thing that ever re-armed it was a human running
  `graduate`, which nothing nagged. Expiry is measured against **`harnessVersion`**,
  not `baseVersion`, and that is the whole mechanism: `installedHarnessVersion()`
  already carried the comment *"a deadline measured against baseVersion is a
  deadline its own beneficiary controls"* and had one caller. The code now says what
  the comment already said. **0.3.0 ships the clock, not the alarm** — pre-existing
  ramps are dated `0.4.0`, new ones `0.5.0`, and nothing reds on a deadline here.
- **`upgrade-linux`**, a new selftest lane: `init` at the previous release tag →
  `pnpm install` → HEAD's `update` → prove green. It asserts what only an upgraded
  install can show — the injected chain steps arrived, the planted data files are
  there and the tolerated-absent ones are not, `doctor` exits 0 or 2 but never 1,
  the chain is green, every ramp NOTE names its deadline, and `graduate` **refuses**
  while those NOTEs stand (the first CI execution of its counting behaviour). The
  0.2.0 changelog records an update-planted defect found "by running the real
  upgrade, not by reading the plan" — a manual act that until now had no CI
  successor. **No `migrations.json` record is trustworthy until this lane runs.**

### The trust path stops depending on things nothing checked

- **The executable bit leaves the trust path.** Every hook command is now
  `node "$CLAUDE_PROJECT_DIR/…"`. Hook commands were bare paths relying on `+x`, and
  `check-gate-integrity` hashes CONTENT and never MODE — so `chmod -x` on the Stop
  hook silently disarmed the turn gate while every sha256 still matched. A structural
  fix that deletes the vulnerability beats a check that detects it, and it avoids a
  win32 exec-bit skip that would have violated the skip-is-never-a-pass doctrine.
  `gate-integrity` now asserts wiring BY VALUE (every command names `node` and an
  existing file); a `chmod-protected` bash rule ships as a tripwire, not the control.
- **MCP containment.** A sixth hook, `pretool-mcp-guard.mjs` on matcher `mcp__.*`.
  The `PreToolUse` matchers were literally `Bash` and `Edit|Write|MultiEdit`, so an
  `mcp__` tool call matched **no hook at all**: a Supabase MCP `apply_migration` or
  `execute_sql` reached the database with no guard in its path, no write-guard SQL
  rule judging the statement, no migration file for `check-migrations` to see, and no
  line in the PR diff — three enforcement layers stepped over by one call, with every
  gate green afterwards. The registry moved from prose to data
  (`tools/approved-tools.json`), making `docs/security/approved-tools.md`'s
  three-release-old default-deny declaration real for the first time; the doc is now
  the rendered view of the data, held in lockstep by `docs-sync`. `NotebookEdit`
  joined the write-guard matcher.
- **Guard closure.** `WRITE_PROTECTED` gained `.github/CODEOWNERS` — the compensating
  control ~ten gate failure messages cite in their own text, and which appeared in no
  write rule, no shell pattern and no permission deny — plus `.gitignore`,
  `renovate.json`, `.claude/hooks/**`, `.claude/statusline.mjs`, `stryker.config.mjs`,
  `commitlint.config.mjs`, `tools/ci/**`, the PR template, the actionlint/zizmor
  configs and this release's data files. New **disarm-verb** tripwires for the
  commands that neutralize a control without writing a byte to it: `chmod`, plain
  `rm`, `truncate`, `mv <protected>` away, and `git checkout <rev> -- <protected>`
  (the plain `git checkout -- <path>` the gate messages prescribe stays allowed —
  a guard that denies its own remedy teaches the wrong habit). `package.json` stays
  agent-editable but a new `npm lifecycle script` content rule denies
  `preinstall`/`postinstall`/`prepare` outside the allowlisted `lefthook install`.
  The blanket `^\.claude/` content exemption narrowed to the surfaces it was written
  for (the guards, which must contain what they ban, and the prose).

### The chain closes over itself

- **The Stop chain has a frozen floor.** `tools/stop.floor.json`, and the hook runs
  the **union** of the local config and that floor: a step deleted from
  `STOP_HOOK_STEPS` still runs. `harness.config.mjs` is manifest mode `config` and
  gate-integrity skips non-`owned` entries, so nothing hashed the list of checks that
  decide whether a *turn* may end. Living under `tools/` puts the floor inside the
  existing hashed surface for free, without flipping the config to `owned` — projects
  may still append; never subtract. A corrupt floor is a loud NOTE, not a bricked
  turn, chosen deliberately over the alternative. `check-i18n` and
  `check-mobile-perf --closure` — two Stop steps that appeared in **no workflow** —
  joined the `unit` job.
- **`gate-summary`**, the one check an enterprise can mark required: `needs:` over
  every job, `if: always()`, delegating to a testable `tools/ci/summarize-gate.mjs`.
  A **skipped** path-filtered lane is recorded BY NAME rather than counted as a pass,
  and an **empty needs context exits 1** — a summary over nothing is not a pass.
  (Deliberately cut: a `.github/rulesets/main.json` artifact. Whether a ruleset was
  *adopted* is readable only through the GitHub API with credentials, so shipping a
  hash-pinned file nobody can prove was applied would ship a member of the very class
  this release deletes.)
- **gate-integrity closes over every threshold-bearing config**, in two tiers split by
  whether human tuning is legitimate. Hash-pinned (ramped): `.mcp.json`,
  `lefthook.yml`, `.gitleaks.toml`, `renovate.json`, the actionlint/zizmor configs.
  Judged by COMMIT instead: `vitest.config.ts` (the aggregate thresholds **and**
  `PER_FILE_FLOORS`), `apps/mobile/jest.config.js`, `eslint.config.mjs`, `biome.jsonc`,
  `knip.json`, `.dependency-cruiser.cjs`, every `tsconfig*.json`, `.gitignore` —
  uncommitted-dirty at gate time is red, a committed reviewed raise stays green
  forever. CODEOWNERS is deliberately **not** hash-pinned: a pin guaranteed to break
  on correct use is a gate everyone learns to ignore.
- **`wiring`** (step 3): `doctor`'s invariants become a chain step. Five load-bearing
  invariants had exactly one check between them and **nothing ran it** — `doctor` is a
  command a human types. Asserts all six hooks wired, `pnpm validate` still targeting
  `tools/validate.mjs`, `CLAUDE.md` a pure `@AGENTS.md` include, `VALIDATE_STEPS`
  containing its frozen floor, the **permission posture**
  (`disableBypassPermissionsMode == "disable"`, `defaultMode != "bypassPermissions"`)
  as a hard red, and **CODEOWNERS coverage** over every escape list, threshold config
  and enforcement-surface prefix — including the empty-owner spelling, valid syntax
  that silently disables review while reading exactly like a rule. Parked upgrades and
  a dormant lefthook are NOTEs.
- **Retrofit conflicts become evidence.** A `conflicted` manifest mode. Retrofit wrote
  the harness config to a sidecar, kept the target's, and `continue`d **before** the
  manifest line — so the path was invisible to `doctor` and `gate-integrity`, and
  `lint`/`types`/`dead-code`/`architecture`/coverage ran against the target's configs
  with zero harness rules and reported green. The settings merge still **keeps theirs**
  for posture scalars (never ambush a human's permission choice) — but `wiring` now
  refuses to *claim* enforcement over one. `doctor`'s seeded-divergence advisory lost
  its bare `catch {}`.

### The controls a security review opens with

- **`secrets`** (step 4): a hermetic, zero-dependency credential scan inside the
  chain. `lefthook.yml` prints `SKIP secrets scan` without the gitleaks binary and
  `gitleaks.yml` only scans after a push, so a turn could end green with a
  service-role key in a tracked file on any machine without the tool. Deliberately
  **not** a Go-regex translation of `.gitleaks.toml` — a silent dialect difference
  between two scanners is worse than one scanner — so it asserts **rule-id lockstep**
  between the two instead, both ways. Findings never echo the matched value. Each rule
  self-tests against a synthetic positive at startup, so a decayed regex reports
  ITSELF; scanning zero files is a hard FAIL.
- **`getSession()` and the service-role credential become lint rules over the whole
  server graph.** Two custom rules join the six that already ship, so they run inside
  `lint` with full AST precision. The doctrine's own "single most consequential line"
  was guarded by a write-guard regex scoped to `if (anyRel(/^apps\/web\//))` and gated
  on whole-file writes — an `Edit` inserting `.auth.getSession()` into `packages/api`,
  a vertical's server barrel or an Edge Function passed every layer. **These are the
  only unramped new controls in the release**, because a pre-existing violation here is
  an authentication bypass, not a style debt.

### Parity, evidence, and the numbers

- **The authoring surface stops teaching an API that does not exist.** `trpc.ts`
  exports `orgProcedure`/`ctx.org`; ten authoring surfaces taught
  `memberProcedure`/`ctx.member` (13 and 7 occurrences, zero `orgProcedure`).
  `scaffold-slice.mjs` wrote a non-resolving import into every new slice, and
  `/verify-invariants` hunted for a `ctx.member` string that cannot appear in real
  code — so that review step was vacuous on every codebase it ever ran against.
  Eleven layers of enforcement could not see it, because every one judges CODE and
  this was a lie in the PROSE that tells an agent what code to write. All ten rewritten,
  `references/dal-dto.md` corrected end-to-end, and a closed token map
  (`tools/doctrine-symbols.json`) now holds the agent surface against the module that
  defines the symbols, both directions. `docs/adr/**` is deliberately out of scope: an
  ADR that narrates the symbol it deleted is honest history.
- **A stub Maestro flow stops satisfying the mobile-perf closure.** The gate *printed*
  "launchApp + reach the route + assertVisible its surface" and then checked only that
  the file existed. It now scans the YAML: `appId`, `launchApp`, a proves-something
  step, a reach step for non-root routes, and no two flows byte-identical. The naive
  "require `assert*`" rule would have broken fresh-scaffold-green — the harness's own
  `buildRouteFlowYaml()` emits `extendedWaitUntil: visible:` and no `assert*` at all —
  so both spellings are accepted and the generator's output is now a lockstep fixture
  of the gate.
- **The web enforcement tier stops being a lie and becomes a written, dated decision.**
  `docs/harness/enforcement-tiers.md`, one row per one-surface layer naming what it
  covers, what it does not, why, the compensating control, and a target release — with
  a `docs-sync` shape check asserting every row carries all five fields and every
  compensating control **resolves to a live step or job** (*a compensating control
  nobody runs is not a control*). Three false claims die with it:
  `apps/web/vitest.config.ts` said the root config listed it in `projects` (it declares
  only `unit-node` and `rls`), the root config's header claimed apps/web coverage its
  include list does not contain, and diff-coverage's "floors on every CHANGED source
  file" was overstated for half the product. The `web` CI path filter widened from the
  hardcoded seeded packages to `packages/verticals/**`.
- **Factory posture parity.** The factory allowed bare `Bash` with `acceptEdits`, set
  no `disableBypassPermissionsMode`, wired no PostToolUse hook, and its write-guard
  omitted `installer/**` (only `installer/lib/`) and `template/migrations.json`. All
  fixed; `stop-factory-gate` gained the three machinery checks that were CI-only
  (`eslint`, `tsc --noEmit`, `knip`), skipping loudly when the toolchain is absent.
  `check-canary-coverage`'s lane closure generalized from the single hardcoded
  `quality-gate.yml` to **all eight** shipped workflows — codeql, gitleaks, osv-scan,
  actions-lint, adr-guard, migration-safety and mutation were every one of them a
  blocking lane a reviewer reads as enforcement, and not one had to carry a red-proof.
- **The numbers move together.** `check-claims` gained two derivations: the executed
  canary count, counted from the selftest matrix and its `scripts/ci` helpers rather
  than hand-authored, and the gates-catalog's opening chain count — which read
  "26-step" against a 29-step chain, live, for two releases, in the very document a
  reader consults to find out how long the chain is.

### What the upgrade lane caught

Three release-blocking defects, all invisible to a fresh scaffold and all found by
running the real upgrade rather than by reading the plan — which is the entire case
for the lane:

- **The agent-surface lock did not travel with an update.** `writeAgentsLock`'s
  `adopt` rule (never rewrite an existing lock) is right about a CONSUMER's edits and
  wrong about the harness's own: this release rewrote ten owned agent-surface files,
  so the lock still described the old bytes and `prompts` reds on every consumer for
  a change they did not make, cannot review, and could only clear by running the very
  generator three separate guards exist to keep them from running. Fixed per-entry:
  `update` re-records only the paths it actually WROTE, which it does only when the
  on-disk bytes still matched the recorded sha. A locally-modified agent file is
  parked, absent from `written`, and keeps redding — because that edit is exactly
  what the lock exists to surface.
- **`docs-sync` red an install for a step the harness itself injected.** `AGENTS.md`
  is seeded, so `update` correctly never rewrites it, while `migrations.json`'s
  `configSteps` injection does add steps to the chain — leaving a consumer's
  documented gate list one release behind through no act of theirs. The fix is not
  "ramp it": the drift is now classified. If every documented gate still exists in the
  same relative order, the difference is steps that were ADDED, and the ramp (dated
  `0.5.0`) applies. A documented gate that no longer exists, or a reordering, is the
  project's own drift and stays a hard red at every vintage.
- **`gate-integrity` accused the consumer of widening a hatch the harness had just
  planted.** Escape lists may not be DIRTY at gate time, so that a widening lands in a
  reviewable diff — but `update` plants a NEW escape list (`tools/approved-tools.json`
  here; `tenancy.json`, `db-limits.json` and `security-headers.json` in 0.2.x, before
  there was a lane to notice) and a planted file is untracked, hence dirty. Classified
  rather than ramped, on a discriminator that is exact at every vintage: untracked AND
  byte-identical to the sha the installer recorded means nobody has tuned it, which is
  a plant and not a widening — so it is a NOTE. A hand-created escape list has no
  manifest entry and a tuned one no longer matches, and both keep the hard red.
  Caught in CI and not locally, which was itself the finding: the lane inherited
  `HARNESS_ALLOW_SELF_EDIT=1` from the maintainer's shell and so ran with the
  commit-not-dirty rules disarmed. It now unsets it — the lane simulates a consumer,
  and a consumer does not hold the escape hatch.

### Deferred, with the reason

The web enforcement **machinery** (a vitest lane for `apps/web`, `SRC_RE` widening,
jsx-a11y, duplication/mutation roots) is 0.4.0 — not merely "cannot ship piecemeal":
widening `SRC_RE` without the unit lane produces a gate with **no green path**, since
no runner measures `apps/web`, and the only edit that restores green is lowering the
floors, i.e. the harness reward-hacking its own bar. Also deferred: the Supabase
`[auth]` posture gate (a CLI-compatibility spike goes first — seeding new `[auth]` keys
against a caret-ranged CLI pin can make `supabase start` refuse, which reds the one lane
that *is* the fresh-scaffold-green proof), the enforcement-tier coverage closure that
forces the next gate author to declare their surface, and process-verified reviewers
(which must fail closed on an unrecognizable transcript, and must not move the Stop
chain 9 → 10 in the same release that first freezes it).

## [0.2.1] — 2026-08-04

**The metal-preset release.** `init` now asks one more question — `DESIGN_TOKENS`,
`default` or `metal` — and the answer selects which vendored token values the
scaffold is born with. The `metal` preset replaces the default OKLCH ramps with
values vendored from [oklch-metal-tokens](https://github.com/BhodiSea/oklch-metal-tokens)
v0.5.0: design tokens whose colours are spectral integrations of measured
material optics. Nothing about the enforcement story changes — the chain is
unchanged at 29 steps, the semantic token vocabulary is unchanged, and a metal
scaffold is gate-green with zero edits, which is the release's governing proof.

### Added

- **The design-token preset seam.** A new `DESIGN_TOKENS` placeholder
  (`default` | `metal`) rides every existing answer rail: interactive prompt,
  `--set`, `--yes`, `--force` carry-over via `manifest.answers`, and validation
  that fails loud before a single file is written. Selection is a stack-plan
  overlay (`installer/lib/copy.mjs` `walkStack`/`planStack`): same-installPath
  entries from `template/presets/tokens-metal/` replace their stack twins in
  place, preset-only files append, and both `update` and `doctor` resolve the
  overlaid bytes so `--refresh-seeded` on a metal install pulls metal content,
  never the default's. Deliberately NOT a module — a preset is an init-time
  choice; `enable tokens-metal` stays "unknown module" by construction, and a
  pre-0.2.1 manifest (which IS a default install) is backfilled on `update`.
  The chosen preset is recorded in the scaffolded design-tokens README as a
  rendered provenance line.
- **The metal preset itself.** Copper is the accent (the upstream palette's
  brand anchor), osmium the neutral, hematite the danger red, and verdigris —
  copper's own corrosion product, upstream's colour-vision-validated green —
  the success hue. The derivation honours both systems' doctrine ("hue and
  chroma belong to the material; lightness belongs to you"): the harness
  lightness curve is kept verbatim because it is what positions the WCAG
  contract, hue interpolates the material's measured rungs by lightness, and
  chroma is min(material trajectory, measured ceiling, 90% of max in-gamut).
  All ten contract pairs clear their floors in both themes with margin (worst:
  light success/surface at 5.35 vs the 4.5 floor); the committed
  `web.css`/`native.ts` artifacts are generated by the package's own fail-closed
  generator, and the mobile splash lockstep (`CANVAS_DARK = '#090d15'`) ships in
  the same overlay the expo-policy gate re-asserts it against.
- **The metal rim system on web.** When metal is chosen, `apps/web/styles/metal/`
  carries the upstream Fresnel-derived edge/rim system (`ramps.css`, `edges.css`,
  `rims.css`, `a11y.css` byte-verbatim from the upstream dist; `index.css`,
  `brand-copper.css` and `edges-dark.css` materialised for this scaffold's
  Tailwind v4 + `[data-theme]`/media theming). Depth arrives as two 1px inset
  box-shadows rather than gradients, so axe-core's background walk — which reads
  `background-color`/`background-image` only — keeps its contrast assertion
  intact under every rimmed surface. The dark polarity mirrors the generated
  `web.css` selectors exactly, including the `:not([data-theme='light'])` guard.
  Third-party provenance is recorded in `REUSE.toml` (upstream's installed
  tokens are `Apache-2.0 OR 0BSD` — identical to the template claim).
- **`@app/design-system-native` finally has the generator its source always
  documented.** `scripts/gen-preset.mjs` (thin CLI, `--check` exits 2 on drift),
  the committed `tailwind-preset.cjs` it emits, and a freshness test at
  `tests/unit/preset.test.ts` that regen-diffs the artifact on every `vitest`
  run — the same contract `@app/design-tokens` has always held. The test lives
  outside `src/` with its own non-composite lint program (`tests/tsconfig.json`)
  because the package program types react-native ambients with no `node`, and
  the two ambient sets must not meet. Colours emit as `var(--color-*)`
  references, so the committed preset is byte-identical across token presets.

### Changed

- `installer/cli.mjs` USAGE documents the new placeholder; the selftest matrix
  gains a metal render-smoke pass and a `metal-bootstrap` job that proves the
  full gate chain on a metal scaffold with zero edits.
- `template/migrations.json` gains the 0.2.1 record: the three
  design-system-native generator files are `seedOnInitOnly` (the committed
  preset is rendered from a seeded token source an existing install may have
  retuned), and the preset overlay tree deliberately contributes nothing —
  living outside `base/stack/modules`, it is init-time-only by construction.
- The factory's own `.claude/hooks` stamps catch up to the release version
  (they still read 0.1.3; nothing consumed them, but a wrong number in an
  enforcement file is a wrong number in an enforcement file).
- Scaffold config touches: the vendored `styles/metal/**` CSS is excluded from
  Biome's parser surface (byte-stable third-party files), `cspell.json` learns
  the material vocabulary, and the design-system-native knip entry covers the
  new generator and test surfaces.

## [0.2.0] — 2026-08-03

**The multi-tenancy release.** Every scaffold is B2B org-scoped from `init`, with
isolation enforced in PostgreSQL and proven by gates that can go red. The chain
goes 24 → 29 steps; the Stop chain is unchanged at 9 (two of its steps deepen).

Read the **Fixed** section first. Every defect in it was GREEN on 0.1.3 — not
because a rule judged the input safe, but because no rule looked at it — and
every one was found by EXECUTING the machinery against a real database or a real
scaffold, never by reading it.

### Fixed

Defects in the enforcement surface itself, each verified against the shipped 0.1.3
tree before it was closed. Every one of these was GREEN on 0.1.3 — not because a
rule judged the input safe, but because no rule looked at it.

Three more were found by CI in this release's own code, and each needed a live
database or a real install to see — no amount of reading would have produced them.

- **The per-role resource ceilings did not bind on any existing project.**
  `20260203000100_resource_limits.sql` set `statement_timeout`,
  `idle_in_transaction_session_timeout` and `lock_timeout` on `anon`,
  `authenticated` and `service_role`, and PostgREST went on serving the OLD values.
  PostgREST does not re-read `pg_db_role_setting` per request — it caches role
  settings in its schema cache. Supabase's `pgrst_ddl_watch` event trigger normally
  issues the reload, and it cannot here: **event triggers do not fire for shared
  objects, and roles are shared**, so `ALTER ROLE ... SET` is precisely the one
  statement class that never gets the automatic reload. Measured against a live
  stack: after `ALTER ROLE anon RESET statement_timeout` the catalog row was gone
  and PostgREST still reported `3s`; only after `NOTIFY pgrst, 'reload schema'` did
  it report the authenticator's `8s`. A fresh `supabase start` cannot exhibit this,
  because PostgREST boots after migrations — which is why every local run and every
  CI lane was green, and why the failure was reserved for the only place it costs
  anything: an existing project taking a migration that tightens a ceiling. The
  migration now ends with an explicit `NOTIFY`, and `db-limits` reds on any
  migration that changes a role ceiling without one — checked PER FILE, because a
  `NOTIFY` in an older migration reloaded PostgREST when *that* migration ran and
  does nothing for the one being added today. This was surfaced by Canary 23, which
  had the same blind spot and was passing: it reset the ceiling live without
  reloading, so it was measuring the cache rather than the ceiling. Also corrects
  the ADR and `db-limits.json`, both of which claimed a per-request read.
- **A departed employee blanked their org's notes list.** The org-scope migration
  demoted `notes.owner_id` to nullable attribution (`ON DELETE SET NULL` — in B2B
  the data controller is the org, so removing an employee must not delete the
  company's rows), and `NoteRecord.ownerId` stayed `z.uuid()`. A non-null contract
  over a nullable column is not stricter, it is wrong, and it failed in the worst
  available way: the row parse sits inside `listNotes`' try/catch, so ONE orphaned
  row returned `contractDrift` for the whole PAGE — an internal error for every
  reader in the org rather than one card losing its byline. Every unit test stamped
  an owner, so the null case existed only against a real database. Now nullable,
  with regression tests at both the parser and the DAL. Nothing in TypeScript
  authorized on the field — the DELETE policy's `owner_id` arm is SQL and reads the
  column — so widening it costs no boundary.
- **Three source files were invisible to `grep`.** `tools/lib/query-shapes.mjs`,
  `check-mutation-ratchet.mjs` and `tests/installer/migrations.test.mjs` contained
  literal NUL bytes (typed as separators in string literals rather than written as
  the `\u0000` escape). A NUL makes a file `data` rather than text, and `grep` skips such files
  in SILENCE — no warning, exit 1, as though the pattern simply were not there. In a
  repo whose thesis is that greps and gates catch things, three of them could not be
  searched, one being the mutation ratchet itself. All now use the escape, which is
  the same character: the mutation identities are `sha1`-identical, proven before
  the edit landed, so the committed baseline is untouched. `scripts/hygiene.mjs`
  now sweeps every tracked text file for NUL bytes (702 files, binary extensions
  excluded by an explicit short list, and it fails closed if it ever scans zero).
  That it is a sweep rather than a review note is not caution: the defect recurred
  while being fixed — the changelog entry you are reading was itself first written
  with a literal NUL. A defect class that survives the act of documenting it needs
  a machine watching for it.

- **`gate-integrity` reds on the first feature a consumer ships.** Its SURFACE is
  `/^tools\//`, and `tools/generated/*` is regenerated from the consumer's own
  router, event catalogs and DALs — so adding one tRPC procedure changed
  `action-inventory.json` and the gate reported `sha256 mismatch … (tampered or
  hand-edited)`, prescribing a remedy (`restore the file(s) from git`) that undoes
  the feature. Reproduced against a real install: one regenerated inventory is
  enough. A pin guaranteed to break on correct use is not evidence — it is a gate
  everyone learns to ignore, and the habit it teaches is what makes a real mismatch
  invisible. `tools/generated/` is now excluded from the hash surface (113 owned
  files checked, down from 116) and nothing is lost: `contracts` REGENERATES each
  inventory and diffs it every validate, which proves the bytes are TRUE rather
  than merely old, and the write-guard still denies an agent editing them. Verified
  in both directions — the regenerated inventory passes, a touched
  `check-migrations.mjs` still reds.
- **Six escape lists were `owned`, so the harness demanded two contradictory
  things at once.** `db-limits.json`, `security-headers.json`, `audit-columns.json`,
  `pii-columns.json`, `rate-limit-budget.json` and `db-perf-baseline.json` shipped
  outside `SEEDED_FILES`, which put them under the same `/^tools\//` hash pin. The
  gates that read them tell the consumer in their own failure text to edit them and
  commit the widening under CODEOWNERS; `gate-integrity` then told them their hash
  had moved and to restore it from git; and `update` reverted the edit regardless.
  All six are now seeded, which is what `check-gate-integrity`'s own ESCAPE_LISTS
  header always claimed they were. `pii-columns.json` is the one that matters most:
  it is the deny list that decides what the audit trail may copy, and a consumer's
  additions to it were being silently reverted on every upgrade.
- **`update` planted the template's query-shape manifest into repos that could
  never regenerate it.** `tools/generated/query-shapes.json` was `owned` while the
  probes that produce it are seedOnInitOnly, so an upgraded install received a
  recording of the TEMPLATE's DAL and a regen-diff that cannot converge — you
  cannot reproduce it from zero probes. The manifest is now seeded and withheld
  alongside its probes, and `gen-query-shapes.mjs` treats "no probes and no
  manifest" as nothing to record. `check-query-shapes` draws the same line from the
  same shared `probeModules()`, so the tree the generator exits 0 on is exactly the
  tree the gate ramps — the two verdicts that must never diverge are "there is
  nothing to record" and "there is something and it is missing".
- **An inert guard rule with a passing canary.** `migration-apply-runner`
  write-protected `tests/migrations/migration-apply.mjs`, a file no template has
  ever shipped and nothing has ever invoked. It had a rule, a hook-contract canary,
  a `settings.json` allow entry and a slot in `check-gate-integrity`'s SURFACE — and
  all four were green, because a deny over a path that cannot exist is satisfied by
  every input. Removed (91 guard-rule ids, down from 92), and `check-canary-coverage`
  now closes the hole structurally: every fully-anchored literal `WRITE_PROTECTED`
  path must name a file the template ships, or a producer recorded by name in
  `GROUNDED_ELSEWHERE` (two entries: the installer writes `tools/agents.lock.json`,
  Claude Code writes `.claude/settings.local.json`). Proven by reconstructing the
  0.1.3 shape — an inert rule WITH a passing canary — and watching it red. The
  closure's own first draft matched nothing, because a regex literal escapes its
  slashes; the ghost-rule proof is what caught it.
- **`update` planted a tsconfig project reference to a package it deliberately
  withheld**, and `tsc -b` died on the first line it read. `tsconfig.json` is a solution
  file and harness-OWNED, so `update` rewrites it from the template — including the new
  `packages/platform/ratelimit` reference — while the package itself is seedOnInitOnly
  (a new Upstash dependency nobody opted into). The result is
  `error TS5083: Cannot read file …/tsconfig.json`, which takes the WHOLE typecheck with
  it, every healthy package included. Found by running the real 0.1.3 → 0.2.0 upgrade,
  not by reading the plan. `pruneMissingProjectReferences` now drops any reference whose
  project will not exist when the run finishes — and "will not exist" is deliberately not
  "is not in the plan", because every withheld file IS in the plan and is skipped later
  in the write loop. That distinction was the bug's second form, caught the same way: by
  re-running the upgrade and seeing the reference still there.
- **A stale harness-authored test no `update` could reach.** The gate-a11y-deep module's
  `apps/mobile/__tests__/a11y-deep.test.tsx` imported `MockRouteHandler` from a
  mock-server that has never exported it. The file is seeded (it lives under `apps/`), so
  `update` skips it forever and the consumer keeps a test that cannot compile. Fixed in
  the template and reached via a sha-guarded `removed` record — deleted before the plan
  loop, re-planted corrected by it. Verified both ways: an untouched copy is replaced, and
  a copy with a local edit is left in place with a note naming the conflict, because a
  hand-tuned accessibility test is the consumer's.
- **The mutation lane was mutating a build-time instrument.**
  `packages/verticals/*/src/data/query-probes.ts` is what `gen-query-shapes.mjs` EXECUTES to
  record the manifest; nothing imports it at runtime, so vitest cannot reach it and all 49
  of its mutants came back `NoCoverage` — 65% of a ratchet failure that said nothing about
  the product. Recording 49 baseline entries would have been the wrong answer to the right
  complaint: the mutation SCOPE was wrong, not the tests missing. Carved out as a PATTERN,
  so a future vertical's probes are excluded the day they land. Its correctness is enforced
  elsewhere and harder — the generator dies if any exported DAL function has no probe, if a
  probe names a function the DAL does not export, or if a probe issues zero chains, and
  `contracts` regen-diffs the manifest on every validate.
- **The DAL's tenant filter had no killing test.** All four `.eq('org_id', …)` call sites
  survived mutation: every one could have its column name emptied and nothing noticed.
  RLS is still the boundary and a policy denial is still what stops a cross-tenant read —
  but that filter also carries a performance guarantee, because `org_id` leads
  `notes_org_id_created_at_id_idx`. Without it the policy filters by org *by scanning the
  table*: correct results, cost proportional to every customer's data. Closed with
  assertions on the column name AND the value, since asserting the value alone leaves
  `.eq('', orgId)` alive.
- **Canary 23 asserted a message that could no longer be produced.** It resets a per-role
  ceiling in the live database and required the SDK resource-limits suite's own failure
  text — but 0.2.0 added the pgTAP `pg_db_role_setting` assertion, and `run-rls.mjs` is
  fail-fast, so the runner now reds *before* the SDK layer ever runs. The canary drove the
  runner, so it was waiting for a string that cannot appear. It now drives the SDK suite
  directly and asserts the catalog layer separately — both halves are independent, and a
  canary watching only one lets the other rot.
- **The docs disagreed about the plan probe, and nothing could see it.**
  `README.md` said there is deliberately no EXPLAIN plan probe while
  `gates-catalog.md` documented one in detail, alongside a capturing pg-proxy and a
  `0002_notes_keyset_idx.sql` that existed in neither tree. Both halves of the real
  answer are true and now stated in both files (no plan assertion in the RLS suite,
  where the cardinality is wrong; the real probe in the path-filtered `db-scale`
  lane), and `docs-sync` asserts the agreement so the contradiction cannot return.
- **A "considered and rejected" record for something the repo had adopted.**
  `gates-catalog.md` still listed **pgTAP** as rejected on the grounds that plain
  SQL checks the same facts — while three pgTAP suites shipped, `pnpm db:test` ran
  them, and CI blocked on them. A rejection record kept after adoption is worse than
  no record: it tells the next reader not to look.
- **`injections.json`'s header mislabelled Canary 17** as a plan-probe red for two
  releases. It is pgTAP's owner-leading-column assertion, and the difference is the
  entire reason Canary 24 exists: Canary 17 must drop the keyset index AND the
  primary key, because either satisfies a leading-column check, while Canary 24
  drops only the secondary index and reds `db-perf` on plan shape with Canary 17
  still green.

- **Six unsorted directory listings in the enforcement surface**, found by the new
  determinism sweep (see Added): `check-contract-drift`, `check-duplication`, `check-prompts-lock`,
  `check-release-lockstep`, `check-reuse` and `installer/lib/detect`. Each fed a list
  whose ORDER reaches an output — package directories, scan roots, prompt files, hook
  files, license files — so error ordering and derived manifests were filesystem-dependent.
  The sweep's own first draft reported four correct call sites out of ten (deferred sorts
  through a try/catch, emptiness tests) and was fixed before the code was: a check that is
  40% noise is a check whose findings get exempted rather than read.
- **The keyset seek was O(page number) — found by the new plan probe, not by review.**
  The shipped DAL expressed its cursor the way every keyset tutorial does, as one
  disjunction covering both lexicographic cases. It is logically correct, it cited
  `use-the-index-luke.com/no-offset` for avoiding exactly this cost, and PostgreSQL
  cannot turn a top-level `OR` into an index range — so the whole predicate lands in
  `Filter:` and the scan still starts at the tenant's newest row. Measured against 1.1M
  seeded rows at page 1000: **1115 rows discarded to return 21, 1798 buffers, 43ms**.
  With the range sent as its own predicate alongside the tie-break: **3 rows discarded,
  8 buffers, 0.1ms**. That is OFFSET's cost wearing a keyset costume, and it was
  invisible to every check in the chain — the index existed, its leading column was the
  tenant key, and its tail was the sort order. `query-shapes` now reds any keyset seek
  carrying no range predicate on its leading sort column; the static rule exists because
  the live probe earned it.
- **`parseIndexes` could not see a constraint added in a multi-action `ALTER TABLE`.**
  `ALTER TABLE t DROP CONSTRAINT c, ADD CONSTRAINT c PRIMARY KEY (…)` — the shape the
  tenant re-scope uses to swap `PRIMARY KEY (id)` for `PRIMARY KEY (org_id, id)` —
  parsed as a pure DROP, because the drop half scanned the whole statement while the add
  half was anchored to the table name. Every consumer of that parser therefore believed
  `notes` had no primary key, silently vacating the leading-column and partition-ready-
  unique rules that depend on it.
- **`schema-rls` collected `ENABLE` and `FORCE` and no negation.** A later
  migration containing `ALTER TABLE x DISABLE ROW LEVEL SECURITY` — or
  `NO FORCE`, or `DISABLE TRIGGER` — matched no pattern, left the table in the
  `enabled` set, and the gate reported it fully covered. The negation set ships
  **unramped**: no legitimate install has ever turned RLS off, so ramping it
  would protect only a tampered tree.
- **`.sql` files reached no write-guard content rule at all.** The guard polices
  source code from `if (!anyRel(/\.(ts|tsx|…)$/)) pass()` down, so the one file
  class where this codebase's authorization boundary is written was checked for
  exactly one thing (`WITH RECURSIVE`). New pure-data table `WRITE_SQL_CHECKS`
  (4 ids, path-scoped) now runs above that gate. Guard table: **71 → 75 rule
  ids**.
- **`migrations` treated only `DROP TABLE|DROP COLUMN|TRUNCATE` as destructive.**
  `DROP POLICY`, `DISABLE ROW LEVEL SECURITY`, `NO FORCE`, `DROP FUNCTION`,
  `DISABLE TRIGGER` and `REVOKE … FROM authenticated` each remove an
  authorization control while leaving the object in place — all shipped
  ADR-free, and all are strictly harder to spot in review than a dropped column
  because the table still exists and every query still returns rows.
- **`check-claims.mjs` counted a hardcoded list of three rule tables.** Adding a
  fourth left the README's number technically true about a surface it no longer
  described. It now derives every rule table from the module's exports.
- **A ramped gate is advisory on FRESH installs, not just legacy ones.** Caught on
  `security-headers` before release: a new scaffold's manifest records the release
  it was built from, which is older than a `0.2.0` ramp until the version bumps —
  so every finding printed as a NOTE and the gate could not go red at all. The
  distinction that was missing: a ramp protects CONSUMER-AUTHORED content from a
  new check, but this gate's subject is a file the HARNESS ships, where there is no
  legacy to protect. The ramp now covers ADOPTION only (the module is absent on an
  upgrading install); once the module is present, wrong values are a hard red
  regardless of vintage. Pinned by a regression test.
- **`gates-catalog.md` claimed a "21-step chain"** while the chain was 24. Stale
  since the 0.1.3 port.
- **The `migrations` DML rule grepped raw text, so it judged function bodies —
  and missed unquoted UPDATEs.** A SECURITY DEFINER RPC's body legitimately
  contains `INSERT`/`DELETE` the migration never executes; the raw-text grep
  would have forced a bogus `-- harness-allow-dml` marker onto every RPC-bearing
  migration. Meanwhile the ancestor regex `UPDATE\s+[a-z"]` + trailing `\b` only
  ever matched a quoted or single-letter table name, so `UPDATE notes SET ...`
  was invisible to the rule entirely (pinned as an ODDITY since the port). DML is
  now judged per STATEMENT via the shared parser: a dollar-quoted body rides
  inside its `CREATE FUNCTION` statement and can never start one, both UPDATE
  spellings red identically, and a leading-CTE `WITH ... DELETE` still reds.

### Added

- **`template/migrations.json` gains its first real record** — it was literally `{}`,
  which meant the upgrade machinery had been shipped but never exercised. The `0.2.0`
  entry injects the five new steps into `VALIDATE_STEPS` (`harness.config.mjs` is
  SEEDED, so injection is the only path into an existing install) and registers 33
  `seedOnInitOnly` patterns. Every path was classified by one question, answered by
  READING the gate: what does it do when this file is absent? Withhold something a gate
  fails closed on and the injected step reds on the first validate after the upgrade;
  plant a migration and `update` has put unapplied DDL in front of a live database.
  So the six new migrations, three schema files, the scale seed, the audit pgTAP suite,
  the whole 0.2.0 web surface, the rate-limit package and the generated artifacts are
  withheld, while `tenancy.json`, `db-limits.json` and `security-headers.json` are
  planted — the first two because their gates fail closed before they can ramp, the
  third so that adopting the module later yields a gate that judges rather than one
  that dies on a missing policy. `rate-limit-budget.json` is withheld for a stronger
  reason than the rest: its ABSENCE is what the gate's ramp keys on, so planting it
  would switch off the protection it was supposed to provide.
- **Every `seedOnInitOnly` pattern must name a path the template ships**
  (`scripts/check-seeded-migrations.mjs`, derived from the installer's own
  `walkTemplate` + `storageToInstall`, so it cannot drift from what `update` computes).
  The field is a pure list read by a prefix/exact matcher and both ways it can be wrong
  are silent: a typo or a path left behind by a rename withholds NOTHING while reading
  as protection. The check was written because the first draft of the 0.2.0 record put
  explanatory comment strings in the array — perfectly valid JSON, and one ending in
  `/` would have silently withheld an entire subtree.
- **The `db-scale` lane asks the manifest whether this install has adopted the surface**
  before it runs, because the workflow file is harness-OWNED (so `update` ships it) while
  the seed and budgets it drives are seedOnInitOnly. It reads `baseVersion` —
  the one record `check-gate-integrity` pins against git history and never lets regress —
  and the asymmetry is what keeps it from being a hole: a pre-0.2.0 baseVersion may skip
  with a `::notice::`, but a 0.2.0+ install MUST carry all three files, so deleting the
  seed to quiet the lane FAILS instead. It runs before `pnpm install`, so an un-adopted
  install spends seconds rather than minutes.
- **`query-shapes`, the 29th gate** (`tools/check-query-shapes.mjs`) — every statement
  the DALs actually issue is BOUNDED and SERVED BY AN INDEX, judged against
  `tools/generated/query-shapes.json`. The manifest is **generated by executing the
  DAL**: `tools/gen-query-shapes.mjs` drives each function through a harness-owned
  recording port and records the builder chain it produced, and `contracts` regen-diffs
  the result. A hand-authored query manifest is a tautology — the same turn writes the
  DAL and the manifest, and the cheapest repair for a red is to edit the manifest.
  The recorder is a **Proxy**, not a fake with methods: it records every call by name,
  so `.range()`/`.offset()` red BY NAME instead of crashing the instrument into being
  taught to ignore them. Two closures keep it honest — generation fails if any exported
  DAL function has no probe (the probe module re-exports its DAL as a namespace, so the
  comparison is against the functions that exist), and fails if a probe issues no query.
  Rules: bounded; no unreviewed builder method; an index whose leading columns are the
  equality set followed by the ORDER BY columns in order and in ONE scan direction (a
  btree walks backwards, so all-reversed is served and MIXED is not); cursor/sort
  agreement; the tenant column present and leading; and no LIMIT above `[api].max_rows`,
  which PostgREST truncates to silently.
- **`db-perf`** (`tools/check-db-perf.mjs`, the new path-filtered **`db-scale`** CI lane)
  — the live half. It applies `supabase/seeds/scale.sql` (2M deterministic rows, a 3%
  whale, `ANALYZE`), impersonates a real member of the largest tenant, and runs
  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on each read shape. It asserts **shape,
  never milliseconds**: the planner chose the index the static gate resolved, no Sort
  above a keyset leaf, no per-row SubPlan, and buffers in the right order of magnitude.
  `SET enable_seqscan = off` is deliberately NOT used — with it the planner uses any
  index, so a table whose only index is useless still yields an Index Scan node.
  **Anti-vacuity:** below `minRows` in `tools/db-perf-baseline.json` it SKIPS loudly and
  FAILS in CI. The seed's row count is overridable; the floor is what stops that knob
  buying a green. **Canary 24** proves it is not redundant: drop the keyset index from
  the live database, change no file, and `schema-rls`, `tenancy`, `query-shapes` and all
  109 pgTAP tests stay green while db-perf reds three ways at once.
- **`query-budget`** (`tools/check-query-budget.mjs`, folded into the existing
  integration lane) — the **N+1 detector**, the one defect `query-shapes` and `db-perf`
  are structurally blind to because both are per-statement. It wraps the live-api-proof
  suite, resets `pg_stat_statements`, and reads the delta filtered to
  `userid = 'authenticator'::regrole`. Anti-vacuity in both directions: a non-zero
  pre-count fails (the reset did not take) and a ZERO post-count fails (the workload
  never reached PostgREST — a budget met by a disconnected instrument is not a budget).
- **The agent surface is hash-locked** (`tools/gen-agents-lock.mjs` → `tools/agents.lock.json`,
  judged by the extended `prompts` gate). `.claude/{agents,commands,skills}` is the most
  privileged prose in the repository — which reviewers exist, what they may touch, what a
  slash command does — and **nothing in the chain noticed it changing**: the `docs-sync`
  roster check reads reviewer FRONTMATTER (name, model, tools) and never the body, where
  the instructions are. Each agent's pinned **model id** is recorded beside its hash,
  because a roster repointed from a frontier model to a cheap one leaves every byte
  identical. The asymmetry is the design: "not in the lock" is RAMPED (an install
  predating it has files nobody covered), "in the lock and the hash moved" is UNRAMPED at
  every vintage. In practice no install sees the ramp — the installer writes the lock from
  the install's own files at `init`, and at `update` only when there is none yet. An
  update never rewrites one: that would launder every edit since.
  **Three layers, because one env var is not a control:** the generator refuses `--write`
  without `HARNESS_ALLOW_SELF_EDIT=1`, the bash-guard denies invoking any
  `gen-*lock*.mjs … --write` by name shape, and the lock plus all four `.claude`
  directories are write-guard-protected. The distinction from the other three generators
  is deliberate and NOT "guard every generator": `gen-action-inventory`,
  `gen-event-catalog` and `gen-query-shapes` derive their output from something else the
  gates judge, so running them launders nothing. This one's output is a hash OF the files
  being checked.
- **Write-protection for `.claude/rules|agents|commands|skills`** — layer 3 (prevention)
  did not exist for any of them. Plus `.claude/rules/` and `.claude/statusline.mjs` in
  `gate-integrity`'s hashed surface, **ramped to 0.2.0**: they are `owned`, so unramped
  this would red every install that tuned `security-invariants.md` and the prescribed
  remedy (`update`) would clobber the tuning it pointed at.
- **A machine-readable reviewer verdict.** All seven reviewers now end with exactly
  `VERDICT: PASS` or `VERDICT: BLOCK`, asserted by `docs-sync`. Six of them asked for a
  bare `PASS` before, which is unparseable — the word occurs in prose, in a quoted
  requirement, in "PASS or FAIL" — so a caller could not tell a verdict from a sentence
  about one. `citation-verifier` keeps its documented `CITATIONS: CLEAN` line as the
  detail and adds the verdict as the summary.
- **`local/no-unsorted-readdir`**, a sixth custom ESLint rule, plus the factory
  determinism sweep in `scripts/hygiene.mjs`. `readdir` returns entries in the
  filesystem's order, so anything derived from one is machine-dependent — stable on the
  machine that wrote it, reordered on somebody else's, and read as flakiness. **Honest
  scope, stated because the release plan assumed otherwise:** `eslint.config.mjs` ignores
  `tools/**` by design, so the lint rule cannot reach the gate scripts, which is where all
  six real offenders were. The sweep covers `template/base/tools`, the hooks, `scripts/`
  and `installer/` — the surface that enforces determinism for everyone else would
  otherwise be the one surface exempt from it.
- **The factory eats its own dog food** (`.claude/settings.json` at the harness root, its
  own revertable commit). `pretool-bash-guard.mjs` is a three-line **re-export** of the
  shipped guard — never a fork, because a fork drifts and the maintainer working on the
  guard is the one person it stops guarding. `pretool-write-guard.mjs` cannot be shimmed
  (its subject is paths; a consumer's `tools/` is this repo's `template/base/tools/`), so
  it reuses the shipped `hookio` plumbing with a factory path table over the gate scripts,
  hooks, `scripts/`, `installer/lib/`, the workflows and the canary registry.
  `stop-factory-gate.mjs` runs the closure checks nobody remembers to run — hygiene,
  canary coverage, rule integrity, claims, floor lockstep, the complexity ratchet, syntax
  — in ~7s. **It blocks maintenance turns, which is the feature:** a blocked maintainer
  turn means a consumer would have been blocked too.
- **`security-headers`, the 25th gate** (`tools/check-security-headers.mjs`) — the
  web response posture asserted BY VALUE. The gate EVALUATES
  `apps/web/lib/security-headers.ts` under `node --experimental-strip-types` (no
  bundler, no tsx, no `node_modules`, no new dependency) and diffs what the module
  returns against the reviewed policy in `tools/security-headers.json`. Grepping
  the source would have been satisfied by a directive that appears in a comment.
  Covers every static header by exact value, `permissions-policy` features denied
  by an explicitly empty allowlist rather than by omission, the CSP directives that
  must hold exact values, the rule that `'unsafe-inline'` never appears in
  `script-src` without `'strict-dynamic'`, that `X-Frame-Options` and
  `frame-ancestors` AGREE, and that authenticated responses are `private, no-store`
  with a `Vary` naming the acting-org selector.
- **A nonce CSP that is actually wired.** `apps/web/proxy.ts` mints a per-request
  nonce for document responses and sets the policy on BOTH the forwarded request
  headers and the response — the request-header half is how Next propagates the
  nonce to its own inline bootstrap, and omitting it is the standard way a nonce
  CSP ships broken (perfect header, blank page). `apps/web/e2e/security-headers.spec.ts`
  asserts Next actually STAMPED the minted nonce onto a script tag, and collects
  `securitypolicyviolation` events so a policy that blanks the app cannot ship green.
- **`check-web-e2e`: the `anySecurityHeaders` closure.** A spec set that never reads
  `response.headers()` AND collects `securitypolicyviolation` reds the lane, exactly
  as a spec set with no axe scan does — a correct config behind a header-stripping
  CDN is invisible to a static value check.
- **A CSP violation sink** (`app/api/csp-report/route.ts`) — bounded on every axis,
  because the body is unauthenticated attacker-controlled input: a size cap before
  parsing, a field allowlist after, no echo, nothing persisted.
- **`tools/lib/sql-parse.mjs`** — the one statement-level SQL reader the SQL
  gates share. Dollar-quote aware (so a `;` inside a PL/pgSQL body no longer
  tears the statement apart, which is why no gate could previously look inside a
  function), balanced-paren clause extraction (the old `USING (…)` regex was
  non-greedy and survived only because every shipped policy happened to end
  where its anchors expected), and string-literal aware.
- **`schema-rls`: correlated-subquery ban.** `EXISTS (SELECT 1 FROM memberships
  m WHERE m.org_id = notes.org_id AND m.user_id = (SELECT auth.uid()))` passes
  the vacuity check and the initPlan regex — it does contain `(select …
  auth.uid()` — while being a per-row SubPlan that re-enters the referenced
  table's own policies. Ramped at 0.2.0.
- **`schema-rls`: helper-body resolution.** Moving `auth.uid()` into a plain SQL
  helper and calling it bare vacated the initPlan check. Predicates now resolve
  one hop through local function bodies, substituted **at the call site** so the
  check stays positional: `owner_id = helper()` reds and
  `owner_id = (SELECT helper())` passes.
- **`schema-rls`: SECURITY DEFINER discipline** — allowlisted with a reason in
  the new `tools/security-definer-allow.json`, `SET search_path = ''` required,
  no `EXECUTE` to anon/authenticated/PUBLIC, and no identity-shaped parameter (a
  definer function derives the caller from `auth.uid()`; it never accepts
  who-am-I as an argument). Ramped at 0.2.0.
- **`migrations`: lock discipline.** `ALTER TABLE` on a table the migration did
  not itself create requires a `SET LOCAL lock_timeout` preamble — ACCESS
  EXCLUSIVE on a populated table queues every reader behind it. `DROP TABLE` and
  `TRUNCATE` are deliberately excluded (already ADR-gated), as is `CREATE INDEX`
  (it takes SHARE, and `CONCURRENTLY` cannot run inside the transaction Supabase
  wraps a migration in — mandating it would make indexing an existing table
  impossible via any migration, forever).
- **`tenancy`, the 26th gate** (`tools/check-tenancy.mjs` + `tools/tenancy.json`) —
  the multi-tenant contract as reviewed data, landed BEFORE the schema so the
  0.2.0 tenancy spine gets written under the gate rather than retrofitted to it.
  `schema-rls` proves a predicate is REAL; this proves it scopes by TENANT:
  `org_id = (SELECT auth.uid())` — a tenant column compared to a user id — passes
  every schema-rls rule and isolates nothing. `predicateForms` is a CLOSED set of
  two reviewed shapes (`org_id = ANY((SELECT private.member_org_ids()))` and the
  jsonb rank-floor form), both uncorrelated scalar sub-selects that hoist to one
  InitPlan per statement; every top-level `OR` arm of every tenant policy must
  carry one (an AND can only narrow; `… OR owner_id = (SELECT auth.uid())` is as
  open as its weakest arm), and failures print the exact normalized predicate so
  admitting a new form is a copy-paste CODEOWNERS diff to owned data — never an
  escape hatch. Also enforced: the correlated-argument ban
  (`(SELECT private.member_rank(org_id)) >= 30` is wrapped in `(SELECT` and passes
  every wrapper check while being a per-row SubPlan), rank floors on the
  configured role scale, `NOT NULL` FK tenant keys folded across the whole
  history (the expand→contract adoption path lands green), partition-ready
  uniques with per-constraint reasoned escapes, no-`WHEN` freeze triggers,
  zero-argument STABLE INVOKER helpers pinned to `search_path = ''`, the
  membership table held to the OPPOSITE shape (self-only SELECT, deny-all writes,
  no helper calls — the recursion smell test; the executable recursion probe is the
  proof, and it asserts the reads LIVE rather than naming a SQLSTATE, because with
  `search_path = ''` pinned the failure is 54001 stack-depth and not the 42P17 every
  reference leads you to expect), and `nonPublicSchemas` kept out of `[api].schemas`. The `0.2.0` ramp
  covers ADOPTION only — the fresh-install ramp bug fixed on `security-headers`
  is pinned here by a regression test from day one.
- **`sql-parse.mjs` grew the primitives the tenancy gate needed** — and every SQL
  gate now shares them: `splitTopLevelOr` / `splitTopLevelCommas` (paren- and
  literal-aware, so `numeric(10,2)` and nested `CHECK (… IN (…))` no longer tear
  a definition apart), `parseColumnFacts` (per-column `NOT NULL`/`REFERENCES`
  folded across `CREATE`/`ALTER … SET/DROP NOT NULL`/`ADD CONSTRAINT`), and
  `parseIndexes` now surfaces inline and table-level `PRIMARY KEY`/`UNIQUE`
  groups from `CREATE TABLE` under PostgreSQL's own default constraint names
  (`<table>_pkey`, `<table>_<col>_key`), fixing a nested-comma edge where the old
  inline-PK regex could register a numeric literal as a leading column.

- **An adoption path for installs that already hold rows** —
  `docs/runbooks/tenancy-adoption.md` plus the one escape in the harness with a
  deadline. A populated database cannot become org-scoped in a single migration:
  `org_id` must arrive NULLable, be backfilled out of band, and only then take
  `NOT NULL`, with the owner-scoped policies alive beside the new ones throughout
  (permissive policies OR, so dropping the old set early blanks the product). A
  `tools/tenancy.json` `dualScopedTables` entry licenses exactly that state on
  exactly the named table and carries an `until` harness version — compared against
  the manifest's `harnessVersion`, **not** `baseVersion`, because `baseVersion`
  moves only when a human graduates a ramp and a deadline measured against it is one
  the escape's own author controls. It also reds the instant the tenant key becomes
  `NOT NULL`, so on the happy path the escape is stale before its deadline is ever
  reached and the deadline only fires for a transition that stalled. One entry
  covers the whole transition state — including the pre-tenancy tenant-blind primary
  key — deliberately, because a second escape in a list that does not expire would
  have outlived the thing it was written for. Every SQL statement in the runbook was
  executed against PostgreSQL 17 before it was written down; the backfill as first
  drafted did not parse (`invalid reference to FROM-clause entry` — an UPDATE target
  cannot be referenced from a JOIN condition in its own `FROM` list).
- **`private.freeze_org_id()` is set-once, not never-set.** The strict
  `NEW.org_id IS DISTINCT FROM OLD.org_id` form refused `NULL -> value`, which is
  every row of the backfill — and refused it for `postgres` too, because a trigger
  fires regardless of `BYPASSRLS` (verified: `postgres` holds `BYPASSRLS`, the
  freeze still raised). The relaxation closes itself: after `SET NOT NULL` the
  `OLD.org_id IS NULL` branch is unreachable, and a fresh scaffold is never in the
  relaxed state for a single statement. Three new pgTAP assertions pin the
  asymmetry on a scratch table, since every shipped table has the column `NOT NULL`
  and that is exactly the state the property is invisible in.

### Changed

Three corrections to the 0.2.0 gates, each forced by a defect an adversarial design
review proved against the real gate code **before** the schema was written. All three
were unimplementable-or-broken as originally specified, and two fail silently.

- **`tenancy`: the rpc writer role, and the pairing rule that makes it work.**
  Every table ships `FORCE ROW LEVEL SECURITY`, so a `SECURITY DEFINER` function's
  writes are policy-checked against the role that OWNS it — the owner is not exempt.
  Combined with the seat table's mandatory deny-all write policies, that left a
  database in which **no role could ever write a membership row**: the first
  `create_org` would fail 42501 and `supabase db reset` would die at seed. The
  contract now names one reviewed `rpcWriterRole` whose policies are judged by the
  same closed form set. Admitting the role is not enough, though, and the naive
  version fails *silently*: a rank-scoped write policy TO that role calls the rank
  helper, which is `SECURITY INVOKER` and therefore reads the seat table AS THE RPC
  ROLE — with no SELECT policy for it the read hits RLS default-deny, the helper
  returns an empty map, every rank comparison is false, and the write **matches zero
  rows and reports success**. Every promotion in production would look fine and change
  nothing, with valid SQL, a present policy and a reviewed predicate shape. The gate
  now requires the pair.
- **`tenancy`: the org table is judged explicitly.** `public.orgs` carries no tenant
  column, so column-driven discovery never reached the root of the model:
  `USING (created_by = (SELECT auth.uid()) OR name IS NOT NULL)` passed every static
  gate in the repo while publishing every org row to every signed-in user. It is now
  matched against the same forms with its own primary key substituted as the scope
  column. Predicate forms may also be narrowed to specific `tables` (with a reason) —
  that is how the two writes performed by someone who is **not yet a member** (creating
  an org, redeeming an invitation) stay reviewable instead of becoming a general
  licence.
- **`schema-rls`: the definer EXECUTE rule was both impossible and unsound.** As
  shipped it redded any `EXECUTE` grant to `authenticated`, and prescribed "grant it to
  a dedicated role reached through a narrow policy instead" — which cannot exist for a
  PostgREST RPC, since PostgREST switches to the JWT's role before calling. So the rule
  made every client-callable RPC unimplementable. It also checked the wrong thing:
  PostgreSQL grants `EXECUTE` to `PUBLIC` on every new function and Supabase's default
  privileges additionally grant `anon`, so a migration naming no grants at all still
  ships an anon-callable privilege-escalation primitive — and a gate inspecting only
  `GRANT` statements reads that migration as clean. The rule is now "prove the default
  was undone": a `REVOKE` from `PUBLIC` and `anon` is required for every definer
  function, `EXECUTE` to `anon`/`PUBLIC` is never legal, and `EXECUTE` to
  `authenticated` is legal only for an allowlisted one. Unramped, by the negation-set
  reasoning: the shipped scaffold has no definer functions, so ramping would protect
  only a tree that added one.
- **Both tenancy contracts are now registered in all three layers.**
  `tools/tenancy.json` and `tools/security-definer-allow.json` join `SEEDED_FILES`
  (an `owned` file is sha-pinned by `gate-integrity` and overwritten by `update`, so
  taking either gate's *own prescribed remedy* would have redded the next validate and
  then been silently reverted on the next upgrade), `WRITE_PROTECTED` (allowlisting a
  definer function now authorizes `EXECUTE`-to-`authenticated`, so the file grants
  privilege-escalation reach rather than silencing a nag), and `ESCAPE_LISTS`. Guard
  table: **75 → 77 rule ids**.

## [0.1.3] — 2026-08-01

The first release of this lineage, and the first one whose claims the selftest
matrix actually proves. `next-expo-supabase-agent-harness` was forked from
`expo-postgres-agent-harness` and retargeted workstream by workstream to a
two-surface shape: a Next.js 16 web app and an Expo 57 mobile app over ONE shared
Supabase backend, with row-level security as the single authorization boundary
both clients reach. The entries below 0.1.3 are the ANCESTOR's history, kept for
provenance; they describe an Expo-only app over a self-hosted server and do not
describe this repository.

Honest limit up front: this release contains no wall-clock timings, because none
have been measured on this port. The device lanes are schedule- and
dispatch-gated, so they are proven nightly rather than per-commit, and the gate
chain still contains no on-device proof at agent time.

Counts, all machine-derived: the chain is **24 gates** (21 → 24 — `boundaries`,
`types-drift` and `parity` are new) and the guard table **71 rule ids**.

### Added

- **The two-surface stack** (W1–W2): `template/stack/apps/{web,mobile}` over one
  `supabase/` backend — SQL-first schemas + append-only migrations + pgTAP. The web
  app HOSTS the API (`app/api/trpc/[trpc]/route.ts` mounts `@app/api`), so there is
  no standalone server; `packages/api` imports no `next/*`, which is the wall that
  keeps that reversible. Backend seam hardened with cookie identity, CSRF, a real
  skew version and a minimum-client floor.
- **`schema-rls` and `types-drift` on Supabase** (W3): every table FORCE RLS with
  per-operation policies keyed on the `(SELECT auth.uid())` initPlan form, dual
  isolation-registry coverage, and a committed Supabase type mirror that must match
  the live schema.
- **The boundary triad** (W4): one `tools/exports-walls.json` census feeding the
  `./client` wall and the declared-dependency allow-matrix, plus dependency-cruiser
  layering laws and four custom ESLint rules.
- **`contracts` and `parity`** (W5): the dead OpenAPI leg replaced by regen-diff
  over generated tRPC action + event inventories, and a two-way surface-parity
  ledger — every action ↔ a `PARITY.md` row, in both directions.
- **One token source** (W6): the design-system gate retargeted to
  `@app/design-tokens`, compiling to the web and native adapters.
- **The web arm** (W7–W9): guards extended over `NEXT_PUBLIC_` and `apps/web`, a
  `web-e2e` lane, `ci-web-deploy`, decoupled release trains, a `web-security-reviewer`,
  and the `.claude` authoring surface rewritten for Supabase/tRPC.
- **Cross-porting detectors armed**: `hono` and `drizzle` are now a hard red
  anywhere under `template/`.

### Fixed

- **The scaffold is green out of the box** — `init` → `pnpm install` →
  `pnpm validate` passes all 24 gates with zero edits. It was not: 21 lint errors
  sat in `template/stack`, which the harness's own ESLint config ignores (the
  consumer config owns that tree), so the shipped payload was only ever linted
  AFTER scaffolding.
- **A fresh scaffold could not make its first commit.** The pre-commit secret scan
  flagged the Android emulator lane's AVD cache key — `key: avd-33-…`, matched by
  gitleaks' `generic-api-key` rule because YAML spells cache keys with the word
  "key" — in the CI workflow the harness itself ships. The shipped `.gitleaks.toml`
  carried no allowlist at all.
- **Every consumer's CI was born broken**: `quality-gate.yml` called `supabase`
  bare in four jobs, but the CLI is a catalog-pinned devDependency in
  `node_modules/.bin`, which a `run:` step's PATH does not carry.
- **Three gate bugs, fixed rather than allowlisted.** `duplication` excluded
  generated code by a `*.gen.ts` suffix that matched NOTHING in the scaffold (the
  token compiler writes to `src/generated/`) and scored member-expression lookup
  tables as code — it had never been green on the tree it ships. `test-quality`
  could not see `expectTypeOf<T>()`, so every type-only test read as
  assertion-free. Both now carry can-fail proofs in both directions.
- **`native-deps` is hermetic.** It shelled out to `expo install --check`, which
  resolves the SDK-blessed map from Expo's LIVE service — so an untouched commit
  went green→red overnight when Expo published a patch, under a gate whose own
  header claimed hermeticity. It now reads `bundledNativeModules.json` from the
  installed package.
- **The mobile jest lane** died at preset load: the scaffold ships no lockfile and
  CI installs with `--no-frozen-lockfile`, so `jest-expo: ~57.0.2` floated to
  57.0.3 and raised its non-optional `@react-native/jest-preset` peer. Coordinated
  SDK bump (expo/expo-router 57.0.9, react-native 0.86.2, jest-preset 0.86.2) and
  `jest-expo` is now pinned EXACT so a patch cannot silently raise a peer floor.
- **The Windows leg** of the selftest matrix: one gate fixture was never ported —
  a POSIX-only `:` PATH separator, a hard-coded `PATH` key where Windows spells it
  `Path`, and a `#!/bin/sh` fake CLI with no `.cmd` twin.
- **`zizmor` found zero issues** yet failed the lint workflow, dying in
  `upload-sarif` (which needs Advanced Security) — the template's own
  `actions-lint.yml` already documented the fix. **`scorecard`** failed because a
  job-level `permissions:` block REPLACES the workflow-level one.
- **The `provenance` gate never scanned a single RLS policy.** Its file matcher
  admitted SQL only under `packages/**` — the ancestor's ORM layout — so every
  file under `supabase/` was invisible to it. The authorization boundary, the one
  place where a wrong line silently exposes another tenant's rows, carried
  `SOURCE:` citations that nothing verified. It now scans `supabase/**.sql`, and
  the decision-site patterns for policies were narrowed to `CREATE POLICY` and
  `FORCE ROW LEVEL SECURITY` (`auth.uid()` appears in every predicate and in the
  owner-column default, so keying on it would have demanded a citation on every
  correct line and taught authors to paste one anywhere).
- **Two canaries could not have caught a regression.** Canary 7 targeted a prompt
  file that only exists with an opt-in module, so it asserted on an absent file;
  Canary 13 pinned the gates-catalog heading `### 21. docs-sync` from the
  ancestor's 21-gate chain, and this one is 24 steps — the tamper deleted nothing,
  the gate correctly stayed green, and the canary blamed the gate. Both now assert
  a GREEN positive control first and prove the injection actually changed the file
  before any verdict is read, so a stale injection fails as a SETUP error naming
  itself instead of masquerading as a broken gate.
- **`check-seeded-migrations.mjs` ran in no workflow**, despite guarding the
  `update` hazard this release is the first to expose publicly: an unregistered
  seeded template addition auto-plants into every EXISTING install on their next
  update. It could not run — it diffs against the previous release tag, and an
  untagged repo (this one until now; every fresh template copy) failed closed
  forever. It now distinguishes a COMPLETE clone with zero tags (no prior release
  to diff against — skip loudly) from a SHALLOW one (cannot tell "no releases"
  from "tags not fetched" — keep failing closed), and runs in `lint.yml`.

### Changed

- The ancestor's auth and server vocabulary is gone from what ships: the Entra +
  `expo-auth-session` PKCE instructions in `mobile-security-reviewer` (which named
  a provider file that does not exist), the `EXPO_PUBLIC_ENTRA_*` and port-8787
  values in the shipped CI and device lane, the `apps/server` paths in
  release-please and ci-provenance, and the `entra`/`jose` corpus entries — which
  were the ONLY two in the `token-verification` group, leaving a Supabase consumer
  with no correct authority to cite. Replaced with `supabase/verify-user` and
  `supabase/asymmetric-keys`.
- The dead OpenAPI breaking-change workflow (`api-contract.yml`) is removed rather
  than left in place: it ran `pnpm --filter server openapi:emit` against a package
  that no longer exists, behind a `paths:` filter that could never match, so it
  read as coverage while running never.
- `CODEOWNERS` now exists at the repo root — `SECURITY.md` names CODEOWNERS review
  as one of the three backstops behind the tamper-evident guard hooks.
- `.github/ISSUE_TEMPLATE/` now exists — `CONTRIBUTING.md` rule 6 has always sent
  gate proposals to a `gate-proposal`-labelled issue, with no template behind it.
  The form asks for the anti-vacuity proof and the deterministic / hermetic / fast
  / green-on-a-fresh-scaffold bar up front, because that is the expensive part of
  a gate, not its code.

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
