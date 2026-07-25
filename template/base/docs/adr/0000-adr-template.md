# 0000 — <Title>

- **Status:** Proposed | Accepted | Superseded by NNNN
- **Date:** YYYY-MM-DD
- **Slice:** <feature-name>

## Context

What problem does this slice solve, and what constraints (security invariants,
RLS/user-scoping, the native config surface, migration discipline, fleet version skew,
store policy, regulatory, performance) bound the decision?

## Decision

The decision that was made, stated plainly.

## Alternatives Considered

- **Alternative A** — why it was rejected.
- **Alternative B** — why it was rejected.

## Consequences

Positive and negative consequences, trade-offs accepted, and any follow-up work or
risks created by this decision.

## Sources

Version-pinned authoritative references behind the non-trivial choices in this slice.
Every inline `// SOURCE:` (`-- SOURCE:` in SQL) in the slice MUST appear here.

- <https://example.com/doc#anchor> — what it backs.
- `[corpus: <id>]` — what it backs.

## Traceability

The RTM fragment: requirement -> implementation files -> test ids.

| Requirement | Migration / DAL / route / UI files | Test ids |
| ----------- | ---------------------------------- | -------- |
| R1: ...     | `supabase/migrations/<ts>_<feature>.sql`, `packages/api/src/routers/<feature>.ts`, `apps/{web,mobile}/...` | `supabase/tests/... > isolates ...`, `<feature>.test.ts > ...` |
