# CONFORMANCE-FACTS — what the regimes and deadlines actually say

**Verified 2026-08-07/08** against primary sources, by a research pass run specifically to
re-check the dates and claims 0.6.0's plan was going to encode. **Re-verify before citing any
row below in a gate, and on any bump of the tools it names.** Same discipline as
`CONTROL-PLANE-FACTS.md`, `EXPO-FACTS.md` and `CI-LANE-FACTS.md`: dated, sourced,
re-verify-on-bump.

## Why this file exists

The plan for this release said, of its own deadline table: *"re-verify each date against its
primary source before encoding it — a wrong date in a gate is worse than no gate."* That
instruction earned its keep. **Six of seven rows came back corrected**, and at least three
would have shipped gates that were wrong in ways nothing downstream could have noticed: an
assertion keyed to a failure code the change does not produce, a legal obligation this project
does not have, and a vendored SQL suite with no licence to vendor.

The other reason is subtler and is why this is a file rather than a paragraph in the changelog.
**A cut regime and a forgotten regime look identical six months later.** Every row below records
its disposition — SHIPPED, TARGET, or CUT — and a cut carries the reason that made it a cut, so
the next release re-opens the question deliberately or not at all.

**Nothing here is a legal opinion.** These are readings of primary text, recorded so that the
next person can check the reading rather than repeat the research.

---

## 1. Supabase Data API grants stop being automatic — **SHIPPED**

| | |
|---|---|
| **Date** | 2026-10-30 |
| **Plan said** | new tables "404 silently" afterwards; the roles are `anon` and `authenticated` |
| **Verified** | Date CONFIRMED. Everything else CORRECTED. |

- The role set is **three**, not two: `service_role` is included.
- **SEQUENCES are revoked too**, not only tables.
- The failure is **SQLSTATE 42501 → HTTP 403/401**, *not* a silent 404. A gate written against
  the plan's 404 would never have fired on the real regression.
- Only **NEW** tables are affected; existing tables keep their grants.
- The `auto_expose_new_tables` config flag that would restore the old behaviour is **itself
  removed on the same date**, so a gate keyed to that flag would have had a shorter shelf life
  than the change it guards. Explicit `GRANT`s are the only durable form.

**Disposition: SHIPPED in 0.6.0** as the policy→grant closure inside `schema-rls` — no new chain
step, because the gate already parsed the grants and used only the function half. See
`tools/lib/table-grants.mjs`.

---

## 2. Google Play target API level — **CUT (already satisfied, and not derivable)**

| | |
|---|---|
| **Date** | 2026-08-31 |
| **Plan said** | make `androidTargetSdk.floor` a map, because the form-factor exceptions cannot be expressed by a scalar |
| **Verified** | Levels CONFIRMED verbatim: **36** general, **35** Wear + Automotive, **34** TV + XR. |

Corrections worth carrying:

- There are **two requirement families**, not one — a *submission* floor and a
  *continued-distribution* floor. They are not interchangeable.
- **TV did not move in 2026.** Its row is dated 2025-08-31; reading the table as one 2026
  deadline misstates it.
- The extension asterisk is scoped to **API 36 general and XR only**.

**Why it is cut rather than deferred.** The form factor is **not derivable from any config this
template can produce**. `@expo/config-types@57.0.2` types `platforms` as a closed union of
`android | ios | web`; the only form-factor-bearing key in the whole surface is
`experiments.supportsTVOnly`, and the real Expo TV path is gated on an **`EXPO_TV=1` environment
variable**. Keying a gate on an env var would reproduce the failure already recorded in this
repo's memory as *lane environment porosity* — a local run that checks less than CI because a
variable leaked in. A **scalar floor is the correct shape for what this template can build**, and
a map would be machinery for a case the scaffold cannot reach.

Re-open if the template ever seeds a Wear, Automotive, TV or XR target.

**Play target-API row re-verified 2026-09-29**, on the scheduled re-read that the
`conformance-play-target-api-window` row owed on 2026-08-31. Both sources were read on
2026-09-29:

