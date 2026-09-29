// The shipped catalog pins the Supabase CLI exactly, and Renovate keeps the pin current
// (1.0.4, #88).
//
// Through 1.0.3 the catalog read `supabase: ^2.34.3` and the scaffold ships no lockfile, so
// every CI run resolved the newest 2.x. That is how CI moved from 2.115.0 to 2.117.0, and
// then to 2.118.0, with no commit, and each move redded an unchanged tree: a pgTAP
// assertion on write grants, then the committed database types (#40). The 1.0.3 CHANGELOG
// said "The Supabase CLI is pinned exactly", which described the Renovate rule, not the
// catalog. An exact pin is only acceptable while something keeps it current (1.0.2
// CHANGELOG), so this file holds both halves: the pin, and the rule that moves it.
//
// It reads two files and nothing else, so it runs unchanged on the Windows leg. Each judge
// is also driven over fixtures that must red, so a judge that can no longer fail is caught
// here and not in a scheduled run.
// SOURCE: template/base/pnpm-workspace.yaml, renovate.json
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { catalogEntry } from '../../installer/lib/migrations.mjs'
import { cmpDotted } from '../../scripts/lib/ramp-sites.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CATALOG = 'template/base/pnpm-workspace.yaml'
// The oldest CLI the shipped tree is proven against. The ADR
// (docs/adr/20260920-authenticated-write-revoke.md) rejects pinning the CLI back to make a
// test pass, so a pin below this is a regression whatever it turns green.
const FLOOR = '2.117.0'
const read = (/** @type {string} */ rel) => readFileSync(join(ROOT, rel), 'utf8')

/**
 * Why a pnpm-workspace.yaml text's `supabase` catalog entry is not an acceptable pin; empty
 * when it is. Reads the entry through `catalogEntry`, the anchor `doctor`'s toolchain report
 * reads the same pin with, so this test and doctor cannot disagree about what the pin is.
 * @param {string} workspaceYaml
 * @returns {string[]}
 */
function pinProblems(workspaceYaml) {
  const value = catalogEntry(workspaceYaml, 'supabase')
  if (value === null) return [`${CATALOG} catalogues no \`supabase\`, so nothing pins the CLI`]
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    return [
      `\`supabase: ${value}\` is not an exact X.Y.Z: the scaffold ships no lockfile, so a range resolves the newest CLI on every fresh install and every CI run`,
    ]
  }
  if (cmpDotted(value, FLOOR) < 0) {
    return [
      `\`supabase: ${value}\` is below ${FLOOR}, the oldest CLI the shipped tree is proven against`,
    ]
  }
  return []
}

/**
 * @typedef {{ matchFileNames?: string[], matchPackageNames?: string[], matchDepNames?: string[],
 *   rangeStrategy?: string, enabled?: boolean, prBodyNotes?: string[] }} PackageRule
 */

/**
 * The packageRule that pins the catalog's CLI, or null.
 * @param {{ packageRules?: PackageRule[] }} renovate
 * @returns {PackageRule | null}
 */
function cliRule(renovate) {
  return (
    (renovate.packageRules ?? []).find(
      (r) => (r.matchFileNames ?? []).includes(CATALOG) && (r.matchPackageNames ?? []).includes('supabase'),
    ) ?? null
  )
}

/**
 * Why a Renovate config does not keep the CLI pin current; empty when it does.
 * @param {{ packageRules?: PackageRule[] }} renovate
 * @returns {string[]}
 */
function ruleProblems(renovate) {
  const rule = cliRule(renovate)
  if (rule === null) {
    return [
      `no packageRule matches \`supabase\` in ${CATALOG}: nothing proposes a CLI bump, so an exact pin goes stale`,
    ]
  }
  const problems = []
  if (rule.rangeStrategy !== 'pin') {
    problems.push(`the Supabase CLI rule's rangeStrategy is ${JSON.stringify(rule.rangeStrategy)}, not "pin"`)
  }
  // Any rule that names the package exactly and turns it off stops the bump PRs, wherever it sits.
  const off = (renovate.packageRules ?? []).filter(
    (r) =>
      r.enabled === false &&
      ((r.matchPackageNames ?? []).includes('supabase') || (r.matchDepNames ?? []).includes('supabase')),
  )
  if (off.length > 0) {
    problems.push('a packageRule naming `supabase` sets enabled: false, so no bump PR ever opens')
  }
  return problems
}

