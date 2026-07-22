import type { z } from 'zod'
import type { EmbeddingProvider, InferenceProvider } from './providers.js'

/**
 * Deterministic inference provider: canned outputs keyed by the exact input
 * text (a committed recording), validated through the same zod schema a real
 * adapter would use — the test path and the live path share one contract.
 * Unknown inputs reject loudly; a fake that silently improvises would turn
 * every downstream assertion vacuous.
 */
export class FakeInferenceProvider implements InferenceProvider {
  readonly #canned: ReadonlyMap<string, unknown>

  constructor(canned: ReadonlyMap<string, unknown>) {
    this.#canned = canned
  }

  chatJson<Out>(schema: z.ZodType<Out>, prompt: string, input: string): Promise<Out> {
    if (prompt.trim() === '') {
      return Promise.reject(new Error('FakeInferenceProvider: refusing an empty prompt'))
    }
    const raw = this.#canned.get(input)
    if (raw === undefined) {
      return Promise.reject(
        new Error(
          `FakeInferenceProvider: no canned response for input starting "${input.slice(0, 40)}"`,
        ),
      )
    }
    return Promise.resolve(schema.parse(raw))
  }
}

/**
 * Hash-derived pseudo-embeddings: stable across runs and platforms, with a
 * configurable dimension. Useful for wiring vector plumbing in tests; NOT a
 * real embedding — values carry no semantic similarity.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly #dimension: number

  constructor(dimension: number) {
    this.#dimension = dimension
  }

  embed(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.#vectorFor(text)))
  }

  // FNV-1a over the text seeds a 32-bit xorshift stream; each draw is scaled
  // into [-1, 1]. Deterministic integer arithmetic only — no Math.random.
  #vectorFor(text: string): number[] {
    let state = 2166136261
    for (let index = 0; index < text.length; index += 1) {
      state = Math.imul(state ^ text.charCodeAt(index), 16777619)
    }
    const vector: number[] = []
    for (let draw = 0; draw < this.#dimension; draw += 1) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      vector.push(((state >>> 0) / 4294967295) * 2 - 1)
    }
    return vector
  }
}
