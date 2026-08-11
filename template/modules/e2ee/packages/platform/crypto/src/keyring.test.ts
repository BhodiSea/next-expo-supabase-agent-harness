import { describe, expect, it } from 'vitest'
import { AAD_ROLE_DEK, AAD_ROLE_ITEM, buildAad, decodeEnvelope } from './envelope.js'
import { deriveKek, openItem, sealItem } from './keyring.js'
import type { CryptoProvider } from './ports.js'
import { createWebCryptoProvider } from './webcrypto-provider.js'

// Declared locally: the package sets `types: []` so platform globals stay out of
// the shared graph — see the note in envelope.ts.
declare const TextEncoder: new () => { encode(input: string): Uint8Array }
declare const TextDecoder: new () => { decode(input: Uint8Array): string }

// The keyring proven over the REAL provider (vitest runs where WebCrypto
// exists), because a keyring proven over a mock proves the mock. The provider
// itself is vector-proven next door — these tests own the HIERARCHY: fresh DEK
// per seal, wrap/unwrap, and the AAD binding that makes a moved ciphertext
// refuse to open.

// Bound through a second const so the null-check NARROWS for the helper
// functions below too: TypeScript does not carry a module-scope narrowing into a
// hoisted function body, since it cannot prove call order.
const maybeProvider = createWebCryptoProvider()
if (maybeProvider === null) throw new Error('vitest runs on Node >= 22 — WebCrypto must exist here')
const provider: CryptoProvider = maybeProvider

const rootKey = new Uint8Array(32).fill(1)
const ctx = { userId: 'user-a', table: 'notes', itemId: 'note-1', field: 'body' }
const text = (s: string) => new TextEncoder().encode(s)

/** The KEK, unwrapped — every test needs it and none of them may swallow a refusal. */
async function kekOrThrow(root: Uint8Array = rootKey): Promise<Uint8Array> {
  const r = await deriveKek(provider, root, 'item-wrap')
  if (!r.ok) throw new Error(`deriveKek refused: ${r.reason}`)
  return r.value
}
async function sealOrThrow(kek: Uint8Array, plaintext: Uint8Array, c = ctx) {
  const r = await sealItem(provider, kek, plaintext, c)
  if (!r.ok) throw new Error(`sealItem refused: ${r.reason}`)
  return r.value
}

describe('seal → open roundtrip', () => {
  it('opens what it sealed, under the derived KEK', async () => {
    const kek = await kekOrThrow()
    const sealed = await sealOrThrow(kek, text('the plaintext body'))
    const opened = await openItem(provider, kek, sealed, ctx)
    expect(opened.ok).toBe(true)
    if (opened.ok) expect(new TextDecoder().decode(opened.value)).toBe('the plaintext body')
  })

  it('round-trips an EMPTY plaintext — the ct.length boundary is exactly the tag', async () => {
    // The `ct.length < 16` guard sits one byte from rejecting every empty field.
    // Without this case a `<=` mutant makes empty strings permanently unreadable
    // (seal succeeds, open reports envelope_malformed) and no test notices.
    const kek = await kekOrThrow()
    const sealed = await sealOrThrow(kek, new Uint8Array(0))
    const opened = await openItem(provider, kek, sealed, ctx)
    expect(opened.ok).toBe(true)
    if (opened.ok) expect(opened.value).toHaveLength(0)
  })

  it('mints a FRESH DEK per seal — proven by UNWRAPPING both, not by comparing envelopes', async () => {
    // The earlier version of this test compared envelope bytes, which differ
    // because of the two random IVs whatever the DEK does: an adversarial review
    // replaced the DEK with a constant and the whole suite stayed green. The
    // fresh-DEK premise is what makes the 96-bit random IV safe, so it is worth
    // recovering the actual keys and comparing THEM.
    const kek = await kekOrThrow()
    const a = await sealOrThrow(kek, text('same'))
    const b = await sealOrThrow(kek, text('same'))
    const unwrap = async (wrappedDek: Uint8Array) => {
      const env = decodeEnvelope(wrappedDek)
      if (!env.ok) throw new Error(`wrapped DEK did not decode: ${env.reason}`)
      const dek = await provider.aeadOpen({
        key: kek,
        iv: env.value.iv,
        ciphertext: env.value.ct,
        aad: buildAad(AAD_ROLE_DEK, ctx),
      })
      if (dek === null) throw new Error('the wrapped DEK did not authenticate')
      return [...dek]
    }
    expect(await unwrap(a.wrappedDek)).not.toEqual(await unwrap(b.wrappedDek))
  })
})

