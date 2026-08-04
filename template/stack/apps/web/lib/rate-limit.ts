import type { RateLimitBucket } from '@app/ratelimit'

// The rate-limit POLICY, as data.
//
// ZERO VALUE IMPORTS, for the same reason apps/web/lib/security-headers.ts has none: the
// `rate-limits` gate evaluates this module under node's type stripping and diffs what it
// returns against tools/rate-limit-budget.json. A value import would drag a package graph
// into that evaluation, the gate would skip with a plausible-sounding reason, and the
// budget would stop being checked at all. `import type` is erased, so the port's type is
// free.
//
// WHAT A BUDGET IS FOR. Not "stop a determined attacker" — a determined attacker POSTs
// straight to PostgREST with their own JWT and never touches this file. These numbers
// bound the accidental and the casual: a runaway retry loop in a client build, a scraper
// pointed at the Server Actions, one tenant's integration hammering a mutation in a
// while(true). Set them well above what a real human generates and well below what a
// loop does, and the difference between those two is where every number here comes from.
// SOURCE: docs/adr/20260204-rate-limiting.md

/**
 * Reads. 300/minute is roughly five per second sustained — far past any human's
 * navigation, comfortably inside what a page that fans out to several queries and then
 * revalidates will do on a fast connection.
 */
const READ: RateLimitBucket = { limit: 300, name: 'read', windowSeconds: 60 }

/**
 * Writes. One a second sustained, which no interactive user reaches and every runaway
 * loop exceeds immediately. Deliberately much tighter than reads: a write costs a
 * transaction, an audit row and a quota check, and it is the direction that leaves
 * damage behind.
 */
const WRITE: RateLimitBucket = { limit: 60, name: 'write', windowSeconds: 60 }

/**
 * Tenancy provisioning — creating an org, redeeming an invitation.
 *
 * Ten an HOUR, not a minute, and the window is the point. These operations are rare for
 * a real person (most users do each of them once, ever) and attractive to abuse: org
 * creation is a cheap way to manufacture tenants, and invitation redemption is the one
 * endpoint that accepts a bearer token from someone who is not yet a member of anything.
 * A per-minute window would let an attacker grind tokens all day at 59-second intervals.
 * `private.create_org`'s own per-user/day cap is the enforcement; this is the cheap layer
 * in front of it that stops the grinding from reaching the database at all.
 */
const PROVISIONING: RateLimitBucket = { limit: 10, name: 'provisioning', windowSeconds: 3600 }

/**
 * Every bucket this deployment declares.
 *
 * `@public` because its ONLY consumer is tools/check-rate-limits.mjs, which evaluates
 * this module under node's type stripping — a caller no static analysis of the app graph
 * can see. Deleting it as "unused" would delete the gate's ability to diff the running
 * budget against the reviewed one, which is the whole reason the gate exists.
 * @public
 */
// SOURCE: docs/adr/20260204-rate-limiting.md (the budget is reviewed data, diffed by value)
export function rateLimitBuckets(): readonly RateLimitBucket[] {
  return [READ, WRITE, PROVISIONING]
}

/**
 * Which bucket a tRPC procedure spends from.
 *
 * The map is EXPLICIT rather than derived from `type`, and the exemption is explicit too.
 * A rule like "mutations get WRITE, queries get READ" reads well and hides the two cases
 * that matter: `system.health` must never be limited (it is what a load balancer calls to
 * decide whether this instance is alive, and rate-limiting it turns a traffic spike into
 * an instance being pulled from rotation), and org provisioning is a mutation whose right
 * budget is three orders of magnitude away from the others.
 */
const PROCEDURE_BUCKETS: Readonly<Record<string, RateLimitBucket | null>> = {
  'notes.create': WRITE,
  'notes.get': READ,
  'notes.list': READ,
  'notes.remove': WRITE,
  'notes.update': WRITE,
  // Deliberately null — see above. The reason is recorded in tools/rate-limit-budget.json
  // where a reviewer looks for it, and the gate refuses an exemption without one.
  'system.health': null,
  'system.me': READ,
}

/**
 * The bucket for a procedure path, or null when it is deliberately unlimited.
 *
 * An UNKNOWN path falls to the strictest sensible default rather than to null: a
 * procedure added without touching this file is limited as a write, which is wrong in the
 * harmless direction. The `rate-limits` gate reds on it in the same turn, so the default
 * is a safety net for the seconds between writing a router and running the chain — never
 * a substitute for the map.
 */
export function bucketForProcedure(path: string): RateLimitBucket | null {
  // `path in map ? map[path] : WRITE` is not enough under noUncheckedIndexedAccess: the
  // index read is typed `| undefined` regardless of the guard, and `?? WRITE` alone would
  // silently turn a DELIBERATE null (an exemption) into the write budget. Both facts are
  // needed, so both are spelled.
  if (!Object.hasOwn(PROCEDURE_BUCKETS, path)) return WRITE
  return PROCEDURE_BUCKETS[path] ?? null
}

/**
 * Which bucket a Server Action spends from.
 *
 * A Server Action is a PUBLIC HTTP ENDPOINT with a generated id — the form on your page
 * is not the only caller, it is merely the only caller you wrote. So this seam is limited
 * on its own, not as a consequence of the router being limited: the two paths share no
 * code, and a browser that posts an action id never goes near a tRPC procedure.
 */
const ACTION_BUCKETS: Readonly<Record<string, RateLimitBucket | null>> = {
  acceptInvitationAction: PROVISIONING,
  createNoteAction: WRITE,
  ensurePersonalOrgAction: PROVISIONING,
}

/** The bucket for a Server Action, with the same strict-by-default rule as procedures. */
export function bucketForAction(name: string): RateLimitBucket | null {
  if (!Object.hasOwn(ACTION_BUCKETS, name)) return WRITE
  return ACTION_BUCKETS[name] ?? null
}
