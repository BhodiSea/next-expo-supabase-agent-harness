// The factory's floor-advisories lane (1.1.0, #81): the red-proof for
// scripts/check-floor-advisories.mjs and for hygiene.yml#floor-advisories.
//
// WHAT IT GUARDS. The framework floor in template/base/tools/framework-floor.json and the
// catalog pin in template/base/pnpm-workspace.yaml are what every new scaffold is rendered
// from. Before this lane nothing compared either with a published advisory: the scheduled
// `registers-clockful` job reads only the review DATES, `version-sync` compares the pin with
// the floor and not the floor with a feed, and `factory-sca` scans a lockfile that resolves
// no `next`. So the 2026-08-25 security release sat inside a live review window and was
// noticed only when the window lapsed (the 1.0.2 CHANGELOG entry).
//
// HOW IT IS PROVEN WITHOUT A NETWORK. The script's `--responses=<file>` seam loads recorded
// responses keyed by feed and probe (`osv:next@16.3.3`, `upstream:next`, and `#<token>` for
// a later page), and with it the script sends no request. `--floor=` and `--workspace=` point
// it at fixture files in a mkdtemp directory. Every case below spawns the real script the way
// tests/gates/register-freshness.test.mjs does, so the verdict, the exit code and the printed
// line are what the scheduled job would produce given those feeds. The live half (does the
// feed still answer in this shape) is the job's own, and its anti-vacuity is the canary and
// the recorded-row checks proven red here.
// SOURCE: scripts/check-floor-advisories.mjs · scripts/lib/floor-advisories.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CANARIES,
  catalogPins,
  deriveProbes,
  MAX_PAGES,
  rangeIncludes,
  UPSTREAM_REPOS,
} from '../../scripts/lib/floor-advisories.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts/check-floor-advisories.mjs')

/** @type {string[]} */
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const RECORDED = 'GHSA-rec1-rec1-rec1'
const FRESH = 'GHSA-new1-new1-new1'
const FRESH_CVE = 'CVE-2026-99999'

/** The fixture floor: the real shape, two lines, one recorded row. */
function floorDoc(advisoryIds = [RECORDED]) {
  return {
    packages: {
      next: {
        minPatchByMajor: { 15: '15.5.24', 16: '16.3.3' },
        reviewedOn: '2026-09-20',
        reviewedUntil: '2026-10-19',
        advisories: advisoryIds.map((id) => ({ id, severity: 'High', summary: 'fixture row' })),
      },
    },
  }
}

const WORKSPACE = "packages:\n  - apps/*\nallowBuilds:\n  next: true\ncatalog:\n  # a comment\n  next: 16.3.5\n  react: ^19.2.0\n"

/** @param {string} ghsa @param {string | null} cve @param {string} range @param {Record<string, unknown>} [extra] */
function upstreamAdvisory(ghsa, cve, range, extra = {}) {
  return {
    ghsa_id: ghsa,
    cve_id: cve,
    published_at: '2026-09-24T12:00:00Z',
    withdrawn_at: null,
    vulnerabilities: [{ package: { ecosystem: 'npm', name: 'next' }, vulnerable_version_range: range }],
    ...extra,
  }
}

const EMPTY = { status: 200, body: {} }

/** The clean feed set: nothing on any probe, the canary lit, the recorded row upstream. */
function cleanResponses() {
  return {
    'osv:next@15.5.24': EMPTY,
    'osv:next@16.3.3': EMPTY,
    'osv:next@16.3.5': EMPTY,
    'osv:next@16.2.7': {
      status: 200,
      body: { vulns: [{ id: RECORDED, aliases: [], published: '2026-08-25T00:00:00Z' }] },
    },
    'upstream:next': { status: 200, body: [upstreamAdvisory(RECORDED, null, '>= 16.0.0, < 16.3.3')] },
  }
}

/** @param {string} id @param {Record<string, unknown>} [extra] */
const osvVuln = (id, extra = {}) => ({ id, aliases: [FRESH_CVE], published: '2026-09-25T10:00:00Z', ...extra })

/**
 * Spawn the real script over a fixture directory.
 * @param {{ floor?: unknown, workspace?: string, responses?: unknown, args?: string[] }} [fx]
 */
