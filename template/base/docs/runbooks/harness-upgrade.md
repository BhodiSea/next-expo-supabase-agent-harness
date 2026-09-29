# Runbook: harness upgrades and version-ramped checks

What to do when a gate prints a `NOTE — … (ramp: …)` line after a harness
`update`. Short version: nothing broke, a NEW check is running in advisory mode
because your project's seeded content predates it; you sweep, then graduate —
deliberately, by hand.

## Two versions in `.harness/manifest.json`

- **`harnessVersion`** — the installer release that last ran against this tree.
  `update` always advances it.
- **`baseVersion`** — the release vintage of the SEEDED starting content this
  tree actually carries. `init` stamps it equal to `harnessVersion`; `update`
  preserves it (owned gate scripts refresh, but your seeded exemplars, docs
  lists, and locally-tuned surfaces do not), so it only moves when a human moves
  it.

## What a ramp NOTE means

Gates never ambush an update: a check added in a newer release than your
`baseVersion` runs NOTE-only (`rampNote` in `tools/lib/gate.mjs`). The line

```
<gate>: NOTE — <check> (ramp: live from baseVersion X.Y.Z; this install's baseVersion is A.B.C; expires in E.F.G). …
```

says: the check executed, found what it found, and withheld the red. On a FRESH
install the same check hard-fails — projects grow into gates; fresh scaffolds
start already grown.

## RAMPS EXPIRE (0.3.0) — `expires in`, and what happens when you reach it

Before 0.3.0 a ramp had no deadline, which meant **"shipped ramped" meant "shipped
disabled, indefinitely"**: the check printed an advisory NOTE — in CI too — and the
only thing that ever re-armed it was a human running `graduate`, which nothing
nagged. A control whose expiry date is optional has no expiry date.

Every ramp now carries an `until`, and it is measured against **`harnessVersion`**,
not `baseVersion`. That distinction is the whole mechanism: `baseVersion` only moves
when the ramp's own beneficiary graduates, so a deadline measured against it is a
deadline you hold open by never graduating. `harnessVersion` advances on every
`update`.

When you reach the deadline the NOTE becomes a FAIL, and the line above it says so:

```
<gate>: RAMP EXPIRED — <check> was ramped from baseVersion X.Y.Z with a deadline of E.F.G,
and this install runs harness E.F.G. The escape is over: the finding below is a hard failure now.
```

**One remediation path, printed by every layer.** Whether you hit this through
`pnpm validate`, a red Stop block, `doctor`, or `update`, the answer is the same
three steps: sweep the finding, then `graduate`, then re-run validate. There is no
flag that extends a deadline — extending one is a harness release, deliberately.

**A dormant install jumping several versions meets several deadlines at once**, and
that is the designed outcome rather than an accident: the alternative is an install
that skipped four releases and still reports every one of their checks as advisory.
Upgrade one minor at a time (`update`, sweep, `graduate`, repeat) if the pile is
large — each `graduate` is cheap and each one shrinks the next.

## 0.4.0 IS THE ALARM — read this before you upgrade

0.3.0 shipped the clock: every pre-existing ramp was dated `0.4.0`, every ramp it
introduced was dated `0.5.0`, and nothing reds on a deadline in that release. **0.4.0 is
the first release where a deadline arrives.**

**Who this affects, exactly.** Every expiring ramp opens at `minVersion 0.2.0`, and
`rampNote` is inert once `baseVersion >= minVersion`. So the affected population is
installs whose **`baseVersion` is below 0.2.0** — among released vintages, only **0.1.3**.

| your `baseVersion` | what `update` to 0.4.0 does |
|---|---|
| `0.1.3` | **12 escapes close at once.** The checks below stop withholding their findings. Sweep, then `graduate`. |
| `0.2.0`, `0.2.1`, `0.3.0` | Nothing expires. Those checks have been live on your install all along — you are already past them. |
| fresh `init` at 0.4.0 | Nothing ever ramped. Every check has been strict since your first run. |

Do not take the count on faith and do not take it from these notes:

```
node tools/check-gate-integrity.mjs      # prints your baseVersion
pnpm validate 2>&1 | grep 'RAMP EXPIRED' # the findings that just went hard, on YOUR tree
```

Most installs at 0.1.3 will see **far fewer than 12**, and the difference is not
optimism: a gate calls the ramp only when it actually has a finding to withhold, so a
deadline you meet fires only if the finding also exists on your tree. Nine of the twelve
sites are *adoption* seams that fire only when the surface is genuinely absent, so an
install that has been pulling seeded content along the way meets almost none.

