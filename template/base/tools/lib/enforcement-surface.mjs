// tools/lib/enforcement-surface.mjs — the ONE list of what "the enforcement surface"
// means, as data. Pure: no imports, no side effects, no fs.
//
// Two gates need the same answer for different questions, and before 0.3.0 only one of
// them had it. check-gate-integrity asks "was this widened without a commit"; check-wiring
// asks "is this covered by a CODEOWNERS rule with a real owner". A second hand-maintained
// copy of the list would drift, and the drift would be invisible — the second gate would
// simply stop asking about whatever the first one added.
// SOURCE: docs/harness/README.md (tamper evidence) [corpus: harness/doctrine]

// The escape hatches: reviewed human data that EXEMPTS code from a gate or RAISES a
// budget. Seeded (a project tunes them), so their content is not hash-pinned — the
// invariant is that a widening must be COMMITTED, not left dirty at gate time.
export const ESCAPE_LISTS = [
  'tools/rls-exempt.json', // exempting a table from FORCE RLS — the security one
  'tools/tenancy.json', // the closed predicate-form set + the one seat-writer role
  'tools/security-definer-allow.json', // authorizes EXECUTE-to-authenticated on a definer fn
  'tools/audit-columns.json', // opting a column's VALUES into the audit trail
  'tools/pii-columns.json', // the deny list that opt-in is checked against
  'tools/db-limits.json', // the per-role blast-radius ceilings + the quota trigger shape
  'tools/data-flow.json', // what survives a subject's deletion, and the export projection
  'tools/reviewer-triggers.json', // which reviewer the diff summons
  'tools/security-headers.json', // the web response posture, asserted by value
  'tools/rate-limit-budget.json', // raising a budget is raising what one caller may cost everyone
  'tools/db-perf-baseline.json', // the plan-probe floor + budgets — lowering minRows is how a plan probe becomes vacuous
  'tools/provenance-overrides.json', // cross-group citation escapes
  // 0.5.0. The citation TAXONOMY, and a widening in the same sense its neighbour above
  // is: provenance-overrides.json excuses ONE site from the group rule, while adding a
  // group here makes a whole class of citation resolve that previously could not. It
  // carried a write-guard rule and a SEEDED entry since 0.1.x and was absent from this
  // list for the whole time — found by scripts/check-escape-registry.mjs, which exists
  // because the header above promised drift would be invisible and then was.
  'tools/decision-groups.json',
  'tools/license-exceptions.json',
  // 0.9.9. Accepting a dependency whose VENDOR has stopped supporting it — the widening
  // its neighbour above is for licences. It is an escape rather than a harness-owned floor
  // (framework-floor.json is the floor) because the question "do we carry this abandoned
  // package, and why" is answered by the project that has the dependency, not by the
  // generator that has never seen its lockfile.
  'tools/eol.json',
  // 0.9.9. The recovery-point tolerance the backup lane judges against. It belongs with the
  // budgets below rather than with the exemptions above: widening `maxDailyBackupAgeHours` is
  // raising a ceiling, and it is the one edit that quietly turns the lane green.
  'tools/backup-posture.json',
  'tools/route-allowlist.json',
  // 0.6.0. The web twin: allowlisting a page as chrome exempts it from declaring an id, a
  // title key and its three data states — the same widening as the line above, on the surface
  // that until this release had no registry to be exempt from.
  'tools/web-route-allowlist.json',
  'tools/dto-bounds-allow.json', // exempting a wire string from the .max() bound
  // 0.8.0. Registering a sinks[] row licenses a vendor transport for operational data —
  // an off-device egress path for redacted-but-real values — and extending
  // vendorSpecifiers is the benign direction only because narrowing it is refused by the
  // gate's floor check; the row itself is the widening a reviewer must see.
  'tools/observability.json',
  // 1.0.0. A suppressions-allow row licenses an inline directive that switches a lint
  // rule off at one site, and a resilience row is the reviewed posture (including a
  // declared do-nothing) of a seam that calls out of the system — both are escapes in
  // the exact rls-exempt sense: the row is the widening a reviewer must see.
  'tools/suppressions-allow.json',
  'tools/resilience.json',
  // 1.0.0. A tunables row is a reviewed auth-posture value (jwt lifetime, signup
  // toggles) and additionalSections licenses a whole config SURFACE — both are the
  // rls-exempt shape: the row is the widening a reviewer must see.
  'tools/auth-tunables.json',
  // 1.0.0. Flipping iosEncryption.nonExemptAllowed, adding a privacy-manifest row, or
  // re-shaping the account-deletion surface are store-review decisions — the same
  // reviewed-widening class as every escape above.
  'tools/store-tunables.json',
  'tools/duplication-allow.json', // accepting a code clone
  'tools/vertical-anatomy-allow.json', // accepting a deviation from the vertical anatomy laws
  'tools/i18n-allow.json', // letting a user-facing string bypass the catalog
  'tools/expo-permissions.json', // granting the app a new platform permission
  'tools/expo-plugins.json', // admitting a config plugin to the native build
  'tools/perf-budget.json',
  'tools/interaction-budget.json',
  'tools/startup-budget.json', // raising a cold-start / per-screen nav ceiling
  'tools/bundle-budget.json',
  'tools/perf-baseline.json',
  'tools/styleguide.manifest.json',
  'tools/mutation-baseline.json', // accepting a surviving mutant
  'tools/test-quality-allow.json', // letting a disabled/assertion-free test stand
  // 0.3.0. Approving an MCP server is granting REACH, not tuning a budget — the sharpest
  // escape in this list, and the guard's own deny message asks for exactly this edit.
  'tools/approved-tools.json',
  // Both tolerated-absent by design (their gates read absent-as-empty), so they appear
  // only on installs that created one — and CREATING either converts a red into a NOTE,
  // which is the same act as widening anything above.
  'tools/retrofit-accept.json', // accepting a retrofit config conflict
  'tools/secret-scan-allow.json', // allowing a secret-shaped string past the scanner
  // 0.4.0, same tolerated-absent shape. Acknowledging that an APPLIED migration cannot be
  // swept: the ADR reference and the lock_timeout preamble both live inside the file, and
  // the append-only rule reds any edit to a committed one, so history has no in-file
  // remedy. The gate refuses an entry for a migration that is new at the diff base, which
  // is what keeps this an acknowledgement of the past rather than a way to write around
  // the rule — but the entry itself is still a widening, and belongs in a reviewed commit.
  'tools/migrations-allow.json',
]