- [developer.android.com/google/play/requirements/target-sdk](https://developer.android.com/google/play/requirements/target-sdk),
  the page `tools/store-policy.json` and `tools/check-expo-policy.mjs` cite. It says "Last
  updated 2026-09-16 UTC".
- [Play Console Help, answer 11926878](https://support.google.com/googleplay/android-developer/answer/11926878),
  "Target API level requirements for Google Play apps". The served page carries no
  last-updated date, so none is recorded.

What they say:

- **Submission (new apps and app updates), from 2026-08-31: unchanged.** API **36** in
  general, **35** for Wear OS and Android Automotive OS, **34** for Android TV and Android XR.
  The Help page's per-form-factor tables still date TV's 34 to 2025-08-31 and XR's 34 to
  2026-08-31.
- **Continued distribution (existing apps), from 2026-08-31.** **35** in general (mobile and
  Android Auto), **34** for Wear OS and for XR, **32** (12L) for Automotive OS. **The two pages
  disagree on TV.** The Help page counts an existing TV app that targets 33 as compliant. The
  developer page lists TV beside Wear OS and XR among the apps restricted at 33 or lower,
  which implies 34. This template builds no TV target, so the difference is recorded and
  nothing acts on it.
- **Extension: to 2026-11-01, on both pages.** On the Help page the asterisk now marks only
  the API 36 row of the general submission table, and the XR table carries none. Its
  per-form-factor "What to do to comply" text offers every form factor an extension request
  to keep distributing to all users until 2026-11-01. So the bullet above that scopes the
  asterisk to "API 36 general and XR only" no longer matches the page. `store-policy.json`
  does not assume an extension, so its floor is unaffected.
- **No later step is published.** Neither page names a requirement after 2026-08-31.

The local half holds, re-checked in this tree on the same day:

- `tools/store-policy.json` has `androidTargetSdk.floor` 36, and `expoSdkDefaults` maps SDK 57
  to 36.
- The catalog pins `expo` at 57.0.9 and `react-native` at 0.86.2.
- `checkTargetSdk` in `tools/check-expo-policy.mjs` reads both values: a declared
  `targetSdkVersion` first, else the mapped default, and an unknown SDK major fails closed.
- The SDK 57 mapping was re-derived from the published packages rather than restated.
  `expo-modules-autolinking` 57.0.13, inside `expo` 57.0.9's `~57.0.9` range, takes
  `targetSdkVersion` from React Native's version catalog, and `react-native` 0.86.2's
  `gradle/libs.versions.toml` sets `targetSdk = "36"`.
- A search of `template/` for
  `leanback|android.hardware.type.(watch|automotive)|supportsTVOnly|EXPO_TV` finds nothing, so
  the form-factor cut above still holds.

**Verdict: the floor of 36 still matches the only form factor this template can produce, and
no shipped value is contradicted.** The row is re-dated, not deleted: its next re-verification
is **2027-05-31**. That is three months before the next 31 August step that the Help page's own
table implies (API 35 from 2025-08-31, API 36 from 2026-08-31). Raising the floor tightens what
`check-expo-policy` judges for an existing install, so it needs a ramp in a minor release, and
a row that fired on the deadline itself would fire too late to ship one.

---

## 3. Apple: uploads must build against a minimum SDK — **TARGET 0.7.0 — DISCHARGED 2026-08-08**

| | |
|---|---|
| **Date** | in force since 2026-04-28 |
| **Plan said** | "uploads must build with the *current* Xcode/iOS SDK" |
| **Verified** | Date CONFIRMED. The characterisation is WRONG in a way that matters. |

- It is a **fixed floor**, not a moving "current" requirement: **Xcode 26 / iOS 26 SDK or
  later**. A gate written against "current" would have to track Apple's releases; a floor is a
  constant.
- **macOS is excluded** from the requirement.
- Only a **concrete pinned image name** is statically checkable — match `-xcode-(\d+)` and
  compare the major against the floor. `auto`, `latest`, `sdk-NN` and *absent* are
  **unverifiable, and must not read as green**. That last clause is the whole design: a check
  that passes an unpinned profile is a check that passes every profile.

**Verified against the shipped tree on 2026-08-08: `apps/mobile/eas.json` pins no `image` on any
profile.** So there is currently nothing to check and nothing that could red, which is exactly
the plan's stated symptom — *"a stale `eas.json` image pin burns a whole build-and-submit cycle
with no gate output"* — in its worst form, where there is no pin to be stale.

**Why it is a Target and not a ship.** Discharging it requires *adding* a pin, and an image name
is a string from EAS's published list that this session could not verify offline. Seeding a
fabricated one would break every consumer's build — a strictly worse outcome than the gap. The
assertion is specified; only the value is missing.

**Target: `version-sync`, 0.7.0** (that row already owns `eas.json`). Discharge = a pinned
`image` on the production iOS profile, a reviewed floor in `tools/store-policy.json` carrying
this date and source, and a check where unpinned/`auto`/`latest` fails rather than passes.

**DISCHARGED in 0.7.0 — the dated evidence (recorded 2026-08-08).** The EAS published image
list was fetched on **2026-08-08** from https://docs.expo.dev/build-reference/infrastructure/
and carries five iOS images at Xcode ≥ 26 (`macos-tahoe-26.5-xcode-26.6` — Xcode 26.6, 17F113,
latest/default and the `sdk-57` alias; `macos-tahoe-26.4-xcode-26.4`;
`macos-sequoia-15.6-xcode-26.2`; `macos-sequoia-15.6-xcode-26.1`;
`macos-sequoia-15.6-xcode-26.0`). The pin landed as **`macos-tahoe-26.5-xcode-26.6`** on the
production iOS profile in `apps/mobile/eas.json` — the CONCRETE name behind the `sdk-57` alias
(the template pins Expo SDK 57 per `design/EXPO-FACTS.md`), chosen precisely so the alias's
future movement cannot silently change the toolchain under a consumer. The reviewed floor is
`tools/store-policy.json` `iosToolchain` (`xcodeFloor: 26`, `inForceSince: 2026-04-28`,
source: https://developer.apple.com/news/upcoming-requirements/ — Apple's upcoming-requirements
notice, the requirement source this section's dates were verified against). The check is the
static, offline half of `check-version-sync.mjs`: absent / `auto` / `latest` / `sdk-NN` red as
unverifiable, and a matched `-xcode-` major below the floor reds naming both numbers, the
in-force date and the source. Ramped `0.7.0 → until 0.8.0` for pre-0.7.0 installs (their
seeded `eas.json` predates the pin; the 0.7.0 migrations record's `seededSourceFixes`
instruction carries the pin itself). The tier row's Target now discharges through the
`closes:` probe `tools/store-policy.json#iosToolchain`. Honest limit, stated in the tier row:
no lane runs an EAS build, so upstream RETIREMENT of the pinned name is invisible to the
chain — re-verify the image list on any Expo SDK bump.

---

## 4. CRA Article 14 reporting — **CUT for this repo; enablement instead**

| | |
|---|---|
| **Date** | 2026-09-11 |
| **Plan said** | 24h / 72h / 14d to the coordinating CSIRT **and** ENISA — "three clocks, three recipients" |
| **Verified** | Date CONFIRMED exactly (Art. 71(2)). Scope and mechanics CORRECTED. |

- **This repository is out of scope entirely.** Unmonetised free and open-source software is not
  "made available on the market in the course of a commercial activity" — Art. 2(1), Art. 3(22),
  and recital 19. Building self-enforcement machinery here would have gated an obligation the
  project does not have.
- **"Three recipients" is wrong.** Art. 14(7) provides a **single reporting end-point**,
  simultaneously accessible to ENISA. One submission, not three.
- The "14 d" is **two different clocks**, not one — they are not a single deadline with a single
  trigger.

**Disposition.** The correct deliverable is **consumer-facing enablement**, since a consumer
shipping a commercial product built on this scaffold *is* in scope. `SECURITY.md` (coordinated
vulnerability disclosure) ships in 0.6.0. `security.txt` is a **Target**, and deliberately not a
ship: RFC 9116 makes `Expires` mandatory, which is a dated commitment in a seeded file — the
exact shape of the defect 0.6.0 just fixed in `framework-floor.json`, where a reviewer-supplied
date with no bound on it was an off switch for the control. It ships when it ships with a bound.

**CRA Article 14 row re-verified 2026-09-29**, on the scheduled re-read that the
`conformance-cra-art14-application` row owed on 2026-09-11.

**How it was read, and what was not read.** The register's evidence URL for the Regulation is
[EUR-Lex, OJ L 2024/2847](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202402847).
It answered every request from the session that did this re-read with an empty HTTP 202, which
is a bot challenge, and its ELI and PDF forms did the same. So the Articles were read through
the Commission's own pages, each of which cites them by number. All three were read on
2026-09-29:

- [Cyber Resilience Act: Reporting obligations](https://digital-strategy.ec.europa.eu/en/policies/cra-reporting)
  (last update 11 September 2026);
- [Cyber Resilience Act: Summary of the legislative text](https://digital-strategy.ec.europa.eu/en/policies/cra-summary)
  (last update 3 December 2025);
- [Cyber Resilience Act: Open source](https://digital-strategy.ec.europa.eu/en/policies/cra-open-source)
  (last update 31 July 2026).

Those pages link two more documents. Their library pages on the same site were read on
2026-09-29, and the documents themselves were not:

- the [Commission guidance, C(2026) 5252](https://digital-strategy.ec.europa.eu/en/library/commission-publishes-new-guidance-support-timely-cyber-resilience-act-implementation)
  and its annex, published 27 July 2026, which the library page says clarifies scope
  "including remote data processing solutions and free and open source software" and covers
  reporting;
- the [Commission FAQ](https://digital-strategy.ec.europa.eu/en/library/cyber-resilience-act-implementation-frequently-asked-questions),
  published 3 December 2025 and last updated 4 September 2026.

Both documents are hosted on ec.europa.eu, which the same session could not reach. Reading
EUR-Lex itself and those two documents is the maintainer's step before the re-dating below is
approved.

What the pages say:

- **Date: CONFIRMED.** "As of 11 September 2026, manufacturers are required to report actively
  exploited vulnerabilities and severe incidents impacting the security of products with
  digital elements." Art. 14 applies early under Art. 71(2). The rest of the Regulation
  applies from 11 December 2027.
- **End-point: CONFIRMED, and now live.** "Manufacturers report only once through the CRA
  Single Reporting Platform (SRP)." The notification is addressed to the CSIRT where the
  manufacturer has its main establishment, and is made available to ENISA at the same time.
  ENISA set the platform up under Art. 16, and it has been operational since 11 September
  2026. The same page: "Manufacturers and open-source software stewards are required to submit
  their notifications through that platform." "One submission, not three" above stands; read
  "single reporting end-point" as one submission through one platform.
- **Scope reading: CONFIRMED for the manufacturer duties.** Only free and open-source software
  that is made available on the market is in scope, and that means supplied in the course of
  a commercial activity, "whether in return for payment or free of charge" (Art. 3(22)). The
  open-source page: "the provision of products with digital elements qualifying as free and
  open-source software that are not monetised by their manufacturers should not be considered
  to be a commercial activity". **The recital cited above looks wrong.** The Commission's
  summary says "Recital 18 further clarifies when free and open-source software is made
  available on the market", and the bullet above cites recital 19. Search-index copies of the
  EUR-Lex text agree with the summary: they quote the not-monetised sentence from recital 18,
  and describe recital 19 as the one that introduces the open-source software steward. The
  bullet above is the 2026-08-07/08 record and is left as it was read; confirming the recital
  numbers is part of the EUR-Lex re-read. The scope reading does not depend on the number.
- **The steward answer, which this section never recorded.** Art. 24 sets up a second role
  beside the manufacturer, the **open-source software steward**. Art. 3(14), in the summary's
  words: "a legal person, other than a manufacturer, that has the purpose or objective of
  systematically providing support on a sustained basis for the development of specific
  products with digital elements, qualifying as free and open-source software and intended
  for commercial activities, and that ensures the viability of those products". Art. 24(3)
  extends two Art. 14 duties to a steward. In the summary's words, a steward reports actively
  exploited vulnerabilities "to the extent that they are involved in the development of the
  products with digital elements", and severe incidents "to the extent that they affect
  network and information systems provided by the open-source software stewards for the
  development of such products". A search-index copy of the EUR-Lex text numbers those duties
  Art. 14(1) and Art. 14(3) and (8); confirming the numbers is part of the EUR-Lex re-read.
  Art. 24 also asks a steward for a cybersecurity policy and for cooperation with market
  surveillance authorities, and Art. 64(10) exempts stewards from administrative fines.
  **The steward duties apply from 11 December 2027, not from 11 September 2026:** "In
  accordance with Article 71(2) of the CRA, open-source software stewards are subject to
  reporting obligations (Article 24(3)) from 11 December 2027."

**What that means here.** On 2026-09-11 no Art. 14 duty reached this repository in either
role. As a manufacturer it is out of scope on the reading above, as free and open-source
software that is not monetised, and a steward's Art. 14 duties do not apply until 2027-12-11.
So "out of scope entirely" above is true of the manufacturer duties and of today. For
2027-12-11 it is **not settled**, because whether this repository has a steward depends on
facts the tree cannot establish.
`package.json`, `CITATION.cff` and `GOVERNANCE.md` name Cogvera Labs as the author. Whether
Cogvera Labs is a legal person that systematically supports this harness, as software intended
for commercial activities, is for the maintainer to determine. This file records the question
as **open**, and does not answer it.

**The two shipped texts still read true,** and neither changes:

- `template/base/SECURITY.md`, "Downstream obligations": a consumer who places a product on
  the EU market in the course of a commercial activity reports under Art. 14 from 2026-09-11,
  to the reporting end-point, on clocks that start when the consumer becomes aware.
- The `CRA-II.5` note in `tools/conformance-map.json` says SECURITY.md carries "a paragraph on
  the consumer's own CRA Article 14 reporting duty from 2026-09-11", and it does.

**Verdict: the row is re-dated, not deleted.** Its next re-verification is **2027-06-11**, six
months before the steward duties apply on 2027-12-11. If the maintainer's organisation is a
steward, its Art. 24 policy and a reporting route into the SRP have to be in place on that
day, and a row that fired on the day itself would fire too late to prepare either.

---

## 5. EU AI Act Article 50 transparency — **CONFIRMED NEGATIVE**

| | |
|---|---|
| **Date** | in force since 2026-08-02 (plus a 2026-12-02 transitional) |
| **Plan said** | encode the negative: AI-*assisted authorship* creates no obligation on the shipped product |
| **Verified** | Dates CONFIRMED. The negative holds — for a **stronger** reason than the plan gave. |

The plan leaned on the Guidelines' source-code carve-out (para. 68). The robust rationale is the
**role split**: Art. 50(2) binds the **provider of the generative system**, not the author of
software written with one. That argument does not depend on a guidance paragraph that can be
revised.

**Disposition: recorded, nothing to build.** A harness that over-claims here manufactures work
for every consumer.

---

## 6. European Accessibility Act — **CUT as a regime; the a11y limits recorded**

| | |
|---|---|
| **Date** | enforceable since 2025-06-28 |
| **Plan said** | the a11y floor is lint + component tests, which makes this a legal exposure |
| **Verified** | Date CONFIRMED. The legal conclusion was **over-built**. |

- The Directive covers **six enumerated consumer service categories**, not software generally.
- **It never mentions WCAG or EN 301 549.**
- **No harmonised standard is cited in the OJ**, so the Art. 15 **presumption of conformity does
  not currently exist**. Mapping controls to a standard that has not landed would be mapping to
  nothing.

**What is worth carrying anyway, because it is true regardless of the regime.**
`eslint-plugin-react-native-a11y` ships **14 rules**; **4 of them target props React Native no
longer documents**, so they can never fire — a rule that cannot fire is a false green. The set
covers only the **syntactic half of one success criterion** (WCAG 4.1.2). And it **goes silent on
design-system wrapper components** — which is precisely the architecture `AGENTS.md` *mandates*
("controls render through `src/components` primitives"). The mandated structure defeats the lint
rule. That is now stated in the `lint` row of `docs/harness/enforcement-tiers.md` rather than
left to be discovered.

**Disposition: cut whole, per the plan's own rule** — *"cut whole regimes, never half a mapping;
a partial map that claims a level is worse than no map."*

---

## 7. Supabase `splinter` lints — **CUT (legal, not technical)**

| | |
|---|---|
| **Plan said** | "29 SQL lints, none run. Apache-2.0 and vendorable." |
| **Verified** | **It has no licence at all.** |

- The Apache-2.0 badge in the README **renders an unrelated PyPI package's licence**, and the
  repository's `LICENSE` link **404s**.
- It ships **28** lints, not 14 or 29.
- `splinter.sql` **aborts on stock PostgreSQL** — `role "anon" does not exist` — so it is not
  the offline drop-in the plan assumed.

**Disposition: cut.** Vendoring code with no licence is a legal question, not an engineering
trade-off, and it is not one a gate can settle. Re-open only if upstream publishes a licence.

---

## 8. pnpm 11 — SBOM and package aging

**`pnpm sbom` is native in pnpm 11.0.0** — CycloneDX 1.7 and SPDX 2.3, with `--sbom-format`
**mandatory**. `--out` and `--split` need **11.8.0+**. This repository and the scaffold both pin
`pnpm@11.11.0`, so every form is available.

Worth noting against the shipped tree: the `ci-provenance` module reaches for
`anchore/sbom-action` (syft) to produce something **the pinned package manager already
produces**. That is a third-party action, and a pinned SHA to keep current, for no capability.

**`minimumReleaseAge` facts, all three empirically checked:**

1. The unit is **MINUTES**. pnpm 11's default is `1440` — twenty-four hours.
2. It is honoured in **`pnpm-workspace.yaml` only**. A value in `.npmrc` is **silently ignored**
   on pnpm 11 — no warning, no error. A consumer who "fixes" the pinned `0` in the wrong file
   gets nothing and is told nothing.
3. pnpm 11's default is **non-strict**.

The shipped `minimumReleaseAge: 0` stays, and its existing comment already records why with a
live observation. Fact 2 is added there, because it is the one that silently wastes someone's
afternoon.

**Disposition (0.11.0): SBOM release-diff consumption SHIPPED.** The undated
disposition this paragraph carried through 0.9.9 said the differentiating control was never
*producing* an SBOM but *consuming* one, and that dating it without intending to build it next
would be the kind of commitment this file exists to prevent. 0.10.0 built the half that had
become buildable and dated the half that had not, so the paragraph splits in two. 0.11.0 built
the dated half: `scripts/check-sbom-drift.mjs` diffs this tree's resolved component closure
against the PREVIOUS RELEASE TAG's and reds on an added component with no reviewed row in
`scripts/sbom-additions.json`. Its first run finds ZERO additions, which is only meaningful
because its red-proof establishes that it can find one — and it is deliberately FACTORY-side:
the completeness closure (`tools/check-sbom.mjs`) judges the consumer's own tree, while drift
is a question about this repository's releases.

**Built.** `pnpm sbom --sbom-format cyclonedx --lockfile-only` runs daily on the `osv-scan`
lane (job `sbom-inventory`), and `tools/check-sbom.mjs` closes the emitted component set
against `pnpm-lock.yaml` in **both** directions — a resolved package with no component, and a
component no lockfile entry resolves — with a zero-component emission a hard failure rather
than an empty set matching an empty set. Emission alone would have been decoration: `pnpm sbom`
is one line and cannot go red, so a lane that only emitted would have been a green tick over an
inventory that had silently lost half the tree. This is what regrades **PA-01**, and only to
`alternate-control`: it is a software inventory, not estate asset discovery.

**DISCHARGED AT 0.11.0 — and the two senses of "consumption" stayed distinct to the end.**
The control this paragraph originally meant is the *release-over-release diff*: compare this
tree's SBOM against the previous release tag's and red on an **added** component that is not
allowlisted. The lockfile closure above consumes the SBOM against the *same* tree, which
catches an incomplete inventory and catches nothing about supply-chain drift. The register row
`sbom-consumption` (target 0.11.0) carried the tag-diff half, and 0.11.0 shipped it as
`scripts/check-sbom-drift.mjs`: the resolved closure diffed against the previous release tag,
an ADDED component red unless a reviewed row in `scripts/sbom-additions.json` names it — the
half a catalog diff structurally cannot see, because a transitive arrival changes no key. The
row is deleted; this paragraph is its record. (Through 0.11.1 this paragraph still described
the row as open — stale prose no machine read, corrected in the 1.0.0 pass.)

## 9. ASD Essential Eight Maturity Model — **SHIPPED whole, and the claim is bounded**

**Verified 2026-08-12** against ASD's published model (dated **27 Nov 2023**), its assessment
process guide, and the ISM's mapping tables. The brief was "make the harness deterministically
produce Maturity Level Three code", and the research changed the deliverable rather than the
effort. Recorded here because the verdict is the sort a future release will be tempted to
re-litigate under commercial pressure.

### The scope verdict — a product cannot hold a maturity level

Four facts, each checkable against ASD's own material, and together they are not a matter of
degree:

- **Maturity attaches to an organisation's system.** Every ASD artefact frames the outcome as
  *the organisation is meeting the control's objective*. There is no approved-product list, no
  product certification, and no mechanism by which software holds a level.
- **46 of the 149 requirements are unreachable by any repository** — Windows workstations,
  drivers, firmware, Microsoft Office, Internet Explorer, PowerShell, jump servers,
  incident-response plans.
- **Assessment is all-or-nothing, per strategy and as a package.** One ineffective requirement
  fails its strategy; one failed strategy fails the level. *Restrict Microsoft Office macros*
  has **zero** reachable requirements in a web and mobile application, and risk-accepting a
  whole strategy forces **Maturity Level Zero** overall. A repo-scoped claim therefore does not
  merely overstate — **it inverts**.
- **The Essential Eight contains no software-development controls at all.** Every control in
  the ISM's *Guidelines for software development* is tagged `Essential 8: N/A`. Writing better
  code cannot earn E8 maturity, by construction.

**Disposition: SHIPPED in 0.9.9** as `tools/essential-eight.json` — all 149 rows, judged by
`tools/check-essential-eight.mjs` as the second script of the `docs-sync` chain step, with
`scripts/check-essential-eight-evidence.mjs` as its factory half. The claim the release
licenses is that a generated application is never the *blocker* to its operator's assessment.
`scripts/hygiene.mjs` carries a deny pattern so "achieves ML3" cannot appear later.

### The 152-vs-149 trap

The naive union of ML1, ML2 and ML3 requirements is **152**. Exactly **three are superseded at
ML3** and must not be counted twice:

| Superseded (ML1/ML2) | Replaced by | Why it is a trap |
|---|---|---|
| Applications patched within two weeks | `PA-08` + `PA-09` | ML3 SPLITS into 48h (vendor-critical or working exploit) and two weeks. The common vendor claim that ML3 moves this class "from one month to two weeks" is **wrong at both ends**. |
| Operating systems patched within one month | `POS-09` + `POS-10` | Unqualified one month becomes a 48h/one-month split. |
| Customer MFA *offers* a phishing-resistant option | `MFA-12` | ML2 requires an option be OFFERED; ML3 requires it **be** phishing-resistant. Letting a customer choose SMS passes ML2 and fails ML3. |

They ship as `supersededAtML3[]` rows carrying `replacedBy`, never deleted — a cut requirement
and a forgotten requirement look identical six months later, which is this file's own rule.
The per-strategy census is `13 / 16 / 23 / 29 / 19 / 11 / 27 / 11` and the gate reds on a
dropped row.

### ASD ranks evidence, and the ranking is the design

The assessment process guide calls **documentation and interviews *Poor*** evidence and
**testing with simulated activity *Excellent***. That is the harness's own doctrine — a gate
that cannot go red is decoration — so `evidenceTier` is a first-class field with three values,
and a row may claim the top tier only while naming a `tests/canary/injections.json` entry that
makes its control go red. The standing shape at 0.11.0 is **114 documentation, 30
system-generated-artefact, 5 simulated-activity**; the point of writing the weakest tier on 114
rows is that they are not dressed up as the other two. (0.9.9's figures were 112/32/5; 0.10.0
promoted two rows, and 0.11.0 regraded UAH-02..05 DOWN — web-browser hardening rests on "no
browser-fleet component", which nothing machine-checks, and an absence resting on prose alone
is documentation tier by definition.)

Two anti-inflation closures matter more than they look. **Absence of a surface is not a
control** — a requirement about an artefact this system does not produce is `not-implemented`,
never `alternate-control`, or a system that does nothing scores best. And **an artefact another
row already claims is not claimed again**: eight logging/incident clauses repeat across four
strategies, **32 of the 149 rows resting on one artefact set**, so `sharedClauses[]` declares
each artefact once. The research pass itself classified three of those clauses four different
ways before its own adversarial critic caught it.

### Supabase's published aal2 RLS policy is broken, in three directions

Load-bearing, because copying it is the obvious move. The first two came out of the research
pass; **the third was found by running the mutation**, and is written the way it was observed:

- **As published** it queries `auth.mfa_factors`, on which `authenticated` holds **no grant** →
  `42501` on every request. (Upstream issue #36024 open; fixing PR #42659 unmerged since
  2026-02-10.)
- **"Fixed" with a naive `GRANT SELECT`**, that table has RLS enabled and **no policy**, so
  default-deny makes `count(id) = 0`, the `CASE` falls through to `array['aal1','aal2']`, and
  the policy **silently accepts aal1**. A fail-open that no naive test catches.
- **It denies every session carrying no JWT at all.** `auth.jwt()->>'aal'` is NULL there, and
  `array[NULL] <@ array['aal1','aal2']` evaluates to NULL rather than true — which a RESTRICTIVE
  policy treats as a refusal, so a migration, a seed file or a psql session cannot write the
  table. Swapping the published policy into the 0.9.9 proof ladder failed `supabase db reset`
  outright, at `Seeding data from supabase/seed.sql`, SQLSTATE 42501. Worth stating because it
  is the *loudest* of the three and would be found immediately — while defect 2, the one that
  matters, is silent.

**The mutation is the evidence, and it was run rather than reasoned about.** With the published
policy in place, `supabase/tests/mfa_aal2.test.sql` fails **6 of its 23** assertions — test 12,
*"aal1 + enrolled: ZERO ROWS"*, returns both rows; the aal1 INSERT succeeds where 42501 was
wanted; the aal1 DELETE removes the enrolled user's notes outright, which is why the later
unenrolled-user assertions then see an empty table. Restoring the shipped policy returns
138/138. A suite that only checked the unenrolled case would have passed against all of it.

Shipped instead: `public.mfa_is_required()` as `SECURITY DEFINER SET search_path = ''`, and a
**RESTRICTIVE policy with no `FOR` clause** — restrictive and `FOR ALL` are orthogonal axes,
and Supabase's other page writes this same policy `for update`, gating UPDATE while leaving
SELECT wide open. `supabase/tests/mfa_aal2.test.sql` proves the fail-open specifically, and two
traps it must avoid are worth recording: set `request.jwt.claims` (the plural blob GUC) not
`request.jwt.claim.sub`, because `auth.jwt()` reads the blob and the singular form returns
`NULL` and passes for the wrong reason; and `auth.mfa_factors` carries a *global* unique on
`last_challenged_at`, so fixtures leave it NULL.

### Two Supabase CLI-docs defects, verified against CLI 2.113.0

Both would have been encoded from the docs page:

- `[auth.mfa.phone].max_frequency` — the docs say `10s`; the **CLI's own embedded template says
  `5s`**.
- `[auth.mfa.phone].template` is **omitted from the docs page entirely**.

The `[auth.mfa]` tree is exactly **ten keys**, all present at that pin, and the CLI parses
unknown keys **leniently** — `[auth.mfa.webauthn]` (missing underscore) is dropped in silence.
That is why all ten land in `tools/auth-posture.json` and are diffed by value in both
directions.

### What no vendor publishes — recorded so it is not re-derived

- **Expo publishes no end-of-life date for any SDK version** in any machine-readable form: its
  versions API carries no date fields, `endoflife.date` has no Expo product, and its written
  policy defines "unsupported" as *removed from the documentation*. `tools/eol.json` records
  the supported set and the vendor's own words and **refuses to compute a date from
  "approximately one year"** — a number this project derived would read as a vendor's
  commitment. React Native is the one layer with a real published policy ("the latest 3 minor
  series") and a dated support-tier table.
- **No RPO is published for Supabase daily backups** (one exists for PITR), and ASD frames the
  requirement as "in accordance with business criticality" — an operator determination. So
  `tools/backup-posture.json` ships `maxDailyBackupAgeHours: null` and must be filled in.
- **No immutability, WORM or object-lock guarantee is published** for the storage holding
  backups, and no Delete or Modify verb for a backup appears in the permissions table or across
  all 115 API paths. That is an **absence of surface, not a control** (grading rule 2), so
  `RB-11` stays ungranted. One route is recorded as explicitly **unverifiable and ungraded in
  either direction**: whether reducing the PITR retention period, or removing the add-on,
  destroys backup data already inside the previous window. The vendor documents the billing
  consequence and publishes no data-lifecycle statement at all.
- **Whether preview branches carry data is a contradiction inside the vendor's own surfaces** —
  the branching guide says branches start with no data, while the CLI's `--with-data` and the
  API's `CreateBranchBody.with_data` say otherwise. Nothing here is graded on it in either
  direction.
- **Log forwarding is asymmetric**: Vercel drains are API- and Terraform-addressable; Supabase
  drains are Dashboard-only (verified against the live Management API OpenAPI spec, where
  `drain` appears seven times and every occurrence is an enum, never a path). Do not design a
  symmetric gate. Platform log retention tops out at **90 days** by plan tier.

### The ceilings the 0.10.0 conversions rest on

Five register rows were dated `release`/`0.10.0` and are converted to `condition` in that
release. Read uncharitably that is a compliance release improving its numbers by moving
goalposts, so the bill is deliberately **heavier** than the dated rows paid: each converted row
carries a `sites[]` anchor byte-checking one of the sentences below, so the ceiling cannot be
quietly edited away later while the row still claims it. **No `outcome` changes** — every
affected requirement stays `not-implemented`. What changes is the honesty of the *date*: a
release row asserts somebody can schedule the work, and for these five nobody can, because the
discharge is a decision about where the product/organisation boundary sits.

- **CEILING (RAP-20/21, AC-11/12, UAH-20, MFA-16): forwarding is not a build this repository
  can schedule — RESOLVED AT 1.0.0 AS A BOUNDARY, NOT A BUILD.** Central logging means the
  record survives compromise of the system that produced it, and no in-database trail does.
  The drains are asymmetric (above) and a gate resolving either from a live endpoint is
  refused outright by the hermeticity rule. MFA-16 rides the same remedy because
  `auth.audit_log_entries` carries no append-only layer and none can be added (GoTrue
  re-migrates its schema) — protecting that stream IS forwarding. 1.0.0 records the decision
  the old condition row said someone had to make: the six requirements moved to the
  ORGANISATION boundary with `docs/runbooks/log-forwarding.md` as the owner's recorded
  surface (what to forward per stream, where each platform's drains are, what the sink must
  guarantee), and the register's own organisation-row rules (`outcome: null`, a named owner)
  keep the move honest — nothing was regraded upward, ownership was placed where the
  consoles are.
- **CEILING (RB-02): the manifest needs a deploy-time artefact channel that does not exist.**
  Binding a database backup to the commit, the migration set and the deployed function versions
  requires something emitted at deploy time, and this repository has no deploy-time channel to
  emit it into. Until it does, the requirement is unreachable rather than unscheduled.
- **CEILING (RB-03/05/06/09): the current grade rests on vacuous truth.** "No client role can
  reach a backup" is true here only because this tree produces no backups of its own — absence
  of a surface, which grading rule 2 refuses as a control. Raising it needs a self-produced
  off-platform backup with its own store and IAM policy, which is an operator's decision about
  where the boundary sits and not a build.
- **CEILING (RB-11): an unoffered verb is not a control.** See the immutability bullet above:
  no Delete or Modify action for a backup exists anywhere in the surface, and no immutability,
  WORM or object-lock guarantee is published. Reading an unoffered verb as prevention is the
  inflation this register exists to refuse.
- **CEILING (PA-11, POS-16): no support flag exists in any artefact this tree contains —
  RESOLVED AT 1.0.0 AS A REVIEWED REGISTER, NOT A PROBE.** PA-13 discharged because npm
  publishes `deprecated` into the lockfile. The online services (Supabase, Vercel, GitHub
  Actions, npm, EAS) and the platforms (runner image, Node major, Postgres major, mobile
  target SDKs) publish no equivalent, and asking their APIs is refused by the hermeticity
  rule. 1.0.0 records the decision the old condition row said someone had to make:
  `tools/support-register.json` carries each subject's disposition as the VENDOR'S OWN dated
  statement (url + quote + fetchedOn) or an honest permanent ceiling — the fact that a
  vendor publishes no lifecycle, recorded so it cannot read as an omission. The clockless
  half (shape + the platform-fact closure against the tree's own Postgres/Node pins) rides
  `version-sync`; the reviewedUntil lapse rides the scheduled `floor-review` job. The
  double-count refusal survives: POS-15 keeps `framework-floor.json`, and PA-11/POS-16 are
  graded on the NEW artefact alone (alternate-control, assessorMayRefuse — a register
  documents support, it cannot perform ASD's "removed/replaced").

### Shelf life — **the deadline row this section owes**

ASD opened consultation on **15 June 2026** to replace the Essential Eight with an ISM-grounded
*Essentials* series, citing the cloud gap explicitly — reported at roughly twelve months to
deprecation and twenty-four to retirement. The stated reason for the change *is* the
product-versus-organisation mismatch this section opens with. Carried as the obligations row
**`conformance-e8-retirement` (calendar, 2027-06-15)**, judged in the scheduled lane so a
verdict that changes with the calendar never fails a pull request.

### The adjacency — **the ISM, assessed via IRAP — no date, deliberately**

The instrument ASD designed to grade a *product* is the **ISM**, assessed via **IRAP**, and the
harness already satisfies much of its *Guidelines for software development* and *Guidelines for
database systems* — the same guidelines the Essential Eight tags `N/A` throughout. That is
recorded here as a **disposition, not a target**, and it carries **no date** for the same reason
the conformance map below carried none until 1.0.0 built it: dating it without intending to build
it next is the commitment this file exists to prevent.

---

---

## The conformance map — RESOLVED at 1.0.0, built whole

Through 0.11.1 this section was titled *What this file deliberately does not contain*, and the
thing it did not contain was a conformance **map** — `tools/conformance-map.json`, gates to
ASVS/MASVS requirement ids. It was the artifact an enterprise buyer asks for by name and the one
thing in W5 that must not be shipped partially: a claimed level with an unmapped requirement is
worse than no claim, and CRA's harmonised standards running late meant there was no presumption
of conformity to anchor it to. It carried **no date** here, deliberately, with the condition
that when built it would be built whole, against Annex I directly rather than against a
standard that has not landed.

**Disposition: RESOLVED at 1.0.0, on that paragraph's own terms — and with one correction.**
`tools/conformance-map.json` ships whole: every requirement of OWASP ASVS 5.0.0, OWASP MASVS
2.1 and CRA Annex I, text verbatim, each graded `covered | partial | not-covered |
not-applicable` against the tree — 392 rows, nothing partial, nothing sampled. The correction is
the ASVS count: the planning figure the 1.0.0 research pass started from was **369**, and the
source at tag **v5.0.0 has 345** requirements across 17 chapters; the register's `expectedCounts` asserts
345 by chapter AND by level, and its header records the wrong figure so nobody re-derives it.
The CRA rows are mapped against Annex I directly, as this paragraph required, and carry a shelf
life: no harmonised standard had been cited in the Official Journal as of the verified date
(2026-08-16), tracked as the calendar row `conformance-cra-hens-citation`.

**What was resolved is the MAP, not a LEVEL — and the distinction this section drew stays
sharp.** The 0.9.9 Essential Eight register could not claim a maturity level because ASD's model
offers none to a product; the 1.0.0 map claims no verification level for a stronger reason it
enforces on itself: a level attaches to a verification *of an application* performed by an
assessor, CRA conformity is a manufacturer's legal act no code tree performs, and the map's own
gate (`tools/check-conformance-map.mjs`, third script of `docs-sync`) reds any note, negative
proof or header line that says otherwise, through the same standards-claim judgement
`scripts/hygiene.mjs` sweeps the shipped prose with. What the map states instead is the honest
ledger — which live control bears on which requirement, how far it reaches (`covered` may not
rest on documentation alone), what is left, which rows are conditional on an opt-in module (8),
and which only the operating organisation can meet (39, enumerated rather than graded up). The
two documents the earlier obligation described as *generatable* — the controls crosswalk and the
threat model — are generated from it (`tools/gen-conformance-docs.mjs`) and regen-diffed by the
same gate, so a hand edit to either is a claim nobody reviewed.
