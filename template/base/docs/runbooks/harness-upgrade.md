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
