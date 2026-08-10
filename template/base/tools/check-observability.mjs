#!/usr/bin/env node
// Gate: observability — vendor telemetry containment. No telemetry SDK import outside a
// declared sink, and every declared sink behind the redaction pass.
//
// THE SENTENCE THIS ENFORCES. packages/platform/observability/src/index.ts ships the
// seam with its invariant as header contract: "NO VENDOR SDK, on purpose. A crash
// reporter or a tracing agent is a MODULE… and it attaches HERE, at the sink, behind
// the redaction pass. That ordering is the whole design: a vendor transport added later
// cannot see a raw value, because by the time a record reaches a sink it has already
// been through `redactFields`." Declared in 0.7.0 as the enforcement-tiers row for this
// gate (deferred MACHINE-HELD, Target 0.8.0); this file is the discharge.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT. It proves — statically, from import specifiers —
// that no vendor telemetry SDK is imported anywhere under apps/, packages/ or
// supabase/functions/ except in files the reviewed sinks[] register names, and that each
// registered sink file references its declared redaction symbol in code (comments
// blanked — a symbol named in prose satisfies nothing). It does NOT prove that a vendor
// call's ARGUMENT flowed through the redaction function (no call graph), that a vendor
// SDK is unreachable through a transitive dependency, or that raw `fetch()` to an ingest
// endpoint never happens; the redaction pass's BEHAVIOR stays the `unit` lane's
// (index.test.ts). Stated per the enforcement-tiers Covers / Does NOT cover discipline.
//
// THE POLICY IS SEEDED, THE DETECTOR IS FLOORED. tools/observability.json is the
// consumer's sink register (adding a row is licensing a telemetry egress path — a
// reviewed act), so it is seeded and planted-when-absent. The gate reds when its
// vendorSpecifiers list is missing any entry of the shipped REQUIRED_VENDOR_FLOOR
// (tools/lib/observability.mjs, owned — detector improvements ride `update`): a
// detector the beneficiary can narrow is an escape, not a control.
// SOURCE: docs/harness/gates-catalog.md ("observability") [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'
import {
  collectVendorImports,
  isBuildConfigFile,
  REQUIRED_REDACTION_FLOOR,
  REQUIRED_VENDOR_FLOOR,
  referencesSymbol,
  scanFiles,
} from './lib/observability.mjs'

const GATE = 'observability'
const POLICY = 'tools/observability.json'
const ROOTS = ['apps', 'packages', 'supabase/functions']

const presentRoots = ROOTS.filter((r) => existsSync(r))
if (presentRoots.length === 0) {
  skipOrFail(GATE, `none of ${ROOTS.join(', ')} exists (no product surface yet)`)
}

let policy = null
if (existsSync(POLICY)) {
  try {
    policy = JSON.parse(readFileSync(POLICY, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${POLICY} is not valid JSON (${e.message}) — it is the reviewed sink register, so an unreadable one fails CLOSED rather than un-declaring every sink; restore it from git history`,
    )
  }
}

const errs = []

// ── 1. THE DETECTOR, floored ─────────────────────────────────────────────────────────
// The policy's list is the one in force (a consumer may EXTEND it for a vendor the
// floor has never heard of); the shipped floor is the minimum it may say. Absent or
// malformed policy falls back to the floor so the scan below still judges something —
// the missing-register finding itself lands after the ramp, like data-flow's.
const declared = Array.isArray(policy?.vendorSpecifiers) ? policy.vendorSpecifiers : null
const detector = declared !== null && declared.length > 0 ? declared : REQUIRED_VENDOR_FLOOR
if (policy !== null) {
  for (const entry of REQUIRED_VENDOR_FLOOR) {
    if (!detector.includes(entry)) {
      errs.push(
        `${POLICY} vendorSpecifiers is missing the shipped floor entry ${JSON.stringify(entry)} — the detector may be extended, never narrowed: a vendor the gate has been told to forget is an unwatched egress path. Restore the entry (the floor is REQUIRED_VENDOR_FLOOR in tools/lib/observability.mjs).`,
      )
    }
  }
  if (!Array.isArray(policy.sinks)) {
    errs.push(
      `${POLICY} sinks must be an array (empty is the shipped state: no vendor transport wired).`,
    )
  }
  // The redaction list is floored and shape-checked the same way (0.9.0): it is
  // SEEDED and consumer-extendable — module patches append their own symbols —
  // but a list that loses the seam's own pass, or degenerates into empty strings,
  // is a register every sink row can satisfy while sitting in front of nothing.
  const declaredSymbols = policy.redactionSymbols
  if (
    !Array.isArray(declaredSymbols) ||
    declaredSymbols.length === 0 ||
    declaredSymbols.some((s) => typeof s !== 'string' || s.trim() === '')
  ) {
    errs.push(
      `${POLICY} redactionSymbols must be a non-empty array of non-empty strings — it is the closed list of passes a sink may declare, and a malformed list lets a sink row point at nothing.`,
    )
  } else {
    for (const entry of REQUIRED_REDACTION_FLOOR) {
      if (!declaredSymbols.includes(entry)) {
        errs.push(
          `${POLICY} redactionSymbols is missing the shipped floor entry ${JSON.stringify(entry)} — the list may be extended (module patches append their own symbols), never narrowed: the seam's own pass is the design the register encodes. Restore the entry (the floor is REQUIRED_REDACTION_FLOOR in tools/lib/observability.mjs).`,
        )
      }
    }
  }
}

