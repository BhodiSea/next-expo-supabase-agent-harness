import type { ActorView, HealthReport } from '@app/contracts'
import { type ActionOutcome, outcomeOk } from '@app/errors'
import { authedProcedure, publicProcedure, router } from '../trpc.js'

// ---------------------------------------------------------------------------
// The two procedures that are about the SYSTEM rather than about a vertical:
// liveness, and "who am I".
//
// They live outside packages/verticals on purpose — a vertical that owns the
// health check is a vertical you cannot delete.
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
})
