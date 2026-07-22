# Local MCP servers

Two stdio MCP servers ship with the harness (wired in `.mcp.json`, allow-listed in
`.claude/settings.json`):

## corpus_search

Searches and resolves the version-pinned citation corpus at
`tools/mcp/corpus/index.json`. Every `// SOURCE: … [corpus: <id>]` comment must
resolve against it — `/verify-citations` and the `citation-verifier` subagent use
these tools to reject hallucinated citations. Extend the corpus deliberately: add
an entry (id, title, url, version, text) in the same PR that first cites it.

Tools: `corpus_search { query }`, `corpus_resolve { id }`.

## rls_verify

Mid-turn cross-user RLS isolation probe against the LOCAL docker-compose Postgres
(`DATABASE_URL`, the unprivileged `app_api` role). As `userA`, asserts 0 of
`userB`'s rows are visible; first proves the probe is non-vacuous by impersonating
`userB` and requiring at least one visible row (positive control — under FORCE RLS
the owner is policy-subject too, so self-visibility is the only honest baseline).
Read-only, transaction-local GUCs, always rolled back. Returns
`RLS: ISOLATED / LEAK / SKIPPED` — anything that prevents a real probe is a SKIP,
never a green. The CI suite (`pnpm test:rls`) is authoritative.

Tool: `rls_verify { table, userA, userB, ownerColumn? }`.
