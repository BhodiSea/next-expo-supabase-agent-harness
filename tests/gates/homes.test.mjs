// home(class) (template/base/tools/lib/homes.mjs, 2.1.0, #186): where one copy of a class of
// equal bodies can live, judged by the rule files the gates already enforce. Each fixture is
// one class of two or more equal bodies; the case names the home it must get and why:
// IMPORT to the member with the most importers that every other member may already import,
// MODULE inside one workspace, LIFT to a new packages/shared package where that is legal
// for every member, and NONE where it is not (web and mobile, a domain file, a platform leaf).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { home, loadForbidden } from '../../template/base/tools/lib/homes.mjs'
import { buildImporters } from '../../template/base/tools/lib/importers.mjs'
import { extractTree } from '../../template/base/tools/lib/shapes.mjs'
import { readCensus } from '../../template/base/tools/lib/workspace-tiers.mjs'
import { BODY, inTree, pkg, treeTest, ts } from './helpers/single-home.mjs'

// Read by path, not imported: the rule file is the scaffold's, not the factory's.
const DEPCRUISE = readFileSync(join(fileURLToPath(new URL('../../template/base/', import.meta.url)), 'dependency-cruiser.cjs'), 'utf8')

/**
 * home() of the class made of the one callable in each of `paths`, over the current tree.
 * @param {string[]} paths @param {any} [parser]
 */
function homeOf(paths, parser = ts) {
  const { callables } = extractTree(parser)
  const members = paths.map((p) => callables.find((c) => c.path === p))
  assert.ok(members.every(Boolean), `every fixture path holds a callable: ${paths.join(', ')}`)
  assert.equal(new Set(members.map((m) => m.alpha)).size, 1, 'the fixture is one class')
  const ctx = { importers: buildImporters(), census: readCensus(), forbidden: loadForbidden() }
  const litEqual = new Set(members.map((m) => m.lit)).size === 1
  const where = home({ lang: members[0].lang, members, litEqual }, ctx)
  return { kind: where.kind, target: where.target?.path ?? null }
}

const CROSS = {
  'packages/a/package.json': pkg('@app/a'),
  'packages/a/src/index.ts': "export { eventOf } from './m'\n",
  'packages/a/src/m.ts': BODY('eventOf'),
  'packages/a/src/use.ts': "import { eventOf } from './m'\nexport const u = eventOf\n",
  'packages/b/package.json': pkg('@app/b', ['@app/a']),
  'packages/b/src/index.ts': "export { eventFor } from './n'\n",
  'packages/b/src/n.ts': BODY('eventFor'),
  'packages/b/src/u1.ts': "import { eventFor } from './n'\nexport const u = eventFor\n",
  'packages/b/src/u2.ts': "import { eventFor } from './n'\nexport const u = eventFor\n",
}

treeTest('homes: IMPORT across workspaces goes to the copy every other member already depends on', () => {
  // @app/b's copy has more importers, but @app/a declares no dependency on @app/b, so it is
  // passed over for @app/a's, which @app/b reaches through its runtime dependency and the
  // `.` subpath of the exports map.
  inTree(CROSS, () => {
    assert.deepEqual(homeOf(['packages/a/src/m.ts', 'packages/b/src/n.ts']), {
      kind: 'import',
      target: 'packages/a/src/m.ts',
    })
  })
})

treeTest('homes: IMPORT across workspaces reads an aliased export, and a barrel that imports then re-exports', () => {
  const members = ['packages/a/src/m.ts', 'packages/b/src/n.ts']
  const aliased = {
    ...CROSS,
    'packages/a/src/index.ts': "export { makeEvent } from './m'\n",
    'packages/a/src/m.ts': `${BODY('eventOf').replace('export ', '')}export { eventOf as makeEvent }\n`,
    'packages/a/src/use.ts': "import { makeEvent } from './m'\nexport const u = makeEvent\n",
  }
  inTree(aliased, () => assert.deepEqual(homeOf(members), { kind: 'import', target: 'packages/a/src/m.ts' }))
  const forwarded = { ...CROSS, 'packages/a/src/index.ts': "import { eventOf } from './m'\nexport { eventOf }\n" }
  inTree(forwarded, () => assert.deepEqual(homeOf(members), { kind: 'import', target: 'packages/a/src/m.ts' }))
})

