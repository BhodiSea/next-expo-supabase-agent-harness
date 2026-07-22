import { readFileSync } from 'node:fs'
import { z } from 'zod'

// The versioned extraction contract. The prompt file is immutable once
// committed — tools/prompts.lock.json pins its sha256 and the `prompts` gate
// re-hashes it on every validate run; to change behavior, add extract.v2.md
// and a new lock entry instead of editing v1. The schema below is the exact
// shape the prompt instructs the model to emit (strict: unknown keys reject).
// SOURCE: harness doctrine — prompts are versioned committed files whose
// hashes are locked in tools/prompts.lock.json [corpus: harness/doctrine]

export const extractionResultSchema = z.strictObject({
  tags: z.array(
    z.strictObject({
      axis: z.string().min(1),
      code: z.string().min(1),
      // Provenance: a verbatim quote plus 0-based, end-exclusive character
      // offsets into the item text, so every tag is auditable against its
      // source (input.slice(start, end) === quote). The refine catches
      // internally-inconsistent offsets without needing the input; grounding
      // against the ACTUAL text is parseExtraction's job below.
      evidence: z
        .strictObject({
          quote: z.string().min(1),
          start: z.int().nonnegative(),
          end: z.int().nonnegative(),
        })
        .refine((e) => e.end > e.start && e.quote.length === e.end - e.start, {
          message: 'evidence offsets must be end-exclusive with end - start === quote.length',
        }),
    }),
  ),
})

export type ExtractionResult = z.output<typeof extractionResultSchema>

// Every accepted extraction must GROUND its evidence in the actual item text.
// The schema alone cannot see the input, and a model emitting a plausible
// quote with wrong offsets would otherwise score green while being
// unauditable — the eval's provenance story would be decorative. Returns one
// message per mismatch (empty = fully grounded).
export function verifyEvidence(itemText: string, result: ExtractionResult): string[] {
  const mismatches: string[] = []
  for (const [i, tag] of result.tags.entries()) {
    const { quote, start, end } = tag.evidence
    const actual = itemText.slice(start, end)
    if (actual !== quote) {
      mismatches.push(
        `tags[${String(i)}] (${tag.axis}/${tag.code}): input[${String(start)}, ${String(end)}) is ${JSON.stringify(actual)}, not ${JSON.stringify(quote)}`,
      )
    }
  }
  return mismatches
}

// THE entry point for turning a raw model reply into an accepted extraction:
// schema-valid AND evidence-grounded, or it throws. Live adapters and the
// eval pipeline both come through here — there is no accept-without-audit path.
export function parseExtraction(itemText: string, raw: unknown): ExtractionResult {
  const result = extractionResultSchema.parse(raw)
  const mismatches = verifyEvidence(itemText, result)
  if (mismatches.length > 0) {
    throw new Error(
      `extraction evidence does not ground in the item text:\n${mismatches.join('\n')}`,
    )
  }
  return result
}

export function loadExtractionPrompt(): string {
  return readFileSync(new URL('../prompts/extract.v1.md', import.meta.url), 'utf8')
}
