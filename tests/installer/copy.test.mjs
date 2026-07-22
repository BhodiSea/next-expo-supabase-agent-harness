// Unit tests for the template tree walker (installer/lib/copy.mjs): the split
// walkTemplate (paths only) / renderEntry (content) / planTree (both) pipeline
// that turns the packaged template/ storage tree into an install plan.
// Regression armor for the v0.1.4 refactor — pins CURRENT behavior:
//   * toPosix normalizes backslashes to '/'
//   * top-level dotless RENAMES map back to dot-paths; a NESTED file literally
//     named `gitignore` is NOT renamed (rename gate is relInstall === '')
//   * `.tmpl` is stripped from the install path but kept in the storage path
//   * binary assets round-trip byte-for-byte as Buffers, never placeholder-rendered
//   * {{TOKEN}} substitution renders from answers, unknown tokens left intact
//   * walkTemplate + renderEntry compose to exactly planTree on the same tree
//   * a missing/empty tree yields []
// Fixture-source walks use a template-root-relative `tree`; that only resolves
// when the tmpdir shares a drive with the repo, so those cases skip cleanly on
// a cross-drive Windows runner (join(templateRoot, absTree) can't reach it).
// The real template/base tree is also exercised read-only on every OS.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import {
  planTree,
  renderEntry,
  storageToInstall,
  templateRoot,
  toPosix,
  walkTemplate,
} from '../../installer/lib/copy.mjs'
import { PLACEHOLDERS, tokensIn } from '../../installer/lib/placeholders.mjs'

// A complete answers map — one value per registered placeholder — so a rendered
// tree that still shows {{...}} can only be an UNKNOWN (unregistered) token.
const ALL_ANSWERS = Object.fromEntries(Object.keys(PLACEHOLDERS).map((k) => [k, 'x']))

// Mirror walkTemplate's own `join(templateRoot(), tree)` to decide whether a
// tmpdir fixture is reachable via a template-root-relative tree. Returns the
// tree string when the walker would land back on the fixture, else null (the
// cross-drive Windows case where `relative` returns an absolute path).
function treeFor(fixtureRoot) {
  const tree = relative(templateRoot(), fixtureRoot)
  const landed = join(templateRoot(), tree)
  return resolve(landed) === resolve(fixtureRoot) ? tree : null
}

function makeFixture(prefix, files) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  for (const [rel, data] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, data)
  }
  return root
}

test('toPosix converts backslashes and leaves POSIX paths untouched', () => {
  assert.equal(toPosix('a\\b\\c'), 'a/b/c')
  assert.equal(toPosix('already/posix/path'), 'already/posix/path')
  assert.equal(toPosix(''), '')
})

test('templateRoot resolves to the packaged template/ dir and is walkable', () => {
  const root = templateRoot()
  assert.ok(/[\\/]template[\\/]?$/.test(root), root)
  // Sanity: the real base tree walks to a non-empty plan through this root.
  assert.ok(walkTemplate('base').length > 0)
})

test('renderEntry substitutes {{TOKEN}} from answers and leaves unknowns intact', () => {
  const root = makeFixture('tpah-copy-render-', {
    'readme.md': '# {{PROJECT_NAME}} by {{GITHUB_OWNER}} — {{NOT_A_TOKEN}}\n',
  })
  const out = renderEntry({ sourcePath: join(root, 'readme.md') }, {
    PROJECT_NAME: 'Acme',
    GITHUB_OWNER: 'acme-co',
  })
  assert.equal(typeof out, 'string')
  assert.equal(out, '# Acme by acme-co — {{NOT_A_TOKEN}}\n')
})

test('renderEntry round-trips a binary asset as a byte-identical Buffer', () => {
  // Bytes that are NOT valid UTF-8: a UTF-8 decode would replace 0xFF/0x80/0xFE
  // with U+FFFD (0xEF 0xBF 0xBD) and corrupt the file on re-encode.
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x80, 0xfe, 0x0d, 0x0a, 0x1a])
  const root = makeFixture('tpah-copy-bin-', { 'logo.png': bytes })
  const out = renderEntry({ sourcePath: join(root, 'logo.png') }, ALL_ANSWERS)
  assert.ok(Buffer.isBuffer(out), 'binary assets must come back as Buffers, not strings')
  assert.equal(out.length, bytes.length)
  assert.deepStrictEqual(out, bytes)
  // No U+FFFD replacement bytes leaked in — proves it was never UTF-8 decoded.
  assert.ok(!out.includes(Buffer.from([0xef, 0xbf, 0xbd])))
})

