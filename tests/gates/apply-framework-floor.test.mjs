// scripts/ci/apply-framework-floor.mjs — the upgrade lane playing the consumer.
//
// WHY THIS EXISTS AT ALL. tools/framework-floor.json is OWNED, so `update` refreshes it
// into existing installs; pnpm-workspace.yaml is SEEDED, so `update` cannot raise the pin
// the refreshed floor demands. The consumer therefore upgrades into a red step 11 carrying
// the CVE ids and a precise instruction — correct behaviour, and permanently fatal to leg A
// of the upgrade lane, which asserts the previous release upgrades to a GREEN chain and is
// the only leg reaching `graduate`'s success branch. The lane applies the documented remedy
// so the chain judges a remedied tree instead of re-reporting a known advisory forever.
//
// The keyed-by-major behaviour below is the part worth pinning: a flat minimum would drag a
// consumer sitting on a patched 15.x onto a major line nobody reviewed for them, which is
// the opposite of what a security floor is for.
// SOURCE: scripts/ci/apply-framework-floor.mjs · template/base/tools/framework-floor.json
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../../scripts/ci/apply-framework-floor.mjs', import.meta.url))

const FLOOR = {
  packages: {
    next: { minPatchByMajor: { 15: '15.5.21', 16: '16.2.11' } },
  },
}

/** A scaffold carrying a catalog and (optionally) a floor. */
function scaffold({ pin, floor = FLOOR, withFloor = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-floor-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  if (withFloor) writeFileSync(join(dir, 'tools/framework-floor.json'), JSON.stringify(floor))
  writeFileSync(
    join(dir, 'pnpm-workspace.yaml'),
    `packages:\n  - apps/*\n\ncatalog:\n  next: ${pin} # exact: the App Router contract\n  react: 19.2.3\n`,
  )
  return dir
}

function run(dir) {
  const res = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' })
  return {
    code: res.status,
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    yaml: (() => {
      try {
        return readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
      } catch {
        return ''
      }
    })(),
  }
}

test('a pin below its major line s floor is raised, and the trailing comment survives', () => {
  const r = run(scaffold({ pin: '16.2.7' }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /raised to the security floor: next 16\.2\.7 -> 16\.2\.11/)
  assert.match(r.yaml, /^ {2}next: 16\.2\.11 # exact: the App Router contract$/m)
  assert.match(r.yaml, /^ {2}react: 19\.2\.3$/m, 'an unrelated pin is untouched')
})

test('a pin already at the floor is left alone — and running twice is a no-op', () => {
  const dir = scaffold({ pin: '16.2.11' })
  const first = run(dir)
  assert.equal(first.code, 0, first.out)
  assert.match(first.out, /already at or above the reviewed floor/)
  const before = first.yaml
  assert.equal(run(dir).yaml, before)
})

test('KEYED BY MAJOR: a patched 15.x is left where it is, not dragged onto 16', () => {
  // The whole reason the floor is a map rather than a number. A consumer deliberately on
  // the 15 line, already carrying the patch, is not vulnerable — and moving them across a
  // major boundary to satisfy a security check would break their app to fix nothing.
  const r = run(scaffold({ pin: '15.5.21' }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.yaml, /^ {2}next: 15\.5\.21 /m)
})

test('KEYED BY MAJOR: an UNPATCHED 15.x is raised to 15 s floor, never to 16 s', () => {
  const r = run(scaffold({ pin: '15.5.2' }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /next 15\.5\.2 -> 15\.5\.21/)
  assert.match(r.yaml, /^ {2}next: 15\.5\.21 /m)
})

test('a major line the floor says nothing about is untouched, not invented', () => {
  // No entry for 14 means nobody reviewed the 14 line. Raising it to some other line's
  // floor would be the gate asserting a review that never happened.
  const r = run(scaffold({ pin: '14.9.0' }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.yaml, /^ {2}next: 14\.9\.0 /m)
})

test('a baseline with no floor file changes nothing and exits 0', () => {
  // Legs B and C init at tags that predate the floor entirely. Failing there would make the
  // lane assert that old releases shipped a file they could not have shipped.
  const r = run(scaffold({ pin: '16.2.7', withFloor: false }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /not present on this baseline/)
  assert.match(r.yaml, /^ {2}next: 16\.2\.7 /m)
})

test('no scaffold argument is a usage error, not a silent success', () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(res.status, 2)
  assert.match(`${res.stdout}${res.stderr}`, /usage:/)
})
