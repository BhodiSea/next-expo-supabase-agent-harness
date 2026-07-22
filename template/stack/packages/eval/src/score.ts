// Per-axis precision / recall / F1 over closed-set tags.
//
// One Tag is one (axis, code) claim about one item. Matching is set-based per
// item (duplicate claims collapse), aggregation is micro: true/false positive
// and false negative counts are summed across items per axis BEFORE the
// ratios are taken, so axes with many items dominate their own score but
// never each other's.

export interface Tag {
  readonly axis: string
  readonly code: string
}

export interface ScoredItem {
  readonly gold: readonly Tag[]
  readonly predicted: readonly Tag[]
}

export interface AxisScore {
  readonly axis: string
  readonly truePositives: number
  readonly falsePositives: number
  readonly falseNegatives: number
  readonly precision: number
  readonly recall: number
  readonly f1: number
}

interface Counts {
  tp: number
  fp: number
  fn: number
}

/**
 * Score predicted tags against gold tags, per axis. Axes are collected from
 * both sides (a hallucinated axis still shows up — with precision 0), and the
 * report is sorted by axis name so output is stable for fixtures and diffs.
 */
export function scoreItems(items: readonly ScoredItem[]): AxisScore[] {
  const byAxis = new Map<string, Counts>()
  for (const item of items) {
    const gold = uniqueTags(item.gold)
    const predicted = uniqueTags(item.predicted)
    for (const [key, tag] of predicted) {
      bump(byAxis, tag.axis, gold.has(key) ? 'tp' : 'fp')
    }
    for (const [key, tag] of gold) {
      if (!predicted.has(key)) bump(byAxis, tag.axis, 'fn')
    }
  }
  return [...byAxis.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([axis, counts]) => {
      const precision = ratio(counts.tp, counts.tp + counts.fp)
      const recall = ratio(counts.tp, counts.tp + counts.fn)
      return {
        axis,
        truePositives: counts.tp,
        falsePositives: counts.fp,
        falseNegatives: counts.fn,
        precision,
        recall,
        f1: ratio(2 * precision * recall, precision + recall),
      }
    })
}

function uniqueTags(tags: readonly Tag[]): Map<string, Tag> {
  const out = new Map<string, Tag>()
  for (const tag of tags) out.set(JSON.stringify([tag.axis, tag.code]), tag)
  return out
}

function bump(byAxis: Map<string, Counts>, axis: string, field: keyof Counts): void {
  const counts = byAxis.get(axis) ?? { tp: 0, fp: 0, fn: 0 }
  counts[field] += 1
  byAxis.set(axis, counts)
}

// Zero-division convention: an undefined ratio (0/0) scores 0, never 1 — an
// axis with no predictions gets precision 0 and an axis with no gold gets
// recall 0, so empty output can never read as a perfect score.
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}