function run(fx = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'floor-advisories-'))
  made.push(dir)
  const floor = join(dir, 'framework-floor.json')
  const workspace = join(dir, 'pnpm-workspace.yaml')
  const responses = join(dir, 'responses.json')
  writeFileSync(floor, JSON.stringify(fx.floor ?? floorDoc()))
  writeFileSync(workspace, fx.workspace ?? WORKSPACE)
  writeFileSync(responses, JSON.stringify(fx.responses ?? cleanResponses()))
  const args = fx.args ?? [`--responses=${responses}`, `--floor=${floor}`, `--workspace=${workspace}`]
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('the clean feeds pass, and the CLEAN line carries the counts it stands on', () => {
  const r = run()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /FLOOR ADVISORIES: CLEAN/)
  assert.match(r.out, /3 probe\(s\)/)
  assert.match(r.out, /1 canary\(ies\)/)
  assert.match(r.out, /1 recorded row\(s\)/)
})

test('an UNRECORDED advisory on a floor probe fails, naming the id, the feed and the probe', () => {
  const responses = { ...cleanResponses(), 'osv:next@16.3.3': { status: 200, body: { vulns: [osvVuln(FRESH)] } } }
  const r = run({ responses })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, new RegExp(FRESH))
  assert.match(r.out, new RegExp(FRESH_CVE))
  assert.match(r.out, /listed by osv/)
  assert.match(r.out, /next@16\.3\.3 \(floor, 16\.x line\)/)
  assert.doesNotMatch(r.out, /next@15\.5\.24 \(floor/)
  // The dating half of the line, and the remedy.
  assert.match(r.out, /published 2026-09-25 \(osv\), after reviewedOn 2026-09-20/)
  assert.match(r.out, /raise minPatchByMajor and the pin, or record the row/)
  assert.match(r.out, /Move both review dates in the same commit/)
})

test('the same advisory RECORDED under its CVE alias prints a NOTE and passes', () => {
  const responses = { ...cleanResponses(), 'osv:next@16.3.3': { status: 200, body: { vulns: [osvVuln(FRESH)] } } }
  const r = run({ responses, floor: floorDoc([RECORDED, FRESH_CVE]) })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, new RegExp(`NOTE — ${FRESH}`))
  assert.match(r.out, new RegExp(`recorded in the floor as ${FRESH_CVE}`))
  assert.match(r.out, /FLOOR ADVISORIES: CLEAN/)
})

test('a WITHDRAWN advisory passes, from either feed', () => {
  const responses = {
    ...cleanResponses(),
    'osv:next@16.3.3': {
      status: 200,
      body: { vulns: [osvVuln(FRESH, { withdrawn: '2026-09-26T00:00:00Z' })] },
    },
    'upstream:next': {
      status: 200,
      body: [
        upstreamAdvisory(RECORDED, null, '>= 16.0.0, < 16.3.3'),
        upstreamAdvisory('GHSA-wd11-wd11-wd11', null, '< 99.0.0', { withdrawn_at: '2026-09-27T00:00:00Z' }),
      ],
    },
  }
  const r = run({ responses })
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /GHSA-new1|GHSA-wd11/)
})

test('the PIN probe fails on its own, with every floor probe clean', () => {
  const responses = { ...cleanResponses(), 'osv:next@16.3.5': { status: 200, body: { vulns: [osvVuln(FRESH)] } } }
  const r = run({ responses })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /next@16\.3\.5 \(catalog pin\)/)
  assert.doesNotMatch(r.out, /next@16\.3\.3 \(floor/)
})

test('an UPSTREAM advisory whose range covers a probe fails, and one both feeds list is reported once', () => {
  const fresh = upstreamAdvisory(FRESH, FRESH_CVE, '>= 16.0.0, < 16.3.6')
  const responses = {
    ...cleanResponses(),
    'osv:next@16.3.3': { status: 200, body: { vulns: [osvVuln(FRESH)] } },
    'upstream:next': { status: 200, body: [upstreamAdvisory(RECORDED, null, '>= 16.0.0, < 16.3.3'), fresh] },
  }
  const r = run({ responses })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /listed by osv, upstream/)
  assert.match(r.out, /next@16\.3\.3 \(floor, 16\.x line\), next@16\.3\.5 \(catalog pin\)/)
  assert.doesNotMatch(r.out, /next@15\.5\.24 \(floor/)
  // The upstream listing dates it a day earlier than OSV does, and the earlier date wins:
  // that head start is the reason the upstream feed is read at all.
  assert.match(r.out, /published 2026-09-24 \(upstream\)/)
  assert.equal(r.out.match(new RegExp(`- ${FRESH}`, 'g'))?.length, 1, r.out)
})

