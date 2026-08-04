#!/usr/bin/env node
// FACTORY dogfood: run the SHIPPED bash guard against the harness repo itself.
//
// A three-line re-export, never a fork. A forked copy drifts — the day the shipped rules
// gain a denial the factory keeps the old table, and the maintainer working on the guard
// is the one person it no longer guards. A shim makes this repo a live test of the exact
// bytes consumers get: the module resolves `./lib/guard-rules.mjs` relative to ITSELF, so
// it reads the shipped rule table, and every canary in tests/hooks/hook-contract.test.mjs
// is describing the guard that is running right now.
//
// SCOPE, stated so nobody expects more. The shipped guard's PATH patterns are
// consumer-relative (`tools/`, `.claude/`, `supabase/migrations/`), and in this repo those
// paths live under `template/base/`, so they do not match. What DOES bind here is every
// command-shape rule — rm -rf, force-push, reset --hard, --no-verify, .env and .dev-auth
// reads, pnpm update, knip --fix, destructive raw SQL, the gen-*lock writer — which is
// most of the table and all of the irreversible half. The factory's own enforcement
// surface is covered by the write-guard beside this file.
await import('../../template/base/.claude/hooks/pretool-bash-guard.mjs')
