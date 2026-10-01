// The shipped workflow universe, walked once for the three factory checks that judge it
// (1.0.4, #55): scripts/check-canary-coverage.mjs (the #lanes and #moduleLanes closures),
// scripts/check-ci-preconditions.mjs and tests/gates/workflow-lanes.test.mjs.
//
// Template workflows are stored without the leading dot (template/<tree>/github/workflows/),
// so none of them ever runs in this repository, and these checks are the only thing here that
// reads them. Through 1.0.3 all three read template/base/ only, which left the ten module
// workflows outside every one of them (CHANGELOG 1.0.2, "How it was missed").
//
// A plain readdirSync, not installer/lib/copy.mjs#walkTemplate: that resolves paths only under
// template/, so it cannot serve check-canary-coverage's --modules-dir override. Labels are
// joined with '/' from directory and file NAMES, never taken from a filesystem path, because
// these checks also run on the Windows leg of installer-unit.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const WORKFLOW_FILE = /\.ya?ml$/

/**
 * The workflow file names directly in `dir`, sorted; none when the directory does not exist.
 * @param {string} dir
 * @returns {string[]}
 */
function workflowNames(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => WORKFLOW_FILE.test(f))
    .sort()
}

/**
 * The base tree's workflows, sorted by file name.
 * @param {string} root the repository root
 * @returns {Array<{ file: string, label: string, text: string }>} `label` is the
 *   repo-relative path, e.g. `template/base/github/workflows/quality-gate.yml`
 */
export function baseWorkflows(root) {
  const dir = join(root, 'template', 'base', 'github', 'workflows')
  return workflowNames(dir).map((file) => ({
    file,
    label: `template/base/github/workflows/${file}`,
    text: readFileSync(join(dir, file), 'utf8'),
  }))
}

/**
 * Every module's workflows, `<modulesDir>/<module>/github/workflows/*.y?ml`, with modules and
 * files sorted. A module that ships no workflow contributes nothing, and a `modulesDir` that
 * does not exist yields an empty list rather than a throw, so a caller that must fail closed
 * reports the empty universe as a finding instead of crashing.
 * @param {string} modulesDir
 * @param {string} [labelPrefix] how labels spell `modulesDir`; `template/modules` by default
 * @returns {Array<{ module: string, file: string, label: string, text: string }>}
 */
export function moduleWorkflows(modulesDir, labelPrefix = 'template/modules') {
  if (!existsSync(modulesDir)) return []
  return readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((module) => {
      const dir = join(modulesDir, module, 'github', 'workflows')
      return workflowNames(dir).map((file) => ({
        module,
        file,
        label: `${labelPrefix}/${module}/github/workflows/${file}`,
        text: readFileSync(join(dir, file), 'utf8'),
      }))
    })
}

/**
 * The job ids of one workflow: every two-space key after the first `\njobs:`, the parse the
 * canary checker has used since 0.3.0. `null` when the file has no `jobs:` block, so a caller
 * can tell a missing block from a block it could not parse.
 * @param {string} text
 * @returns {string[] | null}
 */
export function jobIdsOf(text) {
  const at = text.indexOf('\njobs:')
  if (at === -1) return null
  return [...text.slice(at).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1])
}
