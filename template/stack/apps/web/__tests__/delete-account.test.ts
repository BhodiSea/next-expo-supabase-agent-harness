import { describe, expect, it, vi } from 'vitest'
import { deleteAccount } from '../lib/account/delete-account'

// The web half of DSR erase, held to the same three cases the mobile half's
// apps/mobile/__tests__/actions-modal.test.tsx already covers — because "the surface exists"
// and "the surface behaves" are different claims, and only the second one keeps a user's
// session from being thrown away against a live account.
//
// The component is NOT under test here and deliberately so: apps/web/app/** is excluded from
// the unit lane and diff-coverage, which is exactly why the choreography lives in lib/.

/** A browser-client double exposing only the two members the seam touches. */
function client({ error = null }: { error?: { message: string } | null } = {}) {
  // Promise.resolve rather than `async () =>`: an async arrow with no await is a
  // require-await error under the shipped config, and these doubles have nothing to await.
  const signOut = vi.fn(() => Promise.resolve({ error: null }))
  const invoke = vi.fn(() => Promise.resolve({ data: null, error }))
  return { double: { functions: { invoke }, auth: { signOut } }, invoke, signOut }
}

describe('deleteAccount', () => {
  it('deletes on the server FIRST, and only then drops the local session', async () => {
    const { double, invoke, signOut } = client()
    const outcome = await deleteAccount(double as never)

    expect(outcome).toEqual({ status: 'deleted' })
    expect(invoke).toHaveBeenCalledWith('delete-account')
    expect(signOut).toHaveBeenCalledOnce()
    // ORDER IS THE CONTRACT: signing out first discards the bearer token the Edge Function
    // authenticates with, so a later failure would leave a live account and a client that
    // can no longer ask to delete it.
    //
    // The infinities are the honest defaults under noUncheckedIndexedAccess: if either call
    // never happened the comparison FAILS, where `?? 0` on both sides would have passed.
    expect(invoke.mock.invocationCallOrder.at(0) ?? Number.POSITIVE_INFINITY).toBeLessThan(
      signOut.mock.invocationCallOrder.at(0) ?? Number.NEGATIVE_INFINITY,
    )
  })

  it('a failed deletion KEEPS the session — nothing half-deletes', async () => {
    const { double, signOut } = client({ error: { message: 'boom' } })
    const outcome = await deleteAccount(double as never)

    expect(outcome).toEqual({ status: 'failed', detail: 'boom' })
    expect(signOut).not.toHaveBeenCalled()
  })

  it('carries the provider text as DETAIL, never as the headline', async () => {
    // A FunctionsError is not an AppError, so there is no envelope `code` to key copy off.
    // The rendered string comes from the catalog; this value is for the operator.
    const { double } = client({ error: { message: 'FunctionsHttpError: 503' } })
    await expect(deleteAccount(double as never)).resolves.toEqual({
      status: 'failed',
      detail: 'FunctionsHttpError: 503',
    })
  })
})
