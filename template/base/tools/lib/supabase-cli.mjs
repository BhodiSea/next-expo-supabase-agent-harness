// supabase-cli: which Supabase CLI the local database lane spawns (1.0.4).
//
// The scaffold pins the CLI as a catalog devDependency, so `pnpm install` puts it in
// node_modules/.bin. A package script (`pnpm test:rls`, `pnpm db:types`) and every CI job
// that starts a stack put that directory first on PATH. The Stop hook does not: it starts
// `node tests/rls/run-rls.mjs` and `node tools/check-types-drift.mjs` with the session's PATH
// unchanged, so through 1.0.3 those two spawned whichever `supabase` the machine had first,
// or none. On a machine with no global CLI the `rls-isolation` step failed closed with the
// stack up; on one with another version, `types-drift` could red a mirror `pnpm db:types`
// had just written, because different CLI versions generate different types.
//
// supabaseCli returns the child environment both callers spawn with: PATH starts with
// <root>/node_modules/.bin when that directory holds `supabase` (source `workspace`), and is
// left as it is otherwise (source `PATH`, the pre-1.0.4 lookup). On win32 the environment is
// always returned unchanged: .bin holds .cmd shims there, which execFileSync cannot start
// without a shell, so both callers keep the lookup they had.
// SOURCE: docs/harness/README.md (RLS testing doctrine); https://pnpm.io/cli/run
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * @param {string} root the project root, the directory holding node_modules/
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 * @returns {{ env: Record<string, string | undefined>, source: 'workspace' | 'PATH', bin: string }}
 *   `bin` is the workspace binary's absolute path, or the bare name `supabase` for PATH.
 */
export function supabaseCli(root, env = process.env, platform = process.platform) {
  const binDir = path.join(root, 'node_modules', '.bin')
  const bin = path.join(binDir, 'supabase')
  if (platform === 'win32' || !existsSync(bin)) return { env, source: 'PATH', bin: 'supabase' }
  // Keep whatever spelling the key already has: a second, differently-cased PATH key would be
  // a different variable to Node and an ambiguous one to the child.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const rest = env[key]
  // POSIX only past the win32 return above, so the separator is ':' even when a test injects
  // a POSIX platform on a Windows host.
  return {
    env: { ...env, [key]: rest ? `${binDir}${path.posix.delimiter}${rest}` : binDir },
    source: 'workspace',
    bin,
  }
}
