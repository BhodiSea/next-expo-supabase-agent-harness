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

Once `pnpm validate` is green, `npx next-expo-supabase-agent-harness@latest graduate` advances
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

`npx next-expo-supabase-agent-harness@latest graduate` advances `baseVersion` to 0.5.0 once
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

`npx next-expo-supabase-agent-harness@latest graduate` advances `baseVersion` to 0.6.0 once
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

`npx next-expo-supabase-agent-harness@latest graduate` advances `baseVersion` to 0.7.0
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
NOTEs, then `npx next-expo-supabase-agent-harness@latest graduate` — it refuses while a
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
`npx next-expo-supabase-agent-harness@latest graduate`. A `baseVersion` 0.8.0 install
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
new `fallback` field. `npx next-expo-supabase-agent-harness@latest doctor` surfaces it,
and each probe self-clears once your tree stops matching the broken shape. Those
corrections are **not** on a deadline in this release — the checkers that demand
them are ramped to 0.11.0.

### Then graduate

Sweep the reds, then
`npx next-expo-supabase-agent-harness@latest graduate`, then re-run `pnpm validate`.

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
npx next-expo-supabase-agent-harness@latest update --refresh-seeded tools/eol.json

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
`npx next-expo-supabase-agent-harness@latest update --refresh-seeded supabase/tests/rls_structure.test.sql`,
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
the version bump itself brings a 1.0.x install is the uuid arrival NOTE below, and the new
`web-compile` chain step brings the gate-list NOTE beside it; each ramp a later 1.1.0 change
opens has its own part of this section. Read what applies
to YOUR `baseVersion` off `node scripts/ci/ramp-expectations.mjs <your base> 1.1.0` in a
harness checkout, and off `pnpm validate 2>&1 | grep -E 'NOTE — \(ramp\)|RAMP EXPIRED'` in
your own tree, never off this page.

**If your `baseVersion` is below 1.0.0, this is where the 1.0.0 sweep stops being
optional.** The 1.0.0 section above is the sweep, and nothing in it changed. If you are
more than one release behind, read the sections above in order before crossing this one.

### What ARRIVES (hard) — for installs below 1.0.0

The NOTE fleet 1.0.0 opened, less its two re-opened sites (the eol arrival and
`docs-sync`'s gate list, both below). Each finding that printed as `NOTE — (ramp)` with
`expires in 1.1.0` now prints under a `RAMP EXPIRED` banner and reds its step. The numbers
are the items of the 1.0.0 section's "What OPENS" list, which says what to do for each:

1. **`suppressions`** (item 1). Reconcile `tools/suppressions-allow.json` to your tree: a
   directive with no row, and a row naming a directive your tree lacks, both red.
2. **`resilience`** (item 2). Every outbound seam your tree added needs its
   `tools/resilience.json` row.
3. **`boundaries`, two sites.** The behavior-keyed anatomy widening (item 4), and the
   census module-name closure: an entry in `tools/exports-walls.json` whose `module` is not
   in the owned `tools/modules.json` reds. Fix the name, or remove the entry's sanction.
4. **`version-sync`'s vendor-support register** (item 5, its first half):
   `tools/support-register.json` and its platform-fact closure against your Postgres and
   Node pins.
5. **`auth-posture`'s `[auth.hook.*]` floors** (item 6), and only if the auth-event trail
   migration is in your tree. With neither the migration nor the config sections, nothing
   is demanded, exactly as before.

`scripts/ci/upgrade-sweep.mjs` `SWEEPS['1.0.0']` is what the upgrade lane's swept leg runs
before it requires `graduate` to succeed. For these sites `SWEEPS['1.1.0']` adds no step
(it says why); what it does carry belongs to later subsections of this section: the grant
bound's `grantDoctrine` step, and the two seeded browser specs it adopts.

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

**`docs-sync`'s `AGENTS.md` gate list.** 1.1.0 injects a chain step, `web-compile`, directly
after `build` (the last subsection of this section), so your chain has 37 steps while your
seeded `AGENTS.md` still lists 36, or fewer. The escape that covered this drift reached its
deadline at this very release, so it re-opens at minVersion 1.1.0: while every step your
`AGENTS.md` lists still exists in the same order, the drift prints as `NOTE — (ramp)` with
`expires in 1.2.0`, and the NOTE ends by telling you to paste the chain's names. Do exactly
that: put the 37 names it prints into the "The N gates, in order:" sentence, and change the
"N-step chain" line to 37. A listed step that no longer exists, or a reordering, is your
own drift and stays a hard red. `graduate` refuses while this NOTE stands.

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
`docs/security/threat-model.md`; the register itself is withheld (the subsection below).
Post-merge lane reuse adds `tools/ci/lane-reuse.mjs` and `tools/lib/lane-reuse.mjs`, and
re-plants `.github/workflows/quality-gate.yml`, `tools/ci/summarize-gate.mjs` and
`docs/harness/README.md` (its subsection below). The generated skill
references re-plant the vertical-slice skill's
`.claude/skills/authoring-vertical-slice/references/dal-dto.md` and
`references/migration-rls.md`, and the `.claude/agents/migration-rls-author.md` agent, and
`update` re-records their `tools/agents.lock.json` entries. The fixture-table pgTAP suites
re-plant `tools/conformance-map.json`, `tools/essential-eight.json` and
`docs/harness/gates-catalog.md`, whose sentences now say where the MFA and audit proofs
run; the suites themselves are seeded and stay as they are (their subsection below).
The reviewer ledger v2 re-plants `tools/check-reviewer-verdicts.mjs`,
`tools/lib/git-diff.mjs`, `tools/lib/reviewer-verdicts.mjs`,
`.claude/hooks/subagent-verdict.mjs`, `.claude/settings.json`,
`docs/harness/gates-catalog.md` and `docs/harness/README.md`; its three seeded texts are
yours to copy (its subsection below). The session-start brief adds
`.claude/hooks/session-brief.mjs`, `tools/harness-status.mjs` and
`tools/lib/harness-brief.mjs`, and re-plants `.claude/settings.json` and
`docs/harness/README.md`; its two seeded texts are yours to copy, and a forked settings file
has one entry to merge (its subsection below). Field notes re-plant `tools/lib/gate.mjs`,
`.claude/hooks/lib/guard-rules.mjs`, `docs/harness/gates-catalog.md` and
`docs/security/threat-model.md`, and plant the seeded `tools/field-notes.json` when your
install has none (its subsection below). The reviewer model record re-plants
`.claude/hooks/subagent-verdict.mjs`, `.claude/hooks/stop-validate-gate.mjs`,
`tools/check-reviewer-verdicts.mjs`, `tools/lib/reviewer-verdicts.mjs`,
`tools/lib/agent-roster.mjs`, `tools/check-docs-sync.mjs`, the eight reviewer files under
`.claude/agents/` (and re-records their `tools/agents.lock.json` entries),
`docs/harness/gates-catalog.md` and `docs/harness/README.md`; nothing of it is seeded (its
subsection below). The severity contract re-plants the eight reviewer bodies under
`.claude/agents/` (`update` re-records their `tools/agents.lock.json` entries),
`.claude/hooks/subagent-verdict.mjs`, `tools/check-docs-sync.mjs`,
`tools/check-reviewer-verdicts.mjs`, `tools/lib/agent-roster.mjs`,
`tools/lib/reviewer-verdicts.mjs`, `docs/harness/gates-catalog.md` and
`docs/harness/README.md`; a reviewer body you edited is kept and the new one parked (its
subsection below). The verdict-demand rule re-plants `tools/check-docs-sync.mjs`,
`tools/lib/agent-roster.mjs`, `docs/harness/gates-catalog.md`, and the comments of
`tools/gen-agents-lock.mjs` and `.claude/hooks/lib/guard-rules.mjs`; it changes no reviewer
body (its subsection below). The spec anchors add `tools/spec-anchor.mjs` and
`tools/lib/spec-anchor.mjs`, and re-plant `specs/_template.md`,
`.claude/commands/new-feature.md`, `.claude/commands/adr.md` and
`.claude/agents/torvalds-reviewer.md` (`update` re-records their `tools/agents.lock.json`
entries), `docs/adr/0000-adr-template.md`, `docs/harness/README.md` and
`tools/conformance-map.json`; nothing of it is seeded, and your own specs stay as they are.
Review records plant the seeded `docs/reviews/README.md` when your install has none, and
re-plant `docs/adr/0000-adr-template.md`, `docs/adr/README.md`, `.claude/commands/adr.md`
and `.claude/commands/new-feature.md` (`update` re-records the two commands'
`tools/agents.lock.json` entries); their `AGENTS.md` sentence is yours to copy (its
subsection below). The proposal flow re-plants `.claude/hooks/lib/guard-rules.mjs` (the
`apply-proposal-invocation` rule), `.claude/hooks/pretool-write-guard.mjs` (its tamper deny
names the flow), `docs/harness/README.md` and `docs/security/threat-model.md` (generated; it
lists the new rule). The verb itself is the installer's, so nothing else lands in your tree
(its subsection below). The companion tables re-plant the seven reviewer bodies under
`.claude/agents/` other than `citation-verifier.md` (`update` re-records their
`tools/agents.lock.json` entries) and `docs/harness/README.md`; a reviewer body you edited
is kept and the new one parked (its subsection below). The smaller always-loaded context
re-plants `.claude/rules/encryption.md` (now a stub), the `authoring-e2ee-feature` skill
(`update` re-records its `tools/agents.lock.json` entry), `docs/harness/README.md` and
`tools/conformance-map.json`, and plants the new `.claude/rules/e2ee.md`; the `AGENTS.md`
change is yours to take or leave (its subsection below). The register stamps re-plant
`tools/check-essential-eight.mjs`, `tools/check-conformance-map.mjs`,
`tools/lib/stamp-inputs.mjs`, `docs/harness/gates-catalog.md` and `docs/harness/README.md`;
nothing of it is seeded. The provenance advisory split re-plants
`tools/lib/provenance-rules.mjs`, `tools/check-sources.mjs`,
`.claude/hooks/posttool-source-check.mjs`, `.claude/hooks/lib/hookio.mjs`,
`.claude/rules/provenance.md`, `.claude/agents/citation-verifier.md` (`update` re-records
its `tools/agents.lock.json` entry), `docs/harness/gates-catalog.md` and
`docs/harness/README.md`; the comments of your seeded `tools/decision-groups.json` and
`tools/reviewer-triggers.json` stay as they are (its subsection below). The self-edit
documentation re-plants `docs/harness/README.md` (a section, "What
`HARNESS_ALLOW_SELF_EDIT=1` relaxes", under Tamper evidence),
`docs/harness/gates-catalog.md` and `tools/check-gate-integrity.mjs` (its OK line); no
verdict changes. The event-catalog discovery adds `tools/lib/event-catalogs.mjs`, and
re-plants `tools/gen-event-catalog.mjs`, `tools/lib/stamp-inputs.mjs`, the vertical-slice
skill's `scripts/scaffold-slice.mjs` and `references/dal-dto.md` (`update` re-records their
`tools/agents.lock.json` entries) and `docs/harness/gates-catalog.md`; the example's
`client.ts` and your root `package.json` are seeded and stay as they are (its subsection
below). The catalog pin floors re-plant `tools/lib/harness-brief.mjs`; the floors are the
installer's own, and your `pnpm-workspace.yaml` is never written (its subsection below).
The project workflow rules add `tools/check-workflow-hardening.mjs` and
`tools/lib/workflow-hardening.mjs`, and re-plant `.github/workflows/actions-lint.yml` (a
new `workflow-hardening` job; `harden-runner-coverage` changes only its comment),
`.github/zizmor.yml` (its comment) and `docs/harness/gates-catalog.md`; nothing of it is
seeded (its subsection below). The SQL history fold re-plants `tools/lib/sql-parse.mjs`,
`tools/lib/stamp-inputs.mjs`, `tools/check-rls-manifest.mjs`, `tools/check-tenancy.mjs`,
`tools/check-migrations.mjs`, `tools/check-data-flow.mjs`, `tools/check-db-limits.mjs`,
`tools/check-query-shapes.mjs` and `docs/harness/gates-catalog.md`, and adds
`tools/lib/sql-fold-ramp.mjs`; nothing of it is seeded (its subsection below). The grant
bound re-plants `tools/lib/table-grants.mjs`, `tools/lib/sql-parse.mjs`,
`tools/check-rls-manifest.mjs`, `tools/lib/enforcement-surface.mjs`,
`.claude/hooks/lib/guard-rules.mjs` (the `grant-bound-allow` rule),
`docs/security/threat-model.md`, the `migration-rls-author` and `security-reviewer` agents,
the `/new-migration`, `/new-feature` and `/rls-check` commands, both authoring skills and
the vertical-slice skill's `references/migration-rls.md` and `references/tests.md` (`update`
re-records their `tools/agents.lock.json` entries), `.claude/rules/security-invariants.md`
and `docs/harness/gates-catalog.md`, and adds `tools/gen-grant-assertions.mjs` and
`docs/adr/20260930-three-role-revoke.md`; its migration and its generated test are withheld,
and its three seeded texts are yours to copy (its subsection below). The query-shape rules
for `rpc()` and `upsert()` re-plant `tools/lib/query-recorder.mjs`, `tools/lib/query-shapes.mjs`,
`tools/lib/sql-parse.mjs`, `tools/check-query-shapes.mjs`, `tools/conformance-map.json` and
`docs/harness/gates-catalog.md`; your committed `tools/generated/query-shapes.json` is seeded
and stays as it is (its subsection below). The i18n syntax-tree walk adds
`tools/lib/i18n-tree.mjs` and re-plants `tools/check-i18n.mjs` and
`docs/harness/gates-catalog.md`; your `tools/i18n-allow.json` is seeded and stays as it is,
and a `site` entry in it has a key to take instead (its subsection below).
The web compile step adds `tools/check-web-build.mjs` and injects it into your
`tools/harness.config.mjs` as `web-compile`, after `build`, and re-plants
`tools/check-web-routes.mjs`, `tools/check-docs-sync.mjs`, `tools/lib/stamp-inputs.mjs`,
`tools/validate.floor.json`, `tools/build-check.mjs` (comments),
`.github/workflows/quality-gate.yml`, `docs/harness/gates-catalog.md`,
`docs/harness/enforcement-tiers.md`, `docs/harness/README.md`, `tools/conformance-map.json`
and `docs/compliance/controls-crosswalk.md`; the two new browser specs are withheld, and
your `AGENTS.md` is yours to update (its subsection below).
The Edge Function checks add `tools/check-edge-functions.mjs`, and re-plant
`eslint.config.mjs`, `vitest.config.ts`, `biome.jsonc`, `tools/check-diff-coverage.mjs`,
`tools/check-mutation-ratchet.mjs`, `tools/mutation-scope.mjs`, `tools/lib/gate.mjs`,
`tools/lib/mutation-critical.mjs`, `tools/conformance-map.json`,
`.github/workflows/quality-gate.yml` (a new `edge-functions` job),
`docs/harness/gates-catalog.md`, `docs/harness/enforcement-tiers.md` and
`docs/adr/20260720-account-deletion.md`; the split of the delete-account function they
reach is seeded, and `update` withholds it (its subsection below).
The planted-list provenance re-plants `tools/check-gate-integrity.mjs` and
`docs/harness/gates-catalog.md`, and adds two owned files: `tools/lib/derender.mjs` and the
generated `tools/lib/planted-shas.json`, which lists the escape-list bytes each harness
release planted. Both arrive in the same run as any escape list `update` plants, and nothing
of it is seeded (its subsection below).
What you may notice afterwards:

- **The CLI config census now targets 1.2.0.** It was due at 1.1.0 and arrived with the
  upstream condition unmet: supabase/cli#5894, the side-effect-free `config validate`
  subcommand the census waits for, is still open, and the CLI documents `config push` as
  its only `config` subcommand. The date moved in the owned ledger and its three sentences
  together, so `docs-sync` does not red on it. Nothing is yours to do.
- **The `changes` job checks out the tree and runs one more step**, the surface deferral
  below. With no register it prints `mobile-deferred=false` and reads nothing else, so
  every lane runs exactly as before.
- **On a push to your default branch, some merge-gate lanes finish in seconds.** `static`,
  `unit`, `mutation`, `runtime-rls`, `e2e-fast` and `integration-lane` reuse the pull
  request run that already passed on the identical tree, name it, and appear under
  `REUSED` in `gate-summary`. They now request `actions: read` and `pull-requests: read`.
  The subsection on `quality-gate.yml` below says when a lane reuses and when it runs.
