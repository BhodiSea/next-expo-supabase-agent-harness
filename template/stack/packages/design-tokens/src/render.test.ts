import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SEMANTIC_TOKENS } from './color'
import { assertTokenContract, GENERATED_FILES, renderNativeModule, renderWebCss } from './render'

// Paths are resolved from THIS module, not from cwd: vitest, the Stop hook and CI all
// invoke the runner from different directories, and a cwd-relative read would turn a
// real drift failure into an ENOENT nobody reads.
const committed = (relPath: string): string =>
  readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8')

describe('generator determinism', () => {
  // Byte-for-byte, twice, in one process. The renderers walk canonical ORDER arrays
  // rather than Object.keys(), so this holds even if a future token family gains a
  // computed key — the day it stops holding, the regen-diff would start firing on
  // changes nobody made, and the cause would be invisible in the diff.
  it('renders identical bytes on repeated calls', () => {
    expect(renderWebCss()).toBe(renderWebCss())
    expect(renderNativeModule()).toBe(renderNativeModule())
  })

  it('ends every artifact with exactly one trailing newline', () => {
    for (const render of Object.values(GENERATED_FILES)) {
      const text = render()
      expect(text.endsWith('\n')).toBe(true)
      expect(text.endsWith('\n\n')).toBe(false)
    }
  })
})

// THE freshness gate. `pnpm --filter @app/design-tokens run gen:check` asserts the
// same thing from the CLI, but this runs on every `vitest` — so a retuned token that
// was never regenerated reds in the same turn it was written, not in CI an hour later.
describe('committed artifacts are fresh', () => {
  it.each(Object.keys(GENERATED_FILES))('%s matches a fresh render', (relPath) => {
    const render = GENERATED_FILES[relPath]
    expect(render, `${relPath} has no renderer`).toBeDefined()
    expect(committed(relPath)).toBe(render?.())
  })
})

describe('the emitted web theme', () => {
  const css = renderWebCss()

  it('declares every semantic token in the theme block and in both dark overrides', () => {
    for (const token of SEMANTIC_TOKENS) {
      // Once in @theme (light default), once in the media query, once in [data-theme].
      const occurrences = css.split(`--color-${token}:`).length - 1
      expect(occurrences, `--color-${token}`).toBe(3)
    }
  })

  // `@theme inline` would substitute values into the generated utilities and freeze
  // every color at its light value — the dark blocks below would then be dead CSS
  // that still looks correct in review.
  it('uses plain @theme so the cascade can still override the tokens', () => {
    expect(css).toContain('@theme {')
    // The DIRECTIVE, not the substring: the file header comment legitimately
    // spells "@theme inline" to explain why it is not used, so match the block
    // opener (`@theme inline {`) rather than the bare phrase.
    expect(css).not.toContain('@theme inline {')
  })

  // Without the :not(), the media query outranks [data-theme="light"] and a user who
  // explicitly chose light stays dark after sunset.
  it('lets an explicit light choice survive a dark OS', () => {
    expect(css).toContain(':root:not([data-theme="light"])')
  })
})

describe('the emitted native theme', () => {
  const module = renderNativeModule()

  it('quotes only the keys that are not bare identifiers', () => {
    // Biome formats object keys `asNeeded`; an unnecessary quote would be stripped on
    // the next format pass and then read as regen drift forever after.
    expect(module).toContain("'ink-muted':")
    expect(module).toContain("'2xl':")
    expect(module).toContain('canvas:')
    expect(module).not.toContain("'canvas':")
  })

  it('emits font weights as strings for React Native TextStyle', () => {
    expect(module).toContain("normal: '400',")
  })
})

describe('the fail-closed preflight', () => {
  it('passes for the shipped tokens', () => {
    expect(() => {
      assertTokenContract()
    }).not.toThrow()
  })
})
