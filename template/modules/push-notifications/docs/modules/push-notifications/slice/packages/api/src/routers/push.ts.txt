import { NewPushDeviceTokenInput, PushDeviceTokensListQuery } from '@app/contracts'
import {
  type PushTokensDatabase,
  registerToken,
  listTokens,
  removeToken,
} from '@app/push'
import { z } from 'zod'
import type { AuthedContext } from '../trpc.js'
import { authedProcedure, router } from '../trpc.js'

// ---------------------------------------------------------------------------
// The push router (push-notifications module) — the device push-token slice,
// copied from the notes router's shape. Every procedure is a few lines: pick a
// rung of the ladder, name an input schema, hand the call to the @app/push
// vertical. A business rule in a router is a rule the web app's Server Actions
// cannot reach, so none live here.
//
// THE RUNG, and where it differs from notes on purpose: every procedure is
// `authedProcedure`, reads AND writes. Registering or deregistering a device
// token is a per-user DEVICE operation — a signed-in user wants their phone to
// receive notifications whether or not they hold a workspace seat — so it does
// not consume membership the way a note write does. RLS is the boundary beneath
// all three: a token is only ever visible to (and removable by) its owner.
// ---------------------------------------------------------------------------

/** Addressing a single token — the id the register response handed back. The
 *  contract carries no ref shape (the wire never sends an owner), so it is named
 *  here rather than hand-rolled at the call site. */
const PushTokenRef = z.object({ id: z.uuid() })

/**
 * Narrow the request-scoped client to the DAL's structural port. `as unknown as`:
 * `ctx.db` is typed as the notes DAL's hand-authored subset (the context is
 * seeded from that vertical); the runtime value is the full supabase client the
 * push DAL's own subset also describes, and checking the full client against
 * either subset instantiates supabase-js's vast `.from()` overload set (TS2589).
 * The cast rides a `const` so no-unnecessary-type-assertion does not read it as
 * redundant. Same pattern the web host uses at app/api/trpc/[trpc]/route.ts and
 * app/actions/notes.ts.
 * SOURCE: apps/web/app/api/trpc/[trpc]/route.ts (the NotesDatabase-subset cast)
 */
function pushDb(ctx: AuthedContext): PushTokensDatabase {
  return ctx.db as unknown as PushTokensDatabase
}

export const pushRouter = router({
  registerToken: authedProcedure
    .input(NewPushDeviceTokenInput)
    .mutation(({ ctx, input }) =>
      registerToken(pushDb(ctx), { actorId: ctx.actor.userId }, input),
    ),

  listTokens: authedProcedure
    .input(PushDeviceTokensListQuery)
    .query(({ ctx, input }) => listTokens(pushDb(ctx), input)),

  removeToken: authedProcedure
    .input(PushTokenRef)
    .mutation(({ ctx, input }) => removeToken(pushDb(ctx), input.id)),
})