- **The vertical-slice skill's code blocks name `notes` and sit between `skill-region`
  comments.** Each is now a verbatim copy of a marked span of the harness's own example:
  the `create` procedure of `packages/api/src/routers/notes.ts` in `references/dal-dto.md`,
  and the four permissive policies of `supabase/schemas/20_notes.sql` as the policy half of
  the RLS skeleton in `references/migration-rls.md`. That half reads `notes` where the
  skeleton's hand-written half above it reads `<t>`; rename when you copy, as the line
  beside each block says. A fresh scaffold's copies of those two example files carry the
  matching markers as comments. Yours are seeded, so `update` leaves them as they are, and
  nothing asks you to add the markers: the check that reads them runs in the harness
  repository, not in your chain. If you edited one of the three owned files above, your copy
  stays, the new one is parked under `.harness/pending/`, and `update` exits 2 while it
  stays there.
- **`reviewer-verdicts` prints NOTEs from the reviewer ledger v2.** On an install whose
  `baseVersion` is below 1.1.0 they read `NOTE — the reviewer ledger v2 judgement … expires
  in 2.1.0`, followed by each withheld finding; the 1.0.x judgement still decides. On a
  branch with no upstream the step prints `NOTE — no merge base` instead. The subsection
  on the reviewer ledger v2 below says what v2 judges and what to copy.
- **Every session starts with a short brief in its context.** Four lines and up to ten
  entries: the harness version, base and tier, the upgrades parked under
  `.harness/pending/`, how the last turn in this directory ended, and the reviewers the
  current diff owes. `node tools/harness-status.mjs` prints the same thing. It changes no
  verdict. If your `.claude/settings.json` is a kept fork, you get no brief until you merge
  its entry, and `update` parks the hook instead of writing it: the subsection on the brief
  below says what to do.
- **A new `tools/field-notes.json` appears, untracked, with an empty `notes` object.** It
  changes nothing until you write a note in it: a failing gate then prints your note on the
  line after its `FIX[<gate>]:` line. Commit it as it is, or with your first note.
- **`reviewer-verdicts` names a reviewer verdict that ran on a model other than its pin.**
  One `reviewer-verdicts: FALLBACK MODEL — …` line per such verdict, and on a green turn
  Claude Code shows them to you as a hook warning. On an install whose `baseVersion` is
  below 1.1.0, a security reviewer's PASS on a model its agent file does not name prints as
  `NOTE — the security-reviewer model check … expires in 2.1.0`. The subsection on the model
  record below says what counts.
- **A reviewer can be sent back for a PASS that lists a blocking finding, and `docs-sync`
  may print a NOTE about a reviewer body you forked.** Every shipped reviewer body now
  states `Blocking: CRITICAL, HIGH`, and a PASS whose reply lists `- [HIGH] …` is bounced
  to re-state, the way a reply with no verdict line is. A body you forked has no such line
  until you add it, so its reviewer is not bounced on this ground, and `docs-sync` names
  it in a NOTE that expires in 1.2.0. On a `baseVersion` below 1.1.0, `reviewer-verdicts`
  may also print `NOTE — the per-reviewer round budget`. The subsection on the severity
  contract below says what to do.
- **`docs-sync` may print a NOTE that a reviewer body you forked does not close on its
  verdict demand.** Only a reviewer body whose last paragraph is not the verdict demand, or
  a fork of `tools/lib/agent-roster.mjs`, produces one; every shipped body conforms. The
  subsection on the verdict demand below gives the fix.
- **The spec template has `##` headings, and `node tools/spec-anchor.mjs` prints one
  section.** The bold labels of `specs/_template.md` are now headings, with a new
  `Decisions` section whose entries each take a `###` heading, and a heading's id is its
  GitHub anchor. `node tools/spec-anchor.mjs specs/<feature>.md` lists a spec's ids, and
  `node tools/spec-anchor.mjs specs/<feature>.md#<id>` prints one section. `/new-feature`
  puts the sections a slice implements in the `torvalds-reviewer` brief, and `/adr` cites
  them in Traceability. Your own specs are not rewritten: one with bold labels has no ids,
  and the reviewer reads it whole. Nothing reads the tool's output, and no gate changes.
  If you edited one of the owned files above, your copy stays, the new one is parked under
  `.harness/pending/`, and `update` exits 2 while it stays there.
- **A new `docs/reviews/README.md` appears, untracked, and `/adr` and `/new-feature` point
  at it.** It says where review rounds go. No gate reads it, so it changes no verdict. If
  you already had a file at that path, `update` left it exactly as it was and parked
  nothing.
- **An agent that wants to change a register under `tools/` stages a proposal instead of
  asking you for `HARNESS_ALLOW_SELF_EDIT=1`.** The write guard's deny now tells it how, so a
  `harness-proposals/<id>.json` can appear in your tree. `doctor` lists it as `info`, and it
  changes nothing until you apply it. The bash guard denies an agent the `apply-proposal`
  command. The subsection on proposals below says how to review and apply one.
- **Reviewer replies carry `<id>: present (file:line)` and `<id>: absent` lines.** Every
  reviewer body but `citation-verifier`'s now lists what a change must bring, and its
  reviewer accounts for each row that applies. An absence is a finding at the severity the
  body already gives that rule, so a reviewer can now BLOCK on a revoke, a register row or a
  `page.meta.ts` that the diff never mentions. No gate changes. If you edited a reviewer
  body, your copy stays and the new one is parked under `.harness/pending/`; the subsection
  on companion tables below says how to take the table.
- **`.claude/rules/encryption.md` is shorter, and `.claude/rules/e2ee.md` is new.** The
  stub keeps what applies while the `e2ee` module is off, each item with the check that
  holds it. The full rule loads when a file under `packages/platform/crypto/`,
  `apps/*/src/host/` or `docs/modules/e2ee/` is read, and the `authoring-e2ee-feature`
  skill's Step 0 now tells the agent to read it first. No verdict changes. If you edited
  `encryption.md` or the skill, your copy stays, the new one is parked under
  `.harness/pending/`, and `update` exits 2 while it stays there; a file of your own already
  at `.claude/rules/e2ee.md` is kept the same way, as the 1.0.4 section describes for a
  harness-owned path with no manifest record.
- **A warm validate prints two more `STAMPED` lines: `essential-eight` and
  `conformance-map`.** The `docs-sync` step's two register scripts now skip when nothing
  their verdict reads has changed since their last green run: the register, the chain
  config, the workflows and, for the map, the guard rules, the module list, `docs/modules`,
  the generator and its two documents. `essential-eight` still checks `[storage]` and the
  upload surfaces on every run, before it looks at its stamp. CI and
  `validate --ci-parity` judge both in full, and the first run after `update` re-proves
  both. Nothing is yours to do. If you forked `tools/lib/stamp-inputs.mjs`, both judge in
  full until you merge the parked copy.
- **`provenance` prints `ADVISORY` lines, and the source-check hook stops blocking on
  some uncited sites.** An uncited or wrongly grounded site in `vector-index`,
  `llm-sampling` or `tuning-constants` alone now prints
  `provenance: ADVISORY (n) — file:line [class]` and passes, and the hook hands the agent
  a note instead of exiting 2. Nothing that was green turns red. The subsection on
  advisory classes below says how to keep a class mandatory.
- **`gate-integrity`'s OK line can say a check did not run.** With
  `HARNESS_ALLOW_SELF_EDIT=1` set, it reads `escape-list commit rule not run` and
  `threshold-config commit rule not run` where it printed a count of clean files, and with
  no git work tree it also reads `history check not run`. It exits as it did before. The
  doctrine's new section lists everything the flag relaxes, and its Stop-hook cost section
  no longer suggests commenting `build` or `e2e` out, which the floors and `gate-integrity`
  refuse.
- **`contracts` re-runs locally after an edit to your root `package.json`, and `pnpm gen`
  may name a vertical as not catalogued.** The event-catalog generator now reads the root
  `package.json` to decide whether the example's old export still applies, so the file joins
  the `contracts` stamp; CI never honoured a stamp. `tools/generated/event-catalog.json`
  regenerates unchanged. A direct run of the generator prints `<package> is not catalogued`
  for each other vertical whose `./client` does not export `EVENT_CATALOG`; those were not
  catalogued under 1.0.x either, and the gate prints nothing new. If you forked the
  generator, your copy stays, the new one is parked under `.harness/pending/`, and `update`
  exits 2 while it stays there: the subsection on the event catalog below says what to do.
- **`doctor` may warn that a catalog pin is below a security floor, and exit 2.** If your
  `pnpm-workspace.yaml` still pins `vitest` or `@vitest/coverage-v8` at 4.1.10, as every
  release from 0.1.3 through 1.0.2 scaffolded it, `doctor` prints one warning per package
  and exits 2 where it exited 0, and `update` prints a `CATALOG PIN FLOOR` note per package
  and parks `.harness/pending/pin-floors.json`. No gate reds on it, and `update`'s exit code
  does not move. The subsection on catalog pin floors below says what to do.
- **`actions-lint` runs a new job, `workflow-hardening`, and it may print NOTEs about
  workflows you wrote.** It checks every workflow under `.github/workflows/` for a
  workflow-level bash default, a ceiling on every job and harden-runner as each job's first
  step. Every workflow the harness ships passes. On an install whose `baseVersion` is below
  1.1.0 a finding prints as `workflow-hardening: NOTE — (ramp) …` and the job stays green
  until 1.2.0. The job also runs when `.harness/manifest.json` changes. The subsection on
  your own workflows below gives the sweep.
- **Six SQL gates may print a NOTE about your migration history.** Only when it holds a
  top-level `DROP TABLE` or `ALTER POLICY` (or, for `schema-rls`, a `DROP POLICY`), and only
  for a finding the gates now see because they read those statements. On an install whose
  `baseVersion` is below 1.1.0 each such finding reads `NOTE — (ramp)` under a NOTE that
  expires in 1.2.0. A table created and later dropped no longer reds `schema-rls` as
  undeclared. The subsection on the SQL history fold below says what to sweep.
- **`schema-rls` prints NOTEs about your grants, naming `profiles` and `notes` at least.**
  It now reds a table privilege `anon` or `authenticated` holds that no policy admits, a
  table that keeps the platform's default privileges for any of `anon`, `authenticated` or
  `service_role`, and a missing or stale `supabase/tests/rls_grants.generated.test.sql`.
  Every install below 1.1.0 meets the first two on `profiles` and `notes`, and an install
  that never applied 1.0.2's migration meets them on seven more tables. On an install whose
  `baseVersion` is below 1.1.0 each reads `NOTE — (ramp)` under a NOTE that expires in
  1.2.0, and `graduate` refuses while they stand. The subsection on the grant bound below
  gives the SQL, then the command.
- **`pnpm gen` records a DAL's `rpc()` and `upsert()` calls, and `query-shapes` judges
  them.** If no probed DAL function of yours makes either call, the manifest regenerates
  unchanged and nothing moves. If one does, it could not pass under 1.0.x: `pnpm gen` threw
  on the rpc, and an upsert failed `query-shapes` with advice about OFFSET pagination. Run
  `pnpm gen` again and commit the manifest; the subsection on rpc and upsert below says what
  the gate now checks.
- **The `i18n` Stop step may print NOTEs that expire in 1.2.0, and every FAIL line ends
  with a `{"key": …}` entry.** The step now also parses each file with your `typescript`
  and finds copy its regular expressions never matched, such as
  `accessibilityLabel={'Close dialog'}` or `<h2>Plans from $5</h2>`. On an install whose
  `baseVersion` is below 1.1.0 each such string prints as a NOTE, and so does each
  `{"site": "file:line"}` entry in `tools/i18n-allow.json`, with the key that replaces it.
  A finding the step already reported stays a red, and one only its regular expressions
  report says it retires with them in 1.2.0. Without an installed `typescript` the step
  says the walk did not run, and in CI it fails. The subsection on the i18n syntax-tree
  walk below says what to do.
- **Your chain has a 37th step, `web-compile`, and it builds your web app.** The first
  validate after `update` runs `next build` over `apps/web`, which takes tens of seconds,
  and prints `web-compile: STAMPED` on every later run until something under `apps/web`,
  `packages`, the base tsconfig, the workspace file or the lockfile changes. `static` runs
  it on every pull request. `route-manifest` may print a NOTE naming `notes` and `security`,
  and `docs-sync` a NOTE about your gate list. Your quality-gate workflow's `web-build` and
  `web-e2e` jobs gain one step that builds the workspace declarations first. The subsection
  on the web compile step below says what each NOTE asks of you.
- **`lint` now reads `supabase/functions`, and a new `edge-functions` job may print NOTEs.**
  A `getSession()` call or a raw `crypto.subtle` in one of your own Edge Functions now reds
  `lint` at once, as it would anywhere on the server graph, and so does a function over
  cognitive complexity 15 (the delete-account `index.ts` your install carries is exempt from
  that one until 1.2.0). `doctor` warns that the seeded delete-account function still has its
  1.0.x shape, and `update` notes four new files it did not plant. On an install whose
  `baseVersion` is below 1.1.0, `edge-functions`, `diff-coverage` and the mutation lane print
  `NOTE — (ramp)` lines about `supabase/functions` until 1.2.0. The subsection on Edge
  Functions below gives the sweep.
- **`gate-integrity`'s plant NOTE reads differently, and an untracked escape list can be a
  finding.** For an escape list `update` just planted, the NOTE now says its bytes match the
  manifest record and a harness release planted exactly these bytes
  (`tools/lib/planted-shas.json`); commit it with the rest of the upgrade, as before. An
  untracked escape list whose sha matches its manifest record but that no release planted,
  such as one created by hand with its sha written into `.harness/manifest.json`, now reads
  `gate-integrity: NOTE — (ramp 1.1.0) … no harness release planted these bytes` on an
  install whose `baseVersion` is below 1.1.0, until 1.2.0, and fails after. The subsection
  on planted escape lists below gives the sweep.

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

### `quality-gate.yml`: a push reuses its pull request's green lanes on an identical tree

`update` re-plants `.github/workflows/quality-gate.yml`, `tools/ci/summarize-gate.mjs` and
`docs/harness/README.md` when your copies still match a released sha, and plants two new
owned files, `tools/ci/lane-reuse.mjs` and `tools/lib/lane-reuse.mjs`. What changes for
you:

- **On a push to your default branch, `static`, `unit`, `mutation`, `runtime-rls`,
  `e2e-fast` and `integration-lane` may finish in seconds.** Each first asks whether the
  pull request you just merged passed that same job on the identical tree, at its final
  head. On a hit its steps are skipped, a notice names the pull request run it relied on,
  and `gate-summary` lists the lane as `REUSED` with that run. The job still reports
  success, because it cites one. A merge of a branch that was behind its base, a conflict
  resolution, a direct push, a red or unfinished pull request run, or a GitHub API error
  runs everything, as before. Nightly and manually dispatched runs never reuse.
- **Those jobs now request `actions: read` and `pull-requests: read`** beside
  `contents: read`, to list the pull request's runs, their jobs and job logs, and the pull
  request a push merged. Nothing is written. If the token cannot read them, the lookup
  misses and the lane runs in full.
- **A pull request from a fork never reuses.** Its run executed workflow text from a
  repository you do not control, so its merge runs every lane, which is what it did before.
- **If you forked `quality-gate.yml`,** `update` keeps your fork and parks the incoming copy
  at `.harness/pending/.github/workflows/quality-gate.yml`, and it exits 2 while that copy
  is there ("Forking an owned file" in the 1.0.2 section). Your fork keeps running every
  lane on every push until you merge the new steps in. When you merge them, copy each
  lane's lookup, hit-report and record steps, its `permissions:` and `outputs:` blocks and
  the `steps.reuse.outputs.hit != 'true'` condition on every step in between, then
  re-record the sha. A step you add to one of those lanes later needs the same condition.

### The pgTAP suites prove the rails on a fixture table: fresh scaffolds only

A fresh 1.1.0 scaffold's `supabase/tests/rls_isolation.test.sql`, `mfa_aal2.test.sql` and
`audit_immutability.test.sql` no longer prove isolation, the aal2 rail and audit capture by
writing to the example's table. Each builds a table of its own, `public.pgtap_fixture`,
inside its test transaction, between `-- fixture:begin` and `-- fixture:end`, and the
suite's ROLLBACK removes it. Its DDL is the RLS skeleton of
`.claude/skills/authoring-vertical-slice/references/migration-rls.md` with the table
renamed, plus the example's `title` and `body` columns; `mfa_aal2` adds the example's MFA
rail and `audit_immutability` its audit trigger, both renamed. The fixture runs on your real
`private.member_org_ids()`, `private.member_ranks()`, `private.mfa_satisfied()` and
`audit.write_row()`. A project that deletes the example keeps these proofs.

