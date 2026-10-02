// supabase/functions/delete-account/handler.ts — everything the delete-account function
// DECIDES: which key it runs with, who the caller is, and the order in which the caller's
// data leaves. index.ts is only the Deno.serve shell around it.
//
// WHY THE SPLIT (1.1.0). index.ts imports a jsr: specifier and calls Deno.serve as it loads,
// so no Node-side runner can import it: vitest cannot run it, coverage cannot measure it,
// the mutation lane cannot mutate it, and `tsc -b` never reaches supabase/. Through 1.0.x
// that meant the one file in the tree that holds the key which bypasses row security, and
// whose header says one misordering cannot be recovered from, was checked by review alone.
// This file takes its clients (`connect`) and its environment (`env`) as parameters and
// names no Deno global and no jsr:/npm: specifier, so handler.test.ts runs it under vitest
// in plain Node, the unit floor measures it, and the mutation lane mutates it. Its one
// import is TYPE-ONLY, so no runtime ever resolves it: Node erases it, and Deno resolves
// it through deno.json. tools/check-edge-functions.mjs runs `deno check` on index.ts,
// which reaches this file, against that deno.json and the frozen deno.lock beside it, so
// every call below is typed against the exact supabase-js version the function deploys.
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
// handler.test.ts holds this order: it goes red on a handler with steps 3 and 4 swapped.
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

import type { SupabaseClient } from '@supabase/supabase-js'

/** Reads one environment variable. index.ts passes `(name) => Deno.env.get(name)`. */
export type EnvReader = (name: string) => string | undefined

/** Where the handler writes its diagnostics. Defaults to console.error. */
export type Log = (message: string) => void

export interface ClientOptions {
  readonly global?: { readonly headers: Record<string, string> }
  readonly auth: { readonly persistSession: boolean; readonly autoRefreshToken: boolean }
}

/** Builds a client. index.ts passes supabase-js's createClient. */
export type Connect = (url: string, key: string, options: ClientOptions) => SupabaseClient

export interface Deps {
  readonly env: EnvReader
  readonly connect: Connect
  readonly log?: Log
}

// Neither client keeps a session: each request authenticates afresh from its own token.
const NO_SESSION = { persistSession: false, autoRefreshToken: false } as const

// The mobile client invokes this through supabase-js (`functions.invoke`), which
// sends an OPTIONS preflight; the web surface may too. Answer it, and echo the
// caller's Authorization on the actual call only.
export const CORS_HEADERS: Readonly<Record<string, string>> = {
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

// TWO GENERATIONS OF KEY NAMES, and this reads both — in that order. The current keys
// (`sb_publishable_…` / `sb_secret_…`) arrive as SUPABASE_PUBLISHABLE_KEYS and
// SUPABASE_SECRET_KEYS, which are JSON OBJECTS KEYED BY NAME rather than plain strings;
// the CLI's local stack supplies the singular SUPABASE_PUBLISHABLE_KEY /
// SUPABASE_SECRET_KEY; the legacy JWT keys arrive as SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY.
//
// WHY THE LEGACY-ONLY READ WAS A BUG, stated precisely rather than dramatically. Legacy
// and new keys work simultaneously today and legacy keys stay valid "until you explicitly
// disable them" — so this function is not broken on a stock project right now. What it
// was, was one deliberate act away from broken: disabling legacy keys is the step
// Supabase's own migration guide asks for, they are deprecated by the end of 2026, and
// the rest of this template had ALREADY moved (`isSecretKey`, the `sb_secret_` prefix
// guard in packages/platform/supabase, NEXT_PUBLIC_SUPABASE_PUBLISHABLE). This file was
// the last holdout, and the thing it would take down is the ONLY delivered erase path —
// which Apple 5.1.1(v) makes a store-review requirement, so it fails at review, not in a
// log. The `expo-policy` gate certifies this function EXISTS; nothing certifies that the
// names it reads are still injected, and that gap is what this read closes.
//
// verify_jwt = true is UNAFFECTED and stays on. It inspects the Authorization header,
// which carries the caller's own session JWT (supabase-js sends the session token there
// and the project key on `apikey`). Only a caller with no session would put a key on
// Authorization, and a publishable key rejected as "not a JWT" is the 401 this function
// wants anyway.
// SOURCE: https://supabase.com/docs/guides/functions/secrets (default secrets; the new
// keys are JSON objects keyed by name) · https://supabase.com/docs/guides/functions/auth-headers

/**
 * Read an API key across both generations: the JSON-object form first, then the CLI's
 * singular form, then the legacy JWT name.
 *
 * When the object form carries no `default` entry it is used ONLY if it holds exactly one
 * key. Picking an arbitrary entry out of several would silently choose which authority
 * this function runs with, and for the elevated client that is the one decision that must
 * never be made by iteration order.
 */
export function readKey(
  env: EnvReader,
  names: { readonly object: string; readonly singular: string; readonly legacy: string },
  log: Log,
): string | undefined {
  const raw = env(names.object)
  if (raw) {
    const chosen = chooseFromObject(raw, names.object, log)
    if (chosen !== undefined) return chosen
  }
  return env(names.singular) ?? env(names.legacy)
}

/** The key the JSON-object form names, or undefined when it names none unambiguously. */
function chooseFromObject(raw: string, name: string, log: Log): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    log(`delete-account: ${name} is set but is not valid JSON — ignoring it`)
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const byName = parsed as Record<string, unknown>
  const named = byName.default
  if (typeof named === 'string' && named !== '') return named
  const values = Object.values(byName).filter((v): v is string => typeof v === 'string')
  if (values.length === 1 && values[0] !== '') return values[0]
  log(
    `delete-account: ${name} holds ${String(values.length)} key(s) and none named 'default' — refusing to pick one by iteration order`,
  )
  return undefined
}