test('the catalog pins the Supabase CLI to an exact version at or above the floor', () => {
  assert.deepEqual(pinProblems(read(CATALOG)), [])
})

test('root renovate.json keeps the catalog CLI pin current, in its own rule', () => {
  assert.deepEqual(ruleProblems(JSON.parse(read('renovate.json'))), [])
})

test("the CLI rule's PR note says what a bump costs and what it re-checks", () => {
  // The hosted app runs no post-upgrade tasks, so the reviewer is the one who regenerates
  // the types and re-checks the upstream issue the auth-posture census deferral names.
  const rule = cliRule(JSON.parse(read('renovate.json')))
  assert.ok(rule, 'precondition: the CLI rule exists')
  const notes = (rule.prBodyNotes ?? []).join('\n')
  assert.match(notes, /types-drift/)
  assert.match(notes, /template\/stack\/packages\/platform\/supabase\/src\/database\.types\.ts/)
  assert.match(notes, /pnpm db:types/)
  assert.match(notes, /auth-posture-cli-census/)
  assert.match(notes, /template\/base\/tools\/deferrals\.json/)
  // The id it names is a live deferral, so the note cannot outlive the row it points at.
  /** @type {{ deferrals: { id: string }[] }} */
  const ledger = JSON.parse(read('template/base/tools/deferrals.json'))
  const ids = ledger.deferrals.map((d) => d.id)
  assert.ok(ids.includes('auth-posture-cli-census'), `deferrals.json ids: ${ids.join(', ')}`)
})

test('the pin judge reds a range, a version below the floor and a missing entry', () => {
  const yaml = (/** @type {string} */ line) =>
    `catalog:\n  '@supabase/supabase-js': ^2.108.0\n${line}\n  zod: ^4.4.3\n`
  assert.match(pinProblems(yaml('  supabase: ^2.34.3 # the CLI')).join(), /not an exact X\.Y\.Z/)
  assert.match(pinProblems(yaml('  supabase: ~2.118.0')).join(), /not an exact X\.Y\.Z/)
  assert.match(pinProblems(yaml('  supabase: 2.118')).join(), /not an exact X\.Y\.Z/)
  assert.match(pinProblems(yaml('  supabase: 2.119.0-beta.5')).join(), /not an exact X\.Y\.Z/)
  assert.match(pinProblems(yaml('  supabase: 2.116.0')).join(), /below 2\.117\.0/)
  assert.match(pinProblems(yaml('  other: 1.0.0')).join(), /catalogues no `supabase`/)
  // The accepted shapes: bare, quoted, commented, and exactly the floor.
  assert.deepEqual(pinProblems(yaml('  supabase: 2.118.0 # exact')), [])
  assert.deepEqual(pinProblems(yaml("  supabase: '2.118.0'")), [])
  assert.deepEqual(pinProblems(yaml('  supabase: 2.117.0')), [])
  assert.deepEqual(pinProblems(yaml('  supabase: 2.117.0').replace(/\n/g, '\r\n')), [], 'CRLF checkout')
})

test('the rule judge reds a missing rule, a non-pin strategy and a disabled package', () => {
  const rule = { matchFileNames: [CATALOG], matchPackageNames: ['supabase'], rangeStrategy: 'pin' }
  assert.deepEqual(ruleProblems({ packageRules: [rule] }), [])
  assert.match(ruleProblems({ packageRules: [] }).join(), /no packageRule matches/)
  assert.match(
    ruleProblems({ packageRules: [{ ...rule, matchFileNames: ['template/**'] }] }).join(),
    /no packageRule matches/,
  )
  assert.match(ruleProblems({ packageRules: [{ ...rule, rangeStrategy: 'bump' }] }).join(), /not "pin"/)
  assert.match(ruleProblems({ packageRules: [{ ...rule, enabled: false }] }).join(), /enabled: false/)
  assert.match(
    ruleProblems({ packageRules: [rule, { matchDepNames: ['supabase'], enabled: false }] }).join(),
    /enabled: false/,
  )
})
