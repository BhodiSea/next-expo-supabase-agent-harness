// Can-fail proofs for the `secrets` gate (template/base/tools/check-secrets.mjs).
//
// Fixture = a REAL scaffold from `init` in tmpdir, exactly how validate invokes the gate.
// The FIRST test is the release's governing constraint for this change: a fresh scaffold
// carries secret-SHAPED strings on purpose (a `sb_secret_` fixture key in
// credentials.test.ts, the loopback DSN in vitest.config.ts and the crash-reporting
// redaction docs), and a scanner that reds on those is a scanner nobody can ship.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))
let scaffold

before(() => {
  scaffold = mkdtempSync(join(tmpdir(), 'epah-secrets-'))
  const res = spawnSync(
    'node',
    [CLI, 'init', '--dir', scaffold, '--yes', '--set', 'PROJECT_NAME=Scan App', '--set', 'GITHUB_OWNER=o', '--set', 'SECURITY_OWNERS=@o/sec'],
    { encoding: 'utf8' },
  )
  assert.equal(res.status, 0, `${res.stdout ?? ''}${res.stderr ?? ''}`)
})

function runGate(cwd = scaffold) {
  const res = spawnSync('node', ['tools/check-secrets.mjs'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', HARNESS_REQUIRE_TOOLCHAINS: '' },
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

/** Run with `file` temporarily written, then restore the tree. */
function withFile(rel, contents, fn) {
  const path = join(scaffold, rel)
  const existed = existsSync(path)
  const original = existed ? readFileSync(path) : null
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
  try {
    return fn()
  } finally {
    if (original === null) rmSync(path)
    else writeFileSync(path, original)
  }
}

test('GREEN: a fresh scaffold is clean — the shipped secret-SHAPED strings are not findings', () => {
  const r = runGate()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /file\(s\) scanned against \d+ credential shape\(s\), all self-tested/)
  // Anti-vacuity on the green itself: a clean result over a handful of files would prove
  // nothing about the tree.
  const scanned = Number(/^secrets: OK — (\d+) file/m.exec(r.out)?.[1] ?? 0)
  assert.ok(scanned > 100, `the scan must actually read the tree, got ${String(scanned)} files`)
})

test('RED: a real service-role key in a tracked file — and the VALUE is never echoed', () => {
  const key = 'sb_secret_9f2a1c4b7e0d3856aa11bb22'
  const r = withFile('apps/web/lib/leak.ts', `export const k = '${key}'\n`, runGate)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /apps\/web\/lib\/leak\.ts:1 — supabase-secret-key/)
  assert.match(r.out, /value withheld/)
  // A gate that prints the credential it found has copied it into the CI log, the Stop
  // block and the transcript.
  assert.ok(!r.out.includes(key), `the finding must never echo the matched value:\n${r.out}`)
  assert.match(r.out, /ROTATE it/)
})

test('GREEN: the placeholder spelling passes — a fixture must LOOK like the real shape', () => {
  const r = withFile(
    'apps/web/lib/fixture.ts',
    "export const k = 'sb_secret_example-not-a-real-key-value'\n",
    runGate,
  )
  assert.equal(r.code, 0, r.out)
})

test('DSN: a loopback dev string passes; the same shape against a REMOTE host reds', () => {
  const local = withFile(
    'apps/web/lib/db.ts',
    "const url = 'postgres://postgres:postgres@127.0.0.1:5432/app'\n",
    runGate,
  )
  assert.equal(local.code, 0, local.out)

  const remote = withFile(
    'apps/web/lib/db.ts',
    "const url = 'postgres://app:sup3rs3cret@db.prod.example.com:5432/app'\n",
    runGate,
  )
  assert.equal(remote.code, 1, remote.out)
  assert.match(remote.out, /postgres-dsn-credentialed/)
})

test('RED: a PEM private-key body anywhere in the tree', () => {
  const r = withFile(
    'docs/notes.md',
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\n',
    runGate,
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /asc-api-key-material/)
})

// ── anti-vacuity: the gate must be unable to report a clean tree while broken ──

test('RED: a DECAYED pattern reports ITSELF, not a clean tree', () => {
  const path = join(scaffold, 'tools/secret-patterns.json')
  const original = readFileSync(path, 'utf8')
  try {
    const policy = JSON.parse(original)
    // The exact failure this self-test exists for: a pattern edited until it no longer
    // matches what it was written to catch. Without the startup self-test, the gate would
    // print OK over a tree containing the very thing it stopped seeing.
    const rule = policy.rules.find((r) => r.id === 'supabase-secret-key')
    rule.regex = 'sb_secret_THIS_WILL_NEVER_MATCH'
    writeFileSync(path, JSON.stringify(policy, null, 2))
    const r = runGate()
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /NO LONGER MATCHES ITS OWN POSITIVE/)
    assert.match(r.out, /supabase-secret-key/)
  } finally {
    writeFileSync(path, original)
  }
  const restored131 = runGate()
  assert.equal(restored131.code, 0, `restoring the pattern must return the gate to green
${restored131.out}`)
})

