import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Compose class names: `clsx` flattens conditionals, `tailwind-merge` resolves the
 * conflicts clsx cannot see.
 *
 * Both halves are load-bearing. `clsx('p-2', cond && 'p-4')` yields `"p-2 p-4"`, and
 * CSS resolves that by SOURCE ORDER in the generated stylesheet — not by the order
 * the strings were concatenated. So the padding a component ends up with depends on
 * which utility Tailwind happened to emit last, which is stable enough to look
 * correct in review and to break when an unrelated file adds a class. twMerge keeps
 * the last-written one and drops the rest, which is what every caller already assumed
 * was happening.
 *
 * This is also what makes `className` an honest override prop: a caller passing
 * `className="p-6"` beats the component's own `p-4` deterministically, so overriding a
 * primitive never requires `!important` (and never silently fails).
 *
 * NOTE — the native design system ships a `cn` with the SAME name and signature but
 * WITHOUT twMerge: tailwind-merge's conflict map is generated per Tailwind major, and
 * mobile is pinned to v3 while this side is v4. Running the v4 map over v3 class names
 * drops classes silently, which is strictly worse than not merging at all.
 * SOURCE: Tailwind utilities resolve by stylesheet source order, not by the order
 * class names appear in the attribute — the CSS cascade, not the class list
 * https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Cascade
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
