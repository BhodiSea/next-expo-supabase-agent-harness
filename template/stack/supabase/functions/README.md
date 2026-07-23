# Edge Functions

This directory is empty at seed, and that is the design — not an omission.

## The rule

**Edge Functions are the one sanctioned home for service-role code in this
repository.** Nothing else may hold the service key: not a Server Action, not a
tRPC procedure, not a script, not a screen.

**Every Edge Function needs an ADR** — `docs/adr/NNNN-<slug>.md`, merged in the
same change that adds the function.

## Why the service role is different

Row Level Security is the authorization boundary for both client surfaces. Web
and mobile talk to the same database through the same policies, so an
authorization mistake is a mistake in one place and one place only.

`service_role` is outside that boundary. It bypasses row security by role
attribute, which means **no policy in this repository constrains it** — the
tests under `supabase/tests/` cannot cover it, because there is nothing to
cover. Whatever holds that key is the boundary, and the boundary is now code
someone has to review by hand.

That is a real cost, and it is sometimes worth paying — a webhook that must
write on behalf of a user who is not present, a nightly reconciliation, a
provider callback that arrives with a signature instead of a session. It is
never worth paying by accident, which is what happens when the key is available
in-process and something is easier to do with it than without it.

An Edge Function is a **separate deployment unit**: its own process, its own
secret scope, its own invocation surface. Putting elevated code there means the
key is reachable from exactly one place, that place has a name, and its blast
radius fits in a paragraph. In the web app the same key would sit in the same
process as every request handler; in the mobile bundle it would be extractable
by anyone who downloads the app.

## The database enforces this, not just this README

The seeded migrations `REVOKE ALL` from `service_role` on every table. A
function holding the service key therefore reaches **nothing** until a migration
grants it explicitly, per table:

```sql
GRANT SELECT ON TABLE public.<table> TO service_role;
```

That grant is the change the ADR is attached to. It is deliberately per-table
and deliberately narrow: `GRANT ALL ON ALL TABLES` restores exactly the blanket
authority this arrangement exists to remove, and it is the shape a generated
`supabase db diff` draft will happily hand you if you do not read it.

Note the direction of enforcement. `FORCE ROW LEVEL SECURITY` closes the
table-owner hole — the role that runs migrations and SQL-editor sessions is
subject to its own policies. It does **not** close the BYPASSRLS hole. Grants
are the only lever over `service_role`, which is why they are used as one.

## What an ADR for one of these has to answer

1. **What does it do that RLS cannot?** If the answer can be written as a
   policy, a database function, or a tRPC procedure running as the user, it is
   not an Edge Function.
2. **Which tables, which operations?** Name them. They become the exact
   `GRANT` statements in the accompanying migration.
3. **What authenticates the caller?** `verify_jwt` is on by default; a function
   that turns it off is accepting unauthenticated invocations from the public
   internet and needs a signature check of its own. Record which, and why.
4. **What is the blast radius if the key leaks?** With the per-table grants
   above, this is answerable in one sentence. That is the point of them.
5. **How is it tested?** RLS tests cannot cover it. Something has to.

## Wiring, when the first one lands

Functions live at `supabase/functions/<name>/index.ts` and are declared in
`supabase/config.toml`:

```toml
[functions.<name>]
verify_jwt = true
```

Deploy with `supabase functions deploy <name>`. Secrets are set with
`supabase secrets set` — never committed, never in `config.toml` except as
`env(NAME)`.

## What does not belong here

- Anything expressible as an RLS policy. Policies are tested, reviewed as data,
  and enforced for every caller on every path; a function is enforced only for
  callers who happen to go through it.
- Anything expressible as a database function running as the invoking user.
- Ordinary reads and writes for a signed-in user — those are `@app/api`
  procedures and Server Actions, which run as `authenticated` and go through the
  same policy wall as everything else.

The seeded slice needs none of this. Profiles and notes are created by the
signed-in user, for themselves, through the same policies that guard every read
— `supabase/seed.sql` populates the local database that way on purpose, so
"zero elevated code" is a property that gets exercised on every `db reset`
rather than a claim in a document.
