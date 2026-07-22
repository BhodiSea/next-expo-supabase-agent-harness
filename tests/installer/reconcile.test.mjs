// Unit tests for the pure drift-classification decision table
// (installer/lib/reconcile.mjs). classifyDrift backs both of update's
// reconcile loops (plan sweep and refresh-seeded), so every one of the six
// decisions is pinned here, plus the no-provenance and Buffer/string
// input-shape contracts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDrift } from '../../installer/lib/reconcile.mjs'
import { sha256 } from '../../installer/lib/manifest.mjs'

const PRISTINE = 'pristine content\n'
const INCOMING = 'incoming content\n'
const TUNED = 'locally tuned content\n'

test('absent destination -> create (current === null wins over everything)', () => {
  assert.equal(
    classifyDrift({ current: null, recordedSha: sha256(PRISTINE), incoming: INCOMING }),
    'create',
  )
  // force does not change the classification of an absent file
  assert.equal(classifyDrift({ current: null, incoming: INCOMING, force: true }), 'create')
})

test('unmodified and incoming identical -> skip-same', () => {
  assert.equal(
    classifyDrift({
      current: Buffer.from(PRISTINE),
      recordedSha: sha256(PRISTINE),
      incoming: PRISTINE,
    }),
    'skip-same',
  )
})

test('unmodified and incoming differs -> update-clean', () => {
  assert.equal(
    classifyDrift({
      current: Buffer.from(PRISTINE),
      recordedSha: sha256(PRISTINE),
      incoming: INCOMING,
    }),
    'update-clean',
  )
  // force is irrelevant on the unmodified path — still a clean update
  assert.equal(
    classifyDrift({
      current: Buffer.from(PRISTINE),
      recordedSha: sha256(PRISTINE),
      incoming: INCOMING,
      force: true,
    }),
    'update-clean',
  )
})

test('modified but already matching incoming -> record-only', () => {
  assert.equal(
    classifyDrift({
      current: Buffer.from(INCOMING), // hand-applied fix, drifted from record
      recordedSha: sha256(PRISTINE),
      incoming: INCOMING,
    }),
    'record-only',
  )
  // record-only outranks force: no reason to overwrite identical content
  assert.equal(
    classifyDrift({
      current: Buffer.from(INCOMING),
      recordedSha: sha256(PRISTINE),
      incoming: INCOMING,
      force: true,
    }),
    'record-only',
  )
})

test('modified with force -> force-overwrite', () => {
  assert.equal(
    classifyDrift({
      current: Buffer.from(TUNED),
      recordedSha: sha256(PRISTINE),
      incoming: INCOMING,
      force: true,
    }),
    'force-overwrite',
  )
})

test('modified without force -> park', () => {
  assert.equal(
    classifyDrift({
      current: Buffer.from(TUNED),
      recordedSha: sha256(PRISTINE),
      incoming: INCOMING,
    }),
    'park',
  )
})

test('missing recordedSha counts as unmodified (no provenance -> never park here)', () => {
  // Same content: skip. Absent key, undefined, and empty string all count.
  assert.equal(
    classifyDrift({ current: Buffer.from(PRISTINE), incoming: PRISTINE }),
    'skip-same',
  )
  assert.equal(
    classifyDrift({ current: Buffer.from(PRISTINE), recordedSha: undefined, incoming: PRISTINE }),
    'skip-same',
  )
  assert.equal(
    classifyDrift({ current: Buffer.from(PRISTINE), recordedSha: '', incoming: PRISTINE }),
    'skip-same',
  )
  // Different content without provenance is a CLEAN update, not a park —
  // refresh-seeded layers its stricter park-on-no-provenance policy on top.
  assert.equal(
    classifyDrift({ current: Buffer.from(PRISTINE), incoming: INCOMING }),
    'update-clean',
  )
  assert.equal(
    classifyDrift({ current: Buffer.from(PRISTINE), incoming: INCOMING, force: true }),
    'update-clean',
  )
})

test('Buffer and string incoming hash identically -> same decision either way', () => {
  const asString = classifyDrift({
    current: Buffer.from(PRISTINE),
    recordedSha: sha256(PRISTINE),
    incoming: INCOMING,
  })
  const asBuffer = classifyDrift({
    current: Buffer.from(PRISTINE),
    recordedSha: sha256(PRISTINE),
    incoming: Buffer.from(INCOMING),
  })
  assert.equal(asString, 'update-clean')
  assert.equal(asBuffer, asString)

  // skip-same must also hold when incoming arrives as a Buffer
  assert.equal(
    classifyDrift({
      current: Buffer.from(PRISTINE),
      recordedSha: sha256(PRISTINE),
      incoming: Buffer.from(PRISTINE),
    }),
    'skip-same',
  )
  // and record-only when the drifted local content matches a Buffer incoming
  assert.equal(
    classifyDrift({
      current: Buffer.from(INCOMING),
      recordedSha: sha256(PRISTINE),
      incoming: Buffer.from(INCOMING),
    }),
    'record-only',
  )
})
