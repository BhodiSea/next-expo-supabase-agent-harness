import { describe, expect, it } from 'vitest'
import type { CryptoProvider } from './ports.js'
import {
  deriveRecoveryKey,
  escrowRootKey,
  generateRecoveryCode,
  recoverRootKey,
} from './recovery.js'
import { createWebCryptoProvider } from './webcrypto-provider.js'

// The recovery seam over the REAL provider. These tests own the CODE — its
// alphabet, its error tolerance, its refusals — and the escrow binding: a
// blob moved to another account fails authentication, and a wrong code fails
// exactly like tamper, because to the AEAD it is.

const maybeProvider = createWebCryptoProvider()
if (maybeProvider === null) throw new Error('vitest runs on Node >= 22 — WebCrypto must exist here')
const provider: CryptoProvider = maybeProvider

const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

/** A provider double whose ONLY divergence is a fixed randomBytes — the known-answer seam. */
const withFixedBytes = (bytes: Uint8Array): CryptoProvider => ({
  randomBytes: () => bytes.slice(),
  aeadSeal: (args) => provider.aeadSeal(args),
  aeadOpen: (args) => provider.aeadOpen(args),
  hkdfSha256: (args) => provider.hkdfSha256(args),
})

async function keyOrThrow(code: string): Promise<Uint8Array> {
  const r = await deriveRecoveryKey(provider, code)
  if (!r.ok) throw new Error(`deriveRecoveryKey refused: ${r.reason}`)
  return r.value
}

describe('generateRecoveryCode', () => {
  it('emits 13 dash-separated groups of 4 Crockford symbols (no I, L, O or U)', () => {
    const code = generateRecoveryCode(provider)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){12}$/)
  })

  it('differs across calls — the code IS the entropy', () => {
    expect(generateRecoveryCode(provider)).not.toBe(generateRecoveryCode(provider))
  })

  it('encodes a known byte sequence to the exact committed string', () => {
    // Bytes 0x00..0x1f, Crockford-encoded — computed at authoring time by two
    // independent implementations (JS and Python) of the 5-bit big-endian
    // walk. Freezes the ENCODING: an alphabet edit, a bit-order flip, or a
    // grouping change breaks this exact string, and a code minted before the
    // change would stop deriving the same key after it.
    const seq = Uint8Array.from({ length: 32 }, (_, i) => i)
    expect(generateRecoveryCode(withFixedBytes(seq))).toBe(
      '000G-40R4-0M30-E209-185G-R38E-1W81-24GK-2GAH-C5RR-34D1-P70X-3RFG',
    )
  })
})

describe('deriveRecoveryKey', () => {
  it('is deterministic for one code and 32 bytes long', async () => {
    const code = generateRecoveryCode(provider)
    const a = await keyOrThrow(code)
    const b = await keyOrThrow(code)
    expect(a).toHaveLength(32)
    expect(toHex(a)).toBe(toHex(b))
  })

  it('derives DIFFERENT keys from different codes', async () => {
    const a = await keyOrThrow(generateRecoveryCode(provider))
    const b = await keyOrThrow(generateRecoveryCode(provider))
    expect(toHex(a)).not.toBe(toHex(b))
  })

  it("forgives Crockford's own confusables: case, O for 0, I and L for 1", async () => {
    // The all-zero code exercises O→0; the all-ones bit pattern (five-bit
    // groups of 00001) exercises I→1 and L→1. Error tolerance is part of the
    // ENCODING's contract — a code read aloud or handwritten must survive the
    // symbols humans actually confuse.
    const zeroCode = generateRecoveryCode(withFixedBytes(new Uint8Array(32)))
    expect(toHex(await keyOrThrow(zeroCode.replace(/0/g, 'O')))).toBe(
      toHex(await keyOrThrow(zeroCode)),
    )
    // Build the 32 bytes whose 5-bit groups are all 00001 — the '1'-only code.
    const bits: number[] = []
    for (let i = 0; i < 52; i += 1) bits.push(0, 0, 0, 0, 1)
    const ones = new Uint8Array(32)
    for (let i = 0; i < 256; i += 1) {
      if (bits.at(i) === 1) {
        const byte = ones.at(i >> 3) ?? 0
        ones[i >> 3] = byte | (0x80 >> (i & 7))
      }
    }
    const onesCode = generateRecoveryCode(withFixedBytes(ones))
    const expected = toHex(await keyOrThrow(onesCode))
    expect(toHex(await keyOrThrow(onesCode.replace(/1/g, 'I')))).toBe(expected)
    expect(toHex(await keyOrThrow(onesCode.replace(/1/g, 'l')))).toBe(expected)
    expect(toHex(await keyOrThrow(onesCode.toLowerCase()))).toBe(expected)
  })

  it('a wrong-length code is recovery_code_malformed', async () => {
    expect(await deriveRecoveryKey(provider, 'ABCD-EFGH')).toMatchObject({
      ok: false,
      reason: 'recovery_code_malformed',
    })
  })

  it("a symbol outside the alphabet is recovery_code_malformed — 'U' is excluded by design", async () => {
    const code = generateRecoveryCode(provider)
    // Replace the first symbol with U: same length, one impossible character.
    expect(await deriveRecoveryKey(provider, `U${code.slice(1)}`)).toMatchObject({
      ok: false,
      reason: 'recovery_code_malformed',
    })
  })

  it('nonzero padding bits in the last symbol are recovery_code_malformed', async () => {
    // The 52nd symbol carries one data bit over four zero pad bits, so its
    // only legal values are '0' and 'G'. A '7' there is a mangled final
    // character, and the decoder refuses it rather than deriving a silently
    // different key from the same first 51 symbols.
    const code = generateRecoveryCode(provider)
    expect(await deriveRecoveryKey(provider, `${code.slice(0, -1)}7`)).toMatchObject({
      ok: false,
      reason: 'recovery_code_malformed',
    })
  })
})

