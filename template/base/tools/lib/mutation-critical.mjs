// THE CRITICAL SURFACE the mutation lane guards — the single source of truth, shared by
// stryker.config.mjs (what to mutate) and tools/mutation-scope.mjs (which of a PR's changed
// files are worth mutating). Two copies of this list would drift, and the drift would be
// silent: the lane would look green while mutating nothing.
//
// SCOPE, and why it is drawn HERE:
//   - packages/api/src/**  — the tRPC router: the procedure ladder
//     (publicProcedure → authedProcedure → orgProcedure) that binds a caller's identity
//     to authorization, the createContext that resolves it, the CSRF-origin check, and the
//     ActionOutcome envelope every procedure returns. This is the server-side authorization
//     boundary; a silent break here is an auth break.
//   - packages/platform/supabase/src/**  — the five client factories, the service-role
//     WARRANT gate (the one credential that bypasses RLS), credential validation, and the
//     SQLSTATE→AppError map. The identity/credential seam.
//   - packages/platform/errors/src/**  — the AppError kernel + toOutcome: the single error
//     channel both surfaces return on. A mutant that flips a kind or drops a field is a
//     wrong-answer-to-the-user break no type checker catches.
//   - packages/verticals/*/src/**  — the DAL (data/*.ts) and its domain (owner-scoped ids,
//     cursors): the data-authorization surface, where a row re-parse or a cursor bound going
//     wrong leaks or corrupts.
//
// The scope is DIRECTORY-shaped on purpose, so it CLOSES over work an agent adds: a new
// packages/verticals/comments/src/data/comments.ts is mutated the day it lands, with no
// registry to remember to update. That is the difference between a gate that guards the
// exemplar and one that guards the codebase.
//
// NOT in scope (each for a reason, not by omission):
//   - apps/web|apps/mobile  — React rendering (web RSC + Expo screens). The web behavioural
//     net is Playwright/axe, the mobile net is jest-expo/RNTL + Maestro; JSX mutants are
//     mostly equivalent or uncoverable and would drown the signal.
//   - packages/contracts/src — zod DTO DECLARATIONS. Mutants there are killed by `tsc` and
//     the contract-drift gate, not by tests; including them inflates the score. (This file
//     is harness-owned, write-guard-denied and sha-pinned by check-gate-integrity.mjs on an
//     install — a local edit reds as tampering and `update` parks the incoming version — so
//     widening the FLOOR is a harness-release act; YOUR additive surface is the seeded
//     tools/mutation-scope-extra.json below, the 1.0.0 discharge of the
//     mutation-scope-seeded-split row.)
//   - packages/design-tokens|design-system* — presentation, covered by the tokens/styleguide
//     gates and the render/variants suites, not on the auth/data path.
//
// THE 1.0.0 SPLIT, and the design decision the discharged row left open. This file is the
// FLOOR — owned, sha-pinned, union semantics: nothing a consumer writes can subtract from
// it. The seeded tools/mutation-scope-extra.json is the consumer's ADDITIVE half — reviewed
// {root, why} rows that widen the mutated surface onto their own code. DERIVING the surface
// from the consumer's own inventories (route manifests, the exports census) was considered
// and REFUSED: an inventory-derived surface moves when the inventory moves, so deleting a
// registry row would silently shrink what the lane mutates — and the ratchet's SET
// semantics need a definition only a reviewed diff can change. The residual drift risk
// (a tree whose structure diverged from the exemplar paths silently mutates less than the
// lane claims) is handled by the scoper's zero-match alarm instead: a concrete floor root
// or ANY extra root matching zero files is a hard red — anti-vacuity, never ramped.
// SOURCE: docs/harness/gates-catalog.md (mutation-ratchet) [corpus: harness/doctrine]
import { readFileSync } from 'node:fs'

// CRITICAL_EXCLUDES below is module-local, not exported: it feeds MUTATE_GLOBS and
// isCritical and nothing imports it — exporting an unimported constant is exactly the dead
// API `knip --strict` reds a consumer for. NOT an invitation to edit in place: this file is
// hash-pinned (see the NOT-in-scope note above), and the honest channels for a wider
// surface are the seeded tools/mutation-scope-extra.json (additive roots, reviewed) or a
// harness release for the floor itself.

