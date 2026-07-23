import { describe, expect, it } from 'vitest'
import { cn } from './cn'

describe('cn', () => {
  it('drops falsy entries instead of emitting "false" or "undefined"', () => {
    expect(cn('text-ink', false, undefined, null, '')).toBe('text-ink')
  })

  it('flattens arrays and conditional objects', () => {
    expect(cn(['flex', 'gap-2'], { 'text-danger': true, 'text-success': false })).toBe(
      'flex gap-2 text-danger',
    )
  })

  // THE reason twMerge is in the chain. Without it this returns "p-2 p-4" and the CSS
  // cascade — not the caller — decides which wins, by whichever utility Tailwind
  // happened to emit last. That is stable enough to look right in review and to change
  // when an unrelated file adds a class.
  it('resolves a conflicting utility to the last one written', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4')
    expect(cn('text-ink', 'text-ink-muted')).toBe('text-ink-muted')
  })

  it('keeps utilities from different groups side by side', () => {
    expect(cn('p-4', 'text-sm')).toBe('p-4 text-sm')
  })

  // This is what makes `className` an honest override prop on every component here: a
  // caller's class beats the component's own deterministically, so overriding a
  // primitive never needs !important and never silently fails.
  it('lets a caller override a component default', () => {
    const componentDefault = 'rounded-md bg-surface'
    expect(cn(componentDefault, 'bg-canvas')).toBe('rounded-md bg-canvas')
  })
})
