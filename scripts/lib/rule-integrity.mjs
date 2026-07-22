// The comparison behind the config-rule integrity check (G28), split from the script that
// reads the configs so it can be tested as a pure function: an observed rule-set + a committed
// record in, problems out.
import { createHash } from 'node:crypto'

/** A stable 12-hex digest of any JSON-serialisable value. */
export function hashValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12)
}

/** A stable 12-hex digest of file text (line endings normalised so CRLF checkouts don't flap). */
export function hashText(text) {
  return createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex').slice(0, 12)
}

/** A stable digest of a depcruise rule's FULL definition (name + severity + from + to). */
export function ruleHash(rule) {
  return hashValue(rule)
}

/**
 * Compare the depcruise forbidden rules, the depcruise SCAN OPTIONS, and the eslint config text
 * against the committed record. Four ways to red — each closing a hole the adversarial review of
 * the source harness's v0.1.6 confirmed was open:
 *
 *   - A recorded depcruise rule is GONE (deleted) — the "silently no-op'd rule" G28 names: the
 *     gate still runs and exits 0.
 *   - A depcruise rule CHANGED (hash mismatch) — a narrowed from/to regex neuters a rule while
 *     keeping its name.
 *   - The depcruise OPTIONS changed — `exclude`/`doNotFollow`/`includeOnly` shrink the SCANNED
 *     SET, so a rule can be neutered by starving it of files without touching any rule object
 *     (every ruleHash stays identical). This is why the options are hashed separately.
 *   - The eslint config text changed — the import bans were previously checked by bare
 *     substring, which caught a deleted `group:` array but NOT a severity flipped to 'off' or a
 *     `files`/`ignores` scope broadened to match nothing (both leave the substring intact). The
 *     whole config text is hashed instead, so any weakening reds; the reviewer reads the diff.
 *
 * A NEW depcruise rule the record does not know also reds (register it) — the record cannot
 * silently fall behind the config it vouches for.
 */
export function compareRules({ depcruise, depcruiseOptions, eslintText }, record) {
  const problems = []

  const observed = new Map(depcruise.map((r) => [r.name, ruleHash(r)]))
  const recorded = new Map(Object.entries(record.depcruise ?? {}))

  for (const [name, hash] of recorded) {
    if (!observed.has(name)) {
      problems.push(
        `depcruise rule '${name}' is in the integrity record but GONE from the config — a deleted ` +
          'architecture rule is a silently no-op\'d boundary: the gate still runs and exits 0. Restore it, ' +
          'or drop it from the record in a reviewed commit if the removal is intended.',
      )
    } else if (observed.get(name) !== hash) {
      problems.push(
        `depcruise rule '${name}' CHANGED (${hash} -> ${observed.get(name)}). A narrowed from/to regex ` +
          'can neuter a rule while keeping its name, so any edit to a boundary rule is reviewed: re-record with ' +
          '`node scripts/check-rule-integrity.mjs --write` once you have confirmed the change is intended.',
      )
    }
  }
  for (const name of observed.keys()) {
    if (!recorded.has(name)) {
      problems.push(
        `depcruise rule '${name}' exists in the config but is NOT in the integrity record — register it ` +
          '(`node scripts/check-rule-integrity.mjs --write`) so the record cannot fall behind the rules it protects.',
      )
    }
  }

  if (record.depcruiseOptions !== undefined && hashValue(depcruiseOptions ?? {}) !== record.depcruiseOptions) {
    problems.push(
      "depcruise OPTIONS changed (exclude / doNotFollow / includeOnly). These bound the SCANNED SET, " +
        'so shrinking them neuters every architecture rule at once WITHOUT changing any rule object — the ' +
        'rule hashes above would all still match. Review the diff; re-record with --write if intended.',
    )
  }

  if (record.eslintConfigSha !== undefined && hashText(eslintText) !== record.eslintConfigSha) {
    problems.push(
      'template/base/eslint.config.mjs changed. Its boundary bans (the api-client fetch one-door, ' +
        'the secure-store keychain seam, the chart-library ban) can be weakened WITHOUT deleting the banned ' +
        "`group:` or restricted global — flip the severity to 'off', or broaden `files`/`ignores` so the " +
        'block matches no files. A substring check misses both, so the whole config is hashed. Review the ' +
        'diff for a weakened ban; re-record with --write if intended.',
    )
  }

  return problems
}
