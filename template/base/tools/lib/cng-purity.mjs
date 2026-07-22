// tools/lib/cng-purity.mjs — the ONE CNG (continuous native generation) purity
// assert, shared by the expo-policy and native-deps gates. apps/mobile/android
// and apps/mobile/ios are prebuild OUTPUT — generated, never committed:
// committing one forks native truth away from app.config.ts + the config
// plugins, and every later prebuild silently diverges from what ships. Two
// halves, both required:
//   tracked — `git ls-files` over both dirs must be EMPTY
//   ignored — the repo .gitignore must carry both dir patterns, so purity
//             cannot regress one `git add -A` later
// Both gates call this BEFORE their content stamp, deliberately: git INDEX
// state is not a hashable stamp input, so a freshly-staged native dir must red
// on every invocation, warm stamp or not.
// SOURCE: https://docs.expo.dev/workflow/continuous-native-generation/
import { existsSync, readFileSync } from 'node:fs'
import { runCmd } from './gate.mjs'

const NATIVE_DIRS = ['apps/mobile/android', 'apps/mobile/ios']
const SHOW_MAX = 10

/** @returns {string[]} one error line per violation; [] when pure */
export function cngPurityErrors() {
  const errs = []
  let out = null
  try {
    // Pathspecs that match nothing exit 0 with empty output — the check stays
    // cheap and meaningful whether or not a prebuild ever ran locally.
    out = runCmd(`git ls-files -- ${NATIVE_DIRS.join(' ')}`)
  } catch (e) {
    errs.push(
      `git ls-files failed (${String(e.message).split('\n')[0]}) — CNG purity needs a git work tree; run the gate from the repo root`,
    )
  }
  if (out !== null) {
    const tracked = out.split('\n').filter((line) => line !== '')
    for (const f of tracked.slice(0, SHOW_MAX)) {
      errs.push(
        `${f} is committed native output — prebuild dirs are generated, never committed; \`git rm -r --cached\` the dir and regenerate with prebuild`,
      )
    }
    if (tracked.length > SHOW_MAX) {
      errs.push(
        `…and ${tracked.length - SHOW_MAX} more tracked files under ${NATIVE_DIRS.join(', ')}`,
      )
    }
  }
  errs.push(...gitignoreErrors())
  return errs
}

// The seeded .gitignore writes these as `apps/mobile/android/` (trailing
// slash); accept the slashless spelling too — git treats both as the dir.
function gitignoreErrors() {
  if (!existsSync('.gitignore')) {
    return [
      `.gitignore missing — it must ignore ${NATIVE_DIRS.map((d) => `${d}/`).join(' and ')} (CNG purity)`,
    ]
  }
  const lines = new Set(
    readFileSync('.gitignore', 'utf8')
      .split('\n')
      .map((line) => line.trim()),
  )
  const errs = []
  for (const dir of NATIVE_DIRS) {
    if (!lines.has(`${dir}/`) && !lines.has(dir)) {
      errs.push(
        `.gitignore does not ignore ${dir}/ — add the pattern; untracked-today is one \`git add -A\` away from committed native output`,
      )
    }
  }
  return errs
}
