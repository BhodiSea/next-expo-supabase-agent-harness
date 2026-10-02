# OWED: an obligation ledger for retrieval results

Paths are relative to `template/base/` at the 2.0.0 stack head (`b158f5a`) unless they start with `installer/`, `scripts/`, `design/` or `tests/`. Line numbers were read in the stack-head tree, or come from a research file that cites them.

## 1. Name and thesis

**OWED.** Retrieval is plumbing here. What is new is that every high-confidence retrieval result becomes a **debt with an identity**. One key (`ca-7f3a9c21e0b4`) is the same string in seven places:
- the write-time message;
- the reviewer packet;
- the Stop verdict;
- the CI check;
- a committed disposition register;
- a per-package slop ratchet;
- a GitHub issue.

There are exactly three ways to pay a debt:
- **reuse** and **extract** are recomputed from the tree;
- **justify** is the harness's existing two-place escape. Its register row can only arrive through `harness-proposals/` → `apply-proposal`, and only after a read-only reviewer has endorsed the key, so the author never exempts itself.

RepoReuse shows that agents ignore context they already have, and SlopCodeBench and CodeThread show that slop compounds. So OWED does not show context and hope:
- Only reuse and extract finish inside a turn. Justify is deliberately expensive.
- Slop too noisy to block one instance at a time sits under per-package count ratchets that never grow.
- Every non-blocking line flows through one recorder (`noteAdvisory`) into one issue pipeline. Issues close by recomputation, never by their GitHub state.

It is specific to this harness:
- Keys and legal moves come from the stack's slots, rails (`mapPostgresError`, `set_updated_at`, the cursor codec) and deliberate parallels.
- It reads the `sql-parse` views and the generated inventories.
- Its verdicts reuse ramps, ESCAPE_LISTS, proposals, the v2 ledger, canaries and `reviewer-eval`.
- It adds no parser dependency.

## 2. Architecture

### 2.1 Fact index (plumbing, base, owned)

| Item | Decision |
|---|---|
| Module | `tools/lib/fact-index.mjs`. Owned, write-guarded, namespace-imported (the 1.0.2 rule). |
| TS parser | The project's own `typescript`, syntax-only `ts.createSourceFile`, loaded via R07's `loadParser()` (`tools/lib/i18n-tree.mjs:98`). If it cannot load: null, which is a NOTE locally and a FAIL in CI. oxc, ast-grep, tree-sitter and libpg_query are rejected: native dependencies with no gain at this scale (§10). |
| SQL | The existing `tools/lib/sql-parse.mjs` (`parseFunctions:1045`, `parsePolicies:481`, `parseTriggers:1107`, `parseColumnFacts:978`) |
| Roots | The `check-duplication.mjs` walk (`:35-60`) plus `supabase/{schemas,migrations}`. Excluded: tests, `*.generated.*`, `.txt` overlays. |
| Unit | One record per function, component, hook, exported zod schema, procedure, SQL function, policy and trigger. In functions over 80 lines, also one record per block of at least 25 tokens. |
| Cache | Per-blob records in `.harness/facts/v1/<blobsha>.json`, written temp-then-rename. Merged and immutable: `tree-<digest>.json`. `.harness/**` is denied to Edit, Write and Bash (`.claude/settings.json:215-216`, `.claude/hooks/pretool-bash-guard.mjs:25`). In CI: `actions/cache`. |

The record has closed fields and holds no source text:

```json
{"id":"@app/notes:src/domain/cursor.ts#encodeCursor","blob":"3be1…","span":[18,36],
 "kind":"fn","exported":true,"slot":"cursor-codec","sig":"(string,string)=>string","arity":2,
 "alpha":"9c1e0f…16hex","mh":[/*64 u32*/],"logicTokens":61,"rnr":0.12,
 "imports":["@app/errors#appError"],"callees":["Buffer.from"],"tables":["notes"],
 "flags":{"passThrough":false,"singleExpr":false,"boolSelector":[],"swallow":0,"todo":0,"constReturn":false}}
```

**Subject ids.** TypeScript ids take the form `<workspace|app>:<path in package>#<symbol>`. SQL ids take the form `sql:<schema>.<fn>(<argtypes>)`. Every id is validated by `^[A-Za-z0-9@/_.:#(),-]{1,160}$` and never contains a line number.

**`tools/lib/slop-slots.mjs`** (owned) holds:
- the **slot** table, keyed on vertical-anatomy behaviour (`tools/lib/vertical-anatomy.mjs:51-59`);
- the **deliberate-parallel classes**: `transport-twin` (`apps/web/app/actions/<s>.ts` ↔ `packages/api/src/routers/<s>.ts`), `ds-mirror`, `port-per-consumer` and `i18n-catalog`. Pairs already accepted in `tools/duplication-allow.json` count as deliberate too;
- the **altitude** table that yields legal moves. A factory test keeps it in lockstep with `.dependency-cruiser.cjs`;
- `AUTHOR_SLOTS`, e.g. `dal-author` → port, rows, errors, dal, cursor-codec.

**The concept graph** (SQL column → `rows.ts` → DTO → procedure → route) is built from `tools/generated/query-shapes.json`, `action-inventory.json`, `routes.generated.ts`, `data-flow.json` and `parseColumnFacts`. Selection is never by import graph alone.

### 2.2 Similarity layers