treeTest('homes: the most importers counts every name a member is exported by: alias, default, or both', () => {
  // x.ts's copy has 2 importers under whatever name it is exported by; y.ts's has 1.
  const local = BODY('first').replace('export ', '')
  const spellings = [
    { x: `${local}export { first as primary }\n`, imports: ["import { primary } from './x'", "import { primary } from './x'"] },
    { x: `${local}export { first as default }\n`, imports: ["import first from './x'", "import first from './x'"] },
    { x: `${local}export default first\n`, imports: ["import first from './x'", "import first from './x'"] },
    { x: `${BODY('first')}export default first\n`, imports: ["import first from './x'", "import { first } from './x'"] },
  ]
  for (const { x, imports } of spellings) {
    const tree = {
      'packages/c/package.json': pkg('@app/c'),
      'packages/c/src/x.ts': x,
      'packages/c/src/y.ts': BODY('second'),
      'packages/c/src/v0.ts': "import { second } from './y'\nexport const v = second\n",
      ...Object.fromEntries(
        imports.map((line, i) => [`packages/c/src/u${String(i)}.ts`, `${line}\nexport const u = 1\n`]),
      ),
    }
    inTree(tree, () => {
      assert.deepEqual(
        homeOf(['packages/c/src/x.ts', 'packages/c/src/y.ts']),
        { kind: 'import', target: 'packages/c/src/x.ts' },
        x,
      )
    })
  }
})

treeTest('homes: no IMPORT when the literals differ, so two workspaces with a legal lift get LIFT', () => {
  inTree({ ...CROSS, 'packages/b/src/n.ts': BODY('eventFor', 'tasks.created') }, () => {
    assert.deepEqual(homeOf(['packages/a/src/m.ts', 'packages/b/src/n.ts']), { kind: 'lift', target: null })
  })
})

treeTest('homes: IMPORT inside one workspace goes to the member with the most importers; a tie breaks by path', () => {
  const tree = (yImporters) => ({
    'packages/c/package.json': pkg('@app/c'),
    'packages/c/src/x.ts': BODY('first'),
    'packages/c/src/y.ts': BODY('second'),
    'packages/c/src/u0.ts': "import { first } from './x'\nexport const u = first\n",
    ...Object.fromEntries(
      Array.from({ length: yImporters }, (_, i) => [
        `packages/c/src/v${String(i)}.ts`,
        "import { second } from './y'\nexport const v = second\n",
      ]),
    ),
  })
  inTree(tree(2), () => {
    assert.deepEqual(homeOf(['packages/c/src/x.ts', 'packages/c/src/y.ts']), {
      kind: 'import',
      target: 'packages/c/src/y.ts',
    })
  })
  inTree(tree(1), () => {
    assert.deepEqual(homeOf(['packages/c/src/x.ts', 'packages/c/src/y.ts']), {
      kind: 'import',
      target: 'packages/c/src/x.ts',
    })
  })
})

treeTest('homes: the anatomy laws pick the target: a domain file may not import data/, so the domain copy is it', () => {
  inTree(
    {
      'packages/verticals/notes/package.json': pkg('@app/notes'),
      'packages/verticals/notes/src/domain/event.ts': BODY('eventOf'),
      'packages/verticals/notes/src/data/event.ts': BODY('eventFor'),
      'packages/verticals/notes/src/data/u1.ts': "import { eventFor } from './event'\nexport const u = eventFor\n",
      'packages/verticals/notes/src/data/u2.ts': "import { eventFor } from './event'\nexport const u = eventFor\n",
    },
    () => {
      assert.deepEqual(
        homeOf(['packages/verticals/notes/src/data/event.ts', 'packages/verticals/notes/src/domain/event.ts']),
        { kind: 'import', target: 'packages/verticals/notes/src/domain/event.ts' },
      )
    },
  )
})