test('an upstream advisory alone fails too, and one naming another package or ecosystem is ignored', () => {
  const other = upstreamAdvisory('GHSA-oth1-oth1-oth1', null, '< 99.0.0')
  other.vulnerabilities = [
    { package: { ecosystem: 'npm', name: 'react' }, vulnerable_version_range: '< 99.0.0' },
    { package: { ecosystem: 'pip', name: 'next' }, vulnerable_version_range: '< 99.0.0' },
  ]
  const responses = {
    ...cleanResponses(),
    'upstream:next': {
      status: 200,
      body: [upstreamAdvisory(RECORDED, null, '>= 16.0.0, < 16.3.3'), other, upstreamAdvisory(FRESH, null, '= 15.5.24')],
    },
  }
  const r = run({ responses })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /GHSA-new1-new1-new1 listed by upstream/)
  assert.match(r.out, /next@15\.5\.24 \(floor, 15\.x line\)/)
  assert.doesNotMatch(r.out, /GHSA-oth1/)
})

test('an upstream advisory whose RANGE SYNTAX no test covers fails, and does not read as clean', () => {
  for (const range of ['^16.0.0', '16.x', '>= 16.0.0 < 16.3.6', '>= 16.0.0 || < 15.0.0', '']) {
    const responses = {
      ...cleanResponses(),
      'upstream:next': {
        status: 200,
        body: [upstreamAdvisory(RECORDED, null, '>= 16.0.0, < 16.3.3'), upstreamAdvisory(FRESH, null, range)],
      },
    }
    const r = run({ responses })
    assert.equal(r.code, 1, `${range}: ${r.out}`)
    assert.match(r.out, /range syntax no test covers/, range)
    assert.match(r.out, new RegExp(FRESH), range)
  }
  const responses = cleanResponses()
  responses['upstream:next'].body.push({ ...upstreamAdvisory(FRESH, null, 'x'), vulnerabilities: [{ package: { ecosystem: 'npm', name: 'next' }, vulnerable_version_range: null }] })
  assert.equal(run({ responses }).code, 1)
})

test('the range evaluator: each documented operator, a conjunction, a prerelease, and nothing else', () => {
  // The syntax GitHub documents for an advisory's affected versions: `>=`, `>`, `=`, `<=`,
  // `<`, comma-joined (docs.github.com, "Best practices for writing repository security
  // advisories"). Anything else returns null, which the script turns into a failure.
  assert.equal(rangeIncludes('< 16.3.3', '16.3.2'), true)
  assert.equal(rangeIncludes('< 16.3.3', '16.3.3'), false)
  assert.equal(rangeIncludes('<= 16.3.3', '16.3.3'), true)
  assert.equal(rangeIncludes('<= 16.3.3', '16.3.4'), false)
  assert.equal(rangeIncludes('> 16.3.3', '16.3.4'), true)
  assert.equal(rangeIncludes('> 16.3.3', '16.3.3'), false)
  assert.equal(rangeIncludes('>= 16.3.3', '16.3.3'), true)
  assert.equal(rangeIncludes('>= 16.3.3', '16.3.2'), false)
  assert.equal(rangeIncludes('= 16.3.3', '16.3.3'), true)
  assert.equal(rangeIncludes('= 16.3.3', '16.3.4'), false)
  assert.equal(rangeIncludes('>= 16.0.0, < 16.3.3', '16.2.7'), true)
  assert.equal(rangeIncludes('>= 16.0.0, < 16.3.3', '15.5.24'), false)
  assert.equal(rangeIncludes('>=16.0.0,<16.3.3', '16.2.7'), true)
  // A prerelease sorts below its release, as compareVersions has it.
  assert.equal(rangeIncludes('>= 3.4.0-rc.0, <= 3.4.9', '3.4.0'), true)
  assert.equal(rangeIncludes('= 16.0.0-rc-1', '16.0.0-rc-1'), true)
  assert.equal(rangeIncludes('< 16.0.0', '16.0.0-rc-1'), true)
  for (const unknown of ['^16.0.0', '~16.3.0', '16.x', '16.3.3', '< 16.3', '>= 16.0.0 < 16.3.3', '< 1 || > 2', '', null, 7]) {
    assert.equal(rangeIncludes(/** @type {any} */ (unknown), '16.3.3'), null, String(unknown))
  }
})