Measured, not estimated — the reference scaffold taken from v0.1.3 straight to 0.4.0
(`scripts/ci/upgrade-lane.sh --from v0.1.3`, the release's own proof) reds **six** gates:

```
db-limits  gate-integrity  query-shapes  rate-limits  security-headers  tenancy
```

and three more — `migrations`, `prompts`, `schema-rls` — meet the deadline but stay
silent, because that tree carries nothing for them to report. Yours will differ. Run the
grep.

**If the pile is large, do not fight it head-on.** Upgrade one minor at a time — `update`
to 0.2.0, sweep, `graduate`, then 0.3.0, then 0.4.0. Each `graduate` moves `baseVersion`
forward, and every ramp at or below it goes inert, so each step shrinks the next. Jumping
straight from 0.1.3 to 0.4.0 is the one path that meets all twelve simultaneously.

### The twelve, and the cheapest sweep for each

Grouped by what the finding actually is. **A: the surface is missing** — the fix is to
adopt it, and `update --refresh-seeded <path>` does most of the work. **B: the surface is
there and something in it is wrong** — a real fix. **C: applied history** — cannot be
edited; see the escape.

#### A — adoption seams (the surface is absent)

| Gate | The finding | Sweep |
|---|---|---|
| `tenancy` | no tenant column in any migration | Follow `docs/runbooks/tenancy-adoption.md`. The spine is a migration you write; there is no file to pull. |
| `tenancy` | no `audit.events` table | Write a new migration. **Do NOT `--refresh-seeded` a migration** — `supabase/` is seeded because a migration is applied history, and planting one describes DDL your database has not run. `docs/adr/20260202-audit-trail.md` carries the required schema and trigger shape; copy from it deliberately. |
| `db-limits` | no `ALTER ROLE … SET` in any migration | Same rule — a new migration, from `docs/adr/20260203-resource-limits.md`. Then reconcile `tools/db-limits.json` to what you actually applied; the gate compares the two by value. |
| `db-limits` | no `org_usage` table | Same ADR — the quota trigger pair. `AFTER INSERT … FOR EACH STATEMENT`, never `FOR EACH ROW`, and never a RESTRICTIVE policy over a `STABLE` count (it fails OPEN). |
| `rate-limits` | `tools/rate-limit-budget.json` missing | `update --refresh-seeded tools/rate-limit-budget.json`, then reconcile it against your own procedures — a budget that names actions you do not have reds for a different reason. |
| `security-headers` | `apps/web/lib/security-headers.ts` missing | `update --refresh-seeded apps/web/lib/security-headers.ts` plus `tools/security-headers.json`. The gate asserts the module BY VALUE against the JSON, so pull both or neither. |
| `query-shapes` | no `src/data/query-probes.ts` in any vertical | `update --refresh-seeded packages/verticals/<name>/src/data/query-probes.ts` for the exemplar shape, rewrite it to drive YOUR data functions, then `pnpm gen`. Order matters: the manifest is a recording of what your DAL executed, so generate it from your own probes — never pull `tools/generated/query-shapes.json`, whose regen-diff against a different DAL can never converge. |
| `prompts-lock` | `.claude/{agents,commands,skills}` not covered by the lock | One command: `HARNESS_ALLOW_SELF_EDIT=1 node tools/gen-agents-lock.mjs --write`. Read the diff before committing — you are signing off on the instructions your agent runs under. |
| `gate-integrity` | `.claude/rules/` and `.claude/statusline.mjs` not hashed | The manifest gained hash coverage of these in 0.2.0. `update` re-records them; if the gate still reds, a file has been hand-edited since — review that diff, then re-run `update`. |

#### B — real findings (the surface is present and wrong)

| Gate | The finding | Sweep |
|---|---|---|
| `query-shapes` | index-service and boundedness over the generated manifest | Each finding names a query and what it lacks. The usual two: a list with no unconditional `LIMIT`, and an owner index that carries the filter but not the ORDER BY. `packages/verticals/notes` is the worked pattern. |
| `rls-manifest` | correlated policy predicates, `SECURITY DEFINER` discipline | Replace `auth.uid()` with `(SELECT auth.uid())` in policy predicates — the scalar sub-select the planner hoists to one evaluation per statement instead of one per row. Definer functions need an entry in `tools/security-definer-allow.json` or a `SET search_path`. |

These two are the ones worth the time. Neither is cosmetic: an unbounded list is a
denial-of-service you ship, and a per-row `auth.uid()` is why a table gets slow at exactly
the moment it gets popular.

#### C — applied history (`migrations`)

The `migrations` ramp covers two 0.2.0 rules: authorization-destructive DDL needs an
`-- adr:` reference, and ACCESS EXCLUSIVE needs a `SET lock_timeout = '3s';` preamble.

**If the finding is on a migration you have not committed yet, just fix it in the file.**

If it is on **applied history**, you cannot: both remedies live inside the migration, and
the append-only rule reds any edit to a committed one. Editing is also pointless — a lock
preamble on a migration that ran last quarter governs a lock already released. Record the
acknowledgement instead, in `tools/migrations-allow.json`:

```jsonc
{
  "allow": [
    {
      "file": "20260114093000_add_archived_at.sql",
      "rule": "lock-timeout",
      "reason": "Applied to production 2026-01-14 during the maintenance window; the lock was taken and released then. The file cannot be edited (append-only) and a preamble now would govern nothing."
    }
  ]
}
```

`rule` is `"lock-timeout"` or `"authz-adr"`. The gate refuses the entry if the migration
does not already exist at the diff base — so this covers history, never a migration you
are writing now — and reds a stale entry whose finding is gone. It is an escape list:
commit it, so the widening lands in the PR diff under CODEOWNERS.

### Then graduate

Once `pnpm validate` is green, `npx next-expo-supabase-agent-harness graduate` advances
`baseVersion` to 0.4.0 and prints the failing gate with its detail bullets if anything
still holds it back. Re-run validate: the NOTEs are gone and the checks are live.

## 0.5.0 — THE SECOND ALARM, and it reaches further than the first

0.4.0's expiring escapes all opened at `minVersion 0.2.0`, so only `baseVersion 0.1.3`
met a deadline. **0.5.0's eight open at 0.3.0 and 0.4.0**, so the population is every
released vintage below 0.4.0.

| your `baseVersion` | what `update` to 0.5.0 does |
|---|---|
| `0.1.3` | Everything 0.4.0 closed is still closed, **plus these eight**. If you are still here, upgrade one minor at a time rather than head-on. |
| `0.2.0`, `0.2.1` | **8 escapes close.** All eight, since every one of them opens at 0.3.0 or 0.4.0. |
| `0.3.0` | **2 escapes close** — `diff-coverage`'s per-file floors on the surface 0.4.0 added, and `wiring`'s web a11y plugin seam. The other six opened at 0.3.0 and have been live on your install all along. |
| `0.4.0` | No ramp expires. It is the one released vintage whose escapes this release leaves alone — but see the security floor below, which reds every vintage. |
| fresh `init` at 0.5.0 | Nothing ever ramped. |

### Expect `version-sync` to red on the security floor, whatever your baseline

This one is not a ramp and no vintage is exempt. `tools/framework-floor.json` is
harness-**owned**, so `update` refreshes it into your install — that is the point, a new
advisory has to reach trees that already exist. `pnpm-workspace.yaml` is **seeded**, so
`update` deliberately does not touch your pins. The result is that the first `pnpm validate`
after upgrading reports any catalog pin now sitting below the reviewed floor, naming the
package, your resolved version, the floor and the advisory ids.

For 0.5.0 that is `next`, which moves to **16.2.11** (or **15.5.21** if you are on the 15
line — the floor is keyed by major, so a patched older line is left where it is). Apply it
the way the failure says:

```
# raise the pin in the pnpm-workspace.yaml catalog, then
pnpm install && git add pnpm-lock.yaml pnpm-workspace.yaml
pnpm validate
```

There is no flag that lowers the floor. `tools/framework-floor.json` is sha-pinned by
`gate-integrity`, so editing it down reds step 2 instead of step 11.

Same rule as last time — do not take the count from these notes:

```
pnpm validate 2>&1 | grep 'RAMP EXPIRED'   # the findings that just went hard, on YOUR tree
```

The population above is not prose either: `template/migrations.json`'s `0.5.0.rampExpiry`
record states it as data, and `scripts/check-ramp-ledger.mjs` reds if it disagrees with what
the shipped call sites actually compute.

### The eight, and the cheapest sweep for each

| Gate | The finding | Sweep |
|---|---|---|
| `wiring` | `eslint-plugin-jsx-a11y` is not a declared dependency, so `eslint.config.mjs` omits the `apps/web` accessibility block and the web half of the a11y floor runs nothing | **This is the one expiry whose remedy the harness owes you**, and 0.5.0 delivers it: `update` parks a `dependencyObligations` record at `.harness/pending/dependencies.json` and `doctor` reds until it is met. Add the pin to your `pnpm-workspace.yaml` catalog and the devDependency to `package.json` exactly as the parked file states, run `pnpm install`, and commit `pnpm-lock.yaml`. The obligation file deletes itself on the next `update`. |
| `wiring` | CODEOWNERS does not cover the enforcement surface | The whole gate was ramped for one release. Each finding names a path and the owner it lacks; `{{SECURITY_OWNERS}}` is the seeded answer. A retrofit that deliberately kept a different posture is a real decision — make it explicitly rather than by expiry. |
| `diff-coverage` | per-file floors on `apps/web/lib` and the layered `packages/*/*/src` | Write the tests. These files were never held to a floor before 0.4.0 and now are; `apps/web/__tests__/` ships six seed suites (`seedOnInitOnly`) you can pull as shape references with `update --refresh-seeded`, but the coverage has to come from tests over YOUR modules. |
| `gate-integrity` | the enforcement CONFIGS are not hash-covered, and the threshold-bearing configs are dirty | `update` re-records the hashes. If it still reds afterwards, a covered file has been hand-edited since — read that diff, then re-run `update`. For the commit-not-dirty half: commit the config change, which is the whole point (a widened threshold belongs in a PR under CODEOWNERS, not in a working tree at gate time). |
| `docs-sync` | `AGENTS.md`'s gate list drifted after an injected chain step | Paste the gate names the NOTE prints into AGENTS.md's "The N gates, in order:" sentence and its "N-step chain" line. The ramp only ever covered ADDITIVE drift — a documented step that no longer exists, or a reordering, has always been a hard red. |
| `docs-sync` | the approved-tools registry and `docs/security/approved-tools.md` disagree | Reconcile the doc against `tools/approved-tools.json` (and `.claude/settings.json`). Adding an MCP server is granting reach; the three-corner lockstep is what stops one corner granting it quietly. |
| `docs-sync` | the doctrine token map names a symbol its module no longer contains | Update `tools/doctrine-symbols.json` in the same commit as the rename. A map that outlives its module is a second, stale doctrine. |
| `docs-sync` | `docs/harness/enforcement-tiers.md`'s shape — a `Compensated by` naming a control that is neither a chain step nor a CI job | Name a live one, or write `—` and raise the row's `Target`. **0.5.0 also makes `Target` itself a control**, so a row whose Target has arrived must have closed its gap or moved the date in a reviewed diff. |

**Nothing was deleted to make this release green.** All eight `rampNote` wrappers stay in
the tree; they expire by version comparison, which is the mechanism working rather than
being removed. And there is still no flag that extends a deadline — as of this release that
sentence is enforced: `scripts/check-ramp-ledger.mjs` compares every `until` against the
previous release TAG's tree and reds on any date that moved later, unless a `rampExtensions`
record in `template/migrations.json` names the file, the escape, the versions, and the
reason. (0.6.0 corrected how a site is IDENTIFIED across releases — see its section below.
Through 0.5.0 the comparison keyed on `minVersion`, so re-opening a ramp changed the key and
moved the deadline unseen.)

### Then graduate

`npx next-expo-supabase-agent-harness graduate` advances `baseVersion` to 0.5.0 once
`pnpm validate` is green.

## 0.6.0 — NOTHING NEW EXPIRES, and one deadline moves LATER

Read this one if you are upgrading to 0.6.0. **Nothing newly expires here.** The
release opens **seven** ramps — `auth-posture`, `data-flow`, `reviewer-verdicts`, the
web half of `route-manifest`, the browser lane's authenticated-render axis, the
`schema-rls` policy→grant closure, and a re-opened `docs-sync` — and all seven fall due
at **0.7.0**, so every alarm you meet crossing this release is one you already owed.

Two of the seven are worth naming here because their subject is content you must
author, not a switch you flip:

- **`schema-rls`'s policy→grant closure.** Every `CREATE POLICY` needs a matching table
  `GRANT` behind it, because PostgreSQL checks privileges *before* row security — a
  policy naming a role that holds nothing never runs. It works on your project today
  only because Supabase's default privileges granted `anon`/`authenticated`/
  `service_role` on every new table in `public`, and **those defaults stop applying to
  projects created on or after 2026-10-30**. The NOTE prints the exact `GRANT` statement
  for each finding; put them in a new migration. Do this before that date, not before
  0.7.0.
- **The browser lane's authenticated-render axis.** `update` does not hand you the
  seeded `authenticated.spec.ts`, deliberately: its assertions name *this template's*
  routes and test ids, and planting it would red your lane about your own app. Write one
  against your routes — sign in through the form, then `page.reload()` and assert a
  protected page still renders. That reload is the whole point; a client-side navigation
  renders from state the tab already holds.

**One deadline moves later, and it is recorded rather than quiet.** `docs-sync`'s
AGENTS.md gate-list ramp expired at 0.5.0. This release injects a new chain step
(`auth-posture`) into your `tools/harness.config.mjs`, which takes your chain to 32
steps while your `AGENTS.md` still documents 31 — and `AGENTS.md` is **seeded**, so
`update` will not rewrite your project memory and only you can fix it. Redding you
for that on an upgrade you did not ask for is the ambush the ramp mechanism exists to
prevent, so the escape re-opens at **0.7.0** and the NOTE prints the exact list of
gate names to paste. `template/migrations.json`'s `0.6.0.rampExtensions` records the
move, the reason, and the escape it applies to.

What that means for you depends only on where you are coming from:

| Your `baseVersion` | What 0.6.0 does to you |
|---|---|
| **0.4.0 or 0.5.0** | Nothing expires. Seven advisory NOTEs. `update`, sweep them, `graduate`. |
| **0.3.0** | You meet the two 0.5.0 deadlines you have not met yet (`diff-coverage`, `wiring`) — **on the way through**, not because of this release. Follow the 0.5.0 section above. |
| **0.2.0 / 0.2.1** | Seven of the 0.5.0 section's eight. The AGENTS.md gate-list one is the extension above: it is a NOTE now and a red at 0.7.0. |
| **0.1.3** | Nineteen. Follow 0.4.0's section, then 0.5.0's. |

**If you skipped 0.5.0, its section above is still your section.** A deadline is
measured against `harnessVersion`, and `update` advances that to 0.6.0 in one step
regardless of how many releases you crossed — so skipping a release does not skip its
alarms, it batches them. This is the case the *"upgrade one minor at a time"* advice
at the top of this file exists for: each `graduate` makes every ramp at or below it
inert, so each step shrinks the next.

**The honest count is still the command, never this table:**

```sh
pnpm validate 2>&1 | grep 'RAMP EXPIRED'
```

Several of the twenty-six sites are adoption seams that fire only when the surface is
genuinely absent from your tree, so a list written in prose will always over-state
what YOUR install meets. (The count in that sentence was "nine of twenty-two" through
0.6.0 and had been wrong since the fleet grew — which is the argument for the command,
not for a better-maintained number.)

### Sweeping the web route seam has a second half, and it is yours

The web half of `route-manifest` is the one adoption seam in this release that `update`
cannot finish for you, and the reason is worth understanding rather than working around.
`update` delivers the new files — `apps/web/lib/routes.generated.ts`, a `page.meta.ts`
beside each page, `not-found.tsx`, the `lib/i18n/` seam. It does **not** touch your page
bodies, because those are yours.

But a `page.meta.ts` **declares** state test ids, and the gate requires the page to
**render** them: a declared-but-unrendered state is a claim nothing checks. So adopting
the meta file alone leaves a finding the meta file itself created. For each page you
adopt, render its ids in that page:

```tsx
import { meta } from './page.meta'
// …
<Card data-testid={meta.states.empty}>…</Card>
```

`data-testid={meta.states.<key>}` rather than the literal string is the form that cannot
drift — the declaration and the render read the same value.

If a state genuinely cannot occur on a route, declare it `null` with a reason in
`tools/web-route-allowlist.json` `unreachableStates` instead. The shipped `orgs` route is
the worked example of that judgement in the other direction: `resolveOrgs()` returns an
empty list rather than throwing, so the route has no error branch to put a test id on.

### Adopting `apps/web/lib/i18n/` adds one accepted clone — add the entry with it

The web and mobile catalogs each declare the same eight-line `PluralMessage` interface (the
CLDR categories `Intl.PluralRules` selects between). Both `resolve()` implementations need
it, and **it cannot be extracted**: every shared package source root is *seeded*, so `update`
can never deliver a new export into an existing install — extracting the type would compile
on a fresh scaffold and break `types` on yours.

So the moment you adopt the web seam, `duplication` reports one clone. It is accepted in the
shipped `tools/duplication-allow.json`, but that file is **yours** — `update` will not touch
it, because it also holds the clones *you* have accepted. Add the entry by hand; the gate
prints the fingerprint you need:

```sh
pnpm exec node tools/check-duplication.mjs
```

```json
{ "fingerprint": "e83e21400fb2", "reason": "mobile/web i18n catalogs — the PluralMessage type preamble; see docs/runbooks/harness-upgrade.md" }
```

This is a **Stop-chain** step, not one of the 33 chain gates, so `pnpm validate` alone will
not show it — it appears when your turn tries to end.

### THE ONE THAT IS A BUG FIX, NOT AN ADOPTION: your web sign-in is broken

Every other item on this page is a new surface you are choosing to adopt. This one is
different: **your install carries a functional defect that 0.6.0 fixed, and `update`
cannot hand you the fix.**

The seeded browser Supabase client was constructed without a `storage`, so
`@supabase/supabase-js` persisted the session to `localStorage` — while every server
render reads the **cookie jar**. `localStorage` is never sent with a request. So a
correct sign-in succeeds, the server sees no session, and the protected route redirects
straight back to `/sign-in`: **a sign-in loop**, on the shipped scaffold, invisible to any
test that stops at "the credentials were accepted". The same wave removed four comments
claiming `httpOnly` on a cookie a browser-side sign-in **cannot set it on** — a user agent
ignores that attribute on a `document.cookie` write, so those comments named a control
that was never there.

`apps/web` and `packages/platform/*` are **yours** — `update` does not overwrite them, by
design. So this is an edit you make. `auth-posture` names each site and the exact fix, and
withholds the findings as NOTEs until **0.7.0**:

```sh
pnpm validate 2>&1 | grep -A2 'auth-posture: NOTE'
```

The nine files move **as one set**, because the fix does not decompose: the browser client
takes a cookie-backed storage adapter that the platform package must export, and the
server client takes the reviewed cookie attributes that the same module defines.

| Where | What changed |
|---|---|
| `apps/web/lib/supabase/client.ts` | pass `storage: cookieSessionStorage(jar, { secure })` |
| `apps/web/lib/supabase/server.ts` | pass the reviewed `cookieOptions` — this client REWRITES the cookie, so an omitted attribute is one it strips |
| `apps/web/app/sign-in/page.tsx`, `sign-in-form.tsx` | the sign-in path, and the `httpOnly` comment that claimed a control it cannot have |
| `packages/platform/supabase/src/{client,cookies,cookies.test,cookie-server,index}.ts` | the cookie session adapter and its export |

If you have not modified these files, taking 0.6.0's copies wholesale is the whole
migration. If you have, apply the change the gate names in each — it is small in every
one. The set is recorded as `0.6.0.seededSourceFixes` in the harness's
`template/migrations.json`, which is also what the upgrade lane's sweep leg executes, so
this table cannot drift from what is actually required.

### Then graduate

`npx next-expo-supabase-agent-harness graduate` advances `baseVersion` to 0.6.0 once
`pnpm validate` is green — and it still refuses while any ramp NOTE stands, which is
how you know the sweep was real.

**This is executed, not just written.** The upgrade lane's `--sweep` leg performs exactly
the steps above on a 0.3.0 install and then requires `graduate` to SUCCEED — so if the
sweep on this page ever stops being sufficient, that leg reds rather than a consumer
discovering it. It is also the only thing in this repository that has ever run graduate's
success branch: every other leg ends with it correctly refusing.

## 0.7.0 — THE THIRD ALARM, AND THE WIDEST

Nothing in this section is new work. **The seven ramps 0.6.0 opened all fall due
here** — `auth-posture`, `data-flow`, `docs-sync`, `reviewer-verdicts`, the web half
of `route-manifest`, `schema-rls`, `web-e2e` — so every advisory NOTE the 0.6.0
section describes is now a red, and the sweep for each is the one that section
already wrote down. What IS new is who this reaches: **this is the first release
that reds its own recent predecessors.** 0.4.0 — the one released vintage 0.5.0
left alone — and 0.5.0 both meet a deadline for the first time; the affected
population is every released vintage below 0.6.0.

Two of the seven never appear in `pnpm validate` output, so the count command
below under-reports them by construction: `reviewer-verdicts` is a Stop-chain
step (it fires when a turn tries to end), and `web-e2e` runs only in the
path-filtered browser-lane CI job — both have their caveat spelled out in their
rows below.

| Your `baseVersion` | What 0.7.0 does to you |
|---|---|
| **0.6.0** | None of the seven touches you — every one has been live on your install since you graduated. Instead you meet this release's **new** ramps as NOTEs: `version-sync`'s iOS toolchain floor and `data-flow`'s export-target deadline fire on the seeded files exactly as they shipped, so expect both; the other two (`docs-sync`'s deferral ledger, `reviewer-verdicts`' verdict-to-diff binding) fire only if your tree or turn carries the finding. All four expire in 0.8.0 — and `graduate` refuses while any chain NOTE stands, so graduating to 0.7.0 sweeps the first three anyway. The fourth is a Stop-chain matter: it fires inside a live turn, where only the sweep in its row below clears it. |
| **0.5.0 / 0.4.0** | **The seven close at once** — your first deadline ever. **The 0.6.0 section above IS your sweep list**; this section adds only the parked-fix channel and the new-ramp NOTEs below. A 0.5.0 install meets all seven with no older debt, which makes it the cleanest sweep in the lineage — and the parked artifact plus the `doctor` warning is how you discover the `auth-posture` half without reading anything. |
| **0.3.0** | **Nine**: the seven, plus the two 0.5.0 deadlines you have not met yet (`diff-coverage`, `wiring`) — on the way through, not because of this release. Follow the 0.5.0 section for those two. |
| **0.2.0 / 0.2.1** | Ten. Do not fight it head-on: follow 0.4.0's section, then 0.5.0's, then 0.6.0's, one `graduate` per hop — each hop shrinks the next. |
| **0.1.3** | Seventeen. Same advice, more so. |
| fresh `init` at 0.7.0 | Nothing ever ramped. |

The honest count is still the command, never this table — minus the Stop-side and
browser-lane caveat above:

```sh
pnpm validate 2>&1 | grep 'RAMP EXPIRED'
```

And the population is not prose either: `template/migrations.json`'s
`0.7.0.rampExpiry` record states it as data, and `scripts/check-ramp-ledger.mjs`
reds if it disagrees with what the shipped call sites actually compute.

### The seven, and where their sweeps already live

Every remedy was already written on this page; the rows point INTO it rather than
restate it.

| Gate | The finding | Sweep |
|---|---|---|
| `auth-posture` | the sign-in loop — the browser session in `localStorage` while every server read takes the cookie jar | The nine-file set in **"THE ONE THAT IS A BUG FIX"** above, unchanged. New in 0.7.0: `update` also parks the instruction as data — see the parked-fix channel below. |
| `route-manifest` (web) | the seam files absent, or a `page.meta.ts` declaring state ids the page never renders | **"Sweeping the web route seam has a second half"** above: `--refresh-seeded` the seam, then render `meta.states.*` in each adopted page. Adopting `lib/i18n/` adds the accepted clone — its own subsection above carries the entry. |
| `schema-rls` | a `CREATE POLICY` with no table `GRANT` behind it | The policy→grant bullet at the top of the 0.6.0 section: the finding prints the exact `GRANT` statement; put them in a new migration. Supabase's default-privilege change lands **2026-10-30** — closer than another release cycle, so do this for the date, not for the deadline. |
| `docs-sync` | `AGENTS.md` still documents the gate list from before `update` injected this release's chain steps | Paste the gate names the finding prints. This is the one deadline 0.6.0 moved LATER — recorded as its `rampExtensions` entry — and the escape ends here. |
| `web-e2e` | no spec has ever completed a real sign-in | Author `authenticated.spec.ts` against YOUR routes, per the 0.6.0 section's authenticated-render bullet: sign in through the form — never `context.addCookies`, a planted session proves only that the server reads a cookie — then `page.reload()`. **This red is invisible to `pnpm validate`**: `tools/check-web-e2e.mjs` runs only in the path-filtered `web-e2e` CI job (plus the nightly/dispatch net), so the banner arrives on your first web-touching PR after the upgrade. Do not read its absence as a pass. |
| `reviewer-verdicts` | the turn's diff owed a reviewer and no verdict answers for it | `update` wires the machinery itself — `.claude/settings.json` and the hooks are owned, and the SubagentStop hook records each reviewer's verdict into `.harness/reviewer-ledger.jsonl`. The red fires only inside a live agent turn whose diff matches a `tools/reviewer-triggers.json` pattern, so the sweep is RUNNING the owed reviewers to a `VERDICT: PASS` — not editing files. |
| `data-flow` | the erasure/portability closure over your schema | Review `tools/data-flow.json` against YOUR schema — `update` plants the file when absent, and a planted or stale file's `severed[]`/`retained[]` rows are claims about tables you own. Its export half is the second new-ramp sweep below. |

### The parked-fix channel: `.harness/pending/source-fixes.json`

0.5.0 introduced the pattern for dependencies; 0.7.0 extends it to seeded source.
When a release CORRECTS harness-authored content inside files that are **yours**
(so `update` cannot write them), `update` now parks the instruction as data at
`.harness/pending/source-fixes.json` and prints one `SEEDED SOURCE FIX` note per
set, naming the gate, the files, and the release section on this page that
carries the fix. `doctor` warns while the file stands. It clears **itself**: each
set carries probes describing the broken shape, and once your tree no longer
matches it — you applied the fix, or you rewrote the files your own way — the
next `update` or `doctor` removes the artifact. An absent file is never "broken";
the gate, not the probe, stays the authority on the finding.

On an upgrade to 0.7.0, up to four sets can park: 0.6.0's `auth-posture`
nine-file sign-in set, the two 0.7.0 corrections the next section sweeps, and
one line of `.gitignore`: `supabase/.temp/` — the local stack writes minted
service-role keys and credentialed DSNs there, the pre-0.7.0 seeded ignore
file never covered it, and the `secrets` gate reds on the working tree the
first time validate runs with the stack up. Add the line (however your own
ignore file is organized); the parked set self-clears when it appears.

### The new ramps — the debt this release opens, expiring in 0.8.0

Four new checks arrive ramped, on the same terms every ramp on this page has
carried: NOTE-only while your `baseVersion` predates 0.7.0. Three are chain
gates, so `graduate` refuses while their NOTEs stand; the fourth
(`reviewer-verdicts`) is a Stop-chain step and surfaces only inside a live
turn.

**`version-sync`: the iOS build-toolchain floor over `eas.json` — expect it,
whatever your vintage.** Apple requires uploads built against Xcode 26 / iOS 26
SDK, in force since 2026-04-28 (`tools/store-policy.json` `iosToolchain`), and
every seeded `eas.json` before 0.7.0 pins no build image at all — no pin means
nothing can red, and a too-old toolchain burns a whole build-and-submit cycle
with no gate output. Pin a concrete image on the production iOS profile:
`"image": "macos-tahoe-26.5-xcode-26.6"` is the template's pin (the concrete name
behind the `sdk-57` alias when 0.7.0 shipped), and any image whose `-xcode-`
major is `>= 26` satisfies the gate. `auto`, `latest`, and `sdk-NN` do not count
— an alias moves under the build, so it is unverifiable offline. If you have
never modified `eas.json`, `update --refresh-seeded apps/mobile/eas.json` pulls
the whole file.