**Your install keeps its suites.** They are seeded: `update` does not rewrite them, and
nothing in your chain asks for the new ones. If you never edited a suite, pull the new one
with `npx next-expo-supabase-agent-harness@latest update --refresh-seeded supabase/tests/<file>`,
the channel the 1.0.2 section uses for `rls_structure.test.sql`, then run
`pnpm db:reset && pnpm test:rls`. If you did edit it, `--refresh-seeded` keeps your copy,
parks the new one under `.harness/pending/supabase/tests/`, and exits 2: merge by hand, by
adding the fixture region before the suite's first role switch and pointing your
behavioural assertions at `public.pgtap_fixture`.

**The new suites still name the example.** `rls_isolation`'s recursion probe still reads
`public.notes`, with every other RLS target, and the structural checks still name it:
`mfa_aal2`'s shape assertions read the `notes_mfa_aal2` policy, and `audit_immutability`'s
coverage read lists `notes` among the audited tables, as `rls_structure.test.sql` does. A
project that removes the example still edits those lines, as it did before. What no pgTAP
suite does any more is write to `public.notes`: the example's own rank floors, MFA policy
and audit trigger are judged statically, by `schema-rls` and `tenancy`, and the supabase-js
suite under `tests/rls/` still reads it across tenants.

### `reviewer-verdicts` judges the branch: the reviewer ledger v2 (a NOTE until 2.1.0)

Through 1.0.4 the Stop step owed reviewers on the diff against `HEAD` and judged one
prompt. A migration committed before the turn ended owed nobody, a deleted policy owed
nobody, a BLOCK was forgotten when you next spoke, and a reviewer that blocked, read the fix
and passed could not clear its own BLOCK. From 1.1.0 the step also runs the reviewer ledger
v2, which judges the branch:

- **The owed set is the diff from the merge base** with the branch's upstream (the PR base
  in CI) to the working tree, plus untracked files, with deletions and both sides of a
  rename included and `.harness/` left out. Committing does not clear it. Pushing clears
  whatever the upstream then holds: on a branch whose upstream is its own remote branch,
  which is what `git push -u` sets, the owed set after a push is only what is not pushed
  yet. An upstream set to the branch you will merge into (`git branch
  --set-upstream-to=origin/main`) keeps the whole branch owed.
- **The ledger is read for the whole session.** A BLOCK stands until the SAME reviewer run
  (its `agent_id`) returns PASS at the current tree. To clear one, fix what it named and
  resume that reviewer with `SendMessage` to its `agent_id`. A fresh run of the same
  reviewer is a second opinion and retracts nothing. A PASS whose tree has not moved stands
  for later prompts of the same session; a PASS from another session counts for nothing.
- **A PASS counts only for the tree it was dispatched on.** The hook now also runs on
  `SubagentStart` and records the reviewer's digest in `.harness/reviewer-dispatch.jsonl`.
  At the verdict it records the start and stop digests beside `path_state`, and the step
  counts the PASS only when both equal the tree at Stop. Let a reviewer finish before you
  edit the paths it is reading.
- **`torvalds-reviewer` and `citation-verifier` are owed on every non-empty diff,** through
  the new `wholeTurn` class of `tools/reviewer-triggers.json`.
- **With no upstream, v2 does not judge.** A fresh `git init`, or a branch with no
  upstream configured, prints `NOTE — no merge base` and keeps the 1.0.x judgement. Set
  one with `git branch --set-upstream-to=<remote>/<branch you will merge into>`.

**The ramp.** If your `baseVersion` is below 1.1.0, the 1.0.x judgement still decides and
v2's findings print as NOTEs that expire in 2.1.0. Neither relaxation applies to you yet:
a BLOCK still stands for the rest of its prompt, and a PASS from an earlier prompt still
does not count. They arrive with the tightening, when you graduate or when the ramp
expires. A fresh 1.1.0 scaffold is judged by v2 from the start.

**What to do, in this order.**

1. **If `update` parked `.claude/hooks/subagent-verdict.mjs`, merge it first.** A 1.0.x copy
   of the hook reads a `SubagentStart` payload as a reviewer that ended without a verdict:
   every reviewer dispatch then exits 2 (which `SubagentStart` does not block), appends a
   bounce to `.harness/verdict-bounces.jsonl` and records a blocked turn outcome. If
   `update` re-planted `.claude/settings.json` while it parked your hook, take the hook's
   `SubagentStart` branch now, or remove the `SubagentStart` block until you do.
2. **If `update` parked `.claude/settings.json`,** add the `SubagentStart` block beside
   `SubagentStop`, after step 1. Without it every PASS reds, once v2 is live, with a finding
   that names this block: `wiring` cannot see it, because the hook is already wired under
   `SubagentStop`.

   ```json
   "SubagentStart": [
     {
       "hooks": [
         {
           "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/launch.mjs\" subagent-verdict.mjs",
           "timeout": 10,
           "type": "command"
         }
       ],
       "matcher": "*"
     }
   ],
   ```

3. **Add the `wholeTurn` class to `tools/reviewer-triggers.json`.** The file is seeded, so
   `update` never rewrites it. Put these two keys before `notTriggered`, and delete the
   `torvalds-reviewer` and `citation-verifier` rows from `notTriggered`. Until you do, v2
   owes no whole-turn reviewer on your install.

   ```json
   "wholeTurnMatching": "A reviewer in `wholeTurn` is OWED whenever the owed diff is non-empty, whatever its paths, and its verdict binds to a digest over the WHOLE diff: any later change anywhere in it sends the PASS stale. The owed diff is the one tools/lib/git-diff.mjs reviewChanges() returns (the merge-base diff with deletions, 1.1.0), and the class is judged by the reviewer ledger v2 in tools/check-reviewer-verdicts.mjs.",

   "wholeTurn": [
     {
       "agent": "torvalds-reviewer",
       "why": "AGENTS.md says it runs 'before finishing', which is EVERY turn. No path pattern expresses that: a path trigger would fire it on everything (noise) or on an arbitrary subset (a rule that reads as coverage and is not). Through 1.0.4 it sat in notTriggered for that reason, and its verdicts were recorded and never judged. The whole-turn class is the different mechanism a whole-turn obligation needed."
     },
     {
       "agent": "citation-verifier",
       "why": "Its definition says it MUST BE USED before finishing a feature, so it is summoned before a turn ends, like torvalds-reviewer, and until 1.1.0 its verdict was recorded and never judged. The `provenance` chain gate still reds tree-wide on an uncited decision site; this class judges the other half, that the reviewer which checks each citation resolves actually ran on this diff."
     }
   ],
   ```

4. **Update the `reviewer-verdicts` sentence in `AGENTS.md`.** Also seeded. In the Stop-chain
   bullet, replace the text from "The last one is the only check" to "Triggers are reviewed
   data in" with this, and keep a period at the end of the line that ends the bullet: a
   backticked lowercase name before the first `(` would read to `docs-sync` as a Stop step.

   ```
   The last one is the only check in the
   harness whose subject is the TURN rather than the tree: every reviewer whose
   `MUST BE USED` paths this branch's diff touched must have returned
   `VERDICT: PASS` on the tree it was dispatched on, recorded by the
   SubagentStart and SubagentStop hooks (the diff runs from the merge base with
   the branch's upstream and keeps deletions; `torvalds-reviewer` and
   `citation-verifier` are owed on every non-empty diff; a BLOCK stands until the
   same reviewer passes). Triggers are reviewed data in
   ```

5. **Ignore the local stack's branch marker.** `.gitignore` is seeded too. `supabase start`
   writes `supabase/.branches/_current_branch` beside `supabase/.temp/`, and an untracked
   file is part of the owed set, so without this line a clean tree with the stack up owes
   both whole-turn reviewers. Add it under your `supabase/.temp/` line:

   ```
   supabase/.branches/
   ```

6. **Before you graduate, run the owed reviewers once more.** Entries a 1.0.x hook wrote
   carry no v2 digests, so v2 counts none of them. Read what v2 would say off the NOTEs,
   with an upstream set, and graduate when they are gone.

### The session-start brief: `node tools/harness-status.mjs` and a SessionStart hook

A SessionStart hook, `.claude/hooks/session-brief.mjs`, prints the harness brief into every
session's context when it starts, resumes, clears, compacts or forks, and
`node tools/harness-status.mjs` prints the same bytes in a terminal:

```
harness 1.1.0 (base 1.0.4) · tier standard · mode bootstrap
parked: 1
  - `.claude/settings.json`
last turn in this directory: green
reviewers owed by the current diff: 1
  - security-reviewer (`supabase/migrations/20260930000000_x.sql`)
```

The hook blocks nothing, reads no stdin, writes nothing and exits 0 on every path. A value
that fails its validator prints as `(unprintable)`, and a source that cannot be read prints
`<field>: unavailable`. The owed reviewers are the set Stop step `reviewer-verdicts` decides
on, so on a `baseVersion` below 1.1.0 they are the 1.0.x set until you graduate, and with no
upstream they are the uncommitted changes only. `.claude/settings.json`,
`tools/harness-status.mjs` and `tools/lib/harness-brief.mjs` are owned and reach you with
this `update`. Three things do not:

1. **The `harness:status` script.** `package.json` is seeded, so `update` only prints `new
   template script not installed: "harness:status"`. Add it by hand if you want it; nothing
   in the harness's own text depends on it, because every owned file cites
   `node tools/harness-status.mjs`:

   ```json
   "harness:status": "node tools/harness-status.mjs",
   ```

2. **The `AGENTS.md` line.** Also seeded. Copy it into the Commands list if you want agents
   told about the command; it spends one line of the file's `~350` budget:

   ```
   - `node tools/harness-status.mjs` — install state, parked files, last turn, reviewers owed.
   ```

   Do not write `pnpm harness:status` there unless you added the script: `docs-sync` reds
   an `AGENTS.md` that advertises a script `package.json` lacks.

3. **With a kept-fork `.claude/settings.json`, the hook itself.** `wiring` reds a hook file
   in `.claude/hooks/` that nothing wires, so when `update` keeps your settings fork it parks
   the new hook at `.harness/pending/.claude/hooks/session-brief.mjs`, beside the parked
   `.harness/pending/.claude/settings.json`, and says so in a note; `wiring` stays green.
   To adopt it, merge the `SessionStart` block from the parked settings into yours, beside
   `PreToolUse` (the settings keep their events in alphabetical order), re-record your fork
   (the 1.0.2 section, "Forking an owned file"), and run `update` again: with the entry in
   your settings, `update` writes the hook and records it. Then delete both parked copies.
   Do not move the parked hook into `.claude/hooks/` by hand: a hook placed there by hand has
   no manifest record, so `gate-integrity` cannot hash it.

   ```json
   "SessionStart": [
     {
       "hooks": [
         {
           "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/session-brief.mjs\"",
           "timeout": 10,
           "type": "command"
         }
       ],
       "matcher": ""
     }
   ],
   ```

   The command runs the hook directly, not through `launch.mjs`: SessionStart cannot block,
   so the launcher's "failing closed, action blocked" would be false there.
   `gate-integrity` accepts this form.

### Field notes: `tools/field-notes.json`

A place for what your project has learned about a gate in its own tree: the fixture it
trips on, the fix that is usually right. `update` plants the empty skeleton when your
install has none, and never touches one you already have. It stays untracked until you
commit it. No gate judges its contents, so the planted skeleton cannot turn a validate red;
the `format` step checks it like any JSON under `tools/`.

```json
{
  "comment": "…",
  "notes": {
    "tenancy": "one line: what usually causes this red here, and the fix that is usually right"
  }
}
```

When that gate fails, its output ends with the usual `FIX[tenancy]:` line and then
`FIELD-NOTE[tenancy]: <your text>`. Nothing else changes: the exit code, the finding and
the FIX line are the same with or without a note, and a note never prints on a pass, a
stamped run or a local skip.

- **Key on the token the FAIL line prints** (`<gate>: FAIL`), which is not always the chain
  step's name: the `docs-sync` step's scripts report as `docs-sync`, `essential-eight` and
  `conformance-map`, and the scheduled floor review reports as `floor-review`. A key outside
  `[a-z0-9-]`, and a value that is not a string, are ignored.
- **One line of text.** Whitespace collapses to single spaces, control and format
  characters are removed, and the text is cut at `FIELD_NOTE_MAX_CHARS` code points
  (`tools/lib/gate.mjs`). A file that is not valid JSON prints one line saying so under
  every failing gate, and no note.
- **A human writes it.** The file is write-guarded (`field-notes`): its text reaches an
  agent at the moment it decides how to make a red go away, so an agent cannot edit it.
- **Where no note can print.** `format`, `types`, `lint`, `dead-code`, `architecture`,
  `unit`, `mobile-unit` and `rls-isolation` print no `<gate>: FAIL` line, and a long failed
  Stop step may keep a note only in `.harness/stop-output/<step>.log`. The catalog's
  "Shared behavior" paragraph has the details.

### A reviewer verdict records the model it ran on (security reviewers: a NOTE until 2.1.0)

