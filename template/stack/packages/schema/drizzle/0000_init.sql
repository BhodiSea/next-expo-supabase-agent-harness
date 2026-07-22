-- 0000_init — hand-authored initial migration.
-- Runs as the migrator role (schema owner). The runtime role (app_api) receives
-- only the row-level DML granted at the bottom and is permanently subject to RLS.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"embedding" vector(1024),
	"source_model" text,
	"source_confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- SOURCE: PostgreSQL ALTER TABLE docs — FORCE applies row security to the table
-- owner as well, so no role that ends up owning the table can silently bypass
-- the policies. [corpus: postgres/rls-force]
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The owner check is wrapped in a scalar sub-select so it evaluates once per
-- statement (initPlan) instead of per row. nullif(current_setting(..., true), '')
-- maps BOTH no-identity shapes to NULL — an unset GUC returns NULL, but a pooled
-- session that ever ran SET LOCAL returns '' afterwards, which would make a bare
-- ::uuid cast raise 22P02 instead of cleanly denying. NULL never equals an
-- owner_id, so "no identity" fails closed. Four per-operation policies, never
-- FOR ALL, so read and write intents can diverge later without a rewrite.
-- SOURCE: PostgreSQL row security, initPlan sub-select pattern [corpus: postgres/rls-initplan]
CREATE POLICY "notes_select_own" ON "notes" AS PERMISSIVE FOR SELECT TO "app_api"
	USING ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid));
--> statement-breakpoint
-- SOURCE: WITH CHECK validates the NEW row so a client cannot INSERT another user's owner_id [corpus: postgres/rls-force]; initPlan GUC sub-select [corpus: postgres/rls-initplan]
CREATE POLICY "notes_insert_own" ON "notes" AS PERMISSIVE FOR INSERT TO "app_api"
	WITH CHECK ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid));
--> statement-breakpoint
-- SOURCE: UPDATE needs both USING (rows visible to change) and WITH CHECK (result stays own) [corpus: postgres/rls-force]; initPlan GUC sub-select [corpus: postgres/rls-initplan]
CREATE POLICY "notes_update_own" ON "notes" AS PERMISSIVE FOR UPDATE TO "app_api"
	USING ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid))
	WITH CHECK ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid));
--> statement-breakpoint
-- SOURCE: DELETE USING restricts which rows the role may remove to its own [corpus: postgres/rls-force]; initPlan GUC sub-select [corpus: postgres/rls-initplan]
CREATE POLICY "notes_delete_own" ON "notes" AS PERMISSIVE FOR DELETE TO "app_api"
	USING ("owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "notes" TO "app_api";
