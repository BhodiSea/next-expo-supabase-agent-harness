# Review records

The reviewer subagents each end with a verdict line, and the SubagentStop hook keeps the
machine record of every verdict in `.harness/reviewer-ledger.jsonl`. Git ignores
`.harness/`, so that record never reaches history. This directory is where a change's
review does: what each reviewer found, and what was done about it.

## One record per change

A change's record is `docs/reviews/<YYYYMMDD>-<slice>.md`, with the same name as the change's
ADR (`docs/reviews/20260102-note-sharing.md` beside `docs/adr/20260102-note-sharing.md`). The
ADR's **Traceability** section links it.

Each dispatch of the owed reviewers is a round. Append each round as its own section, headed
`## Round <n> — YYYY-MM-DD`, with one table row per reviewer or command that ran in it:

```markdown
## Round 1 — 2026-01-02

| Reviewer | Verdict | Findings | Resolution |
| -------- | ------- | -------- | ---------- |
| security-reviewer | `VERDICT: BLOCK` | The UPDATE policy on `note_shares` has no `WITH CHECK`, so a member can move a share to another note. | Added a `WITH CHECK` that repeats the `USING` predicate. |
| torvalds-reviewer | `VERDICT: PASS` | none | — |
```

- **Reviewer:** the subagent that returned the verdict, or the command that ran it
  (`/rls-check`, `/verify-invariants`, `/verify-citations`).
- **Verdict:** the verdict line exactly as it was returned: `VERDICT: PASS`,
  `VERDICT: BLOCK` or `VERDICT: FAIL` from a reviewer subagent, `CITATIONS: CLEAN` or
  `CITATIONS: REJECTED` from `/verify-citations`, `RLS: PASS` or `RLS: FAIL` from
  `/rls-check`, and `INVARIANTS: PASS` or `INVARIANTS: FAIL` from `/verify-invariants`.
- **Findings:** each finding as the reviewer reported it, with the file it names, or `none`.
  Separate several findings in one cell with `<br>`.
- **Resolution:** for each finding, the fix that answered it (what changed, and where), or
  why it was declined.

Commit a round in the same change as its resolution, so a finding never lands in history
ahead of its fix.

## The record is part of the diff

No path in the `reviewers` list of `tools/reviewer-triggers.json` matches `docs/**`, so
writing a record leaves every path-triggered reviewer's verdict standing. Keep it that way:
a trigger path that matched `docs/reviews/` would send that reviewer's verdict stale the
moment its round was recorded.

The `wholeTurn` class of the same file, where your table has one (`torvalds-reviewer` and
`citation-verifier` as shipped), is different by design. Its reviewers are owed on every
non-empty diff, and each PASS binds to the whole diff, this record included. A round written
after that PASS sends it stale, and the `reviewer-verdicts` Stop step asks for the reviewer
again. So end a change in this order:

1. Run rounds until one comes back with no finding standing, and write every round, that
   last one included.
2. Then run the `wholeTurn` reviewers once more, over the diff that now holds the record.
   The record is the only change they have not seen, so their PASS confirms the last round
   rather than opening a new one. Do not add it to the record, or it goes stale again; the
   ledger keeps it. A finding from this run opens a new round: resolve it, record it, and
   repeat this step.

## What a record is not

- **Not the decision.** Decisions, and the reasons for them, go in the ADR. A record says what
  the reviewers found and what was done; when a finding changes a decision, the ADR says so,
  and the record's Resolution points at it.
- **Never an `-- adr:` target.** A destructive migration's `-- adr:` line names the ADR in
  `docs/adr/`. The `migrations` gate checks only that the named file exists, so it would accept
  a record too; this rule is yours to keep.
- **Read by no gate.** No check in the chain, the Stop hook or CI judges what a record says,
  so a missing or malformed record turns nothing red. (A record in the diff still moves the
  `wholeTurn` digest, like any other changed file; see above.) A record is not an ADR to
  `adr-guard` either, which looks for a change under `docs/adr/`.
