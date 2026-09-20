// The released-sha tables — the git and filesystem half.
//
// What a HISTORICAL commit shipped, judged by that commit's own installer. Shared by
// scripts/generate-released-shas.mjs (which folds every release commit into the tables)
// and scripts/check-released-shas.mjs --verify-tags (which requires every tag's tree to be
// inside its version's table), so the two cannot disagree about what a commit ships. The
// pure judgements are in ./released-shas.mjs.
//
// `git archive`, not a worktree: it writes nothing under .git, so it cannot race the
// upgrade lane's `worktree prune`, and an interrupted run leaves no registration behind.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { derender } from '../../installer/lib/provenance.mjs'
import { ownedMap, templateTrees } from './released-shas.mjs'

/** @param {string} root @param {string[]} argv */
export const git = (root, argv) =>
  execFileSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })

// Probe answers for the derender self-proof: every token gets a value no source text
// contains, including the shapes that break a derender which SEARCHES instead of walking
// offsets (a value carrying the token opener, a value with spaces).
/** @param {string[]} tokens */
function probeAnswers(tokens) {
  /** @type {Record<string, string>} */
  const answers = {}
  for (const [i, token] of tokens.entries()) answers[token] = i % 3 === 0 ? `probe{{${String(i)}` : `p${String(i)} two words`
  return answers
}

/**
 * The owned map of one extracted tree, SELF-PROVED: that tree's own `render`, fed probe
 * answers, must `derender` back to the source for every placeholder-bearing owned file.
 * The sites are computed with today's token regex and the inversion is checked against the
 * historical renderer, so a commit whose token syntax differed would fail here, loudly,
 * instead of yielding a table that parks that vintage's untouched files.
 *
 * @param {string} dir an extracted `installer/` + `template/` tree @param {string} label
 */
export async function ownedMapOfTree(dir, label) {
  const copy = await import(pathToFileURL(join(dir, 'installer/lib/copy.mjs')).href)
  const manifest = await import(pathToFileURL(join(dir, 'installer/lib/manifest.mjs')).href)
  const placeholders = await import(pathToFileURL(join(dir, 'installer/lib/placeholders.mjs')).href)
  const trees = templateTrees(join(dir, 'template'))
  const map = ownedMap({ trees, walkTemplate: copy.walkTemplate, renderEntry: copy.renderEntry, fileMode: manifest.fileMode })
  for (const entry of trees.flatMap((tree) => copy.walkTemplate(tree))) {
    const sites = map[entry.installPath]?.find((v) => v.sites)?.sites
    const source = sites === undefined ? null : copy.renderEntry(entry, {})
    if (sites === undefined || typeof source !== 'string') continue
    const answers = probeAnswers([...new Set(sites.map(([, token]) => token))])
    if (derender(placeholders.render(source, answers), sites, answers) !== source) {
      throw new Error(`${label}: derender does not invert this commit's own render for ${entry.installPath}`)
    }
  }
  return map
}

/**
 * Run `fn` over one commit's extracted installer + template, then remove the extraction.
 *
 * @template T @param {string} root @param {string} commit @param {(dir: string) => Promise<T> | T} fn
 */
export async function withExtracted(root, commit, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'released-shas-'))
  try {
    const tar = execFileSync('git', ['archive', '--format=tar', commit, 'installer', 'template', 'package.json'], {
      cwd: root,
      maxBuffer: 1024 * 1024 * 1024,
    })
    const untar = spawnSync('tar', ['-x', '-C', dir], { input: tar })
    if (untar.status !== 0) throw new Error(`tar failed for ${commit}: ${String(untar.stderr)}`)
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Every release tag in this clone, oldest name first: `{ tag, commit, version }`. */
/** @param {string} root */
export function releaseTags(root) {
  return git(root, ['tag', '--list', 'v*.*.*'])
    .split('\n')
    .filter(Boolean)
    .sort()
    .map((tag) => ({ tag, commit: git(root, ['rev-parse', `${tag}^{commit}`]).trim(), version: tag.replace(/^v/, '') }))
}

/**
 * First-parent `main` plus every release tag, oldest first, deduplicated. The documented
 * install command carries no tag, so an install can come from any commit `main` ever
 * pointed at — and a tag cut off `main` (a release branch) is a release too.
 *
 * @param {string} root
 */
export function releaseCommits(root) {
  const mainRef = ['main', 'origin/main'].find((ref) => {
    try {
      git(root, ['rev-parse', '-q', '--verify', `${ref}^{commit}`])
      return true
    } catch {
      return false
    }
  })
  if (mainRef === undefined) {
    throw new Error('neither main nor origin/main resolves — the full history is needed (fetch-depth: 0)')
  }
  const firstParent = git(root, ['rev-list', '--first-parent', '--reverse', mainRef]).split('\n').filter(Boolean)
  return [...new Set([...firstParent, ...releaseTags(root).map((t) => t.commit)])]
}
