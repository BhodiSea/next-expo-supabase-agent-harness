// THE NPM DESCRIPTION HAS TO FIT WHAT THE REGISTRY KEEPS (#166).
//
// npm's registry stores the first 255 characters of a package's description and drops the
// rest, and `npm publish` says nothing about it. 2.0.3 shipped a 363-character description,
// and the registry holds it cut off mid-word, ending "...cross-surface parity and design-to".
// `npm view` and `npm search` both show that cut. A publish cannot be taken back, so the
// length is checked on the pull request, before the tag.
//
// The repository's description on GitHub is a setting, not a file, so no test reads it.
//
// SOURCE: npm view next-expo-supabase-agent-harness@2.0.3 description (255 of the tarball's 363 characters)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** The number of characters of a description npm's registry keeps. */
const NPM_DESCRIPTION_LIMIT = 255

/**
 * Why a description would not reach the registry whole, or null when it would.
 *
 * @param {unknown} description
 * @returns {string | null}
 */
function descriptionProblem(description) {
  if (typeof description !== 'string' || description.trim() === '') {
    return 'package.json has no description, so npm shows none'
  }
  if (description.length > NPM_DESCRIPTION_LIMIT) {
    return `package.json's description is ${String(description.length)} characters, and npm keeps the first ${String(NPM_DESCRIPTION_LIMIT)}: it would be published ending "${description.slice(NPM_DESCRIPTION_LIMIT - 30, NPM_DESCRIPTION_LIMIT)}"`
  }
  return null
}

test("package.json's description fits in what npm keeps", () => {
  const { description } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(descriptionProblem(description), null)
})

test('the check can go red: one character over the limit, and no description', () => {
  assert.equal(descriptionProblem('x'.repeat(NPM_DESCRIPTION_LIMIT)), null)
  assert.match(descriptionProblem('x'.repeat(NPM_DESCRIPTION_LIMIT + 1)) ?? '', /is 256 characters, and npm keeps the first 255/)
  assert.match(descriptionProblem(undefined) ?? '', /has no description/)
  assert.match(descriptionProblem('  ') ?? '', /has no description/)
})