// The threshold-bearing configs (0.3.0). Judged by COMMIT, never by hash: raising a
// coverage floor or adding an eslint rule is a legitimate act, and a pin guaranteed to
// break on correct use is a gate everyone learns to ignore. What is not legitimate is an
// agent widening one mid-turn to buy a green run — so the invariant is that the raise is a
// reviewable commit.
export const CONFIG_COMMIT = [
  'vitest.config.ts', // aggregate coverage thresholds AND PER_FILE_FLOORS
  'apps/mobile/jest.config.js', // the other half of the unit floor
  'eslint.config.mjs', // complexity ceiling, boundary bans, the custom rules
  'biome.jsonc',
  'knip.json', // an `ignore` entry is how dead code stops being dead
  '.dependency-cruiser.cjs', // the architecture gate's rules ARE this file
  '.gitignore', // one line here makes a file invisible to every git-diff-based gate
  // 0.9.0: the unguarded mutation-narrowing path. Its `mutate` surface comes from
  // tools/lib/mutation-critical.mjs (hash-pinned), but the config itself can override,
  // ignore or re-scope everything the lane judges — and it is not hash-pinned, because
  // widening the mutated surface is a legitimate consumer act. Commit-not-dirty is the
  // invariant that survives legitimate use while refusing the mid-turn narrowing.
  'stryker.config.mjs',
]

// The path PREFIXES that constitute the enforcement surface itself: the gate scripts, the
// agent surface, the CI definitions, and the install record. A CODEOWNERS file that does
// not cover these is a CODEOWNERS file that does not cover the thing ~ten gate failure
// messages promise it covers.
export const SURFACE_PREFIXES = [
  'tools/',
  '.claude/',
  '.github/',
  '.harness/',
  'supabase/',
  'tests/rls/',
]

// Individually-named root files on the enforcement surface (no useful prefix).
export const SURFACE_FILES = [
  'lefthook.yml',
  '.gitleaks.toml',
  '.mcp.json',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  'renovate.json',
  'stryker.config.mjs',
  'commitlint.config.mjs',
]
