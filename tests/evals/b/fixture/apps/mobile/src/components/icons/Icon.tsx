import Svg, { Path } from 'react-native-svg'
import { iconSize, usePalette } from '../../theme/theme'

// The one icon primitive. The glyph set is a CLOSED union of template-owned
// path data (24×24 grid, stroke 2, round caps/joins — the shared line-icon
// idiom), so iconography cannot fork into mixed sets: growing the vocabulary
// means adding a named glyph HERE, in review. Size comes from the sizing.icon
// tokens; color from the palette by token name. Icons are DECORATIVE by
// construction — meaning always rides the adjacent text/label, so the svg is
// hidden from assistive tech (a tab or toast never reads its glyph aloud
// twice). react-native-svg is one-door'd to this directory (eslint).
// SOURCE: WCAG 2.2 SC 1.1.1 — decorative graphics are implemented so AT can
// ignore them https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html
const GLYPHS = {
  house: ['M3 11 12 3l9 8', 'M5 10v10h14V10', 'M10 20v-6h4v6'],
  grid: ['M4 4h16v16H4z', 'M4 12h16', 'M12 4v16'],
  alertTriangle: ['M12 3 22 20H2z', 'M12 9v5', 'M12 17h.01'],
  checkCircle: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'm8 12 3 3 5-6'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 11v5', 'M12 8h.01'],
  chevronRight: ['m9 6 6 6-6 6'],
} as const

type IconName = keyof typeof GLYPHS
/** Palette token names an icon may take its ink from — status hues included. */
type IconTone = 'ink' | 'ink-muted' | 'accent' | 'danger' | 'success'

interface IconProps {
  readonly name: IconName
  readonly size?: keyof typeof iconSize
  readonly tone?: IconTone
  readonly testID?: string
}

export function Icon({ name, size = 'md', tone = 'ink-muted', testID }: IconProps) {
  const palette = usePalette()
  const dim = iconSize[size]
  return (
    <Svg
      width={dim}
      height={dim}
      viewBox="0 0 24 24"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      // Svg's prop types reject an explicit undefined testID under
      // exactOptionalPropertyTypes — spread it only when present.
      {...(testID === undefined ? {} : { testID })}
    >
      {GLYPHS[name].map((d) => (
        <Path
          key={d}
          d={d}
          stroke={palette[tone]}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ))}
    </Svg>
  )
}
