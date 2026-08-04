// Can-fail proofs for the db-limits gate (template/base/tools/check-db-limits.mjs).
//
// The gate has two halves and they fail in opposite directions, so the proofs do too:
// the role×knob matrix reds when a ceiling is MISSING, and the `unavailable` list reds
// when a knob is PRESENT. The second is the one worth having — `temp_file_limit` and
// `CONNECTION LIMIT` both read as obvious hardening, both were in this release's plan,
// and both bind nothing on this platform. A number that cannot bind is worse than no
// number, because a reviewer reads it as a control.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const GATE_SRC = join(ROOT, 'template/base/tools/check-db-limits.mjs')
const LIB_SRC = join(ROOT, 'template/base/tools/lib')
const CONFIG_SRC = join(ROOT, 'template/base/tools/db-limits.json')

const ROLE_SETTINGS = `ALTER ROLE anon SET statement_timeout = '3s';
ALTER ROLE anon SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE anon SET lock_timeout = '2s';
ALTER ROLE authenticated SET statement_timeout = '8s';
ALTER ROLE authenticated SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE authenticated SET lock_timeout = '3s';
ALTER ROLE service_role SET statement_timeout = '30s';
ALTER ROLE service_role SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE service_role SET lock_timeout = '5s';`

const QUOTA = `CREATE TABLE public.quota_defaults (metric text PRIMARY KEY, hard_limit bigint NOT NULL);
CREATE TABLE public.org_quota (org_id uuid NOT NULL, metric text NOT NULL, hard_limit bigint NOT NULL, PRIMARY KEY (org_id, metric));
CREATE TABLE public.org_usage (org_id uuid NOT NULL, metric text NOT NULL, used bigint NOT NULL DEFAULT 0, PRIMARY KEY (org_id, metric));
GRANT SELECT ON TABLE public.org_usage TO authenticated;
GRANT SELECT ON TABLE public.org_quota TO authenticated;
CREATE FUNCTION private.enforce_org_quota() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$ BEGIN RETURN NULL; END $$;
CREATE FUNCTION private.release_org_quota() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$ BEGIN RETURN NULL; END $$;
CREATE FUNCTION public.reconcile_org_usage() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
  AS $$ BEGIN RETURN 0; END $$;
REVOKE ALL ON FUNCTION public.reconcile_org_usage() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_org_usage() FROM anon, authenticated;`

const TRIGGERS = `CREATE TRIGGER notes_quota_add AFTER INSERT ON public.notes
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.enforce_org_quota('notes', 'org_id');
CREATE TRIGGER notes_quota_release AFTER DELETE ON public.notes
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.release_org_quota('notes', 'org_id');`

const CONFIG_TOML = '[api]\nmax_rows = 1000\nschemas = ["public"]\n'

function migration({ roleSettings = ROLE_SETTINGS, quota = QUOTA, triggers = TRIGGERS, extra = '' } = {}) {
  return `CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE public.notes (id uuid PRIMARY KEY, org_id uuid NOT NULL);
${roleSettings}
${quota}
${triggers}
${extra}`
}

