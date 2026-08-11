import { describe, expect, it } from 'vitest'
import gcmVectors from './testing/vectors.gcm.json'
import hkdfVectors from './testing/vectors.hkdf.json'
import { createWebCryptoProvider } from './webcrypto-provider.js'

// Vector CONFORMANCE, not just roundtrips: a provider that "roundtrips" can
// still be the wrong cipher, a truncated tag, or a homebrew mode agreeing only
// with itself. Sealing must reproduce the published ciphertext AND tag
// byte-exactly; only then do the tamper cases mean what they claim.

const hex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}
const toHex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

const provider = createWebCryptoProvider()
if (provider === null) throw new Error('vitest runs on Node >= 22 — WebCrypto must exist here')

const vectorNamed = (prefix: string) => {
  const v = gcmVectors.vectors.find((x) => x.name.startsWith(prefix))
  if (v === undefined) throw new Error(`vector ${prefix} is missing from vectors.gcm.json`)
  return v
}

describe('aeadSeal / aeadOpen against the published AES-256-GCM vectors', () => {
  // The vector file is DATA a human transcribes, so it gets its own invariant:
  // GCM is a stream mode, so |ciphertext| == |plaintext| and the tag is always
  // 16 bytes. This caught tc15's published answer pasted under tc16's inputs
  // during authoring — a mistake the seal assertion below reports as a cipher
  // mismatch, which reads like an implementation bug rather than a typo.
  it('every vector is self-consistent in length before anything is asserted against it', () => {
    for (const v of gcmVectors.vectors) {
      expect(v.ciphertext.length, `${v.name}: ciphertext length must equal plaintext length`).toBe(
        v.plaintext.length,
      )
      expect(v.tag.length, `${v.name}: GCM tag is 16 bytes`).toBe(32)
    }
  })

  for (const v of gcmVectors.vectors) {
    it(`seals ${v.name} to the exact ct‖tag`, async () => {
      const sealed = await provider.aeadSeal({
        key: hex(v.key),
        iv: hex(v.iv),
        plaintext: hex(v.plaintext),
        aad: hex(v.aad),
      })
      expect(toHex(sealed)).toBe(v.ciphertext + v.tag)
    })

    it(`opens ${v.name} back to the plaintext`, async () => {
      const opened = await provider.aeadOpen({
        key: hex(v.key),
        iv: hex(v.iv),
        ciphertext: hex(v.ciphertext + v.tag),
        aad: hex(v.aad),
      })
      expect(opened).not.toBeNull()
      expect(toHex(opened as Uint8Array)).toBe(v.plaintext)
    })
  }

  it('returns null — never throws — on a flipped ciphertext byte', async () => {
    const v = vectorNamed('tc16')
    const tampered = hex(v.ciphertext + v.tag)
    tampered[0] ^= 0x01
    const opened = await provider.aeadOpen({
      key: hex(v.key),
      iv: hex(v.iv),
      ciphertext: tampered,
      aad: hex(v.aad),
    })
    expect(opened).toBeNull()
  })

  it('returns null on a flipped AAD byte — associated data is authenticated', async () => {
    const v = vectorNamed('tc16') // the one vector carrying AAD
    const aad = hex(v.aad)
    aad[0] ^= 0x01
    const opened = await provider.aeadOpen({
      key: hex(v.key),
      iv: hex(v.iv),
      ciphertext: hex(v.ciphertext + v.tag),
      aad,
    })
    expect(opened).toBeNull()
  })

  it('returns null on a flipped tag byte', async () => {
    const v = vectorNamed('tc14')
    const ct = hex(v.ciphertext + v.tag)
    ct[ct.length - 1] ^= 0x01
    const opened = await provider.aeadOpen({
      key: hex(v.key),
      iv: hex(v.iv),
      ciphertext: ct,
      aad: hex(v.aad),
    })
    expect(opened).toBeNull()
  })
})

describe('hkdfSha256 against RFC 5869 appendix A', () => {
  for (const v of hkdfVectors.vectors) {
    it(`derives ${v.name} to the exact OKM`, async () => {
      const okm = await provider.hkdfSha256({
        ikm: hex(v.ikm),
        salt: hex(v.salt),
        info: hex(v.info),
        length: v.length,
      })
      expect(toHex(okm)).toBe(v.okm)
    })
  }
})

describe('randomBytes', () => {
  it('returns the asked length and does not repeat across calls', () => {
    const a = provider.randomBytes(32)
    const b = provider.randomBytes(32)
    expect(a).toHaveLength(32)
    expect(b).toHaveLength(32)
    // 2^-256 flake odds is not a flake source; identical output is a broken CSPRNG.
    expect(toHex(a)).not.toBe(toHex(b))
  })
})
