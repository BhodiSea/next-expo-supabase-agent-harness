// Can-fail proofs for the test-quality gate (template/base/tools/check-test-quality.mjs).
//
// The subtle one is the RUNTIME-skip pair: `test.skip(condition, reason)` is a RUNTIME
// conditional skip — the form data-driven suites use ("skip unless the database is
// ready"), and a construct browser-e2e runners rely on. It is not the same construct as
// the MODIFIER `test.skip('name', fn)`, which declares a test that never runs. A gate
// that cannot tell them apart would red legitimate conditional suites — so both
// directions are pinned here. (This stack's own runners, vitest + jest-expo, express
// the same intent via ternaries over describe/it references, which a call-form scan
// never matches.)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(
  new URL('../../template/base/tools/check-test-quality.mjs', import.meta.url),
)
const LIB = fileURLToPath(new URL('../../template/base/tools/lib', import.meta.url))

/** @param {{files: Record<string,string>, allow?: unknown, manifest?: string}} opts */
function fixture({ files, allow, manifest }) {
  const dir = mkdtempSync(join(tmpdir(), 'epah-testq-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  cpSync(LIB, join(dir, 'tools/lib'), { recursive: true })
  cpSync(SCRIPT, join(dir, 'tools/check-test-quality.mjs'))
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  if (allow !== undefined) {
    writeFileSync(
      join(dir, 'tools/test-quality-allow.json'),
      typeof allow === 'string' ? allow : JSON.stringify(allow),
    )
  }
  if (manifest !== undefined) {
    mkdirSync(join(dir, '.harness'), { recursive: true })
    writeFileSync(join(dir, '.harness/manifest.json'), manifest)
  }
  return dir
}

function run(dir) {
  const env = { ...process.env }
  delete env.CI
  const r = spawnSync('node', ['tools/check-test-quality.mjs'], { cwd: dir, encoding: 'utf8', env })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const GOOD = `import { expect, it } from 'vitest'
it('adds', () => {
  expect(1 + 1).toBe(2)
})
`

test('RED: a test with NO assertion — it raises coverage and guarantees nothing', () => {
  const r = run(
    fixture({
      files: {
        'apps/server/src/x.test.ts': `import { it } from 'vitest'
it('exercises the happy path', () => {
  buildTheThing({ a: 1 })
})
`,
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /contains NO assertion/, r.out)
  assert.match(r.out, /exercises the happy path/, r.out)
})

test('a test that asserts through a HELPER (assertX / expectX) is not a false red', () => {
  const r = run(
    fixture({
      files: {
        'apps/mobile/__tests__/a11y.test.tsx': `import { render } from '@testing-library/react-native'
test('home screen is a11y-clean', async () => {
  const screen = render(makeHome())
  await assertNoViolations(screen)
})
`,
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('a TYPE-ONLY test asserts through `expectTypeOf<T>()` — not a false red', () => {
  // Regression proof. The assertion pattern required `.` or `(` after the callee, but
  // the type-argument form puts `<` exactly there, so every type-only test in the tree
  // scored as "contains NO assertion" — which is what the shipped platform/events suite
  // did, reddening the mutation canary's control gate on a clean scaffold.
  const r = run(
    fixture({
      files: {
        'packages/platform/events/src/index.test.ts': `import { expectTypeOf } from 'vitest'
test('recovers the payload type from the declaration', () => {
  expectTypeOf<CreatedPayload>().toEqualTypeOf<NoteCreatedPayload>()
  expectTypeOf<SurfacedPayload['kind']>().toEqualTypeOf<string>()
})
`,
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('RED: a bare comparison is NOT an assertion — the type-argument branch stays tight', () => {
  // The guard on the branch above: `expected < 5` must not read as `expected<…>(`.
  const r = run(
    fixture({
      files: {
        'packages/api/src/skew.test.ts': `test('compares two numbers and proves nothing', () => {
  const expected = 5
  if (expected < 5) {
    console.log('nope')
  }
})
`,
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /NO assertion/)
})

test('RED: `.only` is fatal and has NO escape — it disables the whole suite', () => {
  const dir = fixture({
    files: {
      'apps/server/src/x.test.ts': `import { expect, it } from 'vitest'
it.only('just this one', () => {
  expect(1).toBe(1)
})
`,
    },
    // even an allowlist entry must not open it
    allow: { allow: [{ test: 'apps/server/src/x.test.ts::just this one', reason: 'nope' }] },
  })
  const r = run(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /DISABLES EVERY OTHER TEST/, r.out)
  assert.match(r.out, /no reviewed escape/i, r.out)
})

test('RED: a `.skip`/`.todo` MODIFIER declares a test that never runs', () => {
  for (const modifier of ['skip', 'todo', 'failing']) {
    const r = run(
      fixture({
        files: {
          'apps/server/src/x.test.ts': `import { expect, it } from 'vitest'
it.${modifier}('handles the retry path', () => {
  expect(1).toBe(1)
})
`,
        },
      }),
    )
    assert.equal(r.code, 1, `.${modifier} must red\n${r.out}`)
    assert.match(r.out, /never runs/, r.out)
    assert.match(r.out, /handles the retry path/, r.out)
  }
})

test('xit / xdescribe are the same thing under another name', () => {
  const r = run(
    fixture({
      files: {
        'apps/server/src/x.test.ts': `xit('parked', () => {
  expect(1).toBe(1)
})
`,
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /never runs/, r.out)
})

// ---------------------------------------------------------------------------------------
// The distinction a naive `.skip` ban gets wrong — it would red any data-driven suite
// that skips at runtime (the construct browser-e2e runners lean on too).
// ---------------------------------------------------------------------------------------
test('a RUNTIME conditional skip is NOT a disabled test', () => {
  const r = run(
    fixture({
      files: {
        'tests/matrix/matrix.spec.ts': `import { expect, test } from 'vitest'
const DB_READY = process.env.HARNESS_DB_READY === '1'
test.skip(!DB_READY, 'database lane disabled — set HARNESS_DB_READY=1')

test('matrix keyset pages', () => {
  test.skip(MATRIX === undefined, 'no matrix route registered (data-driven skip)')
  expect(page(MATRIX).length).toBe(50)
})

test('burst', () => {
  test.skip(true, 'ROUTES has no "matrix" entry — the app does not ship the grid exemplar')
  expect(1).toBe(1)
})
`,
      },
    }),
  )
  assert.equal(r.code, 0, `a conditional skip is a feature, not rot\n${r.out}`)
})

test('the reviewed allowlist mutes a disabled test; a malformed one FAILS CLOSED', () => {
  const files = {
    'apps/server/src/x.test.ts': `import { expect, it } from 'vitest'
it.todo('emits a span per request')
it('works', () => {
  expect(1).toBe(1)
})
`,
  }
  const key = 'apps/server/src/x.test.ts::emits a span per request'

  const muted = run(
    fixture({ files, allow: { allow: [{ test: key, reason: 'needs the OTel SDK wired' }] } }),
  )
  assert.equal(muted.code, 0, muted.out)

  // A reason is mandatory — an entry without one must never open the gate.
  const noReason = run(fixture({ files, allow: { allow: [{ test: key }] } }))
  assert.equal(noReason.code, 1, noReason.out)
  assert.match(noReason.out, /every entry must be/, noReason.out)

  const broken = run(fixture({ files, allow: '{ not json' }))
  assert.equal(broken.code, 1, broken.out)
  assert.match(broken.out, /not valid JSON/, broken.out)
})

test('it.each keeps its assertion in the SECOND call — not a false red', () => {
  const r = run(
    fixture({
      files: {
        'apps/server/src/x.test.ts': `import { expect, it } from 'vitest'
it.each([[1, 1], [2, 4]])('squares %i', (n, sq) => {
  expect(n * n).toBe(sq)
})
`,
      },
    }),
  )
  assert.equal(r.code, 0, r.out)
})

test('an assertion inside a COMMENT does not satisfy the gate', () => {
  const r = run(
    fixture({
      files: {
        'apps/server/src/x.test.ts': `import { it } from 'vitest'
it('looks tested', () => {
  // expect(result).toBe(42)
  doTheThing()
})
`,
      },
    }),
  )
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /NO assertion/, r.out)
})

test('a baseVersion predating the check downgrades findings to a ramp NOTE (green)', () => {
  // Ramp minimum is 0.1.0 in this lineage (live from the first install) — only a
  // hypothetical pre-lineage manifest rides the NOTE, but the shared rampNote
  // path must stay provable in both directions.
  const dir = fixture({
    files: {
      'apps/server/src/x.test.ts': `import { it } from 'vitest'
it('asserts nothing', () => {
  doTheThing()
})
`,
    },
    manifest: JSON.stringify({ harnessVersion: '0.1.0', baseVersion: '0.0.9' }),
  })
  const r = run(dir)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /NOTE — .*\(ramp: live from baseVersion 0\.1\.0/, r.out)
  // The ramp must still SHOW the finding — a silent NOTE is just a pass.
  assert.match(r.out, /asserts nothing/, r.out)
})

test('turn-fatal once baseVersion reaches 0.1.0', () => {
  const dir = fixture({
    files: {
      'apps/server/src/x.test.ts': `import { it } from 'vitest'
it('asserts nothing', () => {
  doTheThing()
})
`,
    },
    manifest: JSON.stringify({ harnessVersion: '0.1.0', baseVersion: '0.1.0' }),
  })
  const r = run(dir)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /test-quality: FAIL/, r.out)
})

test('a clean suite passes and says what it checked', () => {
  const r = run(fixture({ files: { 'apps/server/src/x.test.ts': GOOD } }))
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /all assert, none disabled/, r.out)
})