test('renderEntry never placeholder-renders inside a binary asset', () => {
  // The same token text that renderEntry would substitute in a text file must
  // survive verbatim inside a binary asset (no render on the Buffer path).
  const payload = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from('{{PROJECT_NAME}}', 'utf8'),
    Buffer.from([0x00, 0x80]),
  ])
  const root = makeFixture('tpah-copy-bin2-', { 'sprite.webp': payload })
  const out = renderEntry({ sourcePath: join(root, 'sprite.webp') }, { PROJECT_NAME: 'Acme' })
  assert.deepStrictEqual(out, payload)
  assert.ok(out.includes(Buffer.from('{{PROJECT_NAME}}', 'utf8')), 'token must survive verbatim')
})

test('renderEntry binary detection is case-insensitive on the extension', () => {
  const bytes = Buffer.from([0x00, 0xff, 0x10])
  const root = makeFixture('tpah-copy-case-', { 'ICON.PNG': bytes, 'Favicon.Ico': bytes })
  assert.ok(Buffer.isBuffer(renderEntry({ sourcePath: join(root, 'ICON.PNG') }, {})))
  assert.ok(Buffer.isBuffer(renderEntry({ sourcePath: join(root, 'Favicon.Ico') }, {})))
})

test('walkTemplate(base): top-level dotless RENAMES map to dot-paths, storage stays dotless', () => {
  const byInstall = new Map(walkTemplate('base').map((e) => [e.installPath, e]))
  const cases = [
    ['.gitignore', 'base/gitignore'],
    ['.mcp.json', 'base/mcp.json'],
    ['.editorconfig', 'base/editorconfig'],
    ['.gitattributes', 'base/gitattributes'],
    ['.nvmrc', 'base/nvmrc'],
    ['.node-version', 'base/node-version'],
    ['.env.example', 'base/env.example'],
    ['.gitleaks.toml', 'base/gitleaks.toml'],
    ['.dependency-cruiser.cjs', 'base/dependency-cruiser.cjs'],
  ]
  for (const [installPath, storagePath] of cases) {
    const e = byInstall.get(installPath)
    assert.ok(e, `expected a base entry installing to ${installPath}`)
    assert.equal(e.storagePath, storagePath)
  }
  // The `github` dir is renamed at top level; its nested files install under
  // .github/ (the rename is applied to the directory, not each leaf).
  assert.ok([...byInstall.keys()].some((p) => p.startsWith('.github/')))
})

test('walkTemplate(base): .tmpl is stripped from installPath but kept in storagePath', () => {
  const pkg = walkTemplate('base').find((e) => e.installPath === 'package.json')
  assert.ok(pkg, 'base must install a package.json')
  assert.equal(pkg.storagePath, 'base/package.json.tmpl')
  assert.ok(pkg.storagePath.endsWith('.tmpl'))
  assert.ok(!pkg.installPath.endsWith('.tmpl'))
})

test('walkTemplate(base) emits only POSIX-normalized paths (no backslashes leak)', () => {
  for (const e of walkTemplate('base')) {
    assert.ok(!e.storagePath.includes('\\'), `backslash in storagePath: ${e.storagePath}`)
    assert.ok(!e.installPath.includes('\\'), `backslash in installPath: ${e.installPath}`)
  }
})

test('walkTemplate + renderEntry compose to exactly planTree on the real base tree', () => {
  const composed = walkTemplate('base').map((e) => ({
    storagePath: e.storagePath,
    installPath: e.installPath,
    content: renderEntry(e, ALL_ANSWERS),
  }))
  assert.deepStrictEqual(composed, planTree('base', ALL_ANSWERS))
})

test('planTree over the REAL base tree renders every entry with no leftover unknown placeholders', () => {
  const plan = planTree('base', ALL_ANSWERS)
  assert.ok(plan.length > 0, 'base tree must not be empty')
  for (const e of plan) {
    if (Buffer.isBuffer(e.content)) continue // binary assets are not rendered
    const leftover = [...tokensIn(e.content)]
    assert.equal(
      leftover.length,
      0,
      `${e.installPath} has unrendered {{...}} tokens (unregistered placeholders?): ${leftover.join(', ')}`,
    )
  }
})

test('storageToInstall: the one rename rule — top-level RENAMES, .tmpl strip, nested names untouched', () => {
  assert.equal(storageToInstall('gitignore'), '.gitignore')
  assert.equal(storageToInstall('github/workflows/ci.yml'), '.github/workflows/ci.yml')
  assert.equal(storageToInstall('package.json.tmpl'), 'package.json')
  assert.equal(storageToInstall('tools/x.mjs.tmpl'), 'tools/x.mjs')
  // Rename applies to the FIRST segment only — nested dotless names stay put.
  assert.equal(storageToInstall('sub/gitignore'), 'sub/gitignore')
  assert.equal(storageToInstall('sub/github/x.yml'), 'sub/github/x.yml')
  // Windows-authored input normalizes at the boundary.
  assert.equal(storageToInstall('github\\CODEOWNERS'), '.github/CODEOWNERS')
})

