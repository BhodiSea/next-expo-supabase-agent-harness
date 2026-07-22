-- db/init/01-roles.sql — dev-only role bootstrap. Runs ONCE, as the postgres
-- superuser, on the first `docker compose up` (docker-entrypoint-initdb.d).
-- Roles are infrastructure, not schema: they are created here, never in drizzle
-- migrations (BUILD-SPEC §Database roles). Passwords follow the documented
-- 'postgres' local-dev convention — never reuse these outside docker-compose.

-- app_migrator owns the schema and runs migrations. CREATEDB lets the RLS
-- runner build scratch databases without borrowing superuser.
CREATE ROLE app_migrator LOGIN PASSWORD 'postgres' NOSUPERUSER NOCREATEROLE CREATEDB;

-- app_api is the login role the API server uses. NOSUPERUSER + NOBYPASSRLS means
-- FORCE RLS applies to it unconditionally — there is no privileged escape hatch
-- on the request path.
-- SOURCE: BUILD-SPEC §Database roles (app_api NOT superuser, subject to FORCE RLS) [corpus: postgres/rls-initplan]
CREATE ROLE app_api LOGIN PASSWORD 'postgres' NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;

-- The RLS runner fresh-applies migrations by DROP/CREATE DATABASE as
-- app_migrator; initdb created the database owned by postgres, so ownership
-- must move or the drop fails with "must be owner of database" (42501).
ALTER DATABASE "{{DB_NAME}}" OWNER TO app_migrator;

-- pgvector: extension creation needs elevated rights, and migrations run as
-- app_migrator — so the extension is provisioned here, up front.
CREATE EXTENSION IF NOT EXISTS vector;

-- Hardened Postgres images no longer hand out implicit privileges on schema
-- public. Make ownership explicit: app_migrator creates objects; app_api reaches
-- them only through explicit grants, with RLS still gating every row.
-- SOURCE: harness doctrine — default-privileges lesson (API roles could not reach RLS tables on newer images) [corpus: harness/doctrine]
ALTER SCHEMA public OWNER TO app_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_api;

-- Belt and braces for objects app_migrator creates later: table-level DML only —
-- row visibility remains RLS's job. Migrations still carry explicit GRANTs so the
-- privilege story is reviewable in the schema history.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_api;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_api;

-- Seed template1 with pgvector so scratch databases created by the RLS runner
-- (CREATE DATABASE inherits from template1) can run the vector migrations too.
\connect template1
CREATE EXTENSION IF NOT EXISTS vector;
