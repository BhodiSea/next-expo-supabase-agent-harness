#!/usr/bin/env node
// Gate: suppressions — the inline-directive census over the product tree.
//
// THE HOLE THIS CLOSES. Every checker that runs inside ESLint can be switched off by
// the directive it cannot police: a rule-LESS `eslint-disable` applies to every rule
// id INCLUDING `local/no-suppressed-complexity` itself, so the report is filtered
// before it surfaces (proven against the real Linter — tools/eslint-rules/index.mjs
// records the attempt). Policing the off-switch needs a scanner OUTSIDE ESLint, and
// that scanner is this file. The factory-side complement has existed since 0.5.0
// (scripts/check-escape-registry.mjs censuses the reviewed-FILE escapes); this is the
// consumer-side inline-directive half.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT. It proves — statically, over the raw text of
// the product tree (apps/, packages/, supabase/) — that (1) no rule-less
// `eslint-disable` form and no `@ts-ignore`/`@ts-nocheck` exists anywhere; (2) every
// surviving directive names its rule AND carries an inline reason of substance
// (eslint's native `-- <reason>` suffix, biome-ignore's native `: <explanation>`,
// `@ts-expect-error <description>`); and (3) the census closes BOTH WAYS against the
// seeded register tools/suppressions-allow.json — a file carrying directives with no
// row is a suppression nobody reviewed, and a row naming directives the tree no
// longer carries is a stale acceptance (the tools/eol.json direction). It does NOT
// judge whether a reason is TRUE (that is the reviewer's half), does not police
// `-- harness-allow-dml:` markers (check-migrations.mjs owns their reason rule; they
// are counted here only so the OK line states the whole escape surface), and does not
// reach tools/** — harness-owned suppressions are the factory ratchet's subject
// (scripts/check-complexity-ratchet.mjs re-lints with --no-inline-config).
//
// WHY RELEASE-CLOCKLESS. The ASD intent this step cites (dated, expiring exceptions)
// is carried by the both-ways closure rather than by calendar dates: a suppression
// cannot outlive its site (the stale-row direction), and adding one is a two-place
// act — the inline reason at the site plus the register row on the write-guarded
// tools/ surface — so every widening lands in a reviewed diff. A calendar review-by
// date would make `pnpm validate`'s verdict change with the day, which no chain step
// may do.
// SOURCE: docs/harness/gates-catalog.md ("suppressions") [corpus: harness/doctrine]
import { existsSync, readFileSync } from 'node:fs'
import { walkFiles } from './lib/fs-walk.mjs'
import { fail, failures, ok, rampNote, skipOrFail } from './lib/gate.mjs'

const GATE = 'suppressions'
const REGISTER = 'tools/suppressions-allow.json'
const ROOTS = ['apps', 'packages', 'supabase']
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.next',
  '.expo',
  '.turbo',
  'coverage',
  'dist',
  'generated',
  'test-results',
  '.git',
])
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const GENERATED_FILE = /\.generated\.|routes\.generated\./

// Directive grammars. eslint's reason separator is ` -- `; biome's is `: `;
// ts-expect-error's is free text after the tag. The MIN_REASON floor is about
// substance, not prose quality: "temp" and "fix later" are what it exists to refuse.
const MIN_REASON = 20
const ESLINT_DIRECTIVE = /eslint-disable(?:-next-line|-line)?(?![a-z-])([^\n*]*)/g
const BIOME_DIRECTIVE = /biome-ignore\s+([^\n*]*)/g
const TS_DIRECTIVE = /@ts-(ignore|nocheck|expect-error)\b([^\n]*)/g

const presentRoots = ROOTS.filter((r) => existsSync(r))
if (presentRoots.length === 0) {
  skipOrFail(GATE, `none of ${ROOTS.join(', ')} exists (no product surface yet)`)
}

let register = null
if (existsSync(REGISTER)) {
  try {
    register = JSON.parse(readFileSync(REGISTER, 'utf8'))
  } catch (e) {
    fail(
      GATE,
      `${REGISTER} is not valid JSON (${e.message}) — it is the reviewed suppression register, so an unreadable one fails CLOSED rather than un-reviewing every directive; restore it from git history`,
    )
  }
}

const errs = []

// ── 1. THE SCAN ──────────────────────────────────────────────────────────────────────
// found: Map<file, Map<"family rule", count>> — what the tree actually carries.
const found = new Map()
let directiveCount = 0
let dmlMarkerCount = 0