function fixture({ mig = migration(), config, configToml = CONFIG_TOML, sources = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nesah-dblimits-'))
  for (const [rel, content] of Object.entries(sources)) {
    mkdirSync(join(dir, rel.slice(0, rel.lastIndexOf('/'))), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'supabase/migrations'), { recursive: true })
  cpSync(GATE_SRC, join(dir, 'tools/check-db-limits.mjs'))
  cpSync(LIB_SRC, join(dir, 'tools/lib'), { recursive: true })
  const base = JSON.parse(readFileSync(CONFIG_SRC, 'utf8'))
  writeFileSync(join(dir, 'tools/db-limits.json'), JSON.stringify(config ? config(base) : base))
  if (mig !== null) writeFileSync(join(dir, 'supabase/migrations/0001_limits.sql'), mig)
  if (configToml !== null) writeFileSync(join(dir, 'supabase/config.toml'), configToml)
  return dir
}

function runGate(dir) {
  const env = { ...process.env }
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  const res = spawnSync('node', ['tools/check-db-limits.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...env, CI: 'true' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('GREEN: the shipped shape passes — full matrix, statement-level quota, no inert knobs', () => {
  const r = runGate(fixture())
  assert.equal(r.code, 0, r.out)
})

test('RED: a declared ceiling that no migration applies', () => {
  // The failure this catches is a contract that describes a database nobody runs:
  // the JSON says authenticated is capped at 8s and nothing ever set it.
  const r = runGate(
    fixture({ mig: migration({ roleSettings: ROLE_SETTINGS.split('\n').filter((l) => !l.includes('authenticated SET statement_timeout')).join('\n') }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('ALTER ROLE authenticated SET statement_timeout'), r.out)
  assert.ok(r.out.includes('exists only in a JSON file'), r.out)
})

test('RED: a later RESET vacates an earlier SET', () => {
  // An earlier SET does not survive a RESET, so a gate that only collected SETs would
  // report a ceiling the database no longer holds.
  const r = runGate(fixture({ mig: migration({ extra: 'ALTER ROLE anon RESET statement_timeout;' }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('RESET by a later migration'), r.out)
})

test('RED: a value that disagrees with the reviewed contract', () => {
  const r = runGate(
    fixture({ mig: migration({ roleSettings: ROLE_SETTINGS.replace("anon SET statement_timeout = '3s'", "anon SET statement_timeout = '7s'") }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes("is '7s' in the migration but '3s'"), r.out)
})

test('RED: a value above its ceiling is a widening that belongs in the contract diff', () => {
  const r = runGate(
    fixture({
      mig: migration({ roleSettings: ROLE_SETTINGS.replace("service_role SET statement_timeout = '30s'", "service_role SET statement_timeout = '120s'") }),
      config: (c) => ({ ...c, roles: { ...c.roles, service_role: { ...c.roles.service_role, statement_timeout: '120s' } } }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('exceeds the statement_timeout ceiling'), r.out)
})

// --- the INVERTED half -------------------------------------------------------

test('RED: temp_file_limit appears — superuser-only, so it cannot be set at all here', () => {
  const r = runGate(fixture({ mig: migration({ extra: "ALTER ROLE authenticated SET temp_file_limit = '256MB';" }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('temp_file_limit'), r.out)
  assert.ok(r.out.includes('permission denied to set parameter'), r.out)
})

test('RED: CONNECTION LIMIT appears — inert on every role that is not a login role', () => {
  // The seductive version of this mistake. It applies cleanly, shows up in pg_authid,
  // and bounds nothing: a connection limit binds at LOGIN, and anon/authenticated/
  // service_role never log in — PostgREST logs in as `authenticator`, which is a
  // reserved role nobody but a superuser may alter.
  const r = runGate(fixture({ mig: migration({ extra: 'ALTER ROLE authenticated CONNECTION LIMIT 60;' }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('CONNECTION LIMIT 60'), r.out)
  assert.ok(r.out.includes('reads to a reviewer as a control'), r.out)
})

test('GREEN: CONNECTION LIMIT -1 is the explicit no-limit spelling, not a control', () => {
  const r = runGate(fixture({ mig: migration({ extra: 'ALTER ROLE app_tenancy_rpc CONNECTION LIMIT -1;' }) }))
  assert.equal(r.code, 0, r.out)
})

// --- the quota's SHAPE -------------------------------------------------------

test('RED: a FOR EACH ROW quota trigger serializes every insert behind one tuple', () => {
  const r = runGate(
    fixture({
      mig: migration({
        triggers: TRIGGERS.replace(
          'REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT',
          'FOR EACH ROW',
        ),
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('FOR EACH ROW'), r.out)
  assert.ok(r.out.includes('1000 dead tuples'), r.out)
})

test('RED: a statement-level trigger with NO transition table can only ever count zero', () => {
  const r = runGate(
    fixture({ mig: migration({ triggers: TRIGGERS.replace('REFERENCING NEW TABLE AS new_rows ', '') }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('REFERENCING NEW TABLE'), r.out)
})

test('RED: a metered table with no enforcement trigger — declared and unenforced', () => {
  const r = runGate(fixture({ mig: migration({ triggers: '' }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no AFTER INSERT trigger'), r.out)
})

test('RED: no release trigger — every delete becomes a permanent debit', () => {
  const r = runGate(
    fixture({ mig: migration({ triggers: TRIGGERS.split('CREATE TRIGGER notes_quota_release')[0] }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('stays at its limit forever'), r.out)
})

test('RED: a RESTRICTIVE counting policy — the alternative that fails OPEN', () => {
  // Hoisted to one evaluation per statement against the PRE-statement count, so a
  // single multi-row INSERT of any size passes wholesale. It looks like enforcement.
  const r = runGate(
    fixture({
      mig: migration({
        extra: `CREATE POLICY notes_quota ON public.notes AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK ((SELECT count(*) FROM public.notes n WHERE n.org_id = notes.org_id) < 100);`,
      }),
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('fails OPEN'), r.out)
})

test('RED: the reconciler reassigned to the tenant-scoped writer — the silent total failure', () => {
  // pg_cron has no JWT, so a scoped owner reads an empty scope, produces an empty
  // truth set, and sets EVERY counter in the database to zero on a schedule.
  const r = runGate(
    fixture({ mig: migration({ extra: 'ALTER FUNCTION public.reconcile_org_usage() OWNER TO app_quota_writer;' }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('silently set to zero on a schedule'), r.out)
})

test('RED: the reconciler made client-callable', () => {
  const r = runGate(
    fixture({ mig: migration({ extra: 'GRANT EXECUTE ON FUNCTION public.reconcile_org_usage() TO authenticated;' }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('its safety is that no client can call it') || r.out.includes('EXECUTE granted to authenticated'), r.out)
})

test('RED: a client role granted UPDATE on the usage counter has no quota', () => {
  const r = runGate(
    fixture({ mig: migration({ extra: 'GRANT UPDATE ON TABLE public.org_usage TO authenticated;' }) }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('has no quota'), r.out)
})

// --- config.toml -------------------------------------------------------------

test('RED: [api].max_rows above the reviewed cap', () => {
  const r = runGate(fixture({ configToml: '[api]\nmax_rows = 100000\n' }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('exceeds the reviewed cap'), r.out)
})

test('RED: a session-mode pooler pins one backend per idle client', () => {
  const r = runGate(
    fixture({ configToml: `${CONFIG_TOML}\n[db.pooler]\nenabled = true\npool_mode = "session"\n` }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('session mode pins one backend'), r.out)
})

// --- pooled-connection discipline, tree-wide ---------------------------------
//
// The write-guard denies all three of these at the moment of the edit. These cases
// prove the OTHER half: a file the hook never watched being written — arriving by
// merge, by an installer update, or predating the rule — is still judged.

test('RED: a postgres() client built without prepare: false', () => {
  const r = runGate(
    fixture({
      sources: {
        'packages/platform/supabase/src/driver.ts': 'const sql = postgres(url, { max: 5 })\n',
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('prepare: false'), r.out)
  assert.ok(r.out.includes('driver.ts:1'), r.out)
})

test('RED: prepare: false on a LATER construction does not clear an earlier one', () => {
  // The per-construction closure the hook's file-scoped tripwire structurally cannot
  // do: the file mentions `prepare: false`, so a whole-file grep reads as compliant.
  const r = runGate(
    fixture({
      sources: {
        'packages/platform/supabase/src/driver.ts':
          'const admin = postgres(adminUrl)\n' +
          `${'// padding to push the second construction past the 600-char window\n'.repeat(12)}` +
          'const app = postgres(appUrl, { prepare: false })\n',
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('driver.ts:1'), r.out)
})

test('GREEN: a URL-validating regex is not a driver construction', () => {
  // `postgres(?:ql)?://` — the shipped env validator and the secret scanner both
  // contain exactly this, and an early version of the rule reddened both.
  const r = runGate(
    fixture({
      sources: {
        'packages/platform/env/src/index.ts': 'const DB_URL = /^postgres(?:ql)?:\\/\\/\\S+$/\n',
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('RED: a timeout GUC set at SESSION scope leaks into the next tenant request', () => {
  const r = runGate(
    fixture({
      sources: {
        'apps/web/lib/report.ts': "await sql`SET statement_timeout = '120s'`\n",
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('SESSION scope'), r.out)
  assert.ok(r.out.includes("NEXT tenant's request"), r.out)
})

test('GREEN: SET LOCAL is the safe form, and ALTER ROLE is the mechanism itself', () => {
  // Two distinct carve-outs, and neither is cosmetic: SET LOCAL reverts at COMMIT, and
  // `ALTER ROLE x SET ...` writes pg_db_role_setting — it is how the reviewed ceilings
  // are installed, so a rule that reddened it would forbid its own migration.
  const r = runGate(
    fixture({
      sources: {
        'apps/web/lib/report.ts': "await sql`SET LOCAL statement_timeout = '3s'`\n",
        'supabase/functions/provision/index.ts':
          "await sql`ALTER ROLE authenticated SET statement_timeout = '8s'`\n",
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('RED: a session-scoped advisory lock outlives the request that took it', () => {
  const r = runGate(
    fixture({
      sources: { 'packages/platform/supabase/src/lock.ts': 'await sql`select pg_advisory_lock(${k})`\n' },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('SESSION-scoped advisory lock'), r.out)
})

test('GREEN: pg_advisory_xact_lock is released by the transaction end, error path included', () => {
  const r = runGate(
    fixture({
      sources: {
        'packages/platform/supabase/src/lock.ts': 'await sql`select pg_advisory_xact_lock(${k})`\n',
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
})

// --- fail-closed -------------------------------------------------------------

test('FAIL CLOSED: malformed contract JSON', () => {
  const dir = fixture()
  writeFileSync(join(dir, 'tools/db-limits.json'), '{ not json')
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('fails closed'), r.out)
})

test('FAIL CLOSED: an EMPTY role matrix never passes vacuously', () => {
  const r = runGate(fixture({ config: (c) => ({ ...c, roles: {} }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('no ceilings at all'), r.out)
})

test('FAIL CLOSED: an unavailable entry without a substantive reason', () => {
  const r = runGate(fixture({ config: (c) => ({ ...c, unavailable: [{ knob: 'temp_file_limit', reason: 'no' }] }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('substantive reason'), r.out)
})

test('FAIL CLOSED: a knob with no declared ceiling could be raised unreviewed', () => {
  const r = runGate(fixture({ config: (c) => ({ ...c, ceilings: { statement_timeout: 30000 } }) }))
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('declares no maximum'), r.out)
})

test('ADOPTION RAMP: a pre-0.2.0 install with no role settings NOTEs rather than reds', () => {
  const dir = fixture({ mig: migration({ roleSettings: '', quota: '', triggers: '' }) })
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify({ baseVersion: '0.1.3' }))
  const r = runGate(dir)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('arrive in 0.2.0'), r.out)
})

test('REGRESSION: an ancient baseVersion must NOT disarm findings once ceilings exist', () => {
  const dir = fixture({ mig: migration({ extra: "ALTER ROLE authenticated SET temp_file_limit = '256MB';" }) })
  mkdirSync(join(dir, '.harness'), { recursive: true })
  writeFileSync(join(dir, '.harness/manifest.json'), JSON.stringify({ baseVersion: '0.1.0' }))
  const r = runGate(dir)
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes('temp_file_limit'), r.out)
})
