import { describe, expect, it } from 'vitest'
import { deriveKek, openItem, sealItem } from './keyring.js'
import { createWebCryptoProvider } from './webcrypto-provider.js'

// The keyring proven over the REAL provider (vitest runs where WebCrypto
// exists), because a keyring proven over a mock proves the mock. The provider
// itself is vector-proven next door — these tests own the HIERARCHY: fresh DEK
// per seal, wrap/unwrap, and the AAD binding that makes a moved ciphertext
// refuse to open.

const provider = createWebCryptoProvider()
if (provider === null) throw new Error('vitest runs on Node >= 22 — WebCrypto must exist here')

const rootKey = new Uint8Array(32).fill(1)
const ctx = { userId: 'user-a', table: 'notes', itemId: 'note-1' }
const text = (s: string) => new TextEncoder().encode(s)

describe('seal → open roundtrip', () => {
  it('opens what it sealed, under the derived KEK', async () => {
    const kek = await deriveKek(provider, rootKey, 'item-wrap')
    const sealed = await sealItem(provider, kek, text('the plaintext body'), ctx)
    const opened = await openItem(provider, kek, sealed, ctx)
    expect(opened.ok).toBe(true)
    if (opened.ok) expect(new TextDecoder().decode(opened.value)).toBe('the plaintext body')
  })

  it('mints a FRESH DEK per seal: same input, different envelopes and wrapped keys', async () => {
    const kek = await deriveKek(provider, rootKey, 'item-wrap')
    const a = await sealItem(provider, kek, text('same'), ctx)
    const b = await sealItem(provider, kek, text('same'), ctx)
    expect([...a.envelope]).not.toEqual([...b.envelope])
    expect([...a.wrappedDek]).not.toEqual([...b.wrappedDek])
  })
})

describe('the AAD binding — a ciphertext moved is a ciphertext refused', () => {
  it("refuses to open under another row's identity", async () => {
    const kek = await deriveKek(provider, rootKey, 'item-wrap')
    const sealed = await sealItem(provider, kek, text('secret'), ctx)
    const moved = await openItem(provider, kek, sealed, { ...ctx, itemId: 'note-2' })
    expect(moved).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it("refuses to open under another user's identity", async () => {
    const kek = await deriveKek(provider, rootKey, 'item-wrap')
    const sealed = await sealItem(provider, kek, text('secret'), ctx)
    const moved = await openItem(provider, kek, sealed, { ...ctx, userId: 'user-b' })
    expect(moved).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it('refuses a wrapped DEK presented as an item envelope (role separation)', async () => {
    const kek = await deriveKek(provider, rootKey, 'item-wrap')
    const sealed = await sealItem(provider, kek, text('secret'), ctx)
    const swapped = await openItem(
      provider,
      kek,
      { envelope: sealed.wrappedDek, wrappedDek: sealed.wrappedDek },
      ctx,
    )
    expect(swapped).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })
})

describe('failure paths stay typed, never thrown', () => {
  it('a tampered wrapped DEK is aead_auth_failed', async () => {
    const kek = await deriveKek(provider, rootKey, 'item-wrap')
    const sealed = await sealItem(provider, kek, text('secret'), ctx)
    const wrappedDek = sealed.wrappedDek.slice()
    wrappedDek[10] ^= 0x01
    const r = await openItem(provider, kek, { ...sealed, wrappedDek }, ctx)
    expect(r).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it('a zero-length wrapped DEK is key_missing — a shred is not a corruption', async () => {
    // The crypto-shred tombstone: `*_wrapped_dek bytea NOT NULL` cannot be
    // nulled, so erasing a row's key is an overwrite with zero bytes. That must
    // read as deliberately-unreadable, not as damage — a screen says different
    // things about the two.
    const kek = await deriveKek(provider, rootKey, 'item-wrap')
    const sealed = await sealItem(provider, kek, text('secret'), ctx)
    const r = await openItem(provider, kek, { ...sealed, wrappedDek: new Uint8Array(0) }, ctx)
    expect(r).toMatchObject({ ok: false, reason: 'key_missing' })
  })

  it('a corrupted envelope is envelope_malformed, before any key touches it', async () => {
    const kek = await deriveKek(provider, rootKey, 'item-wrap')
    const sealed = await sealItem(provider, kek, text('secret'), ctx)
    const r = await openItem(
      provider,
      kek,
      { ...sealed, wrappedDek: sealed.wrappedDek.slice(0, 4) },
      ctx,
    )
    expect(r).toMatchObject({ ok: false, reason: 'envelope_malformed' })
  })

  it('the wrong root key is aead_auth_failed — indistinguishable from tamper, honestly', async () => {
    const kek = await deriveKek(provider, rootKey, 'item-wrap')
    const wrongKek = await deriveKek(provider, new Uint8Array(32).fill(2), 'item-wrap')
    const sealed = await sealItem(provider, kek, text('secret'), ctx)
    const r = await openItem(provider, wrongKek, sealed, ctx)
    expect(r).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })
})

describe('deriveKek', () => {
  it('is deterministic for the same root and purpose', async () => {
    const a = await deriveKek(provider, rootKey, 'item-wrap')
    const b = await deriveKek(provider, rootKey, 'item-wrap')
    expect([...a]).toEqual([...b])
  })
})
