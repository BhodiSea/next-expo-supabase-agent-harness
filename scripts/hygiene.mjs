#!/usr/bin/env node
// Hygiene gate for the harness repo itself.
// 1. Leaked-string scan: nothing project-specific from the source codebase may
//    appear anywhere under template/ (the shipped artifact must be generic).
// 2. Placeholder closure: every {{VAR}} used in template/ must exist in the
//    installer's placeholder registry, and every registry var must be used.
// 3. Determinism sweep: no unsorted directory listing anywhere in the enforcement
//    surface. This is the factory holding ITSELF to a rule it ships to consumers —
//    see the section header below for why the ESLint rule cannot do this job.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { walkFiles } from '../installer/lib/fs-walk.mjs'
import { maturityClaims } from './lib/maturity-claim.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEMPLATE = join(ROOT, 'template')

// A gate that scans nothing is a false green — fail loudly, never skip.
if (!existsSync(TEMPLATE)) {
  console.error(`HYGIENE: FAIL — template dir not found at ${TEMPLATE}`)
  process.exit(1)
}

const LEAK_PATTERNS = [
  /cogvera/i,
  /medqbank/i,
  /uwa\b/i, // no client names in the shipped artifact
  /BhodiSea/, // template files must use {{GITHUB_OWNER}}, never the real handle
  /\/Users\//, // absolute developer paths
  /@cogveralabs/i,
  // Cross-porting detectors: these words appearing anywhere in template/ mean a
  // file was carried from a sibling harness unadapted. This lineage OWNS
  // Next.js + Expo + Supabase + Vercel, so `supabase` and `vercel` were dropped
  // from the inherited set — they are first-class vocabulary here. What remains
  // is the two siblings' server/desktop vocabulary, which must never appear:
  //   - hono + drizzle — the expo-postgres sibling's self-hosted server half.
  //     The whole template was retargeted to Supabase/tRPC (SQL-first migrations,
  //     the packages/api router, RLS) across the closure wave — guard machinery,
  //     then gate code + docs + CI + config, then the two opt-in module slices —
  //     and these two lines ARM last, once nothing carries them. Measured at W1
  //     this vocabulary lived in 65 template files; it is now zero, so no
  //     ALLOWLIST entry is needed. Re-entry is a hard red from here on.
  //   - tauri/cargo/vite/nsis/webview2 — the Tauri desktop harness.
  // Removing a pattern permanently removes a guard: extend ALLOWLIST for a
  // genuine one-file exception instead of deleting a line.
  /\bhono\b/i,
  /drizzle/i,
  /tauri/i,
  /\bcargo\b/i,
  /VITE_/,
  /\bvite\b/i,
  /\bnsis\b/i,
  /webview2/i,
  // Credential shapes — none may ever ship, even as "examples".
  /eyJ[A-Za-z0-9_-]{20,}\.eyJ/, // JWT structure (header.payload)
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, // PEM private keys (incl. ASC AuthKey .p8 bodies)
  /"type"\s*:\s*"service_account"/, // Google Play service-account JSON
  /[A-Za-z0-9._~-]{2,}8Q~[A-Za-z0-9._~-]{20,}/, // Entra/Azure client-secret shape
  /\/[^\s"']+\.gguf/, // absolute model paths are deployment config, never template content
  // Connection strings with credentials, except the documented local-dev
  // convention: password literally 'postgres', loopback host only.
  /postgres(?:ql)?:\/\/(?![a-z_]+:postgres@(?:127\.0\.0\.1|localhost))[^\s'"]+:[^\s'"]+@/,
]

// Files allowed to mention a pattern (path suffix → patterns allowed there).
const ALLOWLIST = new Map([
  // The secret-scanning POLICY must spell the shapes it detects — a scanner that cannot
  // contain its own patterns cannot have patterns. The same carve-out check-secrets.mjs
  // makes for tools/secret-patterns.json (allowPaths), and the same one the write-guard
  // makes for .claude/hooks/: a rule table has to contain the thing it bans.
  //
  // Both files are write-guard-protected and hash-pinned by gate-integrity, so hiding a
  // real credential in one is not a cheaper path than hiding it anywhere else — and the
  // entries here are per-PATTERN, so neither file gets a blanket pass.
  ['template/base/gitleaks.toml', [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]],
  [
    'template/base/tools/secret-patterns.json',
    [
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /"type"\s*:\s*"service_account"/,
      /postgres(?:ql)?:\/\/(?![a-z_]+:postgres@(?:127\.0\.0\.1|localhost))[^\s'"]+:[^\s'"]+@/,
    ],
  ],
])

const failures = []

// The shipped template scans EVERYTHING — no excluded directories.
for (const relPath of walkFiles(TEMPLATE)) {
  let text
  try {
    text = readFileSync(join(TEMPLATE, relPath), 'utf8')
  } catch {
    continue // binary
  }
  const rel = `template/${relPath}`
  for (const pattern of LEAK_PATTERNS) {
    if (!pattern.test(text)) continue
    const allowed = ALLOWLIST.get(rel)
    if (allowed?.some((a) => a.source === pattern.source)) continue
    const line = text.split('\n').findIndex((l) => pattern.test(l)) + 1
    failures.push(`${rel}:${line} matches leaked-string pattern ${pattern}`)
  }
}

// Placeholder closure (runs once the registry + manifest exist).
const registryPath = join(ROOT, 'installer/lib/placeholders.mjs')
if (existsSync(registryPath)) {
  // file:// URL, not the raw path — Windows absolute paths (D:\…) are not
  // importable by the ESM loader.
  const { PLACEHOLDERS } = await import(pathToFileURL(registryPath).href)
  const registered = new Set(Object.keys(PLACEHOLDERS))
  const used = new Set()
  for (const relPath of walkFiles(TEMPLATE)) {
    let text
    try {
      text = readFileSync(join(TEMPLATE, relPath), 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) used.add(m[1])
  }
  for (const v of used) {
    if (!registered.has(v)) failures.push(`template uses {{${v}}} but it is not in the placeholder registry`)
  }
  for (const v of registered) {
    if (!used.has(v)) failures.push(`placeholder registry declares ${v} but no template file uses it`)
  }
}

// ── 3. Determinism sweep: no unsorted directory listing ──────────────────────
//
// `readdir` returns entries in the FILESYSTEM's order — inode order on ext4, roughly
// creation order on APFS, arbitrary on a network mount. Anything derived from one (a
// generated manifest, a hash, an error list, a first-match-wins lookup) is therefore
// machine-dependent, and the failure is characteristically nasty: stable on the machine
// that wrote it, reordered on somebody else's, and read as flakiness rather than as a
// missing sort. For a harness whose entire thesis is that the gate returns the same
// verdict everywhere, this is the bug class that undermines the product itself.
//
// WHY THIS LIVES HERE AND NOT IN ESLINT. The harness ships `local/no-unsorted-readdir`
// and arms it on every consumer's `apps/**` and `packages/**`. It cannot reach the gate
// scripts, because `eslint.config.mjs` ignores `tools/**` by design (plain node, outside
// type-aware lint) — and `scripts/**` and `installer/**` are not in a consumer tree at
// all. So the surface that enforces determinism for everyone else would be the one
// surface exempt from it. This sweep is the answer, in the same spirit as
// scripts/check-complexity-ratchet.mjs: the check that stops the harness exempting itself.
//
// It is a TEXT sweep rather than an AST walk, and deliberately so: it has to cover
// `.mjs`, `.js` and `.tmpl` alike with no parser. That makes recognizing the LEGITIMATE
// shapes the whole design problem — the first draft reported four correct call sites out
// of ten, and a sweep that is 40% noise is a sweep whose findings get exempted reflexively
// rather than read. Three shapes are accepted, each because order provably cannot matter:
//
//   chained     `readdirSync(d).filter(…).map(…).sort()` — the sort is in the expression.
//   deferred    `entries = readdirSync(d)` … `entries.sort(…)` a few lines later. This is
//               not avoidable stylistic sloppiness: a listing wrapped in try/catch CANNOT
//               be chained through the catch, and fs-walk.mjs (the sorted walker everything
//               else is told to use) is itself written that way.
//   emptiness   `readdirSync(d).length === 0` — an emptiness test reads no entry at all.
//
// Everything else is reported with its line.
const DETERMINISM_ROOTS = [
  'template/base/tools',
  'template/base/.claude/hooks',
  'template/base/tests',
  'scripts',
  'installer',
]
const READDIR = /\breaddir(?:Sync)?\s*\(/
// The identifier a listing is bound to, so a sort a few statements later can be found.
const BOUND_TO = /(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:[\w$.]*\.)?readdir(?:Sync)?\s*\(/
let listingsChecked = 0
for (const root of DETERMINISM_ROOTS) {
  const abs = join(ROOT, root)
  if (!existsSync(abs)) continue
  for (const relPath of walkFiles(abs, { excludeDirs: ['node_modules'] })) {
    if (!/\.(mjs|js)(\.tmpl)?$/.test(relPath)) continue
    const lines = readFileSync(join(abs, relPath), 'utf8').split('\n')
    for (const [i, line] of lines.entries()) {
      if (!READDIR.test(line)) continue
      // Prose about the rule is not a call site — line comments, block-comment bodies,
      // and JSDoc openers alike. (`/**` was the miss that flagged this sweep's own
      // sibling rule: `//` and `*` were skipped, `/*` was not.)
      if (/^\s*(?:\/\/|\/\*|\*|#)/.test(line)) continue
      // Neither is the rule's OWN pattern. `readdir(?:Sync)?` is regex source: a call site
      // never has `(?:` after the name. Without this the sweep reports the line that
      // implements it — the same self-flagging shape check-db-limits.mjs hit when its
      // remediation text spelled the construction it was banning.
      if (/\breaddir(?:Sync)?\(\?:/.test(line)) continue
      listingsChecked += 1
      // chained: the sort rides the same expression (which may wrap over a few lines).
      if (/\.sort\s*\(/.test(lines.slice(i, i + 5).join(' '))) continue
      // emptiness: the listing is consumed by .length and no entry is ever read.
      if (/\.length\b/.test(line)) continue
      // deferred: the bound identifier is sorted shortly afterwards.
      const bound = BOUND_TO.exec(line)?.[1]
      if (bound !== undefined && new RegExp(`\\b${bound}\\s*\\.\\s*sort\\s*\\(`).test(lines.slice(i, i + 10).join('\n'))) {
        continue
      }
      failures.push(
        `${root}/${relPath}:${String(i + 1)} reads a directory without sorting it — readdir order is the filesystem's, so anything derived from it differs between machines. Chain \`.sort()\` in the same statement, sort the bound listing before use, or use the shared walker (fs-walk.mjs), which already sorts.`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 4. No NUL byte in a text file — the defect that makes a file unsearchable.
// ---------------------------------------------------------------------------
// A NUL makes a file `data` rather than text, and grep then skips it in SILENCE: no
// warning, exit 1, indistinguishable from "the pattern is not there". Three files in
// this repo carried one (query-shapes.mjs, check-mutation-ratchet.mjs and an installer
// test) because a NUL separator was TYPED into a string literal instead of written as
// the `\u0000` escape. The escape is the same character at runtime, so this costs
// nothing and buys back searchability.
//
// It is a sweep rather than a review note because it recurred while being FIXED: the
// changelog entry describing the problem was itself written with a literal NUL. A class
// of defect that survives the act of documenting it needs a machine watching for it.
//
// Binary assets are excluded by extension — a PNG is legitimately full of NULs. The list
// is deliberately short: anything not on it is text, so a new binary kind reds here and
// gets added on purpose rather than silently widening the exemption.
const BINARY_EXT = /\.(?:png|jpg|jpeg|gif|webp|ico|icns|pdf|woff2?|ttf|otf|zip|gz|jar|keystore)$/i
// THE SET IS `git ls-files`, NOT A FILESYSTEM WALK — and that is the whole fix.
//
// This sweep used to walk ROOT behind a hand-maintained exclude list (node_modules, .git,
// dist, build, .next, coverage) that knew nothing about `.gitignore`. So running THIS
// repo's own upgrade lane — which the release process REQUIRES, and which plants a git
// worktree at an OLD release tag under `.selftest/` — made the factory gate red on two
// files from v0.1.3 that predate this sweep entirely. A maintainer cannot fix a file in
// history: the available remedies were "delete your lane output" or "stop running the
// lane", and the second is the one people take. A gate that punishes running the release
// proof is a gate that deletes the release proof.
//
// The inflated counter is the worse half. `textFilesScanned` immediately below is this
// sweep's anti-vacuity control — "a sweep that scanned nothing is a false green" — and
// with six scratch scaffolds in scope it was counting trees that are not the harness. The
// number that is supposed to prove the sweep looked at THE REPOSITORY could not fall to
// zero while any scratch output existed, so the control could not fire.
//
// `--cached --others --exclude-standard` is exactly "the files this repository is made
// of": tracked, plus untracked-but-not-ignored so a new NUL reds BEFORE it is committed.
// It honours `.gitignore`, so the next scratch directory is out of scope by construction
// rather than by remembering to extend a literal here. Fails closed when git cannot
// answer: a filesystem walk cannot tell source from scratch, which is how this started.
// `-z` because a path may contain anything — including, fittingly, the byte in question.
let listing = ''
try {
  listing = execFileSync(
    'git',
    ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
} catch (err) {
  console.error(
    `HYGIENE: FAIL — cannot enumerate the repository with \`git ls-files\` (${err instanceof Error ? err.message : String(err)}). This sweep's subject is every file the repo is MADE of, and a filesystem walk cannot tell source from scratch output, so it fails closed rather than scanning the wrong tree.`,
  )
  process.exit(1)
}
// `--cached` then `--others` are each sorted but concatenated, so sort the union: this
// gate's own failure list has to be in the same order on every machine.
const repoFiles = listing.split('\u0000').filter(Boolean).sort()
// ---------------------------------------------------------------------------
// 5. No unearned Essential Eight maturity claim (0.9.9) — same listing, same loop.
// ---------------------------------------------------------------------------
// The register shipped in 0.9.9 maps all 149 requirements of ASD's Maturity Level Three
// and grades every one of them. What it must never become is the sentence a reader would
// carry into a procurement conversation, because that sentence is wrong in the direction
// that sells: maturity attaches to an organisation's system, ASD certifies no products,
// and a repo-scoped reading of the model yields Maturity Level ZERO rather than Three.
// The judgement lives in scripts/lib/maturity-claim.mjs (with its own stated limit); the
// reason it is a sweep and not a note in CONTRIBUTING is that the pressure to write the
// sentence arrives long after the review that would have caught it — a README edit for a
// launch, a changelog line, a design doc answering a customer.
//
// Scope is the WHOLE repository rather than template/, because the claim's natural home
// is the root README, and section 1 above never looks outside the shipped artifact.
//
// Two files carry the sentence legitimately, exempted per-file for the same reason
// ALLOWLIST exempts gitleaks.toml: a rule that may not contain the thing it bans cannot
// have a rule, and a red-proof that may not plant the violation cannot prove the red.
// Both are named files, never a directory — and the first is held to actually TRIPPING
// this rule by tests/gates/hygiene.test.mjs, so an exemption cannot outlive its reason.
// The second is defensive rather than load-bearing: the claim string the red-proof plants
// lives in that file, and whether the file reads as an assertion depends on how nearby
// prose happens to be worded, which is a poor thing for a proof to depend on.
const CLAIM_SWEEP_EXEMPT = new Map([
  ['scripts/lib/maturity-claim.mjs', 'the rule itself — it spells the claim shapes it denies'],
  ['tests/gates/hygiene.test.mjs', 'the red-proof — it plants the claim and asserts this sweep bites'],
])

let textFilesScanned = 0
for (const relPath of repoFiles) {
  if (BINARY_EXT.test(relPath)) continue
  // `--cached` lists a path deleted from the working tree but still in the index; a file
  // that is not there cannot carry a NUL.
  if (!existsSync(join(ROOT, relPath))) continue
  textFilesScanned += 1
  const buf = readFileSync(join(ROOT, relPath))
  const at = buf.indexOf(0)
  if (at === -1) {
    if (CLAIM_SWEEP_EXEMPT.has(relPath)) continue
    for (const { line, claim } of maturityClaims(buf.toString('utf8'))) {
      failures.push(
        `${relPath}:${String(line)} claims "${claim}". Nothing this repository generates holds an Essential Eight maturity level: maturity attaches to an organisation's SYSTEM, ASD certifies no products, and a repo-scoped reading of the model yields Maturity Level ZERO, not Three (template/base/docs/compliance/essential-eight.md sets out why, with sources). Say the true thing instead — this project produces machine-checkable evidence for the portions of an ML3 assessment a codebase can carry, and hands the rest to the operator.`,
      )
    }
    continue
  }
  const line = buf.subarray(0, at).toString('utf8').split('\n').length
  failures.push(
    `${relPath}:${String(line)} contains a literal NUL byte, which makes the whole file \`data\` rather than text — \`grep\` then skips it in silence and the file cannot be searched at all. If a NUL is meant as a separator, write it as the \`\\u0000\` escape (identical at runtime); if the file is binary, add its extension to BINARY_EXT.`,
  )
}

if (failures.length > 0) {
  console.error(`HYGIENE: FAIL (${failures.length})`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
// A sweep that scanned nothing is a false green, the same way the missing-template check
// at the top of this file is. Report both counts so a sweep that quietly stops finding
// files to look at shows up as a number that moved, not as continued silence.
if (textFilesScanned === 0) {
  console.error('HYGIENE: FAIL — the NUL sweep scanned 0 files, so its green means nothing')
  process.exit(1)
}
console.log(
  `HYGIENE: CLEAN (${String(listingsChecked)} directory listing(s) sorted; ${String(textFilesScanned)} text file(s) free of NUL bytes and of unearned maturity claims)`,
)
