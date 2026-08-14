// The asset-inventory closure (0.10.0) — the control that turns `pnpm sbom` from an
// artefact into evidence.
//
// The distinction this file exists to hold: emitting an SBOM cannot go red, so a lane that
// only emits one is decoration whatever its name says. Every test below is a way the
// EMISSION can be wrong while the job stays green — an inventory missing half the tree, an
// inventory of a different tree, an inventory of nothing at all — and each one must red.
//
// The last test spawns the shipped script: that is the `lanes['sbom-inventory']` red-proof,
// and it is registered as one. Nothing else in the repo can make that lane go red.
// SOURCE: template/base/tools/lib/sbom.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  lockPackageKeys,
  purlForLockKey,
  sbomProblems,
} from '../../template/base/tools/lib/sbom.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'template/base/tools/check-sbom.mjs')

// A pnpm 9+ lockfile, trimmed to the two sections that matter. The peer-suffixed key under
// `snapshots:` is deliberate: it is the reason this parser reads `packages:` and not the
// section immediately below it.
const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      react:
        specifier: 19.0.0
        version: 19.0.0

packages:

  '@biomejs/biome@2.5.3':
    resolution: {integrity: sha512-aaa}
    engines: {node: '>=14.21.3'}

  react@19.0.0:
    resolution: {integrity: sha512-bbb}

  react-dom@19.0.0:
    resolution: {integrity: sha512-ccc}
    peerDependencies:
      react: ^19.0.0

snapshots:

  '@biomejs/biome@2.5.3': {}

  react@19.0.0: {}

  react-dom@19.0.0(react@19.0.0):
    dependencies:
      react: 19.0.0
