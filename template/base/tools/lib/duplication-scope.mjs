// tools/lib/duplication-scope.mjs — the duplication gate's scope, one list for its two
// readers (2.1.0, #186): the L0 token-window scan in check-duplication.mjs and the Single Home
// extractor in lib/shapes.mjs. Moved out of the gate unchanged, into a module that imports
// only node:fs and node:path, so the Stop run's L0 loads nothing new.
//
// Scan only hand-written product source. Generated bindings, tests (they legitimately repeat
// setup), and type decls are excluded.
// 0.4.0 CORRECTED THE WALK, in the same two places check-diff-coverage.mjs's SRC_RE was
// wrong, because it was the same mistake: one level of `packages/*/src` describes the FLAT
// packages and silently skips the LAYERED groups — packages/platform/* and
// packages/verticals/*, which is the kernel, the Supabase seam, the rate limiter and every
// feature domain. A clone detector that never reads the verticals is a clone detector
// pointed away from the code most likely to be copy-pasted between them.
//
// apps/web is added by NAME rather than by shape: it has no `src/`, its code is `app/` and
// `lib/`, and the enforcement-tiers row that recorded its absence is closed in 0.4.0.
// SOURCE: docs/harness/gates-catalog.md (duplication gate) [corpus: harness/doctrine]
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** `<scope>/<d>/src`, or for a layered group `<scope>/<d>/<inner>/src`, in a fixed order. */
function srcRootsUnder(scope) {
  if (!existsSync(scope)) return []
  return readdirSync(scope)
    .sort()
    .flatMap((d) => {
      const src = join(scope, d, 'src')
      if (existsSync(src)) return [src]
      // No `<scope>/<d>/src` — so either a layered GROUP whose members carry their own src
      // (packages/platform/errors/src), or a surface with a different shape (apps/web).
      const groupDir = join(scope, d)
      return readdirSync(groupDir)
        .sort()
        .map((inner) => join(groupDir, inner, 'src'))
        .filter((nested) => existsSync(nested))
    })
}

/** @returns {string[]} the TS scan roots, relative to the project root, in a fixed order */
export function duplicationScanRoots() {
  const web = [join('apps', 'web', 'app'), join('apps', 'web', 'lib')].filter((d) => existsSync(d))
  return [...srcRootsUnder('apps'), ...srcRootsUnder('packages'), ...web]
}

/** The walk filter: TS source, not a test and not a declaration file. @param {string} rel */
export const isScannedName = (rel) =>
  /\.(ts|tsx)$/.test(rel) && !/\.(test|spec)\.tsx?$/.test(rel) && !/\.d\.ts$/.test(rel)

/**
 * A machine-written module, by path. Generated modules are never a maintainability concern:
 * by construction they RESTATE their source, so scanning them reports the generator's own
 * output as a clone of its input. Three shapes: a `*.gen.ts` suffix; anything under a
 * `generated/` directory, which is where the design-tokens compiler writes
 * (`src/generated/{native.ts,web.css}`; the suffix rule alone matched NOTHING in the shipped
 * scaffold, so the gate once reported native.ts duplicating typography.ts on a clean tree);
 * and `database.types.ts` (0.4.0), the Supabase type mirror `pnpm db:types` writes from the
 * live schema, whose Row/Insert/Update triples restate one another BY CONSTRUCTION. The
 * `types-drift` gate is what proves that file honest.
 * @param {string} path
 */
export const isGeneratedPath = (path) =>
  /\.gen\.tsx?$/.test(path) ||
  /(^|\/)generated\//.test(path) ||
  /(^|\/)database\.types\.ts$/.test(path)
