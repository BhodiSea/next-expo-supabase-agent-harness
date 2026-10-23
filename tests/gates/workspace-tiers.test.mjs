// The workspace tiers and walls (template/base/tools/lib/workspace-tiers.mjs, 2.1.0, #186),
// moved out of tools/check-workspace-deps.mjs so the boundaries gate and the sweep's home()
// read one copy. tests/gates/check-boundaries.test.mjs holds the gate's messages and verdicts
// unchanged; this file holds the library's own answers, including the ones only home() asks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mayDepend,
  projectCensusProblems,
  projectSanctionedOf,
  readCensus,
  readProjectCensus,
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

// #160: the seeded project census joins the union here, and only here, so the boundaries gate's
// two consumers and the sweep cannot disagree about what a project sanctioned.
const PROJECT = (entries) => JSON.stringify({ comment: 'x', entries })
const OWNED = '{"sanctioned":[{"package":"@app/notes","reason":"r"}]}'

test('workspace-tiers: the project census reads absent as empty and refuses a broken file', () => {
  inTree({}, () => assert.deepEqual(readProjectCensus(), { entries: [], error: null }))
  inTree({ 'tools/exports-walls.project.json': '{ not json' }, () =>
    assert.match(readProjectCensus().error ?? '', /not valid JSON/),
  )
  inTree({ 'tools/exports-walls.project.json': '{"sanctioned":[]}' }, () =>
    assert.match(readProjectCensus().error ?? '', /"entries" ARRAY/),
  )
  inTree({ 'tools/exports-walls.project.json': PROJECT([{ package: '@app/probe', reason: 'r' }]) }, () =>
    assert.deepEqual(readProjectCensus(), { entries: [{ package: '@app/probe', reason: 'r' }], error: null }),
  )
})

test('workspace-tiers: only well-shaped project entries sanction a package', () => {
  const entries = [
    { package: '@app/probe', reason: 'r' },
    { package: '@app/blank', reason: ' ' },
    { package: 7, reason: 'r' },
    null,
  ]
  assert.deepEqual([...projectSanctionedOf(entries)], ['@app/probe'])
})

test('workspace-tiers: readCensus is the union of the owned and the project census', () => {
  inTree({ 'tools/exports-walls.json': OWNED, 'tools/exports-walls.project.json': PROJECT([{ package: '@app/probe', reason: 'r' }]) }, () =>
    assert.deepEqual([...readCensus()].sort(), ['@app/notes', '@app/probe']),
  )
  inTree({ 'tools/exports-walls.json': OWNED, 'tools/exports-walls.project.json': '{ broken' }, () =>
    assert.deepEqual([...readCensus()], ['@app/notes']),
  )
})

test('workspace-tiers: the project census is closed: a vertical, a reason, no repeat of either file', () => {
  const owned = new Set(['@app/notes'])
  const verticals = new Set(['@app/notes', '@app/probe'])
  const problems = (entries) => projectCensusProblems(entries, owned, verticals)
  assert.deepEqual(problems([{ package: '@app/probe', reason: 'r' }]), [])
  assert.match(problems([{ package: '@app/probe', reason: '' }]).join(), /non-empty/)
  assert.match(problems(['@app/probe']).join(), /non-empty/)
  assert.match(problems([{ package: '@app/errors', reason: 'r' }]).join(), /only packages\/verticals\/\* may be sanctioned here/)
  assert.match(problems([{ package: '@app/notes', reason: 'r' }]).join(), /tools\/exports-walls\.json already sanctions/)
  assert.match(
    problems([{ package: '@app/probe', reason: 'r' }, { package: '@app/probe', reason: 'r' }]).join(),
    /more than once/,
  )
})
