// `init --consume` turns a copy of this repository into a project in place, so it removes the
// trees that only the factory uses (installer/commands/init.mjs). docs-site/ joined that list
// with the documentation site (#171): left behind, it would be an Astro project with its own
// lockfile inside every consumed copy. This runs the real CLI over a scratch folder that holds
// each factory-only tree the project does not write itself, and checks none survives.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../../installer/cli.mjs', import.meta.url))

const SETS = [
  '--set', 'PROJECT_NAME=Fixture App',
  '--set', 'GITHUB_OWNER=fixture-owner',
  '--set', 'SECURITY_OWNERS=@fixture-owner/security',
]

const FACTORY_ONLY = ['installer', 'template', 'scripts', '.claude-plugin', 'docs-site']

test('init --consume removes the factory-only trees, docs-site/ among them', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'epah-consume-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const tree of FACTORY_ONLY) {
    mkdirSync(join(dir, tree), { recursive: true })
    writeFileSync(join(dir, tree, 'planted.txt'), 'a factory-only file\n')
  }

  const res = spawnSync('node', [CLI, 'init', '--dir', dir, '--consume', '--yes', '--tier', 'core', ...SETS], {
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, `${res.stdout ?? ''}${res.stderr ?? ''}`)

  const survivors = FACTORY_ONLY.filter((tree) => existsSync(join(dir, tree)))
  assert.deepEqual(survivors, [], 'a factory-only tree survived init --consume')
  assert.ok(existsSync(join(dir, 'package.json')), 'precondition: init wrote the project itself')
  assert.ok(existsSync(join(dir, '.harness', 'manifest.json')), 'precondition: init wrote its manifest')
})
