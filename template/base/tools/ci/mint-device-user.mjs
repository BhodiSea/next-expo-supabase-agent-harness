#!/usr/bin/env node
// tools/ci/mint-device-user.mjs — mint the identity the on-device MUTATION journey
// signs in as, and provision its personal org, against the local Supabase stack the
// device lane started (the consumer's mobile-e2e job; the harness's own maestro-smoke).
//
// WHY THIS EXISTS (1.0.0). maestro/journeys/mutation.yaml was written against the
// inherited harness's __DEV__ stub authority: tap the empty sign-in form and a dev
// user was minted for you. Supabase Auth replaced that authority releases ago, the
// mobile sign-in became a real email/password form, and the journey kept tapping an
// empty form — every nightly device lane since has stopped at "Enter an email
// address." (the failure hierarchy says exactly that). Nothing at agent time could
// see it: the journey runs only on the emulator. So the lane now mints a real user
// the way tests/rls/db-context.ts mints its tenants (admin createUser + email_confirm,
// then ensure_personal_org AS THAT USER — GoTrue inserts as supabase_auth_admin where
// auth.uid() is NULL, so a trigger cannot attribute the org, and the mobile app has no
// provisioning seam of its own; without the seat, notes.create resolves no acting org),
// and hands the credentials to Maestro through `check-e2e-device.mjs --env`.
//
// PURE FETCH, NO supabase-js: it runs from the repo root before any workspace's
// node_modules is a given (the harness's own selftest runs THIS shipped copy from a
// freshly rendered scaffold), and GoTrue's admin REST and PostgREST's rpc endpoint are
// the same three calls the SDK would make.
//   POST {url}/auth/v1/admin/users            (apikey + Bearer service-role)
//   POST {url}/auth/v1/token?grant_type=password (apikey anon)
//   POST {url}/rest/v1/rpc/ensure_personal_org (apikey anon + Bearer user token)
//
// IDEMPOTENT on the user: a 422 "already been registered" from createUser is fine —
// the CI stack is fresh per job, but a developer re-running the lane locally against
// a warm stack must not have to reset the database to get past this script.
//
// usage: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… NEXT_PUBLIC_SUPABASE_PUBLISHABLE=… \
//          node tools/ci/mint-device-user.mjs <email> <password>
//        (EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_PUBLISHABLE are accepted for the
//        URL and the anon key — the device lane publishes those for the bundle anyway;
//        the service-role key has no public spelling and must be published for this step.)
// SOURCE: tests/rls/db-context.ts (the identity-minting precedent)
// SOURCE: tools/ci/device-lane.sh (the caller — the mutation journey's preconditions)

import { pathToFileURL } from 'node:url'

/**
 * @typedef {(input: string, init?: { method?: string, headers?: Record<string, string>, body?: string }) => Promise<{ status: number, text: () => Promise<string> }>} FetchLike
 */

/**
 * @param {{ url: string, serviceRoleKey: string, anonKey: string, email: string, password: string, fetch: FetchLike }} p
 * @returns {Promise<{ userId: string | null, orgId: string }>}
 */
export async function mintDeviceUser({ url, serviceRoleKey, anonKey, email, password, fetch }) {
  const base = url.replace(/\/+$/, '')
  const json = (headers) => ({ 'content-type': 'application/json', ...headers })

  // 1. Create (or find) the user, email confirmed so the password grant works.
  const created = await fetch(`${base}/auth/v1/admin/users`, {
    method: 'POST',
    headers: json({ apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` }),
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  const createdText = await created.text()
  let userId = null
  if (created.status >= 200 && created.status < 300) {
    userId = String(JSON.parse(createdText).id ?? '') || null
  } else if (!(created.status === 422 && /already/i.test(createdText))) {
    throw new Error(`createUser failed (${String(created.status)}): ${createdText.slice(0, 300)}`)
  }

  // 2. Sign in AS the user — the org must be provisioned under auth.uid(), never as
  //    the service role.
  const signedIn = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: json({ apikey: anonKey }),
    body: JSON.stringify({ email, password }),
  })
  const signedInText = await signedIn.text()
  if (signedIn.status < 200 || signedIn.status >= 300) {
    throw new Error(
      `password grant failed (${String(signedIn.status)}): ${signedInText.slice(0, 300)}`,
    )
  }
  const accessToken = String(JSON.parse(signedInText).access_token ?? '')
  if (accessToken === '') throw new Error('password grant returned no access_token')

  // 3. The personal org — idempotent by construction (the RPC's own contract).
  const provisioned = await fetch(`${base}/rest/v1/rpc/ensure_personal_org`, {
    method: 'POST',
    headers: json({ apikey: anonKey, authorization: `Bearer ${accessToken}` }),
    body: '{}',
  })
  const provisionedText = await provisioned.text()
  if (provisioned.status < 200 || provisioned.status >= 300) {
    throw new Error(
      `ensure_personal_org failed (${String(provisioned.status)}): ${provisionedText.slice(0, 300)}`,
    )
  }
  const orgId = String(JSON.parse(provisionedText) ?? '').replace(/^"|"$/g, '')
  if (orgId === '') throw new Error('ensure_personal_org returned no org id')
  return { userId, orgId }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [email, password] = process.argv.slice(2)
  const url =
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.EXPO_PUBLIC_SUPABASE_URL ??
    ''
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE ??
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE ??
    ''
  const missing = [
    ['<email>', email],
    ['<password>', password],
    ['SUPABASE_URL (or NEXT_PUBLIC_/EXPO_PUBLIC_SUPABASE_URL)', url],
    ['SUPABASE_SERVICE_ROLE_KEY', serviceRoleKey],
    ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE (or EXPO_PUBLIC_SUPABASE_PUBLISHABLE)', anonKey],
  ]
    .filter(([, v]) => v === undefined || v === '')
    .map(([k]) => k)
  if (missing.length > 0) {
    console.error(`mint-device-user: missing ${missing.join(', ')}`)
    process.exit(2)
  }
  try {
    const { userId, orgId } = await mintDeviceUser({
      url,
      serviceRoleKey,
      anonKey,
      email: String(email),
      password: String(password),
      fetch: globalThis.fetch,
    })
    console.log(
      `mint-device-user: OK — ${String(email)} ${userId === null ? 'already existed' : `created (${userId})`}; personal org ${orgId}`,
    )
  } catch (e) {
    console.error(`mint-device-user: FAIL — ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
