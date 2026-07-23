import { type ClassValue, clsx } from 'clsx'

/**
 * Compose class names for NativeWind. Same name and same signature as the web design
 * system's `cn`, deliberately — a screen moving between surfaces should not have to
 * rename its helper.
 *
 * WITHOUT tailwind-merge, and that is the whole reason this file exists separately.
 * tailwind-merge ships a conflict map GENERATED FOR ONE TAILWIND MAJOR: it decides
 * that `p-2` and `p-4` collide by matching class names against a table of that
 * version's utility groups. Web here is Tailwind v4; mobile is pinned to v3 because
 * NativeWind 4 requires it. Running the v4 map over v3 class names does not throw and
 * does not warn — it silently misclassifies the classes whose names moved between the
 * majors and drops the wrong one, which is strictly worse than not merging at all.
 *
 * What replaces it: NativeWind compiles a class string into a React Native style
 * object, so duplicate utilities resolve in the order they appear IN THE STRING —
 * last one wins. `cn(base, className)` therefore still gives a caller's override the
 * last word. On the web that property does not hold for free, which is exactly why
 * twMerge is in the chain there: the browser resolves competing declarations by the
 * cascade (specificity, then stylesheet source order), not by the order the class
 * names were written in the attribute.
 * SOURCE: the CSS cascade resolves competing declarations by origin, specificity and
 * source order — never by the order class names appear on the element
 * https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascade/Cascade
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}
