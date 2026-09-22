// THE RETRY MUST NOT BECOME A WAY FOR A RED SCAFFOLD TO PASS.
//
// scripts/ci/pnpm-install-retry.mjs exists because a 169-second npm publish race reddened
// twelve jobs on 2026-09-22. Every property worth having here is about the failures it
// must NOT swallow: a scaffold that genuinely does not install has to exit non-zero on the
// first attempt, exactly as it did before the script existed. So the decision lives in two
// exported functions rather than in the shell, and these tests falsify both.
//
// The transport is deliberately not exercised — the same split as wait-for-workflows.mjs,
// whose gh calls are likewise injected. `run`, `sleep` and `dropMetadata` are parameters
// precisely so the retry's judgement can be tested without a registry, a clock, or pnpm.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyFailure, installWithRetry, TRANSIENT_SIGNATURES } from '../../scripts/ci/pnpm-install-retry.mjs'

// The real output from the 2026-09-22 incident, kept verbatim: a signature list is only
// as good as the string it was written against.
const PUBLISH_RACE = [
  ' ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @supabase/auth-js@2.117.0 while fetching it from https://registry.npmjs.org/',
  '',
  'This error happened while installing the dependencies of @supabase/supabase-js@2.117.0',
].join('\n')

// A scaffold that is actually broken. Nothing here is about the registry.
const REAL_FAILURE = [
  ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json',
].join('\n')

const silent = () => undefined

test('the publish race is recognised, and the package it names is extracted', () => {
  const verdict = classifyFailure(PUBLISH_RACE)
  assert.notEqual(verdict, null)
  assert.equal(verdict?.signature, 'ERR_PNPM_NO_MATCHING_VERSION')
  assert.equal(verdict?.packageName, '@supabase/auth-js')
})

test('a failure with no registry signature classifies as fatal', () => {
  assert.equal(classifyFailure(REAL_FAILURE), null)
  assert.equal(classifyFailure(''), null)
  assert.equal(classifyFailure('Error: EACCES: permission denied'), null)
})

test('every declared signature is a distinct id and actually matches something', () => {
  const ids = TRANSIENT_SIGNATURES.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, 'two signatures share an id')
  for (const s of TRANSIENT_SIGNATURES) {
    assert.ok(s.re instanceof RegExp, `${s.id} carries no matcher`)
  }
})

test('a transient failure is retried, and the second attempt is allowed to succeed', async () => {
  const runs = []
  const dropped = []
  let slept = 0
  const status = await installWithRetry({
    run: (attempt) => {
      runs.push(attempt)
      return attempt === 1 ? { status: 1, output: PUBLISH_RACE } : { status: 0, output: 'done' }
    },
    sleep: async (ms) => {
      slept += ms
    },
    dropMetadata: (pkg) => {
      dropped.push(pkg)
    },
    log: silent,
  })
  assert.equal(status, 0)
  assert.deepEqual(runs, [1, 2])
  assert.deepEqual(dropped, ['@supabase/auth-js'], 'the failing package was not dropped from the metadata cache')
  assert.ok(slept > 0, 'the retry did not wait for the registry to settle')
})

test('CANARY: a real failure is NOT retried — one attempt, original status, no waiting', async () => {
  const runs = []
  let slept = 0
  const status = await installWithRetry({
    run: (attempt) => {
      runs.push(attempt)
      return { status: 9, output: REAL_FAILURE }
    },
    sleep: async (ms) => {
      slept += ms
    },
    dropMetadata: () => undefined,
    log: silent,
  })
  assert.equal(status, 9, 'the original exit status did not survive')
  assert.deepEqual(runs, [1], 'a non-registry failure was retried — the lane can now go green on a broken scaffold')
  assert.equal(slept, 0)
})

test('CANARY: a transient failure that never clears still ends red, bounded by the attempt count', async () => {
  const runs = []
  const status = await installWithRetry({
    run: (attempt) => {
      runs.push(attempt)
      return { status: 1, output: PUBLISH_RACE }
    },
    sleep: async () => undefined,
    dropMetadata: () => undefined,
    attempts: 3,
    log: silent,
  })
  assert.equal(status, 1, 'an install that never succeeded reported success')
  assert.deepEqual(runs, [1, 2, 3], 'the retry was not bounded by attempts')
})
