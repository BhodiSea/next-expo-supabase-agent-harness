import { describe, expect, it } from 'vitest'
import type { AxisScore, Tag } from './score.js'
import { scoreItems } from './score.js'

const tag = (axis: string, code: string): Tag => ({ axis, code })

const axisScore = (
  axis: string,
  counts: readonly [number, number, number],
  ratios: readonly [number, number, number],
): AxisScore => ({
  axis,
  truePositives: counts[0],
  falsePositives: counts[1],
  falseNegatives: counts[2],
  precision: ratios[0],
  recall: ratios[1],
  f1: ratios[2],
})

describe('scoreItems', () => {
  it('returns an empty report for no items', () => {
    expect(scoreItems([])).toEqual([])
  })

  it('scores a perfect prediction as 1/1/1', () => {
    const gold = [tag('subject', 'BIO')]
    expect(scoreItems([{ gold, predicted: gold }])).toEqual([
      axisScore('subject', [1, 0, 0], [1, 1, 1]),
    ])
  })

  it('zero-division edge: gold with no predictions scores 0, not 1 (precision 0/0)', () => {
    expect(scoreItems([{ gold: [tag('subject', 'BIO')], predicted: [] }])).toEqual([
      axisScore('subject', [0, 0, 1], [0, 0, 0]),
    ])
  })

  it('zero-division edge: predictions with no gold score 0, not 1 (recall 0/0)', () => {
    expect(scoreItems([{ gold: [], predicted: [tag('subject', 'BIO')] }])).toEqual([
      axisScore('subject', [0, 1, 0], [0, 0, 0]),
    ])
  })

  it('collapses duplicate claims within one item (set semantics)', () => {
    const result = scoreItems([
      { gold: [tag('subject', 'BIO')], predicted: [tag('subject', 'BIO'), tag('subject', 'BIO')] },
    ])
    expect(result).toEqual([axisScore('subject', [1, 0, 0], [1, 1, 1])])
  })

  it('scores each axis independently: one perfect axis, one missed axis', () => {
    const result = scoreItems([
      {
        gold: [tag('skill', 'RECALL'), tag('subject', 'BIO')],
        predicted: [tag('skill', 'RECALL'), tag('subject', 'CHEM')],
      },
    ])
    expect(result).toEqual([
      axisScore('skill', [1, 0, 0], [1, 1, 1]),
      axisScore('subject', [0, 1, 1], [0, 0, 0]),
    ])
  })

  it('micro-aggregates counts across items and sorts axes by name', () => {
    const result = scoreItems([
      { gold: [tag('subject', 'BIO')], predicted: [tag('subject', 'BIO')] },
      { gold: [tag('subject', 'CHEM')], predicted: [tag('subject', 'PHYS')] },
      { gold: [tag('difficulty', 'ADV')], predicted: [tag('difficulty', 'ADV')] },
    ])
    expect(result).toEqual([
      axisScore('difficulty', [1, 0, 0], [1, 1, 1]),
      axisScore('subject', [1, 1, 1], [0.5, 0.5, 0.5]),
    ])
  })

  it('the same code on different items counts once per item, not once overall', () => {
    const result = scoreItems([
      { gold: [tag('subject', 'BIO')], predicted: [tag('subject', 'BIO')] },
      { gold: [tag('subject', 'BIO')], predicted: [] },
    ])
    expect(result).toEqual([axisScore('subject', [1, 0, 1], [1, 0.5, 2 / 3])])
  })
})
