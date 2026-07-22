import { notes } from '@app/schema'
import { withUserContext } from '../db/context.js'
import type { AccountDal } from '../types.js'

// The account-deletion DAL. This stack has NO users table — identity is the
// verified token's subject — so "the account" on this server IS the set of rows
// the user owns: deleting them all (plus the client dropping its local session)
// is complete in-app account deletion.
// SOURCE: Apple App Review Guideline 5.1.1(v) — apps that support account
// creation must let users initiate account deletion within the app
// https://developer.apple.com/app-store/review/guidelines/#5.1.1
export const accountDal: AccountDal = {
  async deleteAllOwnedData(userId) {
    return withUserContext(userId, async (tx) => {
      // SOURCE: visibility is enforced by the notes RLS policies via the app.user_id GUC —
      // like the notes DAL, no owner_id WHERE clause by design: under FORCE RLS this
      // statement can only ever see (and therefore delete) rows the GUC identity owns,
      // and a policy regression cannot be masked by application-side filtering
      // [corpus: postgres/rls-initplan]
      const rows = await tx.delete(notes).returning({ id: notes.id })
      return { deletedNotes: rows.length }
    })
  },
}
