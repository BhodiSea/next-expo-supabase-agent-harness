// The workspace tiers and walls (template/base/tools/lib/workspace-tiers.mjs, 2.1.0, #186),
// moved out of tools/check-workspace-deps.mjs so the boundaries gate and the sweep's home()
// read one copy. tests/gates/check-boundaries.test.mjs holds the gate's messages and verdicts
// unchanged; this file holds the library's own answers, including the ones only home() asks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mayDepend,
  readCensus,
  sanctionedOf,
  tierOf,
  workspaceKind,
} from '../../template/base/tools/lib/workspace-tiers.mjs'
import { inTree } from './helpers/single-home.mjs'

const CENSUS = new Set(['@app/notes'])
const mobile = { name: 'mobile', kind: 'mobile' }
const web = { name: 'web', kind: 'web' }

test('workspace-tiers: tiers and kinds by directory', () => {
  assert.equal(tierOf('verticals/notes'), 'vertical')
  assert.equal(tierOf('shared/concept'), 'shared')
  assert.equal(tierOf('platform/errors'), 'platform')
  assert.equal(tierOf('api'), 'other')
  assert.equal(workspaceKind('apps/mobile'), 'mobile')
  assert.equal(workspaceKind('apps/web'), 'web')
  assert.equal(workspaceKind('packages/verticals/notes'), 'vertical')
  assert.equal(workspaceKind('packages/contracts'), 'other')
  assert.equal(workspaceKind('supabase'), 'other')
})

test('workspace-tiers: the mobile wall', () => {
  assert.equal(mayDepend(mobile, { name: '@app/api', tier: 'other' }, CENSUS), 'mobile-api-runtime')
  assert.equal(mayDepend(mobile, { name: '@app/design-system', tier: 'other' }, CENSUS), 'mobile-web-only')
  assert.equal(mayDepend(mobile, { name: '@app/concept', tier: 'shared' }, CENSUS), 'mobile-unsanctioned')
  assert.equal(mayDepend(mobile, { name: '@app/notes', tier: 'vertical' }, CENSUS), null)
  assert.equal(mayDepend(mobile, { name: '@app/errors', tier: 'platform' }, CENSUS), null)
  assert.equal(mayDepend(mobile, { name: '@app/design-system-native', tier: 'other' }, CENSUS), null)
})

test("workspace-tiers: web's design-system wall, and web may take a shared package", () => {
  assert.equal(mayDepend(web, { name: '@app/design-system-native', tier: 'other' }, CENSUS), 'web-native-ds')
  assert.equal(mayDepend(web, { name: '@app/concept', tier: 'shared' }, CENSUS), null)
})

test('workspace-tiers: verticals never into verticals, shared never into verticals, a package never into itself', () => {
  const notes = { name: '@app/notes', kind: 'vertical' }
  assert.equal(mayDepend(notes, { name: '@app/tasks', tier: 'vertical' }, CENSUS), 'vertical-vertical')
  assert.equal(mayDepend({ name: '@app/concept', kind: 'shared' }, { name: '@app/notes', tier: 'vertical' }, CENSUS), 'shared-vertical')
  assert.equal(mayDepend(notes, { name: '@app/concept', tier: 'shared' }, CENSUS), null)
  assert.equal(mayDepend(notes, { name: '@app/notes', tier: 'vertical' }, CENSUS), null)
})

test('workspace-tiers: the census reads its sanctioned packages; absent or broken reads empty', () => {
  assert.deepEqual(
    [...sanctionedOf({ sanctioned: [{ package: '@app/notes' }, { package: 7 }, null] })],
    ['@app/notes'],
  )
  assert.equal(sanctionedOf(null).size, 0)
  inTree({}, () => assert.equal(readCensus().size, 0))
  inTree({ 'tools/exports-walls.json': '{ not json' }, () => assert.equal(readCensus().size, 0))
  inTree({ 'tools/exports-walls.json': '{"sanctioned":[{"package":"@app/notes"}]}' }, () =>
    assert.deepEqual([...readCensus()], ['@app/notes']),
  )
})