treeTest('homes: MODULE inside one workspace when no member is exported, or the literals differ', () => {
  const tree = {
    'packages/c/package.json': pkg('@app/c'),
    'packages/c/src/x.ts': BODY('first').replace('export ', ''),
    'packages/c/src/y.ts': BODY('second').replace('export ', ''),
    'packages/c/src/p.ts': BODY('third'),
    'packages/c/src/q.ts': BODY('fourth', 'tasks.created'),
  }
  inTree(tree, () => {
    assert.deepEqual(homeOf(['packages/c/src/x.ts', 'packages/c/src/y.ts']), { kind: 'module', target: null })
    assert.deepEqual(homeOf(['packages/c/src/p.ts', 'packages/c/src/q.ts']), { kind: 'module', target: null })
  })
})

treeTest('homes: a copy nested in a function body is no export, though its module exports its name', () => {
  // x.ts exports a different `first`, which u0.ts imports; the copy in the constructor shares
  // only its name. Importing `first` would bring in the other body, so y.ts's copy is the target.
  const nested = `  constructor() {\n${BODY('first').replace('export ', '').replace(/^/gm, '    ')}  }\n`
  const exports = ['export function first(s: string): string', 'function first(s: string): string']
  for (const head of exports) {
    const tail = head.startsWith('export') ? '' : 'export { first }\n'
    const tree = {
      'packages/c/package.json': pkg('@app/c'),
      'packages/c/src/x.ts': `${head} {\n  return s.trim()\n}\nexport class Store {\n${nested}}\n${tail}`,
      'packages/c/src/y.ts': BODY('second'),
      'packages/c/src/u0.ts': "import { first } from './x'\nexport const u = first\n",
    }
    inTree(tree, () => {
      const { callables } = extractTree(ts)
      const copy = callables.find((c) => c.path === 'packages/c/src/y.ts')
      const members = callables.filter((c) => c.alpha === copy?.alpha)
      assert.deepEqual(members.map((m) => [m.path, m.line]), [['packages/c/src/x.ts', 6], ['packages/c/src/y.ts', 1]], head)
      const ctx = { importers: buildImporters(), census: readCensus(), forbidden: loadForbidden() }
      const where = home({ lang: 'ts', members, litEqual: true }, ctx)
      assert.deepEqual({ kind: where.kind, target: where.target?.path ?? null }, { kind: 'import', target: 'packages/c/src/y.ts' }, head)
    })
  }
})

const VERTICALS = {
  '.dependency-cruiser.cjs': DEPCRUISE,
  'packages/verticals/notes/package.json': pkg('@app/notes'),
  'packages/verticals/notes/src/index.ts': "export { eventOf } from './data/event'\n",
  'packages/verticals/notes/src/data/event.ts': BODY('eventOf'),
  'packages/verticals/tasks/package.json': pkg('@app/tasks', ['@app/notes']),
  'packages/verticals/tasks/src/data/event.ts': BODY('eventFor'),
}

treeTest('homes: LIFT for two verticals: the vertical wall stops IMPORT even with the dependency declared', () => {
  const members = ['packages/verticals/notes/src/data/event.ts', 'packages/verticals/tasks/src/data/event.ts']
  inTree(VERTICALS, () => {
    assert.deepEqual(homeOf(members), { kind: 'lift', target: null })
  })
  // workspace-tiers' vertical-vertical wall decides alone, with no .dependency-cruiser.cjs.
  const { '.dependency-cruiser.cjs': _rules, ...bare } = VERTICALS
  inTree(bare, () => {
    assert.deepEqual(homeOf(members), { kind: 'lift', target: null })
  })
})

