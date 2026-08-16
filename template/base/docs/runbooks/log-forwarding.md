# Log forwarding — getting the trails off the platform they observe

Central logging, in ASD's sense, means the record **survives compromise of the
system that produced it**. Nothing inside this repository can satisfy that: the
application's trails (`audit.events`, `auth_trail.events`) are append-only in four
layers, but they live in the same database as the product, and the platform logs
live on the platforms. Forwarding is therefore YOUR act, performed in provider
consoles this repository deliberately does not reach — a gate that resolved drain
state from a live vendor endpoint would red an untouched commit overnight, which is
the hermeticity rule this harness has already paid to learn. This runbook is the
recorded boundary: what there is to forward, where the drains are, and what the
sink must guarantee.

## What there is to forward, per stream

| Stream | Where it lives | What it carries | Why it must leave |
| --- | --- | --- | --- |
| `audit.events` | your Postgres (schema `audit`) | every org-scoped INSERT/UPDATE/DELETE, actor-verified | survives DB compromise only off-DB |
| `auth_trail.events` | your Postgres (schema `auth_trail`) | password/MFA attempts, successful AND failed | same, and it is the incident stream |
| `auth.audit_log_entries` | your Postgres (GoTrue's schema) | GoTrue's own success events | carries NO append-only layer and none can be added (GoTrue re-migrates its schema) — a copy elsewhere is its only protection |
| Postgres / PostgREST / Auth service logs | Supabase's log pipeline | API access, errors, DDL | platform retention is plan-capped (~90 days at the top tier) |
| Web/API request logs, function logs | Vercel's log pipeline | request-level access to every route | short platform retention; the only record of pure enumeration sweeps (attempts against unknown emails never reach the database — the auth-trail ADR's stated ceiling) |

## Where the drains are, and the asymmetry you inherit

- **Supabase**: log drains are configured in the **Dashboard** (Project Settings →
  Log Drains). Verified against the live Management API specification: `drain`
  appears only as an enum value, never as a path — so this half is console-only
  and NOT automatable from a repo. Plan-gated. Sinks: HTTPS endpoint, Datadog,
  and syslog-shaped receivers.
- **Vercel**: log drains are API- and Terraform-addressable as well as
  console-configurable, so this half CAN live in your infrastructure-as-code —
  outside this repository, beside your other provider Terraform.
- **The two database trails** are not in either platform's drain pipeline: they are
  rows, not log lines. Export them on a schedule you own (`pg_dump
  --table=audit.events --table=auth_trail.events` from a runner with database
  reach, or a logical-replication consumer) into the same sink.

## What the sink must guarantee

The sink is the control, so it must hold what the source cannot promise:

1. **Independent access**: credentials that do NOT live in the platform being
   observed; a Supabase compromise must not read or erase the copy.
2. **Its own immutability**: object-lock / WORM or an append-only log store —
   the four in-database layers protect the source, not the copy.
3. **Retention you chose**: platform retention tops out around 90 days by plan;
   any requirement beyond that lives only in the sink.
4. **A tested read path**: an unreadable archive is retention theatre; drill the
   restore/query path the way `tools/backup-posture.json` drills backups.

## What this runbook is, in the register's terms

The Essential Eight rows that turn on the word "centrally" (RAP-20, RAP-21,
AC-11, AC-12) and on log PROTECTION (UAH-20, MFA-16) sit at the
**organisation boundary** with this runbook named as the owner's surface: the
product half — producing the events and protecting them in place — is built and
proven (the four layers, the elevated-role attempt canaries, the auth-trail
suites); the forwarding half is a decision about YOUR sinks and YOUR providers'
consoles, and no repository gate may claim it. When you have configured the
drains and the trail export, the evidence lives in your provider consoles and
your sink's configuration — record it in your own compliance trail, not here.
