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