**`data-flow`: the export-target deadline.** If your `tools/data-flow.json`
`export.surface` still reads `{ "kind": "none", "target": "0.7.0" }` — the
harness's own dated absence, seeded into every 0.6.0 install — the date has
ARRIVED, and the finding names your two legitimate moves. Either adopt the
delivered surface: pull the three withheld files
(`update --refresh-seeded <path>`, once per path) —
`packages/api/src/export.ts` (the `exportMyData` assembly: runs AS THE CALLER
under RLS, notes filtered authored-only in the query), its colocated test
`packages/api/src/routers/system.export.test.ts`, and the covering-index
migration `supabase/migrations/20260808000000_notes_export_index.sql` — then
mount `exportMyData` on your system router (the template's
`packages/api/src/routers/system.ts` is the worked pattern), merge the export
DTOs and row schemas into your contracts barrel (the template's
`packages/contracts/src/index.ts` — the row schemas live there so the adoption
adds no dependency to your api package), and set
`export.surface` to `{ "kind": "procedure", "procedure": "<your router file>" }`
(`--refresh-seeded tools/data-flow.json` does that wholesale, but only if the
file carries no reviews of your own). The mount has two trailing edits leg E
found the hard way: add the `system.exportMyData` row to `PARITY.md` (the
`parity` gate closes the ledger both ways) and run `pnpm gen` so
`tools/generated/action-inventory.json` — generated from YOUR router, seeded as
of 0.7.0 for exactly that reason — names the procedure (`contracts` regen-diffs
it). The parked fix set at `.harness/pending/source-fixes.json` lists all four
files and self-clears on either move. The index file is a NEW migration, not
history: read it, re-timestamp it to the tail of your own history if you have
applied later ones, then apply it like a migration you wrote — the 0.4.0 rule
forbids planting DDL into the MIDDLE of applied history, and this lands at the
end. Or, second move: re-review YOUR target to a release you mean, in a reviewed
diff — the file is git-clean-enforced, so moving the date shows in the PR.

**`docs-sync`: the deferral ledger over the owned prose surfaces.** The gate now
scans `docs/harness/gates-catalog.md`, `tools/auth-posture.json`, and every
top-level `tools/*.mjs` for sentences that defer work to a named release, and
closes them both ways against `tools/deferrals.json`. The harness-owned surfaces
ship clean, so this NOTEs only if YOUR OWN `tools/*.mjs` carry a dated sentence.
The moves are the finding's: add the reviewed entry
(`{ id, file, target, reason, reviewedOn }`) to `tools/deferrals.json`, or make
the sentence dateless if it states a permanent scoping condition rather than a
plan.

**`reviewer-verdicts`: the verdict-to-diff binding.** A `PASS` now carries a
`path_state` binding — the digest, at the moment the reviewer passed, of the
paths that summoned it. A `PASS` that pre-dates the last edit to those paths, or
carries no binding at all (a pre-0.7.0 hook wrote it), blocks toward re-review:
"a reviewer ran" and "a reviewer reviewed THIS" are different claims, and the
difference is exactly the files that moved after the `PASS`. The sweep is
behavioral, like the gate itself: run the owed reviewer again AFTER the last
edit to the paths it covers.

### Then graduate

`npx next-expo-supabase-agent-harness graduate` advances `baseVersion` to 0.7.0
once `pnpm validate` is green — and it still refuses while any ramp NOTE stands,
including the three chain-side ones this release opens.

**This section is executed, not reviewed.** The upgrade lane's `--sweep` leg
performs exactly this page's steps on a v0.3.0 install — crossing 0.4.0, 0.5.0,
0.6.0, and 0.7.0 in a single `update`, sweeping every crossed release's seams,
fixes, and NOTEs — and then requires `graduate` to SUCCEED with zero surviving
ramp NOTEs. If what is written here ever stops being sufficient, that leg reds
before a consumer finds out.

## 0.8.0 — THE FOURTH ALARM: everything 0.7.0 opened falls due

Nothing in this section invents a sweep. **The four ramps 0.7.0 opened all fall
due here** — `version-sync` (the iOS toolchain floor), `data-flow` (the
export-target deadline), `docs-sync` (the deferral ledger), `reviewer-verdicts`
(the path_state binding) — and the remedy for each is the one the 0.7.0 section
above already wrote down, in "The new ramps" rows. What IS new is the injected
step: `update` grows your chain to **34** (`observability`, right after
`boundaries`), which re-opens the AGENTS.md gate-list NOTE one more time and
adds this release's own new ramp.

One of the four never appears in `pnpm validate` output, so the count command
below under-reports it by construction: `reviewer-verdicts` is a Stop-chain step
— it fires when a turn tries to end, and the sweep is RUNNING the owed reviewers
to a `VERDICT: PASS` after the last edit to the paths that summoned them, not
editing files.

| Your `baseVersion` | What 0.8.0 does to you |
|---|---|
| **0.7.0** | **None of the four touches you** — every one has been live on your install since you graduated. You meet only this release's NOTEs: the AGENTS.md gate-list drift (paste the 34 names the finding prints) and, if your tree hand-wired a vendor telemetry SDK before the gate existed, `observability`'s containment findings. Both expire in 0.9.0. |
| **0.6.0** | **The four close at once** — your first deadline ever, met with no older debt: the cleanest sweep in the lineage since 0.7.0 said the same of 0.5.0. The 0.7.0 section's "The new ramps" rows ARE your sweep list — the eas.json pin, the export adopt-or-re-review, the deferral ledger, the reviewer re-run — plus the AGENTS.md paste for the injected step. |
| **0.5.0 / 0.4.0** | The four, plus the 0.6.0-era fleet you have not met yet — on the way through, not because of this release. Follow the 0.7.0 section first (it is your biggest pile), then this one. |
| **0.3.0 and below** | Follow 0.4.0's section, then 0.5.0's, then 0.6.0's, then 0.7.0's, one `graduate` per hop — each hop shrinks the next. This page's own CI proof (leg E) crosses 0.3.0 → 0.8.0 by exactly that route, sweeping as it goes. |
| fresh `init` at 0.8.0 | Nothing ever ramped. |

The honest count is still the command, never this table — minus the Stop-side
caveat above:

```sh
pnpm validate 2>&1 | grep 'RAMP EXPIRED'
```

And the population is not prose either: `template/migrations.json`'s
`0.8.0.rampExpiry` record states it as data, and `scripts/check-ramp-ledger.mjs`
reds if it disagrees with what the shipped call sites actually compute.

### The new ramps — the debt this release opens, expiring in 0.9.0

**`observability`: vendor telemetry containment** (the injected 34th step). No
telemetry SDK import outside the reviewed `tools/observability.json` `sinks[]`
register, and every declared sink referencing its redaction symbol in code — the
seam header's own invariant (`packages/platform/observability/src/index.ts`,
"NO VENDOR SDK, on purpose"). A fresh 0.8.0 tree is clean by construction; this
NOTEs only if YOUR tree wired a transport by hand (the module patch docs predate
the gate). The moves are the finding's: register the sink —
`{ "file": "<path>", "vendors": ["@sentry/"], "redaction": "redactFields",
"reason": "<40+ chars>" }`, with the file referencing the symbol — or remove the
import and attach the vendor at the seam's `LogSink` per the module patches. The
register is planted when absent; the detector may be extended, never narrowed.

**`docs-sync`: the AGENTS.md gate-list NOTE, re-opened.** Same as 0.6.0, same
reason, recorded the same way (the `rampExtensions` entry in
`template/migrations.json` `"0.8.0"`): the injected step grows your chain while
your seeded AGENTS.md is yours alone to edit. Paste the 34 names the finding
prints into the "The N gates, in order:" sentence and the "N-step chain" line.
The escape ends at 0.9.0.

### Then graduate

Sweep the reds (the 0.7.0 rows), paste the gate list, clear any containment
NOTEs, then `npx next-expo-supabase-agent-harness graduate` — it refuses while a
chain NOTE stands, and moving `baseVersion` to 0.8.0 is what retires every ramp
at or below it. This section is executed, not reviewed: the upgrade lane's leg E
runs exactly this page against a v0.3.0 install and reds the release if
`graduate` cannot reach its success branch.

## 0.9.0 — THE FIFTH ALARM: everything 0.8.0 opened falls due

Nothing in this section invents a sweep. **The two ramps 0.8.0 opened both fall
due here** — `docs-sync` (the re-opened AGENTS.md gate-list NOTE after the
injected `observability` step) and `observability` (the vendor-telemetry
containment closure) — and the remedy for each is the one the 0.8.0 section
above already wrote down in "The new ramps". What is deliberately NOT here: no
step is injected (your chain stays 34, byte-identical), no deadline moves, and
the census deferral fired on schedule a second time (`tools/deferrals.json`
moved `auth-posture-cli-census` to 0.10.0 against a still-unchanged upstream).

**If you applied the crash-reporting or observability module before 0.9.0**,
read this first: the pre-0.9.0 patch docs instructed a `"redaction":
"redactFields"` register row while the code they plant references
`redactCrashEvent`/`redactText` — instructions the gate itself reds. The 0.9.0
patch docs carry the corrected rows (append the real symbols to
`redactionSymbols`, one sink row per vendor-importing file, and the
`metro.config.js` require registers as `"kind": "buildConfig"`, which needs no
redaction symbol because a bundler plugin registration transports no event).
Re-apply the register rows from the corrected docs; the code the patches planted
is unchanged.

