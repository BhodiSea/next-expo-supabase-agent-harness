import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

// THE ANTI-VACUITY PROOF for apps/web/vitest.config.ts's JSX override.
//
// This suite asserts almost nothing about the product, and that is the point. The web unit
// project exists to run `__tests__/**/*.test.tsx`, and its ability to do so rests on ONE
// config key — an override of the `jsx: "preserve"` that tsconfig.json must set for Next.
// From 0.1.x to 0.4.0 that key was spelled for the wrong transformer (`esbuild`, which
// Vitest 4 ignores in favour of oxc), and nothing noticed for three releases because
// `__tests__/` was empty: an `include` glob that matches no file passes.
//
// So the moment a .tsx suite exists, the override is load-bearing and a regression in it is
// a red rather than a silence. Rendering through `renderToStaticMarkup` is deliberate: it is
// the same server pass the App Router performs, so this also proves the runtime the other
// suites would use is actually reachable.
// SOURCE: docs/harness/gates-catalog.md (every gate carries a proof it can fail; a lane
// whose transform is never exercised is the same defect one layer down)

function Greeting({ name }: { readonly name: string }) {
  return <p data-testid="greeting">Hello, {name}</p>
}

describe('the web unit project transforms JSX', () => {
  it('renders an element through the server pass', () => {
    // renderToStaticMarkup, not renderToString: no hydration markers and no `<!-- -->`
    // text separators, so the expected string is the markup a reader would write by hand.
    expect(renderToStaticMarkup(<Greeting name="world" />)).toBe(
      '<p data-testid="greeting">Hello, world</p>',
    )
  })

  it('uses the automatic runtime — no `import React` in scope', () => {
    // With `runtime: 'classic'` this file would need React imported by name and would throw
    // "React is not defined" instead. Asserting the render succeeded without that import IS
    // the assertion that the automatic runtime is configured.
    expect(renderToStaticMarkup(<>{'fragment'}</>)).toBe('fragment')
  })
})
