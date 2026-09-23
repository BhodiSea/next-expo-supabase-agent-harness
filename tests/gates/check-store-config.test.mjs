// Can-fail proofs for the store-metadata module's `store-config` gate
// (template/modules/store-metadata/tools/check-store-config.mjs), the credential-free leg of
// the store-metadata-push workflow.
//
// The gate imports ./lib/gate.mjs, which exists only once `enable` installs the module
// beside the base tools, so each fixture stands the same layout up in tmpdir: the base
// tools/lib, the module tool, and apps/mobile/store.config.json.
//
// The example.com sentinel is the case this file was written for. It must refuse the
// reserved domain in every spelling a listing can carry (URL host, subdomain, port, email
// domain, prose, percent-encoded behind %2F or %40) and must NOT refuse a real domain that
// merely contains the text (counterexample.com, my-example.com, example.community).
// Assertions are exit codes and JSON field paths only: the gate echoes the offending value,
// and a URL or host asserted as a substring is exactly the pattern a scanner would flag.
// Every domain this file authors itself is under the RFC 2606 `.test` TLD.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const MODULE = fileURLToPath(new URL('../../template/modules/store-metadata', import.meta.url))
const TOOL = join(MODULE, 'tools/check-store-config.mjs')
const SHIPPED_CONFIG = join(MODULE, 'apps/mobile/store.config.json')
const GATE_LIB_DIR = fileURLToPath(new URL('../../template/base/tools/lib', import.meta.url))

/** A fully authored listing: no sentinel anywhere, every bound satisfied. */
const authored = () => ({
  configVersion: 0,
  apple: {
    info: {
      'en-US': {
        title: 'Acme Notes',
        subtitle: 'Notes that keep up',
        description: 'Acme Notes keeps your notes in sync across every device you own.',
        keywords: ['notes', 'productivity'],
        supportUrl: 'https://acme.test/support',
        privacyPolicyUrl: 'https://acme.test/privacy',
      },
    },
    review: {
      firstName: 'Ada',
      lastName: 'Reviewer',
      email: 'review@acme.test',
      phone: '+15550100',
      demoRequired: false,
      notes: 'Sign in with the magic link sent to the review inbox; no demo account is needed.',
    },
  },
})

/** @param {string} configText */
function runGate(configText) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-store-config-'))
  cpSync(GATE_LIB_DIR, join(dir, 'tools/lib'), { recursive: true })
  cpSync(TOOL, join(dir, 'tools/check-store-config.mjs'))
  mkdirSync(join(dir, 'apps/mobile'), { recursive: true })
  writeFileSync(join(dir, 'apps/mobile/store.config.json'), configText)
  const env = { ...process.env }
  delete env.HARNESS_REQUIRE_TOOLCHAINS
  const r = spawnSync(process.execPath, ['tools/check-store-config.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    env,
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** An authored listing with one field replaced, as `edit` sets it. */
function runWith(edit) {
  const config = authored()
  edit(config)
  return runGate(JSON.stringify(config, null, 2))
}

const flagged = (out, fieldPath) => out.includes(`${fieldPath}: still carries a scaffold sentinel`)
const EN = 'apple.info.en-US'
/** An edit that sets one en-US listing field. */
const setEn = (field, value) => (c) => {
  c.apple.info['en-US'][field] = value
}

test('RED: the SHIPPED placeholder listing fails, naming every sentinel field', () => {
  const r = runGate(readFileSync(SHIPPED_CONFIG, 'utf8'))
  assert.equal(r.code, 1, r.out)
  for (const fieldPath of [
    `${EN}.supportUrl`,
    `${EN}.privacyPolicyUrl`,
    'apple.review.email',
    `${EN}.title`,
    `${EN}.subtitle`,
    `${EN}.description`,
    'apple.review.notes',
  ]) {
    assert.ok(flagged(r.out, fieldPath), `${fieldPath} must be refused\n${r.out}`)
  }
})

test('GREEN: a fully authored listing passes', () => {
  const r = runWith(() => {})
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^store-config: OK/m)
})

test('RED: example.com is refused in every spelling a listing can carry', () => {
  const cases = [
    ['privacyPolicyUrl', 'https://EXAMPLE.COM/privacy'],
    ['privacyPolicyUrl', 'https://app.example.com/privacy'],
    ['privacyPolicyUrl', 'https://example.com:8443/privacy'],
    ['description', 'Support lives at example.com. Write any time.'],
    // Percent-encoded delimiters: hex digits are label characters, so the boundary alone
    // would let these through. They are the same reserved domain.
    ['marketingUrl', 'https://acme.test/?u=https%3A%2F%2Fexample.com'],
    ['marketingUrl', 'https://acme.test/?to=review%40example.com'],
  ]
  for (const [field, value] of cases) {
    const r = runWith(setEn(field, value))
    assert.equal(r.code, 1, `${field}\n${r.out}`)
    assert.ok(flagged(r.out, `${EN}.${field}`), `${field} must be refused\n${r.out}`)
  }
  const email = runWith((c) => {
    c.apple.review.email = 'ops@example.com'
  })
  assert.equal(email.code, 1, email.out)
  assert.ok(flagged(email.out, 'apple.review.email'), email.out)
})

test('GREEN: a real domain that merely CONTAINS example.com is not the sentinel', () => {
  // counterexample.com, my-example.com and example.community are other registrable domains.
  // An unbounded substring match failed all three, so a listing on one could never push.
  for (const url of [
    'https://counterexample.com/privacy',
    'https://my-example.com/privacy',
    'https://example.community/privacy',
  ]) {
    const r = runWith(setEn('privacyPolicyUrl', url))
    assert.equal(r.code, 0, r.out)
    assert.ok(!flagged(r.out, `${EN}.privacyPolicyUrl`), r.out)
  }
})