/** Directory roots (trailing slash) whose .ts files are mutated. The verticals entry is
 * `*`-shaped because the surface is each vertical's src/ tree, not the package dir: a
 * vertical's scripts/ or docs/ .ts file is not on the auth/data path, and until 0.9.0 the
 * GLOB said `packages/verticals/**` while isCritical said `.../src/**` — the drift the
 * tests/gates MUTATE_GLOBS==isCritical pin now reds. Exported as FLOOR_ROOTS for the
 * scoper's zero-match alarm (which reads, and must never rewrite, the floor). */
const CRITICAL_ROOTS = [
  'packages/api/src/',
  'packages/platform/supabase/src/',
  'packages/platform/errors/src/',
  'packages/verticals/*/src/',
]
export const FLOOR_ROOTS = CRITICAL_ROOTS

/**
 * Carve-outs INSIDE those roots. Each is code the VITEST runner (the mutation lane's test
 * runner) cannot honestly reach, so every mutant in it would be NoCoverage — noise, not
 * signal. Two classes:
 *   - process/boundary code exercised only against a live stack, never a unit test:
 *       index.ts (barrel/route wiring), the createClient factory bodies (they hand back a
 *       real SDK client; the credential validation AROUND them is tested, the SDK call is
 *       not), the request-scoped-client plumbing, and the DAL's own live data functions
 *       (the port/domain are unit-tested; the PostgREST round-trip is proven by tests/rls +
 *       the pgTAP twin, never mocked at the SDK boundary — determinism doctrine).
 *   - a client barrel re-export (`client.ts`) is type-only glue, not behaviour.
 * A NEW pure file in these roots is mutated the day it lands; a NEW live-only file surfaces
 * as NoCoverage survivors and forces this reviewed list (or a unit-reachable refactor) in the
 * same diff — the failure direction is toward attention, never silence.
 */
const CRITICAL_EXCLUDES = [
  'packages/api/src/index.ts',
  'packages/platform/supabase/src/index.ts',
  'packages/platform/supabase/src/client.ts',
  'packages/platform/supabase/src/browser.ts',
  'packages/platform/supabase/src/native.ts',
  'packages/platform/supabase/src/cookie-server.ts',
  'packages/platform/supabase/src/access-token.ts',
  'packages/platform/supabase/src/service-role.ts',
  // Credential-reading wrappers over @app/env: no unit test imports them (the
  // env schema + parsing are tested inside @app/env), so every mutant is
  // NoCoverage here — the validation that matters is proven one layer down.
  'packages/platform/supabase/src/public-env.ts',
  'packages/platform/supabase/src/server-env.ts',
]

/**
 * A PATTERN carve-out, because this one closes over verticals that do not exist yet.
 *
 * `src/data/query-probes.ts` is not runtime code at all: it is the build-time INSTRUMENT
 * that `tools/gen-query-shapes.mjs` executes, driving each DAL function through a recording
 * Proxy so the query-shape manifest is generated BY EXECUTION rather than lexed out of the
 * source. Nothing imports it at runtime, so vitest cannot reach it and every mutant in it is
 * NoCoverage — 49 of them on the 0.2.0 exemplar, which is 65% of a ratchet failure that says
 * nothing about the product.
 *
 * Its correctness is enforced, just not by unit tests: the generator DIES if any exported DAL
 * function has no probe, DIES if a probe names a function the DAL does not export, and DIES
 * if a probe issues zero chains — and `contracts` regen-diffs the manifest on every validate,
 * so a probe that stopped exercising a query changes the committed artifact and reds there.
 * A mutant here either breaks generation (caught immediately) or changes the manifest (caught
 * by the regen-diff). Recording 49 baseline entries would have been the wrong answer to the
 * right complaint: it is the mutation SCOPE that was wrong, not the tests that were missing.
 */
const PROBE_FILE = /^packages\/verticals\/[^/]+\/src\/data\/query-probes\.ts$/

/** Stryker's `mutate` globs. Tests, type decls and the carve-outs above are excluded. */
export const MUTATE_GLOBS = [
  ...CRITICAL_ROOTS.map((root) => `${root}**/*.ts`),
  '!**/*.test.ts',
  '!**/*.d.ts',
  '!packages/verticals/*/src/index.ts',
  '!packages/verticals/*/src/client.ts',
  '!packages/verticals/*/src/data/query-probes.ts',
  ...CRITICAL_EXCLUDES.map((path) => `!${path}`),
]

