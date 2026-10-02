# Provenance & citeability (always loaded)

SOURCE: docs/harness/README.md (provenance rule)

- Every non-trivial design decision in generated code carries an inline
  `// SOURCE: <authoritative URL or corpus id>` on or above the decision line —
  `-- SOURCE:` in SQL files and migrations.
- Decision sites include: RLS policy SQL (`CREATE POLICY`, `FORCE ROW LEVEL
  SECURITY`, the `auth.uid()` policy predicate) and the server-side session
  verification that feeds it (`getUser()`/`getClaims()`, never `getSession()` —
  the choice itself is the cited decision), token/webhook verification
  (`jwtVerify`, JWKS choices, `clockTolerance`), vector index choices (`USING
  hnsw`/`ivfflat`, opclass), LLM sampling parameters, retry/timeout/rate-limit
  constants, the
  mobile security surface (ATS/cleartext exceptions, Android permission
  strings, the `runtimeVersion` policy, the EAS updates URL — the seeded
  `mobile-security` group), and any security trade-off. The
  posttool-source-check hook and the `provenance` gate
  (`tools/check-sources.mjs`) run the identical heuristic — per-edit and
  tree-wide; both merge the group extensions in `tools/decision-groups.json`,
  which is how new decision classes join the taxonomy.
- Mandatory and advisory classes (1.1.0). An uncited site in a MANDATORY class
  blocks the edit (the hook exits 2) and reds the gate: `rls-policy`,
  `guc-identity`, `token-verification`, `cryptography`, `mobile-security` and any
  group a project adds. Three classes are ADVISORY — `vector-index`,
  `llm-sampling`, `tuning-constants`: an uncited or wrongly grounded site there is
  reported (the hook's `additionalContext`, the gate's `provenance: ADVISORY`
  line) and blocks nothing, but cite it all the same. A site that matches any
  mandatory class is mandatory. `"mandatory": ["<key>"]` in
  `tools/decision-groups.json` promotes an advisory class; nothing demotes one.
- Cite version-pinned authorities. When the authority is pinned in the corpus
  (`tools/mcp/corpus/index.json`, or the project's `tools/mcp/corpus/project.json`),
  append `[corpus: <id>]` and verify it resolves with the `corpus_search` MCP tool.
  Add a new authority to `project.json`, never to the harness-owned `index.json`, in
  the same PR that first cites it. The citation must JUSTIFY the decision, not merely
  resolve: cite an entry whose `groups` cover the site's decision class (cross-group
  escapes are human-reviewed entries in `tools/provenance-overrides.json`), and a bare
  URL grounds a citation only when its host is on the `tools/lib/citation-domains.mjs`
  allowlist — pin any other authority in `project.json` instead.
- Emit one ADR per slice via `/adr <slice>` (records live in `docs/adr/`); the
  ADR's **Sources** section must mirror every inline `// SOURCE:` in the slice.
  Then run `/verify-citations` — the read-only `citation-verifier` subagent
  rejects hallucinated or unresolvable citations. A turn does not end until it
  returns `CITATIONS: CLEAN`.
- Reproducibility (secondary): the release pipeline pins toolchains (exact
  catalog pins; eas.json `node`/`pnpm` per-profile pins) and the `ci-provenance`
  module adds SBOM + build attestation; reference these where CI touches the
  slice.
