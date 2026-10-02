# Local MCP servers

Two stdio MCP servers ship with the harness (wired in `.mcp.json`, allow-listed in
`.claude/settings.json`):

## corpus_search

Searches and resolves the version-pinned citation corpus, which is two files read
through `tools/lib/corpus.mjs`, the same reader the `provenance` gate uses:
`tools/mcp/corpus/index.json`, the harness's pinned authorities (owned and
hash-pinned, so `update` refreshes it), and `tools/mcp/corpus/project.json`, the
project's own (`{ comment, entries }`; absent counts as empty). Every
`// SOURCE: … [corpus: <id>]` comment must resolve against one of them —
`/verify-citations` and the `citation-verifier` subagent use these tools to reject
hallucinated citations. Extend the corpus deliberately: add an entry (id, title, url,
version, text, sha256, groups) to `project.json` in the same PR that first cites it.
Editing `index.json` forks an owned file. A `project/` id prefix is recommended; an id
`index.json` already pins is a `provenance` red, and the server answers it from
`index.json`. A `project.json` that does not parse is a `provenance` red, and until it
is fixed the server answers `NO_MATCH` for every project id. `CORPUS_INDEX_URL`, when
set, replaces `index.json` only.

Tools: `corpus_search { query }`, `corpus_resolve { id }`.

## rls_verify

Mid-turn cross-user RLS isolation probe against the LOCAL Supabase Postgres
(`SUPABASE_DB_URL`). Impersonates the Supabase way — `SET LOCAL ROLE
authenticated` (the policy-subject role) plus a transaction-local
`request.jwt.claims` whose `sub` is the user id `auth.uid()` reads. As `userA`,
asserts 0 of `userB`'s rows are visible; first proves the probe is non-vacuous by
impersonating `userB` and requiring at least one visible row (positive control —
under FORCE RLS the owner is policy-subject too, so self-visibility is the only
honest baseline). Read-only, transaction-local, always rolled back. Returns
`RLS: ISOLATED / LEAK / SKIPPED` — anything that prevents a real probe is a SKIP,
never a green. The CI suite (`node tests/rls/run-rls.mjs`) is authoritative.

Tool: `rls_verify { table, userA, userB, ownerColumn? }`.
