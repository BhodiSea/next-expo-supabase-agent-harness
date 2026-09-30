// Parity proof for template/base/tools/lib/derender.mjs (1.1.0, #84).
//
// gate-integrity's escape-list plant rule asks whether a harness release planted the bytes on
// disk (tools/lib/planted-shas.json). A variant with token `sites` is judged by rebuilding the
// template SOURCE from the installed copy, which is what installer/lib/provenance.mjs's
// `derender` does for `update`. An install has no installer/ directory, so the gate carries a
// pure copy, and a copy that drifted from the installer's would make the two disagree about
// the same file: `update` would call it a release's bytes and the gate would call it a
// widening, or the reverse. This file runs both on one shared set of cases, including every
// escape list the live template ships with tokens, rendered with probe answers.
//
// No git, no scaffold: it runs on the Windows leg too.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderEntry, templateRoot, walkTemplate } from '../../installer/lib/copy.mjs'
import { render, tokenSites } from '../../installer/lib/placeholders.mjs'
import { derender as installerDerender } from '../../installer/lib/provenance.mjs'
import { templateTrees } from '../../scripts/lib/released-shas.mjs'
import { ESCAPE_LISTS } from '../../template/base/tools/lib/enforcement-surface.mjs'
import { derender as toolsDerender } from '../../template/base/tools/lib/derender.mjs'

/** @typedef {[installed: string, sites: Array<[number, string]>, answers: Record<string, unknown>]} Case */

/** @type {Array<[string, Case]>} */
const CASES = [
  ['no sites: the text is the source', ['plain text\n', [], {}]],
  ['one site, answered', ['owner: @o/sec\n', [[7, 'SECURITY_OWNERS']], { SECURITY_OWNERS: '@o/sec' }]],
  ['one site, left literal (an install older than the token)', ['owner: {{SECURITY_OWNERS}}\n', [[7, 'SECURITY_OWNERS']], { SECURITY_OWNERS: '@o/sec' }]],
  ['one site, no answer recorded', ['owner: {{SECURITY_OWNERS}}\n', [[7, 'SECURITY_OWNERS']], {}]],
  [
    'two sites, the second offset measured in SOURCE coordinates',
    ['a @x b @y\n', [[2, 'A'], [10, 'B']], { A: '@x', B: '@y' }],
  ],
  ['an answer with spaces', ['by Proof App.\n', [[3, 'PROJECT_NAME']], { PROJECT_NAME: 'Proof App' }]],
  ['an answer carrying the token opener', ['x probe{{0 y\n', [[2, 'T']], { T: 'probe{{0' }]],
  ['the rendered value edited: null', ['owner: @o/other\n', [[7, 'SECURITY_OWNERS']], { SECURITY_OWNERS: '@o/sec' }]],
  ['the answers changed since install: null', ['owner: @o/sec\n', [[7, 'SECURITY_OWNERS']], { SECURITY_OWNERS: '@o/new' }]],
  ['a site past the end: null', ['short', [[40, 'T']], { T: 'v' }]],
  ['sites not ascending: null', ['a v b v\n', [[6, 'T'], [2, 'T']], { T: 'v' }]],
  ['a numeric answer', ['n=3\n', [[2, 'N']], { N: 3 }]],
  ['an edit elsewhere survives into the rebuilt text', ['owner: @o/sec EDITED\n', [[7, 'SECURITY_OWNERS']], { SECURITY_OWNERS: '@o/sec' }]],
]

for (const [name, [installed, sites, answers]] of CASES) {
  test(`parity: ${name}`, () => {
    assert.equal(toolsDerender(installed, sites, answers), installerDerender(installed, sites, answers))
  })
}

test('the cases are not vacuous: both nulls and rebuilt sources occur', () => {
  const results = CASES.map(([, [i, s, a]]) => toolsDerender(i, s, a))
  assert.ok(results.filter((r) => r === null).length >= 4)
  assert.ok(results.filter((r) => typeof r === 'string' && r.includes('{{')).length >= 4)
})

test('parity over every placeholder-bearing escape list the template ships, rendered and derendered', () => {
  const wanted = new Set(ESCAPE_LISTS)
  const answers = { SECURITY_OWNERS: '@proof-owner/one @proof-owner/two', PROJECT_NAME: 'Proof App', GITHUB_OWNER: 'proof-owner', DEFAULT_BRANCH: 'trunk' }
  let seen = 0
  for (const tree of templateTrees(templateRoot())) {
    for (const entry of walkTemplate(tree)) {
      if (!wanted.has(entry.installPath)) continue
      const source = renderEntry(entry, {})
      if (typeof source !== 'string') continue
      const sites = tokenSites(source)
      if (sites.length === 0) continue
      seen += 1
      const installed = render(source, answers)
      assert.equal(toolsDerender(installed, sites, answers), source, entry.installPath)
      assert.equal(toolsDerender(installed, sites, answers), installerDerender(installed, sites, answers), entry.installPath)
    }
  }
  assert.ok(seen >= 2, `only ${String(seen)} placeholder-bearing escape list(s) — rls-exempt.json and backup-posture.json carry SECURITY_OWNERS`)
})