/**
 * The request handler. The environment is read ONCE, when index.ts builds the handler at
 * cold start, so a missing secret is logged on every request rather than discovered late.
 */
export function createDeleteAccountHandler(deps: Deps): (req: Request) => Promise<Response> {
  const log =
    deps.log ??
    ((message: string) => {
      console.error(message)
    })
  const url = deps.env('SUPABASE_URL')
  const publishableKey = readKey(
    deps.env,
    {
      object: 'SUPABASE_PUBLISHABLE_KEYS',
      singular: 'SUPABASE_PUBLISHABLE_KEY',
      legacy: 'SUPABASE_ANON_KEY',
    },
    log,
  )
  const secretKey = readKey(
    deps.env,
    {
      object: 'SUPABASE_SECRET_KEYS',
      singular: 'SUPABASE_SECRET_KEY',
      legacy: 'SUPABASE_SERVICE_ROLE_KEY',
    },
    log,
  )

  return async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

    if (!url || !publishableKey || !secretKey) {
      // A misconfigured deployment must not read as a successful deletion. The message
      // names BOTH generations, because the likeliest cause of an absent key here is a
      // project that has disabled its legacy keys and expects the new names to be read.
      log(
        'delete-account: missing SUPABASE_URL, or a publishable key (SUPABASE_PUBLISHABLE_KEYS / SUPABASE_PUBLISHABLE_KEY / SUPABASE_ANON_KEY), or a secret key (SUPABASE_SECRET_KEYS / SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY)',
      )
      return json({ error: 'server_misconfigured' }, 500)
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'unauthorized' }, 401)

    // Resolve the caller's id from THEIR token — a fresh verification, not a trust
    // of the gateway's. This client carries no elevated authority.
    const caller = deps.connect(url, publishableKey, {
      global: { headers: { Authorization: authHeader } },
      auth: NO_SESSION,
    })
    const { data: userData, error: userErr } = await caller.auth.getUser()
    if (userErr || !userData.user) return json({ error: 'unauthorized' }, 401)

    // The elevated client. Its ENTIRE reach over application data is
    // `GRANT SELECT, DELETE ON public.orgs` (migration 20260201000200) — it holds
    // nothing on memberships, invitations, notes or profiles, because those rows
    // leave by FK cascade and referential-integrity actions bypass row security on
    // their own.
    const admin = deps.connect(url, secretKey, { auth: NO_SESSION })
    return deleteCaller(admin, userData.user.id, log)
  }
}

/** Steps 1-4 for a caller whose id came from their own verified token. */
async function deleteCaller(admin: SupabaseClient, userId: string, log: Log): Promise<Response> {
  if (!(await sweepPersonalOrg(admin, userId, log))) {
    return json({ error: 'deletion_failed' }, 500)
  }

  // ── step 4: the one irreversible call ─────────────────────────────────────
  // `shouldSoftDelete` defaults to false → a HARD delete, which removes the
  // auth.users row, cascades public.profiles, and revokes every remaining seat.
  // A soft delete would tombstone the identity and leave the seats live, so it
  // is deliberately not used.
  const { error: deleteErr } = await admin.auth.admin.deleteUser(userId)
  if (deleteErr) {
    log(`delete-account: admin.deleteUser failed for ${userId}: ${deleteErr.message}`)
    return json({ error: 'deletion_failed' }, 500)
  }

  return json({ ok: true }, 200)
}

/** Steps 1-3. True only when the caller's personal org is VERIFIABLY gone. */
async function sweepPersonalOrg(admin: SupabaseClient, userId: string, log: Log): Promise<boolean> {
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
    log(`delete-account: personal-org lookup failed for ${userId}: ${beforeErr.message}`)
    return false
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
    log(`delete-account: personal-org sweep failed for ${userId}: ${sweepErr.message}`)
    return false
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
    log(
      `delete-account: personal-org sweep unverified for ${userId} ` +
        `(expected ${String(expected)}, swept ${String(sweptCount)}, remaining ${String(after?.length ?? '?')}` +
        `${afterErr ? `, recheck failed: ${afterErr.message}` : ''}) — ` +
        'refusing to delete the auth user, because created_by is ON DELETE SET NULL ' +
        'and deleting it now would orphan the org beyond recovery',
    )
    return false
  }
  return true
}
