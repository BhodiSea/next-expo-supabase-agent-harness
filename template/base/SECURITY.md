# Security policy — {{PROJECT_NAME}}

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Report it privately to
{{SECURITY_OWNERS}}, or through this repository's **Security → Report a vulnerability**
advisory form if private reporting is enabled.

Please include, as far as you have it: what the issue is, which surface it affects
(`apps/web`, `apps/mobile`, the Supabase schema, an Edge Function, or the build/CI
surface), the version or commit you observed it on, and the smallest reproduction you
can manage. A rough report sent early beats a polished one sent late.

**Never include real credentials, real customer data, or a live token in a report.** If a
reproduction genuinely needs one, say so and we will arrange a channel — the service-role
key, store signing material and any customer row are all things a report should describe
rather than carry.

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement that a human has it | 3 working days |
| An initial assessment — is it reproducible, what is the impact | 10 working days |
| Status updates while it is open | every 10 working days |

If you have not heard anything within the acknowledgement window, assume the mail went
astray and escalate through the advisory form.

## Coordinated disclosure

We ask for coordinated disclosure and will work to a timeline agreed with you rather than
imposed on you. Our default is that a fix ships before details are published; where that
turns out to be slow, we would rather agree a date with you than let the report age
quietly. Credit is given by default — tell us how you would like to be named, or that you
would rather not be.

## Scope

**In scope:** anything in this repository that ships to a user or protects one — the web
app, the mobile app, the tRPC API surface, the database schema and its row-level security
policies, the Edge Functions, and the build and release pipeline.

**Out of scope**, because a report about them tells us nothing we can act on: findings
against a fork you have modified; anything requiring physical access to an unlocked
device; the *content* of a scanner report with no demonstrated impact; and the
**publishable/anon Supabase key**, which is public by design. That key authenticates the
request to the gateway and nothing more — row-level security is the access boundary, and
`docs/security/sandbox-and-supply-chain.md` records why. A report that the key is visible
in the client bundle is a report that the architecture is working.

`SUPABASE_SERVICE_ROLE_KEY` is the opposite case: it bypasses row-level security entirely.
If you find one reachable from a client bundle, a log line, or any surface a user can
read, that is a serious finding and worth waking someone up for.

## Downstream obligations, if you ship this commercially

This file is a template. If you place a product built on this repository on the EU market
in the course of a commercial activity, the **Cyber Resilience Act** obliges you to report
actively exploited vulnerabilities and severe incidents to the reporting end-point under
**Art. 14, from 2026-09-11** — on clocks that begin when *you* become aware, not when a
release is cut. Check the current text; the obligation is yours and the dates move.

Two things follow that are cheap to do now and expensive to retrofit: keep this contact
address monitored by more than one person, and keep a route from "a report arrived" to
"someone with commit access knows" that does not depend on any single individual reading
their mail.
