import type { ReactNode } from 'react'
import { View } from 'react-native'
import { cn } from './cn'
import { Text } from './Text'
import { emptyStateVariants } from './variants'

export interface EmptyStateProps {
  /** What is not here. A noun phrase, not "No data" — the user knows what they opened. */
  readonly title: string
  /** WHY it is empty, or what to do about it. */
  readonly description?: string
  /** The one action that resolves the emptiness. One, not a toolbar. */
  readonly action?: ReactNode
  readonly className?: string
  readonly testID?: string
}

// The empty state is a real screen state, not an absence of one — which is why it is a
// primitive with a required title rather than a `{items.length === 0 && <Text>none</Text>}`
// at each call site. Those all drift, and half of them never get written at all.
//
// `action` is a slot rather than a label/handler pair, exactly as on the web: the action is
// frequently a navigation, sometimes a Button, occasionally two words of prose. A label prop
// would force every one of those through a Button that is wrong for it. The one platform
// caveat is that the prose case must arrive already wrapped in a <Text> — React Native
// cannot render a bare string inside a View, and it says so by throwing at runtime rather
// than by failing to typecheck, which is why it is written down here.
//
// There is no `as` prop to mirror. Heading LEVEL is document structure and this platform has
// no document — `Text.as` is WEB-ONLY, so the twin's <h3> has no element to become here. What
// the platform does have is the header trait, which is what a screen reader's heading list
// actually reads, so the title carries that instead. It goes on a wrapping View because
// Text's prop set is closed on purpose: a component whose whole job is to be identical on
// both surfaces must not grow a one-platform accessibility prop.
// SOURCE: React Native accessibilityRole 'header' marks an element as a heading for
// assistive technology https://reactnative.dev/docs/accessibility#accessibilityrole
export function EmptyState({ title, description, action, className, testID }: EmptyStateProps) {
  return (
    <View testID={testID} className={cn(emptyStateVariants(), className)}>
      {/* `accessible` collapses the wrapper and its Text into ONE element: without it the
          role sits on a node that has no name of its own and the heading is announced
          empty. */}
      <View accessible accessibilityRole="header">
        {/* text-center on the TEXT, never on the container. The web twin's variant string
            ends in `text-center` and every string inside inherits it through the cascade;
            here nothing inherits — a View cannot set the alignment of text it does not
            itself render — so the alignment has to sit on each Text. That is exactly why
            the native emptyStateVariants has no `text-center` to mirror, and why a
            reviewer diffing the two variant strings should expect that one difference.
            SOURCE: React Native has limited style inheritance — text styles apply only
            inside a Text subtree https://reactnative.dev/docs/text#limited-style-inheritance */}
        <Text size="lg" weight="semibold" className="text-center">
          {title}
        </Text>
      </View>
      {description === undefined ? null : (
        <Text size="sm" tone="muted" className="text-center">
          {description}
        </Text>
      )}
      {action}
    </View>
  )
}
