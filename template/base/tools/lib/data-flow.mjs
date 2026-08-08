// tools/lib/data-flow.mjs — what happens to a row when the person it belongs to is deleted.
//
// The question this answers is not one any earlier gate asks. `schema-rls` asks who may READ
// a row, `tenancy` asks which org OWNS it, `db-limits` asks what it costs. None of them ask
// the question a data subject asks: I am closing my account — what of mine survives, and why?
//
// It is decidable from files this repository already commits. A delete of `auth.users` does
// exactly what the FOREIGN KEY actions say it does, and those are in the migration history.
// So every column carrying subject data lands in exactly one of four buckets:
//
//   ERASED      — reachable from the subject row by a chain of ON DELETE CASCADE. The row
//                 goes when the account goes. Nothing to review.
//   SEVERED     — ON DELETE SET NULL / SET DEFAULT. The ROW SURVIVES and only the link is
//                 cut. This is the bucket that needs a written reason, because it is a
//                 deliberate decision that someone else is the data controller for that row
//                 — true here for notes (the org owns its content) and false the moment
//                 somebody adds a table where it is not.
//   BLOCKING    — ON DELETE RESTRICT / NO ACTION, INCLUDING an FK with no action clause at
//                 all, which is NO ACTION by default. The delete FAILS. An account that
//                 cannot be deleted is a GDPR Art. 17 failure and an Apple 5.1.1(v) review
//                 rejection, and the omitted-clause spelling is the one nobody notices,
//                 because it looks like every other column.
//   UNREACHABLE — subject data with no FK path to the subject at all. `audit.events.actor_id`
//                 is the shipped example and it is deliberate (a trail that deletes its own
//                 evidence is not a trail), but "deliberate" has to be written down and
//                 paired with the procedure that handles the request instead.
//
// WHY THE MIGRATIONS AND NOT THE SCHEMAS. `supabase/schemas/*.sql` is the desired state a
// reviewer reads; `supabase/migrations/*.sql` is what actually ran, and it is what the
// database does. They can disagree, and on this exact question they nearly did:
// notes.owner_id was created `ON DELETE CASCADE` and demoted to `SET NULL` by a later ALTER,
// so a reader that stopped at the creating statement would report a note as erased with its
// author's account when it is not. Same subject as check-tenancy and check-db-limits.
// SOURCE: https://www.postgresql.org/docs/current/ddl-constraints.html (referential actions)
import { stripSchema } from './sql-parse.mjs'

/** The identity table every subject-data question is asked relative to. */
export const SUBJECT_ROOT = 'auth.users'

/** Actions that remove the row with its parent. */
const ERASING = new Set(['CASCADE'])
/** Actions that keep the row and cut the link. */
const SEVERING = new Set(['SET NULL', 'SET DEFAULT'])

/** `null` is NOT ACTION SPELLED AS SILENCE — see the header. */
export const spelledAction = (onDelete) =>
  onDelete === null ? 'NO ACTION (no ON DELETE clause — the PostgreSQL default)' : onDelete

/**
 * Every foreign key in the tree, as edges a reachability walk can use.
 * @param {Map<string, Map<string, {references: string|null, onDelete: string|null}>>} facts
 * @returns {Array<{table: string, column: string, parent: string, onDelete: string|null}>}
 */
export function foreignKeys(facts) {
  const out = []
  for (const [table, cols] of facts) {
    for (const [column, f] of cols) {
      if (f.references === null) continue
      out.push({ table, column, parent: stripSchema(f.references), onDelete: f.onDelete })
    }
  }
  return out.sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`))
}

/**
 * The set of TABLES a delete of `root` empties of the subject's rows, by transitive CASCADE.
 *
 * Fixed-point rather than a single pass: `profiles` is erased because it cascades from
 * auth.users, and anything cascading from `profiles` is erased because `profiles` is — a
 * one-pass reader would answer correctly for depth 1 and confidently wrong for depth 2.
 * The loop terminates because the set only grows and the table count is finite.
 * @param {ReturnType<typeof foreignKeys>} edges @param {string} root
 */
export function erasedTables(edges, root = SUBJECT_ROOT) {
  const erased = new Set()
  for (;;) {
    const before = erased.size
    for (const e of edges) {
      if (!ERASING.has(e.onDelete ?? '')) continue
      if (e.parent === root || erased.has(e.parent)) erased.add(e.table)
    }
    if (erased.size === before) return erased
  }
}

/**
 * Classify every foreign key that points AT the subject — directly, or at a table the
 * subject's deletion empties.
 *
 * `severed` and `blocking` are the two that need review, and they are separated because the
 * consequences are opposite: a severed link means data survives that someone asked to have
 * erased, a blocking one means the erasure never happens at all.
 * @param {ReturnType<typeof foreignKeys>} edges @param {string} root
 */
export function classifyLinks(edges, root = SUBJECT_ROOT) {
  const erased = erasedTables(edges, root)
  const subjectFacing = edges.filter((e) => e.parent === root || erased.has(e.parent))
  return {
    erased,
    cascading: subjectFacing.filter((e) => ERASING.has(e.onDelete ?? '')),
    severed: subjectFacing.filter((e) => SEVERING.has(e.onDelete ?? '')),
    blocking: subjectFacing.filter(
      (e) => !ERASING.has(e.onDelete ?? '') && !SEVERING.has(e.onDelete ?? ''),
    ),
  }
}

/** `table.column`, the key every reviewed-data list in this gate is keyed by. */
export const siteKey = (table, column) => `${table}.${column}`

/**
 * Reviewed-list closure, in the direction that is easy to forget.
 *
 * Both directions are findings and they are different findings: an unreviewed site is a
 * decision nobody made, and a reviewed site that no longer exists is a decision that has
 * outlived its subject — the list drifting into fiction while reading as coverage.
 *
 * @param {string[]} actual keys the schema really has
 * @param {Array<{table?: string, column?: string, reason?: string}>} reviewed
 * @returns {{unreviewed: string[], stale: string[], thin: string[]}}
 */
export function closeAgainstReviewed(actual, reviewed) {
  const declared = new Map(reviewed.map((r) => [siteKey(r.table ?? '?', r.column ?? '?'), r]))
  const present = new Set(actual)
  return {
    unreviewed: actual.filter((k) => !declared.has(k)),
    stale: [...declared.keys()].filter((k) => !present.has(k)),
    thin: [...declared]
      .filter(([k, r]) => present.has(k) && (r.reason ?? '').trim().length < 40)
      .map(([k]) => k),
  }
}
