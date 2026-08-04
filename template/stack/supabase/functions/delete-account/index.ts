// supabase/functions/delete-account/index.ts — the store-compliance slice's one
// piece of elevated code, and the scaffold's worked example of an Edge Function.
//
// WHAT IT DOES THAT RLS CANNOT. Deleting a row in `auth.users` is a GoTrue admin
// operation: no policy a signed-in user runs under can touch that table, and the
// `service_role` key is the only credential that reaches the admin API. There is
// nothing here to express as a policy or a user-context tRPC procedure, which is
// the bar the functions README sets for a function existing at all.
//
// WHAT DELETION MEANS UNDER ORG SCOPE. It is no longer one statement. Since the
// org re-scope (docs/adr/20260201-org-scoped-tenancy.md) the data controller for
// `public.notes` is the ORGANIZATION, not the author: `owner_id` is nullable
// attribution with `ON DELETE SET NULL`, so an employee closing their account
// must not delete the company's rows. Deleting the identity row still cascades
// `public.profiles` and revokes every seat (`memberships.user_id` is ON DELETE
// CASCADE). What it does NOT reach is the caller's PERSONAL org — a single-seat
// organization nobody else can join — whose deletion cascades its own
// memberships, invitations and notes. Sweeping that org is this function's
// second job, and it happens FIRST.
//
// WHY THE ORDER IS LOAD-BEARING. `public.orgs.created_by` is `ON DELETE SET
// NULL`. If `deleteUser` ran while a personal org still existed, the FK action
// would null the very column the sweep filters on: the org would become
// permanently unsweepable, and with the auth user gone no retry could even
// authenticate to try again. One misordering is therefore not a retryable
// failure, it is unrecoverable orphaned tenant data. So the sweep runs first and
// is VERIFIED — error and row count both — and any mismatch returns 500 WITHOUT
// calling deleteUser. A caller who sees 500 still has their account and can try
// again; that is the recoverable side of the trade, and it is the side to be on.
//
// WHO IT CAN DELETE. Only the caller, and only themselves. `verify_jwt = true`
// (config.toml) means the platform rejects an unauthenticated request before
// this code runs; the id we delete is read from that verified token via
// getUser(), never from the request body — a caller cannot name someone else.
//
// BLAST RADIUS IF THE KEY LEAKS. The service key is reachable from this one
// deployed process and nowhere else (not the web process, not the mobile
// bundle). It performs exactly one operation: hard-delete the auth user the
// caller's own token identifies. See docs/adr/20260720-account-deletion.md.
//
// SOURCE: supabase/functions/README.md (Edge Functions are the one sanctioned
// home for service-role code) · docs/adr/20260720-account-deletion.md
import { createClient } from 'jsr:@supabase/supabase-js@2'

// Env is injected by the platform; none of it is committed. SUPABASE_URL +
// SUPABASE_ANON_KEY build a client that runs AS THE CALLER (to read their id
// under RLS); SUPABASE_SERVICE_ROLE_KEY builds the admin client that performs
// the deletion. Read once at cold start so a missing secret fails loudly.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

// The mobile client invokes this through supabase-js (`functions.invoke`), which
// sends an OPTIONS preflight; the web surface may too. Answer it, and echo the
// caller's Authorization on the actual call only.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    // A misconfigured deployment must not read as a successful deletion.
    console.error('delete-account: missing SUPABASE_URL / ANON / SERVICE_ROLE env')
    return json({ error: 'server_misconfigured' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)

  // Resolve the caller's id from THEIR token — a fresh verification, not a trust
  // of the gateway's. This client carries no elevated authority.
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userErr } = await caller.auth.getUser()
  if (userErr || !userData.user) return json({ error: 'unauthorized' }, 401)
  const userId = userData.user.id

  // The elevated client. Its ENTIRE reach over application data is
  // `GRANT SELECT, DELETE ON public.orgs` (migration 20260201000200) — it holds
  // nothing on memberships, invitations, notes or profiles, because those rows
  // leave by FK cascade and referential-integrity actions bypass row security on
  // their own.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // ── step 1: what are we about to remove? ───────────────────────────────────
  // Read before write, so "deleted nothing because there was nothing" and
  // "deleted nothing because the grant is missing" are distinguishable. The
  // partial unique index orgs_personal_creator_key makes this at most one row.
  const { data: before, error: beforeErr } = await admin
    .from('orgs')
    .select('id')
    .eq('created_by', userId)
    .eq('kind', 'personal')
  if (beforeErr) {
    console.error(`delete-account: personal-org lookup failed for ${userId}: ${beforeErr.message}`)
    return json({ error: 'deletion_failed' }, 500)
  }
  const expected = before?.length ?? 0

  // ── step 2: sweep, and count what actually went ───────────────────────────
  // `.select()` on a delete returns the rows PostgREST actually removed, which
  // is the only trustworthy row count available here.
  const { data: swept, error: sweepErr } = await admin
    .from('orgs')
    .delete()
    .eq('created_by', userId)
    .eq('kind', 'personal')
    .select('id')
  if (sweepErr) {
    console.error(`delete-account: personal-org sweep failed for ${userId}: ${sweepErr.message}`)
    return json({ error: 'deletion_failed' }, 500)
  }

  // ── step 3: verify, and refuse to proceed on ANY mismatch ─────────────────
  // A silent partial sweep is the failure this whole ordering exists to
  // prevent, so the check is an equality against the pre-count, not a
  // "greater than zero". Re-reading afterwards additionally catches a delete
  // that reported rows while leaving some behind.
  const sweptCount = swept?.length ?? 0
  const { data: after, error: afterErr } = await admin
    .from('orgs')
    .select('id')
    .eq('created_by', userId)
    .eq('kind', 'personal')
  if (afterErr || sweptCount !== expected || (after?.length ?? 0) !== 0) {
    console.error(
      `delete-account: personal-org sweep unverified for ${userId} ` +
        `(expected ${expected}, swept ${sweptCount}, remaining ${after?.length ?? '?'}` +
        `${afterErr ? `, recheck failed: ${afterErr.message}` : ''}) — ` +
        'refusing to delete the auth user, because created_by is ON DELETE SET NULL ' +
        'and deleting it now would orphan the org beyond recovery',
    )
    return json({ error: 'deletion_failed' }, 500)
  }

  // ── step 4: the one irreversible call ─────────────────────────────────────
  // `shouldSoftDelete` defaults to false → a HARD delete, which removes the
  // auth.users row, cascades public.profiles, and revokes every remaining seat.
  // A soft delete would tombstone the identity and leave the seats live, so it
  // is deliberately not used.
  const { error: deleteErr } = await admin.auth.admin.deleteUser(userId)
  if (deleteErr) {
    console.error(`delete-account: admin.deleteUser failed for ${userId}: ${deleteErr.message}`)
    return json({ error: 'deletion_failed' }, 500)
  }

  return json({ ok: true }, 200)
})
