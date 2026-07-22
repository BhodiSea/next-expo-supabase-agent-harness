<!-- cspell:ignore hitl pgbackrest basebackup -->

# Module: ops-backup

Operational data safety: a local restore-drill rig (compose overlay), the
backup/restore and backfill runbooks, and executable skeletons for the
human-in-the-loop (HITL) backfill state machine — the "pipeline can never
approve" rule and the transition matrix — wired into the RLS test lane.

## What it adds

| File | Purpose |
| --- | --- |
| `docker-compose.pgbackrest.yml` | overlay: WAL archiving + a drill workbench container |
| `docs/runbooks/backup-restore-drill.md` | the quarterly drill (local rig + production pgBackRest skeleton) |
| `docs/runbooks/backfill.md` | the HITL state machine and backfill execution rules |
| `tests/rls/hitl-transition-matrix.test.ts` | pure matrix consistency (runs now) + DB enforcement skeleton |
| `tests/rls/hitl-pipeline-role.test.ts` | pipeline-role-cannot-approve skeleton (with positive-control seam) |

## Prerequisites

- None for the runbooks/tests. The drill rig needs only docker compose.
- Production backup needs pgBackRest ON the database host plus an off-host
  repository — the runbook carries the config skeleton; that infrastructure is
  exactly why this is a module, not a default.

## How enabling works

```
npx next-expo-supabase-agent-harness enable ops-backup
```

The pure transition-matrix tests join `pnpm test:rls` / the Stop hook
immediately. The DB-enforcement halves PROBE for the approval table
(`review_queue` — rename in each test's CONFIG block) and skip loudly with a
TODO until your schema lands; the moment the table exists they FAIL with
"still the skeleton" until you implement the seams — an enabled-but-unfinished
gate is loud, never silently green.

## How its gates can FAIL (anti-vacuity)

- Pure layer, today: add `'approved'` to `draft`'s transitions in the matrix →
  the "never reach approved directly" test fails.
- Skeleton behavior: create a `review_queue` table without implementing the
  seams → both tests fail loudly by design (`expect.fail`), proving they cannot
  be enabled-and-forgotten.
- Once implemented: drop the reviewer-only RLS policy on the state column in a
  scratch migration → pipeline-role test fails; the positive control (a human
  reviewer CAN approve) keeps the test from passing vacuously on a deny-all
  table.
- Drill: run the restore drill once WITHOUT the archive volume → verification
  step 5 fails. A drill that cannot fail proves nothing.

## Honest limits

- The compose overlay drills RESTORE MECHANICS with portable tooling
  (pg_basebackup + WAL `cp` archiving); it does not exercise pgBackRest itself —
  the stock pgvector image has no pgbackrest binary, and pretending otherwise
  would be theater. The production section of the runbook is where pgBackRest
  configuration lives.
- When your approval table lands, also add it to `ISOLATION_TARGETS` in
  `tests/rls/db-context.ts` so the generic cross-user isolation matrix covers it.