function recordHit(file, family, rule) {
  directiveCount += 1
  const key = `${family} ${rule ?? ''}`
  const byKey = found.get(file) ?? new Map()
  byKey.set(key, (byKey.get(key) ?? 0) + 1)
  found.set(file, byKey)
}

for (const root of presentRoots) {
  for (const rel of walkFiles(root, { excludeDirs: EXCLUDED_DIRS })) {
    const file = `${root}/${rel}`
    if (GENERATED_FILE.test(rel)) continue
    if (rel.endsWith('.sql')) {
      // Censused, not re-policed: check-migrations.mjs owns the reason rule for
      // `-- harness-allow-dml:`; the count keeps the OK line honest about the
      // whole escape surface.
      const sql = readFileSync(file, 'utf8')
      dmlMarkerCount += (sql.match(/--\s*harness-allow-dml:/g) ?? []).length
      continue
    }
    if (!SOURCE_EXT.test(rel)) continue
    const text = readFileSync(file, 'utf8')
    if (!/eslint-disable|biome-ignore|@ts-(?:ignore|nocheck|expect-error)/.test(text)) continue

    for (const m of text.matchAll(ESLINT_DIRECTIVE)) {
      const tail = (m[1] ?? '').replace(/\*\/.*$/, '')
      const [rulePart, ...reasonParts] = tail.split(' -- ')
      const rules = (rulePart ?? '')
        .split(',')
        .map((r) => r.trim())
        .filter((r) => /^[@a-z0-9/_-]+$/i.test(r) && r !== '')
      if (rules.length === 0) {
        errs.push(
          `${file}: a rule-LESS eslint-disable directive — it switches off EVERY rule, including the ones that police suppression itself, and no review can license "everything". Name the rule(s): \`eslint-disable-next-line <rule> -- <reason>\`.`,
        )
        continue
      }
      const reason = reasonParts.join(' -- ').trim()
      if (reason.length < MIN_REASON) {
        errs.push(
          `${file}: eslint-disable for ${rules.join(', ')} carries no inline reason of substance (\` -- <reason>\`, >= ${String(MIN_REASON)} chars) — the site is where the next reader meets the suppression, and a bare directive tells them nothing.`,
        )
      }
      for (const rule of rules) recordHit(file, 'eslint-disable', rule)
    }

    for (const m of text.matchAll(BIOME_DIRECTIVE)) {
      const tail = (m[1] ?? '').replace(/\*\/.*$/, '')
      const colon = tail.indexOf(':')
      const rule = (colon === -1 ? tail : tail.slice(0, colon)).trim()
      const explanation = colon === -1 ? '' : tail.slice(colon + 1).trim()
      if (rule === '') {
        errs.push(
          `${file}: a biome-ignore directive naming no rule — biome's own grammar is \`biome-ignore <rule>: <explanation>\`; a ruleless form is refused for the same reason a rule-less eslint-disable is.`,
        )
        continue
      }
      if (explanation.length < MIN_REASON) {
        errs.push(
          `${file}: biome-ignore for ${rule} carries no explanation of substance (\`: <explanation>\`, >= ${String(MIN_REASON)} chars).`,
        )
      }
      recordHit(file, 'biome-ignore', rule)
    }

    for (const m of text.matchAll(TS_DIRECTIVE)) {
      const kind = m[1]
      if (kind === 'ignore' || kind === 'nocheck') {
        errs.push(
          `${file}: @ts-${kind} — it suppresses unconditionally and never expires. Use @ts-expect-error with a description: it self-reports the moment the error it excuses goes away.`,
        )
        continue
      }
      const description = (m[2] ?? '').replace(/\*\/.*$/, '').trim()
      if (description.length < MIN_REASON) {
        errs.push(
          `${file}: @ts-expect-error carries no description of substance (>= ${String(MIN_REASON)} chars) — the directive names no rule, so the description is the only record of what is being excused.`,
        )
      }
      recordHit(file, 'ts-expect-error', null)
    }
  }
}

