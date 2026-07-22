// HITL rule 2: THE PIPELINE ROLE CAN NEVER APPROVE (ops-backup module skeleton).
// Service identities may create and execute backfills; only a HUMAN reviewer
// identity may move pending_review → approved. That rule must hold at the
// DATABASE (RLS policy on the state transition), because the pipeline is
// exactly the code path an agent — or a compromised job — drives unattended.
// See docs/runbooks/backfill.md. Skips loudly until the approval table exists.
// cspell:ignore hitl
import { describe, expect, it } from 'vitest'
import { appSql, RLS_SUITE_READY, withUser } from './db-context'

// ---- CONFIG (TODO seams: align with your schema when it lands) ---------------
const HITL_TABLE = 'review_queue'
const STATE_COLUMN = 'state'
// Identity the automated pipeline runs as. Model it however your schema does
// (dedicated user row, role claim in the JWT → GUC, …) — the test's contract is
// only that THIS identity must not be able to approve.
const PIPELINE_USER = '99999999-9999-4999-8999-999999999999'

if (!RLS_SUITE_READY) {
  describe.skip('HITL pipeline-role-cannot-approve (skipped: database not ready)', () => {
    it('database not ready — run via node tests/rls/run-rls.mjs', () => {
      expect(true).toBe(true)
    })
  })
} else {
  describe('HITL pipeline-role-cannot-approve (skeleton)', () => {
    it('pipeline identity cannot move a backfill to approved', async (ctx) => {
      const sql = appSql()
      try {
        const table = await sql`
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ${HITL_TABLE}`
        if (table.length === 0) {
          console.log(
            `[hitl] TODO: table "${HITL_TABLE}" does not exist yet — this skeleton activates when your approval schema lands (see docs/runbooks/backfill.md)`,
          )
          ctx.skip()
          return
        }
        // TODO(project): with the table present, drive the real assertion —
        //   1. seed a row in pending_review, created by a human submitter
        //      identity (through the app path, not superuser SQL).
        //   2. as the PIPELINE identity, attempt the approval:
        //        await withUser(sql, PIPELINE_USER, (tx) =>
        //          tx`UPDATE ${tx(HITL_TABLE)} SET ${tx(STATE_COLUMN)} = 'approved'
        //             WHERE ${tx(STATE_COLUMN)} = 'pending_review'`)
        //      and expect EITHER 0 rows matched (RLS hides the row from the
        //      pipeline's UPDATE policy) OR SQLSTATE 42501 — never a success.
        //   3. POSITIVE CONTROL (anti-vacuity): the same UPDATE as a human
        //      reviewer identity MUST succeed — otherwise "pipeline cannot
        //      approve" passes vacuously on a deny-all table.
        //   4. Add the self-approval variant: the submitter identity must also
        //      fail to approve their own row (HITL rule 1).
        void withUser // referenced by the seam above; used for real in step 2
        void PIPELINE_USER
        expect.fail(
          `table "${HITL_TABLE}" exists but the pipeline-role assertions are still the skeleton — implement the TODO above before relying on this gate`,
        )
      } finally {
        await sql.end({ timeout: 5 })
      }
    })
  })
}
