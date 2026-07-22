// @app/eval — public surface: model ports, deterministic fakes, the
// versioned extraction contract, and the fixture scorer.
export type { ExtractionResult } from './extract.js'
export {
  extractionResultSchema,
  loadExtractionPrompt,
  parseExtraction,
  verifyEvidence,
} from './extract.js'
export { FakeEmbeddingProvider, FakeInferenceProvider } from './fake.js'
export type { EmbeddingProvider, InferenceProvider } from './providers.js'
export type { AxisScore, ScoredItem, Tag } from './score.js'
export { scoreItems } from './score.js'
