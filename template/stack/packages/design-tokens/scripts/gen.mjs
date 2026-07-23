#!/usr/bin/env node
// The token generator: TypeScript source -> the two committed platform adapters.
//
//   pnpm --filter @app/design-tokens run gen         regenerate (writes)
//   pnpm --filter @app/design-tokens run gen:check   regen-diff (exit 2 on drift)
//
// Deliberately THIN. Every byte of the output is produced by the pure render
// functions in ../src/render.ts, and this file only reads argv and touches the
// filesystem. That split is what lets the freshness assertion live in a unit test
// (call the renderer, compare to the committed bytes) instead of a subprocess — a
// generator whose only entry point is a CLI gets exercised once, in CI, on a good
// day, and its determinism is never actually checked.
//
// Run under tsx, not bare node: the render module is TypeScript with extensionless
// relative imports (see tsconfig.json for why they are extensionless), and Node's own
// type stripping resolves specifiers literally — it requires an explicit `.ts` on
// every relative import and would not find `./color` at all. tsx resolves them, and
// tsx is already a catalog pin, so this costs the workspace nothing new.
//
// FAIL-CLOSED ORDER: render.ts asserts the gamut + contrast contract BEFORE
// returning a single string, so a retune that pushes a ramp value out of sRGB or
// drops a text pair under its WCAG minimum can never reach the tree — the write
// never happens. Checking after the fact would leave the broken tokens committed
// and blame the next person's PR.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { GENERATED_FILES } from '../src/render.ts'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

function render() {
  // Object.entries is safe here: GENERATED_FILES is a hand-written literal and the
  // map is only used to pair a path with its renderer, never to order output bytes.
  return Object.entries(GENERATED_FILES).map(([relPath, renderer]) => ({
    relPath,
    contents: renderer(),
  }))
}

function check(artifacts) {
  const drifted = []
  for (const { relPath, contents } of artifacts) {
    let current = null
    try {
      current = readFileSync(join(PACKAGE_ROOT, relPath), 'utf8')
    } catch {
      // Missing counts as drift: an absent artifact is not "nothing to compare".
    }
    if (current !== contents) drifted.push(relPath)
  }
  return drifted
}

function write(artifacts) {
  for (const { relPath, contents } of artifacts) {
    const outPath = join(PACKAGE_ROOT, relPath)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, contents)
  }
}

// Only when executed directly, so a test can import this module without the CLI
// firing and rewriting the tree underneath it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const artifacts = render()

  if (process.argv.includes('--check')) {
    const drifted = check(artifacts)
    if (drifted.length > 0) {
      console.error(
        `DESIGN-TOKENS: DRIFT — ${drifted.join(', ')} does not match the TypeScript source; run: pnpm --filter @app/design-tokens run gen`,
      )
      process.exit(2)
    }
    console.log(`DESIGN-TOKENS: CLEAN (${artifacts.length} generated files match the source)`)
  } else {
    write(artifacts)
    console.log(`DESIGN-TOKENS: wrote ${artifacts.map((artifact) => artifact.relPath).join(', ')}`)
  }
}

export { check, render, write }
