<!-- cspell:ignore hitl -->

# Runbook: data backfill with human-in-the-loop approval (ops-backup module)

Backfills — bulk writes that touch existing rows — are where tenant data dies.
This runbook is the state machine every backfill follows, and the HITL test
skeletons in `tests/rls/hitl-*.test.ts` are its executable contract once your
approval tables exist.

## The state machine

```
draft ── submit ──▶ pending_review ── approve ──▶ approved ── execute ──▶ executed
  ▲                     │                             │
  └──── revise ◀── reject                          abort ──▶ aborted
```

Hard rules (encode them as CHECK constraints / triggers + RLS policies, then
un-skip the tests):

1. **No self-approval**: the identity that submitted a backfill cannot approve it.
2. **The pipeline role can never approve**: service identities may create and
   execute; only a HUMAN reviewer identity may move `pending_review → approved`
   (`tests/rls/hitl-pipeline-role.test.ts`).
3. **Only the matrix's transitions exist**: anything not drawn above is rejected
   by the database, not by application politeness
   (`tests/rls/hitl-transition-matrix.test.ts`).
4. **Executed is terminal**: corrections are a NEW backfill referencing the old
   one, never an edit of history.

## Executing an approved backfill

- Wrap the whole backfill in one transaction where volume allows; otherwise
  batch with a resumable cursor table and record progress per batch.
- Run as a dedicated role with exactly the DML the backfill needs — never as
  `app_migrator`, never with BYPASSRLS.
- Take a `pg_dump` of the affected tables first (see backup-restore-drill.md) and
  note the LSN, so point-in-time recovery has a named "before".
- Emit one row per batch into your audit table: who approved, what ran, row
  counts expected vs actual. Diverging counts abort the run.

## Why the tests ship skipped

The consuming app defines the approval tables (names, reviewer identity model),
so the skeletons probe for the table (`review_queue` by default — rename in the
test's CONFIG block) and skip loudly with a TODO until it exists. The pure
transition-matrix consistency checks run from day one. When the table lands:
follow the TODO seams, replace the skips with real assertions, and add the table
to `ISOLATION_TARGETS` in `tests/rls/db-context.ts` so the generic isolation
matrix covers it too.