A reviewer's agent file pins one model, and Claude Code can still run it on another: a
per-invocation `model` parameter, `CLAUDE_CODE_SUBAGENT_MODEL` (with
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`), an `availableModels` allowlist that substitutes for a
blocked model, or a `fallbackModel` chain that fails over. From 1.1.0 the SubagentStop hook
records in each ledger entry the `model` that wrote the verdict, read from the subagent's
own transcript, and `pinned`, whether it is the pin. `reviewer-verdicts` judges it:

- **The pin counts, and an alias pin counts for its whole family.** `model: opus` counts for
  any Opus model ID, whichever version the alias resolved to. A full model ID counts only as
  itself.
- **A listed model counts, and is named.** Each shipped reviewer file now carries a
  `harnessFallbackModels` line, next to `model`. Claude Code ignores the key and picks no
  model from it; `reviewer-verdicts` reads it. To run a reviewer on a listed model, pass
  that model as the per-invocation `model`.
- **Any other model is named, never silently counted.** One `FALLBACK MODEL` line per
  verdict, shown to you as a warning when the turn ends green.
- **For `security-reviewer`, `web-security-reviewer` and `mobile-security-reviewer` it does
  not count.** A PASS on a model that is neither the pin nor listed, or one whose model the
  hook could not read (`model: null`), reds.

Entries written before the update carry no `model` field and are judged exactly as before.

**The ramp.** If your `baseVersion` is below 1.1.0, the security finding prints as a NOTE
that expires in 2.1.0. A fresh 1.1.0 scaffold is judged from the start.

**What to do.**

1. **If your configuration forces a model on subagents, check it against the security
   reviewers' lists.** The settings that do are `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, an
   `availableModels` allowlist that blocks a reviewer's pin, and a `fallbackModel` chain. A
   re-run lands on the same model, so re-running does not clear the finding. Either lift
   the setting for your security reviews, or, if you accept that model for security review,
   add it to that reviewer's `harnessFallbackModels` in a reviewed diff. The agent files are
   write-guarded and hashed, so that is a human act: edit under
   `HARNESS_ALLOW_SELF_EDIT=1`, re-record the lock with
   `HARNESS_ALLOW_SELF_EDIT=1 node tools/gen-agents-lock.mjs --write`, and re-record the
   file's sha in `.harness/manifest.json` (the 1.0.2 section, "Forking an owned file").
2. **If a reviewer cannot run on its pin** (the Agent tool reports a model error, and the
   Stop red says the reviewer did not run), dispatch it with the Agent tool's `model` set
   to a model its `harnessFallbackModels` line names. The red says so too. That verdict
   counts, and is named.
3. **If `update` parked one of your reviewer files,** your copy has no list, so only its pin
   counts. Merge the parked copy to take the list.
4. **If every PASS records `model: null`,** the hook cannot find the model in your Claude
   Code's transcript. That is a harness defect, not yours: report it with your Claude Code
   version.
5. **Before you graduate,** read the NOTEs, fix what they name, and graduate when they are
   gone.

### Reviewer bodies state which severities block, and review rounds get a budget (NOTEs until 1.2.0)

Until 1.1.0 no reviewer body said which severity justifies `VERDICT: BLOCK`, so a nit and a
vulnerability both could, and a reviewer could PASS over a HIGH finding it listed itself.
Nothing bounded a fix-and-re-review loop either, except the turn-wide block cap that every
kind of block spends. From 1.1.0:

- **Every reviewer body states its severity contract**, on two lines of their own before its
  closing verdict paragraph, with the finding format after them:

  ```
  Severities: CRITICAL, HIGH, MEDIUM, LOW
  Blocking: CRITICAL, HIGH

  Write each finding on a line of its own as `- [SEVERITY] file:line — …`, with a severity
  from the `Severities:` line. Return `VERDICT: BLOCK` when a finding at a `Blocking:`
  severity stands, and `VERDICT: PASS` otherwise: a PASS that lists a blocking finding is
  sent back to you to re-state.
  ```

  `docs-sync` holds the two lines: each present once, `Blocking:` a subset of
  `Severities:`, and `Blocking:` holding at least `CRITICAL` and `HIGH`.
- **The SubagentStop hook bounces a PASS that lists a blocking finding.** It reads the
  `Blocking:` line from the body of the reviewer that stopped. A reply that ends
  `VERDICT: PASS` and has a line starting `- [HIGH] …` exits 2, so the reviewer re-states,
  and `.harness/verdict-bounces.jsonl` records the shape `pass-with-blocking-finding` with
  the finding lines. A BLOCK is never bounced on this ground, and neither is a body with no
  `Blocking:` line, which keeps the 1.0.x behaviour.
- **Each verdict records its round, and the Stop step holds each reviewer to a budget of 3
  rounds per review loop.** A BLOCK opens a loop, every later verdict of that reviewer in
  the session is its next round, and the loop closes when the same run (its `agent_id`)
  passes over a tree that did not move under it. A loop still open after its third round
  is spent: `reviewer-verdicts` reds with every blocking finding the reviewer recorded and
  tells the agent to stop and hand them to you, and a PASS recorded after that never clears
  it. The budget is judged over the change set the reviewer ledger v2 keys, so on a branch
  with no upstream it does not judge, and `NOTE — no merge base` says so. It is a constant
  of the owned `tools/lib/reviewer-verdicts.mjs`, not a field of the seeded
  `tools/reviewer-triggers.json`, so there is nothing to add to your trigger table.

**When a budget is spent.** The step keeps redding for as long as that reviewer is owed in
this session, and the agent is told not to run it again. The findings are yours to decide:
fix them yourself, or with the agent in a NEW session, where every budget starts afresh; or
change the diff so it no longer owes that reviewer. Starting a new session is the reset, and
it is a human's act, not the agent's.

**The ramps.** If your `baseVersion` is below 1.1.0, both checks print as NOTEs that expire
in 1.2.0:

```
docs-sync: NOTE — the reviewer severity contract (ramp: live from baseVersion 1.1.0; this install's baseVersion is <yours>; expires in 1.2.0). …
docs-sync: NOTE — (ramp) .claude/agents/<name>.md: no `Blocking:` line — …
reviewer-verdicts: NOTE — the per-reviewer round budget (ramp: live from baseVersion 1.1.0; …; expires in 1.2.0). …
```

From harness 1.2.0 the same findings print under `RAMP EXPIRED` and red their step, and on an
install whose `baseVersion` is 1.1.0 or later they red from the start. The hook's bounce is
not ramped: it fires only for a body that states `Blocking:`, and an existing install gets
one only when `update` re-plants an unmodified body or you add the lines yourself.

**Adding the contract to a forked reviewer body.** `.claude/agents/` is write-guarded and the
lock is a human act, so each step is yours, not an agent's.

1. **Add the lines.** Merge the parked copy from `.harness/pending/.claude/agents/<name>.md`
   if `update` left one, or paste the block above into your body, just before its closing
   `End with exactly one final line: …` paragraph, which must stay last. Keep `CRITICAL` and
   `HIGH` on the `Blocking:` line; you may add `MEDIUM` to block on more.
2. **Re-lock the agent surface.** `prompts` reds the edited body until the lock moves, and the
   bash guard refuses the writer from an agent's shell, so a human runs:

   ```
   HARNESS_ALLOW_SELF_EDIT=1 node tools/gen-agents-lock.mjs --write
   ```

3. **Re-record the body's sha** in `.harness/manifest.json`, in a reviewed commit, as
   "Forking an owned file" in the 1.0.2 section describes, and delete the parked copy.

A reviewer of your own, outside the eight the harness ships, is not judged by `docs-sync`. Add
the two lines to it if you want the hook to hold its PASSes to its findings. If the `docs-sync`
finding names `tools/lib/agent-roster.mjs`, or the `reviewer-verdicts` one names
`tools/lib/reviewer-verdicts.mjs`, your fork of that lib predates the contract: merge the
parked copy under `.harness/pending/tools/lib/` into it and re-record its sha.

### A reviewer body must close on its verdict demand (`docs-sync`, a NOTE until 1.2.0)

The SubagentStop hook records a reviewer's PASS only when `VERDICT: PASS` is the last line
of its reply. A reviewer body that asks for anything after that line, such as "Follow it
with the top 3 fixes", which two shipped bodies said at v1.0.1, gets every obedient PASS
bounced. `docs-sync` used to check only that a body asked for the verdict somewhere. From
1.1.0 it also checks where: the last paragraph of each reviewer body in `.claude/agents/`
must be exactly this, with the second and third sentences optional:

```
End with exactly one final line: `VERDICT: PASS` or `VERDICT: BLOCK`. The prefix is
what makes the outcome machine-readable — a bare `PASS` can occur anywhere in prose,
so a caller (or a future receipt gate) cannot tell a verdict from a sentence.
```

Line breaks and CRLF endings do not matter; words do. The severity contract's lines and the
finding format (the subsection above) come before this paragraph, never after it. A body
with no verdict demand at all still reds on every vintage, as it always has.

**Who sees it.** Only an install that forked a reviewer body. `update` re-plants an
unmodified body, and every shipped body conforms. A fork you re-recorded is kept; when the
shipped body changed since your version, the incoming copy is parked at
`.harness/pending/.claude/agents/<name>.md`. If your `baseVersion` is below 1.1.0 the
finding is a NOTE:

```
docs-sync: NOTE — reviewer bodies closing on the verdict demand (ramp: live from baseVersion 1.1.0; this install's baseVersion is <yours>; expires in 1.2.0). …
docs-sync: NOTE — (ramp) .claude/agents/<name>.md: reviewer body does not close on the verdict demand — …
```

From harness 1.2.0 the same finding prints under `RAMP EXPIRED` and reds the step, and on
an install whose `baseVersion` is 1.1.0 or later it reds from the start.

**The fix, in this order.** `.claude/agents/` is write-guarded and the lock is a human act,
so each step is yours, not an agent's.

1. **Restore the closing paragraph.** Merge the parked copy from `.harness/pending/` if there
   is one, or copy the paragraph above from the template. Move whatever your fork asked for
   after the verdict to an earlier paragraph, and say it comes BEFORE the verdict, as the
   shipped `torvalds-reviewer.md` does: "Give the top 3 fixes, most important first, BEFORE
   the verdict".
2. **Re-lock the agent surface.** `prompts` reds the edited body until the lock moves, and
   the bash guard refuses the writer from an agent's shell, so a human runs:

   ```
   HARNESS_ALLOW_SELF_EDIT=1 node tools/gen-agents-lock.mjs --write
   ```

3. **Re-record the body's sha** in `.harness/manifest.json`, in a reviewed commit, as
   "Forking an owned file" in the 1.0.2 section describes: the record keeps `update`
   treating the file as yours. Delete the parked copy once merged.

If the finding names `tools/lib/agent-roster.mjs` instead of a body, your fork of that lib
predates the rule: the gate still checks that each body asks for the verdict, but cannot
check where. Merge `.harness/pending/tools/lib/agent-roster.mjs` into your fork, so that it
exports `verdictDemandProblem`, and re-record its sha. A fork older than 1.1.0 also lacks
`severityContractProblems`, so the severity contract's NOTE names the same lib, and the
same merge clears both.

**One limit.** Only the last paragraph is checked. An earlier paragraph that asks for text
after the verdict line still passes `docs-sync`, and the hook still bounces every PASS that
obeys it, so read your fork for that too.

### Review records: `docs/reviews/`

Reviewer findings had no place in history: the ledger under `.harness/` is ignored by git,
and the ADR template has no section for them. From 1.1.0 a change keeps its review at
`docs/reviews/<YYYYMMDD>-<slice>.md`, named like its ADR, with a `## Round <n> — YYYY-MM-DD`
section per round holding a `| Reviewer | Verdict | Findings | Resolution |` table.
`docs/reviews/README.md` defines the shape, the ADR template's Traceability section links
the record, and `/adr` and `/new-feature` tell the agent to write it. No gate reads the
directory, so a missing or malformed record turns nothing red.

`update` plants `docs/reviews/README.md` where your install has none, and leaves one you
already have exactly as it is, with nothing parked beside it. The owned files above reach
you as usual. One text does not:

1. **The `AGENTS.md` sentence.** `AGENTS.md` is yours, so `update` does not touch it. In its
   Provenance list, extend the ADR bullet so it reads:

   ```
   - Emit one ADR per slice via `/adr <slice>` (records in `docs/adr/`); then run
     `/verify-citations` until it returns `CITATIONS: CLEAN`. Review rounds go in
     `docs/reviews/<YYYYMMDD>-<slice>.md`, never in the ADR.
   ```

   It spends one line of the file's `~350` budget.

Two things to know once you keep records:

- **The whole-turn reviewers see the record.** No path in the `reviewers` list of
  `tools/reviewer-triggers.json` matches `docs/**`, so writing a record leaves those
  reviewers' verdicts standing; keep it that way if you add trigger paths. The `wholeTurn`
  class, where your table has one, binds each PASS to the whole diff, the record included,
  so a round recorded after a `torvalds-reviewer` or `citation-verifier` PASS sends it stale.
  The README's "The record is part of the diff" section gives the order that ends there:
  record every round, then run the whole-turn reviewers once more over the diff that holds
  the record, and leave that confirming run out of it.
- **An `-- adr:` marker names the ADR, never the record.** The `migrations` gate checks only
  that the named file exists, so it would accept a record; the rule is written down, not
  enforced.
### Proposing a register edit: `harness-proposals/` and `apply-proposal`

The write guard denies an agent every reviewed register under `tools/`: the allowlists, the
budgets and registers such as `tools/i18n-allow.json`, `tools/approved-tools.json` or
`tools/mcp/corpus/project.json`. Until 1.1.0 an agent with a reason to change one could only
describe the edit, and you either typed it or relaunched the session with
`HARNESS_ALLOW_SELF_EDIT=1`, which lifts the guard for every protected path at once. From
1.1.0 the agent writes the whole proposed file as one JSON document,
`harness-proposals/<id>.json`:

```json
{
  "version": 1,
  "target": "tools/i18n-allow.json",
  "reason": "Why the register should change.",
  "base": "<output of git rev-parse HEAD:tools/i18n-allow.json, or null if the file is not in HEAD>",
  "content": "<the whole proposed file>"
}
```

`harness-proposals/` is a committed directory outside every path the deny list and the two
guards name, so staging a proposal narrows none of them, and a proposal is inert: no gate
reads it. `format` checks it like any other file, so the agent writes it the way
`JSON.stringify(proposal, null, 2)` prints it, with one trailing newline.

**What to do.**

1. **List what is pending.** `doctor` lists each proposal as `info`, and so does
   `npx next-expo-supabase-agent-harness@latest apply-proposal` with no id. Run the installer of
   the harness version you installed or a later one.
2. **Review one.** Add the id and `--dry-run`: the command prints the reason and a
   `git diff --no-index` of the current file against the proposed one, and writes nothing.
   It needs a terminal on stdin and stdout.
3. **Apply it, or delete it.** Run the same command without `--dry-run`. After the diff it
   asks you to type the target path, and only that answer writes the file. It then deletes
   the proposal and prints `commit <target>`. To reject a proposal, delete the file.
4. **Commit the register.** It is left uncommitted on purpose: `gate-integrity` fails on an
   escape list left uncommitted (a shell with `HARNESS_ALLOW_SELF_EDIT=1` set skips that
   check), and the commit carries the change into your pull request, where CODEOWNERS
   applies. If the proposal was committed, commit its removal with it.

**When it refuses.** Each refusal exits 1, names its reason and writes nothing:

- **The target is not proposable.** A proposal may target the escape lists in
  `tools/lib/enforcement-surface.mjs` and `tools/field-notes.json`. It may not target an
  owned file, the agent surface, settings, a pinned, hashed or generated file, or
  `tools/perf-baseline.json` and `tools/mutation-baseline.json`, which only their
  generators write: re-run the generator yourself.
- **`base` does not match `git rev-parse HEAD:<target>`**, or it is null for a file that is
  in `HEAD`, or set for one that is not. The register changed after the proposal was staged,
  and replacing the whole file would revert that change. Ask for the proposal again.
- **The target has uncommitted changes.** Commit or discard them first, so the file the diff
  shows is the file that is replaced. The check runs again after you answer.
- **The id or the target resolves outside `--dir`**, the content is not JSON, the proposal
  has a field the format does not have, or its text carries a control or
  bidirectional-format character that could make the terminal show something other than
  the bytes written.

### Reviewer bodies list what a change must bring: `## WHAT MUST ACCOMPANY IT`

A reviewer body's rubric asks about the lines a diff contains. A companion the diff should
have brought and did not, such as the `REVOKE ALL … FROM authenticated` that 1.0.2 found
missing on seven tables, is on no line of it. From 1.1.0 every reviewer body except
`citation-verifier`'s carries a table of those companions, placed before its `Flag ONLY`
paragraph where it has one, before its `Severities:` line, and always before its closing
verdict demand:

```
| id | The diff introduces | It must also bring | Stated in | Enforced by |
```

Each row restates a rule the harness already states in the file its `Stated in` cell names,
so the table adds questions, not rules. The reviewer reports each row that applies as
`<id>: present (file:line)` or `<id>: absent`, and an absence is a finding at the severity
the body already gives that rule, so it BLOCKs when that severity is on the body's
`Blocking:` line. `Enforced by` names the chain step that reds the absence, or says
`review only`. A row that a step enforces stays in the table, because the database-backed
proofs skip when no local stack is running. The web-page rows of `accessibility-reviewer`
and `design-reviewer` widen those two bodies past the mobile UI: `tools/reviewer-triggers.json`
already summons both on `apps/web/app/**/page.tsx`.

**Who has to act.** Only an install that forked a reviewer body. No gate reads a table, so a
fork without one reds nothing and simply gets no companion questions. To take the table:

1. **Copy the section.** Take `## WHAT MUST ACCOMPANY IT`, its paragraph and its table from
   the parked copy at `.harness/pending/.claude/agents/<name>.md` into your body where the
   parked copy has it: after the rubric, before the `Flag ONLY` paragraph where your body has
   one, before the `Severities:` line where it has one, and always before the closing
   verdict demand, which stays the body's last paragraph.
2. **Re-lock the agent surface and re-record the body's sha**, as steps 2 and 3 of "Adding
   the contract to a forked reviewer body" describe, in the severity-contract subsection
   above, and delete the parked copy.

A row of your own is welcome in a fork: keep the five columns, a backticked kebab-case id,
and a `Stated in` path that exists in your tree.
### A smaller always-loaded context: `encryption.md` is a stub, and trimming `AGENTS.md` is optional

Every session loads `AGENTS.md` and each rule file without `paths:`. Until 1.1.0
`encryption.md` was one of them in full, while most of it governs the opt-in `e2ee` module.
It now keeps what applies with the module off, each item with the check that holds it in a
base install, and its seven bullets moved word for word to the path-scoped
`.claude/rules/e2ee.md`. The lint and write-guard messages that cite
`.claude/rules/encryption.md` still point at text that states their rule.

`update` delivers this to the harness-owned files: both rule files, the
`authoring-e2ee-feature` skill, `docs/harness/README.md` and `tools/conformance-map.json`.
**`AGENTS.md` is yours, so `update` does not touch it, and nothing turns red whether you
trim yours or not.** The shipped copy no longer carries the rules it repeated from
`.claude/rules/security-invariants.md` that a hook denies with a message naming the fix:
`WITH RECURSIVE` without a `CYCLE` clause or visited guard, secret-shaped `EXPO_PUBLIC_` and
`NEXT_PUBLIC_` names, and the shell commands the bash guard refuses outright (`rm -rf`,
force-push, `git reset --hard`, `git commit --no-verify`, reading `.env*` or `.dev-auth/`,
`pnpm update`, `knip --fix`). No gate reads those sentences, and the always-loaded
`security-invariants.md` still states each rule in every session. To take the smaller
file, delete the `WITH RECURSIVE` bullet under `## Security invariants`, and change the
secret-name bullet and the shell-hygiene bullet to:

> - **The public config is `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE` /
>   `EXPO_PUBLIC_*` transport only**; the service-role key and any provider secret stay
>   server-env.
>
> - **Shell hygiene** (bash-guard enforced): no destructive raw SQL outside migrations,
>   and store/signing credentials (`EXPO_TOKEN`, Android keystores, Apple API keys)
>   never touch shell or repo.

Leave the gate-list and Stop-chain sentences, the `Keep under ~N lines` sentence and every
`pnpm` command it advertises as they are: `docs-sync` reads them.

### Advisory decision classes: `provenance` reds only the mandatory ones

Until 1.1.0 every decision class blocked alike: an uncited `timeoutMs` failed `provenance`
and made the source-check hook exit 2, exactly as an uncited `CREATE POLICY` did. From
1.1.0 three classes are **advisory**: `vector-index`, `llm-sampling` and
`tuning-constants`, listed in the owned `tools/lib/provenance-rules.mjs`. An uncited site,
or a citation whose corpus entry does not cover the class, whose classes are all advisory
prints on every run and fails nothing:

```
provenance: ADVISORY (1) — apps/web/lib/limits.ts:1 [tuning-constants] no SOURCE citation
```

The hook answers the same site with a note in the agent's context and exits 0. Every other
class stays **mandatory**: `rls-policy`, `guc-identity`, `token-verification`,
`cryptography`, the seeded `mobile-security` and every group your
`tools/decision-groups.json` adds. A line that matches a mandatory class and an advisory
one, such as `jwtVerify(t, k, { timeoutMs: 5 })`, is mandatory. A citation you do write
must still ground, whatever the class: a pinned corpus id, an existing repository path or
a URL on an allowlisted host.

**Keeping a class mandatory.** Add a top-level `mandatory` list to
`tools/decision-groups.json`, beside `comment` and `groups`:

```
  "mandatory": ["tuning-constants"]
```

The file is write-guarded, so a human makes the edit and commits it, or reviews and applies
an agent's `harness-proposals/<id>.json` for it (the subsection above). A value that is not
an array, or a key that is not a decision group, fails `provenance` and blocks every edit
until it is fixed. Nothing in the file can make a mandatory class advisory.

**What `update` leaves alone.** `tools/decision-groups.json` and
`tools/reviewer-triggers.json` are seeded, so an existing install keeps its copies. The
`mandatory` key works without the new comment, which only documents it, and the
`citation-verifier` sentence in `tools/reviewer-triggers.json` is prose no check reads.
Copy either from the template if you want the text.

**If you edited `tools/lib/provenance-rules.mjs`.** `update` keeps your copy, parks the new
one under `.harness/pending/` and exits 2 while it stays there. The re-planted gate and
hook find the split only in the new copy, so until you merge it every class stays
mandatory, exactly as before 1.1.0, and nothing turns red that was green.

### The event catalog: a vertical opts in from its `./client`

`tools/gen-event-catalog.mjs` no longer imports the example by name. It walks the platform
catalog plus each `packages/verticals/*` whose `./client` entry exports its catalog as
`EVENT_CATALOG`, and it still reads the example's `noteEvents` export, as 1.0.x did, for as
long as your root `package.json` lists `@app/notes` and that vertical has not opted in.
**Your catalog regenerates unchanged, and nothing is yours to do.** A fresh 1.1.0 scaffold's
`packages/verticals/notes/src/client.ts` carries the line below where yours has
`export { noteEvents } from './events.js'`, and its root `package.json` no longer lists
`@app/notes`. Adopting the line is optional:

```ts
export { noteEvents as EVENT_CATALOG } from './events.js'
```

To catalogue one of your own verticals, add the same line to its `src/client.ts`, naming its
own catalog, then run `pnpm gen:contracts`, the part of `pnpm gen` that needs no database,
and commit the regenerated `tools/generated/event-catalog.json`. The generator looks for the
name in the file's code, not in its comments, and a vertical that names it without exporting
a catalog fails the generator with an error naming the file. If you later remove the
example, drop `@app/notes` from the root `package.json` in the same change: while the root
lists it and the vertical has not opted in, the generator still takes the old import, which
fails once the vertical is gone, as it did under 1.0.x. The reverse holds too: pulling the
new root `package.json` with `update --refresh-seeded package.json` without the `client.ts`
line drops the example's three rows at the next regeneration, so take both together.

If you forked `tools/gen-event-catalog.mjs` to add your own verticals' imports, your copy is
kept and the new one is parked at `.harness/pending/tools/gen-event-catalog.mjs`. Add the
export to each vertical your fork imported, take the parked file, re-record it as "Forking
an owned file" in the 1.0.2 section describes, and delete the parked copy. Then
`pnpm gen:contracts` leaves `tools/generated/event-catalog.json` unchanged.

### A catalog pin below a security floor: `.harness/pending/pin-floors.json`

A release can now record a security floor for a pin in your seeded catalog. 1.1.0 records
two: `vitest` and `@vitest/coverage-v8` at 4.1.11, for GHSA-82fw-gwwq-j7x9, the raise the
1.0.3 section above asks you to make by hand. `update` still never edits
`pnpm-workspace.yaml`, so it tells you instead, once per package:

```
CATALOG PIN FLOOR (1.1.0): raise `vitest` from 4.1.10 to at least 4.1.11 in the pnpm-workspace.yaml catalog, then `pnpm install` and commit pnpm-lock.yaml. WHY: … (parked at .harness/pending/pin-floors.json)
```

and `doctor` warns with the same finding (`catalog pin below a security floor (since
1.1.0)`) and exits 2 until the pin meets the floor. It never exits 1 for a floor: an old
pin stops no gate from running, and your daily `osv-scan` job is still what judges the
version your lockfile resolved. To clear it, raise both pins together, exactly as the 1.0.3
section shows, then run `doctor` again:

```
# in the pnpm-workspace.yaml catalog: vitest: 4.1.11 and '@vitest/coverage-v8': 4.1.11
pnpm install && git add pnpm-lock.yaml pnpm-workspace.yaml
npx next-expo-supabase-agent-harness@latest doctor
```

`doctor` deletes `.harness/pending/pin-floors.json` once every floor is met and says so in
an `info` line; it is an instruction, not a parked upgrade, so there is nothing to merge
from it. A pin is judged by the lower bound of its catalog value: `^4.1.11` and `>=4.1.11`
meet the floor, `^4.1.10` does not, even where your lockfile resolved something newer, and a
value that is not a version (a dist-tag, an `npm:` alias, a URL) cannot be proven to meet
it, so it warns too. The key is found whether it is bare, single-quoted or double-quoted,
and a package you removed from the catalog is not judged.
### Your own workflows: `workflow-hardening` (a NOTE until 1.2.0)

Since 1.0.2 every workflow the harness ships selects bash at workflow level and gives every
job a ceiling, and every shipped job starts with harden-runner. Nothing checked a workflow
you wrote, and `harden-runner-coverage` only counts harden-runner lines per `.yml`
file: two in one job cover a neighbour with none, one placed after `checkout` passes, a
comment counts, and a `.yaml` file or a workflow indented by four spaces is never read.
From 1.1.0 the `workflow-hardening` job in `actions-lint.yml` runs
`node tools/check-workflow-hardening.mjs`, which holds every workflow in
`.github/workflows/` to three rules and names each finding `<file>` or `<file>#<job>`:

1. **A workflow-level bash default, above `jobs:`.** GitHub runs a step that names no shell
   as `bash -e`, without `pipefail`, so `producer | tee file` reports tee's status. Add this
   at the top level, before `jobs:`:

   ```
   defaults:
     run:
       shell: bash
   ```

   Write it as plain `bash`: GitHub adds `-eo pipefail` only to that spelling, so a custom
   command such as `bash -el {0}` is reported even where it sets `pipefail` itself. A
   workflow with no `run:` step needs none, and the one workflow that publishes OpenSSF
   Scorecard results must carry no top-level `defaults` or `env` instead.
2. **A ceiling on every job.** A whole number of `timeout-minutes` at job level, from 1 to
   360 on a GitHub-hosted runner and to 7200 on a self-hosted one: those are the platform's
   limits, and a job with no ceiling inherits 360. An expression is not read, so write the
   number. A job that calls a reusable workflow (`uses:` at job level) takes none.
3. **harden-runner first.** The first step of every job that is neither a reusable-workflow
   call nor on a `self-hosted` runner is `step-security/harden-runner`, pinned by SHA, as in
   every shipped workflow. When the job's `runs-on`, or a matrix value it reads, names
   windows, that step sets `egress-policy: audit`.

**Who sees it, and when.** If your `baseVersion` is below 1.1.0, each finding is a NOTE and
the job stays green:

```
workflow-hardening: NOTE — the workflow hardening rules over the project workflows (…) (ramp: live from baseVersion 1.1.0; this install's baseVersion is <yours>; expires in 1.2.0). …
workflow-hardening: NOTE — (ramp) .github/workflows/<file>#<job>: the first step uses actions/checkout@…, not step-security/harden-runner — …
```

From harness 1.2.0 the same findings print under `RAMP EXPIRED` and red the job, and on an
install whose `baseVersion` is 1.1.0 or later they red it from the start.

**The sweep.** Run `node tools/check-workflow-hardening.mjs` in your tree; it needs Node
only. Fix each finding it names as the rules above say, and run it again until it prints
`workflow-hardening: OK`. The check is not a chain step, so `graduate` does not run it:
run it by hand before you graduate. Because the job also runs when `.harness/manifest.json`
changes, a graduation that left a finding shows it on that pull request. The job is new, so
no branch-protection rule requires it until you add `workflow hardening (bash default, job
ceilings, harden-runner first)` to your required checks.

**If you forked `actions-lint.yml`.** `update` keeps your copy, parks the new one under
`.harness/pending/.github/workflows/actions-lint.yml` and exits 2 while it stays there.
Your fork has no `workflow-hardening` job until you merge it, so nothing runs the check in
CI; `node tools/check-workflow-hardening.mjs` still works locally.

### What OPENS: the SQL gates fold `DROP TABLE` and `ALTER POLICY` (NOTEs until 1.2.0)

Through 1.0.x the parser the SQL gates share read neither statement. A table your history
dropped kept its columns, indexes, triggers, RLS toggles, policies and grants in every view,
and lent them to a later table of the same name. A policy you rewrote with `ALTER POLICY`
was judged on its CREATE text, which the database no longer runs. `schema-rls` also read
`DROP POLICY` and ignored it, so a dropped policy still covered its operation. From 1.1.0
each gate reads the history as the database applies it:

- `DROP TABLE [IF EXISTS] a, b [CASCADE | RESTRICT]` removes each table, its partitions and
  everything on them, and clears the foreign keys that pointed at them. A later
  `CREATE TABLE` of the same name starts with nothing.
- `ALTER POLICY` replaces the `TO`, `USING` and `WITH CHECK` clauses it names and keeps the
  rest; `ALTER POLICY … RENAME TO` renames.
- `schema-rls` reports a `DROP TABLE` without `IF EXISTS`, or an `ALTER POLICY`, whose
  target no earlier migration left in place. `DROP TABLE IF EXISTS` on an unknown table is
  a no-op, as it is in the database.
- `migrations` treats `ALTER POLICY` as an authorization change: it needs an
  `-- adr: docs/adr/<file>` line naming an existing ADR, as `DROP POLICY` already did. A
  migration whose only `ALTER POLICY` statements are `RENAME TO` needs none.

A `DROP TABLE` inside a function body (`EXECUTE format('DROP TABLE …')`) is not a statement
of the history, so it folds nothing. The harness's own migrations hold neither statement at
the top level, so a scaffold that never wrote one sees no change.

**Who sees a NOTE.** An install whose `baseVersion` is below 1.1.0 and whose history holds
one of those statements, for each finding that only the new reading produces. The gates
are `schema-rls`, `tenancy`, `data-flow`, `db-limits` and `query-shapes`, each with one
ramp, and `migrations` for its `ALTER POLICY` rule:

```
schema-rls: NOTE — the SQL history fold (DROP TABLE, ALTER POLICY and DROP POLICY) (ramp: live from baseVersion 1.1.0; this install's baseVersion is <yours>; expires in 1.2.0). …
schema-rls: NOTE — (ramp) notes: policy notes_select_own has a vacuous USING (true) — it permits every row
migrations: NOTE — ALTER POLICY as an authorization change (ramp: live from baseVersion 1.1.0; …; expires in 1.2.0). …
migrations: NOTE — (ramp) supabase/migrations/<file>.sql: ALTER POLICY removes an authorization control — …
```

A finding the old reading also produced stays a hard failure, whatever your
`baseVersion`: the ramp covers only what the gates could not see before. A finding only
the old reading produced is gone, because it described a table or policy your history
dropped or rewrote. From harness 1.2.0 every NOTE above prints under `RAMP EXPIRED` and
reds its step, and on an install whose `baseVersion` is 1.1.0 or later they red from the
start. To tell the two kinds apart the gate replays itself over your history as 1.0.x read
it; that replay runs only when the history holds one of the statements and the gate found
something.

**The sweep, before 1.2.0.** Your migrations are append-only, so every fix goes in a NEW
migration:

1. **Fix what the fold exposes.** A re-created table needs its own `ENABLE` and `FORCE ROW
   LEVEL SECURITY`, its per-operation policies, its `GRANT`s and its owner-column index; a
   predicate an `ALTER POLICY` rewrote must match the reviewed forms `tenancy` names; a
   reviewed entry that named a dropped table (`untenantedTables` in `tools/tenancy.json`, a
   `tools/data-flow.json` row) is stale, so remove it. A new migration that rewrites a policy
   carries its `-- adr:` line.
2. **Acknowledge an `ALTER POLICY` that is already applied.** It cannot take an `-- adr:`
   line without editing a committed migration, which `migrations` refuses. Add the existing
   escape for it to `tools/migrations-allow.json`, one entry per file:

   ```
   { "file": "<migration basename>", "rule": "authz-adr", "reason": "<why applied history cannot be swept>" }
   ```

   The migration must exist at your diff base, and the entry reds once the finding is gone.
3. **A drop of a table made outside the migrations.** If an applied migration drops a table
   the dashboard or an extension created, `schema-rls` cannot place the drop. Record the
   table with a reason in `tools/rls-exempt.json`; nothing of a dropped table is left for
   the exemption to hide. The same holds for a drop of a table an `ALTER TABLE … RENAME TO`
   renamed: the gates do not follow a table rename, so the new name reads as never created.
   The entry exempts the NAME, so a table a later migration creates under it is exempt too:
   give a new table a new name.

The harness's upgrade lane has nothing to sweep here: `scripts/ci/upgrade-sweep.mjs`
`SWEEPS['1.1.0']` adds no step, because its scaffolds hold neither statement. Then
graduate as the section on graduating says.

**One case has no escape yet.** An applied `ALTER POLICY` of a policy the migrations never
created (one made in the dashboard) stays unresolved for `schema-rls`, and nothing
acknowledges it before the ramp expires. Report it; the release that owes this ramp's
expiry has to answer it.

### What OPENS: `schema-rls` bounds grants by policies and holds every table to the three-role revoke (a NOTE until 1.2.0)

Supabase's default privileges grant ALL on every new `public` table to `anon`,
`authenticated` and `service_role`, and a GRANT removes nothing. Until 1.0.2 the harness's
own migrations revoked the default from `anon` and `service_role` only, then granted four
verbs to `authenticated`, which kept TRUNCATE, REFERENCES, TRIGGER and (on PostgreSQL 17)
MAINTAIN. Row security does not apply to those four, so no policy narrows them. 1.0.2
closed that on the seven tables `authenticated` only reads; `profiles` and `notes`, the two
it writes, kept it. And `schema-rls` only ever checked that a policy had a grant behind it,
never that a grant had a policy behind it, so nothing found any of it. From 1.1.0
(`docs/adr/20260930-three-role-revoke.md`) `schema-rls` reds three things:

1. **A grant wider than the table's policies.** Every privilege `anon` or `authenticated`
   holds, counting the platform default, a grant to `PUBLIC` and column grants, needs a
   PERMISSIVE policy for that operation (or `ALL`) naming the role, `public` or no role,
   whose predicate is not literally `false`. TRUNCATE, REFERENCES, TRIGGER and MAINTAIN are
   never admitted: revoke them.
2. **A table that keeps the platform default** for any of the three roles: the doctrine is
   `REVOKE ALL` from all three, then the exact grants. This is what makes the privileges the
   same on every database, including a project created on or after 2026-10-30, which gets
   no default at all.
3. **A missing or stale `supabase/tests/rls_grants.generated.test.sql`**, the pgTAP
   assertion of the exact privileges every table's three roles hold. It is generated from
   your migrations by `node tools/gen-grant-assertions.mjs` and never edited by hand.

Each finding prints the `REVOKE` and `GRANT` statements that clear it.

**Who sees a NOTE.** Every install whose `baseVersion` is below 1.1.0, because its
`profiles` and `notes` predate the doctrine:

```
schema-rls: NOTE — the grant bound, the three-role revoke doctrine and the generated grant assertions (ramp: live from baseVersion 1.1.0; this install's baseVersion is <yours>; expires in 1.2.0). …
schema-rls: NOTE — (ramp) notes: `authenticated` holds TRUNCATE, REFERENCES, TRIGGER, MAINTAIN on public.notes, which no policy admits — … Clear it in a NEW migration: REVOKE ALL ON TABLE public.notes FROM authenticated; GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notes TO authenticated; …
schema-rls: NOTE — (ramp) notes: the platform default still reaches `authenticated` — … Clear it in a NEW migration: REVOKE ALL ON TABLE public.notes FROM authenticated; GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notes TO authenticated; …
```

From harness 1.2.0 they print under `RAMP EXPIRED` and red the step, and on an install
whose `baseVersion` is 1.1.0 or later they red from the start. `graduate` refuses while one
stands.

**The sweep: the SQL first, then the generator.** A fresh scaffold gets
`supabase/migrations/20260930000000_three_role_revoke.sql` and the generated test.
**`update` plants neither**: `supabase/migrations/` is your applied history, and a file
with the harness's timestamp could sort ahead of migrations you have already applied; the
harness's generated test describes the harness's tables, not yours.

1. Create a migration of your own:

   ```
   supabase migration new three_role_revoke
   ```

   and put in it the statements your findings print. For the two tables the harness
   shipped, keeping the four verbs their policies admit, that is:

   ```sql
   -- adr: docs/adr/20260930-three-role-revoke.md
   -- SOURCE: https://www.postgresql.org/docs/17/ddl-priv.html
   REVOKE ALL ON TABLE public.profiles FROM authenticated;
   REVOKE ALL ON TABLE public.notes FROM authenticated;

   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;
   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notes TO authenticated;
   ```

   If you never applied 1.0.2's migration, add its SQL for the seven read-only tables (the
   1.0.2 section above). For a table of your own, add the lines its findings print, or
   run `node tools/gen-grant-assertions.mjs`: while any table fails the doctrine it
   refuses, names the tables and prints every statement your tree needs at once. The
   `-- adr:` line is required, because your `migrations` gate treats a `REVOKE … FROM
   authenticated` as a change to an authorization control; the ADR is the one this update
   plants. Then `pnpm db:reset && pnpm db:test`.
