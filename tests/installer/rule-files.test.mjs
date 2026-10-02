// The always-loaded rule surface stays small, and what it points at exists (#67, N18).
//
// Every session loads `.claude/rules/*.md` files that carry no `paths:` frontmatter, and a
// file that carries one loads only when a matching file is read (design/CONTROL-PLANE-FACTS.md
// Fact 9). Until 1.1.0 `encryption.md` was always loaded while the `e2ee` module that
// implements most of it is opt-in. It is now a stub holding what applies with the module off,
// and the full rule is the path-scoped `e2ee.md`. These cases hold that split, and they hold
// the shipped files that cite a rule file by path to a file that exists.
//
// Read-only over the template tree, so the Windows leg runs every case. `parseFrontmatter` in
// tools/lib/agent-roster.mjs is not reused: it rejects `- ` sequences by design, and a YAML
// list is exactly what a rule's `paths:` must be.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = fileURLToPath(new URL('../../template/base', import.meta.url))
const RULES = '.claude/rules'
const STUB = `${RULES}/encryption.md`
const SCOPED = `${RULES}/e2ee.md`
const SCOPED_GLOBS = ['packages/platform/crypto/**', 'apps/*/src/host/**', 'docs/modules/e2ee/**']
// The rule ids the stub must name: each is active in a base install with the module off
// (eslint.config.mjs for the two lint rules, guard-rules.mjs for the three write-guard rules).
const STUB_CHECKS = [
  'math-random-key-material',
  'hardcoded-key-material',
  'weak-crypto-algorithm',
  'crypto-primitives-one-door',
  'no-insecure-random-in-crypto-scope',
]
// Files that cite a rule file as `SOURCE: .claude/rules/<file>`: a deny message or a lint
// rule sends the reader there, so the file must exist and say what the citation claims.
const CITING_FILES = ['.claude/hooks/lib/guard-rules.mjs', 'tools/eslint-rules/index.mjs']

const readBase = (rel) => readFileSync(join(BASE, rel), 'utf8')
const existsBase = (rel) => existsSync(join(BASE, rel))

/** The frontmatter block between the opening and closing `---` lines, or null. */
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
  return m === null ? null : m[1]
}

/** The globs of a `paths:` YAML list, or null when there is no `paths:` key. */
function pathsList(fm) {
  if (fm === null || !/^paths:/m.test(fm)) return null
  const block = /^paths:[ \t]*\r?\n((?:[ \t]+-[ \t]+.*(?:\r?\n|$))+)/m.exec(fm)
  if (block === null) return []
  return block[1]
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => line.replace(/^[ \t]+-[ \t]+/, '').replace(/^["']|["']$/g, ''))
}

/** The body after the frontmatter (the whole text when there is none). */
function body(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
}

/** Every `SOURCE: .claude/rules/<file>.md` path a file cites. */
function ruleCitations(text) {
  return [...text.matchAll(/SOURCE: (\.claude\/rules\/[A-Za-z0-9._-]+\.md)/g)].map((m) => m[1])
}

/** The rule files the template ships. */
function shippedRules() {
  return readdirSync(join(BASE, RULES)).filter((f) => f.endsWith('.md'))
}

test('(a) encryption.md stays always loaded and names the scoped rule, which exists', () => {
  const stub = readBase(STUB)
  assert.equal(pathsList(frontmatter(stub)), null, `${STUB} must carry no paths: key`)
  assert.match(stub, /always loaded/i, `${STUB} must say it is always loaded`)
  assert.ok(stub.includes(SCOPED), `${STUB} must name ${SCOPED}`)
  assert.ok(existsBase(SCOPED), `${SCOPED} must exist`)
})

test('(b) the scoped rule is a YAML paths: list and does not call itself always loaded', () => {
  assert.ok(existsBase(SCOPED), `${SCOPED} must exist`)
  const text = readBase(SCOPED)
  const globs = pathsList(frontmatter(text))
  assert.notEqual(globs, null, `${SCOPED} must carry a paths: key`)
  assert.deepEqual(globs, SCOPED_GLOBS, `${SCOPED} paths: must be the YAML list of its globs`)
  const heading = body(text).trimStart().split('\n')[0]
  assert.match(heading, /best-effort scoped/, `${SCOPED}'s heading must say it is best-effort`)
  assert.doesNotMatch(heading, /always loaded/i)
  assert.doesNotMatch(text, /this rule is always loaded/i)
  assert.doesNotMatch(text, /SOURCE: docs\/harness\/README\.md \(the always-loaded/)
})

test('(b) every shipped rule that scopes itself uses a YAML list, never a string', () => {
  for (const file of shippedRules()) {
    const fm = frontmatter(readBase(`${RULES}/${file}`))
    const globs = pathsList(fm)
    if (globs === null) continue
    assert.ok(globs.length > 0, `${RULES}/${file}: paths: must be a YAML list of globs`)
    for (const glob of globs) assert.doesNotMatch(glob, /,/, `${RULES}/${file}: ${glob}`)
  }
})

test('(c) the stub names the checks that hold it with the module off', () => {
  // Whitespace-flattened: markdown wraps a clause wherever the column runs out.
  const stub = readBase(STUB).replace(/\s+/g, ' ')
  for (const id of STUB_CHECKS) assert.ok(stub.includes(`\`${id}\``), `${STUB} must name ${id}`)
  // tools/conformance-map.json row 11.4.4 quotes this clause as the always-loaded rule's words.
  const kdf = 'a passphrase without a memory-hard KDF'
  assert.ok(stub.includes(kdf), `${STUB} must keep the KDF clause`)
  // tools/store-tunables.json (seeded, so existing installs keep the pointer) says this file
  // holds the iosEncryption twin.
  for (const token of ['iosEncryption', 'ITSAppUsesNonExemptEncryption', 'expo-policy']) {
    assert.ok(stub.includes(token), `${STUB} must keep the ${token} twin`)
  }
  assert.ok(stub.includes('docs/modules/e2ee/README.md'), `${STUB} must point at the module README`)
})

test('(d) every SOURCE: .claude/rules/<file> in guard-rules.mjs and the lint rules exists', () => {
  let cited = 0
  for (const rel of CITING_FILES) {
    for (const path of ruleCitations(readBase(rel))) {
      cited += 1
      assert.ok(existsBase(path), `${rel} cites ${path}, which the template does not ship`)
    }
  }
  assert.ok(cited > 0, 'the citing files cite no rule file: the pattern no longer matches')
})

test('the e2ee skill reads the scoped rule first, and the doctrine lists both files', () => {
  const skill = readBase('.claude/skills/authoring-e2ee-feature/SKILL.md')
  const step0 = /## Step 0[^\n]*\n([\s\S]*?)\n## /.exec(skill)
  assert.notEqual(step0, null, 'the skill must keep its Step 0 section')
  const first = /^1\. [\s\S]*?(?=^2\. )/m.exec(step0[1])
  assert.notEqual(first, null, 'Step 0 must be a numbered list')
  assert.ok(first[0].includes(SCOPED), `Step 0's first item must name ${SCOPED}`)
  const doctrine = readBase('docs/harness/README.md')
  const section = /## The security invariants\n([\s\S]*?)\n## /.exec(doctrine)
  assert.notEqual(section, null)
  const flat = section[1].replace(/\s+/g, ' ')
  assert.match(flat, /`encryption\.md` \(always loaded/)
  assert.match(flat, /`e2ee\.md` \(path-scoped, best effort/)
})
