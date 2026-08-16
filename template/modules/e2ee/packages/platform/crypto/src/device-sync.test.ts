import { describe, expect, it } from 'vitest'
import { exportForDevice, importFromDevice } from './device-sync.js'
import type { CryptoProvider } from './ports.js'
import { escrowRootKey } from './recovery.js'
import { createWebCryptoProvider } from './webcrypto-provider.js'

// The device-sync seam over the REAL provider. These tests own the transit
// envelope: only the channel key opens it, only the same account's session
// accepts it, and the role byte keeps it out of every other slot even under
// an identical sealing key.

// Declared locally: the package sets `types: []` so platform globals stay out
// of the shared graph — see the note in envelope.ts.
declare const TextEncoder: new () => { encode(input: string): Uint8Array }

const maybeProvider = createWebCryptoProvider()
if (maybeProvider === null) throw new Error('vitest runs on Node >= 22 — WebCrypto must exist here')
const provider: CryptoProvider = maybeProvider

const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const userId = 'user-a'

async function exportOrThrow(
  rootKey: Uint8Array,
  channelKey: Uint8Array,
  uid = userId,
): Promise<Uint8Array> {
  const r = await exportForDevice(provider, { rootKey, channelKey, userId: uid })
  if (!r.ok) throw new Error(`exportForDevice refused: ${r.reason}`)
  return r.value
}

describe('export → import roundtrip', () => {
  it('imports the exact root key under the same channel key and account', async () => {
    const rootKey = provider.randomBytes(32)
    const channelKey = provider.randomBytes(32)
    const payload = await exportOrThrow(rootKey, channelKey)
    const imported = await importFromDevice(provider, { payload, channelKey, userId })
    expect(imported.ok).toBe(true)
    if (imported.ok) expect(toHex(imported.value)).toBe(toHex(rootKey))
  })

  it('two exports of one root key differ — fresh IV per export', async () => {
    const rootKey = provider.randomBytes(32)
    const channelKey = provider.randomBytes(32)
    expect(toHex(await exportOrThrow(rootKey, channelKey))).not.toBe(
      toHex(await exportOrThrow(rootKey, channelKey)),
    )
  })
})

describe('refusals, each with its own reason', () => {
  it('a wrong channel key is aead_auth_failed', async () => {
    const payload = await exportOrThrow(provider.randomBytes(32), provider.randomBytes(32))
    const r = await importFromDevice(provider, {
      payload,
      channelKey: provider.randomBytes(32),
      userId,
    })
    expect(r).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it("a payload moved to another ACCOUNT's session is aead_auth_failed", async () => {
    // The AAD binds the userId both ends already share, so even a correctly
    // transported channel key cannot import user A's root key into user B's
    // session — the ceremony can be socially engineered; the binding cannot.
    const channelKey = provider.randomBytes(32)
    const payload = await exportOrThrow(provider.randomBytes(32), channelKey)
    const r = await importFromDevice(provider, { payload, channelKey, userId: 'user-b' })
    expect(r).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it('a tampered payload byte is aead_auth_failed', async () => {
    const channelKey = provider.randomBytes(32)
    const payload = await exportOrThrow(provider.randomBytes(32), channelKey)
    const tampered = payload.slice()
    tampered[10] = (tampered.at(10) ?? 0) ^ 0x01
    const r = await importFromDevice(provider, { payload: tampered, channelKey, userId })
    expect(r).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it('a truncated payload is envelope_malformed, before any key touches it', async () => {
    const channelKey = provider.randomBytes(32)
    const payload = await exportOrThrow(provider.randomBytes(32), channelKey)
    const r = await importFromDevice(provider, {
      payload: payload.slice(0, 4),
      channelKey,
      userId,
    })
    expect(r).toMatchObject({ ok: false, reason: 'envelope_malformed' })
  })

  it('a recovery escrow does not import as a sync payload even under an IDENTICAL key', async () => {
    // Contrived on purpose, and said so (the keyring.test.ts honesty note): in
    // production the two seams derive different keys by HKDF info alone, so a
    // cross-open would fail for two reasons at once and prove neither. Here
    // the escrow is sealed under the exact key importFromDevice will derive
    // from this channel key, so the ONLY thing left to refuse it is the AAD
    // role byte — which is the property under test.
    const channelKey = provider.randomBytes(32)
    const syncKey = await provider.hkdfSha256({
      ikm: channelKey,
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('app-e2ee/v1/device-sync'),
      length: 32,
    })
    if (syncKey === null) throw new Error('hkdfSha256 refused')
    const escrowed = await escrowRootKey(provider, {
      rootKey: provider.randomBytes(32),
      recoveryKey: syncKey,
      userId,
    })
    if (!escrowed.ok) throw new Error(`escrowRootKey refused: ${escrowed.reason}`)
    const r = await importFromDevice(provider, { payload: escrowed.value, channelKey, userId })
    expect(r).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })
})
