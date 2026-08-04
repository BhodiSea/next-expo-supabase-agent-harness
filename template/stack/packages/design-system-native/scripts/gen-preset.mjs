#!/usr/bin/env node
// The preset generator: @app/design-tokens -> the committed Tailwind v3 preset.
//
//   pnpm --filter @app/design-system-native run gen         regenerate (writes)
//   pnpm --filter @app/design-system-native run gen:check   regen-diff (exit 2 on drift)
//
// Deliberately THIN, exactly like packages/design-tokens/scripts/gen.mjs: every
// byte of the output is produced by the pure renderPreset() in ../src/preset.ts,
// and this file only reads argv and touches the filesystem. That split is what
// lets the freshness assertion live in a unit test (tests/unit/preset.test.ts
// calls the renderer and compares to the committed bytes) instead of a
// subprocess.
//
// Run under tsx, not bare node: preset.ts imports @app/design-tokens, whose
// modules use extensionless relative imports that Node's own type stripping
// does not resolve. tsx is already a catalog pin.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderPreset } from '../src/preset.ts'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const ARTIFACT = 'tailwind-preset.cjs'

function check(contents) {
  let current = null
  try {
    current = readFileSync(join(PACKAGE_ROOT, ARTIFACT), 'utf8')
  } catch {
    // Missing counts as drift: an absent artifact is not "nothing to compare".
  }
  return current === contents
}

// Only when executed directly, so a test can import this module without the CLI
// firing and rewriting the tree underneath it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const contents = renderPreset()

  if (process.argv.includes('--check')) {
    if (!check(contents)) {
      console.error(
        `DESIGN-SYSTEM-NATIVE: DRIFT — ${ARTIFACT} does not match @app/design-tokens; run: pnpm --filter @app/design-system-native run gen`,
      )
      process.exit(2)
    }
    console.log(`DESIGN-SYSTEM-NATIVE: CLEAN (${ARTIFACT} matches the token source)`)
  } else {
    writeFileSync(join(PACKAGE_ROOT, ARTIFACT), contents)
    console.log(`DESIGN-SYSTEM-NATIVE: wrote ${ARTIFACT}`)
  }
}

export { check }
