import type { ActorView, DataExportPage, HealthReport } from '@app/contracts'
import { ExportMyDataSchema } from '@app/contracts'
import { type ActionOutcome, outcomeOk } from '@app/errors'
import { exportMyData } from '../export.js'
import { authedProcedure, publicProcedure, router } from '../trpc.js'

// ---------------------------------------------------------------------------
// The procedures that are about the SYSTEM rather than about a vertical:
// liveness, "who am I", and "what is my data".
//
// They live outside packages/verticals on purpose — a vertical that owns the
// health check is a vertical you cannot delete, and the data-subject export is
// about the ACCOUNT across every vertical, not about any one of them.
// ---------------------------------------------------------------------------

export const systemRouter = router({
  /**
   * Liveness, public. This is what the dev-URL smoke check and deploy
   * verification call, so it must answer with NO session, NO cookies and no
   * database round trip — a health check that touches the database reports the
   * database's health, not the deployment's, and goes red for the wrong reason.
   *
   * It reports the version the skew guard is comparing against, which makes a
   * skew rejection diagnosable with one curl instead of a log dig.
   *
   * It is also the ONE procedure that is not enveloped, and that is not an
   * exception to the rule so much as the rule reaching its floor: health has no
   * failure mode. If it can answer at all, the answer is `ok`. Wrapping it in an
   * outcome would add a discriminant with exactly one inhabitant, and make the
   * smoke check — the caller least able to interpret an envelope — read two
   * levels deep for a boolean.
   */
  health: publicProcedure.query(({ ctx }): HealthReport => {
    return { ok: true, version: ctx.serverVersion }
  }),

  /**
   * The signed-in caller, in the shape both surfaces render.
   *
   * On the envelope even though it cannot fail today: an outcome that starts as
   * "always ok" and later gains a failure mode is a widening of the return type
   * that reds every caller — exactly the review moment you want. A bare
   * `ActorView` that later has to become an outcome is a silent breaking change
   * to two apps.
   */
  me: authedProcedure.query(({ ctx }): ActionOutcome<ActorView> => {
    return outcomeOk({
      // Both are already resolved against public.memberships by createContext;
      // nothing here re-derives them, and `activeOrg` is by construction either
      // an element of `orgs` or null. This procedure is what the org switcher
      // reads, which is why it stays on `authedProcedure`: a caller with no
      // active org must still be able to ask what orgs they have, or the switcher
      // has nothing to switch between.
      activeOrg: ctx.activeOrg,
      displayName: ctx.actor.displayName,
      email: ctx.actor.email,
      id: ctx.actor.userId,
      orgs: [...ctx.orgs],
    })
  }),

  /**
   * The DSR portability surface (GDPR Art. 20): one page of the caller's own
   * data — profile, seats, and the notes they AUTHORED — running AS THE CALLER
   * under RLS. tools/data-flow.json export.surface names this procedure;
   * docs/runbooks/data-subject-requests.md is the human procedure around it.
   *
   * `authedProcedure`, NOT `orgProcedure`, and the difference is the point:
   * the subject's data spans every seat they hold (the notes walk visits each
   * org in turn — the cursor carries the position), and a caller with ZERO
   * seats still owns a profile the export must return. An acting org would be
   * the wrong question — this read is about WHO, not WHERE.
   *
   * The router stays thin like every other procedure here: scope assembly only,
   * with `actorId` from the VERIFIED actor and `orgIds` from the RESOLVED seat
   * list — there is no expression in this file a future edit could point at
   * the input instead. The projection, the walk and the one invariant RLS does
   * not provide (authored-only) live in ../export.ts.
   */
  exportMyData: authedProcedure
    .input(ExportMyDataSchema)
    .query(({ ctx, input }): Promise<ActionOutcome<DataExportPage>> => {
      return exportMyData(
        ctx.db,
        { actorId: ctx.actor.userId, orgIds: ctx.orgs.map((org) => org.id) },
        input,
      )
    }),
})