treeTest('homes: the mobile wall stops IMPORT of a declared dependency the census does not sanction', () => {
  const tree = {
    'packages/x/package.json': pkg('@app/x'),
    'packages/x/src/index.ts': "export { f } from './m'\n",
    'packages/x/src/m.ts': BODY('f'),
    'apps/mobile/package.json': pkg('mobile', ['@app/x']),
    'apps/mobile/src/g.ts': BODY('g'),
  }
  const members = ['packages/x/src/m.ts', 'apps/mobile/src/g.ts']
  inTree(tree, () => assert.deepEqual(homeOf(members), { kind: 'none', target: null }))
  inTree({ ...tree, 'tools/exports-walls.json': '{"sanctioned":[{"package":"@app/x"}]}' }, () =>
    assert.deepEqual(homeOf(members), { kind: 'import', target: 'packages/x/src/m.ts' }),
  )
})

/** The scaffold's rule file with one more forbidden rule at the head of the list. */
const withRule = (rule) => DEPCRUISE.replace('forbidden: [', `forbidden: [\n    ${JSON.stringify(rule)},`)

treeTest('homes: only a rule at severity error forbids; warn, info, ignore and no severity do not', () => {
  const members = ['packages/verticals/notes/src/data/event.ts', 'packages/verticals/tasks/src/data/event.ts']
  const rule = (severity) => ({
    name: 'advise-shared',
    ...(severity === undefined ? {} : { severity }),
    from: { path: '^packages/verticals/' },
    to: { path: '^packages/shared/' },
  })
  for (const severity of ['warn', 'info', 'ignore', undefined]) {
    inTree({ ...VERTICALS, '.dependency-cruiser.cjs': withRule(rule(severity)) }, () => {
      assert.deepEqual(homeOf(members), { kind: 'lift', target: null }, String(severity))
    })
  }
  inTree({ ...VERTICALS, '.dependency-cruiser.cjs': withRule(rule('error')) }, () => {
    assert.deepEqual(homeOf(members), { kind: 'none', target: null })
  })
})

treeTest('homes: no IMPORT that closes a cycle: no-circular sends it to the other member', () => {
  const tree = {
    '.dependency-cruiser.cjs': DEPCRUISE,
    'packages/c/package.json': pkg('@app/c'),
    // x.ts has the most importers, but it already imports y.ts: y importing x is a cycle.
    'packages/c/src/x.ts': `import type { Helper } from './y'\n${BODY('first')}export const h: Helper | null = null\n`,
    'packages/c/src/y.ts': `export interface Helper { readonly id: string }\n${BODY('second')}`,
    'packages/c/src/u0.ts': "import { first } from './x'\nexport const u = first\n",
    'packages/c/src/u1.ts': "import { first } from './x'\nexport const u = first\n",
  }
  const members = ['packages/c/src/x.ts', 'packages/c/src/y.ts']
  inTree(tree, () => {
    assert.deepEqual(homeOf(members), { kind: 'import', target: 'packages/c/src/y.ts' })
  })
  const { '.dependency-cruiser.cjs': _rules, ...bare } = tree
  inTree(bare, () => {
    assert.deepEqual(homeOf(members), { kind: 'import', target: 'packages/c/src/x.ts' })
  })
})

