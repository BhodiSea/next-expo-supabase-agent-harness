#!/usr/bin/env node
// THE RELEASE NOTES (2.0.0). release.yml's `release` job publishes the CHANGELOG.md section
// for the tag being built as the GitHub Release's body, and GitHub refuses a body over
// 125000 characters with HTTP 422. The 1.1.0 section is longer than that, so the first
// v1.1.0 build packed and attested the tarball and then failed at `gh release create`,
// which left `publish-npm` skipped and 1.1.0 unreleased. The step's two decisions live
// here rather than in YAML, so tests/gates/release-notes.test.mjs can falsify them:
//
//   section  the lines between `## [<version>]` and the next `## [` heading, exactly what the
//            awk this replaces extracted. A missing section is a HARD FAIL, as before.
//   bound    a section within the limit is the body unchanged. One over it keeps every line
//            that is not a top-level `- ` entry (the release's opening paragraphs and the
//            `###` headings) and shortens each entry to its bold lead sentence plus its
//            closing issue references, then links CHANGELOG.md at the tag for the full text.
//            Nothing is cut mid-entry and no heading is lost. A section that is still over
//            the limit after that is a HARD FAIL naming the size, because the remedy is an
//            edit to CHANGELOG.md that only a person can make.
//
// Size is measured in UTF-8 bytes, which is never less than GitHub's character count. The
// test suite also bounds the CHANGELOG section for the version in package.json, so a section
// that cannot be published fails a pull request rather than a tag build.
//   usage: node scripts/ci/release-notes.mjs <version> --repository <owner/repo>
//                 [--changelog PATH] [--limit N] > notes.md
// SOURCE: .github/workflows/release.yml · tests/gates/release-notes.test.mjs
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** GitHub's limit on a release body (HTTP 422 "body is too long (maximum is 125000 characters)"). */
export const RELEASE_BODY_LIMIT = 125000

/** @param {string} text */
const size = (text) => Buffer.byteLength(text, 'utf8')

/**
 * The CHANGELOG.md section for `version`, without its heading, or null when there is none.
 * @param {string} changelog
 * @param {string} version
 * @returns {string | null}
 */
export function sectionOf(changelog, version) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## ['))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/**
 * One top-level entry shortened to its bold lead and closing issue references. An entry
 * with no bold lead has nothing shorter to say, so it is kept whole.
 * @param {string[]} entry the entry's lines, the first starting with `- `
 * @returns {string[]}
 */
function shortenEntry(entry) {
  const text = entry.map((line) => line.trim()).join(' ')
  const lead = /^- (\*\*.+?\*\*)/.exec(text)
  if (lead === null) return entry
  const refs = /\(([^()]*#\d+[^()]*)\)\.?$/.exec(text)
  return [`- ${lead[1]}${refs === null ? '' : ` (${refs[1]})`}`]
}

/**
 * Every top-level `- ` entry shortened; every other line kept. An entry runs from its `- `
 * line through the indented lines and blank lines after it, up to the next line that
 * starts at column 0.
 * @param {string} section
 * @returns {string}
 */
export function shortenEntries(section) {
  const lines = section.split('\n')
  /** @type {string[]} */
  const out = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].startsWith('- ')) {
      out.push(lines[i])
      i += 1
      continue
    }
    let j = i + 1
    while (j < lines.length && (lines[j] === '' || /^\s/.test(lines[j]))) j += 1
    // Trailing blank lines separate this entry from what follows; they are not its text.
    let last = j
    while (last > i + 1 && lines[last - 1] === '') last -= 1
    out.push(...shortenEntry(lines.slice(i, last)), ...lines.slice(last, j))
    i = j
  }
  return out.join('\n')
}

/**
 * The release body for `section`: unchanged when it fits, shortened when it does not.
 * @param {string} section
 * @param {{ version: string, repository: string, limit?: number }} opts
 * @returns {{ notes: string, shortened: boolean } | { error: string }}
 */
export function boundNotes(section, { version, repository, limit = RELEASE_BODY_LIMIT }) {
  if (size(section) <= limit) return { notes: section, shortened: false }
  const url = `https://github.com/${repository}/blob/v${version}/CHANGELOG.md`
  const footer =
    '\n---\n\n' +
    `*This section is ${String(size(section))} bytes, over GitHub's ${String(limit)}-character ` +
    'limit on a release body, so each entry above is shortened to its lead sentence. Every entry in full: ' +
    `[CHANGELOG.md at v${version}](${url}).*\n`
  const notes = `${shortenEntries(section).trimEnd()}\n${footer}`
  if (size(notes) > limit) {
    return {
      error:
        `the ${version} section is ${String(size(section))} bytes and still ${String(size(notes))} ` +
        `with every entry shortened to its lead, over GitHub's ${String(limit)}-character ` +
        'release body limit. Shorten the section in CHANGELOG.md.',
    }
  }
  return { notes, shortened: true }
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`::error::release-notes: ${message}`)
  process.exit(1)
}

function main() {
  const args = process.argv.slice(2)
  /** @type {string[]} */
  const positionals = []
  let changelog = 'CHANGELOG.md'
  let repository = ''
  let limit = RELEASE_BODY_LIMIT
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--changelog') changelog = args[(i += 1)] ?? fail('--changelog takes a path')
    else if (arg === '--repository') repository = args[(i += 1)] ?? fail('--repository takes owner/repo')
    else if (arg === '--limit') limit = Number(args[(i += 1)])
    else positionals.push(arg)
  }
  const [version] = positionals
  if (version === undefined || positionals.length !== 1) fail('usage: release-notes.mjs <version> --repository <owner/repo>')
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) fail(`--repository must be owner/repo, got ${JSON.stringify(repository)}`)
  if (!Number.isInteger(limit) || limit <= 0) fail('--limit must be a positive integer')
  const section = sectionOf(readFileSync(changelog, 'utf8'), version)
  if (section === null) fail(`${changelog} is missing a '## [${version}]' section`)
  const bounded = boundNotes(section, { version, repository, limit })
  if ('error' in bounded) fail(bounded.error)
  if (bounded.shortened) {
    console.error(`release-notes: the ${version} section is over ${String(limit)} characters; each entry is shortened to its lead`)
  }
  process.stdout.write(bounded.notes)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