| Layer | Technique | Highest tier |
|---|---|---|
| L0 | The existing `duplication` gate (type-1, ≥70 tokens and ≥6 lines, `check-duplication.mjs:30-31`), **unchanged** | blocks, as today |
| L1a | α-hash: locals renamed in binding order; imported and global names kept, so a hit can name the rail; literals reduced to their kind. Exact type-2. | owed |
| L1b | MinHash (64 permutations) over 3-grams of AST node kinds, LSH 16×4. A candidate needs a verified Jaccard of at least 0.80 and equal arity (type-3). | ratchet |
| L1c | SQL body hash after substituting schema and table names | owed when the match is a rail, otherwise ratchet |
| L2 | Slot, concept edges, legal-move filter, hole count ("differs in 2 identifiers, 1 literal") | explanation |
| L3 | Embeddings (module, §6) | context only |

### 2.3 Families, tiers, keys

**Key** = `<code>-<12 hex of sha256(family|rule|sorted subject ids)>`. It contains no lines and no content. Fingerprints are kept as evidence only.

| Code | Family (catalogue # / slop taxonomy) | Recipe | Launch tier |
|---|---|---|---|
| `rh` | reinvented helper (#27) | New function is α-equal to an existing exported function | owed |
| `ca` | copy-adapt T2 (#5) | α-equal pair across modules, ≥25 logic tokens (below L0's floor) | owed |
| `rb` | rail bypass (#26; "parallel implementation") | α-equal, or J≥0.80, to a **rail**: an export of `packages/platform/*` or `packages/shared/*`, or a SQL function named in `tenancy.json`, `db-limits.json` or `00_shared.sql` | owed |
| `c3` | copy-adapt T3 | L1b pair across modules | ratchet |
| `wo` | wrapper of one (#10, #24) | Body is one forwarded call; ≤1 non-test caller; transport twins excluded | ratchet |
| `sc` | single-consumer abstraction (#9) | New exported interface with 1 importer and no fake; `port.ts` whitelisted | ratchet |
| `es` | error swallowing | `catch` with no rethrow or mapping; a Supabase `error` that is never read | ratchet |
| `ab` | abandoned scaffolding | TODO/FIXME; an exported function that returns a constant | ratchet |
| `bs` | boolean selector (#20) | Top-level split on a boolean parameter that callers pass as a literal | ratchet |
| `rs` | partial migration | Retired tokens from `tools/doctrine-symbols.json` used in product code | ratchet |
| `sq` | SQL clone | L1c pair that is not a rail (`audit.deny_mutation` ≡ `auth_trail.deny_mutation`) | ratchet |
| — | Catalogue #6, #7, #8, #12, #18, #22, #24, #25; gate-induced splitting; mirror tests | | advisory |
| — | Fan-in (#15), co-change (#1–4), depth (#13), envy (#16), synonyms (#19), untouched mirror partner, semantic hits | | context |

**Promotion ladder.** A family moves context → advisory → ratchet → owed only when it clears that rung's bar:
- **advisory**: it is keyed and CI can recompute it;
- **ratchet**: precision on the corpus is at least 0.90;
- **owed**: it also has a mechanical discharge, and its effective false-positive rate is at most 10% (Tricorder).

Each promotion is a gate-proposal plus a ramp.

### 2.4 Ranking and caps

Findings are ranked by:

`rank = precisionPrior(family) × spread(1 | 1.5 cross-package | 2 cross-surface) × log2(1+logicTokens) × (1+fanIn/10)`

Ties break by key.

| Channel | Cap |
|---|---|
| Write-time | ≤3 owed items and ≤1,500 characters per message; ≤3 messages per prompt, then one count line |
| Author brief | ≤12 homes plus the open owed keys, ≤2,500 characters |
| Reviewer packet | owed ≤10, ratchet ≤8, advisory ≤10, context ≤8; ≤6,000 characters in total |
| Issues | 10 new per run, 50 open, one dashboard |

### 2.5 Gates, registers, recorder, hooks

**Gates.** One script, `tools/check-slop.mjs`, serves two steps: `owed` (`--owed`) and `slop-ratchet` (`--ratchet`).
- Both join the Stop chain after `duplication` (`tools/harness.config.mjs:201`).
- Both are added to `tools/stop.floor.json`, which only grows.
- Both run in the `unit` CI lane next to the duplication step (`github/workflows/quality-gate.yml:206-210`).
- Further flags: `--sweep --json`, `--explain <key>`, `--propose <key>`, `--packet <agent>`, `--prune`, `--write`.

**Registers** (committed):
- **`tools/dispositions.json`**: seeded, write-guarded, covered by CODEOWNERS, and added to `ESCAPE_LISTS` (`tools/lib/enforcement-surface.mjs:14`) and `PROPOSABLE` (`installer/lib/proposals.mjs:30`). Shape in §4.
- **`tools/slop-baseline.json`**: seeded as `{"version":1,"counts":{"wo":{"@app/notes":0}},"keys":{"wo":[…]}}`.
  - Only its generator writes it, like `mutation-baseline.json`, so it is not proposable.
  - `--write` joins the `self-rebaseline-writer` deny (`.claude/hooks/lib/guard-rules.mjs:218-221`).
  - `--prune` is allowed, because it can only remove entries.

**Recorder.** `noteAdvisory(gate, {rule, subjects, text, status, scope, until?})` lives in `tools/lib/gate.mjs` next to `noteMissingPrerequisite` (`:169`) and keeps its contract: silent, swallows its own errors, never decides a verdict.
- It prints `<gate>: NOTE — <text>`.
- When `HARNESS_ADVISORY_REPORT_DIR` is set, it also appends `{v:1,gate,rule,key,subjects,status:advisory|ramp|blocking,scope:repo|session,until}`.
- `rampNote` (`:283`) routes through it. The expiry branch (`:319`) emits `status: blocking` under the same key, so an issue never closes "fixed" at the moment its ramp expires into a hard red.

**Hooks:**
- **`posttool-owed.mjs`**: PostToolUse on `Edit|Write|MultiEdit`, timeout 5 s, its own 1 s deadline. Invoked directly, not through `launch.mjs`, and exits 0 on every path, like `session-brief.mjs`.
- **Reviewer SubagentStart** (`subagent-verdict.mjs:284-301`): prints the packet and records `packet_digest`.
- **`subagent-brief.mjs`**: a new SubagentStart entry for authors. `subagent-verdict.mjs` exits 0 for non-reviewers, so it cannot serve them.
- **SubagentStop**: parses `<key>: endorsed|rejected` into an additive `endorsements` field.
- **Stop hook**: sets the recorder directory. On a green turn it prints one systemMessage line (Fact 16): `advisories: 7 recorded, 2 new keys`. Without it, NOTEs vanish on green (`stop-validate-gate.mjs:268-276`).

**Tools:** `tools/neighbours.mjs` (plan time), plus `next: reuse …` lines printed by `scaffold-slice.mjs`.

## 3. Delivery protocol

| Moment | Reaches | Mechanism | Shape |
|---|---|---|---|
| Plan | main agent | `node tools/neighbours.mjs --plan <entity> [--cols] [--verb]`, called from skill Step 0. The spec template gains a `## Reuse` section listing the ids considered. | ≤40 lines: tables with overlapping columns, same entity+verb actions (`action-inventory.json`), slot homes |
| Scaffold | main agent | `scaffold-slice.mjs` stdout | ≤3 lines per slot: `next: reuse @app/supabase:src/errors.ts#mapPostgresError for slot errors` |
| After an edit | the editing agent; inside subagents too, if probe (c) passes | `posttool-owed.mjs` `additionalContext`. Fires only on a **new subject** (new file, export or SQL object). | The message below |
| Author dispatch | `dal-author`, `migration-rls-author`, `test-author` | SubagentStart `additionalContext` (probe a); fallback `updatedInput` on the Agent tool (probe b) | Homes for the slots you write (`path#symbol sig`), plus the session's open owed keys |
| Reviewer dispatch | `torvalds-reviewer` (whole turn), `architecture-reviewer` (when owed) | SubagentStart `additionalContext`. Fallback: `.harness/packets/<agent>.md`, which Read is allowed on. | The packet below |
| Stop | main agent | `owed` / `slop-ratchet` exit 1 and the hook blocks | Every open key with its legal moves, self-contained. Having seen a key earlier never changes the verdict. |
| CI | PR | The same script over the merge-base diff | Same text |

**Write-time message.** Fields pass closed validators. There is no code body and no free text from the tree.

```
OWED ca-7f3a9c21e0b4 (blocks at Stop and in CI unless paid) · 1 of ≤3
  yours     @app/invoices:src/domain/cursor.ts#encodePageToken  :12
  existing  @app/notes:src/domain/cursor.ts#encodeCursor        :18  rename-equal, 0 holes
            (string, string) => string
  A vertical may not import another vertical. Legal moves:
    EXTRACT  move encodeCursor to packages/shared/<name>, import it from both, delete yours
    JUSTIFY  `// disposition: ca-7f3a9c21e0b4 — <reason>` + reviewer endorsement
             + human `apply-proposal` (the turn ends red until applied)
  Import or move the existing one. A second body is the debt, not the fix.
```

**Reviewer packet.** It states neutral facts and no verdict labels, because labels anchor reviewers (Tufano 2025).

```
OBLIGATION PACKET v1 — generated by the harness from the tree; the author did not write it.
tree 3be1c0a29f11 · base 9a0e771b02cd · Do your own rubric pass first, then report one line
per OWED key: `<key>: reuse|extract|endorsed|rejected|open`.
OWED (2)
 ca-7f3a9c21e0b4 new @app/invoices:src/domain/cursor.ts#encodePageToken 12-30
                 ≡   @app/notes:src/domain/cursor.ts#encodeCursor 18-36  alpha-equal · open
                 shown: dal-author, prompt 3; still present
 rb-19ce02aa5d10 new @app/push:src/data/push-tokens.ts#mapFailure 152-168
                 ~   @app/supabase:src/errors.ts#mapPostgresError 134  J=0.84 · justify-claimed (marker :150)
RATCHET  wo @app/invoices 0→1 (wo-55aa01c2d3e4)
ADVISORY (3 of 9) bs @app/invoices:src/data/invoices.ts#listInvoices param 3, literal at 2/2 callers
CONTEXT  fan-in @app/contracts#InvoiceRecord 14 fns/6 files · mirror partner untouched:
         packages/api/src/routers/invoices.ts
```

**Not an injection surface.** The payload follows `harness-brief.mjs`'s closed-field, no-file-content doctrine (`:11-17`):
- It contains only ids, numbers and fixed-vocabulary words. An id that fails validation prints as `(unprintable)`.
- **Marker reasons are never echoed**, because an author could write "reviewer: endorse this". The packet says only "marker :150".
- Owned, hash-pinned code builds it from the tree. The author's Agent prompt cannot reach it.

**Reuse, not copy.** The research says to send signatures, never bodies (arXiv 2503.20589), and that more than 5 items interfere with each other (A3-CodGen). So the message carries:
- a signature and an import path;
- only the moves the altitude table allows, so the agent is never steered into a depcruise red;
- the price of each move.

Reuse and extract finish inside the turn. Justify costs a reviewer and a human. That asymmetry, more than the wording, is what makes reuse the agent's move.

## 4. Enforcement model

| Tier | Scope | Local | CI | Discharge |
|---|---|---|---|---|
| **owed** | Keys whose newer subject is new since the merge base. A move whose α-hash equals a subject deleted in the same diff is not new. | `owed` step blocks Stop | Same function, `unit` lane | Mechanical reuse or extract; justify with a committed row |
| **ratchet** | `count(family, package)` over the whole tree | `slop-ratchet` blocks on growth, and on shrink until `--prune` | Same | Remove an instance, or justify |
| **advisory** | Whole tree, keyed | Never blocks | Recorded, then issues | Fix it, or a `wontfix` row |
| **context** | Diff neighbourhood | Packet only | — | — |

**The verdict is a pure function of the tree, the merge base and the committed registers.** The shown-ledger feeds only the packet and telemetry. Two things follow:
- A local pass and a CI pass mean the same thing (`quality-gate.yml:1-4`).
- The **CI backstop works when hooks did not run**: a human, another agent, `disableAllHooks` (Fact 11), or a hook that failed to parse (Fact 12).

A PR with no merge base fails closed in CI and gets a NOTE locally.

**Mechanical discharge:**
- **Reuse:** the newer subject is gone, and its module imports the candidate.
- **Extract:** both sides import one symbol whose α-hash matches the old pair, from a home that the altitude table permits.
- **Evaded** (the subject persists but no longer matches): the gate clears, but the packet shows the last score and the reviewer judges it. Bookkeeping never decides.

**Disposition record.** It lives in `tools/dispositions.json` and carries no dates, per `check-suppressions.mjs:27-33`:

```json
{"version":1,"rows":[{"key":"ca-7f3a9c21e0b4","family":"copy-adapt",
  "subjects":["@app/invoices:src/domain/cursor.ts#encodePageToken","@app/notes:src/domain/cursor.ts#encodeCursor"],
  "disposition":"justify",
  "reason":"invoices pages by (issuedAt,id) with a reversed tie-break; one codec would couple two verticals' pagination contracts",
  "evidence":{"alpha":["9c1e…","9c1e…"],"jaccard":1.0},"endorsedBy":"torvalds-reviewer"}]}
```

- `disposition` is `justify`, `wontfix` or `parallel`. A `parallel` row takes two globs and declares one of the project's own mirrors.
- The census closes **both ways**:
  - a row whose subjects are gone is red;
  - a `justify` row with no marker is red;
  - a marker with no row leaves the key `justify-claimed`, which is still open.
- **Evidence drift.** If either subject's `alpha` changes, the row stays valid and the packet lists it as "justification on changed code; re-confirm". Small edits cause no churn, yet nothing stays justified unseen.

**Justify stays a two-place reviewed act:**
1. The author writes the inline marker: `// disposition: <key> — <≥20 chars>`, or `-- disposition:` in SQL.
2. The owed reviewer replies `<key>: endorsed`. SubagentStop records it in the v2 ledger, bound to the digest pair. The author cannot write to `.harness/`.
3. `check-slop.mjs --propose <key>` stages `harness-proposals/<id>.json` targeting `tools/dispositions.json`. It refuses without a current endorsement.
4. A human runs `apply-proposal <id>` in a terminal. The agent is denied this invocation (`guard-rules.mjs:224-237`). CODEOWNERS sees the row in the PR.

Until the human applies the row, Stop and CI both stay red, so the agent cannot exempt itself.

So that an unfixable red does not burn all 8 continuations, `owed` marks those keys `AWAITING-HUMAN`. The Stop hook blocks once, so the agent reports them. If the only failures on the next attempt are those same keys, the turn ends red. `turn-outcomes` records it, and that path has its own canary.

**Ratchets against cumulative slop.** The allowed count is `baseline(family, package) + justify rows(family, package)`.
- **Growth** reds, and lists the new keys.
- **Shrink** reds until `--prune` runs. This is the factory complexity ratchet's both-ways rule (`scripts/complexity-ratchet.json`), so the ceiling can never drift back up.
- Counts, not keys, decide the verdict, so renaming a legacy subject does not trip it. Keys serve issues and dispositions.

**Ramps.** Both steps call `rampNote(GATE, '<shipping minor>', …, {until: '<shipping minor + 2>'})` (`tools/lib/gate.mjs:283`). They are live on fresh installs and NOTE-only on older ones. During the ramp, the NOTEs reach the green line and the issues through `noteAdvisory`. Each family promotion is its own ramp.

## 5. Advisory → GitHub issue pipeline

**Scope recommendation: not literally "all".** Every unfixed advisory that meets all three tests becomes an issue:
- it is **keyed**;
- **CI can recompute it**, so a machine can decide when it is closed;
- it is **about the repo**, not the session.

That includes:
- inventory class A: ramp NOTEs and their withheld findings, provenance classes, controls left OFF, ratchet and hygiene drift, skips that CI permits, doctor's pin floor / source fix / parked upgrade, and scheduled-lane reds (one issue per lane);
- every advisory family;
- legacy ratchet debt.

It excludes:
- **class B** (SKIPPED, STAMPED, per-turn notes): these would open and close every turn. They are recorded with `scope: session` and dropped.
- **class C** (allow files, `deferrals.json`, code scanning): linked from the dashboard, never copied, because "two copies drift" (`scripts/check-obligations.mjs:22-27`).
- **reviewer MEDIUM/LOW prose**: no machine can close it. A recurring finding becomes a gate-proposal for a deterministic family instead.
- **findings in harness-owned files**: these are reported upstream from the dashboard, never filed across repos.

**Identity.** The issue uses the §2.3 key. Ramps use `rp-<sha(file|detail, digits normalised)>`. Line 1 of the body is `<!-- harness-advisory v1 key=<key> body=<sha8> -->`. The sync touches an issue only if it is authored by `github-actions[bot]`, labelled `harness-advisory`, and has the marker on line 1.

| Event | Action |
|---|---|
| New key within the cap | Open the issue. Priority: `blocking` ramp > legacy `rb`/`rh`/`ca` > ratchet > advisory, then by rank, first-seen sha, key. |
| Over the cap | List it on the dashboard |
| Body hash changed | Edit the body. Never comment, except once on `advisory:now-blocking`. |
| `wontfix` or `justify` row | Close `not_planned`, linking the row |
| Absent in **2 consecutive runs** where its gate was `complete` | Close `completed`, citing both shas |
| Gate `skipped` or `failed` | No change. After 3 such runs, the dashboard marks the keys `stale` and one `lane:<gate>-incomplete` issue opens. |
| Closed by a human with no row | Stays closed; listed under "closed without reviewed disposition" |
| Key returns after a `completed` close | Reopen as a regression |

**Caps.** 10 new issues per run, 50 open. The first sweep of an existing codebase runs in **baseline mode**: the dashboard shows counts by family and package plus the top 20 keys of each, and 10 keys are promoted per night.

**Every lane contributes.** On scheduled and dispatched runs, each `quality-gate.yml` lane uploads `advisories-<job>.jsonl` and a `{gate: complete|skipped|failed}` file. The static lane runs `validate --min-floor --report-all`, and `unit` runs `check-slop --sweep`. A base `advisory-collect` job (`contents: read`) merges them.

**Security** (module `advisory-issues`, `advisory-sync.yml`). It runs only on `schedule` (05:37, after the 03:11 nightly) and `workflow_dispatch`.
- **Job `fetch`** (`contents: read`, `actions: read`) takes the payload only from the latest scheduled run whose `head_sha` matches HEAD. If there is no match, every gate is `unknown` and nothing closes.
- **Job `sync`** (`issues: write`):
  - installs nothing and checks out only its script and `dispositions.json`;
  - runs harden-runner with `egress-policy: block` to `github.com` and `api.github.com`;
  - validates the payload against a schema;
  - upserts with `gh api --input -`, never `${{ }}`.
- `concurrency: advisory-sync` prevents overlapping runs.
- Titles use fixed vocabularies. A golden test proves `@`, `#N` and `<` never appear outside code spans.
- A factory test pins the permissions, and a canary proves the lane can go red.
- `doctor` warns when the last sync is more than 3 days old.

**Base or module.**
- **Base:** the recorder, the per-lane artifacts and the collect job. None of these needs a new permission.
- **Module:** the sync. It would be the scaffold's first `issues: write`, and 2.0.0 is "the opt-in release" (`CHANGELOG.md:16`).

**Factory versus consumer.** Each repository syncs its own issues. The factory's `hygiene.yml` runs the same sync over `scripts/obligations.json` and over a `check-slop --sweep` of the composite base + stack + demo tree.

## 6. Optional embedding layer (module `embeddings`)

- **Model.** The hosted option is `voyage-code-4`, pinned to its dated snapshot, at 512 dimensions in int8 plus sign bits. Enabling it needs a write-guarded `tools/embeddings.config.json` row recording that the training opt-out was done before the first call. The local option is Qwen3-Embedding-0.6B (Apache-2.0) behind an endpoint the operator runs. Each option has its own cache, and neither falls back to the other.
- **Storage.** `.harness/context/emb/<modelKey>/{vectors.i8,bits.u32,rows.jsonl}`. Search runs a binary prefilter to the top 200, then rescoring in int8. In CI it uses `actions/cache`. No pgvector.
- **Determinism boundary.** A vector is computed once per (content hash, model, normaliser) and replayed after that. A committed probe set must re-embed at cosine ≥0.995, or the layer disables itself loudly.
  - Vectors are computed by an `async` PostToolUse entry and nightly.
  - SubagentStart reads only the cache. Subjects without a vector print as `semantic: not computed (n)`.
  - No Stop step, CI verdict or issue reads a vector.
- **Tier: context only.** Hits appear in two places:
  - the packet CONTEXT section, at most 3, labelled "unverified resemblance" and listing any deterministic corroborators;
  - the output of `neighbours.mjs --plan`.

  Hits never reach write time, owed, ratchets or issues. If a semantic class turns out to be precise because some structural signal corroborates it, that signal becomes a deterministic family. Embeddings find families; they never decide.
- **Evaluation.**
  - On the seeded type-4 corpus, adding embeddings to the structural index must improve recall@5 by **at least 15 points**, at context precision ≥0.6.
  - Reviewer-eval cases that only a semantic neighbour reveals must gain **at least 20 points** of hit rate, while the PASS-twin rate drops by no more than 5 points.
  - Outcome: "recommended" if both bars are met, "experimental" for a gain of 5–15 points, not shipped below 5.

## 7. Tensions and gaps

**Tensions**
1. **Semantic hits at write time.** No. Write time is deterministic only (L1a and L1c owed hits). Semantic hits are context only.
2. **Issue identity.** One scheme: `sha256(family|rule|sorted subject ids)`, using no lines and no content. Fingerprints are evidence only. The ratchet, dispositions, packet and issue all share the key.
3. **Close rules.** An issue closes after 2 complete runs without its key, or when a `wontfix`/`justify` row exists. A human close exempts nothing. Embeddings never open issues, so cosine never closes one.
4. **"Every advisory becomes an issue".** Every advisory that is keyed, recomputable and about the repo becomes one, within the caps and behind the dashboard. Class B is dropped, class C is linked, and reviewer prose becomes a gate-proposal. There is no committed findings register in `tools/`.
5. **Write-time nag versus owed at Stop.** There is one penalty: being open at Stop. Acting on a write-time hit clears it mechanically. "Shown, then ignored" adds a packet line, not a second block. Only justify reaches reviewers.
6. **Agent loop versus distrusted advisory text.** There is no loop in v1. A later loop module passes only the key, re-derives the finding with `check-slop --explain <key>`, and waits for the Fact 5 headless-permission probe.

**Gaps**
- **CI backstop:** §4; the check is a pure function, run on the `unit` lane.
- **All lanes:** per-lane artifacts from a head-matched run.
- **Diff versus sweep:** `owed` covers the diff; ratchets and issues come from the sweep, which §10 sizes.
- **Duplication gate:** L0 keeps its own store. L1 and above use **one** new store. There is no `advisory-allow.json` and no inline-only marker. L1 treats pairs that L0 accepted as deliberate.
- **Ramp visibility:** handled by the recorder.
- **Unrelated red:** the keys go `stale`, and a lane issue opens.
- **Read/Grep/Glob reviewers:** the packet is built from the cache, with the packet file as fallback. There is no network call.
- **Opt-in:** base for gates and the recorder; modules for sync and embeddings.
- **Which repo:** each syncs its own.
- **Action rate:** `{kind:'owed-outcome', family, outcome}` telemetry, ids only (`hookio.mjs:56-58`). `harness-status --owed-stats` reports justify plus wontfix as a share of resolved keys.
- **Concurrency:** content-addressed caches, atomic appends under 4 KB, filtering by `session_id`, and the Stop hook's existing detection of concurrent sessions.

## 8. What it deliberately does NOT do

**Deletion bias.** The design drops several ideas from the research corpus:
- the inline-only `neighbour-divergence:` marker, because it lets an agent exempt itself;
- `advisory-allow.json`, which would be a third store;
- "shown, then ignored" as a penalty;
- semantic hits at write time;
- the `neighbourhood_query` MCP tool. It is pull-based, needs 4 registry changes, and the eval's `--strict-mcp-config` hides it;
- an agent loop in v1.

It adds no parser dependency. The dogfood PRs must be net-negative in lines of code.

| Rejected | Why |
|---|---|
| A pull-only index | RepoReuse shows availability does not change behaviour |
| Embeddings in any verdict | Not reproducible; ExecRetrieval rank-1 accuracy is only 33% |
| Gating on co-change | Needs 5–10 revisions per file, and young repos have 1–3 |
| Depth, feature-envy or synonym gates | Unvalidated, or ≤15% precision |
| Reviewer memory | Already rejected (`design/FIELD-UPGRADES-2026-09.md:911-929`) |
| A PreToolUse deny, or UserPromptSubmit injection | Thrash, or speaks before any code exists |
| SARIF / Code Quality | Licence; no file locations; dismissals live outside the repo |
| Calendar dates on dispositions | A verdict would change with the day |
| Automatic extraction codemods | EM-Assist: 76% of LLM extraction suggestions were hallucinations without verification |
| Code bodies in any payload | They invite copying and injection |

## 9. Evidence trace

| Mechanism | Finding | Source |
|---|---|---|
| Debts, not context | RepoReuse: reuse drops even when the code is in the workspace; "a context system cuts slop only if it creates an obligation" | w1-ai-slop-evidence Q3 |
| Ratchets | 50.8% of chains duplicated by turn 5; erosion in 80% of runs; CodeThread −13.1% | w1-ai-slop-evidence §1 |
| Write-time delivery | Infer: 70% fixed at diff time vs ≈0% in batch; CodePlan "obligations" | w2-write-time §2; w1-design-quality-signals Q7 |
| Signatures, ≤3 items | Similar code adds noise, API info helps; >5 retrieved items interfere | w2-write-time §2 |
| Neutral packet, endorse/reject | Tufano anchoring; evidence-first prompting; OpenCodeReview's fixed dispatch plus checker | w1-design-quality-signals Q7; w1-agent-context-retrieval Q2 |
| Deterministic graph | AST graph 0.90 vs LLM graph 0.64 coverage | w1-agent-context-retrieval Q4 |
| α-hash, MinHash, parallels | SourcererCC ≈5% recall on moderate type-3; platform variation (Kapser & Godfrey); inconsistent clone changes cause faults (Juergens) | w1-clone-similarity-sota Q1, Q2, Q6 |
| Stack-aware families | `mapFailure` ≈ `mapPostgresError`; `asRowArray`; cursor codec; `deny_mutation` ×2 | w1-stack-anatomy §1, §3, §6 |
| Promotion ladder | Tricorder: effective false positives ≤10% | w2-write-time §2 |
| `wo`/`sc` ratchets | Gates may induce wrappers and split helpers | w1-ai-slop-evidence, item 9 |
| Recorder and scope | No advisory type exists; NOTEs vanish; classes A, B, C | w2-advisory-inventory §1, §4 |
| Issue rules and security | Search-API duplicates; close after 2 runs; sanitising | w2-issue-sync §1–3 |
| Embeddings as context | Retrieve, then confirm with structure (2608.04137); probe replay | w2-embeddings §2–3 |
| Justify via proposal | Two-place escapes; proposals stay inert until a human applies them | `tools/check-suppressions.mjs:27-33`; `installer/lib/proposals.mjs:1-21` |

## 10. Cost and latency budget

| Moment | Budget |
|---|---|
| `neighbours.mjs --plan` | ≤1 s warm |
| Scaffold | ≤300 ms extra |
| PostToolUse | p50 ≤150 ms, p95 ≤300 ms, deadline 1 s. For scale, the base hook measures ≈60 ms on a 444-line file. It runs in parallel with Biome and re-hashes candidates before showing them. |
| Author SubagentStart | ≤500 ms, cache only |
| Reviewer SubagentStart | ≤2 s of its 10 s, including the existing `reviewState` hashing |
| Stop: `owed` + `slop-ratchet` | ≤1.5 s warm on the scaffold (`duplication` takes 310 ms). Ceilings live in the factory's `chain-budget.json`. |
| CI `unit` lane | ≤20 s cold at 200k LOC |
| Nightly sync | ≤60 writes |

**Scaling to 200k LOC** (about 20k functions, 6–8 MB of source):
- **Cold run:** parsing takes about 3–6 s, or about 2 s across 4 `worker_threads`. MinHash adds 1–2 s.
- **Warm run:** only changed blobs are re-extracted, and merging takes under 0.5 s.
- **Candidate search:** LSH and α postings keep it near-linear.
- **Index size:** about 12 MB. It is sharded by package once it passes 50 MB.
- **First sweep:** expect 200–600 legacy keys, which baseline mode absorbs.
- **Embeddings:** about 10 MB of int8, searched in about 4 ms. Beyond 100k functions, switch to `usearch`.

## 11. Evaluation

**A. Deterministic families.** These tests are hermetic and run in CI, under `tests/gates/slop-corpus/`.
- **Seeded mutators:** inline function, paraphrase-rename, insert middle man, flag argument, unused optional parameter, duplicate client factory, revert k of N migrated sites, swallowing catch, SQL rail copy.
- **Tiers:** T1 lexical, T2 renamed, T3 edited, T4 cross-package, T5 decoy.
- **Controls:** every case has a **clean twin** and a **decoy**. The decoys are the design-system mirror, the transport twin, and a UTC vs local-time `formatDate`.
- **Pass bars:**
  - owed families: **zero false owed findings across 30 or more decoys**, and recall ≥0.95 on T1–T2;
  - ratchet families: precision ≥0.90, and recall ≥0.70 on T3.
- Each family registers a canary in `tests/canary/injections.json`.

**B. Dogfood corpus** (w1-stack-anatomy §5–6). The detectors must catch at least 10 of the 13 known items before they are fixed. Any item not caught is recorded as reviewer-only. Once the fix PRs land, the composite sweep must show 0 owed.

| # | Item | Family |
|---|---|---|
| 1 | Notes `mapPostgrestFailure` duplicating `mapPostgresError` | `rb` |
| 2 | `asRowArray` | `ca` |
| 3 | Push cursor codec | `ca` |
| 4 | Push `mapFailure` | `rb` |
| 5 | Re-grown push port | `c3` |
| 6–8 | `deny_mutation`, `ensure_partitions`, `drop_partitions_older_than`, each duplicated ×2 | `sq` |
| 9 | Mobile primitives duplicating `design-system-native` | `c3` |
| 10 | Divergent write-context copy | `ca` plus context |
| 11 | Port cast ×3 | fact census |
| 12 | Renderable title ×3 | advisory |
| 13 | Third port in `api/context.ts` | `sc` |

**C. Reviewer-eval** (`scripts/reviewer-eval.mjs`).
- **New kinds:** `KINDS` (`:72`) gains `helper`, `rail`, `sql-function` and `cross-surface`. Each kind has a BLOCK case and a PASS twin.
- **First architecture cases:**
  - BLOCK `rail`: the push vertical's `mapFailure`;
  - PASS twin: the same code, importing `mapPostgresError`;
  - decoys, expected to PASS: the design-system mirror and the transport twin.
- **New companion rows.** These restate rules; they do not make new ones (`scripts/lib/companion-table.mjs:12-13`):
  - architecture-reviewer: `reuse-existing-home` and `disposition-endorsed`, both enforced by `owed`;
  - torvalds-reviewer: `wrapper-of-one` and `superseded-symbol`, both enforced by `slop-ratchet`.
- **New field `mustCite`:** the reply must name the existing home's path. This needs a change to `scoreOne` (`:314`).
- **Arms:** A is today's `livePrompt` (`:389-400`). B is the same prompt plus the output of `check-slop --packet` on the applied tree. Each arm runs 5 repeats, scored by majority, with `claudeVersion` recorded.
- **Pass bars:**
  - B's BLOCK hit rate ≥0.80, and at least 0.30 above A on the new kinds;
  - B's PASS rate on decoys and twins ≥0.90, and no more than 0.05 below A;
  - `mustCite` ≥0.80.

**D. Generation A/B.** Run by developers, because no CI lane spawns Claude (Fact 5). RepoReuse-style: 12 five-turn chains over the demo plus a push vertical, OWED off versus on, 3 seeds. Bars:
- new keys at turn 5 **halved**;
- ratchet slope ≤0 with OWED on;
- decoy false reuse ≤10%;
- pass rate within 2 points;
- tokens no more than 15% higher.

**E. Field.** For each family, at least 50% of shown keys should be resolved by reuse or extract, and justify plus wontfix should stay at or below 30%. A family that misses either bar is demoted one rung.

## 12. Rollout (after `stack/52-i37-work-plan` merges)

| # | PR | Ships in |
|---|---|---|
| 0 | **Spike-0 probes**, recorded as `design/CONTROL-PLANE-FACTS.md` Facts 19–22: (a) does SubagentStart `additionalContext` reach the subagent; (b) can `updatedInput` on the Agent tool rewrite the prompt; (c) does a PostToolUse inside a subagent reach that subagent; (d) can a reviewer Read `.harness/packets`. Re-probe at every floor bump. | factory |
| 1 | `noteAdvisory`; `rampNote` routing; the Stop green line; `harness-status --advisories`; a factory ratchet on raw `NOTE —` prints | base |
| 2 | `gate-proposal` issues for `owed` and `slop-ratchet` | factory |
| 3 | `fact-index`, `slop-slots`, `neighbours.mjs`, the scaffold lines, the spec `## Reuse` section, corpus A. No verdicts yet. | base + factory |
| 4a–f | Dogfood fixes: rail mapper, `asRowArray`, cursor codec, port cast, write context, mobile primitives, and SQL deny functions (via a new migration). Seeded rows for the deliberate ones. | template |
| 5 | `dispositions.json`: ESCAPE_LISTS, PROPOSABLE, write guard, CODEOWNERS, docs-sync, `--propose` | base |
| 6 | `owed` step, with its stop floor, `unit` lane, canary, catalog entry, **ramp**, and AWAITING-HUMAN handling (plus its canary) | base |
| 7 | `posttool-owed.mjs`, the shown-ledger and telemetry | base |
| 8 | Packet; author brief (delivery path chosen by probes a and b); companion rows; `endorsements` (bump `LEDGER_FORMAT` if additive fields count as a format change) | base |
| 9 | Reviewer-eval kinds, cases, twins, decoys and `mustCite`; run arms A and B | factory |
| 10 | `slop-ratchet`, `slop-baseline.json` and the `--write` guard; **ramp**; runbook step "a human runs `--write`" | base |
| 11 | Per-lane advisory artifacts and `advisory-collect` | base |
| 12 | `advisory-issues`: the sync, golden tests, permission pin, canary, doctor staleness check | module |
| 13 | Factory `hygiene.yml` sync and the composite sweep | factory |
| 14 | `embeddings` and its evaluation | module |
| 15+ | Family promotions (each a gate-proposal plus a ramp); later, once Fact 5 is probed, an agent-fix module | base / module |

## 13. Risks and failure modes

- **Goodhart paraphrase below the thresholds:** L1b catches it, `c3` counts toward the ratchet, evaded pairs go in the packet, and decoy evals measure it.
- **Over-extraction:** the `wo` and `sc` ratchets push back, and legal moves prefer the lowest altitude.
- **Justify bottleneck:** this is intended. A family whose justify share exceeds 30% is demoted.
- **Probe failure:** fall back to the packet file and the author brief, with Stop as the authority.
- **Seeded roots:** extraction is fixed for fresh scaffolds only, and existing installs baseline it.
- **Absent parser:** a NOTE locally and a FAIL in CI.
- **Issue noise:** caps, the dashboard, baseline mode, and closing after two runs.
- **Injection through identifiers:** the id regex, and no reason is ever echoed.
- **Stale index:** candidates are re-hashed before they are shown.
- **False sense of safety:** only two steps enforce. Everything else is labelled.
- **Cost at scale:** sharding and worker threads, with the factory budget ceilings watching.

## 14. Open questions for the user

1. **Autonomy versus human apply.** Should CI accept a justification that a reviewer has endorsed without a human running `apply-proposal`, relying on CODEOWNERS on the PR instead? The design currently says no.
2. **Default for issue sync.** Should `init` offer `advisory-issues` as on by default, with a consent prompt, or should it stay strictly opt-in?
3. **Legacy debt.** When an existing codebase adopts OWED, should its legacy ratchet keys become issues, through baseline mode? Or should only new advisories?
4. **Boy-scout scope.** Should `owed` also cover legacy pairs whose existing side the diff edits? That is stricter and adds friction. Today only new subjects are owed.
5. **Embedding egress.** Is a hosted model acceptable once the training opt-out is in place, or should embeddings be local-only?
