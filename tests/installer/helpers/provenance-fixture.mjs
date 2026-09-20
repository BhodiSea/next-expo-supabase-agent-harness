// Shared fixture for the in-process installer tests that need released-sha tables.
//
// "Age" an install the way the older tests did — stale bytes on disk, their sha re-recorded
// in the manifest — and the result is byte-for-byte what a consumer's FORK looks like. What
// tells the two apart is whether a release shipped those bytes, so a test that means "an
// older harness installed this" has to SAY so, by putting the stale sha in the table it
// injects. These helpers build those tables from the real template, so a fixture is always
// the live owned surface plus the one or two variants the scenario is about.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { init } from '../../../installer/commands/init.mjs'
import { update } from '../../../installer/commands/update.mjs'
import { renderEntry, walkTemplate } from '../../../installer/lib/copy.mjs'
import { fileMode, installerVersion, sha256 } from '../../../installer/lib/manifest.mjs'
import { ownedMap, templateTrees } from '../../../scripts/lib/released-shas.mjs'

const TEMPLATE = fileURLToPath(new URL('../../../template/', import.meta.url))

export const VERSION = installerVersion()

/** What the LIVE template ships per owned install path — the same function the generator uses. */
export function liveOwned() {
  return ownedMap({ trees: templateTrees(TEMPLATE), walkTemplate, renderEntry, fileMode })
}

/**
 * Tables for one version: the live owned surface, with `extra` variants ADDED per path —
 * "this version also shipped these bytes", which is what a release history looks like.
 *
 * @param {Record<string, Array<{ sha256: string, sites?: Array<[number, string]> }>>} [extra]
 * @param {string} [version]
 */
export function tablesWith(extra = {}, version = VERSION) {
  const files = liveOwned()
  for (const [path, variants] of Object.entries(extra)) files[path] = [...variants, ...(files[path] ?? [])]
  return { [version]: files }
}

/** Run `fn` with the installer's console chatter swallowed; returns what it logged. */
/** @template T @param {() => Promise<T> | T} fn @returns {Promise<{ result: T, out: string }>} */
export async function captured(fn) {
  const lines = []
  const saved = { log: console.log, warn: console.warn, error: console.error }
  /** @param {unknown[]} a */
  const sink = (...a) => lines.push(a.map(String).join(' '))
  console.log = sink
  console.warn = sink
  console.error = sink
  try {
    return { result: await fn(), out: lines.join('\n') }
  } finally {
    Object.assign(console, saved)
  }
}

/** @param {Record<string, unknown>} opts @param {Record<string, unknown>} [ctx] */
export async function captureUpdate(opts, ctx) {
  const { result, out } = await captured(() => update(opts, ctx))
  return { code: result, out }
}

/** @param {string} out */
export const parseReport = (out) => JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))

/** @param {string} prefix @param {Record<string, unknown>} [opts] */
export async function freshInstall(prefix, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const { result } = await captured(() =>
    init({
      dir,
      tier: 'core',
      yes: true,
      set: ['PROJECT_NAME=Fixture App', 'GITHUB_OWNER=fixture-owner', 'SECURITY_OWNERS=@fixture-owner/security'],
      ...opts,
    }),
  )
  assert.equal(result, 0, 'fixture precondition: init must succeed')
  return dir
}

/** @param {string} dir */
export const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, '.harness', 'manifest.json'), 'utf8'))

/** @param {string} dir @param {Record<string, unknown>} manifest */
export function writeManifestOf(dir, manifest) {
  writeFileSync(join(dir, '.harness', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Put `bytes` at an install path AND re-record their sha — the act that is shared by "an
 * older harness installed this" and "a consumer forked this". Returns the sha.
 *
 * @param {string} dir @param {string} ip @param {string} bytes
 */
export function recordBytes(dir, ip, bytes) {
  writeFileSync(join(dir, ip), bytes)
  const manifest = manifestOf(dir)
  manifest.files[ip] = { ...(manifest.files[ip] ?? { mode: 'owned' }), sha256: sha256(bytes) }
  writeManifestOf(dir, manifest)
  return sha256(bytes)
}
