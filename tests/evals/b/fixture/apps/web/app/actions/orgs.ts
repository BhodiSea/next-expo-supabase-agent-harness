'use server'

import { InvitationToken, OrgId, type OrgSummary } from '@app/contracts'
import { type ActionOutcome, appError, outcomeErr, outcomeOk } from '@app/errors'
import { revalidatePath } from 'next/cache'
import { foldActionResult } from '../../lib/action-outcome'
import { resolveOrgs } from '../../lib/auth/session'
import { enforceActionRateLimit } from '../../lib/rate-limit-runtime'
import { actionClient } from '../../lib/safe-action'
import { createRequestScopedClient, getVerifiedUser } from '../../lib/supabase/server'

// The two tenancy writes the minimum-viable web surface needs: provision the personal org,
// and redeem an invitation. Both go through the allowlisted SECURITY DEFINER RPCs — there is
// no direct-write path to orgs, memberships or invitations, because `authenticated` holds no
// INSERT grant on any of them. That is not a convention this file is honouring; it is the
// only path that exists.
//
// WHY PROVISIONING IS A POST AND NOT A RENDER. `ensure_personal_org()` is idempotent, which
// makes it tempting to call from the /o page's render so a new user "just has" a workspace.
// Resist it: a GET that mutates is a GET that a prefetch, a bot, or Next's own router
// speculation will fire, and the same reasoning that keeps mutations out of Server Components
// keeps them out here. The truly automatic version of this belongs in the DATABASE — a
// trigger on auth.users, or a GoTrue webhook — where it runs exactly once per user regardless
// of which surface they arrive on. This action is the explicit, surface-level stand-in, and
// it is one click.
// SOURCE: supabase/migrations/20260201000000_tenancy_spine.sql (the definer RPC allowlist)

/**
 * A PostgREST failure from an RPC, folded onto the envelope.
 *
 * The RPCs raise with deliberate SQLSTATEs and deliberately uninformative messages —
 * accept_invitation answers "invalid, expired, or already used" as ONE message for all three,
 * because distinguishing them turns the endpoint into a token oracle. That message is
 * forwarded verbatim precisely because it was written to be safe to show; nothing else is.
 */
// Built from the contract rather than a local zod import: apps/web takes no direct zod
// dependency, and the wire shapes live where every other wire shape lives.
const TokenInput = InvitationToken.transform((token) => ({ token }))

function rpcFailure(message: string | undefined, fallback: string): ActionOutcome<never> {
  return outcomeErr(appError.unknown({ message: message ?? fallback }))
}

// No .inputSchema at all: this action takes nothing, because the RPC takes nothing. A schema
// for `{}` would be a validation surface with no input to validate.
const runEnsurePersonalOrg = actionClient.action(
  async (): Promise<ActionOutcome<readonly OrgSummary[]>> => {
    const user = await getVerifiedUser()
    if (user === null) return outcomeErr(appError.unauthorized())

    const client = await createRequestScopedClient()
    // Zero arguments, deliberately: the RPC re-derives the caller from auth.uid() internally,
    // so there is no parameter through which a caller could provision an org for someone else.
    const { error } = await client.rpc('ensure_personal_org')
    if (error !== null) return rpcFailure(error.message, 'Could not create your workspace.')

    revalidatePath('/o')
    return outcomeOk(await resolveOrgs(client))
  },
)

export async function ensurePersonalOrgAction(): Promise<ActionOutcome<readonly OrgSummary[]>> {
  // The rate-limit seam. FIRST, before any work and before the identity round trip: an
  // unauthenticated flood at a Server Action id is the flood worth stopping, and a limit
  // applied after `getUser()` still pays an auth call per abusive request.
  const limited = await enforceActionRateLimit('ensurePersonalOrgAction')
  if (limited !== null) return limited
  const result = await runEnsurePersonalOrg()
  if (result.data !== undefined) return result.data
  if (result.serverError !== undefined) return outcomeErr(result.serverError)
  return outcomeErr(appError.unknown({ message: 'Could not create your workspace.' }))
}

const runAcceptInvitation = actionClient
  .inputSchema(TokenInput)
  .action(async ({ parsedInput }): Promise<ActionOutcome<OrgSummary>> => {
    const user = await getVerifiedUser()
    if (user === null) return outcomeErr(appError.unauthorized())

    const client = await createRequestScopedClient()
    // The token is the ONLY thing the acceptor holds — they are, by definition, not yet a
    // member of the org they are joining, so no rank or scope term could be true for them.
    // Consumption is a DELETE inside the RPC, in one guarded statement, so two tabs racing
    // the same token cannot both succeed and a redeemed token cannot be replayed.
    const result = await client.rpc('accept_invitation', { p_token: parsedInput.token })
    if (result.error !== null) {
      return rpcFailure(result.error.message, 'That invitation could not be accepted.')
    }
    // Re-parsed, not trusted. @app/supabase's client is deliberately NOT parameterised by a
    // generated `Database` type — rows and RPC returns arrive as `unknown`/`any` and are
    // re-parsed at the exit — so this is the same law the notes DAL follows for rows,
    // applied to a function's return value.
    const orgId = OrgId.safeParse(result.data)

    // Read the seat back THROUGH the policies rather than trusting the returned id. If the
    // membership did not actually land, this is where it shows — and the id alone would have
    // rendered a link to an org the user cannot open.
    const joined = orgId.success
      ? (await resolveOrgs(client)).find((o) => o.id === orgId.data)
      : undefined
    if (joined === undefined) {
      return outcomeErr(
        appError.unknown({ message: 'The invitation was accepted but the seat is not readable.' }),
      )
    }
    revalidatePath('/o')
    return outcomeOk(joined)
  })

export async function acceptInvitationAction(token: string): Promise<ActionOutcome<OrgSummary>> {
  // The rate-limit seam. FIRST, before any work and before the identity round trip: an
  // unauthenticated flood at a Server Action id is the flood worth stopping, and a limit
  // applied after `getUser()` still pays an auth call per abusive request.
  const limited = await enforceActionRateLimit('acceptInvitationAction')
  if (limited !== null) return limited
  // A malformed token gets the SAME words the RPC uses for an expired or already-used one.
  // Anything more specific tells a guesser whether their guess was well-formed, which is the
  // first bit of a token oracle. See lib/action-outcome.ts for the fold itself.
  return foldActionResult(await runAcceptInvitation(token), {
    invalid: 'That invitation is invalid, expired, or already used.',
    failed: 'That invitation could not be accepted.',
  })
}
