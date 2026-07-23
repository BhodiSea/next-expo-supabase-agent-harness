import { router } from 'expo-router'
import { useState } from 'react'
import { Alert, ScrollView, View } from 'react-native'
import { AppText } from '../src/components/AppText'
import { EmptyState } from '../src/components/EmptyState'
import { Input } from '../src/components/Input'
import { OptionRow } from '../src/components/OptionRow'
import { Screen } from '../src/components/Screen'
import { useToast } from '../src/components/Toast'
import { rankCommands } from '../src/features/actions/fuzzyScore'
import { pushRecent, readRecents } from '../src/features/actions/recents'
import {
  ACTION_COMMANDS,
  type ActionCommand,
  type ActionContext,
  type ActionGroup,
} from '../src/features/actions/registry'
import { type MessageKey, useI18n } from '../src/i18n'
import { translateError } from '../src/i18n/errors'
import { useSupabase } from '../src/lib/supabase/provider'
import { ROUTES } from '../src/routes'
import { space, useThemedStyles } from '../src/theme/theme'

// The actions modal (presented by app/_layout.tsx) — the mobile successor of
// the desktop command palette: a search input over the typed registry, ranked
// by the same deterministic fuzzy scorer, with persisted recents pinned first
// ON THE EMPTY QUERY ONLY (the desktop discipline: the first typed character
// replaces the whole surface with ranked results — recency never biases
// ranking, which stays a pure function of (query, commands)).
//
// STATES HONESTY: the registry is a static in-process array, so `loading` and
// `error` are UNREACHABLE for this route — no fabricated spinner, no fake
// failure. The one truthful data state besides ready is EMPTY: a query that
// matches nothing (its manifest testID lands on that surface). The manifest
// keeps all three ids so the contract stays uniform; the states sweep documents
// the two that cannot occur here.

// ROUTES entry 2 IS the actions entry (id 'actions') — literal-typed testIDs.
const ACTIONS = ROUTES[2]

// The pinned-recents section id. Not an ActionGroup: no command declares itself
// 'recents' — the section is synthesized from storage below.
const RECENTS_SECTION = 'recents'

type SectionId = ActionGroup | typeof RECENTS_SECTION

/** The catalog key for a section header — every `actions.group.*` message is
 *  provably reachable from this one expression. */
function groupLabelKey(id: SectionId): MessageKey {
  return `actions.group.${id}`
}

/** A command with its title RESOLVED for the active locale — what ranking runs over. */
interface ResolvedCommand extends ActionCommand {
  readonly title: string
}

interface Section {
  readonly id: SectionId
  readonly commands: readonly ResolvedCommand[]
}

/** Bucket a (ranked or registration-ordered) list into sections, preserving
 *  order: a group's position is its best (earliest) member's position. */
function groupSections(commands: readonly ResolvedCommand[]): Section[] {
  const sections: { id: SectionId; commands: ResolvedCommand[] }[] = []
  const byId = new Map<SectionId, ResolvedCommand[]>()
  for (const command of commands) {
    const bucket = byId.get(command.group)
    if (bucket === undefined) {
      const fresh = [command]
      byId.set(command.group, fresh)
      sections.push({ id: command.group, commands: fresh })
    } else {
      bucket.push(command)
    }
  }
  return sections
}

// Recents-vs-ranked interplay (the pinned convention): Recents render ONLY on
// the EMPTY query — pinned first, above the grouped full list (a recent command
// also stays in its home group). Recent ids with no live command (a stale
// build's id) are filtered right here, where the live command set is known —
// storage keeps them for a build that has the command back.
function buildSections(
  query: string,
  commands: readonly ResolvedCommand[],
  recentIds: readonly string[],
): readonly Section[] {
  const grouped = groupSections(rankCommands(query, commands))
  if (query !== '') return grouped
  const byId = new Map(commands.map((command) => [command.id, command]))
  const recents = recentIds.flatMap((id) => {
    const command = byId.get(id)
    return command === undefined ? [] : [command]
  })
  if (recents.length === 0) return grouped
  return [{ id: RECENTS_SECTION, commands: recents }, ...grouped]
}

// A palette-less factory: the surviving styles are pure spacing — the row
// paint left with the control it dressed, into the OptionRow primitive.
const actionStyles = () => ({
  list: {
    gap: space[1],
  },
  sectionHeader: {
    paddingTop: space[2],
  },
})

