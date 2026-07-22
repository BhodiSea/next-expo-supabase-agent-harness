// Retrofit merge for package.json. Never clobbers: an existing, different
// script keeps its body and ours lands under harness:<name>; existing dep
// ranges are kept (with a floor warning), never downgraded.
export function mergePackageJson(existing, incoming) {
  /** @type {{ kind: string, name: string, existing?: string, incoming?: string, tested?: string, range?: string }[]} */
  const report = []
  const merged = structuredClone(existing)

  merged.scripts ??= {}
  let validateName = 'validate'
  for (const [name, cmd] of Object.entries(incoming.scripts ?? {})) {
    const current = merged.scripts[name]
    if (current === undefined) {
      merged.scripts[name] = cmd
      report.push({ kind: 'script-added', name })
    } else if (current === cmd) {
      report.push({ kind: 'script-identical', name })
    } else {
      merged.scripts[`harness:${name}`] = cmd
      report.push({ kind: 'script-conflict', name, existing: current, incoming: cmd })
      if (name === 'validate') validateName = 'harness:validate'
    }
  }

  for (const field of ['dependencies', 'devDependencies']) {
    merged[field] ??= {}
    for (const [dep, range] of Object.entries(incoming[field] ?? {})) {
      const current = merged[field][dep] ?? merged.dependencies?.[dep] ?? merged.devDependencies?.[dep]
      if (current === undefined) {
        merged[field][dep] = range
        report.push({ kind: 'dep-added', name: dep, range })
      } else if (!rangeCovers(current, range)) {
        report.push({ kind: 'dep-mismatch', name: dep, existing: current, tested: range })
      }
    }
  }

  merged.packageManager ??= incoming.packageManager
  merged.engines ??= incoming.engines

  return { merged, report, validateName }
}

// Cheap semver-floor check: does the project's range plausibly include our
// tested minimum? Compares major versions of the leading version literal.
function rangeCovers(existingRange, testedRange) {
  const major = (r) => {
    const m = String(r).match(/(\d+)/)
    return m ? Number(m[1]) : null
  }
  const a = major(existingRange)
  const b = major(testedRange)
  if (a === null || b === null) return true // exotic ranges: trust the project
  return a >= b
}