`

const component = (purl) => ({ type: 'library', purl, 'bom-ref': purl })

const SBOM = (purls) => ({
  bomFormat: 'CycloneDX',
  specVersion: '1.7',
  metadata: { component: { type: 'library', name: 'demo', purl: 'pkg:npm/demo@1.0.0' } },
  components: purls.map(component),
})

const COMPLETE = [
  'pkg:npm/%40biomejs/biome@2.5.3',
  'pkg:npm/react@19.0.0',
  'pkg:npm/react-dom@19.0.0',
]

const judge = (sbom, lockText = LOCK) => sbomProblems({ sbom, lockText })

// ── the parser ────────────────────────────────────────────────────────────────────

test('lockPackageKeys reads `packages:` and stops at the next section', () => {
  // Three, not six: the peer-suffixed snapshots keys are the same packages under different
  // names, and counting them would over-report against an SBOM that lists each once.
  assert.deepEqual(lockPackageKeys(LOCK), [
    '@biomejs/biome@2.5.3',
    'react@19.0.0',
    'react-dom@19.0.0',
  ])
})

test('a scoped name percent-encodes its @, as the purl spec requires', () => {
  // The version comes from the LAST @, because a scoped name starts with one. Getting this
  // wrong mismatches every scoped package — which is most of them — and a check that
  // mismatches everything gets deleted rather than fixed.
  assert.equal(purlForLockKey('@biomejs/biome@2.5.3'), 'pkg:npm/%40biomejs/biome@2.5.3')
  assert.equal(purlForLockKey('react@19.0.0'), 'pkg:npm/react@19.0.0')
})

test('a peer suffix on a packages: key is dropped rather than read as a version', () => {
  // Cannot occur in pnpm 9+, but the lockfile is a format this repo does not own, and a
  // format change must not read as a hole in the inventory.
  assert.equal(purlForLockKey('react-dom@19.0.0(react@19.0.0)'), 'pkg:npm/react-dom@19.0.0')
})

test('a lockfile with NO packages: section yields no keys (the anti-vacuity input)', () => {
  assert.deepEqual(lockPackageKeys("lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n"), [])
})

// ── the closure, both directions ──────────────────────────────────────────────────

test('GREEN: an inventory matching the lockfile exactly is clean', () => {
  assert.deepEqual(judge(SBOM(COMPLETE)), [])
})

test('RED: a resolved package ABSENT from the inventory is named', () => {
  const problems = judge(SBOM(COMPLETE.filter((p) => !p.includes('react-dom'))))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /1 package\(s\) resolved in pnpm-lock\.yaml are ABSENT/)
  assert.match(problems[0], /react-dom@19\.0\.0/)
  assert.match(problems[0], /aimed at a subset nobody declared/)
})

test('RED: a component NO lockfile entry resolves is named — the direction nobody checks', () => {
  // A too-large inventory reads as thorough, which is exactly why this arm exists: a stale
  // committed artefact, a --filter left on, or a generator pointed at another workspace all
  // land here and nowhere else.
  const problems = judge(SBOM([...COMPLETE, 'pkg:npm/left-pad@1.3.0']))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /1 component\(s\).*are resolved by NO entry/s)
  assert.match(problems[0], /left-pad@1\.3\.0/)
})

test('RED: both directions at once are reported as two findings, not one', () => {
  const problems = judge(SBOM(['pkg:npm/react@19.0.0', 'pkg:npm/left-pad@1.3.0']))
  assert.equal(problems.length, 2)
})

test('a long finding names the first 8 offenders and COUNTS the rest', () => {
  const many = Array.from({ length: 12 }, (_, i) => `pkg:npm/extra-${String(i)}@1.0.0`)
  const problems = judge(SBOM([...COMPLETE, ...many]))
  assert.match(problems[0], /\(\+4 more\)/)
})

// ── anti-vacuity: the states where an empty comparison would read as clean ─────────

test('ANTI-VACUITY: ZERO components is a RED, never a clean empty-vs-empty match', () => {
  // The failure this guards is the one that matters. An empty component list compared
  // against an empty lock set is a clean set difference, so without this the whole lane
  // reports OK on an emission that produced nothing.
  const problems = judge(SBOM([]))
  assert.ok(problems.some((p) => /lists ZERO components/.test(p)))
  assert.ok(problems.some((p) => /never a dependency-free repository/.test(p)))
})

test('ANTI-VACUITY: a lockfile the parser found nothing in is a RED, not a clean tree', () => {
  const problems = judge(SBOM(COMPLETE), "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n")
  assert.ok(problems.some((p) => /yielded no `packages:` entries/.test(p)))
  assert.ok(problems.some((p) => /must not report clean/.test(p)))
})

test('ANTI-VACUITY: zero components AND an unreadable lockfile report BOTH, then stop', () => {
  // Both inputs are gone, so the set comparison below them is meaningless — it must not run
  // and add noise on top of the two findings that explain the state.
  const problems = judge(SBOM([]), 'lockfileVersion: 9.0\n')
  assert.equal(problems.length, 2)
})

// ── the artefact must be the format the closure reads ─────────────────────────────

test('RED: a non-CycloneDX document reds instead of comparing nothing to nothing', () => {
  const problems = judge({ bomFormat: 'SPDX', components: [] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /does not declare bomFormat 'CycloneDX'/)
  // And it STOPS: reading CycloneDX field names out of another format would produce
  // findings about the wrong thing.
  assert.doesNotMatch(problems[0], /ZERO components/)
})

test('RED: an inventory that does not name what it inventories', () => {
  const sbom = SBOM(COMPLETE)
  delete sbom.metadata
  const problems = judge(sbom)
  assert.ok(problems.some((p) => /no metadata\.component\.purl/.test(p)))
})

test('RED: a component with no purl is invisible to the closure, so it is its own finding', () => {
  const sbom = SBOM(COMPLETE)
  sbom.components.push({ type: 'library', name: 'anonymous' })
  const problems = judge(sbom)
  assert.ok(problems.some((p) => /missing or duplicate purl/.test(p)))
})

// ── the lane red-proof ────────────────────────────────────────────────────────────

test('CANARY — the shipped sbom-inventory script EXITS 1 on an under-reporting inventory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-sbom-'))
  const lock = join(dir, 'pnpm-lock.yaml')
  const sbom = join(dir, 'sbom.cdx.json')
  writeFileSync(lock, LOCK)
  writeFileSync(sbom, JSON.stringify(SBOM(COMPLETE.slice(0, 1))))

  const red = spawnSync(process.execPath, [SCRIPT, `--lock=${lock}`, `--sbom=${sbom}`], {
    encoding: 'utf8',
  })
  assert.equal(red.status, 1)
  assert.match(red.stderr, /sbom-inventory: FAIL/)
  assert.match(red.stderr, /are ABSENT from/)
  assert.match(red.stderr, /FIX\[sbom-inventory\]/)

  // The inverse, same script, same fixture set: a complete inventory exits 0. Without this
  // the red above is consistent with a script that always fails.
  writeFileSync(sbom, JSON.stringify(SBOM(COMPLETE)))
  const green = spawnSync(process.execPath, [SCRIPT, `--lock=${lock}`, `--sbom=${sbom}`], {
    encoding: 'utf8',
  })
  assert.equal(green.status, 0)
  assert.match(green.stdout, /sbom-inventory: OK — 3 component\(s\)/)
})

test('CANARY — an absent lockfile SKIPS locally and FAILS CLOSED in CI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-sbom-nolock-'))
  const args = [SCRIPT, `--lock=${join(dir, 'pnpm-lock.yaml')}`]

  const local = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, CI: '', HARNESS_REQUIRE_TOOLCHAINS: '' },
  })
  assert.equal(local.status, 0)
  assert.match(local.stdout, /sbom-inventory: SKIPPED/)

  const ci = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  })
  assert.equal(ci.status, 1)
  assert.match(ci.stderr, /skips are not allowed in CI/)
})

// ── the closure runs against the REAL emitted artefact, not only fixtures ──────────

test('the shipped lib agrees with a REAL `pnpm sbom` run over this repository', { timeout: 180_000 }, () => {
  // Fixtures prove the judgement; this proves the judgement is about the real format. A
  // CycloneDX spec bump that renamed `purl`, or a pnpm change that stopped emitting
  // components, would leave every test above green and this one red — which is the only
  // way this suite learns that the artefact moved.
  const run = spawnSync('pnpm', ['sbom', '--sbom-format', 'cyclonedx', '--lockfile-only'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  // TOOLCHAIN ABSENT vs REAL FAILURE — the distinction stop-factory-gate.mjs already draws,
  // and conflating them is how this test first shipped: a spawn ENOENT leaves `stderr`
  // UNDEFINED, so the CI-strict branch below reported `pnpm sbom failed in CI: undefined`
  // 4ms into a job that has no pnpm to fail.
  //
  // AND THE GAP, STATED RATHER THAN HIDDEN: no CI job runs this corpus with pnpm on PATH.
  // installer-unit (which owns tests/**) and release.yml's tag gate are both setup-node
  // ONLY — deliberately dependency-free — so in CI this test SKIPS, every time. Where it
  // actually executes is the factory Stop hook, which runs tests/gates/*.test.mjs on every
  // maintainer turn with a real toolchain. That is a weaker home than CI and it is the
  // honest one; the seventeen fixture tests above are unaffected and run everywhere.
  if (run.error !== undefined) {
    console.log(
      'sbom: SKIPPED the real-emission cross-check — pnpm is not on PATH (%s). The fixture closure above still ran.',
      run.error.message,
    )
    return
  }
  if (run.status !== 0) {
    // pnpm RAN and refused. That is a finding about the emission, not about the toolchain,
    // so it fails closed in CI and skips loudly on a workstation mid-install.
    assert.equal(
      process.env.CI === 'true',
      false,
      `pnpm sbom exited ${String(run.status)} in CI: ${run.stderr}`,
    )
    return
  }
  const real = JSON.parse(run.stdout)
  assert.ok(real.components.length > 50, 'this repository resolves more than 50 packages')
  assert.deepEqual(
    sbomProblems({ sbom: real, lockText: readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8') }),
    [],
    'the real emission must satisfy the real closure',
  )
})