2. Generate the assertion and commit it:

   ```
   node tools/gen-grant-assertions.mjs
   git add supabase/tests/rls_grants.generated.test.sql
   ```

   It reads `[db].major_version` from `supabase/config.toml`: eight table privileges on
   PostgreSQL 17, seven on 15 and 16. Run it again after every grant change; `schema-rls`
   reds a stale copy. `pnpm db:test` then runs it against your local stack.
3. **A privilege you mean to keep that no policy admits** (a TRIGGER an owner-side process
   needs, say) goes in `tools/grant-bound-allow.json`, one row per table, role and
   privilege, with a reason. The file is write-guarded like the other allow lists, and a row
   naming a privilege nobody holds reds:

   ```json
   { "allow": [{ "table": "<table>", "role": "authenticated", "privilege": "TRIGGER", "reason": "<why>" }] }
   ```

Three seeded texts are yours to copy. `package.json` gains the generator in `pnpm gen`:

```json
"gen": "… && pnpm gen:routes && pnpm gen:grants",
"gen:grants": "node tools/gen-grant-assertions.mjs",
```

`AGENTS.md`'s RLS bullet gains, after "(a GRANT removes nothing; the default leaves it
TRUNCATE).":

> `pnpm gen` regenerates the exact-privilege pgTAP file, never a hand edit.

