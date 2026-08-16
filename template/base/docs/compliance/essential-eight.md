# The Essential Eight, mapped whole

This project ships a machine-checked map of every requirement in the Australian Signals
Directorate's **Essential Eight Maturity Model at Maturity Level Three** — all 149 of
them — against what this application actually does. The map is
`tools/essential-eight.json`; the `docs-sync` gate judges it on every `pnpm validate`.

**Run `node tools/check-essential-eight.mjs` for the current standing.** The counts are
printed by the gate rather than written here on purpose: a number in prose is a number
that can drift away from the file it describes, and this document would be the easiest
place to start over-claiming.

The same discipline governs the tree's other conformance register, one standard over:
`tools/conformance-map.json` maps every requirement of OWASP ASVS 5.0.0, OWASP MASVS 2.1
and CRA Annex I to the live control that bears on it, judged by the third `docs-sync`
script (`node tools/check-conformance-map.mjs`), and generates
`docs/compliance/controls-crosswalk.md` (control → requirements, per standard) and
`docs/security/threat-model.md` (what the guards refuse, what the map leaves). It claims no
verification level for the same reason this document claims no maturity level.

---

## What this map does not claim

**This application is not "Essential Eight Maturity Level Three", and no application can
be.** That is not modesty, it is what the framework says, and a vendor who tells you
otherwise is selling something. Four facts, each checkable against ASD's own material:

- **Maturity attaches to an organisation's system, not to a product.** Every ASD artefact
  frames the outcome as *the organisation is meeting the control's objective*. There is no
  approved-product list, no product certification, and no mechanism by which software
  holds a maturity level.
- **46 of the 149 requirements are unreachable by any repository.** They name Windows
  workstations, drivers, firmware, Microsoft Office, Internet Explorer, PowerShell,
  jump servers and incident-response plans. No amount of application code moves them.
- **Assessment is all-or-nothing, per strategy and as a package.** One ineffective
  requirement fails its strategy; one failed strategy fails the level. *Restrict Microsoft
  Office macros* has **zero** reachable requirements in a web and mobile application, and
  risk-accepting a whole strategy forces **Maturity Level Zero** overall. So a
  repo-scoped Essential Eight claim does not merely overstate — it inverts.
- **The Essential Eight contains no software-development controls at all.** Every control
  in the ISM's *Guidelines for software development* is tagged `Essential 8: N/A`. Writing
  better code cannot earn Essential Eight maturity, by construction.

**What the map is for**, then, is the useful thing next door: making sure this
application is never the *blocker* to its operator's assessment, and handing an assessor
a per-requirement statement with evidence attached instead of a sales claim.

If you need a framework that does grade a software product, the instrument ASD designed
for it is the **ISM**, assessed via **IRAP** — in particular its *Guidelines for software
development* and *Guidelines for database systems*.

---

## How to read a row

Each row carries ASD's requirement text **verbatim** and then two independent judgements.

`reachability` is **frozen research**: could *any* codebase satisfy this — `direct`,
`alternate`, or `none`? It never changes to match a grade.

`outcome` is **this tree, today**:

| `outcome` | Meaning |
|---|---|
| `effective` | A live control runs here and its *subject is the requirement*. |
| `alternate-control` | A shipped mechanism serves the same intent by a different route. Always carries `assessorMayRefuse` — an alternate control is demonstrated by the system owner and an assessor may decline it. |
| `not-implemented` | Reachable, and honestly unbuilt. Names the obligations row that owns the gap. |
| `not-applicable` | The asset class does not exist here. Carries a written negative proof, never silence. |
| *(null)* | `boundary: organisation` — the requirement is real but the operator configures and evidences it. Names an `owner`. |

Keeping `reachability` and `outcome` apart is deliberate: several rows are reachable and
unbuilt, and collapsing the two fields is precisely how a compliance register inflates.

`evidenceTier` records **how strong the evidence is**, using ASD's own ranking — its
assessment process guide calls documentation and interviews *poor* evidence and testing
with simulated activity *excellent*:

- `simulated-activity` — an injection exists that makes the control go red, registered as
  a can-fail proof. The strongest claim, and the hardest to make.
- `system-generated-artefact` — a gate reads a real artefact and asserts on it.
- `documentation` — a written statement. A legitimate tier, and not dressed up as more.

## The grading rules

Grades are assigned **conservatively**, and the rules are enforced by the gate rather
than left to good intentions:

1. `effective` needs a live control whose subject **is** the requirement.
2. **Absence of a surface is not a control.** A requirement about an artefact this system
   does not produce is `not-implemented`, never `alternate-control` — otherwise a system
   that does nothing scores best.
3. Where two grades are defensible, the **lower** one is taken.
4. **An artefact already claimed by another row is not claimed again.** Eight
   logging clauses repeat across four strategies — 32 rows resting on one artefact set —
   so `sharedClauses[]` declares each artefact once and at most one row claims it.
   Double-counting is the commonest form of compliance inflation.
5. Every claimed control must be one something **actually runs**, and a control that is
   path-filtered or schedule-gated must say so: *this control exists* and *this control
   ran on this commit* are different claims.

The gate deliberately does **not** fail on `not-implemented`. Rows that are honestly
unbuilt say so, and failing on them would create steady pressure to regrade rows
generously to get a green build — the exact failure this map exists to prevent. What
fails is a malformed or inflated claim.

---

## What an assessor should ask us for

- The register itself, plus the gate output that proves its closures hold.
- For any `effective` or `alternate-control` row: the named control, and its can-fail
  proof where the row claims `simulated-activity`.
- For any `organisation` row: **your** evidence, not ours. Those rows name what we cannot
  see — your identity provider, your platform's patching, your log analysis and incident
  response, your Supabase organisation roles.

## Known ceilings, stated here rather than discovered later

- **Multi-factor authentication is enforced but not required.** The database refuses
  every statement from a user who holds a verified second factor and presents a
  password-only session — `aal2` is checked in a restrictive RLS policy, so it binds a
  client talking straight to the API and not merely one that goes through a screen. What
  the platform cannot express is *mandatory enrolment*: the auth service has no
  "required" setting anywhere, so a user who never enrols still signs in with one
  factor. The register therefore grades "MFA **is used** to authenticate users" as
  unbuilt and grades only the factor *composition* as effective. Making enrolment
  mandatory is yours to add; the enforcement it needs is already here.
- **Phishing-resistant multi-factor authentication** (an ML3 requirement) is not
  satisfiable on this stack today. Time-based one-time passwords are not
  phishing-resistant, and the platform's WebAuthn factor — while it does produce `aal2` —
  is undocumented, absent from the dashboard, marked experimental in the client library,
  and a paid add-on the CLI silently downgrades to off when the cost is unconfirmed. It
  ships explicitly disabled in a reviewed config rather than left to a default, so
  turning it on is a visible diff. The register records the ceiling rather than claiming
  the control.
- **Backup administrator separation** (ML3) cannot be met with the platform's built-in
  organisation roles: the role documented as unable to change project settings can still
  restore a database, and the only non-restoring role requires a higher plan tier. Re-read
  against the raw permissions table, the four published roles grant backups only
  View/Download/Restore and PITR only View/Restore — so there is no backup-administrator role
  to separate *from*, and the requirement's subject does not exist on this platform.
- **No API or role can delete a backup — and that is not a control.** No Delete or Modify
  action for a backup appears in the permissions table or anywhere across the 115 published
  API paths, and it is tempting to read that as satisfying the requirement that backup
  administrators be *prevented* from deleting backups. It does not. Prevention is a control;
  an unoffered verb is a gap in an interface. No immutability, WORM or object-lock guarantee
  is published for the storage holding these backups, so nothing is being prevented — it is
  merely not currently reachable through the surfaces on offer. One route is recorded as
  explicitly **unverifiable and ungraded in either direction**: whether reducing the PITR
  retention period, or removing the add-on, destroys backup data already inside the previous
  window. The vendor documents the billing consequence and publishes no data-lifecycle
  statement at all.
- **A backup is the database, not the system.** Edge Functions, Auth settings and API keys,
  Realtime settings, extensions and project settings, read replicas and Storage objects are
  all outside it — the database holds only Storage metadata — and custom-role login passwords
  are stripped. The sharpest exclusion is the Vault root key: a backup carries ciphertext but
  never the key, so a restore into a new project cannot decrypt what it just restored until
  the key is carried across by hand. That is the kind of thing normally discovered during a
  recovery rather than before one, which is why it is written here.
- **Restoration testing is a written record, and cannot honestly be anything else.** The
  scheduled `backup-evidence` lane asks the platform whether a recovery mechanism exists; it
  cannot test that a restore works. An in-place restore takes the project offline, and the
  non-destructive alternative — restore to a new project — is a Dashboard flow with no API
  path. Preview branches are not a substitute and not a counter-example either: the branching
  guide says branches start with no data, while the CLI's `--with-data` flag and the API's own
  `with_data` field say otherwise, and nothing here is graded on a contradiction between a
  vendor's own surfaces. So `tools/backup-posture.json` carries a date, a method and a name,
  and the lane refuses to imply more than that.
