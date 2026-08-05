// RETROFIT CONFLICTS ARE EVIDENCE (0.3.0).
//
// A retrofit keeps the target's config and parks the harness version in a sidecar — the
// right call, because clobbering a human's configuration is exactly what this ownership
// model exists to prevent. What was wrong until 0.3.0 is that the installer `continue`d
// BEFORE the manifest line, so the state was invisible to everything afterwards: `doctor`
// saw nothing and `check-gate-integrity` had no entry to judge.
//
// The consequence was specific and bad. `lint`, `types`, `dead-code`, `architecture` and
// the coverage floors all ran against the TARGET's eslint/tsconfig/knip/vitest configs —
// with zero harness rules in them — and reported green. The install looked enforced and
// was not.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))

// A pnpm monorepo that already carries its own eslint config and a settings file with
// `bypassPermissions` — the two shapes this change is about. Retrofit reports conflicts
// with exit 2 by design, so that is the expected status.
const SIDECAR = 'eslint.config.harness.mjs'
function retrofitTarget() {
  const dir = mkdtempSync(join(tmpdir(), 'epah-retrofit-'))
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'their-app', version: '1.0.0', private: true }, null, 2)}\n`,
  )
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n")
  mkdirSync(join(dir, 'apps/web/src'), { recursive: true })
  writeFileSync(join(dir, 'apps/web/package.json'), '{"name":"web"}\n')
  // The detector requires a real Next.js or Expo app at the expected path — the harness
  // retrofits this stack, not any monorepo.
  writeFileSync(join(dir, 'apps/web/next.config.ts'), 'export default {}\n')
  writeFileSync(join(dir, 'apps/web/src/index.ts'), 'export const theirs = true\n')
  // Their own eslint config: the file the `lint` gate would read.
  writeFileSync(join(dir, 'eslint.config.mjs'), 'export default []\n')
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(
    join(dir, '.claude/settings.json'),
    `${JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }, null, 2)}\n`,
  )
  const res = spawnSync(
    'node',
    [CLI, 'init', '--dir', dir, '--yes', '--set', 'PROJECT_NAME=Their App', '--set', 'GITHUB_OWNER=o', '--set', 'SECURITY_OWNERS=@o/sec'],
    { encoding: 'utf8' },
  )
  assert.ok([0, 2].includes(res.status), `${res.stdout ?? ''}${res.stderr ?? ''}`)
  return dir
}

const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, '.harness/manifest.json'), 'utf8'))

function run(script, dir, env = {}) {
  const res = spawnSync('node', [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', HARNESS_REQUIRE_TOOLCHAINS: '', HARNESS_ALLOW_SELF_EDIT: '', ...env },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const doctor = (dir) => {
  const res = spawnSync('node', [CLI, 'doctor', '--dir', dir], { encoding: 'utf8' })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

test('init RECORDS the conflict: mode, both hashes, and the sidecar it parked', () => {
  const dir = retrofitTarget()
  const entry = manifestOf(dir).files['eslint.config.mjs']
  assert.ok(entry, 'the conflicted path must appear in the manifest at all — it did not before 0.3.0')
  assert.equal(entry.mode, 'conflicted')
  assert.match(entry.theirsSha256, /^[0-9a-f]{64}$/)
  assert.match(entry.oursSha256, /^[0-9a-f]{64}$/)
  assert.notEqual(entry.theirsSha256, entry.oursSha256)
  assert.equal(entry.sidecar, SIDECAR)
  assert.ok(existsSync(join(dir, SIDECAR)), 'the harness version is parked, not lost')
  // …and THEIRS is untouched. Never clobber a human's config.
  assert.equal(readFileSync(join(dir, 'eslint.config.mjs'), 'utf8'), 'export default []\n')
})

test('check-gate-integrity REDS on the unresolved conflict with the exact merge instruction', () => {
  const dir = retrofitTarget()
  const r = run('tools/check-gate-integrity.mjs', dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /RETROFIT CONFLICT/)
  assert.match(r.out, /eslint\.config\.mjs/)
  assert.ok(r.out.includes(SIDECAR), r.out)
  assert.match(r.out, /judging the TARGET's rules/)
})

test('doctor exits 2 naming it — a known divergence, never reported as "locally modified"', () => {
  const dir = retrofitTarget()
  const r = doctor(dir)
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /retrofit conflict unresolved: eslint\.config\.mjs/)
  assert.ok(
    !/locally modified.*eslint\.config\.mjs/.test(r.out),
    `a conflict is not drift — that wording sends a reader looking for an edit nobody made:\n${r.out}`,
  )
})

test('wiring REFUSES to claim enforcement over a posture the merge deliberately kept', () => {
  // The settings merge keeps THEIRS for posture scalars, and that is correct — never
  // ambush a human's permission choice. But keeping theirs and CLAIMING enforcement over
  // it are different things, and this is where the claim is refused.
  const dir = retrofitTarget()
  const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))
  assert.equal(settings.permissions.defaultMode, 'bypassPermissions', 'the merge keeps theirs')
  const r = run('tools/check-wiring.mjs', dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /every session starts with the permission model off/)
})

test('a REVIEWED acceptance converts the red into a NOTE, pinned to the reviewed content', () => {
  const dir = retrofitTarget()
  const theirs = manifestOf(dir).files['eslint.config.mjs'].theirsSha256
  const acceptPath = join(dir, 'tools/retrofit-accept.json')
  writeFileSync(
    acceptPath,
    `${JSON.stringify(
      {
        accept: [
          {
            path: 'eslint.config.mjs',
            theirsSha256: theirs,
            reason: 'this repo has a reviewed house eslint config; harness rules folded in manually',
          },
        ],
      },
      null,
      2,
    )}\n`,
  )
  const accepted = run('tools/check-gate-integrity.mjs', dir)
  assert.equal(accepted.code, 0, accepted.out)
  assert.match(accepted.out, /accepted divergence/)

  // The sha PINS the acceptance to what was reviewed: editing their config afterwards
  // re-opens the question rather than inheriting the judgement.
  writeFileSync(join(dir, 'eslint.config.mjs'), 'export default [{ rules: {} }]\n')
  const changed = run('tools/check-gate-integrity.mjs', dir)
  assert.equal(changed.code, 1, changed.out)
  assert.match(changed.out, /RETROFIT CONFLICT/)
})

test('an acceptance with no real reason FAILS CLOSED', () => {
  const dir = retrofitTarget()
  writeFileSync(
    join(dir, 'tools/retrofit-accept.json'),
    JSON.stringify({ accept: [{ path: 'eslint.config.mjs', reason: '' }] }),
  )
  const r = run('tools/check-gate-integrity.mjs', dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /needs a real `reason`/)
})

test('deleting the sidecar is the RESOLUTION signal — `update` re-records the file', () => {
  const dir = retrofitTarget()
  // A real merge produces a file that is neither theirs nor ours, so byte-equality with
  // the template would refuse to recognise the correct outcome. Deleting the sidecar is
  // the protocol the gate's own failure text prescribes.
  writeFileSync(join(dir, 'eslint.config.mjs'), 'export default [/* merged: house rules + harness rules */]\n')
  rmSync(join(dir, SIDECAR))

  const res = spawnSync('node', [CLI, 'update', '--dir', dir], { encoding: 'utf8' })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  assert.match(out, /retrofit conflict RESOLVED: eslint\.config\.mjs/, out)

  const entry = manifestOf(dir).files['eslint.config.mjs']
  assert.notEqual(entry.mode, 'conflicted', 'the record must clear once the merge is done')
  const gate = run('tools/check-gate-integrity.mjs', dir)
  assert.ok(!/RETROFIT CONFLICT/.test(gate.out), gate.out)
})

test('while the sidecar STANDS, `update` preserves theirs and keeps saying so', () => {
  const dir = retrofitTarget()
  const res = spawnSync('node', [CLI, 'update', '--dir', dir], { encoding: 'utf8' })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  assert.match(out, /retrofit conflict still unresolved: eslint\.config\.mjs/, out)
  assert.equal(readFileSync(join(dir, 'eslint.config.mjs'), 'utf8'), 'export default []\n')
  assert.equal(manifestOf(dir).files['eslint.config.mjs'].mode, 'conflicted')
})
