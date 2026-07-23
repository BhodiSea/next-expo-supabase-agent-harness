import type { MessageKey } from '../../i18n'

// The typed action registry — the mobile successor of the desktop original's
// keyboard/command registry, minus the key bindings: this host has no
// hardware-keyboard surface in the base app, so there are no `keys` combos and
// no key-hint column (PORT NOTE: a keyboard module can reintroduce both; the
// data model below deliberately leaves room — an added optional field, not a
// reshape).
//
// The GROUP UNION is the load-bearing type: adding a command with a new section
// is a deliberate one-line extension HERE, and omitting `group` on any command
// is a compile error — no command can ship outside the sectioned rendering.
// These are machine IDS, not copy (the desktop original once made them the
// visible headers, which welded the type system to English): the header copy
// lives in the catalog under `actions.group.<id>` and translates freely without
// touching a single command.
export type ActionGroup = 'navigation' | 'notes' | 'session'

/**
 * What a command needs from its host screen to run. Injected — the registry is
 * a data module and must stay import-pure (no expo-router, no auth): the modal
 * owns navigation and session plumbing and hands them in.
 */
export interface ActionContext {
  /** Navigate to an app path (the modal closes itself first). */
  readonly navigate: (path: string) => void
  /** Drop the session and return to sign-in. */
  readonly signOut: () => Promise<void>
  /**
   * In-app account deletion (Apple 5.1.1(v)): the host confirms destructively,
   * invokes the deletion Edge Function, then signs out. Fire-and-forget from a
   * command's point of view — the host owns the confirm/error choreography, and
   * the registry stays import-pure (no auth client, no navigation) so ranking
   * remains a pure function this module can be tested through.
   */
  readonly deleteAccount: () => void
}

export interface ActionCommand {
  readonly id: string
  /** Catalog key for the human title — resolve with t() at RENDER time, so the
   *  ranked list follows a locale switch. Ranking runs over the RESOLVED title:
   *  the user searches the text they can see, in their language. */
  readonly titleKey: MessageKey
  /** Section this command renders under. REQUIRED — see ActionGroup above. */
  readonly group: ActionGroup
  readonly run: (context: ActionContext) => void
}

// The base app's commands. Screens do not contribute contextual commands on
// this host (the desktop's register/unregister seam presumed a long-lived shell
// around routed panels; expo-router modals mount fresh) — the registry is one
// static, typed array, which is also what keeps ranking pure and testable.
export const ACTION_COMMANDS: readonly ActionCommand[] = [
  {
    id: 'nav.home',
    titleKey: 'command.goHome',
    group: 'navigation',
    run: (context) => {
      context.navigate('/')
    },
  },
  {
    id: 'nav.matrix',
    titleKey: 'command.goMatrix',
    group: 'navigation',
    run: (context) => {
      context.navigate('/matrix')
    },
  },
  {
    id: 'notes.create',
    titleKey: 'command.createNote',
    group: 'notes',
    run: (context) => {
      // Lands on Home with the composer focused (app/(tabs)/index.tsx reads the
      // param and forwards autoFocus to the NoteComposer).
      context.navigate('/?focus=composer')
    },
  },
  {
    id: 'session.signOut',
    titleKey: 'command.signOut',
    group: 'session',
    run: (context) => {
      void context.signOut()
    },
  },
  {
    // In-app account deletion — the store-compliance surface (Apple 5.1.1(v)):
    // the expo-policy gate's account-deletion closure asserts this id exists
    // whenever the app ships an auth surface.
    id: 'session.deleteAccount',
    titleKey: 'command.deleteAccount',
    group: 'session',
    run: (context) => {
      context.deleteAccount()
    },
  },
]
