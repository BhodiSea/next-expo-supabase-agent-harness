// `doctor`'s toolchain report and `doctor --clean` (1.0.4).
//
// THE REPORT. Through 1.0.3 doctor checked only Node's major version, so nothing said which
// `supabase`, `pnpm` or `psql` a local run reaches, or which pin each is held to. For node,
// pnpm, the Supabase CLI (the workspace copy in node_modules/.bin and the one on PATH, which
// the Stop hook's steps used to take) and psql, the report names the binary it found, that
// binary's version, and the pin it is compared with. Every line is `info`: the report never
// moves doctor's exit code, and the gates that need a tool keep their own skip-or-fail rule.
// A probe never throws and always has a timeout; a tool it could not run is reported as "not
// probed" with the reason, never as missing. That matters on Windows, where the workspace
// copies are .cmd shims a probe without a shell cannot start.
//
// THE CLEAN LIST. Two directories of ignored residue that nothing else deletes: the Stop
// hook's per-step spill logs and the build gate's mobile export. The list is this constant
// and nothing else. Before an entry is deleted it must be inside the target, not reached
// through a symlink, ignored by git at run time, and hold no tracked file; an entry that
// fails any check is skipped with a note. The install manifest, pending/, rollback/,
// turn.lock, the *.jsonl ledgers and the .ok stamps are never on it (`graduate` clears the
// stamps).
//
// Node built-ins only: installer/ has no runtime dependencies (CONTRIBUTING, ground rule 3).
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { catalogEntry } from './migrations.mjs'

/** Ignored residue `doctor --clean` deletes, relative to the install root. */
export const CLEAN_LIST = Object.freeze(['.harness/stop-output/', 'apps/mobile/dist/'])

/** Every probe is bounded: a tool that hangs becomes a "not probed" line, never a hung doctor. */
const PROBE_TIMEOUT_MS = 10_000

/**
 * @typedef {{ found: string | null, version?: string, reason?: string }} ProbeResult
 *   `found` is the binary's absolute path (null when there is none to run); `version` is
 *   the first line it printed, when it ran and exited 0; otherwise `reason` says why not.
 * @typedef {(bin: string, args: string[], opts: { cwd: string }) => ProbeResult} Probe
 */

