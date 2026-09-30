// supabase/functions/delete-account/index.ts — the store-compliance slice's one
// piece of elevated code, and the scaffold's worked example of an Edge Function.
//
// A SHELL, ON PURPOSE (1.1.0). Everything this function decides — which key it runs with,
// who the caller is, and the order in which the caller's data leaves — lives in
// handler.ts, which names no Deno global and no jsr:/npm: specifier, so vitest runs it
// (handler.test.ts), the unit floor measures it and the mutation lane mutates it. This
// file binds the handler to the Deno runtime and to supabase-js and does nothing else,
// because nothing Node-side can load it: `tools/check-edge-functions.mjs` typechecks it
// with `deno check` against deno.json (the exact supabase-js version) and the frozen
// deno.lock beside it. Read handler.ts for why the sweep runs before deleteUser and why
// that order is not negotiable.
//
// SOURCE: supabase/functions/README.md (Edge Functions are the one sanctioned
// home for service-role code) · docs/adr/20260720-account-deletion.md
import { createClient } from '@supabase/supabase-js'
import { createDeleteAccountHandler } from './handler.ts'

// Env is injected by the platform; none of it is committed. The handler reads it once, here,
// at cold start.
Deno.serve(
  createDeleteAccountHandler({
    env: (name) => Deno.env.get(name),
    connect: (url, key, options) => createClient(url, key, options),
  }),
)
