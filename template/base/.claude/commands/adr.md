---
description: Emit an Architecture Decision Record for the current feature slice.
argument-hint: "[slice-name]"
allowed-tools: Read, Grep, Glob, Write, Bash
---

Today's date (the command engine does NOT expand `$(...)`, so use this inline line):

!`date +%Y%m%d`

Write an ADR to `docs/adr/<YYYYMMDD>-$1.md` (use the date printed above as `<YYYYMMDD>`)
from the template at `docs/adr/0000-adr-template.md`. Fill in every section:

- **Context** — the problem and constraints driving this slice.
- **Decision** — what was chosen.
- **Alternatives Considered** — what was rejected and why.
- **Consequences** — trade-offs, follow-ups, risks.
- **Sources** — every authoritative reference (version-pinned URLs, `[corpus: <id>]`
  entries, ADR ids) behind the non-trivial choices in this slice.
- **Traceability** — the RTM fragment: requirement -> migration / DAL / route /
  mobile-screen files -> vitest + jest test ids + the `tests/rls/db-context.ts`
  isolation target.

Then cross-check two couplings:

1. Every inline `// SOURCE:` (`-- SOURCE:` in SQL) in the slice MUST appear in the
   ADR **Sources** list. Grep the changed files for `SOURCE:` and reconcile.
2. If the slice contains destructive DDL (DROP TABLE/COLUMN, TRUNCATE), the migration
   MUST reference this ADR via `-- adr: docs/adr/<YYYYMMDD>-$1.md` — the `migrations`
   gate fails otherwise, and the referenced file must exist BEFORE the migration is
   written (append-only: the migration cannot be edited afterwards to add it).