describe('escrow → recover', () => {
  const userId = 'user-a'

  async function escrowOrThrow(
    rootKey: Uint8Array,
    recoveryKey: Uint8Array,
    uid = userId,
  ): Promise<Uint8Array> {
    const r = await escrowRootKey(provider, { rootKey, recoveryKey, userId: uid })
    if (!r.ok) throw new Error(`escrowRootKey refused: ${r.reason}`)
    return r.value
  }

  it('recovers the exact root key from the code alone', async () => {
    const rootKey = provider.randomBytes(32)
    const code = generateRecoveryCode(provider)
    const escrowed = await escrowOrThrow(rootKey, await keyOrThrow(code))
    // The recovery flow as a lost device would run it: re-derive from the
    // typed code, then open.
    const recovered = await recoverRootKey(provider, {
      escrowed,
      recoveryKey: await keyOrThrow(code),
      userId,
    })
    expect(recovered.ok).toBe(true)
    if (recovered.ok) expect(toHex(recovered.value)).toBe(toHex(rootKey))
  })

  it('a wrong code is aead_auth_failed — indistinguishable from tamper, honestly', async () => {
    const escrowed = await escrowOrThrow(
      provider.randomBytes(32),
      await keyOrThrow(generateRecoveryCode(provider)),
    )
    const r = await recoverRootKey(provider, {
      escrowed,
      recoveryKey: await keyOrThrow(generateRecoveryCode(provider)),
      userId,
    })
    expect(r).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it("a moved escrow — another account's row — is aead_auth_failed", async () => {
    // The AAD binds the userId, so the right code cannot open an escrow blob
    // copied under a different account: the binding, not the secrecy, is what
    // refuses it.
    const code = generateRecoveryCode(provider)
    const escrowed = await escrowOrThrow(provider.randomBytes(32), await keyOrThrow(code))
    const r = await recoverRootKey(provider, {
      escrowed,
      recoveryKey: await keyOrThrow(code),
      userId: 'user-b',
    })
    expect(r).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it('a tampered escrow byte is aead_auth_failed', async () => {
    const code = generateRecoveryCode(provider)
    const escrowed = await escrowOrThrow(provider.randomBytes(32), await keyOrThrow(code))
    const tampered = escrowed.slice()
    tampered[10] = (tampered.at(10) ?? 0) ^ 0x01
    const r = await recoverRootKey(provider, {
      escrowed: tampered,
      recoveryKey: await keyOrThrow(code),
      userId,
    })
    expect(r).toMatchObject({ ok: false, reason: 'aead_auth_failed' })
  })

  it('a truncated escrow is envelope_malformed, before any key touches it', async () => {
    const code = generateRecoveryCode(provider)
    const escrowed = await escrowOrThrow(provider.randomBytes(32), await keyOrThrow(code))
    const r = await recoverRootKey(provider, {
      escrowed: escrowed.slice(0, 4),
      recoveryKey: await keyOrThrow(code),
      userId,
    })
    expect(r).toMatchObject({ ok: false, reason: 'envelope_malformed' })
  })

  it('a wrong-length recovery key is a NAMED refusal at escrow time', async () => {
    const r = await escrowRootKey(provider, {
      rootKey: provider.randomBytes(32),
      recoveryKey: new Uint8Array(16),
      userId,
    })
    expect(r).toMatchObject({ ok: false, reason: 'key_missing' })
  })
})