describe('the AAD binding — a ciphertext moved is a ciphertext refused', () => {
  const moved = async (to: Partial<typeof ctx>) => {
    const kek = await kekOrThrow()
    const sealed = await sealOrThrow(kek, text('secret'))
    return openItem(provider, kek, sealed, { ...ctx, ...to })
  }

  it("refuses to open under another row's identity", async () => {
    expect(await moved({ itemId: 'note-2' })).toMatchObject({
      ok: false,
      reason: 'aead_auth_failed',
    })
  })

  it("refuses to open under another user's identity", async () => {
    expect(await moved({ userId: 'user-b' })).toMatchObject({
      ok: false,
      reason: 'aead_auth_failed',
    })
  })

  it("refuses to open under another TABLE's identity", async () => {
    expect(await moved({ table: 'invoices' })).toMatchObject({
      ok: false,
      reason: 'aead_auth_failed',
    })
  })

  it('refuses a ciphertext moved to another COLUMN of the SAME row', async () => {
    // The finding that added `field` to KeyContext: two encrypted columns of one
    // row shared an AAD, so an operator could copy `title` into `body` and the
    // client rendered it as authentic. This is the regression test for that.
    const kek = await kekOrThrow()
    const title = await sealOrThrow(kek, text('PUBLIC TITLE'), { ...ctx, field: 'title' })
    const asBody = await openItem(provider, kek, title, { ...ctx, field: 'body' })
    expect(asBody).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it('binds the role byte itself: an item AAD and a DEK AAD differ for one row', () => {
    // Asserted on buildAad DIRECTLY. The end-to-end "swap the slots" case below
    // is refused by the KEY mismatch too, so it cannot prove the role byte —
    // an adversarial review made the two roles equal and that test stayed green.
    expect([...buildAad(AAD_ROLE_ITEM, ctx)]).not.toEqual([...buildAad(AAD_ROLE_DEK, ctx)])
  })

  it('refuses a wrapped DEK presented as an item envelope', async () => {
    const kek = await kekOrThrow()
    const sealed = await sealOrThrow(kek, text('secret'))
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
    const kek = await kekOrThrow()
    const sealed = await sealOrThrow(kek, text('secret'))
    // Same branched read as the provider suite's flipByte — noUncheckedIndexedAccess
    // makes `x[i] ^= 1` unwritable, and `!` is the habit the rubric names.
    const wrappedDek = sealed.wrappedDek.slice()
    wrappedDek[10] = (wrappedDek.at(10) ?? 0) ^ 0x01
    const r = await openItem(provider, kek, { ...sealed, wrappedDek }, ctx)
    expect(r).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it('a zero-length wrapped DEK is key_missing — a shred is not a corruption', async () => {
    const kek = await kekOrThrow()
    const sealed = await sealOrThrow(kek, text('secret'))
    const r = await openItem(provider, kek, { ...sealed, wrappedDek: new Uint8Array(0) }, ctx)
    expect(r).toMatchObject({ ok: false, reason: 'key_missing' })
  })

  it('a corrupted envelope is envelope_malformed, before any key touches it', async () => {
    const kek = await kekOrThrow()
    const sealed = await sealOrThrow(kek, text('secret'))
    const r = await openItem(
      provider,
      kek,
      { ...sealed, wrappedDek: sealed.wrappedDek.slice(0, 4) },
      ctx,
    )
    expect(r).toMatchObject({ ok: false, reason: 'envelope_malformed' })
  })

  it('the wrong root key is aead_auth_failed — indistinguishable from tamper, honestly', async () => {
    const kek = await kekOrThrow()
    const wrongKek = await kekOrThrow(new Uint8Array(32).fill(2))
    const sealed = await sealOrThrow(kek, text('secret'))
    const r = await openItem(provider, wrongKek, sealed, ctx)
    expect(r).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it('a wrong-length KEK is a NAMED refusal, not a thrown DataError', async () => {
    // WebCrypto rejects importKey on a 31-byte key. Before the provider imported
    // keys inside its own guard, that rejection escaped the package as a throw —
    // through a sealItem that had no way to express failure at all.
    const r = await sealItem(provider, new Uint8Array(31), text('secret'), ctx)
    expect(r).toMatchObject({ ok: false })
  })

  it('a 16-byte KEK is REFUSED rather than silently sealing AES-128', async () => {
    // importKey accepts 16/24/32 bytes, so a short KEK used to seal AES-128
    // under an envelope byte that declares AES-256-GCM — the envelope lying
    // about its own algorithm, which the decoder cannot detect.
    const r = await sealItem(provider, new Uint8Array(16).fill(9), text('secret'), ctx)
    expect(r).toMatchObject({ ok: false })
  })
})

describe('deriveKek', () => {
  it('is deterministic for the same root and purpose', async () => {
    expect([...(await kekOrThrow())]).toEqual([...(await kekOrThrow())])
  })

  it('returns 32 bytes — the AES-256 key length the provider enforces', async () => {
    expect(await kekOrThrow()).toHaveLength(32)
  })
})
