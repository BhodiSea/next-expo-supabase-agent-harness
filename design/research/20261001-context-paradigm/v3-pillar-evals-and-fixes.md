# v3: the staged eval ladder (B4) and open items N1–N4

*This document replaces three parts of PLAN v2: §10 "Eval cost", the run sizes and statistics in §11 C/D, and Appendix C's notes N1–N4. It also refines two points in `v3-pillar-reviewer-packet.md`: its §5 N3 rule and the corpus behind its §10 pilot rule. Paths are relative to stack head b158f5a. "Measured" means an inline Node 22.22 script using the factory's `typescript@6.0.3`, committed nowhere.*

## 0. Decisions

1. **Order and location.** Rungs run cheapest first: probes → A → B → C0 → C → L → D → E. Deterministic rungs run in factory CI on every PR. Model-spending rungs run on demand on the maintainer's machine, under the existing `--live` doctrine (`scripts/reviewer-eval.mjs:50-55`).
2. **What gates the exact rule (PR 8):** A (holdout), B, L and D arm 2. D arm 3 gates the write-time pointer (PR 9). Gate-tier checks from pillar B2 need A and B as well. Eval C never decides whether the packet exists; only its displacement falsifier can turn it off.
3. **C and D start as one-seed pilots.** Each pilot is judged against a pre-registered three-zone band (§1.4). Only an ambiguous pilot scales up to full power.
4. **D's arms are sequenced** to the PRs they gate. Arm 3 reuses the arm-2 runs as long as the recorded posture is unchanged.
5. **N2 is owed.** PR 7a replaces the two constructors with one constructor per payload shape. The normaliser also gains shorthand expansion, which removes a false cross-vertical class.
6. **N4:** `PATH_RE` now admits `()[]`, with segment rules. This also fixes a defect in today's SessionStart brief.
7. **N1:** `gate-integrity` already reds any census edit, because the census file is `owned`. A guard row is added anyway, so the edit is denied at the moment it is made.
8. **N3:** case labels print as names. Constants are resolved to their values only to align arms, and values are never printed.

## 1. B4: the staged eval ladder

### 1.1 Rungs

| Rung | Purpose and inputs | Runs, compute, tokens | Maintainer time | Where | Gates |
|---|---|---|---|---|---|
| **0 Probes** (a)–(f) | Channels and the headless posture; each probe records its minimum CC version | About 20 `claude -p` runs; under 1 h; ≤ 2M tokens | 1 h | on demand; re-run when the CC floor moves | (d) → L, D; (f) → PR 10 |
| **A Detector** | Freezes FLOOR, the token convention and the near-miss thresholds. Inputs: about 40 helpers × 7 scripted mutators; v2's decoys plus N2's two; 5 plantings and 5 decoys per gate-tier B2 check. Split: 70% dev; holdout = 30% plus a blind third vertical | Deterministic, under 10 s. The blind vertical is one agent session (3–6M tokens), then frozen | about 1.5 days (agent-drafted); 1 h at holdout | factory CI | Dev split → gate-proposal values (PR 1/4). Holdout → PR 8 and each gate-tier B2 check |
| **B All-hits precision** | Every hit on the frozen pre-dogfood fixture: duplication (all tiers), B2 checks, and B3 facts with every callable as a seed. Labels go in `tests/evals/b/labels.json`, keyed by finding key; **an unlabelled key fails the test**. Coverage is reported per pillar | Deterministic, under 10 s | about 1 day to start. A family with more than 50 hits is labelled on a stratified sample of 50 | factory CI | PR 8: owed 1.0, advisory ≥ 0.8. B2 gate tier: 1.0. A family graduating to issues: ≥ 46 of 50 (0.92; Wilson lower bound 0.81) |
| **C0 Packet rank** (new) | For each C second-home case, the shipped `buildPacket()` ranks the oracle item within the cap. Control-case items are true facts | Deterministic, seconds | — | factory CI | Tunes ranking with no model calls |
| **C Packet** | The displacement falsifier, then tuning (§1.5) | Pilot: 124 runs, under 1 h at 8 parallel, 8–15M input and 0.4M output tokens. Ablation: +186 runs, 12–22M input. Full power (only if ambiguous): +1,116 runs, about 7 h at 8 parallel, 70–135M input | about 1.5 days to review 62 drafted cases; 2 h per look | on demand | PR 10 ships live unless the pilot is OFF; PR 10b |
| **L Lift** | v2's 40 sessions (4 scenarios × 10 seeds). **Curtailed** at the 5th failure within the cap, or at the 13th Lift needing more than 2 blocks: either bar is then lost | 15–25 min per session; 3–5 h at 4 parallel. Totals: 80–160M input (≥ 90% cache reads), 1–2.5M output | 2 h | on demand | PR 8 (PR 6: a 4-session dry run) |
| **D Generation** | v2's design, with the arms sequenced | Pilot, arms 1 and 2: 200 turns at 6–10 min, so about 8 h at 4 parallel; 100–400M input, 2–5M output. Full power: +400 turns (two nights), +200–800M input. Arm 3: 100-turn pilot; +200 turns at full power | 1 day per look | on demand | Arm 2 → PR 8; arm 3 → PR 9 |
| **E Field** | v2, unchanged | — | 1 h a month | consumers | release decisions |
| **X Embeddings** (optional) | The v2 §6 prototype, after B | 1–3M embedding tokens | 1.5 h | on demand | §6 bars |

