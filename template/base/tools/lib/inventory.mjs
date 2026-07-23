// Pure serializers for the committed contract inventories (the action inventory + the
// event catalog). Split from the two gen-*.mjs CLIs so the harness suite can test the
// serialization without the tsx loader or the workspace graph — the CLIs do the runtime
// walk (appRouter._def.procedures, listEvents) and hand the plain rows to these.
//
// Both emit `JSON.stringify(rows, null, 2) + '\n'` over rows sorted by their key with
// CODE-UNIT comparison — never localeCompare, which is ICU-version-dependent and cannot
// order a committed, regen-diffed artifact reproducibly (see @app/events listEvents).
// SOURCE: docs/harness/README.md (contracts gate) [corpus: harness/doctrine]

/** Code-unit (locale-independent) string order. */
function codeUnit(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * The committed action-inventory bytes for a tRPC `_def.procedures` record. Each row is
 * `{ action, type }` — the dotted procedure path and its query|mutation kind. The auth rung
 * (public/authed/member) is deliberately absent: tRPC middleware is opaque at `_def`, so it
 * cannot be recovered mechanically, and an inventory must not claim what it cannot verify.
 */
export function renderActions(procedures) {
  const rows = Object.keys(procedures)
    .map((action) => ({ action, type: procedures[action]._def.type }))
    .sort((x, y) => codeUnit(x.action, y.action))
  return `${JSON.stringify(rows, null, 2)}\n`
}

/**
 * The committed event-catalog bytes for a flat list of event definitions gathered from
 * every catalog. Each row is `{ name, version, description }` — exactly what
 * `JSON.stringify` of a definition yields (the phantom `payloadType` is never present at
 * runtime). Globally sorted by name; a duplicate `name` across catalogs THROWS, because two
 * catalogs both claiming one wire name is a silent collision no diff would explain.
 */
export function renderEvents(events) {
  const rows = events
    .map((e) => ({ name: e.name, version: e.version, description: e.description }))
    .sort((x, y) => codeUnit(x.name, y.name))
  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.name)) {
      throw new Error(
        `@app/events: duplicate event name ${JSON.stringify(row.name)} across catalogs`,
      )
    }
    seen.add(row.name)
  }
  return `${JSON.stringify(rows, null, 2)}\n`
}