And `supabase/AGENTS.md`'s grant bullet ends:

> That revoke needs an `-- adr:` marker (the `migrations` gate). Then `pnpm gen` (or
> `node tools/gen-grant-assertions.mjs`) regenerates `tests/rls_grants.generated.test.sql`,
> the exact privileges of every table; never edit its rows or its `plan()` by hand.

The schema files `supabase/schemas/10_account.sql` and `20_notes.sql` gained the same
`REVOKE ALL … FROM authenticated` line in a fresh scaffold; add it to yours so the
declarative schema matches the history. The hand-written assertions in
`rls_structure.test.sql` stay: they state intent (the `service_role` allowlist, the seat and
quota shapes) that a file generated from the migrations cannot.

The harness's upgrade lane runs exactly these two steps on its swept leg
(`scripts/ci/upgrade-sweep.mjs` `SWEEPS['1.1.0']`): the statements the gate prints, in a
migration of the leg's own, then the generator. It copies neither withheld file.

### A DAL that calls `rpc()` or `upsert()`: regenerate the query-shape manifest

Through 1.0.4 neither call could pass `query-shapes`. The recording port that `pnpm gen`
drives each probed DAL function with had no `rpc()`, so generation threw on a function that
called it, and an upsert recorded as a read whose `extra` named `.upsert()`, which the gate
failed with advice about OFFSET pagination. Both are now recorded as their own kind of row.
`tools/generated/query-shapes.json` is seeded, so `update` does not rewrite it. If a probed
DAL function of yours makes either call:

1. Run `pnpm gen`, or `pnpm gen:contracts`, the part of it that needs no database.
2. Run `node tools/check-query-shapes.mjs`, and fix what it names (below).
3. Commit `tools/generated/query-shapes.json`. Only the rows of rpc and upsert calls change;
   every other row keeps its bytes.

What the gate now checks, and the fix for each red:

- **`calls rpc public.<name>, which no migration creates`.** No file in
  `supabase/migrations/` creates that function in `public`, the one schema PostgREST
  exposes, so the call would get PGRST202. Create it there, or call a name a migration
  creates.
- **`without its required parameter(s) …` or `names …, which public.<name> has no input
  parameter called`.** Pass every input parameter that has no DEFAULT, under its declared
  name, and no other. An OUT parameter is a result, not an argument.
- **`upsert into public.<table> ON CONFLICT (…) — no UNIQUE index or primary key …`.** Put
  the exact columns of a UNIQUE index or of the primary key in `onConflict`, in any order,
  or add the index in a new migration; the finding lists the ones the table holds. On a
  tenant table the index carries the tenant column, because `tenancy` reds a UNIQUE there
  that omits it, so the conflict target names it too. With no `onConflict` the target is
  the primary key, so the table needs one.
- **`upsert into tenant table "<table>" writes no <tenant column>`.** Write the tenant column
  in the payload, as an insert does.

The gate reads migrations, not a database, and it does not model `DROP FUNCTION` or
overloads (the last definition of a name wins), reads a partial UNIQUE index as an arbiter,
and does not judge the arguments of a function with an unnamed input parameter. If you
edited one of the owned files this item re-plants, your copy stays, the new one is parked
under `.harness/pending/`, and `update` exits 2 while it stays there.

### The i18n syntax-tree walk: `tools/i18n-allow.json` keys, not lines

`tools/check-i18n.mjs` now walks the TypeScript syntax tree of every file it scans, with
the `typescript` your root `package.json` has listed since the first release, beside the
regular expressions it has always run, and it reports both. Two ramps open at 1.1.0 and
expire in 1.2.0; on a `baseVersion` of 1.1.0 or later, and on a fresh scaffold, both are
already hard.

**Strings only the walk finds.** A string inside `{…}` (`title={'Settings'}`), a template
literal with no `${…}` (`` label: `Home` ``), a double-quoted object value in a `.ts`
module, and JSX text holding `=`, `;`, a backtick or `$` were never matched before. Below
1.1.0 each prints as `i18n: NOTE — <file>:<line>: hardcoded user-facing string …`, under
one ramp NOTE naming `copy only the syntax-tree walk finds`. Move each into your catalog
and render it through `t('<key>')`, as the line says, or, for a string no human reads, add
the `{"key": …, "reason": …}` entry the line prints to `tools/i18n-allow.json`.

**`site` entries become keys.** A 1.0.x entry `{"site": "file:line", "reason": …}` mutes
whatever sits on that line, and a line inserted above the string moves it onto something
else. A key is 12 hex characters hashed from the file's path, the finding's kind, its
attribute or property name and its text, so it stays on its string. Below 1.1.0 the step
still honours a `site` entry and prints its replacement:

```
i18n: NOTE — tools/i18n-allow.json: {"site": "apps/mobile/src/Brand.tsx:12"} mutes this line until 1.2.0; replace it with {"key": "6d2720cab99b", "reason": "a brand name"}, which stays on the string when the line moves
```

Replace each `site` entry with the entry its NOTE prints, keeping your reason. A `site`
entry whose NOTE says it matches no finding is stale: delete it. The file is
write-guarded, so a human makes the edit and commits it, or reviews and applies an agent's
`harness-proposals/<id>.json` for it (the subsection on proposals above). Run
`node tools/check-i18n.mjs` again: once no `site` entry is left and no NOTE names the walk,
graduating turns nothing of either ramp red. `graduate` runs `validate`, and this is a Stop
step, so run it yourself before you graduate. A key that matches no finding reds, as a
stale `site` entry never did.

**What `update` leaves alone.** `tools/i18n-allow.json` is seeded, so your copy and its
comment stay as they are; only a fresh scaffold gets the comment that describes keys. The
shipped allowlist is empty, and no release's own scaffold holds a string only the walk
finds, so an install that never edited its copy or its screens' copy sees nothing new.

**If `typescript` is not installed.** The step prints
`i18n: NOTE — the syntax-tree walk did not run: …`, judges with the regular expressions
alone, and cannot tell whether a key that matches none of their findings is stale. Run
`pnpm install`. In CI, where the quality gate installs before it runs the step, a walk that
did not run is a failure.

### The web app compiles in the chain, and each web route needs a browser spec (NOTEs until 1.2.0)

Through 1.0.x nothing in your chain compiled the web app: `types` typechecks and does not
bundle, and `build` is the mobile export. A Client Component that imports a server-only
module, or an import only the bundler cannot resolve, passed the whole chain and `static`,
and only the path-filtered `web-build` job ran `next build`. The new step, `web-compile`
(`node tools/check-web-build.mjs`), runs `pnpm --filter web exec next build --webpack` when
its inputs changed and prints `STAMPED` when they did not; CI never uses the stamp.

**What it needs.** `node_modules` and `apps/web`: without either it skips loudly on your
machine and fails in CI, like every toolchain step. It runs after `types`, whose `tsc -b`
writes the declarations Next's type check reads; run on its own on a fresh clone it fails
with TS6305 and prints `pnpm exec tsc -b . apps/web apps/mobile`, which is the fix. Your
environment is used as it is. For each Supabase key the build needs that you have not set
and no `apps/web/.env*` file defines, it uses the placeholder your `web-build` job builds
with and prints which keys it filled, so a scaffold with no local stack compiles. It
restores the committed `apps/web/next-env.d.ts` that `next build` rewrites, so the build
leaves your tree clean.

**If your web app does not compile.** On an install whose `baseVersion` is below 1.1.0 the
step prints `web-compile: NOTE — the web compile step (next build over apps/web)` with
`expires in 1.2.0`, followed by the build's output, and passes. It records no stamp, so the
NOTE comes back on every run, and `graduate` refuses, until the build is green. Reproduce it
with `node tools/check-web-build.mjs` and fix what Next reports.

**Each registered web route needs a spec that renders it.** `route-manifest` now also asks,
for every route in `apps/web/lib/routes.generated.ts`, that some `*.spec.ts` under
`apps/web/e2e` names one of the route's declared state test ids as a quoted string, outside
a comment. A fresh scaffold ships `apps/web/e2e/notes.spec.ts` and
`apps/web/e2e/security.spec.ts` for the two seeded routes that had none; `update` does not
plant them, so your install has a spec for `orgs` only. Below `baseVersion` 1.1.0 the
finding is a NOTE, `route-manifest: NOTE — the per-route browser closure (…)`, naming each
route, its path and its state test ids. Copy the two specs from the harness's
`template/stack/apps/web/e2e/` if your `notes` and `security` routes are the seeded ones,
or write a spec per route that signs in, visits it and asserts one of its ids with
`page.getByTestId('<id>')`. Each seeded spec mints its own user through
`SUPABASE_SERVICE_ROLE_KEY`, as `authenticated.spec.ts` does, so it runs in the `web-e2e`
job with no new setup. A route that is chrome rather than content belongs in
`tools/web-route-allowlist.json` instead.

**Your `AGENTS.md` gate list.** Add `web-compile` after `build` and change 36 to 37 in both
places (the "What re-OPENS" part above).

**If you edited an owned file.** Your copy of `tools/check-web-routes.mjs`,
`tools/check-docs-sync.mjs`, `tools/lib/stamp-inputs.mjs` or `quality-gate.yml` is kept,
the new one is parked under `.harness/pending/`, and `update` exits 2 while it stays there.
Until you merge a parked `tools/lib/stamp-inputs.mjs`, your copy has no list for
`web-compile`, so the step builds on every run and records no stamp.

### Edge Functions: pull the handler split, `deno.json` and `deno.lock` (NOTEs until 1.2.0)

Through 1.0.x no check compiled, linted, ran or mutated `supabase/functions`: a global lint
ignore covered it, `tsc -b` never reached it, and vitest, coverage and Stryker cannot import
a file that imports a `jsr:` specifier and starts a server as it loads. 1.1.0 reaches it four
ways. `lint` gives it the TypeScript parser, so `no-unverified-session`,
`crypto-primitives-one-door`, cognitive complexity 15 and `no-suppressed-complexity` apply.
`unit` runs every vitest suite under it (a `*.test.ts` importing from `'vitest'`; a
`deno test` file is left alone) and measures each function directory that holds one, and
`diff-coverage` holds a changed file there to the per-file floors. The mutation floor gains
`supabase/functions/*/`, each `index.ts` excepted. The new `edge-functions` job in
`quality-gate.yml` installs deno and runs `node tools/check-edge-functions.mjs`, which runs
`deno check --frozen` on each `supabase/functions/<fn>/index.ts` against that function's
`deno.json` (exact `jsr:`/`npm:` versions) and `deno.lock`.

The seeded delete-account function is split so those checks reach what it decides:
`handler.ts` holds `readKey` and the four deletion steps and takes its clients and
environment as parameters, `handler.test.ts` proves the personal-org sweep is verified before
`deleteUser`, `index.ts` becomes a one-call `Deno.serve` shell, and `deno.json` and
`deno.lock` pin supabase-js to one release. `index.ts` is seeded, so `update` never rewrites
yours, and the four new files are withheld.

**Who sees what, and when.** On an install whose `baseVersion` is below 1.1.0:

- `lint` stays green on the 1.0.x `index.ts`: its `readKey` measures 16, and that one path is
  exempt from the complexity rules until 1.2.0. The security rules are not exempt; the
  seeded file passes both. A function of YOUR OWN that calls `getSession()`, reaches
  `crypto.subtle`, or measures over 15 reds `lint` now.
- `edge-functions` prints `edge-functions: NOTE — (ramp) supabase/functions/<fn>: no
  deno.json` (and `no deno.lock`) for each function, and stays green.
- `diff-coverage` prints `diff-coverage: NOTE — (ramp) supabase/functions/…: absent from every
  coverage map` for a changed file in a function directory that holds no vitest suite.
- The mutation lane's scoper withholds such a file from Stryker with a
  `mutation-scope: NOTE — (ramp) …` line, and the ratchet NOTEs a new survivor under
  `supabase/functions/` in a directory that has a suite.

From harness 1.2.0 all of it prints under `RAMP EXPIRED` and reds, and the lint exemption is
gone. On an install whose `baseVersion` is 1.1.0 or later it reds from the start.

**The sweep.**

1. Pull the split: `npx next-expo-supabase-agent-harness@latest update --refresh-seeded
   supabase/functions/delete-account/`. An `index.ts` you never changed is replaced; one you
   changed stays, the new one is parked under `.harness/pending/`, and you carry your change
   into `handler.ts` by hand. Then `pnpm exec vitest run supabase/functions` runs the suite,
   and `doctor` stops warning.
2. For each function of your own, move what it decides into a file that names no `Deno`
   global and no `jsr:`/`npm:` specifier (a type-only import is fine) and give that
   directory a vitest suite; keep `index.ts` a shell. Code in `_shared/` needs a suite in
   `_shared/`.
3. Give each function a `deno.json` whose imports name exact releases, and write its lock:
   `deno check --frozen=false --config supabase/functions/<fn>/deno.json
   supabase/functions/<fn>/index.ts`. Commit both. Supabase deploys each function with its
   own `deno.json`.
