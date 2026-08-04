import type { z } from 'zod'

// The inference PORT — the one interface every provider in this package implements, and the
// reason `adapters/` is the only directory dependency-cruiser lets touch a model endpoint.
//
// It lives here rather than beside the live adapter because a port defined next to one of its
// implementations is not a port: the deterministic fixture provider the default eval scores
// against and the live provider the GPU workflow uses must be interchangeable, and that is
// only true if neither owns the type.
//
// `chatJson` takes the SCHEMA, not a string, and returns the parsed value. That signature is
// what keeps "the model returned prose instead of JSON" a parse failure at the boundary
// rather than an `any` flowing into a scorer — the failure mode that makes an eval report a
// number nobody can reproduce.
// SOURCE: harness doctrine — live evaluation is an opt-in module; everything else programs
// against the ports [corpus: harness/doctrine]
export interface InferenceProvider {
  /**
   * One structured completion: send `prompt` + `input`, parse the reply against `schema`.
   * Rejects if the endpoint fails OR if the reply does not satisfy the schema — the caller
   * gets a value it can trust or an error, never a half-parsed object.
   */
  chatJson<Out>(schema: z.ZodType<Out>, prompt: string, input: string): Promise<Out>
}