// ── 2. THE SCAN ──────────────────────────────────────────────────────────────────────
const files = scanFiles(presentRoots)
if (files.length === 0) {
  fail(
    GATE,
    `zero source files found under ${presentRoots.join(', ')} — a containment verdict over nothing is vacuous, and an empty scan here means the roots moved out from under the gate (the check-secrets anti-vacuity rule)`,
  )
}
const found = collectVendorImports(files, detector)

// ── 3. EVERY VENDOR IMPORT IS A DECLARED SINK ────────────────────────────────────────
const sinks = Array.isArray(policy?.sinks) ? policy.sinks : []
const sinkByFile = new Map(sinks.map((s) => [String(s.file ?? ''), s]))
for (const hit of found) {
  if (sinkByFile.has(hit.file)) continue
  const registerMove = isBuildConfigFile(hit.file)
    ? `register the file in ${POLICY} sinks[] with kind "buildConfig" and a reason (a build-config vendor require is a bundler plugin registration — it transports no event, so that kind carries no redaction symbol)`
    : `register the file in ${POLICY} sinks[] with its redaction symbol and a reason`
  errs.push(
    `${hit.file}:${String(hit.line)} imports ${JSON.stringify(hit.specifier)} (vendor telemetry: ${hit.entry}) and is not a declared sink. A transport outside the seam sees values the redaction pass never touched. Either remove the import — the sanctioned wiring is the crash-reporting/observability module patches, which attach at the seam's LogSink — or ${registerMove}.`,
  )
}