4. With deno installed (the version `quality-gate.yml`'s `edge-functions` job pins), run
   `node tools/check-edge-functions.mjs` until it prints `edge-functions: OK`. It is not a
   chain step, so `graduate` does not run it: run it by hand before you graduate. The job is
   new, so no branch-protection rule requires it until you add `edge functions (deno check
   against deno.json + frozen deno.lock)` to your required checks; `gate-summary` already
   waits for it.

The harness's upgrade lane adopts the whole split on every swept leg (the fix's paths ride
the derived pass), and `SWEEPS['1.1.0']` adds no step.

**If you forked `eslint.config.mjs`, `vitest.config.ts` or `quality-gate.yml`.** `update`
keeps your copy, parks the new one under `.harness/pending/` and exits 2 while it stays
there, and your fork does not reach `supabase/functions` until you merge it.
### An uncommitted escape list must be one a release planted (`gate-integrity`, a NOTE until 1.2.0)

**What changed.** `gate-integrity` reds an escape list (the files in
`tools/lib/enforcement-surface.mjs` `ESCAPE_LISTS`) that is modified but not committed. Its
one exemption is a list the harness itself just planted, which `init` and `update` leave
untracked. Until 1.1.0 that exemption asked two questions: is the file untracked, and does
its sha256 match its `.harness/manifest.json` record? Since 1.0.2 you may re-record a sha
yourself to keep a fork (the 1.0.2 section, "Forking an owned file"), and the manifest does
not have to be committed, so a record alone no longer says who wrote the bytes. The gate
now asks a third question: did a harness release plant exactly these bytes? The answer is
in `tools/lib/planted-shas.json`, a new owned file that `update` plants and `gate-integrity`
hash-pins like every owned `tools/` file. It is generated from the harness's released-sha
tables, which never reach an install; never edit it. A list that carries a placeholder,
such as `tools/rls-exempt.json` with your `SECURITY_OWNERS`, is compared after the tokens
are put back from your manifest's answers (`tools/lib/derender.mjs`, also new and owned).

**What you see.** The escape lists `update` plants on this hop are explained by the file
the same `update` delivers, so the hop adds no finding: each prints the plant NOTE until
you commit it. An untracked escape list that matches its record but no release variant
prints, on an install whose `baseVersion` is below 1.1.0:

```
gate-integrity: NOTE — (ramp 1.1.0) <path>: escape hatch present but not committed, and no harness release planted these bytes. …
```

From harness 1.2.0, or once you graduate to 1.1.0, it is a failure. Everything that failed
before still fails with the same text: a tracked list that is modified, an untracked one
with no record, and an untracked one whose sha differs from its record.

**What to do.** Review each list the NOTE names. If you meant the entries, commit the file,
so the change is in a pull request diff under CODEOWNERS; if you did not, delete the file
(or restore it from git) and remove the record you wrote for it. `graduate` refuses while a
NOTE stands. With `HARNESS_ALLOW_SELF_EDIT=1` set, the commit rule does not run at all, as
before.

**What is unchanged.** The threshold-config rule beside it (`vitest.config.ts`,
`eslint.config.mjs` and the other configs that carry numbers) still treats a dirty config
whose sha matches its record as a harness refresh. If you forked
`tools/check-gate-integrity.mjs`, your copy is kept, the new one is parked under
`.harness/pending/`, and `update` exits 2 while it stays there; your copy never reads
`tools/lib/planted-shas.json`.

## 2.0.0 — the opt-in release: the 1.1.0 notes fall due

**If your `baseVersion` is 1.1.0 or later, nothing expires for you.** Every ramp 1.1.0 opened
carries `minVersion 1.1.0`, so none of them has ever been live on your install. What the
version bump itself brings a 1.1.0 install is the uuid arrival NOTE below; each change a later
2.0.0 item makes has its own part of this section. Read what applies to YOUR `baseVersion`
off `node scripts/ci/ramp-expectations.mjs <your base> 2.0.0` in a harness checkout, and off
`pnpm validate 2>&1 | grep -E 'NOTE — \(ramp\)|RAMP EXPIRED'` in your own tree, never off
this page.

**If your `baseVersion` is below 1.1.0, this is where the 1.1.0 sweep stops being
optional.** 1.2.0 is never cut: this lineage goes from 1.1.0 to 2.0.0 directly, and every
comparison is `>=`, so each deadline dated 1.2.0 arrives here. The 1.1.0 section above is the
sweep, and nothing in it changed. If you are more than one release behind, read the sections
above in order before crossing this one.

### Expect `version-sync` to red on the `next` floor, whatever your `baseVersion`

This one is not a ramp, and no `baseVersion` is exempt from it. The `next` floor on the 16
line moves from 16.3.3 to **16.3.6**, for
[GHSA-vcvr-r3jv-pc5j](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j)
(CVE-2026-94545, Critical): remote code execution in the Node.js `ImageResponse` of
`next/og` when an app passes attacker-controlled values into the SVG content, attributes or
styles it renders. It affects 16.2.0 up to but not including 16.3.6, so it covers 16.3.5, the
pin every release from 1.0.2 to 1.1.0 shipped. The 15 line is outside its range, and its
floor stays **15.5.24**.

`tools/framework-floor.json` is harness-owned, so `update` refreshes it. `pnpm-workspace.yaml`
is seeded, so `update` does not touch your pins, and the first `pnpm validate` after the
upgrade reds `version-sync` on a `next` pin below 16.3.6, naming the pin, the floor and the
advisory. Raise the pin yourself:

```
# in the pnpm-workspace.yaml catalog: next: 16.3.6
pnpm install && git add pnpm-lock.yaml pnpm-workspace.yaml
pnpm validate
```

From 16.3.5 this is a patch on the same minor. The scaffold imports nothing from `next/og`, so
a tree that never added an `ImageResponse` route was not exposed through one, and the floor
moves anyway, because an Open Graph image route is one import away. Until you can raise the
pin, the advisory's workaround is to keep attacker-controlled values out of everything the
Node.js `ImageResponse` renders; the Edge `ImageResponse` is not affected. No flag lowers the
floor. Do not use `update --refresh-seeded pnpm-workspace.yaml` to take the pin: it replaces
your whole catalog with the template's.

### What ARRIVES (hard) — for installs below 1.1.0

Eighteen of the ramp sites 1.1.0 opened, across fifteen gates. Each finding that printed as
`NOTE — (ramp)` with `expires in 1.2.0` now prints under a `RAMP EXPIRED` banner and reds its
step. Each 1.1.0 subsection named here says what to do:

1. **The SQL history fold**, in `data-flow`, `db-limits`, `query-shapes`, `tenancy` and
   `schema-rls`, and `migrations`' rule that an `ALTER POLICY` is an authorization change
   ("What OPENS: the SQL gates fold `DROP TABLE` and `ALTER POLICY`"). Fix what the fold
   exposes in a NEW migration, or add a `tools/migrations-allow.json` `authz-adr` entry for
   an `ALTER POLICY` you already applied.
2. **`schema-rls`' grant bound**, its three-role revoke doctrine and the generated grant
   assertions ("What OPENS: `schema-rls` bounds grants by policies…"). The subsection's SQL
   goes in a NEW migration, then `node tools/gen-grant-assertions.mjs`.
3. **`docs-sync`, three sites**: the reviewer severity contract and the verdict-demand
   position of a reviewer body you forked ("Reviewer bodies state which severities block…"
   and "A reviewer body must close on its verdict demand"), and the `AGENTS.md` gate list
   ("What re-OPENS" in the 1.1.0 section: paste the 37 names the finding prints).
4. **The Edge Function surface**, in `diff-coverage`, `edge-functions`, `mutation-ratchet`
   and `mutation-scope` ("Edge Functions: pull the handler split…").
5. **`gate-integrity`'s planted escape list** ("An uncommitted escape list must be one a
   release planted"): commit each escape list the finding names after reviewing it, or delete
   one nobody meant to create.
6. **`web-compile`** and **`route-manifest`'s per-route browser closure** ("The web app
   compiles in the chain, and each web route needs a browser spec").
