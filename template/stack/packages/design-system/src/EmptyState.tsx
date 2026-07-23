import type { ReactNode } from 'react'
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
// primitive with a required title rather than a `{items.length === 0 && <p>none</p>}`
// at each call site. Those all drift, and half of them never get written at all.
//
// `action` is a slot rather than a label/handler pair: the action is frequently a link
// (navigate somewhere else), sometimes a button, occasionally two words of prose. A
// label prop would force every one of those through a Button that is wrong for it.
export function EmptyState({ title, description, action, className, testID }: EmptyStateProps) {
  return (
    <div className={cn(emptyStateVariants(), className)} data-testid={testID}>
      <Text as="h3" size="lg" weight="semibold">
        {title}
      </Text>
      {description === undefined ? null : (
        <Text size="sm" tone="muted">
          {description}
        </Text>
      )}
      {action}
    </div>
  )
}
