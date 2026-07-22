// Target-directory detection: bootstrap (empty / no package.json) vs
// retrofit (existing pnpm monorepo with a Next.js web app and/or an Expo
// mobile app). Single-root layouts are rejected in v1 — every gate, glob, and
// boundary rule assumes the pnpm workspace shape (apps/*, packages/*).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'

export function detect(targetDir) {
  const pkgPath = join(targetDir, 'package.json')
  if (!existsSync(pkgPath)) {
    const entries = existsSync(targetDir)
      ? readdirSync(targetDir).filter((e) => e !== '.git' && e !== '.DS_Store')
      : []
    return { mode: 'bootstrap', empty: entries.length === 0 }
  }
  let pkg = {}
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    throw new Error(`unreadable package.json at ${pkgPath}`)
  }
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  // This lineage OWNS Next.js + Expo together. The single-surface siblings own the
  // halves, so a target that is unambiguously one of theirs is redirected rather than
  // retrofitted into a two-surface shape it does not have.
  if (allDeps.hono && !allDeps.next) {
    throw new Error(
      'target depends on `hono` but not `next` — this harness is for monorepos shipping a ' +
        'Next.js web app AND an Expo mobile app over one shared Supabase backend. For a ' +
        'standalone Hono + Drizzle/Postgres server with an Expo client use ' +
        'github:BhodiSea/expo-postgres-agent-harness instead.',
    )
  }
  if (allDeps['@tauri-apps/api'] || existsSync(join(targetDir, 'apps/desktop/src-tauri'))) {
    throw new Error(
      'target is a Tauri desktop project — this harness is for Next.js web + Expo mobile pnpm ' +
        'monorepos on Supabase. For Tauri 2 desktop projects use ' +
        'github:BhodiSea/tauri-postgres-agent-harness instead.',
    )
  }
  for (const lock of ['package-lock.json', 'yarn.lock', 'bun.lockb', 'bun.lock']) {
    if (existsSync(join(targetDir, lock))) {
      throw new Error(
        `${lock} detected — the harness requires pnpm (every gate invokes \`pnpm exec\`, ` +
          'and the workspace catalog pins the toolchain). Migrate to pnpm first: ' +
          'remove the lockfile, add packageManager to package.json, run `pnpm import` (npm) or `pnpm install`.',
      )
    }
  }
  if (!existsSync(join(targetDir, 'pnpm-workspace.yaml'))) {
    throw new Error(
      'no pnpm-workspace.yaml — v1 retrofits pnpm monorepos only (apps/*, packages/*). ' +
        'Every gate glob, knip workspace map, tsconfig project reference, and boundary rule ' +
        'assumes the workspace shape. Either adopt the monorepo layout first, or bootstrap a ' +
        'fresh scaffold and move your code into it.',
    )
  }
  const hasExpo =
    Boolean(allDeps.expo) ||
    existsSync(join(targetDir, 'apps/mobile/app.config.ts')) ||
    existsSync(join(targetDir, 'apps/mobile/app.json'))
  const hasWeb = Boolean(allDeps.next) || existsSync(join(targetDir, 'apps/web/next.config.ts'))
  if (!hasExpo && !hasWeb) {
    throw new Error(
      'workspace found, but neither an apps/web Next.js app (next.config.ts) nor an apps/mobile ' +
        'Expo app (app.config.ts) is present — the harness targets Next.js web + Expo mobile ' +
        'monorepos on Supabase. If your workspace uses different app paths, v1 cannot retrofit ' +
        'it; track the configurable-layout fast-follow in the harness repo.',
    )
  }
  return { mode: 'retrofit', pkg, hasExpo, hasWeb }
}

export function detectContext(targetDir) {
  const ctx = { dirName: basename(targetDir), gitOwner: null, answers: {} }
  try {
    const url = execFileSync('git', ['-C', targetDir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const m = url.match(/[:/]([^/:]+)\/[^/]+?(\.git)?$/)
    if (m) ctx.gitOwner = m[1]
  } catch {
    // no git remote — defaults cover it
  }
  return ctx
}