| Your `baseVersion` | What 0.9.0 does to you |
|---|---|
| **0.8.0** | **Neither expiry touches you** — both have been live on your install since you graduated. You meet only this release's NOTEs, and only when their findings exist: `version-sync` reds an ABSENT `pnpm-lock.yaml` (run `pnpm install`, commit the lockfile) and `wiring` reds a committed-but-not-installed lefthook (run `pnpm install`). A tree with a committed lockfile and installed hooks sees nothing. Both expire in 0.10.0. |
| **0.7.0** | **The two close at once** — your first deadline ever, met with no older debt (the property the upgrade lane's leg H isolates). The sweep: paste the 34 gate names the `docs-sync` finding prints into your AGENTS.md, and clear any `observability` containment findings (register the sink with the CORRECTED symbol rows above, or remove the hand-wired import). |
| **0.6.0** | The two, plus the 0.8.0 pile you have not met yet — follow the 0.8.0 section first, then this one. |
| **0.5.0 and below** | Follow each section in order — 0.4.0's, 0.5.0's, 0.6.0's, 0.7.0's, 0.8.0's, then this one — one `graduate` per hop; each hop shrinks the next. |
| fresh `init` at 0.9.0 | Nothing ever ramped. |

The honest count is still the command, never this table:

```sh
pnpm validate 2>&1 | grep 'RAMP EXPIRED'
```

And the population is not prose either: `template/migrations.json`'s
`0.9.0.rampExpiry` record states it as data, and `scripts/check-ramp-ledger.mjs`
reds if it disagrees with what the shipped call sites actually compute.

### The new ramps — the debt this release opens, expiring in 0.10.0

**`version-sync`: the committed-lockfile floor.** The absent-lockfile NOTE this
replaces claimed "CI always has one" — false: the shipped workflows run
`pnpm install --frozen-lockfile`, which hard-fails with no committed lockfile,
and a fresh resolution drifts against the live registry (two installs a day
apart were measured 230 lock-lines apart). The move is one command:
`pnpm install`, then commit `pnpm-lock.yaml`. `doctor` names the
committed-but-untracked case too.

**`wiring`: the commit-time layer installed, not dormant.** A committed
`lefthook.yml` with nothing in `.git/hooks` is layer 2 fully disarmed while
every description of the harness counts it armed. The move is one command:
`pnpm install` (the prepare script), or `pnpm exec lefthook install`.

### Then graduate

Sweep the reds (the 0.8.0 rows), paste the gate list, clear any containment
NOTEs with the corrected register rows, then
`npx next-expo-supabase-agent-harness graduate`. A `baseVersion` 0.8.0 install
with a committed lockfile and installed hooks sweeps NOTHING — graduate reaches
its success branch untouched, the first un-swept graduation in the lineage, and
the upgrade lane's leg A holds the release to exactly that.

## 0.10.0 — THE SIXTH ALARM, and the largest: SIX expiries at once

**Read this paragraph before anything else in this section, because it is the
remedy and everything below it is detail.** Six ramps fall due here. If you are
upgrading from **0.8.0 or older, do not hop straight to 0.10.0** — upgrade **one
minor at a time**. Every `graduate` moves your `baseVersion` forward, and every
ramp at or below it goes *inert*: it never fires and never expires. A 0.8.0
install that goes `0.9.0 → 0.9.5 → 0.9.9 → 0.10.0` meets **0, then 2, then 2,
then 2** gates instead of six in one run. That is not a trick — it is the
mechanism working as designed, and it is the difference between four short
sweeps and one long one.

There is deliberately **no flag that extends a deadline** (see the top of this
runbook), so staggering the hops is the only lever, and it is a real one.

**Why six at once is worse than six spread out.** `tools/validate.mjs` is
FAIL-FAST: it stops at the first red gate. So a human meets these **one per
run** — five round trips, at roughly 24 s each, before seeing the last one. The
Stop chain does not stop early, so an agent sees all six in a single block. That
is why this release also bounds the Stop gate's output: each failing step's full
output now goes to `.harness/stop-output/<gate>.log` and the block carries a
head, a tail and the path, because the previous tail-only truncation dropped the
*first* finding of exactly this kind of flood.

| Your `baseVersion` | What 0.10.0 does to you |
|---|---|
| **0.9.9** | **Nothing expires.** You meet three advisory NOTEs for the ramps this release OPENS (the AGENTS.md Stop-chain list, the axe tag ladder, the outage-rung fallback declaration), all due 0.11.0. The upgrade lane's leg A holds the release to exactly that. |
| **0.9.5** | **Two:** `auth-posture` (the ten `[auth.mfa]` keys) and `version-sync` (the end-of-life register). The first release where a 0.9.x install meets a deadline at all. |
| **0.9.0** | **Four:** those two plus `docs-sync` (the AGENTS.md agent-surface list) and `boundaries` (the vertical-anatomy laws). |
| **0.8.0** | **Six** — the four above plus `version-sync`'s committed-lockfile floor and `wiring`'s installed-not-dormant lefthook floor. Both of those are **one command**: `pnpm install`, then commit `pnpm-lock.yaml`. (Six EXPIRIES across five gate names: `version-sync` fires twice, once for the lockfile floor and once for the end-of-life register. `grep 'RAMP EXPIRED'` prints one line per expiry, so you will see six.) |
| **0.7.0 and below** | Six, plus everything the earlier sections describe that you have not met yet. Follow each section in order, one `graduate` per hop. |
| fresh `init` at 0.10.0 | Nothing ever ramped. |

The honest count is the command, never this table:

```sh
pnpm validate 2>&1 | grep 'RAMP EXPIRED'
```

And the population is data, not prose: `template/migrations.json`'s
`0.10.0.rampExpiry` states it, and `scripts/check-ramp-ledger.mjs` reds if that
record disagrees with what the shipped call sites compute.

### The six, and the move for each

Two are trivial and are listed first so you can clear them before reading on.

- **`wiring` — the lefthook floor.** `pnpm install` (the prepare script), or
  `pnpm exec lefthook install`.
- **`version-sync` — the committed-lockfile floor.** `pnpm install`, then commit
  `pnpm-lock.yaml`.

The remaining four land on files `update` **cannot** rewrite, because they are
yours:

- **`auth-posture` — the ten `[auth.mfa]` keys.** `supabase/config.toml` is
  seeded. The 0.9.9 section above has the reviewed block; append it if you have
  not already. Exactly ten keys across four sections, checked by value in both
  directions, so a typo that the CLI silently ignores reds here.
- **`version-sync` — the end-of-life register.** `tools/eol.json` was planted at
  0.9.9 with six rows drawn from the harness's own lockfile. Yours is a superset,
  so dispose of whatever else your tree resolves: each row records the package,
  the scope, and why it is accepted or when it goes.
- **`docs-sync` — the AGENTS.md agent-surface list.** `AGENTS.md` is seeded. The
  finding prints the exact list; paste it in.
- **`boundaries` — the vertical-anatomy laws.** `packages/**` is seeded. Each
  finding names the package, the law and the path. The escape, where a finding is
  wrong for your architecture, is a reviewed entry in
  `tools/vertical-anatomy-allow.json` — and a stale entry reds, so it cannot rot.

### The seeded-source sweep (five files, one instruction)

Separately from the expiries, `update` parks one `seededSourceFixes` instruction
covering five files it cannot edit for you: the two axe specs, the tenant
switcher's link sizing, the rate limiter's outage rung, and its budget policy's
new `fallback` field. `npx next-expo-supabase-agent-harness doctor` surfaces it,
and each probe self-clears once your tree stops matching the broken shape. Those
corrections are **not** on a deadline in this release — the checkers that demand
them are ramped to 0.11.0.

### Then graduate

Sweep the reds, then
`npx next-expo-supabase-agent-harness graduate`, then re-run `pnpm validate`.

## 0.11.0 — THE SEVENTH ALARM, and the widest population the lineage has published

**Twelve vintages meet a hard failure** (0.1.3 through 0.9.9), against eleven at 0.10.0 —
and it is the first wave ever to reach a 0.9.9 install. **Five ramps fall due at once**
across four gate names: `docs-sync` (twice), `web-e2e`, `version-sync` and `rate-limits`.

**If your `baseVersion` is 0.10.0 you are UNAFFECTED.** Four of the five carry
`minVersion 0.10.0`, and a ramp is inert when `baseVersion >= minVersion` — the demand was
live for you from your first validate, so nothing expires. This section is for installs
seeded before the demand existed.

**THE MITIGATION IS THE ONE THAT HAS ALWAYS WORKED, and it is stated first rather than
last: UPGRADE ONE MINOR AT A TIME.** Each `graduate` moves `baseVersion` forward and every
ramp at or below it goes inert. `tools/validate.mjs` is FAIL-FAST, so a human meets these
one per run — five round trips before you see the last. There is no flag that extends a
deadline; moving one needs a reviewed `rampExtensions` entry in the harness itself.

### What you must sweep, in the order the chain will ask for it

1. **`tools/eol.json` — the uuid acceptance (gate: `version-sync`).**
   **CORRECTED AT 0.11.1 — on 0.11.1 or later this is a NOTE, not a hard red; see the
   0.11.1 section below. The paragraph that follows describes 0.11.0 only.** The register
   ships a
   `removalTarget` the HARNESS wrote, your copy is SEEDED, and `update` may never rewrite
   it. At 0.11.0 that date arrives AND the ramp that softened it into a NOTE expires, so
   the finding is hard. Re-affirm the acceptance — move `removalTarget` to a release you
   actually mean, recording what you re-checked in the diff — or remove the dependency.
   This is the one correction this release parks for you through `seededSourceFixes`.
2. **`AGENTS.md` — the Stop-chain list (gate: `docs-sync`).** The sentence
   "The N Stop-chain steps, in order:" must agree with your floor. `AGENTS.md` is seeded,
   so `update` cannot correct it. v0.3.0, v0.4.0 and v0.5.0 each shipped "The 9 Stop-chain
   steps" against a 10-step floor. If your file carries no such sentence, you are green by
   the absent-is-green rule — a fork may decline to document the Stop chain.
3. **`docs/adr/**` — ADR content shape (gate: `docs-sync`).** Load-bearing sections need
   real bodies, `Status` comes from a closed vocabulary, corpus refs must resolve, and
   source hosts must be allowlisted. ADRs are owned by you, which is why this had two
   releases of runway rather than one.
4. **The seeded axe scans (gate: `web-e2e`).** `apps/web/e2e/*.spec.ts` calling
   `withTags([...])` must carry the full ladder `['wcag2a','wcag2aa','wcag21aa','wcag22aa']`
   — `withTags` NARROWS axe, so a short list is a decision not to run everything outside it.
   Stated as counts and never as a level: those four tags select 63 runnable rules over 21
   success criteria. An UNTAGGED scan is exempt because it runs more.
5. **`tools/rate-limit-budget.json` — `failOpen.fallback` (gate: `rate-limits`).** The block
   records WHETHER the limiter fails open; it must now also say WHAT limits traffic while it
   does. `update` cannot write this for you because the honest answer depends on your
   deployment.

Items 2, 4 and 5 were parked for you by the 0.10.0 record as advisory `seededSourceFixes`.
At 0.11.0 they stop being advisory.

### What this release OPENS, recorded beside what it closes

**The web account-deletion surface (gate: `data-flow`), advisory until 0.12.0 — which
was never cut, so it arrives at 1.0.0 (every comparison is `>=`).** The
`delete-account` Edge Function and the mobile command that calls it have shipped since
0.7.0; `tools/data-flow.json` now carries an `erase` record whose `clients` closure names
BOTH initiators, so the rule that holds export to a delivered surface holds erase to one
too. Your web app is very likely missing its half. Two reasons it arrives as a NOTE and not
a file: `tools/data-flow.json` is SEEDED, so `update` cannot write the record for you, and
`apps/web/app/(protected)/` has been `seedOnInitOnly` since 0.2.0, so `update` was never
going to plant the button either. A FRESH 0.11.0 scaffold is seeded with the whole surface
and held to it immediately. Yours is yours to add — the shape to copy is
`apps/web/lib/account/delete-account.ts` in a fresh scaffold: server-side deletion FIRST,
local session dropped only after it succeeds. Apple 5.1.1(v) already requires this of the
mobile half.

### After this release, one ramp is left — and it is the one above

Every ramp opened BEFORE this release is now inert or expired. Exactly one of the 43
shipped `rampNote` sites is still advisory, and 0.11.0 is the release that opened it — so
`graduate`'s refusal-while-NOTEs-stand has exactly one thing left to hold, and adding the
erase surface clears it. For the count that applies to YOUR `baseVersion`, run
`pnpm validate 2>&1 | grep 'NOTE — (ramp)'`; never read it off this page.

## 0.11.1 — a correction to 0.11.0, and one less thing to sweep

**If you are on 0.11.0 already, nothing here applies to you** — your baseVersion is at or
above every escape this release touches, and you meet nothing. This section is for an
install crossing 0.11.0 on its way to 0.11.1 or later.

**One expiry is withdrawn.** `tools/eol.json`'s uuid acceptance — item 1 of the 0.11.0 list
above — is a dated **NOTE** on 0.11.1, not a hard red, and it now falls due at 0.12.0 (a
release that was never cut: it arrives at 1.0.0). So
you meet **four** expiring sites crossing this hop rather than five: `docs-sync` twice,
`web-e2e` and `rate-limits`. Items 2 through 5 above are unchanged and still hard.

**Why it was withdrawn, because "we moved a deadline" deserves a reason.** The escape was
live for exactly the population it could not help. A ramp is inert once your `baseVersion`
reaches its `minVersion`, and that one opened at 0.10.0 — so a 0.10.0-vintage install was
never covered by it, and a 0.10.0-vintage install is the only one whose seeded
`tools/eol.json` carries a `removalTarget` of `"0.11.0"` that the harness itself wrote. You
would have met a hard failure, on your first `validate` after `update`, for a value you did
not choose, in a file `update` is not allowed to fix for you. That is not an expiry — no
deadline of yours had been reached — and the upgrade lane refused the release for it.

**You still owe the row.** Re-affirm the uuid acceptance and move `removalTarget` to a
release you actually mean, recording what you re-checked in the diff. The deadline is 0.12.0
— met at 1.0.0, since 0.12.0 was never cut — and the HARNESS will not move it in your file
again (its own copy moved to 1.1.0 on fresh evidence, which reaches fresh scaffolds only): `check-eol-target` now reds any harness PR that would ship an
arrived target, so the harness cannot re-author this date into your seeded file a fourth
time.

## 1.0.0 — THE SETTLEMENT RELEASE: 0.11.1 to 1.0.0 direct, no 0.12.0 ever cut

Every comparison in the fleet is `>=`, so the deadlines the 0.11.x releases wrote as
`0.12.0` arrive at THIS hop exactly as they would have at a 0.12.0. Read the count that
applies to YOUR `baseVersion` off `pnpm validate 2>&1 | grep 'NOTE — (ramp)'` and, for the
expiries, off `node scripts/ci/ramp-expectations.mjs <your base> 1.0.0` in a harness
checkout — never off this page. What the page owes you is the SHAPE, and the sweep.

**One release at a time.** 1.0.0 is a major bump and a large one; if you are more than
one release behind, hop to 0.11.1 first (its section is above) and let its expiries settle
before crossing this one. `update` will happily hop further — the ramps compose — but the
list below is written for an install arriving from 0.11.x, and an install arriving from
0.9.x meets this list PLUS everything the sections above owe it.

### What ARRIVES (hard) — for installs below 0.11.0

- **The web account-deletion surface (gate: `data-flow`).** The 0.11.0 NOTE falls due.
  Add the web erase half (the shape is `apps/web/lib/account/delete-account.ts` and the
  `(protected)` button + layout in a fresh scaffold) or the record in `tools/data-flow.json`
  stays a promise the gate reds. A `baseVersion` of 0.11.0 or later meets nothing here.

### What OPENS (dated NOTEs, until 1.1.0) — for EVERY install below 1.0.0

Six gates, each ramped at `minVersion 1.0.0`, so `graduate` refuses until each is swept:

1. **`suppressions` (NEW chain step, 35 of 36)** — the inline-directive census over
   `apps/`, `packages/`, `supabase/`. `update` PLANTS `tools/suppressions-allow.json` with
   rows describing the 1.0.0 seeded tree; a tree of yours that carries a directive the
   register does not name NOTEs until you add its row (with a `why` — a reviewed sentence),
   and a planted row naming a directive your tree lacks NOTEs as a stale acceptance until you
   drop it. Reconcile the register to YOUR tree; the gate never invents a `why` and neither
   should you.
2. **`resilience` (NEW chain step, 10 of 36)** — the outbound-seam posture register.
   `update` PLANTS `tools/resilience.json` describing the seeded seams; a seam you added
   NOTEs until it has a row.
3. **`docs-sync`'s gate list** — your seeded `AGENTS.md` says "34 gates"; the chain now
   runs 36. Paste the 36 names the NOTE prints (the same edit 0.6.0 and 0.8.0 asked for).
4. **`boundaries`' anatomy widening** — the DAL laws are behaviour-keyed now (a client
   value-import anywhere under `src/**`; PostgREST callers owe a resolving `port.ts`
   import). Findings carry a `vintage`; the widened ones NOTE until 1.1.0.