**Token basis.**
- A Claude Code turn re-sends its context on every model call. A 40–100k context over 10–30 calls is 0.5–2M input tokens per turn, of which at least 90% are cache reads.
- v2's "10⁸" for D implies about 10⁵ tokens per turn, so it omits cache reads.
- No prices are given here. Multiply by the account's rates.

**Boundary audit (part of A's dev split).** Two independent normalisers disagree by one token on both deliberate mirrors next to FLOOR:

| Mirror | Mine | v2 |
|---|---|---|
| `useTheme` | 30 | 29 |
| `invalidExportCursor` / `invalidCursor` | 29 | 28 |

So the token convention is frozen together with FLOOR, inside the extractor digest. The gate-proposal lists every fixture class within ±3 tokens of FLOOR, each with its label.

### 1.2 Pilot design (one seed)

- **Paired.** Every arm runs the same cases or chains, with the same rotation seed, model pin, CC version and fixture digest.
- **Pre-registered.** The band table, the metrics and the analysis-script digest go in `tests/evals/<eval>/prereg.json`, committed before seed 1. The result record cites its hash.
- **Shakedown.** If more than 5% of runs fail for infrastructure reasons (install, timeout or rate limit), fix the harness and re-run. Those runs are discarded.
- **Seed 1 is the pilot.** Full power adds seeds, and the final analysis uses all of them. Bootstraps use 2,000 resamples, clustered by case (C) or by chain (D).
- **D's oracle sample.** The pilot gets blind human labels on 20% of chain-runs. If the execution oracle agrees with those labels on at least 90% of functions, full power labels only 10%.

### 1.3 What runs where

- **Factory CI** (the `selftest.yml` `node --test` run, plus the `lint.yml` machinery block):
  - A, B and C0;
  - `reviewer-eval.mjs --check`;
  - the packet goldens, purity and verdict-isolation tests;
  - the B2 plantings;
  - the record check below.
- **On demand, on the maintainer's machine:** probes, C, L, D and X. These spend model calls, need credentials and refuse to run under the test runner.
- **Never:** scheduled model spend, or any eval in a consumer's CI.
- **Records.** Each eval writes `tests/evals/<eval>/<date>.json`, holding the posture plus the digests of its inputs (extractor, fixture, `agents.lock.json`, `review-packet.mjs`, `PACKET_FAMILIES`, prereg).
  - A *gating* record (A, B, L or D) whose digests no longer match is red in `lint.yml`, but only in a release that ships the tier it gates.
  - A stale C record is a NOTE.
  - Each gated tier gets one `kind: release` row in `scripts/obligations.json` that cites its records as `evidence`. For example, `single-home-exact-golive` targets 2.1.0.

### 1.4 The pilot-to-full-power rule

**D, arm 2 vs arm 1.** The pilot is GO if every row is in its GO column, and NO-GO if any row is in its NO-GO column. Otherwise it is ambiguous, and seeds 2–3 run.

| Metric | Margin | Pilot GO | Pilot NO-GO |
|---|---|---|---|
| Pass rate per turn | −10 points | One-sided 97.5% lower bound > −10 | Δ̂ ≤ −10 **and** 95% upper bound < 0 |
| Tokens per turn (ratio) | +15% | 97.5% upper bound < +15% | Δ̂ ≥ +15% **and** 95% lower bound > 0 |
| Induced slop per chain (single-consumer shared exports, wrappers-of-one) | +0.10 | 97.5% upper bound < +0.10 | Δ̂ ≥ +0.10 **and** 95% lower bound > 0 |
| Degradation (arm 2's discharges) | 10% | At least 10 discharges with at most 1 degraded | At least 4 degraded **and** at least 20% |
| Cap-hit (owed-red turns ending at the cap) | 5% | At most 1 turn | At least 3 turns |

- **Full power** applies v2's tests at one-sided α = 0.025 over all 3 seeds. Two looks at 0.025 each keep the false-GO rate at the margin at or below 0.05 (Bonferroni).
- **Degradation and cap-hit are count screens only.** About 15 discharges cannot bound a 10% rate. Their real guards are v2's pre-committed graduation and E's cap-hit trigger.
- **Honest expectation.** With no true effect, the pilot reaches GO perhaps one time in four or five. Expected cost is about 2.6 seeds instead of 3. The pilot's value is the NO-GO screen and a shakedown before 400 more turns.
- **Arm 3 vs arm 2** uses the same rows, plus v2's superiority bar: owed-attributable Stop blocks down by at least 30%.
  - GO: Δ̂ ≥ 30% and the 97.5% lower bound > 0.
  - NO-GO: Δ̂ ≤ 0.
- **On NO-GO,** the PR does not ship. The failing row names what to fix (floor, moves or Lift). Re-pilot under a new prereg.

**C, packet ON vs OFF: the displacement falsifier.** Counts are net, over paired discordant cases.

| Metric | n at pilot | KEEP | OFF |
|---|---|---|---|
| **D1** control-finding recall: 16 control cases + 16 *within-case* second findings + 2 existing torvalds cases | 34 | Net lost ≤ 1 | Net lost ≥ 4 **and** one-sided exact sign test p ≤ 0.07 |
| **D2** false BLOCK on PASS-expected cases: 8 twins, 8 decoys, 6 justified complexity cases | 22 | Net new ≤ 0 | Net new ≥ 4 **and** p ≤ 0.07 |

- **Ambiguous → 10 seeds.** At full power, the falsifier trips when the case-clustered one-sided test rejects "no displacement" at α = 0.05 **and** the point estimate exceeds **5 points**. The design SE is about 3–4 points. That gives about a 5% false-trip rate with no harm, and about 85% power at an 8-point harm.
- **OFF** follows the sibling's sequence:
  1. re-pilot at a cap of 3, then at a cap of 1;
  2. if ≥ 80% of excess false BLOCKs cite one family's `(packet <key>)`, retire that family only;
  3. otherwise write `none (disabled)` and keep `changes.md`.

**Within-case second findings** (a refinement of the sibling's corpus). Each of the 16 second-home BLOCK cases also omits one unrelated companion-row item (a test or an i18n key) that the reviewer must name.
- This measures displacement inside the same review, where the packet actually competes for attention.
- It raises D1's n from 18 to 34 at no extra runs.
- Scoring is per finding (`mustName`/`mustCite`), not per verdict.

### 1.5 Eval C: the live packet as a tuning eval

- **Arms:** OFF (`packet.md` reads `none (eval-off)`) and ON (cap 5). Both use the same v3 body. v2's push and diff-only arms, and their 5,500 runs, are gone (B1).
- **After KEEP, tuning lands at PR 10b** in `PACKET_FAMILIES` or the cap constant:
  - **Size.** Run caps {1, 3, 8} at one seed. Pick the *smallest* cap whose second-home `mustCite` recall is within one case of the best, and whose D1/D2 counts are not in the OFF zone.
  - **Ranking.** C0 tunes it in CI.
  - **Families.** The sibling's §9 triggers decide, using the pilot's confirm/dismiss answers and field telemetry.
- **Re-runs.** Any change to a reviewer body, the packet format, the caps or a recipe triggers a one-seed re-run under the same bands.

### 1.6 One maintainer's calendar

| Week | Hands-on | Unattended |
|---|---|---|
| 1 | Probes (1 h); A corpus and dev labels (1.5 days) | — |
| 2 | B labels (1 day); C case review (1.5 days) | The blind third vertical |
| 3 | A holdout (1 h); review of C and L (4 h) | C pilot (1 h); L (one evening) |
| 4 | D labels and analysis (1 day) | D arms 1 and 2 pilot (one night) |
| 5–6 | Only if ambiguous: D full power (1 day) | Two nights |
| Before PR 9 and 10b | D arm 3 (½ day); C ablation (2 h) | One night |

- **Total:** 7–9 maintainer-days over 5–6 weeks, plus 3–6 overnight runs and 1 h a month.
- **Hardware:** one 32 GB workstation with Docker.
  - D and L run 4 installs in parallel, because `rls-isolation` needs a local Supabase per install.
  - C runs 8 in parallel: with hooks off, it needs no Supabase.
  - Both are subject to the account's rate limits.

## 2. Open items

### N2: `noteCreated` / `noteDeleted` is owed

**Verified.**
- `D/packages/verticals/notes/src/events.ts:109,134` differ only in the event-name literal.
- Under v2's convention the class is 44 tokens.
- Literal density is 1/44 = 0.023 (the threshold is > 0.5). RNR is 0.98 on the alpha stream and 0.77 with identifiers collapsed, CCFinder-style (the threshold is < 0.5). **The data-shaped filter does not drop it.**
- Callers are `src/data/notes.ts:451,523`, plus the re-export at `src/index.ts:65`. No test names either function.

**The slot expectation.** `w1-stack-anatomy.md` reads this as "a missing generic factory". The factory belongs at MODULE altitude: one constructor per *payload shape*, keyed by the wire name. A platform factory in `@app/events` would need a computed id key. That breaks the plain-payload rule (`events.ts:14-17`) and the rule that declarations live in the vertical (`:6-10`).

**Decision: owed (MODULE, one literal parameter). No idiom carve-out.**
- Decision A1 is one rule with no special cases.
- The fact "a base event carries exactly the four base identifiers" is stated twice.
- Every vertical copies the worked example. Fixing the example first stops the same pair from red-ing in every new vertical's `events.ts`.
- The fix is type-checked. Measured with tsc: the constructor below compiles, and `'notes.updated'` is rejected.

**PR 7a:**
```ts
export function noteBaseEvent(
  name: 'notes.created' | 'notes.deleted',
  origin: EventOrigin, noteId: string, occurredAt: string,
): NoteEvent {
  return { name, payload: { actorId: origin.actorId, noteId, occurredAt, orgId: origin.orgId } }
}
```

- Callers pass the name. `noteUpdated` stays separate, because its payload shape differs.
- **Rejected:** thin wrappers such as `noteCreated = (…) => noteBaseEvent('notes.created', …)`. They recreate a 28-token tag-only pair, which is exactly the gate-induced helper splitting that B3 exposes.
- `dal-dto.md:20-23` and the scaffold's `events.ts` stub each gain one sentence: "one constructor per payload shape; events that share a payload share a constructor keyed by the wire name."

**Normaliser fix (found while checking).** Shorthand properties and shorthand binding elements expand to `key : $n` before hashing.
- **Without it,** a second vertical's `taskCreated(origin, taskId, occurredAt)` hashes equal to `noteCreated` (measured: alpha `98052e40c2a7` for both). That is a false *cross-vertical* owed class, and its LIFT would emit the wrong payload key.
- **With it,** the two hashes differ, and the class counts on the default, demo and push trees are unchanged. `noteCreated` grows to 48 tokens.

**Consequences.**
- Dogfood gains row #23: the blocking rule now catches 7 of 16 second homes.
- The floor table's demo columns read 7 / 5 / 3 / 1 / 0, and the demo + push columns 11 / 9 / 6 / 4 / 2.
- Eval B's "owed set empty after PR 7" now holds.
- Eval A gains a same-file tag-only twin planting (owed).
- Eval A gains a decoy: another vertical's constructor with a different id key (silent).

### N4: `PATH_RE` is widened and stays closed

**Verified.**
- `T/tools/lib/harness-brief.mjs:52` rejects 22 of the 697 template files: 19 under `apps/web/app` route groups or dynamic segments, and 3 under `apps/mobile/app/(tabs)/`.
- **It is a live defect.** `reviewerLines` (`:129`) prints the summoning path (`path: o.because`, `:310`). So the SessionStart brief and `harness-status` print `(unprintable)` whenever such a file summons a reviewer.

**Decision.** `closed-text.mjs` exports one path printer, and `harness-brief.mjs` imports it. The printer:
- matches `^[A-Za-z0-9._@+/()\[\]-]{1,160}$`;
- rejects empty, `.` and `..` *segments*, which also rejects absolute and `//` paths;
- rejects any segment that starts with `-`;
- still allows `..` *inside* a segment, as in Next's `(..)photo`, `[...slug]` and `[[...slug]]`.

Measured: it rejects 0 of the 697 files, and the longest is 67 characters.

**Why it is still closed.**
- `()[]` cannot break a code span or carry an instruction.
- Backtick, whitespace, `:`, `<`, `\` and control characters stay excluded, so no URL scheme can form.
- New surfaces print paths only inside code spans.

**Golden test.**
- Must print: the 22 paths and Next's special segments.
- Must refuse: a backtick, a space, `:`, `\`, a newline, a `..` segment, a leading `-`, and 161 characters.

### N1: the census gets a guard row

**Verified.** v2 was right that no `WRITE_PROTECTED` row, `ESCAPE_LISTS` entry or `PROPOSABLE` entry covers `tools/exports-walls.json`. It missed the control that actually decides:
- The census is manifest-mode **`owned`**: it is in neither `SEEDED_FILES` nor `CONFIG_FILES` (`installer/lib/layout.mjs:112,319`; `tests/gates/check-released-shas.test.mjs:103`).
- `gate-integrity` hashes every owned file under `^tools\/` (`check-gate-integrity.mjs:44-50,199-222`). It runs inside Stop's `validate --report-all` (`T/tools/harness.config.mjs:18`) and in CI.
- Keeping an edited owned file requires re-recording its sha in `.harness/manifest.json`. Agents are denied that write three ways: the settings deny, the `harness-dir` row and the bash guard's `PROT_DIRS`.

So an agent can write the bytes, but a forged census can never be on a green tree.

**What remains.**
- The act itself is not denied, so the turn burns a Stop block.
- In that same run, `homes.mjs` reads the forged census and may print LIFT.
- The red says "tampered or hand-edited" without naming the human path.

A forged census can only turn NONE into owed, never silence a class, so `homes.mjs` needs no special case.

**Decision.** Add `{ id: 'exports-walls-census', re: /^tools\/exports-walls\.json$/ }` beside `modules-register` (`guard-rules.mjs:582`).
- The rationale is the same as `modules-register`'s: an owned file that a gate reads and no agent may author.
- It gets a non-vacuous hook-contract case, since the file ships in every install.
- Its message names the human path: an edit under `{{SECURITY_OWNERS}}` review, plus a re-recorded fork.

PLAN §2.3 now reads: "only a human census fork (an edit plus a re-recorded manifest sha) or a factory release could admit it."

### N3: print names, align on values

**Verified.**
- Every case label in both mappers is a file-local `const` of 13–27 characters bound to a literal: `S/packages/platform/supabase/src/errors.ts:71-101` (12 labels) and `D/…/notes/src/data/errors.ts:36-40` (6 labels).
- The 12-character label printer turns all 18 into `#n`.

**Decision** (this refines the sibling's "constants are never resolved").
- **Identifier labels** print through the symbol printer (`^[A-Za-z_]\w{0,63}$`).
- **Alignment by value.** When a label is a file-local `const` initialised with a string or number literal, arms are aligned on that *value*. The value is only compared, as `lit` is only hashed, and it is **never printed**. All other labels align by name.
- **Different names for one value** print both names (`A`/`B`). Otherwise the fact would claim false A-only and B-only arms (`false-fact`).
- **Literal labels** keep the `^[A-Za-z0-9_]{1,12}$` printer. SQLSTATEs are 5 characters and PostgREST codes 8.
- **Counting.** Arms are counted both as labels and as case groups.
- **"Same"** means the same callee text.

**v2's example, corrected against the tree:**
```
DIFFERS AT  case `FOREIGN_KEY_VIOLATION`: `appError.conflict` | `appError.validation` · case `CHECK_VIOLATION`: same pair · case `PGRST_NO_ROWS`: `missingNote` | `readMiss`
B ONLY      6 labels in 4 case groups
```

After PR 7a, notes wraps `mapPostgresError`, so this pair leaves the live tree. It stays as the canonical near-miss in B's frozen fixture and as a C BLOCK case.

## 3. Deltas against PLAN v2

- **§2.2:** add shorthand expansion; the token convention joins the extractor digest.
- **§2.3:** the corrected census sentence and the guard row.
- **§2.4 and the Dogfood inventory:** the corrected floor table, row #23 and coverage of 7 of 16.
- **§3:** the N3 and N4 printers.
- **§10:** replaced by §1.1.
- **§11:**
  - A and B are extended to B2, B3, N2's decoys and the boundary audit.
  - C0 is new.
  - C and D follow §1.4.
- **§12:**
  - PR 5 adds the prereg files and the record check.
  - PR 7a adds `events.ts`.
  - PR 8 cites the records for A, B, L and D arm 2 through an obligations row.
  - PR 9 cites D arm 3.
  - PR 10 is held by probe (f) and by a C pilot that is not OFF.
  - PR 10b is the tuning release.

## 4. Defects in today's tree found while checking

These are candidates for the issue filing. I verified each by reading the code, not by running it on an install.

1. **The brief prints `(unprintable)` for app-router paths.** See N4: `harness-brief.mjs:52,68,129`, affecting 22 template paths.
2. **A consumer's own vertical cannot reach green without a human census fork, and nothing tells the author.**
   - The dual-barrel law requires `./client` (`T/tools/lib/vertical-anatomy.mjs:158-170`).
   - Any `./client` without a census entry reds (`T/tools/check-exports-walls.mjs:153-158`).
   - The census is owned and hashed (N1).
   - `SKILL.md:68-70` frames the census as a Class-A opt-in, and the scaffold's next steps omit it.
3. **The scaffold writes no vertical manifest.** `scaffold-slice.mjs` writes no `packages/verticals/<slice>/package.json` or `tsconfig.json` (its file list is at `:36-149`). The dual-barrel law therefore reds a fresh scaffold (`vertical-anatomy.mjs:144-155`). This extends Dogfood #21.
