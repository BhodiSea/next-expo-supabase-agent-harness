---
description: Add a single tRPC procedure (+ optional web Server Action) on the right rung, returning ActionOutcome — then regen the contract inventories.
argument-hint: "[action-name]"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

Add the action **$1** — one tRPC procedure served by `apps/web` and consumed by mobile
`import type` only, optionally with its web Server Action twin.

## STEP 0 — do not duplicate a procedure that already exists

Read the contract surface BEFORE writing anything:

- the committed action inventory `tools/generated/action-inventory.json` — every procedure
  the composed `appRouter` exposes, as a dotted path (this is the generated surface the
  `contracts` gate holds the router to);
- the routers themselves, `packages/api/src/routers/*.ts`, and their composition in
  `packages/api/src/index.ts`;
- the DTOs in `@app/contracts` (`packages/contracts/src/index.ts`).

If an equivalent procedure already exists, STOP and report it — extend the existing one, do
not add a near-duplicate. Two procedures that mean the same thing are how the two surfaces
quietly fork.

## The procedure

Author it in `packages/api/src/routers/<vertical>.ts` (or `system.ts` for a non-vertical
concern like liveness or "who am I"), three lines or fewer — the router picks a RUNG, names
an input schema, and hands the call to the vertical. Business rules in a router are rules the
web app's Server Action cannot reach, and the moment one lands there the two surfaces have
forked (`packages/api/src/routers/notes.ts` is the worked example).

Pick the rung off the ladder in `packages/api/src/trpc.ts`:

- `publicProcedure` — behind the version-skew gate only.
- `authedProcedure` — throws `UNAUTHORIZED` if `ctx.actor` is null (the ONE sanctioned
  transport throw); narrows `ctx.actor` to non-null downstream. READS a signed-in user may
  perform go here.
- `orgProcedure` — membership is an AUTHORIZATION outcome, not a transport fact, so it
  rides the envelope: resolve it with the same two lines every write uses —
  `const gate = ctx.org; if (!gate.ok) return gate`. EVERY procedure rides this rung, READS
  INCLUDED: the acting org is WHICH DATA a read is about, not an extra permission on top.

THE ENVELOPE RULE. The procedure returns `ActionOutcome<T>` from `@app/errors` on the DATA
channel — `outcomeOk(...)` / `outcomeErr(appError.X())`. A domain failure is NEVER a thrown
`TRPCError`: throwing flattens the discriminated `AppError` the screens switch on into an HTTP
status. Only auth (`UNAUTHORIZED`) and version-skew (`CONFLICT`) bypass the envelope, and both
are transport facts the handler could not produce. Bound every wire value in the
`@app/contracts` schema (`.max()` on strings); `owner_id` / actor ids come from the VERIFIED
`ctx.actor`, never from the input.

Delegate the non-trivial half — the vertical data function the procedure calls (a read on the
`./client` barrel, a write on `.`, TAKING an RLS-scoped client and returning `ActionOutcome`,
keyset-paginated with an unconditional LIMIT, zod-parsed at exit, no app-side owner filter) —
to the `dal-author` subagent.

## The optional Server Action twin

If the WEB surface performs this write, add its twin in `apps/web/app/actions/*` — a
`next-safe-action` action sharing the SAME zod contract and the SAME vertical implementation,
folding the framework's three out-of-band channels back onto ONE `ActionOutcome` so a caller
reads one shape. Resolve identity with `getVerifiedUser()` (`getUser()` under the hood —
NEVER `getSession()` server-side) and refuse an anonymous caller on the data channel rather
than leaving it to surface as an opaque RLS denial. `apps/web/app/actions/notes.ts` is the
pattern. One operation, two callers — never a rule that lives in only one of them.

## Regenerate + verify

After ANY procedure (or event) change the committed inventories are stale — regenerate them
(the `contracts` gate regen-diffs `tools/generated/action-inventory.json` and reds on drift,
adding OR removing a procedure):

```
pnpm gen        # or the narrower `pnpm gen:contracts`
```

Then:

- run the `security-reviewer` (or `/rls-check`) if the procedure touches auth, membership, or
  a data function that reads/writes user rows;
- run the `web-security-reviewer` if a Server Action, the tRPC route handler, or service-role
  usage changed;
- carry `// SOURCE:` on every non-trivial decision, emit `/adr $1`, and run
  `/verify-citations` until `CITATIONS: CLEAN`.

Finish only when `pnpm validate` is green and `pnpm test` passes.

Current working tree: !`git diff --name-only HEAD`