test('RED: rule-id lockstep with .gitleaks.toml, in BOTH directions', () => {
  const patterns = join(scaffold, 'tools/secret-patterns.json')
  const toml = join(scaffold, '.gitleaks.toml')
  const originalPatterns = readFileSync(patterns, 'utf8')
  const originalToml = readFileSync(toml, 'utf8')

  // (a) a shape this gate hunts that gitleaks does not: no history coverage.
  try {
    const policy = JSON.parse(originalPatterns)
    policy.rules.push({
      id: 'invented-shape',
      description: 'x',
      regex: 'ZZZ_[0-9]{6}',
      positive: 'ZZZ_123456',
    })
    writeFileSync(patterns, JSON.stringify(policy, null, 2))
    const r = runGate()
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /no rule with that id/)
    assert.match(r.out, /invented-shape/)
  } finally {
    writeFileSync(patterns, originalPatterns)
  }

  // (b) a shape gitleaks hunts that this gate does not: caught only after a PUSH, on
  // machines that have the binary.
  try {
    writeFileSync(
      toml,
      `${originalToml}\n[[rules]]\nid = "vendor-token"\ndescription = "x"\nregex = '''vnd_[a-z0-9]{20}'''\n`,
    )
    const r = runGate()
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /vendor-token/)
    assert.match(r.out, /only caught after a PUSH|only after a PUSH|after a PUSH/)
  } finally {
    writeFileSync(toml, originalToml)
  }
  const restored172 = runGate()
  assert.equal(restored172.code, 0, `restoring both files must return the gate to green
${restored172.out}`)
})

test('RED: scanning ZERO files is a FAIL — a clean result over no input is not a clean tree', () => {
  // A cwd holding ONLY the policy file, which is in allowPaths — so the file set really is
  // empty. The gate script is invoked by absolute path from the scaffold (all its data
  // paths are cwd-relative, all its imports are script-relative), which is what makes a
  // genuinely empty tree constructible without also emptying the gate.
  const empty = mkdtempSync(join(tmpdir(), 'epah-secrets-empty-'))
  mkdirSync(join(empty, 'tools'), { recursive: true })
  writeFileSync(
    join(empty, 'tools/secret-patterns.json'),
    readFileSync(join(scaffold, 'tools/secret-patterns.json')),
  )
  const r = spawnSync('node', [join(scaffold, 'tools/check-secrets.mjs')], {
    cwd: empty,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  assert.equal(r.status, 1, out)
  assert.match(out, /ZERO files/)
  assert.match(out, /broken file enumeration/)
})

test('an acceptance with no real reason FAILS — an empty reason is an acceptance nobody reviewed', () => {
  const key = 'sb_secret_9f2a1c4b7e0d3856aa11bb22'
  const r = withFile('apps/web/lib/leak.ts', `export const k = '${key}'\n`, () =>
    withFile(
      'tools/secret-scan-allow.json',
      JSON.stringify({ allow: [{ path: 'apps/web/lib/leak.ts', rule: 'supabase-secret-key', reason: '' }] }),
      runGate,
    ),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /needs a real `reason`/)
})

test('GREEN: a REASONED acceptance clears exactly that one finding, and nothing else', () => {
  const key = 'sb_secret_9f2a1c4b7e0d3856aa11bb22'
  const accepted = withFile('apps/web/lib/leak.ts', `export const k = '${key}'\n`, () =>
    withFile(
      'tools/secret-scan-allow.json',
      JSON.stringify({
        allow: [
          {
            path: 'apps/web/lib/leak.ts',
            rule: 'supabase-secret-key',
            reason: 'reviewed fixture for the scanner test suite',
          },
        ],
      }),
      runGate,
    ),
  )
  assert.equal(accepted.code, 0, accepted.out)
  assert.match(accepted.out, /1 reviewed acceptance/)

  // …and the same acceptance does NOT cover a second file.
  const elsewhere = withFile('apps/web/lib/other.ts', `export const k = '${key}'\n`, () =>
    withFile(
      'tools/secret-scan-allow.json',
      JSON.stringify({
        allow: [
          {
            path: 'apps/web/lib/leak.ts',
            rule: 'supabase-secret-key',
            reason: 'reviewed fixture for the scanner test suite',
          },
        ],
      }),
      runGate,
    ),
  )
  assert.equal(elsewhere.code, 1, elsewhere.out)
  assert.match(elsewhere.out, /other\.ts/)
})

test('FAILS CLOSED with no policy file — an absent policy is not an empty policy', () => {
  const path = join(scaffold, 'tools/secret-patterns.json')
  const original = readFileSync(path)
  try {
    rmSync(path)
    const r = runGate()
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /has no policy and cannot report a clean tree/)
  } finally {
    writeFileSync(path, original)
  }
})