test('an OSV next_page_token is FOLLOWED, and the second page is judged', () => {
  const responses = {
    ...cleanResponses(),
    'osv:next@16.3.3': { status: 200, body: { vulns: [], next_page_token: 'tok-2' } },
    'osv:next@16.3.3#tok-2': { status: 200, body: { vulns: [osvVuln(FRESH)] } },
  }
  const r = run({ responses })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, new RegExp(`${FRESH} .*next@16\\.3\\.3`))
})

test('an upstream Link to a next page is followed too', () => {
  // The recorded row lives only on page two: a reader that stopped at page one would red on
  // "no recorded row", so a green here is the second page having been read.
  const responses = {
    ...cleanResponses(),
    'upstream:next': { status: 200, body: [], next: 'cursor-2' },
    'upstream:next#cursor-2': { status: 200, body: [upstreamAdvisory(RECORDED, null, '>= 16.0.0, < 16.3.3')] },
  }
  const r = run({ responses })
  assert.equal(r.code, 0, r.out)
})

test('a page count past the CAP fails — a token still unfollowed is not a complete answer', () => {
  const responses = /** @type {Record<string, unknown>} */ (cleanResponses())
  responses['osv:next@16.3.3'] = { status: 200, body: { vulns: [], next_page_token: 't1' } }
  for (let i = 1; i <= MAX_PAGES; i += 1) {
    responses[`osv:next@16.3.3#t${String(i)}`] = { status: 200, body: { vulns: [], next_page_token: `t${String(i + 1)}` } }
  }
  const r = run({ responses })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, new RegExp(`osv:next@16\\.3\\.3: still had a next page after ${String(MAX_PAGES)} page\\(s\\)`))
})

test('a MISSING recorded response fails — the seam never reads silence as "no advisories"', () => {
  const responses = /** @type {Record<string, unknown>} */ (cleanResponses())
  delete responses['osv:next@15.5.24']
  const r = run({ responses })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no recorded response for osv:next@15\.5\.24/)
})

test('every other way a feed can fail to answer is a failure, never "no advisories"', () => {
  /** @type {Array<[string, unknown, RegExp]>} */
  const cases = [
    ['osv:next@16.3.3', { status: 503, body: null }, /osv:next@16\.3\.3: HTTP 503/],
    ['osv:next@16.3.3', { error: 'TimeoutError' }, /osv:next@16\.3\.3: timed out/],
    ['osv:next@16.3.3', { status: 200, body: [] }, /osv:next@16\.3\.3: the body is not a JSON object/],
    ['osv:next@16.3.3', { status: 200, body: 'ok' }, /osv:next@16\.3\.3: the body is not a JSON object/],
    ['osv:next@16.3.3', { status: 200, body: { vulns: {} } }, /osv:next@16\.3\.3: `vulns` is present but is not an array/],
    ['osv:next@16.3.3', { status: 200, body: { vulns: [{ aliases: [] }] } }, /osv:next@16\.3\.3: a vuln with no string id/],
    ['osv:next@16.3.3', { status: 200, body: { next_page_token: 5 } }, /osv:next@16\.3\.3: next_page_token is not a non-empty string/],
    ['upstream:next', { status: 404, body: null }, /upstream:next: HTTP 404/],
    ['upstream:next', { status: 200, body: {} }, /upstream:next: the body is not a JSON array/],
    ['upstream:next', { status: 200, body: [{ cve_id: 'CVE-1' }] }, /upstream:next: an advisory with no string ghsa_id/],
  ]
  for (const [key, response, expected] of cases) {
    const r = run({ responses: { ...cleanResponses(), [key]: response } })
    assert.equal(r.code, 1, `${key} ${JSON.stringify(response)}: ${r.out}`)
    assert.match(r.out, expected)
  }
})

test('an EMPTY floor fails, and so does zero probes', () => {
  const r = run({ floor: { packages: {} } })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no floored package/)
  assert.match(r.out, /zero probes/)
  const noPackages = run({ floor: { '//': 'x' } })
  assert.equal(noPackages.code, 1, noPackages.out)
  assert.match(noPackages.out, /no floored package/)
})

