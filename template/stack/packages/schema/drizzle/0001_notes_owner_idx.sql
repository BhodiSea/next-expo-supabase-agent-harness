-- 0001_notes_owner_idx — hand-authored.
-- Every RLS policy on notes filters by owner_id; without an index the policy
-- predicate degrades every query to a sequential scan the moment the table has
-- real data — RLS + missing index is the classic silent 100x regression. The
-- runtime suite asserts index coverage from pg_catalog and the plan-regression
-- probe proves no Seq Scan at 10k rows.
-- SOURCE: PostgreSQL row security — policy predicates participate in normal
-- planning, so filtered columns need the same indexes any WHERE clause would.
-- [corpus: postgres/rls-initplan]
CREATE INDEX "notes_owner_id_idx" ON "notes" ("owner_id");
