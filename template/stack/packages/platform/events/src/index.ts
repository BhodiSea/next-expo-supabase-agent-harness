// ---------------------------------------------------------------------------
// @app/events — the typed event registry, and the second kernel leaf.
//
// It imports NOTHING: no zod, no vendor SDK, not even @app/errors. Two reasons,
// and the second is the one that matters:
//
//  1. Layering. A leaf that imports a sibling is no longer a leaf, and both
//     surfaces bundle this package.
//  2. Durability. Analytics rows outlive the code that wrote them. If a payload
//     field were typed as another package's union, renaming a member of that
//     union would silently reinterpret events already sitting in a warehouse.
//     Payload fields are plain, boring types on purpose.
//
// WHY THERE IS NO `defineEvent()` HELPER. An event declaration is a value with a
// name and a phantom payload type. A helper would have to take the payload as an
// EXPLICIT type argument and the name as an INFERRED one — TypeScript has no
// partial type-argument inference, so such a helper needs either a curried
// double call or an internal cast. An annotated `const` expresses the same thing
// with neither, and it is what the platform catalog at the bottom of this file
// demonstrates. The mechanism IS `EventDefinition`.
// ---------------------------------------------------------------------------

/**
 * One declared event.
 *
 * `Payload` is carried by the type-only `payloadType` field, which is NEVER
 * present at runtime — that is the point. The payload is a compile-time contract
 * for emitters and consumers; the runtime object stays a small, JSON-safe
 * descriptor that a generator can walk and serialize.
 */
export interface EventDefinition<Name extends string, Payload> {
  /**
   * The wire name. MUST equal the catalog key — `defineEventCatalog` pins the
   * two together at the type level and again at runtime.
   */
  readonly name: Name
  /**
   * Payload schema version. Bump it when a field is removed, renamed, or
   * re-typed — never when one is added optionally. Consumers of historical rows
   * branch on this number, so it is part of the contract, not a changelog.
   */
  readonly version: number
  /**
   * What this event MEANS. It is the only documentation an analyst reading a
   * column name six months from now will ever have.
   */
  readonly description: string
  /**
   * PHANTOM. Declared optional and never assigned, so it costs nothing at
   * runtime (`JSON.stringify` of a definition emits name/version/description and
   * nothing else) while `EventPayload<…>` can still recover the type.
   */
  readonly payloadType?: Payload
}

/** The supertype every definition is assignable to — the walkable shape. */
export type AnyEventDefinition = EventDefinition<string, unknown>

/** Recover a definition's payload type. */
export type EventPayload<Definition extends AnyEventDefinition> = Exclude<
  Definition['payloadType'],
  undefined
>

/**
 * The self-referential constraint that pins every catalog KEY to its
 * definition's `name`. Without it a catalog can carry
 * `{ 'note.created': { name: 'note.updated', … } }` — which typechecks, reads
 * fine, and emits the wrong event forever.
 */
type EventCatalogShape<Catalog> = {
  readonly [Name in keyof Catalog]: Name extends string ? EventDefinition<Name, unknown> : never
}

/** Every event name in a catalog. */
export type EventName<Catalog> = keyof Catalog & string

/** The payload type a given catalog entry declares. */
export type PayloadOf<
  Catalog extends Readonly<Record<string, AnyEventDefinition>>,
  Name extends EventName<Catalog>,
> = EventPayload<Catalog[Name]>

/**
 * Declare a catalog. Returns its argument unchanged — the entire value of this
 * function is the constraint it applies.
 *
 * The runtime key/name check is NOT redundant with the type constraint: a
 * catalog assembled dynamically, or one that reached here through a cast, dodges
 * the compiler. It throws at MODULE SCOPE, so a mismatched catalog fails at
 * import — at boot, in every test run, in CI — instead of the first time that
 * one event happens to be emitted in production.
 */
export function defineEventCatalog<
  Catalog extends EventCatalogShape<Catalog> & Readonly<Record<string, AnyEventDefinition>>,
>(catalog: Catalog): Catalog {
  for (const [key, definition] of Object.entries<AnyEventDefinition>(catalog)) {
    if (definition.name !== key) {
      throw new Error(
        `@app/events: catalog key ${JSON.stringify(key)} declares name ` +
          `${JSON.stringify(definition.name)} — the key IS the wire name; they must match`,
      )
    }
  }
  return catalog
}

// SOURCE: localeCompare is locale- and ICU-version-dependent, so it cannot order a
// GENERATED, committed artifact reproducibly; code-unit comparison is stable everywhere.
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/localeCompare
function byName(left: AnyEventDefinition, right: AnyEventDefinition): number {
  if (left.name === right.name) return 0
  return left.name < right.name ? -1 : 1
}

/**
 * The walk the contracts generator performs: every definition in a catalog, in a
 * stable order.
 *
 * Sorted, not insertion-ordered, because the output is COMMITTED and
 * regen-diffed — an inventory whose row order followed however the catalog
 * literal happened to be written would churn on unrelated edits and train
 * reviewers to skim past the diff that mattered.
 */
export function listEvents(
  catalog: Readonly<Record<string, AnyEventDefinition>>,
): readonly AnyEventDefinition[] {
  return Object.values(catalog).sort(byName)
}

// ---------------------------------------------------------------------------
// The platform catalog.
//
// These are the events the PLATFORM owns — the ones both surfaces emit and no
// feature does. Verticals declare their own catalogs beside their own code
// (`@app/notes` and its successors) and the generator walks each one. Nothing
// domain-shaped belongs here: an event declared far from the code that emits it
// is an event that outlives its emitter.
// ---------------------------------------------------------------------------

/** Which surface emitted an event. The one dimension every platform event needs. */
export type EventSurface = 'mobile' | 'web'

/**
 * An `AppError` reached a user. `kind` and `code` are plain strings, NOT
 * `@app/errors` types — see the module header: binding a warehouse column to a
 * live union makes a rename rewrite history.
 */
export interface ErrorSurfacedPayload {
  readonly surface: EventSurface
  readonly kind: string
  readonly code: string
  /** The route or screen it was rendered on — never the input that failed. */
  readonly route: string
}

/** The signed-in/signed-out edge, as observed by a surface. */
export interface SessionChangedPayload {
  readonly surface: EventSurface
  readonly signedIn: boolean
}

// The declaration idiom: an ANNOTATED const. The annotation is what carries the
// phantom payload type into the catalog — a `satisfies` clause would keep only
// the literal's inferred shape and silently drop the payload, leaving
// `PayloadOf<…>` resolving to `never` at every emit site.
const errorSurfaced: EventDefinition<'platform.error_surfaced', ErrorSurfacedPayload> = {
  name: 'platform.error_surfaced',
  version: 1,
  description: 'A domain failure was rendered to a user on one of the two surfaces.',
}

const sessionChanged: EventDefinition<'platform.session_changed', SessionChangedPayload> = {
  name: 'platform.session_changed',
  version: 1,
  description: 'A surface observed the session cross the signed-in boundary.',
}

/** The platform-owned catalog. Verticals export their own beside their code. */
export const platformEvents = defineEventCatalog({
  'platform.error_surfaced': errorSurfaced,
  'platform.session_changed': sessionChanged,
})
