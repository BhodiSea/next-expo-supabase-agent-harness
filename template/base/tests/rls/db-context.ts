// Shared helpers for the RLS suite: unprivileged connections with transaction-local
// user impersonation, mirroring apps/server/src/db/context.ts exactly — the tests
// must exercise the same GUC discipline the app uses.
// Pool max=1 ON PURPOSE: every impersonated transaction reuses the one physical
// connection, so a session-scoped GUC leak (the bug class this suite exists to
// catch) becomes observable instead of hidden by connection rotation.
// SOURCE: docs/harness/README.md (RLS testing doctrine) [corpus: postgres/guc-set-local]
import postgres from 'postgres'

export const RLS_SUITE_READY = process.env['RLS_SUITE_READY'] === '1'

export function appSql() {
  const url = process.env['DATABASE_URL']
  if (!url) throw new Error('DATABASE_URL not set (run via node tests/rls/run-rls.mjs)')
  return postgres(url, { max: 1, prepare: false })
}

export type Sql = ReturnType<typeof appSql>

// Impersonate a user for exactly one transaction (SET LOCAL via set_config third
// arg true) — identical shape to the server's withUserContext.
export async function withUser<T>(
  sql: Sql,
  userId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${userId}, true)`
    return fn(tx)
  }) as Promise<T>
}

// Tables under isolation test. Add an entry per user-scoped table; the suite
// asserts the full read/write isolation matrix for each.
export interface IsolationTarget {
  table: string
  ownerColumn: string
  seedRow: (ownerId: string) => Record<string, unknown>
}

export const ISOLATION_TARGETS: IsolationTarget[] = [
  {
    table: 'notes',
    ownerColumn: 'owner_id',
    seedRow: (ownerId) => ({
      owner_id: ownerId,
      title: 'rls probe',
      body: 'seeded by the isolation suite',
    }),
  },
]

export const USER_A = '11111111-1111-4111-8111-111111111111'
export const USER_B = '22222222-2222-4222-8222-222222222222'
