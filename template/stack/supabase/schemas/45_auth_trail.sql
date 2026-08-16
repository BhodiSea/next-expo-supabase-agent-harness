-- supabase/schemas/45_auth_trail.sql — the append-only authentication-event trail.
--
-- DECLARATIVE FILE — see 00_shared.sql for how this directory relates to
-- supabase/migrations/ and what the diff engine does not see. The forward step that
-- builds this state, plus the full design argument (the GoTrue-hook seam, the
-- ceilings, the deliberate no-reader posture), is
-- supabase/migrations/20260816000000_auth_event_trail.sql; the decision record is
-- docs/adr/20260816-auth-event-trail.md.
--
-- Same non-public-schema reasoning as 40_audit.sql one file up, and the same
-- declares-tables-only discipline: the roles, grants, policies, hook functions and
-- runtime partitions all live in the migration, because the shadow database
-- `db diff` builds has never run one.
CREATE SCHEMA IF NOT EXISTS auth_trail;

CREATE TABLE auth_trail.events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- Nullable, and deliberately NOT a foreign key: account deletion must never
  -- erase the record of attempts against that account.
  user_id uuid,
  -- The trail's own CLOSED vocabulary — never GoTrue's enum, which upgrades with
  -- the auth server.
  event_kind text NOT NULL,
  factor_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT events_kind_known CHECK (
    event_kind IN ('password_success', 'password_failure', 'mfa_success', 'mfa_failure')
  ),
  PRIMARY KEY (occurred_at, id)
)
PARTITION BY RANGE (occurred_at);

CREATE TABLE auth_trail.events_default PARTITION OF auth_trail.events DEFAULT;