7. **`workflow-hardening`** over your own workflows ("Your own workflows:
   `workflow-hardening`").

`workflow-hardening`, `edge-functions`, `mutation-ratchet` and `mutation-scope` run only in
CI and `diff-coverage` is a Stop step, so `pnpm validate` does not show them: run each by hand
before you graduate, as the 1.1.0 subsections say. `scripts/ci/upgrade-sweep.mjs`
`SWEEPS['1.1.0']` is what the upgrade lane's swept leg runs before it requires `graduate` to
succeed; `SWEEPS['2.0.0']` adds no step for these sites (it says why).

### What RETIRES with them — on every install

Two of the 1.1.0 ramps existed only to carry something to this release, and both things go
now, whatever your `baseVersion`.

**The `i18n` gate's regular expressions and the `site` entry.** Through 1.1.x the gate ran
its 1.0.x regular expressions beside the syntax-tree walk and reported both. From 2.0.0 the
walk is the only scan:

- A `{"site": "file:line", …}` entry in `tools/i18n-allow.json` is malformed on every install
  and fails the step closed. Delete it; the FAIL line of the string it muted prints the
  `{"key": …}` entry that replaces it, ready to paste.
- A string only the regular expressions reported (for example `title = "…"` as a plain
  assignment in a `.ts` module) no longer reds. A `key` entry you added for one now matches no
  finding and reds as stale: delete it.
- Without `typescript` installed, the copy and `Intl`-boundary checks cannot run. Locally the
  step says so in a NOTE; in CI it fails. Run `pnpm install`.

**The `lint` exemption for `supabase/functions/delete-account/index.ts`.** 1.1.0 kept that
seeded file out of the Edge Function complexity block for one release, because the copy every
1.0.x install carries measures 16. If `update` printed a `SEEDED SOURCE FIX` naming `lint` and
you have not acted on it, `lint` now reds on that file. Pull the split:

```
update --refresh-seeded supabase/functions/delete-account/
git add supabase/functions/delete-account/
```

That replaces the whole directory, so read the diff first if you edited it. A fresh 1.1.0 or
later scaffold already has the split.

### What moves to 2.1.0 (a dated NOTE)

**`version-sync`'s uuid arrival, a fifth time.** The harness re-reviewed its own uuid 7
acceptance at this release and moved its `removalTarget` from 1.2.0 to 2.1.0: `xcode` 3.0.1
still declares `uuid: ^7.0.3`, `@expo/config-plugins` still depends on that `xcode`, and a
registry sweep of a fresh scaffold still finds uuid@7.0.3 in the production closure. Your
seeded `tools/eol.json` still says `"removalTarget": "1.2.0"` on a 1.1.0 install, or an older
date on an older one, and that date has arrived. `update` parks the re-affirmation under
`.harness/pending/source-fixes.json`, and `version-sync` prints the arrival as
`NOTE — (ramp)` with `expires in 2.1.0`. The remedy is the 1.1.0 section's, one date on:
re-affirm the row under a release you mean, or, if you never edited the file,
`update --refresh-seeded tools/eol.json` and read the diff before you commit it.
`graduate` refuses while this NOTE stands.

**`reviewer-verdicts`' round budget.** It stays a NOTE until 2.1.0 on an install below 1.1.0,
where it was dated 1.2.0. It counts rounds over the reviewer ledger v2's change set and closes
a loop by v2's rule, and v2 itself stays a NOTE there until 2.1.0, so the budget waits for it.
Nothing to do; the NOTE now names 2.1.0.

**The Supabase CLI census.** `auth-posture`'s deferred ask-the-CLI check moved from 1.2.0 to
2.1.0: supabase/cli#5894 is still open, and the CLI still documents `config push` as its only
`config` subcommand. Nothing to do.

### What `update` plants, and what else moved

Owned files, re-planted when your copy still matches a released sha: the hooks under
`.claude/hooks/` (their version stamps), this runbook, `tools/check-version-sync.mjs` (the
re-opened arrival ramp), `tools/check-reviewer-verdicts.mjs` (the round budget's date),
`tools/check-i18n.mjs` and `tools/lib/i18n-tree.mjs` (the retired regular expressions),
`eslint.config.mjs` (the retired exemption), `tools/deferrals.json`, `tools/auth-posture.json`,
`tools/check-auth-posture.mjs` and `docs/harness/gates-catalog.md` (the census date and the
sentences that called the 1.1.0 ramps open), and `tools/framework-floor.json` (the `next`
floor above). The seeded `tools/eol.json`, `tools/i18n-allow.json` and `pnpm-workspace.yaml`
change for fresh scaffolds only: the first reaches you through the parked fix above, the
second changes only its comment, and the third carries the `next` pin you raise yourself.

### The full encryption rule ships with the `e2ee` module

`.claude/rules/e2ee.md`, the full encryption rule, moved from the base template into the
`e2ee` module: the same text, the same install path and the same `paths:` scoping, so it loads
exactly as before wherever it is installed. What changes is which installs carry it. The
always-loaded `.claude/rules/encryption.md` stays in every install, and it now says that
`enable e2ee` installs the full rule.

- **An install without `e2ee`:** `update` deletes `.claude/rules/e2ee.md` when it holds the
  bytes a release shipped, and prunes its record. `enable e2ee` brings it back.
- **An install with `e2ee`:** `update` deletes the old copy and plants the module's straight
  back, recorded as the module's (`module: "e2ee"`), so `disable e2ee` removes it from now on.
- **A kept fork.** If you edited the file, or re-recorded its sha to keep an edit, `update`
  leaves it in place with a note ending "remove it manually".
  - Without `e2ee`: delete it, or keep it as your own rule. Nothing re-plants or removes it.
  - With `e2ee`: ignore the note's "remove it manually", because the module ships this rule.
    If `update` parked a copy under `.harness/pending/.claude/rules/e2ee.md` (it does when the
    rule changed after your version), merge it into your file. Your record keeps no module
    attribution, so `disable e2ee` leaves the file in place: delete it yourself if you disable
    the module.

Owned files re-planted when your copy still matches a released sha: the stub,
`docs/harness/README.md` and `tools/conformance-map.json` (five notes that named the full rule
as if every install had it; its two generated documents do not quote notes and are
unchanged), and, on an `e2ee` install, `docs/modules/e2ee/README.md`, which lists the rule
among the files the module adds.

### The worked example leaves the default scaffold: `init --with-demo` and `eject`

From 2.0.0 a fresh `init` writes no worked example: no `@app/notes` vertical, no notes or
matrix screens, no notes route or Server Action, and none of the example's migrations. The
shared files the example used to change (the API router, the home tab, the command palette,
the root `package.json`) and the seeded registers carry only the platform's rows, and the
gates that judged the example's rows accept a tree without them. `init --with-demo` writes the
example as before and records `"demo": true` in `.harness/manifest.json`; a default `init`
records `"demo": false`.

**Your install keeps its example, and nothing is yours to do.** Its files are seeded, so
`update` neither rewrites nor deletes them. Your manifest records no demo choice, so `update`
plans the default template for you and never hands you a file of the example's: the owned
files it re-plants are the default ones, and they are green on an install that still has the
example (the upgrade lane proves it on a 1.1.0 install). Two owned files moved into the
example, `maestro/flows/matrix.yaml` and `maestro/journeys/mutation.yaml`: yours stay where
they are, at the bytes you have, and `update` no longer touches them. The new
`maestro/journeys/session.yaml` is planted beside them, and the device lane runs every
journey in that directory.

One owned change needs a line from you if your install was created before 1.1.0:
`tools/gen-event-catalog.mjs` no longer reads the example's events by name ("The event
catalog: a vertical opts in from its `./client`" in the 1.1.0 section). If your
`packages/verticals/notes/src/client.ts` does not export `EVENT_CATALOG`, add the line that
section shows and run `pnpm gen:contracts`; until you do, `contracts` reds on the example's
three rows. `tools/generated/event-catalog.json` is seeded from 2.0.0 (and write-guarded), so
`update` no longer re-plants it: your catalog is yours to regenerate.

**`eject` removes the example from an install made with `init --with-demo`:**

```
node <harness checkout>/installer/cli.mjs eject --dir . --dry-run   # what it would remove
node <harness checkout>/installer/cli.mjs eject --dir .
pnpm install
git add -A && git commit -m "chore: eject the worked example"
pnpm validate
```

Commit before you validate: `eject` rewrites registers that `gate-integrity` holds to a
commit, so a `pnpm validate` before the commit fails on each of them. In the pull request,
`migrations` judges the deletions against its base. It deletes each of the example's files that still holds the bytes it was
installed with, gives each shared file it replaced the default install's bytes back, and
deletes the register rows `template/demo-index.json` lists where they still equal the rows
the example shipped. A file you changed is kept and reported; a shared file you changed keeps
your bytes, and the default copy parks under `.harness/pending/` for you to merge; a register
row you changed is kept. Each migration it deletes is recorded with its sha256 under
`ejectedMigrations` in the manifest, and `migrations` accepts the deletion of exactly those
bytes with a NOTE per file. It still reds any other deleted or edited migration.

**A database that applied the example's migrations keeps its tables.** `eject` deletes the
files, not the schema, so a fresh `supabase db reset` no longer creates `public.notes`, but a
database you keep (staging, production) still has it, with its triggers and policies. If you
want it gone there, write a NEW migration, with an `-- adr:` comment as `migrations` requires
for a `DROP TABLE`. First re-create `public.reconcile_org_usage()` with the body
`supabase/migrations/20260203000000_quota.sql` gives it, because the example's rails
migration replaced that function with one that counts notes. Then
`DROP TABLE IF EXISTS public.notes CASCADE`. `IF EXISTS` keeps the migration valid on a fresh
database, where the table never existed.

**An install created before 2.0.0 cannot `eject`.** It records no demo choice, and `eject`
refuses it and exits non-zero. Its spine migrations (`…_audit.sql`, `…_quota.sql`,
`…_mfa_aal2.sql`) attach the rails to `public.notes` themselves, so deleting the example's
migrations would break a fresh database, and editing the spine would break append-only
history. To remove the example by hand:

1. Write the NEW migration described above, so the table goes in history rather than by
   deleting the migrations that made it.
2. Delete the example's code: `packages/verticals/notes/`, `packages/api/src/routers/notes.ts`,
   `apps/web/app/(protected)/o/[orgSlug]/notes/`, `apps/web/app/actions/notes.ts`,
   `apps/web/lib/app-data/notes.ts` and `notes-model.ts`, `apps/mobile/src/features/notes/`
   and `matrix/`, `apps/mobile/app/(tabs)/matrix.tsx`, their tests and specs,
   `supabase/schemas/20_notes.sql`, and the two Maestro files above. Remove `@app/notes`
   from every `package.json` that lists it, and the notes router from
   `packages/api/src/index.ts`.
3. Run `pnpm install`, `pnpm gen`, then `pnpm validate`, and remove each row the chain names.
   In a harness checkout of 2.0.0, `template/demo-index.json` lists every register row the
   example adds, and the default tree's copy of each register is what it should come back to.
4. Record `"demo": false` in `.harness/manifest.json`, as a reviewed human commit. Until you
   do, `boundaries` reads the `@app/notes` row of `tools/exports-walls.json` as live and reds
   it as stale once the package is gone.

Owned files re-planted when your copy still matches a released sha: `eslint.config.mjs`,
`knip.json`, `vitest.config.ts` and `tsconfig.json` (no path of the example's), the gates
that now accept a tree without it (`tools/check-rls-manifest.mjs`, `check-query-shapes.mjs`,
`check-db-perf.mjs`, `check-rate-limits.mjs`, `check-perf-budget.mjs`,
`check-exports-walls.mjs`, `check-diff-coverage.mjs`, `check-migrations.mjs`,
`gen-event-catalog.mjs` and `tools/lib/event-catalogs.mjs`), `tools/conformance-map.json`
and `docs/security/threat-model.md`, the guard rules, `.github/workflows/quality-gate.yml`
(its `db-scale` adoption step stands down when the query-shape manifest holds no shape),
`tools/ci/device-lane.sh`, `maestro/journeys/i18n-rtl.yaml`,
`tests/rls/cross-tenant-isolation.test.ts` (its isolation proof reads `public.orgs`), and the
authoring skill's `scaffold-slice.mjs`.
The registers that gained an empty state (`tools/rls-exempt.json`'s `mfaRailUnused` row,
`tools/rate-limit-budget.json`'s `unmapped` bucket) are seeded and change for fresh
scaffolds only.
Two more seeded files changed at the 2.0.0 cut, for fresh scaffolds only.
`tools/duplication-allow.json` gains `4f2c41321264`, the mobile and web i18n catalogs'
match on a tree without the example (the same kind of match as `e83e21400fb2`; the span
moved with the example's keys). `apps/mobile/__tests__/live-api-proof.test.ts` writes the
caller's own `profiles` row before it reads it back, because nothing creates one at signup.
If you remove the example by hand, take both: add the entry when `duplication` (a Stop
step) names that fingerprint, and run
`update --refresh-seeded apps/mobile/__tests__/live-api-proof.test.ts` to replace the
example's live proof, which writes to `public.notes`.

Two registers reach a very old install as 2.0.0's default copies, because `update` plants a
seeded register only where it is absent. An install made before 1.0.0 that keeps the example
never had `tools/suppressions-allow.json`, and the default copy has no rows for the example's
files: when `suppressions` names them, take their rows from
`template/demo/tools/suppressions-allow.json` in a harness checkout of 2.0.0. An install made
before 0.6.0 receives `tools/web-route-allowlist.json` the same way, and it allowlists the org
landing page, which `update` withholds as a new exemplar: run
`update --refresh-seeded 'apps/web/app/(protected)/o/[orgSlug]/page.tsx'`, or delete that row.

### `reviewer-verdicts`: the ledger key is the session and a format stamp, not the prompt

Through 1.1.x every entry in `.harness/reviewer-ledger.jsonl` was keyed by its session and
its prompt. The reviewer ledger v2 already counts a PASS by the tree it reviewed (the
digests at its dispatch and at its verdict must equal the tree now), so from 2.0.0 the
prompt leaves v2's key:

- **Every entry carries a format stamp,** `"v": "2.0.0"`, written by
  `.claude/hooks/subagent-verdict.mjs` from `tools/lib/reviewer-verdicts.mjs`. The step
  reads this session's entries by session and format. An entry in another format, which
  includes every entry a 1.1.x hook wrote, never counts as a PASS and never clears a BLOCK.
  A BLOCK in any format still stands until the same reviewer run passes.
- **A reviewer whose entries are all in another format** reds with a finding that starts
  `<reviewer> has verdicts in this session only in another ledger format` and names the
  format. It is not "did not run": the reviewer ran, on the other side of the update.
- **The step needs only `HARNESS_SESSION_ID`.** The Stop hook still passes
  `HARNESS_PROMPT_ID` and the hook still records `prompt_id`, because the 1.0.x judgement
  keeps the prompt in its key. That judgement decides on a branch with no upstream, and, if
  your `baseVersion` is below 1.1.0, until 2.1.0. Run by hand with no prompt id, it now reds
  where it used to skip.
- **A ledger line that lacks `agent_type` or `verdict`** fails closed until the prompt it
  was written in ends, as before. The finding now says so: re-running the reviewer does not
  clear it, and the next prompt does. End the turn and tell the user what it says.

**What to do after the update, in this order.**

1. **If `update` parked `.claude/hooks/subagent-verdict.mjs` or
   `tools/lib/reviewer-verdicts.mjs`, merge the parked copy first** (the 1.0.2 section,
   "Forking an owned file"). A kept fork of either writes entries without the stamp on every
   run, so the format finding comes back after each re-run. A kept 1.1.x
   `tools/lib/reviewer-verdicts.mjs` also lacks `readSessionEntries`, and the step says so
   in one finding. If you kept a fork of `tools/check-reviewer-verdicts.mjs` instead, it goes
   on judging by the 1.1.x rule through the new lib, which keeps the functions it calls.
2. **Run the owed reviewers once.** In a session that spans the update, every verdict
   recorded before it is in the old format. One run of each reviewer the next Stop names
   records an entry in the new format. If a reviewer's BLOCK from before the update still
   stands, resume that run (`SendMessage` to its `agent_id`): a fresh run is a second
   opinion and does not clear it. A session that starts after the update has nothing to
   re-run.

Owned files re-planted when your copy still matches a released sha:
`tools/lib/reviewer-verdicts.mjs`, `tools/check-reviewer-verdicts.mjs`,
`.claude/hooks/subagent-verdict.mjs`, `.claude/hooks/stop-validate-gate.mjs` (a comment),
`docs/harness/gates-catalog.md` and this runbook. Nothing here is ramped, withheld or
seeded.

## 2.0.1 — a security patch: the `next` floor moves to 16.3.8

**No ramp here applies to any install.** 2.0.1 opens no ramp and moves no deadline. The
population 2.0.0 reds is restated in this release's record, and the 1.1.0 and 2.0.0 sections
above are still the sweep for an install below 1.1.0.

**What `update` plants.** Owned files, re-planted when your copy still matches a released
sha: `tools/framework-floor.json`, this runbook, and the hooks under `.claude/hooks/` (their
version stamps). Nothing is withheld, and no seeded file changes on an existing install.

### Expect `version-sync` to red on the `next` floor, whatever your `baseVersion`

This one is not a ramp, and no `baseVersion` is exempt from it. The `next` floor moves from
16.3.6 to **16.3.8** on the 16 line, and from 15.5.24 to **15.5.27** on the 15 line, for five
advisories upstream published on 2026-09-30:

- [GHSA-cjq9-62q9-8jv4](https://github.com/vercel/next.js/security/advisories/GHSA-cjq9-62q9-8jv4)
  (High): server-side request forgery in Image Optimization through an allow-listed remote
  URL. Only an app that configures `images.remotePatterns` is affected.
- [GHSA-4jqv-mc3x-m676](https://github.com/vercel/next.js/security/advisories/GHSA-4jqv-mc3x-m676)
  (Moderate, both lines): cache poisoning of statically generated and ISR pages on the Pages
  Router, when self-hosted.
- [GHSA-mcj8-r9mp-w47p](https://github.com/vercel/next.js/security/advisories/GHSA-mcj8-r9mp-w47p)
  (Moderate, both lines): cache poisoning through a root-level catch-all page combined with
  static generation or ISR.
- [GHSA-f87g-xv8r-7p7x](https://github.com/vercel/next.js/security/advisories/GHSA-f87g-xv8r-7p7x)
  (Moderate): App Router metadata image routes built with webpack ignore `dynamicParams`.
- [GHSA-39w2-rjm5-chcv](https://github.com/vercel/next.js/security/advisories/GHSA-39w2-rjm5-chcv)
  (Low): the `next dev` server's Model Context Protocol endpoint checks no origin. Production
  builds are not affected.

None of them names the release that fixes it yet: each lists its patched version as `16.3.?`
(and `15.5.?` for the two cache poisonings). 16.3.8 and 15.5.27, the newest release on each
line, came out the same day as the advisories, and the floor moves to them rather than wait.
As shipped, the scaffold configures no `images.remotePatterns`, is App Router only with no
static generation or ISR, and has no metadata image route, so of the five only the `next dev`
disclosure reached a tree that added none of those. If yours added any of them, that
advisory applies to it.

`tools/framework-floor.json` is harness-owned, so `update` refreshes it. `pnpm-workspace.yaml`
is seeded, so `update` does not touch your pins, and the first `pnpm validate` after the
upgrade reds `version-sync` on a `next` pin below 16.3.8 (or 15.5.27 on the 15 line), naming
the pin, the floor and the advisories. Raise the pin yourself:

```
# in the pnpm-workspace.yaml catalog: next: 16.3.8
pnpm install && git add pnpm-lock.yaml pnpm-workspace.yaml
pnpm validate
```

From 16.3.6 this is a patch on the same minor. No flag lowers the floor. Do not use
`update --refresh-seeded pnpm-workspace.yaml` to take the pin: it replaces your whole catalog
with the template's.

## 2.0.2 — run the CLI at `@latest`; the installer refuses an older one

**No ramp here applies to any install.** 2.0.2 opens no ramp and moves no deadline. The
population 2.0.0 reds is restated in this release's record, and the 1.1.0 and 2.0.0 sections
above are still the sweep for an install below 1.1.0.

**What `update` plants.** Owned files, re-planted when your copy still matches a released
sha: this runbook, the hooks under `.claude/hooks/` (their version stamps, and the write
guard's `apply-proposal` rule), the gate scripts under `tools/` and the harness docs whose
messages print a CLI command. Nothing is withheld, and no seeded file changes on an existing
install.

### Every printed command names `@latest`

The gate messages, hooks and docs used to print `npx next-expo-supabase-agent-harness
<command>`. When a global install is on your `PATH`, that bare form runs the global copy, at
whatever release it was installed at. They now print `npx
next-expo-supabase-agent-harness@latest <command>`, which always fetches the newest release.
A fork you kept prints the old spelling, and it still runs.

If you installed the CLI globally (`npm i -g next-expo-supabase-agent-harness`), run
`npm i -g next-expo-supabase-agent-harness@latest` before `update` to move it to the newest
release.

### `update`, `enable`, `disable` and `eject` refuse a CLI older than the install

Each writes the running CLI's copy of the template, so an older CLI used to move an install
backwards without a word: a 2.0.0 CLI over a 2.0.1 install printed `harness update 2.0.1 →
2.0.0` and rewrote 11 owned files. From the 2.0.2 CLI on, the four stop before their first
write and print both versions and the command to run instead:

```
error: this install is v2.0.2 and this CLI is v2.0.1, an older release, so `update` would write v2.0.1 files over it. Run the current release instead: `npx next-expo-supabase-agent-harness@latest update` (with a global install, run `npm i -g next-expo-supabase-agent-harness@latest` first).
```

Running the same version as the install is still allowed. The check is in the installer, so
only a 2.0.2 or later CLI makes it; an older CLI cannot be made to refuse.

### `graduate` advances `baseVersion` to the install's version, not the CLI's

`graduate` used to set `baseVersion` to the version of the CLI that ran it. Run at `@latest`
on an install that had not been updated, it marked ramps the install does not carry as
swept. It now advances `baseVersion` to the install's own `harnessVersion`, whichever CLI runs
it. An install that is behind runs `update` first.

If your install graduated with a newer CLI before 2.0.2, its `baseVersion` in
`.harness/manifest.json` is above its `harnessVersion`. The checks ramped between the two
then arrive as hard reds rather than NOTEs when you update. Nothing in 2.0.2 rewrites a
recorded `baseVersion`.

## 2.0.3 — a patch: defect fixes

**No ramp here applies to any install.** 2.0.3 opens no ramp and moves no deadline. The
population 2.0.0 reds is restated in this release's record, and the 1.1.0 and 2.0.0 sections
above are still the sweep for an install below 1.1.0.

**What `update` plants.** Owned files, re-planted when your copy still matches a released
sha: this runbook and the hooks under `.claude/hooks/` (their version stamps). Each fix below
says what else it delivers and what it leaves to you.

### The session brief prints App Router paths (#153)

Through 2.0.2 the brief (the SessionStart hook and `node tools/harness-status.mjs`) printed
every App Router route group and dynamic segment, such as
`apps/web/app/(protected)/o/[orgSlug]/page.tsx`, as `(unprintable)`, the way it prints a
refused value. It now prints every path in a code span, `( ) [ ]` included, and refuses an
absolute path, an empty or `.` segment and a segment that starts with `-`. `update` plants
`tools/lib/harness-brief.mjs` and `docs/harness/README.md`, both owned. Nothing is left to
you: the brief judges nothing, so no verdict moves. A fork of the lib you kept keeps the old
printer.

### The vertical-slice scaffold writes the worked example's shape (#155)

Through 2.0.2 `scaffold-slice.mjs` wrote a slice's web page at `apps/web/app/<slice>/`,
outside the org scope and with no `page.meta.ts`, so a run with no edits turned
`route-manifest` red. It wrote none of the example's data seams, and its Server Action stub
taught a write with no org and a cast at each call site. It now writes the segment at
`apps/web/app/(protected)/o/[orgSlug]/<slice>/` with its meta and loading state, a stub for
every seam, and `apps/web/lib/app-data/<slice>-port.ts` as the one narrowing function, and it
prints a `next:` line for each step it leaves to you. `update` plants the script, the skill's
`SKILL.md` and `references/dal-dto.md`, all owned. The script runs only when you run it, so no
slice you already have changes.

If your install has the worked example (`--with-demo`), `update` withholds the example's new
`apps/web/lib/app-data/notes-port.ts`: its three callers are seeded and keep their casts, so
nothing would import it. Nothing is left to you. To adopt the one-cast shape, pull the file
with `update --refresh-seeded apps/web/lib/app-data/notes-port.ts` and make
`app/actions/notes.ts`, `lib/app-data/notes.ts` and `app/api/trpc/[trpc]/route.ts` call
`toNotesPort`.

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
   `npx next-expo-supabase-agent-harness@latest update --rollback` — restores every
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
   first (`npx next-expo-supabase-agent-harness@latest update --refresh-seeded <path>` — the
   update report names them).
2. **Bump `baseVersion`** in `.harness/manifest.json` to the version the NOTE
   names (or the current release). This is a HUMAN decision: the file is
   write-guard-protected against agents, so edit it outside an agent session (a
   plain editor is fine), or run `npx next-expo-supabase-agent-harness@latest graduate` —
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
npx next-expo-supabase-agent-harness@latest update --refresh-seeded tools/perf-budget.json
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
