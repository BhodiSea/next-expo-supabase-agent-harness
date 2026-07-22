// Install/update report: human text by default, machine JSON with --report json.
export function printReport(report, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return report.conflicts.length === 0 && report.drift.length === 0 ? 0 : 2
  }
  const { written = [], skipped = [], conflicts = [], drift = [], notes = [] } = report
  console.log(`\n${report.title}`)
  console.log(`  written: ${written.length} file(s)`)
  if (skipped.length) console.log(`  skipped (project-owned): ${skipped.length}`)
  for (const c of conflicts) {
    console.log(`  CONFLICT ${c.path ?? c.name}: ${c.detail}`)
  }
  for (const d of drift) {
    console.log(`  DRIFT ${d.path}: local edits preserved; incoming saved to ${d.pending}`)
  }
  for (const n of notes) console.log(`  note: ${n}`)
  if (conflicts.length || drift.length) {
    console.log('\nResolve the items above, then run `doctor` to confirm a clean install.')
    return 2
  }
  return 0
}
