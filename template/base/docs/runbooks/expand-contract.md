# Runbook: expand → contract schema changes

How to change the schema without breaking a fleet of mobile clients that update on the
app stores' schedule — and their users' — not yours. This runbook is mechanically
coupled to the gates: migrations are **append-only** (`migrations` gate + write guard),
destructive DDL requires an **ADR** (`-- adr:` coupling), every new table needs its
**RLS story in the same migration** (`schema-rls` gate), and route changes must
re-emit the committed contract (`contracts` gate).

## Why two-phase

- **Migrations are append-only.** You cannot fix a shipped migration; you can only add
  the next one. Plan the sequence before writing the first file.
- **Mobile clients skew — worse than any desktop fleet.** A release sits in store
  review for days, rolls out staged (a percentage at a time), and then meets users who
  have auto-update off or a phone that last synced in March. An OTA update narrows the
  window but only reaches installs on the SAME runtimeVersion
  (`policy: 'appVersion'` — an OTA cannot cross store versions). The skew middleware
  only rejects MAJOR mismatches — within a major, the previous app version and the
  previous server version must both keep working against the new schema, and "previous"
  here means a long tail, not N-1.
- A single-step rename/drop breaks one of those, always. Split every breaking change
  into an additive **expand** phase and a destructive **contract** phase, with deploys,
  store rollout, and data migration in between.

## Phase 1 — EXPAND (additive migration; new file via `drizzle-kit generate`)

Add the new shape alongside the old. Allowed: new tables, new nullable-or-defaulted
columns, new indexes, widened types. Never remove or rename anything here.

- New table? ENABLE + FORCE ROW LEVEL SECURITY + four per-operation policies in the
  SAME migration (the `schema-rls` gate rejects the migration without them), plus an
  `ISOLATION_TARGETS` entry in `tests/rls/db-context.ts` and shapes in
  `tests/rls/dal-shapes.ts` so the runtime suite probes it.
- New column that replaces an old one? Make it nullable or defaulted so old-server
  INSERTs still succeed.
- Update the Drizzle schema + DAL to **write both** (dual-write) and **read new,
  fall back to old**. DTOs in `@app/contracts` stay backward-compatible (additive Zod
  fields, optional).
- Gate check: `pnpm validate` + `pnpm test:rls` green; `pnpm openapi:emit` if routes
  changed (additive contract changes only — an old client must still validate).

## Phase 2 — DEPLOY + ROLL OUT

Ship the dual-write server FIRST (it must accept both shapes before any client sends
the new one). Then submit the new mobile build and roll it out staged; watch the
rollout percentage and crash/error signals before widening. Do NOT bump the major
version for an expand — a major bump 409s every not-yet-updated client on purpose;
reserve it for deliberate contract breaks. An OTA update may carry the client half
ONLY if it does not require the new native surface (same runtimeVersion) — otherwise
it rides the store build.

## Phase 3 — MIGRATE DATA (backfill)

Move existing rows to the new shape.

- Small, immutable reference data MAY ride a migration with an explicit
  `-- harness-allow-dml: <reason>` marker (the `migrations` gate rejects unmarked DML).
- Everything else uses a **backfill runner outside migrations** (idempotent, batched,
  resumable; the `ops-backup` module ships a harnessed one). Backfills run as a
  deliberate operational act, not as a side effect of `db:migrate`.
- Verify: counts old-vs-new agree; `pnpm test:rls` still green (backfills run under
  the migrator role — confirm they set owner columns correctly, or RLS will hide the
  rows from their owners and the positive control will catch it).

## Phase 4 — CONTRACT (destructive migration; ADR-coupled)

Only after: the fleet floor no longer runs readers of the old shape — and on mobile
that floor is measured, not assumed: check store analytics / version telemetry for the
oldest version still calling the API, remembering the store-review lag means the
"current" release was never the whole fleet. And the backfill is verified complete.

1. Write the ADR first: `/adr <slice>` → `docs/adr/YYYYMMDD-<slug>.md` recording what
   is dropped, why it is safe now (including the measured fleet floor), and the
   rollback story.
2. New migration with the destructive DDL, carrying
   `-- adr: docs/adr/YYYYMMDD-<slug>.md` — the `migrations` gate rejects
   DROP TABLE/DROP COLUMN/TRUNCATE without a resolvable ADR reference.
3. Remove the dual-write/fallback code (knip will flag the dead path), regenerate the
   contract if routes changed, and — if the old shape was still accepted over the API —
   this is the point to bump the MAJOR version so stragglers get an explicit
   `409 version_skew` instead of silent data loss. A majored-out mobile client must
   render its upgrade surface, not a crash.
4. Full gate: `pnpm validate`, `pnpm test:rls`, both unit suites.

## Quick reference

| Step | Migration file | Gates that hold the line |
|---|---|---|
| Expand | new, additive | `migrations` (append-only), `schema-rls` (FORCE RLS + policies), `contracts` (additive OpenAPI), `rls-isolation` |
| Deploy + rollout | — | `version-sync` (manifests move together), skew middleware (majors), staged rollout telemetry |
| Backfill | none (runner) or `-- harness-allow-dml:` | `migrations` (DML marker), `rls-isolation` (owner columns) |
| Contract | new, destructive | `migrations` (`-- adr:` required), `dead-code`, `contracts` |

Worked example — renaming `notes.body` → `notes.content`: expand adds `content`
(nullable) + dual-write in `dal/notes.ts`; deploy the server, submit + roll out the
client; backfill copies `body` → `content` in batches; contract migration drops `body`
with `-- adr:` after telemetry shows the pre-dual-write versions gone from the fleet.
