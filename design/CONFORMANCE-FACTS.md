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

**Disposition: SBOM consumption is deferred, undated.** The differentiating control was never
producing an SBOM — it is **consuming** one: diffing against the previous release tag and
redding on an *added* component that is not allowlisted. That is a real gate and it is not
small, and dating it here without intending to build it next would be the kind of commitment
this file exists to prevent.

---

## What this file deliberately does not contain

A conformance **map** — `tools/conformance-map.json`, gates to ASVS/MASVS requirement ids with a
claimed level. It is the artifact an enterprise buyer asks for by name, and it is the one thing
in W5 that must not be shipped partially: a claimed level with an unmapped requirement is worse
than no claim, and CRA's harmonised standards running late means there is no presumption of
conformity to anchor it to either. It carries **no date** here, deliberately. When it is built it
will be built whole, against Annex I directly rather than against a standard that has not landed.
