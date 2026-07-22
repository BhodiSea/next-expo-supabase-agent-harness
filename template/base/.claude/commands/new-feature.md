---
description: One-turn vertical-slice entry point (migration+RLS -> DAL -> route+contract -> mobile screen -> tests -> provenance -> green gate).
argument-hint: "[feature-name]"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
model: opus
---

Build the feature **$1** as a complete vertical slice in a single turn.

Use the `authoring-vertical-slice` skill and follow its locked order EXACTLY:
migration + RLS -> DAL -> route + contract regen -> mobile screen -> tests ->
provenance -> green gate.

Delegate each layer to its specialist subagent:

- schema / migration + RLS -> `migration-rls-author`
- the DAL + route contracts (`apps/server/src/dal/$1.ts`) -> `dal-author`
- the test suite (isolation target + units) -> `test-author`

The MAIN THREAD runs the scaffold and the contract regen (the `dal-author` subagent
has no Bash):

```
node .claude/skills/authoring-vertical-slice/scripts/scaffold-slice.mjs $1
pnpm openapi:emit   # after any route change; the contracts gate diffs the committed file
```

The scaffold deliberately does NOT create the migration file — migrations are
append-only (the write-guard denies edits to any existing
`packages/schema/drizzle/*.sql`), so the migration is composed completely and written
ONCE as a new file, with its `meta/_journal.json` entry.

Per-layer non-negotiables the gates enforce (see the skill references for the
worked patterns — a slice missing any of these arrives pre-red):

- migration: ENABLE + FORCE RLS, four per-op initPlan policies, AND a
  leading-column index on the owner column, all in the same migration; the table
  wired into `tests/rls/db-context.ts` ISOLATION_TARGETS (and new DAL methods into
  `tests/rls/dal-shapes.ts`).
- DAL: drizzle query builder through `withUserContext`, Zod-parse at exit,
  keyset pagination with an unconditional LIMIT, a statement-count test.
- contracts: `.max()` bounds on every wire string; errors through the
  `{ error: { code, message, requestId } }` envelope with declared 4xx/5xx.
- mobile: the screen REGISTERED in `src/routes.ts` (and its `app/` route file),
  tokens-only styling through `src/theme` (no literal colors/sizes), every
  user-facing string a catalog key rendered via `t()`, loading/empty/error state
  testIDs, API access only through `src/lib/api-client.ts` — plus the closure the
  Stop chain enforces: a Maestro flow and a `tools/startup-budget.json` row for
  the new screen (`mobile-perf --closure` reds otherwise; the budget file is
  human-reviewed, so list the needed row in your report if you cannot write it).
- tests: enough to hold the coverage floor (vitest + jest-expo both run
  `--coverage` in the Stop hook; diff-coverage holds every changed file to the
  per-file floor).

For invariant-touching work (auth, RLS, migrations, the app-config security
surface), it is strongly recommended to write `specs/$1.md` first and get sign-off
before implementing.

Before you finish (provenance is REQUIRED — the turn is not done without it):

- run the `torvalds-reviewer` subagent and require `VERDICT: SHIP`;
- run the `security-reviewer` if migrations / RLS / the DAL / db context / auth /
  API middleware changed;
- run the `mobile-security-reviewer` if `app.config.ts` / `eas.json` /
  `tools/identity.lock.json` / the permission or plugin allowlists / `src/host/**` /
  the auth session changed;
- run the `accessibility-reviewer` if mobile UI changed;
- run the `design-reviewer` if mobile UI changed (taste + choreography; require
  `PASS`);
- emit and verify the ADR — run `/adr $1` FIRST (so the ADR Sources list is itself
  verified), THEN run `/verify-citations` and require `CITATIONS: CLEAN`.

Every non-trivial decision carries `// SOURCE:` (`--` in SQL), ideally with a
`[corpus: <id>]` reference. The turn ends ONLY when `pnpm validate` is green and
`pnpm test:rls` / `pnpm test` / `pnpm test:mobile` pass. The Stop hook enforces
exactly this (it invokes `node tools/validate.mjs`, `node tests/rls/run-rls.mjs`,
and both unit runners directly) — do not stop on a red build.

Current working tree for context: !`git status --short`
