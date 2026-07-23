import type { AppError } from '@app/errors'
import { appError } from '@app/errors'
import { createSafeActionClient } from 'next-safe-action'

// The Server Action client. It lives here, OUTSIDE app/actions/notes.ts, because a
// 'use server' module may export nothing but async functions — exporting this builder from
// an action file is a build error, and defining it privately in every action file is how a
// project ends up with four different error-handling policies.
//
// next-safe-action buys exactly two things, and both are security properties rather than
// conveniences:
//
//   1. Input validation at the boundary. A Server Action is a PUBLIC HTTP ENDPOINT. Next
//      generates an id for it and anyone can POST arbitrary JSON to that id — the fact that
//      the only caller you wrote is a form on a page you control is irrelevant. Parsing with
//      the zod contract before the body reaches domain code is what makes the action's
//      TypeScript signature true at runtime instead of aspirational.
//   2. A single error boundary. Without one, an unexpected throw inside an action is
//      serialized to the client by Next with its message intact in development and a
//      digest in production — two different behaviours, one of which leaks internals.
//
// handleServerError is the redaction point. It returns an AppError (not next-safe-action's
// default string) so the failure arrives in the SAME shape as every other failure in the
// system: the tRPC procedure's envelope, the RSC read seam's model, and this action all hand
// screens one discriminated AppError to switch on.
// SOURCE: docs/security/sandbox-and-supply-chain.md (validate untrusted input at the
// boundary; never leak internals in an error) docs/harness/README.md
// The `: AppError` annotation on handleServerError is load-bearing, not decoration. apps/web
// emits declarations (tsconfig: composite + emitDeclarationOnly), so the exported `actionClient`
// must have a NAMEABLE type in its .d.ts. Left to inference, next-safe-action's `ServerError`
// type parameter would be whatever this callback returns; naming it `AppError` explicitly —
// with the type imported above — is what lets the declaration reference a real, exported name
// instead of an anonymous inferred shape (TS4023: "cannot be named").
export const actionClient = createSafeActionClient({
  handleServerError: (): AppError =>
    // Deliberately message-free about the cause. The thrown error's text may name a table,
    // a constraint or a connection string, and this value crosses the wire to a browser.
    // The diagnostic copy belongs in the server log that @app/observability owns; what the
    // caller gets is a stable code it can branch on and a sentence it can show a human.
    // `unknown` is the kernel's kind for an unclassified throw — there is no `unexpected`.
    appError.unknown({ message: 'The action could not be completed. Please try again.' }),
})