/** @param {Record<string, string | undefined>} env */
const envPath = (env) => env[Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'] ?? ''

/** @param {string} candidate @param {number} mode an fs.constants access mode */
function runnableFile(candidate, mode) {
  try {
    accessSync(candidate, mode)
    return !lstatSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/**
 * A bare name's first match on PATH, trying PATHEXT's extensions on win32; null when none.
 * @param {string} name @param {Record<string, string | undefined>} env @param {string} platform
 */
function findOnPath(name, env, platform) {
  const win = platform === 'win32'
  const exts = win ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : ['']
  // Windows has no execute bit to test; existence is what its own lookup checks.
  const mode = win ? constants.F_OK : constants.X_OK
  const dirs = envPath(env)
    .split(win ? ';' : delimiter)
    .filter((d) => d !== '')
  for (const dir of dirs) {
    const hit = exts.map((ext) => join(dir, `${name}${ext}`)).find((c) => runnableFile(c, mode))
    if (hit) return hit
  }
  return null
}

/** @param {import('node:child_process').SpawnSyncReturns<string>} res @param {number} timeout */
function failureReason(res, timeout) {
  const err = /** @type {NodeJS.ErrnoException | undefined} */ (res.error)
  if (err?.code === 'ETIMEDOUT') return `timed out after ${timeout / 1000}s`
  if (err) return `could not start it: ${err.code ?? err.message}`
  const said = `${res.stderr ?? ''}`.trim().split('\n')[0] ?? ''
  return `exit ${res.status ?? res.signal}${said ? `: ${said.slice(0, 160)}` : ''}`
}

/**
 * Run `bin args` once, stdin ignored, bounded by `timeout`. Never throws. Corepack may not
 * download a package manager while doctor probes: a pnpm it has not cached reads as not
 * probed, which is the truth about that machine.
 * @param {string} bin an absolute path, or a bare name looked up on `env`'s PATH
 * @param {string[]} args
 * @param {{ cwd: string, timeout?: number, env?: Record<string, string | undefined>, platform?: string }} opts
 * @returns {ProbeResult}
 */
export function probeCommand(bin, args, { cwd, timeout = PROBE_TIMEOUT_MS, env = process.env, platform = process.platform }) {
  const found = isAbsolute(bin) ? (existsSync(bin) ? bin : null) : findOnPath(bin, env, platform)
  if (found === null) return { found, reason: isAbsolute(bin) ? `${bin} does not exist` : `not found on PATH` }
  try {
    const res = spawnSync(found, args, {
      cwd,
      env: { ...env, COREPACK_ENABLE_NETWORK: '0' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      windowsHide: true,
    })
    if (res.error || res.status !== 0) return { found, reason: failureReason(res, timeout) }
    return { found, version: `${res.stdout}`.trim().split('\n')[0] ?? '' }
  } catch (err) {
    return { found, reason: `could not start it: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** @param {string} targetDir @param {string} rel */
function readText(targetDir, rel) {
  try {
    return readFileSync(join(targetDir, rel), 'utf8')
  } catch {
    return null
  }
}

/** @param {string} targetDir */
function nodePin(targetDir) {
  const pin = readText(targetDir, '.node-version')?.trim()
  return pin ? `.node-version ${pin}` : 'none (.node-version is absent)'
}

/** @param {string} targetDir */
function pnpmPin(targetDir) {
  let pm
  try {
    pm = JSON.parse(readText(targetDir, 'package.json') ?? '{}').packageManager
  } catch {
    pm = undefined
  }
  // The integrity suffix (`+sha512.…`) is not part of the version a reader compares.
  return typeof pm === 'string' && pm !== ''
    ? `package.json packageManager ${pm.split('+')[0]}`
    : 'none (package.json names no packageManager)'
}

/** @param {string} targetDir */
function supabasePin(targetDir) {
  const value = catalogEntry(readText(targetDir, 'pnpm-workspace.yaml') ?? '', 'supabase')
  return value ? `pnpm-workspace.yaml catalog ${value}` : 'none (pnpm-workspace.yaml catalogues no supabase)'
}

/** @param {string} targetDir */
function psqlPin(targetDir) {
  const toml = readText(targetDir, 'supabase/config.toml') ?? ''
  // Only the [db] table's own key: the section runs to the next table header.
  const db = toml.match(/^\[db\][ \t]*$([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? ''
  const major = db.match(/^[ \t]*major_version[ \t]*=[ \t]*(\d+)/m)?.[1]
  return major
    ? `supabase/config.toml [db] major_version ${major}`
    : 'none (supabase/config.toml sets no [db] major_version)'
}

/** @param {string} targetDir @param {string} found */
function shown(targetDir, found) {
  const rel = relative(targetDir, found)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : found
}

/**
 * One `info` line per tool. The probe is injected so a test can drive a failing, a timing-out
 * and a throwing probe; a probe that throws anyway is reported, never propagated.
 * @param {string} targetDir
 * @param {Probe} [probe]
 * @returns {string[]}
 */
export function toolchainReport(targetDir, probe = probeCommand) {
  const tools = [
    { label: 'node', bin: 'node', pin: nodePin },
    { label: 'pnpm', bin: 'pnpm', pin: pnpmPin },
    { label: 'supabase (workspace)', bin: join(targetDir, 'node_modules', '.bin', 'supabase'), pin: supabasePin },
    { label: 'supabase (PATH)', bin: 'supabase', pin: supabasePin },
    { label: 'psql', bin: 'psql', pin: psqlPin },
  ]
  return tools.map(({ label, bin, pin }) => {
    let r
    try {
      r = probe(bin, ['--version'], { cwd: targetDir })
    } catch (err) {
      r = { found: null, reason: `probe failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    // A workspace path is shown relative to the install, in a reason as in a hit.
    const reason = r.reason ?? 'no result'
    const why = isAbsolute(bin) ? reason.replace(bin, shown(targetDir, bin)) : reason
    const what = r.version !== undefined && r.found ? `${shown(targetDir, r.found)}, ${r.version}` : `not probed (${why})`
    return `toolchain: ${label} — ${what}; pin: ${pin(targetDir)}`
  })
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS })
  return { ok: !res.error && res.status === 0, out: `${res.stdout ?? ''}` }
}

/**
 * The first path component from the target down to `abs` that is a symlink (or junction),
 * or null. Components that do not exist end the walk.
 * @param {string} root @param {string} abs
 */
function symlinkOnTheWay(root, abs) {
  let at = root
  for (const part of relative(root, abs).split(sep)) {
    at = join(at, part)
    let st
    try {
      st = lstatSync(at)
    } catch {
      return null
    }
    if (st.isSymbolicLink()) return relative(root, at).split(sep).join('/')
  }
  return null
}

/**
 * One list entry, judged and (unless `dryRun`) removed. Returns the line doctor prints.
 * @param {string} targetDir @param {string} entry @param {boolean} dryRun
 */
export function cleanEntry(targetDir, entry, dryRun) {
  const root = resolve(targetDir)
  const abs = resolve(root, entry)
  const rel = relative(root, abs)
  const skip = (why) => `clean: skipped ${entry} — ${why}`
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return skip('not inside the target directory')
  const link = symlinkOnTheWay(root, abs)
  if (link) return skip(`${link} is a symlink, and --clean never follows one`)
  if (!existsSync(abs)) return `clean: nothing at ${entry}`
  const posixRel = rel.split(sep).join('/')
  // Tracked first: git does not report a directory that holds a tracked file as ignored, so
  // the ignore check alone would skip it too, under a reason that sends a reader to the
  // .gitignore instead of to the force-added file.
  const tracked = git(root, ['ls-files', '--', posixRel])
  if (!tracked.ok || tracked.out.trim() !== '') return skip('it holds tracked files')
  if (!git(root, ['check-ignore', '-q', '--', posixRel]).ok) return skip('not ignored by git here')
  if (dryRun) return `clean --dry-run: would remove ${entry}`
  try {
    rmSync(abs, { recursive: true })
  } catch (err) {
    return skip(`could not remove it: ${err instanceof Error ? err.message : String(err)}`)
  }
  return `clean: removed ${entry}`
}

/**
 * `doctor --clean [--dry-run]`. Called on every doctor run so the command itself carries no
 * branch for it (its complexity-ratchet row only moves down): without `clean` it returns no
 * lines and touches nothing.
 * @param {string} targetDir
 * @param {{ clean?: boolean, dryRun?: boolean }} opts
 * @returns {string[]}
 */
export function cleanResidue(targetDir, opts) {
  if (!opts.clean) return []
  if (!git(targetDir, ['rev-parse', '--is-inside-work-tree']).ok) {
    return CLEAN_LIST.map((entry) => `clean: skipped ${entry} — ${targetDir} is not a git repository, so nothing proves the entry is ignored`)
  }
  return CLEAN_LIST.map((entry) => cleanEntry(targetDir, entry, opts.dryRun === true))
}