- **Log forwarding is asymmetric, and neither half is gated here.** One platform's log
  drains are API- and Terraform-addressable; the other's are dashboard-only. A gate that
  resolved either from a live endpoint is refused outright by this harness's own rule
  against non-hermetic checks — an untouched commit must never turn red overnight because
  a third party changed an answer. So forwarding is an evidence record, not a control, and
  the register says so. Retention is the other half of the reason to care: platform log
  retention tops out at **90 days** by plan tier, so anything you must retain longer has
  to ride a drain into a sink you control.
- **Abandoned dependencies are dispositioned, not removed — and the difference is the
  grade.** The `version-sync` gate reads the npm registry's own `deprecated` flags out of the
  resolved lockfile and requires every one of them to be recorded in `tools/eol.json`, with
  each row's production-vs-development scope **recomputed from the lockfile** rather than
  taken on trust. What it cannot do is what ASD's text actually says: *removed*. A fresh
  scaffold resolves six vendor-deprecated packages; five are development-only and one —
  `uuid@7`, reached through `expo` → `@expo/config-plugins` → `xcode` — is inside the
  production dependency closure and is **accepted with a re-review date, not removed**,
  because nothing in this repository selects that pin. So the requirement is graded
  `alternate-control` with `assessorMayRefuse`, and an assessor may reasonably decline it.
  Note also that "in the production dependency closure" is not "in the shipped bundle" —
  bundling follows imports, a lockfile records dependencies — so that grade is a ceiling on
  exposure rather than a measurement of it.
- **Vendor support windows are a written record, because most vendors publish no date.**
  Expo publishes **no end-of-life date for any SDK version** in any machine-readable form:
  its versions API carries no date fields, `endoflife.date` has no Expo product, and its
  written policy defines "unsupported" as *removed from the documentation*. So the register
  records the supported set and the vendor's own words, and refuses to compute a date from
  "approximately one year" — a number this project derived would read as a vendor's
  commitment. React Native is the one layer that publishes a real policy ("the latest 3
  minor series") with a dated support-tier table, and its row is correspondingly stronger.
  The requirements about **online services** and **operating systems** no longer supported by
  vendors stay unbuilt for the same reason and say so: a package flag describes a package,
  and establishing that Supabase, Vercel or a CI runner image is still supported means asking
  them — which a gate here may not do, because a check that resolves its answers from a live
  third-party endpoint turns an untouched commit red overnight.
- **Authentication events — successes AND failures — are logged since 1.0.0, at the
  only seam that can see them.** The vendor's `auth.audit_log_entries` records
  successes only (verified on a running stack: three failed sign-ins wrote nothing),
  and no client-side seam can do better — a failed attempt belongs to somebody who
  never got a session, and a credential-stuffing run against the token endpoint never
  renders your form. The seam that sees every attempt is GoTrue itself, so the trail
  binds there: the `[auth.hook.password_verification_attempt]` and
  `[auth.hook.mfa_verification_attempt]` hooks append to `auth_trail.events`
  (migration `20260816000000_auth_event_trail.sql`) — append-only in the same four
  layers as `audit.events`, org-less, with NO client read path at all (the operator's
  own database access is the read posture, recorded in the migration). The hooks are
  exception-wrapped and always answer continue, so a trail fault can never lock a
  user out. Ceilings, honestly: an attempt against an unknown email fires nothing;
  the password hook covers the password grant only; hosted auth hooks are
  plan-gated. Earlier releases of this document advised writing auth events into
  `audit.events` "at your own sign-in seam" — withdrawn as misleading, for the
  failed-attempt reason above. (ADR: docs/adr/20260816-auth-event-trail.md.)

## Shelf life

ASD opened consultation on **15 June 2026** to replace the Essential Eight with an
ISM-grounded *Essentials* series, citing the cloud gap explicitly — roughly twelve months
to deprecation and twenty-four to retirement. The stated reason for the change is the
same product-versus-organisation mismatch this document opens with. The obligations row
`conformance-e8-retirement` carries the date, and it is judged in the scheduled lane so
that a verdict which changes with the calendar never fails a pull request.

**Nothing here is a legal opinion or a certification.** It is a reading of ASD's published
text, recorded so the next person can check the reading rather than repeat the research.
The research pass behind it, with sources, is `design/research/` in the harness that
generated this project.
