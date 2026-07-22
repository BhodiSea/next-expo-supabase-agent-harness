#!/usr/bin/env node
// check-rule-integrity (G28, config-driven half) — every architecture/import rule the harness
// ships is still present and unweakened.
//
// The canary registry proves a GATE SCRIPT can go red. But several validate steps are
// "runner-kind": their proof is only that the runner propagates a vendor tool's exit code
// (validate-runner.test.mjs). It does NOT prove that any individual eslint/depcruise RULE fires.
// Delete `mobile-not-into-server` from the depcruise config, or the expo-secure-store ban from
// eslint, and the architecture/lint gates still run and still exit 0 — the boundary is gone and
// nothing says so. cognitive-complexity is the exception: scripts/check-complexity-ratchet.mjs
// re-lints with --no-inline-config, so disabling that rule empties the measured set and reds the
// ratchet.
//
// This closes the rest. It reads the SHIPPED configs, hashes each depcruise forbidden rule's full
// definition, and asserts the eslint config text is unchanged, comparing against
// scripts/rule-integrity.json. Deleting a rule reds; NARROWING a from/to regex until it matches
// nothing reds (the hash changes); a new unregistered rule reds.
//
//   node scripts/check-rule-integrity.mjs           # the gate (machinery-lint, blocking)
//   node scripts/check-rule-integrity.mjs --write    # re-record after a REVIEWED config change
//
// The comparison lives in scripts/lib/rule-integrity.mjs so it can be proven red as a pure
// function (tests/gates/check-rule-integrity.test.mjs).
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { compareRules, hashText, hashValue, ruleHash } from './lib/rule-integrity.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const RECORD = 'scripts/rule-integrity.json'
const DEPCRUISE = 'template/base/dependency-cruiser.cjs'
const ESLINT = 'template/base/eslint.config.mjs'
const WRITE = process.argv.includes('--write')

// The depcruise config is plain CJS with no plugin imports, so it loads cleanly — the forbidden
// rules AND the scan `options` (exclude/doNotFollow, which bound WHAT gets scanned). The eslint
// config imports consumer-only plugins (typescript-eslint, eslint-plugin-react-native,
// react-native-a11y, react-hooks, …) not installed at the repo root, so it cannot be imported and
// is hashed as TEXT: a substring check missed a ban weakened by a severity flip or a scope
// broadening, so the whole file text is pinned instead.
const depcruiseConfig = require(`${ROOT}${DEPCRUISE}`)
const depcruise = depcruiseConfig.forbidden ?? []
const depcruiseOptions = depcruiseConfig.options ?? {}
const eslintText = readFileSync(`${ROOT}${ESLINT}`, 'utf8')

if (WRITE) {
  const record = existsSync(`${ROOT}${RECORD}`)
    ? JSON.parse(readFileSync(`${ROOT}${RECORD}`, 'utf8'))
    : {}
  const next = {
    '//':
      record['//'] ??
      'Integrity record for the config-driven boundary rules (G28): the depcruise forbidden rules + scan options (architecture/dead-code gates) and the FULL eslint config text (lint gate, incl. the restricted-imports/globals bans). A deleted, edited, scope-starved, or severity-flipped rule is a silently no-op\'d boundary the runner-kind canaries cannot see. Regenerate with `node scripts/check-rule-integrity.mjs --write` ONLY after a reviewed config change. cognitive-complexity is separately canaried by scripts/check-complexity-ratchet.mjs.',
    depcruise: Object.fromEntries(depcruise.map((r) => [r.name, ruleHash(r)])),
    depcruiseOptions: hashValue(depcruiseOptions),
    eslintConfigSha: hashText(eslintText),
  }
  writeFileSync(`${ROOT}${RECORD}`, `${JSON.stringify(next, null, 2)}\n`)
  console.log(
    `RULE INTEGRITY: wrote ${RECORD} (${String(depcruise.length)} depcruise rule(s) + options; eslint config text pinned)`,
  )
  process.exit(0)
}

if (!existsSync(`${ROOT}${RECORD}`)) {
  console.error(`RULE INTEGRITY: ${RECORD} missing — seed it with \`node scripts/check-rule-integrity.mjs --write\``)
  process.exit(1)
}

const record = JSON.parse(readFileSync(`${ROOT}${RECORD}`, 'utf8'))
const problems = compareRules({ depcruise, depcruiseOptions, eslintText }, record)

if (problems.length > 0) {
  console.error(`RULE INTEGRITY: ${String(problems.length)} problem(s):`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nThese are the boundary rules the runner-kind canaries cannot see fire. A deletion or a ' +
      'narrowed regex here is a security or architecture boundary going quietly no-op.',
  )
  process.exit(1)
}

console.log(
  `RULE INTEGRITY: CLEAN (${String(Object.keys(record.depcruise ?? {}).length)} depcruise rule(s) + scan options unchanged; ` +
    'eslint config text unchanged)',
)
