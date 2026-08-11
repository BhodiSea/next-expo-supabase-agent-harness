import { describe, expect, it } from 'vitest'
import type { CryptoProvider } from './ports.js'
import { createWebCryptoProvider } from './webcrypto-provider.js'

// AES-256-GCM known-answer vectors — test cases 13, 14, 15 and 16 of the GCM specification's validation set (the same set NIST CAVP exercises). ct/tag are held SEPARATELY and the tests assert seal output equals ct||tag byte-exactly: a provider that computes the wrong tag, truncates it, or reorders the concatenation fails the vector, not just a roundtrip. tc15 and tc16 share a key and IV and differ only in the last 4 plaintext bytes and the presence of AAD, which makes them the pair that catches an AAD silently dropped — and, during authoring, caught tc15's answer pasted under tc16's inputs. SOURCE: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf [corpus: nist/sp800-38d-gcm]
const GCM_VECTORS = [
  {
    name: 'tc13: zero key, zero iv, empty plaintext, no aad',
    key: '0000000000000000000000000000000000000000000000000000000000000000',
    iv: '000000000000000000000000',
    plaintext: '',
    aad: '',
    ciphertext: '',
    tag: '530f8afbc74536b9a963b4f1c4cb738b',
  },
  {
    name: 'tc14: zero key, zero iv, one zero block, no aad',
    key: '0000000000000000000000000000000000000000000000000000000000000000',
    iv: '000000000000000000000000',
    plaintext: '00000000000000000000000000000000',
    aad: '',
    ciphertext: 'cea7403d4d606b6e074ec5d3baf39d18',
    tag: 'd0d1c8a799996bf0265b98b5d48ab919',
  },
  {
    name: 'tc15: real key, real iv, 64-byte plaintext, no aad',
    key: 'feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308',
    iv: 'cafebabefacedbaddecaf888',
    plaintext:
      'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255',
    aad: '',
    ciphertext:
      '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad',
    tag: 'b094dac5d93471bdec1a502270e3cc6c',
  },
  {
    name: 'tc16: same key and iv as tc15, 60-byte plaintext, 20-byte aad',
    key: 'feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308',
    iv: 'cafebabefacedbaddecaf888',
    plaintext:
      'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39',
    aad: 'feedfacedeadbeeffeedfacedeadbeefabaddad2',
    ciphertext:
      '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662',
    tag: '76fc6ece0f4e1768cddf8853bb2d551b',
  },
] as const

// HKDF-SHA-256 known-answer vectors — RFC 5869 Appendix A test cases 1 and 3 (A.3 is the zero-salt case the keyring's own derivation shape relies on: HMAC pads keys with zeros to block size, so the empty salt and the HashLen-zeros default are the SAME key). SOURCE: https://www.rfc-editor.org/rfc/rfc5869 [corpus: ietf/rfc5869-hkdf]
const HKDF_VECTORS = [
  {
    name: 'rfc5869 A.1: basic case',
    ikm: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b',
    salt: '000102030405060708090a0b0c',
    info: 'f0f1f2f3f4f5f6f7f8f9',
    length: 42,
    okm: '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
  },
  {
    name: 'rfc5869 A.3: zero-length salt and info',
    ikm: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b',
    salt: '',
    info: '',
    length: 42,
    okm: '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
  },
] as const

// Vector CONFORMANCE, not just roundtrips: a provider that "roundtrips" can
// still be the wrong cipher, a truncated tag, or a homebrew mode agreeing only
// with itself. Sealing must reproduce the published ciphertext AND tag
// byte-exactly; only then do the tamper cases mean what they claim.

const hex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}
const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

// Bound through a second const so the null-check NARROWS for the helper
// functions below too: TypeScript does not carry a module-scope narrowing into a
// hoisted function body, since it cannot prove call order.
const maybeProvider = createWebCryptoProvider()
if (maybeProvider === null) throw new Error('vitest runs on Node >= 22 — WebCrypto must exist here')
const provider: CryptoProvider = maybeProvider

// Flip one bit of a COPY. `bytes[i] ^= 1` cannot be written under
// noUncheckedIndexedAccess (the READ is `number | undefined`), and reaching for `!`
// to silence that is the exact habit the torvalds rubric names — so the read is
// branched, once, here.
const flipByte = (bytes: Uint8Array, index: number): Uint8Array => {
  const out = bytes.slice()
  out[index] = (out.at(index) ?? 0) ^ 0x01
  return out
}

const vectorNamed = (prefix: string) => {
  const v = GCM_VECTORS.find((x) => x.name.startsWith(prefix))
  if (v === undefined) throw new Error(`vector ${prefix} is missing from vectors.gcm.ts`)
  return v
}

describe('aeadSeal / aeadOpen against the published AES-256-GCM vectors', () => {
  // The vector file is DATA a human transcribes, so it gets its own invariant:
  // GCM is a stream mode, so |ciphertext| == |plaintext| and the tag is always
  // 16 bytes. This caught tc15's published answer pasted under tc16's inputs
  // during authoring — a mistake the seal assertion below reports as a cipher
  // mismatch, which reads like an implementation bug rather than a typo.
  it('every vector is self-consistent in length before anything is asserted against it', () => {
    for (const v of GCM_VECTORS) {
      expect(v.ciphertext.length, `${v.name}: ciphertext length must equal plaintext length`).toBe(
        v.plaintext.length,
      )
      expect(v.tag.length, `${v.name}: GCM tag is 16 bytes`).toBe(32)
    }
  })

  for (const v of GCM_VECTORS) {
    it(`seals ${v.name} to the exact ct‖tag`, async () => {
      const sealed = await provider.aeadSeal({
        key: hex(v.key),
        iv: hex(v.iv),
        plaintext: hex(v.plaintext),
        aad: hex(v.aad),
      })
      // aeadSeal refuses (null) rather than throwing on a key the engine rejects;
      // a vector must never take that path, so a null here is a real failure.
      if (sealed === null) throw new Error(`${v.name}: aeadSeal refused a published vector`)
      expect(toHex(sealed)).toBe(v.ciphertext + v.tag)
    })

    it(`opens ${v.name} back to the plaintext`, async () => {
      const opened = await provider.aeadOpen({
        key: hex(v.key),
        iv: hex(v.iv),
        ciphertext: hex(v.ciphertext + v.tag),
        aad: hex(v.aad),
      })
      // Narrowed with a real branch rather than `!` or a cast: the strict rule set
      // forbids the assertion and biome rejects the widening cast, and a throw here
      // says the same thing more honestly — a null means the vector did not open.
      if (opened === null) throw new Error(`${v.name}: aeadOpen returned null on a valid vector`)
      expect(toHex(opened)).toBe(v.plaintext)
    })
  }

  it('returns null — never throws — on a flipped ciphertext byte', async () => {
    const v = vectorNamed('tc16')
    const tampered = flipByte(hex(v.ciphertext + v.tag), 0)
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
    const aad = flipByte(hex(v.aad), 0)
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
    const full = hex(v.ciphertext + v.tag)
    const ct = flipByte(full, full.length - 1)
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
  for (const v of HKDF_VECTORS) {
    it(`derives ${v.name} to the exact OKM`, async () => {
      const okm = await provider.hkdfSha256({
        ikm: hex(v.ikm),
        salt: hex(v.salt),
        info: hex(v.info),
        length: v.length,
      })
      if (okm === null) throw new Error(`${v.name}: hkdfSha256 refused a published vector`)
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