treeTest('homes: dependency types are judged for a new value import; a condition not judged forbids', () => {
  const tree = {
    'packages/api/package.json': pkg('@app/api'),
    'packages/api/src/index.ts': "export { eventOf } from './m'\n",
    'packages/api/src/m.ts': BODY('eventOf'),
    'apps/web/package.json': pkg('web', ['@app/api']),
    'apps/web/lib/event.ts': BODY('eventFor'),
  }
  const members = ['packages/api/src/m.ts', 'apps/web/lib/event.ts']
  const rule = (to) => ({ name: 'web-api', severity: 'error', from: { path: '^apps/web/' }, to: { path: '^packages/api/', ...to } })
  const cases = [
    [{}, 'lift'],
    [{ dependencyTypesNot: ['type-only'] }, 'lift'],
    [{ dependencyTypes: ['type-only'] }, 'import'],
    [{ dependencyTypes: ['local', 'import'] }, 'lift'],
    [{ dependencyTypesNot: ['import'] }, 'import'],
    [{ moreThanOneDependencyType: true }, 'lift'],
  ]
  for (const [to, kind] of cases) {
    inTree({ ...tree, '.dependency-cruiser.cjs': `module.exports = ${JSON.stringify({ forbidden: [rule(to)] })}\n` }, () => {
      assert.equal(homeOf(members).kind, kind, JSON.stringify(to))
    })
  }
})

treeTest('homes: NONE when a member is a domain file: domain purity admits no packages/shared import', () => {
  inTree(
    {
      ...VERTICALS,
      'packages/verticals/notes/src/domain/codec.ts': BODY('encode'),
      'packages/verticals/tasks/src/domain/codec.ts': BODY('decode'),
    },
    () => {
      assert.deepEqual(
        homeOf(['packages/verticals/notes/src/domain/codec.ts', 'packages/verticals/tasks/src/domain/codec.ts']),
        { kind: 'none', target: null },
      )
    },
  )
})

treeTest("homes: no LIFT with a platform member: the architecture step's kernel-only rule forbids it", () => {
  const tree = {
    'packages/platform/errors/package.json': pkg('@app/errors'),
    'packages/platform/errors/src/event.ts': BODY('eventOf').replace('export ', ''),
    'packages/verticals/notes/package.json': pkg('@app/notes'),
    'packages/verticals/notes/src/data/event.ts': BODY('eventFor').replace('export ', ''),
  }
  const members = ['packages/platform/errors/src/event.ts', 'packages/verticals/notes/src/data/event.ts']
  inTree({ ...tree, '.dependency-cruiser.cjs': DEPCRUISE }, () => {
    assert.deepEqual(homeOf(members), { kind: 'none', target: null })
  })
  // The verdict is the rule file's: with no .dependency-cruiser.cjs the same class lifts.
  inTree(tree, () => assert.deepEqual(homeOf(members), { kind: 'lift', target: null }))
})

treeTest('homes: NONE for web and mobile, until a reviewed census entry admits the shared package', () => {
  const tree = {
    'apps/web/package.json': pkg('web'),
    'apps/web/lib/event.ts': BODY('eventOf'),
    'apps/mobile/package.json': pkg('mobile'),
    'apps/mobile/src/event.ts': BODY('eventFor'),
  }
  const members = ['apps/web/lib/event.ts', 'apps/mobile/src/event.ts']
  inTree(tree, () => assert.deepEqual(homeOf(members), { kind: 'none', target: null }))
  inTree({ ...tree, 'tools/exports-walls.json': '{"sanctioned":[{"package":"@app/concept"}]}' }, () =>
    assert.deepEqual(homeOf(members), { kind: 'lift', target: null }),
  )
})

const DENY = (schema) => `CREATE FUNCTION ${schema}.deny_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $deny$
BEGIN
  RAISE EXCEPTION '${schema}.events is append-only (% on % refused)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501';
END
$deny$;
`

test('homes: a SQL class is MODULE, one function in schema private, with no parser needed', () => {
  inTree(
    {
      'supabase/migrations/20260202000000_audit.sql': DENY('audit'),
      'supabase/migrations/20260816000000_auth_event_trail.sql': DENY('auth_trail'),
    },
    () => {
      assert.deepEqual(
        homeOf(
          ['supabase/migrations/20260202000000_audit.sql', 'supabase/migrations/20260816000000_auth_event_trail.sql'],
          null,
        ),
        { kind: 'module', target: null },
      )
    },
  )
})
