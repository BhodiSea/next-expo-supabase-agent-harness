#!/usr/bin/env node
// Release lockstep: one version everywhere, asserted on every PR (not only at
// tag time — skew must red the PR that introduces it). Checks:
//   package.json.version == .claude-plugin/plugin.json.version
//     == every HARNESS_HOOK_VERSION stamp under template/base/.claude/hooks/
//     == GITHUB_REF_NAME (only when running on a v* tag)
// Doctor uses the hook stamps to tell "stale hook from an older harness" from
// "locally modified" — a stamp that skews from the released version breaks
// that diagnosis for every consumer.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = fileURLToPath(new URL('..', import.meta.url))
const problems = []

const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const pluginVersion = JSON.parse(
  readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'),
).version

if (pluginVersion !== pkgVersion) {
  problems.push(`.claude-plugin/plugin.json version ${pluginVersion} != package.json ${pkgVersion}`)
}

const hooksDir = join(root, 'template/base/.claude/hooks')
for (const entry of readdirSync(hooksDir)) {
  if (!entry.endsWith('.mjs')) continue
  const text = readFileSync(join(hooksDir, entry), 'utf8')
  const stamp = text.match(/HARNESS_HOOK_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]
  if (!stamp) {
    problems.push(`hooks/${entry} carries no HARNESS_HOOK_VERSION stamp`)
  } else if (stamp !== pkgVersion) {
    problems.push(`hooks/${entry} stamp ${stamp} != package.json ${pkgVersion}`)
  }
}

const tag = process.env.GITHUB_REF_NAME
if (tag?.startsWith('v') && tag.slice(1) !== pkgVersion) {
  problems.push(`git tag ${tag} != package.json ${pkgVersion}`)
}

// Citation + changelog ride the same lockstep: a release whose CITATION.cff or
// CHANGELOG section lags the version ships silently-stale metadata (release.yml
// re-checks the CHANGELOG at tag time, but skew should red the PR that causes it).
const citation = readFileSync(join(root, 'CITATION.cff'), 'utf8')
if (!citation.includes(`version: ${pkgVersion}`)) {
  problems.push(`CITATION.cff carries no "version: ${pkgVersion}"`)
}
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
if (!new RegExp(`^## \\[${pkgVersion.replaceAll('.', '\\.')}\\]`, 'm').test(changelog)) {
  problems.push(`CHANGELOG.md has no "## [${pkgVersion}]" section`)
}

if (problems.length > 0) {
  console.error('release lockstep FAILED:')
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log(`release lockstep: OK (v${pkgVersion} everywhere)`)
