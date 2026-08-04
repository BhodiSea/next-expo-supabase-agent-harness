import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderPreset } from '../../src/preset'

// Lives in tests/unit rather than src ON PURPOSE: this package's tsconfig types
// react-native + nativewind ambients with no `node` types, so a node:fs-reading
// test inside src would break `tsc -b`. Out here it is transformed by vitest
// only — the same reasoning design-tokens uses to keep gen.mjs outside its
// program.
//
// Paths are resolved from THIS module, not from cwd: vitest, the Stop hook and
// CI all invoke the runner from different directories, and a cwd-relative read
// would turn a real drift failure into an ENOENT nobody reads.
const committed = (): string =>
  readFileSync(new URL('../../tailwind-preset.cjs', import.meta.url), 'utf8')

describe('generator determinism', () => {
  it('renders identical bytes on repeated calls', () => {
    expect(renderPreset()).toBe(renderPreset())
  })

  it('ends the artifact with exactly one trailing newline', () => {
    const text = renderPreset()
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
  })
})

// THE freshness gate. `pnpm --filter @app/design-system-native run gen:check`
// asserts the same thing from the CLI, but this runs on every `vitest` — so a
// retuned token that was never regenerated here reds in the same turn it was
// written, not in CI an hour later.
describe('the committed preset is fresh', () => {
  it('tailwind-preset.cjs matches a fresh render', () => {
    expect(committed()).toBe(renderPreset())
  })
})

describe('the emitted preset', () => {
  const preset = renderPreset()

  it('indirects every colour through the runtime variable, never a baked hex', () => {
    expect(preset).toContain("canvas: 'var(--color-canvas)',")
    expect(preset).not.toMatch(/#[0-9a-f]{6}/i)
  })

  it('extends the theme rather than replacing it', () => {
    expect(preset).toContain('theme: {')
    expect(preset).toContain('extend: {')
  })

  it('quotes only the keys that are not bare identifiers', () => {
    // Biome formats object keys `asNeeded`; an unnecessary quote would be
    // stripped on the next format pass and then read as regen drift forever.
    expect(preset).toContain("'ink-muted':")
    expect(preset).not.toContain("'canvas':")
  })
})
