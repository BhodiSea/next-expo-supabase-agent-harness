import 'server-only'

import type { Session } from '@app/api'
import { ORG_ROLE_RANK, type OrgRole, type OrgSummary } from '@app/contracts'
import { type ActionOutcome, appError, outcomeErr, outcomeOk } from '@app/errors'
import type { SupabaseServerClient } from '@app/supabase'
import { getVerifiedUser } from '@app/supabase'
import { createRequestScopedClient } from '../supabase/server'

// ---------------------------------------------------------------------------
// The web host's identity seam — the ONE place this app turns a verified user
// into "who they are and which orgs they hold".
//
// It exists because there were TWO before, and both were lies of the same kind:
// the tRPC route handler minted `{ role: 'owner', workspaceId: user.userId }`
// and `app/actions/notes.ts` minted the same shape inline. Each stood in for a
// membership table that did not exist. With a real one, a second copy stops
// being a duplication problem and becomes a place where one caller believes a
// different set of seats than the other — which is how a Server Action writes
// into an org the tRPC path would have refused.
//
// WHAT IS AUTHORITATIVE HERE AND WHAT IS NOT. Nothing in this file is the
// isolation boundary; the RLS policies are, and they key on public.memberships
// at statement time. What this file does is (a) read the caller's seats THROUGH
// those same policies, so its answer is by construction a subset of what the
// database would allow, and (b) turn "no acting org" into a good error before a
// round trip, instead of an empty result set the UI has to guess about.
// SOURCE: packages/api/src/context.ts (resolveActiveOrg — the same resolution
// for the header transport, one rule set) [corpus: harness/doctrine]
//
// ── TWO TRANSPORTS, TWO SPELLINGS, ONE RULE ────────────────────────────────
// The acting org reaches the server two ways, and neither is a payload field:
//
//   tRPC (both surfaces)  the `x-org-id` HEADER, resolved by @app/api's
//                         createContext against the caller's real seats.
//   Server Actions (web)  the org SLUG from the route the action was invoked
//                         from (`/o/[orgSlug]/…`), passed explicitly and
//                         resolved here against the same real seats.
//
// A Server Action cannot read a custom request header — the browser does not
// send one on a form POST — so the route segment is the selector. Passing it as
// an argument is NOT the thing the `org-id-from-session-only` rule forbids: what
// that rule forbids is an `org_id` flowing from input into a QUERY. Here the
// argument is a SELECTOR that gets looked up in a list the server derived from
// the verified identity, and the id that reaches the query is the looked-up
// org's — never the caller's string. A selector can only ever pick something
// the caller already holds, or nothing.
// ---------------------------------------------------------------------------

/** The seat table's rank ladder, inverted. */
const ROLE_BY_RANK: ReadonlyMap<number, OrgRole> = new Map(
  (Object.entries(ORG_ROLE_RANK) as [OrgRole, number][]).map(([role, rank]) => [rank, role]),
)

/**
 * The embedded read PostgREST performs across the memberships -> orgs foreign
 * key. `!inner` matters: without it, a membership whose org row was filtered
 * away by the orgs SELECT policy comes back as `orgs: null` rather than being
 * dropped, and the mapper below would have to invent a name for an org it cannot
 * see. The two policies agree today (a seat implies org visibility); `!inner` is
 * what keeps a future divergence a missing row instead of a null dereference.
 */
const ORG_SELECT = 'role_rank, orgs!inner(id, name, slug)'

interface MembershipRow {
  readonly orgs: { readonly id: string; readonly name: string; readonly slug: string } | null
  readonly role_rank: number
}

