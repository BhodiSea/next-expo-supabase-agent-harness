# Runbook: first run

From `init` to the first Claude Code turn that ends green. `init` prints the same steps when
it finishes.

## The steps

1. `git init`, unless the folder already is a repository. The `prepare` script
   (`lefthook install`) needs one.
2. `pnpm install`.
3. `git add -A && git commit -m "chore: scaffold"`. The first commit must include
   `pnpm-lock.yaml`: the shipped workflows run `pnpm install --frozen-lockfile`, which fails
   without it, and the `version-sync` gate reds an absent lockfile.
4. `pnpm db:up`, with Docker running. It runs `supabase start`, which downloads the Supabase
   images the first time and applies the migrations.
   [Local development](./local-development.md) lists what it starts. On Windows, also
   install the Supabase CLI on PATH, at the version `pnpm-workspace.yaml` pins. There the
   Stop hook's `rls-isolation` step never uses the copy in `node_modules/.bin`, so with none
   on PATH it fails closed, with `supabase CLI not installed`, even with the stack up.
5. `pnpm validate`.
6. Open Claude Code in this folder and ask for one small change. The turn ends when every
   gate, the RLS tests included, is green.

## What the first turn looks like

When the agent tries to end its turn, the Stop hook (`.claude/hooks/stop-validate-gate.mjs`)
runs the steps `STOP_HOOK_STEPS` lists in `tools/harness.config.mjs`: the `pnpm validate`
gates, the RLS tests (`rls-isolation`), both unit suites with coverage, and the checks after
them. While one is red, the hook sends the agent back to work with its output.
`pnpm validate` does not run the RLS tests, so a green `pnpm validate` does not mean the turn
can end.

### With the stack running

`rls-isolation` runs the pgTAP suite (`supabase test db`) and the supabase-js suite (vitest)
against the local database. On a clean scaffold every step is then green; the harness's own
CI checks that through the real hook, on Linux. What else the turn needs depends on the
change: `reviewer-verdicts` asks for a PASS from each reviewer that
`tools/reviewer-triggers.json` names for it, and `diff-coverage` holds every changed source
file under `apps/*/src` and `packages/*/src` to its runner's per-file coverage floors. Some
steps also print NOTE lines on a new scaffold: for files and registers that are still absent
or empty, and, in a repository with no upstream branch, that the reviewer ledger v2 did not
judge it. The hook shows you NOTE lines when a turn ends green.

### With no stack running

A new scaffold has migrations, so under the Stop hook `rls-isolation` fails closed. The
hook's message to the agent includes:

```
[rls] FAIL: the RLS surface exists but no running supabase stack (`pnpm db:up`), so cross-tenant isolation is UNPROVEN and the turn cannot end.
[rls] Fix: `pnpm db:up` (supabase start), then re-run.
```

Run by hand, as `pnpm test:rls`, the same runner prints `[rls] SKIPPED` and exits 0.

`pnpm db:up` is pre-approved in `.claude/settings.json`, so the agent can start the stack
without asking. With Docker running, the turn can still end green. Without Docker,
`supabase start` fails, and the hook sends the agent back each time it tries to stop. Claude
Code ends the turn anyway once its Stop hooks have done that eight times in a row with no
tool call in between (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, set in `.claude/settings.json`;
[hooks reference](https://code.claude.com/docs/en/hooks)), so the turn ends red. The harness
records that in `.harness/turn-outcomes.jsonl`. In the same session, the next turn that would
end green is sent back once, to say which gates the red turn left. In a new session no turn
is sent back for it, and the brief says
`last turn in this directory: ended red at the cap (rls-isolation)`.