test('a MISSING or RANGED pin fails — a probe the script cannot make is not a clean result', () => {
  const missing = run({ workspace: 'catalog:\n  react: ^19.2.0\n' })
  assert.equal(missing.code, 1, missing.out)
  assert.match(missing.out, /`next` has no catalog pin/)
  const ranged = run({ workspace: 'catalog:\n  next: ^16.3.5\n' })
  assert.equal(ranged.code, 1, ranged.out)
  assert.match(ranged.out, /`next`'s catalog pin \^16\.3\.5 is not an exact version/)
  // The pin is read from the `catalog:` block only: a same-named key elsewhere is not a pin.
  const elsewhere = run({ workspace: 'allowBuilds:\n  next: 16.3.5\n' })
  assert.equal(elsewhere.code, 1, elsewhere.out)
  assert.match(elsewhere.out, /`next` has no catalog pin/)
})

test('a floored package with no UPSTREAM repository and no CANARY fails, naming both', () => {
  const floor = floorDoc()
  floor.packages['left-pad'] = { minPatchByMajor: { 1: '1.3.0' }, reviewedOn: '2026-09-20', reviewedUntil: '2026-10-19', advisories: [] }
  const r = run({ floor, workspace: `${WORKSPACE}  left-pad: 1.3.0\n` })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /`left-pad` has no upstream repository/)
  assert.match(r.out, /`left-pad` has no canary/)
})

test('a CANARY that returns nothing fails — zero on a known-affected version is a wrong query, not a clean package', () => {
  const r = run({ responses: { ...cleanResponses(), 'osv:next@16.2.7': EMPTY } })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /canary next@16\.2\.7 returned no advisory/)
})

test('an UPSTREAM listing with no recorded row fails — a wrong repository must not look clean', () => {
  const unrelated = upstreamAdvisory('GHSA-unr1-unr1-unr1', null, '< 1.0.0')
  const r = run({ responses: { ...cleanResponses(), 'upstream:next': { status: 200, body: [unrelated] } } })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /upstream listing for `next` \(vercel\/next\.js\) holds none of its recorded rows/)
  // A recorded row naming the package under another ecosystem does not count either.
  const pip = upstreamAdvisory(RECORDED, null, '< 1.0.0')
  pip.vulnerabilities = [{ package: { ecosystem: 'pip', name: 'next' }, vulnerable_version_range: '< 1.0.0' }]
  const r2 = run({ responses: { ...cleanResponses(), 'upstream:next': { status: 200, body: [pip] } } })
  assert.equal(r2.code, 1, r2.out)
  assert.match(r2.out, /holds none of its recorded rows/)
})

test('a malformed argument exits 2 rather than running on a default', () => {
  for (const args of [['--responses'], ['--bogus=1'], ['--floor='], ['responses.json'], ['--floor=a', '--floor=b']]) {
    const r = run({ args })
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`)
    assert.match(r.out, /FLOOR ADVISORIES: usage/)
  }
})

test('an unreadable floor, workspace or responses file fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'floor-advisories-'))
  made.push(dir)
  writeFileSync(join(dir, 'bad.json'), '{')
  const missing = join(dir, 'absent.json')
  for (const args of [[`--floor=${join(dir, 'bad.json')}`], [`--workspace=${missing}`], [`--responses=${join(dir, 'bad.json')}`]]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
  }
})

test('on the REAL seeds, the probes are each minPatchByMajor version and the exact pin — read from the files', () => {
  // DERIVED, not typed (1.0.2's rule: a test that types the floor's versions reds on every
  // honest re-review for a reason that has nothing to do with what it proves).
  const floor = JSON.parse(readFileSync(join(ROOT, 'template/base/tools/framework-floor.json'), 'utf8'))
  const workspaceText = readFileSync(join(ROOT, 'template/base/pnpm-workspace.yaml'), 'utf8')
  const { probes, problems } = deriveProbes({ floor, workspaceText })
  assert.deepEqual(problems, [])
  for (const [name, entry] of Object.entries(floor.packages)) {
    const floors = Object.values(/** @type {any} */ (entry).minPatchByMajor).sort()
    assert.ok(floors.length > 0, `${name} has no floor lines`)
    const got = probes.filter((p) => p.name === name)
    assert.deepEqual(got.filter((p) => p.role === 'floor').map((p) => p.version).sort(), floors)
    const pin = catalogPins(workspaceText).get(name)
    assert.match(String(pin), /^\d+\.\d+\.\d+$/, `${name}'s shipped pin is exact`)
    assert.deepEqual(got.filter((p) => p.role === 'pin').map((p) => p.version), [pin])
    assert.deepEqual(got.filter((p) => p.role === 'canary').map((p) => p.version), [CANARIES[name]])
    assert.ok(UPSTREAM_REPOS[name], `${name} has an upstream repository`)
  }
})