// ── 4. THE REGISTER IS LIVE, both directions, and each sink sits BEHIND the pass ─────
const redactionSymbols = Array.isArray(policy?.redactionSymbols) ? policy.redactionSymbols : []
const vendorFiles = new Set(found.map((h) => h.file))
for (const sink of sinks) {
  const file = String(sink.file ?? '')
  if (!existsSync(file)) {
    errs.push(
      `${POLICY} sinks[] names ${file}, which is not a file in this tree — a stale sink entry reads as a reviewed egress path and licenses nothing.`,
    )
    continue
  }
  if (!vendorFiles.has(file)) {
    errs.push(
      `${POLICY} sinks[] names ${file}, which imports no vendor telemetry SDK the detector knows — the register is closed both ways, so an entry whose import went away must go with it.`,
    )
  }
  for (const v of sink.vendors ?? []) {
    if (!detector.includes(v)) {
      errs.push(
        `${POLICY} sinks[] entry for ${file} licenses vendor ${JSON.stringify(v)}, which is not in vendorSpecifiers — a sink for a vendor the detector cannot see is incoherent; add the detector entry in the same diff.`,
      )
    }
  }
  // `kind: "buildConfig"` (0.9.0): a bundler plugin registration in a build-config
  // file transports no event, so the redaction-symbol requirement does not apply —
  // but ONLY to the small fixed set of build-config filenames, and only to that
  // declared kind. Any other kind value licenses nothing.
  const kind = sink.kind
  if (kind !== undefined && kind !== 'buildConfig') {
    errs.push(
      `${POLICY} sinks[] entry for ${file} has kind ${JSON.stringify(kind)}, which the register schema does not define — the only declared kind is "buildConfig" (a build-config file whose vendor require is a bundler plugin registration); an unknown kind licenses nothing.`,
    )
  } else if (kind === 'buildConfig') {
    if (!isBuildConfigFile(file)) {
      errs.push(
        `${POLICY} sinks[] entry for ${file} declares kind "buildConfig", but only a build-config file (metro.config.js, next.config.*, babel.config.*) may carry that kind — a runtime module transports events, so it sits behind a declared redaction symbol like every other sink.`,
      )
    }
  } else {
    const symbol = String(sink.redaction ?? '')
    if (!redactionSymbols.includes(symbol)) {
      errs.push(
        `${POLICY} sinks[] entry for ${file} declares redaction ${JSON.stringify(sink.redaction ?? null)}, which is not one of redactionSymbols — the pass a sink sits behind must be one the register names.`,
      )
    } else if (!referencesSymbol(readFileSync(file, 'utf8'), symbol)) {
      errs.push(
        `${file} never references its declared redaction symbol \`${symbol}\` in code (comments blanked) — a sink ahead of the redaction pass sees raw values, and the ordering is the whole design (packages/platform/observability/src/index.ts, "NO VENDOR SDK, on purpose").`,
      )
    }
  }
  if (String(sink.reason ?? '').trim().length < 40) {
    errs.push(
      `${POLICY} sinks[] entry for ${file} has a reason under 40 characters — this is the only place a reader learns why an off-device transport for operational data is licensed here.`,
    )
  }
}

// ── the 0.8.0 ramp ───────────────────────────────────────────────────────────────────
// An install seeded before 0.8.0 may have wired a vendor transport by hand (the module
// patch docs predate this gate), and its packages tree is the consumer's own — hard-
// redding it on the update that delivered the scanner is the ambush shape the ramp
// doctrine exists for. One release of dated NOTEs to register or remove each import;
// the escape ends at the `until` deadline the rampNote call below carries (gate.mjs
// prints the derived date — no hand-typed copy of it here to go stale). The comment
// lives HERE and not inside the condition:
// scripts/check-ramp-ledger.mjs reads the line preceding `rampNote(` to decide whether
// the result is consumed, and a comment between `if (` and the call reads to it as a
// discarded result — a ramp that gates nothing.
if (
  errs.length > 0 &&
  rampNote(GATE, '0.8.0', 'the vendor-telemetry containment closure over declared sinks', {
    until: '0.9.0',
  })
) {
  console.log(`${GATE}: NOTE — ${String(errs.length)} finding(s) withheld by the 0.8.0 ramp:`)
  for (const e of errs) console.log(`  - ${e}`)
  ok(GATE, 'NOTE-only on this pre-0.8.0 install — the NOTE above carries the derived deadline')
}

if (policy === null) {
  fail(
    GATE,
    `${POLICY} is missing — it is the reviewed sink register this gate judges against (the scan above ran on the shipped detector floor). Pull the seeded exemplar with \`npx next-expo-supabase-agent-harness update --refresh-seeded ${POLICY}\`; its shipped state declares zero sinks, which is the tree the harness installs.`,
  )
}

failures(
  GATE,
  errs,
  `Each finding is an egress decision: remove the import, or register the sink in ${POLICY} sinks[] (git-clean-enforced by check-gate-integrity.mjs, so every widening lands in a PR diff where somebody can see it).`,
)
ok(
  GATE,
  `${String(files.length)} file(s) scanned, ${String(found.length)} vendor import(s) all inside ${String(sinks.length)} declared sink(s), each runtime sink behind the redaction pass (buildConfig rows carry none — a bundler plugin registration transports no event); detector covers ${String(detector.length)} specifier entr${detector.length === 1 ? 'y' : 'ies'}`,
)
