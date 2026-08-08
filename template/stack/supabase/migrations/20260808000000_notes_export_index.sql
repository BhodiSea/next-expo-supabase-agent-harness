-- 20260808000000_notes_export_index — the serving index for the DSR export's
-- authored-notes seek.
--
-- APPLIED HISTORY, NOT DESIRED STATE. The reasoning lives in
-- supabase/schemas/20_notes.sql beside the twin declaration; this file is the
-- forward step, append-only like every other migration here.
--
-- `system.exportMyData` reads ONE org's notes authored by the subject
-- (`org_id = $1 AND owner_id = $2`), keyset-ordered on (created_at DESC,
-- id DESC). notes_org_id_created_at_id_idx serves the org LIST but leaves
-- owner_id as a filter over every row the org has — fast on a test database,
-- a scan-and-discard on a successful customer's. This index carries the
-- equality pair as its prefix and the keyset tail after it, so the export seek
-- is an ordered index scan like every other list in the repo. org_id LEADS:
-- on a tenant table the tenant key leads or every tenant's rows are in the
-- scan before the filter runs (tools/check-query-shapes.mjs rule 5).
-- SOURCE: https://www.postgresql.org/docs/17/indexes-ordering.html
CREATE INDEX notes_org_id_owner_id_created_at_id_idx
  ON public.notes (org_id, owner_id, created_at DESC, id DESC);
