import { describe, expect, it } from 'vitest'
import { parseOptionalServerEnv } from './optional.js'

// The optional server section's contract, proven in both directions: absence is
// a supported configuration (nothing throws on an empty environment), and every
// PRESENT value is validated — including the both-or-neither pair invariant
// that turns a silently-degraded limiter into a boot failure.

describe('parseOptionalServerEnv', () => {
  it('parses an empty environment: every value optional, nothing required', () => {
    expect(parseOptionalServerEnv({})).toEqual({})
  })

  it('accepts the full valid section', () => {
    const parsed = parseOptionalServerEnv({
      UPSTASH_REDIS_REST_TOKEN: 'AXt0ken-value',
      UPSTASH_REDIS_REST_URL: 'https://example-region.upstash.io',
      APP_VERSION: '1.4.0',
      MIN_SUPPORTED_CLIENT: '1.2.0',
    })
    expect(parsed.UPSTASH_REDIS_REST_TOKEN).toBe('AXt0ken-value')
    expect(parsed.UPSTASH_REDIS_REST_URL).toBe('https://example-region.upstash.io')
    expect(parsed.APP_VERSION).toBe('1.4.0')
    expect(parsed.MIN_SUPPORTED_CLIENT).toBe('1.2.0')
  })

  it('rejects a token without its URL — half a Redis config is a misconfiguration', () => {
    expect(() => parseOptionalServerEnv({ UPSTASH_REDIS_REST_TOKEN: 'AXt0ken-value' })).toThrow(
      /UPSTASH_REDIS_REST_URL/,
    )
  })

  it('rejects a URL without its token', () => {
    expect(() =>
      parseOptionalServerEnv({ UPSTASH_REDIS_REST_URL: 'https://example-region.upstash.io' }),
    ).toThrow(/UPSTASH_REDIS_REST_TOKEN/)
  })

  it('rejects a non-https REST URL', () => {
    expect(() =>
      parseOptionalServerEnv({
        UPSTASH_REDIS_REST_TOKEN: 'AXt0ken-value',
        UPSTASH_REDIS_REST_URL: 'http://example-region.upstash.io',
      }),
    ).toThrow(/https/)
  })

  it('rejects a present-but-empty value: set-and-empty is a paste accident, not "unset"', () => {
    expect(() => parseOptionalServerEnv({ APP_VERSION: '' })).toThrow(/APP_VERSION/)
  })
})