test('storageToInstall agrees with walkTemplate on EVERY real template file (no second rename implementation)', () => {
  // The seeded-migrations selftest gate maps `git diff` storage paths through
  // storageToInstall; this closure over the real trees proves that mapping can
  // never disagree with the walker that `init`/`update` actually install with.
  const root = templateRoot()
  const trees = ['base', 'stack']
  for (const entry of readdirSyncSafe(join(root, 'modules'))) trees.push(`modules/${entry}`)
  let checked = 0
  for (const tree of trees) {
    for (const e of walkTemplate(tree)) {
      const treeRel = toPosix(relative(join(root, tree), e.sourcePath))
      assert.equal(
        storageToInstall(treeRel),
        e.installPath,
        `${tree}/${treeRel}: mapper and walker disagree`,
      )
      checked += 1
    }
  }
  // Anti-vacuity floor: the full template surface (base + stack + the 11 W7
  // module trees) walks to 300+ files — a mapper/walker closure that "passed"
  // over a handful of files would prove nothing. (The W0 port skeleton ran at
  // > 10; restored to the finished-template floor when the module trees landed.)
  assert.ok(checked > 200, `expected the template surface, checked only ${checked}`)
})

// readdirSync that treats a missing dir as empty — module trees are optional.
function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

test('walkTemplate returns [] for a missing tree, and planTree agrees', () => {
  assert.deepEqual(walkTemplate('base/does-not-exist-xyz'), [])
  assert.deepEqual(planTree('base/does-not-exist-xyz', ALL_ANSWERS), [])
})

test('a NESTED file named `gitignore` is NOT renamed — rename applies at top level only', (t) => {
  const root = makeFixture('tpah-copy-rename-', {
    gitignore: 'top\n',
    'github/CODEOWNERS': 'owners\n',
    'sub/gitignore': 'nested\n',
    'sub/github': 'a plain file, not the dir\n',
    'foo.txt.tmpl': 'hi {{PROJECT_NAME}}\n',
    'sub/bar.mjs.tmpl': 'nested tmpl\n',
  })
  const tree = treeFor(root)
  if (tree === null) {
    t.skip('tmpdir on a different drive than the repo — template-relative tree unreachable')
    return
  }
  const byInstall = new Map(walkTemplate(tree).map((e) => [e.installPath, e]))
  // Top-level names ARE renamed to their dot-paths.
  assert.ok(byInstall.has('.gitignore'), 'top-level gitignore -> .gitignore')
  assert.ok(byInstall.has('.github/CODEOWNERS'), 'top-level github/ -> .github/')
  // Nested names are left exactly as stored — the rename gate is relInstall===''.
  assert.ok(byInstall.has('sub/gitignore'), 'nested gitignore must stay dotless')
  assert.ok(byInstall.has('sub/github'), 'nested plain file named github must stay dotless')
  assert.ok(!byInstall.has('sub/.gitignore'), 'nested gitignore must NOT gain a dot')
  assert.ok(!byInstall.has('sub/.github'), 'nested github must NOT gain a dot')
  // `.tmpl` is stripped at any depth.
  assert.ok(byInstall.has('foo.txt'), 'top-level .tmpl stripped')
  assert.ok(byInstall.has('sub/bar.mjs'), 'nested .tmpl stripped')
})

test('walkTemplate + renderEntry compose to exactly planTree on a fixture tree', (t) => {
  const root = makeFixture('tpah-copy-compose-', {
    'readme.md': '# {{PROJECT_NAME}}\n',
    gitignore: 'node_modules\n',
    'nested/config.json.tmpl': '{ "owner": "{{GITHUB_OWNER}}" }\n',
    'assets/pixel.png': Buffer.from([0x00, 0xff, 0x89, 0x50]),
  })
  const tree = treeFor(root)
  if (tree === null) {
    t.skip('tmpdir on a different drive than the repo — template-relative tree unreachable')
    return
  }
  const answers = { PROJECT_NAME: 'Compose', GITHUB_OWNER: 'octo' }
  const composed = walkTemplate(tree).map((e) => ({
    storagePath: e.storagePath,
    installPath: e.installPath,
    content: renderEntry(e, answers),
  }))
  const planned = planTree(tree, answers)
  assert.deepStrictEqual(composed, planned)
  // And the binary member really is a verbatim Buffer inside the plan.
  const png = planned.find((e) => e.installPath === 'assets/pixel.png')
  assert.deepStrictEqual(png.content, Buffer.from([0x00, 0xff, 0x89, 0x50]))
})

test('walkTemplate returns [] for an empty directory', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tpah-copy-empty-'))
  const tree = treeFor(root)
  if (tree === null) {
    t.skip('tmpdir on a different drive than the repo — template-relative tree unreachable')
    return
  }
  assert.deepEqual(walkTemplate(tree), [])
  assert.deepEqual(planTree(tree, ALL_ANSWERS), [])
})
