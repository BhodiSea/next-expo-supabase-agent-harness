// WHAT COUNTS AS "the agent surface" — the directories whose contents are instructions
// the coding agent runs under, rather than code it writes.
//
// It lives in its own module for a reason worth stating: both the generator that hashes
// this surface (tools/gen-agents-lock.mjs) and the gate that judges it
// (tools/check-prompts-lock.mjs) need the same list, and neither may import the other. A
// gate that imported the generator would drag the generator — and everything IT imports —
// into every fixture that spawns the gate; a generator that imported the gate would be
// backwards. Two hand-kept copies is the third option, and the day they disagree is the
// day a whole directory is locked by one and unjudged by the other.
//
// `.claude/rules/` is deliberately ABSENT: it is covered by gate-integrity's hash of the
// installed manifest instead, because unlike the three below it is `owned` content the
// installer re-records on update.
// SOURCE: docs/harness/README.md (prompt/agent lock discipline) [corpus: harness/doctrine]
export const AGENT_SURFACE = ['.claude/agents', '.claude/commands', '.claude/skills']
