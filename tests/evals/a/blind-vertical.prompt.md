# Eval A: the blind-vertical prompt

This file is the committed prompt for eval A's three blind verticals (#188, #194). The
maintainer runs it; nothing in CI does. Each run writes one vertical, which
`scripts/eval-a-freeze-vertical.mjs --from <install> --n <k>` freezes into
`tests/evals/a/holdout/vertical-<k>/`.

## How to run it

1. In a scratch directory, make a fresh install from this repository at the commit the
   development run used:
   `node installer/cli.mjs init --dir <scratch> --tier core --with-demo --yes`.
   The demo is there on purpose: the notes vertical is what an agent copies from.
2. Start Claude Code in `<scratch>` with no access to this repository, no memory and no
   extra instructions. The agent sees the install's own files and its shipped skills,
   `authoring-vertical-slice` included, and nothing else. It must not see the Single Home
   plan, the duplication gate's catalog entry, `tools/lib/sweep.mjs` or this eval's files.
3. Send the prompt below, with `<k>`'s feature from the table.
4. When the turn ends, run the freeze script on `<scratch>`, then record the run (model,
   Claude Code version, tokens, the install commit) in #194.

| k | Feature | Why this one |
|---|---|---|
| 1 | `bookmarks`: an org member saves a URL with a title and an optional note, lists the org's bookmarks newest first with a cursor, and deletes their own | closest to notes, so the copy pressure is highest |
| 2 | `tasks`: an org member creates a task with a title and a due date, marks it done, and lists open tasks; an event on create and on done | events and a state change |
| 3 | `comments`: an org member comments on a note, edits their own comment within 15 minutes, and lists a note's comments oldest first | a vertical that reads another vertical's id |

## The prompt

> Add a `<feature>` feature to this project as a new vertical slice, end to end: the
> database table with its policies, the domain and data layers in
> `packages/verticals/<feature>`, the tRPC procedures, the web screen and the mobile
> screen, and their tests. Follow the project's own skills and conventions, and leave
> `pnpm validate` green.
>
> The feature: <the Feature cell of the table, verbatim>.