export default function ActionsModal() {
  const { t } = useI18n()
  const styles = useThemedStyles(actionStyles)
  const toast = useToast()
  const supabase = useSupabase()
  const [query, setQuery] = useState('')
  // Raw persisted ids, read once at mount; every run keeps this in sync via
  // pushRecent's return value, so no render-time storage read can go stale
  // under the React Compiler's memoization.
  const [recentIds, setRecentIds] = useState(readRecents)

  // Titles resolve HERE, per render — ranking must run over the text the user
  // can see, in the locale they see it in.
  const commands: readonly ResolvedCommand[] = ACTION_COMMANDS.map((command) => ({
    ...command,
    title: t(command.titleKey),
  }))
  const sections = buildSections(query.trim(), commands, recentIds)
  const total = sections.reduce((sum, section) => sum + section.commands.length, 0)

  const context: ActionContext = {
    navigate: (path) => {
      router.navigate(path)
    },
    signOut: async () => {
      // `signOut()` clears the keychain-backed session store and stops the
      // refresh timer. It is awaited before the redirect so the sign-in screen
      // cannot mount over a session that is still, briefly, valid.
      await supabase.auth.signOut()
      router.replace('/sign-in')
    },
    deleteAccount: () => {
      // Destructive two-step: the native confirm is the second step Apple's
      // reviewers look for — no accidental single-tap deletion. On confirm:
      // server-side deletion first, THEN the local session drops and the app
      // returns to sign-in. Failures surface as the envelope-code toast (the
      // notes write-UX pattern) and the session survives — nothing half-deletes.
      // SOURCE: Apple App Review Guideline 5.1.1(v) — in-app account deletion
      // https://developer.apple.com/app-store/review/guidelines/#5.1.1
      //
      // WHY AN EDGE FUNCTION AND NOT A tRPC PROCEDURE. Deleting a user is the
      // one operation in this app that RLS cannot express: the row being
      // removed is the identity the policies are evaluated against, so no
      // policy-scoped client can perform it. It needs the service-role client,
      // and this workspace has exactly one sanctioned home for service-role
      // code — a Supabase Edge Function, ADR-governed, never the router and
      // never anything Metro can bundle. `functions.invoke` carries the
      // caller's own bearer token, so the function deletes the CALLER and has
      // no user id to be tricked about.
      // SOURCE: supabase/functions/README.md (Edge Functions are the one
      // sanctioned home for service-role code) · @app/supabase src/types.ts
      Alert.alert(t('account.delete.confirmTitle'), t('account.delete.confirmBody'), [
        { text: t('account.delete.cancel'), style: 'cancel' },
        {
          text: t('account.delete.confirm'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const { error } = await supabase.functions.invoke('delete-account')
              if (error !== null) {
                // A FunctionsError is not an AppError, and translateError is
                // built for exactly that: `isAppError` rejects it and it lands
                // in the honest fallback — "could not reach the server", which
                // is the only thing this app actually knows about a failed
                // invoke. The provider's own message rides along as the quiet
                // detail rather than becoming the headline.
                toast.show(translateError(error).message, 'error')
                return
              }
              await supabase.auth.signOut()
              router.replace('/sign-in')
            })()
          },
        },
      ])
    },
  }

  const runCommand = (command: ResolvedCommand): void => {
    setRecentIds(pushRecent(command.id))
    // Close the modal FIRST (the desktop original's order), then run — a
    // navigation command must land on the target screen, not under a modal.
    // Guarded: a deep launch straight into /actions has no history to pop.
    if (router.canGoBack()) router.back()
    command.run(context)
  }

  return (
    <Screen keyboard testID="actions-screen">
      <AppText variant="title">{t('route.actions')}</AppText>
      {/* eslint-disable-next-line react-native-a11y/has-accessibility-hint -- the label + placeholder already say everything a hint would; a third repetition is screen-reader noise */}
      <Input
        value={query}
        onChangeText={setQuery}
        placeholder={t('actions.placeholder')}
        accessibilityLabel={t('actions.search')}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        testID="actions-search"
      />
      {total === 0 ? (
        <EmptyState
          testID={ACTIONS.states.empty}
          title={t('actions.noMatch.title')}
          description={t('actions.noMatch.description')}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
          {sections.map((section) => (
            // Fragment-per-section, keyed on the section id; header + options
            // render flat (no wrapper Views for Fabric to flatten).
            <View key={section.id} style={styles.list}>
              <AppText variant="label" role="heading" style={styles.sectionHeader}>
                {t(groupLabelKey(section.id))}
              </AppText>
              {section.commands.map((command) => (
                // Rows render through the OptionRow primitive: the pressable
                // styling, role/label contract, and leaf testID live there.
                <OptionRow
                  key={`${section.id}:${command.id}`}
                  label={command.title}
                  testID={`action-${command.id}`}
                  onPress={() => {
                    runCommand(command)
                  }}
                />
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </Screen>
  )
}
