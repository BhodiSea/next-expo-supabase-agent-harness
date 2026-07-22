import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { LiveInferenceProvider } from './live.js'

// Contract tests for the live adapter — run in the DEFAULT unit lane with an
// injected fetch (no network, no GPU): the adapter's request shape, schema
// enforcement, and failure modes are proven long before a live endpoint exists.
// The GPU workflow (eval-live.yml) runs the same adapter against a real server.

const replySchema = z.strictObject({ answer: z.string() })

interface CapturedRequest {
  url: string
  body: unknown
}

function fakeFetch(captured: CapturedRequest[], content: string, status = 200): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const rawBody = typeof init?.body === 'string' ? init.body : '{}'
    captured.push({
      url,
      body: JSON.parse(rawBody) as unknown,
    })
    const payload = JSON.stringify({ choices: [{ message: { content } }] })
    return Promise.resolve(new Response(payload, { status }))
  }
}

const requestBody = z.object({
  temperature: z.number(),
  response_format: z.object({ type: z.literal('json_object') }),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
})

describe('LiveInferenceProvider', () => {
  it('sends the prompt as system and the input as user data, deterministic decoding', async () => {
    const captured: CapturedRequest[] = []
    const provider = new LiveInferenceProvider({
      endpoint: 'http://127.0.0.1:8080/v1/chat/completions',
      fetchImpl: fakeFetch(captured, JSON.stringify({ answer: 'ok' })),
    })
    const out = await provider.chatJson(replySchema, 'instructions v1', 'the item text')
    expect(out).toEqual({ answer: 'ok' })

    expect(captured).toHaveLength(1)
    const body = requestBody.parse(captured[0]?.body)
    expect(body.temperature).toBe(0)
    expect(body.response_format.type).toBe('json_object')
    expect(body.messages).toEqual([
      { role: 'system', content: 'instructions v1' },
      { role: 'user', content: 'the item text' },
    ])
  })

  it('rejects a reply that fails the caller schema (raw model text never escapes)', async () => {
    const provider = new LiveInferenceProvider({
      endpoint: 'http://e/v1/chat/completions',
      fetchImpl: fakeFetch([], JSON.stringify({ wrong: 'shape' })),
    })
    await expect(provider.chatJson(replySchema, 'p', 'i')).rejects.toThrow()
  })

  it('rejects non-JSON reply content with a clear error', async () => {
    const provider = new LiveInferenceProvider({
      endpoint: 'http://e/v1/chat/completions',
      fetchImpl: fakeFetch([], 'plainly not json'),
    })
    await expect(provider.chatJson(replySchema, 'p', 'i')).rejects.toThrow(
      'live inference reply was not valid JSON',
    )
  })

  it('surfaces HTTP failures with the status code', async () => {
    const provider = new LiveInferenceProvider({
      endpoint: 'http://e/v1/chat/completions',
      fetchImpl: fakeFetch([], JSON.stringify({ answer: 'x' }), 503),
    })
    await expect(provider.chatJson(replySchema, 'p', 'i')).rejects.toThrow(
      'live inference endpoint responded 503',
    )
  })
})
