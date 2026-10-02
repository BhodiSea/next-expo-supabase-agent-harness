import { Tabs } from 'expo-router'
import { Icon } from '../../src/components/icons/Icon'
import { useI18n } from '../../src/i18n'
import { usePalette } from '../../src/theme/theme'

// The tab shell for the two content screens. Titles come from the catalog via
// useI18n (subscribed: a locale switch re-titles the bar live); colors are
// tokens through the palette hook — the navigator's option bag is config, not
// a style prop, so it reads raw hex from exactly one sanctioned source. Tab
// icons ride the closed glyph set, toned to match the label tint (accent when
// focused) — the icons are decorative, so the label remains the tab's name.
export default function TabsLayout() {
  const { t } = useI18n()
  const palette = usePalette()
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette['ink-muted'],
        tabBarStyle: {
          backgroundColor: palette.surface,
          borderTopColor: palette.edge,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('route.home'),
          tabBarIcon: ({ focused }) => (
            <Icon name="house" tone={focused ? 'accent' : 'ink-muted'} />
          ),
        }}
      />
      <Tabs.Screen
        name="matrix"
        options={{
          title: t('route.matrix'),
          tabBarIcon: ({ focused }) => <Icon name="grid" tone={focused ? 'accent' : 'ink-muted'} />,
        }}
      />
    </Tabs>
  )
}
