// supabase/functions/delete-account/index.ts — the store-compliance slice's one
// piece of elevated code, and the scaffold's worked example of an Edge Function.
//
// WHAT IT DOES THAT RLS CANNOT. Deleting a row in `auth.users` is a GoTrue admin
// operation: no policy a signed-in user runs under can touch that table, and the
// `service_role` key is the only credential that reaches the admin API. Every
// owned row (`public.profiles`, `public.notes`, …) references `auth.users(id) ON
// DELETE CASCADE`, so removing the identity row sweeps the account in ONE
// statement — the schema is built for exactly this (see supabase/schemas/
// 10_account.sql). There is nothing here to express as a policy or a
// user-context tRPC procedure, which is the bar the functions README sets for a
// function existing at all.
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

  // The one elevated call. `shouldSoftDelete` defaults to false → a HARD delete,
  // which removes the auth.users row and fires the ON DELETE CASCADE that sweeps
  // every owned table. A soft delete would tombstone the identity and leave the
  // owned rows orphaned, so it is deliberately not used.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: deleteErr } = await admin.auth.admin.deleteUser(userId)
  if (deleteErr) {
    console.error(`delete-account: admin.deleteUser failed for ${userId}: ${deleteErr.message}`)
    return json({ error: 'deletion_failed' }, 500)
  }

  return json({ ok: true }, 200)
})
