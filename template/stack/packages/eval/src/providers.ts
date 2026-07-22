import type { z } from 'zod'

// Ports for model access. Everything in @app/eval is written against these
// interfaces; gates and tests use the deterministic fakes in ./fake.ts.
// Real adapters (local runtime, remote endpoint, …) implement the same ports
// and are the ONLY modules allowed to import model SDKs (depcruise-enforced).
// SOURCE: harness doctrine — gates and unit tests never make live model
// calls; live evaluation is an opt-in module [corpus: harness/doctrine]

export interface InferenceProvider {
  /**
   * Ask the model for a JSON answer conforming to `schema`. Implementations
   * MUST validate the raw model output through `schema` before returning, so
   * callers always hold a parsed, typed value — never raw model text.
   *
   * @param schema zod schema the reply must satisfy (rejects on mismatch)
   * @param prompt versioned instruction prompt (see prompts/, hash-locked in
   *               tools/prompts.lock.json)
   * @param input  the item text to work on, passed as data — never spliced
   *               into the prompt
   */
  chatJson<Out>(schema: z.ZodType<Out>, prompt: string, input: string): Promise<Out>

  /**
   * Optional multimodal variant for providers that accept images;
   * `imagePngBase64` is a base64-encoded PNG.
   */
  vision?<Out>(schema: z.ZodType<Out>, prompt: string, imagePngBase64: string): Promise<Out>
}

export interface EmbeddingProvider {
  /** Embed a batch of texts; returns one vector per input, in input order. */
  embed(texts: readonly string[]): Promise<number[][]>
}
