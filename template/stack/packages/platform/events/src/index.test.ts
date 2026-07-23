// The registry's three promises: the phantom payload never reaches runtime, the
// catalog key IS the wire name, and the generator's walk is order-stable.
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { AnyEventDefinition, EventDefinition, PayloadOf } from './index.js'
import { defineEventCatalog, listEvents, platformEvents } from './index.js'

interface NoteCreatedPayload {
  readonly noteId: string
  readonly titleLength: number
}

interface NoteArchivedPayload {
  readonly noteId: string
}

const noteCreated: EventDefinition<'note.created', NoteCreatedPayload> = {
  name: 'note.created',
  version: 1,
  description: 'A note was created by its owner.',
}

const noteArchived: EventDefinition<'note.archived', NoteArchivedPayload> = {
  name: 'note.archived',
  version: 2,
  description: 'A note left the active list without being deleted.',
}

const fixtureCatalog = defineEventCatalog({
  'note.created': noteCreated,
  'note.archived': noteArchived,
})

type CreatedPayload = PayloadOf<typeof fixtureCatalog, 'note.created'>
type ArchivedPayload = PayloadOf<typeof fixtureCatalog, 'note.archived'>
type SurfacedPayload = PayloadOf<typeof platformEvents, 'platform.error_surfaced'>

describe('event declarations', () => {
  it('keeps the payload type-only — nothing reaches the serialized descriptor', () => {
    expect(Object.hasOwn(noteCreated, 'payloadType')).toBe(false)
    expect(JSON.parse(JSON.stringify(noteCreated))).toEqual({
      name: 'note.created',
      version: 1,
      description: 'A note was created by its owner.',
    })
  })

  it('recovers the payload type from the declaration', () => {
    expectTypeOf<CreatedPayload>().toEqualTypeOf<NoteCreatedPayload>()
    // The phantom is per-declaration, not per-catalog: two entries in the same
    // catalog keep two different payloads.
    expectTypeOf<ArchivedPayload>().toEqualTypeOf<NoteArchivedPayload>()
  })
})

describe('defineEventCatalog', () => {
  it('returns the catalog unchanged', () => {
    expect(fixtureCatalog['note.created']).toBe(noteCreated)
  })

  it('rejects a key that disagrees with the declared wire name', () => {
    // The self-referential type constraint blocks this at every literal call
    // site. A catalog assembled dynamically — an index-signature type, as here —
    // slips past the compiler, which is precisely the case the runtime check
    // exists for.
    const assembled: Record<string, AnyEventDefinition> = { 'note.created': noteArchived }
    expect(() => defineEventCatalog(assembled)).toThrow(/the key IS the wire name/)
  })
})

describe('listEvents', () => {
  it('walks a catalog in code-unit name order, whatever the literal order was', () => {
    // Declared created-then-archived; the walk must not echo that.
    expect(listEvents(fixtureCatalog).map((event) => event.name)).toEqual([
      'note.archived',
      'note.created',
    ])
  })

  it('is stable across repeated walks of the same catalog', () => {
    const first = listEvents(fixtureCatalog).map((event) => event.name)
    const second = listEvents(fixtureCatalog).map((event) => event.name)
    expect(first).toEqual(second)
  })

  it('carries version and description through for the generated inventory', () => {
    const archived = listEvents(fixtureCatalog)[0]
    expect(archived?.version).toBe(2)
    expect(archived?.description).not.toBe('')
  })
})

describe('the platform catalog', () => {
  it('declares only platform-owned events, each with a non-empty description', () => {
    const names = listEvents(platformEvents).map((event) => event.name)
    expect(names).toEqual(['platform.error_surfaced', 'platform.session_changed'])
    for (const event of listEvents(platformEvents)) {
      expect(event.name.startsWith('platform.')).toBe(true)
      expect(event.description).not.toBe('')
      expect(event.version).toBeGreaterThanOrEqual(1)
    }
  })

  it('types the error payload as plain strings, not the error taxonomy', () => {
    // Deliberate: a warehouse column bound to a live union would make renaming
    // an AppError kind a rewrite of already-emitted history.
    expectTypeOf<SurfacedPayload['kind']>().toEqualTypeOf<string>()
    expectTypeOf<SurfacedPayload['code']>().toEqualTypeOf<string>()
  })
})