5. **`version-sync`** — two things: the seeded **vendor-support register**
   (`tools/support-register.json`, planted) with its platform-fact closure, and the
   **uuid arrival**: your seeded `tools/eol.json` says `removalTarget: 0.12.0`, that date
   arrives at 1.0.0, and the harness re-dated its OWN copy to 1.1.0 on fresh registry
   evidence (a caret-range correction; `scripts/sweep-registry-deprecations.mjs` is the
   review method). The re-date reaches you as a PARKED fix under `.harness/pending/`
   (`seededSourceFixes` probe on the old literal) — apply it, or re-affirm the row under a
   target you mean, or remove the dependency. The 0.11.1 section said "the deadline will
   not move again" and meant the HARNESS would not re-author your file; it did not, and the
   NOTE is the runway to apply the parked fix rather than a hard red on your first validate.
6. **`auth-posture`'s `[auth.hook.*]` floors — ONLY IF you adopt the auth-event trail.**
   The trail is a migration (`20260816000000_auth_event_trail.sql` + the declarative twin
   `45_auth_trail.sql`, its pgTAP suite and its live wiring test) and two config sections
   that bind GoTrue's password/MFA verification hooks to it. `update` writes neither: the
   migration is your append-only history and `config.toml` is yours. **The two halves are
   ONE act**, and the gate holds it: with the migration in your tree the four hook floors are
   demanded (NOTE until 1.1.0 for a pre-1.0.0 base); with a hook `enabled = true` and NO
   migration, the gate is a HARD red — GoTrue would call a function nothing created and every
   sign-in would fail; with neither, nothing is demanded and one plain line says so. Adopt
   both together (`docs/adr/20260816-auth-event-trail.md` shows both), and restart the auth
   container (`supabase stop && supabase start` — `db reset` does not reload hook config).

### What is WITHHELD, and what the sweep adopts for you

`seedOnInitOnly` in the 1.0.0 record: the MFA enrolment surface (web `sign-up`,
`sign-in/mfa`, `(protected)/security`; mobile `sign-up`, `mfa-challenge`, `security` with
their suites), the privilege-lifecycle + JIT migration, the auth-event trail, and
`security.txt`. The documented sweep (`scripts/ci/upgrade-sweep.mjs`, `SWEEPS['1.0.0']`) is
what upgrade-lane leg E executes and what proved this list SUFFICIENT — and it was written by
running that leg, not by reading the record:

- It ADOPTS the **web** MFA seams — because the 0.6.0 parked fixes copy HEAD's
  `sign-in/page.tsx`, `sign-in-form.tsx` and `@app/supabase`'s `client.ts`, and at 1.0.0
  those import the MFA ceremony; the importers without the imported is a `dead-code`
  "unresolved imports" red and a `route-manifest` red for allowlisted pages that do not
  exist. If you applied those parked fixes, adopt the web MFA files with them
  (`update --refresh-seeded apps/web/app/sign-in/ apps/web/app/sign-up/ "apps/web/app/(protected)/security/" packages/platform/supabase/src/mfa-actions.ts packages/platform/supabase/src/mfa-flow.ts`).
  The mobile screens are yours to adopt deliberately (route registry, i18n catalog,
  startup budget).
- It RECONCILES `tools/data-flow.json`'s `export.excluded` to your migrations — the 0.7.0
  parked fix copies HEAD's file, whose excluded set names `admin_elevations`, a table only
  the (withheld) JIT migration creates; `check-data-flow` reds a stale exclusion and its
  own remedy is to remove it. Drop the entry, or adopt the JIT migration deliberately (it
  REPLACES `private.member_ranks` and rewrites `memberships` policies — read it first).