/** True when a repo-relative path is a file this lane mutates. `extraRoots` is the
 * loaded additive half (loadExtraRoots below), consulted AFTER the carve-outs (an extra
 * root cannot resurrect a NoCoverage exclusion) but BEFORE the floor's scoping rules
 * (an extra root may deliberately widen inside a floor tree — e.g. a verticals scripts/
 * dir the floor scopes out) — so extras only ever WIDEN the answer, never flip a
 * carve-out. */
export function isCritical(file, extraRoots = []) {
  const path = file.replaceAll('\\', '/')
  if (!path.endsWith('.ts') || path.endsWith('.test.ts') || path.endsWith('.d.ts')) return false
  if (CRITICAL_EXCLUDES.includes(path)) return false
  if (PROBE_FILE.test(path)) return false
  if (/^packages\/verticals\/[^/]+\/src\/(index|client)\.ts$/.test(path)) return false
  if (extraRoots.some((e) => rootMatches(path, e.root))) return true
  if (path.startsWith('packages/verticals/')) return /^packages\/verticals\/[^/]+\/src\//.test(path)
  return CRITICAL_ROOTS.some((root) => path.startsWith(root))
}

// ── YOUR additive half (1.0.0): tools/mutation-scope-extra.json ────────────────────────

const EXTRA_FILE = 'tools/mutation-scope-extra.json'

/** One root's grammar: a directory prefix ending '/', each segment a plain name or a
 * single `*` spanning exactly one level (the verticals grammar above). */
const ROOT_SHAPE = /^([\w.-]+|\*)(\/([\w.-]+|\*))*\/$/

/** True when `path` sits under `root` (either grammar). */
export function rootMatches(path, root) {
  if (!root.includes('*')) return path.startsWith(root)
  const re = new RegExp(
    `^${root
      .split('*')
      .map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]+')}`,
  )
  return re.test(path)
}

/**
 * Shape problems for a parsed tools/mutation-scope-extra.json. Union semantics make the
 * failure direction gentle — a bad row can only fail to ADD surface — but an unvalidated
 * row that silently adds nothing is exactly the claimed-but-absent coverage the zero-match
 * alarm exists to red, so the shape fails loud here first.
 * @param {any} doc
 * @returns {string[]} problems, empty when usable
 */
export function extraRootProblems(doc) {
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.roots)) {
    return [`${EXTRA_FILE} must carry a "roots" ARRAY of { root, why } entries`]
  }
  const problems = []
  for (const [i, e] of doc.roots.entries()) {
    if (typeof e?.root !== 'string' || !ROOT_SHAPE.test(e.root)) {
      problems.push(
        `roots[${i}] needs a "root": a directory prefix ending '/' whose segments are plain names or a single '*' spanning one level — got ${JSON.stringify(e?.root)}`,
      )
      continue
    }
    if (typeof e.why !== 'string' || e.why.trim().length < 40) {
      problems.push(
        `roots[${i}] (${e.root}) needs a "why" of at least 40 characters — what lives there and why a silent break matters; an unreasoned surface is noise waiting to be deleted`,
      )
    }
  }
  return problems
}

/** Stryker `mutate` globs for the extra roots — the same dialect as MUTATE_GLOBS. */
export function extraGlobs(roots) {
  return roots.map((e) => `${e.root}**/*.ts`)
}

/**
 * Read and validate the seeded additive half from the repo root (both consumers —
 * stryker.config.mjs and the PR diff-scoper — run there). Throws on a missing,
 * unparsable, or malformed file: the register is SEEDED, so its absence is a broken
 * tree, and a scoper that shrugged would report "nothing extra to mutate" in exactly
 * the tone of an honest empty register.
 * @returns {Array<{root: string, why: string}>}
 */
export function loadExtraRoots() {
  let raw
  try {
    raw = readFileSync(EXTRA_FILE, 'utf8')
  } catch {
    throw new Error(
      `${EXTRA_FILE} is missing — it is SEEDED; restore it from git history or replant it with \`npx next-expo-supabase-agent-harness update\``,
    )
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    throw new Error(
      `${EXTRA_FILE} is not valid JSON (${e.message}) — the additive surface must be reviewable data`,
    )
  }
  const problems = extraRootProblems(doc)
  if (problems.length > 0) throw new Error(`${EXTRA_FILE}: ${problems.join('; ')}`)
  return doc.roots
}
