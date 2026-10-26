---
name: designing-mobile-ui
description: >
  The design doctrine for the mobile app: typography roles, spacing rhythm,
  motion tokens, state choreography, and per-surface "default beautiful"
  checklists. Use when building or restyling any screen, component, list,
  form, modal, or interaction — BEFORE composing the JSX.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
argument-hint: "[surface-type]"
---

# Designing mobile UI

The gates make bad UI hard (tokens-only color, primitives-only controls,
registered states, computed contrast, the motion seam, the 44dp floor). This
skill is the other half: what makes the UI *good* — the choices inside the
fence. Work the procedure in order; read each reference lazily, only when its
step arrives.

1. **Classify the surface** — list screen, form, modal/sheet, detail, empty
   state, or settings — and open its checklist in
   `references/surface-checklists.md`. Build TO the checklist, not toward it
   afterwards.
2. **Foundations before pixels** — read `references/foundations.md` before
   choosing any type size, weight, spacing multiple, radius, or accent moment.
   Every one of those is a role decision, not a taste decision.
3. **Choreograph the data states** — read `references/state-choreography.md`.
   Every route registers `states.{loading,empty,error}` testIDs in
   `src/routes.ts`; this reference is HOW each state should behave, not just
   exist: skeleton→content without layout shift, empty states that propose the
   next action, errors that keep their retry.
4. **Motion last, tokens only** — read `references/motion.md`. Animation goes
   through the seam (`src/lib/motion.ts`) over the `motion` tokens,
   transform/opacity only, reduce-motion collapse built in. If a transition
   needs a value the tokens don't carry, that is a manifest conversation, not
   a literal.
5. **Self-check, then review** — walk the surface checklist once against the
   real diff, then run the `design-reviewer` subagent and address its findings
   until it answers `PASS`. (The `accessibility-reviewer` owns WCAG; the
   design reviewer owns taste and choreography — run both on UI diffs.)

Enforcement honesty: this skill is positive doctrine — advisory by design. The
deterministic floor is exactly the gates named above plus the e2e states sweep;
nothing here claims a check that does not exist. When doctrine and a gate ever
disagree, the gate wins and the doctrine gets fixed.
