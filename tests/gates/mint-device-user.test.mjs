// template/base/tools/ci/mint-device-user.mjs — the identity the on-device mutation journey signs
// in as. Pinned with a scripted fetch: the three-call choreography (admin createUser
// with email_confirm → password grant AS the user → ensure_personal_org under the
// user's token, never the service role), the idempotent already-registered branch,
// and fail-loud on every other refusal. What no repo test can prove — GoTrue and
// PostgREST honouring those calls — is the device lane's job (the harness's maestro-smoke
// runs this shipped copy from a rendered scaffold; the consumer's mobile-e2e runs it too).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mintDeviceUser } from '../../template/base/tools/ci/mint-device-user.mjs'

const BASE = {
  url: 'http://127.0.0.1:54321/',
  serviceRoleKey: 'service-role-key',
  anonKey: 'anon-key',
  email: 'device@example.com',
  password: 'device-pw-1',
}

/** A scripted fetch: answers per URL suffix, records every call. */
function scriptedFetch(answers) {
  const calls = []
  const fetch = (input, init = {}) => {
    calls.push({ url: input, method: init.method, headers: init.headers ?? {}, body: init.body })
    const key = Object.keys(answers).find((k) => input.includes(k))
    if (key === undefined) return Promise.reject(new Error(`unscripted url ${input}`))
    const [status, body] = answers[key]
    return Promise.resolve({ status, text: () => Promise.resolve(body) })
  }
  return { fetch, calls }
}

test('mints the user, signs in AS the user, provisions the personal org under the USER token', async () => {
  const { fetch, calls } = scriptedFetch({
    '/auth/v1/admin/users': [200, JSON.stringify({ id: 'user-1' })],
    '/auth/v1/token?grant_type=password': [200, JSON.stringify({ access_token: 'user-jwt' })],
    '/rest/v1/rpc/ensure_personal_org': [200, JSON.stringify('org-1')],
  })
  const out = await mintDeviceUser({ ...BASE, fetch })
  assert.deepEqual(out, { userId: 'user-1', orgId: 'org-1' })
  assert.equal(calls.length, 3)
  // 1. admin createUser: service role on BOTH headers, email confirmed (no round-trip).
  assert.ok(calls[0].url.startsWith('http://127.0.0.1:54321/auth/v1/admin/users'), calls[0].url)
  assert.equal(calls[0].headers.apikey, 'service-role-key')
  assert.equal(calls[0].headers.authorization, 'Bearer service-role-key')
  assert.deepEqual(JSON.parse(calls[0].body), {
    email: 'device@example.com',
    password: 'device-pw-1',
    email_confirm: true,
  })
  // 2. password grant with the ANON key — the user's own sign-in, not an admin act.
  assert.equal(calls[1].headers.apikey, 'anon-key')
  assert.equal(calls[1].headers.authorization, undefined)
  // 3. ensure_personal_org under the USER's token: auth.uid() must be the user, or the
  //    org is attributed to nobody (GoTrue's own reason for refusing a trigger here).
  assert.equal(calls[2].headers.apikey, 'anon-key')
  assert.equal(calls[2].headers.authorization, 'Bearer user-jwt')
  assert.ok(!calls[2].headers.authorization.includes('service-role'), 'never the service role')
})

test('an already-registered user is fine (idempotent on a warm local stack) — userId null, org still provisioned', async () => {
  const { fetch, calls } = scriptedFetch({
    '/auth/v1/admin/users': [
      422,
      JSON.stringify({
        code: 422,
        msg: 'A user with this email address has already been registered',
      }),
    ],
    '/auth/v1/token?grant_type=password': [200, JSON.stringify({ access_token: 'user-jwt' })],
    '/rest/v1/rpc/ensure_personal_org': [200, '"org-1"'],
  })
  const out = await mintDeviceUser({ ...BASE, fetch })
  assert.deepEqual(out, { userId: null, orgId: 'org-1' })
  assert.equal(calls.length, 3)
})

test('every other refusal is LOUD, naming the call: createUser 401, password grant 400, rpc 404', async () => {
  const c1 = scriptedFetch({ '/auth/v1/admin/users': [401, '{"msg":"invalid JWT"}'] })
  await assert.rejects(mintDeviceUser({ ...BASE, fetch: c1.fetch }), /createUser failed \(401\)/)
  assert.equal(c1.calls.length, 1, 'stops at the first failure')

  const c2 = scriptedFetch({
    '/auth/v1/admin/users': [200, '{"id":"user-1"}'],
    '/auth/v1/token?grant_type=password': [400, '{"error":"invalid_grant"}'],
  })
  await assert.rejects(
    mintDeviceUser({ ...BASE, fetch: c2.fetch }),
    /password grant failed \(400\)/,
  )

  const c3 = scriptedFetch({
    '/auth/v1/admin/users': [200, '{"id":"user-1"}'],
    '/auth/v1/token?grant_type=password': [200, '{"access_token":"user-jwt"}'],
    '/rest/v1/rpc/ensure_personal_org': [404, '{"message":"function not found"}'],
  })
  await assert.rejects(
    mintDeviceUser({ ...BASE, fetch: c3.fetch }),
    /ensure_personal_org failed \(404\)/,
  )

  // A grant that "succeeds" without a token is a failure too — never a silent empty bearer.
  const c4 = scriptedFetch({
    '/auth/v1/admin/users': [200, '{"id":"user-1"}'],
    '/auth/v1/token?grant_type=password': [200, '{}'],
  })
  await assert.rejects(mintDeviceUser({ ...BASE, fetch: c4.fetch }), /no access_token/)
})
