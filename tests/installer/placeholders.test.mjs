import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PLACEHOLDERS, render, tokensIn } from '../../installer/lib/placeholders.mjs'

test('render substitutes registered tokens and leaves unknown ones intact', () => {
  const out = render('# {{PROJECT_NAME}} by {{GITHUB_OWNER}} — {{NOT_A_TOKEN}}', {
    PROJECT_NAME: 'Acme',
    GITHUB_OWNER: 'acme-co',
  })
  assert.equal(out, '# Acme by acme-co — {{NOT_A_TOKEN}}')
})

test('render does not touch GitHub Actions ${{ }} expressions', () => {
  const yaml = 'run: echo ${{ secrets.GITHUB_TOKEN }} ${{ github.ref }}'
  assert.equal(render(yaml, { PROJECT_NAME: 'x' }), yaml)
})

test('tokensIn finds all distinct tokens', () => {
  assert.deepEqual([...tokensIn('{{A_1}} {{A_1}} {{B_2}}')], ['A_1', 'B_2'])
})

test('PROJECT_SLUG default kebab-cases the project name', () => {
  const ctx = { dirName: 'ignored', answers: { PROJECT_NAME: 'Acme  Portal!' } }
  assert.equal(PLACEHOLDERS.PROJECT_SLUG.default(ctx), 'acme-portal')
})

test('SECURITY_OWNERS defaults to @GITHUB_OWNER', () => {
  const ctx = { answers: { GITHUB_OWNER: 'acme-co' } }
  assert.equal(PLACEHOLDERS.SECURITY_OWNERS.default(ctx), '@acme-co')
})

test('APP_IDENTIFIER derives reverse-DNS from slug, stripping non-alphanumerics', () => {
  const ctx = { answers: { PROJECT_SLUG: 'acme-curriculum' } }
  assert.equal(PLACEHOLDERS.APP_IDENTIFIER.default(ctx), 'com.example.acmecurriculum')
})

test('APP_IDENTIFIER validation enforces the iOS∩Android intersection (no hyphens, no underscores)', () => {
  const v = PLACEHOLDERS.APP_IDENTIFIER.validate
  assert.equal(v('com.acme.curriculum'), null)
  assert.match(v('com.acme.my-app') ?? '', /Android forbids/)
  assert.match(v('com.acme.my_app') ?? '', /iOS forbids/)
  assert.match(v('acme') ?? '', /reverse-DNS/)
  assert.match(v('com.9acme.app') ?? '', /reverse-DNS/)
})

test('APP_SCHEME derives from the slug with dashes stripped, and rejects non-alphanumerics', () => {
  const ctx = { answers: { PROJECT_SLUG: 'acme-curriculum' } }
  assert.equal(PLACEHOLDERS.APP_SCHEME.default(ctx), 'acmecurriculum')
  assert.equal(PLACEHOLDERS.APP_SCHEME.validate('acmecurriculum'), null)
  assert.notEqual(PLACEHOLDERS.APP_SCHEME.validate('acme-curriculum'), null)
  assert.notEqual(PLACEHOLDERS.APP_SCHEME.validate('9acme'), null)
})

test('EAS/store identity placeholders accept TBD and their real shapes, nothing else', () => {
  assert.equal(PLACEHOLDERS.EAS_PROJECT_ID.validate('TBD'), null)
  assert.equal(PLACEHOLDERS.EAS_PROJECT_ID.validate('01234567-89ab-cdef-0123-456789abcdef'), null)
  assert.notEqual(PLACEHOLDERS.EAS_PROJECT_ID.validate('not-a-uuid'), null)
  assert.equal(PLACEHOLDERS.ASC_APP_ID.validate('TBD'), null)
  assert.equal(PLACEHOLDERS.ASC_APP_ID.validate('6448311069'), null)
  assert.notEqual(PLACEHOLDERS.ASC_APP_ID.validate('abc123'), null)
  assert.equal(PLACEHOLDERS.APPLE_TEAM_ID.validate('TBD'), null)
  assert.equal(PLACEHOLDERS.APPLE_TEAM_ID.validate('AB12CD34EF'), null)
  assert.notEqual(PLACEHOLDERS.APPLE_TEAM_ID.validate('short'), null)
})

test('WEB_ORIGIN defaults to local loopback for bootstrap-green', () => {
  // apps/web is BOTH the web client and the API host, so the default is the Next
  // dev port — not a separate server's. 3000, not 8787.
  assert.equal(PLACEHOLDERS.WEB_ORIGIN.default({}), 'http://127.0.0.1:3000')
})

test('WEB_ORIGIN rejects anything that is not a bare origin', () => {
  // It lands in the committed transport policy the expo-policy gate asserts, so a
  // trailing path or slash would be baked into a shipped binary.
  assert.equal(PLACEHOLDERS.WEB_ORIGIN.validate('https://app.example.com'), null)
  assert.equal(PLACEHOLDERS.WEB_ORIGIN.validate('http://127.0.0.1:3000'), null)
  assert.notEqual(PLACEHOLDERS.WEB_ORIGIN.validate('https://app.example.com/'), null)
  assert.notEqual(PLACEHOLDERS.WEB_ORIGIN.validate('https://app.example.com/api'), null)
  assert.notEqual(PLACEHOLDERS.WEB_ORIGIN.validate('app.example.com'), null)
})

test('DESIGN_TOKENS defaults to "default" and accepts only the registered presets', () => {
  const spec = PLACEHOLDERS.DESIGN_TOKENS
  assert.equal(spec.default(), 'default')
  assert.equal(spec.validate('default'), null)
  assert.equal(spec.validate('metal'), null)
  // Case-sensitive and closed: the value selects a template tree by exact key.
  assert.match(spec.validate('Metal') ?? '', /default, metal/)
  assert.match(spec.validate('chrome') ?? '', /default, metal/)
  assert.match(spec.validate('') ?? '', /default, metal/)
})

test('SUPABASE_PROJECT_REF accepts TBD or a 20-char ref, nothing else', () => {
  // TBD keeps init from blocking on project creation; doctor warns while it remains.
  assert.equal(PLACEHOLDERS.SUPABASE_PROJECT_REF.default(), 'TBD')
  assert.equal(PLACEHOLDERS.SUPABASE_PROJECT_REF.validate('TBD'), null)
  assert.equal(PLACEHOLDERS.SUPABASE_PROJECT_REF.validate('abcdefghijklmnopqrst'), null)
  assert.notEqual(PLACEHOLDERS.SUPABASE_PROJECT_REF.validate('tooshort'), null)
  assert.notEqual(PLACEHOLDERS.SUPABASE_PROJECT_REF.validate('ABCDEFGHIJKLMNOPQRST'), null)
})
