-- 0003_push_device_tokens — hand-authored (push-notifications module).
-- One row per (owner, device push token). The id DEFAULT stays gen_random_uuid()
-- for probe/bulk inserts, but the DAL always supplies a DETERMINISTIC version-5
-- UUID of (owner_id, token) — that primary key is the upsert arbiter that makes
-- register() idempotent and race-free WITHOUT a (owner_id, token) unique index
-- (which would reject the harness plan probe's constant-scalar bulk seed; see
-- the module README's honest limits).
-- `platform` carries a CHECK mirroring the @app/contracts PUSH_PLATFORMS enum:
-- the DB is an enforcement surface, not a hope.
CREATE TABLE "push_device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL CONSTRAINT "push_device_tokens_platform_check" CHECK ("platform" IN ('android', 'ios')),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_device_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- SOURCE: FORCE applies row security to the table owner as well, so no role
-- that ends up owning the table can silently bypass the policies.
-- [corpus: postgres/rls-force]
ALTER TABLE "push_device_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Same initPlan-shaped predicate as the notes policies: scalar sub-select so
-- identity resolves once per statement; nullif maps both no-identity shapes
-- (unset GUC -> NULL, post-SET-LOCAL pooled session -> '') to NULL, which never
-- equals an owner_id — no identity fails closed instead of raising 22P02.
-- Four per-operation policies, never FOR ALL.
-- SOURCE: PostgreSQL row security, initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY "push_device_tokens_select_own" ON "push_device_tokens" AS PERMISSIVE FOR SELECT TO "app_api"
	USING ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid));
--> statement-breakpoint
-- The DAL's register() is INSERT ... ON CONFLICT DO UPDATE: this WITH CHECK screens every
-- proposed row, and the DO UPDATE path additionally checks the UPDATE policies below.
-- SOURCE: WITH CHECK validates the NEW row so a client cannot INSERT another user's owner_id; ON CONFLICT DO UPDATE also checks the UPDATE policies on the conflicting row https://www.postgresql.org/docs/current/sql-createpolicy.html [corpus: postgres/rls-force]; initPlan GUC sub-select [corpus: postgres/rls-initplan]
CREATE POLICY "push_device_tokens_insert_own" ON "push_device_tokens" AS PERMISSIVE FOR INSERT TO "app_api"
	WITH CHECK ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid));
--> statement-breakpoint
-- SOURCE: UPDATE needs both USING (rows visible to change) and WITH CHECK (result stays own) [corpus: postgres/rls-force]; initPlan GUC sub-select [corpus: postgres/rls-initplan]
CREATE POLICY "push_device_tokens_update_own" ON "push_device_tokens" AS PERMISSIVE FOR UPDATE TO "app_api"
	USING ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid))
	WITH CHECK ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid));
--> statement-breakpoint
-- SOURCE: DELETE USING restricts which rows the role may remove to its own
-- [corpus: postgres/rls-force]; initPlan GUC sub-select [corpus: postgres/rls-initplan]
CREATE POLICY "push_device_tokens_delete_own" ON "push_device_tokens" AS PERMISSIVE FOR DELETE TO "app_api"
	USING ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid));
--> statement-breakpoint
-- ONE index serves the RLS equality predicate, the list ORDER BY, and the
-- keyset range in a single walk — the 0002_notes_keyset_idx lesson applied
-- from day one instead of re-learned: equality column first, then the ORDER BY
-- columns in their declared direction. A bare (owner_id) index would satisfy
-- the leading-column check and still sort the owner's whole partition per page.
-- SOURCE: keyset pagination requires the index to cover the ORDERING, not just
-- the filter — https://use-the-index-luke.com/no-offset ; policy predicates
-- participate in normal planning [corpus: postgres/rls-initplan]
CREATE INDEX "push_device_tokens_owner_created_id_idx" ON "push_device_tokens" ("owner_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "push_device_tokens" TO "app_api";
