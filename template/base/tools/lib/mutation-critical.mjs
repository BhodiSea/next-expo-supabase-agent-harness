// THE CRITICAL SURFACE the mutation lane guards — the single source of truth, shared by
// stryker.config.mjs (what to mutate) and tools/mutation-scope.mjs (which of a PR's changed
// files are worth mutating). Two copies of this list would drift, and the drift would be
// silent: the lane would look green while mutating nothing.
//
// SCOPE, and why it is drawn HERE:
//   - packages/api/src/**  — the tRPC router: the procedure ladder
//     (publicProcedure → authedProcedure → memberProcedure) that binds a caller's identity
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
//     the contract-drift gate, not by tests; including them inflates the score. (Widening the
//     scope is a supported consumer decision — add a root here.)
//   - packages/design-tokens|design-system* — presentation, covered by the tokens/styleguide
//     gates and the render/variants suites, not on the auth/data path.
// SOURCE: docs/harness/gates-catalog.md (mutation-ratchet) [corpus: harness/doctrine]

// Module-local, not exported: these two feed MUTATE_GLOBS and isCritical below and nothing
// imports them. A consumer widening the mutated surface EDITS this array in place (that is the
// "supported consumer decision" the header note means) — editing does not need an export, and
// exporting an unimported constant is exactly the dead API `knip --strict` reds a consumer for.

/** Directory roots (trailing slash) whose .ts files are mutated. */
const CRITICAL_ROOTS = [
  'packages/api/src/',
  'packages/platform/supabase/src/',
  'packages/platform/errors/src/',
  'packages/verticals/',
]

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

/** Stryker's `mutate` globs. Tests, type decls and the carve-outs above are excluded. */
export const MUTATE_GLOBS = [
  ...CRITICAL_ROOTS.map((root) => `${root}**/*.ts`),
  '!**/*.test.ts',
  '!**/*.d.ts',
  '!packages/verticals/*/src/index.ts',
  '!packages/verticals/*/src/client.ts',
  ...CRITICAL_EXCLUDES.map((path) => `!${path}`),
]

/** True when a repo-relative path is a file this lane mutates. */
export function isCritical(file) {
  const path = file.replaceAll('\\', '/')
  if (!path.endsWith('.ts') || path.endsWith('.test.ts') || path.endsWith('.d.ts')) return false
  if (CRITICAL_EXCLUDES.includes(path)) return false
  if (/^packages\/verticals\/[^/]+\/src\/(index|client)\.ts$/.test(path)) return false
  if (path.startsWith('packages/verticals/')) return /^packages\/verticals\/[^/]+\/src\//.test(path)
  return CRITICAL_ROOTS.some((root) => path.startsWith(root))
}
