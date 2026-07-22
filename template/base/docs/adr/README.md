# Architecture Decision Records

One ADR per vertical slice. ADRs capture the *why* behind non-trivial decisions
(security, RLS/user-scoping, schema, the native config surface, contracts) so they are
reviewable and reproducible. Destructive migrations are hard-coupled to ADRs: the
`migrations` gate rejects DROP/TRUNCATE without a `-- adr: docs/adr/<file>` line
pointing at an existing record.

## Conventions

- **One ADR per slice.** Emit it with `/adr <slice-name>`.
- **Filename:** `YYYYMMDD-slug.md` (e.g. `20260102-note-sharing.md`). The date prefix
  sorts chronologically; the slug matches the slice name.
- **Template:** copy the structure from `0000-adr-template.md` — Status, Context,
  Decision, Alternatives Considered, Consequences, Sources, Traceability.
- **Sources mirror the code.** Every inline `// SOURCE:` (`-- SOURCE:` in SQL) in the
  slice MUST appear in that slice's ADR **Sources** section, and vice versa. `/adr`
  cross-checks this; `/verify-citations` then resolves each source.

## How the provenance loop closes

The chain runs corpus -> code -> check -> ADR -> verification -> gate
(SOURCE: docs/harness/README.md — the provenance pipeline):

1. **corpus / authority** — a version-pinned authority (Expo / React Native / Postgres /
   Drizzle / Hono docs, or an entry in `tools/mcp/corpus/index.json`) grounds a decision.
2. **`// SOURCE:`** — an inline comment on the decision line cites that authority,
   with `[corpus: <id>]` when pinned.
3. **posttool-source-check hook + `provenance` gate** — flag any decision site that
   lacks a citation, per-edit and tree-wide.
4. **`/adr`** — writes the ADR and reconciles its **Sources** list against every
   inline `// SOURCE:` in the slice.
5. **`/verify-citations`** — the `citation-verifier` subagent resolves each source
   (existence + support) and returns `CITATIONS: CLEAN` or `CITATIONS: REJECTED`.
6. **Stop gate** — `pnpm validate` + `node tests/rls/run-rls.mjs` + both unit suites
   must be green before the turn ends; the Stop hook enforces it.