// ── 2. THE REGISTER, closed both ways ────────────────────────────────────────────────
const rows = Array.isArray(register?.files) ? register.files : []
const rowByFile = new Map()
for (const row of rows) {
  const file = String(row?.file ?? '')
  if (rowByFile.has(file)) {
    errs.push(
      `${REGISTER} carries two rows for ${file} — one file, one row; a duplicate is where two reviews disagree and nothing notices.`,
    )
  }
  rowByFile.set(file, row)
  if (String(row?.why ?? '').trim().length < 40) {
    errs.push(
      `${REGISTER} row for ${file} has a \`why\` under 40 characters — the register is the REVIEW record; the inline suffix says what each site excuses, the row says why the file is licensed to carry suppressions at all.`,
    )
  }
}

// Tree -> register: every file carrying directives needs a row that matches exactly.
for (const [file, byKey] of found) {
  const row = rowByFile.get(file)
  if (row === undefined) {
    errs.push(
      `${file} carries inline suppression directive(s) with no ${REGISTER} row — something was suppressed and nobody recorded the review. Add a row {file, directives:[{family, rule, count}], why} (write-guarded: adding one is a reviewed act).`,
    )
    continue
  }
  const declared = new Map()
  for (const d of Array.isArray(row.directives) ? row.directives : []) {
    declared.set(`${String(d?.family ?? '')} ${d?.rule ?? ''}`, Number(d?.count ?? 0))
  }
  for (const [key, count] of byKey) {
    const [family, rule] = key.split(' ')
    const want = declared.get(key)
    if (want === undefined) {
      errs.push(
        `${file} carries ${String(count)}x ${family}${rule ? ` (${rule})` : ''} but its ${REGISTER} row does not declare that directive — the census is exact so a new suppression cannot ride an old review.`,
      )
    } else if (want !== count) {
      errs.push(
        `${file} carries ${String(count)}x ${family}${rule ? ` (${rule})` : ''} but ${REGISTER} declares ${String(want)} — counts are part of the census: a second site under a one-site review is an unreviewed suppression.`,
      )
    }
  }
  for (const [key, want] of declared) {
    if (!byKey.has(key)) {
      const [family, rule] = key.split(' ')
      errs.push(
        `${REGISTER} row for ${file} declares ${String(want)}x ${family}${rule ? ` (${rule})` : ''} that the file no longer carries — a stale acceptance reads as a live review; delete the directive entry (or the row) in the same diff that removed the site.`,
      )
    }
  }
}

// Register -> tree: a row for a file with no directives (or no file) is stale.
for (const [file] of rowByFile) {
  if (!existsSync(file)) {
    errs.push(
      `${REGISTER} names ${file}, which is not a file in this tree — a row that outlives its file is a review of nothing.`,
    )
  } else if (!found.has(file)) {
    errs.push(
      `${REGISTER} names ${file}, which carries no suppression directive — the register closes both ways, so a row whose directives went away must go with them.`,
    )
  }
}

// ── the 1.0.0 ramp ───────────────────────────────────────────────────────────────────
// An install seeded before 1.0.0 may carry its own directive shapes in its own
// packages tree — hard-redding those on the update that delivered the scanner is the
// ambush the ramp doctrine exists for. One release of dated NOTEs to reason each
// site and seed the register; the deadline rides the rampNote call below.
if (
  errs.length > 0 &&
  rampNote(GATE, '1.0.0', 'the inline-suppression census over the product tree', {
    until: '1.1.0',
  })
) {
  console.log(`${GATE}: NOTE — ${String(errs.length)} finding(s) withheld by the 1.0.0 ramp:`)
  for (const e of errs) console.log(`  - ${e}`)
  ok(GATE, 'NOTE-only on this pre-1.0.0 install — the NOTE above carries the derived deadline')
}

if (register === null) {
  fail(
    GATE,
    `${REGISTER} is missing — it is the reviewed suppression register this gate closes against. Pull the seeded exemplar with \`npx next-expo-supabase-agent-harness update --refresh-seeded ${REGISTER}\`; its shipped state matches the scaffold's own directives exactly.`,
  )
}

failures(
  GATE,
  errs,
  `Each finding is a suppression decision: delete the directive, or reason it inline AND record it in ${REGISTER} (write-guard-protected, so every widening lands in a PR diff where somebody can see it).`,
)
ok(
  GATE,
  `${String(directiveCount)} inline directive(s) across ${String(found.size)} file(s), every one rule-named, reasoned, and census-matched both ways against ${REGISTER} (${String(rows.length)} row(s)); ${String(dmlMarkerCount)} harness-allow-dml marker(s) censused (reason rule owned by check-migrations)`,
)
