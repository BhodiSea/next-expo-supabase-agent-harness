# Data subject requests — the procedure the schema cannot perform

`docs/adr/20260201-org-scoped-tenancy.md` records the fact this runbook exists for:

> DSR completeness is now procedure-backed, not schema-backed… residual rows can no
> longer be enumerated back to the subject.

Before the org re-scope, "delete user X" and "what belongs to X" were the same query: every
`owner_id` hung off one root and removing the `auth.users` row cascaded the lot. After it,
the data controller for a note is the **organization**, so the cascade deliberately stops —
and what stops with it is the ability to answer an erasure request by running one statement.

`tools/data-flow.json` is the reviewed inventory of exactly what survives and why;
`tools/check-data-flow.mjs` reds when the schema grows a surviving row nobody reviewed. This
file is the other half: what a human does when a request arrives.

**This runbook is a starting point, not legal advice.** Your controller/processor
relationships, retention obligations and lawful bases are yours. What the harness guarantees
is that the *inventory* is complete and current — no column carrying personal data survives a
deletion without appearing in `tools/data-flow.json` with a written reason.

## What the account-deletion path already does

A user deleting their own account (mobile: the `session.deleteAccount` command; the
`delete-account` Edge Function behind it) performs, in this order:

1. **Sweeps the caller's personal org** — a single-seat organization nobody else can join.
   Deleting it cascades its memberships, invitations and notes.
2. **Verifies the sweep** — error *and* row count. Any mismatch returns 500 and
   **`deleteUser` is not called.**
3. **Deletes the `auth.users` row**, which cascades `public.profiles` and every
   `public.memberships` seat.

The order is load-bearing and the reason is worth knowing before you touch this path:
`public.orgs.created_by` is `ON DELETE SET NULL`, so deleting the identity first would null
the very column the sweep filters on. The personal org would become permanently unsweepable
and — with the auth user gone — unauthenticatable, so no retry could even begin. One
misordering is not a retryable failure; it is unrecoverable orphaned tenant data.

## What it does NOT do, and what you do instead

Run `node tools/check-data-flow.mjs` for the current list. As shipped:

| What survives | Why | What the procedure is |
|---|---|---|
| `notes` rows in a **team** org (`title`, `body`, and the now-NULL `owner_id`) | The org is the data controller. An employee leaving must not delete the company's content. | Erasure: refer the subject to the **org**, which is the controller for that content. If you are the controller (B2C, or the org is defunct), delete by `org_id` with a reviewed one-off migration. |
| `orgs.created_by` → NULL, `invitations.invited_by` → NULL | Attribution, not ownership. The workspace and its pending seats outlive their creator. | Nothing further — the link is already severed, which is the erasure. |
| `invitations.email` for a **pending** invitation | The invitee may have no account at all, so there is no `auth.users` row to delete and no foreign key that could reach it. Nothing reaps expired rows. | Delete by `(org_id, email)`. This is the one request that can arrive from someone who has never used the product. |
| `orgs.slug` of a personal org, **only after a failed sweep** | The slug embeds the subject's own auth id (`personal-<uid>`). Normally unreachable because the sweep runs first and is verified. | If a 500 was returned by `delete-account`, the org still exists and `created_by` is intact — **retry the deletion**. Do not delete the auth user by hand first. |
| `audit.events.actor_id` and the rest of the trail | A trail that deletes its own evidence is not a trail. GDPR Art. 17(3) covers this: retention for legal claims and for the controller's own security obligations. | **Do not delete audit rows to satisfy a request.** The bound on this data is the retention window: `audit.drop_partitions_older_than()` removes whole monthly partitions. Record the request and the refusal, and tell the subject the window. |

## Answering a portability request (Art. 20)

`tools/data-flow.json` `export.projection` is the reviewed answer to "what is my data", and
the gate closes it against the schema in both directions — a projected column no migration
creates reds, and a subject-data table that is neither projected nor excluded reds.

**There is no delivered export surface yet** (`export.surface.kind` is `"none"`, with a
`target`). Until there is, run the projection by hand as the subject's own role — every
projected row is readable under their policies, so no elevated credential is involved, and
that is deliberate: an export that needs `service_role` is an export that can return somebody
else's rows if the filter is wrong.

The exclusions are as much a part of the answer as the projection, and each carries its
reason in the same file. The one worth understanding: an **audit trail is data the controller
*observed*, not data the subject *provided***, and Art. 20 covers the latter. That is the
distinction the exclusion rests on — not convenience.

## When you change the schema

Adding a table that carries personal data puts you in exactly one of four states, and the
gate will tell you which:

- **ERASED** — a chain of `ON DELETE CASCADE` reaches it from `auth.users`. Nothing to do.
- **SEVERED** — `ON DELETE SET NULL`. The row survives. Record why in
  `tools/data-flow.json` `severed[]`.
- **RETAINED** — no delete reaches it. Record why in `retained[]`, **with a `procedure`**
  pointing at the file that answers the request. The gate requires that file to exist.
- **BLOCKING** — `ON DELETE RESTRICT`, `NO ACTION`, or **no `ON DELETE` clause at all**,
  which PostgreSQL treats as `NO ACTION`. The account deletion **fails**. This is a hard red
  with no quiet escape: an account that cannot be deleted is a GDPR Art. 17 failure and an
  Apple 5.1.1(v) review rejection from the same line, and the omitted-clause spelling is the
  one that looks like every other column definition.

Then re-run `node tools/check-data-flow.mjs` and `pnpm validate`.