test('on the REAL seeds, the script asks for exactly those probes and the upstream listing', () => {
  // End to end over the default paths, with an EMPTY recording: every request the script
  // would send is named by its missing response, and nothing else is.
  const dir = mkdtempSync(join(tmpdir(), 'floor-advisories-'))
  made.push(dir)
  writeFileSync(join(dir, 'none.json'), '{}')
  const r = spawnSync(process.execPath, [SCRIPT, `--responses=${join(dir, 'none.json')}`], { cwd: ROOT, encoding: 'utf8' })
  const out = `${r.stdout}${r.stderr}`
  assert.equal(r.status, 1, out)
  const floor = JSON.parse(readFileSync(join(ROOT, 'template/base/tools/framework-floor.json'), 'utf8'))
  const workspaceText = readFileSync(join(ROOT, 'template/base/pnpm-workspace.yaml'), 'utf8')
  const expected = new Set()
  for (const [name, entry] of Object.entries(floor.packages)) {
    for (const v of Object.values(/** @type {any} */ (entry).minPatchByMajor)) expected.add(`osv:${name}@${String(v)}`)
    expected.add(`osv:${name}@${String(catalogPins(workspaceText).get(name))}`)
    expected.add(`osv:${name}@${CANARIES[name]}`)
    expected.add(`upstream:${name}`)
  }
  const asked = new Set([...out.matchAll(/no recorded response for (\S+?)(?: —|$)/gm)].map((m) => m[1]))
  assert.deepEqual([...asked].sort(), [...expected].sort())
})

test('each canary is a version below its own floor line — a canary on a patched version proves nothing', () => {
  const floor = JSON.parse(readFileSync(join(ROOT, 'template/base/tools/framework-floor.json'), 'utf8'))
  const bad = floorDoc()
  bad.packages.next.minPatchByMajor[16] = '16.2.7'
  const r = run({ floor: bad })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /canary next@16\.2\.7 is not below the floor of its line \(16\.2\.7\)/)
  assert.ok(Object.keys(floor.packages).every((name) => typeof CANARIES[name] === 'string'))
})

/** @param {string} text @param {string} id */
function jobBody(text, id) {
  const region = text.slice(text.indexOf('\njobs:'))
  const heads = [...region.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)]
  const i = heads.findIndex((m) => m[1] === id)
  if (i === -1) return null
  return region.slice(heads[i].index, heads[i + 1]?.index ?? region.length)
}

test('the job COPIES registers-clockful: same trigger, clock, pins and posture, plus the token', () => {
  const text = readFileSync(join(ROOT, '.github/workflows/hygiene.yml'), 'utf8')
  const job = jobBody(text, 'floor-advisories')
  const model = jobBody(text, 'registers-clockful')
  assert.ok(model, 'fixture precondition: registers-clockful exists')
  assert.ok(job, 'hygiene.yml has no floor-advisories job')
  /** @param {string} body */
  const shape = (body) =>
    body
      .split('\n')
      .filter((l) => /^ {4}(if|runs-on|timeout-minutes):|^ {6}- uses:|^ {8}(egress-policy|persist-credentials|node-version):/.test(l))
  assert.deepEqual(shape(job), shape(model))
  // Never on a pull request or a push: the verdict changes with the feeds, not the commit.
  assert.match(job, /^ {4}if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'$/m)
  assert.match(job, /^ {10}GITHUB_TOKEN: \$\{\{ github\.token \}\}$/m)
  assert.match(job, /^ {8}run: node scripts\/check-floor-advisories\.mjs$/m)
  // No install step: the script imports only node built-ins and repository files.
  assert.doesNotMatch(job, /pnpm|npm (ci|install)|yarn/)
  const env = [...job.matchAll(/^ {10}([A-Z_]+):/gm)].map((m) => m[1])
  assert.deepEqual(env, ['GITHUB_TOKEN'])
})