- It does NOT append the `[auth.hook.*]` block and does NOT adopt the trail (item 6 above
  says why: the two halves travel together or not at all, and the trail drags three seeded
  wiring files behind it — `tools/rls-exempt.json` rows, the pgTAP `rls_targets` list, the
  client suite's `ISOLATION_TARGETS`).

### After this release

Every ramp opened before 1.0.0 is inert or expired. The advisory column is exactly the
six-gate 1.0.0 fleet, all dated 1.1.0, and each has an obligations row that owes the 1.1.0
record its expiry. `graduate` refuses while any of them NOTEs; the sweep above clears the
ones a script may clear, and the rest (registers naming YOUR code, the paired trail
adoption) are yours.

## 1.0.1 — a patch: nothing expires, nothing opens, and the lock follows the re-pin

**If you are on 1.0.0 already, no ramp here applies to you** — `EXPIRED` and `NOTING` are
both empty at `baseVersion` 1.0.0 (`node scripts/ci/ramp-expectations.mjs 1.0.0 1.0.1` in the
harness repo says so). The population 1.0.0 reds is restated in this release's record because
a direct hop from an old vintage crosses 1.0.0's record on the way and meets its expiries on
arrival; the 1.0.0 section above is the sweep, and 1.0.1 adds nothing to it.

**What `update` plants.** Three owned files, re-planted when your copy still matches the
recorded sha: `tools/check-diff-coverage.mjs` (the comment-stripping fix — on a 1.0.0
scaffold the gate was demanding coverage the runner never measured for everything below the
first apostrophe inside `vitest.config.ts`'s exclude array), `.claude/settings.json` (the
`~/.claude` deny narrowed to the two settings files, so plans and memory can persist under
`~/.claude`), and `.claude/agents/architecture-reviewer.md` (`model: opus` → `model: fable`).

**The agent lock follows the re-pin.** `update` never regenerates an existing
`tools/agents.lock.json`, because that would launder every edit made since the last one.
It re-records only the entries of the agent-surface files it rewrote itself, hash and
model pin together. If your `architecture-reviewer.md` was untouched, `update` rewrites
it, the lock records its new model, and `prompts` does not red on it: nothing is owed.
If you had edited it, `update` keeps your copy and parks the incoming one under
`.harness/pending/` (see "Forking an owned file" in the 1.0.2 section). Merging it is
your edit, so `prompts` reds on it until a human runs
`HARNESS_ALLOW_SELF_EDIT=1 node tools/gen-agents-lock.mjs --write` and commits the lock
with the merge. That is not a ramp and has no deadline.

## 1.0.2 — a security patch: the `next` floor moves, and it reds every install below it

**No ramp here applies to a 1.0.0 or 1.0.1 install**, and the population 1.0.0 reds is
restated in this release's record for the same reason 1.0.1 restated it. What follows is
not a ramp, and no vintage is exempt from it.

**Expect `version-sync` to red after `update`.** `tools/framework-floor.json` is
harness-owned, so `update` refreshes it; `pnpm-workspace.yaml` is seeded, so `update` does
not touch your pins. The `next` floor is now **16.3.3** (or **15.5.24** on the 15 line), for
the two critical advisories in the
[August 2026 security release](https://nextjs.org/blog/august-2026-security-release):

- **GHSA-2xp9-vwfh-vxw4**: unauthenticated remote code execution when the Image
  Optimization API optimizes an attacker-controlled AVIF image. The patched releases
  disable AVIF optimization until an upstream fix propagates.
- **CVE-2026-75604**: unauthenticated remote code execution for apps using both the Pages
  Router and the App Router without Cache Components, when the server uses a Windows
  filesystem. Linux and macOS are not affected.

Upstream patched no 16.2 release, so a 16.2.x pin moves to 16.3.x. **That is a minor bump of
your web framework**, which this harness otherwise pins exactly to avoid. A fresh scaffold
passes the whole chain on 16.3.5, which is what new installs now pin. Your app has code the
scaffold does not, so read the [16.3 release notes](https://nextjs.org/blog/next-16-3)
before you take it:

```
# raise the `next` pin in the pnpm-workspace.yaml catalog, then
pnpm install && git add pnpm-lock.yaml pnpm-workspace.yaml
pnpm validate
```

If you deploy to Vercel or another Linux host, use the App Router only and configure no
remote images, your exposure to both advisories is narrow. The floor does not ask: there is
no flag that lowers it, for the reason the 0.5.0 section gives.

**Expect `version-sync` to red on `eslint` 9 as well, and this one is not caused by the
update.** The vendor ended the ESLint 9 line on 2026-08-06 and has since flagged every 9.x
release on the registry. `tools/eol.json` is seeded, because its rows are your decisions,
so `update` does not touch your copy. The next time your lockfile re-resolves, the census
reds on a deprecated package your register has no row for. Two ways to clear it:

```
# if you have never edited tools/eol.json: take the harness's register, which now
# carries an eslint 9 row (overwrites when untouched, parks on drift)
npx next-expo-supabase-agent-harness update --refresh-seeded tools/eol.json

# if you have your own rows: copy the eslint row from the parked or template copy into yours
```

The row accepts ESLint 9 as a development dependency because
`eslint-plugin-react-native-a11y` and `eslint-plugin-jsx-a11y` do not yet admit ESLint 10.
`react-native` 0.84 also left the supported set. The scaffold has never shipped below 0.86,
so that reds only a tree that was moved down by hand.

### One migration you have to write yourself: revoke `authenticated`'s default write grants

Supabase's default privileges grant ALL on every new `public` table to `authenticated`.
The migrations that created the seven tables `authenticated` may only read revoked that
from `anon` and `service_role`, then granted `SELECT` to `authenticated`. A GRANT adds a
privilege and removes none, so `authenticated` kept INSERT, UPDATE, DELETE, TRUNCATE,
REFERENCES and TRIGGER on them.

Row security still refused every client write, because all seven are `FORCE ROW LEVEL
SECURITY` with deny-all write policies. So this is a missing layer and not an open door.
It still needs closing: table privileges are checked before row security, and row security
does not apply to TRUNCATE at all. `docs/adr/20260920-authenticated-write-revoke.md`, which
this update plants, has the full account.

A fresh scaffold gets `supabase/migrations/20260920000000_authenticated_write_revoke.sql`.
**`update` does not plant it in your project**, because `supabase/migrations/` is your
applied history and a file with the harness's timestamp could sort ahead of migrations you
have already applied. Create your own:

```
supabase migration new authenticated_write_revoke
```

and put this in it, keeping only the tables your project has (`admin_elevations` arrived in
1.0.0; the three quota tables and the three seat tables in 0.2.0):

```sql
-- adr: docs/adr/20260920-authenticated-write-revoke.md
-- SOURCE: https://www.postgresql.org/docs/17/ddl-priv.html
REVOKE ALL ON TABLE public.orgs FROM authenticated;
REVOKE ALL ON TABLE public.memberships FROM authenticated;
REVOKE ALL ON TABLE public.invitations FROM authenticated;
REVOKE ALL ON TABLE public.admin_elevations FROM authenticated;
REVOKE ALL ON TABLE public.org_usage FROM authenticated;
REVOKE ALL ON TABLE public.org_quota FROM authenticated;
REVOKE ALL ON TABLE public.quota_defaults FROM authenticated;

GRANT SELECT ON TABLE public.orgs TO authenticated;
GRANT SELECT ON TABLE public.memberships TO authenticated;
GRANT SELECT ON TABLE public.invitations TO authenticated;
GRANT SELECT ON TABLE public.admin_elevations TO authenticated;
GRANT SELECT ON TABLE public.org_usage TO authenticated;
GRANT SELECT ON TABLE public.org_quota TO authenticated;
GRANT SELECT ON TABLE public.quota_defaults TO authenticated;
```

The `-- adr:` line is required: your `migrations` gate treats a `REVOKE ... FROM
authenticated` as a change to an authorization control. Do the same for any table of your
own that `authenticated` should only read. Then `pnpm db:reset && pnpm db:test`.

**You may meet this as a red test before you read this page.** `rls_structure.test.sql`
has asserted "authenticated holds NO write grant" on the seat tables since 0.2.0. It passed
against the local stack of Supabase CLI 2.115 and fails against 2.117, which applies the
default privileges the way the platform documents them. If that assertion goes red after a
CLI upgrade, the test is right and this migration is the fix. To pull the stricter version
of the test, which covers all seven tables and TRUNCATE:
`npx next-expo-supabase-agent-harness update --refresh-seeded supabase/tests/rls_structure.test.sql`,
after the migration is applied.

### The authoring guidance now teaches the revoke this release shipped

The migration above exists because a GRANT adds a privilege and removes none. Until this
release the places that TEACH a new table's grants still showed the old shape: revoke
`anon` and `service_role`, then grant `authenticated`. An agent following them wrote
exactly the table the new privilege assertion reds. They now teach three revokes (`anon`,
`service_role`, `authenticated`) and then a grant of exactly the operations the table's
policies admit, name TRUNCATE, REFERENCES and TRIGGER as what the default leaves behind,
and say that the `authenticated` revoke needs the `-- adr:` marker your `migrations` gate
asks for.

`update` delivers this to the harness-owned files: the `migration-rls-author` and
`security-reviewer` agents, the `/new-migration`, `/new-feature` and `/rls-check` commands,
both authoring skills and `.claude/rules/security-invariants.md`. **`AGENTS.md` and
`supabase/AGENTS.md` are yours, so `update` does not touch them.** If yours still say
"`REVOKE ALL` from `service_role`, and grants to `authenticated`", change that clause to:

> `REVOKE ALL` from `anon`, `service_role` AND `authenticated`, then the EXACT grants its
> policies admit (a GRANT removes nothing; the default leaves it TRUNCATE).

The shipped example migrations keep the older shape. They are applied history, and the
seven read-only tables are corrected by the migration above. For a writable table of your
own, the same three statements and an exact re-grant are the fix.

### Forking an owned file: re-record it, and `update` parks instead of overwriting

Sometimes a harness-owned file has to change for your project: a gate script that needs a
local fix before upstream ships one, a workflow with a lane you run differently. The
supported way to keep such a fork is the one `gate-integrity` already pushes you towards:
edit the file, then have a human re-record its `sha256` in `.harness/manifest.json` in a
reviewed commit. The gate goes green, and the record is visible in the diff.

**Until 1.0.2 that record was also the fork's death warrant.** `update` read "the bytes
match the manifest" as "the harness wrote them", so a re-recorded fork looked pristine and
was overwritten on the next update, silently, with exit 0. `disable` and a `removed`
migration deleted one the same way, and the installer did it to two files it had recorded
itself: `.claude/settings.json` after a retrofit merged your settings into it, and a root
config whose retrofit conflict you had just resolved by merging.

From 1.0.2 `update` asks a different question: did a release ever ship these bytes? The
installer now carries, per version, the sha of every owned file it has shipped
(`template/shas/` in the harness repo; nothing is added to your tree). A recorded sha that
matches none of them is a fork, and:

- **the file is kept**, whatever `update` brings;
- **the incoming version is parked** at `.harness/pending/<path>` only when upstream
  actually changed that file since your install's version. Merge it, re-record, delete
  the parked copy. `update` exits 2 while anything is parked, exactly as it does for drift;
- **nothing is parked when upstream left the file alone**. The run lists your forks in one
  note and the exit code stays 0. A fork does not cost you a red update forever;
- `update --dry-run` now names every path it would write, and `doctor` lists each fork as
  `info` without changing its exit code, so you can see what a run will do before it does it;
- `update --force` still means "discard my local version". It overwrites forks too.

A file pinned back to an *older* release's bytes is treated the same way, and the note
says which release it matches.

Do not reach for the quieter escape of editing the record's `mode` to `seeded`. It does
stop `update` from touching the file, and it also takes the file off the hash surface, so
`gate-integrity` no longer notices anyone editing it. Re-recording keeps the evidence.

Two limits. `update` rebuilds a placeholder-bearing file's template source from the
answers in your manifest, so hand-editing `answers` afterwards makes those files read as
forks (parked, never lost). And `tsconfig.json` is exempt: the installer derives its
project references at install time, so no release's bytes can match it, and it is
refreshed as before.

### The shipped workflows now fail a broken pipe, and every job has a ceiling

`update` refreshes every workflow under `.github/workflows/` that you have not changed. Two
things are different in them.

**Every workflow selects `shell: bash` at the top.** GitHub runs a step that names no shell
as `bash -e`, without `pipefail`, so `producer | tee file` reported `tee`'s status and the
producer's failure was lost. That is what `gate-summary` was: the check you were told to
mark required printed `gate-summary: FAIL` and exited 0. It now goes red when a lane it
covers is red. **If `gate-summary` turns red on the first run after this update, open the
lane it names.** The lane was already failing; the summary has started saying so. Two other
steps were rewritten for the same class: the pull request mutation lane no longer reads a
scoper that failed closed as "nothing to mutate", and the `native` job's targetSdk check
still prints why it failed.

**Every job has a `timeout-minutes`.** Without one a hung step costs GitHub's 360-minute
default before anything reports. The ceilings are several times what the lanes take on a
fresh scaffold, and a job that times out is reported as cancelled, which `gate-summary`
already counts as a failure. If one of your lanes legitimately runs longer than its
ceiling (mutation testing and CodeQL grow with your code), raise the number in your copy
of the workflow and re-record its sha, as this release's "Forking an owned file" section
describes: `update` keeps a fork and parks the incoming version for you to merge.

## 1.0.3 — a patch: nothing expires, nothing opens, one pin to raise by hand

**No ramp here applies to a 1.0.0, 1.0.1 or 1.0.2 install.** The population 1.0.0 reds is
restated in this release's record for the same reason 1.0.1 and 1.0.2 restated it, and the
1.0.0 section above is still the sweep.

**What `update` plants.** Owned files, re-planted when your copy still matches a released
sha: the shipped gates and libraries that close the template's CodeQL findings
(`tools/check-secrets.mjs`, `tools/lib/gate.mjs`, `tools/check-mutation-ratchet.mjs`,
`tools/perf-baseline.mjs`, `tools/check-rls-manifest.mjs`, `tools/lib/observability.mjs`,
`tools/lib/sbom.mjs`, `tools/check-backup-posture.mjs`, `tools/check-restore-manifest.mjs`,
and `tools/check-store-config.mjs` where the store-metadata module is enabled), plus
`.github/workflows/codeql.yml`, `tools/conformance-map.json`, `renovate.json` and the hook
version stamps. What you may notice afterwards:

- **New entries in the Security tab.** The CodeQL lane now runs the `security-and-quality`
  suite: every query it ran before, plus reliability and maintainability ones. They are
  informational. The lane is not a required check, and no gate reads it.
- **A gate stamp that fails where it used to pass.** `hashInputs` now throws on an input it
  cannot open for any reason other than absence (a symlink loop, `EACCES` on a parent
  directory), where it used to hash that input as missing. A readable or absent input
  hashes exactly as before, so no stamp moves unless an input really was unreadable.
- **The backup-evidence lane skips on `TBD`.** init's default project ref now reads as
  "never linked", the same loud skip as the unrendered placeholder, which still fails under
  `HARNESS_REQUIRE_BACKUP_EVIDENCE=1`. A ref that is not 20 lowercase letters fails before
  any request, naming where it came from but never printing it.
- **`renovate.json`** drops the deprecated `baseBranches` key and gains two packageRules:
  one restores the 5-day npm cooldown that `config:best-practices` quietly shortens to 3,
  one lets the CodeQL action pin update. If you tuned your copy, it is kept and the
  incoming one is parked under `.harness/pending/`; copy the two rules across by hand.

**The one thing you owe: raise `vitest`.** The catalog now pins `vitest` and
`@vitest/coverage-v8` at **4.1.11**, for GHSA-82fw-gwwq-j7x9 (moderate: an arbitrary file
read by path traversal through the `@vitest/mocker` redirect mock, affecting 2.1.0 up to
4.1.11). Every release through 1.0.2 shipped 4.1.10. `pnpm-workspace.yaml` is seeded, so
`update` does not touch your pins, and no gate reds on the old one; your daily `osv-scan`
job is what reports it. Move both pins together, because the coverage package peer-pins
the identical `vitest`:

```
# in the pnpm-workspace.yaml catalog: vitest: 4.1.11 and '@vitest/coverage-v8': 4.1.11
pnpm install && git add pnpm-lock.yaml pnpm-workspace.yaml
pnpm validate
```

Do not use `update --refresh-seeded pnpm-workspace.yaml` for this: it replaces your whole
catalog with the template's.

## 1.0.4 — the local loop release: a patch, nothing expires, nothing opens

**No ramp here applies to a 1.0.0, 1.0.1, 1.0.2 or 1.0.3 install.** The population 1.0.0
reds is restated in this release's record for the same reason 1.0.1 through 1.0.3 restated
it, and the 1.0.0 section above is still the sweep.

**What `update` plants.** Owned files, re-planted when your copy still matches a released
sha: `tools/check-types-drift.mjs`, `docs/harness/gates-catalog.md`, this runbook, the hooks
under `.claude/hooks/` (their version stamps, and the telemetry below),
`.claude/hooks/lib/hookio.mjs`, `.claude/hooks/lib/guard-rules.mjs`, `docs/harness/README.md`,
`tools/lib/gate.mjs`, `tools/lib/stamp-inputs.mjs`, `tests/rls/run-rls.mjs`,
`tests/rls/auth-trail.test.ts`, `tools/validate.mjs`, `tools/check-migrations.mjs`,
`tools/check-version-sync.mjs`, `tools/check-styleguide-manifest.mjs`,
`tools/check-perf-budget.mjs` and `tools/check-expo-policy.mjs`; where the `eas-update`
module is enabled, `tools/check-eas-update.mjs`; and where the `store-metadata` module is
enabled, `docs/store/app-review-notes.md`. `tools/lib/supabase-cli.mjs` is new, and `update`
plants it. The project citation corpus below adds the new `tools/lib/corpus.mjs`, which
`update` plants too, and changes `tools/check-sources.mjs`, `tools/check-docs-sync.mjs`,
`tools/mcp/corpus-search-server.mjs`, `tools/mcp/README.md`,
`tools/lib/enforcement-surface.mjs`, the header comments of `tools/lib/provenance-rules.mjs`
and `tools/lib/citation-domains.mjs`, `.claude/rules/provenance.md`,
`.claude/agents/citation-verifier.md`, `.claude/commands/verify-citations.md`,
`.claude/skills/authoring-e2ee-feature/SKILL.md`, `docs/adr/README.md` and
`docs/security/approved-tools.md`. The device lane below changes
`.github/workflows/quality-gate.yml`, `tools/ci/device-lane.sh`,
`tools/check-e2e-device.mjs` and `tools/lib/maestro-flows.mjs`, and, where the
`device-e2e` module is enabled, `.github/workflows/device-e2e.yml`. What you may notice
afterwards:

- **A `types-drift` FAIL shows the diff.** Before the unchanged FAIL sentence the gate
  prints each side's line count, the first line that differs, and a bounded window of each
  side from there (`DIFF_LINES` in the gate), the committed file's lines prefixed `- ` and
  the generated output's `+ `. The verdict and the exit code do not change.
- **A new log, `.harness/telemetry.jsonl`.** The hooks append a record per Stop step (its
  status, duration, and `SKIPPED` and `STAMPED` counts), per gate time in a step's
  `VALIDATE_TIMINGS` line, and per in-turn deny, provenance block, Biome warning or reviewer
  bounce. It holds ids and counts, never content, commands or paths. It is never trimmed and
  no gate reads it, and `.harness/*` is already ignored, so it never shows in `git status`.
  To reset it, delete it yourself: the guards deny an agent's edits and deletions under
  `.harness/`. If you forked `.claude/hooks/lib/hookio.mjs` and `update` parked the new one
  under `.harness/pending/`, every hook still loads and nothing is recorded until you take
  the parked copy.
- **A stamp hit prints `STAMPED`.** A gate riding its stamp used to print
  `<gate>: OK — inputs unchanged since last green run (…)`; it now prints
  `<gate>: STAMPED — inputs unchanged since last green run (…)`, still exits 0, and the Stop
  hook lists those lines beside its skipped layers. If a script of yours matched the old
  line, match the new one. `update` deletes every `.harness/*.ok` as it always has, so the
  first run after it re-proves every gate.
- **Stamps expire on more edits.** Each gate's stamp now also hashes the `tools/lib` modules
  its script imports (`lib/sql-parse.mjs` for `tenancy`, `query-shapes` and `db-limits`, for
  example) and `lib/fs-walk.mjs`. An edit to one of them re-runs the gate instead of riding
  a warm stamp. Nothing expires less often than before.
- **`rls-isolation` can print `STAMPED` with the stack up.** When nothing the two suites
  read has changed, the `supabase --version` output is the same and the running database
  has the same start time and applied migrations as at the last green run, the Stop step
  prints `rls-isolation: STAMPED` and runs neither suite. `pnpm db:reset`, `pnpm db:down`
  then `pnpm db:up`, a migration applied from the command line, or a different CLI each run
  both suites again. Any non-empty `CI`, `CI=false` included, and
  `HARNESS_REQUIRE_TOOLCHAINS=1` always run them. The stamp cannot see SQL you run by hand
  against the running database: after that, run `pnpm db:reset`, or delete
  `.harness/rls-isolation.ok` yourself (the guards deny an agent's deletions under
  `.harness/`). If `update` parked your copy of `tools/lib/gate.mjs` or
  `tools/lib/stamp-inputs.mjs`, the runner stamps nothing and runs both suites, as it did
  before, until you take the parked copies.
- **The Stop hook's database steps run your workspace Supabase CLI.** The `rls-isolation`
  step and `types-drift` now put `node_modules/.bin` first on the `PATH` they spawn with
  (not on Windows), so they run the CLI your catalog pins, as `pnpm test:rls`,
  `pnpm db:types` and CI already did. The runner prints which CLI it used.
- **`types-drift` can now red locally on a stale mirror.** On a machine with no global CLI
  it used to skip; with your stack up it now runs, and a mirror that no longer matches your
  schema blocks the turn. CI's `runtime-rls` job was already judging the same file with the
  same CLI. Clear it the way the FAIL says:

  ```
  pnpm db:up && pnpm db:types
  git add packages/platform/supabase/src/database.types.ts
  ```

- **The two `tests/rls` files change together.** The runner now hands vitest
  `SUPABASE_DB_URL`, and `auth-trail.test.ts` reads it instead of naming a port. If you
  forked `tests/rls/run-rls.mjs`, `update` keeps your fork and parks the incoming copy under
  `.harness/pending/`, while the unmodified `auth-trail.test.ts` is re-planted. Your fork
  must then pass `SUPABASE_DB_URL: s['DB_URL'] ?? ''` to vitest, or that suite throws
  (locally and in `runtime-rls`) with a message naming the runner. Merge the parked copy, or
  add that one key.
- **`doctor` reports your toolchain and can clean residue.** Run with this release's CLI, it
  prints `info` lines naming the `node`, `pnpm`, Supabase CLI and `psql` it found, their
  versions and their pins. `doctor --clean` deletes `.harness/stop-output/`,
  `apps/mobile/dist/`, `apps/web/.next/`, `apps/mobile/.expo/`, `coverage/`, `.stryker-tmp/`
  and `.eslintcache` when git ignores them and they hold no tracked file (`--clean --dry-run`
  lists them first). Your `.gitignore` is yours, so an entry it does not ignore is skipped
  with a note. Neither changes its exit code. The bash guard still denies a recursive
  force-delete, and its message now names `doctor --clean`.
- **A new flag, `node tools/validate.mjs --ci-parity`.** It gives one local run CI's
  posture: a missing prerequisite fails instead of skipping, no stamp is honoured, and the
  run closes by naming each missing prerequisite. Run
  `node tools/validate.mjs --min-floor --ci-parity` before you push to see what CI's
  `static` job will say. Without the flag nothing changes, and no chain step, floor or
  workflow moves. If you forked `tools/lib/gate.mjs` and `update` parked the new one, the
  gates still run and nothing is recorded until you take the parked copy.
- **You can edit a migration draft you have not committed.** The write guard used to deny
  every Edit or Write to an existing `supabase/migrations/*.sql`, so the file
  `supabase migration new` or `supabase db diff -f` had just written could not be filled in.
  It now allows it when git reports the file as untracked (`?? <path>`) and it has one hard
  link, `.harness/manifest.json` does not record it, and the session has no `GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_INDEX_FILE` or `GIT_COMMON_DIR` set. Once you `git add` it, it is
  history again, and the deny returns naming the proof that failed. Committed migrations stay
  append-only: the `migrations` gate and CI's `append-only` job judge them as before. A
  migration someone applied to a shared database by hand and never committed reads as a
  draft too, so commit what you apply. If your install sits in a subdirectory of its git
  repository, git names the file with that prefix, which is not exactly `?? <path>`, so the
  deny stays as it was through 1.0.3. If you forked
  `.claude/hooks/pretool-write-guard.mjs`, `update` parks the new one under
  `.harness/pending/` and your fork keeps denying every existing migration until you take
  it.
- **Two optional register keys; neither is needed, and neither changes a verdict unless
  you add it.** Both registers are escape-listed and write-guarded, so each key lands as a
  committed human edit.
  - `tools/perf-budget.json` may declare `"subjects": []` beside
    `"emptySubjects": { "reason": …, "reviewedOn": "YYYY-MM-DD" }` when nothing in your
    app is dense enough to measure. The reason needs at least 40 characters after
    trimming; the date is checked for format only. `perf-budget` then prints a NOTE and
    names the reason in its OK line. The leak scan and the dense-feature closure still
    run, so a `features/*/perfSubject.tsx` you keep needs a reviewed `exempt` row for its
    directory (declaring it as a subject ends the empty state), and the row beside a
    non-empty `subjects[]` reds as a stale escape.
  - `tools/store-tunables.json` `accountDeletion` may carry `"registry"` when your command
    registry is not `apps/mobile/src/features/actions/registry.ts`: a forward-slash `.ts`
    or `.tsx` path under `apps/mobile/src/` with no `..` segment, legal only with
    `"surface": "action"`. Without the key `expo-policy` reads the default path, as
    before. **If you move the registry, move the mobile entry in `tools/data-flow.json`
    `erase.clients` with it**, in the same commit: that entry names the file the mobile
    app starts erasure from, and `data-flow` reds once the file it names is gone.
- **`expo-policy` re-checks more often locally.** Its stamp now also hashes
  `tools/store-tunables.json`, `apps/mobile/src`, `apps/mobile/app` and
  `supabase/functions`, which it read without hashing, so an edit to any of them could
  pass on a warm stamp. Any mobile source or Edge Function edit now re-runs
  `expo-policy`, as a mobile source edit already re-runs `build` and `e2e`. CI never
  honoured a stamp, so no CI verdict moves.
- **A new vertical's events reach the catalog only through a forked generator, until
  1.1.0.** `tools/gen-event-catalog.mjs` walks only the catalogs it imports by name, and
  it is owned and hash-pinned, so adding your vertical's import line reds
  `gate-integrity` unless you keep it as a deliberate fork: re-record its sha as the
  1.0.2 section's "Forking an owned file" describes. Without the line, that vertical's
  events are missing from the committed catalog while `contracts` stays green. Discovery
  is planned for 1.1.0, and that release's section will say what changes.
- **A project adds a citation authority in `tools/mcp/corpus/project.json`.** The
  `provenance` gate, the ADR check in `docs-sync` and the `corpus_search` MCP server read
  it beside `tools/mcp/corpus/index.json`, through `tools/lib/corpus.mjs`. An absent file
  counts as empty, so until you create one every verdict is what it was. Once it exists,
  `provenance` judges it: it must parse as exactly `{ comment, entries }`, each entry
  passes the same lint as an index entry, and an id the index already pins reds naming
  both files. The gate's remedies now point at `project.json`. The one change that
  reaches you whether or not you create the file is in `wiring`; see "The CODEOWNERS
  case" below.
- **`update` can exit 2 over an owned file it holds no record for.** A file at a path the
  harness owns, with no record in `.harness/manifest.json`, is now judged by its bytes.
  Unless a release shipped exactly those bytes for that path, `update` keeps your file,
  parks the incoming copy and exits 2, where it used to overwrite the file and exit 0. See
  "A harness-owned file with no manifest record" below.
- **The 1.0.1 section above and `docs/harness/gates-catalog.md` are corrected.** They said
  `update` leaves an existing `tools/agents.lock.json` alone, and the 1.0.1 section said the
  `architecture-reviewer.md` re-pin left `prompts` red until a human regenerated the lock.
  Since 0.3.0 `update` has re-recorded the lock entry of each agent-surface file it
  rewrites, hash and model pin together, so an install that had not edited that file owed
  nothing then and owes nothing now. An agent file you edited still needs a human to run
  `HARNESS_ALLOW_SELF_EDIT=1 node tools/gen-agents-lock.mjs --write` once you merge its
  parked copy. What `update` does has not changed.
- **Your `mobile-e2e` and `integration-lane` jobs reach their suites.** Both booted the web
  app before the env its first request parses was set (`SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_DB_URL` and the three `NEXT_PUBLIC_` names), so it answered 500, and waited on
  `/api/trpc/health`, which is no procedure (the routers are namespaced), so neither could
  get past the boot step to the device lane or the live-api proof. Each job now has a
  "Publish the local Supabase env" step before "Boot the web app", fed from
  `supabase status -o env`, and waits on `/api/trpc/system.health`. From this release the
  two jobs can go red on their suites; treat that as you would any red suite. If you forked
  `.github/workflows/quality-gate.yml`, `update` parks the new copy under
  `.harness/pending/` and neither job gets past the boot until you take those two
  publish steps and the `system.health` probe from it.
- **A device red says what was on screen.** `tools/check-e2e-device.mjs` prints
  `e2e-device: on screen when <flow> failed — ids: …; text: …` before its FAIL line, and
  the evidence upload now keeps Maestro's own debug output, which it writes under a hidden
  `.maestro/` directory. The perf-harness journey fails as soon as the screen shows its
  verdict without `perf-pass`, and the printed text names each breached cap with its
  measured value. The failure step prints `/tmp/web.log`, the web app's log.
- **The device lane's Metro prewarm can fail the lane.** `tools/ci/device-lane.sh` fetches
  the bundle a debug build asks Metro for, the Expo virtual entry, where it fetched
  `/index.bundle`, a 404 on this SDK, and ignored the result. A Metro that cannot serve the
  bundle within 600 seconds now fails the lane on that line instead of on the first
  journey.
- **A FIX line repeats path arguments.** The command after `FIX[<gate>]: reproduce with`
  now keeps relative paths and prints a `KEY=VALUE` argument as `KEY=…`, so a value passed
  with `--env` never reaches a log. If a script of yours reads FIX lines, it may see more
  arguments than before.

**What only a fresh scaffold gets.** These files are seeded, so `update` never plants them.
Each note says what an existing install does instead.

- **`packages/platform/supabase/src/database.types.ts`, regenerated with Supabase CLI
  2.118.0.** The schema is unchanged. The generator's layout moved, and a function that
  takes no arguments is now typed `Args: Record<PropertyKey, never>` where it was
  `Args: never`. Your catalog's `supabase` entry decides which CLI your install runs, not
  this release. Once that CLI generates differently from your committed file, `types-drift`
  reds with your stack up, and the diff it prints shows where. Regenerate from your own
  schema and commit the result:

  ```
  pnpm db:up && pnpm db:types
  git add packages/platform/supabase/src/database.types.ts
  pnpm validate
  ```

  Do not copy the template's file over yours. It describes the example's schema, not
  your database.
- **The template pins the Supabase CLI exactly.** New scaffolds get `supabase: 2.118.0`
  where the catalog said `^2.34.3`. `pnpm-workspace.yaml` is seeded, so `update` leaves
  yours alone. Your committed lockfile already fixes the CLI your CI installs. To take the
  pin, set it in your catalog, run the commands below, and commit the lockfile and any
  change to `packages/platform/supabase/src/database.types.ts`:

  ```
  # in the pnpm-workspace.yaml catalog: supabase: 2.118.0
  pnpm install && pnpm db:down && pnpm db:up && pnpm db:types && pnpm validate
  git add pnpm-lock.yaml pnpm-workspace.yaml packages/platform/supabase/src/database.types.ts
  ```

  If `rls_structure.test.sql` then goes red on write grants, the 1.0.2 section is the fix.
  Do not use `update --refresh-seeded pnpm-workspace.yaml`: it replaces your whole catalog.
- **`tools/store-tunables.json`'s `//` comment documents `accountDeletion.registry`.**
  The key itself works on an existing install without it; the section above says how.
- **`tools/mcp/corpus/project.json`, the empty project corpus.** `update` prints
  `new exemplar available (not auto-planted): tools/mcp/corpus/project.json` instead of
  planting it: every reader takes an absent file as empty, and a file whose gate reads
  absence as empty is not planted. Pull it when you need it, as described below.
- **The seeded sentences that name it.** These seeded files now name `project.json`, and
  `update` changes none of yours. Each sentence is prose, so copying it changes no verdict,
  and you may copy any of them from the template:
  - `AGENTS.md`, the first bullet under `## Provenance` (reworded in place, so its line
    count and the budget `docs-sync` holds it to do not move);
  - `tools/decision-groups.json`, the sentence in `comment` about the covering entry a
    group you add needs;
  - `tools/provenance-overrides.json`, the sentence in `comment` that prefers a
    properly-grouped authority over an override;
  - `tools/approved-tools.json`, the `reason` of the `corpus_search` row.

  The JSON files among them are reviewed escape files: the guards deny an agent's edit,
  and `gate-integrity` reds an uncommitted one, so a human makes the change and commits it.

### The project citation corpus: pulling it, and moving a forked index into it

Through 1.0.3 the only place to add a citation authority was
`tools/mcp/corpus/index.json`, which the harness owns and `gate-integrity` hash-pins, and
the `provenance` gate's own remedy said to extend it. If you did, you re-recorded its sha
(the "Forking an owned file" section above), and since 1.0.2 every `update` that changed
the index has parked the incoming copy under `.harness/pending/` for you to merge by hand.
From 1.0.4 your authorities belong in `tools/mcp/corpus/project.json`, and the index can
go back to being the harness's.

1. **Pull the skeleton.** `update --refresh-seeded tools/mcp/corpus/project.json` writes
   `{ "comment": "…", "entries": [] }`. Its `comment` gives the entry shape. The file is
   write-guarded, so a human edits it.
2. **Move your additions.** Cut every entry you added to `tools/mcp/corpus/index.json` and
   paste it, unchanged, into `entries`. Keep each id: a `project/` prefix is recommended
   for new ids and required of none, so every `[corpus: <id>]` you cite keeps resolving.
   Do not copy an entry the harness shipped; an id both files pin reds as "already pinned
   in `tools/mcp/corpus/index.json`". The same red appears if a later release pins an id
   you chose. Rename your entry and its citations then; the harness's entry stays.
3. **Return the index to a released version.** Only once step 2 is done, run
   `update --refresh-seeded tools/mcp/corpus/index.json --force`. Scoped to that one path,
   `--force` discards your copy, writes the index this release ships and re-records its
   `sha256` in `.harness/manifest.json`, the reverse of the re-record you made when you
   forked it; no other file is touched. If an earlier `update` parked a copy at
   `.harness/pending/tools/mcp/corpus/index.json`, delete it. `doctor` stops listing the
   index as a fork, and the next `update` refreshes it again.
4. **Commit `project.json`, `index.json` and `.harness/manifest.json` together** and run
   `pnpm validate`. `provenance` is green when every citation resolves and each moved
   entry still hashes; a red names the file and the entry. `project.json` is a reviewed
   escape file, so `gate-integrity` also reds while an edit to it is uncommitted.

A decision group you add to `tools/decision-groups.json` still needs an entry tagged with
its key. That entry now goes in `project.json`, so adding a group no longer forks the index.

### The CODEOWNERS case

`tools/mcp/corpus/project.json` joins the escape lists that `wiring` checks CODEOWNERS
against, and `wiring` asks about every path on them whether or not the file exists. The
shipped `/tools/**` rule and the `*` catch-all both give it an owner. `wiring` reds only
when the last CODEOWNERS rule that matches the path names no owner, for example a bare
`/tools/mcp/` line added below `/tools/**`. GitHub reads that rule as "no review" for
everything under it. The red names the path and the rule. Give that rule an owner, or add
a `/tools/mcp/corpus/project.json` line with one below it.

### A harness-owned file with no manifest record: `update` keeps it and parks the incoming copy

**Who is affected.** An install that holds a file at a path the harness owns, with no
record for that path in `.harness/manifest.json`. `init` and `update` record every owned
file they write, so an install nobody has touched has none. One appears when:

- a release starts shipping a path where your project already had its own file;
- `enable` found your file at a module path, kept it and parked the module's copy, which
  records nothing for the path;
- `disable` kept a module file you had modified and dropped its record, and you enabled
  the module again;
- someone deleted a record by hand.

**What you see.** Through 1.0.3 `update` read a missing record as "unmodified": it
replaced your file with the harness's copy, recorded it and exited 0, and a `removed` or
`renamed` migration deleted it. From 1.0.4 `update` asks whether any release of the
harness shipped exactly the bytes on disk for that path. When one did, the file is
refreshed and recorded as before. When none did, `update`:

- keeps your file and records nothing for it;
- parks the incoming version at `.harness/pending/<path>` and lists the path as drift;
- adds one note, `<path> has no manifest record and its bytes match no release of this
  harness — kept; …`;
- exits 2, as it does for any drift. `update --dry-run` reports the same park.

It parks even when upstream has not changed the file since your install's version: with
no record, nothing shows that your file started as the harness's copy. A `removed` or
`renamed` migration leaves such a file in place and says so in a note ending `left in
place; remove it manually`. `gate-integrity` checks recorded files only, so the file stays
outside it until you resolve the park, as it was before the update, and `doctor` keeps
naming the parked copy.

**Three ways to resolve it.**

1. **Keep your file, merged.** Merge what you need from `.harness/pending/<path>` into
   your file, delete the parked copy, and have a human record the file's `sha256` in
   `.harness/manifest.json`, with mode `owned`, in a reviewed commit. The file is then a
   fork, and "Forking an owned file" in the 1.0.2 section above applies on every later
   update.
2. **Take the harness's copy.** Delete your file and the parked copy, then run `update`
   again. The path is written fresh and recorded.
3. **Discard yours in one step.** `update --refresh-seeded <path> --force` overwrites that
   one file with this release's version, records its `sha256` and notes
   `--force overwrote locally-modified <path>`; no other file is touched. Delete the parked
   copy afterwards. A plain `update --force` does the same, but it also discards every
   other drifted or forked owned file in the run, so read `update --dry-run` first if you
   use it.

## 1.1.0 — the sharper verdicts release: the 1.0.0 notes fall due

**If your `baseVersion` is 1.0.0 or later, nothing expires for you.** Every ramp 1.0.0
opened carries `minVersion 1.0.0`, so none of them has ever been live on your install. What
the version bump itself brings a 1.0.x install is the uuid arrival NOTE below; each ramp a
later 1.1.0 change opens has its own part of this section. Read what applies
to YOUR `baseVersion` off `node scripts/ci/ramp-expectations.mjs <your base> 1.1.0` in a
harness checkout, and off `pnpm validate 2>&1 | grep -E 'NOTE — \(ramp\)|RAMP EXPIRED'` in
your own tree, never off this page.

**If your `baseVersion` is below 1.0.0, this is where the 1.0.0 sweep stops being
optional.** The 1.0.0 section above is the sweep, and nothing in it changed. If you are
more than one release behind, read the sections above in order before crossing this one.

### What ARRIVES (hard) — for installs below 1.0.0

The six-gate NOTE fleet 1.0.0 opened, less its re-opened eol arrival. Each finding that
printed as `NOTE — (ramp)` with `expires in 1.1.0` now prints under a `RAMP EXPIRED`
banner and reds its step. The numbers are the items of the 1.0.0 section's "What OPENS"
list, which says what to do for each:

1. **`suppressions`** (item 1). Reconcile `tools/suppressions-allow.json` to your tree: a
   directive with no row, and a row naming a directive your tree lacks, both red.
2. **`resilience`** (item 2). Every outbound seam your tree added needs its
   `tools/resilience.json` row.
3. **`docs-sync`'s gate list** (item 3). Your seeded `AGENTS.md` must list every step the
   chain runs. Paste the names the finding prints.
4. **`boundaries`, two sites.** The behavior-keyed anatomy widening (item 4), and the
   census module-name closure: an entry in `tools/exports-walls.json` whose `module` is not
   in the owned `tools/modules.json` reds. Fix the name, or remove the entry's sanction.
5. **`version-sync`'s vendor-support register** (item 5, its first half):
   `tools/support-register.json` and its platform-fact closure against your Postgres and
   Node pins.
6. **`auth-posture`'s `[auth.hook.*]` floors** (item 6), and only if the auth-event trail
   migration is in your tree. With neither the migration nor the config sections, nothing
   is demanded, exactly as before.

`scripts/ci/upgrade-sweep.mjs` `SWEEPS['1.0.0']` is what the upgrade lane's swept leg runs
before it requires `graduate` to succeed, and it adds no step for this release
(`SWEEPS['1.1.0']` is empty, and says why).

### What re-OPENS (a dated NOTE, until 1.2.0) — for every install below 1.1.0

**`version-sync`'s uuid arrival.** The harness re-reviewed its own uuid 7 acceptance at
this release and moved its `removalTarget` from 1.1.0 to 1.2.0. `xcode` 3.0.1 still
declares `uuid: ^7.0.3`, `@expo/config-plugins` still depends on that `xcode`, and a
registry sweep of a fresh scaffold (`scripts/sweep-registry-deprecations.mjs`) still finds
uuid@7.0.3 as the only deprecated package in the production closure. The vendor's
message now also tells ESM codebases to update to uuid@latest and CommonJS codebases to
use uuid@11. Neither is a move this tree can make, because `xcode` chooses the range.

Your `tools/eol.json` is seeded, so it still says what it said: `"removalTarget": "1.1.0"`
on a 1.0.x install, and `"0.12.0"` or earlier on an older one that never re-dated it. That
date has arrived. `update` parks the re-affirmation under
`.harness/pending/source-fixes.json` (a `SEEDED SOURCE FIX` note naming `version-sync`),
and `version-sync` prints the arrival as `NOTE — (ramp)` with `expires in 1.2.0` rather
than a hard red. Re-affirm the row under a release you mean, recording what you
re-checked, or remove the dependency. If you never edited `tools/eol.json`, taking the
harness's register is the same act:

```
update --refresh-seeded tools/eol.json
git add tools/eol.json
```

That pull replaces the whole file, your own rows included, so read the diff before you
commit it. The parked fix clears itself once your file no longer says `"1.1.0"`.
`graduate` refuses while this NOTE stands.

### What `update` plants, and what else moved

Owned files, re-planted when your copy still matches a released sha: the hooks under
`.claude/hooks/` (their version stamps), this runbook, `tools/check-version-sync.mjs` (the
re-opened arrival ramp), `tools/deferrals.json`, `tools/auth-posture.json`,
`tools/check-auth-posture.mjs` and `docs/harness/gates-catalog.md` (the census date below),
`tools/conformance-map.json` and the comments of `tools/check-docs-sync.mjs` and
`tools/check-workspace-deps.mjs` (the sentences that called the 1.0.0 ramps open). The
surface deferral adds `tools/ci/surface-deferral.mjs` and `tools/lib/surface-deferral.mjs`,
and re-plants `.github/workflows/quality-gate.yml`, `.github/workflows/osv-scan.yml`,
`tools/ci/summarize-gate.mjs`, `tools/lib/gate.mjs`, `tools/lib/enforcement-surface.mjs`,
`.claude/hooks/lib/guard-rules.mjs`, `docs/harness/enforcement-tiers.md` and
`docs/security/threat-model.md`; the register itself is withheld (the subsection below). What you may notice afterwards:

- **The CLI config census now targets 1.2.0.** It was due at 1.1.0 and arrived with the
  upstream condition unmet: supabase/cli#5894, the side-effect-free `config validate`
  subcommand the census waits for, is still open, and the CLI documents `config push` as
  its only `config` subcommand. The date moved in the owned ledger and its three sentences
  together, so `docs-sync` does not red on it. Nothing is yours to do.
- **The `changes` job checks out the tree and runs one more step**, the surface deferral
  below. With no register it prints `mobile-deferred=false` and reads nothing else, so
  every lane runs exactly as before.

### A surface you have not built yet: `tools/surfaces.json`

A project that builds its web surface first can now say so, instead of forking the owned
`quality-gate.yml`. A live row skips `mobile-e2e` and `perf-lane` on a pull request, and
nothing else: scheduled and dispatched runs keep both lanes, every other job ignores the
file, and `gate-summary` prints the row's reason beside each lane it skipped.

**`update` withholds the register from an existing install.** It is `seedOnInitOnly` in the
1.1.0 record: its reader treats an absent register as an empty one, which defers nothing,
so an install that never writes a row sees no change. Fresh scaffolds get the empty
register. **Creating one is a committed, reviewed act.** The file is write-guarded, so a
human writes it, and it is on the escape lists, so `gate-integrity` reds while an edit to
it is uncommitted and `wiring` asks CODEOWNERS about it:

```json
{
  "//": "Surfaces this project has not built yet.",
  "deferrals": [
    { "surface": "mobile", "deferredUntil": "YYYY-MM-DD", "reason": "one line: why the app is not built yet" }
  ]
}
```

`mobile` is the only surface a row may name, one row per surface; `deferredUntil` is the
last deferred day; the reason is non-empty and on one line. Any other shape makes the
`changes` job red, after it reports `mobile-deferred=false`. Check a row before you push:
`node tools/ci/surface-deferral.mjs --mode=pr` prints the two output lines and, on stderr,
whether the row is live and how many files it compared.

**What ends a deferral, without anyone touching the row.**

- **The content tripwire.** The row is void, and both lanes run, as soon as any tracked
  file under `apps/mobile/` differs from the sha256 the installer recorded in
  `.harness/manifest.json`, a file is added there or a recorded one is gone, or the
  manifest is absent. Your first real screen re-arms the lanes. Changes to the shared
  packages do not void the row on their own; one that forces an edit under `apps/mobile/`
  voids it through that edit. `update --refresh-seeded <path>` rewrites a file and its
  record together, so it keeps the row live; hand-editing the manifest to do the same is
  an edit to the write-guarded, CODEOWNERS-covered `.harness/`, and the date still ends it.
- **The date.** After `deferredUntil` a pull request runs the lanes again, and the
  scheduled `floor-review` job (`osv-scan.yml`) reds on the lapsed row, naming it. It also
  reds on a void or malformed row. It never reds a pull request.

**A retrofit install** planted no `apps/mobile/` files. If your project has its own mobile
app there, its files have no records, so a `mobile` row is void from the start. If nothing
is tracked or recorded under `apps/mobile/`, the row is live and the CLI says that zero
files were compared.

## RECOVERY — when an `update` is interrupted or fails

Every real `update` (0.9.0+) records the pre-update state of every path it
could touch as one blob under `.harness/rollback/` BEFORE its first disk write,
and its writes are atomic (staged to a dot-tmp beside the destination, then
renamed) — a file is either its old bytes or its new bytes, never a truncation.
The ordering is: snapshot → deletions → file writes → manifest LAST. What to do,
by symptom:

1. **Commit before you update.** The snapshot is the harness's recovery point;
   your commit is yours. Both existing is the posture every step below assumes.
2. **The update stopped partway (crash, ^C, ENOSPC).** Re-run `update` — the
   sweep is idempotent: files already rewritten re-record, files not yet reached
   are written, and the second run's report says `written: 0` when there was
   nothing left. This is the default remedy.
3. **You want the pre-update tree back** (the update revealed a red you are not
   ready to sweep, or you suspect damage):
   `npx next-expo-supabase-agent-harness update --rollback` — restores every
   recorded path byte-for-byte (files first, manifest last), deletes files the
   update created, and keeps the blob so a repeated rollback is a no-op. The
   next `update` replaces the snapshot; `graduate` deletes it (restoring a
   pre-graduation tree would silently regress `baseVersion`).
4. **`check-gate-integrity` reports a sha mismatch right after an update, or
   `doctor` reports drift on a harness-owned file you never edited.** Before
   reading it as tampering: an update that did not complete leaves exactly this
   shape. Re-run `update` (heals the partial state), or `update --rollback`
   (restores the recorded tree) — the gate and doctor messages name both.
5. **A DRIFT report parks a file you never edited** (`.harness/pending/<path>`
   after an interrupted update on an older harness whose writes were not yet
   atomic): the parked copy is the harness's CORRECT version and the in-tree
   file may be torn. Compare them; if the in-tree file is truncated, take the
   parked copy (`mv .harness/pending/<path> <path>`), then re-run `update`.
   A torn file under `.claude/hooks/` is still the case to treat first, and
   since 1.0.0 it BLOCKS instead of disarming: every hook is invoked through
   the fail-closed launcher (`launch.mjs`), so a hook or library file that
   cannot LOAD exits 2 and refuses the action rather than failing open (the
   pre-1.0.0 behaviour, where Claude Code read the load-failure exit 1 as
   non-blocking and the agent-time layer was silently gone). The honest
   residual: a torn `launch.mjs` ITSELF still fails open — the class cannot be
   closed from inside the process it disarms; what shipped is a shrink of the
   fail-open surface from every hook and library file to one tiny import-free
   file, re-probed at every Claude Code pin bump per CONTROL-PLANE-FACTS.

## How to graduate

1. **Sweep.** Run `pnpm validate` and fix everything the ramped check reports in
   its NOTE lines, exactly as if they were reds. Pull any new exemplars you want
   first (`npx next-expo-supabase-agent-harness update --refresh-seeded <path>` — the
   update report names them).
2. **Bump `baseVersion`** in `.harness/manifest.json` to the version the NOTE
   names (or the current release). This is a HUMAN decision: the file is
   write-guard-protected against agents, so edit it outside an agent session (a
   plain editor is fine), or run `npx next-expo-supabase-agent-harness graduate` —
   it runs the ramp-aware validate and advances `baseVersion` only when zero
   ramp NOTEs remain. Do not bump past checks you have not swept — every ramped
   check at or below the new `baseVersion` goes live at once.
3. **Re-run `pnpm validate`.** The NOTE is gone and the check is live: from now
   on a violation is a red, which is the point.

A corrupt manifest never ramps anything — the gates fail closed on unparseable
JSON (restore the file from git history; do NOT re-run `init`).

## Content-conditional checks (data-shape ramps, no `baseVersion` involved)

Some checks key off the SHAPE or PRESENCE of a seeded data file instead of
`baseVersion`. Those files are seeded — `update` never rewrites them — so your
install keeps its old shape (and gets a NOTE naming the newer one) until you
pull the file deliberately:

```
npx next-expo-supabase-agent-harness update --refresh-seeded tools/perf-budget.json
```

In this harness the pattern covers, among others:

- **`tools/perf-budget.json`** — the `subjects[]` render budgets and the
  dense-feature closure. Pull any exemplar the shape references first
  (`apps/mobile/src/features/matrix/` ships the worked `perfSubject.tsx`).
- **`tools/startup-budget.json`** — `seedOnInitOnly`: its rows name YOUR routes,
  so `update` withholds it and the mobile-perf floor self-disables with an
  adoption NOTE until you write rows for your own screens.
- **`tests/rls/db-context.ts`** — `seedOnInitOnly`: its `ISOLATION_TARGETS` name
  YOUR tables; absent, the runtime isolation suite has nothing to iterate.
- **`tools/mutation-baseline.json`** — `seedOnInitOnly`: one project's accepted
  survivors must never become another's; the mutation ratchet notes its absence.

Graduation here is the file pull (or hand-authoring) itself — no `baseVersion`
bump.

## Adopting the gzip ratchet (tools/perf-baseline.json)

The build gate's byte-true ratchet keys off the PRESENCE of
`tools/perf-baseline.json`. It is seeded + `seedOnInitOnly`, so `update` never
plants it: without it the absolute bundle caps apply alone and the build gate
prints a NOTE naming the file. To adopt, generate the baseline from **your own
bundle's real bytes** — do NOT pull the template's shipped baseline, its numbers
describe the fresh scaffold, not your app:

```
pnpm perf:baseline
```

Review the printed measurements, commit the JSON, and from the next validate the
build gate fails on measured gzip > baseline × `ratioCap`. Re-baseline after any
DELIBERATE size change with the same command in a reviewed commit — the file is
write-guard-protected against ad-hoc agent edits.
