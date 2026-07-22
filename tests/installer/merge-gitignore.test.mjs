// Unit tests for installer/lib/merge-gitignore.mjs: theirs verbatim, missing
// harness patterns appended under ONE marker block, dedup on trimmed line,
// idempotent on re-merge. These pin the current union semantics — regression
// armor for the retrofit path (a clobbered project .gitignore is destructive).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeGitignore } from '../../installer/lib/merge-gitignore.mjs'

const MARKER = '# --- next-expo-supabase-agent-harness ---'

const INCOMING = `# harness ignore rules
node_modules/
.dev-auth/
.harness/pending/
target/
`

test('union: theirs kept verbatim as a prefix, missing patterns appended under the marker', () => {
  const existing = '# mine\nnode_modules/\ndist/\n'
  const res = mergeGitignore(existing, INCOMING)
  assert.ok(res.merged.startsWith(existing), 'existing text must survive byte-for-byte at the top')
  assert.deepEqual(res.added, ['.dev-auth/', '.harness/pending/', 'target/'])
  // Exactly one marker block, blank-line separated, added lines in incoming order.
  assert.equal(
    res.merged,
    `${existing}\n${MARKER}\n.dev-auth/\n.harness/pending/\ntarget/\n`,
  )
})

test('duplicates are not re-appended: dedup matches on the trimmed line', () => {
  // Whitespace-padded and CRLF-terminated existing entries still count as present.
  const existing = '  node_modules/  \ntarget/\r\n.dev-auth/\n'
  const res = mergeGitignore(existing, INCOMING)
  assert.deepEqual(res.added, ['.harness/pending/'])
  assert.equal((res.merged.match(/node_modules\//g) ?? []).length, 1, 'no duplicate entry')
  assert.equal((res.merged.match(/target\//g) ?? []).length, 1, 'no duplicate entry')
})

test('incoming comments and blank lines are never appended', () => {
  const existing = 'node_modules/\n'
  const res = mergeGitignore(existing, '# a comment\n\n   \n.dev-auth/\n# trailing note\n')
  assert.deepEqual(res.added, ['.dev-auth/'])
  assert.ok(!res.merged.includes('# a comment'), 'incoming comments must not be copied over')
  assert.ok(!res.merged.includes('# trailing note'), 'incoming comments must not be copied over')
})

test('nothing missing → existing returned verbatim (no marker, no trailing-newline repair)', () => {
  // Deliberately no trailing newline: a no-op merge must not rewrite the file at all.
  const existing = '# mine\nnode_modules/\n.dev-auth/\n.harness/pending/\ntarget/'
  const res = mergeGitignore(existing, INCOMING)
  assert.equal(res.merged, existing)
  assert.deepEqual(res.added, [])
})

test('existing without a trailing newline gets one before the marker block', () => {
  const res = mergeGitignore('dist/', 'target/\n')
  assert.equal(res.merged, `dist/\n\n${MARKER}\ntarget/\n`)
  assert.deepEqual(res.added, ['target/'])
})

test('empty existing file: marker block still lands after the (empty) base', () => {
  const res = mergeGitignore('', 'target/\n')
  // '' does not end with \n, so the base gains one — pinned current behavior.
  assert.equal(res.merged, `\n\n${MARKER}\ntarget/\n`)
  assert.deepEqual(res.added, ['target/'])
})

test('idempotent: merging the merged result again is a byte-identical no-op', () => {
  const first = mergeGitignore('# mine\nnode_modules/\n', INCOMING)
  const second = mergeGitignore(first.merged, INCOMING)
  assert.equal(second.merged, first.merged)
  assert.deepEqual(second.added, [])
})

test('re-merge with a grown incoming set appends only the new pattern (marker per merge)', () => {
  const first = mergeGitignore('node_modules/\n', INCOMING)
  const grown = `${INCOMING}.new-cache/\n`
  const second = mergeGitignore(first.merged, grown)
  assert.deepEqual(second.added, ['.new-cache/'])
  assert.ok(second.merged.startsWith(first.merged), 'prior merge result kept verbatim')
  assert.ok(second.merged.endsWith(`\n${MARKER}\n.new-cache/\n`), second.merged)
  // Current behavior: each merge that adds lines opens its own marker block.
  assert.equal(second.merged.split(MARKER).length - 1, 2)
  // And the third merge with the same grown set settles back to a no-op.
  const third = mergeGitignore(second.merged, grown)
  assert.equal(third.merged, second.merged)
  assert.deepEqual(third.added, [])
})
