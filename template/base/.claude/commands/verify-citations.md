---
description: Verify every // SOURCE: and ADR citation in the working tree; reject hallucinations.
allowed-tools: Read, Grep, Glob, Bash
model: sonnet
---

Run the `citation-verifier` subagent over the current changes:

!`git diff --name-only HEAD`

It must perform PRE-SCREEN -> EXISTENCE-RESOLVE -> SUPPORT-CHECK (resolving
`[corpus: <id>]` references through the `corpus_search` MCP server against
`tools/mcp/corpus/index.json`) and return either `CITATIONS: CLEAN` or
`CITATIONS: REJECTED` with every unresolved / unsupported / hallucinated entry. If
REJECTED, fix the sources (or remove the unsupported claim; or, deliberately, add the
missing corpus entry in this same change) and re-run this command until it returns
`CITATIONS: CLEAN`.
