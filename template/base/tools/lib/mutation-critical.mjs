// THE CRITICAL SURFACE the mutation lane guards — the single source of truth, shared by
// stryker.config.mjs (what to mutate) and tools/mutation-scope.mjs (which of a PR's changed
// files are worth mutating). Two copies of this list would drift, and the drift would be
// silent: the lane would look green while mutating nothing.
//
// SCOPE, and why it is drawn HERE:
//   - apps/server/src/**  — the whole server. Token verification, the DAL (the authorization
//     boundary), the error envelope, the middleware, and the route wiring that binds auth to
//     handlers. This is where a silent break is expensive.
//   - apps/mobile/src/auth/** and src/lib/** — the client's half of the same seam: where the
//     bearer token comes from (SecureStore through the host layer, never module state alone)
//     and the one-door api client that attaches it. A break here is an auth break.
//
// The scope is DIRECTORY-shaped on purpose, so it CLOSES over work an agent adds: a new
// apps/server/src/dal/comments.ts is mutated the day it lands, with no registry to remember
// to update. That is the difference between a gate that guards the exemplar and one that
// guards the codebase.
//
// NOT in scope (each for a reason, not by omission):
//   - apps/mobile/src/features|components|app — React rendering. Its behavioural net is the
//     jest-expo/RNTL fast lane + the Maestro device lane; mutants in JSX are mostly
//     equivalent or uncoverable, and they would drown the signal.
//   - packages/schema/src — table and DTO DECLARATIONS. Mutants there are killed by `tsc`
//     and the contract-drift gate, not by tests; including them inflates the score and adds
//     nothing. (Widening the scope is a supported consumer decision — add a root here.)
//   - packages/importer, packages/eval — pure data transforms, and not on the auth/data path.
// SOURCE: docs/harness/gates-catalog.md (mutation-ratchet) [corpus: harness/doctrine]

// Module-local, not exported: these two feed MUTATE_GLOBS and isCritical below and nothing
// imports them. A consumer widening the mutated surface EDITS this array in place (that is the
// "supported consumer decision" the header note means) — editing does not need an export, and
// exporting an unimported constant is exactly the dead API `knip --strict` reds a consumer for.

/** Directory roots (trailing slash) whose .ts files are mutated. */
const CRITICAL_ROOTS = ['apps/server/src/', 'apps/mobile/src/auth/', 'apps/mobile/src/lib/']

/**
 * Carve-outs INSIDE those roots. Each is code the VITEST runner (the mutation lane's test
 * runner) cannot honestly reach, so every mutant in it would be NoCoverage — noise, not
 * signal. Two classes:
 *   - process/connection boundaries (same three as the desktop-era original):
 *       index.ts        : process boot; runs only in a real host.
 *       db/client.ts    : opens a real connection.
 *       db/context.ts   : the withUserContext transaction boundary — deliberately
 *                         unreachable from unit tests (they never open a connection:
 *                         determinism doctrine). The RLS isolation suite proves it against
 *                         real Postgres instead.
 *   - the RUNNER BOUNDARY (this stack's runner split, documented in vitest.config.ts): a
 *     mobile module whose import closure reaches react-native/expo native code is tested
 *     under jest-expo, which stryker's vitest runner cannot execute — its mutants would all
 *     be NoCoverage. Only the PURE mobile modules (the vitest unit-node file list) are
 *     mutable today. Mutating the RN-coupled half under a jest runner is a recorded honest
 *     loss (docs/harness/gates-catalog.md, mutation-ratchet) — a deliberate later adoption,
 *     not an accident. A NEW pure file in these roots is mutated the day it lands; a NEW
 *     RN-coupled file surfaces as NoCoverage survivors and forces this reviewed list (or a
 *     vitest-reachable refactor) in the same diff — the failure direction is toward
 *     attention, never silence.
 */
const CRITICAL_EXCLUDES = [
  'apps/server/src/index.ts',
  'apps/server/src/db/client.ts',
  'apps/server/src/db/context.ts',
  // RN-coupled (jest-expo lane): expo-auth-session/SecureStore/expo-fetch closures.
  'apps/mobile/src/auth/session.ts',
  'apps/mobile/src/auth/providers/entra.ts',
  'apps/mobile/src/auth/providers/stub.ts',
  'apps/mobile/src/lib/api-client.ts',
  'apps/mobile/src/lib/boot-timing.ts',
  'apps/mobile/src/lib/log.ts',
  // RN-coupled (jest-expo lane), 0.1.2: the motion seam (react-native Animated/
  // AccessibilityInfo closure) and the haptics seam (expo-haptics closure).
  // Behavioural nets: __tests__/motion-primitives.test.tsx + the primitives
  // suite's reduce-motion/teardown cases; src/lib/haptics.test.ts (the engine
  // mapping) + the primitives suite's vocabulary-wiring cases.
  'apps/mobile/src/lib/motion.ts',
  'apps/mobile/src/lib/haptics.ts',
  // React-hooks module (useEffect/rAF), jest-expo lane — and dev-only perf
  // tooling besides (consumed solely by app/perf-harness.tsx, which renders
  // perf-unavailable outside __DEV__). Behavioural net: 12 jest tests
  // (perf-probes.test.ts), the perf-harness journey, and Canary 20's
  // busy-loop red-proof in the device lane.
  'apps/mobile/src/lib/perf-probes.ts',
]

/** Stryker's `mutate` globs. Tests, type decls and the carve-outs above are excluded. */
export const MUTATE_GLOBS = [
  ...CRITICAL_ROOTS.map((root) => `${root}**/*.ts`),
  '!**/*.test.ts',
  '!**/*.d.ts',
  ...CRITICAL_EXCLUDES.map((path) => `!${path}`),
]

/** True when a repo-relative path is a file this lane mutates. */
export function isCritical(file) {
  const path = file.replaceAll('\\', '/')
  if (!path.endsWith('.ts') || path.endsWith('.test.ts') || path.endsWith('.d.ts')) return false
  if (CRITICAL_EXCLUDES.includes(path)) return false
  return CRITICAL_ROOTS.some((root) => path.startsWith(root))
}
