import { z } from 'zod'
import type { InferenceProvider } from '../providers.js'

// Live inference adapter (eval-live module). Implements the SAME InferenceProvider
// port the deterministic fakes implement, against an OpenAI-compatible
// chat-completions endpoint (llama.cpp `llama-server`, vLLM, TGI, …) over plain
// fetch — deliberately no SDK, so the depcruise LLM wall stays narrow. This file
// lives in packages/eval/src/adapters/ because that is the ONLY directory allowed
// to touch model endpoints (dependency-cruiser enforces it).
// Gates and unit tests never construct this with a real endpoint: the default
// eval is fixture-scored by design; the GPU workflow (eval-live.yml) is the only
// live caller.
// SOURCE: harness doctrine — live evaluation is an opt-in module; everything else
// programs against the ports [corpus: harness/doctrine]

const completionEnvelope = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
      }),
    )
    .min(1),
})

export interface LiveProviderOptions {
  /** Chat-completions URL, e.g. http://127.0.0.1:8080/v1/chat/completions */
  readonly endpoint: string
  /** Model name passed through to the server (llama.cpp ignores it). */
  readonly model?: string
  /** Extra headers (e.g. an internal gateway token). */
  readonly headers?: Readonly<Record<string, string>>
  /** Injection seam for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch
}

export class LiveInferenceProvider implements InferenceProvider {
  readonly #endpoint: string
  readonly #model: string
  readonly #headers: Readonly<Record<string, string>>
  readonly #fetch: typeof fetch

  constructor(options: LiveProviderOptions) {
    this.#endpoint = options.endpoint
    this.#model = options.model ?? 'default'
    this.#headers = options.headers ?? {}
    this.#fetch = options.fetchImpl ?? fetch
  }

  async chatJson<Out>(schema: z.ZodType<Out>, prompt: string, input: string): Promise<Out> {
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.#headers },
      body: JSON.stringify({
        model: this.#model,
        // SOURCE: greedy decoding for eval determinism — sampling noise would make
        // run-to-run scores incomparable [corpus: llamacpp/sampling]
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          // The prompt is the versioned, hash-locked instruction; the item text is
          // DATA in its own message — never spliced into the instruction.
          { role: 'system', content: prompt },
          { role: 'user', content: input },
        ],
      }),
    })
    if (!response.ok) {
      throw new Error(`live inference endpoint responded ${String(response.status)}`)
    }
    const envelope = completionEnvelope.parse(await response.json())
    const content = envelope.choices[0]?.message.content
    if (content === undefined) {
      throw new Error('live inference endpoint returned no choices')
    }
    // Contract of the port: the raw model text is validated through the caller's
    // schema before anything downstream sees it.
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error('live inference reply was not valid JSON')
    }
    return schema.parse(parsed)
  }
}
