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

**0.3.0 ships the clock, not the alarm.** Every pre-existing 0.1.x/0.2.0 ramp was
dated `0.4.0` and every ramp introduced in 0.3.0 was dated `0.5.0`, so nothing reds
on a deadline in this release. The first expiries land in 0.4.0.

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
