import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergePackageJson } from '../../installer/lib/merge-package-json.mjs'

const incoming = {
  scripts: { validate: 'node tools/validate.mjs', lint: 'eslint .' },
  devDependencies: { knip: '^6.0.0', eslint: '^9.0.0' },
  dependencies: { hono: '^4.9.0' },
  packageManager: 'pnpm@11.10.0',
  engines: { node: '>=22' },
}

test('absent scripts are added; identical ones skipped', () => {
  const { merged, validateName } = mergePackageJson({ scripts: { lint: 'eslint .' } }, incoming)
  assert.equal(merged.scripts.validate, 'node tools/validate.mjs')
  assert.equal(merged.scripts.lint, 'eslint .')
  assert.equal(validateName, 'validate')
})

test('conflicting validate script is never clobbered — harness: prefix wins', () => {
  const existing = { scripts: { validate: 'my-own-gate' } }
  const { merged, report, validateName } = mergePackageJson(existing, incoming)
  assert.equal(merged.scripts.validate, 'my-own-gate')
  assert.equal(merged.scripts['harness:validate'], 'node tools/validate.mjs')
  assert.equal(validateName, 'harness:validate')
  assert.ok(report.some((r) => r.kind === 'script-conflict' && r.name === 'validate'))
})

test('existing dep ranges are kept; older majors flagged, never downgraded', () => {
  const existing = { dependencies: { hono: '^3.12.0' }, devDependencies: { eslint: '^9.5.0' } }
  const { merged, report } = mergePackageJson(existing, incoming)
  assert.equal(merged.dependencies.hono, '^3.12.0')
  assert.equal(merged.devDependencies.eslint, '^9.5.0')
  assert.ok(report.some((r) => r.kind === 'dep-mismatch' && r.name === 'hono'))
  assert.ok(!report.some((r) => r.kind === 'dep-mismatch' && r.name === 'eslint'))
  assert.equal(merged.devDependencies.knip, '^6.0.0')
})

test('packageManager and engines are set only when absent', () => {
  const { merged } = mergePackageJson({ packageManager: 'pnpm@10.0.0' }, incoming)
  assert.equal(merged.packageManager, 'pnpm@10.0.0')
  const { merged: m2 } = mergePackageJson({}, incoming)
  assert.equal(m2.packageManager, 'pnpm@11.10.0')
})