/**
 * Every seat the caller holds, read through their OWN policies.
 *
 * Read as `authenticated`, never with a privileged client, and that is the whole
 * design: the seat table's SELECT policy is self-only, so this query cannot
 * return another user's seats even though it carries no `user_id` filter. The
 * filter is ABSENT for exactly that reason — adding one would restate the policy
 * in TypeScript and mask its removal (see the notes DAL header for the same
 * distinction spelled out at length).
 *
 * A failure returns an EMPTY list rather than throwing. A signed-in user whose
 * seat lookup failed is seatless for this request: they see "no organizations"
 * and can retry, which is strictly better than a crash screen and strictly safer
 * than any fallback that invents a seat.
 */
export async function resolveOrgs(client: SupabaseServerClient): Promise<OrgSummary[]> {
  const { data, error } = await client.from('memberships').select(ORG_SELECT)
  if (error !== null) return []

  const orgs: OrgSummary[] = []
  for (const row of data as unknown as MembershipRow[]) {
    const org = row.orgs
    const role = ROLE_BY_RANK.get(row.role_rank)
    // An unknown rank is DROPPED, never defaulted. Defaulting down hides an org
    // the user really holds; defaulting up offers a role the database will
    // refuse. Dropping is the only choice that cannot lie — and it is reachable
    // only if @app/contracts' ladder and the CHECK constraint in
    // supabase/schemas/05_tenancy.sql have drifted, which is a bug to find.
    if (org === null || role === undefined) continue
    orgs.push({ id: org.id, name: org.name, role, slug: org.slug })
  }
  // Deterministic order, so the "exactly one org" default and every rendered
  // switcher agree run to run. By slug, because slug is UNIQUE and the sort is
  // therefore total; sorting by name would leave ties in database order.
  return orgs.sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * The verified caller plus their real seats, in the shape @app/api's context
 * expects. Null for an anonymous caller — the host injects this ALREADY PROVEN,
 * so the router never re-derives an identity from a cookie it cannot verify.
 */
export async function resolveHostSession(
  client: SupabaseServerClient,
  token?: string,
): Promise<Session | null> {
  const user = await getVerifiedUser(client, token)
  if (user === null) return null
  return {
    // displayName falls back to the verified email, then the id: ActorView only
    // requires a non-empty string and both always are.
    actor: { displayName: user.email ?? user.userId, email: user.email, userId: user.userId },
    orgs: await resolveOrgs(client),
  }
}

export interface OrgContextValue {
  readonly client: SupabaseServerClient
  readonly org: OrgSummary
  readonly orgs: readonly OrgSummary[]
  readonly userId: string
}

/**
 * The Server Action / Server Component entry point: a verified caller acting in
 * a real org, or an outcome saying which half is missing.
 *
 * TWO DISTINCT FAILURES, kept distinct here while the tRPC wire keeps them
 * merged:
 *   - not signed in            -> `unauthorized`; the UI sends them to /sign-in
 *   - signed in, no such seat  -> `forbidden(org_context_required)`; the UI
 *                                 sends them to the org picker
 * Collapsing these would put a signed-in user with no seat into a login loop
 * they can never exit, because signing in again does not grant a seat. The wire
 * merges them for a different reason — telling a caller that an org exists but
 * is not theirs is the existence disclosure the RLS suites exist to prevent —
 * and that is fine, because on this side of the boundary the caller IS the user.
 *
 * `orgSlug` is looked up in the caller's own list. A slug naming somebody else's
 * org is not an error and not an elevation: it simply is not in the list.
 */
export async function requireOrgContext(orgSlug: string): Promise<ActionOutcome<OrgContextValue>> {
  const client = await createRequestScopedClient()
  const session = await resolveHostSession(client)
  if (session === null) return outcomeErr(appError.unauthorized())

  const wanted = orgSlug.trim().toLowerCase()
  const org = session.orgs.find((o) => o.slug === wanted)
  if (org === undefined) {
    return outcomeErr(
      appError.forbidden({
        code: 'org_context_required',
        message: 'an active organization is required',
      }),
    )
  }
  return outcomeOk({ client, org, orgs: session.orgs, userId: session.actor.userId })
}
