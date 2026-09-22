#!/usr/bin/env node
// A BOUNDED RETRY FOR THE ONE THING A SCAFFOLD INSTALL DOES NOT CONTROL: THE REGISTRY.
//
// THE INCIDENT (2026-09-22). npm published `@supabase/supabase-js@2.117.0` at 12:57:17Z
// and `@supabase/auth-js@2.117.0` — a dependency the parent pins EXACTLY — at 13:00:06Z,
// 169 seconds later. A selftest run resolved the parent at 12:59:59Z, seven seconds inside
// that window, and twelve jobs went red together on ERR_PNPM_NO_MATCHING_VERSION:
// bootstrap-linux on both Node majors, integration, canary, canary-mutation and seven
// upgrade legs. Nothing in this tree was wrong. A rendered scaffold has no lockfile by
// design and the catalog floats (`'@supabase/supabase-js': ^2.108.0`), so every job
// resolves live against the registry and all of them were inside the window at once.
//
// WHY NOT A BLIND RETRY. A lane that re-runs every failure stops being evidence: the
// matrix exists to catch a scaffold that does not install, and a blind retry turns that
// red into a slow green. So the rule is narrow — retry ONLY when the output carries a
// registry-side signature, and otherwise fail immediately with the original exit status,
// which is what every non-registry failure did before this script existed.
//
// WHY THE METADATA CACHE IS DROPPED BETWEEN ATTEMPTS. pnpm caches the packument it
// fetched, so a second attempt can be served the same version list that lacked the
// version — the retry would then fail for a reason that is no longer true upstream.
// `pnpm cache delete <pkg>` drops exactly the one package's metadata, so the next attempt
// refetches it and nothing else pays for the miss.
//
// THE HONEST LIMIT. ERR_PNPM_NO_MATCHING_VERSION is also what a catalog range naming a
// version that never existed produces. This retries that too, and then fails — two
// attempts slower than before, in a log that names the signature each time. The
// alternative is a lane that cannot tell a publish race from a typo either, and takes
// the whole matrix down for the race.
//
//   usage: node scripts/ci/pnpm-install-retry.mjs [pnpm install args...]
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** @typedef {{ status: number, output: string }} Attempt */
/** @typedef {{ signature: string, packageName: string | null }} Verdict */

// Registry-side failures only. Each one is a statement about the network or the registry
// at that instant, never about the contents of this repository.
export const TRANSIENT_SIGNATURES = [
  { id: 'ERR_PNPM_NO_MATCHING_VERSION', re: /ERR_PNPM_NO_MATCHING_VERSION/ },
  { id: 'ERR_PNPM_META_FETCH_FAIL', re: /ERR_PNPM_META_FETCH_FAIL/ },
  { id: 'ERR_PNPM_FETCH_5xx', re: /ERR_PNPM_FETCH_5\d\d/ },
  { id: 'ERR_PNPM_FETCH_429', re: /ERR_PNPM_FETCH_429/ },
  { id: 'registry-transport', re: /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/ },
]

// "No matching version found for @supabase/auth-js@2.117.0 while fetching it from ..."
const PACKAGE_RE = /No matching version found for (@?[^@\s]+)@/

/**
 * The verdict on one failed attempt: null when nothing in the output points at the
 * registry, which is the fail-immediately case.
 * @param {string} output
 * @returns {Verdict | null}
 */
export function classifyFailure(output) {
  const text = String(output ?? '')
  const hit = TRANSIENT_SIGNATURES.find((s) => s.re.test(text))
  if (hit === undefined) return null
  const named = PACKAGE_RE.exec(text)
  return { signature: hit.id, packageName: named === null ? null : named[1] }
}

/**
 * @param {{
 *   run: (attempt: number) => Attempt | Promise<Attempt>,
 *   sleep: (ms: number) => Promise<void>,
 *   dropMetadata: (pkg: string) => void | Promise<void>,
 *   attempts?: number,
 *   delayMs?: number,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<number>} the exit status to leave the lane with
 */
export async function installWithRetry(options) {
  const { run, sleep, dropMetadata } = options
  const attempts = options.attempts ?? 3
  const delayMs = options.delayMs ?? 45_000
  const log = options.log ?? console.log

  let status = 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await run(attempt)
    if (result.status === 0) return 0
    status = result.status

    const verdict = classifyFailure(result.output)
    if (verdict === null) {
      log(`install failed (exit ${String(status)}) with no registry signature — not retrying`)
      return status
    }
    if (attempt === attempts) {
      log(`::error::install failed ${String(attempts)} times on ${verdict.signature} — giving up`)
      return status
    }

    const named = verdict.packageName === null ? '' : ` on ${verdict.packageName}`
    log(`attempt ${String(attempt)}/${String(attempts)} hit ${verdict.signature}${named} — retrying`)
    if (verdict.packageName !== null) await dropMetadata(verdict.packageName)
    await sleep(delayMs)
  }
  return status
}

/**
 * The real transport. Streamed rather than buffered: a multi-minute install that prints
 * nothing until it is over is the kind of CI log nobody reads.
 * @param {string[]} args
 * @returns {Promise<Attempt>}
 */
function runInstall(args) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['install', ...args], { shell: process.platform === 'win32' })
    let output = ''
    child.stdout.on('data', (d) => {
      output += String(d)
      process.stdout.write(d)
    })
    child.stderr.on('data', (d) => {
      output += String(d)
      process.stderr.write(d)
    })
    child.on('close', (code) => {
      resolve({ status: code ?? 1, output })
    })
  })
}

async function main() {
  const args = process.argv.slice(2)
  const status = await installWithRetry({
    run: () => runInstall(args),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    dropMetadata: (pkg) => {
      // Best effort: a cache that will not drop is not a reason to skip the retry.
      spawnSync('pnpm', ['cache', 'delete', pkg], {
        stdio: 'ignore',
        shell: process.platform === 'win32',
      })
    },
  })
  process.exit(status)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
